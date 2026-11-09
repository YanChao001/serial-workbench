use super::*;

struct TestEffectExecutor;
impl platform_effects::PlatformEffectExecutor for TestEffectExecutor {
    fn capabilities(&self) -> Vec<serial_workbench_core::ClientCapability> {
        vec![serial_workbench_core::ClientCapability::WindowRead]
    }
    fn execute<'a>(
        &'a self,
        action: serial_workbench_core::ClientEffectAction,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = HostResult<serial_workbench_core::ClientEffectResult>>
                + Send
                + 'a,
        >,
    > {
        use serial_workbench_core::*;
        Box::pin(async move {
            assert!(matches!(action, ClientEffectAction::WindowRead {}));
            Ok(ClientEffectResult::Window(ClientWindowSnapshot {
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
            }))
        })
    }
}

fn key(generation: u64, id: &str, stream: DeliveryStream) -> DeliveryKey {
    DeliveryKey {
        generation,
        subscription_id: Id::try_from(id).unwrap(),
        stream,
    }
}

#[test]
fn closing_and_reconnecting_cannot_release_unacknowledged_window_budget() {
    let mut ledger = DeliveryLedger::new(2, 10);
    let old = key(1, "old", DeliveryStream::Data);
    let current = key(2, "new", DeliveryStream::Data);
    assert_eq!(ledger.reserve(&old, 6).unwrap(), 1);
    ledger.close(&old);
    assert_eq!(ledger.pending(), (1, 6));
    assert_eq!(ledger.reserve(&current, 5).unwrap_err().code, "HOST_BUSY");
    ledger.acknowledge(&old, 1).unwrap();
    assert_eq!(ledger.pending(), (0, 0));
    assert_eq!(ledger.reserve(&current, 5).unwrap(), 1);
}

#[test]
fn ack_is_cumulative_bounded_and_confined_to_exact_stream_and_generation() {
    let mut ledger = DeliveryLedger::new(4, 20);
    let old = key(1, "subscription", DeliveryStream::Data);
    let new = key(2, "subscription", DeliveryStream::Data);
    let lifecycle = key(2, "subscription", DeliveryStream::Lifecycle);
    assert_eq!(ledger.reserve(&old, 2).unwrap(), 1);
    assert_eq!(ledger.reserve(&new, 3).unwrap(), 1);
    assert_eq!(ledger.reserve(&new, 4).unwrap(), 2);
    assert_eq!(ledger.reserve(&lifecycle, 5).unwrap(), 1);
    assert_eq!(
        ledger.acknowledge(&new, 3).unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    ledger.acknowledge(&new, 1).unwrap();
    ledger.acknowledge(&new, 1).unwrap();
    assert_eq!(ledger.pending(), (3, 11));
    ledger.acknowledge(&old, 1).unwrap();
    assert_eq!(ledger.pending(), (2, 9));
    ledger.acknowledge(&lifecycle, 1).unwrap();
    assert_eq!(ledger.pending(), (1, 4));
    ledger.acknowledge(&new, 2).unwrap();
    assert_eq!(ledger.pending(), (0, 0));
}

#[test]
fn item_limit_applies_across_distinct_closed_subscriptions() {
    let mut ledger = DeliveryLedger::new(2, 100);
    for name in ["a", "b"] {
        let subscription = key(1, name, DeliveryStream::Data);
        ledger.reserve(&subscription, 1).unwrap();
        ledger.close(&subscription);
    }
    assert_eq!(
        ledger
            .reserve(&key(2, "c", DeliveryStream::Data), 1)
            .unwrap_err()
            .code,
        "HOST_BUSY"
    );
    assert_eq!(ledger.pending(), (2, 2));
}

fn query(
    attachment: &serial_workbench_core::AttachResult,
    action: &str,
    params: serde_json::Value,
    request_id: &str,
) -> serial_workbench_core::Query {
    use serial_workbench_core::*;
    Query {
        protocol_version: attachment.protocol_version,
        host_id: attachment.host_id.clone(),
        instance_epoch: attachment.instance_epoch,
        actor_id: attachment.actor_id.clone(),
        request_id: RequestId::try_from(request_id).unwrap(),
        action_id: Id::try_from(action).unwrap(),
        target: Target {
            host_id: attachment.host_id.clone(),
            id: attachment.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        },
        params: serde_json::from_value(params).unwrap(),
        reveal_target: RevealTarget {
            page_id: Id::try_from("workbench").unwrap(),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    }
}

#[tokio::test]
async fn rejected_window_cannot_bootstrap_or_create_profile() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("absent");
    let bridge = DesktopHostBridge::new(profile.clone());
    let error = match bridge.attach("diagnostics").await {
        Ok(_) => panic!("unexpected attachment"),
        Err(error) => error,
    };
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert!(!profile.exists());
}

#[tokio::test]
async fn retired_window_requests_and_subscriptions_never_implicitly_reattach() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::sync::Arc;
    use tauri::ipc::Channel;
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().into());
    let attached = bridge.attach("main").await.unwrap();
    let instance = bridge.instances.lock().unwrap().active["main"];
    let request = query(
        &attached.attachment,
        "state.snapshot",
        serde_json::json!({"scopeId":"host.devices"}),
        "00000000-0000-4000-8000-000000000091",
    );
    bridge.disconnect_for_test("main").await;
    let control = bridge
        .request("main", RpcRequest::StateSnapshot(request.clone()))
        .await;
    let control_reattached = bridge.inner.lock().await.windows.contains_key("main");
    bridge.disconnect_for_test("main").await;
    let raw = bridge
        .raw_request("main", RpcRequest::StateSnapshot(request.clone()))
        .await;
    let raw_reattached = bridge.inner.lock().await.windows.contains_key("main");
    bridge.disconnect_for_test("main").await;
    let state = bridge
        .subscribe_for_instance("main", instance, request.clone(), Channel::new(|_| Ok(())))
        .await;
    let state_reattached = bridge.inner.lock().await.windows.contains_key("main");
    bridge.disconnect_for_test("main").await;
    let stream = bridge
        .raw_subscribe_for_instance(
            "main",
            instance,
            request,
            Channel::new(|_| Ok(())),
            Channel::new(|_| Ok(())),
        )
        .await;
    let stream_reattached = bridge.inner.lock().await.windows.contains_key("main");
    bridge.disconnect_for_test("main").await;
    let explicit = bridge.attach("main").await.unwrap();
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    for (name, result) in [("control", control), ("raw", raw)] {
        assert!(
            matches!(result, Err(ref error) if error.code == "EPOCH_MISMATCH"),
            "{name}: {result:?}"
        );
    }
    for (name, result) in [("state", state), ("stream", stream)] {
        assert!(
            matches!(result, Err(ref error) if error.code == "EPOCH_MISMATCH"),
            "{name}: {result:?}"
        );
    }
    assert!(!control_reattached && !raw_reattached && !state_reattached && !stream_reattached);
    assert!(explicit.generation > attached.generation);
}

