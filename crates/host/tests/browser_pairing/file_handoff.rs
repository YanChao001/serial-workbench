use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest as _, Sha256};

async fn handoff(socket: &mut Socket, params: BrowserFileHandoffParams) -> RpcReply {
    reply(
        exchange(
            socket,
            IpcChannel::Control,
            request(RpcRequest::BrowserFileHandoff(params)),
        )
        .await,
    )
}

fn progress(response: RpcReply) -> BrowserFileHandoffProgress {
    let RpcResult::BrowserFileHandoff(value) = success(response) else {
        panic!("Missing browser file handoff receipt");
    };
    value
}

fn operation(response: RpcReply) -> Operation {
    let RpcResult::Operation(value) = success(response) else {
        panic!("Missing browser file operation");
    };
    value.operation
}

#[tokio::test]
async fn browser_file_upload_sends_the_selected_range_once_and_returns_quota_after_revocation() {
    use BrowserFileHandoffParams as Upload;

    let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let profile = root.path().join("profile");
    let assets = root.path().join("web");
    std::fs::create_dir(&assets).unwrap();
    std::fs::write(assets.join("index.html"), "<html><head></head></html>").unwrap();
    let mut server = HostServer::bind(&profile).await.unwrap();
    let auth = server.auth();
    let host = Arc::new(Host::new(server.store(), auth.clone()).await.unwrap());
    let (stop, stopped) = oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(host, async {
                let _ = stopped.await;
            })
            .await
    });

    let desktop_id = client("desktop-file-handoff-test");
    let local = HostClient::connect(ConnectOptions::new(
        profile.clone(),
        desktop_id.clone(),
        ClientKind::Desktop,
    ))
    .await
    .unwrap();
    let credential = read_user_control_credential(&profile).unwrap();
    let user = auth
        .authenticate_user_control(&desktop_id, &credential)
        .unwrap();
    let mut options = ConnectOptions::new(profile.clone(), desktop_id.clone(), ClientKind::Desktop);
    options.user_control_credential = Some(credential);
    let operator = HostClient::connect(options).await.unwrap();
    let host_id = local.attachment().host_id.clone();
    let host_target = Target {
        host_id: host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &user,
        AuthorizeParams {
            client_id: desktop_id,
            permissions: vec!["device.modify".into(), "content.read".into()],
            targets: vec![host_target],
            expires_at: None,
        },
    )
    .unwrap();
    let opened = invoke(
        &local,
        "device.open",
        Target {
            host_id: host_id.clone(),
            kind: ResourceKind::try_from("device").unwrap(),
            id: client("virtual:echo"),
            session_id: None,
            session_epoch: None,
        },
        json!({"configuration": SerialConfiguration::default()}),
    )
    .await;
    let Some(ActionResult::Opened(session)) = opened.result else {
        panic!("Virtual device failed to open");
    };
    let target = Target {
        host_id,
        kind: ResourceKind::try_from("session").unwrap(),
        id: session.session_id.clone(),
        session_id: Some(session.session_id),
        session_epoch: Some(session.session_epoch),
    };
    let begin = |size: u64| Upload::Begin {
        target: target.clone(),
        length: size.into(),
    };
    let append = |upload_id: &Id, offset: u64, data: &[u8]| Upload::Append {
        upload_id: upload_id.clone(),
        offset: offset.into(),
        bytes_base64: Bytes::try_from(STANDARD.encode(data).as_str()).unwrap(),
    };
    let pair = || {
        RpcRequest::BrowserAccess(BrowserAccessParams::Pair {
            assets_dir: assets.to_str().unwrap().into(),
            mode: BrowserAccessMode::Operate,
        })
    };
    assert!(matches!(
        local.request(RpcRequest::BrowserFileHandoff(begin(1))).await.unwrap(),
        RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"
    ));

    let RpcResult::BrowserAccess(BrowserAccessResult {
        browser_access: BrowserAccessState::Pairing { entry, .. },
    }) = success(operator.request(pair()).await.unwrap())
    else {
        panic!("Missing browser pairing entry")
    };
    let reconnect = random_token();
    let mut browser = browser_socket(&entry.url, Some(&entry.url)).await.unwrap();
    let IpcMessage::Authenticated {
        raw_attach_token, ..
    } = exchange(
        &mut browser,
        IpcChannel::Control,
        pairing_frame(&entry, &reconnect),
    )
    .await
    else {
        panic!("Browser was not authenticated")
    };
    let RpcResult::Attach(attachment) = success(reply(
        exchange(
            &mut browser,
            IpcChannel::Control,
            request(RpcRequest::Attach(AttachParams {
                supported_protocol_versions: vec![ProtocolVersion::CURRENT.as_wire().into()],
                client_kind: ClientKind::Browser,
                client_id: entry.client_id.clone(),
                expected_host_id: Some(target.host_id.clone()),
            })),
        )
        .await,
    )) else {
        panic!("Missing browser attachment")
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
    assert!(matches!(
        reply(exchange(&mut raw, IpcChannel::Raw, request(RpcRequest::BrowserFileHandoff(begin(1)))).await),
        RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"
    ));
    let mut other = browser_socket(&entry.url, Some(&entry.url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut other,
            IpcChannel::Control,
            IpcMessage::Authenticate {
                client_id: entry.client_id.clone(),
                credential: Some(reconnect.clone()),
            }
        )
        .await,
        IpcMessage::Authenticated { .. }
    ));
    let submit = |upload_id: &Id, offset: u64, length: u64| {
        let q = query(
            &attachment,
            target.clone(),
            "transfer.file",
            json!({
                "sourceRef": {"hostId": target.host_id, "kind": "file", "id": upload_id, "revision": "1"},
                "offset": offset.to_string(), "length": length.to_string(),
                "chunkBytes": "1", "bytesPerSecond": "1024", "interChunkMs": "100",
                "writeWaitMs": "1000"
            }),
        );
        Upload::Submit {
            upload_id: upload_id.clone(),
            call: Box::new(Call {
                protocol_version: q.protocol_version,
                host_id: q.host_id,
                instance_epoch: q.instance_epoch,
                actor_id: q.actor_id,
                request_id: q.request_id,
                request_context: attachment.request_context.clone(),
                action_id: q.action_id,
                target: q.target,
                params: q.params,
                reveal_target: q.reveal_target,
                expected_revision: None,
                lease_id: None,
                execution_mode: Some(ExecutionMode::Independent),
            }),
        }
    };
    let received = progress(handoff(&mut browser, begin(4)).await);
    assert_eq!(received.received_bytes.get(), 0);
    let unsealed = handoff(&mut browser, submit(&received.upload_id, 1, 2)).await;
    assert!(
        matches!(&unsealed, RpcReply::Failure { error, .. } if error.code == "INVALID_ARGUMENT"),
        "{unsealed:?}",
    );
    assert!(matches!(
        handoff(&mut other, append(&received.upload_id, 0, &[0, 255])).await,
        RpcReply::Failure { error, .. } if error.code == "NOT_FOUND"
    ));
    let partial = progress(handoff(&mut browser, append(&received.upload_id, 0, &[0, 255])).await);
    assert_eq!(partial.received_bytes.get(), 2);
    assert!(partial.sealed_fingerprint.is_none());
    let full = progress(handoff(&mut browser, append(&received.upload_id, 2, &[36, 123])).await);
    assert_eq!(full.received_bytes.get(), 4);
    let sealed = progress(
        handoff(
            &mut browser,
            Upload::Seal {
                upload_id: received.upload_id.clone(),
            },
        )
        .await,
    );
    assert_eq!(
        sealed.sealed_fingerprint.unwrap().as_str(),
        format!("{:x}", Sha256::digest([0, 255, 36, 123]))
    );
    assert!(matches!(
        handoff(&mut browser, submit(&received.upload_id, 3, 2)).await,
        RpcReply::Failure { error, .. } if error.code == "INVALID_ARGUMENT"
    ));
    let confirmed = submit(&received.upload_id, 1, 2);
    assert!(matches!(
        handoff(&mut other, confirmed.clone()).await,
        RpcReply::Failure { error, .. } if error.code == "NOT_FOUND"
    ));
    let accepted = operation(handoff(&mut browser, confirmed.clone()).await);
    browser.close(None).await.unwrap();
    let finished = timeout(Duration::from_secs(8), async {
        loop {
            let state = operation(handoff(&mut other, confirmed.clone()).await);
            assert_eq!(state.operation_id, accepted.operation_id);
            if !matches!(
                state.state,
                OperationState::Queued | OperationState::Running
            ) {
                break state;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Browser file transfer did not finish");
    assert_eq!(finished.state, OperationState::Succeeded, "{finished:?}");
    let Some(ActionResult::FileTransfer(result)) = finished.result else {
        panic!("Missing browser file transfer result");
    };
    assert_eq!(result.accepted.get(), 2);
    assert_eq!(result.unknown.get(), 0);
    let echo_reader = local.connect_raw().await.unwrap();
    let read = RpcRequest::StreamRead(query(
        local.attachment(),
        target.clone(),
        "stream.read",
        json!({
            "sessionId": target.id, "sessionEpoch": target.session_epoch,
            "startEventSeq": "1", "maxEvents": "100", "maxBytes": "262144"
        }),
    ));
    let echo = timeout(Duration::from_secs(5), async {
        loop {
            let RpcResult::StreamRead(page) =
                success(echo_reader.request(read.clone()).await.unwrap())
            else {
                panic!("Missing Virtual Echo stream");
            };
            let bytes: Vec<_> = page
                .events
                .into_iter()
                .filter_map(|event| {
                    let RawPayload::Rx(value) = event.payload else {
                        return None;
                    };
                    Some(STANDARD.decode(value.bytes_base64.as_str()).unwrap())
                })
                .flatten()
                .collect();
            if bytes.len() >= 2 {
                break bytes;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Virtual Echo did not receive the staged bytes");
    assert_eq!(echo, [255, 36]);
    let mut conflicting = confirmed.clone();
    if let Upload::Submit { call, .. } = &mut conflicting {
        call.params
            .insert("offset".into(), JsonValue::String("0".into()));
    }
    assert!(matches!(
        handoff(&mut other, conflicting).await,
        RpcReply::Failure { error, .. } if error.code == "REQUEST_CONFLICT"
    ));
    let mut browser = browser_socket(&entry.url, Some(&entry.url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut browser,
            IpcChannel::Control,
            IpcMessage::Authenticate {
                client_id: entry.client_id.clone(),
                credential: Some(reconnect),
            }
        )
        .await,
        IpcMessage::Authenticated { .. }
    ));
    assert!(matches!(
        handoff(&mut browser, submit(&received.upload_id, 1, 2)).await,
        RpcReply::Failure { error, .. } if error.code == "NOT_FOUND"
    ));
    let discarded = progress(handoff(&mut browser, begin(2)).await).upload_id;
    progress(handoff(&mut browser, append(&discarded, 0, &[1, 2])).await);
    progress(
        handoff(
            &mut browser,
            Upload::Seal {
                upload_id: discarded.clone(),
            },
        )
        .await,
    );
    assert!(matches!(
        success(
            handoff(
                &mut browser,
                Upload::Discard {
                    upload_id: discarded.clone()
                }
            )
            .await
        ),
        RpcResult::Closed(_)
    ));
    assert!(matches!(
        handoff(&mut browser, submit(&discarded, 0, 2)).await,
        RpcReply::Failure { error, .. } if error.code == "NOT_FOUND"
    ));

    let outdated = progress(handoff(&mut browser, begin(4)).await);
    progress(
        handoff(
            &mut browser,
            append(&outdated.upload_id, 0, &[0, 255, 36, 123]),
        )
        .await,
    );
    progress(
        handoff(
            &mut browser,
            Upload::Seal {
                upload_id: outdated.upload_id.clone(),
            },
        )
        .await,
    );
    auth.revoke(
        &user,
        RevokeParams {
            actor_id: attachment.actor_id.clone(),
            permissions: vec!["device.modify".into()],
            targets: vec![target.clone()],
        },
    )
    .unwrap();
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
    assert!(matches!(
        handoff(&mut browser, submit(&outdated.upload_id, 0, 4)).await,
        RpcReply::Failure { error, .. } if ["NOT_FOUND", "PERMISSION_DENIED"].contains(&error.code.as_str())
    ));

    let capacity = 1024 * 1024 * 1024;
    let _pending = progress(handoff(&mut browser, begin(capacity)).await);
    assert!(matches!(
        handoff(&mut other, begin(1)).await,
        RpcReply::Failure { error, .. } if error.code == "HOST_BUSY"
    ));
    browser.close(None).await.unwrap();
    let replacement = timeout(Duration::from_secs(3), async {
        loop {
            match handoff(&mut other, begin(capacity)).await {
                RpcReply::Failure { error, .. } if error.code == "HOST_BUSY" => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                result => break progress(result),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(replacement.total_bytes.get(), capacity);

    assert!(matches!(
        success(
            operator
                .request(RpcRequest::BrowserAccess(BrowserAccessParams::Revoke {}))
                .await
                .unwrap()
        ),
        RpcResult::BrowserAccess(BrowserAccessResult {
            browser_access: BrowserAccessState::Disabled {}
        })
    ));
    let RpcResult::BrowserAccess(BrowserAccessResult {
        browser_access: BrowserAccessState::Pairing { entry, .. },
    }) = success(operator.request(pair()).await.unwrap())
    else {
        panic!("Missing replacement pairing")
    };
    let mut fresh = browser_socket(&entry.url, Some(&entry.url)).await.unwrap();
    assert!(matches!(
        exchange(
            &mut fresh,
            IpcChannel::Control,
            pairing_frame(&entry, &random_token())
        )
        .await,
        IpcMessage::Authenticated { .. }
    ));
    // A stop acknowledgement follows listener drain. The retired upload must no longer own its quota.
    assert_eq!(
        progress(handoff(&mut fresh, begin(capacity)).await)
            .total_bytes
            .get(),
        capacity
    );
    stop.send(()).unwrap();
    timeout(Duration::from_secs(8), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}
