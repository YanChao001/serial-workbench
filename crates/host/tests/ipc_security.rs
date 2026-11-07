use serial_workbench_client::{ConnectOptions, HostClient, RawConnection};
use serial_workbench_core::*;
use serial_workbench_host::ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::oneshot;

struct CountingHandler(Arc<AtomicUsize>);
impl RequestHandler for CountingHandler {
    fn handle(&self, _: ConnectionContext, _: RpcRequest) -> HandlerFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async {
            Ok(RpcReply::Success {
                ok: True,
                result: Box::new(RpcResult::Closed(ClosedResult { closed: True })),
            }
            .into())
        })
    }
}
fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
fn temporary_profile() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}
fn request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap()
}
fn query(client: &HostClient) -> RpcRequest {
    let attach = client.attachment();
    RpcRequest::StateSnapshot(Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: attach.host_id.clone(),
        instance_epoch: attach.instance_epoch,
        actor_id: attach.actor_id.clone(),
        request_id: request_id(),
        action_id: id("state.snapshot"),
        target: Target {
            host_id: attach.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: attach.host_id.clone(),
            session_id: None,
            session_epoch: None,
        },
        params: JsonObject::new(),
        reveal_target: RevealTarget {
            page_id: id("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    })
}

#[tokio::test]
async fn authenticated_attach_dispatch_and_disconnect_leave_host_running() {
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let expected_host_id = host.identity().host_id.clone();
    let dispatched = Arc::new(AtomicUsize::new(0));
    let (stop, done) = oneshot::channel();
    let handler = Arc::new(CountingHandler(dispatched.clone()));
    let running = tokio::spawn(async move {
        host.serve_until(handler, async {
            let _ = done.await;
        })
        .await
    });
    let options = ConnectOptions::new(
        directory.path().to_path_buf(),
        id("new-mcp"),
        ClientKind::Mcp,
    );
    let client = HostClient::connect(options.clone()).await.unwrap();
    assert_eq!(client.attachment().host_id, expected_host_id);
    assert!(matches!(
        client.request(query(&client)).await.unwrap(),
        RpcReply::Success { .. }
    ));
    assert_eq!(dispatched.load(Ordering::SeqCst), 1);
    drop(client);
    let reconnected = HostClient::connect(options).await.unwrap();
    assert_eq!(reconnected.attachment().host_id, expected_host_id);
    drop(reconnected);
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn forged_actor_and_stale_epoch_are_rejected_before_dispatch() {
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let dispatched = Arc::new(AtomicUsize::new(0));
    let (stop, done) = oneshot::channel();
    let handler = Arc::new(CountingHandler(dispatched.clone()));
    let running = tokio::spawn(async move {
        host.serve_until(handler, async {
            let _ = done.await;
        })
        .await
    });
    let client = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("mcp"),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    let RpcRequest::StateSnapshot(mut forged) = query(&client) else {
        unreachable!()
    };
    forged.actor_id = id("claimed-actor");
    assert!(
        matches!(client.request(RpcRequest::StateSnapshot(forged)).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "ACTOR_MISMATCH")
    );
    let RpcRequest::StateSnapshot(mut stale) = query(&client) else {
        unreachable!()
    };
    stale.instance_epoch = 0.into();
    assert!(
        matches!(client.request(RpcRequest::StateSnapshot(stale)).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "EPOCH_MISMATCH")
    );
    assert_eq!(dispatched.load(Ordering::SeqCst), 0);
    drop(client);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn forged_discovery_host_is_rejected_without_dispatch() {
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let dispatched = Arc::new(AtomicUsize::new(0));
    let (stop, done) = oneshot::channel();
    let handler = Arc::new(CountingHandler(dispatched.clone()));
    let running = tokio::spawn(async move {
        host.serve_until(handler, async {
            let _ = done.await;
        })
        .await
    });
    let discovery_path = directory.path().join("host-v0/discovery.json");
    let mut discovery: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&discovery_path).unwrap()).unwrap();
    discovery["hostId"] = serde_json::json!("forged-host");
    serial_workbench_ipc::write_atomic(&discovery_path, &serde_json::to_vec(&discovery).unwrap())
        .unwrap();
    let result = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("mcp"),
        ClientKind::Mcp,
    ))
    .await;
    assert!(matches!(result, Err(error) if error.code == "HOST_ID_MISMATCH"));
    assert_eq!(dispatched.load(Ordering::SeqCst), 0);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn two_connections_of_one_actor_have_independent_cleanup() {
    struct Connections {
        seen: Arc<std::sync::Mutex<Vec<(Id, Id)>>>,
        closed: Arc<std::sync::Mutex<Vec<Id>>>,
    }
    impl RequestHandler for Connections {
        fn handle(&self, context: ConnectionContext, _: RpcRequest) -> HandlerFuture {
            self.seen
                .lock()
                .unwrap()
                .push((context.connection_id, context.actor.id().clone()));
            Box::pin(async {
                Ok(RpcReply::Success {
                    ok: True,
                    result: Box::new(RpcResult::Closed(ClosedResult { closed: True })),
                }
                .into())
            })
        }
        fn disconnected(&self, context: &ConnectionContext) {
            self.closed
                .lock()
                .unwrap()
                .push(context.connection_id.clone());
        }
    }
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let closed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (stop, done) = oneshot::channel();
    let handler = Arc::new(Connections {
        seen: seen.clone(),
        closed: closed.clone(),
    });
    let running = tokio::spawn(async move {
        host.serve_until(handler, async {
            let _ = done.await;
        })
        .await
    });
    let options = ConnectOptions::new(
        directory.path().to_path_buf(),
        id("shared-client"),
        ClientKind::Cli,
    );
    let first = HostClient::connect(options.clone()).await.unwrap();
    let second = HostClient::connect(options).await.unwrap();
    first.request(query(&first)).await.unwrap();
    second.request(query(&second)).await.unwrap();
    let connections = seen.lock().unwrap().clone();
    assert_eq!(connections[0].1, connections[1].1);
    assert_ne!(connections[0].0, connections[1].0);
    drop(first);
    tokio::time::timeout(Duration::from_secs(3), async {
        while !closed.lock().unwrap().contains(&connections[0].0) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!closed.lock().unwrap().contains(&connections[1].0));
    assert!(matches!(
        second.request(query(&second)).await.unwrap(),
        RpcReply::Success { .. }
    ));
    drop(second);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn raw_is_a_separate_connection_and_old_attach_token_is_rejected() {
    struct Tracker {
        closed: Arc<tokio::sync::Notify>,
        count: Arc<AtomicUsize>,
    }
    impl RequestHandler for Tracker {
        fn handle(&self, _: ConnectionContext, _: RpcRequest) -> HandlerFuture {
            self.count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Ok(RpcReply::Success {
                    ok: True,
                    result: Box::new(RpcResult::Closed(ClosedResult { closed: True })),
                }
                .into())
            })
        }
        fn disconnected(&self, context: &ConnectionContext) {
            if context.channel == IpcChannel::Control {
                self.closed.notify_one();
            }
        }
    }
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let closed = Arc::new(tokio::sync::Notify::new());
    let count = Arc::new(AtomicUsize::new(0));
    let (stop, done) = oneshot::channel();
    let handler = Arc::new(Tracker {
        closed: closed.clone(),
        count: count.clone(),
    });
    let running = tokio::spawn(async move {
        host.serve_until(handler, async {
            let _ = done.await;
        })
        .await
    });
    let client = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("raw-reader"),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    let attachment = client.raw_attachment();
    let raw = client.connect_raw().await.unwrap();
    assert!(RawConnection::connect(attachment.clone()).await.is_err());
    assert!(
        matches!(raw.request(query(&client)).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let RpcRequest::StateSnapshot(mut stream_query) = query(&client) else {
        unreachable!()
    };
    stream_query.action_id = id("stream.read");
    assert!(
        matches!(client.request(RpcRequest::StreamRead(stream_query)).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(matches!(
        client.request(query(&client)).await.unwrap(),
        RpcReply::Success { .. }
    ));
    drop(raw);
    drop(client);
    tokio::time::timeout(Duration::from_secs(3), closed.notified())
        .await
        .unwrap();
    assert!(
        matches!(RawConnection::connect(attachment).await, Err(error) if error.code == "UNAUTHENTICATED")
    );
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn oversized_and_partial_network_frames_never_reach_auth_or_dispatch() {
    use tokio::io::AsyncWriteExt;
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let auth = host.auth();
    let count = Arc::new(AtomicUsize::new(0));
    let discovery = serial_workbench_ipc::DiscoveryRecord::read(
        &directory.path().join("host-v0/discovery.json"),
    )
    .unwrap();
    let (stop, done) = oneshot::channel();
    let handler = Arc::new(CountingHandler(count.clone()));
    let running = tokio::spawn(async move {
        host.serve_until(handler, async {
            let _ = done.await;
        })
        .await
    });
    for bytes in [
        vec![0, 0],
        vec![0, 0, 0, 99, b'{'],
        1_048_577_u32.to_be_bytes().to_vec(),
    ] {
        let mut stream = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match serial_workbench_ipc::connect(&discovery.endpoint).await {
                    Ok(stream) => break stream,
                    Err(error) if error.code == "HOST_BUSY" => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("{}", error.code),
                }
            }
        })
        .await
        .unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.shutdown().await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(auth.current_revision().unwrap(), 0.into());
    assert_eq!(count.load(Ordering::SeqCst), 0);
    let client = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("after-invalid"),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    client.request(query(&client)).await.unwrap();
    assert_eq!(count.load(Ordering::SeqCst), 1);
    drop(client);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn fake_endpoint_cannot_obtain_client_credential_by_echoing_host_id() {
    use serial_workbench_ipc::{
        DiscoveryRecord, LocalListener,
        frame::{MAX_FRAME_BYTES, read_frame, write_frame},
        identity::random_token,
    };
    let directory = temporary_profile();
    let host = HostServer::bind(directory.path()).await.unwrap();
    let path = directory.path().join("host-v0/discovery.json");
    let mut discovery = DiscoveryRecord::read(&path).unwrap();
    // 复用 Host 已检查的 runtime；macOS 的长 profile 路径会使用短 socket 目录。
    #[cfg(unix)]
    let runtime = std::path::Path::new(&discovery.endpoint)
        .parent()
        .unwrap()
        .to_path_buf();
    #[cfg(windows)]
    let runtime = directory.path().join("host-v0");
    let mut fake = LocalListener::bind(&runtime, &uuid::Uuid::new_v4().to_string()).unwrap();
    discovery.endpoint = fake.endpoint().into();
    discovery.write(&path).unwrap();
    let fake_host_id = discovery.host_id.clone();
    let epoch = discovery.instance_epoch;
    let hostile = tokio::spawn(async move {
        let mut stream = fake.accept().await.unwrap();
        let hello = read_frame(&mut stream, MAX_FRAME_BYTES)
            .await
            .unwrap()
            .unwrap();
        write_frame(
            &mut stream,
            &WireFrame {
                request_id: hello.request_id,
                channel: IpcChannel::Control,
                body: IpcMessage::HostHello {
                    protocol_version: ProtocolVersion::V0_1,
                    host_id: fake_host_id,
                    instance_epoch: epoch,
                    server_nonce: random_token(),
                    proof: random_token(),
                },
            },
            MAX_FRAME_BYTES,
        )
        .await
        .unwrap();
        // 无 Authenticate 消息：客户端必须先检查真正的 proof。
        read_frame(&mut stream, MAX_FRAME_BYTES).await
    });
    let result = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("secret-client"),
        ClientKind::Mcp,
    ))
    .await;
    assert!(matches!(result, Err(error) if error.code == "UNAUTHENTICATED"));
    let after = tokio::time::timeout(Duration::from_secs(3), hostile)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(after, Ok(None) | Err(_)));
    drop(host);
}

#[tokio::test]
async fn queued_sensitive_event_is_denied_after_revoke_before_delivery() {
    use serial_workbench_client::read_user_control_credential;
    use serial_workbench_host::auth::{AuthService, AuthenticatedActor};
    struct RevokeBeforeDelivery {
        auth: AuthService,
        operator: AuthenticatedActor,
    }
    impl RequestHandler for RevokeBeforeDelivery {
        fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
            let RpcRequest::StateSnapshot(query) = request else {
                panic!("test query")
            };
            let cursor = Cursor {
                host_id: query.host_id.clone(),
                instance_epoch: query.instance_epoch,
                scope_id: id("private-events"),
                position: 1.into(),
            };
            let mut previous = cursor.clone();
            previous.position = 0.into();
            let mut payload = JsonObject::new();
            payload.insert(
                "secret".into(),
                JsonValue::String("must-not-be-delivered".into()),
            );
            context
                .register_subscription(id("private-subscription"))
                .unwrap();
            context
                .emit(
                    WireFrame {
                        request_id: query.request_id,
                        channel: IpcChannel::State,
                        body: IpcMessage::Delta {
                            subscription_id: id("private-subscription"),
                            delta: Box::new(Delta {
                                cursor,
                                previous_cursor: previous,
                                revision: 1.into(),
                                event_type: id("private-content"),
                                payload,
                            }),
                        },
                    },
                    "content.read",
                    query.target.clone(),
                )
                .unwrap();
            self.auth
                .revoke(
                    &self.operator,
                    RevokeParams {
                        actor_id: context.actor.id().clone(),
                        permissions: vec!["content.read".into()],
                        targets: vec![query.target],
                    },
                )
                .unwrap();
            Box::pin(async {
                Ok(RpcReply::Success {
                    ok: True,
                    result: Box::new(RpcResult::Closed(ClosedResult { closed: True })),
                }
                .into())
            })
        }
    }
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let auth = host.auth();
    let operator = auth
        .authenticate_user_control(
            &id("explicit-user"),
            &read_user_control_credential(directory.path()).unwrap(),
        )
        .unwrap();
    let (stop, done) = oneshot::channel();
    let handler = Arc::new(RevokeBeforeDelivery {
        auth: auth.clone(),
        operator: operator.clone(),
    });
    let running = tokio::spawn(async move {
        host.serve_until(handler, async {
            let _ = done.await;
        })
        .await
    });
    let client = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("content-reader"),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    let RpcRequest::StateSnapshot(request) = query(&client) else {
        unreachable!()
    };
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: id("content-reader"),
            permissions: vec!["content.read".into()],
            targets: vec![request.target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    assert!(
        matches!(client.request(RpcRequest::StateSnapshot(request)).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    let event = tokio::time::timeout(Duration::from_secs(3), client.next_event())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(event.body, IpcMessage::SubscriptionEnded { error, subscription_id } if error.code == "PERMISSION_DENIED" && subscription_id == id("private-subscription"))
    );
    drop(client);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn saturated_normal_requests_leave_reserved_cancel_capacity() {
    struct HoldingHandler {
        held: Arc<AtomicUsize>,
        release: Arc<tokio::sync::Semaphore>,
    }
    impl RequestHandler for HoldingHandler {
        fn handle(&self, _: ConnectionContext, request: RpcRequest) -> HandlerFuture {
            let release = self.release.clone();
            let held = self.held.clone();
            Box::pin(async move {
                if !matches!(request, RpcRequest::OperationCancel(_)) {
                    held.fetch_add(1, Ordering::SeqCst);
                    release.acquire().await.unwrap().forget();
                }
                Ok(RpcReply::Success {
                    ok: True,
                    result: Box::new(RpcResult::Closed(ClosedResult { closed: True })),
                }
                .into())
            })
        }
    }
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let held = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (stop, done) = oneshot::channel();
    let handler = Arc::new(HoldingHandler {
        held: held.clone(),
        release: release.clone(),
    });
    let running = tokio::spawn(async move {
        host.serve_until(handler, async {
            let _ = done.await;
        })
        .await
    });
    let client = Arc::new(
        HostClient::connect(ConnectOptions::new(
            directory.path().to_path_buf(),
            id("busy-cli"),
            ClientKind::Cli,
        ))
        .await
        .unwrap(),
    );
    let mut pending = tokio::task::JoinSet::new();
    for _ in 0..224 {
        let client = client.clone();
        pending.spawn(async move { client.request(query(&client)).await });
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while held.load(Ordering::SeqCst) != 224 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        matches!(client.request(query(&client)).await, Err(error) if error.code == "HOST_BUSY")
    );
    let RpcRequest::StateSnapshot(q) = query(&client) else {
        unreachable!()
    };
    let cancel = RpcRequest::OperationCancel(Call {
        protocol_version: q.protocol_version,
        host_id: q.host_id,
        instance_epoch: q.instance_epoch,
        actor_id: q.actor_id,
        request_id: q.request_id,
        request_context: client.attachment().request_context.clone(),
        action_id: id("operation.cancel"),
        target: q.target,
        params: q.params,
        reveal_target: q.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    });
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), client.request(cancel))
            .await
            .unwrap()
            .unwrap(),
        RpcReply::Success { .. }
    ));
    release.add_permits(224);
    while let Some(result) = pending.join_next().await {
        result.unwrap().unwrap();
    }
    drop(client);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn actual_host_process_holds_profile_and_transfers_bootstrap_only_over_pipe() {
    use std::{
        io::Read,
        process::{Child, Command, Stdio},
    };
    struct OwnedChild(Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if self.0.try_wait().ok().flatten().is_none() {
                let _ = self.0.kill();
            }
            let _ = self.0.wait();
        }
    }
    let directory = temporary_profile();
    let mut command = Command::new(env!("CARGO_BIN_EXE_serial-workbench-host"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = OwnedChild(
        command
            .arg("--profile")
            .arg(directory.path())
            .arg("--bootstrap-stdio")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut stdout = child.0.stdout.take().unwrap();
    let secret = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let mut length = [0_u8; 4];
            stdout.read_exact(&mut length).unwrap();
            let length = u32::from_be_bytes(length) as usize;
            assert!((1..=2048).contains(&length));
            let mut bytes = vec![0; length];
            stdout.read_exact(&mut bytes).unwrap();
            ContextToken::try_from(std::str::from_utf8(&bytes).unwrap()).unwrap()
        }),
    )
    .await
    .unwrap()
    .unwrap();
    let mut control = ConnectOptions::new(
        directory.path().to_path_buf(),
        id("local-control"),
        ClientKind::Cli,
    );
    control.user_control_credential = Some(secret);
    let control = HostClient::connect(control).await.unwrap();
    let first = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("plain-desktop-claim"),
        ClientKind::Desktop,
    ))
    .await
    .unwrap();
    assert_ne!(first.attachment().actor_id, control.attachment().actor_id);
    let host_id = first.attachment().host_id.clone();
    drop(first);
    drop(control);
    assert!(child.0.try_wait().unwrap().is_none());
    let second = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("another-cli"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    assert_eq!(second.attachment().host_id, host_id);
    assert!(
        matches!(second.request(query(&second)).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "INVALID_ARGUMENT")
    );
    drop(second);
}

