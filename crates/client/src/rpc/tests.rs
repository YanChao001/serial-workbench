use super::*;
use serial_workbench_ipc::{self as local, LocalListener};
use std::{
    future::{Future, poll_fn},
    task::Poll,
};
use tokio::sync::oneshot;

struct Fixture {
    _directory: tempfile::TempDir,
    client: Arc<RpcConnection>,
    server: LocalStream,
}
impl Fixture {
    async fn new() -> Self {
        static NEXT_ENDPOINT: AtomicU64 = AtomicU64::new(1);
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let directory = tempfile::Builder::new()
            .prefix("sw-rpc-")
            .tempdir_in(base)
            .unwrap();
        let runtime = directory.path().join("r");
        local::prepare_private_directory(&runtime).unwrap();
        let tag = format!(
            "rpc-{}-{}",
            std::process::id(),
            NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed)
        );
        let mut listener = LocalListener::bind(&runtime, &tag).unwrap();
        let endpoint = listener.endpoint().to_owned();
        let (client, server) = tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(local::connect(&endpoint), listener.accept())
        })
        .await
        .expect("LocalStream setup did not complete within its budget");
        Self {
            _directory: directory,
            client: Arc::new(RpcConnection::new(client.unwrap(), IpcChannel::Control)),
            server: server.unwrap(),
        }
    }
    async fn received(&mut self) -> WireFrame {
        tokio::time::timeout(
            Duration::from_secs(2),
            read_frame(&mut self.server, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    }
    async fn reply(&mut self, request: &WireFrame) {
        let frame = WireFrame {
            request_id: request.request_id.clone(),
            channel: request.channel,
            body: IpcMessage::Reply {
                reply: Box::new(RpcReply::Success {
                    ok: True,
                    result: Box::new(RpcResult::Query(QueryResult::Devices(DeviceList {
                        devices: Vec::new(),
                        stale: false,
                    }))),
                }),
            },
        };
        tokio::time::timeout(
            Duration::from_secs(2),
            write_frame(&mut self.server, &frame, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap();
    }
    async fn close(self) {
        let result = tokio::time::timeout(Duration::from_secs(5), self.client.close()).await;
        // 即使异步 close 超时，先释放本测试仍拥有的两端句柄和临时目录，再失败。
        drop(self);
        result
            .expect("RPC connection cleanup did not complete within its budget")
            .unwrap();
    }
}

async fn completed(mut task: JoinHandle<HostResult<RpcReply>>) -> RpcReply {
    match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
        Ok(result) => result.unwrap().unwrap(),
        Err(_) => {
            task.abort();
            let cleanup = tokio::time::timeout(Duration::from_secs(5), &mut task).await;
            assert!(
                cleanup.is_ok(),
                "Owned RPC task did not stop after cancellation"
            );
            panic!("RPC reply did not complete within its budget");
        }
    }
}

fn query(id: &str, action: &str) -> RpcRequest {
    RpcRequest::Query(serde_json::from_value(serde_json::json!({
        "protocolVersion":"0.1", "hostId":"private-host", "instanceEpoch":"1",
        "actorId":"private-actor", "requestId":id, "actionId":action,
        "target":{"hostId":"private-host","kind":"host","id":"private-host"},
        "params":{"privatePath":"C:/private/fixture", "requestContext":"PRIVATE_CONTEXT", "nonce":"PRIVATE_NONCE", "bytes":"PRIVATE_BODY"},
        "revealTarget":{"pageId":"workbench"}
    })).unwrap())
}
const FIRST_ID: &str = "00000000-0000-4000-8000-000000000001";
const SECOND_ID: &str = "00000000-0000-4000-8000-000000000002";

fn assert_success(reply: RpcReply) {
    assert!(
        matches!(reply, RpcReply::Success { result, .. } if matches!(*result, RpcResult::Query(QueryResult::Devices(_))))
    );
}

#[tokio::test]
async fn duplicate_pending_id_reports_conflict_without_replacing_or_cancelling_the_first_request() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "device.list")).await });
    // 收到真实首帧后才发第二次请求，不以 sleep 猜测 pending 是否建立。
    let frame = f.received().await;
    assert_eq!(frame.request_id.as_str(), FIRST_ID);
    let started = f
        .client
        .pending
        .lock()
        .unwrap()
        .get(&frame.request_id)
        .unwrap()
        .started;
    assert!(!first.is_finished());
    let error = tokio::time::timeout(
        Duration::from_secs(2),
        f.client.request(query(FIRST_ID, "catalog.list")),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert_eq!(error.code, "REQUEST_CONFLICT");
    assert_eq!(
        error.message,
        "This request is already pending on the connection"
    );
    assert!(error.details.is_none());
    assert!(f.client.healthy.load(Ordering::Acquire));
    {
        let pending = f.client.pending.lock().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending.get(&frame.request_id).unwrap().started, started);
        assert_eq!(
            pending.get(&frame.request_id).unwrap().diagnostic.action,
            "device.list"
        );
    }
    let connection = f.client.clone();
    let other =
        tokio::spawn(async move { connection.request(query(SECOND_ID, "device.list")).await });
    let next = f.received().await;
    assert_eq!(next.request_id.as_str(), SECOND_ID);
    f.reply(&next).await;
    assert_success(completed(other).await);
    f.reply(&frame).await;
    assert_success(completed(first).await);
    assert!(f.client.pending.lock().unwrap().is_empty());
    f.close().await;
}