#[tokio::test]
async fn real_host_snapshot_subscription_and_close_use_one_authenticated_connection() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};
    use tauri::ipc::{Channel, InvokeResponseBody};

    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let control = server
        .auth()
        .authenticate_user_control(
            &Id::try_from("desktop").unwrap(),
            &serial_workbench_client::read_user_control_credential(directory.path()).unwrap(),
        )
        .unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attached = bridge.attach("main").await.unwrap();
    assert_ne!(&attached.attachment.actor_id, control.id());
    let internal = bridge
        .control_attachment_at_generation("main", attached.generation)
        .await
        .unwrap();
    assert_eq!(&internal.actor_id, control.id());
    assert_eq!(internal.client_id, attached.attachment.client_id);
    let internal_reply = bridge
        .control_request_at_generation(
            "main",
            attached.generation,
            RpcRequest::StateSnapshot(query(
                &internal,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000005",
            )),
        )
        .await
        .unwrap();
    assert!(matches!(internal_reply, RpcReply::Success { .. }));
    let auth_bypass = bridge
        .request(
            "main",
            RpcRequest::Query(query(
                &attached.attachment,
                "auth.authorize",
                serde_json::json!({}),
                "00000000-0000-4000-8000-000000000004",
            )),
        )
        .await;
    assert!(matches!(auth_bypass, Err(ref error) if error.code == "PERMISSION_DENIED"));
    let snapshot = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attached.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000001",
            )),
        )
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = snapshot else {
        panic!("snapshot failed: {snapshot:?}")
    };
    let RpcResult::Snapshot(snapshot) = *result else {
        panic!("expected snapshot")
    };
    let bypass = bridge
        .request(
            "main",
            RpcRequest::Query(query(
                &attached.attachment,
                "state.subscribe",
                serde_json::json!({"scopeId":"host.devices", "after": snapshot.cursor.clone()}),
                "00000000-0000-4000-8000-000000000003",
            )),
        )
        .await;
    assert!(matches!(bypass, Err(ref error) if error.code == "PERMISSION_DENIED"));
    assert_eq!(host.projections().reader_count(), 0);
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let channel = Channel::new(move |message| {
        if let InvokeResponseBody::Json(json) = message {
            let _ = send.send(serde_json::from_str::<WireFrame>(&json).unwrap());
        }
        Ok(())
    });
    let id = bridge
        .subscribe(
            "main",
            query(
                &attached.attachment,
                "state.subscribe",
                serde_json::json!({"scopeId":"host.devices", "after": snapshot.cursor}),
                "00000000-0000-4000-8000-000000000002",
            ),
            channel,
        )
        .await
        .unwrap();
    assert_eq!(host.projections().reader_count(), 1);
    host.projections()
        .commit(
            &Id::try_from("host.devices").unwrap(),
            Id::try_from("devices.changed").unwrap(),
            JsonObject::new(),
            JsonObject::new(),
        )
        .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(3), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(frame.body, IpcMessage::Delta { subscription_id, .. } if subscription_id == id)
    );
    bridge.unsubscribe("main", id).await.unwrap();
    assert_eq!(host.projections().reader_count(), 0);
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn stale_generation_never_commits_platform_effects() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let directory = tempfile::tempdir().unwrap();
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let ran = AtomicBool::new(false);
    let result = bridge
        .with_current_generation("main", 1.into(), || {
            ran.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
    assert_eq!(result.unwrap_err().code, "EPOCH_MISMATCH");
    assert!(!ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn destroying_window_releases_real_host_subscription_without_stopping_host() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};
    use tauri::ipc::Channel;

    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attached = bridge.attach("main").await.unwrap();
    let snapshot = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attached.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000011",
            )),
        )
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = snapshot else {
        panic!("snapshot failed")
    };
    let RpcResult::Snapshot(snapshot) = *result else {
        panic!("expected snapshot")
    };
    bridge
        .subscribe(
            "main",
            query(
                &attached.attachment,
                "state.subscribe",
                serde_json::json!({"scopeId":"host.devices", "after":snapshot.cursor}),
                "00000000-0000-4000-8000-000000000012",
            ),
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
    assert_eq!(host.projections().reader_count(), 1);
    bridge.destroy_window("main", attached.generation).await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.projections().reader_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let another = bridge.attach("secondary").await.unwrap();
    assert_eq!(another.attachment.host_id, attached.attachment.host_id);
    let replacement = bridge.attach("main").await.unwrap();
    assert_ne!(replacement.generation, attached.generation);
    bridge.destroy_window("main", attached.generation).await;
    bridge
        .with_current_generation("main", replacement.generation, || Ok(()))
        .await
        .unwrap();
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn internal_generation_request_does_not_attach_or_call_after_window_is_gone() {
    use serial_workbench_core::*;
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("absent");
    let bridge = DesktopHostBridge::new(profile.clone());
    let request = RpcRequest::Attach(AttachParams {
        supported_protocol_versions: vec!["0.1".into()],
        client_kind: ClientKind::Desktop,
        client_id: Id::try_from("desktop").unwrap(),
        expected_host_id: None,
    });
    let result = bridge
        .request_at_generation("main", 1.into(), request)
        .await;
    assert!(matches!(result, Err(ref error) if error.code == "EPOCH_MISMATCH"));
    assert!(!profile.exists());
}

#[tokio::test]
async fn internal_generation_attachment_does_not_implicitly_connect() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("absent");
    let bridge = DesktopHostBridge::new(profile.clone());
    let result = bridge.attachment_at_generation("main", 1.into()).await;
    assert!(matches!(result, Err(ref error) if error.code == "EPOCH_MISMATCH"));
    assert!(!profile.exists());
}

