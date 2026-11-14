//! 统一动作接纳与连接适配；持久操作由 Store 持有，执行任务由 Host 持有。
#[path = "operation_inspection.rs"]
mod operation_inspection;
#[path = "shutdown.rs"]
mod shutdown;
use crate::{
    auth::{AuthService, AuthenticatedActor},
    device::{DeviceService, TransportOpener},
    ipc::{ConnectionContext, HandlerFuture, HandlerReply, RequestHandler},
    registry::Registry,
    state::{ProjectionLimits, ProjectionStore, Subscription},
    storage::{Acceptance, Settlement, Store, canonical_digest},
    stream::{RawOutputLease, RawSubscription, StreamHub, StreamLimits},
    transmission::TransmissionService,
};
use serde::{Serialize, de::DeserializeOwned};
use serial_workbench_core::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{Semaphore, oneshot},
    task::JoinHandle,
};

#[derive(Clone)]
pub struct Host {
    inner: Arc<HostInner>,
}
struct HostInner {
    shutdown: shutdown::ShutdownCoordinator,
    startup_config: Option<StartupConfigSnapshot>,
    store: Store,
    auth: AuthService,
    registry: Arc<Registry>,
    documents: Arc<crate::documents::DocumentService>,
    files: crate::files::FileService,
    capture_api: crate::capture_api::CaptureApi,
    client_effects: crate::client_effects::ClientEffects,
    clock: Arc<dyn Clock>,
    projections: ProjectionStore,
    activities: Mutex<VecDeque<Activity>>,
    jobs: Mutex<Jobs>,
    capacity: Arc<Semaphore>,
    stop_capacity: Arc<Semaphore>,
    subscriptions: Mutex<HashMap<Id, Pump>>,
    operation_projection: tokio::sync::Mutex<Option<JsonObject>>,
    operation_projection_task: Mutex<Option<JoinHandle<()>>>,
    devices: DeviceService,
    device_runtime: Option<Arc<crate::device::DeviceRuntime>>,
    streams: StreamHub,
    sessions: TransmissionService,
    stop_requested: tokio::sync::watch::Sender<bool>,
    catalog_watchers: tokio::sync::Mutex<HashMap<Id, oneshot::Sender<()>>>,
    #[cfg(test)]
    admission_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
    #[cfg(test)]
    catalog_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}
