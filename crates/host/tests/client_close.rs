use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, oneshot};
fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct DelayedHost {
    host: Host,
    entered: Mutex<Option<oneshot::Sender<()>>>,
    release: Arc<Notify>,
    disconnected: Arc<AtomicBool>,
    channel: IpcChannel,
}
impl RequestHandler for DelayedHost {
    fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
        let entered = self.entered.lock().unwrap().take();
        let release = self.release.clone();
        let host = self.host.clone();
        Box::pin(async move {
            if let Some(entered) = entered {
                let _ = entered.send(());
                release.notified().await;
            }
            host.handle(context, request).await
        })
    }
    fn disconnected(&self, context: &ConnectionContext) {
        if context.channel == self.channel {
            self.disconnected.store(true, Ordering::SeqCst);
        }
        self.host.disconnected(context);
    }
    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<()>> + Send>> {
        let host = self.host.clone();
        Box::pin(async move { host.shutdown().await })
    }
}
fn query(client: &HostClient, raw: bool) -> RpcRequest {
    let a = client.attachment();
    let target = Target {
        host_id: a.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: a.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    RpcRequest::Query(Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: a.host_id.clone(),
        instance_epoch: a.instance_epoch,
        actor_id: a.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id(if raw {
            "subscription.close"
        } else {
            "catalog.list"
        }),
        target,
        params: serde_json::from_value(if raw {
            serde_json::json!({"subscriptionId":"missing"})
        } else {
            serde_json::json!({"pageSize":"100"})
        })
        .unwrap(),
        reveal_target: RevealTarget {
            page_id: id("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    })
}
async fn closes(raw: bool) {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(dir.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (entered, wait_entered) = oneshot::channel();
    let release = Arc::new(Notify::new());
    let disconnected = Arc::new(AtomicBool::new(false));
    let delayed = Arc::new(DelayedHost {
        host,
        entered: Mutex::new(Some(entered)),
        release: release.clone(),
        disconnected: disconnected.clone(),
        channel: if raw {
            IpcChannel::Raw
        } else {
            IpcChannel::Control
        },
    });
    let (stop, done) = oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(delayed, async {
                let _ = done.await;
            })
            .await
    });
    let client = Arc::new(
        HostClient::connect(ConnectOptions::new(
            dir.path().to_path_buf(),
            id("close-client"),
            ClientKind::Cli,
        ))
        .await
        .unwrap(),
    );
    let raw_client = if raw {
        Some(Arc::new(client.connect_raw().await.unwrap()))
    } else {
        None
    };
    let request = query(&client, raw);
    let waiter = client.clone();
    let raw_waiter = raw_client.clone();
    let mut pending = tokio::spawn(async move {
        match raw_waiter {
            Some(connection) => connection.request(request).await,
            None => waiter.request(request).await,
        }
    });
    wait_entered.await.unwrap();
    if let Some(connection) = &raw_client {
        connection.close().await.unwrap();
        connection.close().await.unwrap();
    } else {
        client.close().await.unwrap();
        client.close().await.unwrap();
    }
    let completion = tokio::time::timeout(Duration::from_millis(300), &mut pending).await;
    let closed_pending = matches!(&completion,Ok(Ok(Err(error))) if error.code=="UNAUTHENTICATED");
    let physical_close = tokio::time::timeout(Duration::from_millis(300), async {
        while !disconnected.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    release.notify_one();
    if completion.is_err() {
        let _ = pending.await;
    }
    let after = if let Some(connection) = &raw_client {
        connection.request(query(&client, true)).await
    } else {
        client.request(query(&client, false)).await
    };
    let another = HostClient::connect(ConnectOptions::new(
        dir.path().to_path_buf(),
        id("still-alive"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    assert!(matches!(
        another.request(query(&another, false)).await.unwrap(),
        RpcReply::Success { .. }
    ));
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert!(
        closed_pending,
        "close must wake the outstanding request despite its retained Arc"
    );
    assert!(
        physical_close,
        "close must actually release the transport before a late reply"
    );
    assert!(
        matches!(after,Err(ref error) if error.code=="UNAUTHENTICATED"),
        "closed connection must reject new writes: {after:?}"
    );
}
#[tokio::test]
async fn closing_control_wakes_pending_and_closes_transport_with_retained_client_arc() {
    closes(false).await;
}
#[tokio::test]
async fn closing_raw_wakes_pending_without_stopping_host_or_control() {
    closes(true).await;
}