#[tokio::test]
async fn identical_inflight_queries_share_the_original_reply_without_resending() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "operation.get")).await });
    let frame = f.received().await;
    let repeated_client = f.client.clone();
    let mut repeated = Box::pin(repeated_client.request(query(FIRST_ID, "operation.get")));
    poll_fn(|cx| {
        assert!(
            repeated.as_mut().poll(cx).is_pending(),
            "An identical in-flight delivery must await its original response"
        );
        Poll::Ready(())
    })
    .await;
    assert_eq!(f.client.pending.lock().unwrap().len(), 1);
    f.reply(&frame).await;
    assert_success(completed(first).await);
    assert_success(
        tokio::time::timeout(Duration::from_secs(2), repeated)
            .await
            .unwrap()
            .unwrap(),
    );
    assert!(f.client.pending.lock().unwrap().is_empty());
    f.client.close().await.unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_secs(2),
            read_frame(&mut f.server, MAX_FRAME_BYTES)
        )
        .await
        .unwrap()
        .unwrap()
        .is_none()
    );
    f.close().await;
}

#[tokio::test]
async fn cancelling_the_original_query_waiter_preserves_the_shared_request() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "operation.get")).await });
    let frame = f.received().await;
    let repeated_client = f.client.clone();
    let mut repeated = Box::pin(repeated_client.request(query(FIRST_ID, "operation.get")));
    poll_fn(|cx| {
        assert!(repeated.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    first.abort();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), first)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled()
    );
    assert_eq!(f.client.pending.lock().unwrap().len(), 1);
    f.reply(&frame).await;
    assert_success(
        tokio::time::timeout(Duration::from_secs(2), repeated)
            .await
            .unwrap()
            .unwrap(),
    );
    f.close().await;
}

