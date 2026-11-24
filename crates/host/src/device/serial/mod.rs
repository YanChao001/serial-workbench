//! 原生串口提供器；平台调用与设备目录身份分离。
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(test, windows))]
#[path = "../tool_handoff_sim_provider.rs"]
pub(crate) mod tool_handoff_sim_provider;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use serial_workbench_core::*;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct SerialProvider {
    host_id: Id,
    claims: SerialClaims,
    #[cfg(all(test, windows))]
    simulated_open: Option<tool_handoff_sim_provider::SimulatedOpen>,
}
impl SerialProvider {
    pub fn new(host_id: Id) -> Self {
        Self {
            host_id,
            claims: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(all(test, windows))]
            simulated_open: None,
        }
    }
    pub fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>> {
        #[cfg(windows)]
        {
            windows::enumerate(&self.host_id)
        }
        #[cfg(target_os = "linux")]
        {
            linux::enumerate(&self.host_id)
        }
        #[cfg(target_os = "macos")]
        {
            macos::enumerate(&self.host_id)
        }
    }
    /// 调用方只能传入目录已经按 binding/身份解析的 descriptor。
    pub fn open(
        &self,
        device: &DeviceDescriptor,
        configuration: &SerialConfiguration,
    ) -> BackendResult<Box<dyn Transport>> {
        self.open_owned(device, configuration, None)
    }

    fn open_owned(
        &self,
        device: &DeviceDescriptor,
        configuration: &SerialConfiguration,
        handoff: Option<&Id>,
    ) -> BackendResult<Box<dyn Transport>> {
        #[cfg(all(test, windows))]
        if let Some(open) = &self.simulated_open {
            return open(device, configuration, self.claim_native(device, handoff)?);
        }
        #[cfg(windows)]
        let (device, interface) = match handoff {
            Some(_) => {
                let (device, path) = windows::resolve_handoff_port(device)?;
                (device, Some(path))
            }
            None => (device.clone(), None),
        };
        #[cfg(unix)]
        let device = match handoff {
            Some(_) => {
                let mut current = find_handoff_identity(device, &self.enumerate()?)?.clone();
                current.device_id.clone_from(&device.device_id);
                current
            }
            None => device.clone(),
        };
        let claim = self.claim_native(&device, handoff)?;
        let isolated = claim.isolated.clone();
        let config = configuration.clone();
        start_native(
            move || {
                #[cfg(windows)]
                {
                    windows::open(&device, &config, claim, interface)
                }
                #[cfg(unix)]
                {
                    unix::open(&device, &config, claim)
                }
            },
            isolated,
        )
    }

    fn claim_native(
        &self,
        device: &DeviceDescriptor,
        handoff: Option<&Id>,
    ) -> HostResult<SerialClaim> {
        let keys = self.device_keys(device)?;
        let owner = SerialOwner::Native(device.device_id.clone());
        let mut claims = self.claims.lock().map_err(|_| reservation_unavailable())?;
        if let Some(id) = handoff
            && !claims
                .get(&SerialOwner::Tool(id.clone()))
                .is_some_and(|previous| overlaps(previous, &keys))
        {
            return Err(device_busy());
        }
        if claims.iter().any(|(owner, existing)| {
            !matches!(owner, SerialOwner::Tool(id) if Some(id) == handoff)
                && overlaps(existing, &keys)
        }) {
            return Err(device_busy());
        }
        if claims
            .keys()
            .filter(|owner| matches!(owner, SerialOwner::Native(_)))
            .count()
            >= 16
        {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Native serial capacity is exhausted",
            ));
        }
        claims.insert(owner, keys);
        drop(claims);
        Ok(SerialClaim {
            id: device.device_id.clone(),
            claims: self.claims.clone(),
            isolated: Arc::new(AtomicBool::new(false)),
            released: false,
        })
    }

    /// 在旧句柄仍归本提供器时先占位，避免关停与启动工具之间出现可抢占窗口。
    pub fn reserve_tool_handoff(&self, device: &DeviceDescriptor) -> HostResult<SerialHandoff> {
        let keys = self.device_keys(device)?;
        let mut claims = self.claims.lock().map_err(|_| reservation_unavailable())?;
        let native_owner = SerialOwner::Native(device.device_id.clone());
        if claims.get(&native_owner) != Some(&keys) {
            return Err(HostError::new(
                "DEVICE_NOT_FOUND",
                "The live native owner no longer matches this device",
            ));
        }
        if claims
            .iter()
            .any(|(owner, existing)| *owner != native_owner && overlaps(existing, &keys))
        {
            return Err(device_busy());
        }
        let id = crate::device::sessions::new_id();
        claims.insert(SerialOwner::Tool(id.clone()), keys);
        drop(claims);
        Ok(SerialHandoff {
            provider: self.clone(),
            device: device.clone(),
            id,
            phase: HandoffPhase::Reserved,
        })
    }

    pub(crate) fn require_tool_quiescence(&self) -> HostResult<()> {
        let claims = self.claims.lock().map_err(|_| reservation_unavailable())?;
        if claims
            .keys()
            .any(|owner| matches!(owner, SerialOwner::Tool(_)))
        {
            return Err(HostError::new(
                "TOOL_EXIT_UNCONFIRMED",
                "External serial owner has not been released",
            ));
        }
        Ok(())
    }

    fn device_keys(&self, device: &DeviceDescriptor) -> HostResult<Vec<SerialAddress>> {
        if device.host_id != self.host_id
            || !matches!(
                device.fingerprint.transport,
                DeviceTransportKind::Serial | DeviceTransportKind::Pty
            )
        {
            return Err(HostError::new(
                "DEVICE_NOT_FOUND",
                "Device does not belong to this serial provider",
            ));
        }
        let locator = if cfg!(windows) {
            device.system_name.to_ascii_lowercase()
        } else {
            device.system_name.clone()
        };
        let mut keys = vec![
            SerialAddress::Device(device.device_id.clone()),
            SerialAddress::Locator(locator),
        ];
        let fingerprint = &device.fingerprint;
        if fingerprint.evidence == IdentityEvidence::SerialNumber
            && let Some(serial) = fingerprint
                .serial_number
                .as_ref()
                .filter(|value| !value.trim().is_empty())
        {
            keys.push(SerialAddress::Fingerprint {
                transport: fingerprint.transport,
                vid: fingerprint.vid,
                pid: fingerprint.pid,
                serial: serial.clone(),
            });
        }
        Ok(keys)
    }
}

