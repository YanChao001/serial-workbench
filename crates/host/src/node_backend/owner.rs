use super::{
    Authority, BeforeDispatch, DispatchedTask, ExitObservation, NodeBackendExit, NodeBackendLimits,
    Request, TICK, TaskOperationReply,
    debugger::{DebugCommandOutcome, ScriptDebugSession, debugger_unavailable},
    definitions, error, pipes, process_scope, registrations,
};
use crate::{
    node_packages::VerifiedNodeInstallation,
    node_runtime::{RuntimeChild, VerifiedNodeRuntime},
};
use serde::{Deserialize, Serialize};
use serial_workbench_core::{
    ActionKind, Call, HostError, HostResult, Id, NodeContributionSelection, NodePackageId,
    NodePackageRegistration, Query, ScriptDebugCommand, ScriptDebugSnapshot, U64,
};
use std::{
    collections::BTreeMap,
    process::ExitStatus,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
mod derived;
mod raw;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskDataRequest {
    request_id: U64,
    parent_request_id: U64,
    parent_operation_id: serial_workbench_core::Id,
    task_context: serial_workbench_core::ContextToken,
    params: serde_json::Value,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Command<'a> {
    Activate {
        request_id: U64,
        id: &'a NodePackageId,
        entry: &'a str,
        root: &'a str,
        #[serde(skip_serializing_if = "BTreeMap::is_empty")]
        configuration_kinds: &'a BTreeMap<&'a Id, ActionKind>,
    },
    Dispose {
        request_id: U64,
        id: &'a NodePackageId,
    },
    Query {
        request_id: U64,
        id: &'a NodePackageId,
        query: &'a Query,
    },
    OpenTransport {
        request_id: U64,
        id: &'a NodePackageId,
        transport_id: &'a serial_workbench_core::Id,
        address: &'a str,
        credential: &'a serial_workbench_core::ContextToken,
        params: &'a serial_workbench_core::JsonObject,
    },
    Invoke {
        request_id: U64,
        id: &'a NodePackageId,
        call: &'a Call,
        #[serde(skip_serializing_if = "Option::is_none")]
        task_context: Option<&'a serial_workbench_core::ContextToken>,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent_operation_id: Option<&'a serial_workbench_core::Id>,
        #[serde(skip_serializing_if = "Option::is_none")]
        script_breakpoints: Option<&'a [u32]>,
    },
    ScriptDebugCommand {
        request_id: U64,
        action_request_id: U64,
        command: &'a ScriptDebugCommand,
    },
    TaskReply {
        request_id: U64,
        reply: &'a serial_workbench_core::RpcReply,
        before_admission: bool,
    },
    CancelAction {
        request_id: U64,
    },
    Shutdown {
        request_id: U64,
    },
}
fn command_size(command: &Command<'_>) -> HostResult<usize> {
    serial_workbench_ipc::frame::encoded_length(command, super::MAX_HOST_COMMAND_BYTES)
        .map_err(|_| error("LIMIT_EXCEEDED", "backendControlFrame"))
}
pub(super) fn validate_invoke_frame(package: &NodePackageId, call: &Call) -> HostResult<()> {
    // 按实际Serde信封计数，预留U64序号与Core ContextToken的最大ASCII长度；不分配正文。
    let token = serial_workbench_core::ContextToken::try_from("A".repeat(2048).as_str())?;
    command_size(&Command::Invoke {
        request_id: u64::MAX.into(),
        id: package,
        call,
        task_context: Some(&token),
        parent_operation_id: Some(&serial_workbench_core::Id::try_from(
            "00000000-0000-4000-8000-000000000000",
        )?),
        script_breakpoints: (call.action_id.as_str()
            == crate::node_packages::TRUSTED_SCRIPT_ACTION)
            .then_some(&[65_537; 32]),
    })
    .map(|_| ())
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Frame {
    Ready {
        probe: serial_workbench_core::NodeRuntimeSelfTest,
    },
    Heartbeat {
        #[serde(default, deserialize_with = "super::observation::deserialize_present")]
        sample: Option<super::telemetry::NodeSample>,
    },
    Registered {
        request_id: U64,
        contributes: NodeContributionSelection,
    },
    Disposed {
        request_id: U64,
    },
    Queried {
        request_id: U64,
        value: serde_json::Value,
    },
    QueryFailed {
        request_id: U64,
    },
    TransportStarted {
        request_id: U64,
    },
    ActionCompleted {
        request_id: U64,
        value: serde_json::Value,
        #[serde(default, deserialize_with = "super::observation::deserialize_present")]
        observation: Option<super::observation::RawObservation>,
    },
    ActionFailed {
        request_id: U64,
        #[serde(default, deserialize_with = "super::observation::deserialize_present")]
        observation: Option<super::observation::RawObservation>,
    },
    ActionCancelled {
        request_id: U64,
        #[serde(default, deserialize_with = "super::observation::deserialize_present")]
        observation: Option<super::observation::RawObservation>,
    },
    ActionInterrupted {
        request_id: U64,
        #[serde(default, deserialize_with = "super::observation::deserialize_present")]
        observation: Option<super::observation::RawObservation>,
    },
    ActionStopping {
        request_id: U64,
    },
    ScriptDebugSnapshot {
        request_id: U64,
        value: ScriptDebugSnapshot,
    },
    ScriptDebugReply {
        request_id: U64,
        outcome: DebugCommandOutcome,
    },
    InvokeChild {
        request_id: U64,
        parent_request_id: U64,
        call: Box<serial_workbench_core::ChildCall>,
    },
    OperationGet {
        request_id: U64,
        parent_request_id: U64,
        parent_operation_id: serial_workbench_core::Id,
        task_context: serial_workbench_core::ContextToken,
        params: serde_json::Value,
    },
    Stopped {
        request_id: U64,
    },
    Failed {
        request_id: U64,
    },
}
struct PendingAction {
    package: NodePackageId,
    definition: Arc<definitions::Definition>,
    authorize: Authority,
    reply: SyncSender<HostResult<serde_json::Value>>,
    cancelling: Option<(Instant, HostError)>,
    cleanup_deadline: Option<Instant>,
    task: Option<DispatchedTask>,
    observations: super::observation::ObservationSlot,
    debug_command: Option<(U64, Instant)>,
}
impl PendingAction {
    fn debugger(&self) -> Option<&Arc<ScriptDebugSession>> {
        self.task.as_ref()?.debugger.as_ref().map(|lease| &lease.0)
    }
}
struct PendingTaskRequest {
    response: tokio::sync::oneshot::Receiver<TaskOperationReply>,
    work: tokio::task::JoinHandle<()>,
    parent_request_id: U64,
}
impl Drop for PendingTaskRequest {
    fn drop(&mut self) {
        self.work.abort();
    }
}
enum ActionOutcome {
    Completed(serde_json::Value),
    Failed,
    Cancelled,
    Interrupted,
}
pub(super) struct Owner {
    process: Process,
    limits: NodeBackendLimits,
    cancel: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    heartbeat: Instant,
    sequence: U64,
    registrations: Arc<registrations::Registrations>,
    effect_started: bool,
    actions: BTreeMap<u64, PendingAction>,
    task_requests: BTreeMap<u64, PendingTaskRequest>,
    request_sequence: u64,
    raw: raw::Lane,
    derived: derived::Lane,
    metrics: super::NodeMetricsCache,
    #[cfg(test)]
    gates: crate::node_test_gates::NodeTestGates,
}
impl Owner {
    #[cfg_attr(
        test,
        expect(
            clippy::too_many_arguments,
            reason = "测试门只增加时序观察，不为构造器另造参数模型"
        )
    )]
    pub(super) fn new(
        runtime: VerifiedNodeRuntime,
        limits: NodeBackendLimits,
        cancel: Arc<AtomicBool>,
        stop: Arc<AtomicBool>,
        observation: Arc<Mutex<ExitObservation>>,
        registrations: Arc<registrations::Registrations>,
        metrics: super::NodeMetricsCache,
        #[cfg(test)] gates: crate::node_test_gates::NodeTestGates,
    ) -> HostResult<Self> {
        let process = Process::new(runtime, limits.command_timeout, &cancel, observation)?;
        Ok(Self {
            process,
            limits,
            cancel,
            stop,
            heartbeat: Instant::now(),
            sequence: 0.into(),
            registrations,
            effect_started: false,
            actions: BTreeMap::new(),
            task_requests: BTreeMap::new(),
            request_sequence: 0,
            raw: raw::Lane::default(),
            derived: derived::Lane::default(),
            metrics,
            #[cfg(test)]
            gates,
        })
    }
    fn health(&self, closing: bool) -> HostResult<()> {
        if !closing && (self.cancel.load(Ordering::Acquire) || self.stop.load(Ordering::Acquire)) {
            return Err(error("CANCELLED", "backendStopping"));
        }
        if !closing {
            self.process.child.check_owner()?;
        }
        if self.process.io.failed() {
            return Err(error("NODE_BACKEND_INTERRUPTED", "backendPipe"));
        }
        if self.heartbeat.elapsed() >= self.limits.heartbeat_timeout {
            return Err(error("NODE_BACKEND_INTERRUPTED", "backendHeartbeat"));
        }
        Ok(())
    }
    fn check_active(&self) -> HostResult<()> {
        let authorities = self.registrations.authorizations()?;
        #[cfg(test)]
        self.gates.before_authority.arrive();
        for authorize in authorities {
            if let Err(cause) = authorize() {
                let mut interrupted =
                    error("NODE_BACKEND_INTERRUPTED", "backendActiveAuthorityChanged");
                interrupted.details = Some(Box::new(serde_json::from_value(serde_json::json!({"component":"nodeBackend","reason":"backendActiveAuthorityChanged","causeCode":cause.code})).expect("static authority details")));
                return Err(interrupted);
            }
        }
        Ok(())
    }
    fn frame(
        &mut self,
        deadline: Instant,
        closing: bool,
        authorize: &dyn Fn() -> HostResult<()>,
    ) -> HostResult<Frame> {
        loop {
            self.health(closing)?;
            if !closing {
                self.check_active()?;
            }
            self.poll_actions()?;
            self.poll_task_requests()?;
            self.poll_raw()?;
            self.poll_derived()?;
            authorize()?;
            if Instant::now() >= deadline {
                return Err(error("LIMIT_EXCEEDED", "backendCommandDeadline"));
            }
            match self.process.io.receive.try_recv() {
                Ok(bytes) => {
                    let frame = serde_json::from_slice(&bytes)
                        .map_err(|_| error("PROTOCOL_ERROR", "backendResponse"))?;
                    if let Frame::Heartbeat { sample } = frame {
                        self.observe_heartbeat(sample);
                        continue;
                    }
                    if let Some(frame) = self.action_frame(frame)? {
                        return Ok(frame);
                    }
                }
                Err(mpsc::TryRecvError::Empty) => thread::park_timeout(TICK),
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(error("NODE_BACKEND_INTERRUPTED", "backendOutputEnded"));
                }
            }
        }
    }
    pub(super) fn ready(&mut self) -> HostResult<()> {
        match self.frame(Instant::now() + self.limits.command_timeout, false, &|| {
            Ok(())
        })? {
            Frame::Ready { probe } => self.process.runtime.validate_process_probe(&probe),
            _ => Err(error("PROTOCOL_ERROR", "backendHandshake")),
        }
    }
    fn send(&mut self, command: Command<'_>) -> HostResult<()> {
        let size = command_size(&command)?;
        let mut bytes = Vec::with_capacity(size);
        serde_json::to_writer(&mut bytes, &command)
            .map_err(|_| error("INVALID_ARGUMENT", "backendCommand"))?;
        self.process
            .io
            .send
            .try_send(bytes)
            .map_err(|_| error("HOST_BUSY", "backendWriteQueue"))?;
        self.effect_started = true;
        Ok(())
    }
    fn next(&mut self) -> HostResult<U64> {
        self.sequence = self.sequence.checked_next()?;
        Ok(self.sequence)
    }
    fn start_transport(
        &mut self,
        package: NodePackageId,
        definition: Arc<definitions::Definition>,
        endpoint: super::transport::TransportEndpoint,
        params: serial_workbench_core::JsonObject,
        authorize: &dyn Fn() -> HostResult<()>,
    ) -> HostResult<()> {
        self.health(false)?;
        self.check_active()?;
        self.registrations
            .validate_transport(&package, &definition)?;
        authorize()?;
        let request_id = self.next()?;
        self.send(Command::OpenTransport {
            request_id,
            id: &package,
            transport_id: &definition.spec().action_id,
            address: &endpoint.address,
            credential: &endpoint.credential,
            params: &params,
        })?;
        // 仅接收私有线路启动回执。对端 connect 及流 I/O 不等待控制队列。
        match self.frame(Instant::now() + self.limits.command_timeout, false, &|| {
            Ok(())
        })? {
            Frame::TransportStarted {
                request_id: received,
            } if received == request_id => Ok(()),
            Frame::Failed {
                request_id: received,
            } if received == request_id => {
                self.effect_started = false;
                Err(error("HOST_BUSY", "backendTransportRejected"))
            }
            _ => Err(error("PROTOCOL_ERROR", "backendTransportResponse")),
        }
    }

    fn activate(
        &mut self,
        package: VerifiedNodeInstallation,
        definitions: definitions::Definitions,
        authorize: Authority,
        completed: Box<dyn FnOnce() + Send>,
    ) -> HostResult<NodePackageRegistration> {
        authorize()?;
        self.health(false)?;
        self.check_active()?;
        let installed = package.package();
        if installed.manifest.runtime_ref
            != serial_workbench_core::bundled_node_runtime_release().id
        {
            return Err(error("NODE_RUNTIME_INCOMPATIBLE", "backendPackageRuntime"));
        }
        if !installed.enabled
            || !installed.execution_trust.as_ref().is_some_and(|trust| {
                trust.archive_sha256 == installed.archive_sha256
                    && trust.permissions == installed.manifest.permissions
                    && trust.verified_source == installed.verified_source
            })
        {
            return Err(error("PERMISSION_DENIED", "backendExecutionTrust"));
        }
        let id = installed.manifest.id.clone();
        let archive_sha256 = installed.archive_sha256.clone();
        let ui_assets = package.ui_assets();
        let verified_themes = package.themes().to_vec();
        let manifest = installed.manifest.clone();
        if self.registrations.contains(&id)? {
            return Err(error("REVISION_CONFLICT", "backendAlreadyActive"));
        }
        if self.process.packages.len() >= 32 {
            return Err(error("HOST_BUSY", "backendLoadedGenerations"));
        }
        let entry = package.code_directory().join(manifest.main.as_str());
        let entry = entry
            .to_str()
            .ok_or_else(|| error("INVALID_ARGUMENT", "backendEntryEncoding"))?
            .to_owned();
        let root = package
            .code_directory()
            .to_str()
            .ok_or_else(|| error("INVALID_ARGUMENT", "backendRootEncoding"))?
            .to_owned();
        let request_id = self.next()?;
        // 先转交证明再让写者看到命令；panic 也不能先放开执行中的内容。
        self.process
            .observation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .package_objects
            .insert(package.package().object_id());
        self.process.packages.push(package);
        // 只把已验签清单中的配置种类交给私有运行时，用于核对登记的处理器。
        let configuration_kinds = manifest
            .contributes
            .configuration
            .iter()
            .map(|spec| (&spec.action_id, spec.kind))
            .collect();
        self.send(Command::Activate {
            request_id,
            id: &id,
            entry: &entry,
            root: &root,
            configuration_kinds: &configuration_kinds,
        })?;
        // Node 模块缓存仍可引用该代内容；dispose 后也保持证明到真实进程退出。
        let frame = self.frame(
            Instant::now() + self.limits.command_timeout,
            false,
            authorize.as_ref(),
        )?;
        let contributes = match frame {
            Frame::Registered {
                request_id: response_id,
                contributes,
            } if response_id == request_id => contributes,
            Frame::Failed {
                request_id: response_id,
            } if response_id == request_id => {
                return Err(error("NODE_REGISTRATION_FAILED", "backendRegister"));
            }
            _ => return Err(error("PROTOCOL_ERROR", "backendRegistrationResponse")),
        };
        let registration = NodePackageRegistration {
            id: id.clone(),
            version: manifest.version.clone(),
            contributes,
        };
        registration.validate_against(&manifest)?;
        let selected_views = registration
            .contributes
            .views
            .iter()
            .collect::<std::collections::BTreeSet<_>>();
        let views = manifest
            .contributes
            .views
            .into_iter()
            .filter(|view| selected_views.contains(&view.id))
            .collect();
        let themes = verified_themes
            .into_iter()
            .filter(|theme| {
                registration
                    .contributes
                    .themes
                    .contains(&theme.entry.theme_id)
                    && registration
                        .contributes
                        .configuration
                        .contains(&theme.configuration)
            })
            .map(|theme| (theme.configuration, theme.entry))
            .collect();
        let execution = Arc::new(registrations::PackageExecution {
            id: id.clone(),
            version: manifest.version,
            archive_sha256,
            instance_id: serial_workbench_core::Id::try_from(
                uuid::Uuid::new_v4().to_string().as_str(),
            )?,
            host_api: manifest.permissions.host_api,
            views,
            themes,
            ui_assets,
        });
        authorize()?;
        self.check_active()?;
        let definitions = definitions.select(&registration);
        self.registrations
            .insert(execution, authorize.clone(), definitions)?;
        authorize()?;
        // 登记已在原期限及授权内完成；在同一owner中结束临时期，再交付回执。
        completed();
        Ok(registration)
    }
    fn dispose(
        &mut self,
        id: NodePackageId,
        authorize: &dyn Fn() -> HostResult<()>,
    ) -> HostResult<()> {
        authorize()?;
        if !self.registrations.contains(&id)? {
            return Ok(());
        }
        let request_id = self.next()?;
        self.send(Command::Dispose {
            request_id,
            id: &id,
        })?;
        match self.frame(
            Instant::now() + self.limits.command_timeout,
            false,
            authorize,
        )? {
            Frame::Disposed {
                request_id: response_id,
            } if response_id == request_id => {
                self.registrations.remove(&id)?;
                Ok(())
            }
            Frame::Failed {
                request_id: response_id,
            } if response_id == request_id => Err(error("NODE_DISPOSE_FAILED", "backendDispose")),
            _ => Err(error("PROTOCOL_ERROR", "backendDisposeResponse")),
        }
    }
    fn query(
        &mut self,
        package: NodePackageId,
        query: Query,
        definition: Arc<definitions::Definition>,
        authorize: &dyn Fn() -> HostResult<()>,
    ) -> HostResult<serde_json::Value> {
        authorize()?;
        self.health(false)?;
        self.check_active()?;
        self.registrations
            .validate_query(&package, query.action_id.as_str(), &definition)?;
        authorize()?;
        let request_id = self.next()?;
        self.send(Command::Query {
            request_id,
            id: &package,
            query: &query,
        })?;
        let frame = self.frame(
            Instant::now() + self.limits.command_timeout,
            false,
            authorize,
        )?;
        let result = match frame {
            Frame::Queried {
                request_id: response_id,
                value,
            } if response_id == request_id => {
                // 处理器已实际结束；领域输出错误不应结束其他包或丢失共享进程责任。
                self.effect_started = false;
                Ok(value)
            }
            Frame::QueryFailed {
                request_id: response_id,
            } if response_id == request_id => {
                self.effect_started = false;
                Err(error("NODE_QUERY_FAILED", "backendQueryHandler"))
            }
            _ => return Err(error("PROTOCOL_ERROR", "backendQueryResponse")),
        };
        authorize()?;
        self.check_active()?;
        result
    }
    #[expect(
        clippy::too_many_arguments,
        reason = "派发入口同时接收实际任务、授权、回执及观察责任，保持显式所有权"
    )]
    fn start_action(
        &mut self,
        package: NodePackageId,
        call: Call,
        definition: Arc<definitions::Definition>,
        authorize: Authority,
        before_dispatch: BeforeDispatch,
        observations: super::observation::ObservationSlot,
        reply: SyncSender<HostResult<serde_json::Value>>,
    ) -> HostResult<()> {
        authorize()?;
        self.health(false)?;
        self.check_active()?;
        self.registrations.validate_action(&package, &definition)?;
        if self.actions.len() >= super::QUEUE {
            return Err(error("HOST_BUSY", "backendActionCapacity"));
        }
        authorize()?;
        let request_id = self.next()?;
        let task = before_dispatch()?;
        authorize()?;
        self.send(Command::Invoke {
            request_id,
            id: &package,
            call: &call,
            task_context: task.as_ref().map(|task| &task.context),
            parent_operation_id: task.as_ref().map(|task| &task.operation),
            script_breakpoints: task
                .as_ref()
                .and_then(|task| task.debugger.as_ref())
                .map(|lease| lease.0.breakpoints()),
        })?;
        self.actions.insert(
            request_id.get(),
            PendingAction {
                package,
                definition,
                authorize,
                reply,
                cancelling: None,
                cleanup_deadline: None,
                task,
                observations,
                debug_command: None,
            },
        );
        Ok(())
    }
    fn poll_actions(&mut self) -> HostResult<()> {
        let mut cancelled = Vec::new();
        let now = Instant::now();
        for (id, action) in &self.actions {
            if action
                .cleanup_deadline
                .is_some_and(|deadline| now >= deadline)
            {
                return Err(error(
                    "NODE_BACKEND_INTERRUPTED",
                    "backendActionCleanupDeadline",
                ));
            }
            if let Some((deadline, _)) = &action.cancelling {
                if now >= *deadline {
                    return Err(error(
                        "NODE_BACKEND_INTERRUPTED",
                        "backendActionCancellationDeadline",
                    ));
                }
            } else if let Err(cause) = (action.authorize)().and_then(|()| {
                self.registrations
                    .validate_action(&action.package, &action.definition)
            }) {
                cancelled.push((*id, cause));
            } else if action
                .debug_command
                .is_some_and(|(_, deadline)| now >= deadline)
            {
                cancelled.push((*id, debugger_unavailable()));
            }
        }
        for (id, cause) in cancelled {
            self.send(Command::CancelAction {
                request_id: id.into(),
            })?;
            let action = self.actions.get_mut(&id).expect("active action");
            action.cancelling = Some((now + self.limits.command_timeout, cause));
            if let Some(debugger) = action.debugger() {
                debugger.close();
            }
        }
        self.poll_script_debuggers(now)
    }

    fn poll_script_debuggers(&mut self, now: Instant) -> HostResult<()> {
        let mut commands = Vec::new();
        for (id, action) in &mut self.actions {
            if action.cancelling.is_some() || action.cleanup_deadline.is_some() {
                continue;
            }
            if action.debug_command.is_some() {
                continue;
            }
            if let Some(debugger) = action.debugger()
                && let Some(command) = debugger.take_command()
            {
                commands.push((*id, debugger.clone(), command));
            }
        }
        for (id, debugger, command) in commands {
            let request_id = self.next()?;
            let effect_started = self.effect_started;
            let sent = self.send(Command::ScriptDebugCommand {
                request_id,
                action_request_id: id.into(),
                command: &command,
            });
            self.effect_started = effect_started;
            match sent {
                Ok(()) => {
                    self.actions
                        .get_mut(&id)
                        .expect("active debug task")
                        .debug_command = Some((request_id, now + self.limits.command_timeout));
                }
                Err(error) => debugger.complete(Err(error)),
            }
        }
        Ok(())
    }

    fn action_frame(&mut self, frame: Frame) -> HostResult<Option<Frame>> {
        if let Frame::OperationGet {
            request_id,
            parent_request_id,
            parent_operation_id,
            task_context,
            params,
        } = frame
        {
            self.validate_request_sequence(request_id)?;
            let attempt = (|| {
                let task =
                    self.task_context(parent_request_id, &parent_operation_id, &task_context)?;
                if self.task_requests.len() >= super::QUEUE {
                    return Err(error("HOST_BUSY", "backendTaskCapacity"));
                }
                let selector = serde_json::from_value(params).map_err(|_| {
                    serial_workbench_core::HostError::new(
                        "INVALID_ARGUMENT",
                        "Operation selector is invalid",
                    )
                })?;
                let future = (task.get_operation)(selector);
                let (sent, response) = tokio::sync::oneshot::channel();
                let work = task.runtime.spawn(async move {
                    let _ = sent.send(future.await);
                });
                Ok(PendingTaskRequest {
                    response,
                    work,
                    parent_request_id,
                })
            })();
            match attempt {
                Ok(pending) => {
                    self.task_requests.insert(request_id.get(), pending);
                }
                Err(error) => self.task_reply(
                    request_id,
                    TaskOperationReply {
                        result: Err(error),
                        before_admission: true,
                    },
                )?,
            }
            return Ok(None);
        }
        if let Frame::InvokeChild {
            request_id,
            parent_request_id,
            call,
        } = frame
        {
            self.validate_request_sequence(request_id)?;
            let attempt = (|| {
                let task = self.task_context(
                    parent_request_id,
                    &call.parent_operation_id,
                    &call.task_context,
                )?;
                if self.task_requests.len() >= super::QUEUE {
                    return Err(error("HOST_BUSY", "backendChildCapacity"));
                }
                let future = (task.invoke_child)(*call);
                let (sent, response) = tokio::sync::oneshot::channel();
                let work = task.runtime.spawn(async move {
                    let _ = sent.send(future.await);
                });
                Ok(PendingTaskRequest {
                    response,
                    work,
                    parent_request_id,
                })
            })();
            match attempt {
                Ok(pending) => {
                    self.task_requests.insert(request_id.get(), pending);
                }
                Err(error) => self.task_reply(
                    request_id,
                    TaskOperationReply {
                        result: Err(error),
                        before_admission: true,
                    },
                )?,
            }
            return Ok(None);
        }
        if let Frame::ScriptDebugSnapshot { request_id, value } = frame {
            let debugger = self
                .actions
                .get(&request_id.get())
                .and_then(PendingAction::debugger)
                .ok_or_else(|| error("PROTOCOL_ERROR", "backendUnknownScriptDebugger"))?;
            debugger.observe(value)?;
            return Ok(None);
        }
        if let Frame::ScriptDebugReply {
            request_id,
            outcome,
        } = frame
        {
            if let Some(action) = self.actions.values_mut().find(|pending| {
                pending
                    .debug_command
                    .is_some_and(|(id, _)| id == request_id)
            }) {
                action.debug_command = None;
                if let Some(debugger) = action.debugger() {
                    debugger.complete(outcome.result());
                }
            }
            // An acknowledged command can arrive after the action has already settled.
            return Ok(None);
        }
        if let Frame::ActionStopping { request_id } = frame {
            let pending = self
                .actions
                .get_mut(&request_id.get())
                .ok_or_else(|| error("PROTOCOL_ERROR", "backendUnknownActionCleanup"))?;
            // 只启动原停止预算；不结束调用，不重置更早取消，也不归还实际工作名额。
            pending
                .cleanup_deadline
                .get_or_insert(Instant::now() + self.limits.command_timeout);
            if let Some(debugger) = pending.debugger() {
                debugger.close();
            }
            return Ok(None);
        }
        let (request_id, outcome, observation) = match frame {
            Frame::ActionCompleted {
                request_id,
                value,
                observation,
            } => (request_id, ActionOutcome::Completed(value), observation),
            Frame::ActionFailed {
                request_id,
                observation,
            } => (request_id, ActionOutcome::Failed, observation),
            Frame::ActionCancelled {
                request_id,
                observation,
            } => (request_id, ActionOutcome::Cancelled, observation),
            Frame::ActionInterrupted {
                request_id,
                observation,
            } => (request_id, ActionOutcome::Interrupted, observation),
            frame => return Ok(Some(frame)),
        };
        let pending = self
            .actions
            .remove(&request_id.get())
            .ok_or_else(|| error("PROTOCOL_ERROR", "backendUnknownActionReceipt"))?;
        if let Some(observation) = observation
            && let Err(cause) = pending.observations.update(&observation)
        {
            eprintln!("node_observation_rejected code={}", cause.code);
        }
        let result = match outcome {
            ActionOutcome::Completed(value) => Ok(value),
            ActionOutcome::Failed => Err(error("NODE_ACTION_FAILED", "backendActionHandler")),
            ActionOutcome::Interrupted => {
                Err(error("NODE_WORKER_INTERRUPTED", "backendTaskWorker"))
            }
            ActionOutcome::Cancelled => Err(pending
                .cancelling
                .map(|(_, cause)| cause)
                // 任务数据回执可先于监督轮的取消控制帧到达 Node。仅接受 Host 此刻已确认的取消。
                .or_else(|| {
                    (pending.authorize)()
                        .err()
                        .filter(|error| error.code == "CANCELLED")
                })
                .unwrap_or_else(|| {
                    // 插件自行声称取消不能代替Host请求，也不能留下不可结算的Running。
                    error("NODE_ACTION_FAILED", "backendUnexpectedActionCancellation")
                })),
        };
        // 只有处理器实际完成才归还调用方；晚到的成功保留已发生结果。
        let _ = pending.reply.send(result);
        Ok(None)
    }
    pub(super) fn run(mut self, receiver: Receiver<Request>) -> NodeBackendExit {
        loop {
            if self.cancel.load(Ordering::Acquire) || self.stop.load(Ordering::Acquire) {
                return self.finish(None);
            }
            if let Err(cause) = self
                .health(false)
                .and_then(|()| self.check_active())
                .and_then(|()| self.poll_actions())
                .and_then(|()| self.poll_task_requests())
                .and_then(|()| self.poll_raw())
                .and_then(|()| self.poll_derived())
            {
                if self.cancel.load(Ordering::Acquire) || self.stop.load(Ordering::Acquire) {
                    return self.finish(None);
                }
                return self.finish(Some(cause));
            }
            // 持续有数据时仍回到取消/期限检查，观察不能占住整个监督轮。
            for _ in 0..super::QUEUE {
                let Ok(bytes) = self.process.io.receive.try_recv() else {
                    break;
                };
                match serde_json::from_slice::<Frame>(&bytes) {
                    Ok(Frame::Heartbeat { sample }) => self.observe_heartbeat(sample),
                    Ok(frame) => match self.action_frame(frame) {
                        Ok(None) => {}
                        Ok(Some(_)) => {
                            return self
                                .finish(Some(error("PROTOCOL_ERROR", "backendUnsolicitedFrame")));
                        }
                        Err(error) => return self.finish(Some(error)),
                    },
                    Err(_) => return self.finish(Some(error("PROTOCOL_ERROR", "backendResponse"))),
                }
            }
            match receiver.try_recv() {
                Ok(Request::Activate {
                    package,
                    definitions,
                    authorize,
                    completed,
                    reply,
                }) => {
                    self.effect_started = false;
                    let result = self.activate(*package, definitions, authorize, completed);
                    if let Err(cause) = &result
                        && self.effect_started
                    {
                        let report = self.finish(Some(cause.clone()));
                        let _ = reply.send(result);
                        return report;
                    }
                    let _ = reply.send(result);
                }
                Ok(Request::Dispose {
                    id,
                    authorize,
                    reply,
                }) => {
                    self.effect_started = false;
                    let result = self.dispose(id, authorize.as_ref());
                    if let Err(cause) = &result
                        && self.effect_started
                    {
                        let report = self.finish(Some(cause.clone()));
                        let _ = reply.send(result);
                        return report;
                    }
                    let _ = reply.send(result);
                }
                Ok(Request::Query {
                    package,
                    query,
                    definition,
                    authorize,
                    reply,
                }) => {
                    self.effect_started = false;
                    let result = self.query(package, *query, definition, authorize.as_ref());
                    if let Err(cause) = &result
                        && self.effect_started
                    {
                        let report = self.finish(Some(cause.clone()));
                        let _ = reply.send(result);
                        return report;
                    }
                    let _ = reply.send(result);
                }
                Ok(Request::OpenTransport {
                    package,
                    definition,
                    endpoint,
                    params,
                    authorize,
                    reply,
                }) => {
                    self.effect_started = false;
                    let result = self.start_transport(
                        package,
                        definition,
                        endpoint,
                        params,
                        authorize.as_ref(),
                    );
                    if let Err(cause) = &result
                        && self.effect_started
                    {
                        let report = self.finish(Some(cause.clone()));
                        let _ = reply.send(result);
                        return report;
                    }
                    let _ = reply.send(result);
                }
                Ok(Request::Invoke {
                    package,
                    call,
                    definition,
                    authorize,
                    before_dispatch,
                    observations,
                    reply,
                }) => {
                    self.effect_started = false;
                    let failed = reply.clone();
                    let result = self.start_action(
                        package,
                        *call,
                        definition,
                        authorize,
                        before_dispatch,
                        observations,
                        reply,
                    );
                    if let Err(cause) = result {
                        if self.effect_started {
                            let report = self.finish(Some(cause.clone()));
                            let _ = failed.send(Err(cause));
                            return report;
                        }
                        let _ = failed.send(Err(cause));
                    }
                }
                Err(mpsc::TryRecvError::Empty) => thread::park_timeout(TICK),
                Err(mpsc::TryRecvError::Disconnected) => return self.finish(None),
            }
        }
    }
    fn validate_request_sequence(&mut self, request_id: U64) -> HostResult<()> {
        if request_id.get() <= self.request_sequence {
            return Err(error("PROTOCOL_ERROR", "backendTaskSequence"));
        }
        self.request_sequence = request_id.get();
        Ok(())
    }
    fn observe_heartbeat(&mut self, sample: Option<super::telemetry::NodeSample>) {
        self.heartbeat = Instant::now();
        if let Some(sample) = sample {
            if let Err(cause) = self.metrics.update(self.process.child.id(), &sample) {
                eprintln!("node_metrics_rejected code={}", cause.code);
            }
            if let Some(task) = sample.task
                && let Some(pending) = self.actions.get(&task.request_id.get())
                && pending.task.is_some()
                && let Err(cause) = pending.observations.update(&task.observation)
            {
                eprintln!("node_observation_rejected code={}", cause.code);
            }
        }
    }
    fn task_context(
        &self,
        parent: U64,
        operation: &serial_workbench_core::Id,
        context: &serial_workbench_core::ContextToken,
    ) -> HostResult<&DispatchedTask> {
        let parent = self
            .actions
            .get(&parent.get())
            .ok_or_else(|| error("OPERATION_NOT_RUNNING", "backendParentFinished"))?;
        (parent.authorize)()?;
        let task = parent
            .task
            .as_ref()
            .ok_or_else(|| error("PERMISSION_DENIED", "backendParentWithoutTask"))?;
        if &task.operation != operation || &task.context != context {
            return Err(error("PERMISSION_DENIED", "backendTaskOwnerMismatch"));
        }
        Ok(task)
    }
    fn task_reply(&mut self, request_id: U64, outcome: TaskOperationReply) -> HostResult<()> {
        use serial_workbench_core::{False, OperationResult, RpcReply, RpcResult, True};
        let reply = match outcome.result {
            Ok(operation) => RpcReply::Success {
                ok: True,
                result: Box::new(RpcResult::Operation(Box::new(OperationResult {
                    operation,
                }))),
            },
            Err(error) => RpcReply::Failure { ok: False, error },
        };
        self.send(Command::TaskReply {
            request_id,
            reply: &reply,
            before_admission: outcome.before_admission,
        })
    }
    fn poll_task_requests(&mut self) -> HostResult<()> {
        let mut ready = Vec::new();
        for (id, child) in &mut self.task_requests {
            match child.response.try_recv() {
                Ok(result) => ready.push((*id, child.parent_request_id, result)),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => ready.push((
                    *id,
                    child.parent_request_id,
                    TaskOperationReply {
                        result: Err(error("NODE_ACTION_FAILED", "backendChildAdmissionEnded")),
                        before_admission: false,
                    },
                )),
            }
        }
        for (id, parent, mut result) in ready {
            self.task_requests.remove(&id);
            if result.result.is_ok() {
                let current = self
                    .actions
                    .get(&parent.get())
                    .ok_or_else(|| error("OPERATION_NOT_RUNNING", "backendParentFinished"))
                    .and_then(|parent| (parent.authorize)());
                if let Err(error) = current {
                    result.result = Err(error);
                    result.before_admission = false;
                }
            }
            self.task_reply(id.into(), result)?;
        }
        Ok(())
    }
    pub(super) fn finish(
        mut self,
        mut cause: Option<serial_workbench_core::HostError>,
    ) -> NodeBackendExit {
        if cause.is_none() {
            let graceful = (|| {
                let request_id = self.next()?;
                self.send(Command::Shutdown { request_id })?;
                match self.frame(Instant::now() + self.limits.command_timeout, true, &|| {
                    Ok(())
                })? {
                    Frame::Stopped {
                        request_id: response_id,
                    } if response_id == request_id => Ok(()),
                    _ => Err(error("NODE_DISPOSE_FAILED", "backendShutdown")),
                }
            })();
            if let Err(error) = graceful {
                cause = Some(error);
            }
        }
        let process_id = self.process.child.id();
        let status = self.process.stop();
        if let Err(reap_error) = &status {
            eprintln!(
                "node_backend_reap_failed os_error={:?} reaped={}",
                reap_error.raw_os_error(),
                self.process.child.is_closed()
            );
            if cause.is_none() {
                cause = Some(error("NODE_BACKEND_INTERRUPTED", "backendReap"));
            }
        }
        NodeBackendExit {
            process_id,
            reaped: self.process.child.is_closed(),
            exit_code: status.ok().and_then(|status| status.code()),
            error: cause,
            stderr: self.process.io.stderr(),
        }
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        // panic和正常退出都先撤下登记；Process仍负责持有执行证明至真实回收。
        self.registrations.clear();
    }
}
struct Process {
    child: RuntimeChild,
    scope: process_scope::ProcessScope,
    io: pipes::Pipes,
    runtime: VerifiedNodeRuntime,
    packages: Vec<VerifiedNodeInstallation>,
    reaped: Option<ExitStatus>,
    observation: Arc<Mutex<ExitObservation>>,
}
impl Process {
    fn new(
        runtime: VerifiedNodeRuntime,
        timeout: Duration,
        cancel: &AtomicBool,
        observation: Arc<Mutex<ExitObservation>>,
    ) -> HostResult<Self> {
        let script_worker = serde_json::to_string(include_str!("script-worker.mjs"))
            .map_err(|_| error("INTERNAL_ERROR", "scriptWorkerSource"))?;
        let bootstrap = format!(
            "const scriptWorkerSource = {script_worker};\n{}",
            concat!(
                include_str!("transport.mjs"),
                "\n",
                include_str!("script-debugger.mjs"),
                "\n",
                include_str!("bootstrap.mjs")
            )
        )
        .into_bytes();
        if bootstrap.is_empty() || bootstrap.len() > serial_workbench_ipc::frame::MAX_FRAME_BYTES {
            return Err(error("LIMIT_EXCEEDED", "backendBootstrapFrame"));
        }
        let scope = process_scope::ProcessScope::new()?;
        let child = runtime.spawn_backend(
            include_str!("loader.mjs"),
            timeout,
            cancel,
            |process_id, reaped, exit_code| {
                let mut observed = observation
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                observed.process_id = process_id;
                observed.reaped = reaped;
                observed.exit_code = exit_code;
            },
        )?;
        let mut owner = Self {
            child,
            scope,
            io: pipes::Pipes::empty(),
            runtime,
            packages: Vec::new(),
            reaped: None,
            observation,
        };
        // 固定 bootstrap 先等 Host 命令；纳入进程责任后才允许送激活命令。
        owner.scope.attach(owner.child.process())?;
        owner.io.start(owner.child.io())?;
        // 进程已纳入责任后，首帧经原有有界writer交付；激活仍按同一FIFO与期限监督。
        owner
            .io
            .send
            .try_send(bootstrap)
            .map_err(|_| error("HOST_BUSY", "backendBootstrapQueue"))?;
        Ok(owner)
    }
    fn stop(&mut self) -> std::io::Result<ExitStatus> {
        let status = if let Some(status) = self.reaped {
            Ok(status)
        } else if self.child.is_closed() {
            // 原始终态可能随监护丢失；实际已结束时绝不能再次使用已reap的PID杀组。
            Err(std::io::Error::other("Node exit status unavailable"))
        } else {
            self.scope.terminate(self.child.io());
            // Job 接纳失败时子进程尚不在 Job 中；所有路径都保留直接终止责任。
            let _ = self.child.kill();
            loop {
                match self.child.wait() {
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    result => break result,
                }
            }
        };
        self.reaped = status.as_ref().ok().copied();
        self.io.stop();
        let mut observed = self
            .observation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        observed.reaped = self.child.is_closed();
        observed.exit_code = self.reaped.and_then(|status| status.code());
        observed.stderr = self.io.stderr();
        status
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