#[tokio::test]
async fn another_actors_registration_and_grant_change_do_not_discard_reply() {
    use serial_workbench_host::auth::{AuthService, AuthenticatedActor};
    struct ChangeOtherActor {
        auth: AuthService,
        operator: AuthenticatedActor,
    }
    impl RequestHandler for ChangeOtherActor {
        fn handle(&self, _: ConnectionContext, request: RpcRequest) -> HandlerFuture {
            let RpcRequest::StateSnapshot(query) = request else {
                unreachable!()
            };
            let other = self
                .auth
                .authenticate(&id("actor-a-client"), None)
                .unwrap()
                .actor;
            self.auth
                .authorize(
                    &self.operator,
                    AuthorizeParams {
                        client_id: other.client_id().clone(),
                        permissions: vec!["content.read".into()],
                        targets: vec![query.target],
                        expires_at: None,
                    },
                )
                .unwrap();
            Box::pin(async {
                Ok(RpcReply::Success {
                    ok: True,
                    result: Box::new(RpcResult::Closed(ClosedResult { closed: True })),
                }
                .into())
            })
        }
    }
    let directory = temporary_profile();
    let mut host = HostServer::bind(directory.path()).await.unwrap();
    let auth = host.auth();
    let operator = auth
        .authenticate_user_control(
            &id("explicit-user"),
            &serial_workbench_client::read_user_control_credential(directory.path()).unwrap(),
        )
        .unwrap();
    let (stop, done) = oneshot::channel();
    let running = tokio::spawn(async move {
        host.serve_until(Arc::new(ChangeOtherActor { auth, operator }), async {
            let _ = done.await;
        })
        .await
    });
    let client = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("actor-b-client"),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    assert!(matches!(
        client.request(query(&client)).await.unwrap(),
        RpcReply::Success { .. }
    ));
    drop(client);
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

#[tokio::test]
async fn copied_profile_cannot_start_a_second_running_identity() {
    let original = temporary_profile();
    let copied = temporary_profile();
    let host = HostServer::bind(original.path()).await.unwrap();
    drop(host);
    let destination = copied.path().join("host-v0");
    serial_workbench_ipc::prepare_private_directory(&destination).unwrap();
    for entry in std::fs::read_dir(original.path().join("host-v0")).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_file() {
            serial_workbench_ipc::write_atomic(
                &destination.join(entry.file_name()),
                &std::fs::read(entry.path()).unwrap(),
            )
            .unwrap();
        }
    }
    let identity_before = std::fs::read(destination.join("identity.secret")).unwrap();
    let database_before = std::fs::read(destination.join("state.sqlite3")).unwrap();
    assert!(
        matches!(HostServer::bind(copied.path()).await, Err(error) if error.code == "HOST_ID_MISMATCH")
    );
    assert_eq!(
        std::fs::read(destination.join("identity.secret")).unwrap(),
        identity_before
    );
    assert_eq!(
        std::fs::read(destination.join("state.sqlite3")).unwrap(),
        database_before
    );
}