#[derive(PartialEq, Eq)]
enum SerialAddress {
    Device(Id),
    Locator(String),
    Fingerprint {
        transport: DeviceTransportKind,
        vid: Option<u16>,
        pid: Option<u16>,
        serial: String,
    },
}
impl SerialAddress {
    fn overlaps(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Fingerprint {
                    transport,
                    vid,
                    pid,
                    serial,
                },
                Self::Fingerprint {
                    transport: other_transport,
                    vid: other_vid,
                    pid: other_pid,
                    serial: other_serial,
                },
            ) => {
                transport == other_transport
                    && serial == other_serial
                    && (vid.is_none() || other_vid.is_none() || vid == other_vid)
                    && (pid.is_none() || other_pid.is_none() || pid == other_pid)
            }
            _ => self == other,
        }
    }
}

fn overlaps(left: &[SerialAddress], right: &[SerialAddress]) -> bool {
    left.iter()
        .any(|key| right.iter().any(|other| key.overlaps(other)))
}
fn reservation_unavailable() -> HostError {
    HostError::new("HOST_BUSY", "Serial reservation is unavailable")
}
fn device_busy() -> HostError {
    HostError::new("DEVICE_BUSY", "Device has a native or external owner")
}

#[derive(PartialEq, Eq, Hash)]
enum SerialOwner {
    Native(Id),
    Tool(Id),
}
type SerialClaims = Arc<Mutex<HashMap<SerialOwner, Vec<SerialAddress>>>>;

#[derive(PartialEq, Eq)]
enum HandoffPhase {
    Reserved,
    ToolMayOwnDevice,
    ToolExited,
}

/// 物理占用由 Host 的工具任务拥有，操作取消等待不会撤销它。
pub struct SerialHandoff {
    provider: SerialProvider,
    device: DeviceDescriptor,
    id: Id,
    phase: HandoffPhase,
}
impl SerialHandoff {
    pub(crate) fn initial_locator(&self) -> &str {
        &self.device.system_name
    }

    /// 关停后读取新鲜目录并核对身份，仍可能持有原生句柄时拒绝移交。
    pub fn begin_tool(&mut self, devices: &DeviceList) -> HostResult<String> {
        if self.phase != HandoffPhase::Reserved {
            return Err(device_busy());
        }
        let device = self.find_same_device(devices)?;
        let keys = self.provider.device_keys(device)?;
        let mut claims = self
            .provider
            .claims
            .lock()
            .map_err(|_| reservation_unavailable())?;
        let owner = SerialOwner::Tool(self.id.clone());
        if claims
            .iter()
            .any(|(other, existing)| other != &owner && overlaps(existing, &keys))
        {
            return Err(device_busy());
        }
        let reserved = claims.get_mut(&owner).ok_or_else(device_busy)?;
        for key in keys {
            if !reserved.contains(&key) {
                reserved.push(key);
            }
        }
        self.phase = HandoffPhase::ToolMayOwnDevice;
        Ok(device.system_name.clone())
    }

    pub(in crate::device) fn is_for(&self, device: &Id) -> bool {
        &self.device.device_id == device
    }

    /// 只在启动明确未发生或工具及其后代实际退出后调用。
    pub fn confirm_tool_exit(&mut self) {
        if self.phase == HandoffPhase::ToolMayOwnDevice {
            self.phase = HandoffPhase::ToolExited;
        }
    }

    pub(in crate::device) fn return_opener(
        &self,
        devices: &DeviceList,
    ) -> HostResult<(Id, super::TransportOpener)> {
        let device = self.return_device(devices)?.clone();
        let provider = self.provider.clone();
        let proof = self.id.clone();
        Ok((
            device.device_id.clone(),
            Arc::new(move |id, configuration| {
                if id != &device.device_id {
                    return Err(device_busy().into());
                }
                provider.open_owned(&device, configuration, Some(&proof))
            }),
        ))
    }

    fn return_device<'a>(&self, devices: &'a DeviceList) -> HostResult<&'a DeviceDescriptor> {
        if self.phase == HandoffPhase::ToolMayOwnDevice {
            return Err(device_busy());
        }
        self.find_same_device(devices)
    }

    fn find_same_device<'a>(&self, devices: &'a DeviceList) -> HostResult<&'a DeviceDescriptor> {
        if devices.stale {
            return Err(HostError::new(
                "DISCOVERY_STALE",
                "Fresh device discovery is required after tool handoff",
            ));
        }
        find_handoff_identity(&self.device, &devices.devices)
    }
}

fn find_handoff_identity<'a>(
    expected: &DeviceDescriptor,
    devices: &'a [DeviceDescriptor],
) -> HostResult<&'a DeviceDescriptor> {
    let candidates: Vec<_> = devices
        .iter()
        .filter(|device| device.host_id == expected.host_id)
        .cloned()
        .collect();
    let super::MatchResult::Exact(id) =
        super::IdentityMatcher::match_device(&expected.fingerprint, &candidates)
    else {
        return Err(HostError::new(
            "REQUIRES_REBIND",
            "The device identity after tool exit could not be established",
        ));
    };
    devices
        .iter()
        .find(|device| device.host_id == expected.host_id && device.device_id == id)
        .ok_or_else(|| HostError::new("DEVICE_NOT_FOUND", "The handoff device is absent"))
}

impl Drop for SerialHandoff {
    fn drop(&mut self) {
        // 若 owner 在回收期间丢失，保持占用并拒绝普通打开，避免争抢。
        if self.phase != HandoffPhase::ToolMayOwnDevice
            && let Ok(mut claims) = self.provider.claims.lock()
        {
            claims.remove(&SerialOwner::Tool(self.id.clone()));
        }
    }
}

struct SerialClaim {
    id: Id,
    claims: SerialClaims,
    isolated: Arc<AtomicBool>,
    released: bool,
}
impl SerialClaim {
    fn confirm_release(&mut self) -> HostResult<()> {
        if self.released {
            return Ok(());
        }
        let mut claims = self
            .claims
            .lock()
            .map_err(|_| HostError::new("HOST_BUSY", "Serial reservation is unavailable"))?;
        claims.remove(&SerialOwner::Native(self.id.clone()));
        // 解除后旧 guard 的 Drop 不得再删除随后取得同一设备的新占用。
        self.released = true;
        Ok(())
    }
}
impl Drop for SerialClaim {
    fn drop(&mut self) {
        if !self.released && !self.isolated.load(Ordering::SeqCst) {
            let _ = self.confirm_release();
        }
    }
}

