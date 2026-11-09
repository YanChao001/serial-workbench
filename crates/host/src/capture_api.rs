//! Capture/replay business routing behind the shared Host dispatcher.
use crate::{
    auth::{AuthService, AuthenticatedActor},
    capture::{CaptureRuntime, CaptureService, replay::ReplayService},
    dispatch::AcceptedCall,
    files::FileService,
    storage::{Settlement, Store},
};
use serde::{Serialize, de::DeserializeOwned};
use serial_workbench_core::*;
use tokio::sync::RwLock;

pub(crate) struct CaptureApi {
    captures: CaptureService,
    replays: ReplayService,
    files: FileService,
    auth: AuthService,
    store: Store,
    closing: RwLock<bool>,
}

#[cfg(test)]
pub(crate) fn with_storage_for_test(
    runtime: CaptureRuntime,
    limits: crate::capture::writer::CaptureLimits,
    opener: crate::capture::writer::VolumeOpener,
) -> CaptureApi {
    CaptureApi {
        replays: ReplayService::new(
            runtime.files.clone(),
            runtime.identity.clone(),
            runtime.clock.clone(),
        ),
        files: runtime.files.clone(),
        auth: runtime.auth.clone(),
        store: runtime.store.clone(),
        captures: CaptureService::with_storage(runtime, limits, opener),
        closing: RwLock::new(false),
    }
}
impl CaptureApi {
    pub(crate) fn new(runtime: CaptureRuntime) -> Self {
        let replays = ReplayService::new(
            runtime.files.clone(),
            runtime.identity.clone(),
            runtime.clock.clone(),
        );
        Self {
            replays,
            files: runtime.files.clone(),
            auth: runtime.auth.clone(),
            store: runtime.store.clone(),
            captures: CaptureService::new(runtime),
            closing: RwLock::new(false),
        }
    }
    pub(crate) async fn authorize(
        &self,
        action: BuiltinAction,
        target: &Target,
        params: &JsonObject,
        actor: &AuthenticatedActor,
    ) -> HostResult<()> {
        target.validate()?;
        match action {
            BuiltinAction::CaptureStart => {
                let params: CaptureStartParams = decode(params)?;
                reference_target(target, &params.target_ref)?;
                self.require_file(&params.target_ref, actor, "workspace.modify")
                    .await?;
                self.require_file(&params.target_ref, actor, "metadata.read")
                    .await?;
                let auth = self.auth.clone();
                let actor = actor.clone();
                blocking(move || {
                    for source in params.session_refs {
                        source.validate()?;
                        if source.kind.as_str() != "session" {
                            return Err(invalid());
                        }
                        auth.require(&actor, "content.read", &source)?;
                    }
                    Ok(())
                })
                .await
            }
            BuiltinAction::CaptureStop => {
                let params: CaptureStopParams = decode(params)?;
                reference_target(target, &params.capture_ref)?;
                self.require_file(&params.capture_ref, actor, "workspace.modify")
                    .await?;
                self.require_file(&params.capture_ref, actor, "metadata.read")
                    .await
            }
            BuiltinAction::CaptureStatus | BuiltinAction::CaptureVerify => {
                let params: CaptureVerifyParams = decode(params)?;
                reference_target(target, &params.capture_ref)?;
                self.require_file(
                    &params.capture_ref,
                    actor,
                    if action == BuiltinAction::CaptureStatus {
                        "metadata.read"
                    } else {
                        "content.read"
                    },
                )
                .await
            }
            BuiltinAction::CaptureTail => {
                let params: CaptureTailParams = decode(params)?;
                reference_target(target, &params.capture_ref)?;
                self.require_file(&params.capture_ref, actor, "content.read")
                    .await
            }
            BuiltinAction::CaptureRecover => {
                let params: RecoverPrefixParams = decode(params)?;
                reference_target(target, &params.target_ref)?;
                self.require_file(&params.target_ref, actor, "workspace.modify")
                    .await?;
                let captures = self.captures.clone();
                let actor = actor.clone();
                blocking(move || {
                    captures
                        .recovery_authorization_target(&params, &actor, "content.read")
                        .map(|_| ())
                })
                .await
            }
            BuiltinAction::CaptureExport => {
                let params: TextExportParams = decode(params)?;
                reference_target(target, &params.capture_ref)?;
                self.require_file(&params.capture_ref, actor, "content.read")
                    .await?;
                self.require_file(&params.target_ref, actor, "workspace.modify")
                    .await
            }
            BuiltinAction::ReplayOpen => {
                let params: ReplayOpenParams = decode(params)?;
                reference_target(target, &params.capture_ref)?;
                self.require_file(&params.capture_ref, actor, "content.read")
                    .await
            }
            BuiltinAction::ReplayRead => {
                let params: ReplayReadParams = decode(params)?;
                session_target(target, &params.session_id, params.session_epoch)?;
                self.require_replay(target, actor, "content.read").await
            }
            BuiltinAction::ReplayControl => {
                let params: ReplayControlParams = decode(params)?;
                session_target(target, &params.session_id, params.session_epoch)?;
                self.require_replay(target, actor, "content.read").await
            }
            BuiltinAction::ReplayClose | BuiltinAction::SessionClose => {
                let _: EmptyParams = decode(params)?;
                self.require_replay(target, actor, "content.read").await
            }
            BuiltinAction::SessionGet => {
                let _: EmptyParams = decode(params)?;
                self.require_replay(target, actor, "metadata.read").await
            }
            other if self.owns_replay(&target.id) => {
                self.require_replay(target, actor, "content.read").await?;
                if other.is_device_action() {
                    Err(HostError::new("READ_ONLY", "Replay session is read only"))
                } else {
                    Err(HostError::new(
                        "UNSUPPORTED_CAPABILITY",
                        "Replay data is available through replay.read",
                    ))
                }
            }
            _ => Err(invalid()),
        }
    }
    async fn require_file(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &'static str,
    ) -> HostResult<()> {
        let files = self.files.clone();
        let reference = reference.clone();
        let actor = actor.clone();
        blocking(move || files.require_reference(&reference, &actor, permission)).await
    }
    async fn require_replay(
        &self,
        target: &Target,
        actor: &AuthenticatedActor,
        permission: &'static str,
    ) -> HostResult<()> {
        let replays = self.replays.clone();
        let target = target.clone();
        let actor = actor.clone();
        blocking(move || {
            replays
                .authorization_target(&target, &actor, permission)
                .map(|_| ())
        })
        .await
    }
    pub(crate) async fn query(
        &self,
        action: BuiltinAction,
        query: &Query,
        actor: &AuthenticatedActor,
    ) -> HostResult<QueryResult> {
        self.authorize(action, &query.target, &query.params, actor)
            .await?;
        let auth = self.auth.clone();
        let current = actor.clone();
        let stamp = blocking(move || auth.capture_grants(&current)).await?;
        let result = match action {
            BuiltinAction::CaptureStatus => {
                let params: CaptureVerifyParams = decode(&query.params)?;
                QueryResult::CaptureStatus(self.status(&params.capture_ref, actor).await?)
            }
            BuiltinAction::CaptureTail => {
                QueryResult::CaptureTail(self.captures.tail(decode(&query.params)?, actor).await?)
            }
            BuiltinAction::ReplayRead => {
                QueryResult::ReplayRead(self.replays.read(decode(&query.params)?, actor).await?)
            }
            _ => return Err(invalid()),
        };
        self.authorize(action, &query.target, &query.params, actor)
            .await?;
        if let Some(stamp) = stamp {
            let auth = self.auth.clone();
            blocking(move || auth.validate_grants(&stamp)).await?;
        }
        Ok(result)
    }
    pub(crate) async fn operation_source(
        &self,
        action: BuiltinAction,
        target: &Target,
        params: &JsonObject,
        actor: &AuthenticatedActor,
    ) -> HostResult<Option<Target>> {
        if action == BuiltinAction::CaptureRecover {
            let captures = self.captures.clone();
            let actor = actor.clone();
            let params: RecoverPrefixParams = decode(params)?;
            blocking(move || {
                captures.recovery_authorization_target(&params, &actor, "content.read")
            })
            .await
            .map(Some)
        } else if matches!(
            action,
            BuiltinAction::ReplayControl | BuiltinAction::ReplayClose
        ) || (action == BuiltinAction::SessionClose && self.owns_replay(&target.id))
        {
            let replays = self.replays.clone();
            let actor = actor.clone();
            let target = target.clone();
            blocking(move || replays.authorization_target(&target, &actor, "content.read"))
                .await
                .map(Some)
        } else {
            Ok(None)
        }
    }
    pub(crate) async fn execute(
        &self,
        action: BuiltinAction,
        accepted: &AcceptedCall,
    ) -> HostResult<Settlement> {
        let store = self.store.clone();
        let call = accepted.call.clone();
        blocking(move || {
            let identity = store.identity()?;
            if call.host_id != identity.host_id || call.target.host_id != identity.host_id {
                return Err(HostError::new(
                    "HOST_ID_MISMATCH",
                    "Target belongs to another Host",
                ));
            }
            if call.instance_epoch != identity.instance_epoch {
                return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
            }
            Ok(())
        })
        .await?;
        self.authorize(
            action,
            &accepted.call.target,
            &accepted.call.params,
            &accepted.actor,
        )
        .await?;
        // Recheck the current service parent before dispatch; admission already persisted it.
        if let Some(source) = self
            .operation_source(
                action,
                &accepted.call.target,
                &accepted.call.params,
                &accepted.actor,
            )
            .await?
        {
            let store = self.store.clone();
            let operation_id = accepted.operation.operation_id.clone();
            blocking(move || store.record_operation_source_authority(&operation_id, &source))
                .await?;
        }
        // Serialize publication with shutdown, but release before the long owner wait.
        let publication = if matches!(
            action,
            BuiltinAction::CaptureStart | BuiltinAction::ReplayOpen
        ) {
            let admission = self.closing.read().await;
            if *admission {
                return Err(closing());
            }
            Some(admission)
        } else {
            None
        };
        // Store owns operation admission and cancellation; this API never creates an owner.
        let store = self.store.clone();
        let actor = accepted.actor.clone();
        let operation_id = accepted.operation.operation_id.clone();
        let running = blocking(move || match store.mark_dispatch(&operation_id) {
            Ok(()) => store.get(&actor, &operation_id).map(Some),
            Err(error) => {
                if store.get(&actor, &operation_id)?.state == OperationState::CancelRequested {
                    Ok(None)
                } else {
                    Err(error)
                }
            }
        })
        .await?;
        let Some(owner) = running else {
            return Ok(Settlement {
                state: OperationState::Cancelled,
                result: None,
                error: None,
            });
        };
        let outcome = self.run(action, accepted, &owner, publication).await;
        let store = self.store.clone();
        let actor = accepted.actor.clone();
        let operation_id = owner.operation_id;
        let cancelled = blocking(move || {
            store
                .get(&actor, &operation_id)
                .map(|operation| operation.state == OperationState::CancelRequested)
        })
        .await?;
        Ok(match outcome {
            Ok(result) => Settlement {
                state: if cancelled {
                    OperationState::Cancelled
                } else {
                    OperationState::Succeeded
                },
                result: Some(result),
                error: None,
            },
            Err(error) => Settlement {
                state: OperationState::Failed,
                result: None,
                error: Some(error),
            },
        })
    }
    async fn run(
        &self,
        action: BuiltinAction,
        accepted: &AcceptedCall,
        owner: &Operation,
        publication: Option<tokio::sync::RwLockReadGuard<'_, bool>>,
    ) -> HostResult<ActionResult> {
        let actor = &accepted.actor;
        let call = &accepted.call;
        match action {
            BuiltinAction::CaptureStart => {
                if call.execution_mode != Some(ExecutionMode::Independent) {
                    return Err(invalid());
                }
                let reference = self
                    .captures
                    .start(decode(&call.params)?, owner, actor)
                    .await?;
                drop(publication);
                self.captures.wait(&reference).await?;
                let fixed = self.captures.final_reference(&reference, actor).await?;
                self.status(&fixed, actor)
                    .await
                    .map(ActionResult::CaptureStatus)
            }
            BuiltinAction::CaptureStop => {
                let params: CaptureStopParams = decode(&call.params)?;
                self.captures.stop(&params.capture_ref, actor).await?;
                self.status(&params.capture_ref, actor)
                    .await
                    .map(ActionResult::CaptureStatus)
            }
            BuiltinAction::CaptureVerify => {
                let params: CaptureVerifyParams = decode(&call.params)?;
                self.captures
                    .verify(&params.capture_ref, actor)
                    .await
                    .map(ActionResult::CaptureVerification)
            }
            BuiltinAction::CaptureRecover => self
                .captures
                .recover_prefix(decode(&call.params)?, actor)
                .await
                .map(|result_ref| ActionResult::Reference(ResultReference { result_ref })),
            BuiltinAction::CaptureExport => self
                .captures
                .export_text(decode(&call.params)?, actor)
                .await
                .map(|result_ref| ActionResult::Reference(ResultReference { result_ref })),
            BuiltinAction::ReplayOpen => self
                .replays
                .open(decode(&call.params)?, actor)
                .await
                .map(ActionResult::Opened),
            BuiltinAction::ReplayControl => self
                .replays
                .control(decode(&call.params)?, actor)
                .await
                .map(ActionResult::ReplayPosition),
            BuiltinAction::ReplayClose | BuiltinAction::SessionClose => self
                .replays
                .close(&call.target, actor)
                .await
                .map(ActionResult::Session),
            _ => Err(invalid()),
        }
    }
    async fn status(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<CaptureStatusResult> {
        let summary = self.captures.status(reference, actor).await?;
        let owner_operation_id = self.captures.owner_operation(reference, actor).await?;
        let files = self.files.clone();
        let reference = reference.clone();
        let actor = actor.clone();
        let capture_ref = blocking(move || {
            files
                .metadata(&reference, &actor)
                .map(|metadata| metadata.file_ref)
        })
        .await?;
        Ok(CaptureStatusResult {
            capture_ref,
            owner_operation_id,
            summary,
        })
    }
    pub(crate) fn owns_replay(&self, id: &Id) -> bool {
        self.replays.owns(id)
    }
    pub(crate) fn memory_usage(&self) -> crate::capture::CaptureMemory {
        self.captures.memory_usage()
    }
    pub(crate) async fn snapshot(
        &self,
        target: &Target,
        actor: &AuthenticatedActor,
    ) -> HostResult<SessionSnapshot> {
        self.replays.snapshot(target, actor).await
    }
    pub(crate) async fn shutdown(&self) -> HostResult<()> {
        *self.closing.write().await = true;
        let result = self.captures.shutdown().await;
        let replay = self.replays.shutdown();
        result.and(replay)
    }
}
pub(crate) fn normalize(action: BuiltinAction, call: &Call) -> HostResult<JsonObject> {
    match action {
        BuiltinAction::CaptureStart => {
            if call.execution_mode != Some(ExecutionMode::Independent) {
                return Err(invalid());
            }
            normalized::<CaptureStartParams>(&call.params)
        }
        BuiltinAction::CaptureStop => normalized::<CaptureStopParams>(&call.params),
        BuiltinAction::CaptureVerify => normalized::<CaptureVerifyParams>(&call.params),
        BuiltinAction::CaptureRecover => normalized::<RecoverPrefixParams>(&call.params),
        BuiltinAction::CaptureExport => normalized::<TextExportParams>(&call.params),
        BuiltinAction::ReplayOpen => normalized::<ReplayOpenParams>(&call.params),
        BuiltinAction::ReplayControl => normalized::<ReplayControlParams>(&call.params),
        BuiltinAction::ReplayClose | BuiltinAction::SessionClose => {
            normalized::<EmptyParams>(&call.params)
        }
        _ => Err(invalid()),
    }
}
fn normalized<T: DeserializeOwned + Serialize>(params: &JsonObject) -> HostResult<JsonObject> {
    serde_json::from_value(serde_json::to_value(decode::<T>(params)?).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
fn decode<T: DeserializeOwned>(params: &JsonObject) -> HostResult<T> {
    serde_json::from_value(serde_json::to_value(params).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
fn reference_target(target: &Target, reference: &ObjectRef) -> HostResult<()> {
    if target.host_id != reference.host_id
        || target.kind != reference.kind
        || target.id != reference.id
        || target.session_id.is_some()
        || target.session_epoch.is_some()
    {
        return Err(invalid());
    }
    Ok(())
}
fn session_target(target: &Target, id: &Id, epoch: U64) -> HostResult<()> {
    target.validate()?;
    if target.kind.as_str() != "session"
        || &target.id != id
        || target.session_id.as_ref() != Some(id)
    {
        return Err(invalid());
    }
    if target.session_epoch != Some(epoch) {
        return Err(HostError::new(
            "EPOCH_MISMATCH",
            "Replay session epoch differs",
        ));
    }
    Ok(())
}
fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Capture parameters or target are invalid",
    )
}
fn closing() -> HostError {
    HostError::new("HOST_BUSY", "Host is shutting down")
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> HostResult<T> + Send + 'static,
) -> HostResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| HostError::new("STORAGE_UNAVAILABLE", "Host worker is unavailable"))?
}
