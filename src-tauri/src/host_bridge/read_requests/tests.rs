use super::*;
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler},
};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct ChangeBeforeDelivery {
    host: Host,
    auth: AuthService,
    operator: AuthenticatedActor,
    changes: [AtomicUsize; 3],
    reads: Mutex<Vec<Query>>,
    actions: Mutex<Vec<String>>,
    paused: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    entered: Arc<tokio::sync::Notify>,
    failure: Mutex<Option<HostError>>,
}
impl RequestHandler for ChangeBeforeDelivery {
    fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
        let query = match &request {
            RpcRequest::Query(query) | RpcRequest::OperationGet(query) => Some(query.clone()),
            _ => None,
        };
        if let Some(query) = query {
            self.actions
                .lock()
                .unwrap()
                .push(query.action_id.to_string());
            let index = match query.action_id.as_str() {
                "settings.read" => Some(0),
                "operation.get" => Some(1),
                "session.get" => Some(2),
                _ => None,
            };
            if let Some(index) = index.filter(|_| !context.actor.is_user_control()) {
                self.reads.lock().unwrap().push(query.clone());
                let change = self.changes[index]
                    .try_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                        value.checked_sub(1)
                    })
                    .is_ok();
                let host = self.host.clone();
                let auth = self.auth.clone();
                let operator = self.operator.clone();
                let paused = self.paused.lock().unwrap().take();
                let entered = self.entered.clone();
                let failure = self.failure.lock().unwrap().take();
                return Box::pin(async move {
                    if let Some(error) = failure {
                        return Err(error);
                    }
                    // The real server already captured the actor's grant stamp.
                    // Change it after the real read: output_writer rejects that reply.
                    let mut reply = host.handle(context.clone(), request.clone()).await?;
                    if change && index == 1 {
                        // 本例验证已接纳 Open 的只读回复失效；先等真实 Open 终态，
                        // 否则授权变化会正确取消仍在打开的设备，测成另一个生命周期。
                        tokio::time::timeout(std::time::Duration::from_secs(5), async {
                            while matches!(&reply.wire_reply, RpcReply::Success { result, .. }
                                if matches!(result.as_ref(), RpcResult::Operation(value)
                                    if matches!(value.operation.state, OperationState::Queued | OperationState::Running | OperationState::CancelRequested))) {
                                tokio::task::yield_now().await;
                                reply = host.handle(context.clone(), request.clone()).await?;
                            }
                            Ok::<(), HostError>(())
                        }).await.map_err(|_| HostError::new("TIMEOUT", "Fixture Open did not reach its real terminal state"))??;
                    }
                    if let Some(paused) = paused {
                        entered.notify_one();
                        let _ = paused.await;
                    }
                    if change {
                        auth.authorize(
                            &operator,
                            AuthorizeParams {
                                client_id: context.actor.client_id().clone(),
                                permissions: vec!["metadata.read".into()],
                                targets: vec![query.target],
                                expires_at: None,
                            },
                        )?;
                    }
                    Ok(reply)
                });
            }
        } else if let RpcRequest::Invoke(call) = &request {
            self.actions
                .lock()
                .unwrap()
                .push(call.action_id.to_string());
        }
        self.host.handle(context, request)
    }
    fn disconnected(&self, context: &ConnectionContext) {
        self.host.disconnected(context);
    }
    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<()>> + Send>> {
        RequestHandler::shutdown(&self.host)
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    bridge: DesktopHostBridge,
    attached: super::super::DesktopAttachment,
    handler: Arc<ChangeBeforeDelivery>,
    stop: tokio::sync::oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl Fixture {
    async fn new(changes: [usize; 3]) -> Self {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(directory.path()).await.unwrap();
        let auth = server.auth();
        let operator = auth
            .authenticate_user_control(
                &Id::try_from("read-test-operator").unwrap(),
                &serial_workbench_client::read_user_control_credential(directory.path()).unwrap(),
            )
            .unwrap();
        let host = Host::new(server.store(), auth.clone()).await.unwrap();
        let handler = Arc::new(ChangeBeforeDelivery {
            host,
            auth,
            operator,
            changes: changes.map(AtomicUsize::new),
            reads: Mutex::new(Vec::new()),
            actions: Mutex::new(Vec::new()),
            paused: Mutex::new(None),
            entered: Arc::new(tokio::sync::Notify::new()),
            failure: Mutex::new(None),
        });
        let (stop, done) = tokio::sync::oneshot::channel();
        let served = handler.clone();
        let running = tokio::spawn(async move {
            server
                .serve_until(served, async {
                    let _ = done.await;
                })
                .await
        });
        let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
        let attached = bridge.attach("main").await.unwrap();
        handler.actions.lock().unwrap().clear();
        Self {
            _directory: directory,
            bridge,
            attached,
            handler,
            stop,
            running,
        }
    }
    fn settings_query(&self) -> Query {
        let attachment = &self.attached.attachment;
        Query {
            protocol_version: attachment.protocol_version,
            host_id: attachment.host_id.clone(),
            instance_epoch: attachment.instance_epoch,
            actor_id: attachment.actor_id.clone(),
            request_id: crate::platform_settings::next_effects_request_id().unwrap(),
            action_id: Id::try_from("settings.read").unwrap(),
            target: Target {
                host_id: attachment.host_id.clone(),
                kind: ResourceKind::try_from("settings").unwrap(),
                id: Id::try_from("shared").unwrap(),
                session_id: None,
                session_epoch: None,
            },
            params: Default::default(),
            reveal_target: RevealTarget {
                page_id: Id::try_from("settings").unwrap(),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
        }
    }
    async fn stop(self) {
        drop(self.bridge);
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
    }
}
struct Outcome {
    result: HostResult<RpcReply>,
    reads: Vec<Query>,
    actions: Vec<String>,
    before: U64,
    after: U64,
}
async fn exercise(changes: usize, revoke: bool) -> Outcome {
    let fixture = Fixture::new([changes, 0, 0]).await;
    let query = fixture.settings_query();
    if revoke {
        fixture
            .handler
            .auth
            .revoke(
                &fixture.handler.operator,
                RevokeParams {
                    actor_id: fixture.attached.attachment.actor_id.clone(),
                    permissions: vec!["metadata.read".into()],
                    targets: vec![query.target.clone()],
                },
            )
            .unwrap();
    }
    let before = fixture.handler.auth.current_revision().unwrap();
    let result = fixture
        .bridge
        .read_request_at_generation(
            "main",
            fixture.attached.generation,
            RpcRequest::Query(query),
        )
        .await;
    let after = fixture.handler.auth.current_revision().unwrap();
    let reads = fixture.handler.reads.lock().unwrap().clone();
    let actions = fixture.handler.actions.lock().unwrap().clone();
    fixture.stop().await;
    Outcome {
        result,
        reads,
        actions,
        before,
        after,
    }
}

#[tokio::test]
async fn native_read_recovers_a_real_reply_invalidated_by_one_legal_grant_change() {
    let Outcome {
        result,
        reads,
        actions,
        before,
        after,
    } = exercise(1, false).await;
    assert!(
        matches!(result.unwrap(), RpcReply::Success { result, .. } if matches!(*result, RpcResult::Query(QueryResult::Settings(_))))
    );
    assert_eq!(reads.len(), 2);
    assert_ne!(reads[0].request_id, reads[1].request_id);
    assert_eq!(reads[0].actor_id, reads[1].actor_id);
    assert_eq!(reads[0].instance_epoch, reads[1].instance_epoch);
    assert_eq!(reads[0].target, reads[1].target);
    assert_eq!(actions, ["settings.read", "settings.read"]);
    assert_eq!(after, before.checked_next().unwrap());
}

#[tokio::test]
async fn native_read_stops_after_three_real_reply_invalidations() {
    let Outcome {
        result,
        reads,
        actions,
        ..
    } = exercise(4, false).await;
    assert!(
        matches!(result.unwrap(), RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    assert_eq!(reads.len(), 3);
    assert_eq!(
        reads
            .iter()
            .map(|q| &q.request_id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        3
    );
    assert_eq!(actions, ["settings.read", "settings.read", "settings.read"]);
}

#[tokio::test]
async fn native_read_does_not_reauthorize_a_permanently_revoked_reader() {
    let Outcome {
        result,
        reads,
        actions,
        before,
        after,
    } = exercise(0, true).await;
    assert!(
        matches!(result.unwrap(), RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    assert_eq!(reads.len(), 3);
    assert_eq!(actions, ["settings.read", "settings.read", "settings.read"]);
    assert_eq!(before, after);
}

#[tokio::test]
async fn native_read_retires_an_inflight_result_without_retry_or_reattachment() {
    let fixture = Fixture::new([1, 0, 0]).await;
    let (release, held) = tokio::sync::oneshot::channel();
    *fixture.handler.paused.lock().unwrap() = Some(held);
    let query = fixture.settings_query();
    let bridge = fixture.bridge.clone();
    let generation = fixture.attached.generation;
    let pending = tokio::spawn(async move {
        bridge
            .read_request_at_generation("main", generation, RpcRequest::Query(query))
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        fixture.handler.entered.notified(),
    )
    .await
    .unwrap();
    fixture.bridge.destroy_window("main", generation).await;
    release.send(()).unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap();
    let reads = fixture.handler.reads.lock().unwrap().len();
    let reattached = fixture
        .bridge
        .inner
        .lock()
        .await
        .windows
        .contains_key("main");
    fixture.stop().await;
    assert!(matches!(result, Err(error) if error.code == "EPOCH_MISMATCH"));
    assert_eq!(reads, 1);
    assert!(!reattached);
}

#[tokio::test]
async fn native_read_does_not_retry_other_errors_or_side_effect_requests() {
    let fixture = Fixture::new([0, 0, 0]).await;
    *fixture.handler.failure.lock().unwrap() = Some(HostError::new(
        "STORAGE_UNAVAILABLE",
        "controlled read failure",
    ));
    let result = fixture
        .bridge
        .read_request_at_generation(
            "main",
            fixture.attached.generation,
            RpcRequest::Query(fixture.settings_query()),
        )
        .await;
    assert!(
        matches!(result.unwrap(), RpcReply::Failure { error, .. } if error.code == "STORAGE_UNAVAILABLE")
    );
    for action in [
        "settings.save",
        "auth.authorize",
        "file.register",
        "state.subscribe",
        "stream.subscribe",
    ] {
        let mut query = fixture.settings_query();
        query.action_id = Id::try_from(action).unwrap();
        assert_eq!(
            fixture
                .bridge
                .read_request_at_generation(
                    "main",
                    fixture.attached.generation,
                    RpcRequest::Query(query),
                )
                .await
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }
    assert_eq!(
        fixture
            .bridge
            .read_request_at_generation(
                "main",
                fixture.attached.generation,
                RpcRequest::OperationGet(fixture.settings_query()),
            )
            .await
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let actions = fixture.handler.actions.lock().unwrap().clone();
    fixture.stop().await;
    assert_eq!(actions, ["settings.read"]);
}

#[tokio::test]
async fn native_device_connection_recovers_only_the_original_operation_and_session_reads() {
    let fixture = Fixture::new([0, 1, 1]).await;
    let result = fixture
        .bridge
        .connect_device_intent(
            "main",
            fixture.attached.generation,
            Id::try_from("virtual:echo").unwrap(),
            OpenParams {
                configuration: SerialConfiguration::default(),
                binding: None,
            },
        )
        .await;
    let reads = fixture.handler.reads.lock().unwrap().clone();
    let actions = fixture.handler.actions.lock().unwrap().clone();
    fixture.stop().await;
    let session = result.unwrap();
    assert_eq!(session.device_id, Id::try_from("virtual:echo").unwrap());
    assert_eq!(
        actions
            .iter()
            .filter(|action| action.as_str() == "device.open")
            .count(),
        1
    );
    assert_eq!(
        actions
            .iter()
            .filter(|action| action.as_str() == "auth.authorize")
            .count(),
        2
    );
    let operations = reads
        .iter()
        .filter(|query| query.action_id.as_str() == "operation.get")
        .collect::<Vec<_>>();
    assert!(operations.len() >= 2);
    assert!(
        operations
            .iter()
            .all(|query| query.params == operations[0].params)
    );
    assert_eq!(
        operations
            .iter()
            .map(|query| &query.request_id)
            .collect::<std::collections::HashSet<_>>()
            .len(),
        operations.len()
    );
    let sessions = reads
        .iter()
        .filter(|query| query.action_id.as_str() == "session.get")
        .collect::<Vec<_>>();
    assert_eq!(sessions.len(), 2);
    assert_ne!(sessions[0].request_id, sessions[1].request_id);
    assert_eq!(sessions[0].target, sessions[1].target);
    assert_eq!(sessions[0].target.id, session.session_id);
}
