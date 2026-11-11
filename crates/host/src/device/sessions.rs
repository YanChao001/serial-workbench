use super::observability::{InputPermit, InputSample, SessionObservability};
use crate::{
    auth::{AuthService, AuthenticatedActor, HostIdentity},
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
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

pub type TransportOpener =
    Arc<dyn Fn(&Id, &SerialConfiguration) -> BackendResult<Box<dyn Transport>> + Send + Sync>;
type DeviceSlot = Arc<tokio::sync::Mutex<Option<Arc<Session>>>>;
type OwnerJoin = Arc<Mutex<Option<JoinHandle<()>>>>;
async fn wait_owner_exit(owner: &OwnerJoin) -> HostResult<()> {
    loop {
        {
            let mut join = owner.lock().map_err(|_| unavailable())?;
            if join.as_ref().is_none_or(JoinHandle::is_finished) {
                if let Some(join) = join.take() {
                    join.join().map_err(|_| unavailable())?;
                }
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}
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
    opening: Mutex<HashMap<Id, Arc<OpeningOwner>>>,
    runtime: Mutex<Option<RuntimeAttachment>>,
    reconnect_jobs: Mutex<HashMap<Id, ReconnectJob>>,
    pub closing: AtomicBool,
    #[cfg(test)]
    owner_exit_gate: Mutex<Option<Arc<crate::test_support::Gate>>>,
}
pub(crate) struct Session {
    pub closing: Arc<AtomicBool>,
    completed: tokio::sync::watch::Receiver<Option<HostResult<()>>>,
    pub snapshot: Arc<Mutex<SessionSnapshot>>,
    pub source: StreamSource,
    sender: mpsc::SyncSender<BackendCommand>,
    join: OwnerJoin,
    pub document_revision: tokio::sync::Mutex<U64>,
    projections: ProjectionStore,
    pub(crate) observability: Arc<Mutex<SessionObservability>>,
    input_pending: Arc<AtomicBool>,
}
struct OpeningOwner {
    closing: Arc<AtomicBool>,
    completed: tokio::sync::watch::Receiver<Option<HostResult<()>>>,
    join: OwnerJoin,
}
impl OpeningOwner {
    async fn wait(&self) -> HostResult<()> {
        self.closing.store(true, Ordering::SeqCst);
        let mut completed = self.completed.clone();
        let result = completed
            .wait_for(Option::is_some)
            .await
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(unavailable)?;
        wait_owner_exit(&self.join).await?;
        result
    }
}
fn retained_cleanup(error: &BackendError) -> Option<HostResult<()>> {
    error.cleanup.as_ref().map(|cleanup| {
        loop {
            if let Some(result) = cleanup.poll() {
                return result;
            }
            thread::sleep(Duration::from_millis(5));
        }
    })
}
fn close_unpublished(backend: &mut dyn Transport) -> HostResult<()> {
    match backend.close() {
        Ok(()) => Ok(()),
        Err(error) => retained_cleanup(&error).unwrap_or(Err(*error.error)),
    }
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
    SampleInputs(InputSample),
    Drain(
        DrainRequest,
        BackendAdmission,
        oneshot::Sender<BackendResult<ControlResult>>,
    ),
    Write(
        WritePayload,
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
pub type BindingResolver = Arc<
    dyn Fn(&AuthenticatedActor, &DeviceBindingReference) -> HostResult<DeviceBinding> + Send + Sync,
>;
#[derive(Clone)]
struct RuntimeAttachment {
    directory: Arc<super::DeviceRuntime>,
    resolver: BindingResolver,
}
#[derive(Clone)]
struct OpenAdmission {
    actor: AuthenticatedActor,
    grant_stamp: Option<crate::auth::GrantStamp>,
    binding: Option<(DeviceBindingReference, DeviceBinding)>,
    cancelled: Arc<AtomicBool>,
    expected_session: Option<(Id, U64)>,
}
struct ResponsibilityPin(Arc<super::DeviceRuntime>, Id);
struct ReconnectJob {
    stop: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for ResponsibilityPin {
    fn drop(&mut self) {
        self.0.unpin(&self.1);
    }
}
impl DeviceService {
    pub fn attach_runtime(
        &self,
        runtime: Arc<super::DeviceRuntime>,
        resolver: BindingResolver,
    ) -> HostResult<()> {
        let mut attachment = self.inner.runtime.lock().map_err(|_| unavailable())?;
        if attachment.is_some() {
            return Err(HostError::new(
                "REVISION_CONFLICT",
                "Device runtime is already attached",
            ));
        }
        *attachment = Some(RuntimeAttachment {
            directory: runtime,
            resolver,
        });
        Ok(())
    }
    pub async fn open_authorized(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: OpenParams,
        cancelled: Arc<AtomicBool>,
    ) -> HostResult<OpenResult> {
        if cancelled.load(Ordering::SeqCst) {
            return Err(open_cancelled());
        }
        let service = self.clone();
        let actor = actor.clone();
        let requested = target.clone();
        let reference = params.binding.clone();
        let admission = blocking(move || {
            service
                .inner
                .auth
                .require(&actor, "device.modify", &requested)?;
            let binding = reference
                .as_ref()
                .map(|reference| {
                    let runtime = service.runtime_attachment()?.ok_or_else(invalid)?;
                    let binding = (runtime.resolver)(&actor, reference)?;
                    binding.validate()?;
                    Ok((reference.clone(), binding))
                })
                .transpose()?;
            Ok(OpenAdmission {
                grant_stamp: service.inner.auth.capture_grants(&actor)?,
                actor,
                binding,
                cancelled,
                expected_session: None,
            })
        })
        .await?;
        self.check_open(target, &params.configuration, &admission)
            .await?;
        let mut opened = self
            .open_inner(target, params.clone(), Some(&admission))
            .await?;
        self.record_recent(target, &params.configuration, &mut opened)
            .await;
        if !opened.reused
            && admission
                .binding
                .as_ref()
                .is_some_and(|(_, binding)| binding.reconnect.enabled)
        {
            self.register_reconnect(target.clone(), &opened, admission)
                .await;
            if let Ok(session) = self.session(&open_target(&self.inner.identity, &opened)) {
                opened.revision = session.snapshot()?.revision;
            }
        }
        Ok(opened)
    }
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
                opening: Mutex::new(HashMap::new()),
                runtime: Mutex::new(None),
                reconnect_jobs: Mutex::new(HashMap::new()),
                closing: AtomicBool::new(false),
                #[cfg(test)]
                owner_exit_gate: Mutex::new(None),
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
        if params.binding.is_some() {
            return Err(invalid());
        }
        self.open_inner(target, params, None).await
    }
    async fn open_inner(
        &self,
        target: &Target,
        params: OpenParams,
        admission: Option<&OpenAdmission>,
    ) -> HostResult<OpenResult> {
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
        if let Some(admission) = admission {
            self.check_open(target, &params.configuration, admission)
                .await?;
        }
        let explicit_reopen = admission.is_none_or(|request| request.expected_session.is_none());
        if let Some(session) = current.as_ref() {
            let mut snapshot = session.snapshot()?;
            if snapshot.tx_gate == TxGate::ControlUnknown {
                if !explicit_reopen || snapshot.control_state != ControlState::Clear {
                    return Err(HostError::new(
                        "CONTROL_UNKNOWN",
                        "Device requires confirmed line recovery",
                    ));
                }
                // 显式重连也必须等实际资源释放及 owner 退出；旧 TX unknown 不改写。
                session.close().await?;
                self.persist(session).await?;
                snapshot = session.snapshot()?;
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
                    recent_error: None,
                });
            }
            if snapshot.state != SessionState::Closed {
                if snapshot.state != SessionState::Disconnected
                    || !session
                        .completed
                        .borrow()
                        .as_ref()
                        .is_some_and(Result::is_ok)
                {
                    session.close().await?;
                }
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
            v.control_state != ControlState::Clear
                || (v.tx_gate == TxGate::ControlUnknown && !explicit_reopen)
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
        let observability = current.as_ref().map_or_else(
            || Arc::new(Mutex::new(SessionObservability::default())),
            |session| session.observability.clone(),
        );
        let (ready, opened) = oneshot::channel();
        if let Some(admission) = admission {
            self.check_open(target, &params.configuration, admission)
                .await?;
        }
        let (start, started) = mpsc::sync_channel(1);
        let (sender, receiver) = mpsc::sync_channel(8);
        let closing_signal = Arc::new(AtomicBool::new(false));
        let owner_closing = closing_signal.clone();
        let (completed_send, completed) = tokio::sync::watch::channel(None);
        let owner = Arc::new(OpeningOwner {
            closing: closing_signal.clone(),
            completed: completed.clone(),
            join: Arc::new(Mutex::new(None)),
        });
        let opener = self.inner.opener.clone();
        let device = target.id.clone();
        let config = params.configuration.clone();
        let clock = self.inner.clock.clone();
        let projections = self.inner.projections.clone();
        let identity = self.inner.identity.clone();
        // 注册和启动共用锁；shutdown 关闭 admission 后不会漏掉迟到的打开。
        {
            let mut opening = self.inner.opening.lock().map_err(|_| unavailable())?;
            if self.inner.closing.load(Ordering::SeqCst) {
                return Err(closing());
            }
            if let Some(previous) = opening.get(&target.id) {
                if !previous
                    .completed
                    .borrow()
                    .as_ref()
                    .is_some_and(Result::is_ok)
                    || !previous
                        .join
                        .lock()
                        .map_err(|_| unavailable())?
                        .as_ref()
                        .is_none_or(JoinHandle::is_finished)
                {
                    return Err(HostError::new(
                        "HOST_BUSY",
                        "Device opening or cleanup remains owned",
                    ));
                }
                if let Some(join) = previous.join.lock().map_err(|_| unavailable())?.take() {
                    let _ = join.join();
                }
            }
            opening.retain(|_, pending| {
                !pending
                    .completed
                    .borrow()
                    .as_ref()
                    .is_some_and(Result::is_ok)
                    || pending.join.lock().map_or(true, |join| {
                        !join.as_ref().is_none_or(JoinHandle::is_finished)
                    })
            });
            if opening.len() >= 16 {
                return Err(HostError::new(
                    "LIMIT_EXCEEDED",
                    "Device opening owner capacity exhausted",
                ));
            }
            opening.insert(target.id.clone(), owner.clone());
            #[cfg(test)]
            let owner_exit_gate = self.inner.owner_exit_gate.lock().unwrap().take();
            let join = thread::Builder::new()
                .name(format!("device-{}", target.id.as_str()))
                .spawn(move || {
                    let mut backend = match opener(&device, &config) {
                        Ok(v) => v,
                        Err(e) => {
                            let _ = ready.send(Err((*e.error).clone()));
                            completed_send
                                .send_replace(Some(retained_cleanup(&e).unwrap_or(Ok(()))));
                            return;
                        }
                    };
                    let opened_at = clock.mono_ns();
                    if ready.send(Ok((backend.capabilities(), opened_at))).is_err() {
                        completed_send.send_replace(Some(close_unpublished(backend.as_mut())));
                        return;
                    }
                    let Ok((snapshot, source, observability)) = started.recv() else {
                        completed_send.send_replace(Some(close_unpublished(backend.as_mut())));
                        return;
                    };
                    let result = owner_loop(
                        backend,
                        receiver,
                        snapshot,
                        source,
                        OwnerContext {
                            clock,
                            identity,
                            projections,
                            observability,
                        },
                        owner_closing,
                    );
                    let cleaned = match result {
                        Ok(()) => Ok(()),
                        Err(error) => retained_cleanup(&error).unwrap_or(Err(*error.error)),
                    };
                    // 这是实际资源清理结果；此前 TX unknown 的业务记录保持独立。
                    completed_send.send_replace(Some(cleaned));
                    #[cfg(test)]
                    if let Some(gate) = owner_exit_gate {
                        gate.hold();
                    }
                })
                .map_err(|_| {
                    opening.remove(&target.id);
                    unavailable()
                })?;
            *owner.join.lock().map_err(|_| unavailable())? = Some(join);
        }
        // 发布失败只结束调用等待；owner 保留到实际原生清理结算。
        let prepared: HostResult<_> = async {
            // 冷启动的隔离记录仅在本次显式打开真实成功后替换，不提前解除持久隔离。
            let (capabilities, opened_at) = opened.await.map_err(|_| unavailable())??;
            if let Some(admission) = admission {
                self.check_open(target, &params.configuration, admission)
                    .await?;
            }
            let snapshot = SessionSnapshot {
                reconnect: None,
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
            Ok((snapshot, source, persisted.revision, opened_at))
        }
        .await;
        let (snapshot, source, document_revision, opened_at) = match prepared {
            Ok(v) => v,
            Err(error) => {
                drop(start);
                closing_signal.store(true, Ordering::SeqCst);
                return Err(error);
            }
        };
        let snapshot = Arc::new(Mutex::new(snapshot));
        observability
            .lock()
            .map_err(|_| unavailable())?
            .connected(epoch, opened_at);
        start
            .send((snapshot.clone(), source.clone(), observability.clone()))
            .map_err(|_| unavailable())?;
        let session = Arc::new(Session {
            closing: closing_signal,
            completed,
            snapshot,
            source,
            sender,
            join: owner.join.clone(),
            document_revision: tokio::sync::Mutex::new(document_revision),
            projections: self.inner.projections.clone(),
            observability,
            input_pending: Arc::new(AtomicBool::new(false)),
        });
        let result = session.snapshot()?;
        self.inner
            .sessions
            .lock()
            .map_err(|_| unavailable())?
            .insert(session_id, session.clone());
        *current = Some(session);
        self.inner
            .opening
            .lock()
            .map_err(|_| unavailable())?
            .remove(&target.id);
        Ok(OpenResult {
            session_id: result.session_id,
            session_epoch: result.session_epoch,
            revision: result.revision,
            reused: false,
            recent_error: None,
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
        let opening: Vec<_> = {
            let opening = self.inner.opening.lock().map_err(|_| unavailable())?;
            self.inner.closing.store(true, Ordering::SeqCst);
            opening.values().cloned().collect()
        };
        for owner in &opening {
            owner.closing.store(true, Ordering::SeqCst);
        }
        if let Some(runtime) = self.runtime_attachment()? {
            runtime.directory.stop();
        }
        let jobs: Vec<_> = self
            .inner
            .reconnect_jobs
            .lock()
            .map_err(|_| unavailable())?
            .drain()
            .map(|(_, job)| job)
            .collect();
        for job in &jobs {
            job.stop.store(true, Ordering::SeqCst);
        }
        for job in jobs {
            let _ = job.task.await;
        }
        let mut failure = None;
        for owner in opening {
            if let Err(error) = owner.wait().await {
                failure.get_or_insert(error);
            }
        }
        for session in self.sessions()? {
            if session.snapshot()?.state == SessionState::Closed
                && session.join.lock().map_err(|_| unavailable())?.is_none()
            {
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
    pub(super) async fn sample_inputs(&self, epoch: U64) -> HostResult<SessionInputs> {
        let permit = InputPermit::acquire(&self.input_pending)?;
        let (reply, receive) = oneshot::channel();
        {
            let state = self.snapshot.lock().map_err(|_| unavailable())?;
            if state.session_epoch != epoch {
                return Err(HostError::new("EPOCH_MISMATCH", "Session epoch changed"));
            }
            if self.closing.load(Ordering::SeqCst) || state.state != SessionState::Open {
                return Err(HostError::new(
                    "HOST_BUSY",
                    "Session is not open for input sampling",
                ));
            }
            self.sender
                .try_send(BackendCommand::SampleInputs(InputSample {
                    epoch,
                    reply,
                    permit,
                }))
                .map_err(|error| match error {
                    mpsc::TrySendError::Full(_) => {
                        HostError::new("HOST_BUSY", "Device control queue is full")
                    }
                    mpsc::TrySendError::Disconnected(_) => unavailable(),
                })?;
        }
        receive.await.map_err(|_| unavailable())?
    }
    pub fn snapshot(&self) -> HostResult<SessionSnapshot> {
        self.snapshot
            .lock()
            .map(|v| v.clone())
            .map_err(|_| unavailable())
    }
    pub async fn write(
        &self,
        bytes: WritePayload,
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
    pub async fn drain(
        &self,
        mut request: DrainRequest,
        admission: BackendAdmission,
    ) -> BackendResult<ControlResult> {
        if self.closing.load(Ordering::SeqCst) {
            return Err(HostError::new("HOST_BUSY", "Session is closing").into());
        }
        request.closing = self.closing.clone();
        let (send, receive) = oneshot::channel();
        self.sender
            .try_send(BackendCommand::Drain(request, admission, send))
            .map_err(|_| {
                BackendError::from(HostError::new("HOST_BUSY", "Device owner mailbox is full"))
            })?;
        receive
            .await
            .map_err(|_| BackendError::from(unavailable()))?
    }

    pub async fn close(&self) -> HostResult<()> {
        self.closing.store(true, Ordering::SeqCst);
        {
            let mut state = self.snapshot.lock().map_err(|_| unavailable())?;
            if state.state != SessionState::Closed {
                state.state = SessionState::Closing;
                if state.tx_gate != TxGate::ControlUnknown {
                    state.tx_gate = TxGate::Closing;
                }
            }
        }
        let (send, _) = oneshot::channel();
        // 仅唤醒提示；关闭责任由独立 sideband 承载，不依赖业务邮箱空位。
        let _ = self.sender.try_send(BackendCommand::Close(send));
        let mut completed = self.completed.clone();
        let result = tokio::time::timeout(Duration::from_millis(250), async {
            let result = completed
                .wait_for(Option::is_some)
                .await
                .map_err(|_| unavailable())?
                .clone()
                .unwrap_or_else(|| Err(unavailable()));
            // A completed backend result may precede the owner thread's return.
            // Keep its JoinHandle owned until actual exit, including Closed retries.
            wait_owner_exit(&self.join).await?;
            Ok::<_, HostError>(result)
        })
        .await;
        let result = match result {
            Ok(Ok(result)) => result,
            _ => {
                let error =
                    HostError::new("CONTROL_UNKNOWN", "Native owner cleanup is not confirmed");
                if let Ok(mut state) = self.snapshot.lock() {
                    state.tx_gate = TxGate::ControlUnknown;
                }
                let _ = self.source.fail(error.clone());
                return Err(error);
            }
        };
        {
            let mut state = self.snapshot.lock().map_err(|_| unavailable())?;
            // The owner may have finished before this explicit close request.
            // Its confirmed result settles the request in either ordering.
            if result.is_ok() {
                state.state = SessionState::Closed;
                if state.tx_gate != TxGate::ControlUnknown {
                    state.tx_gate = TxGate::Disconnected;
                }
            } else {
                state.state = SessionState::Disconnected;
                state.tx_gate = TxGate::ControlUnknown;
            }
        }
        if result.is_ok() {
            self.source.close()?;
        }
        result
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.closing.store(true, Ordering::SeqCst);
        if let Ok(mut state) = self.snapshot.lock() {
            if state.state != SessionState::Closed {
                state.state = SessionState::Closing;
            }
            if state.tx_gate != TxGate::ControlUnknown {
                state.tx_gate = TxGate::Closing;
            }
        }
        let (send, _) = oneshot::channel();
        let _ = self.sender.try_send(BackendCommand::Close(send));
        if let Ok(mut join) = self.join.lock()
            && join.as_ref().is_some_and(JoinHandle::is_finished)
            && let Some(join) = join.take()
        {
            let _ = join.join();
        }
    }
}
struct PendingWriteReply {
    job: Box<dyn PendingWrite>,
    reply: oneshot::Sender<BackendResult<BackendWrite>>,
    wait: BackendWait,
    length: usize,
}
struct PendingDrainReply {
    job: Box<dyn PendingDrain>,
    reply: oneshot::Sender<BackendResult<ControlResult>>,
    wait: BackendWait,
}
struct BackendWait {
    deadline: u64,
    cancelled: Arc<AtomicBool>,
    native_cancelled: Arc<AtomicBool>,
    cleanup_at: Option<Instant>,
    timed_out: bool,
}
impl BackendWait {
    fn cleanup_expired(&mut self, clock: &dyn Clock, closing: bool) -> bool {
        let cancelled = self.cancelled.load(Ordering::SeqCst);
        if clock.mono_ns() >= self.deadline && !cancelled && !closing {
            self.timed_out = true;
        }
        if closing || cancelled || self.timed_out {
            self.native_cancelled.store(true, Ordering::SeqCst);
            self.cleanup_at.get_or_insert_with(Instant::now);
        }
        self.cleanup_at
            .is_some_and(|at| at.elapsed() >= Duration::from_millis(150))
    }
    fn normalize_error(&self, error: &mut HostError) {
        if self.timed_out && error.code == "CANCELLED" {
            error.code = "WRITE_TIMEOUT".into();
            error.message = "Serial operation wait expired".into();
        }
    }
}
struct OwnerContext {
    clock: Arc<dyn Clock>,
    identity: HostIdentity,
    projections: ProjectionStore,
    observability: Arc<Mutex<SessionObservability>>,
}
fn owner_loop(
    mut backend: Box<dyn Transport>,
    receiver: mpsc::Receiver<BackendCommand>,
    snapshot: Arc<Mutex<SessionSnapshot>>,
    source: StreamSource,
    context: OwnerContext,
    closing: Arc<AtomicBool>,
) -> BackendResult<()> {
    let OwnerContext {
        clock,
        identity,
        projections,
        observability,
    } = context;
    let mut writing: Option<PendingWriteReply> = None;
    let mut pending: Option<PendingDrainReply> = None;
    let mut close_reply = None;
    loop {
        // 领域期限先请求取消；poll 仍优先收取已存在的完成证据。
        let write_cleanup_expired = writing.as_mut().is_some_and(|pending| {
            pending
                .wait
                .cleanup_expired(clock.as_ref(), closing.load(Ordering::SeqCst))
        });
        let drain_cleanup_expired = pending.as_mut().is_some_and(|pending| {
            pending
                .wait
                .cleanup_expired(clock.as_ref(), closing.load(Ordering::SeqCst))
        });
        if let Some(pending_write) = &mut writing
            && let Some(mut result) = pending_write.job.poll()
        {
            let error = match &result {
                Ok(write) => write.error.as_ref(),
                Err(error) => Some(error.error.as_ref()),
            };
            if let Some(error) = error {
                observability
                    .lock()
                    .map_err(|_| unavailable())?
                    .write_error(error);
            }
            match &mut result {
                Ok(BackendWrite {
                    error: Some(error), ..
                }) => pending_write.wait.normalize_error(error),
                Err(error) => pending_write.wait.normalize_error(&mut error.error),
                _ => {}
            }
            if (result
                .as_ref()
                .is_ok_and(|result| !result.unknown_ranges.is_empty())
                || result.is_err())
                && let Ok(mut state) = snapshot.lock()
            {
                state.tx_gate = TxGate::ControlUnknown;
            }
            let _ = writing.take().expect("pending write").reply.send(result);
        }
        if writing.is_some() && write_cleanup_expired {
            let PendingWriteReply {
                reply,
                length,
                wait,
                ..
            } = writing.take().expect("pending write");
            if let Ok(mut state) = snapshot.lock() {
                state.tx_gate = TxGate::ControlUnknown;
            }
            let _ = reply.send(Ok(BackendWrite {
                accepted_ranges: vec![],
                unknown_ranges: vec![ByteRange {
                    start: 0.into(),
                    end: (length as u64).into(),
                }],
                error: Some(HostError::new(
                    if wait.timed_out {
                        "WRITE_TIMEOUT"
                    } else {
                        "CONTROL_UNKNOWN"
                    },
                    "Write backend did not retain a bounded settlement",
                )),
            }));
        }
        if let Some(pending_drain) = &mut pending
            && let Some(mut result) = pending_drain.job.poll()
        {
            match &mut result {
                Ok(ControlResult::Drained {
                    error: Some(error), ..
                }) => pending_drain.wait.normalize_error(error),
                Err(error) => pending_drain.wait.normalize_error(&mut error.error),
                _ => {}
            }
            if (matches!(
                &result,
                Ok(ControlResult::Drained {
                    status: ControlStatus::Unknown,
                    ..
                })
            ) || result.is_err())
                && let Ok(mut state) = snapshot.lock()
            {
                state.tx_gate = TxGate::ControlUnknown;
            }
            let _ = pending.take().expect("pending drain").reply.send(result);
        }
        if pending.is_some() && drain_cleanup_expired {
            let PendingDrainReply { reply, wait, .. } = pending.take().expect("pending drain");
            if let Ok(mut state) = snapshot.lock() {
                state.tx_gate = TxGate::ControlUnknown;
            }
            let _ = reply.send(Ok(ControlResult::Drained {
                status: ControlStatus::Unknown,
                error: Some(HostError::new(
                    if wait.timed_out {
                        "WRITE_TIMEOUT"
                    } else {
                        "CONTROL_UNKNOWN"
                    },
                    "Drain cleanup did not finish within its budget",
                )),
            }));
        }
        if closing.load(Ordering::SeqCst) && pending.is_none() && writing.is_none() {
            // 已接纳只读查询仍可结算；副作用命令在 admission 中因 Closing 拒绝。
            for _ in 0..8 {
                let Ok(command) = receiver.try_recv() else {
                    break;
                };
                match command {
                    BackendCommand::SampleInputs(sample) => {
                        sample.complete(backend.as_mut(), &snapshot, clock.as_ref(), &closing);
                    }
                    BackendCommand::Control(
                        command @ (ControlCommand::QueueStatus | ControlCommand::ModemStatus),
                        _,
                        reply,
                    ) => {
                        let _ = reply.send(backend.control(command));
                    }
                    BackendCommand::Close(reply) => {
                        close_reply = Some(reply);
                    }
                    BackendCommand::Write(_, _, _, reply) => {
                        let _ = reply.send(Ok(BackendWrite {
                            accepted_ranges: vec![],
                            unknown_ranges: vec![],
                            error: Some(closing_error()),
                        }));
                    }
                    BackendCommand::Configure(_, _, reply, _) => {
                        let _ = reply.send(Err(closing_error().into()));
                    }
                    BackendCommand::Control(_, _, reply) | BackendCommand::Drain(_, _, reply) => {
                        let _ = reply.send(Err(closing_error().into()));
                    }
                }
            }
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(1)) {
            Ok(BackendCommand::SampleInputs(sample)) => {
                sample.complete(backend.as_mut(), &snapshot, clock.as_ref(), &closing);
            }
            Ok(BackendCommand::Drain(mut request, admission, reply)) => {
                let deadline = backend_deadline(clock.as_ref(), request.wait);
                let cancelled = request.cancelled.clone();
                let native_cancelled = Arc::new(AtomicBool::new(false));
                request.cancelled = native_cancelled.clone();
                let started = if pending.is_some() || writing.is_some() {
                    Err(HostError::new("HOST_BUSY", "Drain is already pending").into())
                } else {
                    admission
                        .begin(&snapshot, clock.as_ref(), false)
                        .map_err(BackendError::from)
                        .and_then(|()| backend.begin_drain(request))
                };
                match started {
                    Ok(job) => {
                        pending = Some(PendingDrainReply {
                            job,
                            reply,
                            wait: BackendWait {
                                deadline,
                                cancelled,
                                native_cancelled,
                                cleanup_at: None,
                                timed_out: false,
                            },
                        })
                    }
                    Err(error) => {
                        let _ = reply.send(Err(error));
                    }
                }
            }
            Ok(BackendCommand::Write(bytes, wait, admission, send)) => {
                let cancelled = admission.cancelled.clone();
                let native_cancelled = Arc::new(AtomicBool::new(false));
                let deadline = backend_deadline(clock.as_ref(), wait);
                let admitted = if pending.is_some() || writing.is_some() {
                    Err(HostError::new("HOST_BUSY", "Drain owns the TX boundary"))
                } else {
                    admission.begin(&snapshot, clock.as_ref(), false)
                };
                let length = bytes.len();
                match admitted.map_err(BackendError::from).and_then(|()| {
                    let result =
                        backend.begin_write(bytes, wait, native_cancelled.clone(), closing.clone());
                    if let Err(error) = &result {
                        observability
                            .lock()
                            .map_err(|_| unavailable())?
                            .write_error(&error.error);
                    }
                    result
                }) {
                    Ok(job) => {
                        writing = Some(PendingWriteReply {
                            job,
                            reply: send,
                            length,
                            wait: BackendWait {
                                deadline,
                                cancelled,
                                native_cancelled,
                                cleanup_at: None,
                                timed_out: false,
                            },
                        })
                    }
                    Err(error) => {
                        let _ = send.send(Ok(BackendWrite {
                            accepted_ranges: error.accepted_ranges,
                            unknown_ranges: error.unknown_ranges,
                            error: Some(*error.error),
                        }));
                    }
                }
            }
            Ok(BackendCommand::Configure(config, admission, send, resumed)) => {
                let result = if pending.is_some() || writing.is_some() {
                    Err(HostError::new("HOST_BUSY", "Drain owns the configuration boundary").into())
                } else {
                    admission
                        .begin(&snapshot, clock.as_ref(), false)
                        .map_err(BackendError::from)
                        .and_then(|()| backend.configure(&config))
                };
                let _ = send.send(result);
                loop {
                    match resumed.recv_timeout(Duration::from_millis(20)) {
                        Ok(()) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) if !closing.load(Ordering::SeqCst) => {
                        }
                        _ => {
                            closing.store(true, Ordering::SeqCst);
                            break;
                        }
                    }
                }
            }
            Ok(BackendCommand::Control(command, admission, send)) => {
                let check = if (pending.is_some() || writing.is_some())
                    && !matches!(
                        command,
                        ControlCommand::QueueStatus | ControlCommand::ModemStatus
                    ) {
                    Err(HostError::new(
                        "HOST_BUSY",
                        "Drain owns the control boundary",
                    ))
                } else {
                    admission.map_or(Ok(()), |admission| {
                        admission.begin(
                            &snapshot,
                            clock.as_ref(),
                            matches!(command, ControlCommand::AssertBreak),
                        )
                    })
                };
                let _ = send.send(
                    check
                        .map_err(BackendError::from)
                        .and_then(|()| backend.control(command)),
                );
            }
            Ok(BackendCommand::Close(send)) => {
                closing.store(true, Ordering::SeqCst);
                close_reply = Some(send);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if closing.load(Ordering::SeqCst) {
            continue;
        }
        match backend.read(16 * 1024, Duration::from_millis(20)) {
            Ok(block) if !block.bytes.is_empty() => {
                observability
                    .lock()
                    .map_err(|_| unavailable())?
                    .received(block.bytes.len(), clock.mono_ns());
                let revision = match snapshot.lock() {
                    Ok(v) => v.configuration_revision,
                    Err(_) => break,
                };
                if let Err(error) = source.append_rx(
                    source_meta(&identity, clock.as_ref(), revision),
                    block.bytes,
                    block.message,
                ) {
                    observability
                        .lock()
                        .map_err(|_| unavailable())?
                        .disconnected(clock.mono_ns());
                    disconnected(&snapshot, &projections, &source, error);
                    if pending.is_some() || writing.is_some() {
                        closing.store(true, Ordering::SeqCst);
                    } else {
                        break;
                    }
                }
            }
            Err(error) => {
                {
                    let mut metrics = observability.lock().map_err(|_| unavailable())?;
                    metrics.read_error(&error.error);
                    metrics.disconnected(clock.mono_ns());
                }
                disconnected(&snapshot, &projections, &source, *error.error);
                if pending.is_some() || writing.is_some() {
                    closing.store(true, Ordering::SeqCst);
                } else {
                    break;
                }
            }
            _ => {}
        }
    }
    if let Some(PendingWriteReply { reply, length, .. }) = writing.take() {
        if let Ok(mut state) = snapshot.lock() {
            state.tx_gate = TxGate::ControlUnknown;
        }
        let _ = reply.send(Ok(BackendWrite {
            accepted_ranges: vec![],
            unknown_ranges: vec![ByteRange {
                start: 0.into(),
                end: (length as u64).into(),
            }],
            error: Some(unavailable()),
        }));
    }
    if let Some(PendingDrainReply { reply, .. }) = pending.take() {
        if let Ok(mut state) = snapshot.lock() {
            state.tx_gate = TxGate::ControlUnknown;
        }
        let _ = reply.send(Ok(ControlResult::Drained {
            status: ControlStatus::Unknown,
            error: Some(unavailable()),
        }));
    }
    let result = backend.close();
    observability
        .lock()
        .map_err(|_| unavailable())?
        .disconnected(clock.mono_ns());
    let mut requested_close = false;
    if let Ok(mut state) = snapshot.lock() {
        requested_close = state.state == SessionState::Closing;
        // 原生清理不能把此前的断连或仍待领域处理的邮箱故障覆写为正常关闭。
        if requested_close {
            state.state = if result.is_ok() {
                SessionState::Closed
            } else {
                SessionState::Disconnected
            };
        }
        if result.is_err() {
            state.tx_gate = TxGate::ControlUnknown;
        } else if requested_close && state.tx_gate != TxGate::ControlUnknown {
            state.tx_gate = TxGate::Disconnected;
        }
        if let Ok(boundary) = object(&serde_json::json!({"state": state.state})) {
            let _ = source.append_boundary(
                source_meta(&identity, clock.as_ref(), state.configuration_revision),
                SourceBoundary::Lifecycle(boundary),
            );
        }
    }
    if requested_close {
        let _ = source.close();
    }
    if let Some(reply) = close_reply {
        let _ = reply.send(result.clone());
    }
    result
}

fn closing_error() -> HostError {
    HostError::new("HOST_BUSY", "Session is closing")
}
fn backend_deadline(clock: &dyn Clock, wait: Duration) -> u64 {
    clock
        .mono_ns()
        .saturating_add(wait.as_nanos().min(u128::from(u64::MAX)) as u64)
}

fn disconnected(
    snapshot: &Mutex<SessionSnapshot>,
    projections: &ProjectionStore,
    source: &StreamSource,
    error: HostError,
) {
    if let Ok(mut state) = snapshot.lock() {
        state.state = SessionState::Disconnected;
        if !matches!(
            state.tx_gate,
            TxGate::ControlUnknown | TxGate::ConfigurationPending
        ) {
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

    #[tokio::test]
    async fn explicit_reopen_after_confirmed_write_cleanup_starts_new_epoch_without_replaying() {
        let h = support::Harness::new().await;
        let name = "manual-write-recovery";
        let target = h.open(name).await;
        let session = h.host.devices().session(&target).unwrap();
        h.probe.steps.lock().unwrap().push_back(support::WriteStep {
            accepted: 0,
            unknown: true,
            gate: None,
            advance_ms: 0,
        });
        let original = session
            .write(
                WritePayload::owned(Arc::from([1, 2, 3])),
                Duration::from_secs(1),
                BackendAdmission {
                    session_epoch: target.session_epoch.unwrap(),
                    actor_id: h.actor.id().clone(),
                    lease_id: None,
                    lease: Arc::new(Mutex::new(None)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                },
            )
            .await
            .unwrap();
        assert!(!original.unknown_ranges.is_empty());
        session.close().await.unwrap();
        assert_eq!(
            session.snapshot().unwrap().control_state,
            ControlState::Clear
        );
        assert_eq!(session.snapshot().unwrap().tx_gate, TxGate::ControlUnknown);
        let reopened = h
            .host
            .devices()
            .open(
                &h.device(name),
                OpenParams {
                    binding: None,
                    configuration: SerialConfiguration::default(),
                },
            )
            .await
            .expect("explicit reopen must recover only after confirmed cleanup");
        assert!(!reopened.reused);
        assert_eq!(reopened.session_id, target.id);
        assert!(reopened.session_epoch > target.session_epoch.unwrap());
        assert_eq!(h.probe.writes.lock().unwrap().len(), 1);
        assert!(!original.unknown_ranges.is_empty());
        h.host.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn explicit_reopen_keeps_quarantine_while_owner_cleanup_is_pending() {
        let h = support::Harness::new().await;
        let name = "manual-recovery-pending";
        let target = h.open(name).await;
        let session = h.host.devices().session(&target).unwrap();
        let gate = hold_read(&h).await;
        session.snapshot.lock().unwrap().tx_gate = TxGate::ControlUnknown;
        let result = h
            .host
            .devices()
            .open(
                &h.device(name),
                OpenParams {
                    binding: None,
                    configuration: SerialConfiguration::default(),
                },
            )
            .await;
        gate.release();
        assert_eq!(result.unwrap_err().code, "CONTROL_UNKNOWN");
        assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
        assert_eq!(session.snapshot().unwrap().tx_gate, TxGate::ControlUnknown);
        session.close().await.unwrap();
        assert_shutdown_retains_known_closed_quarantine(&h, &target).await;
    }

    #[tokio::test]
    async fn explicit_reopen_does_not_clear_unsettled_line_control() {
        let h = support::Harness::new().await;
        let name = "manual-recovery-line-control";
        let target = h.open(name).await;
        let session = h.host.devices().session(&target).unwrap();
        session.close().await.unwrap();
        {
            let mut state = session.snapshot.lock().unwrap();
            state.tx_gate = TxGate::ControlUnknown;
            state.control_state = ControlState::Asserted;
        }
        let error = h
            .host
            .devices()
            .open(
                &h.device(name),
                OpenParams {
                    binding: None,
                    configuration: SerialConfiguration::default(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "CONTROL_UNKNOWN");
        assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
        assert_eq!(
            session.snapshot().unwrap().control_state,
            ControlState::Asserted
        );
        session.snapshot.lock().unwrap().control_state = ControlState::Clear;
        assert_shutdown_retains_known_closed_quarantine(&h, &target).await;
    }

    #[tokio::test]
    async fn automatic_reopen_cannot_clear_a_confirmed_closed_quarantine() {
        let h = support::Harness::new().await;
        let name = "automatic-recovery-quarantine";
        let target = h.open(name).await;
        let session = h.host.devices().session(&target).unwrap();
        session.close().await.unwrap();
        {
            let mut state = session.snapshot.lock().unwrap();
            state.tx_gate = TxGate::ControlUnknown;
            state.state = SessionState::Disconnected;
        }
        let error = h
            .host
            .devices()
            .open_inner(
                &h.device(name),
                OpenParams {
                    binding: None,
                    configuration: SerialConfiguration::default(),
                },
                Some(&OpenAdmission {
                    actor: h.actor.clone(),
                    grant_stamp: None,
                    binding: None,
                    cancelled: Arc::new(AtomicBool::new(false)),
                    expected_session: Some((target.id.clone(), target.session_epoch.unwrap())),
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "CONTROL_UNKNOWN");
        assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
        session.close().await.unwrap();
        assert_shutdown_retains_known_closed_quarantine(&h, &target).await;
    }

    #[tokio::test]
    async fn explicit_reopen_recovers_persisted_quarantine_only_by_opening_a_new_epoch() {
        let h = support::Harness::new().await;
        let name = "manual-recovery-persisted";
        let device = h.device(name);
        let target = h.open(name).await;
        let service = h.host.devices();
        let session = service.session(&target).unwrap();
        session.close().await.unwrap();
        session.snapshot.lock().unwrap().tx_gate = TxGate::ControlUnknown;
        service.persist(&session).await.unwrap();
        // 模拟同一持久记录在尚无本进程会话的显式打开路径。
        service.inner.slots.lock().unwrap().remove(&device.id);
        service.inner.sessions.lock().unwrap().remove(&target.id);
        let reopened = service
            .open(
                &device,
                OpenParams {
                    binding: None,
                    configuration: SerialConfiguration::default(),
                },
            )
            .await
            .unwrap();
        assert!(!reopened.reused);
        assert!(reopened.session_epoch > target.session_epoch.unwrap());
        assert_eq!(h.probe.opens.load(Ordering::SeqCst), 2);
        assert!(h.probe.writes.lock().unwrap().is_empty());
        h.host.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn completed_close_and_shutdown_wait_for_actual_owner_thread_exit() {
        let h = support::Harness::new().await;
        let exited = Arc::new(support::Gate::default());
        *h.host.devices().inner.owner_exit_gate.lock().unwrap() = Some(exited.clone());
        let target = h.open("owner-thread-exit").await;
        let devices = h.host.devices().clone();
        let session = devices.session(&target).unwrap();
        let read = hold_read(&h).await;
        let mut first = Box::pin(session.close());
        poll_pending(first.as_mut()).await;
        read.release();
        exited.entered().await;
        assert_eq!(session.snapshot().unwrap().state, SessionState::Closed);
        assert!(session.completed.borrow().as_ref().unwrap().is_ok());
        let first_state = std::future::poll_fn(|cx| Poll::Ready(first.as_mut().poll(cx))).await;
        let mut second = Box::pin(session.close());
        let second_state = std::future::poll_fn(|cx| Poll::Ready(second.as_mut().poll(cx))).await;
        let mut shutdown = Box::pin(devices.shutdown());
        let shutdown_state =
            std::future::poll_fn(|cx| Poll::Ready(shutdown.as_mut().poll(cx))).await;
        let premature = [
            first_state.is_ready(),
            second_state.is_ready(),
            shutdown_state.is_ready(),
        ];
        exited.release();
        match first_state {
            Poll::Ready(result) => result,
            Poll::Pending => first.await,
        }
        .unwrap();
        match second_state {
            Poll::Ready(result) => result,
            Poll::Pending => second.await,
        }
        .unwrap();
        match shutdown_state {
            Poll::Ready(result) => result,
            Poll::Pending => shutdown.await,
        }
        .unwrap();
        let reaped = session.join.lock().unwrap().is_none();
        // Also clean up the old implementation when running the red regression.
        if let Some(join) = session.join.lock().unwrap().take() {
            join.join().unwrap();
        }
        assert_eq!(
            premature, [false; 3],
            "A close path reported success while its owner thread was still held"
        );
        assert!(reaped, "Successful shutdown retained the owner JoinHandle");
        assert_eq!(h.probe.close_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn write_deadline_requests_cancel_then_settles_without_advancing_domain_clock_again() {
        let h = support::Harness::new().await;
        let target = h.open("write-domain-deadline").await;
        let session = h.host.devices().session(&target).unwrap();
        let gate = Arc::new(support::Gate::default());
        h.probe.steps.lock().unwrap().push_back(support::WriteStep {
            accepted: 3,
            unknown: false,
            gate: Some(gate.clone()),
            advance_ms: 0,
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let admission = BackendAdmission {
            session_epoch: target.session_epoch.unwrap(),
            actor_id: h.actor.id().clone(),
            lease_id: None,
            lease: Arc::new(Mutex::new(None)),
            cancelled: cancelled.clone(),
        };
        let writing_session = session.clone();
        let writing = tokio::spawn(async move {
            writing_session
                .write(
                    WritePayload::owned(Arc::from([1, 2, 3])),
                    Duration::from_millis(10),
                    admission,
                )
                .await
        });
        gate.entered().await;
        h.clock.advance_ms(10);
        let result = tokio::time::timeout(Duration::from_millis(500), writing).await;
        let cancellation_observed = h
            .probe
            .write_cancelled
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .load(Ordering::SeqCst);
        gate.release();
        assert!(
            cancellation_observed,
            "owner must request native cancellation at the domain deadline"
        );
        assert!(
            !cancelled.load(Ordering::SeqCst),
            "deadline must not impersonate a user cancellation"
        );
        let result = result
            .expect("cleanup must not require another fake-clock advance")
            .unwrap()
            .unwrap();
        assert_eq!(
            result.unknown_ranges,
            [ByteRange {
                start: 0.into(),
                end: 3.into()
            }]
        );
        assert_eq!(result.error.unwrap().code, "WRITE_TIMEOUT");
        assert_shutdown_retains_known_closed_quarantine(&h, &target).await;
    }

    #[tokio::test]
    async fn drain_deadline_requests_cancel_without_advancing_domain_clock_again() {
        let h = support::Harness::new().await;
        let target = h.open("drain-domain-deadline").await;
        let session = h.host.devices().session(&target).unwrap();
        h.probe.drain_hold.store(true, Ordering::SeqCst);
        let cancelled = Arc::new(AtomicBool::new(false));
        let admission = BackendAdmission {
            session_epoch: target.session_epoch.unwrap(),
            actor_id: h.actor.id().clone(),
            lease_id: None,
            lease: Arc::new(Mutex::new(None)),
            cancelled: cancelled.clone(),
        };
        let request = DrainRequest {
            wait: Duration::from_millis(10),
            cancelled: cancelled.clone(),
            closing: session.closing.clone(),
        };
        let draining_session = session.clone();
        let draining =
            tokio::spawn(async move { draining_session.drain(request, admission).await });
        support::until(|| h.probe.drain_started.load(Ordering::SeqCst)).await;
        h.clock.advance_ms(10);
        let result = tokio::time::timeout(Duration::from_millis(500), draining).await;
        let cancellation_observed = h
            .probe
            .drain_cancelled
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .load(Ordering::SeqCst);
        h.probe.drain_release.store(true, Ordering::SeqCst);
        assert!(
            cancellation_observed,
            "owner must request drain cancellation at the domain deadline"
        );
        assert!(
            !cancelled.load(Ordering::SeqCst),
            "deadline must not impersonate a user cancellation"
        );
        assert!(matches!(
            result
                .expect("cleanup must not require another fake-clock advance")
                .unwrap()
                .unwrap(),
            ControlResult::Drained {
                status: ControlStatus::Unknown,
                ..
            }
        ));
        assert_shutdown_retains_known_closed_quarantine(&h, &target).await;
    }

    #[tokio::test]
    async fn pending_drain_keeps_receiving_and_closing_settles_without_waiting_for_drain() {
        let h = support::Harness::new().await;
        let target = h.open("drain-rx").await;
        let session = h.host.devices().session(&target).unwrap();
        h.probe.drain_hold.store(true, Ordering::SeqCst);
        let request = DrainRequest {
            wait: Duration::from_secs(60),
            cancelled: Arc::new(AtomicBool::new(false)),
            closing: session.closing.clone(),
        };
        let admission = BackendAdmission {
            session_epoch: target.session_epoch.unwrap(),
            actor_id: h.actor.id().clone(),
            lease_id: None,
            lease: Arc::new(Mutex::new(None)),
            cancelled: request.cancelled.clone(),
        };
        let mut draining = Box::pin(session.drain(request, admission));
        poll_pending(draining.as_mut()).await;
        support::until(|| h.probe.rx_during_drain.load(Ordering::SeqCst) >= 3).await;
        assert!(matches!(
            std::future::poll_fn(|cx| Poll::Ready(draining.as_mut().poll(cx))).await,
            Poll::Pending
        ));
        tokio::time::timeout(Duration::from_secs(1), session.close())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            draining.await.unwrap(),
            ControlResult::Drained {
                status: ControlStatus::Unknown,
                ..
            }
        ));
        assert_eq!(session.snapshot().unwrap().tx_gate, TxGate::ControlUnknown);
        assert_shutdown_retains_known_closed_quarantine(&h, &target).await;
    }

    #[tokio::test]
    async fn close_wait_is_bounded_when_backend_read_does_not_return() {
        let h = support::Harness::new().await;
        let target = h.open("bounded-close").await;
        let session = h.host.devices().session(&target).unwrap();
        let gate = hold_read(&h).await;
        let result = tokio::time::timeout(Duration::from_millis(500), session.close()).await;
        gate.release();
        assert!(
            result.is_ok(),
            "close waited indefinitely for the blocked owner"
        );
        assert_eq!(result.unwrap().unwrap_err().code, "CONTROL_UNKNOWN");
        assert_shutdown_retains_known_closed_quarantine(&h, &target).await;
    }

    async fn assert_shutdown_retains_known_closed_quarantine(
        h: &support::Harness,
        target: &Target,
    ) {
        let error = h.host.shutdown().await.unwrap_err();
        assert_eq!(error.code, "SHUTDOWN_INCOMPLETE");
        let report: ShutdownReport = decode(error.details.as_deref().unwrap()).unwrap();
        assert_eq!(report.mode, ShutdownMode::CancelAndSettle);
        assert!(!report.completed);
        assert_eq!(report.quarantined_sessions, vec![target.clone()]);
        assert!(report.unsettled_operation_ids.is_empty());
        assert!(report.failures.is_empty());
        let session = h.host.devices().session(target).unwrap();
        assert_eq!(*session.completed.borrow(), Some(Ok(())));
        assert_eq!(h.probe.closes.load(Ordering::SeqCst), 1);
        assert_eq!(session.snapshot().unwrap().state, SessionState::Closed);
        assert_eq!(session.snapshot().unwrap().tx_gate, TxGate::ControlUnknown);
    }

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

impl DeviceService {
    fn runtime_attachment(&self) -> HostResult<Option<RuntimeAttachment>> {
        self.inner
            .runtime
            .lock()
            .map(|runtime| runtime.clone())
            .map_err(|_| unavailable())
    }
    pub fn list(&self) -> HostResult<DeviceList> {
        self.runtime_attachment()?
            .ok_or_else(unavailable)?
            .directory
            .list()
    }
    pub async fn refresh(&self) -> HostResult<DeviceList> {
        self.runtime_attachment()?
            .ok_or_else(unavailable)?
            .directory
            .refresh()
            .await
    }
    pub fn recent(&self) -> HostResult<RecentList> {
        super::RecentConnections::new(self.inner.store.clone()).list()
    }
    async fn check_open(
        &self,
        target: &Target,
        configuration: &SerialConfiguration,
        admission: &OpenAdmission,
    ) -> HostResult<()> {
        let service = self.clone();
        let target = target.clone();
        let configuration = configuration.clone();
        let admission = admission.clone();
        blocking(move || service.check_open_now(&target, &configuration, &admission)).await
    }
    fn check_open_now(
        &self,
        target: &Target,
        configuration: &SerialConfiguration,
        admission: &OpenAdmission,
    ) -> HostResult<()> {
        if admission.cancelled.load(Ordering::SeqCst) {
            return Err(open_cancelled());
        }
        if self.inner.closing.load(Ordering::SeqCst) {
            return Err(closing());
        }
        if self.inner.store.identity()?.instance_epoch != self.inner.identity.instance_epoch {
            return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
        }
        self.inner
            .auth
            .require(&admission.actor, "device.modify", target)?;
        if let Some(stamp) = &admission.grant_stamp {
            self.inner.auth.validate_grants(stamp)?;
        }
        if let Some(runtime) = self.runtime_attachment()? {
            let list = runtime.directory.list()?;
            let descriptor = list
                .devices
                .iter()
                .find(|device| device.device_id == target.id)
                .ok_or_else(|| {
                    HostError::new("DEVICE_NOT_FOUND", "Device is absent from the directory")
                })?;
            if list.stale && descriptor.fingerprint.transport != DeviceTransportKind::Virtual {
                return Err(HostError::new(
                    "DISCOVERY_STALE",
                    "Device discovery must succeed before opening",
                ));
            }
            if let Some((reference, binding)) = &admission.binding {
                let latest = (runtime.resolver)(&admission.actor, reference)?;
                if latest != *binding || binding.configuration != *configuration {
                    return Err(HostError::new(
                        "CONFIGURATION_CONFLICT",
                        "Saved device binding changed",
                    ));
                }
                if binding.host_id != target.host_id {
                    return Err(invalid());
                }
                let exact =
                    super::IdentityMatcher::match_device(&binding.fingerprint, &list.devices)
                        == super::MatchResult::Exact(target.id.clone());
                let explicit = admission.expected_session.is_none()
                    && binding.device_id == target.id
                    && binding.fingerprint == descriptor.fingerprint;
                if !exact && !explicit {
                    return Err(HostError::new(
                        "REQUIRES_REBIND",
                        "Device identity requires explicit rebinding",
                    ));
                }
            }
        } else if admission.binding.is_some() {
            return Err(invalid());
        }
        if let Some((session_id, epoch)) = &admission.expected_session {
            let session = self
                .inner
                .sessions
                .lock()
                .map_err(|_| unavailable())?
                .get(session_id)
                .cloned()
                .ok_or_else(unavailable)?;
            let state = session.snapshot()?;
            if state.session_epoch != *epoch {
                return Err(HostError::new("EPOCH_MISMATCH", "Session epoch changed"));
            }
            if state.state != SessionState::Disconnected {
                return Err(open_cancelled());
            }
            if state.tx_gate == TxGate::ControlUnknown
                || state.control_state != ControlState::Clear
                || !session
                    .completed
                    .borrow()
                    .as_ref()
                    .is_some_and(Result::is_ok)
            {
                return Err(HostError::new(
                    "CONTROL_UNKNOWN",
                    "Previous owner cleanup is not confirmed",
                ));
            }
            if state.tx_gate == TxGate::ConfigurationPending {
                return Err(HostError::new(
                    "CONFIGURATION_PENDING",
                    "Configuration is unsettled",
                ));
            }
            if state.lease.as_ref().is_some_and(|lease| {
                matches!(lease.state, LeaseState::Active | LeaseState::Revoking)
            }) {
                return Err(HostError::new(
                    "LEASE_CONFLICT",
                    "A lease still owns the previous session",
                ));
            }
        }
        Ok(())
    }
    async fn record_recent(
        &self,
        target: &Target,
        configuration: &SerialConfiguration,
        opened: &mut OpenResult,
    ) {
        let result = async {
            let Some(runtime) = self.runtime_attachment()? else {
                return Ok(());
            };
            let descriptor = runtime.directory.descriptor(&target.id)?;
            let recent = super::RecentConnections::new(self.inner.store.clone());
            let entry = RecentConnection {
                device_id: target.id.clone(),
                fingerprint: descriptor.fingerprint,
                configuration: configuration.clone(),
                opened_at: self.inner.clock.wall_time(),
            };
            blocking(move || recent.record(entry)).await?;
            Ok::<_, HostError>(())
        }
        .await;
        opened.recent_error = result.err();
    }
    async fn reconnect_status(
        &self,
        session: &Arc<Session>,
        state: ReconnectState,
        attempts: u64,
        error: Option<HostError>,
    ) -> HostResult<()> {
        let snapshot = session.snapshot()?;
        if !self
            .inner
            .sessions
            .lock()
            .map_err(|_| unavailable())?
            .get(&snapshot.session_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            return Ok(());
        }
        {
            let mut snapshot = session.snapshot.lock().map_err(|_| unavailable())?;
            let status = ReconnectStatus {
                state,
                attempts: attempts.into(),
                last_error: error,
            };
            if snapshot.reconnect.as_ref() == Some(&status) {
                return Ok(());
            }
            snapshot.reconnect = Some(status);
            snapshot.revision = snapshot.revision.checked_next()?;
        }
        self.persist(session).await
    }
    async fn register_reconnect(
        &self,
        device: Target,
        opened: &OpenResult,
        mut admission: OpenAdmission,
    ) {
        let target = open_target(&self.inner.identity, opened);
        let Ok(session) = self.session(&target) else {
            return;
        };
        let Some((_, binding)) = admission.binding.clone() else {
            return;
        };
        let Ok(Some(runtime)) = self.runtime_attachment() else {
            return;
        };
        let old = self.inner.reconnect_jobs.lock().ok().and_then(|mut jobs| {
            // 仅退役已结束的观察任务；会话与原生隔离资源仍由各自 owner 持有。
            jobs.retain(|_, job| !job.task.is_finished());
            jobs.remove(&opened.session_id)
        });
        if let Some(old) = old {
            old.stop.store(true, Ordering::SeqCst);
            let _ = old.task.await;
        }
        let pin = runtime
            .directory
            .descriptor(&device.id)
            .and_then(|descriptor| runtime.directory.pin(&descriptor));
        if let Err(error) = pin {
            let _ = self
                .reconnect_status(&session, ReconnectState::Stopped, 0, Some(error))
                .await;
            return;
        }
        let _ = self
            .reconnect_status(&session, ReconnectState::Idle, 0, None)
            .await;
        admission.expected_session = Some((opened.session_id.clone(), opened.session_epoch));
        let weak = Arc::downgrade(&self.inner);
        let mut grants = self.inner.auth.subscribe_changes();
        let session_id = opened.session_id.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let job = tokio::spawn(async move {
            let _pin = ResponsibilityPin(runtime.directory.clone(), device.id.clone());
            let mut target = target;
            let mut schedule: Option<super::ReconnectResponsibility> = None;
            let mut attempts = 0;
            loop {
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let service = DeviceService { inner };
                let Ok(session) = service.session(&target) else {
                    break;
                };
                let Ok(snapshot) = session.snapshot() else {
                    break;
                };
                if schedule.as_ref().is_some_and(|responsibility| {
                    responsibility.session_epoch != snapshot.session_epoch
                }) {
                    schedule = None;
                    attempts = 0;
                }
                let checked = {
                    let service = service.clone();
                    let snapshot = snapshot.clone();
                    let admission = admission.clone();
                    let runtime = runtime.clone();
                    let device = device.clone();
                    let stopped = stopped.clone();
                    blocking(move || -> HostResult<()> {
                        if stopped.load(Ordering::SeqCst)
                            || admission.cancelled.load(Ordering::SeqCst)
                            || service.inner.closing.load(Ordering::SeqCst)
                            || matches!(
                                snapshot.state,
                                SessionState::Closed | SessionState::Closing
                            )
                        {
                            return Err(open_cancelled());
                        }
                        if service.inner.store.identity()?.instance_epoch
                            != service.inner.identity.instance_epoch
                        {
                            return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
                        }
                        service
                            .inner
                            .auth
                            .require(&admission.actor, "device.modify", &device)?;
                        if let Some(stamp) = &admission.grant_stamp {
                            service.inner.auth.validate_grants(stamp)?;
                        }
                        let (reference, original) =
                            admission.binding.as_ref().ok_or_else(invalid)?;
                        if (runtime.resolver)(&admission.actor, reference)? != *original
                            || snapshot.configuration != original.configuration
                        {
                            return Err(HostError::new(
                                "CONFIGURATION_CONFLICT",
                                "Saved binding or active configuration changed",
                            ));
                        }
                        if snapshot.tx_gate == TxGate::ControlUnknown
                            || snapshot.control_state != ControlState::Clear
                        {
                            return Err(HostError::new(
                                "CONTROL_UNKNOWN",
                                "Session remains isolated",
                            ));
                        }
                        if snapshot.tx_gate == TxGate::ConfigurationPending {
                            return Err(HostError::new(
                                "CONFIGURATION_PENDING",
                                "Configuration is unsettled",
                            ));
                        }
                        Ok(())
                    })
                    .await
                };
                if let Err(error) = checked {
                    let _ = service
                        .reconnect_status(&session, ReconnectState::Stopped, attempts, Some(error))
                        .await;
                    break;
                }
                if snapshot.state == SessionState::Disconnected {
                    let completed = session.completed.borrow().clone();
                    if completed.as_ref().is_some_and(Result::is_err) {
                        let _ = service
                            .reconnect_status(
                                &session,
                                ReconnectState::Stopped,
                                attempts,
                                Some(HostError::new("CONTROL_UNKNOWN", "Owner cleanup failed")),
                            )
                            .await;
                        break;
                    }
                    let settled = completed.as_ref().is_some_and(Result::is_ok)
                        && !snapshot.lease.as_ref().is_some_and(|lease| {
                            matches!(lease.state, LeaseState::Active | LeaseState::Revoking)
                        });
                    if settled {
                        if schedule.is_none() {
                            schedule = super::ReconnectResponsibility::new(
                                admission.actor.id().clone(),
                                binding.clone(),
                                snapshot.session_epoch,
                                service.inner.clock.clone(),
                            )
                            .ok();
                            let _ = service
                                .reconnect_status(&session, ReconnectState::Waiting, attempts, None)
                                .await;
                        }
                        let list = runtime.directory.list();
                        let identity = list.as_ref().ok().filter(|list| !list.stale).map(|list| {
                            super::IdentityMatcher::match_device(
                                &binding.fingerprint,
                                &list.devices,
                            )
                        });
                        let exact = matches!(&identity, Some(super::MatchResult::Exact(id)) if id == &device.id);
                        if matches!(identity, Some(super::MatchResult::RequiresRebind(_))) {
                            let _ = service
                                .reconnect_status(
                                    &session,
                                    ReconnectState::RequiresRebind,
                                    attempts,
                                    Some(HostError::new(
                                        "REQUIRES_REBIND",
                                        "Device identity requires explicit rebinding",
                                    )),
                                )
                                .await;
                        }
                        if let Some(schedule) = schedule.as_mut() {
                            let decision = schedule.poll(super::ReconnectGate {
                                authorized: true,
                                identity_exact: exact,
                                configuration_settled: true,
                                epoch_current: true,
                                closed: false,
                                cancelled: false,
                            });
                            match decision {
                                super::ReconnectDecision::Attempt => {
                                    attempts += 1;
                                    let _ = service
                                        .reconnect_status(
                                            &session,
                                            ReconnectState::Attempting,
                                            attempts,
                                            None,
                                        )
                                        .await;
                                    let params = OpenParams {
                                        configuration: binding.configuration.clone(),
                                        binding: admission
                                            .binding
                                            .as_ref()
                                            .map(|(reference, _)| reference.clone()),
                                    };
                                    match service
                                        .open_inner(&device, params, Some(&admission))
                                        .await
                                    {
                                        Ok(mut opened) => {
                                            service
                                                .record_recent(
                                                    &device,
                                                    &binding.configuration,
                                                    &mut opened,
                                                )
                                                .await;
                                            target = open_target(&service.inner.identity, &opened);
                                            admission.expected_session =
                                                Some((opened.session_id, opened.session_epoch));
                                            if let Ok(current) = service.session(&target) {
                                                let _ = service
                                                    .reconnect_status(
                                                        &current,
                                                        ReconnectState::Idle,
                                                        0,
                                                        opened.recent_error,
                                                    )
                                                    .await;
                                            }
                                            attempts = 0;
                                        }
                                        Err(error) => {
                                            schedule.attempt_failed();
                                            let _ = service
                                                .reconnect_status(
                                                    &session,
                                                    ReconnectState::Waiting,
                                                    attempts,
                                                    Some(error),
                                                )
                                                .await;
                                        }
                                    }
                                }
                                super::ReconnectDecision::Stopped => {
                                    let _ = service
                                        .reconnect_status(
                                            &session,
                                            ReconnectState::Stopped,
                                            attempts,
                                            Some(HostError::new(
                                                "RECONNECT_EXHAUSTED",
                                                "Reconnect attempt limit reached",
                                            )),
                                        )
                                        .await;
                                    break;
                                }
                                super::ReconnectDecision::Wait => {}
                            }
                        }
                    }
                } else {
                    schedule = None;
                }
                drop(service);
                tokio::select! { _ = grants.changed() => {}, _ = tokio::time::sleep(Duration::from_millis(20)) => {} }
            }
        });
        if let Ok(mut jobs) = self.inner.reconnect_jobs.lock() {
            jobs.insert(session_id, ReconnectJob { stop, task: job });
        }
    }
}
fn open_cancelled() -> HostError {
    HostError::new("CANCELLED", "Device open responsibility was cancelled")
}
fn open_target(identity: &HostIdentity, opened: &OpenResult) -> Target {
    Target {
        host_id: identity.host_id.clone(),
        kind: ResourceKind::try_from("session").expect("session kind"),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id.clone()),
        session_epoch: Some(opened.session_epoch),
    }
}

#[cfg(test)]
mod responsibility_budget_tests {
    use super::*;
    use crate::{
        device::{DeviceProvider, DeviceRuntime, virtual_backend::VirtualTransport},
        state::ProjectionLimits,
        test_support as support,
    };
    struct ManyDevices(Id);
    struct RuntimeProvider {
        host_id: Id,
        opener: TransportOpener,
    }
    impl DeviceProvider for RuntimeProvider {
        fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>> {
            Ok(ManyDevices(self.host_id.clone())
                .enumerate()?
                .into_iter()
                .take(1)
                .collect())
        }
        fn open(
            &self,
            descriptor: &DeviceDescriptor,
            configuration: &SerialConfiguration,
        ) -> BackendResult<Box<dyn Transport>> {
            (self.opener)(&descriptor.device_id, configuration)
        }
    }
    #[tokio::test]
    async fn host_close_after_disconnected_owner_settles_closed_and_allows_new_epoch() {
        let mut h = support::Harness::new().await;
        let provider = Arc::new(RuntimeProvider {
            host_id: h.host_id.clone(),
            opener: h.host.devices().inner.opener.clone(),
        });
        h.host.shutdown().await.unwrap();
        h.host = crate::Host::with_device_provider(
            h.store.clone(),
            h.auth.clone(),
            h.clock.clone(),
            provider,
        )
        .await
        .unwrap();
        let descriptor = h
            .host
            .devices()
            .refresh()
            .await
            .unwrap()
            .devices
            .into_iter()
            .find(|device| device.fingerprint.transport == DeviceTransportKind::Serial)
            .unwrap();
        let device = h.device(descriptor.device_id.as_str());
        let params = serde_json::json!({"configuration": SerialConfiguration::default()});
        let opened = h.action(&device, "device.open", params.clone()).await;
        assert_eq!(
            opened.state,
            OperationState::Succeeded,
            "{:?}",
            opened.error
        );
        let Some(ActionResult::Opened(first)) = opened.result else {
            panic!("open result")
        };
        let target = open_target(&h.store.identity().unwrap(), &first);
        let session = h.host.devices().session(&target).unwrap();
        h.probe.read_fails.store(true, Ordering::SeqCst);
        let mut completed = session.completed.clone();
        let cleanup =
            tokio::time::timeout(Duration::from_secs(3), completed.wait_for(Option::is_some))
                .await
                .unwrap()
                .unwrap()
                .clone()
                .unwrap();
        assert_eq!(cleanup, Ok(()));
        assert_eq!(h.probe.closes.load(Ordering::SeqCst), 1);
        assert_eq!(
            session.snapshot().unwrap().state,
            SessionState::Disconnected
        );
        let closed = h
            .action(&target, "session.close", serde_json::json!({}))
            .await;
        assert_eq!(
            closed.state,
            OperationState::Succeeded,
            "{:?}",
            closed.error
        );
        let Some(ActionResult::Session(receipt)) = closed.result else {
            panic!("close result")
        };
        assert_eq!(receipt.state, SessionState::Closed);
        let persisted = h
            .store
            .read_document(&document_id(&device.id).unwrap())
            .unwrap()
            .unwrap();
        let persisted: SessionSnapshot = decode(&persisted.value).unwrap();
        assert_eq!(persisted.state, SessionState::Closed);
        assert_eq!(persisted.session_epoch, first.session_epoch);
        h.probe.read_fails.store(false, Ordering::SeqCst);
        let reopened = h.action(&device, "device.open", params).await;
        assert_eq!(
            reopened.state,
            OperationState::Succeeded,
            "{:?}",
            reopened.error
        );
        let Some(ActionResult::Opened(second)) = reopened.result else {
            panic!("open result")
        };
        assert_eq!(second.session_id, first.session_id);
        assert_eq!(
            second.session_epoch,
            first.session_epoch.checked_next().unwrap()
        );
        assert!(!second.reused);
        assert_eq!(h.probe.opens.load(Ordering::SeqCst), 2);
        assert_eq!(
            h.host.devices().snapshot(&target).await.unwrap_err().code,
            "EPOCH_MISMATCH"
        );
        h.host.shutdown().await.unwrap();
    }
    impl DeviceProvider for ManyDevices {
        fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>> {
            Ok((0..21)
                .map(|index| DeviceDescriptor {
                    device_id: support::id(&format!("provider-{index}")),
                    host_id: self.0.clone(),
                    system_name: format!("COM{}", index + 1),
                    description: None,
                    manufacturer: None,
                    driver: None,
                    fingerprint: DeviceFingerprint {
                        transport: DeviceTransportKind::Serial,
                        vid: Some(1),
                        pid: Some(2),
                        serial_number: Some(format!("unit-{index}")),
                        topology_path: Some(format!("socket-{index}")),
                        evidence: IdentityEvidence::SerialNumber,
                    },
                    capabilities: VirtualTransport::new(SerialConfiguration::default())
                        .capabilities(),
                })
                .collect())
        }
        fn open(
            &self,
            _: &DeviceDescriptor,
            _: &SerialConfiguration,
        ) -> BackendResult<Box<dyn Transport>> {
            unreachable!("Harness owns the injected transport")
        }
    }
    #[tokio::test]
    async fn retired_responsibilities_do_not_accumulate_and_active_owner_is_retained() {
        let h = support::Harness::new().await;
        let identity = h.store.identity().unwrap();
        let directory = DeviceRuntime::new(
            identity.clone(),
            Arc::new(ManyDevices(h.host_id.clone())),
            ProjectionStore::new(identity, h.auth.clone(), ProjectionLimits::default()),
        )
        .unwrap();
        let devices: Vec<_> = directory
            .refresh()
            .await
            .unwrap()
            .devices
            .into_iter()
            .filter(|device| device.fingerprint.transport == DeviceTransportKind::Serial)
            .collect();
        let lookup = directory.clone();
        h.host
            .devices()
            .attach_runtime(
                directory,
                Arc::new(move |_, reference| {
                    let descriptor = lookup.descriptor(&reference.binding_id)?;
                    Ok(DeviceBinding {
                        binding_id: reference.binding_id.clone(),
                        host_id: descriptor.host_id,
                        device_id: descriptor.device_id,
                        fingerprint: descriptor.fingerprint,
                        configuration: SerialConfiguration::default(),
                        reconnect: ReconnectPolicy {
                            enabled: true,
                            ..Default::default()
                        },
                    })
                }),
            )
            .unwrap();
        let mut live = None;
        for (index, descriptor) in devices.iter().enumerate() {
            let opened = h
                .host
                .devices()
                .open_authorized(
                    &h.actor,
                    &h.device(descriptor.device_id.as_str()),
                    OpenParams {
                        configuration: SerialConfiguration::default(),
                        binding: Some(DeviceBindingReference {
                            workspace_id: support::id("bench"),
                            binding_id: descriptor.device_id.clone(),
                        }),
                    },
                    Arc::new(AtomicBool::new(false)),
                )
                .await
                .unwrap();
            if index == 20 {
                live = Some(opened);
                break;
            }
            let target = open_target(&h.store.identity().unwrap(), &opened);
            let closed = h
                .action(&target, "session.close", serde_json::json!({}))
                .await;
            assert_eq!(closed.state, OperationState::Succeeded);
            support::until(|| {
                h.host
                    .devices()
                    .inner
                    .reconnect_jobs
                    .lock()
                    .unwrap()
                    .get(&opened.session_id)
                    .is_none_or(|job| job.task.is_finished())
            })
            .await;
        }
        {
            let jobs = h.host.devices().inner.reconnect_jobs.lock().unwrap();
            assert!(
                jobs.len() <= 16,
                "retired responsibilities exceeded the live-session budget: {}",
                jobs.len()
            );
            assert!(
                !jobs
                    .get(&live.unwrap().session_id)
                    .unwrap()
                    .task
                    .is_finished()
            );
        }
        assert_eq!(h.probe.opens.load(Ordering::SeqCst), 21);
        assert_eq!(h.probe.closes.load(Ordering::SeqCst), 20);
        h.host.shutdown().await.unwrap();
    }
}