/// 只在专有原生线程内使用；实现的析构也必须留在该线程。
trait NativePort: Send + 'static {
    fn capabilities(&self) -> TransportCapabilities;
    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock>;
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>>;
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication>;
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult>;
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>>;
    fn close(&mut self) -> BackendResult<()>;
}

#[cfg(test)]
mod final_fix_tests;

#[cfg(test)]
mod handoff_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Condvar, Mutex, atomic::Ordering};
    use std::time::Instant;

    struct BlockingWrite {
        gate: Arc<crate::test_support::Gate>,
        isolated: Arc<AtomicBool>,
        rx: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl NativePort for BlockingWrite {
        fn capabilities(&self) -> TransportCapabilities {
            serial_capabilities()
        }
        fn read(&mut self, _: usize, _: Duration) -> BackendResult<ReadBlock> {
            if self.gate.entered.load(Ordering::SeqCst) {
                self.rx.fetch_add(1, Ordering::SeqCst);
            }
            Ok(ReadBlock {
                bytes: Arc::from([7]),
                message: None,
            })
        }
        fn begin_write(
            &mut self,
            bytes: WritePayload,
            wait: Duration,
            cancelled: Arc<AtomicBool>,
            closing: Arc<AtomicBool>,
        ) -> BackendResult<Box<dyn PendingWrite>> {
            let gate = self.gate.clone();
            Ok(start_write_job(
                bytes,
                wait,
                cancelled,
                closing,
                self.isolated.clone(),
                move |bytes, _, _, progress| {
                    {
                        let mut progress = progress.lock().unwrap();
                        progress.accepted = 2;
                        progress.submitted_end = bytes.len();
                    }
                    gate.hold();
                    Ok(BackendWrite {
                        accepted_ranges: vec![],
                        unknown_ranges: vec![],
                        error: None,
                    })
                },
            ))
        }
        fn configure(&mut self, _: &SerialConfiguration) -> BackendResult<ConfigApplication> {
            unreachable!()
        }
        fn control(&mut self, _: ControlCommand) -> BackendResult<ControlResult> {
            unreachable!()
        }
        fn begin_drain(&mut self, _: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
            unreachable!()
        }
        fn close(&mut self) -> BackendResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn host_shutdown_settles_uninterruptible_native_write_without_waiting_for_its_thread() {
        let mut h = crate::test_support::Harness::new().await;
        h.host.shutdown().await.unwrap();
        let gate = Arc::new(crate::test_support::Gate::default());
        let worker_gate = gate.clone();
        let rx = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let worker_rx = rx.clone();
        h.host = crate::Host::with_runtime(
            h.store.clone(),
            h.auth.clone(),
            h.clock.clone(),
            Arc::new(move |_, _| {
                let gate = worker_gate.clone();
                let isolated = Arc::new(AtomicBool::new(false));
                let worker_isolated = isolated.clone();
                let rx = worker_rx.clone();
                start_native(
                    move || {
                        Ok(Box::new(BlockingWrite {
                            gate,
                            isolated: worker_isolated,
                            rx,
                        }))
                    },
                    isolated,
                )
            }),
        )
        .await
        .unwrap();
        let target = h.open("blocked-native-write").await;
        let operation = h
            .invoke(h.call(
                &target,
                "session.tx",
                serde_json::json!({"bytesBase64":"AQIDBAU=", "writeWaitMs":"60000"}),
            ))
            .await;
        gate.entered().await;
        crate::test_support::until(|| rx.load(Ordering::SeqCst) >= 3).await;
        let shutdown = tokio::time::timeout(Duration::from_millis(750), h.host.shutdown()).await;
        gate.release();
        if shutdown.is_err() {
            let _ = h.host.shutdown().await;
        }
        assert!(
            shutdown.is_ok(),
            "Host shutdown waited for an unresolved native write"
        );
        let settled = h.store.get(&h.actor, &operation.operation_id).unwrap();
        assert_eq!(settled.state, OperationState::Unknown);
        let receipt = crate::test_support::receipt(&settled);
        assert_eq!(receipt.accepted_ranges, [range(0, 2)]);
        assert_eq!(receipt.unknown_ranges, [range(2, 5)]);
    }

    struct Cleanup(Arc<AtomicBool>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn unresolved_native_bytes_remain_charged_after_source_history_is_removed() {
        use crate::stream::{StreamHub, StreamKey, StreamLimits, TxSettlement};
        let h = crate::test_support::Harness::new().await;
        let identity = h.host.devices().inner.identity.clone();
        let hub = StreamHub::new(identity.clone(), h.auth.clone(), StreamLimits::default());
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: Id::try_from("retained-write").unwrap(),
            session_id: Some(Id::try_from("retained-write").unwrap()),
            session_epoch: Some(1.into()),
        };
        let source = hub
            .register_source(
                StreamKey {
                    session_id: target.id.clone(),
                    session_epoch: 1.into(),
                },
                target.clone(),
            )
            .unwrap();
        let bytes: Arc<[u8]> = Arc::from([1, 2, 3]);
        let meta = crate::device::sessions::source_meta(&identity, h.clock.as_ref(), 1.into());
        let intent = source
            .append_tx_intent(
                meta.clone(),
                Id::try_from("retained-operation").unwrap(),
                bytes,
            )
            .unwrap();
        let gate = Arc::new(crate::test_support::Gate::default());
        let worker_gate = gate.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut job = start_write_job(
            intent.write_payload(),
            Duration::from_secs(60),
            cancelled.clone(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            move |bytes, _, _, progress| {
                progress.lock().unwrap().submitted_end = bytes.len();
                worker_gate.hold();
                assert_eq!(&*bytes, &[1, 2, 3]);
                Ok(BackendWrite {
                    accepted_ranges: vec![range(0, 3)],
                    unknown_ranges: vec![],
                    error: None,
                })
            },
        );
        assert!(job.poll().is_none());
        gate.entered().await;
        cancelled.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(1);
        let result = loop {
            if let Some(result) = job.poll() {
                break result.unwrap();
            }
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        };
        assert_eq!(result.unknown_ranges, [range(0, 3)]);
        source
            .complete_tx(
                &intent,
                meta,
                TxSettlement {
                    outcome: TxOutcome::Unknown,
                    accepted_ranges: result.accepted_ranges,
                    unknown_ranges: result.unknown_ranges,
                    backend_error: result.error,
                },
            )
            .unwrap();
        source.close().unwrap();
        drop(intent);
        drop(source);
        // 注册下一源会清掉已关闭且无 source 引用的旧环，只剩新源 4096 字节元数据。
        let mut target = target;
        target.session_epoch = Some(2.into());
        let next = hub
            .register_source(
                StreamKey {
                    session_id: target.id.clone(),
                    session_epoch: 2.into(),
                },
                target,
            )
            .unwrap();
        let retained = hub.memory_usage().source_bytes;
        gate.release();
        crate::test_support::until(|| hub.memory_usage().source_bytes == 4096).await;
        drop(job);
        drop(next);
        h.host.shutdown().await.unwrap();
        assert!(
            retained > 4096,
            "unresolved native bytes lost their allocation lease when source history was removed"
        );
    }

    #[tokio::test]
    async fn rx_source_failure_preserves_pending_native_write_prefix() {
        let mut h = crate::test_support::Harness::new().await;
        h.host.shutdown().await.unwrap();
        let gate = Arc::new(crate::test_support::Gate::default());
        let worker_gate = gate.clone();
        h.host = crate::Host::with_runtime(
            h.store.clone(),
            h.auth.clone(),
            h.clock.clone(),
            Arc::new(move |_, _| {
                let gate = worker_gate.clone();
                let isolated = Arc::new(AtomicBool::new(false));
                let worker_isolated = isolated.clone();
                start_native(
                    move || {
                        Ok(Box::new(BlockingWrite {
                            gate,
                            isolated: worker_isolated,
                            rx: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
                        }))
                    },
                    isolated,
                )
            }),
        )
        .await
        .unwrap();
        let target = h.open("source-failure-native-write").await;
        let session = h.host.devices().session(&target).unwrap();
        let writing_session = session.clone();
        let admission = crate::device::sessions::BackendAdmission {
            dispatch_fence: None,
            session_epoch: session.snapshot().unwrap().session_epoch,
            actor_id: Id::try_from("operator").unwrap(),
            lease_id: None,
            lease: Arc::new(Mutex::new(None)),
            cancelled: Arc::new(AtomicBool::new(false)),
        };
        let writing = tokio::spawn(async move {
            writing_session
                .write(
                    WritePayload::owned(Arc::from([1, 2, 3, 4, 5])),
                    Duration::from_secs(60),
                    admission,
                )
                .await
        });
        gate.entered().await;
        session
            .source
            .fail(HostError::new(
                "LIMIT_EXCEEDED",
                "RX source fixture failure",
            ))
            .unwrap();
        let settled = tokio::time::timeout(Duration::from_millis(750), writing).await;
        gate.release();
        let result = settled
            .expect("RX failure must settle pending write")
            .unwrap()
            .unwrap();
        assert_eq!(result.accepted_ranges, [range(0, 2)]);
        assert_eq!(result.unknown_ranges, [range(2, 5)]);
        assert_eq!(session.snapshot().unwrap().tx_gate, TxGate::ControlUnknown);
        // 实际清理及线程退出允许关停，但不能改写已发布的 TX unknown。
        let report = h.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
        assert_eq!(report.mode, ShutdownMode::CancelAndSettle);
        assert!(report.completed, "{report:?}");
        assert!(report.quarantined_sessions.is_empty());
        assert!(report.unsettled_operation_ids.is_empty());
        // 后端已实际退出并确认 close；资源清理成功不改写原 TX 的隔离结果。
        assert!(report.failures.is_empty());
        assert_eq!(session.snapshot().unwrap().tx_gate, TxGate::ControlUnknown);
        h.host.shutdown().await.unwrap();
    }

    #[test]
    fn native_write_waits_for_owner_acceptance_before_submission() {
        let (entered, observed) = mpsc::channel();
        let mut job = start_write_job(
            WritePayload::owned(Arc::from([7])),
            Duration::from_secs(1),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            move |_, _, _, _| {
                entered.send(()).unwrap();
                Ok(BackendWrite {
                    accepted_ranges: vec![range(0, 1)],
                    unknown_ranges: vec![],
                    error: None,
                })
            },
        );
        assert!(
            observed.recv_timeout(Duration::from_millis(20)).is_err(),
            "native write ran before its pending result reached the owner"
        );
        let first = job.poll();
        observed.recv_timeout(Duration::from_secs(1)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let result = first.unwrap_or_else(|| {
            loop {
                if let Some(result) = job.poll() {
                    break result;
                }
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
        });
        assert_eq!(result.unwrap().accepted_ranges, [range(0, 1)]);
    }

    #[test]
    fn native_drain_waits_for_owner_acceptance_before_submission() {
        let (entered, observed) = mpsc::channel();
        let request = DrainRequest {
            wait: Duration::from_secs(1),
            cancelled: Arc::new(AtomicBool::new(false)),
            closing: Arc::new(AtomicBool::new(false)),
        };
        let mut job = start_drain_job(request, Arc::new(AtomicBool::new(false)), move || {
            entered.send(()).unwrap();
            Ok(())
        });
        assert!(
            observed.recv_timeout(Duration::from_millis(20)).is_err(),
            "native drain ran before its pending result reached the owner"
        );
        let first = job.poll();
        observed.recv_timeout(Duration::from_secs(1)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let result = first.unwrap_or_else(|| {
            loop {
                if let Some(result) = job.poll() {
                    break result;
                }
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
        });
        assert!(matches!(
            result.unwrap(),
            ControlResult::Drained {
                status: ControlStatus::Confirmed,
                ..
            }
        ));
    }

    #[test]
    fn cancelled_write_cannot_publish_a_late_submission_after_known_settlement() {
        let progress = Arc::new(Mutex::new(WriteProgress {
            accepted: 2,
            submitted_end: 2,
        }));
        let signals = WriteSignals {
            cancelled: Arc::new(AtomicBool::new(true)),
            closing: Arc::new(AtomicBool::new(false)),
            abandoned: Arc::new(AtomicBool::new(false)),
            isolated: Arc::new(AtomicBool::new(false)),
        };
        assert!(!publish_write_submission(&progress, &signals, 8));
        let progress = progress.lock().unwrap();
        assert_eq!(progress.accepted, 2);
        assert_eq!(progress.submitted_end, 2);
    }

    #[test]
    fn cancellation_before_native_submission_is_known_not_started() {
        let isolated = Arc::new(AtomicBool::new(false));
        let entered = Arc::new(AtomicBool::new(false));
        let worker_entered = entered.clone();
        let request = DrainRequest {
            wait: Duration::from_secs(1),
            cancelled: Arc::new(AtomicBool::new(true)),
            closing: Arc::new(AtomicBool::new(false)),
        };
        let mut job = start_drain_job(request, isolated.clone(), move || {
            worker_entered.store(true, Ordering::SeqCst);
            Ok(())
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        let result = loop {
            if let Some(result) = job.poll() {
                break result.unwrap();
            }
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        };
        assert!(
            matches!(result, ControlResult::Drained { status: ControlStatus::Failed, error: Some(ref error) } if error.code == "CANCELLED")
        );
        assert!(!entered.load(Ordering::SeqCst));
        assert!(!isolated.load(Ordering::SeqCst));
    }

    #[test]
    fn native_completion_observed_before_cancellation_remains_confirmed() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let isolated = Arc::new(AtomicBool::new(false));
        let request = DrainRequest {
            wait: Duration::from_secs(1),
            cancelled: cancelled.clone(),
            closing: Arc::new(AtomicBool::new(false)),
        };
        let mut job = start_drain_job(request, isolated.clone(), || Ok(()));
        let deadline = Instant::now() + Duration::from_secs(1);
        let result = loop {
            if let Some(result) = job.poll() {
                break result.unwrap();
            }
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        };
        cancelled.store(true, Ordering::SeqCst);
        assert!(matches!(
            result,
            ControlResult::Drained {
                status: ControlStatus::Confirmed,
                error: None
            }
        ));
        assert!(!isolated.load(Ordering::SeqCst));
        assert!(job.poll().is_none());
    }

    #[test]
    fn blocked_native_call_keeps_port_owned_after_wait_and_drop_return() {
        let entered = Arc::new(AtomicBool::new(false));
        let closed = Arc::new(AtomicBool::new(false));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let isolated = Arc::new(AtomicBool::new(false));
        let worker_entered = entered.clone();
        let worker_release = release.clone();
        let owned = Cleanup(closed.clone());
        let started = Instant::now();
        let request = DrainRequest {
            wait: Duration::from_millis(20),
            cancelled: Arc::new(AtomicBool::new(false)),
            closing: Arc::new(AtomicBool::new(false)),
        };
        let mut job = start_drain_job(request, isolated.clone(), move || {
            let _owned = owned;
            worker_entered.store(true, Ordering::SeqCst);
            let mut released = worker_release.0.lock().unwrap();
            while !*released {
                released = worker_release.1.wait(released).unwrap();
            }
            Ok(())
        });
        let result = loop {
            if let Some(result) = job.poll() {
                break result;
            }
            assert!(started.elapsed() < Duration::from_secs(1));
            std::thread::yield_now();
        };
        assert!(matches!(
            result,
            Ok(ControlResult::Drained {
                status: ControlStatus::Unknown,
                ..
            })
        ));
        assert!(entered.load(Ordering::SeqCst));
        assert!(!closed.load(Ordering::SeqCst));
        assert!(isolated.load(Ordering::SeqCst));
        drop(job);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!closed.load(Ordering::SeqCst));
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
        let deadline = Instant::now() + Duration::from_secs(1);
        while !closed.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(closed.load(Ordering::SeqCst));
    }
}

enum NativeRequest {
    Read(usize, Duration, mpsc::Sender<BackendResult<ReadBlock>>),
    Write(
        WritePayload,
        Duration,
        Arc<AtomicBool>,
        Arc<AtomicBool>,
        mpsc::Sender<BackendResult<Box<dyn PendingWrite>>>,
    ),
    Configure(
        SerialConfiguration,
        mpsc::Sender<BackendResult<ConfigApplication>>,
    ),
    Control(ControlCommand, mpsc::Sender<BackendResult<ControlResult>>),
    Drain(
        DrainRequest,
        mpsc::Sender<BackendResult<Box<dyn PendingDrain>>>,
    ),
    Close(mpsc::Sender<BackendResult<()>>),
}
struct NativeTransport {
    sender: mpsc::SyncSender<NativeRequest>,
    stopping: Arc<AtomicBool>,
    isolated: Arc<AtomicBool>,
    capabilities: TransportCapabilities,
    owner: Arc<NativeOwner>,
}
#[derive(Debug, Default)]
struct NativeOwner {
    result: Mutex<Option<HostResult<()>>>,
    cleanup: Mutex<Option<Arc<dyn BackendCleanup>>>,
    join: Mutex<Option<JoinHandle<()>>>,
}
impl BackendCleanup for NativeOwner {
    fn poll(&self) -> Option<HostResult<()>> {
        let mut join = self.join.lock().ok()?;
        if join.as_ref().is_some_and(|join| !join.is_finished()) {
            return None;
        }
        if let Some(join) = join.take()
            && join.join().is_err()
        {
            let failure = Err(HostError::new(
                "CONTROL_UNKNOWN",
                "Native serial owner failed",
            ));
            if let Ok(mut result) = self.result.lock() {
                *result = Some(failure.clone());
            }
            return Some(failure);
        }
        if let Some(cleanup) = self.cleanup.lock().ok()?.as_ref() {
            return cleanup.poll();
        }
        self.result.lock().ok()?.clone()
    }
}
fn retained_unknown(owner: &Arc<NativeOwner>) -> BackendError {
    let mut error = unknown();
    error.cleanup = Some(owner.clone());
    error
}
fn start_native(
    opener: impl FnOnce() -> BackendResult<Box<dyn NativePort>> + Send + 'static,
    isolated: Arc<AtomicBool>,
) -> BackendResult<Box<dyn Transport>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (ready, opened) = mpsc::channel();
    let stopping = Arc::new(AtomicBool::new(false));
    let worker_stopping = stopping.clone();
    let worker_isolated = isolated.clone();
    let owner = Arc::new(NativeOwner::default());
    let worker_owner = owner.clone();
    let join = thread::Builder::new()
        .name("serial-native".into())
        .spawn(move || {
            let result = (|| {
                let mut port = match opener() {
                    Ok(port) => port,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return Ok(());
                    }
                };
                if ready.send(Ok(port.capabilities())).is_err() {
                    return port.close();
                }
                loop {
                    if worker_stopping.load(Ordering::SeqCst)
                        || worker_isolated.load(Ordering::SeqCst)
                    {
                        break;
                    }
                    match receiver.recv_timeout(Duration::from_millis(20)) {
                        Ok(NativeRequest::Read(limit, wait, reply)) => {
                            let _ = reply.send(port.read(limit, wait));
                        }
                        Ok(NativeRequest::Write(bytes, wait, cancelled, closing, reply)) => {
                            let _ = reply.send(port.begin_write(bytes, wait, cancelled, closing));
                        }
                        Ok(NativeRequest::Configure(config, reply)) => {
                            let _ = reply.send(port.configure(&config));
                        }
                        Ok(NativeRequest::Control(command, reply)) => {
                            let _ = reply.send(port.control(command));
                        }
                        Ok(NativeRequest::Drain(request, reply)) => {
                            let _ = reply.send(port.begin_drain(request));
                        }
                        Ok(NativeRequest::Close(reply)) => {
                            let result = port.close();
                            let _ = reply.send(result.clone());
                            return result;
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                port.close()
            })();
            // owner 线程结束不证明借给在途 I/O 的句柄已关闭，继续保有其完成凭证。
            if let Err(error) = &result
                && let Some(cleanup) = &error.cleanup
                && let Ok(mut retained) = worker_owner.cleanup.lock()
            {
                *retained = Some(cleanup.clone());
            }
            if let Ok(mut completed) = worker_owner.result.lock() {
                *completed = Some(result.map_err(|error| *error.error));
            }
        })
        .map_err(|_| {
            BackendError::from(HostError::new(
                "HOST_BUSY",
                "Native serial worker could not start",
            ))
        })?;
    *owner.join.lock().map_err(|_| unknown())? = Some(join);
    let capabilities = match opened.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => result?,
        Err(_) => {
            isolated.store(true, Ordering::SeqCst);
            stopping.store(true, Ordering::SeqCst);
            return Err(retained_unknown(&owner));
        }
    };
    Ok(Box::new(NativeTransport {
        sender,
        stopping,
        isolated,
        capabilities,
        owner,
    }))
}
impl NativeTransport {
    fn call<T>(
        &self,
        wait: Duration,
        command: impl FnOnce(mpsc::Sender<BackendResult<T>>) -> NativeRequest,
    ) -> BackendResult<T> {
        if self.isolated.load(Ordering::SeqCst) {
            return Err(unknown());
        }
        if self.stopping.load(Ordering::SeqCst) {
            return Err(HostError::new("BACKEND_DISCONNECTED", "Serial port is closing").into());
        }
        let (reply, receive) = mpsc::channel();
        self.sender.try_send(command(reply)).map_err(|_| {
            BackendError::from(HostError::new(
                "HOST_BUSY",
                "Native command was not submitted",
            ))
        })?;
        match receive.recv_timeout(wait + Duration::from_millis(100)) {
            Ok(result) => result,
            Err(_) => {
                self.isolated.store(true, Ordering::SeqCst);
                self.stopping.store(true, Ordering::SeqCst);
                Err(unknown())
            }
        }
    }
}
impl Transport for NativeTransport {
    fn capabilities(&self) -> TransportCapabilities {
        self.capabilities.clone()
    }
    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        // 原生读还需收取取消完成，调度余量覆盖该阶段后才隔离 owner。
        self.call(wait + Duration::from_millis(150), |reply| {
            NativeRequest::Read(limit, wait, reply)
        })
    }
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        if self.isolated.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst) {
            return Err(unknown());
        }
        if cancelled.load(Ordering::SeqCst) || closing.load(Ordering::SeqCst) {
            return Err(HostError::new("CANCELLED", "Write was not submitted").into());
        }
        self.call(Duration::from_millis(100), |reply| {
            NativeRequest::Write(bytes, wait, cancelled, closing, reply)
        })
    }
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        self.call(Duration::from_secs(1), |reply| {
            NativeRequest::Configure(config.clone(), reply)
        })
    }
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        self.call(Duration::from_secs(1), |reply| {
            NativeRequest::Control(command, reply)
        })
    }
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        if request.cancelled.load(Ordering::SeqCst) || request.closing.load(Ordering::SeqCst) {
            return Err(HostError::new("CANCELLED", "Drain was not submitted").into());
        }
        self.call(Duration::from_millis(100), |reply| {
            NativeRequest::Drain(request, reply)
        })
    }
    fn close(&mut self) -> BackendResult<()> {
        if self.isolated.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst) {
            self.stopping.store(true, Ordering::SeqCst);
            return self
                .owner
                .poll()
                .unwrap_or_else(|| Err(*unknown().error))
                .map_err(|error| {
                    let mut error = BackendError::from(error);
                    error.cleanup = Some(self.owner.clone());
                    error
                });
        }
        let result = self.call(Duration::from_millis(100), NativeRequest::Close);
        self.stopping.store(true, Ordering::SeqCst);
        if let Err(mut error) = result {
            error.cleanup = Some(self.owner.clone());
            return Err(error);
        }
        let deadline = Instant::now() + Duration::from_millis(100);
        loop {
            if let Some(result) = self.owner.poll() {
                return result.map_err(Into::into);
            }
            if Instant::now() >= deadline {
                return Err(retained_unknown(&self.owner));
            }
            thread::sleep(Duration::from_millis(1));
        }
    }
}
impl Drop for NativeTransport {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        let _ = self.owner.poll();
    }
}

