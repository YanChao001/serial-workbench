//! 真实执行上下文只登记到处理器完成；已接纳子项仍由现有Host任务拥有。
use super::node_actions::ActionAuthority;
use super::*;
use crate::{
    auth::TaskAuthority,
    node_backend::{
        DispatchedTask, RegisteredHandler, TaskDerivedFuture, TaskOperationReply, TaskRawFuture,
        TaskRawPage, TaskRawResult,
    },
};

pub(super) struct TaskScope {
    actor: AuthenticatedActor,
    operation: Operation,
    binding: Arc<RegisteredHandler>,
    authority: Arc<ActionAuthority>,
    instance_epoch: U64,
    configuration_digest: Digest,
}
impl TaskScope {
    fn check_reader(self: &Arc<Self>, host: &Host) -> HostResult<()> {
        let current = host
            .inner
            .tasks
            .lock()
            .map_err(|_| busy())?
            .get(&self.operation.operation_id)
            .is_some_and(|known| Arc::ptr_eq(known, self));
        if !current {
            return Err(HostError::new(
                "OPERATION_NOT_RUNNING",
                "Task reader owner has finished",
            ));
        }
        if host.inner.store.identity()?.instance_epoch != self.instance_epoch {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Host instance has changed",
            ));
        }
        self.authority.check()
    }
    fn delegate(
        self: &Arc<Self>,
        host: &Host,
        admission: Option<ChildCall>,
        admission_queued: Arc<std::sync::atomic::AtomicBool>,
    ) -> HostResult<AuthenticatedActor> {
        let check: Arc<dyn Fn() -> HostResult<()> + Send + Sync> = if admission.is_some() {
            self.authority.check()?;
            let authority = self.authority.clone();
            Arc::new(move || authority.check())
        } else {
            self.check_reader(host)?;
            let scope = self.clone();
            let host = host.clone();
            Arc::new(move || scope.check_reader(&host))
        };
        Ok(self.actor.with_task(TaskAuthority {
            admission,
            owner_instance: self.binding.instance_id().clone(),
            execution_mode: self.operation.execution_mode,
            scope: self.operation.target.clone(),
            host_api: self.binding.host_api().to_vec(),
            inherited: self.actor.task().cloned(),
            admission_queued,
            check,
        }))
    }
}
pub(super) struct TaskLease {
    host: Host,
    operation: Id,
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        self.host
            .inner
            .tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.operation);
        self.host.inner.derived.retire(&self.operation);
        // 与子接纳使用同一writer；关闭后排队的新调用不能推进父水位。
        let _ = self.host.inner.store.close_task_admission(&self.operation);
    }
}
impl Host {
    pub(super) fn task_lease(&self, operation: &Id) -> TaskLease {
        TaskLease {
            host: self.clone(),
            operation: operation.clone(),
        }
    }
    pub(super) fn dispatch_extension_task(
        &self,
        accepted: &AcceptedCall,
        binding: Arc<RegisteredHandler>,
        authority: Arc<ActionAuthority>,
        runtime: tokio::runtime::Handle,
    ) -> HostResult<DispatchedTask> {
        authority.check()?;
        let context = self
            .inner
            .store
            .dispatch_task(&accepted.operation.operation_id, binding.instance_id())?;
        use sha2::Digest as _;
        let configuration = serde_json::to_vec(&accepted.call.params).map_err(|_| invalid())?;
        let configuration_digest =
            Digest::try_from(format!("{:x}", sha2::Sha256::digest(configuration)).as_str())?;
        let scope = Arc::new(TaskScope {
            actor: accepted.actor.clone(),
            operation: accepted.operation.clone(),
            binding,
            authority,
            instance_epoch: accepted.call.instance_epoch,
            configuration_digest,
        });
        self.inner
            .tasks
            .lock()
            .map_err(|_| busy())?
            .insert(scope.operation.operation_id.clone(), scope.clone());
        let host = self.clone();
        let reader = self.clone();
        let read_scope = scope.clone();
        let raw_reader = self.clone();
        let raw_scope = scope.clone();
        // 读取器与已派发任务同寿命。不要放进 TaskScope，读取授权本身持有 scope。
        let session_events = Arc::new(tokio::sync::Mutex::new(None));
        let session_cleanup = session_events.clone();
        let publisher = self.clone();
        let publish_scope = scope.clone();
        Ok(DispatchedTask {
            context,
            operation: scope.operation.operation_id.clone(),
            runtime,
            invoke_child: Arc::new(move |call| host.invoke_child_attempt(&scope.actor, call)),
            get_operation: Arc::new(move |selector| {
                reader.get_task_operation(read_scope.clone(), selector)
            }),
            read_raw: Arc::new(move |params, ordered| {
                raw_reader.read_task_raw(
                    raw_scope.clone(),
                    params,
                    ordered.then(|| session_events.clone()),
                )
            }),
            close_session_events: Arc::new(move || {
                // 归还读取者不依赖内容授权或新的读取名额。
                session_cleanup.try_lock().map_err(|_| busy())?.take();
                Ok(TaskRawPage::closed())
            }),
            publish_derived: Arc::new(move |params| {
                publisher.publish_task_derived(publish_scope.clone(), params)
            }),
        })
    }

