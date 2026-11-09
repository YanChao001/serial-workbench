#![allow(dead_code)]
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    device::TransportOpener,
    storage::Store,
};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

pub fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
pub struct ManualClock(pub AtomicU64);
impl Clock for ManualClock {
    fn mono_ns(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    fn wall_time(&self) -> Timestamp {
        Timestamp::try_from("2026-11-07T00:00:00Z").unwrap()
    }
}
impl ManualClock {
    pub fn advance_ms(&self, ms: u64) {
        self.0.fetch_add(ms * 1_000_000, Ordering::SeqCst);
    }
}
#[derive(Default)]
pub struct Gate {
    pub entered: AtomicBool,
    released: Mutex<bool>,
    wake: Condvar,
}
impl Gate {
    pub fn hold(&self) {
        self.entered.store(true, Ordering::SeqCst);
        let mut released = self.released.lock().unwrap();
        while !*released {
            let (next, timeout) = self
                .wake
                .wait_timeout(released, Duration::from_secs(5))
                .unwrap();
            released = next;
            if timeout.timed_out() {
                break;
            }
        }
    }
    pub fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
    pub fn is_released(&self) -> bool {
        *self.released.lock().unwrap()
    }
    pub async fn entered(&self) {
        until(|| self.entered.load(Ordering::SeqCst)).await;
    }
}
#[derive(Default)]
pub struct Probe {
    pub drain_hold: AtomicBool,
    pub drain_started: AtomicBool,
    pub write_cancelled: Mutex<Option<Arc<AtomicBool>>>,
    pub write_completes_on_cancel: AtomicBool,
    pub drain_cancelled: Mutex<Option<Arc<AtomicBool>>>,
    pub drain_release: AtomicBool,
    pub rx_during_drain: AtomicUsize,
    pub read_gate: Mutex<Option<Arc<Gate>>>,
    pub read_fails: AtomicBool,
    pub configured_reads: AtomicUsize,
    pub opens: AtomicUsize,
    pub closes: AtomicUsize,
    pub close_calls: AtomicUsize,
    pub writes: Mutex<Vec<(String, Vec<u8>, Duration)>>,
    pub steps: Mutex<VecDeque<WriteStep>>,
    pub partial_configuration: AtomicBool,
    pub clear_fails: AtomicBool,
    pub break_asserted: AtomicBool,
    pub clear_count: AtomicUsize,
}
pub struct WriteStep {
    pub accepted: usize,
    pub unknown: bool,
    pub gate: Option<Arc<Gate>>,
    pub advance_ms: u64,
}
pub struct Profile(Option<tempfile::TempDir>);
impl Profile {
    pub fn path(&self) -> &std::path::Path {
        self.0.as_ref().unwrap().path()
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let path = self.0.take().unwrap().keep();
            eprintln!("host_test_failed_profile={}", path.display());
        }
    }
}