#[derive(Default)]
struct WriteProgress {
    accepted: usize,
    submitted_end: usize,
}
impl WriteProgress {
    fn receipt(&self, error: HostError) -> BackendWrite {
        BackendWrite {
            accepted_ranges: if self.accepted == 0 {
                vec![]
            } else {
                vec![range(0, self.accepted)]
            },
            unknown_ranges: if self.submitted_end > self.accepted {
                vec![range(self.accepted, self.submitted_end)]
            } else {
                vec![]
            },
            error: Some(error),
        }
    }
}
#[derive(Clone)]
struct WriteSignals {
    cancelled: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
    abandoned: Arc<AtomicBool>,
    isolated: Arc<AtomicBool>,
}
impl WriteSignals {
    fn interrupted(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
            || self.closing.load(Ordering::SeqCst)
            || self.abandoned.load(Ordering::SeqCst)
            || self.isolated.load(Ordering::SeqCst)
    }
}

fn publish_write_submission(
    progress: &Arc<Mutex<WriteProgress>>,
    signals: &WriteSignals,
    end: usize,
) -> bool {
    let mut progress = progress.lock().unwrap_or_else(|e| e.into_inner());
    if signals.interrupted() {
        return false;
    }
    progress.submitted_end = end;
    true
}

fn start_write_job(
    bytes: WritePayload,
    wait: Duration,
    cancelled: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
    isolated: Arc<AtomicBool>,
    operation: impl FnOnce(
        WritePayload,
        Instant,
        WriteSignals,
        Arc<Mutex<WriteProgress>>,
    ) -> BackendResult<BackendWrite>
    + Send
    + 'static,
) -> Box<dyn PendingWrite> {
    let signals = WriteSignals {
        cancelled,
        closing,
        abandoned: Arc::new(AtomicBool::new(false)),
        isolated,
    };
    let worker_signals = signals.clone();
    let progress = Arc::new(Mutex::new(WriteProgress::default()));
    let worker_progress = progress.clone();
    let result = Arc::new(Mutex::new(None));
    let worker_result = result.clone();
    let accepted = Arc::new(AtomicBool::new(false));
    let worker_accepted = accepted.clone();
    let deadline = Instant::now() + wait;
    let join = thread::Builder::new()
        .name("serial-write".into())
        .spawn(move || {
            while !worker_accepted.load(Ordering::SeqCst) && !worker_signals.interrupted() {
                thread::park_timeout(Duration::from_millis(1));
            }
            let outcome = if worker_signals.interrupted() {
                Ok(worker_progress
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .receipt(HostError::new("CANCELLED", "Write was not submitted")))
            } else {
                operation(bytes, deadline, worker_signals, worker_progress)
            };
            *worker_result.lock().unwrap_or_else(|e| e.into_inner()) = Some(outcome);
        });
    let join = match join {
        Ok(join) => Some(join),
        Err(_) => {
            *result.lock().unwrap_or_else(|e| e.into_inner()) = Some(Ok(progress
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .receipt(HostError::new(
                    "HOST_BUSY",
                    "Native write worker could not start",
                ))));
            None
        }
    };
    Box::new(NativeWrite {
        accepted,
        signals,
        progress,
        result,
        deadline,
        interrupted: None,
        join,
        settled: false,
        native_finished: false,
    })
}
struct NativeWrite {
    accepted: Arc<AtomicBool>,
    signals: WriteSignals,
    progress: Arc<Mutex<WriteProgress>>,
    result: Arc<Mutex<Option<BackendResult<BackendWrite>>>>,
    deadline: Instant,
    interrupted: Option<Instant>,
    join: Option<JoinHandle<()>>,
    settled: bool,
    native_finished: bool,
}
impl PendingWrite for NativeWrite {
    fn poll(&mut self) -> Option<BackendResult<BackendWrite>> {
        if self.settled {
            return None;
        }
        self.accepted.store(true, Ordering::SeqCst);
        if let Some(join) = &self.join {
            join.thread().unpark();
        }
        let mut result = self.result.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(result) = result.take() {
            self.settled = true;
            self.native_finished = true;
            if result
                .as_ref()
                .is_ok_and(|result| !result.unknown_ranges.is_empty())
                || result.is_err()
            {
                self.signals.isolated.store(true, Ordering::SeqCst);
            }
            return Some(result);
        }
        let now = Instant::now();
        if self.signals.interrupted() || now >= self.deadline {
            let at = *self.interrupted.get_or_insert(now);
            self.signals.abandoned.store(true, Ordering::SeqCst);
            if let Some(join) = &self.join {
                interrupt_thread(join);
            }
            if now.duration_since(at) >= Duration::from_millis(100) {
                self.signals.isolated.store(true, Ordering::SeqCst);
                self.settled = true;
                let error = HostError::new(
                    if now >= self.deadline {
                        "WRITE_TIMEOUT"
                    } else {
                        "CANCELLED"
                    },
                    "Native write completion is not confirmed",
                );
                return Some(Ok(self
                    .progress
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .receipt(error)));
            }
        }
        None
    }
}
impl Drop for NativeWrite {
    fn drop(&mut self) {
        let result = self.result.lock().unwrap_or_else(|e| e.into_inner());
        if !self.settled {
            self.signals.abandoned.store(true, Ordering::SeqCst);
            self.signals.isolated.store(true, Ordering::SeqCst);
        }
        if !self.native_finished
            && result.is_none()
            && let Some(join) = &self.join
        {
            interrupt_thread(join);
        }
        drop(result);
        if let Some(join) = self.join.take()
            && join.is_finished()
        {
            let _ = join.join();
        }
    }
}