#[tokio::test]
async fn cancelling_a_shared_query_waiter_preserves_the_original_request() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "operation.get")).await });
    let frame = f.received().await;
    let repeated_client = f.client.clone();
    let mut repeated = Box::pin(repeated_client.request(query(FIRST_ID, "operation.get")));
    poll_fn(|cx| {
        assert!(repeated.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    drop(repeated);
    assert_eq!(f.client.pending.lock().unwrap().len(), 1);
    f.reply(&frame).await;
    assert_success(completed(first).await);
    f.close().await;
}

#[tokio::test]
async fn completed_request_guard_cannot_remove_a_new_request_with_the_same_id() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let mut first = Box::pin(connection.request(query(FIRST_ID, "operation.get")));
    let frame = tokio::select! {
        _ = &mut first => panic!("First query completed before the peer replied"),
        frame = f.received() => frame,
    };
    f.reply(&frame).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while !f.client.pending.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let second_client = f.client.clone();
    let second = tokio::spawn(async move {
        second_client
            .request(query(FIRST_ID, "operation.get"))
            .await
    });
    let next = f.received().await;
    assert_success(first.await.unwrap());
    assert_eq!(f.client.pending.lock().unwrap().len(), 1);
    f.reply(&next).await;
    assert_success(completed(second).await);
    f.close().await;
}

#[tokio::test]
async fn shared_query_waiters_still_obey_the_connection_capacity() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "operation.get")).await });
    let frame = f.received().await;
    let repeated_client = f.client.clone();
    let mut repeated = Vec::new();
    for _ in 1..256 {
        let mut waiting = Box::pin(repeated_client.request(query(FIRST_ID, "operation.get")));
        poll_fn(|cx| {
            assert!(waiting.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        repeated.push(waiting);
    }
    assert_eq!(
        f.client
            .request(query(FIRST_ID, "operation.get"))
            .await
            .unwrap_err()
            .code,
        "HOST_BUSY"
    );
    drop(repeated);
    f.reply(&frame).await;
    assert_success(completed(first).await);
    f.close().await;
}

#[tokio::test]
async fn cancelled_write_owner_releases_shared_waiters_without_sending_the_query() {
    let mut f = Fixture::new().await;
    let writer_client = f.client.clone();
    let writer = writer_client.writer.lock().await;
    let connection = f.client.clone();
    let first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "operation.get")).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while f.client.pending.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let repeated_client = f.client.clone();
    let mut repeated = Box::pin(repeated_client.request(query(FIRST_ID, "operation.get")));
    poll_fn(|cx| {
        assert!(repeated.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    first.abort();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), first)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled()
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), repeated)
            .await
            .unwrap()
            .unwrap_err()
            .code,
        "UNAUTHENTICATED"
    );
    assert!(f.client.pending.lock().unwrap().is_empty());
    drop(writer);
    let next_client = f.client.clone();
    let next =
        tokio::spawn(async move { next_client.request(query(SECOND_ID, "operation.get")).await });
    let frame = f.received().await;
    assert_eq!(frame.request_id.as_str(), SECOND_ID);
    f.reply(&frame).await;
    assert_success(completed(next).await);
    f.close().await;
}

#[tokio::test]
async fn same_query_action_and_id_with_different_content_is_still_rejected() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "operation.get")).await });
    let frame = f.received().await;
    let RpcRequest::Query(mut changed) = query(FIRST_ID, "operation.get") else {
        unreachable!()
    };
    changed.params.insert(
        "operationId".into(),
        JsonValue::String("different-operation".into()),
    );
    assert_eq!(
        f.client
            .request(RpcRequest::Query(changed))
            .await
            .unwrap_err()
            .code,
        "REQUEST_CONFLICT"
    );
    f.reply(&frame).await;
    assert_success(completed(first).await);
    f.close().await;
}

#[tokio::test]
async fn identical_business_invokes_are_never_coalesced_or_replayed() {
    let mut f = Fixture::new().await;
    let RpcRequest::Query(q) = query(FIRST_ID, "settings.save") else {
        unreachable!()
    };
    let mut value = serde_json::to_value(q).unwrap();
    value.as_object_mut().unwrap().insert(
        "requestContext".into(),
        serde_json::json!("private-context"),
    );
    let request = RpcRequest::Invoke(serde_json::from_value(value).unwrap());
    let connection = f.client.clone();
    let original = request.clone();
    let first = tokio::spawn(async move { connection.request(original).await });
    let frame = f.received().await;
    assert_eq!(
        f.client.request(request).await.unwrap_err().code,
        "REQUEST_CONFLICT"
    );
    f.reply(&frame).await;
    assert_success(completed(first).await);
    f.close().await;
}

#[tokio::test]
async fn distinct_pending_ids_complete_independently_in_reverse_reply_order() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "device.list")).await });
    let first_frame = f.received().await;
    let connection = f.client.clone();
    let second =
        tokio::spawn(async move { connection.request(query(SECOND_ID, "device.list")).await });
    let second_frame = f.received().await;
    assert_ne!(first_frame.request_id, second_frame.request_id);
    assert_eq!(f.client.pending.lock().unwrap().len(), 2);
    f.reply(&second_frame).await;
    assert_success(completed(second).await);
    assert!(!first.is_finished());
    f.reply(&first_frame).await;
    assert_success(completed(first).await);
    assert!(f.client.pending.lock().unwrap().is_empty());
    f.close().await;
}

