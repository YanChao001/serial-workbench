use crate::{
    auth::{AuthService, HostIdentity},
    state::ProjectionStore,
    storage::Store,
    stream::{SourceBoundary, SourceMeta, StreamHub, StreamKey, StreamSource},
};
use serial_workbench_core::*;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tokio::sync::oneshot;

pub type TransportOpener =
    Arc<dyn Fn(&Id, &SerialConfiguration) -> BackendResult<Box<dyn Transport>> + Send + Sync>;
type DeviceSlot = Arc<tokio::sync::Mutex<Option<Arc<Session>>>>;
#[derive(Clone)]
pub struct DeviceService {
    pub(crate) inner: Arc<DeviceInner>,
}
pub(crate) struct DeviceInner {
    pub store: Store,
    pub auth: AuthService,
    pub identity: HostIdentity,
    pub streams: StreamHub,
    pub clock: Arc<dyn Clock>,
    projections: ProjectionStore,
    opener: TransportOpener,
    slots: Mutex<HashMap<Id, DeviceSlot>>,
    sessions: Mutex<HashMap<Id, Arc<Session>>>,
    pub closing: AtomicBool,
}
pub(crate) struct Session {
    pub snapshot: Arc<Mutex<SessionSnapshot>>,
    pub source: StreamSource,
    sender: mpsc::SyncSender<BackendCommand>,
    join: Mutex<Option<JoinHandle<()>>>,
    pub document_revision: tokio::sync::Mutex<U64>,
    projections: ProjectionStore,
}
pub(crate) struct ConfigurationChange {
    result: Option<BackendResult<ConfigApplication>>,
    resume: Option<mpsc::SyncSender<()>>,
}
pub(crate) struct BackendAdmission {
    pub session_epoch: U64,
    pub actor_id: Id,
    pub lease_id: Option<Id>,
    pub lease: Arc<Mutex<Option<Lease>>>,
    pub cancelled: Arc<AtomicBool>,
}
impl BackendAdmission {
    fn begin(
        &self,
        snapshot: &Mutex<SessionSnapshot>,
        clock: &dyn Clock,
        asserting_break: bool,
    ) -> HostResult<()> {
        // 与 renew/revoke 使用同一租约锁；此处是 owner 开始调用的线性化点，
        // 之后直到 backend 调用没有 await，也不跨后端等待持锁。
        let lease = self.lease.lock().map_err(|_| unavailable())?;
        let snapshot = snapshot.lock().map_err(|_| unavailable())?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err(HostError::new(
                "CANCELLED",
                "Backend submission was cancelled",
            ));
        }
        if snapshot.session_epoch != self.session_epoch {
            return Err(HostError::new("EPOCH_MISMATCH", "Session epoch changed"));
        }
        if snapshot.state != SessionState::Open {
            return Err(unavailable());
        }
        if snapshot.tx_gate == TxGate::ControlUnknown
            && !(asserting_break && snapshot.control_state == ControlState::Asserting)
        {
            return Err(HostError::new(
                "CONTROL_UNKNOWN",
                "Session remains isolated",
            ));
        }
        if let Some(expected) = &self.lease_id {
            if !lease.as_ref().is_some_and(|current| {
                &current.lease_id == expected
                    && current.actor_id == self.actor_id
                    && current.session_epoch == self.session_epoch
                    && current.state == LeaseState::Active
                    && clock.mono_ns() < current.expires_at_mono_ns.get()
            }) {
                return Err(HostError::new(
                    "LEASE_EXPIRED",
                    "Lease expired before backend submission",
                ));
            }
        } else if lease.as_ref().is_some_and(|current| {
            matches!(current.state, LeaseState::Active | LeaseState::Revoking)
        }) {
            return Err(HostError::new("LEASE_CONFLICT", "A lease owns the session"));
        }
        Ok(())
    }
}
impl ConfigurationChange {
    pub fn resume(mut self) {
        if let Some(resume) = self.resume.take() {
            let _ = resume.try_send(());
        }
    }
    pub fn take_result(&mut self) -> BackendResult<ConfigApplication> {
        self.result.take().unwrap_or_else(|| Err(invalid().into()))
    }
    pub fn stop(&mut self) {
        self.resume.take();
    }
}
enum BackendCommand {
    Write(
        Arc<[u8]>,
        Duration,
        BackendAdmission,
        oneshot::Sender<BackendResult<BackendWrite>>,
    ),
    Configure(
        SerialConfiguration,
        BackendAdmission,
        oneshot::Sender<BackendResult<ConfigApplication>>,
        mpsc::Receiver<()>,
    ),
    Control(
        ControlCommand,
        Option<BackendAdmission>,
        oneshot::Sender<BackendResult<ControlResult>>,
    ),
    Close(oneshot::Sender<BackendResult<()>>),
}
impl DeviceService {
    pub fn new(
        store: Store,
        auth: AuthService,
        identity: HostIdentity,
        streams: StreamHub,
        clock: Arc<dyn Clock>,
        opener: TransportOpener,
        projections: ProjectionStore,
    ) -> Self {
        Self {
            inner: Arc::new(DeviceInner {
                store,
                auth,
                identity,
                streams,
                clock,
                opener,
                projections,
                slots: Mutex::new(HashMap::new()),
                sessions: Mutex::new(HashMap::new()),
                closing: AtomicBool::new(false),
            }),
        }
    }
    pub fn virtual_opener() -> TransportOpener {
        Arc::new(|device, config| {
            if device.as_str() != "virtual:echo" {
                return Err(HostError::new("NOT_FOUND", "Device was not found").into());
            }
            Ok(Box::new(super::virtual_backend::VirtualTransport::new(
                config.clone(),
            )))
        })
    }
    pub async fn open(&self, target: &Target, params: OpenParams) -> HostResult<OpenResult> {
        if target.host_id != self.inner.identity.host_id || target.kind.as_str() != "device" {
            return Err(invalid());
        }
        if self.inner.closing.load(Ordering::SeqCst) {
            return Err(closing());
        }
        let slot = {
            let mut slots = self.inner.slots.lock().map_err(|_| unavailable())?;
            let mut retired = Vec::new();
            slots.retain(|device, slot| {
                if device == &target.id || Arc::strong_count(slot) != 1 {
                    return true;
                }
                let Ok(current) = slot.try_lock() else {
                    return true;
                };
                match current.as_ref() {
                    None => false,
                    Some(session) => {
                        if let Ok(state) = session.snapshot() {
                            if state.state == SessionState::Closed
                                && state.tx_gate != TxGate::ControlUnknown
                            {
                                retired.push(state.session_id);
                                false
                            } else {
                                true
                            }
                        } else {
                            true
                        }
                    }
                }
            });
            if !retired.is_empty() {
                self.inner
                    .sessions
                    .lock()
                    .map_err(|_| unavailable())?
                    .retain(|id, _| !retired.contains(id));
            }
            if !slots.contains_key(&target.id) && slots.len() >= 16 {
                return Err(HostError::new(
                    "LIMIT_EXCEEDED",
                    "Session capacity exhausted",
                ));
            }
            slots
                .entry(target.id.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
                .clone()
        };
        let mut current = slot.lock().await;
        if let Some(session) = current.as_ref() {
            let snapshot = session.snapshot()?;
            if snapshot.tx_gate == TxGate::ControlUnknown {
                return Err(HostError::new(
                    "CONTROL_UNKNOWN",
                    "Device requires confirmed line recovery",
                ));
            }
            if snapshot.state == SessionState::Closing {
                return Err(HostError::new(
                    "HOST_BUSY",
                    "Session owner is still closing",
                ));
            }
            if snapshot.state == SessionState::Open {
                if snapshot.configuration != params.configuration {
                    return Err(HostError::new(
                        "CONFIGURATION_CONFLICT",
                        "Device is open with a different configuration",
                    ));
                }
                return Ok(OpenResult {
                    session_id: snapshot.session_id,
                    session_epoch: snapshot.session_epoch,
                    revision: snapshot.revision,
                    reused: true,
                });
            }
            if snapshot.state != SessionState::Closed {
                session.close().await?;
                self.persist(session).await?;
            }
        }
        let document_id = document_id(&target.id)?;
        let store = self.inner.store.clone();
        let key = document_id.clone();
        let stored = blocking(move || store.read_document(&key)).await?;
        let previous: Option<SessionSnapshot> =
            stored.as_ref().map(|v| decode(&v.value)).transpose()?;
        if previous.as_ref().is_some_and(|v| {
            v.tx_gate == TxGate::ControlUnknown || v.control_state != ControlState::Clear
        }) {
            return Err(HostError::new(
                "CONTROL_UNKNOWN",
                "Unsettled line responsibility prevents reopen",
            ));
        }
        let epoch = previous
            .as_ref()
            .map_or(Ok(U64::from(1)), |v| v.session_epoch.checked_next())?;
        let session_id = previous
            .as_ref()
            .map_or_else(new_id, |v| v.session_id.clone());
        let (ready, opened) = oneshot::channel();
        let (start, started) = mpsc::sync_channel(1);
        let (sender, receiver) = mpsc::sync_channel(8);
        let opener = self.inner.opener.clone();
        let device = target.id.clone();
        let config = params.configuration.clone();
        let clock = self.inner.clock.clone();
        let projections = self.inner.projections.clone();
        let identity = self.inner.identity.clone();
        let join = thread::Builder::new()
            .name(format!("device-{}", target.id.as_str()))
            .spawn(move || {
                let mut backend = match opener(&device, &config) {
                    Ok(v) => v,
                    Err(e) => {
                        let _ = ready.send(Err(*e.error));
                        return;
                    }
                };
                if ready.send(Ok(backend.capabilities())).is_err() {
                    let _ = backend.close();
                    return;
                }
                let Ok((snapshot, source)) = started.recv() else {
                    let _ = backend.close();
                    return;
                };
                owner_loop(
                    backend,
                    receiver,
                    snapshot,
                    source,
                    clock,
                    identity,
                    projections,
                );
            })
            .map_err(|_| unavailable())?;
        // 启动失败也等待唯一owner退出，不能把未关闭句柄留在已脱离的线程里。
        let prepared: HostResult<_> = async {
            let capabilities = opened.await.map_err(|_| unavailable())??;
            let snapshot = SessionSnapshot {
                session_id: session_id.clone(),
                device_id: target.id.clone(),
                session_epoch: epoch,
                revision: previous
                    .as_ref()
                    .map_or(Ok(U64::from(1)), |v| v.revision.checked_next())?,
                configuration_revision: previous.as_ref().map_or(Ok(U64::from(1)), |v| {
                    v.configuration_revision.checked_next()
                })?,
                state: SessionState::Open,
                configuration: params.configuration,
                read_only: previous.as_ref().is_some_and(|v| v.read_only),
                tx_gate: TxGate::Ready,
                control_state: ControlState::Clear,
                capabilities,
                lease: None,
            };
            let expected = stored.map_or(U64::from(0), |v| v.revision);
            let value = object(&snapshot)?;
            let store = self.inner.store.clone();
            let persisted =
                blocking(move || store.compare_and_swap_document(&document_id, expected, value))
                    .await?;
            let target = Target {
                host_id: self.inner.identity.host_id.clone(),
                kind: ResourceKind::try_from("session")?,
                id: session_id.clone(),
                session_id: Some(session_id.clone()),
                session_epoch: Some(epoch),
            };
            let source = self.inner.streams.register_source(
                StreamKey {
                    session_id: session_id.clone(),
                    session_epoch: epoch,
                },
                target.clone(),
            )?;
            if let Err(error) = source.append_boundary(
                source_meta(
                    &self.inner.identity,
                    self.inner.clock.as_ref(),
                    snapshot.configuration_revision,
                ),
                SourceBoundary::Lifecycle(object(&serde_json::json!({"state":"open"}))?),
            ) {
                let _ = source.fail(error.clone());
                return Err(error);
            }
            let scope = scope_id(&snapshot.session_id)?;
            let state = object(&snapshot)?;
            let published = match self.inner.projections.register_scope(
                scope.clone(),
                target.clone(),
                "metadata.read".into(),
                state.clone(),
            ) {
                Ok(()) => Ok(()),
                Err(error) if error.code == "REVISION_CONFLICT" => self
                    .inner
                    .projections
                    .commit_for_target(
                        &scope,
                        target,
                        Id::try_from("session.changed")?,
                        state.clone(),
                        state,
                    )
                    .map(|_| ()),
                Err(error) => Err(error),
            };
            if let Err(error) = published {
                let _ = source.close();
                return Err(error);
            }
            Ok((snapshot, source, persisted.revision))
        }
        .await;
        let (snapshot, source, document_revision) = match prepared {
            Ok(v) => v,
            Err(error) => {
                drop(start);
                blocking(move || join.join().map_err(|_| unavailable())).await?;
                return Err(error);
            }
        };
        let snapshot = Arc::new(Mutex::new(snapshot));
        start
            .send((snapshot.clone(), source.clone()))
            .map_err(|_| unavailable())?;
        let session = Arc::new(Session {
            snapshot,
            source,
            sender,
            join: Mutex::new(Some(join)),
            document_revision: tokio::sync::Mutex::new(document_revision),
            projections: self.inner.projections.clone(),
        });
        let result = session.snapshot()?;
        self.inner
            .sessions
            .lock()
            .map_err(|_| unavailable())?
            .insert(session_id, session.clone());
        *current = Some(session);
        Ok(OpenResult {
            session_id: result.session_id,
            session_epoch: result.session_epoch,
            revision: result.revision,
            reused: false,
        })
    }
    pub async fn snapshot(&self, target: &Target) -> HostResult<SessionSnapshot> {
        self.session(target)?.snapshot()
    }
    pub(crate) fn session(&self, target: &Target) -> HostResult<Arc<Session>> {
        if target.host_id != self.inner.identity.host_id || target.kind.as_str() != "session" {
            return Err(invalid());
        }
        let session = self
            .inner
            .sessions
            .lock()
            .map_err(|_| unavailable())?
            .get(&target.id)
            .cloned()
            .ok_or_else(|| HostError::new("NOT_FOUND", "Session was not found"))?;
        if target.session_epoch != Some(session.snapshot()?.session_epoch) {
            return Err(HostError::new("EPOCH_MISMATCH", "Session epoch changed"));
        }
        Ok(session)
    }
    pub(crate) async fn persist(&self, session: &Session) -> HostResult<()> {
        let mut revision = session.document_revision.lock().await;
        let snapshot = session.snapshot()?;
        let key = document_id(&snapshot.device_id)?;
        let value = object(&snapshot)?;
        let store = self.inner.store.clone();
        let expected = *revision;
        *revision = blocking(move || store.compare_and_swap_document(&key, expected, value))
            .await?
            .revision;
        self.publish(&snapshot)?;
        Ok(())
    }
    pub(crate) fn publish(&self, snapshot: &SessionSnapshot) -> HostResult<()> {
        let value = object(snapshot)?;
        self.inner.projections.commit(
            &scope_id(&snapshot.session_id)?,
            Id::try_from("session.changed")?,
            value.clone(),
            value,
        )?;
        Ok(())
    }
    pub(crate) async fn publish_lease(
        &self,
        session: &Session,
        lease: Option<Lease>,
    ) -> HostResult<()> {
        {
            let mut state = session.snapshot.lock().map_err(|_| invalid())?;
            state.lease = lease;
            state.revision = state.revision.checked_next()?;
        }
        self.persist(session).await
    }
    pub(crate) fn meta(&self, session: &Session) -> HostResult<SourceMeta> {
        Ok(source_meta(
            &self.inner.identity,
            self.inner.clock.as_ref(),
            session.snapshot()?.configuration_revision,
        ))
    }
    pub(crate) fn sessions(&self) -> HostResult<Vec<Arc<Session>>> {
        Ok(self
            .inner
            .sessions
            .lock()
            .map_err(|_| unavailable())?
            .values()
            .cloned()
            .collect())
    }
    pub async fn shutdown(&self) -> HostResult<()> {
        self.inner.closing.store(true, Ordering::SeqCst);
        let mut failure = None;
        for session in self.sessions()? {
            if session.snapshot()?.state == SessionState::Closed {
                continue;
            }
            if let Err(error) = session.close().await {
                failure.get_or_insert(error);
            }
            if let Err(error) = self.persist(&session).await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}
impl Session {
    pub fn snapshot(&self) -> HostResult<SessionSnapshot> {
        self.snapshot
            .lock()
            .map(|v| v.clone())
            .map_err(|_| unavailable())
    }
    pub async fn write(
        &self,
        bytes: Arc<[u8]>,
        wait: Duration,
        admission: BackendAdmission,
    ) -> BackendResult<BackendWrite> {
        let (send, receive) = oneshot::channel();
        if let Err(error) = self
            .sender
            .try_send(BackendCommand::Write(bytes, wait, admission, send))
        {
            // try_send 返回命令本身：owner 未接纳，不能把已知零写入结算为 unknown。
            return Ok(BackendWrite {
                accepted_ranges: vec![],
                unknown_ranges: vec![],
                error: Some(match error {
                    mpsc::TrySendError::Full(_) => {
                        HostError::new("HOST_BUSY", "Device owner mailbox is full")
                    }
                    mpsc::TrySendError::Disconnected(_) => unavailable(),
                }),
            });
        }
        match receive.await {
            Ok(result) => result,
            Err(_) => {
                let error = unavailable();
                disconnected(
                    &self.snapshot,
                    &self.projections,
                    &self.source,
                    error.clone(),
                );
                Err(error.into())
            }
        }
    }
    pub async fn configure(
        &self,
        config: SerialConfiguration,
        admission: BackendAdmission,
    ) -> ConfigurationChange {
        let (send, receive) = oneshot::channel();
        let (resume, resumed) = mpsc::sync_channel(1);
        let result = match self
            .sender
            .try_send(BackendCommand::Configure(config, admission, send, resumed))
        {
            Ok(()) => receive.await.unwrap_or_else(|_| Err(unavailable().into())),
            Err(_) => Err(unavailable().into()),
        };
        ConfigurationChange {
            result: Some(result),
            resume: Some(resume),
        }
    }
    pub async fn control(
        &self,
        command: ControlCommand,
        admission: Option<BackendAdmission>,
    ) -> BackendResult<ControlResult> {
        let (send, receive) = oneshot::channel();
        {
            // 和 close 的状态迁移共用锁，关闭后不能再由普通查询填充邮箱。
            let state = self.snapshot.lock().map_err(|_| unavailable())?;
            if matches!(command, ControlCommand::QueueStatus)
                && matches!(state.state, SessionState::Closing | SessionState::Closed)
            {
                return Err(HostError::new("HOST_BUSY", "Session is closing").into());
            }
            self.sender
                .try_send(BackendCommand::Control(command, admission, send))
                .map_err(|_| BackendError::from(unavailable()))?;
        }
        receive
            .await
            .map_err(|_| BackendError::from(unavailable()))?
    }
    pub async fn close(&self) -> HostResult<()> {
        {
            let mut state = self.snapshot.lock().map_err(|_| unavailable())?;
            if state.state == SessionState::Closed {
                return Ok(());
            }
            state.state = SessionState::Closing;
            if state.tx_gate != TxGate::ControlUnknown {
                state.tx_gate = TxGate::Closing;
            }
        }
        let (send, receive) = oneshot::channel();
        let sender = self.sender.clone();
        // 保留八槽邮箱；仅关闭在 blocking 池等待容量，可靠提交退出命令后才能 join。
        let submitted =
            blocking(move || Ok(sender.send(BackendCommand::Close(send)).is_ok())).await;
        let mut result = match submitted {
            Ok(true) => receive
                .await
                .unwrap_or_else(|_| Err(unavailable().into()))
                .map_err(|e| *e.error),
            Ok(false) => Ok(()),
            Err(error) => Err(error),
        };
        let join = self.join.lock().map_err(|_| unavailable())?.take();
        if let Some(join) = join
            && let Err(error) = blocking(move || join.join().map_err(|_| unavailable())).await
        {
            let _ = self.source.fail(error.clone());
            result = Err(error);
        }
        if let Err(error) = self.source.close() {
            result = Err(error);
        }
        let mut state = self.snapshot.lock().map_err(|_| unavailable())?;
        state.state = SessionState::Closed;
        if state.tx_gate != TxGate::ControlUnknown {
            state.tx_gate = TxGate::Disconnected;
        }
        result
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let (send, _) = oneshot::channel();
        let _ = self.sender.send(BackendCommand::Close(send));
        if let Ok(join) = self.join.get_mut()
            && let Some(join) = join.take()
        {
            let _ = join.join();
        }
    }
}
fn owner_loop(
    mut backend: Box<dyn Transport>,
    receiver: mpsc::Receiver<BackendCommand>,
    snapshot: Arc<Mutex<SessionSnapshot>>,
    source: StreamSource,
    clock: Arc<dyn Clock>,
    identity: HostIdentity,
    projections: ProjectionStore,
) {
    loop {
        match receiver.recv_timeout(Duration::from_millis(1)) {
            Ok(BackendCommand::Write(bytes, wait, admission, send)) => {
                let result = if let Err(error) = admission.begin(&snapshot, clock.as_ref(), false) {
                    Ok(BackendWrite {
                        accepted_ranges: vec![],
                        unknown_ranges: vec![],
                        error: Some(error),
                    })
                } else {
                    backend.write(&bytes, wait)
                };
                let _ = send.send(result);
            }
            Ok(BackendCommand::Configure(config, admission, send, resumed)) => {
                let result = admission
                    .begin(&snapshot, clock.as_ref(), false)
                    .map_err(BackendError::from)
                    .and_then(|()| backend.configure(&config));
                let _ = send.send(result);
                if resumed.recv().is_err() {
                    break;
                }
            }
            Ok(BackendCommand::Control(command, admission, send)) => {
                let check = admission.map_or(Ok(()), |admission| {
                    admission.begin(
                        &snapshot,
                        clock.as_ref(),
                        matches!(command, ControlCommand::AssertBreak),
                    )
                });
                let _ = send.send(
                    check
                        .map_err(BackendError::from)
                        .and_then(|()| backend.control(command)),
                );
            }
            Ok(BackendCommand::Close(send)) => {
                let result = backend.close();
                if let Ok(state) = snapshot.lock() {
                    let boundary = object(
                        &serde_json::json!({"state":if result.is_ok(){"closed"}else{"disconnected"}}),
                    );
                    if let Ok(boundary) = boundary
                        && let Err(error) = source.append_boundary(
                            source_meta(&identity, clock.as_ref(), state.configuration_revision),
                            SourceBoundary::Lifecycle(boundary),
                        )
                    {
                        let _ = source.fail(error);
                    }
                }
                let _ = send.send(result);
                return;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        match backend.read(16 * 1024, Duration::from_millis(20)) {
            Ok(block) if !block.bytes.is_empty() => {
                let revision = match snapshot.lock() {
                    Ok(v) => v.configuration_revision,
                    Err(_) => break,
                };
                if let Err(error) = source.append_rx(
                    source_meta(&identity, clock.as_ref(), revision),
                    block.bytes,
                    block.message,
                ) {
                    disconnected(&snapshot, &projections, &source, error);
                    break;
                }
            }
            Err(error) => {
                disconnected(&snapshot, &projections, &source, *error.error);
                break;
            }
            _ => {}
        }
    }
    let _ = backend.close();
}
fn disconnected(
    snapshot: &Mutex<SessionSnapshot>,
    projections: &ProjectionStore,
    source: &StreamSource,
    error: HostError,
) {
    if let Ok(mut state) = snapshot.lock() {
        state.state = SessionState::Disconnected;
        if state.tx_gate != TxGate::ControlUnknown {
            state.tx_gate = TxGate::Disconnected;
        }
        if let Ok(revision) = state.revision.checked_next() {
            state.revision = revision;
        }
        if let (Ok(scope), Ok(value), Ok(event)) = (
            scope_id(&state.session_id),
            object(&*state),
            Id::try_from("session.changed"),
        ) {
            let _ = projections.commit(&scope, event, value.clone(), value);
        }
    }
    let _ = source.fail(error);
}
pub(crate) fn source_meta(identity: &HostIdentity, clock: &dyn Clock, revision: U64) -> SourceMeta {
    SourceMeta {
        configuration_revision: revision,
        time: EventTime {
            clock_id: Id::try_from(format!("clock-{}", identity.instance_epoch.get()).as_str())
                .expect("clock id"),
            source_mono_ns: (clock.mono_ns() / 1_000_000 * 1_000_000).into(),
            received_wall_time: clock.wall_time(),
            source_wall_time: None,
            precision: TimePrecision {
                source: TimeSource::HostRead,
                resolution_ns: 1_000_000.into(),
                sync_method: "host_suspend_inclusive_quantized".into(),
                offset_estimate_ns: None,
                offset_error_ns: None,
                rtt_ns: None,
            },
        },
    }
}
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> HostResult<T> + Send + 'static,
) -> HostResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| unavailable())?
}
pub(crate) fn object<T: serde::Serialize>(value: &T) -> HostResult<JsonObject> {
    serde_json::from_value(serde_json::to_value(value).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(value: &JsonObject) -> HostResult<T> {
    serde_json::from_value(serde_json::to_value(value).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
fn document_id(device: &Id) -> HostResult<Id> {
    Id::try_from(format!("device:{}", device.as_str()).as_str())
}
fn scope_id(session: &Id) -> HostResult<Id> {
    Id::try_from(format!("session:{}", session.as_str()).as_str())
}
pub(crate) fn new_id() -> Id {
    Id::try_from(uuid::Uuid::new_v4().to_string().as_str()).expect("UUID")
}
pub(crate) fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid session parameters")
}
pub(crate) fn unavailable() -> HostError {
    HostError::new("BACKEND_DISCONNECTED", "Device owner is unavailable")
}
pub(crate) fn closing() -> HostError {
    HostError::new("HOST_BUSY", "Host is shutting down")
}

#[cfg(test)]
mod mailbox_tests {
    use super::*;
    use crate::{test_support as support, transmission::TransmissionService};
    use std::{future::Future, pin::Pin, task::Poll};

    async fn poll_pending<T>(future: Pin<&mut impl Future<Output = T>>) {
        let mut future = future;
        std::future::poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    async fn hold_read(h: &support::Harness) -> Arc<support::Gate> {
        let gate = Arc::new(support::Gate::default());
        *h.probe.read_gate.lock().unwrap() = Some(gate.clone());
        gate.entered().await;
        gate
    }

    #[tokio::test]
    async fn full_mailbox_close_joins_owner_and_allows_host_shutdown() {
        let h = support::Harness::new().await;
        let target = h.open("full-close").await;
        let session = h.host.devices().session(&target).unwrap();
        let service = TransmissionService::new(h.host.devices().clone());
        let gate = hold_read(&h).await;
        let mut queries = (0..8)
            .map(|_| Box::pin(service.queue_status(&target)))
            .collect::<Vec<_>>();
        for query in &mut queries {
            poll_pending(query.as_mut()).await;
        }
        // 每个 future 已真实入队，owner 仍阻塞在 read，八个槽全部占满。
        let mut close = Box::pin(session.close());
        poll_pending(close.as_mut()).await;
        let closing_query = service.queue_status(&target).await;
        gate.release();
        for query in queries {
            query.await.unwrap();
        }
        let result = tokio::time::timeout(Duration::from_millis(500), close).await;
        if result.is_err() {
            // RED 清理：把旧实现丢失的 Close 补交，释放其已启动的 blocking join。
            let (send, receive) = oneshot::channel();
            assert!(session.sender.try_send(BackendCommand::Close(send)).is_ok());
            receive.await.unwrap().unwrap();
        }
        tokio::time::timeout(Duration::from_secs(2), h.host.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert!(
            result.is_ok(),
            "full mailbox lost Close and owner join never finished"
        );
        result.unwrap().unwrap();
        assert_eq!(closing_query.unwrap_err().code, "HOST_BUSY");
        assert_eq!(session.snapshot().unwrap().state, SessionState::Closed);
        assert!(session.join.lock().unwrap().is_none());
        assert_eq!(h.probe.closes.load(Ordering::SeqCst), 1);
        assert_eq!(h.probe.close_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn close_operation_settles_with_full_query_mailbox_before_host_shutdown() {
        let h = support::Harness::new().await;
        let target = h.open("close-operation").await;
        let service = TransmissionService::new(h.host.devices().clone());
        let gate = hold_read(&h).await;
        let mut queries = (0..8)
            .map(|_| Box::pin(service.queue_status(&target)))
            .collect::<Vec<_>>();
        for query in &mut queries {
            poll_pending(query.as_mut()).await;
        }
        let close = h
            .invoke(h.call(&target, "session.close", serde_json::json!({})))
            .await;
        let session = h.host.devices().session(&target).unwrap();
        support::until(|| session.snapshot().unwrap().state == SessionState::Closing).await;
        let late_query = service.queue_status(&target).await;
        gate.release();
        for query in queries {
            query.await.unwrap();
        }
        let done = h.wait(&close.operation_id).await;
        tokio::time::timeout(Duration::from_secs(2), h.host.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(late_query.unwrap_err().code, "HOST_BUSY");
        assert_eq!(done.state, OperationState::Succeeded);
        assert!(
            matches!(done.result, Some(ActionResult::Session(state)) if state.state == SessionState::Closed)
        );
        assert!(session.join.lock().unwrap().is_none());
        assert_eq!(h.probe.close_calls.load(Ordering::SeqCst), 1);
    }

    async fn leased_tx(h: &support::Harness, target: &Target) -> Operation {
        let owner = h
            .invoke(h.call(
                target,
                "lease.acquire",
                serde_json::json!({"kind":"exclusive","ttlMs":"30000"}),
            ))
            .await;
        support::until(|| {
            h.store
                .get(&h.actor, &owner.operation_id)
                .unwrap()
                .result
                .is_some()
        })
        .await;
        let lease = h
            .host
            .devices()
            .snapshot(target)
            .await
            .unwrap()
            .lease
            .unwrap();
        let mut call = h.call(
            target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        );
        call.lease_id = Some(lease.lease_id);
        let operation = h.invoke(call).await;
        h.wait(&operation.operation_id).await
    }

    fn assert_rejected(
        h: &support::Harness,
        done: &Operation,
        state: &SessionSnapshot,
        code: &str,
    ) {
        assert_eq!(h.write_count(), 0);
        assert_eq!(done.state, OperationState::Succeeded);
        let receipt = support::receipt(done);
        assert_eq!(receipt.outcome, TxOutcome::Rejected);
        assert!(receipt.accepted_ranges.is_empty());
        assert!(receipt.unknown_ranges.is_empty());
        assert_eq!(receipt.backend_error.as_ref().unwrap().code, code);
        assert_eq!(state.tx_gate, TxGate::Ready);
        assert_eq!(state.control_state, ControlState::Clear);
    }

    #[tokio::test]
    async fn full_mailbox_tx_is_rejected_without_isolating_lease() {
        let h = support::Harness::new().await;
        let target = h.open("full-write").await;
        let service = TransmissionService::new(h.host.devices().clone());
        let gate = hold_read(&h).await;
        let mut queries = (0..8)
            .map(|_| Box::pin(service.queue_status(&target)))
            .collect::<Vec<_>>();
        for query in &mut queries {
            poll_pending(query.as_mut()).await;
        }
        let done = leased_tx(&h, &target).await;
        let state = h.host.devices().snapshot(&target).await.unwrap();
        gate.release();
        for query in queries {
            query.await.unwrap();
        }
        h.host.shutdown().await.unwrap();
        assert_rejected(&h, &done, &state, "HOST_BUSY");
    }

    #[tokio::test]
    async fn disconnected_mailbox_tx_is_rejected_without_isolating_lease() {
        let h = support::Harness::new().await;
        let target = h.open("disconnected-write").await;
        let session = h.host.devices().session(&target).unwrap();
        // 让真实 owner 退出而保留提交前领域快照，固定复现 sender 已断开的窗口。
        let (send, receive) = oneshot::channel();
        assert!(session.sender.try_send(BackendCommand::Close(send)).is_ok());
        receive.await.unwrap().unwrap();
        support::until(|| session.join.lock().unwrap().as_ref().unwrap().is_finished()).await;
        let done = leased_tx(&h, &target).await;
        let state = session.snapshot().unwrap();
        h.host.shutdown().await.unwrap();
        assert_rejected(&h, &done, &state, "BACKEND_DISCONNECTED");
    }
}