pub struct Harness {
    pub store: Store,
    pub auth: AuthService,
    pub actor: AuthenticatedActor,
    pub host: Host,
    pub clock: Arc<ManualClock>,
    pub probe: Arc<Probe>,
    pub host_id: Id,
    // Release Host/Store owners before TempDir attempts successful-test cleanup.
    pub dir: Profile,
}
impl Harness {
    pub async fn new() -> Self {
        let evidence =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/rust-failures");
        std::fs::create_dir_all(&evidence).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("host-harness-")
            .tempdir_in(evidence.canonicalize().unwrap())
            .unwrap();
        Self::in_profile(dir).await
    }
    pub async fn in_profile(dir: tempfile::TempDir) -> Self {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let store = Store::open_with_clock(dir.path(), clock.clone()).unwrap();
        let identity = store.begin_instance().unwrap();
        let secret = ContextToken::try_from("test-user-control").unwrap();
        let auth = AuthService::with_clock(store.clone(), secret.clone(), clock.clone());
        let operator = auth
            .authenticate_user_control(&id("operator"), &secret)
            .unwrap();
        let actor = auth.authenticate(&id("client"), None).unwrap().actor;
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: id("client"),
                permissions: vec!["device.modify".into(), "content.read".into()],
                targets: vec![Target {
                    host_id: identity.host_id.clone(),
                    kind: ResourceKind::try_from("host").unwrap(),
                    id: identity.host_id.clone(),
                    session_id: None,
                    session_epoch: None,
                }],
                expires_at: None,
            },
        )
        .unwrap();
        let probe = Arc::new(Probe::default());
        let p = probe.clone();
        let c = clock.clone();
        let opener: TransportOpener = Arc::new(move |device, config| {
            p.opens.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(ScriptedTransport {
                device: device.as_str().into(),
                probe: p.clone(),
                clock: c.clone(),
                configuration: config.clone(),
                configured: false,
                closed: false,
            }))
        });
        let host = Host::with_runtime(store.clone(), auth.clone(), clock.clone(), opener)
            .await
            .unwrap();
        Self {
            dir: Profile(Some(dir)),
            store,
            auth,
            actor,
            host,
            clock,
            probe,
            host_id: identity.host_id,
        }
    }
    pub fn device(&self, name: &str) -> Target {
        Target {
            host_id: self.host_id.clone(),
            kind: ResourceKind::try_from("device").unwrap(),
            id: id(name),
            session_id: None,
            session_epoch: None,
        }
    }
    pub async fn open(&self, name: &str) -> Target {
        let open = self
            .host
            .devices()
            .open(
                &self.device(name),
                OpenParams {
                    binding: None,
                    configuration: SerialConfiguration::default(),
                },
            )
            .await
            .unwrap();
        Target {
            host_id: self.host_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: open.session_id.clone(),
            session_id: Some(open.session_id),
            session_epoch: Some(open.session_epoch),
        }
    }
    pub fn call(&self, target: &Target, action: &str, params: serde_json::Value) -> Call {
        self.call_as(&self.actor, target, action, params)
    }
    pub fn call_as(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        action: &str,
        params: serde_json::Value,
    ) -> Call {
        Call {
            protocol_version: ProtocolVersion::V0_1,
            host_id: self.host_id.clone(),
            instance_epoch: self.store.identity().unwrap().instance_epoch,
            actor_id: actor.id().clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            request_context: self.store.issue_context(actor).unwrap().token,
            action_id: id(action),
            target: target.clone(),
            params: serde_json::from_value(params).unwrap(),
            reveal_target: RevealTarget {
                page_id: id("workbench"),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
            expected_revision: None,
            lease_id: None,
            execution_mode: None,
        }
    }
    pub async fn invoke(&self, call: Call) -> Operation {
        self.host.invoke(&self.actor, call).await.unwrap()
    }
    pub async fn wait(&self, id: &Id) -> Operation {
        let mut last = None;
        let result = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let store = self.store.clone();
                let actor = self.actor.clone();
                let id = id.clone();
                let operation = tokio::task::spawn_blocking(move || store.get(&actor, &id))
                    .await
                    .unwrap()
                    .unwrap();
                if terminal(operation.state) {
                    return operation;
                }
                last = Some(operation);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        if result.is_err() {
            let last = last.as_ref().map(|operation| {
                let transfer = match &operation.result {
                    Some(ActionResult::FileTransfer(value)) => Some(serde_json::json!({
                        "accepted": value.accepted,
                        "unknown": value.unknown,
                        "receiptsRef": value.receipts_ref,
                    })),
                    _ => None,
                };
                serde_json::json!({
                    "state": operation.state,
                    "revision": operation.revision,
                    "error": operation.error,
                    "transfer": transfer,
                })
            });
            eprintln!(
                "host_test_wait_timeout operation={id} profile={} last={last:?} writes={} remaining_steps={} clock_ns={}",
                self.dir.path().display(),
                self.probe.writes.lock().unwrap().len(),
                self.probe.steps.lock().unwrap().len(),
                self.clock.mono_ns(),
            );
        }
        result.unwrap()
    }
    pub async fn send(&self, target: &Target) -> Operation {
        let op = self
            .invoke(self.call(
                target,
                "session.tx",
                serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
            ))
            .await;
        self.wait(&op.operation_id).await
    }
    pub async fn action(
        &self,
        target: &Target,
        action: &str,
        params: serde_json::Value,
    ) -> Operation {
        let op = self.invoke(self.call(target, action, params)).await;
        self.wait(&op.operation_id).await
    }
    pub async fn cancel(&self, operation: &Operation) -> Operation {
        let target = Target {
            host_id: self.host_id.clone(),
            kind: ResourceKind::try_from("operation").unwrap(),
            id: operation.operation_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        self.action(
            &target,
            "operation.cancel",
            serde_json::json!({"reason":"user"}),
        )
        .await
    }
    pub fn write_count(&self) -> usize {
        self.probe.writes.lock().unwrap().len()
    }
    pub fn new_actor(&self, name: &str) -> AuthenticatedActor {
        let operator = self
            .auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let actor = self.auth.authenticate(&id(name), None).unwrap().actor;
        self.auth
            .authorize(
                &operator,
                AuthorizeParams {
                    client_id: id(name),
                    permissions: vec!["device.modify".into(), "content.read".into()],
                    targets: vec![Target {
                        host_id: self.host_id.clone(),
                        kind: ResourceKind::try_from("host").unwrap(),
                        id: self.host_id.clone(),
                        session_id: None,
                        session_epoch: None,
                    }],
                    expires_at: None,
                },
            )
            .unwrap();
        actor
    }
}
pub fn terminal(state: OperationState) -> bool {
    !matches!(
        state,
        OperationState::Queued | OperationState::Running | OperationState::CancelRequested
    )
}
pub fn receipt(op: &Operation) -> &TxReceipt {
    match &op.result {
        Some(ActionResult::Tx(v)) => v,
        other => panic!(
            "Expected TX receipt: {other:?}, state={:?}, error={:?}",
            op.state, op.error
        ),
    }
}
pub async fn until(check: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
}
struct ScriptedTransport {
    device: String,
    probe: Arc<Probe>,
    clock: Arc<ManualClock>,
    configuration: SerialConfiguration,
    configured: bool,
    closed: bool,
}
impl Transport for ScriptedTransport {
    fn capabilities(&self) -> TransportCapabilities {
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
    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        let gate = self.probe.read_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.hold();
        }
        if self.probe.read_fails.load(Ordering::SeqCst) {
            return Err(HostError::new("BACKEND_DISCONNECTED", "Scripted read failed").into());
        }
        if self.configured {
            self.probe.configured_reads.fetch_add(1, Ordering::SeqCst);
        }
        assert!(limit <= 16384);
        assert!(wait <= Duration::from_millis(20));
        Ok(ReadBlock {
            bytes: if self.probe.drain_started.load(Ordering::SeqCst)
                && !self.probe.drain_release.load(Ordering::SeqCst)
            {
                self.probe.rx_during_drain.fetch_add(1, Ordering::SeqCst);
                Arc::from([7])
            } else {
                Arc::from([])
            },
            message: None,
        })
    }
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        _: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        *self.probe.write_cancelled.lock().unwrap() = Some(cancelled.clone());
        assert!(bytes.len() <= 16384);
        self.probe
            .writes
            .lock()
            .unwrap()
            .push((self.device.clone(), bytes.to_vec(), wait));
        let step = self.probe.steps.lock().unwrap().pop_front();
        if let Some(step) = step {
            assert_ne!(
                step.accepted,
                usize::MAX,
                "Scripted owner lost its write receipt"
            );
            let count = step.accepted.min(bytes.len());
            let result = BackendWrite {
                accepted_ranges: if count > 0 {
                    vec![ByteRange {
                        start: 0.into(),
                        end: (count as u64).into(),
                    }]
                } else {
                    vec![]
                },
                unknown_ranges: if step.unknown {
                    vec![ByteRange {
                        start: (count as u64).into(),
                        end: (bytes.len() as u64).into(),
                    }]
                } else {
                    vec![]
                },
                error: if count < bytes.len() {
                    Some(HostError::new("WRITE_TIMEOUT", "Scripted write stopped"))
                } else {
                    None
                },
            };
            if let Some(gate) = &step.gate {
                gate.entered.store(true, Ordering::SeqCst);
            }
            Ok(Box::new(ScriptedWrite {
                result: Some(result),
                gate: step.gate,
                clock: self.clock.clone(),
                advance_ms: step.advance_ms,
                cancelled: self
                    .probe
                    .write_completes_on_cancel
                    .load(Ordering::SeqCst)
                    .then_some(cancelled),
            }))
        } else {
            Ok(pending_write(
                BackendWrite {
                    accepted_ranges: vec![ByteRange {
                        start: 0.into(),
                        end: (bytes.len() as u64).into(),
                    }],
                    unknown_ranges: vec![],
                    error: None,
                },
                None,
            ))
        }
    }
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        self.configured = true;
        let requested = serde_json::to_value(config).unwrap();
        let partial = self.probe.partial_configuration.load(Ordering::SeqCst);
        let old_parity = self.configuration.parity;
        self.configuration = config.clone();
        if partial {
            self.configuration.parity = old_parity;
        }
        let actual = serde_json::to_value(&self.configuration).unwrap();
        let fields = requested
            .as_object()
            .unwrap()
            .keys()
            .map(|key| ConfigField {
                field: key.clone(),
                status: if partial && key == "parity" {
                    FieldStatus::Rejected
                } else {
                    FieldStatus::Applied
                },
                actual: Some(serde_json::from_value(actual[key].clone()).unwrap()),
            })
            .collect();
        Ok(ConfigApplication {
            fields,
            readback: serde_json::from_value(actual).unwrap(),
        })
    }
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        match command {
            ControlCommand::SetLine { line, value } => Ok(ControlResult::Line { line, value }),
            ControlCommand::AssertBreak => {
                self.probe.break_asserted.store(true, Ordering::SeqCst);
                Ok(ControlResult::Break { asserted: true })
            }
            ControlCommand::ClearBreak => {
                self.probe.clear_count.fetch_add(1, Ordering::SeqCst);
                if self.probe.clear_fails.load(Ordering::SeqCst) {
                    Err(HostError::new("CONTROL_UNKNOWN", "Scripted clear failed").into())
                } else {
                    self.probe.break_asserted.store(false, Ordering::SeqCst);
                    Ok(ControlResult::Break { asserted: false })
                }
            }
            ControlCommand::QueueStatus => Ok(ControlResult::Queue {
                pending_bytes: 0.into(),
            }),
            ControlCommand::ModemStatus => {
                Err(HostError::new("UNSUPPORTED_CAPABILITY", "No modem inputs").into())
            }
            ControlCommand::Purge { .. } => Ok(ControlResult::Purged {
                ranges: vec![],
                unknown_extent: false,
            }),
        }
    }
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        *self.probe.drain_cancelled.lock().unwrap() = Some(request.cancelled.clone());
        if self.probe.drain_hold.load(Ordering::SeqCst) {
            self.probe.drain_started.store(true, Ordering::SeqCst);
            return Ok(Box::new(ScriptedDrain {
                probe: self.probe.clone(),
                request,
                settled: false,
            }));
        }
        serial_workbench_host::device::virtual_backend::VirtualTransport::new(
            SerialConfiguration::default(),
        )
        .begin_drain(request)
    }
    fn close(&mut self) -> BackendResult<()> {
        self.probe.close_calls.fetch_add(1, Ordering::SeqCst);
        if !self.closed {
            self.closed = true;
            self.probe.closes.fetch_add(1, Ordering::SeqCst);
        }
        Ok(())
    }
}

