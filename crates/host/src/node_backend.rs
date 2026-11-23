//! 共享 Node 后台的阻塞生命周期边界；调用方在有界阻塞任务中持有 owner。
mod definitions;
mod derived;
pub(crate) mod observation;
mod owner;
mod pipes;
mod process_scope;
mod raw;
mod registrations;
mod telemetry;
mod transport;
use crate::{node_packages::VerifiedNodeInstallation, node_runtime::VerifiedNodeRuntime};
pub(crate) use derived::{SLOTS as DERIVED_SLOTS, TaskDerivedFuture};
pub(crate) use raw::{
    SLOTS as RAW_READ_SLOTS, SessionRawRequest, TaskRawFuture, TaskRawPage, TaskRawRequest,
    TaskRawResult,
};
use serial_workbench_core::{HostError, HostResult, NodePackageId, NodePackageRegistration};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};
pub(crate) use telemetry::NodeMetricsCache;
pub(crate) use transport::RegisteredTransport;

const TICK: Duration = Duration::from_millis(5);
const QUEUE: usize = 8;
// 公共Call仍受1MiB限制；Host→Node私有信封另预留包id、序号及taskContext元数据。
const MAX_HOST_COMMAND_BYTES: usize = serial_workbench_ipc::frame::MAX_FRAME_BYTES + 4096;
type Authority = Arc<dyn Fn() -> HostResult<()> + Send + Sync>;
type BeforeDispatch = Arc<dyn Fn() -> HostResult<Option<DispatchedTask>> + Send + Sync>;
type TaskOperationFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = TaskOperationReply> + Send>>;
pub(crate) struct TaskOperationReply {
    pub result: HostResult<serial_workbench_core::Operation>,
    // 仅说明本次尝试未交给持久接纳owner，不否认更早的未确认尝试。
    pub before_admission: bool,
}
pub(crate) struct DispatchedTask {
    pub context: serial_workbench_core::ContextToken,
    pub operation: serial_workbench_core::Id,
    pub runtime: tokio::runtime::Handle,
    pub invoke_child:
        Arc<dyn Fn(serial_workbench_core::ChildCall) -> TaskOperationFuture + Send + Sync>,
    pub get_operation:
        Arc<dyn Fn(serial_workbench_core::OperationGetParams) -> TaskOperationFuture + Send + Sync>,
    pub read_raw:
        Arc<dyn Fn(serial_workbench_core::StreamReadParams, bool) -> TaskRawFuture + Send + Sync>,
    pub close_session_events: Arc<dyn Fn() -> HostResult<TaskRawPage> + Send + Sync>,
    pub publish_derived:
        Arc<dyn Fn(serial_workbench_core::DerivedPublishParams) -> TaskDerivedFuture + Send + Sync>,
}
#[derive(Debug, Clone)]
pub struct NodeBackendLimits {
    pub command_timeout: Duration,
    pub heartbeat_timeout: Duration,
    /// 单次schema正则匹配的回溯预算；调用方可收紧，不能超过默认上限。
    pub schema_regex_backtrack_limit: usize,
}
impl Default for NodeBackendLimits {
    fn default() -> Self {
        Self {
            command_timeout: Duration::from_secs(5),
            heartbeat_timeout: Duration::from_secs(2),
            schema_regex_backtrack_limit: definitions::MAX_BACKTRACK_LIMIT,
        }
    }
}
#[derive(Debug)]
pub struct NodeBackendExit {
    pub process_id: u32,
    pub reaped: bool,
    pub exit_code: Option<i32>,
    pub error: Option<HostError>,
    /// 只供 Host 私有诊断，不能进入 RPC 错误或公开状态。
    pub stderr: Vec<u8>,
}
pub struct NodeBackend {
    requests: pipes::WakingSender<Request>,
    stop: Arc<AtomicBool>,
    owner: Option<JoinHandle<NodeBackendExit>>,
    observation: Arc<Mutex<ExitObservation>>,
    registrations: Arc<registrations::Registrations>,
    schema_regex_backtrack_limit: usize,
    finished: Arc<AtomicBool>,
    action_capacity: Arc<tokio::sync::Semaphore>,
    metrics: NodeMetricsCache,
}