#[tokio::test]
async fn unacknowledged_frontend_is_bounded_and_control_remains_available() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};
    use tauri::ipc::{Channel, InvokeResponseBody};
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new_with_limits(directory.path().to_path_buf(), 1, 1024 * 1024);
    let attached = bridge.attach("main").await.unwrap();
    let reply = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attached.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000021",
            )),
        )
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("snapshot failed")
    };
    let RpcResult::Snapshot(snapshot) = *result else {
        panic!("expected snapshot")
    };
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let channel = Channel::new(move |message| {
        if let InvokeResponseBody::Json(json) = message {
            let _ = send.send(serde_json::from_str::<WireFrame>(&json).unwrap());
        }
        Ok(())
    });
    let subscription = bridge
        .subscribe(
            "main",
            query(
                &attached.attachment,
                "state.subscribe",
                serde_json::json!({"scopeId":"host.devices", "after":snapshot.cursor}),
                "00000000-0000-4000-8000-000000000022",
            ),
            channel,
        )
        .await
        .unwrap();
    for _ in 0..2 {
        host.projections()
            .commit(
                &Id::try_from("host.devices").unwrap(),
                Id::try_from("devices.changed").unwrap(),
                JsonObject::new(),
                JsonObject::new(),
            )
            .unwrap();
    }
    let first = tokio::time::timeout(Duration::from_secs(3), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(first.body, IpcMessage::Delta { ref subscription_id, .. } if subscription_id == &subscription)
    );
    let ended = tokio::time::timeout(Duration::from_secs(3), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(ended.body, IpcMessage::SubscriptionEnded { ref subscription_id, ref error } if subscription_id == &subscription && error.code == "CURSOR_EXPIRED")
    );
    let reply = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attached.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000023",
            )),
        )
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Success { .. }));
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn cancelled_subscribe_waiter_closes_late_real_host_reader() {
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
    struct Delayed {
        host: Host,
        entered: Arc<Notify>,
        completed: Arc<Notify>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }
    impl RequestHandler for Delayed {
        fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
            if matches!(request, RpcRequest::StateSubscribe(_)) {
                let release = self.release.lock().unwrap().take().unwrap();
                let entered = self.entered.clone();
                let completed = self.completed.clone();
                let host = self.host.clone();
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
        }
    }
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let entered = Arc::new(Notify::new());
    let completed = Arc::new(Notify::new());
    let (release, held) = oneshot::channel();
    let (stop, done) = oneshot::channel();
    let handler = Delayed {
        host: host.clone(),
        entered: entered.clone(),
        completed: completed.clone(),
        release: Mutex::new(Some(held)),
    };
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attached = bridge.attach("main").await.unwrap();
    let reply = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attached.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000031",
            )),
        )
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("snapshot failed")
    };
    let RpcResult::Snapshot(snapshot) = *result else {
        panic!("expected snapshot")
    };
    let worker = bridge.clone();
    let pending = tokio::spawn(async move {
        worker
            .subscribe(
                "main",
                query(
                    &attached.attachment,
                    "state.subscribe",
                    serde_json::json!({"scopeId":"host.devices", "after":snapshot.cursor}),
                    "00000000-0000-4000-8000-000000000032",
                ),
                tauri::ipc::Channel::new(|_| Ok(())),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    pending.abort();
    let _ = pending.await;
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), completed.notified())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if host.projections().reader_count() == 0 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if host.projections().reader_count() == 0 {
                    break;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn internal_control_connection_never_attaches_after_window_is_gone() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("absent");
    let bridge = DesktopHostBridge::new(profile.clone());
    let result = bridge
        .control_attachment_at_generation("main", 1.into())
        .await;
    assert!(matches!(result, Err(ref error) if error.code == "EPOCH_MISMATCH"));
    assert!(!profile.exists());
}

#[tokio::test]
async fn delivery_ack_cannot_attach_or_ack_another_window_generation() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("absent");
    let bridge = DesktopHostBridge::new(profile.clone());
    let result = bridge
        .delivery_ack(
            "main",
            1.into(),
            Id::try_from("subscription").unwrap(),
            DeliveryStream::Data,
            1.into(),
        )
        .await;
    assert!(matches!(result, Err(ref error) if error.code == "EPOCH_MISMATCH"));
    assert!(!profile.exists());
}

