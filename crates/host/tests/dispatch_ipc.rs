use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, oneshot};
fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
fn query(client: &HostClient, action: &str, params: serde_json::Value) -> Query {
    let attach = client.attachment();
    Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: attach.host_id.clone(),
        instance_epoch: attach.instance_epoch,
        actor_id: attach.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id(action),
        target: Target {
            host_id: attach.host_id.clone(),
            id: attach.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        },
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
async fn connect(path: &std::path::Path, client: &str) -> HostClient {
    HostClient::connect(ConnectOptions::new(
        path.to_path_buf(),
        id(client),
        ClientKind::Cli,
    ))
    .await
    .unwrap()
}
fn success(reply: RpcReply) -> RpcResult {
    let RpcReply::Success { result, .. } = reply else {
        panic!("{reply:?}")
    };
    *result
}

#[tokio::test]
async fn live_attach_catalog_generic_query_and_subscription_are_real() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(dir.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let store = server.store();
    let (stop, done) = oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let client = connect(dir.path(), "reader").await;
    let second = connect(dir.path(), "reader").await;
    assert_eq!(
        client.attachment().catalog_version,
        store.identity().unwrap().catalog_version
    );
    let result = success(
        client
            .request(RpcRequest::Query(query(
                &client,
                "catalog.list",
                serde_json::json!({"pageSize":"100"}),
            )))
            .await
            .unwrap(),
    );
    assert!(
        matches!(result,RpcResult::Query(QueryResult::Catalog(page)) if page.items.iter().any(|entry|entry.action_id.as_str()=="state.snapshot"))
    );
    let q = query(&client, "stream.read", serde_json::json!({}));
    assert!(
        matches!(client.request(RpcRequest::Query(q)).await.unwrap(),RpcReply::Failure {error,..} if error.code=="PERMISSION_DENIED")
    );
    let result = success(
        client
            .request(RpcRequest::StateSnapshot(query(
                &client,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Snapshot(snapshot) = result else {
        panic!()
    };
    let result = success(
        client
            .request(RpcRequest::StateSubscribe(query(
                &client,
                "state.subscribe",
                serde_json::json!({"scopeId":"host.devices","after":snapshot.cursor}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Subscription(subscription) = result else {
        panic!()
    };
    let forbidden = second
        .request(RpcRequest::SubscriptionClose(query(
            &second,
            "subscription.close",
            serde_json::json!({"subscriptionId":subscription.subscription_id}),
        )))
        .await
        .unwrap();
    assert!(matches!(forbidden,RpcReply::Failure {error,..} if error.code=="PERMISSION_DENIED"));
    let committed = host
        .projections()
        .commit(
            &id("host.devices"),
            id("devices.changed"),
            JsonObject::new(),
            JsonObject::new(),
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut previous = snapshot.cursor;
        loop {
            let event = client.next_event().await.unwrap().unwrap();
            let IpcMessage::Delta {
                subscription_id,
                delta,
            } = event.body
            else {
                panic!("expected a contiguous state delta, got {:?}", event.body);
            };
            assert_eq!(subscription_id, subscription.subscription_id);
            assert_eq!(delta.previous_cursor, previous);
            assert_eq!(
                delta.cursor.position,
                previous.position.checked_next().unwrap()
            );
            assert!(delta.cursor.position <= committed.cursor.position);
            if delta.cursor == committed.cursor {
                assert_eq!(delta.as_ref(), &committed);
                break;
            }
            previous = delta.cursor;
        }
    })
    .await
    .unwrap();
    drop(second);
    assert_eq!(host.projections().reader_count(), 1);
    success(
        client
            .request(RpcRequest::SubscriptionClose(query(
                &client,
                "subscription.close",
                serde_json::json!({"subscriptionId":subscription.subscription_id}),
            )))
            .await
            .unwrap(),
    );
    drop(client);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

struct DelayedSubscribe {
    host: Host,
    entered: Arc<Notify>,
    disconnected: Arc<Notify>,
    completed: Arc<Notify>,
    release: Mutex<Option<oneshot::Receiver<()>>>,
}
impl RequestHandler for DelayedSubscribe {
    fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
        if matches!(request, RpcRequest::StateSubscribe(_)) {
            let release = self.release.lock().unwrap().take().unwrap();
            let entered = self.entered.clone();
            let host = self.host.clone();
            let completed = self.completed.clone();
            Box::pin(async move {
                entered.notify_one();
                let _ = release.await;
                let result = host.handle(context, request).await;
                completed.notify_one();
                result
            })
        } else {
            self.host.handle(context, request)
        }
    }
    fn disconnected(&self, context: &ConnectionContext) {
        self.host.disconnected(context);
        self.disconnected.notify_one();
    }
}
#[tokio::test]
async fn disconnected_before_subscribe_finishes_never_leaks_reader() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(dir.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let entered = Arc::new(Notify::new());
    let disconnected = Arc::new(Notify::new());
    let (release, held) = oneshot::channel();
    let (stop, done) = oneshot::channel();
    let completed = Arc::new(Notify::new());
    let handler = Arc::new(DelayedSubscribe {
        host: host.clone(),
        entered: entered.clone(),
        disconnected: disconnected.clone(),
        completed: completed.clone(),
        release: Mutex::new(Some(held)),
    });
    let running = tokio::spawn(async move {
        server
            .serve_until(handler, async {
                let _ = done.await;
            })
            .await
    });
    let client = connect(dir.path(), "late-reader").await;
    let result = success(
        client
            .request(RpcRequest::StateSnapshot(query(
                &client,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Snapshot(snapshot) = result else {
        panic!()
    };
    let q = query(
        &client,
        "state.subscribe",
        serde_json::json!({"scopeId":"host.devices","after":snapshot.cursor}),
    );
    let request = tokio::spawn(async move { client.request(RpcRequest::StateSubscribe(q)).await });
    entered.notified().await;
    request.abort();
    let _ = request.await;
    tokio::time::timeout(Duration::from_secs(3), disconnected.notified())
        .await
        .unwrap();
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), completed.notified())
        .await
        .unwrap();
    assert_eq!(host.projections().reader_count(), 0);
    let another = connect(dir.path(), "other-reader").await;
    success(
        another
            .request(RpcRequest::StateSnapshot(query(
                &another,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
            )))
            .await
            .unwrap(),
    );
    drop(another);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(host.projections().reader_count(), 0);
}
