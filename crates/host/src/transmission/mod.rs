mod controls;
pub(crate) mod file_transfer;
#[cfg(test)]
mod fix_round1_tests;
mod leases;
mod scheduler;
#[cfg(test)]
mod tests;
mod tool_handoff;
#[cfg(all(test, windows))]
mod tool_handoff_sim_tests;
#[cfg(all(test, windows))]
mod tool_handoff_test_package;
use crate::{
    auth::AuthenticatedActor,
    device::{
        DeviceService,
        sessions::{
            BackendAdmission, ConfigurationChange, Session, TxDispatchFence, blocking, decode,
            invalid, new_id, object,
        },
    },
    dispatch::AcceptedCall,
    storage::Settlement,
    stream::{PreparedTxIntent, SourceBoundary, TxSettlement},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use scheduler::{Entry, QueueReservation, Runtime, Turn};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
fn validate_mapped_tx_source(
    source: &TxSourceText,
    transforms: &[TransformReference],
) -> HostResult<()> {
    let original = STANDARD
        .decode(source.utf8_base64.as_str())
        .map_err(|_| invalid())?;
    std::str::from_utf8(&original).map_err(|_| invalid())?;

    let replacements = &source.mapping.replacements;
    if replacements.len() > CHARACTER_REMAP_MAX_REPLACEMENTS {
        return Err(invalid());
    }
    let mut seen = HashSet::with_capacity(replacements.len());
    for row in replacements {
        if row.source.chars().count() != 1
            || matches!(row.source.as_str(), "\r" | "\n" | "\x08")
            || row.replacement.encode_utf16().count() > CHARACTER_REMAP_MAX_REPLACEMENT_UTF16
            || !seen.insert(row.source.as_str())
        {
            return Err(invalid());
        }
    }

    let mapping = serde_json::to_vec(&source.mapping).map_err(|_| invalid())?;
    let digest = format!("{:x}", Sha256::digest(mapping));
    let [transform] = transforms else {
        return Err(invalid());
    };
    if transform.id.as_str() != CHARACTER_REMAP_TRANSFORM_ID
        || transform.version != CHARACTER_REMAP_TRANSFORM_VERSION
        || transform.configuration_digest.as_str() != digest
    {
        return Err(invalid());
    }
    Ok(())
}

type RuntimeMap = HashMap<(Id, U64), Arc<Runtime>>;
type AdmissionScope = (Id, U64, Id);
#[cfg(test)]
type TestGate = Arc<
    Mutex<
        Option<(
            tokio::sync::oneshot::Sender<()>,
            tokio::sync::oneshot::Receiver<()>,
        )>,
    >,
>;
#[derive(Clone)]
pub struct TransmissionService {
    pub(crate) devices: DeviceService,
    tokens: Arc<Mutex<HashMap<Id, Arc<ControlToken>>>>,
    pending_cancels: Arc<Mutex<HashSet<Id>>>,
    ready: Arc<Notify>,
    runtimes: Arc<Mutex<RuntimeMap>>,
    admissions: Arc<AtomicUsize>,
    session_admissions: Arc<Mutex<HashMap<AdmissionScope, usize>>>,
    quiescing: Arc<AtomicBool>,
    quiesce_cancel: Arc<AtomicBool>,
    #[cfg(test)]
    cancel_gap: TestGate,
    #[cfg(test)]
    dispatch_gap: TestGate,
    #[cfg(test)]
    boundary_gap: TestGate,
    #[cfg(test)]
    settlement_gap: TestGate,
}
#[derive(Default)]
struct QueueWait {
    relative_ms: Option<DurationMs>,
    dispatch_fence: Option<TxDispatchFence>,
}
struct ControlToken {
    is_stop: bool,
    actor_id: Id,
    is_tx: bool,
    cancelled: Arc<AtomicBool>,
    dispatch: tokio::sync::Mutex<()>,
    done: Notify,
    wake: Notify,
    session_id: Option<Id>,
    session_epoch: Option<U64>,
    is_close: bool,
    holds_tool_gate: AtomicBool,
    grant_stamp: Option<crate::auth::GrantStamp>,
    lease_id: Option<Id>,
    accepted_mono_ns: u64,
}
impl ControlToken {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }
}
pub(crate) struct AdmissionGuard {
    count: Arc<AtomicUsize>,
    session_counts: Arc<Mutex<HashMap<AdmissionScope, usize>>>,
    scope: Option<AdmissionScope>,
    ready: Arc<Notify>,
}
pub(crate) struct OperationPreparation {
    file_transfer: Option<file_transfer::FileTransferGuard>,
    transfer_source: Option<file_transfer::PreparedTransfer>,
    configuration_change: Option<ConfigurationChange>,
    _queue: Option<QueueReservation>,
    session: Option<Arc<Session>>,
    tx: Option<(Arc<[u8]>, PreparedTxIntent)>,
}
impl OperationPreparation {
    pub(crate) fn set_browser_file(&mut self, upload: crate::dispatch::browser_file::Upload) {
        self.transfer_source = Some(file_transfer::PreparedTransfer::Browser(Box::new(upload)));
    }
}
impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        if let Some(scope) = &self.scope {
            let mut counts = self
                .session_counts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(count) = counts.get_mut(scope) {
                *count -= 1;
                if *count == 0 {
                    counts.remove(scope);
                }
            }
        }
        self.count.fetch_sub(1, Ordering::SeqCst);
        self.ready.notify_waiters();
    }
}
struct Completion {
    state: OperationState,
    result: ActionResult,
    error: Option<HostError>,
}
impl Completion {
    fn success(result: ActionResult) -> Self {
        Self {
            state: OperationState::Succeeded,
            result,
            error: None,
        }
    }
}
impl TransmissionService {
    pub fn new(devices: DeviceService) -> Self {
        Self {
            devices,
            tokens: Arc::new(Mutex::new(HashMap::new())),
            pending_cancels: Arc::new(Mutex::new(HashSet::new())),
            ready: Arc::new(Notify::new()),
            runtimes: Arc::new(Mutex::new(HashMap::new())),
            admissions: Arc::new(AtomicUsize::new(0)),
            session_admissions: Arc::default(),
            quiescing: Arc::new(AtomicBool::new(false)),
            quiesce_cancel: Arc::new(AtomicBool::new(false)),
            #[cfg(test)]
            cancel_gap: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            dispatch_gap: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            boundary_gap: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            settlement_gap: Arc::new(Mutex::new(None)),
        }
    }
    #[cfg(test)]
    pub(crate) fn hold_next_dispatch(
        &self,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        tokio::sync::oneshot::Sender<()>,
    ) {
        let (entered, held) = tokio::sync::oneshot::channel();
        let (release, waiting) = tokio::sync::oneshot::channel();
        assert!(
            self.dispatch_gap
                .lock()
                .unwrap()
                .replace((entered, waiting))
                .is_none()
        );
        (held, release)
    }
    pub(crate) fn admission(
        &self,
        allow_stop: bool,
        call: Option<&Call>,
    ) -> HostResult<AdmissionGuard> {
        if self.quiescing.load(Ordering::SeqCst) && !allow_stop {
            return Err(HostError::new(
                "HOST_BUSY",
                "Host transmission admission is closed",
            ));
        }
        let scope = call.and_then(|call| Self::admission_scope(&call.target, &call.actor_id));
        if let Some(scope) = &scope {
            let mut counts = self.session_admissions.lock().map_err(|_| invalid())?;
            *counts.entry(scope.clone()).or_default() += 1;
        }
        self.admissions.fetch_add(1, Ordering::SeqCst);
        let guard = AdmissionGuard {
            count: self.admissions.clone(),
            session_counts: self.session_admissions.clone(),
            scope,
            ready: self.ready.clone(),
        };
        if self.quiescing.load(Ordering::SeqCst) && !allow_stop {
            return Err(HostError::new(
                "HOST_BUSY",
                "Host transmission admission is closed",
            ));
        }
        self.require_handoff_admission(call, allow_stop)?;
        Ok(guard)
    }
    fn require_handoff_admission(&self, call: Option<&Call>, allow_stop: bool) -> HostResult<()> {
        let Some(call) = call.filter(|call| !allow_stop && call.target.kind.as_str() == "session")
        else {
            return Ok(());
        };
        let active = self
            .tokens
            .lock()
            .map_err(|_| invalid())?
            .values()
            .any(|token| {
                token.holds_tool_gate.load(Ordering::SeqCst)
                    && token.session_id.as_ref() == Some(&call.target.id)
                    && token.session_epoch == call.target.session_epoch
            });
        if active {
            return Err(HostError::new(
                "DEVICE_BUSY",
                "The session is reserved for an external tool",
            ));
        }
        Ok(())
    }
    fn admission_scope(target: &Target, actor: &Id) -> Option<AdmissionScope> {
        Some((
            target.session_id.clone()?,
            target.session_epoch?,
            actor.clone(),
        ))
    }
    fn has_session_admission(&self, target: &Target, actor: &Id) -> HostResult<bool> {
        let key = Self::admission_scope(target, actor).ok_or_else(invalid)?;
        Ok(self
            .session_admissions
            .lock()
            .map_err(|_| invalid())?
            .contains_key(&key))
    }
    pub(crate) fn prepare(&self, call: &Call) -> HostResult<OperationPreparation> {
        let session = if call.target.kind.as_str() == "session" {
            Some(self.devices.session(&call.target)?)
        } else {
            None
        };
        let bytes = if call.action_id.as_str() == "session.tx" {
            let params: TxParams = decode(&call.params)?;
            if params
                .dispatch_window
                .is_some_and(|window| window.earliest_unix_ms > window.latest_unix_ms)
            {
                return Err(invalid());
            }
            if let Some(source) = &params.source_text {
                validate_mapped_tx_source(source, params.transforms.as_deref().unwrap_or(&[]))?;
            }
            let bytes: Arc<[u8]> = STANDARD
                .decode(params.bytes_base64.as_str())
                .map_err(|_| invalid())?
                .into();
            Some(bytes)
        } else {
            None
        };
        let paste = if call.action_id.as_str() == "transfer.paste" {
            Some(file_transfer::PreparedPaste::new(decode(&call.params)?)?)
        } else {
            None
        };
        let queue = if matches!(
            call.action_id.as_str(),
            "session.tx"
                | "transfer.file"
                | "transfer.paste"
                | "session.configure"
                | "session.control"
                | "session.break"
                | "session.setReadOnly"
                | "tx.drain"
                | "lease.acquire"
        ) {
            Some(self.runtime(&call.target)?.reserve(
                if call.action_id.as_str() == "transfer.file" {
                    usize::try_from(
                        decode::<FileTransferParams>(&call.params)?
                            .chunk_bytes
                            .get(),
                    )
                    .map_err(|_| invalid())?
                } else if let Some(paste) = &paste {
                    paste.len()
                } else {
                    bytes.as_ref().map_or(0, |bytes| bytes.len())
                },
            )?)
        } else {
            None
        };
        let tx = bytes
            .map(|bytes| -> HostResult<_> {
                let session = session.as_ref().ok_or_else(invalid)?;
                let prepared = session
                    .source
                    .reserve_tx_intent(self.devices.meta(session)?, bytes.clone())?;
                Ok((bytes, prepared))
            })
            .transpose()?;
        Ok(OperationPreparation {
            file_transfer: None,
            transfer_source: paste.map(file_transfer::PreparedTransfer::Paste),
            configuration_change: None,
            session,
            tx,
            _queue: queue,
        })
    }
    pub(crate) fn track(
        &self,
        operation: &Operation,
        grant_stamp: Option<crate::auth::GrantStamp>,
        lease_id: Option<Id>,
    ) -> HostResult<()> {
        let result = (|| {
            let session_id =
                (operation.target.kind.as_str() == "session").then(|| operation.target.id.clone());
            let is_tool_handoff = operation.action_id.as_str() == "session.toolHandoff";
            let is_close = operation.action_id.as_str() == "session.close" || is_tool_handoff;
            let runtime = session_id
                .as_ref()
                .map(|_| self.runtime(&operation.target))
                .transpose()?;
            let mut pending = self.pending_cancels.lock().map_err(|_| invalid())?;
            let mut tokens = self.tokens.lock().map_err(|_| invalid())?;
            if tokens.len() >= 256 {
                return Err(HostError::new(
                    "HOST_BUSY",
                    "Operation owner capacity exhausted",
                ));
            }
            let mut should_cancel = self.devices.inner.closing.load(Ordering::SeqCst);
            if let Some(runtime) = runtime {
                if is_close && !is_tool_handoff && self.devices.session(&operation.target).is_ok() {
                    if runtime.closing.swap(true, Ordering::SeqCst) {
                        return Err(HostError::new("HOST_BUSY", "Session is already closing"));
                    }
                } else {
                    should_cancel |= runtime.closing.load(Ordering::SeqCst);
                }
            }
            let is_stop = crate::limits::is_stop(operation.action_id.as_str());
            should_cancel |= self.quiesce_cancel.load(Ordering::SeqCst) && !is_stop;
            should_cancel |= pending.remove(&operation.operation_id);
            tokens.insert(
                operation.operation_id.clone(),
                Arc::new(ControlToken {
                    is_stop,
                    actor_id: operation.actor_id.clone(),
                    is_tx: matches!(
                        operation.action_id.as_str(),
                        "session.tx" | "transfer.file" | "transfer.paste"
                    ),
                    cancelled: Arc::new(AtomicBool::new(should_cancel)),
                    dispatch: tokio::sync::Mutex::new(()),
                    done: Notify::new(),
                    wake: Notify::new(),
                    session_id,
                    session_epoch: operation.target.session_epoch,
                    is_close,
                    holds_tool_gate: AtomicBool::new(false),
                    grant_stamp,
                    lease_id: if operation.action_id.as_str().starts_with("lease.") {
                        None
                    } else {
                        lease_id
                    },
                    accepted_mono_ns: self.now(),
                }),
            );
            Ok(())
        })();
        self.ready.notify_waiters();
        result
    }
    pub(crate) async fn reject_untracked(
        &self,
        operation: &Operation,
        error: HostError,
    ) -> HostResult<()> {
        self.pending_cancels
            .lock()
            .map_err(|_| invalid())?
            .remove(&operation.operation_id);
        let store = self.devices.inner.store.clone();
        let id = operation.operation_id.clone();
        let result = blocking(move || {
            store.settle(
                &id,
                Settlement {
                    state: OperationState::Interrupted,
                    result: None,
                    error: Some(error),
                },
            )
        })
        .await;
        self.ready.notify_waiters();
        result?;
        Ok(())
    }
    pub(crate) async fn execute(
        &self,
        accepted: AcceptedCall,
        mut preparation: OperationPreparation,
    ) -> HostResult<()> {
        let token = self
            .tokens
            .lock()
            .map_err(|_| invalid())?
            .get(&accepted.operation.operation_id)
            .cloned()
            .ok_or_else(invalid)?;
        let mut grants = self.devices.inner.auth.subscribe_changes();
        if self.require_token(&accepted, &token).await.is_err() {
            token.cancel();
        }
        let result = {
            let work = self.run(&accepted, &token, &mut preparation);
            tokio::pin!(work);
            let mut watch = true;
            loop {
                tokio::select! {
                    result=&mut work=>break result,
                    _=self.devices.inner.auth.wait_grant_expiry(token.grant_stamp.as_ref()),if watch=>{token.cancel();watch=false;},
                    changed=grants.changed(),if watch=>{if changed.is_err() || self.require_token(&accepted,&token).await.is_err(){token.cancel();watch=false;}}
                }
            }
        };
        let store = self.devices.inner.store.clone();
        let id = accepted.operation.operation_id.clone();
        let actor = accepted.actor.clone();
        let mut settled = blocking(move || {
            let current = store.get(&actor, &id)?;
            if current.state.is_terminal() {
                return Ok(current);
            }
            let settlement = match result {
                Ok(done) => {
                    if done.state == OperationState::Cancelled
                        && current.state == OperationState::Running
                    {
                        store.request_cancel(&actor, &id)?;
                    }
                    Settlement {
                        state: done.state,
                        result: Some(done.result),
                        error: done.error,
                    }
                }
                Err(error) => Settlement {
                    state: if current.state == OperationState::Queued {
                        if token.cancelled.load(Ordering::SeqCst) {
                            OperationState::Cancelled
                        } else {
                            OperationState::Interrupted
                        }
                    } else if error.code == "STORAGE_UNAVAILABLE"
                        || error.code == "BACKEND_DISCONNECTED"
                    {
                        OperationState::Unknown
                    } else {
                        OperationState::Failed
                    },
                    result: None,
                    error: Some(error),
                },
            };
            store.settle(&id, settlement)
        })
        .await;
        if accepted.call.lease_id.is_some()
            && settled
                .as_ref()
                .is_ok_and(|operation| operation.state == OperationState::Unknown)
            && let Some(session) = &preparation.session
            && let Err(error) = self.isolate_lease(session).await
        {
            settled = Err(error);
        }
        if let Some(mut change) = preparation.configuration_change.take() {
            if settled.as_ref().is_ok_and(|operation| {
                matches!(operation.result, Some(ActionResult::Configuration(_)))
            }) {
                change.resume();
            } else {
                change.stop();
                let error = settled.as_ref().err().cloned().unwrap_or_else(|| {
                    HostError::new(
                        "STORAGE_UNAVAILABLE",
                        "Configuration receipt was not durably settled",
                    )
                });
                if let Some(session) = &preparation.session {
                    self.fail_configuration(session, &error).await;
                }
            }
        }
        if let Some(guard) = preparation.file_transfer.take()
            && let Err(error) = self.finish_file_transfer(guard, &settled).await
        {
            settled = Err(error);
        }
        #[cfg(test)]
        {
            let gate = self.settlement_gap.lock().unwrap().take();
            if let Some((entered, release)) = gate {
                let _ = entered.send(());
                let _ = release.await;
            }
        }
        if let Some(token) = self
            .tokens
            .lock()
            .map_err(|_| invalid())?
            .remove(&accepted.operation.operation_id)
        {
            token.done.notify_waiters();
        }
        self.ready.notify_waiters();
        settled?;
        Ok(())
    }
    async fn run(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        preparation: &mut OperationPreparation,
    ) -> HostResult<Completion> {
        if accepted.call.action_id.as_str() == "device.open" {
            self.require_token(accepted, token).await?;
            let _guard = token.dispatch.lock().await;
            if token.cancelled.load(Ordering::SeqCst) {
                return Err(cancelled());
            }
            let store = self.devices.inner.store.clone();
            let id = accepted.operation.operation_id.clone();
            blocking(move || store.mark_dispatch(&id)).await?;
            return Ok(Completion::success(ActionResult::Opened(
                self.devices
                    .open_authorized(
                        &accepted.actor,
                        &accepted.call.target,
                        decode(&accepted.call.params)?,
                        token.cancelled.clone(),
                    )
                    .await?,
            )));
        }
        let session = preparation.session.as_ref().ok_or_else(invalid)?;
        let runtime = self.runtime(&accepted.call.target)?;
        match accepted.call.action_id.as_str() {
            "session.toolHandoff" => self.tool_handoff(accepted, token, session, &runtime).await,
            "transfer.file" | "transfer.paste" => {
                self.transfer(
                    accepted,
                    token,
                    session,
                    &runtime,
                    &mut preparation.file_transfer,
                    preparation.transfer_source.take(),
                )
                .await
            }
            "session.tx" => {
                self.submit(
                    accepted,
                    token,
                    session,
                    &runtime,
                    preparation.tx.take().ok_or_else(invalid)?,
                )
                .await
            }
            "lease.acquire" | "lease.renew" | "lease.release" => {
                self.lease_action(accepted, token, session, &runtime).await
            }
            _ => {
                self.control_action(
                    accepted,
                    token,
                    session,
                    &runtime,
                    &mut preparation.configuration_change,
                )
                .await
            }
        }
    }
    fn runtime(&self, target: &Target) -> HostResult<Arc<Runtime>> {
        let epoch = target.session_epoch.ok_or_else(invalid)?;
        let mut runtimes = self.runtimes.lock().map_err(|_| invalid())?;
        runtimes.retain(|(id, old), runtime| {
            (id == &target.id && *old == epoch)
                || Arc::strong_count(runtime) > 1
                || (id != &target.id && !runtime.closing.load(Ordering::SeqCst))
        });
        Ok(runtimes
            .entry((target.id.clone(), epoch))
            .or_insert_with(|| Arc::new(Runtime::default()))
            .clone())
    }
    fn now(&self) -> u64 {
        self.devices.inner.clock.mono_ns()
    }
    fn backend_admission(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        runtime: &Runtime,
    ) -> BackendAdmission {
        BackendAdmission {
            dispatch_fence: None,
            session_epoch: accepted.call.target.session_epoch.expect("session target"),
            actor_id: accepted.actor.id().clone(),
            lease_id: accepted.call.lease_id.clone(),
            lease: runtime.lease.clone(),
            cancelled: token.cancelled.clone(),
        }
    }
    async fn require(&self, accepted: &AcceptedCall) -> HostResult<()> {
        let auth = self.devices.inner.auth.clone();
        let actor = accepted.actor.clone();
        let target = accepted.call.target.clone();
        let store = self.devices.inner.store.clone();
        let epoch = accepted.call.instance_epoch;
        let permission = if matches!(
            accepted.call.action_id.as_str(),
            "session.takeover" | "session.toolHandoff"
        ) {
            "auth.manage"
        } else {
            "device.modify"
        };
        blocking(move || {
            auth.require(&actor, permission, &target)?;
            if store.identity()?.instance_epoch != epoch {
                return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
            }
            Ok(())
        })
        .await
    }
    fn gate(&self, session: &Session, accepted: &AcceptedCall) -> HostResult<()> {
        let state = session.snapshot()?;
        if Some(state.session_epoch) != accepted.call.target.session_epoch {
            return Err(HostError::new("EPOCH_MISMATCH", "Session epoch changed"));
        }
        let action = accepted.call.action_id.as_str();
        if state.state != SessionState::Open && action != "session.close" {
            return Err(HostError::new(
                "BACKEND_DISCONNECTED",
                "Session is not open",
            ));
        }
        if state.read_only
            && !matches!(
                action,
                "session.setReadOnly"
                    | "session.close"
                    | "tx.waitBoundary"
                    | "lease.release"
                    | "session.takeover"
            )
        {
            return Err(HostError::new("READ_ONLY", "Session is read only"));
        }
        if matches!(
            action,
            "session.tx"
                | "transfer.paste"
                | "lease.acquire"
                | "session.control"
                | "session.break"
                | "tx.drain"
        ) {
            match state.tx_gate {
                TxGate::Ready => {}
                TxGate::ConfigurationPending => {
                    return Err(HostError::new(
                        "CONFIGURATION_PENDING",
                        "Configuration requires confirmation",
                    ));
                }
                TxGate::ControlUnknown => {
                    return Err(HostError::new(
                        "CONTROL_UNKNOWN",
                        "Control line state is unknown",
                    ));
                }
                _ => return Err(HostError::new("BACKEND_DISCONNECTED", "TX gate is closed")),
            }
        }
        if let Some(revision) = accepted.call.expected_revision
            && revision != state.revision
        {
            return Err(HostError::new(
                "REVISION_CONFLICT",
                "Session revision changed",
            ));
        }
        Ok(())
    }
    async fn require_token(&self, accepted: &AcceptedCall, token: &ControlToken) -> HostResult<()> {
        self.require(accepted).await?;
        if let Some(stamp) = token.grant_stamp.clone() {
            let auth = self.devices.inner.auth.clone();
            blocking(move || auth.validate_grants(&stamp)).await?;
        }
        Ok(())
    }
    async fn dispatch(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
    ) -> HostResult<()> {
        #[cfg(test)]
        {
            let gate = self.dispatch_gap.lock().unwrap().take();
            if let Some((entered, release)) = gate {
                let _ = entered.send(());
                let _ = release.await;
            }
        }
        let _guard = token.dispatch.lock().await;
        if token.cancelled.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        self.require_token(accepted, token).await?;
        self.devices.session(&accepted.call.target)?;
        self.gate(session, accepted)?;
        let store = self.devices.inner.store.clone();
        let id = accepted.operation.operation_id.clone();
        blocking(move || store.mark_dispatch(&id)).await?;
        self.require_token(accepted, token).await?;
        self.check_lease(self.runtime(&accepted.call.target)?.as_ref(), accepted)
    }
    async fn acquire(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Arc<Runtime>,
        bytes: usize,
        queue_wait: QueueWait,
    ) -> HostResult<Turn> {
        let end = queue_wait
            .relative_ms
            .map(|wait| deadline(token.accepted_mono_ns, wait, 2147483647))
            .transpose()?;
        let lease_end = if accepted.call.action_id.as_str() == "lease.acquire" {
            Some(deadline(
                token.accepted_mono_ns,
                decode::<LeaseAcquireParams>(&accepted.call.params)?.ttl_ms,
                30000,
            )?)
        } else {
            None
        };
        runtime
            .queue
            .lock()
            .map_err(|_| invalid())?
            .enqueue(Entry {
                id: accepted.operation.operation_id.clone(),
                actor: accepted.operation.actor_id.clone(),
                lease: accepted.call.lease_id.clone(),
                bytes,
            })?;
        let turn = Turn {
            runtime: runtime.clone(),
            id: accepted.operation.operation_id.clone(),
        };
        loop {
            if lease_end.is_some_and(|end| self.now() >= end) {
                return Err(HostError::new(
                    "LEASE_EXPIRED",
                    "Lease request expired before acquisition",
                ));
            }
            if token.cancelled.load(Ordering::SeqCst) {
                return Err(cancelled());
            }
            if runtime.closing.load(Ordering::SeqCst) {
                return Err(HostError::new("BACKEND_DISCONNECTED", "Session is closing"));
            }
            if let Some(fence) = queue_wait.dispatch_fence {
                fence.check(self.devices.inner.clock.as_ref())?;
            }
            if end.is_some_and(|end| self.now() >= end) {
                return Err(HostError::new("QUEUE_TIMEOUT", "Queue wait expired"));
            }
            self.gate(session, accepted)?;
            self.check_lease(runtime, accepted)?;
            let lease = runtime
                .lease
                .lock()
                .map_err(|_| invalid())?
                .clone()
                .filter(|v| matches!(v.state, LeaseState::Active | LeaseState::Revoking));
            let acquired = {
                let mut queue = runtime.queue.lock().map_err(|_| invalid())?;
                queue.take(&accepted.operation.operation_id, lease.as_ref())
            };
            if acquired {
                return Ok(turn);
            }
            tokio::select! {_=runtime.changed.notified()=>{},_=tokio::time::sleep(Duration::from_millis(2))=>{}}
        }
    }
    async fn submit(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Arc<Runtime>,
        prepared: (Arc<[u8]>, PreparedTxIntent),
    ) -> HostResult<Completion> {
        let params: TxParams = decode(&accepted.call.params)?;
        let (bytes, prepared) = prepared;
        // 意图在持久接纳之后立即进入同一源；最终回执另占序号，RX不等TX完成。
        let intent = session
            .source
            .commit_tx_intent(prepared, accepted.operation.operation_id.clone())?;
        let mut admission = self.backend_admission(accepted, token, runtime);
        let fence = params
            .dispatch_window
            .map(|window| TxDispatchFence::new(window, self.devices.inner.clock.as_ref()))
            .transpose();
        let prepared = match fence {
            Ok(fence) => {
                admission.dispatch_fence = fence;
                self.acquire(
                    accepted,
                    token,
                    session,
                    runtime,
                    bytes.len(),
                    QueueWait {
                        relative_ms: params.queue_wait_ms,
                        dispatch_fence: fence,
                    },
                )
                .await
            }
            Err(error) => Err(error),
        };
        let (settlement, state) = match prepared {
            Err(error) => (
                TxSettlement {
                    outcome: TxOutcome::Rejected,
                    accepted_ranges: vec![],
                    unknown_ranges: vec![],
                    backend_error: Some(error),
                },
                if token.cancelled.load(Ordering::SeqCst) {
                    OperationState::Cancelled
                } else {
                    OperationState::Interrupted
                },
            ),
            Ok(_turn) => match self.dispatch(accepted, token, session).await {
                Err(error) => (
                    TxSettlement {
                        outcome: TxOutcome::Rejected,
                        accepted_ranges: vec![],
                        unknown_ranges: vec![],
                        backend_error: Some(error),
                    },
                    if token.cancelled.load(Ordering::SeqCst) {
                        OperationState::Cancelled
                    } else {
                        OperationState::Interrupted
                    },
                ),
                Ok(()) => {
                    let initial = TxSettlement {
                        outcome: TxOutcome::Unknown,
                        accepted_ranges: vec![],
                        unknown_ranges: if bytes.is_empty() {
                            vec![]
                        } else {
                            vec![ByteRange {
                                start: 0.into(),
                                end: (bytes.len() as u64).into(),
                            }]
                        },
                        backend_error: None,
                    };
                    let evidence = ActionResult::Tx(intent.receipt(&initial)?);
                    let store = self.devices.inner.store.clone();
                    let id = accepted.operation.operation_id.clone();
                    blocking(move || store.record_result_evidence(&id, &evidence)).await?;
                    let result = session
                        .write(
                            intent.write_payload(),
                            Duration::from_millis(params.write_wait_ms.get()),
                            admission,
                        )
                        .await;
                    let settlement = write_settlement(result, bytes.len())?;
                    let state = if settlement.outcome == TxOutcome::Unknown {
                        OperationState::Unknown
                    } else if token.cancelled.load(Ordering::SeqCst)
                        && settlement.outcome != TxOutcome::Accepted
                    {
                        OperationState::Cancelled
                    } else {
                        OperationState::Succeeded
                    };
                    (settlement, state)
                }
            },
        };
        let receipt = intent.receipt(&settlement)?;
        session.record_tx(&receipt, self.devices.inner.clock.mono_ns())?;
        session
            .source
            .complete_tx(&intent, self.devices.meta(session)?, settlement)?;
        Ok(Completion {
            state,
            result: ActionResult::Tx(receipt),
            error: None,
        })
    }
    pub(crate) async fn cancel(
        &self,
        actor: &AuthenticatedActor,
        id: &Id,
    ) -> HostResult<Operation> {
        loop {
            let ready = self.ready.notified();
            let store = self.devices.inner.store.clone();
            let actor_copy = actor.clone();
            let key = id.clone();
            let current = blocking(move || store.get(&actor_copy, &key)).await?;
            if current.state.is_terminal() {
                self.pending_cancels
                    .lock()
                    .map_err(|_| invalid())?
                    .remove(id);
                return Ok(current);
            }
            if current.owner.kind == OwnerKind::Plugin
                || !BuiltinAction::find(current.action_id.as_str())?.is_device_action()
            {
                let store = self.devices.inner.store.clone();
                let actor = actor.clone();
                let id = id.clone();
                return blocking(move || store.request_cancel(&actor, &id)).await;
            }
            let token = {
                let mut pending = self.pending_cancels.lock().map_err(|_| invalid())?;
                let tokens = self.tokens.lock().map_err(|_| invalid())?;
                let token = tokens.get(id).cloned();
                if token.is_none() {
                    if pending.len() >= 256 && !pending.contains(id) {
                        return Err(HostError::new(
                            "HOST_BUSY",
                            "Cancellation signal capacity exhausted",
                        ));
                    }
                    pending.insert(id.clone());
                }
                token
            };
            #[cfg(test)]
            if token.is_none() {
                let gate = self.cancel_gap.lock().unwrap().take();
                if let Some((entered, release)) = gate {
                    let _ = entered.send(());
                    let _ = release.await;
                }
            }
            if let Some(token) = token {
                let done = token.done.notified();
                token.cancel();
                let guard = token.dispatch.lock().await;
                let store = self.devices.inner.store.clone();
                let actor_copy = actor.clone();
                let key = id.clone();
                let current = blocking(move || {
                    let op = store.get(&actor_copy, &key)?;
                    if op.state == OperationState::Running {
                        store.request_cancel(&actor_copy, &key)
                    } else {
                        Ok(op)
                    }
                })
                .await?;
                drop(guard);
                if current.state != OperationState::Queued {
                    return Ok(current);
                }
                tokio::select! {_=done=>{},_=tokio::time::sleep(Duration::from_millis(2))=>{}}
            } else if self.admissions.load(Ordering::SeqCst) == 0 {
                let store = self.devices.inner.store.clone();
                let actor = actor.clone();
                let key = id.clone();
                let latest = blocking(move || store.get(&actor, &key)).await?;
                self.pending_cancels
                    .lock()
                    .map_err(|_| invalid())?
                    .remove(id);
                if latest.state.is_terminal() {
                    return Ok(latest);
                }
                if self.tokens.lock().map_err(|_| invalid())?.contains_key(id) {
                    continue;
                }
                return Err(HostError::new(
                    "OWNER_UNAVAILABLE",
                    "Operation owner is no longer available; query its retained evidence",
                ));
            } else {
                tokio::select! {_=ready=>{},_=tokio::time::sleep(Duration::from_millis(2))=>{}}
            }
        }
    }
    pub(crate) fn request_quiesce(&self, cancel: bool) -> HostResult<()> {
        self.quiescing.store(true, Ordering::SeqCst);
        if cancel {
            self.quiesce_cancel.store(true, Ordering::SeqCst);
            let tokens = self.tokens.lock().map_err(|_| invalid())?;
            for token in tokens.values() {
                if !token.is_stop {
                    token.cancel();
                }
            }
        }
        self.ready.notify_waiters();
        Ok(())
    }
    pub(crate) fn quiesce_pending(&self) -> HostResult<(Vec<Id>, usize)> {
        let tokens = self.tokens.lock().map_err(|_| invalid())?;
        Ok((
            tokens.keys().cloned().collect(),
            self.admissions.load(Ordering::SeqCst),
        ))
    }
    pub async fn queue_status(&self, target: &Target) -> HostResult<QueueStatus> {
        let session = self.devices.session(target)?;
        match session
            .control(ControlCommand::QueueStatus, None)
            .await
            .map_err(|e| *e.error)?
        {
            ControlResult::Queue { pending_bytes } => Ok(QueueStatus {
                pending_bytes,
                observed_at: self.devices.inner.clock.wall_time(),
            }),
            _ => Err(invalid()),
        }
    }
}
fn cancelled() -> HostError {
    HostError::new("CANCELLED", "Operation cancelled before remaining work")
}
fn deadline(now: u64, wait: DurationMs, max: u64) -> HostResult<u64> {
    if wait.get() > max {
        return Err(HostError::new(
            "LIMIT_EXCEEDED",
            "Requested duration exceeds Host limit",
        ));
    }
    now.checked_add(wait.get() * 1_000_000).ok_or_else(invalid)
}
fn write_settlement(
    result: BackendResult<BackendWrite>,
    length: usize,
) -> HostResult<TxSettlement> {
    let (accepted, unknown, error) = match result {
        Ok(v) => (v.accepted_ranges, v.unknown_ranges, v.error),
        Err(v) => {
            let unknown = if v.unknown_ranges.is_empty() {
                complement(&v.accepted_ranges, length)
            } else {
                v.unknown_ranges
            };
            (v.accepted_ranges, unknown, Some(*v.error))
        }
    };
    let accepted_bytes = accepted
        .iter()
        .try_fold(0u64, |sum, r| {
            sum.checked_add(r.end.get().checked_sub(r.start.get())?)
                .filter(|_| r.end.get() <= length as u64)
        })
        .ok_or_else(invalid)?;
    let outcome = if !unknown.is_empty() {
        TxOutcome::Unknown
    } else if accepted_bytes == length as u64 {
        TxOutcome::Accepted
    } else if accepted_bytes == 0 {
        TxOutcome::Rejected
    } else {
        TxOutcome::Partial
    };
    Ok(TxSettlement {
        outcome,
        accepted_ranges: accepted,
        unknown_ranges: unknown,
        backend_error: error,
    })
}
fn complement(accepted: &[ByteRange], length: usize) -> Vec<ByteRange> {
    let mut ranges = accepted.to_vec();
    ranges.sort_by_key(|v| v.start.get());
    let mut start = 0;
    let mut missing = vec![];
    for range in ranges {
        if range.start.get() > start {
            missing.push(ByteRange {
                start: start.into(),
                end: range.start,
            });
        }
        start = start.max(range.end.get());
    }
    if start < (length as u64) {
        missing.push(ByteRange {
            start: start.into(),
            end: (length as u64).into(),
        });
    }
    missing
}
pub(crate) fn normalize(action: BuiltinAction, call: &Call) -> HostResult<JsonObject> {
    fn norm<T: serde::Serialize + serde::de::DeserializeOwned>(
        value: &JsonObject,
    ) -> HostResult<JsonObject> {
        object(&decode::<T>(value)?)
    }
    match action {
        BuiltinAction::TransferFile | BuiltinAction::TransferPaste => {
            if call.execution_mode != Some(ExecutionMode::Independent) || call.lease_id.is_some() {
                return Err(invalid());
            }
            if action == BuiltinAction::TransferPaste {
                let params: PasteTransferParams = decode(&call.params)?;
                file_transfer::validate_paste_params(&params)?;
                object(&params)
            } else {
                let params: FileTransferParams = decode(&call.params)?;
                file_transfer::validate_params(&params)?;
                object(&params)
            }
        }
        BuiltinAction::DeviceOpen => norm::<OpenParams>(&call.params),
        BuiltinAction::ToolHandoff => {
            if call.execution_mode != Some(ExecutionMode::Independent)
                || call.lease_id.is_some()
                || call.expected_revision.is_some()
            {
                return Err(invalid());
            }
            norm::<ToolHandoffParams>(&call.params)
        }
        BuiltinAction::SessionTx => norm::<TxParams>(&call.params),
        BuiltinAction::SessionConfigure => {
            if call.expected_revision.is_none() {
                return Err(invalid());
            }
            norm::<ConfigureParams>(&call.params)
        }
        BuiltinAction::SessionSetReadOnly => {
            if call.expected_revision.is_none() {
                return Err(invalid());
            }
            norm::<SetReadOnlyParams>(&call.params)
        }
        BuiltinAction::SessionControl => norm::<ControlParams>(&call.params),
        BuiltinAction::SessionBreak => norm::<BreakParams>(&call.params),
        BuiltinAction::LeaseAcquire => norm::<LeaseAcquireParams>(&call.params),
        BuiltinAction::LeaseRenew => norm::<LeaseRenewParams>(&call.params),
        BuiltinAction::LeaseRelease => norm::<LeaseReleaseParams>(&call.params),
        BuiltinAction::SessionTakeover => norm::<TakeoverParams>(&call.params),
        BuiltinAction::TxWaitBoundary => norm::<WaitBoundaryParams>(&call.params),
        BuiltinAction::TxDrain => norm::<DrainParams>(&call.params),
        BuiltinAction::SessionPurge => norm::<PurgeParams>(&call.params),
        BuiltinAction::SessionClose => norm::<EmptyParams>(&call.params),
        _ => Err(invalid()),
    }
}