#[test]
fn in_flight_window_instance_is_invalidated_and_late_destroy_cannot_touch_replacement() {
    let mut instances = WindowInstances::new();
    let old = instances.create("main");
    assert!(instances.current("main", old));
    instances.destroy("main", old);
    assert!(!instances.current("main", old));
    let replacement = instances.create("main");
    assert_ne!(old, replacement);
    instances.destroy("main", old);
    assert!(instances.current("main", replacement));
    assert!(!instances.current("main", old));
}

#[tokio::test]
async fn raw_connection_rejects_control_requests_without_stopping_control_connection() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::sync::Arc;
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attached = bridge.attach("main").await.unwrap();
    let raw = bridge
        .raw_request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attached.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000041",
            )),
        )
        .await
        .unwrap();
    assert!(matches!(raw, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"));
    let control = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attached.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000042",
            )),
        )
        .await
        .unwrap();
    assert!(matches!(control, RpcReply::Success { .. }));
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn first_profile_starts_then_reads_control_and_attaches_distinct_business_actor() {
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::sync::{Arc, Mutex};
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let profile = directory.path().join("fresh");
    let bridge = DesktopHostBridge::new(profile.clone());
    let running = Arc::new(Mutex::new(None));
    let capture = running.clone();
    let start_profile = profile.clone();
    let attachment = bridge
        .bootstrap_with_test_start("main", move || async move {
            let mut server = HostServer::bind(&start_profile).await?;
            let host = Host::new(server.store(), server.auth()).await?;
            let (stop, done) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                server
                    .serve_until(Arc::new(host), async {
                        let _ = done.await;
                    })
                    .await
            });
            *capture.lock().unwrap() = Some((stop, task));
            Ok(())
        })
        .await
        .unwrap();
    let control = bridge
        .control_attachment_at_generation("main", attachment.generation)
        .await
        .unwrap();
    assert_eq!(control.host_id, attachment.attachment.host_id);
    assert_eq!(control.client_id, attachment.attachment.client_id);
    assert_ne!(control.actor_id, attachment.attachment.actor_id);
    assert!(profile.join("host-v0/user-control.secret").is_file());
    drop(bridge);
    let (stop, task) = running.lock().unwrap().take().unwrap();
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn corrupt_existing_control_credential_never_downgrades_to_business_attachment() {
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::sync::Arc;
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let secret = directory.path().join("host-v0/user-control.secret");
    std::fs::write(&secret, b"invalid protected credential").unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    assert!(bridge.attach("main").await.is_err());
    assert!(!directory.path().join("host-v0/clients").exists());
    drop(bridge);
    stop.send(()).unwrap();
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn raw_subscribe_rejects_untrusted_window_before_connecting() {
    use serial_workbench_core::*;
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("absent");
    let bridge = DesktopHostBridge::new(profile.clone());
    let target = Target {
        host_id: Id::try_from("host").unwrap(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: Id::try_from("host").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    let request = Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: target.host_id.clone(),
        instance_epoch: 1.into(),
        actor_id: Id::try_from("actor").unwrap(),
        request_id: RequestId::try_from("00000000-0000-4000-8000-000000000051").unwrap(),
        action_id: Id::try_from("stream.subscribe").unwrap(),
        target,
        params: JsonObject::new(),
        reveal_target: RevealTarget {
            page_id: Id::try_from("workbench").unwrap(),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    };
    let result = bridge
        .raw_subscribe(
            "diagnostics",
            request,
            tauri::ipc::Channel::new(|_| Ok(())),
            tauri::ipc::Channel::new(|_| Ok(())),
        )
        .await;
    assert!(matches!(result, Err(ref error) if error.code == "PERMISSION_DENIED"));
    assert!(!profile.exists());
}

#[tokio::test]
async fn raw_unsubscribe_rejects_untrusted_window_before_connecting() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("absent");
    let bridge = DesktopHostBridge::new(profile.clone());
    let result = bridge
        .raw_unsubscribe("diagnostics", Id::try_from("sub").unwrap())
        .await;
    assert!(matches!(result, Err(ref error) if error.code == "PERMISSION_DENIED"));
    assert!(!profile.exists());
}

#[tokio::test]
async fn old_generation_ack_releases_only_old_delivery_after_reconnect() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};
    use tauri::ipc::{Channel, InvokeResponseBody};
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new_with_limits(directory.path().to_path_buf(), 4, 1024 * 1024);
    let old = bridge.attach("main").await.unwrap();
    let reply = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &old.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000061",
            )),
        )
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("snapshot failed")
    };
    let RpcResult::Snapshot(snapshot) = *result else {
        panic!("expected snapshot")
    };
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let channel = Channel::new(move |message| {
        if let InvokeResponseBody::Json(json) = message {
            let _ = send.send(serde_json::from_str::<WireFrame>(&json).unwrap());
        }
        Ok(())
    });
    let id = bridge
        .subscribe(
            "main",
            query(
                &old.attachment,
                "state.subscribe",
                serde_json::json!({"scopeId":"host.devices", "after":snapshot.cursor}),
                "00000000-0000-4000-8000-000000000062",
            ),
            channel,
        )
        .await
        .unwrap();
    host.projections()
        .commit(
            &Id::try_from("host.devices").unwrap(),
            Id::try_from("devices.changed").unwrap(),
            JsonObject::new(),
            JsonObject::new(),
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), receive.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bridge.pending_for_test("main").await.0, 1);
    bridge.disconnect_for_test("main").await;
    let current = bridge.attach("main").await.unwrap();
    assert_ne!(current.generation, old.generation);
    assert_eq!(bridge.pending_for_test("main").await.0, 1);
    bridge
        .delivery_ack("main", old.generation, id, DeliveryStream::Data, 1.into())
        .await
        .unwrap();
    assert_eq!(bridge.pending_for_test("main").await.0, 0);
    bridge
        .with_current_generation("main", current.generation, || Ok(()))
        .await
        .unwrap();
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn destroyed_instance_during_real_attach_cannot_publish_late_connection() {
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};
    use tokio::sync::{Notify, oneshot};
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let entered = Arc::new(Notify::new());
    let (release, held) = oneshot::channel();
    let (stop, done) = oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let instance = bridge.create_instance_for_test("main");
    let worker = bridge.clone();
    let signal = entered.clone();
    let pending = tokio::spawn(async move {
        worker
            .attach_instance_with_gate_for_test("main", instance, signal, held)
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    bridge.destroy_instance_for_test("main", instance);
    let replacement = bridge.create_instance_for_test("main");
    assert!(!bridge.inner.lock().await.windows.contains_key("main"));
    let _ = release.send(());
    let result = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(result, Err(ref error) if error.code == "EPOCH_MISMATCH"));
    let current = bridge
        .attach_instance_for_test("main", replacement)
        .await
        .unwrap();
    assert_eq!(current.attachment.client_id.as_str(), "desktop");
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn raw_subscription_uses_real_host_cursor_and_closes_its_reader() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::sync::Arc;
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let auth = server.auth();
    let operator = auth
        .authenticate_user_control(
            &Id::try_from("desktop").unwrap(),
            &serial_workbench_client::read_user_control_credential(directory.path()).unwrap(),
        )
        .unwrap();
    let host = Host::new(server.store(), auth.clone()).await.unwrap();
    let host_id = server.store().identity().unwrap().host_id;
    let host_target = Target {
        host_id: host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let device = Target {
        kind: ResourceKind::try_from("device").unwrap(),
        id: Id::try_from("virtual:echo").unwrap(),
        ..host_target.clone()
    };
    let opened = host
        .devices()
        .open(
            &device,
            OpenParams {
                configuration: SerialConfiguration::default(),
                binding: None,
            },
        )
        .await
        .unwrap();
    let session = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..host_target.clone()
    };
    let (stop, done) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attached = bridge.attach("main").await.unwrap();
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: attached.attachment.client_id.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![host_target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let mut cursor_query = query(
        &attached.attachment,
        "stream.cursor",
        serde_json::json!({}),
        "00000000-0000-4000-8000-000000000071",
    );
    cursor_query.target = session.clone();
    let cursor = bridge
        .raw_request("main", RpcRequest::Query(cursor_query))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = cursor else {
        panic!("cursor failed: {cursor:?}")
    };
    let RpcResult::Query(QueryResult::StreamCursor(cursor)) = *result else {
        panic!("expected stream cursor")
    };
    let mut subscribe = query(
        &attached.attachment,
        "stream.subscribe",
        serde_json::json!({"scopeId":cursor.cursor.scope_id,"after":cursor.cursor,"queueBytes":"65536","initialCreditBytes":"65536","overflowPolicy":"drop_with_gap"}),
        "00000000-0000-4000-8000-000000000072",
    );
    subscribe.target = session;
    let (send, mut lifecycle) = tokio::sync::mpsc::unbounded_channel();
    let lifecycle_channel = tauri::ipc::Channel::new(move |message| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = message {
            let _ = send.send(serde_json::from_str::<WireFrame>(&json).unwrap());
        }
        Ok(())
    });
    let id = bridge
        .raw_subscribe(
            "main",
            subscribe,
            tauri::ipc::Channel::new(|_| Ok(())),
            lifecycle_channel,
        )
        .await
        .unwrap();
    assert!(!id.as_str().is_empty());
    auth.revoke(
        &operator,
        RevokeParams {
            actor_id: attached.attachment.actor_id.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![host_target],
        },
    )
    .unwrap();
    let ended = tokio::time::timeout(std::time::Duration::from_secs(3), lifecycle.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(ended.body, IpcMessage::SubscriptionEnded { subscription_id, error } if subscription_id == id && error.code == "PERMISSION_DENIED")
    );
    bridge.raw_unsubscribe("main", id).await.unwrap();
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn late_frames_after_unsubscribe_do_not_disconnect_another_subscription() {
    use serial_workbench_core::*;
    use serial_workbench_host::{
        Host,
        ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler},
    };
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };
    use tauri::ipc::{Channel, InvokeResponseBody};
    use tokio::sync::{Notify, oneshot};
    struct DelayedClose {
        host: Host,
        entered: Arc<Notify>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }
    impl RequestHandler for DelayedClose {
        fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
            let release = if matches!(request, RpcRequest::SubscriptionClose(_)) {
                self.release.lock().unwrap().take()
            } else {
                None
            };
            if let Some(release) = release {
                let host = self.host.clone();
                let entered = self.entered.clone();
                Box::pin(async move {
                    entered.notify_one();
                    let _ = release.await;
                    host.handle(context, request).await
                })
            } else {
                self.host.handle(context, request)
            }
        }
        fn disconnected(&self, context: &ConnectionContext) {
            self.host.disconnected(context);
        }
    }
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let entered = Arc::new(Notify::new());
    let (release, held) = oneshot::channel();
    let (stop, done) = oneshot::channel();
    let handler = DelayedClose {
        host: host.clone(),
        entered: entered.clone(),
        release: Mutex::new(Some(held)),
    };
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attachment = bridge.attach("main").await.unwrap();
    let reply = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attachment.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000091",
            )),
        )
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("snapshot failed")
    };
    let RpcResult::Snapshot(snapshot) = *result else {
        panic!("expected snapshot")
    };
    let old = bridge
        .subscribe(
            "main",
            query(
                &attachment.attachment,
                "state.subscribe",
                serde_json::json!({"scopeId":"host.devices","after":snapshot.cursor}),
                "00000000-0000-4000-8000-000000000092",
            ),
            Channel::new(|_| Ok(())),
        )
        .await
        .unwrap();
    let (frames, mut received) = tokio::sync::mpsc::unbounded_channel();
    let witness = bridge
        .subscribe(
            "main",
            query(
                &attachment.attachment,
                "state.subscribe",
                serde_json::json!({"scopeId":"host.devices","after":snapshot.cursor}),
                "00000000-0000-4000-8000-000000000093",
            ),
            Channel::new(move |message| {
                if let InvokeResponseBody::Json(json) = message {
                    let _ = frames.send(serde_json::from_str::<WireFrame>(&json).unwrap());
                }
                Ok(())
            }),
        )
        .await
        .unwrap();
    let worker = bridge.clone();
    let closing = tokio::spawn(async move { worker.unsubscribe("main", old).await });
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .unwrap();
    // Host close is deliberately held: each event reaches the already-retired
    // channel and a live witness. Acknowledging the witness keeps normal delivery
    // capacity available, so only retention of the retired frames can overflow.
    let outcome = tokio::time::timeout(Duration::from_secs(10), async {
        for ordinal in 1..=300_u64 {
            host.projections().commit(
                &Id::try_from("host.devices").unwrap(), Id::try_from("devices.changed").unwrap(),
                JsonObject::new(), JsonObject::new(),
            ).map_err(|error| error.to_string())?;
            let frame = received.recv().await.ok_or("Witness channel closed".to_owned())?;
            if !matches!(frame.body, IpcMessage::Delta { subscription_id, .. } if subscription_id == witness) {
                return Err("An unrelated live subscription was terminated by retired frames".to_owned());
            }
            bridge.delivery_ack("main", attachment.generation, witness.clone(), DeliveryStream::Data, ordinal.into())
                .await.map_err(|error| error.to_string())?;
        }
        Ok::<_, String>(())
    }).await;
    let _ = release.send(());
    let _ = tokio::time::timeout(Duration::from_secs(3), closing).await;
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert!(
        matches!(outcome, Ok(Ok(()))),
        "Late-frame isolation failed: {outcome:?}"
    );
}