#[tokio::test]
async fn cancelled_outer_wait_keeps_the_owned_rpc_pending_until_its_actual_reply() {
    let mut f = Fixture::new().await;
    let connection = f.client.clone();
    let mut first =
        tokio::spawn(async move { connection.request(query(FIRST_ID, "device.list")).await });
    let frame = f.received().await;
    let (cancel, cancelled) = oneshot::channel();
    {
        // 模拟桥接层仅取消等待；实际 RPC task 仍持有其 pending 和资源责任。
        let mut waiting = Box::pin(async {
            tokio::select! {
                _ = cancelled => true,
                _ = &mut first => false,
            }
        });
        poll_fn(|cx| {
            assert!(waiting.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        cancel.send(()).unwrap();
        assert!(waiting.await);
    }
    assert!(!first.is_finished());
    assert_eq!(f.client.pending.lock().unwrap().len(), 1);
    let repeated_client = f.client.clone();
    let mut repeated = Box::pin(repeated_client.request(query(FIRST_ID, "device.list")));
    poll_fn(|cx| {
        assert!(repeated.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    f.reply(&frame).await;
    assert_success(completed(first).await);
    assert_success(
        tokio::time::timeout(Duration::from_secs(2), repeated)
            .await
            .unwrap()
            .unwrap(),
    );
    assert!(f.client.pending.lock().unwrap().is_empty());
    f.close().await;
}

#[test]
fn conflict_diagnostics_only_serialize_bounded_safe_metadata() {
    let first_request = query(FIRST_ID, "device.list");
    let second_request = query(FIRST_ID, "private.action");
    let (reply, _receive) = watch::channel(None);
    let pending = PendingRequest {
        reply,
        identity: Arc::new(()),
        fingerprint: request_fingerprint(&first_request).unwrap(),
        shareable: true,
        waiters: 1,
        diagnostic: RequestDiagnostic::of(&first_request),
        started: Instant::now(),
    };
    let diagnostic = ConflictDiagnostic::new(
        Some(7),
        IpcChannel::Control,
        &request_id(&first_request),
        &pending,
        RequestDiagnostic::of(&second_request),
    );
    let value = serde_json::to_value(&diagnostic).unwrap();
    assert_eq!(value["connection"], 7);
    assert_eq!(value["channel"], "control");
    assert_eq!(
        value["first"],
        serde_json::json!({"method":"action.query","action":"device.list"})
    );
    assert_eq!(
        value["second"],
        serde_json::json!({"method":"action.query","action":"other"})
    );
    assert_eq!(value.as_object().unwrap().len(), 6);
    let digest = value["request_digest"].as_str().unwrap();
    assert_eq!(digest.len(), 16);
    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let encoded = serde_json::to_string(&diagnostic).unwrap();
    assert!(encoded.len() < 512);
    for private in [
        FIRST_ID,
        "private-host",
        "private-actor",
        "C:/private/fixture",
        "PRIVATE_CONTEXT",
        "PRIVATE_NONCE",
        "PRIVATE_BODY",
        "private.action",
    ] {
        assert!(!encoded.contains(private));
    }
    assert!(value["inflight_ms"].is_u64());
    let same = ConflictDiagnostic::new(
        Some(9),
        IpcChannel::Raw,
        &request_id(&first_request),
        &pending,
        RequestDiagnostic::of(&second_request),
    );
    assert_eq!(diagnostic.request_digest, same.request_digest);
    let other = ConflictDiagnostic::new(
        Some(7),
        IpcChannel::Control,
        &request_id(&query(SECOND_ID, "device.list")),
        &pending,
        RequestDiagnostic::of(&second_request),
    );
    assert_ne!(diagnostic.request_digest, other.request_digest);
}

#[test]
fn conflict_warnings_have_one_process_wide_bounded_window() {
    let start = Instant::now();
    let mut warnings = ConflictWarnings {
        since: start,
        emitted: 0,
    };
    for _ in 0..20 {
        assert!(warnings.admit(start));
    }
    assert!(!warnings.admit(start));
    assert!(!warnings.admit(start + Duration::from_secs(59)));
    assert!(warnings.admit(start + Duration::from_secs(60)));
    assert_eq!(warnings.emitted, 1);
}

#[test]
fn diagnostic_connection_numbers_do_not_reuse_a_live_process_sequence() {
    let first = next_connection_id().unwrap();
    let second = next_connection_id().unwrap();
    assert!(second > first);
}