    fn read_task_raw(
        &self,
        scope: Arc<TaskScope>,
        params: StreamReadParams,
        session_events: Option<Arc<tokio::sync::Mutex<Option<crate::stream::SessionEventReader>>>>,
    ) -> TaskRawFuture {
        let host = self.clone();
        Box::pin(async move {
            let owner = scope.operation.operation_id.clone();
            let reader = host.clone();
            host.run_task_data_job(&host.inner.node_raw_read_capacity, owner, async move {
                reader
                    .prepare_task_raw(scope, params, session_events.as_deref())
                    .await
            })
            .await
        })
    }

    fn publish_task_derived(
        &self,
        scope: Arc<TaskScope>,
        params: DerivedPublishParams,
    ) -> TaskDerivedFuture {
        let host = self.clone();
        Box::pin(async move {
            let owner = scope.operation.operation_id.clone();
            let publisher = host.clone();
            host.run_task_data_job(&host.inner.node_derived_capacity, owner, async move {
                blocking(move || publisher.commit_task_sample(scope, params)).await
            })
            .await
        })
    }

    async fn run_task_data_job<T: Send + 'static>(
        &self,
        capacity: &Arc<Semaphore>,
        owner: Id,
        work: impl std::future::Future<Output = HostResult<T>> + Send + 'static,
    ) -> HostResult<T> {
        let capacity = capacity.clone().try_acquire_owned().map_err(|_| busy())?;
        let (sent, received) = oneshot::channel();
        {
            let mut jobs = self.inner.jobs.lock().map_err(|_| busy())?;
            if jobs.closing {
                return Err(HostError::new("HOST_CLOSING", "Host is closing"));
            }
            jobs.handles.retain(|job| !job.handle.is_finished());
            let handle = tokio::spawn(async move {
                let _capacity = capacity;
                let _ = sent.send(work.await);
            });
            jobs.handles.push(OwnedJob {
                handle,
                operation_id: Arc::new(Mutex::new(Some(owner))),
            });
        }
        received.await.map_err(|_| busy())?
    }

    fn commit_task_sample(
        &self,
        scope: Arc<TaskScope>,
        params: DerivedPublishParams,
    ) -> HostResult<DerivedPublishResult> {
        params.validate()?;
        let source = &params.sources[0];
        let target = Target {
            host_id: scope.operation.execution_host_id.clone(),
            kind: ResourceKind::try_from("session")?,
            id: source.session_id.clone(),
            session_id: Some(source.session_id.clone()),
            session_epoch: Some(source.session_epoch),
        };
        let actor = scope.delegate(self, None, Arc::default())?;
        self.inner.auth.require(&actor, "content.read", &target)?;
        self.inner
            .streams
            .verify_derived_sources(&target, &params)?;
        let provenance = DerivedProvenance {
            sources: params.sources,
            parser_id: scope.binding.spec().action_id.clone(),
            parser_version: scope.binding.version().into(),
            configuration_digest: scope.configuration_digest.clone(),
            quality: params.quality,
            unit: params.unit,
        };
        #[cfg(test)]
        self.inner.node_test_gates.task_derived_ready.arrive();
        self.inner
            .auth
            .commit_authorized(&actor, &["content.read".into()], &target, || {
                let tasks = self.inner.tasks.lock().map_err(|_| busy())?;
                let owner = &scope.operation.operation_id;
                if !tasks
                    .get(owner)
                    .is_some_and(|task| Arc::ptr_eq(task, &scope))
                {
                    return Err(HostError::new(
                        "OPERATION_NOT_RUNNING",
                        "Derived publisher has finished",
                    ));
                }
                self.inner
                    .derived
                    .publish(owner.clone(), target.clone(), provenance, params.value)
            })
    }

    async fn prepare_task_raw(
        &self,
        scope: Arc<TaskScope>,
        params: StreamReadParams,
        session_events: Option<&tokio::sync::Mutex<Option<crate::stream::SessionEventReader>>>,
    ) -> HostResult<TaskRawPage> {
        let host = self.clone();
        let target = Target {
            host_id: scope.operation.execution_host_id.clone(),
            kind: ResourceKind::try_from("session")?,
            id: params.session_id.clone(),
            session_id: Some(params.session_id.clone()),
            session_epoch: Some(params.session_epoch),
        };
        let (actor, stamp) = blocking(move || {
            let actor = scope.delegate(&host, None, Arc::default())?;
            let snapshot = host.inner.auth.snapshot(&actor)?;
            snapshot.require("content.read", &target)?;
            let stamp = snapshot.capture_grants().ok_or_else(|| {
                HostError::new("PERMISSION_DENIED", "Raw data requires a scoped grant")
            })?;
            Ok((actor, stamp))
        })
        .await?;
        let streams = &self.inner.streams;
        let read = if let Some(session_events) = session_events {
            let mut events = session_events.try_lock().map_err(|_| busy())?;
            if events.is_none() {
                *events = Some(
                    streams
                        .open_session_events(
                            &actor,
                            &crate::stream::StreamKey {
                                session_id: params.session_id.clone(),
                                session_epoch: params.session_epoch,
                            },
                        )
                        .await?,
                );
            }
            let reader = events.as_ref().ok_or_else(busy)?;
            reader.read_prepared(params).await.map(|(page, end)| {
                let (page, lease) = page.into_parts();
                (TaskRawResult::SessionEvents { page, end }, lease)
            })
        } else {
            streams.read_prepared(&actor, params).await.map(|page| {
                let (page, lease) = page.into_parts();
                (TaskRawResult::StreamRead(page), lease)
            })
        };
        let (result, lease) = match read {
            Ok((page, lease)) => (Ok(page), Some(lease)),
            // 最早保留游标也是内容权限下的源信息，错误帧同样在写入前复核。
            Err(error) if error.code == "CURSOR_EXPIRED" => (Err(error), None),
            Err(error) => return Err(error),
        };
        let auth = self.inner.auth.clone();
        // 绑定权限戳也保留任务授权检查，writer 只需按同一戳复核一次。
        let page = TaskRawPage::protected(
            result,
            Arc::new(move || auth.validate_grants(&stamp)),
            lease,
        );
        #[cfg(test)]
        let page = {
            let gate = self.inner.node_test_gates.task_raw_read_ready.clone();
            blocking(move || {
                gate.arrive();
                Ok(page)
            })
            .await?
        };
        Ok(page)
    }
    pub fn invoke_child(
        &self,
        actor: &AuthenticatedActor,
        child: ChildCall,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<Operation>> + Send>> {
        let attempt = self.invoke_child_attempt(actor, child);
        Box::pin(async move { attempt.await.result })
    }
    fn invoke_child_attempt(
        &self,
        actor: &AuthenticatedActor,
        child: ChildCall,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = TaskOperationReply> + Send>> {
        use std::sync::atomic::{AtomicBool, Ordering};
        let queued = Arc::new(AtomicBool::new(false));
        let host = self.clone();
        let actor = actor.clone();
        Box::pin(async move {
            let result = async {
                let check_host = host.clone();
                let original = actor.clone();
                let input = child.clone();
                let admission_queued = queued.clone();
                let (delegated, call) = blocking(move || {
                    let identity = check_host.inner.store.identity()?;
                    if input.instance_epoch != identity.instance_epoch {
                        return Err(HostError::new(
                            "EPOCH_MISMATCH",
                            "Host instance has changed",
                        ));
                    }
                    if input.host_id != identity.host_id || input.target.host_id != identity.host_id
                    {
                        return Err(HostError::new(
                            "HOST_ID_MISMATCH",
                            "Child belongs to another Host",
                        ));
                    }
                    let scope = check_host
                        .inner
                        .tasks
                        .lock()
                        .map_err(|_| busy())?
                        .get(&input.parent_operation_id)
                        .cloned()
                        .ok_or_else(|| {
                            HostError::new("OPERATION_NOT_RUNNING", "Parent owner is not executing")
                        })?;
                    if original.id() != scope.actor.id()
                        || original.client_id() != scope.actor.client_id()
                        || input.actor_id != *scope.actor.id()
                    {
                        return Err(HostError::new(
                            "ACTOR_MISMATCH",
                            "Child does not match the original caller",
                        ));
                    }
                    let delegated =
                        scope.delegate(&check_host, Some(input.clone()), admission_queued)?;
                    let call = Call {
                        protocol_version: input.protocol_version,
                        host_id: input.host_id,
                        instance_epoch: input.instance_epoch,
                        actor_id: input.actor_id,
                        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
                        // 内部复用Call形状；子动作由taskContext接纳，不具备根请求凭据。
                        request_context: ContextToken::try_from("child")?,
                        action_id: input.action_id,
                        target: input.target,
                        params: input.params,
                        reveal_target: input.reveal_target,
                        expected_revision: input.expected_revision,
                        lease_id: input.lease_id,
                        execution_mode: Some(scope.operation.execution_mode),
                    };
                    Ok((delegated, call))
                })
                .await?;
                host.invoke(&delegated, call).await
            }
            .await
            .map_err(|mut error| {
                // 新子请求关闭接纳；已接纳Operation的取消及实际回执不经过此错误映射。
                if error.code == "CANCELLED" {
                    error.code = "OPERATION_NOT_RUNNING".into();
                    error.message = "Parent is not accepting child operations".into();
                    error.retryable = false;
                }
                error
            });
            let before_admission = result.is_err() && !queued.load(Ordering::Acquire);
            #[cfg(test)]
            let result = if result.is_ok()
                && host
                    .inner
                    .node_test_gates
                    .fail_child_receipt_once
                    .swap(false, Ordering::AcqRel)
            {
                // 已发生的接纳和工作保持原样；只在Host回执交付边界模拟一次失败。
                Err(busy())
            } else {
                result
            };
            TaskOperationReply {
                result,
                before_admission,
            }
        })
    }
    fn get_task_operation(
        &self,
        scope: Arc<TaskScope>,
        selector: OperationGetParams,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = TaskOperationReply> + Send>> {
        let host = self.clone();
        Box::pin(async move {
            let result = async {
                let permit = host
                    .inner
                    .node_query_capacity
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| busy())?;
                let (sent, receive) = oneshot::channel();
                {
                    let mut jobs = host.inner.jobs.lock().map_err(|_| busy())?;
                    if jobs.closing {
                        return Err(HostError::new("HOST_CLOSING", "Host is closing"));
                    }
                    jobs.handles.retain(|job| !job.handle.is_finished());
                    let read_host = host.clone();
                    let operation_id =
                        Arc::new(Mutex::new(Some(scope.operation.operation_id.clone())));
                    let handle = tokio::spawn(async move {
                        // 调用方停止等待不会释放实际读取责任或名额；关停按所属父Op报告该job。
                        let _permit = permit;
                        let result = async {
                            let prepare = read_host.clone();
                            let caller = scope.clone();
                            let (actor, query) = blocking(move || {
                                let actor = caller.delegate(&prepare, None, Arc::default())?;
                                let host_id = caller.operation.execution_host_id.clone();
                                let query = Query {
                                    protocol_version: ProtocolVersion::V1_0,
                                    host_id: host_id.clone(),
                                    instance_epoch: caller.instance_epoch,
                                    actor_id: actor.id().clone(),
                                    request_id: RequestId::try_from(
                                        uuid::Uuid::new_v4().to_string().as_str(),
                                    )?,
                                    action_id: id("operation.get"),
                                    target: Target {
                                        host_id: host_id.clone(),
                                        kind: ResourceKind::try_from("host")?,
                                        id: host_id,
                                        session_id: None,
                                        session_epoch: None,
                                    },
                                    params: object(
                                        serde_json::to_value(selector).map_err(|_| invalid())?,
                                    )?,
                                    reveal_target: caller.operation.reveal_target.clone(),
                                };
                                Ok((actor, query))
                            })
                            .await?;
                            let QueryResult::Operation(value) =
                                read_host.query(&actor, query).await?
                            else {
                                return Err(invalid());
                            };
                            let verify = read_host.clone();
                            blocking(move || {
                                #[cfg(test)]
                                verify
                                    .inner
                                    .node_test_gates
                                    .task_operation_read_ready
                                    .arrive();
                                scope.check_reader(&verify)
                            })
                            .await?;
                            Ok(value.operation)
                        }
                        .await;
                        let _ = sent.send(result);
                    });
                    jobs.handles.push(OwnedJob {
                        handle,
                        operation_id,
                    });
                }
                receive.await.map_err(|_| busy())?
            }
            .await;
            TaskOperationReply {
                result,
                before_admission: false,
            }
        })
    }
    pub(super) async fn wait_task_children(&self, parent: &Id) -> bool {
        let mut changes = self.inner.store.subscribe_operation_changes();
        loop {
            changes.borrow_and_update();
            let store = self.inner.store.clone();
            let id = parent.clone();
            match blocking(move || store.child_summary(&id)).await {
                Ok((false, unknown)) => return unknown,
                Ok((true, _)) => {}
                // 观察失败不能证明子项结束；保持父任务责任并有界退避。
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
            }
            if changes.changed().await.is_err() {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    }
}
