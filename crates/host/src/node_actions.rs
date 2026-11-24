//! 动态动作复用持久接纳与实际派发，工作名额一直跟随真实后台与结果提交。
use super::node_queries::QueryAuthority;
use super::*;
use crate::{node_backend::RegisteredHandler, storage::PluginOperation};
use serial_workbench_core::{
    NODE_CSV_RESULT_MAX_BYTES, NODE_FILE_RESULT_KEY, NODE_PNG_RESULT_MAX_BYTES, PNG_SIGNATURE,
    SchemaValue,
};

pub(super) struct ActionAuthority {
    host: Host,
    operation: Id,
    caller: Arc<QueryAuthority>,
    cached: Mutex<(OperationState, tokio::sync::watch::Receiver<()>)>,
}
enum ExtensionRequest {
    Existing(Box<Operation>),
    New(Box<PreparedExtension>),
    Dormant,
}
struct PreparedExtension {
    call: Call,
    binding: Arc<RegisteredHandler>,
    authority: Arc<QueryAuthority>,
    plugin: PluginOperation,
}
fn request_conflict() -> HostError {
    HostError::new(
        "REQUEST_CONFLICT",
        "Request identity is already bound to another intent",
    )
}
impl ActionAuthority {
    fn new(host: Host, operation: Id, caller: Arc<QueryAuthority>) -> HostResult<Self> {
        let mut changes = host.inner.store.subscribe_operation_state_changes();
        changes.borrow_and_update();
        let state = host.inner.store.operation_state(&operation)?;
        Ok(Self {
            host,
            operation,
            caller,
            cached: Mutex::new((state, changes)),
        })
    }
    pub(super) fn check(&self) -> HostResult<()> {
        self.caller.check()?;
        let mut cached = self.cached.lock().map_err(|_| busy())?;
        if cached.1.has_changed().unwrap_or(true) {
            cached.1.borrow_and_update();
            cached.0 = self.host.inner.store.operation_state(&self.operation)?;
        }
        match cached.0 {
            OperationState::Queued | OperationState::Running => Ok(()),
            OperationState::CancelRequested | OperationState::Cancelled => Err(HostError::new(
                "CANCELLED",
                "Operation cancellation requested",
            )),
            _ => Err(HostError::new(
                "OPERATION_NOT_RUNNING",
                "Operation is not running",
            )),
        }
    }
}
impl Host {
    fn replay_extension_call(
        &self,
        actor: &AuthenticatedActor,
        raw: &Call,
    ) -> HostResult<Option<Operation>> {
        self.extension_identity(actor, &call_query(raw))?;
        let selector = if let Some(task) = actor.task() {
            let child = task.child()?;
            OperationGetParams::ByChild {
                parent_operation_id: child.parent_operation_id.clone(),
                child_key: child.child_key,
            }
        } else {
            OperationGetParams::ByRequest {
                actor_id: raw.actor_id.clone(),
                request_id: raw.request_id.clone(),
                request_context: raw.request_context.clone(),
            }
        };
        let previous = match self.inner.store.get_selected(actor, &selector) {
            Ok(operation) => operation,
            Err(error) if error.code == "NOT_FOUND" => return Ok(None),
            Err(error) => return Err(error),
        };
        if previous.owner.kind != OwnerKind::Plugin || previous.action_id != raw.action_id {
            return Err(request_conflict());
        }
        let saved = self.inner.store.plugin_operation(&previous.operation_id)?;
        let (_, retained_params) = self
            .inner
            .store
            .retained_operation(&previous.operation_id)?;
        // 已接纳参数的有界形状约束比较；相同输入无需在全局压力下重新编译。
        // 缺失默认值或不同输入仍按原保存schema规范化，再核对完整摘要。
        let params = match retained_params {
            Some(params) if params == raw.params => params,
            _ => crate::node_backend::normalize_saved_parameters(&saved.spec, &raw.params)
                .map_err(|error| {
                    if error.code == "INVALID_ARGUMENT" {
                        request_conflict()
                    } else {
                        error
                    }
                })?,
        };
        let mut normalized = raw.clone();
        normalized.params = params;
        self.inner
            .store
            .lookup_call(actor, &normalized, &canonical_digest(&normalized)?)?
            .map(Some)
            .ok_or_else(|| {
                HostError::new(
                    "RESULT_EXPIRED",
                    "Retained operation evidence is no longer available",
                )
            })
    }
    fn prepare_extension_call(
        &self,
        actor: &AuthenticatedActor,
        mut call: Call,
    ) -> HostResult<PreparedExtension> {
        let binding = self.inner.registry.runtime.resolve(&call.action_id)?;
        if binding.spec().kind != ActionKind::Action {
            return Err(invalid());
        }
        let authority = Arc::new(QueryAuthority::new(
            self.clone(),
            actor.clone(),
            call.target.clone(),
            binding.clone(),
        )?);
        call.params = binding.normalize_parameters(&call.params)?;
        binding.validate_call(&call)?;
        binding.current()?;
        call.reveal_target = binding.spec().reveal_target.clone();
        if serde_json::to_vec(&call).map_err(|_| invalid())?.len()
            > serial_workbench_ipc::frame::MAX_FRAME_BYTES
        {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Normalized action exceeds the control frame budget",
            ));
        }
        let plugin = PluginOperation {
            format_version: "0.1".into(),
            package: binding.package().clone(),
            version: NodePackageVersion::try_from(binding.version())?,
            archive_sha256: binding.archive_sha256().clone(),
            instance_id: binding.instance_id().clone(),
            host_api: binding.host_api().to_vec(),
            spec: binding.spec().clone(),
        };
        Ok(PreparedExtension {
            call,
            binding,
            authority,
            plugin,
        })
    }
    fn prepare_extension_request(
        &self,
        caller: &AuthenticatedActor,
        call: Call,
    ) -> HostResult<ExtensionRequest> {
        self.extension_identity(caller, &call_query(&call))?;
        if let Some(existing) = self.replay_extension_call(caller, &call)? {
            return Ok(ExtensionRequest::Existing(Box::new(existing)));
        }
        #[cfg(test)]
        self.inner.node_test_gates.action_lookup_missing.arrive();
        match self.prepare_extension_call(caller, call.clone()) {
            Ok(prepared) => Ok(ExtensionRequest::New(Box::new(prepared))),
            Err(error) => match self.replay_extension_call(caller, &call)? {
                Some(existing) => Ok(ExtensionRequest::Existing(Box::new(existing))),
                None if error.code == "UNSUPPORTED_CAPABILITY" => Ok(ExtensionRequest::Dormant),
                None => Err(error),
            },
        }
    }
    pub(super) async fn invoke_extension(
        &self,
        actor: &AuthenticatedActor,
        call: Call,
    ) -> HostResult<Operation> {
        let host = self.clone();
        let caller = actor.clone();
        let raw_call = call.clone();
        let mut prepared = blocking(move || host.prepare_extension_request(&caller, call)).await?;
        let mut activation_permit = None;
        if matches!(prepared, ExtensionRequest::Dormant) {
            // 懒激活等待也占同一个Host名额，重放仍在此前返回，不占backend执行名额。
            let permit = self
                .inner
                .capacity
                .clone()
                .try_acquire_owned()
                .map_err(|_| busy())?;
            let permit = Arc::new(permit);
            self.ensure_extension_active(
                actor,
                &call_query(&raw_call),
                ActionKind::Action,
                permit.clone(),
            )
            .await?;
            let host = self.clone();
            let caller = actor.clone();
            let call = raw_call.clone();
            let preparation_budget = permit.clone();
            prepared = blocking(move || {
                let _budget = preparation_budget;
                host.prepare_extension_request(&caller, call)
            })
            .await?;
            activation_permit = Some(permit);
        }
        let prepared = match prepared {
            ExtensionRequest::Existing(existing) => {
                let (operation, _) = self
                    .inspect_operation(
                        actor,
                        &raw_call.target,
                        OperationGetParams::ById {
                            operation_id: existing.operation_id,
                            request_context: None,
                        },
                        false,
                    )
                    .await?;
                return Ok(operation);
            }
            ExtensionRequest::New(prepared) => *prepared,
            ExtensionRequest::Dormant => {
                return Err(HostError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "Contribution is not registered",
                ));
            }
        };
        let PreparedExtension {
            call,
            binding,
            authority,
            plugin,
        } = prepared;
        let backend_permit = binding.reserve_action()?;
        let permit = match activation_permit {
            Some(permit) => permit,
            None => Arc::new(
                self.inner
                    .capacity
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| busy())?,
            ),
        };
        let (sent, receive) = oneshot::channel();
        let host = self.clone();
        let actor = actor.clone();
        {
            let mut jobs = self.inner.jobs.lock().map_err(|_| busy())?;
            if jobs.closing {
                return Err(HostError::new("HOST_CLOSING", "Host is closing"));
            }
            jobs.handles.retain(|job| !job.handle.is_finished());
            let operation_id = Arc::new(Mutex::new(None));
            let accepted_slot = operation_id.clone();
            actor.mark_admission_queued();
            let handle = tokio::spawn(async move {
                let _permit = permit;
                let store = host.inner.store.clone();
                let accept_actor = actor.clone();
                let accept_call = call.clone();
                let check = authority.clone();
                let active = binding.clone();
                let replay_host = host.clone();
                let original = raw_call;
                #[cfg(test)]
                let gates = host.inner.node_test_gates.clone();
                let accepted = blocking(move || {
                    let attempt = (|| {
                        check.check()?;
                        active.current()?;
                        #[cfg(test)]
                        gates.action_before_accept.arrive();
                        store.accept_plugin(
                            &accept_actor,
                            &accept_call,
                            &canonical_digest(&accept_call)?,
                            &plugin,
                        )
                    })();
                    let acceptance = match attempt {
                        Ok(Acceptance::New(operation)) => Acceptance::New(operation),
                        other => {
                            match replay_host.replay_extension_call(&accept_actor, &original)? {
                                Some(operation) => Acceptance::Existing(operation),
                                None => other?,
                            }
                        }
                    };
                    let operation = match &acceptance {
                        Acceptance::New(operation) | Acceptance::Existing(operation) => operation,
                    };
                    *accepted_slot.lock().map_err(|_| busy())? =
                        Some(operation.operation_id.clone());
                    Ok(acceptance)
                })
                .await;
                match accepted {
                    Err(error) => {
                        let _ = sent.send(Err(error));
                    }
                    Ok(Acceptance::Existing(operation)) => {
                        let replay = host
                            .inspect_operation(
                                &actor,
                                &call.target,
                                OperationGetParams::ById {
                                    operation_id: operation.operation_id,
                                    request_context: None,
                                },
                                false,
                            )
                            .await
                            .map(|(operation, _)| operation);
                        let _ = sent.send(replay);
                    }
                    Ok(Acceptance::New(operation)) => {
                        host.observe_mcp_operation(&actor, &operation).await;
                        let _ = sent.send(Ok(operation.clone()));
                        let mut call = call;
                        call.request_id = operation.request_id.clone();
                        host.execute_extension(
                            AcceptedCall {
                                actor,
                                call,
                                operation,
                            },
                            binding,
                            authority,
                            backend_permit,
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
    async fn execute_extension(
        &self,
        accepted: AcceptedCall,
        binding: Arc<RegisteredHandler>,
        caller: Arc<QueryAuthority>,
        permit: tokio::sync::OwnedSemaphorePermit,
    ) {
        let host = self.clone();
        let operation_id = accepted.operation.operation_id.clone();
        let id = operation_id.clone();
        let runtime = tokio::runtime::Handle::current();
        let output = blocking(move || {
            let authority = Arc::new(ActionAuthority::new(host.clone(), id.clone(), caller)?);
            authority.check()?;
            if accepted.actor.mcp_client_id().is_none() {
                host.activity_with_reveal(
                    &accepted.actor,
                    &call_query(&accepted.call),
                    binding.spec().reveal_target.clone(),
                )?;
            }
            let check = authority.clone();
            let dispatch = authority.clone();
            let dispatcher = host.clone();
            let active = binding.clone();
            let dispatch_call = AcceptedCall {
                actor: accepted.actor.clone(),
                call: accepted.call.clone(),
                operation: accepted.operation.clone(),
            };
            let _task = host.task_lease(&id);
            let observation_store = host.inner.store.clone();
            let observation_id = id.clone();
            let observation_instance = binding.instance_id().clone();
            let observation_epoch = accepted.call.instance_epoch;
            let value = binding.invoke_reserved(
                accepted.call,
                permit,
                move || check.check(),
                move || {
                    dispatch.check()?;
                    dispatcher
                        .dispatch_extension_task(
                            &dispatch_call,
                            active.clone(),
                            dispatch.clone(),
                            runtime.clone(),
                        )
                        .map(Some)
                },
                Arc::new(move |observation| {
                    observation_store
                        .record_plugin_observation(
                            &observation_id,
                            &observation_instance,
                            observation_epoch,
                            observation.progress.clone(),
                            observation.worker_observation.clone(),
                        )
                        .map(|_| ())
                }),
            )?;
            if let Some(format) = binding.spec().output_schema.get(NODE_FILE_RESULT_KEY) {
                use base64::{Engine as _, engine::general_purpose::STANDARD};
                return value
                    .as_str()
                    .and_then(|encoded| STANDARD.decode(encoded).ok())
                    .filter(|bytes| !bytes.is_empty())
                    .filter(|bytes| match format {
                        SchemaValue::String(mime) if mime == "text/csv" => {
                            bytes.len() <= NODE_CSV_RESULT_MAX_BYTES
                                && std::str::from_utf8(bytes).is_ok()
                        }
                        SchemaValue::String(mime) if mime == "image/png" => {
                            bytes.len() <= NODE_PNG_RESULT_MAX_BYTES
                                && bytes.starts_with(PNG_SIGNATURE)
                        }
                        _ => true,
                    })
                    .ok_or_else(|| {
                        HostError::new(
                            "NODE_OUTPUT_INVALID",
                            "Invalid base64 artifact or file contents",
                        )
                    });
            }
            serde_json::to_vec(&value)
                .map_err(|_| HostError::new("NODE_OUTPUT_INVALID", "Cannot encode plugin result"))
        })
        .await;
        let child_outcome = self.wait_task_children(&operation_id).await;
        let store = self.inner.store.clone();
        let _ = blocking(move || {
            let mut outcome = match output {
                Ok(bytes) => match store.record_plugin_result(&operation_id, &bytes) {
                    Ok(result) => Settlement {
                        state: OperationState::Succeeded,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => Settlement {
                        state: OperationState::Unknown,
                        result: None,
                        error: Some(error),
                    },
                },
                Err(error) => {
                    let state = store.operation_state(&operation_id)?;
                    if state.is_terminal() {
                        return Ok(());
                    }
                    let terminal = if matches!(state, OperationState::Queued) {
                        if error.code == "CANCELLED" {
                            OperationState::Cancelled
                        } else {
                            OperationState::Interrupted
                        }
                    } else if error.code == "CANCELLED" && state == OperationState::CancelRequested
                    {
                        OperationState::Cancelled
                    } else if [
                        "CANCELLED",
                        "NODE_BACKEND_INTERRUPTED",
                        "NODE_OWNER_EXIT_UNCONFIRMED",
                    ]
                    .contains(&error.code.as_str())
                    {
                        OperationState::Unknown
                    } else if [
                        "PERMISSION_DENIED",
                        "HOST_CLOSING",
                        "CATALOG_CHANGED",
                        "NODE_WORKER_INTERRUPTED",
                    ]
                    .contains(&error.code.as_str())
                    {
                        OperationState::Interrupted
                    } else {
                        OperationState::Failed
                    };
                    Settlement {
                        state: terminal,
                        result: None,
                        error: Some(error),
                    }
                }
            };
            if child_outcome {
                outcome.state = OperationState::Unknown;
                outcome.error = Some(HostError::new(
                    "CHILD_OUTCOME_UNKNOWN",
                    "A child effect could not be confirmed",
                ));
            }
            store.settle(&operation_id, outcome).map(|_| ())
        })
        .await;
    }
}

#[cfg(test)]
#[path = "node_actions/native_tests.rs"]
mod native_tests;

#[cfg(test)]
#[path = "node_actions/task_lifetime_tests.rs"]
mod task_lifetime_tests;

#[cfg(test)]
#[path = "node_actions/restart_tests.rs"]
mod restart_tests;

#[cfg(test)]
#[path = "node_actions/upgrade_tests.rs"]
mod upgrade_tests;

#[cfg(test)]
#[path = "node_actions/lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "node_actions/lifecycle_commit_tests.rs"]
mod lifecycle_commit_tests;
