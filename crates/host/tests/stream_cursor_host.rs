use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient, RawConnection};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    ipc::HostServer,
    storage::Store,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;
fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Fixture {
    _dir: tempfile::TempDir,
    client: HostClient,
    auth: AuthService,
    operator: AuthenticatedActor,
    store: Store,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        let store = server.store();
        let auth = server.auth();
        let secret =
            serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
                .unwrap()
                .unwrap();
        let operator = auth
            .authenticate_user_control(
                &id("cursor-operator"),
                &ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap(),
            )
            .unwrap();
        let host = Host::new(store.clone(), auth.clone()).await.unwrap();
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        let client = HostClient::connect(ConnectOptions::new(
            dir.path().to_path_buf(),
            id("cursor-reader"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        Self {
            _dir: dir,
            client,
            auth,
            operator,
            store,
            stop,
            running,
        }
    }
    fn host_target(&self) -> Target {
        Target {
            host_id: self.client.attachment().host_id.clone(),
            id: self.client.attachment().host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        }
    }
    fn grant(&self, permission: &str) {
        self.auth
            .authorize(
                &self.operator,
                AuthorizeParams {
                    client_id: self.client.attachment().client_id.clone(),
                    permissions: vec![permission.into()],
                    targets: vec![self.host_target()],
                    expires_at: None,
                },
            )
            .unwrap();
    }
    fn query(&self, target: &Target, action: &str, params: serde_json::Value) -> Query {
        let a = self.client.attachment();
        Query {
            protocol_version: ProtocolVersion::V0_1,
            host_id: a.host_id.clone(),
            instance_epoch: a.instance_epoch,
            actor_id: a.actor_id.clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            action_id: id(action),
            target: target.clone(),
            params: serde_json::from_value(params).unwrap(),
            reveal_target: RevealTarget {
                page_id: id("workbench"),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
        }
    }
    async fn invoke(&self, target: &Target, action: &str, params: serde_json::Value) -> Operation {
        let q = self.query(target, action, params);
        let call = Call {
            protocol_version: q.protocol_version,
            host_id: q.host_id,
            instance_epoch: q.instance_epoch,
            actor_id: q.actor_id,
            request_id: q.request_id,
            request_context: self.client.attachment().request_context.clone(),
            action_id: q.action_id,
            target: q.target,
            params: q.params,
            reveal_target: q.reveal_target,
            expected_revision: None,
            lease_id: None,
            execution_mode: None,
        };
        let RpcResult::Operation(accepted) =
            success(self.client.request(RpcRequest::Invoke(call)).await.unwrap())
        else {
            panic!("operation expected")
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = self
                    .store
                    .get(&self.operator, &accepted.operation.operation_id)
                    .unwrap();
                if !matches!(
                    current.state,
                    OperationState::Queued
                        | OperationState::Running
                        | OperationState::CancelRequested
                ) {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn open(&self) -> Target {
        self.grant("device.modify");
        let device = Target {
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("virtual:echo"),
            ..self.host_target()
        };
        let operation = self
            .invoke(
                &device,
                "device.open",
                json!({"configuration":SerialConfiguration::default()}),
            )
            .await;
        assert_eq!(
            operation.state,
            OperationState::Succeeded,
            "{:?}",
            operation.error
        );
        let Some(ActionResult::Opened(opened)) = operation.result else {
            panic!("open result expected")
        };
        Target {
            kind: ResourceKind::try_from("session").unwrap(),
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
            ..self.host_target()
        }
    }
    async fn cursor(&self, raw: &RawConnection, target: &Target) -> StreamCursorResult {
        let result = success(
            raw.request(RpcRequest::Query(self.query(
                target,
                "stream.cursor",
                json!({}),
            )))
            .await
            .unwrap(),
        );
        let RpcResult::Query(QueryResult::StreamCursor(result)) = result else {
            panic!("typed cursor expected: {result:?}")
        };
        result
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
    }
}
fn success(reply: RpcReply) -> RpcResult {
    let RpcReply::Success { result, .. } = reply else {
        panic!("unexpected failure: {reply:?}")
    };
    *result
}
fn failure(reply: RpcReply) -> HostError {
    let RpcReply::Failure { error, .. } = reply else {
        panic!("unexpected success: {reply:?}")
    };
    error
}

// 客户端直接用Host真实cursor接续TX事件，不猜raw scope或起始序号。
#[tokio::test]
async fn returned_cursor_subscribes_to_real_raw_stream_without_invented_scope() {
    let f = Fixture::new().await;
    let target = f.open().await;
    f.grant("content.read");
    let raw = f.client.connect_raw().await.unwrap();
    let reference = f.cursor(&raw, &target).await;
    assert_eq!(reference.target, target);
    assert_eq!(reference.cursor.host_id, target.host_id);
    assert_eq!(
        reference.cursor.instance_epoch,
        f.client.attachment().instance_epoch
    );
    let result = success(
        f.client
            .request(RpcRequest::Query(f.query(
                &f.host_target(),
                "state.scopes",
                json!({}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Query(QueryResult::Scopes(scopes)) = result else {
        panic!("state scopes expected")
    };
    assert!(
        scopes
            .scopes
            .iter()
            .all(|scope| scope.scope_id != reference.cursor.scope_id)
    );
    let result = success(raw.request(RpcRequest::Query(f.query(&target, "stream.subscribe", json!({"scopeId":reference.cursor.scope_id,"after":reference.cursor,"queueBytes":"65536","initialCreditBytes":"65536","overflowPolicy":"drop_with_gap"})))).await.unwrap());
    let RpcResult::Query(QueryResult::StreamSubscribe(subscription)) = result else {
        panic!("raw subscription expected")
    };
    assert_eq!(
        f.invoke(
            &target,
            "session.tx",
            json!({"bytesBase64":"AQI=","writeWaitMs":"1000"})
        )
        .await
        .state,
        OperationState::Succeeded
    );
    let frame = tokio::time::timeout(Duration::from_secs(3), raw.next_event())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let IpcMessage::RawBatch { batch } = frame.body else {
        panic!("raw batch expected")
    };
    assert_eq!(batch.subscription_id, subscription.subscription_id);
    assert_eq!(batch.previous_cursor, reference.cursor);
    assert!(batch.items.iter().any(|item| matches!(item, StreamItem::Source { event } if matches!(event.payload, RawPayload::TxIntent(_)))));
    f.finish().await;
}

// 同一action不能绕过raw物理连接或沿用已撤销的源内容权限。
#[tokio::test]
async fn cursor_requires_raw_channel_and_current_content_permission() {
    let f = Fixture::new().await;
    let target = f.open().await;
    let raw = f.client.connect_raw().await.unwrap();
    let request = || RpcRequest::Query(f.query(&target, "stream.cursor", json!({})));
    assert_eq!(
        failure(raw.request(request()).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.grant("content.read");
    assert_eq!(
        failure(f.client.request(request()).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    assert_eq!(f.cursor(&raw, &target).await.target, target);
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.client.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        failure(raw.request(request()).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.finish().await;
}

// 公开cursor只能指向仍打开的精确会话代次，目录必须暴露同一typed契约。
#[tokio::test]
async fn cursor_rejects_old_epoch_and_closed_source_and_has_typed_catalog() {
    let f = Fixture::new().await;
    let target = f.open().await;
    f.grant("content.read");
    let raw = f.client.connect_raw().await.unwrap();
    f.cursor(&raw, &target).await;
    let result = success(
        f.client
            .request(RpcRequest::Query(f.query(
                &f.host_target(),
                "catalog.list",
                json!({"pageSize":"100"}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Query(QueryResult::Catalog(catalog)) = result else {
        panic!("catalog expected")
    };
    let action = catalog
        .items
        .iter()
        .find(|item| item.action_id.as_str() == "stream.cursor")
        .unwrap();
    assert_eq!(action.kind, ActionKind::Query);
    assert_eq!(action.permissions, vec!["content.read"]);
    assert_eq!(
        action.target_kinds,
        vec![ResourceKind::try_from("session").unwrap()]
    );
    assert_eq!(
        serde_json::to_value(&action.output_schema).unwrap(),
        schema::<StreamCursorResult>()
    );
    let mut old = target.clone();
    old.session_epoch = Some(target.session_epoch.unwrap().checked_next().unwrap());
    assert_eq!(
        failure(
            raw.request(RpcRequest::Query(f.query(&old, "stream.cursor", json!({}))))
                .await
                .unwrap()
        )
        .code,
        "EPOCH_MISMATCH"
    );
    assert_eq!(
        f.invoke(&target, "session.close", json!({})).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        failure(
            raw.request(RpcRequest::Query(f.query(
                &target,
                "stream.cursor",
                json!({})
            )))
            .await
            .unwrap()
        )
        .code,
        "BACKEND_DISCONNECTED"
    );
    f.finish().await;
}
