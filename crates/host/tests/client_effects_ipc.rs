use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Fixture {
    _profile: tempfile::TempDir,
    ordinary: HostClient,
    operator: HostClient,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(profile.path()).await.unwrap();
        let host = Host::new(server.store(), server.auth()).await.unwrap();
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        let ordinary = HostClient::connect(ConnectOptions::new(
            profile.path().to_path_buf(),
            id("receiver"),
            ClientKind::Desktop,
        ))
        .await
        .unwrap();
        let mut options = ConnectOptions::new(
            profile.path().to_path_buf(),
            id("receiver"),
            ClientKind::Desktop,
        );
        options.user_control_credential =
            Some(serial_workbench_client::read_user_control_credential(profile.path()).unwrap());
        let operator = HostClient::connect(options).await.unwrap();
        Self {
            _profile: profile,
            ordinary,
            operator,
            stop,
            running,
        }
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
    }
}
fn registration() -> RpcRequest {
    RpcRequest::ClientRegister(ClientRegisterParams {
        generation: 1.into(),
        capabilities: vec![ClientCapability::WindowRead],
    })
}
fn failure(reply: RpcReply) -> HostError {
    let RpcReply::Failure { error, .. } = reply else {
        panic!("expected failure: {reply:?}")
    };
    error
}
fn registered(reply: RpcReply) -> ClientRegistration {
    let RpcReply::Success { result, .. } = reply else {
        panic!("expected registration: {reply:?}")
    };
    let RpcResult::ClientRegistration(result) = *result else {
        panic!("wrong registration result: {result:?}")
    };
    result
}

