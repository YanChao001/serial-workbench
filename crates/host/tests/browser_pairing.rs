use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use serial_workbench_ipc::identity::random_token;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::oneshot,
    time::timeout,
};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{Error, Message, client::IntoClientRequest},
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn client(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

fn pairing_frame(entry: &BrowserEntry, reconnect_credential: &ContextToken) -> IpcMessage {
    IpcMessage::BrowserPair {
        client_id: entry.client_id.clone(),
        pairing_code: entry.pairing_code.clone(),
        reconnect_credential: reconnect_credential.clone(),
    }
}

fn query(attachment: &AttachResult, target: Target, action: &str, params: Value) -> Query {
    Query {
        protocol_version: attachment.protocol_version,
        host_id: attachment.host_id.clone(),
        instance_epoch: attachment.instance_epoch,
        actor_id: attachment.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: client(action),
        target,
        params: serde_json::from_value(params).unwrap(),
        reveal_target: RevealTarget {
            page_id: client("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    }
}

#[track_caller]
fn success(reply: RpcReply) -> RpcResult {
    match reply {
        RpcReply::Success { result, .. } => *result,
        RpcReply::Failure { error, .. } => panic!("Host rejected test request: {}", error.code),
    }
}

fn invoke_request(client: &HostClient, action: &str, target: Target, params: Value) -> RpcRequest {
    let attachment = client.attachment();
    let query = query(attachment, target, action, params);
    let call = Call {
        protocol_version: query.protocol_version,
        host_id: query.host_id,
        instance_epoch: query.instance_epoch,
        actor_id: query.actor_id,
        request_id: query.request_id,
        request_context: attachment.request_context.clone(),
        action_id: query.action_id,
        target: query.target,
        params: query.params,
        reveal_target: query.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    };
    RpcRequest::Invoke(call)
}

async fn invoke(client: &HostClient, action: &str, target: Target, params: Value) -> Operation {
    let RpcResult::Operation(accepted) = success(
        client
            .request(invoke_request(client, action, target, params))
            .await
            .unwrap(),
    ) else {
        panic!("Missing operation receipt");
    };
    wait_operation(client, &accepted.operation.operation_id).await
}

async fn wait_operation(client: &HostClient, operation_id: &Id) -> Operation {
    let attachment = client.attachment();
    timeout(Duration::from_secs(8), async {
        loop {
            let target = Target {
                host_id: attachment.host_id.clone(),
                kind: ResourceKind::try_from("operation").unwrap(),
                id: operation_id.clone(),
                session_id: None,
                session_epoch: None,
            };
            let reply = client
                .request(RpcRequest::OperationGet(self::query(
                    attachment,
                    target,
                    "operation.get",
                    json!({"operationId": operation_id}),
                )))
                .await
                .unwrap();
            let RpcResult::Operation(receipt) = success(reply) else {
                panic!("Missing operation result");
            };
            match receipt.operation.state {
                OperationState::Queued
                | OperationState::Running
                | OperationState::CancelRequested => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                _ => return receipt.operation,
            }
        }
    })
    .await
    .unwrap()
}

async fn browser_socket(url: &str, origin: Option<&str>) -> Result<Socket, Error> {
    let endpoint = format!("ws://{}/api/ws", url.strip_prefix("http://").unwrap());
    let mut request = endpoint.into_client_request().unwrap();
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("origin", origin.parse().unwrap());
    }
    Ok(connect_async(request).await?.0)
}

async fn load_entry(url: &str, authority: &str) -> String {
    let mut http = TcpStream::connect(url.strip_prefix("http://").unwrap())
        .await
        .unwrap();
    http.write_all(
        format!("GET / HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n").as_bytes(),
    )
    .await
    .unwrap();
    let mut response = String::new();
    timeout(Duration::from_secs(5), http.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    response
}

async fn exchange(socket: &mut Socket, channel: IpcChannel, body: IpcMessage) -> IpcMessage {
    let request_id = send_message(socket, channel, body).await;
    receive_message(socket, channel, request_id).await
}

async fn send_message(socket: &mut Socket, channel: IpcChannel, body: IpcMessage) -> RequestId {
    let request_id = if let IpcMessage::Request { request } = &body
        && let RpcRequest::Query(query) = request.as_ref()
    {
        query.request_id.clone()
    } else {
        RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap()
    };
    let frame = WireFrame {
        request_id: request_id.clone(),
        channel,
        body,
    };
    socket
        .send(Message::Text(serde_json::to_string(&frame).unwrap().into()))
        .await
        .unwrap();
    request_id
}

async fn receive_message(
    socket: &mut Socket,
    channel: IpcChannel,
    request_id: RequestId,
) -> IpcMessage {
    let received = timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let frame: WireFrame = serde_json::from_str(received.to_text().unwrap()).unwrap();
    assert_eq!(frame.request_id, request_id);
    assert_eq!(frame.channel, channel);
    frame.body
}

fn request(request: RpcRequest) -> IpcMessage {
    IpcMessage::Request {
        request: Box::new(request),
    }
}

#[track_caller]
fn reply(body: IpcMessage) -> RpcReply {
    match body {
        IpcMessage::Reply { reply } => *reply,
        other => panic!("Unexpected browser response: {other:?}"),
    }
}

async fn read_takeover(operator: &HostClient) -> Option<BrowserTakeoverRequest> {
    let attachment = operator.attachment();
    let target = Target {
        host_id: attachment.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: attachment.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let RpcResult::Snapshot(snapshot) = success(
        operator
            .request(RpcRequest::StateSnapshot(query(
                attachment,
                target,
                "state.snapshot",
                json!({"scopeId":"host.activity"}),
            )))
            .await
            .unwrap(),
    ) else {
        panic!("Missing activity snapshot");
    };
    let snapshot: ActivitySnapshot =
        serde_json::from_value(serde_json::to_value(snapshot.state).unwrap()).unwrap();
    snapshot.pending_takeover
}

async fn wait_takeover(operator: &HostClient, present: bool) -> Option<BrowserTakeoverRequest> {
    timeout(Duration::from_secs(8), async {
        loop {
            let state = read_takeover(operator).await;
            if state.is_some() == present {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn browser_takeover_requires_live_local_approval_for_the_named_actor_and_port() {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let assets = directory.path().join("web");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "<html><head></head></html>").unwrap();
    let profile = directory.path().join("profile");
    let mut server = HostServer::bind(&profile).await.unwrap();
    let auth = server.auth();
    let host = Host::new(server.store(), auth.clone()).await.unwrap();
    let (stop, done) = oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let operator_id = client("desktop-takeover-test");
    let credential = read_user_control_credential(&profile).unwrap();
    let user = auth
        .authenticate_user_control(&operator_id, &credential)
        .unwrap();
    let mut options = ConnectOptions::new(profile.clone(), operator_id, ClientKind::Desktop);
    options.user_control_credential = Some(credential);
    let operator = HostClient::connect(options).await.unwrap();
    let host_id = operator.attachment().host_id.clone();
    let host_target = Target {
        host_id: host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: host_id,
        session_id: None,
        session_epoch: None,
    };
    let mut agents = Vec::new();
    for name in ["bench-primary", "bench-secondary"] {
        let id = client(name);
        let agent = HostClient::connect(ConnectOptions::new(
            profile.clone(),
            id.clone(),
            ClientKind::Mcp,
        ))
        .await
        .unwrap();
        auth.authorize(
            &user,
            AuthorizeParams {
                client_id: id,
                permissions: vec!["device.modify".into(), "content.read".into()],
                targets: vec![host_target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        agents.push(agent);
    }
    let [primary, secondary] = agents.as_slice() else {
        unreachable!()
    };
    let device = Target {
        kind: ResourceKind::try_from("device").unwrap(),
        id: client("virtual:echo"),
        ..host_target.clone()
    };
    let opened = invoke(
        primary,
        "device.open",
        device,
        json!({"configuration":SerialConfiguration::default()}),
    )
    .await;
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("Virtual session did not open");
    };
    let target = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..host_target
    };
    let pair = RpcRequest::BrowserAccess(BrowserAccessParams::Pair {
        assets_dir: assets.into_os_string().into_string().unwrap(),
        mode: BrowserAccessMode::Operate,
    });
    let RpcResult::BrowserAccess(BrowserAccessResult {
        browser_access: BrowserAccessState::Pairing { entry, .. },
    }) = success(operator.request(pair).await.unwrap())
    else {
        panic!("Browser listener did not pair");
    };
    let mut browser = browser_socket(&entry.url, Some(&entry.url)).await.unwrap();
    let reconnect = random_token();
    let IpcMessage::Authenticated {
        credential: None, ..
    } = exchange(
        &mut browser,
        IpcChannel::Control,
        pairing_frame(&entry, &reconnect),
    )
    .await
    else {
        panic!("Browser pairing did not bind the reconnect credential");
    };
    let request_for = || {
        RpcRequest::BrowserTakeover(BrowserTakeoverParams::Request {
            target: target.clone(),
            actor_id: primary.attachment().actor_id.clone(),
        })
    };
    let decide = |key: &Id, approve| {
        RpcRequest::BrowserTakeover(BrowserTakeoverParams::Decide {
            takeover_id: key.clone(),
            approve,
        })
    };
    assert!(
        matches!(primary.request(request_for()).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    let waiting = send_message(&mut browser, IpcChannel::Control, request(request_for())).await;
    let pending = wait_takeover(&operator, true).await.unwrap();
    assert_eq!(pending.target, target);
    assert_eq!(pending.client_id, client("bench-primary"));
    assert_eq!(pending.device_id, client("virtual:echo"));
    let forged = reply(
        exchange(
            &mut browser,
            IpcChannel::Control,
            request(decide(&pending.takeover_id, true)),
        )
        .await,
    );
    assert!(matches!(forged, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"));
    let refused = success(
        operator
            .request(decide(&pending.takeover_id, false))
            .await
            .unwrap(),
    );
    assert!(matches!(refused, RpcResult::Closed(_)));
    assert!(
        matches!(reply(receive_message(&mut browser, IpcChannel::Control, waiting).await), RpcReply::Failure { error, .. } if error.code == "TAKEOVER_DECLINED")
    );
    let tx = json!({"bytesBase64":"QVQ=", "writeWaitMs":"1000"});
    assert_eq!(
        invoke(primary, "session.tx", target.clone(), tx.clone())
            .await
            .state,
        OperationState::Succeeded
    );

    let _closed = send_message(&mut browser, IpcChannel::Control, request(request_for())).await;
    let pending = wait_takeover(&operator, true).await.unwrap();
    browser.close(None).await.unwrap();
    wait_takeover(&operator, false).await;
    assert!(
        matches!(operator.request(decide(&pending.takeover_id, true)).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "NOT_FOUND")
    );

    let mut browser = browser_socket(&entry.url, Some(&entry.url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut browser,
            IpcChannel::Control,
            IpcMessage::Authenticate {
                client_id: entry.client_id.clone(),
                credential: Some(reconnect)
            }
        )
        .await,
        IpcMessage::Authenticated { .. }
    ));
    let attached = exchange(
        &mut browser,
        IpcChannel::Control,
        request(RpcRequest::Attach(AttachParams {
            supported_protocol_versions: vec!["0.1".into()],
            client_kind: ClientKind::Browser,
            client_id: entry.client_id.clone(),
            expected_host_id: Some(target.host_id.clone()),
        })),
    )
    .await;
    let RpcResult::Attach(attached) = success(reply(attached)) else {
        panic!("Browser did not attach after reconnect");
    };
    let waiting = send_message(&mut browser, IpcChannel::Control, request(request_for())).await;
    let pending = wait_takeover(&operator, true).await.unwrap();
    auth.revoke(
        &user,
        RevokeParams {
            actor_id: attached.actor_id,
            permissions: vec!["device.modify".into()],
            targets: vec![target.clone()],
        },
    )
    .unwrap();
    wait_takeover(&operator, false).await;
    assert!(
        matches!(reply(receive_message(&mut browser, IpcChannel::Control, waiting).await),
        RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    assert!(
        matches!(operator.request(decide(&pending.takeover_id, true)).await.unwrap(),
        RpcReply::Failure { error, .. } if error.code == "NOT_FOUND")
    );
    auth.authorize(
        &user,
        AuthorizeParams {
            client_id: entry.client_id,
            permissions: vec!["device.modify".into()],
            targets: vec![target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let waiting = send_message(&mut browser, IpcChannel::Control, request(request_for())).await;
    let pending = wait_takeover(&operator, true).await.unwrap();
    let RpcResult::Operation(approved) = success(
        operator
            .request(decide(&pending.takeover_id, true))
            .await
            .unwrap(),
    ) else {
        panic!("Local approval did not enqueue an operation");
    };
    let RpcResult::Operation(observed) = success(reply(
        receive_message(&mut browser, IpcChannel::Control, waiting).await,
    )) else {
        panic!("Browser did not receive the accepted operation");
    };
    assert_eq!(
        approved.operation.operation_id,
        observed.operation.operation_id
    );
    assert_eq!(
        wait_operation(&operator, &observed.operation.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    assert!(
        matches!(operator.request(decide(&pending.takeover_id, true)).await.unwrap(), RpcReply::Failure { error, .. } if error.code == "NOT_FOUND")
    );
    let check = RpcRequest::Query(query(
        primary.attachment(),
        target.clone(),
        "action.check",
        json!({"actionId":"session.tx","params":tx}),
    ));
    assert!(matches!(
        success(primary.request(check).await.unwrap()),
        RpcResult::Query(QueryResult::ActionCheck(ActionCheckResult {
            allowed: false,
            ..
        }))
    ));
    let denied = invoke_request(
        primary,
        "session.tx",
        target.clone(),
        json!({
            "bytesBase64":"REVOSUVE", "writeWaitMs":"1000"
        }),
    );
    assert!(
        matches!(primary.request(denied).await.unwrap(), RpcReply::Failure { error, .. }
        if error.code == "PERMISSION_DENIED")
    );
    assert_eq!(
        invoke(secondary, "session.tx", target, tx).await.state,
        OperationState::Succeeded
    );
    stop.send(()).unwrap();
    timeout(Duration::from_secs(8), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn explicit_browser_pairing_attaches_to_the_live_host_and_owns_its_raw_connection() {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let assets = directory.path().join("web");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(
        assets.join("index.html"),
        "<!doctype html><head></head><body>Workbench</body>",
    )
    .unwrap();
    let asset_dir = assets.join("assets");
    std::fs::create_dir(&asset_dir).unwrap();
    let download_size = 8 * 1024 * 1024;
    std::fs::File::create(asset_dir.join("stalled.bin"))
        .unwrap()
        .set_len(download_size)
        .unwrap();
    let profile = directory.path().join("profile");
    let mut server = HostServer::bind(&profile).await.unwrap();
    let local_control =
        serial_workbench_ipc::read_secret(&profile.join("host-v0/user-control.secret"))
            .unwrap()
            .unwrap();
    let local_control =
        ContextToken::try_from(std::str::from_utf8(&local_control).unwrap()).unwrap();
    let host_id = server.identity().host_id.clone();
    let entry = server.enable_browser(&assets).await.unwrap();
    let host = Arc::new(Host::new(server.store(), server.auth()).await.unwrap());
    let (stop, stop_requested) = oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(host, async {
                let _ = stop_requested.await;
            })
            .await
    });
    let url = &entry.url;
    assert!(url.starts_with("http://127.0.0.1:"));
    let authority = url.strip_prefix("http://").unwrap();
    let client_id = entry.client_id.clone();
    let same_origin_page = load_entry(url, authority).await;
    assert!(same_origin_page.starts_with("HTTP/1.1 200 "));
    assert!(same_origin_page.contains("name=\"serial-workbench-host\" content=\"browser\""));
    assert!(same_origin_page.contains(&format!(
        "name=\"serial-workbench-browser-id\" content=\"{}\"",
        client_id.as_str()
    )));
    let rejected_page = load_entry(url, "other.example").await;
    assert!(rejected_page.starts_with("HTTP/1.1 403 "));
    for rejected in [None, Some("https://unpaired.example")] {
        let Err(Error::Http(response)) = browser_socket(url, rejected).await else {
            panic!("cross-origin or origin-less handshake was unexpectedly accepted");
        };
        assert_eq!(response.status(), 403);
    }
    let mut privileged = browser_socket(url, Some(url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut privileged,
            IpcChannel::Control,
            IpcMessage::AuthenticateUserControl {
                client_id: client("browser-user-control"),
                credential: local_control,
            },
        )
        .await,
        IpcMessage::Error { error } if error.code == "UNAUTHENTICATED"
    ));

    let mut wrong_identity = browser_socket(url, Some(url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut wrong_identity,
            IpcChannel::Control,
            IpcMessage::BrowserPair {
                client_id: client("desktop"),
                pairing_code: entry.pairing_code.clone(),
                reconnect_credential: random_token(),
            },
        )
        .await,
        IpcMessage::Error { error } if error.code == "UNAUTHENTICATED"
    ));

    // 重连凭据由浏览器预先生成，且服务端回包不包含该值。
    let reconnect_proof = random_token();

    let mut control = browser_socket(url, Some(url)).await.unwrap();
    let reply = exchange(
        &mut control,
        IpcChannel::Control,
        pairing_frame(&entry, &reconnect_proof),
    )
    .await;
    let IpcMessage::Authenticated {
        credential: None,
        raw_attach_token,
    } = reply
    else {
        panic!("local pairing did not create an ordinary browser credential");
    };
    let unsupported = exchange(
        &mut control,
        IpcChannel::Control,
        request(RpcRequest::Attach(AttachParams {
            supported_protocol_versions: vec!["future".into()],
            client_kind: ClientKind::Browser,
            client_id: client_id.clone(),
            expected_host_id: Some(host_id.clone()),
        })),
    )
    .await;
    let RpcReply::Failure { error, .. } = self::reply(unsupported) else {
        panic!("Host accepted an unsupported protocol version");
    };
    assert_eq!(error.code, "PROTOCOL_UNSUPPORTED");
    assert_eq!(
        serde_json::to_value(&error.details).unwrap(),
        json!({
            "supportedProtocolVersions": ["0.1"],
            "upgradeTarget": "0.1",
        })
    );
    let reply = exchange(
        &mut control,
        IpcChannel::Control,
        IpcMessage::Request {
            request: Box::new(RpcRequest::Attach(AttachParams {
                supported_protocol_versions: vec!["0.1".into()],
                client_kind: ClientKind::Browser,
                client_id: client_id.clone(),
                expected_host_id: Some(host_id.clone()),
            })),
        },
    )
    .await;
    let IpcMessage::Reply { reply } = reply else {
        panic!("attach did not reach Host");
    };
    let RpcReply::Success { result, .. } = *reply else {
        panic!("Host rejected the browser attachment");
    };
    let RpcResult::Attach(attached) = *result else {
        panic!("missing Host attachment");
    };
    assert_eq!(attached.client_id, client_id);
    assert_eq!(attached.host_id, host_id);
    assert_eq!(attached.protocol_version, ProtocolVersion::V0_1);

    for rejected in [
        pairing_frame(&entry, &random_token()),
        IpcMessage::Authenticate {
            client_id: client_id.clone(),
            credential: Some(entry.pairing_code.clone()),
        },
    ] {
        let mut replay = browser_socket(url, Some(url)).await.unwrap();
        assert!(matches!(
            exchange(&mut replay, IpcChannel::Control, rejected).await,
            IpcMessage::Error { error } if error.code == "UNAUTHENTICATED"
        ));
    }

    let mut raw = browser_socket(url, Some(url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut raw,
            IpcChannel::Raw,
            IpcMessage::RawAttach {
                token: raw_attach_token,
            }
        )
        .await,
        IpcMessage::RawAttached {}
    ));
    control.close(None).await.unwrap();
    let ended = timeout(Duration::from_secs(5), raw.next()).await.unwrap();
    assert!(ended.is_none() || matches!(ended, Some(Err(_) | Ok(Message::Close(_)))));

    let mut reconnect = browser_socket(url, Some(url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut reconnect,
            IpcChannel::Control,
            IpcMessage::Authenticate {
                client_id: client_id.clone(),
                credential: Some(reconnect_proof),
            }
        )
        .await,
        IpcMessage::Authenticated {
            credential: None,
            ..
        }
    ));

    let mut stalled = BufReader::new(TcpStream::connect(authority).await.unwrap());
    stalled
        .get_mut()
        .write_all(
            format!("GET /assets/stalled.bin HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let headers = timeout(Duration::from_secs(5), async {
        let mut headers = String::new();
        while !headers.ends_with("\r\n\r\n") {
            assert_ne!(stalled.read_line(&mut headers).await.unwrap(), 0);
        }
        headers
    })
    .await
    .unwrap();
    assert!(headers.starts_with("HTTP/1.1 200 "));
    assert!(headers.contains(&format!("content-length: {download_size}\r\n")));
    // Leave the download unread while the Host closes the listener and the active sockets.
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(stalled);

    let mut restarted = HostServer::bind(&profile).await.unwrap();
    assert_eq!(
        restarted.enable_browser(&assets).await.unwrap().client_id,
        client_id
    );
}

#[tokio::test]
async fn local_user_control_revokes_browser_access_without_closing_the_serial_session() {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let profile = directory.path().join("profile");
    let assets = directory.path().join("web");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "<html><head></head></html>").unwrap();
    let mut server = HostServer::bind(&profile).await.unwrap();
    let auth = server.auth();
    let host = Arc::new(Host::new(server.store(), auth.clone()).await.unwrap());
    let (stop, stop_requested) = oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(host, async {
                let _ = stop_requested.await;
            })
            .await
    });

    let client_id = client("desktop-pairing-test");
    let ordinary = HostClient::connect(ConnectOptions::new(
        profile.clone(),
        client_id.clone(),
        ClientKind::Desktop,
    ))
    .await
    .unwrap();
    let user_control = read_user_control_credential(&profile).unwrap();
    let operator_actor = auth
        .authenticate_user_control(&client_id, &user_control)
        .unwrap();
    let mut options = ConnectOptions::new(profile, client_id.clone(), ClientKind::Desktop);
    options.user_control_credential = Some(user_control);
    let operator = HostClient::connect(options).await.unwrap();
    let desktop_target = Target {
        host_id: ordinary.attachment().host_id.clone(),
        id: ordinary.attachment().host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &operator_actor,
        AuthorizeParams {
            client_id,
            permissions: vec!["device.modify".into(), "content.read".into()],
            targets: vec![desktop_target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let device = Target {
        kind: ResourceKind::try_from("device").unwrap(),
        id: client("virtual:echo"),
        ..desktop_target
    };
    let opened = invoke(
        &ordinary,
        "device.open",
        device.clone(),
        json!({"configuration": SerialConfiguration::default()}),
    )
    .await;
    let Some(ActionResult::Opened(session)) = opened.result else {
        panic!("Virtual port did not open");
    };
    let session_target = Target {
        host_id: device.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: session.session_id.clone(),
        session_id: Some(session.session_id),
        session_epoch: Some(session.session_epoch),
    };
    let pair = RpcRequest::BrowserAccess(BrowserAccessParams::Pair {
        assets_dir: assets.into_os_string().into_string().unwrap(),
        mode: BrowserAccessMode::ReadOnly,
    });
    assert!(
        matches!(ordinary.request(pair.clone()).await.unwrap(), RpcReply::Failure { error, .. }
        if error.code == "PERMISSION_DENIED")
    );
    let RpcResult::BrowserAccess(BrowserAccessResult {
        browser_access:
            BrowserAccessState::Pairing {
                entry,
                mode: BrowserAccessMode::ReadOnly,
            },
    }) = success(operator.request(pair).await.unwrap())
    else {
        panic!("No browser pairing was issued");
    };
    let mut control = browser_socket(&entry.url, Some(&entry.url)).await.unwrap();
    let IpcMessage::Authenticated {
        raw_attach_token, ..
    } = exchange(
        &mut control,
        IpcChannel::Control,
        pairing_frame(&entry, &random_token()),
    )
    .await
    else {
        panic!("Browser did not authenticate");
    };
    let IpcMessage::Reply { reply } = exchange(
        &mut control,
        IpcChannel::Control,
        IpcMessage::Request {
            request: Box::new(RpcRequest::Attach(AttachParams {
                supported_protocol_versions: vec!["0.1".into()],
                client_kind: ClientKind::Browser,
                client_id: entry.client_id,
                expected_host_id: Some(device.host_id.clone()),
            })),
        },
    )
    .await
    else {
        panic!("Browser attach was not answered");
    };
    let RpcResult::Attach(attachment) = success(*reply) else {
        panic!("Browser attach was not confirmed");
    };
    let mut raw = browser_socket(&entry.url, Some(&entry.url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut raw,
            IpcChannel::Raw,
            IpcMessage::RawAttach {
                token: raw_attach_token
            }
        )
        .await,
        IpcMessage::RawAttached {}
    ));
    let cursor = query(
        &attachment,
        session_target.clone(),
        "stream.cursor",
        json!({}),
    );
    let IpcMessage::Reply { reply } = exchange(
        &mut raw,
        IpcChannel::Raw,
        IpcMessage::Request {
            request: Box::new(RpcRequest::Query(cursor)),
        },
    )
    .await
    else {
        panic!("Browser cursor request was not answered");
    };
    let RpcResult::Query(QueryResult::StreamCursor(result)) = success(*reply) else {
        panic!("Browser cursor was not returned");
    };
    assert_eq!(result.target, session_target);
    assert_eq!(result.cursor.host_id, attachment.host_id);
    assert_eq!(result.cursor.instance_epoch, attachment.instance_epoch);
    let subscribe = query(
        &attachment,
        session_target.clone(),
        "stream.subscribe",
        json!({
            "scopeId": result.cursor.scope_id,
            "after": Cursor { scope_id: client("foreign-scope"), ..result.cursor },
            "queueBytes": "65536",
            "initialCreditBytes": "0",
            "overflowPolicy": "drop_with_gap",
        }),
    );
    let rejected = exchange(
        &mut raw,
        IpcChannel::Raw,
        request(RpcRequest::Query(subscribe)),
    )
    .await;
    let IpcMessage::Reply { reply } = rejected else {
        panic!("Browser subscription rejection was not returned");
    };
    assert!(matches!(
        *reply,
        RpcReply::Failure { error, .. } if error.code == "INVALID_ARGUMENT"
    ));
    let write_check = query(
        &attachment,
        session_target.clone(),
        "action.check",
        json!({
            "actionId": "session.tx",
            "params": {"bytesBase64": "QVQ=", "writeWaitMs": "1000"}
        }),
    );
    let IpcMessage::Reply { reply } = exchange(
        &mut control,
        IpcChannel::Control,
        IpcMessage::Request {
            request: Box::new(RpcRequest::Query(write_check)),
        },
    )
    .await
    else {
        panic!("Browser permission request was not answered");
    };
    assert!(matches!(
        success(*reply),
        RpcResult::Query(QueryResult::ActionCheck(ActionCheckResult {
            allowed: false,
            ..
        }))
    ));
    let blocked = exchange(
        &mut control,
        IpcChannel::Control,
        IpcMessage::Request {
            request: Box::new(RpcRequest::BrowserAccess(BrowserAccessParams::Revoke {})),
        },
    )
    .await;
    assert!(
        matches!(blocked, IpcMessage::Reply { reply } if matches!(reply.as_ref(),
        RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"))
    );
    let revoke = RpcRequest::BrowserAccess(BrowserAccessParams::Revoke {});
    assert!(matches!(
        success(operator.request(revoke).await.unwrap()),
        RpcResult::BrowserAccess(BrowserAccessResult {
            browser_access: BrowserAccessState::Disabled {}
        })
    ));
    for socket in [&mut control, &mut raw] {
        let ended = timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap();
        assert!(ended.is_none() || matches!(ended, Some(Err(_) | Ok(Message::Close(_)))));
    }
    let after_revoke = invoke(
        &ordinary,
        "session.tx",
        session_target,
        json!({"bytesBase64":"QVQ=", "writeWaitMs":"1000"}),
    )
    .await;
    assert_eq!(after_revoke.state, OperationState::Succeeded);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
