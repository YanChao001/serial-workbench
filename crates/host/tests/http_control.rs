use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use serial_workbench_ipc::identity::random_token;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
    time::timeout,
};

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

fn request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap()
}

fn host_target(host_id: &Id) -> Target {
    Target {
        host_id: host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: host_id.clone(),
        session_id: None,
        session_epoch: None,
    }
}

fn query(attachment: &AttachResult, target: Target, action: &str, params: Value) -> Query {
    Query {
        protocol_version: attachment.protocol_version,
        host_id: attachment.host_id.clone(),
        instance_epoch: attachment.instance_epoch,
        actor_id: attachment.actor_id.clone(),
        request_id: request_id(),
        action_id: id(action),
        target,
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

#[track_caller]
fn success(reply: RpcReply) -> RpcResult {
    match reply {
        RpcReply::Success { result, .. } => *result,
        RpcReply::Failure { error, .. } => panic!("Host rejected HTTP request: {}", error.code),
    }
}

#[track_caller]
fn rejected(reply: RpcReply, code: &str) {
    match reply {
        RpcReply::Failure { error, .. } => assert_eq!(error.code, code),
        RpcReply::Success { .. } => panic!("Expected HTTP request to be rejected with {code}"),
    }
}

async fn post(
    endpoint: &str,
    authority: &str,
    origin: Option<&str>,
    credential: &ContextToken,
    request_id: &RequestId,
    request: &RpcRequest,
) -> (u16, RpcReply) {
    let (address, path) = endpoint
        .strip_prefix("http://")
        .unwrap()
        .split_once('/')
        .unwrap();
    assert_eq!(path, "api/rpc");
    let body = serde_json::to_string(&json!({
        "requestId": request_id,
        "request": request,
    }))
    .unwrap();
    let origin_header = origin.map_or_else(String::new, |value| format!("Origin: {value}\r\n"));
    let mut stream = TcpStream::connect(address).await.unwrap();
    let headers = format!(
        "POST /{path} HTTP/1.1\r\nHost: {authority}\r\n{origin_header}\
         Authorization: bEaReR  {}\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        credential.as_str(),
        body.len(),
    );
    timeout(Duration::from_secs(5), async {
        stream.write_all(headers.as_bytes()).await.unwrap();
        stream.write_all(body.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        let (head, payload) = response.split_once("\r\n\r\n").unwrap();
        let status = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(payload).unwrap())
    })
    .await
    .expect("HTTP request did not settle")
}

async fn rpc(
    endpoint: &str,
    credential: &ContextToken,
    request_id: &RequestId,
    request: &RpcRequest,
) -> RpcReply {
    let authority = endpoint
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let (status, reply) = post(endpoint, authority, None, credential, request_id, request).await;
    assert_eq!(status, 200);
    reply
}

#[tokio::test]
async fn real_http_listener_authenticates_an_independent_actor_and_uses_the_host_catalog() {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let profile = directory.path().join("profile");
    let mut server = HostServer::bind(&profile).await.unwrap();
    let entry = server.enable_http_control().await.unwrap();
    let expected_host = server.identity().host_id.clone();
    let host = Arc::new(Host::new(server.store(), server.auth()).await.unwrap());
    let (stop, stop_requested) = oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(host, async {
                let _ = stop_requested.await;
            })
            .await
    });

    let local = HostClient::connect(ConnectOptions::new(
        profile.clone(),
        id("http-catalog-test-local"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let user_control = read_user_control_credential(&profile).unwrap();
    let request = RpcRequest::Attach(AttachParams {
        supported_protocol_versions: vec!["0.1".into()],
        client_kind: ClientKind::Cli,
        client_id: entry.client_id.clone(),
        expected_host_id: Some(expected_host.clone()),
    });
    let authority = entry
        .url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();

    for credential in [&random_token(), &user_control] {
        let (status, reply) = post(
            &entry.url,
            authority,
            None,
            credential,
            &request_id(),
            &request,
        )
        .await;
        assert_eq!(status, 401);
        rejected(reply, "UNAUTHENTICATED");
    }
    for (host, origin) in [("localhost", None), (authority, Some("http://localhost"))] {
        let (status, _) = post(
            &entry.url,
            host,
            origin,
            &entry.credential,
            &request_id(),
            &request,
        )
        .await;
        assert_eq!(status, 403);
    }

    let RpcRequest::Attach(mut unsupported) = request.clone() else {
        unreachable!()
    };
    unsupported.supported_protocol_versions = vec!["future".into()];
    let RpcReply::Failure { error, .. } = rpc(
        &entry.url,
        &entry.credential,
        &request_id(),
        &RpcRequest::Attach(unsupported),
    )
    .await
    else {
        panic!("HTTP accepted an unsupported protocol version");
    };
    assert_eq!(error.code, "PROTOCOL_UNSUPPORTED");
    assert_eq!(
        serde_json::to_value(error.details.unwrap()).unwrap(),
        json!({"supportedProtocolVersions":["0.1"],"upgradeTarget":"0.1"}),
    );

    let RpcResult::Attach(attachment) =
        success(rpc(&entry.url, &entry.credential, &request_id(), &request).await)
    else {
        panic!("HTTP attach did not return Host attachment");
    };
    assert_eq!(attachment.host_id, expected_host);
    assert_eq!(attachment.host_id, local.attachment().host_id);
    assert_eq!(attachment.instance_epoch, local.attachment().instance_epoch);
    assert_eq!(attachment.protocol_version, ProtocolVersion::V0_1);
    assert_eq!(attachment.client_id, entry.client_id);
    assert_ne!(attachment.actor_id, local.attachment().actor_id);

    let catalog = query(
        &attachment,
        host_target(&expected_host),
        "catalog.list",
        json!({"pageSize":"100"}),
    );
    let RpcResult::Catalog(result) = success(
        rpc(
            &entry.url,
            &entry.credential,
            &catalog.request_id,
            &RpcRequest::CatalogList(catalog.clone()),
        )
        .await,
    ) else {
        panic!("HTTP catalog did not return Host catalog");
    };
    assert_eq!(result.catalog_version, local.attachment().catalog_version);
    assert!(
        result
            .items
            .iter()
            .any(|item| item.action_id == id("device.list"))
    );
    assert!(
        result
            .items
            .iter()
            .all(|item| item.action_id != id("device.open"))
    );
    assert!(result.items.iter().all(|item| !matches!(
        item.action_id.as_str(),
        "state.subscribe" | "stream.subscribe" | "stream.credit" | "subscription.close"
    )));
    let subscribe = query(
        &attachment,
        host_target(&expected_host),
        "state.subscribe",
        json!({}),
    );
    rejected(
        rpc(
            &entry.url,
            &entry.credential,
            &subscribe.request_id,
            &RpcRequest::Query(subscribe.clone()),
        )
        .await,
        "PERMISSION_DENIED",
    );

    let mut wrong_epoch = catalog.clone();
    wrong_epoch.instance_epoch = attachment.instance_epoch.checked_next().unwrap();
    rejected(
        rpc(
            &entry.url,
            &entry.credential,
            &wrong_epoch.request_id,
            &RpcRequest::CatalogList(wrong_epoch.clone()),
        )
        .await,
        "EPOCH_MISMATCH",
    );

    let mut wrong_actor = catalog;
    wrong_actor.actor_id = local.attachment().actor_id.clone();
    rejected(
        rpc(
            &entry.url,
            &entry.credential,
            &wrong_actor.request_id,
            &RpcRequest::CatalogList(wrong_actor.clone()),
        )
        .await,
        "ACTOR_MISMATCH",
    );

    drop(local);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(TcpStream::connect(authority).await.is_err());
}

fn call(attachment: &AttachResult, target: Target, action: &str, params: Value) -> Call {
    let query = query(attachment, target, action, params);
    Call {
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
    }
}

#[track_caller]
fn operation(reply: RpcReply) -> Operation {
    let RpcResult::Operation(result) = success(reply) else {
        panic!("Host operation receipt expected");
    };
    result.operation
}

fn operation_query(attachment: &AttachResult, operation_id: &Id) -> Query {
    query(
        attachment,
        Target {
            kind: ResourceKind::try_from("operation").unwrap(),
            id: operation_id.clone(),
            ..host_target(&attachment.host_id)
        },
        "operation.get",
        json!({"operationId": operation_id}),
    )
}

fn read_query(attachment: &AttachResult, target: &Target, start: U64, limit: U64) -> Query {
    query(
        attachment,
        target.clone(),
        "stream.read",
        json!({
            "sessionId": target.session_id,
            "sessionEpoch": target.session_epoch,
            "startEventSeq": start,
            "maxEvents": limit,
            "maxBytes": "262144",
        }),
    )
}

#[track_caller]
fn stream_page(reply: RpcReply) -> StreamReadResult {
    let RpcResult::StreamRead(page) = success(reply) else {
        panic!("Host stream page expected");
    };
    page
}

#[tokio::test]
async fn http_writes_once_and_pages_the_same_source_until_its_session_grant_is_revoked() {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let profile = directory.path().join("profile");
    let mut server = HostServer::bind(&profile).await.unwrap();
    let entry = server.enable_http_control().await.unwrap();
    let expected_host = server.identity().host_id.clone();
    let auth = server.auth();
    let operator = auth
        .authenticate_user_control(
            &id("http-source-user"),
            &read_user_control_credential(&profile).unwrap(),
        )
        .unwrap();
    let store = server.store();
    let host = Arc::new(Host::new(store.clone(), auth.clone()).await.unwrap());
    let (stop, stop_requested) = oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(host, async {
                let _ = stop_requested.await;
            })
            .await
    });
    let local = HostClient::connect(ConnectOptions::new(
        profile,
        id("http-source-local"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let local_attach = local.attachment();
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: local_attach.client_id.clone(),
            permissions: vec!["device.modify".into(), "content.read".into()],
            targets: vec![host_target(&expected_host)],
            expires_at: None,
        },
    )
    .unwrap();
    let opening = operation(
        local
            .request(RpcRequest::Invoke(call(
                local_attach,
                Target {
                    kind: ResourceKind::try_from("device").unwrap(),
                    id: id("virtual:echo"),
                    ..host_target(&expected_host)
                },
                "device.open",
                json!({"configuration": SerialConfiguration::default()}),
            )))
            .await
            .unwrap(),
    );
    let opened = timeout(Duration::from_secs(5), async {
        loop {
            let state = store.get(&operator, &opening.operation_id).unwrap();
            match state.state {
                OperationState::Queued
                | OperationState::Running
                | OperationState::CancelRequested => {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                _ => break state,
            }
        }
    })
    .await
    .expect("Virtual Echo open did not settle");
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("Virtual Echo open failed: {:?}", opened.error);
    };
    let target = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..host_target(&expected_host)
    };
    let attach = RpcRequest::Attach(AttachParams {
        supported_protocol_versions: vec!["0.1".into()],
        client_kind: ClientKind::Cli,
        client_id: entry.client_id.clone(),
        expected_host_id: Some(expected_host.clone()),
    });
    let RpcResult::Attach(http) =
        success(rpc(&entry.url, &entry.credential, &request_id(), &attach).await)
    else {
        panic!("HTTP attachment expected");
    };

    let tx_params = json!({"bytesBase64":"AA0K/0E=","writeWaitMs":"1000"});
    let invoke = |request: Call| async {
        let request_id = request.request_id.clone();
        rpc(
            &entry.url,
            &entry.credential,
            &request_id,
            &RpcRequest::Invoke(request),
        )
        .await
    };
    let read_cursor = || async {
        let cursor = query(&http, target.clone(), "stream.cursor", json!({}));
        let request_id = cursor.request_id.clone();
        rpc(
            &entry.url,
            &entry.credential,
            &request_id,
            &RpcRequest::Query(cursor),
        )
        .await
    };
    rejected(
        invoke(call(&http, target.clone(), "session.tx", tx_params.clone())).await,
        "PERMISSION_DENIED",
    );
    rejected(read_cursor().await, "PERMISSION_DENIED");
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: entry.client_id.clone(),
            permissions: vec!["device.modify".into(), "content.read".into()],
            targets: vec![target.clone()],
            expires_at: None,
        },
    )
    .unwrap();

    let RpcResult::Query(QueryResult::StreamCursor(before)) = success(read_cursor().await) else {
        panic!("HTTP stream cursor expected");
    };
    assert_eq!(before.target, target);
    assert_eq!(before.cursor.host_id, expected_host);
    assert_eq!(before.cursor.instance_epoch, http.instance_epoch);
    let start = before.cursor.position.checked_next().unwrap();

    let request = call(&http, target.clone(), "session.tx", tx_params.clone());
    let accepted = operation(invoke(request.clone()).await);
    let settled = timeout(Duration::from_secs(5), async {
        loop {
            let query = operation_query(&http, &accepted.operation_id);
            let request_id = query.request_id.clone();
            let state = operation(
                rpc(
                    &entry.url,
                    &entry.credential,
                    &request_id,
                    &RpcRequest::OperationGet(query),
                )
                .await,
            );
            match state.state {
                OperationState::Queued
                | OperationState::Running
                | OperationState::CancelRequested => {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                _ => break state,
            }
        }
    })
    .await
    .expect("HTTP TX did not settle separately from acceptance");
    assert_eq!(settled.state, OperationState::Succeeded);
    assert_eq!(settled.request_id, request.request_id);
    assert_eq!(settled.actor_id, http.actor_id);
    assert_eq!(operation(invoke(request.clone()).await), settled);
    let mut changed = request;
    changed.params =
        serde_json::from_value(json!({"bytesBase64":"AA==","writeWaitMs":"1000"})).unwrap();
    rejected(invoke(changed).await, "REQUEST_CONFLICT");

    let entry = &entry;
    let http = &http;
    let target_ref = &target;
    let read_http = |start: U64, limit: U64| async move {
        let query = read_query(http, target_ref, start, limit);
        let request_id = query.request_id.clone();
        rpc(
            &entry.url,
            &entry.credential,
            &request_id,
            &RpcRequest::StreamRead(query),
        )
        .await
    };
    let full = timeout(Duration::from_secs(5), async {
        loop {
            let page = stream_page(read_http(start, 100.into()).await);
            if page.events.iter().any(|event| matches!(&event.payload, RawPayload::Rx(rx) if rx.bytes_base64.as_str() == "AA0K/0E="))
                && page.events.iter().any(|event| matches!(&event.payload, RawPayload::Tx(tx) if tx.operation_id == settled.operation_id))
            {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("HTTP did not read the actual Virtual Echo RX and TX");
    assert_eq!(
        full.events
            .iter()
            .filter(|event| matches!(event.payload, RawPayload::TxIntent(_)))
            .count(),
        1,
    );
    assert!(full.events.iter().all(|event| {
        event.host_id == expected_host
            && event.instance_epoch == http.instance_epoch
            && event.session_id == target.id
            && Some(event.session_epoch) == target.session_epoch
    }));
    let first = stream_page(read_http(start, 1.into()).await);
    assert!(first.has_more);
    assert_eq!(first.events, full.events[..1]);
    let rest = stream_page(read_http(first.next_event_seq, 100.into()).await);
    assert_eq!(rest.events, full.events[1..]);
    assert_eq!(rest.next_event_seq, full.next_event_seq);

    let local_raw = local.connect_raw().await.unwrap();
    let local_read = || async {
        stream_page(
            local_raw
                .request(RpcRequest::StreamRead(read_query(
                    local_attach,
                    &target,
                    start,
                    100.into(),
                )))
                .await
                .unwrap(),
        )
    };
    assert_eq!(local_read().await, full);
    auth.revoke(
        &operator,
        RevokeParams {
            actor_id: http.actor_id.clone(),
            permissions: vec!["device.modify".into(), "content.read".into()],
            targets: vec![target.clone()],
        },
    )
    .unwrap();
    rejected(read_http(start, 100.into()).await, "PERMISSION_DENIED");
    rejected(
        invoke(call(http, target.clone(), "session.tx", tx_params)).await,
        "PERMISSION_DENIED",
    );
    assert_eq!(local_read().await, full);

    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn production_host_transfers_http_entry_only_through_an_inherited_pipe() {
    use serial_workbench_ipc::frame::read_json_frame;
    use std::process::Stdio;

    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let profile = directory.path().join("profile");
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_serial-workbench-host"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    command
        .arg("--profile")
        .arg(&profile)
        .arg("--http-control-stdio")
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    let mut redirected = command.stdout(Stdio::null()).spawn().unwrap();
    let failed = timeout(Duration::from_secs(10), redirected.wait())
        .await
        .expect("Host accepted HTTP credential transfer without an inherited pipe")
        .unwrap();
    assert!(!failed.success());

    let mut child = command.stdout(Stdio::piped()).spawn().unwrap();
    let mut pipe = child.stdout.take().unwrap();
    let entry: HttpControlEntry =
        match timeout(Duration::from_secs(10), read_json_frame(&mut pipe, 2048))
            .await
            .expect("Host did not transfer HTTP entry")
            .unwrap()
        {
            Some(entry) => entry,
            None => {
                let status = timeout(Duration::from_secs(10), child.wait())
                    .await
                    .expect("Host closed its HTTP entry pipe without exiting")
                    .unwrap();
                panic!("Host exited before sending an HTTP entry: {status}");
            }
        };
    let mut options =
        ConnectOptions::new(profile.clone(), id("http-startup-local"), ClientKind::Cli);
    options.user_control_credential = Some(read_user_control_credential(&profile).unwrap());
    let local = HostClient::connect(options).await.unwrap();
    let attachment = local.attachment();
    let RpcResult::Attach(http) = success(
        rpc(
            &entry.url,
            &entry.credential,
            &request_id(),
            &RpcRequest::Attach(AttachParams {
                supported_protocol_versions: vec!["0.1".into()],
                client_kind: ClientKind::Cli,
                client_id: entry.client_id,
                expected_host_id: Some(attachment.host_id.clone()),
            }),
        )
        .await,
    ) else {
        panic!("HTTP entry from the production Host did not attach");
    };
    assert_eq!(http.instance_epoch, attachment.instance_epoch);
    assert_ne!(http.actor_id, attachment.actor_id);

    let authority = entry
        .url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let mut stalled = TcpStream::connect(authority).await.unwrap();
    let partial = format!(
        "POST /api/rpc HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {}\r\n\
         Content-Type: application/json\r\nContent-Length: 128\r\n\r\n{{",
        entry.credential.as_str(),
    );
    stalled.write_all(partial.as_bytes()).await.unwrap();

    assert_eq!(
        operation(
            local
                .request(RpcRequest::Invoke(call(
                    attachment,
                    host_target(&attachment.host_id),
                    "host.shutdown",
                    json!({}),
                )))
                .await
                .unwrap(),
        )
        .action_id,
        id("host.shutdown"),
    );
    let status = timeout(Duration::from_secs(10), child.wait())
        .await
        .expect("Production Host did not stop")
        .unwrap();
    assert!(status.success());
    let ended = timeout(Duration::from_secs(1), stalled.read(&mut [0]))
        .await
        .unwrap();
    assert!(
        matches!(ended, Ok(0) | Err(_)),
        "Partial HTTP request received a response during shutdown"
    );
}