#[tokio::test]
async fn early_frame_overflow_closes_actual_control_connection() {
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
    struct DelayedReply {
        host: Host,
        subscribed: Arc<Notify>,
        release: Mutex<Option<oneshot::Receiver<()>>>,
    }
    impl RequestHandler for DelayedReply {
        fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
            if matches!(request, RpcRequest::StateSubscribe(_)) {
                let release = self.release.lock().unwrap().take().unwrap();
                let subscribed = self.subscribed.clone();
                let host = self.host.clone();
                Box::pin(async move {
                    let result = host.handle(context, request).await;
                    subscribed.notify_one();
                    let _ = release.await;
                    result
                })
            } else {
                self.host.handle(context, request)
            }
        }
        fn disconnected(&self, context: &ConnectionContext) {
            self.host.disconnected(context);
        }
    }
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let subscribed = Arc::new(Notify::new());
    let (release, held) = oneshot::channel();
    let (stop, done) = oneshot::channel();
    let handler = DelayedReply {
        host: host.clone(),
        subscribed: subscribed.clone(),
        release: Mutex::new(Some(held)),
    };
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attachment = bridge.attach("main").await.unwrap();
    let reply = bridge
        .request(
            "main",
            RpcRequest::StateSnapshot(query(
                &attachment.attachment,
                "state.snapshot",
                serde_json::json!({"scopeId":"host.devices"}),
                "00000000-0000-4000-8000-000000000081",
            )),
        )
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("snapshot failed")
    };
    let RpcResult::Snapshot(snapshot) = *result else {
        panic!("expected snapshot")
    };
    let worker = bridge.clone();
    let a = attachment.attachment.clone();
    let pending = tokio::spawn(async move {
        worker
            .subscribe(
                "main",
                query(
                    &a,
                    "state.subscribe",
                    serde_json::json!({"scopeId":"host.devices","after":snapshot.cursor}),
                    "00000000-0000-4000-8000-000000000082",
                ),
                tauri::ipc::Channel::new(|_| Ok(())),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), subscribed.notified())
        .await
        .unwrap();
    for expected in 1..=256 {
        host.projections()
            .commit(
                &Id::try_from("host.devices").unwrap(),
                Id::try_from("devices.changed").unwrap(),
                JsonObject::new(),
                JsonObject::new(),
            )
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let subscriptions = {
                    let state = bridge.inner.lock().await;
                    state
                        .windows
                        .get("main")
                        .map(|window| window.subscriptions.clone())
                };
                let count = subscriptions
                    .map(|subscriptions| subscriptions.lock().unwrap().setups.lock().unwrap().len())
                    .unwrap_or(0);
                if count >= expected {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    host.projections()
        .commit(
            &Id::try_from("host.devices").unwrap(),
            Id::try_from("devices.changed").unwrap(),
            JsonObject::new(),
            JsonObject::new(),
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while bridge.inner.lock().await.windows.contains_key("main") {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while host.projections().reader_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    release.send(()).ok();
    let result = tokio::time::timeout(Duration::from_secs(3), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_err());
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[test]
fn late_call_from_old_window_identity_never_resolves_new_instance() {
    let mut windows = WindowInstances::new();
    let old = windows.create("main");
    windows.identities.insert("main".into(), 100);
    assert_eq!(windows.resolve("main", 100), Some(old));
    let new = windows.create("main");
    windows.identities.insert("main".into(), 200);
    assert_eq!(windows.resolve("main", 100), None);
    assert_eq!(windows.resolve("main", 200), Some(new));
}

#[test]
fn concurrent_host_terminals_use_normal_budget_then_one_emergency_slot() {
    use serial_workbench_core::*;
    use std::sync::{Arc, Mutex};
    use tauri::ipc::{Channel, InvokeResponseBody};
    let ids: Vec<_> = ["sub-a", "sub-b", "sub-c"]
        .into_iter()
        .map(|id| Id::try_from(id).unwrap())
        .collect();
    let target = Target {
        host_id: Id::try_from("host").unwrap(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: Id::try_from("host").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    let query = Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: target.host_id.clone(),
        instance_epoch: 1.into(),
        actor_id: Id::try_from("actor").unwrap(),
        request_id: RequestId::try_from("00000000-0000-4000-8000-000000000091").unwrap(),
        action_id: Id::try_from("state.subscribe").unwrap(),
        target,
        params: JsonObject::new(),
        reveal_target: RevealTarget {
            page_id: Id::try_from("workbench").unwrap(),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    };
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = received.clone();
    let channel = Channel::new(move |message| {
        if let InvokeResponseBody::Json(json) = message {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str::<WireFrame>(&json).unwrap());
        }
        Ok(())
    });
    let ledger = Arc::new(Mutex::new(DeliveryLedger::new(2, 1024 * 1024)));
    ledger
        .lock()
        .unwrap()
        .reserve(
            &DeliveryKey {
                generation: 1,
                subscription_id: ids[0].clone(),
                stream: DeliveryStream::Data,
            },
            1,
        )
        .unwrap();
    let mut subscriptions = Subscriptions {
        active: ids
            .iter()
            .map(|id| {
                (
                    id.clone(),
                    Subscription {
                        query: query.clone(),
                        channel: channel.clone(),
                    },
                )
            })
            .collect(),
        setups: Default::default(),
        ledger,
        failed: false,
    };
    let terminal = |id: Id| WireFrame {
        request_id: RequestId::try_from("00000000-0000-4000-8000-000000000092").unwrap(),
        channel: IpcChannel::State,
        body: IpcMessage::SubscriptionEnded {
            subscription_id: id,
            error: HostError::new("PERMISSION_DENIED", "Permission revoked"),
        },
    };
    for id in &ids[..2] {
        deliver_state(&mut subscriptions, 1, terminal(id.clone()));
    }
    assert!(!subscriptions.failed);
    assert_eq!(subscriptions.ledger.lock().unwrap().pending().0, 3);
    // 普通预算及唯一应急槽都耗尽后，仍关闭连接，不无限排队。
    deliver_state(&mut subscriptions, 1, terminal(ids[2].clone()));
    assert!(subscriptions.failed);
    let received = received.lock().unwrap();
    assert_eq!(received.len(), 2);
    for frame in received.iter() {
        assert!(
            matches!(&frame.body, IpcMessage::SubscriptionEnded { error, .. } if error.code == "PERMISSION_DENIED")
        );
    }
    let mut ledger = subscriptions.ledger.lock().unwrap();
    ledger
        .acknowledge(&key(1, "sub-a", DeliveryStream::Data), 2)
        .unwrap();
    ledger
        .acknowledge(&key(1, "sub-b", DeliveryStream::Data), 1)
        .unwrap();
    assert_eq!(ledger.pending(), (0, 0));
    assert!(!ledger.terminal_inflight);
}

#[tokio::test]
async fn registered_native_receiver_returns_typed_receipt_over_real_control_connection() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attached = bridge.attach("main").await.unwrap();
    let registration = bridge
        .start_effects("main", attached.generation, Arc::new(TestEffectExecutor))
        .await
        .unwrap();
    let mut request = query(
        &attached.attachment,
        "client.window.read",
        serde_json::json!({}),
        "00000000-0000-4000-8000-000000000102",
    );
    request.target = registration.target;
    let reply = tokio::time::timeout(
        Duration::from_secs(3),
        bridge.request("main", RpcRequest::Query(request)),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(reply, RpcReply::Success { .. }));
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn explicit_device_connect_grants_only_selected_device_and_real_session() {
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::sync::Arc;
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attached = bridge.attach("main").await.unwrap();
    let opened = bridge
        .connect_device_intent(
            "main",
            attached.generation,
            Id::try_from("virtual:echo").unwrap(),
            OpenParams {
                configuration: SerialConfiguration::default(),
                binding: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(opened.device_id, Id::try_from("virtual:echo").unwrap());
    assert_eq!(opened.state, SessionState::Open);
    let mut other = query(
        &attached.attachment,
        "session.close",
        serde_json::json!({}),
        "00000000-0000-4000-8000-000000000103",
    );
    other.target = Target {
        host_id: attached.attachment.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: Id::try_from("other-session").unwrap(),
        session_id: Some(Id::try_from("other-session").unwrap()),
        session_epoch: Some(opened.session_epoch),
    };
    let call = Call {
        protocol_version: other.protocol_version,
        host_id: other.host_id,
        instance_epoch: other.instance_epoch,
        actor_id: other.actor_id,
        request_id: other.request_id,
        request_context: attached.attachment.request_context.clone(),
        action_id: other.action_id,
        target: other.target,
        params: other.params,
        reveal_target: other.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: Some(ExecutionMode::Interactive),
    };
    assert!(
        matches!(bridge.request_at_generation("main", attached.generation, RpcRequest::Invoke(call)).await.unwrap(),
        RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn settings_effects_stale_generation_never_reattaches() {
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::sync::Arc;
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
    let attached = bridge.attach("main").await.unwrap();
    assert_eq!(
        bridge
            .settings_attachment_for_generation("main", attached.generation)
            .await
            .unwrap()
            .actor_id,
        attached.attachment.actor_id
    );
    bridge.destroy_window("main", attached.generation).await;
    assert_eq!(
        bridge
            .settings_attachment_for_generation("main", attached.generation)
            .await
            .unwrap_err()
            .code,
        "EPOCH_MISMATCH"
    );
    assert!(!bridge.inner.lock().await.windows.contains_key("main"));
    drop(bridge);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[test]
fn authorized_close_for_old_instance_cannot_close_recreated_window() {
    let bridge = DesktopHostBridge::new(std::path::PathBuf::new());
    let (old, new) = {
        let mut instances = bridge.instances.lock().unwrap();
        let old = instances.create("secondary");
        let new = instances.create("secondary");
        (old, new)
    };
    assert!(!bridge.can_close_window_instance("secondary", old));
    assert!(bridge.can_close_window_instance("secondary", new));
}