fn start_drain_job(
    _request: DrainRequest,
    _isolated: Arc<AtomicBool>,
    _operation: impl FnOnce() -> BackendResult<()> + Send + 'static,
) -> Box<dyn PendingDrain> {
    let result = Arc::new(Mutex::new(None));
    let worker_result = result.clone();
    let worker_request = _request.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = cancelled.clone();
    let accepted = Arc::new(AtomicBool::new(false));
    let worker_accepted = accepted.clone();
    let deadline = Instant::now() + _request.wait;
    let join = thread::Builder::new()
        .name("serial-drain".into())
        .spawn(move || {
            while !worker_accepted.load(Ordering::SeqCst)
                && !worker_cancelled.load(Ordering::SeqCst)
                && !worker_request.cancelled.load(Ordering::SeqCst)
                && !worker_request.closing.load(Ordering::SeqCst)
            {
                thread::park_timeout(Duration::from_millis(1));
            }
            let submitted = !(worker_cancelled.load(Ordering::SeqCst)
                || worker_request.cancelled.load(Ordering::SeqCst)
                || worker_request.closing.load(Ordering::SeqCst));
            let outcome = if !submitted {
                Err(
                    HostError::new("CANCELLED", "Drain was cancelled before native submission")
                        .into(),
                )
            } else {
                _operation()
            };
            // 与发送定向取消使用同一锁，直到结果发布才允许原生线程退出。
            *worker_result.lock().unwrap_or_else(|e| e.into_inner()) = Some((submitted, outcome));
        });
    let join = match join {
        Ok(join) => Some(join),
        Err(_) => {
            *result.lock().unwrap_or_else(|e| e.into_inner()) = Some((
                false,
                Err(HostError::new("HOST_BUSY", "Native drain worker could not start").into()),
            ));
            None
        }
    };
    Box::new(NativeDrain {
        accepted,
        request: _request,
        isolated: _isolated,
        result,
        cancelled,
        deadline,
        interrupted: None,
        join,
        settled: false,
        native_finished: false,
    })
}