struct Jobs {
    closing: bool,
    handles: Vec<OwnedJob>,
}
impl Drop for HostInner {
    fn drop(&mut self) {
        if let Some(task) = self
            .operation_projection_task
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            task.abort();
        }
    }
}
struct OwnedJob {
    handle: JoinHandle<()>,
    operation_id: Arc<Mutex<Option<Id>>>,
}
struct Pump {
    connection_id: Id,
    channel: IpcChannel,
    target: Target,
    stop: oneshot::Sender<()>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    activity_id: Id,
    actor_id: Id,
    request_id: RequestId,
    action_id: Id,
    target: Target,
    reveal_target: RevealTarget,
    observations: U64,
}
pub(crate) struct AcceptedCall {
    pub actor: AuthenticatedActor,
    pub call: Call,
    pub operation: Operation,
}
struct QueryOutput {
    result: QueryResult,
    raw_output_lease: Option<RawOutputLease>,
}
enum DeviceSource {
    Native,
    Provider(Arc<dyn crate::device::DeviceProvider>),
    Opener(TransportOpener),
}
impl Host {
    pub async fn with_device_provider(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
        provider: Arc<dyn crate::device::DeviceProvider>,
    ) -> HostResult<Self> {
        Self::initialize(store, auth, clock, DeviceSource::Provider(provider), None).await
    }
    pub async fn new(store: Store, auth: AuthService) -> HostResult<Self> {
        Self::initialize(
            store,
            auth,
            Arc::new(crate::clock::SystemClock::new()?),
            DeviceSource::Native,
            None,
        )
        .await
    }
    pub async fn with_startup_config(
        store: Store,
        auth: AuthService,
        snapshot: StartupConfigSnapshot,
    ) -> HostResult<Self> {
        Self::initialize(
            store,
            auth,
            Arc::new(crate::clock::SystemClock::new()?),
            DeviceSource::Native,
            Some(snapshot),
        )
        .await
    }
    pub async fn with_runtime(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
        opener: TransportOpener,
    ) -> HostResult<Self> {
        Self::initialize(store, auth, clock, DeviceSource::Opener(opener), None).await
    }
    async fn initialize(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
        source: DeviceSource,
        startup_config: Option<StartupConfigSnapshot>,
    ) -> HostResult<Self> {
        let registry_store = store.clone();
        let registry_auth = auth.clone();
        let registry =
            Arc::new(blocking(move || Registry::new(registry_store, registry_auth)).await?);
        let identity_store = store.clone();
        let identity = blocking(move || identity_store.identity()).await?;
        let streams = StreamHub::new(identity.clone(), auth.clone(), StreamLimits::default());
        let projections =
            ProjectionStore::new(identity.clone(), auth.clone(), ProjectionLimits::default());
        let (device_runtime, opener) = match source {
            DeviceSource::Opener(opener) => (None, opener),
            DeviceSource::Native => {
                let runtime =
                    crate::device::DeviceRuntime::native(identity.clone(), projections.clone())?;
                (Some(runtime.clone()), runtime.opener())
            }
            DeviceSource::Provider(provider) => {
                let runtime = crate::device::DeviceRuntime::new(
                    identity.clone(),
                    provider,
                    projections.clone(),
                )?;
                (Some(runtime.clone()), runtime.opener())
            }
        };
        let documents = Arc::new(crate::documents::DocumentService::new(
            store.clone(),
            auth.clone(),
            projections.clone(),
        ));
        let devices = DeviceService::new(
            store.clone(),
            auth.clone(),
            identity.clone(),
            streams.clone(),
            clock.clone(),
            opener,
            projections.clone(),
        );
        let sessions = TransmissionService::new(devices.clone());
        if let Some(runtime) = &device_runtime {
            let resolver = documents.clone();
            devices.attach_runtime(
                runtime.clone(),
                Arc::new(move |actor, reference| resolver.resolve_device_binding(actor, reference)),
            )?;
        }
        let files = crate::files::FileService::new(store.clone(), auth.clone(), identity.clone());
        let client_effects = crate::client_effects::ClientEffects::new(store.clone(), auth.clone());
        let capture_api = crate::capture_api::CaptureApi::new(crate::capture::CaptureRuntime {
            store: store.clone(),
            auth: auth.clone(),
            identity: identity.clone(),
            files: files.clone(),
            streams: streams.clone(),
            devices: devices.clone(),
            clock: clock.clone(),
        });
        let target = Target {
            host_id: identity.host_id.clone(),
            id: identity.host_id,
            kind: ResourceKind::try_from("host")?,
            session_id: None,
            session_epoch: None,
        };
        for scope in ["host.activity", "host.operations"]
            .into_iter()
            .chain(device_runtime.is_none().then_some("host.devices"))
        {
            projections.register_scope(
                id(scope),
                target.clone(),
                "metadata.read".into(),
                object(serde_json::json!({"items":[]}))?,
            )?;
        }
        let host = Self {
            inner: Arc::new(HostInner {
                shutdown: shutdown::ShutdownCoordinator::default(),
                startup_config,
                documents,
                store,
                auth,
                files,
                capture_api,
                client_effects,
                clock,
                registry,
                projections,
                activities: Mutex::new(VecDeque::new()),
                jobs: Mutex::new(Jobs {
                    closing: false,
                    handles: Vec::new(),
                }),
                capacity: Arc::new(Semaphore::new(crate::limits::NORMAL_OPERATIONS)),
                stop_capacity: Arc::new(Semaphore::new(crate::limits::STOP_OPERATIONS)),
                subscriptions: Mutex::new(HashMap::new()),
                operation_projection: tokio::sync::Mutex::new(None),
                operation_projection_task: Mutex::new(None),
                devices,
                device_runtime,
                streams,
                sessions,
                stop_requested: tokio::sync::watch::channel(false).0,
                catalog_watchers: tokio::sync::Mutex::new(HashMap::new()),
                #[cfg(test)]
                admission_gate: Mutex::new(None),
                #[cfg(test)]
                catalog_gate: Mutex::new(None),
            }),
        };
        host.start_operation_projection()?;
        host.publish_operations().await?;
        Ok(host)
    }
    pub fn projections(&self) -> &ProjectionStore {
        &self.inner.projections
    }
    pub fn devices(&self) -> &DeviceService {
        &self.inner.devices
    }
    pub fn streams(&self) -> &StreamHub {
        &self.inner.streams
    }
    pub fn files(&self) -> &crate::files::FileService {
        &self.inner.files
    }
    pub fn activity_count(&self) -> usize {
        self.inner.activities.lock().expect("activity mutex").len()
    }
    async fn validate(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        kind: ActionKind,
    ) -> HostResult<BuiltinAction> {
        if &query.actor_id != actor.id() {
            return Err(HostError::new(
                "ACTOR_MISMATCH",
                "Actor does not match authentication",
            ));
        }
        query.target.validate()?;
        let replay = query.action_id.as_str() != "action.check"
            && query.target.kind.as_str() == "session"
            && self.inner.capture_api.owns_replay(&query.target.id);
        let store = self.inner.store.clone();
        let auth = self.inner.auth.clone();
        let actor = actor.clone();
        let check_query = query.clone();
        let check_actor = actor.clone();
        let action = blocking(move || {
            let query = check_query;
            let actor = check_actor;
            let identity = store.identity()?;
            if query.host_id != identity.host_id || query.target.host_id != identity.host_id {
                return Err(HostError::new(
                    "HOST_ID_MISMATCH",
                    "Target belongs to another Host",
                ));
            }
            if query.instance_epoch != identity.instance_epoch {
                return Err(HostError::new(
                    "EPOCH_MISMATCH",
                    "Host instance has changed",
                ));
            }
            let action = BuiltinAction::find(query.action_id.as_str())?;
            let spec = action.spec();
            if spec.kind != kind || !spec.target_kinds.contains(&query.target.kind) {
                return Err(invalid());
            }
            if action == BuiltinAction::FileRegister && !actor.is_user_control() {
                return Err(HostError::new(
                    "PERMISSION_DENIED",
                    "File registration requires user control",
                ));
            }
            let mut authorization = None;
            for permission in &spec.permissions {
                // 引用权限由 FileService 解析到保存的原始授权目标，不能套用派生引用 target。
                if (action == BuiltinAction::TransferFile && permission == "content.read")
                    || action.is_capture_api()
                    || replay
                    || matches!(
                        action,
                        BuiltinAction::FileMetadata
                            | BuiltinAction::FileRead
                            | BuiltinAction::TransferReceiptsRead
                            | BuiltinAction::OperationGet
                            | BuiltinAction::OperationInput
                            | BuiltinAction::CatalogList
                    )
                {
                    continue;
                }
                if authorization.is_none() {
                    authorization = Some(auth.snapshot(&actor)?);
                }
                if let Some(authorization) = &authorization {
                    authorization.require(permission, &query.target)?;
                }
            }
            action.validate_query_params(&query)?;
            Ok(action)
        })
        .await?;
        if action.is_capture_api() || replay {
            self.inner
                .capture_api
                .authorize(action, &query.target, &query.params, &actor)
                .await?;
        }
        self.authorize_resource(&actor, query, action).await?;
        Ok(action)
    }
    // Both normal admission and action.check resolve composite authority here.
    // Reading a reference's authority never opens its payload or performs the action.
    async fn authorize_resource(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        action: BuiltinAction,
    ) -> HostResult<()> {
        match action {
            action
                if action.is_document_action()
                    || matches!(
                        action,
                        BuiltinAction::SettingsRead
                            | BuiltinAction::SettingsExport
                            | BuiltinAction::WorkspaceRead
                            | BuiltinAction::WorkspaceExport
                            | BuiltinAction::WorkspaceImportPreview
                    ) =>
            {
                crate::documents::DocumentService::reference(&query.target)?;
            }
            BuiltinAction::DeviceOpen => {
                let params: OpenParams = decode(&query.params)?;
                if let Some(reference) = params.binding {
                    let documents = self.inner.documents.clone();
                    let actor = actor.clone();
                    blocking(move || {
                        documents
                            .resolve_device_binding(&actor, &reference)
                            .map(|_| ())
                    })
                    .await?;
                }
            }
            BuiltinAction::OperationCancel => {
                self.authorize_cancellation(actor, &query.target, decode(&query.params)?)
                    .await?;
            }
            BuiltinAction::OperationGet => {
                self.inspect_operation(actor, &query.target, decode(&query.params)?, false)
                    .await?;
            }
            BuiltinAction::OperationInput => {
                let params: OperationInputParams = decode(&query.params)?;
                self.inspect_operation(
                    actor,
                    &query.target,
                    OperationGetParams::ById {
                        operation_id: params.operation_id,
                        request_context: None,
                    },
                    true,
                )
                .await?;
            }
            BuiltinAction::FileMetadata
            | BuiltinAction::FileRead
            | BuiltinAction::TransferReceiptsRead
            | BuiltinAction::TransferFile => {
                let files = self.inner.files.clone();
                let actor = actor.clone();
                let query = query.clone();
                blocking(move || match action {
                    BuiltinAction::FileMetadata => {
                        let params: FileMetadataParams = decode(&query.params)?;
                        require_reference_target(&query.target, &params.file_ref)?;
                        files.require_reference(&params.file_ref, &actor, "metadata.read")
                    }
                    BuiltinAction::FileRead => {
                        let params: FileReadParams = decode(&query.params)?;
                        require_reference_target(&query.target, &params.file_ref)?;
                        files.require_reference(&params.file_ref, &actor, "content.read")
                    }
                    BuiltinAction::TransferReceiptsRead => {
                        let params: FileTransferReceiptsParams = decode(&query.params)?;
                        require_reference_target(&query.target, &params.receipts_ref)?;
                        files.authorize_receipts(&params.receipts_ref, &actor)
                    }
                    BuiltinAction::TransferFile => {
                        let params: FileTransferParams = decode(&query.params)?;
                        files.require_reference(&params.source_ref, &actor, "content.read")
                    }
                    _ => Err(invalid()),
                })
                .await?;
            }
            _ => {}
        }
        Ok(())
    }
    fn activity(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        action: BuiltinAction,
    ) -> HostResult<()> {
        let mut activities = self.inner.activities.lock().map_err(|_| busy())?;
        if let Some(existing) = activities
            .iter_mut()
            .find(|entry| entry.actor_id == *actor.id() && entry.request_id == query.request_id)
        {
            if existing.action_id != query.action_id || existing.target != query.target {
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Query identity already refers to another activity",
                ));
            }
            existing.observations = existing.observations.checked_next()?;
        } else {
            if activities.len() == 1024 {
                activities.pop_front();
            }
            activities.push_back(Activity {
                activity_id: new_id(),
                actor_id: actor.id().clone(),
                request_id: query.request_id.clone(),
                action_id: query.action_id.clone(),
                target: query.target.clone(),
                reveal_target: action_reveal(action, &query.target),
                observations: 1.into(),
            });
        }
        // 这里只发布活动元数据，params、正文、令牌及错误详情不进入共享投影。
        let state = object(serde_json::json!({"items":&*activities}))?;
        self.inner.projections.commit(
            &id("host.activity"),
            id("activity.changed"),
            state.clone(),
            state,
        )?;
        Ok(())
    }
    pub async fn check_action(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: ActionCheckParams,
    ) -> HostResult<ActionCheckResult> {
        let action = BuiltinAction::find(params.action_id.as_str())?;
        if action == BuiltinAction::ActionCheck {
            return Err(invalid());
        }
        target.validate()?;
        let spec = action.spec();
        if !spec.target_kinds.contains(&target.kind) {
            return Err(invalid());
        }
        // Connection-owned state has additional ownership gates.
        // They need a reusable read-only gate before they can advertise permission here.
        if matches!(
            action,
            BuiltinAction::Client(_)
                | BuiltinAction::StateSnapshot
                | BuiltinAction::StateSubscribe
                | BuiltinAction::SubscriptionClose
                | BuiltinAction::StreamCredit
        ) {
            return Err(HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "This action has no read-only permission check",
            ));
        }
        let auth = self.inner.auth.clone();
        let store = self.inner.store.clone();
        let reader = actor.clone();
        let (identity, stamp) =
            blocking(move || Ok((store.identity()?, auth.capture_grants(&reader)?))).await?;
        let query = Query {
            protocol_version: ProtocolVersion::V0_1,
            host_id: identity.host_id.clone(),
            instance_epoch: identity.instance_epoch,
            actor_id: actor.id().clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
            action_id: params.action_id.clone(),
            target: target.clone(),
            params: params.params,
            reveal_target: spec.reveal_target.clone(),
        };
        let authorization = self.validate(actor, &query, spec.kind).await;
        let auth = self.inner.auth.clone();
        let store = self.inner.store.clone();
        blocking(move || {
            if store.identity()?.instance_epoch != identity.instance_epoch {
                return Err(HostError::new(
                    "EPOCH_MISMATCH",
                    "Host instance has changed",
                ));
            }
            if let Some(stamp) = stamp {
                auth.validate_grants(&stamp)?;
            }
            Ok(())
        })
        .await?;
        let allowed = match authorization {
            Ok(_) => true,
            Err(error) if error.code == "PERMISSION_DENIED" => false,
            Err(error) => return Err(error),
        };
        Ok(ActionCheckResult {
            action_id: params.action_id,
            target: target.clone(),
            allowed,
        })
    }
    pub async fn query(&self, actor: &AuthenticatedActor, query: Query) -> HostResult<QueryResult> {
        self.query_connected(actor, query, None)
            .await
            .map(|output| output.result)
    }
    async fn query_connected(
        &self,
        actor: &AuthenticatedActor,
        query: Query,
        connection: Option<ConnectionContext>,
    ) -> HostResult<QueryOutput> {
        let action = self.validate(actor, &query, ActionKind::Query).await?;
        if !matches!(
            action,
            BuiltinAction::ActionCheck
                | BuiltinAction::WorkspaceImportPreview
                | BuiltinAction::SessionMetrics
                | BuiltinAction::SessionInputs
                | BuiltinAction::HostMetrics
                | BuiltinAction::OperationGet
                | BuiltinAction::StateScopes
                | BuiltinAction::StateSnapshot
                | BuiltinAction::StateSubscribe
                | BuiltinAction::SubscriptionClose
                | BuiltinAction::StreamCursor
                | BuiltinAction::StreamRead
                | BuiltinAction::StreamSubscribe
                | BuiltinAction::StreamCredit
        ) {
            // 传输、投影和任务轮询不再观测自身；否则一次更新会放大为整份活动历史。
            // 显式查询仍保留活动，但序列化/投影提交不能阻塞异步 I/O 调度线程。
            let host = self.clone();
            let observer = actor.clone();
            let observed = query.clone();
            blocking(move || host.activity(&observer, &observed, action)).await?;
        }
        let result = match action {
            BuiltinAction::ActionCheck => self
                .check_action(actor, &query.target, decode(&query.params)?)
                .await
                .map(QueryResult::ActionCheck),
            BuiltinAction::WorkspaceImportPreview => {
                let documents = self.inner.documents.clone();
                let actor = actor.clone();
                blocking(move || {
                    documents
                        .preview_workspace_import(&actor, &query.target, decode(&query.params)?)
                        .map(QueryResult::WorkspaceImportPreview)
                })
                .await
            }
            BuiltinAction::StartupConfigGet => {
                let _: EmptyParams = decode(&query.params)?;
                self.inner
                    .startup_config
                    .clone()
                    .map(QueryResult::StartupConfig)
                    .ok_or_else(|| {
                        HostError::new(
                            "STARTUP_CONFIG_UNAVAILABLE",
                            "This Host has no injected process configuration",
                        )
                    })
            }
            BuiltinAction::OperationInput => {
                let params: OperationInputParams = decode(&query.params)?;
                let (_, input) = self
                    .inspect_operation(
                        actor,
                        &query.target,
                        OperationGetParams::ById {
                            operation_id: params.operation_id,
                            request_context: None,
                        },
                        true,
                    )
                    .await?;
                Ok(QueryResult::OperationInput(input))
            }
            BuiltinAction::ClientList => {
                let _: EmptyParams = decode(&query.params)?;
                let clients = self.inner.client_effects.clone();
                let actor = actor.clone();
                blocking(move || clients.list(&actor).map(QueryResult::Clients)).await
            }
            BuiltinAction::Client(capability) => {
                let effect = ClientEffectAction::from_params(capability, &query.params)?;
                let clients = self.inner.client_effects.clone();
                let actor = actor.clone();
                let (dispatch, waiter) = blocking(move || {
                    clients.reserve(&actor, &query.target, query.request_id, None, effect)
                })
                .await?;
                self.send_client_effect(dispatch).await?;
                match waiter.wait().await? {
                    ClientEffectOutcome::Succeeded { result } => {
                        Ok(QueryResult::ClientEffect(result))
                    }
                    ClientEffectOutcome::Failed { error } => Err(error),
                }
            }
            BuiltinAction::HostMetrics => {
                let _: HostMetricsParams = decode(&query.params)?;
                let store = self.inner.store.clone();
                let stream = self.inner.streams.memory_usage();
                let capture = self.inner.capture_api.memory_usage();
                let clock = self.inner.clock.clone();
                blocking(move || {
                    crate::metrics::snapshot(&store.identity()?, stream, capture, clock.as_ref())
                        .map(QueryResult::HostMetrics)
                })
                .await
            }
            action if action.is_capture_api() => {
                if matches!(
                    action,
                    BuiltinAction::ReplayRead | BuiltinAction::CaptureTail
                ) && connection.is_none()
                {
                    return Err(HostError::new(
                        "CLIENT_REQUIRED",
                        "Capture content requires a raw connection",
                    ));
                }
                self.inner.capture_api.query(action, &query, actor).await
            }
            BuiltinAction::DeviceRefresh => {
                let _: EmptyParams = decode(&query.params)?;
                self.inner.devices.refresh().await.map(QueryResult::Devices)
            }
            BuiltinAction::RecentList => {
                let _: EmptyParams = decode(&query.params)?;
                let devices = self.inner.devices.clone();
                blocking(move || devices.recent().map(QueryResult::Recent)).await
            }
            BuiltinAction::FileMetadata
            | BuiltinAction::FileRead
            | BuiltinAction::TransferReceiptsRead => {
                if action != BuiltinAction::FileMetadata && connection.is_none() {
                    return Err(HostError::new(
                        "CLIENT_REQUIRED",
                        "Raw file query requires a connection",
                    ));
                }
                let files = self.inner.files.clone();
                let auth = self.inner.auth.clone();
                let actor = actor.clone();
                blocking(move || {
                    let stamp = auth.capture_grants(&actor)?;
                    let result = match action {
                        BuiltinAction::FileMetadata => {
                            let params: FileMetadataParams = decode(&query.params)?;
                            require_reference_target(&query.target, &params.file_ref)?;
                            files.require_reference(&params.file_ref, &actor, "metadata.read")?;
                            let metadata = files.metadata(&params.file_ref, &actor)?;
                            files.require_reference(&params.file_ref, &actor, "metadata.read")?;
                            QueryResult::FileMetadata(metadata)
                        }
                        BuiltinAction::FileRead => {
                            let params: FileReadParams = decode(&query.params)?;
                            require_reference_target(&query.target, &params.file_ref)?;
                            let reference = params.file_ref.clone();
                            files.require_reference(&reference, &actor, "content.read")?;
                            let read = files.read(params, &actor)?;
                            files.require_reference(&reference, &actor, "content.read")?;
                            QueryResult::FileRead(read)
                        }
                        BuiltinAction::TransferReceiptsRead => {
                            let params: FileTransferReceiptsParams = decode(&query.params)?;
                            require_reference_target(&query.target, &params.receipts_ref)?;
                            let reference = params.receipts_ref.clone();
                            files.authorize_receipts(&reference, &actor)?;
                            let page = files.read_receipts(params, &actor)?;
                            files.authorize_receipts(&reference, &actor)?;
                            QueryResult::FileTransferReceipts(page)
                        }
                        _ => return Err(invalid()),
                    };
                    if let Some(stamp) = stamp {
                        auth.validate_grants(&stamp)?;
                    }
                    Ok(result)
                })
                .await
            }
            BuiltinAction::StreamCursor => {
                let _: EmptyParams = decode(&query.params)?;
                let _context = connection.ok_or_else(|| {
                    HostError::new("CLIENT_REQUIRED", "Raw cursor requires a connection")
                })?;
                let streams = self.inner.streams.clone();
                let auth = self.inner.auth.clone();
                let actor = actor.clone();
                let target = query.target;
                blocking(move || {
                    let stamp = {
                        let authorization = auth.snapshot(&actor)?;
                        authorization.require("content.read", &target)?;
                        authorization.capture_grants()
                    };
                    let cursor = streams.current_cursor(&target)?;
                    let authorization = auth.snapshot(&actor)?;
                    if let Some(stamp) = &stamp {
                        authorization.validate_grants(stamp)?;
                    }
                    authorization.require("content.read", &target)?;
                    Ok(QueryResult::StreamCursor(StreamCursorResult {
                        target,
                        cursor,
                    }))
                })
                .await
            }
            BuiltinAction::StateScopes => {
                let _: EmptyParams = decode(&query.params)?;
                if query.target.id != query.host_id {
                    return Err(invalid());
                }
                Ok(QueryResult::Scopes(
                    self.inner.projections.list_scopes(actor).await?,
                ))
            }
            BuiltinAction::SettingsRead
            | BuiltinAction::SettingsExport
            | BuiltinAction::WorkspaceList
            | BuiltinAction::WorkspaceRead
            | BuiltinAction::WorkspaceExport => {
                let documents = self.inner.documents.clone();
                let actor = actor.clone();
                blocking(move || documents.query(&actor, &query, action)).await
            }
            BuiltinAction::StreamRead => {
                let _context = connection.ok_or_else(|| {
                    HostError::new(
                        "CLIENT_REQUIRED",
                        "Raw reads require a connection that retains the output budget",
                    )
                })?;
                let params: StreamReadParams = decode(&query.params)?;
                let (result, lease) = self
                    .inner
                    .streams
                    .read_prepared(actor, params)
                    .await?
                    .into_parts();
                return Ok(QueryOutput {
                    result: QueryResult::StreamRead(result),
                    raw_output_lease: Some(lease),
                });
            }
            BuiltinAction::StreamSubscribe => {
                let params: StreamSubscribeParams = decode(&query.params)?;
                let context = connection.ok_or_else(|| {
                    HostError::new("CLIENT_REQUIRED", "Raw subscription requires a connection")
                })?;
                let subscription = self.inner.streams.subscribe(actor, params).await?;
                if subscription.target() != &query.target {
                    subscription.close();
                    return Err(invalid());
                }
                let subscription_id = subscription.id().clone();
                self.start_raw_pump(context, query.request_id, subscription)?;
                Ok(QueryResult::StreamSubscribe(StreamSubscribeResult {
                    subscription_id,
                }))
            }
            BuiltinAction::StreamCredit => {
                let params: StreamCreditParams = decode(&query.params)?;
                let context = connection.ok_or_else(|| {
                    HostError::new("CLIENT_REQUIRED", "Raw credit requires its connection")
                })?;
                {
                    let pumps = self.inner.subscriptions.lock().map_err(|_| busy())?;
                    let pump = pumps
                        .get(&params.subscription_id)
                        .ok_or_else(|| HostError::new("NOT_FOUND", "Subscription is not active"))?;
                    if pump.connection_id != context.connection_id
                        || pump.channel != context.channel
                        || pump.target != query.target
                    {
                        return Err(HostError::new(
                            "PERMISSION_DENIED",
                            "Subscription belongs to another connection or target",
                        ));
                    }
                }
                Ok(QueryResult::StreamCredit(
                    self.inner.streams.credit(actor, params).await?,
                ))
            }
            BuiltinAction::DeviceList => {
                let _: EmptyParams = decode(&query.params)?;
                if let Some(runtime) = &self.inner.device_runtime {
                    return Ok(QueryOutput {
                        result: QueryResult::Devices(runtime.list()?),
                        raw_output_lease: None,
                    });
                }
                Ok(QueryResult::Devices(DeviceList {
                    devices: vec![DeviceDescriptor {
                        device_id: id("virtual:echo"),
                        host_id: query.target.host_id.clone(),
                        system_name: "virtual:echo".into(),
                        description: Some("Virtual echo".into()),
                        manufacturer: None,
                        driver: None,
                        fingerprint: DeviceFingerprint {
                            transport: DeviceTransportKind::Virtual,
                            vid: None,
                            pid: None,
                            serial_number: None,
                            topology_path: None,
                            evidence: IdentityEvidence::Unreliable,
                        },
                        capabilities: TransportCapabilities {
                            semantics: TransportSemantics::Stream,
                            configuration: true,
                            dtr: true,
                            rts: true,
                            finite_break: true,
                            queue_status: true,
                            drain: true,
                            purge_rx: true,
                            purge_tx: true,
                        },
                    }],
                    stale: false,
                }))
            }
            BuiltinAction::SessionGet => {
                let _: EmptyParams = decode(&query.params)?;
                if self.inner.capture_api.owns_replay(&query.target.id) {
                    return Ok(QueryOutput {
                        result: QueryResult::Session(
                            self.inner
                                .capture_api
                                .snapshot(&query.target, actor)
                                .await?,
                        ),
                        raw_output_lease: None,
                    });
                }
                Ok(QueryResult::Session(
                    self.inner.devices.snapshot(&query.target).await?,
                ))
            }
            BuiltinAction::TxQueueStatus => {
                let _: EmptyParams = decode(&query.params)?;
                Ok(QueryResult::Queue(
                    self.inner.sessions.queue_status(&query.target).await?,
                ))
            }
            BuiltinAction::SessionMetrics => {
                let _: EmptyParams = decode(&query.params)?;
                self.inner
                    .devices
                    .metrics(&query.target)
                    .map(QueryResult::SessionMetrics)
            }
            BuiltinAction::SessionInputs => {
                let _: EmptyParams = decode(&query.params)?;
                self.inner
                    .devices
                    .inputs(&query.target)
                    .await
                    .map(QueryResult::SessionInputs)
            }
            BuiltinAction::CatalogList => {
                let params = decode(&query.params)?;
                if let Some(context) = connection {
                    self.ensure_catalog_watch(context).await?;
                }
                let registry = self.inner.registry.clone();
                let actor = actor.clone();
                Ok(QueryResult::Catalog(
                    blocking(move || registry.list(&actor, params)).await?,
                ))
            }
            BuiltinAction::OperationGet => {
                let selector: OperationGetParams = decode(&query.params)?;
                let (operation, _) = self
                    .inspect_operation(actor, &query.target, selector, false)
                    .await?;
                Ok(QueryResult::Operation(Box::new(OperationResult {
                    operation,
                })))
            }
            BuiltinAction::StateSnapshot => {
                let params: StateSnapshotParams = decode(&query.params)?;
                Ok(QueryResult::Snapshot(
                    self.inner
                        .projections
                        .snapshot_for(actor, &params.scope_id, &query.target)
                        .await?,
                ))
            }
            BuiltinAction::StateSubscribe => {
                let params: StateSubscribeParams = decode(&query.params)?;
                let context = connection.ok_or_else(|| {
                    HostError::new(
                        "CLIENT_REQUIRED",
                        "State subscription requires a connection",
                    )
                })?;
                let subscription = self
                    .inner
                    .projections
                    .subscribe_for(actor, &params.scope_id, &params.after, &query.target)
                    .await?;
                let subscription_id = subscription.id().clone();
                self.start_pump(context, query.request_id, subscription)?;
                Ok(QueryResult::Subscription(SubscriptionResult {
                    subscription_id,
                }))
            }
            BuiltinAction::SubscriptionClose => {
                let params: SubscriptionCloseParams = decode(&query.params)?;
                let context = connection.ok_or_else(|| {
                    HostError::new(
                        "CLIENT_REQUIRED",
                        "Closing a subscription requires its connection",
                    )
                })?;
                let mut pumps = self.inner.subscriptions.lock().map_err(|_| busy())?;
                if let Some(pump) = pumps.get(&params.subscription_id)
                    && (pump.connection_id != context.connection_id
                        || pump.channel != context.channel
                        || pump.target != query.target)
                {
                    return Err(HostError::new(
                        "PERMISSION_DENIED",
                        "Subscription belongs to another connection",
                    ));
                }
                if let Some(pump) = pumps.remove(&params.subscription_id) {
                    context.close_subscription(&params.subscription_id);
                    let _ = pump.stop.send(());
                }
                Ok(QueryResult::Closed(ClosedResult { closed: True }))
            }
            _ => Err(invalid()),
        };
        result.map(|result| QueryOutput {
            result,
            raw_output_lease: None,
        })
    }
    fn start_pump(
        &self,
        context: ConnectionContext,
        request_id: RequestId,
        mut subscription: Subscription,
    ) -> HostResult<()> {
        let subscription_id = subscription.id().clone();
        context.register_subscription(subscription_id.clone())?;
        let (stop, mut stopped) = oneshot::channel();
        self.inner.subscriptions.lock().map_err(|_| busy())?.insert(
            subscription_id.clone(),
            Pump {
                connection_id: context.connection_id.clone(),
                channel: context.channel,
                target: subscription.target().clone(),
                stop,
            },
        );
        let host = self.clone();
        tokio::spawn(async move {
            loop {
                if context.is_closed() {
                    break;
                }
                let next = tokio::select! { _=&mut stopped=>break, _=context.closed()=>break, next=subscription.next()=>next };
                match next {
                    Ok(Some(delta)) => {
                        let frame = WireFrame {
                            request_id: request_id.clone(),
                            channel: IpcChannel::State,
                            body: IpcMessage::Delta {
                                subscription_id: subscription_id.clone(),
                                delta: Box::new(delta),
                            },
                        };
                        if let Err(error) = context.emit_with_stamp(
                            frame,
                            subscription.permission(),
                            subscription.target().clone(),
                            subscription.grant_stamp(),
                            Some(subscription.delivery_liveness()),
                        ) {
                            context.end_subscription(
                                request_id.clone(),
                                &subscription_id,
                                &error.code,
                            );
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        context.end_subscription(request_id.clone(), &subscription_id, &error.code);
                        break;
                    }
                }
            }
            subscription.close();
            context.close_subscription(&subscription_id);
            if let Ok(mut pumps) = host.inner.subscriptions.lock() {
                pumps.remove(&subscription_id);
            }
        });
        Ok(())
    }
    fn start_raw_pump(
        &self,
        context: ConnectionContext,
        request_id: RequestId,
        subscription: RawSubscription,
    ) -> HostResult<()> {
        let subscription_id = subscription.id().clone();
        if context.is_closed() {
            subscription.close();
            return Err(HostError::new("CLIENT_CLOSED", "Connection is closed"));
        }
        if let Err(error) = context.register_subscription(subscription_id.clone()) {
            subscription.close();
            return Err(error);
        }
        let (stop, mut stopped) = oneshot::channel();
        self.inner.subscriptions.lock().map_err(|_| busy())?.insert(
            subscription_id.clone(),
            Pump {
                connection_id: context.connection_id.clone(),
                channel: context.channel,
                target: subscription.target().clone(),
                stop,
            },
        );
        let host = self.clone();
        tokio::spawn(async move {
            loop {
                if context.is_closed() {
                    break;
                }
                let next = tokio::select! {_=&mut stopped=>break,_=context.closed()=>break,next=subscription.next()=>next};
                match next {
                    Ok(Some(batch)) => {
                        if let Err(error) = subscription.deliver(&context, &batch) {
                            context.end_subscription(
                                request_id.clone(),
                                &subscription_id,
                                &error.code,
                            );
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        context.end_subscription(request_id.clone(), &subscription_id, &error.code);
                        break;
                    }
                }
            }
            subscription.close();
            context.close_subscription(&subscription_id);
            if let Ok(mut pumps) = host.inner.subscriptions.lock() {
                pumps.remove(&subscription_id);
            }
        });
        Ok(())
    }
    async fn catalog_visibility(
        &self,
        actor: &AuthenticatedActor,
    ) -> HostResult<crate::registry::CatalogVisibility> {
        #[cfg(test)]
        {
            let gate = self
                .inner
                .catalog_gate
                .lock()
                .map_err(|_| invalid())?
                .take();
            if let Some((entered, wait)) = gate {
                let _ = entered.send(());
                let _ = wait.await;
            }
        }
        for attempt in 0..3 {
            let registry = self.inner.registry.clone();
            let actor = actor.clone();
            match blocking(move || registry.visibility(&actor)).await {
                Err(error) if error.code == "CATALOG_CHANGED" && attempt < 2 => continue,
                result => return result,
            }
        }
        unreachable!("the final catalog attempt returns its result")
    }
    async fn ensure_catalog_watch(&self, context: ConnectionContext) -> HostResult<()> {
        if context.channel != IpcChannel::Control || context.is_closed() {
            return Err(HostError::new(
                "CLIENT_CLOSED",
                "Catalog requires a live control connection",
            ));
        }
        if self
            .inner
            .catalog_watchers
            .lock()
            .await
            .contains_key(&context.connection_id)
        {
            return Ok(());
        }
        let mut changes = self.inner.auth.subscribe_changes();
        changes.borrow_and_update();
        let mut current = tokio::select! {
            _ = context.closed() => return Err(HostError::new("CLIENT_CLOSED", "Connection is closed")),
            result = self.catalog_visibility(&context.actor) => result?,
        };
        if context.is_closed() {
            return Err(HostError::new("CLIENT_CLOSED", "Connection is closed"));
        }
        let (stop, mut stopped) = oneshot::channel();
        // 目录计算会访问存储，期间不持有跨客户端的登记表锁。
        let mut watchers = self.inner.catalog_watchers.lock().await;
        if context.is_closed() {
            return Err(HostError::new("CLIENT_CLOSED", "Connection is closed"));
        }
        // 关闭先设置 closing 再清登记表，锁内复核避免初始化晚到重新登记。
        if self.inner.jobs.lock().map_err(|_| busy())?.closing {
            return Err(busy());
        }
        if watchers.contains_key(&context.connection_id) {
            return Ok(());
        }
        watchers.insert(context.connection_id.clone(), stop);
        drop(watchers);
        let host = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = context.closed() => break,
                    result = changes.changed() => if result.is_err() { break; },
                    _ = host.inner.auth.wait_grant_expiry(current.stamp.as_ref()) => {},
                }
                let next = match tokio::select! {
                    _ = &mut stopped => break,
                    _ = context.closed() => break,
                    result = host.catalog_visibility(&context.actor) => result,
                } {
                    Ok(next) => next,
                    Err(error) if error.code == "CATALOG_CHANGED" => continue,
                    Err(_) => break,
                };
                if (next.version != current.version || next.token != current.token)
                    && context
                        .emit_catalog_changed(next.version, next.token.clone())
                        .is_err()
                {
                    break;
                }
                current = next;
            }
            host.inner
                .catalog_watchers
                .lock()
                .await
                .remove(&context.connection_id);
        });
        Ok(())
    }
    pub async fn invoke(
        &self,
        actor: &AuthenticatedActor,
        mut call: Call,
    ) -> HostResult<Operation> {
        let query = call_query(&call);
        let action = self.validate(actor, &query, ActionKind::Action).await?;
        let replay_session = call.target.kind.as_str() == "session"
            && self.inner.capture_api.owns_replay(&call.target.id);
        let device_action = action.is_device_action() && !replay_session;
        call.params = match action {
            BuiltinAction::Client(capability) => {
                ClientEffectAction::from_params(capability, &call.params)?;
                call.params.clone()
            }
            action
                if action.is_capture_api()
                    || (replay_session && action == BuiltinAction::SessionClose) =>
            {
                crate::capture_api::normalize(action, &call)?
            }
            action if action.is_document_action() => crate::documents::normalize(action, &call)?,
            BuiltinAction::HostShutdown => normalize::<EmptyParams>(&call.params)?,
            BuiltinAction::FileRegister => normalize::<RegisterFileParams>(&call.params)?,
            BuiltinAction::Authorize => normalize::<AuthorizeParams>(&call.params)?,
            BuiltinAction::Revoke => normalize::<RevokeParams>(&call.params)?,
            BuiltinAction::OperationCancel => normalize::<OperationCancelParams>(&call.params)?,
            action if action.is_device_action() => crate::transmission::normalize(action, &call)?,
            _ => return Err(invalid()),
        };
        call.reveal_target = action_reveal(action, &call.target);
        let lookup_store = self.inner.store.clone();
        let lookup_actor = actor.clone();
        let lookup_call = call.clone();
        let lookup_files = self.inner.files.clone();
        if let Some(existing) = blocking(move || {
            let existing = lookup_store.lookup_call(
                &lookup_actor,
                &lookup_call,
                &canonical_digest(&lookup_call)?,
            )?;
            if let Some(operation) = &existing {
                authorize_transfer_result(&lookup_files, &lookup_actor, operation)?;
            }
            Ok(existing)
        })
        .await?
        {
            return Ok(existing);
        }
        if action == BuiltinAction::TransferFile {
            let files = self.inner.files.clone();
            let actor = actor.clone();
            let params: FileTransferParams = decode(&call.params)?;
            blocking(move || {
                let source = files.open_fixed(&params.source_ref, &actor)?;
                if params
                    .offset
                    .get()
                    .checked_add(params.length.get())
                    .is_none_or(|end| end > source.len())
                {
                    return Err(invalid());
                }
                Ok(())
            })
            .await?;
        }
        let client_preparation = if let BuiltinAction::Client(capability) = action {
            let effect = ClientEffectAction::from_params(capability, &call.params)?;
            let clients = self.inner.client_effects.clone();
            let actor = actor.clone();
            let target = call.target.clone();
            let request_id = call.request_id.clone();
            Some(blocking(move || clients.prepare(&actor, &target, request_id, effect)).await?)
        } else {
            None
        };
        let operation_source = self
            .inner
            .capture_api
            .operation_source(action, &call.target, &call.params, actor)
            .await?;
        let capacity = if crate::limits::is_stop(call.action_id.as_str()) {
            &self.inner.stop_capacity
        } else {
            &self.inner.capacity
        };
        let permit = capacity.clone().try_acquire_owned().map_err(|_| busy())?;
        let (send, receive) = oneshot::channel();
        let host = self.clone();
        let actor = actor.clone();
        let admission = device_action
            .then(|| {
                self.inner
                    .sessions
                    .admission(crate::limits::is_stop(call.action_id.as_str()))
            })
            .transpose()?;
        let preparation = if device_action {
            Some(self.inner.sessions.prepare(&call)?)
        } else {
            None
        };
        {
            let mut jobs = self.inner.jobs.lock().map_err(|_| busy())?;
            if jobs.closing && !crate::limits::is_stop(call.action_id.as_str()) {
                return Err(busy());
            }
            if !jobs.closing {
                jobs.handles.retain(|job| !job.handle.is_finished());
            }
            let operation_id = Arc::new(Mutex::new(None));
            let accepted_slot = operation_id.clone();
            let handle = tokio::spawn(async move {
                let mut admission = admission;
                #[cfg(test)]
                {
                    let gate = host.inner.admission_gate.lock().expect("test gate").take();
                    if let Some((entered, release)) = gate {
                        let _ = entered.send(());
                        let _ = release.await;
                    }
                }
                let _permit = permit;
                let store = host.inner.store.clone();
                let accept_actor = actor.clone();
                let accept_call = call.clone();
                let accept_auth = host.inner.auth.clone();
                let accept_files = host.inner.files.clone();
                let acceptance = blocking(move || {
                    let stamp = accept_auth.capture_grants(&accept_actor)?;
                    let acceptance = store.accept_with_source(
                        &accept_actor,
                        &accept_call,
                        &canonical_digest(&accept_call)?,
                        operation_source.as_ref(),
                    )?;
                    let operation = match &acceptance {
                        Acceptance::New(operation) | Acceptance::Existing(operation) => operation,
                    };
                    *accepted_slot.lock().map_err(|_| busy())? =
                        Some(operation.operation_id.clone());
                    if let Acceptance::Existing(operation) = &acceptance {
                        authorize_transfer_result(&accept_files, &accept_actor, operation)?;
                        if let Some(stamp) = &stamp {
                            accept_auth.validate_grants(stamp)?;
                        }
                    }
                    Ok((acceptance, stamp))
                })
                .await;
                match acceptance {
                    Err(error) => {
                        let _ = send.send(Err(error));
                    }
                    Ok((Acceptance::Existing(operation), _)) => {
                        let _ = send.send(Ok(operation));
                    }
                    Ok((Acceptance::New(operation), stamp)) => {
                        if let Some(prepared) = client_preparation {
                            let accepted = AcceptedCall {
                                actor,
                                call,
                                operation,
                            };
                            let binding = blocking({
                                let operation = accepted.operation.clone();
                                move || prepared.bind(Some(&operation))
                            })
                            .await;
                            let _ = send.send(Ok(accepted.operation.clone()));
                            host.execute_client_effect(accepted, binding).await;
                            return;
                        }
                        if device_action {
                            if let Err(error) =
                                host.inner
                                    .sessions
                                    .track(&operation, stamp, call.lease_id.clone())
                            {
                                let _ = host
                                    .inner
                                    .sessions
                                    .reject_untracked(&operation, error.clone())
                                    .await;
                                let _ = send.send(Err(error));
                                return;
                            }
                            drop(admission.take());
                            let _ = send.send(Ok(operation.clone()));
                            let _ = host
                                .inner
                                .sessions
                                .execute(
                                    AcceptedCall {
                                        actor,
                                        call,
                                        operation,
                                    },
                                    preparation.expect("device preparation"),
                                )
                                .await;
                            // Store changes are coalesced by the projection owner;
                            // a settled device job must not wait for another full snapshot.
                            return;
                        }
                        let _ = send.send(Ok(operation.clone()));
                        // Store changes wake the sole projection owner. Starting the
                        // action must not wait for the operation-history display.
                        host.execute_short(
                            action,
                            AcceptedCall {
                                actor,
                                call,
                                operation,
                            },
                        )
                        .await;
                    }
                }
            });
            jobs.handles.push(OwnedJob {
                handle,
                operation_id,
            });
        }
        receive.await.map_err(|_| busy())?
    }
    async fn send_client_effect(
        &self,
        dispatch: crate::client_effects::ClientEffectDispatch,
    ) -> HostResult<()> {
        let clients = self.inner.client_effects.clone();
        blocking(move || {
            let sent = (|| {
                dispatch.authorize()?;
                clients.mark_dispatched(&dispatch.request.delivery_id)?;
                dispatch.destination.emit_client_effect(&dispatch)
            })();
            if let Err(error) = &sent {
                // No queue insertion succeeded: the platform cannot have begun.
                clients.reject_undelivered(&dispatch.request.delivery_id, error.clone())?;
            }
            sent
        })
        .await
    }
    async fn execute_client_effect(
        &self,
        accepted: AcceptedCall,
        binding: HostResult<(
            crate::client_effects::ClientEffectDispatch,
            crate::client_effects::ClientEffectWaiter,
        )>,
    ) {
        let result = async {
            let (dispatch, waiter) = binding?;
            let store = self.inner.store.clone();
            let operation_id = accepted.operation.operation_id.clone();
            let prepared = blocking(move || {
                dispatch.authorize()?;
                store.mark_dispatch(&operation_id)?;
                Ok(dispatch)
            })
            .await;
            let dispatch = match prepared {
                Ok(dispatch) => dispatch,
                Err(error) => {
                    let clients = self.inner.client_effects.clone();
                    let delivery_id = waiter.delivery_id.clone();
                    let rejected = error.clone();
                    let _ =
                        blocking(move || clients.reject_undelivered(&delivery_id, rejected)).await;
                    return Err(error);
                }
            };
            if accepted.call.action_id.as_str() == "client.updater.install" {
                let barrier = self.quiesce_for_update(&accepted).await;
                if !matches!(&barrier, Ok(report) if report.completed) {
                    let error = barrier.err().unwrap_or_else(|| {
                        HostError::new(
                            "SHUTDOWN_INCOMPLETE",
                            "Host has unsettled work before update installation",
                        )
                    });
                    let clients = self.inner.client_effects.clone();
                    let delivery_id = waiter.delivery_id.clone();
                    let rejected = error.clone();
                    let _ =
                        blocking(move || clients.reject_undelivered(&delivery_id, rejected)).await;
                    return Err(error);
                }
            }
            self.send_client_effect(dispatch).await?;
            Ok(match waiter.wait().await {
                Ok(ClientEffectOutcome::Succeeded { result }) => Settlement {
                    state: OperationState::Succeeded,
                    result: Some(ActionResult::ClientEffect(result)),
                    error: None,
                },
                Ok(ClientEffectOutcome::Failed { error }) => Settlement {
                    state: OperationState::Failed,
                    result: None,
                    error: Some(error),
                },
                Err(error) => Settlement {
                    state: OperationState::Unknown,
                    result: None,
                    error: Some(error),
                },
            })
        }
        .await;
        let outcome = result.unwrap_or_else(|error| Settlement {
            state: OperationState::Interrupted,
            result: None,
            error: Some(error),
        });
        let store = self.inner.store.clone();
        let operation_id = accepted.operation.operation_id;
        let _ = blocking(move || {
            if let Some(result) = &outcome.result {
                store.record_result_evidence(&operation_id, result)?;
            }
            store.settle(&operation_id, outcome)
        })
        .await;
    }
    async fn execute_short(&self, action: BuiltinAction, accepted: AcceptedCall) {
        if action.is_capture_api()
            || (action == BuiltinAction::SessionClose
                && self.inner.capture_api.owns_replay(&accepted.call.target.id))
        {
            let outcome = self
                .inner
                .capture_api
                .execute(action, &accepted)
                .await
                .unwrap_or_else(|error| Settlement {
                    state: OperationState::Interrupted,
                    result: None,
                    error: Some(error),
                });
            let store = self.inner.store.clone();
            let operation_id = accepted.operation.operation_id;
            let _ = blocking(move || {
                if let Some(result) = &outcome.result {
                    store.record_result_evidence(&operation_id, result)?;
                }
                store.settle(&operation_id, outcome)
            })
            .await;
            return;
        }
        if action == BuiltinAction::OperationCancel {
            let result = self.cancel_operation(&accepted).await;
            let store = self.inner.store.clone();
            let id = accepted.operation.operation_id;
            let _ = blocking(move || {
                store.settle(
                    &id,
                    match result {
                        Ok(operation) => Settlement {
                            state: OperationState::Succeeded,
                            result: Some(ActionResult::CancellationRequested(CancellationResult {
                                operation_id: operation.operation_id,
                                state: operation.state,
                            })),
                            error: None,
                        },
                        Err(error) => Settlement {
                            state: OperationState::Failed,
                            result: None,
                            error: Some(error),
                        },
                    },
                )
            })
            .await;
            return;
        }
        let store = self.inner.store.clone();
        let auth = self.inner.auth.clone();
        let documents = self.inner.documents.clone();
        let files = self.inner.files.clone();
        let devices = self.inner.devices.clone();
        let operation_id = accepted.operation.operation_id.clone();
        let result = blocking(move || {
            let check = (|| {
                let authorization = auth.snapshot(&accepted.actor)?;
                for permission in &action.spec().permissions {
                    authorization.require(permission, &accepted.call.target)?;
                }
                if store.identity()?.instance_epoch != accepted.call.instance_epoch {
                    return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
                }
                Ok(())
            })();
            if let Err(error) = check {
                return store.settle(
                    &operation_id,
                    Settlement {
                        state: OperationState::Interrupted,
                        result: None,
                        error: Some(error),
                    },
                );
            }
            store.mark_dispatch(&operation_id)?;
            if action.is_document_action() {
                let descriptor = (|| {
                    if action == BuiltinAction::DeviceRebind {
                        let params: RebindParams = decode(&accepted.call.params)?;
                        let directory = devices.list()?;
                        let descriptor = directory
                            .devices
                            .into_iter()
                            .find(|device| device.device_id == params.device_id)
                            .ok_or_else(|| {
                                HostError::new(
                                    "DEVICE_NOT_FOUND",
                                    "Device is absent from the directory",
                                )
                            })?;
                        if directory.stale
                            && descriptor.fingerprint.transport != DeviceTransportKind::Virtual
                        {
                            return Err(HostError::new(
                                "DISCOVERY_STALE",
                                "Device discovery must succeed before rebinding",
                            ));
                        }
                        Ok(Some(descriptor))
                    } else {
                        Ok(None)
                    }
                })();
                let descriptor = match descriptor {
                    Ok(value) => value,
                    Err(error) => {
                        return store.settle(
                            &operation_id,
                            Settlement {
                                state: OperationState::Failed,
                                result: None,
                                error: Some(error),
                            },
                        );
                    }
                };
                let outcome =
                    documents.execute(&accepted.actor, &accepted.call, action, descriptor);
                // 文档已保存的回执先独立持久化，终态写入失败时恢复仍保留实际结果。
                if let Some(result) = &outcome.result {
                    store.record_result_evidence(&operation_id, result)?;
                }
                return store.settle(&operation_id, outcome);
            }
            let result = (|| match action {
                BuiltinAction::FileRegister => {
                    let reference =
                        files.register(decode(&accepted.call.params)?, &accepted.actor)?;
                    let result =
                        ActionResult::FileMetadata(files.metadata(&reference, &accepted.actor)?);
                    store.record_result_evidence(&operation_id, &result)?;
                    Ok(result)
                }
                BuiltinAction::HostShutdown => {
                    Ok(ActionResult::ShutdownRequested(ShutdownRequested {
                        instance_epoch: accepted.call.instance_epoch,
                    }))
                }
                BuiltinAction::Authorize => auth
                    .authorize(&accepted.actor, decode(&accepted.call.params)?)
                    .map(|grant_revision| {
                        ActionResult::AuthorizationChanged(AuthorizationResult { grant_revision })
                    }),
                BuiltinAction::Revoke => auth
                    .revoke(&accepted.actor, decode(&accepted.call.params)?)
                    .map(|grant_revision| {
                        ActionResult::AuthorizationChanged(AuthorizationResult { grant_revision })
                    }),
                BuiltinAction::OperationCancel => store
                    .request_cancel(&accepted.actor, &accepted.call.target.id)
                    .map(|operation| {
                        ActionResult::CancellationRequested(CancellationResult {
                            operation_id: operation.operation_id,
                            state: operation.state,
                        })
                    }),
                _ => Err(invalid()),
            })();
            match result {
                Ok(result) => store.settle(
                    &operation_id,
                    Settlement {
                        state: OperationState::Succeeded,
                        result: Some(result),
                        error: None,
                    },
                ),
                Err(error) => store.settle(
                    &operation_id,
                    Settlement {
                        state: OperationState::Failed,
                        result: None,
                        error: Some(error),
                    },
                ),
            }
        })
        .await;
        let stop = action == BuiltinAction::HostShutdown
            && matches!(&result, Ok(operation) if operation.state == OperationState::Succeeded
                && matches!(operation.result, Some(ActionResult::ShutdownRequested(_))));
        if stop {
            if let Ok(mut jobs) = self.inner.jobs.lock() {
                jobs.closing = true;
            }
            self.inner.stop_requested.send_replace(true);
        }
    }
    async fn authorize_cancellation(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: OperationCancelParams,
    ) -> HostResult<()> {
        target.validate()?;
        if target.kind.as_str() != "operation"
            || target.session_id.is_some()
            || target.session_epoch.is_some()
        {
            return Err(invalid());
        }
        if params.reason != CancelReason::User && !actor.is_user_control() {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Cancellation reason requires user control",
            ));
        }
        let store = self.inner.store.clone();
        let auth = self.inner.auth.clone();
        let actor = actor.clone();
        let target = target.clone();
        blocking(move || {
            auth.require(&actor, "metadata.read", &target)?;
            // TransmissionService::cancel and Store::request_cancel use this same
            // retained-operation ownership gate before signalling or changing state.
            store.get(&actor, &target.id).map(|_| ())
        })
        .await
    }
    async fn cancel_operation(&self, accepted: &AcceptedCall) -> HostResult<Operation> {
        // Recheck current rights, reason, owner and Host epoch at actual dispatch.
        self.validate(
            &accepted.actor,
            &call_query(&accepted.call),
            ActionKind::Action,
        )
        .await?;
        let store = self.inner.store.clone();
        let id = accepted.operation.operation_id.clone();
        blocking(move || store.mark_dispatch(&id)).await?;
        self.inner
            .sessions
            .cancel(&accepted.actor, &accepted.call.target.id)
            .await
    }
    async fn publish_operations(&self) -> HostResult<()> {
        let mut published = self.inner.operation_projection.lock().await;
        let store = self.inner.store.clone();
        let state = blocking(move || store.operation_metadata()).await?;
        if published.as_ref() == Some(&state) {
            return Ok(());
        }
        self.inner.projections.commit(
            &id("host.operations"),
            id("operations.changed"),
            state.clone(),
            state.clone(),
        )?;
        *published = Some(state);
        Ok(())
    }
    fn start_operation_projection(&self) -> HostResult<()> {
        let mut task = self
            .inner
            .operation_projection_task
            .lock()
            .map_err(|_| busy())?;
        let mut changes = self.inner.store.subscribe_operation_changes();
        let owner = Arc::downgrade(&self.inner);
        *task = Some(tokio::spawn(async move {
            while changes.changed().await.is_ok() {
                let Some(inner) = owner.upgrade() else {
                    break;
                };
                let host = Host { inner };
                let _ = host.publish_operations().await;
            }
        }));
        Ok(())
    }
    async fn stop_operation_projection(&self) -> HostResult<()> {
        let task = self
            .inner
            .operation_projection_task
            .lock()
            .map_err(|_| busy())?
            .take();
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
        Ok(())
    }
    pub async fn shutdown(&self) -> HostResult<()> {
        self.finish_shutdown().await
    }
}
impl RequestHandler for Host {
    fn stop_requested(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let mut stopped = self.inner.stop_requested.subscribe();
        Box::pin(async move {
            while !*stopped.borrow_and_update() {
                if stopped.changed().await.is_err() {
                    break;
                }
            }
        })
    }
    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<()>> + Send>> {
        let host = self.clone();
        Box::pin(async move { Host::shutdown(&host).await })
    }
    fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
        let host = self.clone();
        Box::pin(async move {
            let required = request.required_channel()?;
            if (context.channel == IpcChannel::Control && required == RequestChannel::Raw)
                || (context.channel == IpcChannel::Raw && required == RequestChannel::Control)
            {
                return Err(HostError::new(
                    "PERMISSION_DENIED",
                    "Request requires a different physical connection",
                ));
            }
            let generic = matches!(request, RpcRequest::Query(_));
            let actor = context.actor.clone();
            let mut raw_output_lease = None;
            let result = match request {
                RpcRequest::ClientRegister(params) => {
                    if !actor.is_user_control() {
                        return Err(HostError::new(
                            "PERMISSION_DENIED",
                            "Client receiver management requires user control",
                        ));
                    }
                    let clients = host.inner.client_effects.clone();
                    blocking(move || {
                        clients
                            .register(&context, params)
                            .map(RpcResult::ClientRegistration)
                    })
                    .await?
                }
                RpcRequest::ClientUnregister(params) => {
                    if !actor.is_user_control() {
                        return Err(HostError::new(
                            "PERMISSION_DENIED",
                            "Client receiver management requires user control",
                        ));
                    }
                    let clients = host.inner.client_effects.clone();
                    blocking(move || clients.unregister(&context, params).map(RpcResult::Closed))
                        .await?
                }
                RpcRequest::ClientReceipt(params) => {
                    if !actor.is_user_control() {
                        return Err(HostError::new(
                            "PERMISSION_DENIED",
                            "Client receiver management requires user control",
                        ));
                    }
                    let clients = host.inner.client_effects.clone();
                    blocking(move || {
                        clients
                            .receipt(&context, params)
                            .map(RpcResult::ClientEffectAcknowledged)
                    })
                    .await?
                }
                RpcRequest::Invoke(call) | RpcRequest::OperationCancel(call) => {
                    RpcResult::Operation(Box::new(OperationResult {
                        operation: host.invoke(&actor, call).await?,
                    }))
                }
                RpcRequest::Query(q)
                | RpcRequest::CatalogList(q)
                | RpcRequest::OperationGet(q)
                | RpcRequest::StateSnapshot(q)
                | RpcRequest::StateSubscribe(q)
                | RpcRequest::SubscriptionClose(q)
                | RpcRequest::ObjectRead(q)
                | RpcRequest::StreamRead(q)
                | RpcRequest::StreamSubscribe(q)
                | RpcRequest::StreamCredit(q) => {
                    let output = host.query_connected(&actor, q, Some(context)).await?;
                    raw_output_lease = output.raw_output_lease;
                    let result = output.result;
                    if generic {
                        RpcResult::Query(result)
                    } else {
                        match result {
                            QueryResult::Catalog(value) => RpcResult::Catalog(value),
                            QueryResult::Operation(value) => RpcResult::Operation(value),
                            QueryResult::Snapshot(value) => RpcResult::Snapshot(value),
                            QueryResult::Subscription(value) => RpcResult::Subscription(value),
                            QueryResult::Closed(value) => RpcResult::Closed(value),
                            QueryResult::StreamRead(value) => RpcResult::StreamRead(value),
                            QueryResult::StreamSubscribe(value) => {
                                RpcResult::Subscription(SubscriptionResult {
                                    subscription_id: value.subscription_id,
                                })
                            }
                            QueryResult::StreamCredit(value) => RpcResult::StreamCredit(value),
                            other => RpcResult::Query(other),
                        }
                    }
                }
                _ => {
                    return Err(HostError::new(
                        "UNSUPPORTED_CAPABILITY",
                        "Action handler is not registered",
                    ));
                }
            };
            Ok(HandlerReply {
                wire_reply: RpcReply::Success {
                    ok: True,
                    result: Box::new(result),
                },
                raw_output_lease,
            })
        })
    }
    fn disconnected(&self, context: &ConnectionContext) {
        let _ = self
            .inner
            .client_effects
            .disconnected(&context.connection_id);
        if let Ok(mut pumps) = self.inner.subscriptions.lock() {
            pumps.retain(|_, pump| {
                pump.connection_id != context.connection_id
                    || (context.channel == IpcChannel::Raw && pump.channel != IpcChannel::Raw)
            });
        }
    }
}
fn require_reference_target(target: &Target, reference: &ObjectRef) -> HostResult<()> {
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
fn authorize_transfer_result(
    files: &crate::files::FileService,
    actor: &AuthenticatedActor,
    operation: &Operation,
) -> HostResult<()> {
    if let Some(ActionResult::FileTransfer(result)) = &operation.result {
        files.authorize_receipts(&result.receipts_ref, actor)?;
    }
    Ok(())
}
fn call_query(call: &Call) -> Query {
    Query {
        protocol_version: call.protocol_version,
        host_id: call.host_id.clone(),
        instance_epoch: call.instance_epoch,
        actor_id: call.actor_id.clone(),
        request_id: call.request_id.clone(),
        action_id: call.action_id.clone(),
        target: call.target.clone(),
        params: call.params.clone(),
        reveal_target: call.reveal_target.clone(),
    }
}
fn action_reveal(action: BuiltinAction, target: &Target) -> RevealTarget {
    let mut reveal = action.spec().reveal_target.clone();
    if target.kind.as_str() == "workspace" {
        reveal.workspace_id = Some(target.id.clone());
    }
    reveal
}
fn decode<T: DeserializeOwned>(params: &JsonObject) -> HostResult<T> {
    serde_json::from_value(serde_json::to_value(params).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
fn normalize<T: DeserializeOwned + Serialize>(params: &JsonObject) -> HostResult<JsonObject> {
    object(serde_json::to_value(decode::<T>(params)?).map_err(|_| invalid())?)
}
fn object(value: serde_json::Value) -> HostResult<JsonObject> {
    serde_json::from_value(value).map_err(|_| invalid())
}
fn id(value: &str) -> Id {
    Id::try_from(value).expect("static Id")
}
fn new_id() -> Id {
    id(&uuid::Uuid::new_v4().to_string())
}
fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Action parameters or target are invalid",
    )
}
fn busy() -> HostError {
    HostError::new("HOST_BUSY", "Host request capacity is exhausted")
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> HostResult<T> + Send + 'static,
) -> HostResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| HostError::new("STORAGE_UNAVAILABLE", "Host worker is unavailable"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{HostServer, InstanceGuard};
    #[tokio::test]
    async fn catalog_initialization_releases_the_map_lock_and_cancels_on_close() {
        let h = crate::test_support::Harness::new().await;
        let (first, keep_first) = crate::ipc::test_context(h.actor.clone(), id("first-catalog"));
        let (second, keep_second) = crate::ipc::test_context(h.actor.clone(), id("second-catalog"));
        let (entered, wait_entered) = oneshot::channel();
        let (_release, wait) = oneshot::channel();
        *h.host.inner.catalog_gate.lock().unwrap() = Some((entered, wait));
        let host = h.host.clone();
        let initializing = tokio::spawn(async move { host.ensure_catalog_watch(first).await });
        wait_entered.await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            h.host.ensure_catalog_watch(second),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(h.host.inner.catalog_watchers.lock().await.len(), 1);
        drop(keep_first);
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(3), initializing)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            "CLIENT_CLOSED"
        );
        drop(keep_second);
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !h.host.inner.catalog_watchers.lock().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        h.host.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn catalog_initialization_cannot_register_after_host_shutdown() {
        let h = crate::test_support::Harness::new().await;
        let (context, keep_open) = crate::ipc::test_context(h.actor.clone(), id("closing-catalog"));
        let (entered, wait_entered) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        *h.host.inner.catalog_gate.lock().unwrap() = Some((entered, wait));
        let host = h.host.clone();
        let initializing = tokio::spawn(async move { host.ensure_catalog_watch(context).await });
        wait_entered.await.unwrap();
        h.host.shutdown().await.unwrap();
        release.send(()).unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(3), initializing)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            "HOST_BUSY"
        );
        assert!(h.host.inner.catalog_watchers.lock().await.is_empty());
        drop(keep_open);
    }
    #[tokio::test]
    async fn concurrent_catalog_initialization_registers_only_one_connection_watcher() {
        let h = crate::test_support::Harness::new().await;
        let (context, keep_open) = crate::ipc::test_context(h.actor.clone(), id("same-catalog"));
        let (entered, wait_entered) = oneshot::channel();
        let (release, wait) = oneshot::channel();
        *h.host.inner.catalog_gate.lock().unwrap() = Some((entered, wait));
        let host = h.host.clone();
        let first = context.clone();
        let initializing = tokio::spawn(async move { host.ensure_catalog_watch(first).await });
        wait_entered.await.unwrap();
        h.host.ensure_catalog_watch(context).await.unwrap();
        release.send(()).unwrap();
        initializing.await.unwrap().unwrap();
        assert_eq!(h.host.inner.catalog_watchers.lock().await.len(), 1);
        drop(keep_open);
        h.host.shutdown().await.unwrap();
        assert!(h.host.inner.catalog_watchers.lock().await.is_empty());
    }
    #[tokio::test]
    async fn duplicate_transfer_admission_rechecks_source_after_another_call_settles() {
        let h = crate::test_support::Harness::new().await;
        let target = h.open("duplicate-admission").await;
        let operator = h
            .auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let path = h.dir.path().join("duplicate-source.bin");
        std::fs::write(&path, [1, 2, 3]).unwrap();
        let reference = h
            .host
            .files()
            .register(
                RegisterFileParams {
                    path: path.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &operator,
            )
            .unwrap();
        let mut call = h.call(&target, "transfer.file", serde_json::json!({"sourceRef":reference,"offset":"0","length":"3","chunkBytes":"3","bytesPerSecond":"1000000","interChunkMs":"0","writeWaitMs":"1000"}));
        call.execution_mode = Some(ExecutionMode::Independent);
        let (entered, wait_entered) = oneshot::channel();
        let (release, held) = oneshot::channel();
        *h.host.inner.admission_gate.lock().unwrap() = Some((entered, held));
        let host = h.host.clone();
        let actor = h.actor.clone();
        let waiting_call = call.clone();
        let waiting = tokio::spawn(async move { host.invoke(&actor, waiting_call).await });
        wait_entered.await.unwrap();
        let other = h.host.invoke(&h.actor, call).await.unwrap();
        let settled = h.wait(&other.operation_id).await;
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "{:?}",
            settled.error
        );
        assert!(matches!(
            settled.result,
            Some(ActionResult::FileTransfer(_))
        ));
        h.auth
            .revoke(
                &operator,
                RevokeParams {
                    actor_id: h.actor.id().clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![Target {
                        host_id: reference.host_id,
                        kind: reference.kind,
                        id: reference.id,
                        session_id: None,
                        session_epoch: None,
                    }],
                },
            )
            .unwrap();
        release.send(()).unwrap();
        let result = waiting.await.unwrap();
        h.host.shutdown().await.unwrap();
        assert!(
            matches!(result, Err(ref error) if error.code == "PERMISSION_DENIED"),
            "admission duplicate must recheck source authority: {result:?}"
        );
    }
    #[tokio::test]
    async fn device_authorization_settles_while_operation_projection_is_busy() {
        use crate::test_support as support;
        let h = support::Harness::new().await;
        let operator = h
            .auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let target = Target {
            host_id: h.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: h.host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let projection = h.host.inner.operation_projection.lock().await;
        let call = h.call_as(
            &operator,
            &target,
            "auth.authorize",
            serde_json::json!({
                "clientId":h.actor.client_id(),"permissions":["metadata.read"],"targets":[target],
            }),
        );
        let accepted = h.host.invoke(&operator, call).await.unwrap();
        let completed = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                let store = h.store.clone();
                let actor = operator.clone();
                let operation_id = accepted.operation_id.clone();
                let operation =
                    tokio::task::spawn_blocking(move || store.get(&actor, &operation_id))
                        .await
                        .unwrap()
                        .unwrap();
                if operation.state == OperationState::Succeeded {
                    return operation;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await;
        drop(projection);
        h.host.shutdown().await.unwrap();
        assert!(
            completed.is_ok(),
            "Serial connection authorization waited for operation-history display"
        );
    }
    #[tokio::test]
    async fn settled_device_owner_retires_while_operation_projection_is_busy() {
        use crate::test_support as support;
        let h = support::Harness::new().await;
        let target = h.open("projection-owner").await;
        let projection = h.host.inner.operation_projection.lock().await;
        let accepted = h
            .invoke(h.call(
                &target,
                "session.tx",
                serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
            ))
            .await;
        let settled = h.wait(&accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        assert_eq!(h.write_count(), 1);
        support::until(|| {
            let (pending, admissions) = h.host.inner.sessions.quiesce_pending().unwrap();
            pending.is_empty() && admissions == 0
        })
        .await;
        let retired = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let finished = {
                    let jobs = h.host.inner.jobs.lock().unwrap();
                    let owner = jobs
                        .handles
                        .iter()
                        .find(|job| {
                            job.operation_id.lock().unwrap().as_ref()
                                == Some(&accepted.operation_id)
                        })
                        .expect("the last admitted device owner is retained");
                    owner.handle.is_finished()
                };
                if finished {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        })
        .await;
        assert!(
            retired.is_ok(),
            "durably settled device owner still waits for duplicate operation projection"
        );
        let shutdown =
            tokio::time::timeout(std::time::Duration::from_secs(6), h.host.shutdown()).await;
        drop(projection);
        let error = shutdown
            .expect("shutdown retains its existing bounded wait")
            .expect_err("shutdown must await the final operation projection");
        assert_eq!(error.code, "SHUTDOWN_INCOMPLETE");
        let report: ShutdownReport = decode(error.details.as_deref().unwrap()).unwrap();
        assert!(!report.completed);
        assert!(report.unsettled_operation_ids.is_empty(), "{report:?}");
        assert!(report.quarantined_sessions.is_empty(), "{report:?}");
        assert_eq!(report.failures.len(), 1, "{report:?}");
        assert_eq!(report.failures[0].code, "SHUTDOWN_INCOMPLETE");
        assert_eq!(
            report.failures[0].message,
            "Host settlement budget expired before all owners completed"
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let snapshot = h
                    .host
                    .inner
                    .projections
                    .snapshot(&h.actor, &id("host.operations"))
                    .await
                    .unwrap();
                let snapshot: OperationsSnapshot = decode(&snapshot.state).unwrap();
                if snapshot.items.iter().any(|operation| {
                    operation.operation_id == settled.operation_id
                        && operation.state == settled.state
                        && operation.revision == settled.revision
                }) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("the existing projection owner must publish the durable terminal state");
        assert_eq!(
            serde_json::to_value(h.store.get(&h.actor, &settled.operation_id).unwrap()).unwrap(),
            serde_json::to_value(settled).unwrap()
        );
        assert_eq!(h.write_count(), 1);
        h.host.shutdown().await.unwrap();
    }
    #[tokio::test]
    async fn saturated_normal_operations_preserve_cancel_close_release_and_shutdown() {
        use crate::test_support as support;
        for stop in ["operation.cancel", "session.close", "lease.release"] {
            let h = support::Harness::new().await;
            let mut targets = vec![];
            let mut leases = vec![];
            for name in ["capacity-a", "capacity-b"] {
                let target = h.open(name).await;
                let op = h
                    .invoke(h.call(
                        &target,
                        "lease.acquire",
                        serde_json::json!({"kind":"exclusive","ttlMs":"30000"}),
                    ))
                    .await;
                eprintln!(
                    "saturated stage=lease_evidence stop={stop} device={name} operation={}",
                    op.operation_id
                );
                let wait_started = std::time::Instant::now();
                let waited = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    while h
                        .store
                        .get(&h.actor, &op.operation_id)
                        .unwrap()
                        .result
                        .is_none()
                    {
                        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                    }
                })
                .await;
                if waited.is_err() {
                    eprintln!(
                        "saturated timeout stage=lease_evidence stop={stop} device={name} elapsed={:?} operation={:?}",
                        wait_started.elapsed(),
                        h.store.get(&h.actor, &op.operation_id)
                    );
                }
                waited.unwrap();
                let Some(ActionResult::Lease(lease)) =
                    h.store.get(&h.actor, &op.operation_id).unwrap().result
                else {
                    panic!()
                };
                targets.push(target);
                leases.push(lease);
            }
            let mut queued = vec![];
            for index in 0..222 {
                queued.push(
                    h.invoke(h.call(
                        &targets[index % 2],
                        "session.tx",
                        serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
                    ))
                    .await,
                );
            }
            let ordinary = h
                .host
                .invoke(
                    &h.actor,
                    h.call(
                        &targets[0],
                        "session.tx",
                        serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
                    ),
                )
                .await;
            let (target, params) = match stop {
                "operation.cancel" => (
                    Target {
                        host_id: h.host_id.clone(),
                        kind: ResourceKind::try_from("operation").unwrap(),
                        id: queued[0].operation_id.clone(),
                        session_id: None,
                        session_epoch: None,
                    },
                    serde_json::json!({"reason":"user"}),
                ),
                "lease.release" => (
                    targets[0].clone(),
                    serde_json::json!({"leaseId":leases[0].lease_id}),
                ),
                _ => (targets[0].clone(), serde_json::json!({})),
            };
            let stopping = h.host.invoke(&h.actor, h.call(&target, stop, params)).await;
            assert!(
                matches!(ordinary,Err(ref error) if error.code=="HOST_BUSY"),
                "ordinary accepted while all normal slots occupied: {stop}"
            );
            assert!(
                stopping.is_ok(),
                "stop admission failed: {stop}: {stopping:?}"
            );
            let stopping = stopping.unwrap();
            let mut operation_ids = leases
                .iter()
                .map(|lease| lease.owner_operation_id.clone())
                .collect::<Vec<_>>();
            operation_ids.extend(
                queued
                    .iter()
                    .map(|operation| operation.operation_id.clone()),
            );
            operation_ids.push(stopping.operation_id);
            tokio::time::timeout(std::time::Duration::from_secs(60), async {
                h.store.trace_requests(true);
                let shutdown_started = std::time::Instant::now();
                eprintln!("saturated stage=shutdown_begin stop={stop} at={shutdown_started:?}");
                let shutdown = h.host.shutdown().await;
                h.store.trace_requests(false);
                let (pending, admissions) = h.host.inner.sessions.quiesce_pending().unwrap();
                let jobs = h
                    .host
                    .inner
                    .jobs
                    .lock()
                    .unwrap()
                    .handles
                    .iter()
                    .map(|job| {
                        (
                            job.operation_id.lock().unwrap().clone(),
                            job.handle.is_finished(),
                        )
                    })
                    .collect::<Vec<_>>();
                eprintln!(
                    "saturated stage=shutdown_return stop={stop} elapsed={:?} pending={pending:?} admissions={admissions} jobs={jobs:?}",
                    shutdown_started.elapsed()
                );
                if let Err(error) = shutdown {
                    assert_eq!(error.code, "SHUTDOWN_INCOMPLETE");
                    assert!(error.retryable);
                    let report: ShutdownReport = decode(error.details.as_deref().unwrap()).unwrap();
                    assert_eq!(report.mode, ShutdownMode::CancelAndSettle);
                    assert!(!report.completed);
                    assert!(report.excluded_operation_id.is_none());
                    assert!(report.quarantined_sessions.is_empty(), "{report:?}");
                    assert!(!report.failures.is_empty(), "{report:?}");
                    for failure in &report.failures {
                        assert_eq!(failure.code, "SHUTDOWN_INCOMPLETE", "{report:?}");
                        assert!(failure.retryable, "{report:?}");
                    }
                    assert_eq!(admissions, 0, "accepted calls still awaiting admission");
                    assert!(
                        report
                            .unsettled_operation_ids
                            .iter()
                            .all(|id| operation_ids.contains(id)),
                        "{report:?}"
                    );
                    let reported = |id: &Id| {
                        report.unsettled_operation_ids.contains(id)
                            || report.evidence_refs.iter().any(|reference| {
                                reference.host_id == h.host_id
                                    && reference.kind.as_str() == "operation"
                                    && &reference.id == id
                            })
                    };
                    for id in &pending {
                        assert!(operation_ids.contains(id), "unowned token: {id}");
                        assert!(reported(id), "unreported token: {id}: {report:?}");
                    }
                    for (id, finished) in &jobs {
                        if !finished {
                            let id = id.as_ref().expect("accepted owner has an operation");
                            assert!(operation_ids.contains(id), "unowned job: {id}");
                            assert!(reported(id), "unreported owner: {id}: {report:?}");
                        }
                    }
                    // Preserve the narrower case where durable evidence is
                    // already terminal but later cleanup has not completed.
                    if report.unsettled_operation_ids.is_empty() {
                        assert_eq!(report.failures.len(), 1, "{report:?}");
                        assert_eq!(
                            report.failures[0].message,
                            "Host settlement budget expired before all owners completed"
                        );
                    }
                    // A bounded barrier may expire while these real owners are
                    // finishing. Retry only after they actually retire.
                    eprintln!("saturated stage=owner_retirement stop={stop}");
                    let wait_started = std::time::Instant::now();
                    let retirement_budget = std::time::Duration::from_secs(60)
                        .saturating_sub(shutdown_started.elapsed());
                    let waited = tokio::time::timeout(retirement_budget, async {
                        loop {
                            let (pending, admissions) =
                                h.host.inner.sessions.quiesce_pending().unwrap();
                            if pending.is_empty()
                                && admissions == 0
                                && h.host
                                    .inner
                                    .jobs
                                    .lock()
                                    .unwrap()
                                    .handles
                                    .iter()
                                    .all(|job| job.handle.is_finished())
                            {
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                        }
                    })
                    .await;
                    if waited.is_err() {
                        let (pending, admissions) =
                            h.host.inner.sessions.quiesce_pending().unwrap();
                        let jobs = h
                            .host
                            .inner
                            .jobs
                            .lock()
                            .unwrap()
                            .handles
                            .iter()
                            .map(|job| {
                                (
                                    job.operation_id.lock().unwrap().clone(),
                                    job.handle.is_finished(),
                                )
                            })
                            .collect::<Vec<_>>();
                        let mut ids = pending.clone();
                        for (id, finished) in &jobs {
                            if !finished
                                && let Some(id) = id
                                && !ids.contains(id)
                            {
                                ids.push(id.clone());
                            }
                        }
                        let operations = ids
                            .iter()
                            .map(|id| h.store.get(&h.actor, id))
                            .collect::<Vec<_>>();
                        eprintln!(
                            "saturated timeout stage=owner_retirement stop={stop} elapsed={:?} pending={pending:?} admissions={admissions} jobs={jobs:?} operations={operations:?} first_report={report:?}",
                            wait_started.elapsed()
                        );
                    }
                    waited.unwrap();
                }
                let before = operation_ids
                    .iter()
                    .map(|id| h.store.get(&h.actor, id).unwrap())
                    .collect::<Vec<_>>();
                let writes = h.write_count();
                // Inspect the final barrier only after actual owner retirement;
                // its original budget must still produce complete evidence.
                let report = h.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
                assert_eq!(report.mode, ShutdownMode::CancelAndSettle);
                assert!(report.completed, "{report:?}");
                assert!(report.excluded_operation_id.is_none());
                assert!(report.unsettled_operation_ids.is_empty(), "{report:?}");
                assert!(report.quarantined_sessions.is_empty(), "{report:?}");
                assert!(report.failures.is_empty(), "{report:?}");
                assert_eq!(report.evidence_refs.len(), operation_ids.len());
                for operation in &before {
                    assert!(operation.result.is_some());
                    assert!(!matches!(
                        operation.state,
                        OperationState::Queued
                            | OperationState::Running
                            | OperationState::CancelRequested
                    ));
                    assert!(
                        report.evidence_refs.contains(&ObjectRef {
                            host_id: h.host_id.clone(),
                            kind: ResourceKind::try_from("operation").unwrap(),
                            id: operation.operation_id.clone(),
                            revision: Some(operation.revision),
                        }),
                        "{report:?}"
                    );
                }
                // Successful process teardown requires a completed report.
                h.host.shutdown().await.unwrap();
                assert_eq!(h.write_count(), writes, "retry dispatched new backend work");
                for operation in before {
                    assert_eq!(
                        serde_json::to_value(
                            h.store.get(&h.actor, &operation.operation_id).unwrap()
                        )
                        .unwrap(),
                        serde_json::to_value(operation).unwrap()
                    );
                }
            })
            .await
            .unwrap();
            assert!(h.probe.closes.load(std::sync::atomic::Ordering::SeqCst) >= 2);
            for target in targets {
                let session = h.host.devices().session(&target).unwrap();
                assert_eq!(session.snapshot().unwrap().state, SessionState::Closed);
            }
            assert_eq!(
                h.probe
                    .close_calls
                    .load(std::sync::atomic::Ordering::SeqCst),
                2
            );
        }
    }
    #[tokio::test]
    async fn cancelled_waiter_does_not_release_instance_lock_before_owned_admission_settles() {
        owned_admission_shutdown(false, false).await;
    }
    #[tokio::test]
    async fn listener_error_does_not_release_instance_lock_before_owned_admission_settles() {
        owned_admission_shutdown(true, false).await;
    }
    #[tokio::test]
    async fn shutdown_action_waits_for_owned_jobs_before_releasing_instance_lock() {
        owned_admission_shutdown(false, true).await;
    }
    #[tokio::test]
    async fn shutdown_rejects_ordinary_actor_and_settlement_failure_never_signals_stop() {
        let h = crate::test_support::Harness::new().await;
        let target = Target {
            host_id: h.host_id.clone(),
            id: h.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let call = h.call(&target, "host.shutdown", serde_json::json!({}));
        assert!(
            matches!(h.host.invoke(&h.actor, call.clone()).await, Err(error) if error.code == "PERMISSION_DENIED")
        );
        let actor = h
            .auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let connection =
            rusqlite::Connection::open(h.dir.path().join("host-v0/state.sqlite3")).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_shutdown_terminal BEFORE UPDATE ON operations WHEN NEW.terminal=1 BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;").unwrap();
        let mut call = call;
        call.actor_id = actor.id().clone();
        call.request_context = h.store.issue_context(&actor).unwrap().token;
        let accepted = h.host.invoke(&actor, call).await.unwrap();
        crate::test_support::until(|| {
            h.host
                .inner
                .jobs
                .lock()
                .unwrap()
                .handles
                .iter()
                .all(|job| job.handle.is_finished())
        })
        .await;
        assert_eq!(
            h.store.get(&actor, &accepted.operation_id).unwrap().state,
            OperationState::Running
        );
        assert!(!*h.host.inner.stop_requested.borrow());
        let error = h.host.shutdown().await.unwrap_err();
        assert_eq!(error.code, "SHUTDOWN_INCOMPLETE");
        let report: ShutdownReport = decode(error.details.as_deref().unwrap()).unwrap();
        assert_eq!(report.mode, ShutdownMode::CancelAndSettle);
        assert!(!report.completed);
        assert!(report.excluded_operation_id.is_none());
        assert_eq!(
            report.unsettled_operation_ids,
            vec![accepted.operation_id.clone()]
        );
        assert!(report.quarantined_sessions.is_empty());
        assert!(report.evidence_refs.is_empty());
        assert!(report.failures.is_empty());
        assert!(h.host.inner.jobs.lock().unwrap().handles.is_empty());
        assert_eq!(h.probe.closes.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(
            h.store.get(&actor, &accepted.operation_id).unwrap().state,
            OperationState::Running
        );
        assert!(!*h.host.inner.stop_requested.borrow());
    }
    async fn owned_admission_shutdown(listener_error: bool, action_shutdown: bool) {
        let dir =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        if listener_error {
            server.accept_error = Some(HostError::new(
                "TEST_ACCEPT_ERROR",
                "Injected listener failure",
            ));
        }
        let store = server.store();
        let auth = server.auth();
        let secret =
            serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
                .unwrap()
                .unwrap();
        let secret = ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap();
        let actor = auth
            .authenticate_user_control(&id("operator"), &secret)
            .unwrap();
        auth.authenticate(&id("recipient"), None).unwrap();
        let identity = store.identity().unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let call=Call {protocol_version:ProtocolVersion::V0_1,host_id:identity.host_id,instance_epoch:identity.instance_epoch,actor_id:actor.id().clone(),request_id:RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),request_context:store.issue_context(&actor).unwrap().token,action_id:id("auth.authorize"),target:target.clone(),params:object(serde_json::json!({"clientId":"recipient","permissions":["content.read"],"targets":[target]})).unwrap(),reveal_target:BuiltinAction::Authorize.spec().reveal_target.clone(),expected_revision:None,lease_id:None,execution_mode:None};
        let selector = OperationGetParams::ByRequest {
            actor_id: actor.id().clone(),
            request_id: call.request_id.clone(),
            request_context: call.request_context.clone(),
        };
        let mut shutdown_call = call.clone();
        shutdown_call.action_id = id("host.shutdown");
        shutdown_call.params = JsonObject::new();
        shutdown_call.request_id =
            RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
        let host = Host::new(store.clone(), auth).await.unwrap();
        let (entered, wait_entered) = oneshot::channel();
        let (release, held) = oneshot::channel();
        *host.inner.admission_gate.lock().unwrap() = Some((entered, held));
        let invoke_host = host.clone();
        let invoke_actor = actor.clone();
        let waiter = tokio::spawn(async move { invoke_host.invoke(&invoke_actor, call).await });
        wait_entered.await.unwrap();
        waiter.abort();
        let _ = waiter.await;
        let (stop, done) = oneshot::channel();
        let service = host.clone();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(service), async {
                    let _ = done.await;
                })
                .await
        });
        let shutdown_operation = if action_shutdown {
            Some(host.invoke(&actor, shutdown_call).await.unwrap())
        } else {
            None
        };
        if !listener_error && !action_shutdown {
            stop.send(()).unwrap();
        }
        // 关闭标记是确定性的同步证据；不是依赖睡眠推测已开始关闭。
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if host.inner.jobs.lock().unwrap().closing || running.is_finished() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!running.is_finished());
        assert!(matches!(InstanceGuard::acquire(dir.path()),Err(error) if error.code=="HOST_BUSY"));
        release.send(()).unwrap();
        let result = running.await.unwrap();
        if listener_error {
            assert!(
                matches!(result, Err(error) if error.code == "TEST_ACCEPT_ERROR" && error.message == "Injected listener failure")
            );
        } else {
            result.unwrap();
        }
        assert_eq!(
            store.get_selected(&actor, &selector).unwrap().state,
            OperationState::Succeeded
        );
        if let Some(operation) = shutdown_operation {
            let operation = store.get(&actor, &operation.operation_id).unwrap();
            assert_eq!(operation.state, OperationState::Succeeded);
            assert!(matches!(
                operation.result,
                Some(ActionResult::ShutdownRequested(_))
            ));
        }
        assert!(InstanceGuard::acquire(dir.path()).is_ok());
    }
}