#[derive(Clone)]
pub(crate) struct RegisteredHandler {
    execution: Arc<registrations::PackageExecution>,
    definition: Arc<definitions::Definition>,
    requests: pipes::WakingSender<Request>,
    registrations: Arc<registrations::Registrations>,
    observation: Arc<Mutex<ExitObservation>>,
    finished: Arc<AtomicBool>,
    authority: Authority,
    action_capacity: Arc<tokio::sync::Semaphore>,
}
struct OwnerCompletion(Arc<AtomicBool>);
impl Drop for OwnerCompletion {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[derive(Default)]
struct ExitObservation {
    process_id: u32,
    reaped: bool,
    exit_code: Option<i32>,
    stderr: Vec<u8>,
    package_objects: std::collections::BTreeSet<uuid::Uuid>,
}
impl ExitObservation {
    fn report(&self, error: Option<HostError>) -> NodeBackendExit {
        NodeBackendExit {
            process_id: self.process_id,
            reaped: self.reaped,
            exit_code: self.exit_code,
            error,
            stderr: self.stderr.clone(),
        }
    }
}
enum Request {
    Activate {
        package: Box<VerifiedNodeInstallation>,
        definitions: definitions::Definitions,
        authorize: Authority,
        completed: Box<dyn FnOnce() + Send>,
        reply: SyncSender<HostResult<NodePackageRegistration>>,
    },
    Dispose {
        id: NodePackageId,
        authorize: Authority,
        reply: SyncSender<HostResult<()>>,
    },
    Query {
        package: NodePackageId,
        query: Box<serial_workbench_core::Query>,
        definition: Arc<definitions::Definition>,
        authorize: Authority,
        reply: SyncSender<HostResult<serde_json::Value>>,
    },
    OpenTransport {
        package: NodePackageId,
        definition: Arc<definitions::Definition>,
        endpoint: transport::TransportEndpoint,
        params: serial_workbench_core::JsonObject,
        authorize: Authority,
        reply: SyncSender<HostResult<()>>,
    },
    Invoke {
        package: NodePackageId,
        call: Box<serial_workbench_core::Call>,
        definition: Arc<definitions::Definition>,
        authorize: Authority,
        before_dispatch: BeforeDispatch,
        observations: observation::ObservationSlot,
        reply: SyncSender<HostResult<serde_json::Value>>,
    },
}
impl NodeBackend {
    /// 只接受同套资源已建立的执行证明，不通过 PATH、工作区或用户参数寻找 Node。
    pub fn start(
        runtime: VerifiedNodeRuntime,
        limits: NodeBackendLimits,
        cancel: Arc<AtomicBool>,
    ) -> HostResult<Self> {
        Self::start_notifying(
            runtime,
            limits,
            cancel,
            tokio::sync::watch::channel(()).0,
            #[cfg(test)]
            crate::node_test_gates::NodeTestGates::default(),
        )
    }
    pub(crate) fn start_notifying(
        runtime: VerifiedNodeRuntime,
        limits: NodeBackendLimits,
        cancel: Arc<AtomicBool>,
        changed: tokio::sync::watch::Sender<()>,
        #[cfg(test)] gates: crate::node_test_gates::NodeTestGates,
    ) -> HostResult<Self> {
        if limits.command_timeout.is_zero()
            || limits.command_timeout > Duration::from_secs(30)
            || limits.heartbeat_timeout < Duration::from_millis(500)
            || limits.heartbeat_timeout > Duration::from_secs(30)
            || limits.schema_regex_backtrack_limit == 0
            || limits.schema_regex_backtrack_limit > definitions::MAX_BACKTRACK_LIMIT
        {
            return Err(error("INVALID_ARGUMENT", "backendBudgets"));
        }
        let stop = Arc::new(AtomicBool::new(false));
        let owner_stop = stop.clone();
        let (requests, receiver) = mpsc::sync_channel(QUEUE);
        let (ready, startup) = mpsc::sync_channel(1);
        let observation = Arc::new(Mutex::new(ExitObservation::default()));
        let owner_observation = observation.clone();
        let registrations = Arc::new(registrations::Registrations::new(changed));
        let owner_registrations = registrations.clone();
        let schema_regex_backtrack_limit = limits.schema_regex_backtrack_limit;
        let finished = Arc::new(AtomicBool::new(false));
        let metrics = NodeMetricsCache::new(finished.clone());
        let owner_metrics = metrics.clone();
        let owner_finished = finished.clone();
        let owner = thread::Builder::new()
            .name("node-backend-owner".into())
            .spawn(move || {
                // 先声明、最后释放，只有真实owner/子进程/管道责任结束后才唤醒晚结果调用方。
                let _completion = OwnerCompletion(owner_finished);
                let report = match owner::Owner::new(
                    runtime,
                    limits,
                    cancel,
                    owner_stop,
                    owner_observation.clone(),
                    owner_registrations,
                    owner_metrics,
                    #[cfg(test)]
                    gates.clone(),
                ) {
                    Ok(mut owner) => {
                        if let Err(cause) = owner.ready() {
                            let report = owner.finish(Some(cause.clone()));
                            let _ = ready.send(Err(cause));
                            #[cfg(test)]
                            gates.observe_exit(&report);
                            return report;
                        }
                        if ready.send(Ok(())).is_err() {
                            let report = owner.finish(None);
                            #[cfg(test)]
                            gates.observe_exit(&report);
                            return report;
                        }
                        owner.run(receiver)
                    }
                    Err(cause) => {
                        let _ = ready.send(Err(cause.clone()));
                        owner_observation
                            .lock()
                            .unwrap_or_else(|poison| poison.into_inner())
                            .report(Some(cause))
                    }
                };
                #[cfg(test)]
                gates.observe_exit(&report);
                report
            })
            .map_err(|_| error("HOST_BUSY", "backendOwnerThread"))?;
        let mut requests = pipes::WakingSender::from(requests);
        requests.set_receiver(owner.thread().clone());
        let mut backend = Self {
            requests,
            stop,
            owner: Some(owner),
            observation,
            registrations,
            schema_regex_backtrack_limit,
            finished,
            action_capacity: Arc::new(tokio::sync::Semaphore::new(QUEUE)),
            metrics,
        };
        let started = startup
            .recv()
            .unwrap_or_else(|_| Err(error("NODE_BACKEND_INTERRUPTED", "backendStartupOwner")));
        if let Err(cause) = started {
            backend.stop.store(true, Ordering::Release);
            let report = backend.join();
            return Err(if report.process_id != 0 && !report.reaped {
                error("NODE_OWNER_EXIT_UNCONFIRMED", "backendStartupNotReaped")
            } else {
                cause
            });
        }
        Ok(backend)
    }
    pub(crate) fn metrics_reader(&self) -> NodeMetricsCache {
        self.metrics.clone()
    }
    pub(crate) fn holds_installation_object(&self, object_id: uuid::Uuid) -> HostResult<bool> {
        let observation = self
            .observation
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendInstallationProofs"))?;
        // finished只在真实owner及Process证明析构后发布，不能以dispose代替。
        Ok(!self.is_finished() && observation.package_objects.contains(&object_id))
    }
    pub fn activate(
        &self,
        package: VerifiedNodeInstallation,
        authorize: impl Fn() -> HostResult<()> + Send + Sync + 'static,
    ) -> HostResult<NodePackageRegistration> {
        self.activate_with_completion(package, authorize, || {})
    }
    pub(crate) fn activate_with_completion(
        &self,
        package: VerifiedNodeInstallation,
        authorize: impl Fn() -> HostResult<()> + Send + Sync + 'static,
        completed: impl FnOnce() + Send + 'static,
    ) -> HostResult<NodePackageRegistration> {
        let authorize: Authority = Arc::new(authorize);
        authorize()?;
        // 编译在调用方持有的实际工作名额内完成，不阻塞共享Node监督线程的心跳。
        let definitions = definitions::Definitions::compile(
            &package.package().manifest,
            self.schema_regex_backtrack_limit,
        )?;
        authorize()?;
        let (reply, response) = mpsc::sync_channel(1);
        self.requests
            .try_send(Request::Activate {
                package: Box::new(package),
                definitions,
                authorize,
                completed: Box::new(completed),
                reply,
            })
            .map_err(|cause| self.queue_error(cause))?;
        response.recv().map_err(|_| self.owner_ended())?
    }
    pub fn dispose(
        &self,
        id: NodePackageId,
        authorize: impl Fn() -> HostResult<()> + Send + Sync + 'static,
    ) -> HostResult<()> {
        let (reply, response) = mpsc::sync_channel(1);
        self.requests
            .try_send(Request::Dispose {
                id,
                authorize: Arc::new(authorize),
                reply,
            })
            .map_err(|cause| self.queue_error(cause))?;
        response.recv().map_err(|_| self.owner_ended())?
    }
    /// 可信Host调用方在有界任务中完成schema工作；authorize检查实际调用者及目标。
    /// 调用前后绑定同一实际登记，等待授权期间不占共享监督线程。
    pub fn query(
        &self,
        package: NodePackageId,
        query: serial_workbench_core::Query,
        authorize: impl Fn() -> HostResult<()> + Send + Sync + 'static,
    ) -> HostResult<serde_json::Value> {
        let authorize: Authority = Arc::new(authorize);
        authorize()?;
        let entry = self.registrations.registration(
            &package,
            query.action_id.as_str(),
            serial_workbench_core::ActionKind::Query,
        )?;
        self.bound_handler(entry)
            .query_authorized(query, authorize, |_| Ok(()))
    }
    /// 调用方持有实际任务名额；取消观察持续到处理器终结，异常owner要等真实回收。
    /// 成功回执保留已发生的事实，交付权限由Host在读取Operation时另行核验。
    pub fn invoke(
        &self,
        package: NodePackageId,
        call: serial_workbench_core::Call,
        authorize: impl Fn() -> HostResult<()> + Send + Sync + 'static,
    ) -> HostResult<serde_json::Value> {
        let entry = self.registrations.registration(
            &package,
            call.action_id.as_str(),
            serial_workbench_core::ActionKind::Action,
        )?;
        self.bound_handler(entry).invoke(call, authorize)
    }
    fn bound_handler(&self, entry: registrations::RegisteredDefinition) -> RegisteredHandler {
        RegisteredHandler {
            execution: entry.execution,
            definition: entry.definition,
            requests: self.requests.clone(),
            registrations: self.registrations.clone(),
            observation: self.observation.clone(),
            finished: self.finished.clone(),
            authority: entry.authorize,
            action_capacity: self.action_capacity.clone(),
        }
    }
    pub(crate) fn registered_handlers(
        &self,
        package: &NodePackageId,
    ) -> HostResult<Vec<RegisteredHandler>> {
        Ok(self
            .registrations
            .definitions(package)?
            .into_iter()
            .filter(|entry| !entry.definition.is_transport())
            .map(|entry| self.bound_handler(entry))
            .collect())
    }
    pub fn shutdown(mut self) -> NodeBackendExit {
        self.stop.store(true, Ordering::Release);
        self.join()
    }
    pub(crate) fn is_finished(&self) -> bool {
        self.owner.as_ref().is_none_or(JoinHandle::is_finished)
    }
    fn queue_error(&self, cause: mpsc::TrySendError<Request>) -> HostError {
        match cause {
            mpsc::TrySendError::Full(_) => error("HOST_BUSY", "backendControlQueue"),
            mpsc::TrySendError::Disconnected(_) => self.owner_ended(),
        }
    }
    fn owner_ended(&self) -> HostError {
        owner_ended(&self.finished, &self.observation)
    }
    fn join(&mut self) -> NodeBackendExit {
        self.requests.wake();
        self.owner
            .take()
            .expect("one owner join")
            .join()
            .unwrap_or_else(|_| {
                self.observation
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .report(Some(error(
                        "NODE_BACKEND_INTERRUPTED",
                        "backendOwnerPanicked",
                    )))
            })
    }
}
pub(crate) fn validate_theme_resource(
    schema: &serial_workbench_core::SchemaObject,
    value: &serde_json::Value,
) -> HostResult<()> {
    definitions::validate_theme_resource(schema, value)
}

impl RegisteredHandler {
    pub(crate) fn themes(&self) -> impl Iterator<Item = &serial_workbench_core::NodeThemeEntry> {
        self.execution
            .themes
            .iter()
            .filter(|(configuration, _)| configuration == &self.spec().action_id)
            .map(|(_, theme)| theme)
    }