type DrainCompletion = Arc<Mutex<Option<(bool, BackendResult<()>)>>>;
struct NativeDrain {
    accepted: Arc<AtomicBool>,
    request: DrainRequest,
    isolated: Arc<AtomicBool>,
    result: DrainCompletion,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    interrupted: Option<(Instant, HostError)>,
    join: Option<JoinHandle<()>>,
    settled: bool,
    native_finished: bool,
}
impl PendingDrain for NativeDrain {
    fn poll(&mut self) -> Option<BackendResult<ControlResult>> {
        if self.settled {
            return None;
        }
        self.accepted.store(true, Ordering::SeqCst);
        if let Some(join) = &self.join {
            join.thread().unpark();
        }
        let mut result = self.result.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((submitted, result)) = result.take() {
            self.settled = true;
            self.native_finished = true;
            let (status, error) = match result {
                Ok(()) => (ControlStatus::Confirmed, None),
                Err(error) if !submitted => (ControlStatus::Failed, Some(*error.error)),
                Err(error) => {
                    self.isolated.store(true, Ordering::SeqCst);
                    (ControlStatus::Unknown, Some(*error.error))
                }
            };
            return Some(Ok(ControlResult::Drained { status, error }));
        }
        let now = Instant::now();
        if self.interrupted.is_none()
            && (self.request.cancelled.load(Ordering::SeqCst)
                || self.request.closing.load(Ordering::SeqCst)
                || now >= self.deadline)
        {
            let code = if now >= self.deadline {
                "WRITE_TIMEOUT"
            } else {
                "CANCELLED"
            };
            self.interrupted = Some((
                now,
                HostError::new(code, "Native drain completion is not confirmed"),
            ));
            self.cancelled.store(true, Ordering::SeqCst);
        }
        if let Some((at, error)) = &self.interrupted {
            if let Some(join) = &self.join {
                interrupt_thread(join);
            }
            if now.duration_since(*at) >= Duration::from_millis(100) {
                self.settled = true;
                self.isolated.store(true, Ordering::SeqCst);
                return Some(Ok(ControlResult::Drained {
                    status: ControlStatus::Unknown,
                    error: Some(error.clone()),
                }));
            }
        }
        None
    }
}
impl Drop for NativeDrain {
    fn drop(&mut self) {
        let result = self.result.lock().unwrap_or_else(|e| e.into_inner());
        if !self.settled {
            self.isolated.store(true, Ordering::SeqCst);
            self.cancelled.store(true, Ordering::SeqCst);
        }
        if !self.native_finished
            && result.is_none()
            && let Some(join) = &self.join
        {
            interrupt_thread(join);
        }
        drop(result);
        if let Some(join) = self.join.take()
            && join.is_finished()
        {
            let _ = join.join();
        }
    }
}