struct ScriptedWrite {
    result: Option<BackendWrite>,
    gate: Option<Arc<Gate>>,
    clock: Arc<ManualClock>,
    advance_ms: u64,
    cancelled: Option<Arc<AtomicBool>>,
}
impl PendingWrite for ScriptedWrite {
    fn poll(&mut self) -> Option<BackendResult<BackendWrite>> {
        if self.gate.as_ref().is_some_and(|gate| !gate.is_released())
            && !self
                .cancelled
                .as_ref()
                .is_some_and(|cancelled| cancelled.load(Ordering::SeqCst))
        {
            return None;
        }
        let result = self.result.take()?;
        self.clock.advance_ms(self.advance_ms);
        Some(Ok(result))
    }
}
struct TestWrite {
    result: Option<BackendWrite>,
    gate: Option<Arc<Gate>>,
    cancelled: Option<Arc<AtomicBool>>,
}
impl PendingWrite for TestWrite {
    fn poll(&mut self) -> Option<BackendResult<BackendWrite>> {
        if self.gate.as_ref().is_some_and(|gate| !gate.is_released())
            && !self
                .cancelled
                .as_ref()
                .is_some_and(|cancelled| cancelled.load(Ordering::SeqCst))
        {
            return None;
        }
        self.result.take().map(Ok)
    }
}
pub fn pending_write(result: BackendWrite, gate: Option<Arc<Gate>>) -> Box<dyn PendingWrite> {
    if let Some(gate) = &gate {
        gate.entered.store(true, Ordering::SeqCst);
    }
    Box::new(TestWrite {
        result: Some(result),
        gate,
        cancelled: None,
    })
}
pub fn pending_write_on_cancel(
    result: BackendWrite,
    gate: Option<Arc<Gate>>,
    cancelled: Arc<AtomicBool>,
) -> Box<dyn PendingWrite> {
    if let Some(gate) = &gate {
        gate.entered.store(true, Ordering::SeqCst);
    }
    Box::new(TestWrite {
        result: Some(result),
        gate,
        cancelled: Some(cancelled),
    })
}

struct ScriptedDrain {
    probe: Arc<Probe>,
    request: DrainRequest,
    settled: bool,
}
impl PendingDrain for ScriptedDrain {
    fn poll(&mut self) -> Option<BackendResult<ControlResult>> {
        if self.settled {
            return None;
        }
        let status = if self.probe.drain_release.load(Ordering::SeqCst) {
            ControlStatus::Confirmed
        } else if self.request.cancelled.load(Ordering::SeqCst)
            || self.request.closing.load(Ordering::SeqCst)
        {
            ControlStatus::Unknown
        } else {
            return None;
        };
        self.settled = true;
        Some(Ok(ControlResult::Drained {
            status,
            error: None,
        }))
    }
}