    pub(crate) fn normalize_parameters(
        &self,
        params: &serial_workbench_core::JsonObject,
    ) -> HostResult<serial_workbench_core::JsonObject> {
        self.definition.normalize_parameters(params)
    }
    pub(crate) fn validate_check(&self, query: &serial_workbench_core::Query) -> HostResult<()> {
        self.definition.validate_check(query)
    }
    pub(crate) fn spec(&self) -> &serial_workbench_core::ActionSpec {
        self.definition.spec()
    }
    pub(crate) fn package(&self) -> &NodePackageId {
        &self.execution.id
    }
    pub(crate) fn version(&self) -> &str {
        self.execution.version.as_str()
    }
    pub(crate) fn archive_sha256(&self) -> &serial_workbench_core::Digest {
        &self.execution.archive_sha256
    }
    pub(crate) fn instance_id(&self) -> &serial_workbench_core::Id {
        &self.execution.instance_id
    }
    pub(crate) fn host_api(&self) -> &[serial_workbench_core::NodeHostApiScope] {
        &self.execution.host_api
    }
    pub(crate) fn view_assets(
        &self,
        id: &serial_workbench_core::Id,
    ) -> Option<(
        &serial_workbench_core::NodePackageView,
        Arc<crate::node_packages::ui_assets::VerifiedUiAssets>,
    )> {
        let assets = self.execution.ui_assets.as_ref()?;
        let view = self
            .execution
            .views
            .iter()
            .find(|view| &view.id == id && view.action_id == self.spec().action_id)?;
        Some((view, assets.clone()))
    }
    pub(crate) fn reserve_action(&self) -> HostResult<tokio::sync::OwnedSemaphorePermit> {
        self.action_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| error("HOST_BUSY", "backendActionCapacity"))
    }
    pub(crate) fn validate_call(&self, call: &serial_workbench_core::Call) -> HostResult<()> {
        self.definition.validate_call(call)?;
        owner::validate_invoke_frame(self.package(), call)
    }
    pub(crate) fn current(&self) -> HostResult<()> {
        (self.authority)()?;
        match self.spec().kind {
            serial_workbench_core::ActionKind::Query => self.registrations.validate_query(
                self.package(),
                self.spec().action_id.as_str(),
                &self.definition,
            ),
            serial_workbench_core::ActionKind::Action => self
                .registrations
                .validate_action(self.package(), &self.definition),
        }
    }
    pub(crate) fn invoke(
        &self,
        call: serial_workbench_core::Call,
        authorize: impl Fn() -> HostResult<()> + Send + Sync + 'static,
    ) -> HostResult<serde_json::Value> {
        let permit = self.reserve_action()?;
        self.invoke_reserved(call, permit, authorize, || Ok(None), Arc::new(|_| Ok(())))
    }
    pub(crate) fn invoke_reserved(
        &self,
        call: serial_workbench_core::Call,
        permit: tokio::sync::OwnedSemaphorePermit,
        authorize: impl Fn() -> HostResult<()> + Send + Sync + 'static,
        before_dispatch: impl Fn() -> HostResult<Option<DispatchedTask>> + Send + Sync + 'static,
        observe: observation::ObservationSink,
    ) -> HostResult<serde_json::Value> {
        let _permit = permit;
        let authorize: Authority = Arc::new(authorize);
        authorize()?;
        self.current()?;
        self.validate_call(&call)?;
        authorize()?;
        let (reply, response) = mpsc::sync_channel(1);
        let observations = observation::ObservationSlot::default();
        self.requests
            .try_send(Request::Invoke {
                package: self.package().clone(),
                call: Box::new(call),
                definition: self.definition.clone(),
                authorize,
                before_dispatch: Arc::new(before_dispatch),
                observations: observations.clone(),
                reply,
            })
            .map_err(|cause| self.queue_error(cause))?;
        let flush = || -> HostResult<()> {
            if let Some(snapshot) = observations.peek()? {
                observe(snapshot.value())?;
                observations.ack(&snapshot)?;
            }
            Ok(())
        };
        let mut observation_error = None;
        let result = loop {
            match response.recv_timeout(Duration::from_millis(50)) {
                Ok(result) => {
                    if let Err(cause) = flush() {
                        observation_error = Some(cause);
                    }
                    break result;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if let Err(cause) = flush() {
                        observation_error = Some(cause);
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break Err(self.owner_ended()),
            }
        };
        // 观测失败不能放弃仍在运行的实际工作，也不覆盖已有领域成功回执。
        if let Some(cause) = observation_error {
            eprintln!("node_observation_write_failed code={}", cause.code);
        }
        let value = result?;
        self.definition.validate_output(&value)?;
        Ok(value)
    }
    pub(crate) fn execute(
        &self,
        query: serial_workbench_core::Query,
        authorize: impl Fn() -> HostResult<()> + Send + Sync + 'static,
        observe: impl FnOnce(&serial_workbench_core::Query) -> HostResult<()>,
    ) -> HostResult<serde_json::Value> {
        let authorize: Authority = Arc::new(authorize);
        authorize()?;
        self.query_authorized(query, authorize, observe)
    }
    fn query_authorized(
        &self,
        query: serial_workbench_core::Query,
        authorize: Authority,
        observe: impl FnOnce(&serial_workbench_core::Query) -> HostResult<()>,
    ) -> HostResult<serde_json::Value> {
        self.current()?;
        self.definition.validate_input(&query)?;
        authorize()?;
        observe(&query)?;
        authorize()?;
        let action_id = query.action_id.clone();
        let package_id = self.package().clone();
        let (reply, response) = mpsc::sync_channel(1);
        self.requests
            .try_send(Request::Query {
                package: self.package().clone(),
                query: Box::new(query),
                definition: self.definition.clone(),
                authorize: authorize.clone(),
                reply,
            })
            .map_err(|cause| self.queue_error(cause))?;
        let value = response.recv().map_err(|_| self.owner_ended())??;
        self.definition.validate_output(&value)?;
        authorize()?;
        self.registrations
            .validate_query(&package_id, action_id.as_str(), &self.definition)?;
        self.current()?;
        Ok(value)
    }
    fn queue_error(&self, cause: mpsc::TrySendError<Request>) -> HostError {
        match cause {
            mpsc::TrySendError::Full(_) => error("HOST_BUSY", "backendControlQueue"),
            mpsc::TrySendError::Disconnected(_) => self.owner_ended(),
        }
    }
    fn owner_ended(&self) -> HostError {
        owner_ended(&self.finished, &self.observation)
    }
}

pub(crate) fn normalize_saved_parameters(
    spec: &serial_workbench_core::ActionSpec,
    params: &serial_workbench_core::JsonObject,
) -> HostResult<serial_workbench_core::JsonObject> {
    definitions::normalize_parameters(spec, params)
}
fn owner_ended(finished: &AtomicBool, observation: &Mutex<ExitObservation>) -> HostError {
    // reply在unwind开始时即可关闭；实际责任退出前不归还调用方名额。
    while !finished.load(Ordering::Acquire) {
        thread::sleep(TICK);
    }
    let observed = observation
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if observed.process_id != 0 && !observed.reaped {
        error("NODE_OWNER_EXIT_UNCONFIRMED", "backendOwnerNotReaped")
    } else {
        error("NODE_BACKEND_INTERRUPTED", "backendOwnerEnded")
    }
}
impl Drop for NodeBackend {
    fn drop(&mut self) {
        if self.owner.is_some() {
            self.stop.store(true, Ordering::Release);
            let _ = self.join();
        }
    }
}
fn error(code: &str, reason: &str) -> HostError {
    let mut value = HostError::new(code, "Node backend lifecycle failed");
    value.details = Some(Box::new(
        serde_json::from_value(serde_json::json!({"component":"nodeBackend", "reason":reason}))
            .expect("static backend details"),
    ));
    value
}
