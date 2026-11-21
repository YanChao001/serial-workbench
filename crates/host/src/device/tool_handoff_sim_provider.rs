//! Windows 验收以独占文件句柄模拟设备，串口预约仍使用生产实现。
use super::{
    NativePort, SerialClaim, SerialHandoff, SerialProvider, device_busy, serial_capabilities,
    start_native,
};
use crate::device::{DeviceProvider, virtual_backend::VirtualTransport};
use serial_workbench_core::*;
use std::{
    fs::{File, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;

pub(crate) const SIMULATED_LOCATOR: &str = "COM4294967294";

pub(super) type SimulatedOpen = Arc<
    dyn Fn(
            &DeviceDescriptor,
            &SerialConfiguration,
            SerialClaim,
        ) -> BackendResult<Box<dyn Transport>>
        + Send
        + Sync,
>;

#[derive(Default)]
struct PortSignals {
    opens: AtomicUsize,
    closes: AtomicUsize,
    native_open_attempts: AtomicUsize,
    disconnect_generation: AtomicUsize,
}

#[derive(Clone)]
pub(crate) struct SimSerialProvider {
    serial: SerialProvider,
    descriptor: DeviceDescriptor,
    signals: Arc<PortSignals>,
}

impl SimSerialProvider {
    pub(crate) fn new(host_id: Id, device_lock: PathBuf) -> Self {
        let descriptor = DeviceDescriptor {
            device_id: Id::try_from("simulated:tool-handoff").expect("static device identity"),
            host_id: host_id.clone(),
            system_name: SIMULATED_LOCATOR.into(),
            description: Some("Handoff test fixture".into()),
            manufacturer: None,
            driver: None,
            fingerprint: DeviceFingerprint {
                transport: DeviceTransportKind::Serial,
                vid: Some(0x10c4),
                pid: Some(0xea60),
                serial_number: Some("simulated-handoff-serial".into()),
                topology_path: Some("simulated-usb-path".into()),
                evidence: IdentityEvidence::SerialNumber,
            },
            capabilities: serial_capabilities(),
        };
        let signals = Arc::new(PortSignals::default());
        let owner_signals = signals.clone();
        let mut serial = SerialProvider::new(host_id);
        serial.simulated_open = Some(Arc::new(move |_, configuration, claim| {
            let configuration = configuration.clone();
            let device_lock = device_lock.clone();
            let owner_signals = owner_signals.clone();
            let isolated = claim.isolated.clone();
            start_native(
                move || {
                    let handle = OpenOptions::new()
                        .read(true)
                        .write(true)
                        .create(true)
                        .truncate(false)
                        .share_mode(0)
                        .open(&device_lock)
                        .map_err(|error| {
                            if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) {
                                device_busy()
                            } else {
                                HostError::new(
                                    "SIMULATED_SERIAL_IO",
                                    format!("Cannot acquire the test serial handle: {error}"),
                                )
                            }
                        })?;
                    let generation = owner_signals.opens.fetch_add(1, Ordering::SeqCst) + 1;
                    Ok(Box::new(SimulatedPort {
                        handle: Some(handle),
                        generation,
                        claim,
                        signals: owner_signals,
                        stream: VirtualTransport::new(configuration),
                    }))
                },
                isolated,
            )
        }));
        Self {
            serial,
            descriptor,
            signals,
        }
    }

    pub(crate) fn descriptor(&self) -> DeviceDescriptor {
        self.descriptor.clone()
    }

    pub(crate) fn handle_is_open(&self) -> bool {
        self.open_count() > self.close_count()
    }

    pub(crate) fn disconnect(&self) {
        let generation = self.open_count();
        assert!(
            generation > self.close_count(),
            "A simulated native handle must be open before disconnect"
        );
        self.signals
            .disconnect_generation
            .store(generation, Ordering::SeqCst);
    }

    pub(crate) fn native_open_attempts(&self) -> usize {
        self.signals.native_open_attempts.load(Ordering::SeqCst)
    }

    pub(crate) fn open_count(&self) -> usize {
        self.signals.opens.load(Ordering::SeqCst)
    }

    pub(crate) fn close_count(&self) -> usize {
        self.signals.closes.load(Ordering::SeqCst)
    }
}

impl DeviceProvider for SimSerialProvider {
    fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>> {
        Ok(vec![self.descriptor()])
    }

    fn open(
        &self,
        device: &DeviceDescriptor,
        configuration: &SerialConfiguration,
    ) -> BackendResult<Box<dyn Transport>> {
        self.signals
            .native_open_attempts
            .fetch_add(1, Ordering::SeqCst);
        self.serial.open(device, configuration)
    }

    fn require_tool_quiescence(&self) -> HostResult<()> {
        self.serial.require_tool_quiescence()
    }

    fn reserve_tool_handoff(&self, device: &DeviceDescriptor) -> HostResult<SerialHandoff> {
        self.serial.reserve_tool_handoff(device)
    }
}

struct SimulatedPort {
    handle: Option<File>,
    generation: usize,
    claim: SerialClaim,
    signals: Arc<PortSignals>,
    stream: VirtualTransport,
}

impl SimulatedPort {
    fn close_physical_handle(&mut self) {
        if let Some(handle) = self.handle.take() {
            drop(handle);
            self.signals.closes.fetch_add(1, Ordering::SeqCst);
        }
    }
}

impl Drop for SimulatedPort {
    fn drop(&mut self) {
        self.close_physical_handle();
    }
}

impl NativePort for SimulatedPort {
    fn capabilities(&self) -> TransportCapabilities {
        serial_capabilities()
    }

    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        // 断开只针对产生标记时的原生 owner，不能落到之后打开的句柄。
        if self
            .signals
            .disconnect_generation
            .compare_exchange(self.generation, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return Err(HostError::new(
                "BACKEND_DISCONNECTED",
                "Simulated serial link disconnected",
            )
            .into());
        }
        self.stream.read(limit, wait)
    }

    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        self.stream.begin_write(bytes, wait, cancelled, closing)
    }

    fn configure(
        &mut self,
        configuration: &SerialConfiguration,
    ) -> BackendResult<ConfigApplication> {
        self.stream.configure(configuration)
    }

    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        self.stream.control(command)
    }

    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        self.stream.begin_drain(request)
    }

    fn close(&mut self) -> BackendResult<()> {
        self.stream.close()?;
        self.close_physical_handle();
        self.claim.confirm_release()?;
        Ok(())
    }
}