#[tokio::test]
async fn receiver_rpc_requires_real_operator_and_control_connection() {
    let f = Fixture::new().await;
    assert_ne!(
        f.ordinary.attachment().actor_id,
        f.operator.attachment().actor_id
    );
    assert_eq!(
        failure(f.ordinary.request(registration()).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    let raw = f.operator.connect_raw().await.unwrap();
    assert_eq!(
        failure(raw.request(registration()).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.finish().await;
}

#[tokio::test]
async fn receiver_registration_is_typed_idempotent_and_discoverable_over_real_ipc() {
    let f = Fixture::new().await;
    let first = registered(f.operator.request(registration()).await.unwrap());
    let second = registered(f.operator.request(registration()).await.unwrap());
    assert_eq!(first, second);
    assert_eq!(first.target.kind.as_str(), "client");
    assert_ne!(first.target.id, f.operator.attachment().client_id);
    let a = f.ordinary.attachment();
    let query = Query {
        protocol_version: a.protocol_version,
        host_id: a.host_id.clone(),
        instance_epoch: a.instance_epoch,
        actor_id: a.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id("client.list"),
        target: Target {
            host_id: a.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: a.host_id.clone(),
            session_id: None,
            session_epoch: None,
        },
        params: serde_json::from_value(serde_json::json!({})).unwrap(),
        reveal_target: RevealTarget {
            page_id: id("settings"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    };
    let reply = f.ordinary.request(RpcRequest::Query(query)).await.unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("expected discovery: {reply:?}")
    };
    let RpcResult::Query(QueryResult::Clients(list)) = *result else {
        panic!("wrong discovery result: {result:?}")
    };
    assert_eq!(list.clients.len(), 1);
    assert_eq!(list.clients[0].registration, first);
    assert!(list.clients[0].settings_application.is_none());
    f.finish().await;
}

async fn pending_window_query(
    f: &Fixture,
    target: &Target,
) -> (
    ClientEffectRequest,
    tokio::task::JoinHandle<HostResult<RpcReply>>,
) {
    let caller = f.ordinary.reconnect().await.unwrap();
    let a = caller.attachment();
    let query = Query {
        protocol_version: a.protocol_version,
        host_id: a.host_id.clone(),
        instance_epoch: a.instance_epoch,
        actor_id: a.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id("client.window.read"),
        target: target.clone(),
        params: serde_json::from_value(serde_json::json!({})).unwrap(),
        reveal_target: RevealTarget {
            page_id: id("settings"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    };
    let mut waiting = tokio::spawn(async move { caller.request(RpcRequest::Query(query)).await });
    let request = tokio::time::timeout(Duration::from_secs(2), async {
        tokio::select! {
            reply = &mut waiting => panic!("query completed before an executor receipt: {reply:?}"),
            event = f.operator.next_event() => {
                let event = event.unwrap().expect("operator connection remains open");
                assert_eq!(event.channel, IpcChannel::Control);
                if let IpcMessage::ClientEffect { request } = event.body { return *request; }
                panic!("effect must use the dedicated control event: {event:?}");
            }
        }
    })
    .await
    .expect("Host must emit a client effect instead of waiting for a nonexistent receipt");
    (request, waiting)
}
fn window_result() -> ClientEffectResult {
    ClientEffectResult::Window(ClientWindowSnapshot {
        geometry: ClientWindowGeometry {
            width: 1000.into(),
            height: 700.into(),
            min_width: 640.into(),
            min_height: 480.into(),
            max_width: 3000.into(),
            max_height: 2000.into(),
            default_width: 1000.into(),
            default_height: 700.into(),
        },
        maximized: false,
        fullscreen: false,
    })
}
fn receipt(request: &ClientEffectRequest) -> ClientEffectReceipt {
    ClientEffectReceipt {
        host_id: request.host_id.clone(),
        instance_epoch: request.instance_epoch,
        client_target_id: request.client_target_id.clone(),
        generation: request.generation,
        delivery_id: request.delivery_id.clone(),
        outcome: ClientEffectOutcome::Succeeded {
            result: window_result(),
        },
    }
}
fn acknowledged(reply: RpcReply) {
    let RpcReply::Success { result, .. } = reply else {
        panic!("receipt was rejected: {reply:?}")
    };
    assert!(matches!(
        *result,
        RpcResult::ClientEffectAcknowledged(ClientEffectAcknowledged { accepted: True })
    ));
}

#[tokio::test]
async fn ordinary_window_query_waits_for_dedicated_operator_effect_and_typed_receipt() {
    let f = Fixture::new().await;
    let registered = registered(f.operator.request(registration()).await.unwrap());
    let (request, waiting) = pending_window_query(&f, &registered.target).await;
    assert_eq!(request.client_target_id, registered.target.id);
    assert_eq!(request.generation, registered.generation);
    assert!(request.operation_id.is_none());
    assert_eq!(request.action, ClientEffectAction::WindowRead {});
    acknowledged(
        f.operator
            .request(RpcRequest::ClientReceipt(ClientReceiptSubmission::Effect(
                Box::new(receipt(&request)),
            )))
            .await
            .unwrap(),
    );
    let reply = tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("query failed after receipt: {reply:?}")
    };
    assert!(
        matches!(*result, RpcResult::Query(QueryResult::ClientEffect(result)) if result == window_result())
    );
    f.finish().await;
}

#[tokio::test]
async fn another_operator_connection_and_stale_generation_cannot_settle_pending_query() {
    let f = Fixture::new().await;
    let registered = registered(f.operator.request(registration()).await.unwrap());
    let (request, mut waiting) = pending_window_query(&f, &registered.target).await;
    let other = f.operator.reconnect().await.unwrap();
    assert_eq!(
        failure(
            other
                .request(RpcRequest::ClientReceipt(ClientReceiptSubmission::Effect(
                    Box::new(receipt(&request))
                )))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    let mut stale = receipt(&request);
    stale.generation = 0.into();
    assert_eq!(
        failure(
            f.operator
                .request(RpcRequest::ClientReceipt(ClientReceiptSubmission::Effect(
                    Box::new(stale)
                )))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut waiting)
            .await
            .is_err(),
        "invalid receipts must not settle the caller"
    );
    acknowledged(
        f.operator
            .request(RpcRequest::ClientReceipt(ClientReceiptSubmission::Effect(
                Box::new(receipt(&request)),
            )))
            .await
            .unwrap(),
    );
    assert!(matches!(
        waiting.await.unwrap().unwrap(),
        RpcReply::Success { .. }
    ));
    f.finish().await;
}