fn interrupt_thread(join: &JoinHandle<()>) {
    #[cfg(windows)]
    windows::interrupt_thread(join);
    #[cfg(unix)]
    unix::interrupt_thread(join);
}

fn unsupported(message: &str) -> BackendError {
    HostError::new("UNSUPPORTED_CAPABILITY", message).into()
}
fn unknown() -> BackendError {
    HostError::new("CONTROL_UNKNOWN", "Native serial resources remain isolated").into()
}
fn serial_capabilities() -> TransportCapabilities {
    TransportCapabilities {
        semantics: TransportSemantics::Stream,
        configuration: true,
        dtr: true,
        rts: true,
        finite_break: true,
        queue_status: true,
        drain: true,
        purge_rx: true,
        purge_tx: true,
    }
}
fn configuration_receipt(
    requested: &SerialConfiguration,
    actual: &SerialConfiguration,
) -> BackendResult<ConfigApplication> {
    let requested: JsonObject = serde_json::from_value(
        serde_json::to_value(requested)
            .map_err(|_| unsupported("Configuration encoding failed"))?,
    )
    .map_err(|_| unsupported("Configuration encoding failed"))?;
    let readback: JsonObject = serde_json::from_value(
        serde_json::to_value(actual).map_err(|_| unsupported("Configuration readback failed"))?,
    )
    .map_err(|_| unsupported("Configuration readback failed"))?;
    let fields = requested
        .iter()
        .map(|(field, value)| ConfigField {
            field: field.clone(),
            status: if readback.get(field) == Some(value) {
                FieldStatus::Applied
            } else {
                FieldStatus::Rejected
            },
            actual: readback.get(field).cloned(),
        })
        .collect();
    Ok(ConfigApplication { fields, readback })
}
fn require_applied(application: &ConfigApplication) -> BackendResult<()> {
    if application
        .fields
        .iter()
        .all(|field| field.status == FieldStatus::Applied)
    {
        Ok(())
    } else {
        Err(unsupported(
            "Driver readback does not match the requested configuration",
        ))
    }
}
fn check_line(config: &SerialConfiguration, line: ControlLine) -> BackendResult<()> {
    if matches!(
        (config.flow_control, line),
        (FlowControl::RtsCts, ControlLine::Rts) | (FlowControl::DsrDtr, ControlLine::Dtr)
    ) {
        Err(HostError::new("CONTROL_CONFLICT", "Flow control owns this line").into())
    } else {
        Ok(())
    }
}
fn range(start: usize, end: usize) -> ByteRange {
    ByteRange {
        start: (start as u64).into(),
        end: (end as u64).into(),
    }
}
fn native_error(code: &str, os_code: u64) -> BackendError {
    let mut error = HostError::new(code, "Native serial operation failed");
    error.details = serde_json::from_value(serde_json::json!({"osCode": os_code.to_string()}))
        .ok()
        .map(Box::new);
    error.into()
}
