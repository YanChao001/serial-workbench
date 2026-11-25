//! 统一动作接纳与连接适配；持久操作由 Store 持有，执行任务由 Host 持有。
#[path = "browser_file.rs"]
pub(crate) mod browser_file;
#[path = "browser_takeover.rs"]
mod browser_takeover;
#[path = "experiment_api.rs"]
mod experiment_api;
#[path = "node_actions.rs"]
mod node_actions;
#[path = "node_queries.rs"]
mod node_queries;
#[path = "node_views.rs"]
mod node_views;
#[path = "operation_inspection.rs"]
mod operation_inspection;
#[path = "shutdown.rs"]
mod shutdown;
#[path = "task_children.rs"]
mod task_children;
use crate::{
    auth::{AuthService, AuthenticatedActor, GrantStamp},
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
    browser_file_budget: browser_file::BrowserFileBudget,
    node_packages: Arc<crate::node_packages::NodePackageManager>,
    node_query_capacity: Arc<Semaphore>,
    node_raw_read_capacity: Arc<Semaphore>,
    node_derived_capacity: Arc<Semaphore>,
    node_view_capacity: Arc<Semaphore>,
    tasks: Mutex<HashMap<Id, Arc<task_children::TaskScope>>>,
    capture_api: crate::capture_api::CaptureApi,
    client_effects: crate::client_effects::ClientEffects,
    clock: Arc<dyn Clock>,
    projections: ProjectionStore,
    activities: Mutex<ActivityLog>,
    jobs: Mutex<Jobs>,
    capacity: Arc<Semaphore>,
    stop_capacity: Arc<Semaphore>,
    subscriptions: Mutex<HashMap<Id, Pump>>,
    operation_projection: tokio::sync::Mutex<Option<JsonObject>>,
    operation_projection_task: Mutex<Option<JoinHandle<()>>>,
    devices: DeviceService,
    device_runtime: Option<Arc<crate::device::DeviceRuntime>>,
    streams: StreamHub,
    derived: crate::derived::DerivedHub,
    sessions: TransmissionService,
    stop_requested: tokio::sync::watch::Sender<bool>,
    catalog_watchers: tokio::sync::Mutex<HashMap<Id, oneshot::Sender<()>>>,
    #[cfg(test)]
    admission_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
    #[cfg(test)]
    catalog_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
    #[cfg(test)]
    node_test_gates: crate::node_test_gates::NodeTestGates,
}
struct Jobs {
    closing: bool,
    handles: Vec<OwnedJob>,
}
impl Drop for HostInner {
    fn drop(&mut self) {
        self.node_packages.request_quiesce(true);
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
#[derive(Default)]
struct ActivityLog {
    records: VecDeque<(ActivitySummary, usize)>,
    reserved: usize,
    pending_takeover: Option<browser_takeover::PendingTakeover>,
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
        Self::initialize(
            store,
            auth,
            clock,
            DeviceSource::Provider(provider),
            None,
            None,
        )
        .await
    }
    pub async fn new(store: Store, auth: AuthService) -> HostResult<Self> {
        Self::initialize(
            store,
            auth,
            Arc::new(crate::clock::SystemClock::new()?),
            DeviceSource::Native,
            None,
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
            None,
        )
        .await
    }
    pub async fn with_runtime(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
        opener: TransportOpener,
    ) -> HostResult<Self> {
        Self::initialize(store, auth, clock, DeviceSource::Opener(opener), None, None).await
    }
    /// 可信 Rust 嵌入方可移交已校验的同套 Node 证明；该入口不接受 RPC 路径。
    pub async fn with_verified_node_runtime(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
        opener: TransportOpener,
        node: crate::node_runtime::VerifiedNodeRuntime,
    ) -> HostResult<Self> {
        Self::initialize(
            store,
            auth,
            clock,
            DeviceSource::Opener(opener),
            None,
            Some(node),
        )
        .await
    }
    pub async fn with_verified_node_runtime_native(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
        runtime: crate::node_runtime::VerifiedNodeRuntime,
    ) -> HostResult<Self> {
        Self::initialize(
            store,
            auth,
            clock,
            DeviceSource::Native,
            None,
            Some(runtime),
        )
        .await
    }

    async fn initialize(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
        source: DeviceSource,
        startup_config: Option<StartupConfigSnapshot>,
        node: Option<crate::node_runtime::VerifiedNodeRuntime>,
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
        #[cfg(test)]
        let node_test_gates = crate::node_test_gates::NodeTestGates::default();
        let node_packages = Arc::new(crate::node_packages::NodePackageManager::new(
            store.clone(),
            auth.clone(),
            files.clone(),
            registry.runtime.clone(),
            #[cfg(test)]
            node_test_gates.clone(),
        ));
        if let Some(runtime) = &device_runtime {
            let packages = node_packages.clone();
            runtime.attach_plugin_catalog(move || packages.registered_transports())?;
        }
        if let Some(node) = node {
            node_packages.provide_runtime(node)?;
        }
        let recovery_manager = node_packages.clone();
        let provision_bundled = startup_config.is_some();
        if let Err(error) = blocking(move || {
            let limits = crate::node_packages::NodePackageLimits::default();
            let cancel = std::sync::atomic::AtomicBool::new(false);
            recovery_manager.recover_installations(&limits, &cancel)?;
            if provision_bundled {
                recovery_manager.provision_bundled_packages(&limits, &cancel)?;
            }
            Ok(())
        })
        .await
        {
            // 待恢复代码保持原件；实际Node效果会在安装名额内重试并拒绝未解决状态。
            eprintln!("Node package preparation remains pending: {}", error.code);
        }
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
                browser_file_budget: browser_file::BrowserFileBudget::new(),
                node_packages,
                node_query_capacity: Arc::new(Semaphore::new(2)),
                node_raw_read_capacity: Arc::new(Semaphore::new(
                    crate::node_backend::RAW_READ_SLOTS,
                )),
                node_derived_capacity: Arc::new(Semaphore::new(crate::node_backend::DERIVED_SLOTS)),
                node_view_capacity: Arc::new(Semaphore::new(4)),
                tasks: Mutex::new(HashMap::new()),
                capture_api,
                client_effects,
                clock,
                registry,
                projections,
                activities: Mutex::new(ActivityLog::default()),
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
                derived: crate::derived::DerivedHub::new(),
                sessions,
                stop_requested: tokio::sync::watch::channel(false).0,
                catalog_watchers: tokio::sync::Mutex::new(HashMap::new()),
                #[cfg(test)]
                admission_gate: Mutex::new(None),
                #[cfg(test)]
                catalog_gate: Mutex::new(None),
                #[cfg(test)]
                node_test_gates,
            }),
        };
        host.start_operation_projection()?;
        host.publish_operations().await?;
        let recovery =
            crate::node_packages::NodePackageManager::start_recovery(&host.inner.node_packages);
        host.inner
            .jobs
            .lock()
            .map_err(|_| busy())?
            .handles
            .push(OwnedJob {
                handle: recovery,
                operation_id: Arc::new(Mutex::new(None)),
            });
        Ok(host)
    }
    pub fn projections(&self) -> &ProjectionStore {
        &self.inner.projections
    }
    #[cfg(test)]
    pub(crate) async fn with_native_test_clock(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
    ) -> HostResult<Self> {
        Self::initialize(store, auth, clock, DeviceSource::Native, None, None).await
    }
    #[cfg(test)]
    pub(crate) fn hold_next_session_dispatch(
        &self,
    ) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        self.inner.sessions.hold_next_dispatch()
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
        self.inner
            .activities
            .lock()
            .expect("activity mutex")
            .records
            .len()
    }
    async fn validate(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        kind: ActionKind,
    ) -> HostResult<BuiltinAction> {
        self.validate_source(actor, query, kind, None).await
    }

    async fn validate_source(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        kind: ActionKind,
        browser_file: Option<&browser_file::BrowserFileAdmission>,
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
            if action == BuiltinAction::ToolHandoff && !cfg!(windows) {
                return Err(HostError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "This Host has no contained external serial tool executor",
                ));
            }
            if action == BuiltinAction::ToolHandoff {
                auth.require_control(&actor)?;
            }
            let spec = action.spec();
            if spec.kind != kind || !spec.target_kinds.contains(&query.target.kind) {
                return Err(invalid());
            }
            if matches!(
                action,
                BuiltinAction::FileRegister
                    | BuiltinAction::NodeSourceApproveKey
                    | BuiltinAction::NodeSourceRevokeKey
                    | BuiltinAction::NodePackageConfirmExecutionTrust
                    | BuiltinAction::NodePackageRevokeExecutionTrust
                    | BuiltinAction::ToolHandoff
            ) && !actor.is_user_control()
            {
                return Err(HostError::new(
                    "PERMISSION_DENIED",
                    "This action requires user control",
                ));
            }
            let mut authorization = None;
            for permission in &spec.permissions {
                // 引用权限由 FileService 解析到保存的原始授权目标，不能套用派生引用 target。
                if (matches!(
                    action,
                    BuiltinAction::TransferFile | BuiltinAction::NodePackagesInstall
                ) && permission == "content.read")
                    || action.is_capture_api()
                    || replay
                    || matches!(
                        action,
                        BuiltinAction::FileMetadata
                            | BuiltinAction::FileRead
                            | BuiltinAction::TransferReceiptsRead
                            | BuiltinAction::TransferReadProgress
                            | BuiltinAction::OperationGet
                            | BuiltinAction::OperationInput
                            | BuiltinAction::OperationCancel
                            | BuiltinAction::NodeViewAssetRead
                            | BuiltinAction::CatalogList
                    )
                {
                    continue;
                }
                if authorization.is_none() {
                    authorization = Some(auth.snapshot(&actor)?);
                }
                if let Some(authorization) = &authorization {
                    if matches!(
                        action,
                        BuiltinAction::StateScopes | BuiltinAction::DeviceList
                    ) && authorization.is_lan_peer()
                    {
                        // 此目录由 list_scopes 逐项验权，配对身份只看到 B 明确共享的范围。
                        continue;
                    }
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
        if let Some(file) = browser_file {
            if action != BuiltinAction::TransferFile {
                return Err(invalid());
            }
            file.validate_reference(query)?;
        } else {
            self.authorize_resource(&actor, query, action).await?;
        }
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
                            | BuiltinAction::ExperimentExport
                            | BuiltinAction::ExperimentInspect
                            | BuiltinAction::CommandLibraryRead
                    ) =>
            {
                crate::documents::DocumentService::reference(&query.target)?;
            }
            BuiltinAction::NodePackagesInstall => {
                let manager = self.inner.node_packages.clone();
                let actor = actor.clone();
                let target = query.target.clone();
                let params: NodePackageInstallParams = decode(&query.params)?;
                blocking(move || manager.authorize_inspection(&actor, &target, &params)).await?;
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
            | BuiltinAction::TransferReadProgress
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
                    BuiltinAction::TransferReadProgress => {
                        let params: FileTransferReadProgressParams = decode(&query.params)?;
                        require_reference_target(&query.target, &params.receipts_ref)?;
                        files.authorize_receipts(&params.receipts_ref, &actor)
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
        self.activity_with_reveal(actor, query, action_reveal(action, &query.target))
    }
    fn activity_with_reveal(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        mut reveal_target: RevealTarget,
    ) -> HostResult<()> {
        reveal_target.result_ref = None;
        self.record_activity(ActivitySummary {
            activity_id: new_id(),
            actor_id: actor.id().clone(),
            action_id: query.action_id.clone(),
            request_id: query.request_id.clone(),
            target: query.target.clone(),
            reveal_target,
            observations: 1.into(),
            observed_at: self.inner.clock.wall_time(),
            mcp_client_id: actor.mcp_client_id().cloned(),
            operation_id: None,
        })
    }
    fn record_activity(&self, activity: ActivitySummary) -> HostResult<()> {
        let shared_target = (activity.mcp_client_id.is_some()
            && activity.target.kind.as_str() == "session")
            .then(|| activity.target.clone());
        let mut activities = self.inner.activities.lock().map_err(|_| busy())?;
        if let Some((existing, _)) = activities.records.iter_mut().find(|(entry, _)| {
            activity.operation_id.is_none()
                && entry.operation_id.is_none()
                && entry.actor_id == activity.actor_id
                && entry.request_id == activity.request_id
        }) {
            if existing.action_id != activity.action_id || existing.target != activity.target {
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Query identity already refers to another activity",
                ));
            }
            existing.observations = existing.observations.checked_next()?;
        } else {
            // 活动是整份投影，须为 wire 信封和 U64 观察次数增长预留空间。
            let bytes = serde_json::to_vec(&activity).map_err(|_| invalid())?.len() + 21;
            let limit = serial_workbench_ipc::frame::MAX_FRAME_BYTES * 3 / 4;
            while activities.records.len() >= 1024 || activities.reserved + bytes > limit {
                let Some((_, retired)) = activities.records.pop_front() else {
                    return Err(invalid());
                };
                activities.reserved -= retired;
            }
            activities.records.push_back((activity, bytes));
            activities.reserved += bytes;
        }
        self.publish_activity(&activities)?;
        if let Some(target) = shared_target {
            self.publish_session_activity(&activities, &target)?;
        }
        Ok(())
    }
    fn publish_session_activity(
        &self,
        activities: &ActivityLog,
        target: &Target,
    ) -> HostResult<()> {
        let mut items: Vec<_> = activities
            .records
            .iter()
            .rev()
            .map(|(item, _)| item)
            .filter(|item| item.mcp_client_id.is_some() && &item.target == target)
            .take(32)
            .collect();
        items.reverse();
        let state = object(serde_json::json!({"items":items}))?;
        let result = self.inner.projections.commit_for_current_target(
            &crate::state::session_activity_scope(&target.id)?,
            target,
            id("activity.changed"),
            state.clone(),
            state,
        );
        match result {
            Ok(_) => Ok(()),
            // 迟到查询或操作观察不能附着到同一串口的新会话代次。
            Err(error) if matches!(error.code.as_str(), "NOT_FOUND" | "EPOCH_MISMATCH") => Ok(()),
            Err(error) => Err(error),
        }
    }
    fn publish_activity(&self, activities: &ActivityLog) -> HostResult<()> {
        // 这里只发布活动元数据，params、正文、令牌及错误详情不进入共享投影。
        let items: Vec<_> = activities.records.iter().map(|(item, _)| item).collect();
        let mut state = object(serde_json::json!({"items":items}))?;
        if let Some(pending) = &activities.pending_takeover {
            let value = serde_json::to_value(&pending.summary).map_err(|_| invalid())?;
            state.insert(
                "pendingTakeover".into(),
                serde_json::from_value(value).map_err(|_| invalid())?,
            );
        }
        self.inner.projections.commit(
            &id("host.activity"),
            id("activity.changed"),
            state.clone(),
            state,
        )?;
        Ok(())
    }
    async fn observe_mcp_operation(&self, actor: &AuthenticatedActor, operation: &Operation) {
        let Some(client_id) = actor.mcp_client_id() else {
            return;
        };
        let mut reveal_target = operation.reveal_target.clone();
        reveal_target.result_ref = None;
        let activity = ActivitySummary {
            activity_id: new_id(),
            actor_id: operation.actor_id.clone(),
            action_id: operation.action_id.clone(),
            request_id: operation.request_id.clone(),
            target: operation.target.clone(),
            reveal_target,
            observations: 1.into(),
            observed_at: operation.accepted_at.clone(),
            mcp_client_id: Some(client_id.clone()),
            operation_id: Some(operation.operation_id.clone()),
        };
        let host = self.clone();
        if let Err(error) = blocking(move || host.record_activity(activity)).await {
            // 观察失败不撤回已经持久接纳的操作。
            eprintln!("MCP activity publication failed: {}", error.code);
        }
    }
    async fn preflight_node_install(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
    ) -> HostResult<()> {
        let manager = self.inner.node_packages.clone();
        let actor = actor.clone();
        let target = query.target.clone();
        let params: NodePackageInstallParams = decode(&query.params)?;
        blocking(move || manager.authorize(&actor, &target, &params)).await
    }

    pub async fn check_action(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: ActionCheckParams,
    ) -> HostResult<ActionCheckResult> {
        self.check_action_connected(actor, target, params, false)
            .await
    }

    async fn check_action_connected(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: ActionCheckParams,
        paired_browser: bool,
    ) -> HostResult<ActionCheckResult> {
        if BuiltinAction::find(params.action_id.as_str()).is_err() {
            return self.check_extension_query(actor, target, params).await;
        }
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
            protocol_version: ProtocolVersion::V1_0,
            host_id: identity.host_id.clone(),
            instance_epoch: identity.instance_epoch,
            actor_id: actor.id().clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
            action_id: params.action_id.clone(),
            target: target.clone(),
            params: params.params,
            reveal_target: spec.reveal_target.clone(),
        };
        let authorization = match self.validate(actor, &query, spec.kind).await {
            Ok(BuiltinAction::NodePackagesInstall) => self
                .preflight_node_install(actor, &query)
                .await
                .map(|()| BuiltinAction::NodePackagesInstall),
            Ok(BuiltinAction::NodeViewAssetRead) => self
                .check_node_view_asset(actor, &query, paired_browser)
                .await
                .map(|()| BuiltinAction::NodeViewAssetRead),
            result => result,
        };
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
        self.query_connected(actor, query, None, true)
            .await
            .map(|output| output.result)
    }
    async fn query_connected(
        &self,
        actor: &AuthenticatedActor,
        query: Query,
        connection: Option<ConnectionContext>,
        observe: bool,
    ) -> HostResult<QueryOutput> {
        if BuiltinAction::find(query.action_id.as_str()).is_err() {
            return self
                .query_extension(actor, query)
                .await
                .map(|result| QueryOutput {
                    result,
                    raw_output_lease: None,
                });
        }
        let action = self.validate(actor, &query, ActionKind::Query).await?;
        if observe
            && !matches!(
                action,
                BuiltinAction::ActionCheck
                    | BuiltinAction::WorkspaceImportPreview
                    | BuiltinAction::ExperimentExport
                    | BuiltinAction::ExperimentInspect
                    | BuiltinAction::SessionMetrics
                    | BuiltinAction::SessionInputs
                    | BuiltinAction::HostMetrics
                    | BuiltinAction::OperationGet
                    | BuiltinAction::NodeViewAssetRead
                    | BuiltinAction::NodeThemesList
                    | BuiltinAction::StateScopes
                    | BuiltinAction::StateSnapshot
                    | BuiltinAction::StateSubscribe
                    | BuiltinAction::SubscriptionClose
                    | BuiltinAction::StreamCursor
                    | BuiltinAction::StreamRead
                    | BuiltinAction::StreamDerivedRead
                    | BuiltinAction::StreamSubscribe
                    | BuiltinAction::StreamCredit
            )
        {
            // 传输、投影和任务轮询不再观测自身；否则一次更新会放大为整份活动历史。
            // 显式查询仍保留活动，但序列化/投影提交不能阻塞异步 I/O 调度线程。
            let host = self.clone();
            let observer = actor.clone();
            let observed = query.clone();
            blocking(move || host.activity(&observer, &observed, action)).await?;
        }
        let paired_browser = connection
            .as_ref()
            .is_some_and(|context| context.browser_stopped.is_some());
        let result = match action {
            BuiltinAction::ActionCheck => self
                .check_action_connected(
                    actor,
                    &query.target,
                    decode(&query.params)?,
                    paired_browser,
                )
                .await
                .map(QueryResult::ActionCheck),
            BuiltinAction::ExperimentExport => self
                .experiment_export(actor, query)
                .await
                .map(|package| QueryResult::ExperimentPackage(Box::new(package))),
            BuiltinAction::ExperimentInspect => self
                .experiment_inspect(actor, query)
                .await
                .map(|preview| QueryResult::ExperimentInspection(Box::new(preview))),
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
            BuiltinAction::NodeThemesList => {
                let registry = self.inner.registry.clone();
                let actor = actor.clone();
                blocking(move || {
                    registry
                        .node_themes(&actor, &query.target)
                        .map(QueryResult::NodeThemes)
                })
                .await
            }
            BuiltinAction::NodePackagesList => {
                let params: NodePackageListParams = decode(&query.params)?;
                let manager = self.inner.node_packages.clone();
                let actor = actor.clone();
                blocking(move || {
                    manager
                        .list(&actor, &query.target, params)
                        .map(QueryResult::NodePackages)
                })
                .await
            }
            BuiltinAction::NodeViewAssetRead => self
                .read_node_view_asset(actor, query.target, decode(&query.params)?, paired_browser)
                .await
                .map(|asset| QueryResult::NodeViewAsset(Box::new(asset))),
            BuiltinAction::NodePackageRuntime => {
                let params: NodePackageRuntimeParams = decode(&query.params)?;
                let manager = self.inner.node_packages.clone();
                let actor = actor.clone();
                blocking(move || {
                    manager
                        .runtime_status(&actor, &query.target, params)
                        .map(QueryResult::NodePackageRuntime)
                })
                .await
            }
            BuiltinAction::NodeSourcesList => {
                let params: NodeSourceListParams = decode(&query.params)?;
                let manager = self.inner.node_packages.clone();
                let actor = actor.clone();
                blocking(move || {
                    manager
                        .sources_list(&actor, &query.target, params)
                        .map(QueryResult::NodePackageSources)
                })
                .await
            }
            BuiltinAction::NodePackageDetailsRead => {
                let params: NodePackageDetailsReadParams = decode(&query.params)?;
                let manager = self.inner.node_packages.clone();
                let actor = actor.clone();
                blocking(move || {
                    manager
                        .details_read(&actor, &query.target, params)
                        .map(QueryResult::NodePackageDetails)
                })
                .await
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
                let host = self.clone();
                let mut metrics = blocking(move || {
                    let mut metrics = crate::metrics::snapshot(
                        &store.identity()?,
                        stream,
                        capture,
                        clock.as_ref(),
                    )?;
                    metrics.derived = Some(host.inner.derived.memory_usage()?);
                    Ok(metrics)
                })
                .await?;
                // 阻塞快照之后再复核实际Node，避免把等待期间已退出的实例缓存带入回执。
                metrics.node = self.inner.node_packages.metrics();
                Ok(QueryResult::HostMetrics(metrics))
            }
            action if action.is_capture_api() => {
                if matches!(
                    action,
                    BuiltinAction::ReplayRead
                        | BuiltinAction::ReplaySearch
                        | BuiltinAction::CaptureTail
                ) && connection.is_none()
                {
                    return Err(HostError::new(
                        "CLIENT_REQUIRED",
                        "Capture content requires a raw connection",
                    ));
                }
                self.inner
                    .capture_api
                    .query(action, &query, actor, connection.as_ref())
                    .await
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
            | BuiltinAction::TransferReceiptsRead
            | BuiltinAction::TransferReadProgress => {
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
                        BuiltinAction::TransferReadProgress => {
                            let params: FileTransferReadProgressParams = decode(&query.params)?;
                            let reference = params.receipts_ref;
                            require_reference_target(&query.target, &reference)?;
                            let progress = files.read_transfer_progress(&reference, &actor)?;
                            QueryResult::FileTransferReadProgress(progress)
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
            | BuiltinAction::WorkspaceExport
            | BuiltinAction::CommandLibraryRead => {
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
            BuiltinAction::StreamDerivedRead => {
                let _context = connection.ok_or_else(|| {
                    HostError::new(
                        "CLIENT_REQUIRED",
                        "Derived reads require a Raw data connection",
                    )
                })?;
                let params: DerivedReadParams = decode(&query.params)?;
                let host = self.clone();
                let (result, lease) = blocking(move || {
                    host.inner
                        .derived
                        .read(&query.target, query.instance_epoch, params)
                })
                .await?;
                return Ok(QueryOutput {
                    result: QueryResult::StreamDerivedRead(result),
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
                let listed = if let Some(runtime) = &self.inner.device_runtime {
                    runtime.list()?
                } else {
                    DeviceList {
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
                    }
                };
                let auth = self.inner.auth.clone();
                let device_service = self.inner.devices.clone();
                let actor = actor.clone();
                let host_id = query.target.host_id.clone();
                let listed = blocking(move || {
                    filter_lan_devices(&auth, &actor, &device_service, host_id, listed)
                })
                .await?;
                Ok(QueryResult::Devices(listed))
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
                let supports_events = connection
                    .as_ref()
                    .is_none_or(|context| context.supports_events);
                if let Some(context) = connection
                    && supports_events
                {
                    self.ensure_catalog_watch(context).await?;
                }
                let registry = self.inner.registry.clone();
                let actor = actor.clone();
                Ok(QueryResult::Catalog(
                    blocking(move || registry.list_for_delivery(&actor, params, supports_events))
                        .await?,
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
        let mut runtime_changes = self.inner.registry.runtime.subscribe();
        runtime_changes.borrow_and_update();
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
                    result = runtime_changes.changed() => if result.is_err() { break; },
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
                let authorization_changed =
                    next.stamp.as_ref().map(GrantStamp::revision_and_expiry)
                        != current.stamp.as_ref().map(GrantStamp::revision_and_expiry);
                if (authorization_changed
                    || next.version != current.version
                    || next.token != current.token)
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
    pub async fn invoke(&self, actor: &AuthenticatedActor, call: Call) -> HostResult<Operation> {
        self.invoke_with_browser_file(actor, call, None).await
    }

    async fn invoke_with_browser_file(
        &self,
        actor: &AuthenticatedActor,
        mut call: Call,
        browser_file: Option<browser_file::BrowserFileAdmission>,
    ) -> HostResult<Operation> {
        if BuiltinAction::find(call.action_id.as_str()).is_err() {
            return self.invoke_extension(actor, call).await;
        }
        let query = call_query(&call);
        let action = self
            .validate_source(actor, &query, ActionKind::Action, browser_file.as_ref())
            .await?;
        let replay_session = call.target.kind.as_str() == "session"
            && self.inner.capture_api.owns_replay(&call.target.id);
        if replay_session && action == BuiltinAction::ToolHandoff {
            return Err(HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "External tools require a native serial session",
            ));
        }
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
            action if action.is_node_mutation() => {
                if call.expected_revision.is_none() {
                    return Err(invalid());
                }
                match action {
                    BuiltinAction::NodePackagesInstall => {
                        normalize::<NodePackageInstallParams>(&call.params)?
                    }
                    BuiltinAction::NodePackageConfirmExecutionTrust
                    | BuiltinAction::NodePackageRevokeExecutionTrust
                    | BuiltinAction::NodePackageUninstall => {
                        normalize::<NodePackageIdentityParams>(&call.params)?
                    }
                    BuiltinAction::NodePackageSetEnabled => {
                        normalize::<NodePackageSetEnabledParams>(&call.params)?
                    }
                    BuiltinAction::NodeSourceApproveKey => {
                        normalize::<NodeSourceApproveParams>(&call.params)?
                    }
                    BuiltinAction::NodeSourceRevokeKey => {
                        normalize::<NodeSourceRevokeParams>(&call.params)?
                    }
                    _ => return Err(invalid()),
                }
            }
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
        if let Some(mut existing) = blocking(move || {
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
            operation_inspection::redact_error_details(&mut existing);
            return Ok(existing);
        }
        if action == BuiltinAction::NodePackagesInstall {
            // 当前读授权已通过；只有尚未接纳的新请求才复核安装输入和来源。
            self.preflight_node_install(actor, &call_query(&call))
                .await?;
        }
        if action == BuiltinAction::TransferFile && browser_file.is_none() {
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
                    .admission(crate::limits::is_stop(call.action_id.as_str()), Some(&call))
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
            actor.mark_admission_queued();
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
                let accept_host = host.clone();
                let acceptance = blocking(move || {
                    if action == BuiltinAction::ToolHandoff {
                        accept_auth.require_control(&accept_actor)?;
                    }
                    let authority = accept_auth.snapshot(&accept_actor)?;
                    let stamp = if device_action && accept_call.target.kind.as_str() == "session" {
                        if matches!(
                            action,
                            BuiltinAction::SessionTakeover | BuiltinAction::ToolHandoff
                        ) {
                            authority.require("auth.manage", &accept_call.target)?;
                            authority.capture_grants()
                        } else {
                            authority.require("device.modify", &accept_call.target)?;
                            authority.capture_session_write_grants(&accept_call.target)
                        }
                    } else {
                        authority.capture_grants()
                    };
                    let digest = canonical_digest(&accept_call)?;
                    let (acceptance, browser_stamp, upload) = if let Some(handoff) = browser_file {
                        handoff.accept(&accept_host, &accept_call, &digest)?
                    } else {
                        (
                            store.accept_with_source(
                                &accept_actor,
                                &accept_call,
                                &digest,
                                operation_source.as_ref(),
                            )?,
                            None,
                            None,
                        )
                    };
                    let stamp = browser_stamp.or(stamp);
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
                    Ok((acceptance, stamp, upload))
                })
                .await;
                match acceptance {
                    Err(error) => {
                        let _ = send.send(Err(error));
                    }
                    Ok((Acceptance::Existing(mut operation), _, _)) => {
                        operation_inspection::redact_error_details(&mut operation);
                        let _ = send.send(Ok(operation));
                    }
                    Ok((Acceptance::New(operation), stamp, upload)) => {
                        let mut call = call;
                        call.request_id = operation.request_id.clone();
                        host.observe_mcp_operation(&actor, &operation).await;
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
                            let mut preparation = preparation.expect("device preparation");
                            if let Some(upload) = upload {
                                preparation.set_browser_file(upload);
                            }
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
                                    preparation,
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
                            stamp,
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
    async fn execute_short(
        &self,
        action: BuiltinAction,
        accepted: AcceptedCall,
        stamp: Option<GrantStamp>,
    ) {
        if action.is_node_mutation()
            || action.is_capture_api()
            || (action == BuiltinAction::SessionClose
                && self.inner.capture_api.owns_replay(&accepted.call.target.id))
        {
            let outcome = if action.is_node_mutation() {
                self.inner.node_packages.execute(&accepted, stamp).await
            } else {
                self.inner.capture_api.execute(action, &accepted).await
            }
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
                        if descriptor.fingerprint.transport == DeviceTransportKind::Plugin {
                            return Err(HostError::new(
                                "UNSUPPORTED_CAPABILITY",
                                "Plugin transport bindings need explicit parameters",
                            ));
                        }
                        if directory.stale
                            && matches!(
                                descriptor.fingerprint.transport,
                                DeviceTransportKind::Serial | DeviceTransportKind::Pty
                            )
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
                let outcome = documents.execute(
                    &files,
                    &accepted.actor,
                    &accepted.call,
                    action,
                    descriptor,
                    &operation_id,
                );
                // 命令库将结果证据和数据写入同一事务；其余文档沿用独立回执。
                if !matches!(
                    action,
                    BuiltinAction::CommandLibraryChange | BuiltinAction::CommandLibraryImport
                ) && let Some(result) = &outcome.result
                {
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
            let readable = || auth.require(&actor, "metadata.read", &target);
            if !actor.is_user_control() {
                readable()?;
            }
            // TransmissionService::cancel and Store::request_cancel check ownership again
            // before signalling or changing state.
            let operation = store.get(&actor, &target.id)?;
            if operation.action_id.as_str() == "session.toolHandoff" {
                auth.require_control(&actor)
            } else if actor.is_user_control() {
                readable()
            } else {
                Ok(())
            }
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
            let observe = !matches!(request, RpcRequest::CatalogList(_));
            let actor = context.actor.clone();
            let mut raw_output_lease = None;
            let result = match request {
                RpcRequest::BrowserFileHandoff(params) => {
                    host.browser_file_handoff(context, params).await?
                }
                RpcRequest::BrowserTakeover(params) => {
                    host.browser_takeover(context, params).await?
                }
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
                    let acknowledged = match params {
                        ClientReceiptSubmission::UpdatePreparation(preparation) => {
                            host.prepare_client_update(context, preparation).await?
                        }
                        receipt => {
                            let clients = host.inner.client_effects.clone();
                            blocking(move || clients.receipt(&context, receipt)).await?
                        }
                    };
                    RpcResult::ClientEffectAcknowledged(acknowledged)
                }
                RpcRequest::Invoke(call) | RpcRequest::OperationCancel(call) => {
                    RpcResult::Operation(Box::new(OperationResult {
                        operation: host.invoke(&actor, call).await?,
                    }))
                }
                RpcRequest::InvokeChild(call) => RpcResult::Operation(Box::new(OperationResult {
                    operation: host.invoke_child(&actor, call).await?,
                })),
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
                    let output = host
                        .query_connected(&actor, q, Some(context), observe)
                        .await?;
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
        self.inner
            .capture_api
            .release_search_connection(&context.connection_id);
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
fn filter_lan_devices(
    auth: &AuthService,
    actor: &AuthenticatedActor,
    service: &DeviceService,
    host_id: Id,
    mut listed: DeviceList,
) -> HostResult<DeviceList> {
    let authorization = auth.snapshot(actor)?;
    if !authorization.is_lan_peer() {
        return Ok(listed);
    }
    let mut visible_sessions = std::collections::HashSet::new();
    for session in service.sessions()? {
        let snapshot = session.snapshot()?;
        if authorization
            .require(
                "metadata.read",
                &Target {
                    host_id: host_id.clone(),
                    kind: ResourceKind::try_from("session")?,
                    id: snapshot.session_id.clone(),
                    session_id: Some(snapshot.session_id),
                    session_epoch: Some(snapshot.session_epoch),
                },
            )
            .is_ok()
        {
            visible_sessions.insert(snapshot.device_id);
        }
    }
    let device_kind = ResourceKind::try_from("device")?;
    listed.devices.retain_mut(|device| {
        let explicitly_shared = authorization
            .require(
                "metadata.read",
                &Target {
                    host_id: device.host_id.clone(),
                    kind: device_kind.clone(),
                    id: device.device_id.clone(),
                    session_id: None,
                    session_epoch: None,
                },
            )
            .is_ok();
        if explicitly_shared {
            return true;
        }
        if !visible_sessions.contains(&device.device_id) {
            return false;
        }
        device.description = None;
        device.manufacturer = None;
        device.driver = None;
        device.fingerprint = DeviceFingerprint {
            transport: device.fingerprint.transport,
            evidence: IdentityEvidence::Unreliable,
            vid: None,
            pid: None,
            serial_number: None,
            topology_path: None,
        };
        true
    });
    Ok(listed)
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
    reveal.session_id = target.session_id.clone();
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
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct BundledSlavePeer {
        serving: AtomicBool,
        incoming: Mutex<VecDeque<Vec<u8>>>,
        replies: Mutex<Vec<Vec<u8>>>,
        retry_response: Mutex<Option<(Vec<u8>, Vec<u8>)>>,
    }

    struct BundledPeerTransport {
        inner: Box<dyn Transport>,
        peer: Arc<BundledSlavePeer>,
    }

    impl Transport for BundledPeerTransport {
        fn capabilities(&self) -> TransportCapabilities {
            self.inner.capabilities()
        }
        fn read(&mut self, limit: usize, wait: std::time::Duration) -> BackendResult<ReadBlock> {
            let echo = self.inner.read(limit, wait)?;
            if !self.peer.serving.load(Ordering::Acquire) {
                return Ok(echo);
            }
            let mut queue = self.peer.incoming.lock().unwrap();
            let mut bytes = queue.pop_front().unwrap_or_default();
            if bytes.len() > limit {
                queue.push_front(bytes.split_off(limit));
            }
            Ok(ReadBlock {
                bytes: Arc::from(bytes),
                message: None,
            })
        }
        fn begin_write(
            &mut self,
            bytes: WritePayload,
            wait: std::time::Duration,
            cancelled: Arc<AtomicBool>,
            closing: Arc<AtomicBool>,
        ) -> BackendResult<Box<dyn PendingWrite>> {
            if self.peer.serving.load(Ordering::Acquire) {
                self.peer.replies.lock().unwrap().push(bytes.to_vec());
                if let Some((request, response)) = self.peer.retry_response.lock().unwrap().as_ref()
                    && &*bytes == request.as_slice()
                {
                    self.peer
                        .incoming
                        .lock()
                        .unwrap()
                        .push_back(response.clone());
                }
            }
            self.inner.begin_write(bytes, wait, cancelled, closing)
        }
        fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
            self.inner.configure(config)
        }
        fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
            self.inner.control(command)
        }
        fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
            self.inner.begin_drain(request)
        }
        fn close(&mut self) -> BackendResult<()> {
            self.inner.close()
        }
    }

    #[tokio::test]
    #[ignore = "Needs a verified native Node distribution in SWB_NODE_RUNTIME_TEST_ROOT"]
    async fn native_node_bundled_protocol_registers_on_first_start_and_restart() {
        use crate::node_runtime::{NodeRuntimeLimits, verify_node_runtime};
        use std::{path::PathBuf, time::Duration};

        let root = PathBuf::from(std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap());
        let profile = crate::test_support::Profile::isolated("host-bundled-framing-");
        let framing = NodePackageId::try_from("swb.reference.framing").unwrap();
        let fields = NodePackageId::try_from("swb.reference.fields").unwrap();
        let modbus = NodePackageId::try_from("swb.reference.modbus").unwrap();
        let slave = NodePackageId::try_from("swb.reference.modbus.slave").unwrap();
        let chart = NodePackageId::try_from("swb.builtin.chart").unwrap();
        let automation = NodePackageId::try_from("swb.builtin.automation").unwrap();
        let tcp = NodePackageId::try_from("swb.builtin.tcp").unwrap();
        let rfc2217 = NodePackageId::try_from("swb.builtin.rfc2217").unwrap();
        let peer = Arc::new(BundledSlavePeer::default());
        let mut first_revision = None;
        let mut pending_calendar: Option<(Id, tokio::time::Instant, ContextToken)> = None;
        for epoch in [1_u64, 2] {
            let server = HostServer::bind(profile.path()).await.unwrap();
            let store = server.store();
            let runtime = verify_node_runtime(
                &root,
                &NodeRuntimeLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
            let host = Host::initialize(
                store.clone(),
                server.auth(),
                Arc::new(crate::clock::SystemClock::new().unwrap()),
                DeviceSource::Opener({
                    let peer = peer.clone();
                    let open = crate::device::DeviceService::virtual_opener();
                    Arc::new(move |id, config| {
                        Ok(Box::new(BundledPeerTransport {
                            inner: open(id, config)?,
                            peer: peer.clone(),
                        }))
                    })
                }),
                Some(StartupConfigSnapshot {
                    profile_reference: StartupProfileReference::HostProfile,
                    profile_source: StartupConfigSource::Argument,
                    log_level: StartupLogLevel::Info,
                    log_level_source: StartupConfigSource::Default,
                }),
                Some(runtime),
            )
            .await
            .unwrap();
            let catalog = &host.inner.registry.runtime;
            let mut updates = catalog.subscribe();
            let statuses = tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    let statuses = [
                        catalog.status(&framing).unwrap(),
                        catalog.status(&fields).unwrap(),
                        catalog.status(&modbus).unwrap(),
                        catalog.status(&slave).unwrap(),
                        catalog.status(&chart).unwrap(),
                        catalog.status(&automation).unwrap(),
                        catalog.status(&tcp).unwrap(),
                        catalog.status(&rfc2217).unwrap(),
                    ];
                    if statuses
                        .iter()
                        .all(|status| status.phase == NodePackageRuntimePhase::Active)
                        || statuses
                            .iter()
                            .any(|status| status.phase == NodePackageRuntimePhase::Failed)
                    {
                        break statuses;
                    }
                    updates.changed().await.unwrap();
                }
            })
            .await;
            let registered = catalog.snapshot().map(|(_, handlers)| {
                [
                    (&framing, "swb.reference.framing.scan"),
                    (&fields, "swb.reference.fields.decode"),
                    (&fields, "swb.reference.fields.encode"),
                    (&fields, "swb.reference.fields.identifyCrc"),
                    (&fields, "swb.reference.fields.modbus"),
                    (&fields, "swb.reference.fields.modbusServer"),
                    (&fields, "swb.reference.fields.nmea"),
                    (&fields, "swb.reference.fields.at"),
                    (&fields, "swb.reference.fields.compareSessions"),
                    (&modbus, "swb.reference.modbus.transaction"),
                    (&slave, "swb.reference.modbus.slave.serve"),
                    (&chart, "swb.builtin.chart.sample"),
                    (&chart, "swb.builtin.chart.exportSvg"),
                    (&chart, "swb.builtin.chart.exportCsv"),
                    (&chart, "swb.builtin.chart.exportPng"),
                    (&automation, "swb.builtin.automation.repeat"),
                    (&automation, "swb.builtin.automation.sequence"),
                    (&automation, "swb.builtin.automation.rule"),
                    (&automation, "swb.builtin.automation.calendar"),
                ]
                .into_iter()
                .all(|(package, action)| {
                    handlers.iter().any(|handler| {
                        handler.package() == package && handler.spec().action_id.as_str() == action
                    })
                })
            });
            let transports_registered =
                host.inner
                    .node_packages
                    .registered_transports()
                    .map(|items| {
                        let host_id = store.identity().unwrap().host_id;
                        let devices: Vec<_> =
                            items.iter().map(|item| item.descriptor(&host_id)).collect();
                        [
                            (&tcp, "swb.builtin.tcp.transport"),
                            (&rfc2217, "swb.builtin.rfc2217.transport"),
                        ]
                        .into_iter()
                        .all(|(package, contribution)| {
                            devices.iter().any(|device| {
                                device.system_name == contribution
                                    && device.driver.as_deref() == Some(package.as_str())
                            })
                        })
                    });
            let execution = if epoch == 1 && registered.as_ref().is_ok_and(|active| *active) {
                Some(
                    tokio::spawn(check_bundled_field_actions(
                        host.clone(),
                        profile.path().to_path_buf(),
                        peer.clone(),
                    ))
                    .await,
                )
            } else {
                None
            };
            if epoch == 2 {
                let (operation_id, check_after, credential) = pending_calendar.as_ref().unwrap();
                let actor = server
                    .auth()
                    .authenticate(&id("bundled-fields-operator"), Some(credential))
                    .unwrap()
                    .actor;
                let before = store.get(&actor, operation_id).unwrap();
                match before.state {
                    OperationState::Cancelled | OperationState::Interrupted => {}
                    OperationState::Failed => {
                        assert_eq!(before.error.as_ref().unwrap().code, "NODE_ACTION_FAILED");
                    }
                    _ => panic!("shutdown did not end the armed calendar task: {before:?}"),
                }
                assert_eq!(before.child_high_watermark, 0.into());
                tokio::time::sleep_until(*check_after).await;
                let after = store.get(&actor, operation_id).unwrap();
                assert_eq!(after.state, before.state);
                assert_eq!(after.revision, before.revision);
                assert_eq!(after.child_high_watermark, 0.into());
                eprintln!(
                    "bundled_calendar_restart terminal_before_due=true no_child_after_original_due=true"
                );
            }
            host.shutdown().await.unwrap();
            let statuses =
                statuses.expect("bundled protocol packages reached a terminal registration phase");
            assert!(
                statuses
                    .iter()
                    .all(|status| status.phase == NodePackageRuntimePhase::Active),
                "{statuses:?}"
            );
            assert!(registered.unwrap());
            assert!(
                transports_registered.unwrap(),
                "bundled TCP and RFC 2217 providers were not registered"
            );
            if let Some(execution) = execution {
                pending_calendar = Some(execution.expect("bundled field actions on the real Host"));
            }
            assert_eq!(store.identity().unwrap().instance_epoch, U64::from(epoch));
            let installed =
                crate::node_packages::NodePackageInstaller::read_snapshot(&store).unwrap();
            assert_eq!(installed.packages.len(), statuses.len());
            for status in statuses {
                let package = installed
                    .packages
                    .iter()
                    .find(|package| package.manifest.id == status.id)
                    .unwrap();
                assert_eq!(
                    status.archive_sha256.as_ref(),
                    Some(&package.archive_sha256)
                );
                if status.id == rfc2217 {
                    let descriptor: serde_json::Value = serde_json::from_str(include_str!(
                        "../resources/node-packages/rfc2217.json"
                    ))
                    .unwrap();
                    assert_eq!(
                        package.archive_sha256.as_str(),
                        descriptor["archiveSha256"].as_str().unwrap()
                    );
                    assert_eq!(
                        package.verified_source.as_ref().unwrap().source.as_str(),
                        "swb.product"
                    );
                    eprintln!(
                        "bundled_rfc2217 epoch={epoch} archive={} source=swb.product active=true",
                        package.archive_sha256
                    );
                }
            }
            let revision = first_revision.get_or_insert(installed.revision);
            assert_eq!(installed.revision, *revision);
            drop(host);
            drop(server);
        }
    }

    #[tokio::test]
    #[ignore = "Needs a verified native Node distribution in SWB_NODE_RUNTIME_TEST_ROOT"]
    async fn native_node_bundled_tcp_opens_both_roles_and_sends_exact_bytes() {
        use crate::node_runtime::{NodeRuntimeLimits, verify_node_runtime};
        use base64::{Engine, engine::general_purpose::STANDARD};
        use std::{net::Ipv4Addr, path::Path, time::Duration};
        use tokio::{
            io::AsyncReadExt,
            net::{TcpListener, TcpStream},
            time::timeout,
        };

        let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap();
        let profile = crate::test_support::Profile::isolated("host-bundled-tcp-");
        let server = HostServer::bind(profile.path()).await.unwrap();
        let runtime = verify_node_runtime(
            Path::new(&root),
            &NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
        let host = Host::initialize(
            server.store(),
            server.auth(),
            Arc::new(crate::clock::SystemClock::new().unwrap()),
            DeviceSource::Native,
            Some(StartupConfigSnapshot {
                profile_reference: StartupProfileReference::HostProfile,
                profile_source: StartupConfigSource::Argument,
                log_level: StartupLogLevel::Info,
                log_level_source: StartupConfigSource::Default,
            }),
            Some(runtime),
        )
        .await
        .unwrap();
        let credential =
            serial_workbench_client::read_user_control_credential(profile.path()).unwrap();
        let check = tokio::spawn({
            let host = host.clone();
            async move {
                let catalog = &host.inner.registry.runtime;
                let mut updates = catalog.subscribe();
                let package = NodePackageId::try_from("swb.builtin.tcp").unwrap();
                timeout(Duration::from_secs(30), async {
                    loop {
                        let status = catalog.status(&package).unwrap();
                        if status.phase == NodePackageRuntimePhase::Active {
                            break;
                        }
                        assert_ne!(status.phase, NodePackageRuntimePhase::Failed, "{status:?}");
                        updates.changed().await.unwrap();
                    }
                })
                .await
                .unwrap();

                let devices = host.inner.device_runtime.as_ref().unwrap().refresh().await.unwrap();
                let tcp = devices
                    .devices
                    .iter()
                    .find(|device| device.system_name == "swb.builtin.tcp.transport"
                        && device.driver.as_deref() == Some("swb.builtin.tcp"))
                    .expect("Expected the bundled TCP device in the live directory");
                let auth = &host.inner.auth;
                let store = &host.inner.store;
                let identity = store.identity().unwrap();
                let client = id("bundled-tcp-client");
                let actor = auth.authenticate(&client, None).unwrap().actor;
                let operator = auth.authenticate_user_control(&id("bundled-tcp-operator"), &credential).unwrap();
                let device = Target {
                    host_id: identity.host_id.clone(),
                    kind: ResourceKind::try_from("device").unwrap(),
                    id: tcp.device_id.clone(),
                    session_id: None,
                    session_epoch: None,
                };
                let grant = |target: &Target, permissions: Vec<String>| {
                    auth.authorize(&operator, AuthorizeParams {
                        client_id: client.clone(),
                        permissions,
                        targets: vec![target.clone()],
                        expires_at: None,
                    }).unwrap();
                };
                let call = |target: &Target, action: &str, params: serde_json::Value| Call {
                    protocol_version: ProtocolVersion::V1_0,
                    host_id: identity.host_id.clone(),
                    instance_epoch: identity.instance_epoch,
                    actor_id: actor.id().clone(),
                    request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
                    request_context: store.issue_context(&actor).unwrap().token,
                    action_id: id(action),
                    target: target.clone(),
                    params: serde_json::from_value(params).unwrap(),
                    reveal_target: serde_json::from_value(serde_json::json!({"pageId":"workbench"})).unwrap(),
                    expected_revision: None,
                    lease_id: None,
                    execution_mode: None,
                };
                let wait = Duration::from_secs(5);
                let settled = |operation: Operation| {
                    let actor = actor.clone();
                    async move {
                        timeout(wait, async {
                            loop {
                                let current = store.get(&actor, &operation.operation_id).unwrap();
                                if current.state.is_terminal() {
                                    assert_eq!(current.state, OperationState::Succeeded, "{current:?}");
                                    break current.result.unwrap();
                                }
                                tokio::time::sleep(Duration::from_millis(10)).await;
                            }
                        })
                        .await
                        .unwrap()
                    }
                };

                grant(&device, vec!["device.modify".into()]);
                let mut previous_epoch = None;
                for role in ["client", "server"] {
                    let reserved = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
                    let endpoint = reserved.local_addr().unwrap();
                    let mut listener = Some(reserved);
                    if role == "server" {
                        drop(listener.take());
                    }
                    let opened = host.invoke(&actor, call(&device, "device.open", serde_json::json!({
                        "configuration": SerialConfiguration::default(),
                        "transportParams": {"role":role,"host":"127.0.0.1","port":endpoint.port()},
                    }))).await.unwrap();
                    let ActionResult::Opened(opened) = settled(opened).await else {
                        panic!("Expected a live TCP session");
                    };
                    assert!(!opened.reused);
                    assert!(previous_epoch.is_none_or(|epoch| opened.session_epoch > epoch));
                    previous_epoch = Some(opened.session_epoch);
                    let session = Target {
                        kind: ResourceKind::try_from("session").unwrap(),
                        id: opened.session_id.clone(),
                        session_id: Some(opened.session_id),
                        session_epoch: Some(opened.session_epoch),
                        ..device.clone()
                    };
                    let mut peer = if let Some(listener) = listener {
                        timeout(wait, listener.accept()).await.unwrap().unwrap().0
                    } else {
                        timeout(wait, TcpStream::connect(endpoint)).await.unwrap().unwrap()
                    };
                    grant(&session, vec!["device.modify".into(), "content.read".into()]);
                    let sample = [0, 0xff, 13, 10, 128];
                    let accepted = host.invoke(&actor, call(&session, "session.tx", serde_json::json!({
                        "bytesBase64":STANDARD.encode(sample),"writeWaitMs":"1000",
                    }))).await.unwrap();
                    let ActionResult::Tx(receipt) = settled(accepted).await else {
                        panic!("Expected an actual TX receipt");
                    };
                    assert_eq!(receipt.outcome, TxOutcome::Accepted);
                    assert_eq!(receipt.session_epoch, opened.session_epoch);
                    let mut received = [0; 5];
                    timeout(wait, peer.read_exact(&mut received)).await.unwrap().unwrap();
                    assert_eq!(received, sample);
                    let closing = host.invoke(&actor, call(&session, "session.close", serde_json::json!({}))).await.unwrap();
                    settled(closing).await;
                    assert_eq!(timeout(wait, peer.read(&mut received)).await.unwrap().unwrap(), 0);
                    eprintln!("bundled_tcp role={role} epoch={:?} peer_closed=true exact_bytes={}", opened.session_epoch, received.len());
                }
            }
        }).await;
        host.shutdown().await.unwrap();
        check.unwrap();
    }

    async fn check_bundled_field_actions(
        host: Host,
        profile: std::path::PathBuf,
        peer: Arc<BundledSlavePeer>,
    ) -> (Id, tokio::time::Instant, ContextToken) {
        use base64::{Engine, engine::general_purpose::STANDARD};
        use std::time::Duration;

        let store = &host.inner.store;
        let auth = &host.inner.auth;
        let identity = store.identity().unwrap();
        let client_id = id("bundled-fields-operator");
        let authentication = auth.authenticate(&client_id, None).unwrap();
        let credential = authentication.issued_credential.unwrap();
        let actor = authentication.actor;
        let capability = serial_workbench_client::read_user_control_credential(&profile).unwrap();
        let operator = auth
            .authenticate_user_control(&id("bundled-fields-control"), &capability)
            .unwrap();
        let device = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("virtual:echo"),
            session_id: None,
            session_epoch: None,
        };
        let grant = |permission: &str, target: &Target| {
            auth.authorize(
                &operator,
                AuthorizeParams {
                    client_id: client_id.clone(),
                    permissions: vec![permission.into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        };
        let call = |target: &Target, action: &str, params: serde_json::Value| Call {
            protocol_version: ProtocolVersion::V1_0,
            host_id: identity.host_id.clone(),
            instance_epoch: identity.instance_epoch,
            actor_id: actor.id().clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            request_context: store.issue_context(&actor).unwrap().token,
            action_id: id(action),
            target: target.clone(),
            params: serde_json::from_value(params).unwrap(),
            reveal_target: serde_json::from_value(serde_json::json!({"pageId":"workbench"}))
                .unwrap(),
            expected_revision: None,
            lease_id: None,
            execution_mode: None,
        };
        let settled = |accepted: Operation| {
            let actor = actor.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(15), async {
                    loop {
                        let operation = store.get(&actor, &accepted.operation_id).unwrap();
                        if operation.state.is_terminal() {
                            assert_eq!(operation.state, OperationState::Succeeded, "{operation:?}");
                            break operation.result.unwrap();
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await
                .unwrap()
            }
        };
        grant("device.modify", &device);
        let opened = host
            .invoke(
                &actor,
                call(
                    &device,
                    "device.open",
                    serde_json::json!({"configuration": SerialConfiguration::default()}),
                ),
            )
            .await
            .unwrap();
        let ActionResult::Opened(open) = settled(opened).await else {
            panic!("Expected an open session");
        };
        let session = Target {
            id: open.session_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            session_id: Some(open.session_id),
            session_epoch: Some(open.session_epoch),
            ..device
        };
        let definition = r#"{"version":"1","byteLength":1,"fields":[{"id":"reading","kind":"integer","byteOffset":0,"width":1,"order":"big","calibration":{"kind":"table","revision":"probe-2","interpolation":"linear","points":[{"raw":"64","value":"33"},{"raw":"66","value":"34"}]}}]}"#;
        let decode_params = serde_json::json!({"definition":definition,"bytesBase64":"QQ=="});
        let crc_params = serde_json::json!({
            "width":16,
            "samples":[
                {"bytesBase64":"MTIzNDU2Nzg5","checksumBase64":"N0s="},
                {"bytesBase64":"AQMAAAAK","checksumBase64":"xc0="}
            ]
        });
        let modbus_params = serde_json::json!({
            "mode":"decode","transport":"rtu","direction":"request","bytesBase64":"AQMAAAAKxc0="
        });
        let modbus_compare = serde_json::json!({
            "mode":"compare","transport":"tcp",
            "requestBase64":STANDARD.encode([0, 1, 0, 0, 0, 6, 1, 3, 0, 0, 0, 2]),
            "responseBase64":STANDARD.encode([0, 1, 0, 0, 0, 3, 1, 0x83, 2]),
        });
        let server_request = STANDARD.encode([0, 1, 0, 0, 0, 6, 1, 6, 0, 1, 1, 2]);
        let modbus_server = serde_json::json!({
            "transport":"tcp","requestBase64":&server_request,"model":{
                "unitId":1,
                "tables":{"holdingRegisters":[{"start":0,"values":[12,0]}]}
            }
        });
        let nmea = serde_json::json!({
            "text":"$GPVTG,77.52,T,,M,0.004,N,0.008,K,A*06\r\n$GPVTG,77.52,T,,M,0.004,N,0.008,K,A*00"
        });
        let at_response = serde_json::json!({
            "command":"AT+CREG?",
            "text":"AT+CREG?\r\n+CREG: 5\r\n+CREG: 2,5\r\nOK",
        });
        let comparison = serde_json::json!({
            "baseline": [
                {"position":"1","bytesBase64":"QQ==","time":{"clockId":"base","monoNs":"9007199254740993","segment":0}},
                {"position":"2","bytesBase64":"Qg==","time":{"clockId":"base","monoNs":"9007199254741014","segment":0}}
            ],
            "candidate": [
                {"position":"1","bytesBase64":"Qg==","time":{"clockId":"test","monoNs":"9007199254800000","segment":0}},
                {"position":"2","bytesBase64":"Qg==","time":{"clockId":"test","monoNs":"9007199254800015","segment":0}}
            ],
            "alignment": {"kind":"ordinal"},
            "detail": {"rowIndex":0}
        });
        for (action, params) in [
            ("swb.reference.fields.decode", decode_params.clone()),
            ("swb.reference.fields.identifyCrc", crc_params.clone()),
            ("swb.reference.fields.modbus", modbus_params.clone()),
            ("swb.reference.fields.modbus", modbus_compare.clone()),
            ("swb.reference.fields.modbusServer", modbus_server.clone()),
            ("swb.reference.fields.nmea", nmea.clone()),
            ("swb.reference.fields.at", at_response.clone()),
            ("swb.reference.fields.compareSessions", comparison.clone()),
            (
                "swb.builtin.chart.sample",
                serde_json::json!({"sampleCount":2}),
            ),
            (
                "swb.builtin.chart.exportSvg",
                serde_json::json!({"sampleCount":2}),
            ),
            (
                "swb.builtin.chart.exportCsv",
                serde_json::json!({"sampleCount":2}),
            ),
            (
                "swb.builtin.chart.exportPng",
                serde_json::json!({"sampleCount":2}),
            ),
        ] {
            assert_eq!(
                host.invoke(&actor, call(&session, action, params))
                    .await
                    .unwrap_err()
                    .code,
                "PERMISSION_DENIED"
            );
        }
        grant("content.read", &session);
        peer.serving.store(true, Ordering::Release);
        peer.incoming
            .lock()
            .unwrap()
            .extend([b"1.".to_vec(), b"25\n-2\n".to_vec()]);
        let sample_params = serde_json::json!({"sampleCount":2});
        let sampling = host
            .invoke(
                &actor,
                call(&session, "swb.builtin.chart.sample", sample_params.clone()),
            )
            .await
            .unwrap();
        let sample_operation = sampling.operation_id.clone();
        assert!(matches!(
            settled(sampling).await,
            ActionResult::Reference(_)
        ));
        peer.serving.store(false, Ordering::Release);
        let (page, lease) = host
            .inner
            .derived
            .read(
                &session,
                identity.instance_epoch,
                DerivedReadParams {
                    operation_id: sample_operation,
                    after: 0.into(),
                    max_samples: 2.into(),
                    max_bytes: 4096.into(),
                },
            )
            .unwrap();
        drop(lease);
        assert_eq!(page.samples.len(), 2);
        assert_eq!(page.next_position.get(), 2);
        assert!(!page.has_more);
        let mut start = 0;
        for (sample, (value, end)) in page
            .samples
            .iter()
            .zip([(serde_json::json!(1.25), 5), (serde_json::json!(-2), 8)])
        {
            assert_eq!(serde_json::to_value(&sample.value).unwrap(), value);
            assert_eq!(
                sample.provenance.parser_id.as_str(),
                "swb.builtin.chart.sample"
            );
            assert_eq!(sample.provenance.unit.as_deref(), Some("V"));
            let [source] = &sample.provenance.sources[..] else {
                panic!("Expected one exact RX range");
            };
            assert_eq!(source.byte_start.map(U64::get), Some(start));
            assert_eq!(source.byte_end.map(U64::get), Some(end));
            start = end;
        }
        for (action, prefix) in [
            ("swb.builtin.chart.exportSvg", b"<svg ".as_slice()),
            (
                "swb.builtin.chart.exportCsv",
                b"sample_index,value_v,".as_slice(),
            ),
            (
                "swb.builtin.chart.exportPng",
                serial_workbench_core::PNG_SIGNATURE.as_slice(),
            ),
        ] {
            let exporting = host
                .invoke(&actor, call(&session, action, sample_params.clone()))
                .await
                .unwrap();
            let ActionResult::Reference(result) = settled(exporting).await else {
                panic!("Expected the bundled chart file for {action}");
            };
            let file = host
                .inner
                .files
                .read(
                    FileReadParams {
                        file_ref: result.result_ref,
                        offset: 0.into(),
                        max_bytes: 4096.into(),
                    },
                    &actor,
                )
                .unwrap();
            assert!(file.at_end);
            let bytes = STANDARD.decode(file.bytes_base64.as_str()).unwrap();
            assert!(bytes.starts_with(prefix), "{action}");
        }
        eprintln!("bundled_chart authorized=true samples=2 raw_bytes=8 svg=true csv=true png=true");
        let yaml = "version: \"1\"\nbyteLength: 1\nfields:\n  - id: reading\n    kind: integer\n    byteOffset: 0\n    width: 1\n    order: big\n    scale: \"0.5\"\n    bias: \"1\"";
        for (action, params, expected_status) in [
            (
                "swb.reference.fields.encode",
                serde_json::json!({"definition":definition,"values":{"reading":"33.5"}}),
                "encoded",
            ),
            ("swb.reference.fields.decode", decode_params, "decoded"),
            (
                "swb.reference.fields.encode",
                serde_json::json!({"definition":yaml,"definitionFormat":"yaml","values":{"reading":"33.5"}}),
                "encoded",
            ),
            (
                "swb.reference.fields.decode",
                serde_json::json!({"definition":yaml,"definitionFormat":"yaml","bytesBase64":"QQ=="}),
                "decoded",
            ),
            (
                "swb.reference.fields.decode",
                serde_json::json!({"definition":yaml.replace("width: 1","width: 2"),"definitionFormat":"yaml","bytesBase64":"QQ=="}),
                "invalid",
            ),
            ("swb.reference.fields.identifyCrc", crc_params, "matched"),
            ("swb.reference.fields.modbus", modbus_params, "decoded"),
            (
                "swb.reference.fields.modbus",
                modbus_compare,
                "device-exception",
            ),
            (
                "swb.reference.fields.modbusServer",
                modbus_server,
                "replied",
            ),
            ("swb.reference.fields.nmea", nmea, "parsed"),
            ("swb.reference.fields.at", at_response, "parsed"),
            (
                "swb.reference.fields.compareSessions",
                comparison,
                "compared",
            ),
        ] {
            let calibrated = params["definition"] == definition;
            let accepted = host
                .invoke(&actor, call(&session, action, params))
                .await
                .unwrap();
            let ActionResult::Reference(output) = settled(accepted).await else {
                panic!("Expected a codec result file");
            };
            let read = host
                .inner
                .files
                .read(
                    FileReadParams {
                        file_ref: output.result_ref,
                        offset: 0.into(),
                        max_bytes: 4096.into(),
                    },
                    &actor,
                )
                .unwrap();
            assert!(read.at_end);
            let report: serde_json::Value =
                serde_json::from_slice(&STANDARD.decode(read.bytes_base64.as_str()).unwrap())
                    .unwrap();
            assert_eq!(report["status"], expected_status);
            if action == "swb.reference.fields.compareSessions" {
                assert_eq!(report["rows"][0]["changedBytes"], 1);
                assert_eq!(report["rows"][1]["elapsedDeltaNs"], "-6");
                assert_eq!(
                    report["detail"]["byteRanges"]["items"],
                    serde_json::json!([{"start":0,"end":1}])
                );
                assert!(report["detail"]["fields"].is_null());
                eprintln!(
                    "bundled_session_comparison permission_denied_before_grant=true changed_bytes=1 relative_delta_ns=-6"
                );
            } else if action == "swb.reference.fields.modbusServer" {
                assert_eq!(report["responseBase64"], server_request);
                assert_eq!(
                    report["model"]["tables"]["holdingRegisters"],
                    serde_json::json!([{"start":0,"values":[12,258]}])
                );
            } else if action == "swb.reference.fields.at" {
                assert_eq!(report["state"], "complete");
                assert_eq!(
                    report["lines"],
                    serde_json::json!([
                        {"line":1,"raw":"AT+CREG?","kind":"echo"},
                        {"line":2,"raw":"+CREG: 5","kind":"urc","code":"+CREG"},
                        {"line":3,"raw":"+CREG: 2,5","kind":"response","code":"+CREG"},
                        {"line":4,"raw":"OK","kind":"result","code":"OK"}
                    ])
                );
            } else if expected_status == "parsed" {
                assert_eq!(report["lines"][0]["type"], "VTG");
                assert_eq!(
                    report["lines"][0]["fields"][2]["value"],
                    serde_json::Value::Null
                );
                assert_eq!(
                    report["lines"][0]["fields"][0],
                    serde_json::json!({"id":"trueCourse","value":77.52,"raw":"77.52","start":7,"end":12,"unit":"deg"})
                );
                assert_eq!(report["lines"][1]["status"], "invalid");
                assert_eq!(report["lines"][1]["path"], "checksum");
            } else if expected_status == "device-exception" {
                assert_eq!(
                    report,
                    serde_json::json!({"status":"device-exception","exceptionCode":2})
                );
            } else if action == "swb.reference.fields.modbus" {
                assert_eq!(
                    report,
                    serde_json::json!({"status":"decoded","broadcast":false,"packet":{
                        "unitId":1,"pdu":{"functionCode":3,"address":0,"quantity":10}
                    }})
                );
            } else if expected_status == "matched" {
                assert_eq!(report["distinctSamples"], 2);
                assert_eq!(
                    report["candidates"],
                    serde_json::json!([{"name":"CRC-16/MODBUS","width":16,"polynomial":32773,
                        "initial":65535,"reflectInput":true,"reflectOutput":true,
                        "finalXor":0,"order":"little"}])
                );
            } else if expected_status == "invalid" {
                assert_eq!(
                    report,
                    serde_json::json!({"status":"invalid","path":"fields[0].width","position":{"line":7,"column":5}})
                );
            } else if expected_status == "encoded" {
                assert_eq!(
                    report,
                    serde_json::json!({"status":"encoded","bytesBase64":"QQ=="})
                );
            } else {
                assert_eq!(report["status"], "decoded");
                assert_eq!(report["readings"][0]["value"], "33.5");
                assert_eq!(report["readings"][0]["rawHex"], "41");
                assert_eq!(report["readings"][0]["rawValue"], "65");
                if calibrated {
                    assert_eq!(
                        report["readings"][0]["calibration"],
                        serde_json::json!({"kind":"table","revision":"probe-2","status":"applied"})
                    );
                }
                assert_eq!(
                    report["readings"][0]["bytes"],
                    serde_json::json!({"start":0,"end":1})
                );
            }
        }
        let modbus = "swb.reference.modbus.transaction";
        let slave = "swb.reference.modbus.slave.serve";
        let slave_params = serde_json::json!({
            "transport": "tcp", "durationMs": 15_000, "requestLimit": 2,
            "model": {"unitId":1,"tables":{"holdingRegisters":[{"start":0,"values":[12,0]}]}},
        });
        let request = [0, 17, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1];
        let params = serde_json::json!({
            "transport": "tcp",
            "requestBase64": STANDARD.encode(request),
            "responseTimeoutMs": 200,
            "includeTrace": true,
        });
        let repeat = "swb.builtin.automation.repeat";
        let repeat_params = serde_json::json!({
            "sendBase64": "Uw==", "expectBase64": "Uw==", "periodMs": 150, "count": 2,
        });
        grant("metadata.read", &session);
        let denied_repeat = host
            .invoke(&actor, call(&session, repeat, repeat_params.clone()))
            .await
            .unwrap_err();
        assert_eq!(denied_repeat.code, "PERMISSION_DENIED");

        let sequence = "swb.builtin.automation.sequence";
        let sequence_params = || {
            let cursor = host.inner.streams.current_cursor(&session).unwrap();
            let start_event_seq = cursor.position.get().checked_add(1).unwrap().to_string();
            let document = serde_json::json!({
                "version": 1,
                "variables": {"code": "51"},
                "steps": [
                    {"kind":"send","hex":"${code}","writeWaitMs":3200,"expect":{"hex":"51"}},
                    {"kind":"delay","milliseconds":20},
                    {"kind":"send","hex":"52","expect":{"hex":"52"}}
                ]
            });
            serde_json::json!({"definition":document.to_string(),"startEventSeq":start_event_seq})
        };
        let denied_sequence = host
            .invoke(&actor, call(&session, sequence, sequence_params()))
            .await
            .unwrap_err();
        assert_eq!(denied_sequence.code, "PERMISSION_DENIED");

        let denied = host
            .invoke(&actor, call(&session, modbus, params.clone()))
            .await
            .unwrap_err();
        assert_eq!(denied.code, "PERMISSION_DENIED");
        let denied_slave = host
            .invoke(&actor, call(&session, slave, slave_params.clone()))
            .await
            .unwrap_err();
        assert_eq!(denied_slave.code, "PERMISSION_DENIED");
        grant("device.modify", &session);
        let accepted = host
            .invoke(&actor, call(&session, modbus, params))
            .await
            .unwrap();
        let ActionResult::Reference(output) = settled(accepted).await else {
            panic!("Expected a bundled Modbus result file");
        };
        let read = host
            .inner
            .files
            .read(
                FileReadParams {
                    file_ref: output.result_ref,
                    offset: 0.into(),
                    max_bytes: 4096.into(),
                },
                &actor,
            )
            .unwrap();
        assert!(read.at_end);
        let trace: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(read.bytes_base64.as_str()).unwrap()).unwrap();
        assert_eq!(trace["outcome"], "response_timeout", "{trace:?}");
        assert_eq!(trace["attempts"].as_array().unwrap().len(), 1);
        assert_eq!(trace["attempts"][0]["requestTransactionId"], 17);
        assert!(trace["attempts"][0]["trace"]["tx"]["eventSeq"].is_string());
        assert!(trace["attempts"][0]["trace"].get("rxFirst").is_none());
        assert_eq!(trace["ignoredFrames"], 1, "Virtual Echo is not a reply");
        eprintln!(
            "bundled_modbus denied_without_device_modify=true accepted_tx=true invalid_echo_ignored=true"
        );
        let wait_armed = |operation_id: Id, unit: &'static str| {
            let actor = actor.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(8), async {
                    loop {
                        let state = store.get(&actor, &operation_id).unwrap();
                        if state.progress.as_ref().is_some_and(|p| p.unit == unit) {
                            break;
                        }
                        assert!(!state.state.is_terminal(), "{state:?}");
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                })
                .await
                .expect("Signed operation reported its armed source cursor");
            }
        };
        peer.serving.store(true, Ordering::Release);
        let started = host
            .invoke(&actor, call(&session, slave, slave_params.clone()))
            .await
            .unwrap();
        wait_armed(started.operation_id.clone(), "frames").await;
        assert!(peer.replies.lock().unwrap().is_empty());
        let write = [0, 21, 0, 0, 0, 6, 1, 6, 0, 1, 1, 2];
        let query = [0, 22, 0, 0, 0, 6, 1, 3, 0, 1, 0, 1];
        let reply = [0, 22, 0, 0, 0, 5, 1, 3, 2, 1, 2];
        peer.incoming
            .lock()
            .unwrap()
            .extend([write[..3].to_vec(), [&write[3..], &query].concat()]);
        let ActionResult::Reference(output) = settled(started).await else {
            panic!("Expected the live slave result file");
        };
        let result = host
            .inner
            .files
            .read(
                FileReadParams {
                    file_ref: output.result_ref,
                    offset: 0.into(),
                    max_bytes: 4096.into(),
                },
                &actor,
            )
            .unwrap();
        assert!(result.at_end);
        let live: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(result.bytes_base64.as_str()).unwrap())
                .unwrap();
        assert_eq!(live["reason"], "request_limit");
        assert_eq!(live["receivedBytes"], 24);
        assert_eq!(
            live["model"]["tables"]["holdingRegisters"][0]["values"],
            serde_json::json!([12, 258])
        );
        assert_eq!(live["processed"][0]["tx"]["confirmed"], true);
        assert_eq!(live["processed"][1]["tx"]["confirmed"], true);
        assert_eq!(
            live["processed"][0]["source"]["byteEnd"],
            live["processed"][1]["source"]["byteStart"]
        );
        assert_eq!(
            *peer.replies.lock().unwrap(),
            vec![write.to_vec(), reply.to_vec()]
        );

        let idle = host
            .invoke(&actor, call(&session, slave, slave_params.clone()))
            .await
            .unwrap();
        wait_armed(idle.operation_id.clone(), "frames").await;
        let cancellation = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("operation").unwrap(),
            id: idle.operation_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let cancel_op = host
            .invoke(
                &actor,
                call(
                    &cancellation,
                    "operation.cancel",
                    serde_json::json!({"reason":"user"}),
                ),
            )
            .await
            .unwrap();
        assert!(matches!(
            settled(cancel_op).await,
            ActionResult::CancellationRequested(_)
        ));
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let state = store.get(&actor, &idle.operation_id).unwrap();
                if state.state.is_terminal() {
                    assert_eq!(state.state, OperationState::Cancelled, "{state:?}");
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Slave cancellation reached its terminal state");
        let mut brief = slave_params;
        brief["durationMs"] = serde_json::json!(100);
        let restarted = host
            .invoke(&actor, call(&session, slave, brief))
            .await
            .unwrap();
        assert!(matches!(
            settled(restarted).await,
            ActionResult::Reference(_)
        ));
        assert_eq!(peer.replies.lock().unwrap().len(), 2);
        eprintln!(
            "bundled_modbus_slave authorized=true split_write_read=true accepted_replies=2 cancelled=true lease_reusable=true"
        );

        peer.serving.store(false, Ordering::Release);
        let mut scheduled = call(&session, repeat, repeat_params);
        scheduled.execution_mode = Some(ExecutionMode::Independent);
        let accepted = host.invoke(&actor, scheduled).await.unwrap();
        let ActionResult::Reference(output) = settled(accepted).await else {
            panic!("Expected the signed scheduled-send result file");
        };
        let read = host
            .inner
            .files
            .read(
                FileReadParams {
                    file_ref: output.result_ref,
                    offset: 0.into(),
                    max_bytes: 4096.into(),
                },
                &actor,
            )
            .unwrap();
        assert!(read.at_end);
        let report: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(read.bytes_base64.as_str()).unwrap()).unwrap();
        assert_eq!(report["outcome"], "completed", "{report}");
        assert_eq!(report["completed"], 2);
        let attempts = report["attempted"].as_array().unwrap();
        assert_eq!(attempts.len(), 2);
        assert!(attempts.iter().all(|item| item["outcome"] == "matched"));
        assert_ne!(attempts[0]["operationId"], attempts[1]["operationId"]);
        eprintln!("bundled_scheduled_send denied_without_device_modify=true confirmed_echoes=2");

        let accepted = host
            .invoke(&actor, call(&session, sequence, sequence_params()))
            .await
            .unwrap();
        let ActionResult::Reference(output) = settled(accepted).await else {
            panic!("Expected the signed command-sequence result file");
        };
        let read = host
            .inner
            .files
            .read(
                FileReadParams {
                    file_ref: output.result_ref,
                    offset: 0.into(),
                    max_bytes: 4096.into(),
                },
                &actor,
            )
            .unwrap();
        assert!(read.at_end);
        let report: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(read.bytes_base64.as_str()).unwrap()).unwrap();
        assert_eq!(report["outcome"], "completed", "{report}");
        assert_eq!(report["completedSteps"], 3);
        let steps = report["attempts"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        for (attempt, frame) in steps.iter().zip([b"Q", b"R"]) {
            assert_eq!(attempt["outcome"], "matched");
            assert_eq!(attempt["source"]["sessionId"], session.id.as_str());
            let op = store
                .get(&actor, &id(attempt["operationId"].as_str().unwrap()))
                .unwrap();
            let Some(ActionResult::Tx(write)) = op.result else {
                panic!("Missing signed sequence write receipt");
            };
            assert_eq!(write.outcome, TxOutcome::Accepted);
            assert_eq!(write.bytes_base64.as_str(), STANDARD.encode(frame));
        }
        eprintln!(
            "bundled_command_sequence denied_without_device_modify=true confirmed_echoes=2 delay_steps=1"
        );

        let previous_writes = peer.replies.lock().unwrap().len();
        assert!(peer.incoming.lock().unwrap().is_empty());
        *peer.retry_response.lock().unwrap() = Some((vec![0x54], vec![0xa5]));
        peer.serving.store(true, Ordering::Release);
        let document = serde_json::json!({
            "version": 1,
            "steps": [{
                "kind": "send",
                "hex": "53",
                "expect": {"hex": "A4", "timeoutMs": 100, "retry": [{"hex": "54", "expectHex": "A5"}]}
            }]
        });
        let cursor = host.inner.streams.current_cursor(&session).unwrap();
        let accepted = host
            .invoke(
                &actor,
                call(
                    &session,
                    sequence,
                    serde_json::json!({
                        "definition": document.to_string(),
                        "startEventSeq": cursor.position.get().checked_add(1).unwrap().to_string()
                    }),
                ),
            )
            .await
            .unwrap();
        let ActionResult::Reference(output) = settled(accepted).await else {
            panic!("Expected the signed assertion result file");
        };
        let read = host
            .inner
            .files
            .read(
                FileReadParams {
                    file_ref: output.result_ref,
                    offset: 0.into(),
                    max_bytes: 4096.into(),
                },
                &actor,
            )
            .unwrap();
        assert!(read.at_end);
        let report: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(read.bytes_base64.as_str()).unwrap()).unwrap();
        assert_eq!(report["outcome"], "completed", "{report}");
        assert_eq!(report["completedSteps"], 1);
        let attempts = report["attempts"].as_array().unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0]["outcome"], "response_timeout");
        assert_eq!(attempts[1]["outcome"], "matched");
        assert_eq!(attempts[1]["path"], "$.steps[0].expect.retry[0]");
        assert_ne!(attempts[0]["operationId"], attempts[1]["operationId"]);
        assert_eq!(
            &peer.replies.lock().unwrap()[previous_writes..],
            &[vec![0x53], vec![0x54]]
        );
        peer.serving.store(false, Ordering::Release);
        eprintln!(
            "bundled_assertion first_attempt=response_timeout retry=matched distinct_peer_writes=2"
        );

        let arm_rule = || {
            let cursor = host.inner.streams.current_cursor(&session).unwrap();
            let document = serde_json::json!({
                "version": 1,
                "observationMs": 10_000,
                "condition": {"kind":"regex","pattern":"^ALARM$"},
                "effect": {"kind":"send","bytesBase64":STANDARD.encode(b"ACK\n")},
            });
            let mut operation = call(
                &session,
                "swb.builtin.automation.rule",
                serde_json::json!({
                    "definition": document.to_string(),
                    "startEventSeq": cursor.position.get().checked_add(1).unwrap().to_string(),
                }),
            );
            operation.execution_mode = Some(ExecutionMode::Independent);
            operation
        };
        let read_automation_report = |result: ActionResult| -> serde_json::Value {
            let ActionResult::Reference(output) = result else {
                panic!("Expected the signed automation result file");
            };
            let read = host
                .inner
                .files
                .read(
                    FileReadParams {
                        file_ref: output.result_ref,
                        offset: 0.into(),
                        max_bytes: 4096.into(),
                    },
                    &actor,
                )
                .unwrap();
            assert!(read.at_end);
            serde_json::from_slice(&STANDARD.decode(read.bytes_base64.as_str()).unwrap()).unwrap()
        };
        let rule = host.invoke(&actor, arm_rule()).await.unwrap();
        wait_armed(rule.operation_id.clone(), "matches").await;
        let duplicate = host.invoke(&actor, arm_rule()).await.unwrap();
        let rejected = read_automation_report(settled(duplicate).await);
        assert_eq!(rejected, serde_json::json!({"outcome":"already_armed"}));
        let input = host.invoke(&actor, call(
            &session,
            "session.tx",
            serde_json::json!({"bytesBase64":STANDARD.encode(b"\nALARM\n"),"writeWaitMs":"1000"}),
        )).await.unwrap();
        assert!(
            matches!(settled(input).await, ActionResult::Tx(tx) if tx.outcome == TxOutcome::Accepted)
        );
        let matched = read_automation_report(settled(rule).await);
        assert_eq!(matched["outcome"], "written", "{matched}");
        assert_eq!(matched["source"]["sessionId"], session.id.as_str());
        assert_eq!(matched["source"]["direction"], "rx");
        let from = matched["source"]["byteStart"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let to = matched["source"]["byteEnd"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert_eq!(to - from, b"ALARM\n".len() as u64);
        let effect = store
            .get(&actor, &id(matched["operationId"].as_str().unwrap()))
            .unwrap();
        assert!(matches!(effect.result, Some(ActionResult::Tx(tx))
            if tx.outcome == TxOutcome::Accepted && tx.bytes_base64.as_str() == STANDARD.encode(b"ACK\n")));
        eprintln!(
            "bundled_rule duplicate_arm_rejected=true source_bytes=6 confirmed_write_ack=true"
        );

        let calendar = "swb.builtin.automation.calendar";
        let session_revision = host.devices().snapshot(&session).await.unwrap().revision;
        let now = chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now());
        let due = now + chrono::Duration::milliseconds(2_000);
        let bytes = STANDARD.encode(b"CAL\n");
        let mut input = call(
            &session,
            calendar,
            serde_json::json!({
                "schedule": { "kind": "once", "at": due.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) },
                "sessionRevision": session_revision,
                "bytesBase64": bytes,
            }),
        );
        input.execution_mode = Some(ExecutionMode::Independent);
        let accepted = host.invoke(&actor, input).await.unwrap();
        let parent_id = accepted.operation_id.clone();
        let report = read_automation_report(settled(accepted).await);
        assert_eq!(report["outcome"], "completed", "{report}");
        let runs = report["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0]["scheduledMs"], due.timestamp_millis());
        assert_eq!(runs[0]["outcome"], "written");
        assert!(runs[0]["observedMs"].as_i64().unwrap() >= due.timestamp_millis());
        let child = store
            .get(&actor, &id(runs[0]["operationId"].as_str().unwrap()))
            .unwrap();
        assert_eq!(child.root_operation_id, parent_id);
        assert!(matches!(child.result, Some(ActionResult::Tx(tx))
            if tx.outcome == TxOutcome::Accepted && tx.bytes_base64.as_str() == bytes));
        eprintln!("bundled_calendar independent=true writes=1 exact_frame=true due_window=true");

        let check_after_restart = tokio::time::Instant::now() + Duration::from_secs(11);
        let later = chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
            + chrono::Duration::seconds(8);
        let mut pending = call(
            &session,
            calendar,
            serde_json::json!({
                "schedule": { "kind": "once", "at": later.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) },
                "sessionRevision": session_revision,
                "bytesBase64": STANDARD.encode(b"NO-REPLAY\n"),
            }),
        );
        pending.execution_mode = Some(ExecutionMode::Independent);
        let pending = host.invoke(&actor, pending).await.unwrap();
        wait_armed(pending.operation_id.clone(), "slots").await;
        let operation = store.get(&actor, &pending.operation_id).unwrap();
        assert_eq!(operation.state, OperationState::Running);
        assert_eq!(operation.child_high_watermark, 0.into());
        (pending.operation_id, check_after_restart, credential)
    }

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
    async fn takeover_waits_for_the_selected_admission_but_not_another_serial_port() {
        use crate::test_support as support;
        let h = support::Harness::new().await;
        let target = h.open("takeover-selected").await;
        let other = h.open("takeover-other").await;
        let operator = h
            .auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let mut pending = Vec::new();
        for serial in [&target, &other] {
            let (entered, ready) = oneshot::channel();
            let (release, held) = oneshot::channel();
            *h.host.inner.admission_gate.lock().unwrap() = Some((entered, held));
            let host = h.host.clone();
            let actor = h.actor.clone();
            let call = h.call(
                serial,
                "session.tx",
                serde_json::json!({"bytesBase64":"WA==","writeWaitMs":"1000"}),
            );
            let waiting = tokio::spawn(async move { host.invoke(&actor, call).await });
            ready.await.unwrap();
            pending.push((release, waiting));
        }
        let takeover = h
            .host
            .invoke(
                &operator,
                h.call_as(
                    &operator,
                    &target,
                    "session.takeover",
                    serde_json::json!({"actorId":h.actor.id(),"reason":"user"}),
                ),
            )
            .await
            .unwrap();
        support::until(|| h.auth.require(&h.actor, "device.modify", &target).is_err()).await;
        assert!(
            !h.store
                .get(&operator, &takeover.operation_id)
                .unwrap()
                .state
                .is_terminal()
        );
        let (release_other, write_other) = pending.pop().unwrap();
        let (release_target, write_target) = pending.pop().unwrap();
        release_target.send(()).unwrap();
        assert_eq!(
            write_target.await.unwrap().unwrap_err().code,
            "PERMISSION_DENIED"
        );
        support::until(|| {
            h.store
                .get(&operator, &takeover.operation_id)
                .unwrap()
                .state
                .is_terminal()
        })
        .await;
        assert_eq!(
            h.store
                .get(&operator, &takeover.operation_id)
                .unwrap()
                .state,
            OperationState::Succeeded
        );
        assert_eq!(h.write_count(), 0);
        release_other.send(()).unwrap();
        let sent = write_other.await.unwrap().unwrap();
        assert_eq!(
            h.wait(&sent.operation_id).await.state,
            OperationState::Succeeded
        );
        assert_eq!(h.write_count(), 1);
        h.host.shutdown().await.unwrap();
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
                .filter(|job| {
                    job.operation_id.lock().unwrap().as_ref() == Some(&accepted.operation_id)
                })
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
        let call=Call {protocol_version:ProtocolVersion::V1_0,host_id:identity.host_id,instance_epoch:identity.instance_epoch,actor_id:actor.id().clone(),request_id:RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),request_context:store.issue_context(&actor).unwrap().token,action_id:id("auth.authorize"),target:target.clone(),params:object(serde_json::json!({"clientId":"recipient","permissions":["content.read"],"targets":[target]})).unwrap(),reveal_target:BuiltinAction::Authorize.spec().reveal_target.clone(),expected_revision:None,lease_id:None,execution_mode:None};
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
