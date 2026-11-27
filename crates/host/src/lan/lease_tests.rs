use super::*;
use crate::test_support::ManualClock;
use std::path::Path;
use tokio::task::JoinHandle;

fn serve(mut server: HostServer, host: Host) -> (oneshot::Sender<()>, JoinHandle<HostResult<()>>) {
    let (stop, stopped) = oneshot::channel();
    let task = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = stopped.await;
            })
            .await
    });
    (stop, task)
}

async fn stop((signal, task): (oneshot::Sender<()>, JoinHandle<HostResult<()>>)) {
    signal.send(()).unwrap();
    timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

async fn admin(profile: &Path) -> HostClient {
    let mut options = ConnectOptions::new(
        profile.to_path_buf(),
        id("lease-local-user"),
        ClientKind::Cli,
    );
    options.user_control_credential = Some(read_user_control_credential(profile).unwrap());
    HostClient::connect(options).await.unwrap()
}

fn call(
    client: &HostClient,
    action: &str,
    target: &Target,
    params: Value,
    execution: ExecutionMode,
    lease_id: Option<Id>,
) -> Call {
    let attachment = client.attachment();
    let query = query(attachment, action, target, params);
    Call {
        protocol_version: query.protocol_version,
        host_id: query.host_id,
        instance_epoch: query.instance_epoch,
        actor_id: query.actor_id,
        action_id: query.action_id,
        request_id: query.request_id,
        target: query.target,
        params: query.params,
        reveal_target: query.reveal_target,
        request_context: attachment.request_context.clone(),
        execution_mode: Some(execution),
        workspace_startup: None,
        expected_revision: None,
        lease_id,
    }
}

fn tx(
    client: &HostClient,
    target: &Target,
    bytes: &[u8],
    execution: ExecutionMode,
    lease: Option<Id>,
) -> Call {
    call(
        client,
        "session.tx",
        target,
        json!({
            "bytesBase64": STANDARD.encode(bytes), "writeWaitMs": "1000", "queueWaitMs": "30000"
        }),
        execution,
        lease,
    )
}

async fn submit(client: &HostClient, call: Call) -> Operation {
    let RpcResult::Operation(result) =
        success(client.request(RpcRequest::Invoke(call)).await.unwrap())
    else {
        panic!("Expected an operation receipt");
    };
    result.operation
}

async fn operation(client: &HostClient, accepted: &Operation) -> Operation {
    let target = Target {
        host_id: accepted.execution_host_id.clone(),
        kind: ResourceKind::try_from("operation").unwrap(),
        id: accepted.operation_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let request = query(
        client.attachment(),
        "operation.get",
        &target,
        json!({"operationId": target.id}),
    );
    let RpcResult::Operation(receipt) = success(
        client
            .request(RpcRequest::OperationGet(request))
            .await
            .unwrap(),
    ) else {
        panic!("Expected a stored operation");
    };
    receipt.operation
}

async fn settled(client: &HostClient, accepted: &Operation) -> Operation {
    timeout(Duration::from_secs(5), async {
        loop {
            let receipt = operation(client, accepted).await;
            if receipt.state.is_terminal() {
                return receipt;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("operation failed to settle")
}

fn assert_rejected_without_write(receipt: Operation) {
    assert!(matches!(
        receipt.state,
        OperationState::Cancelled | OperationState::Interrupted
    ));
    assert!(matches!(receipt.result, Some(ActionResult::Tx(result))
        if result.outcome == TxOutcome::Rejected
            && result.accepted_ranges.is_empty() && result.unknown_ranges.is_empty()));
}

async fn route_client(
    profile: &Path,
    name: &str,
    auth: &crate::auth::AuthService,
    operator: &crate::auth::AuthenticatedActor,
    host_id: &Id,
    route: &LanRoute,
) -> HostClient {
    let mut options = ConnectOptions::new(profile.to_path_buf(), id(name), ClientKind::Cli);
    let local = HostClient::connect(options.clone()).await.unwrap();
    auth.authorize(
        operator,
        AuthorizeParams {
            client_id: local.attachment().client_id.clone(),
            permissions: vec![LAN_CONNECT_PERMISSION.into()],
            targets: vec![route.authorization_target(host_id)],
            expires_at: None,
        },
    )
    .unwrap();
    options.lan_route = Some(route.clone());
    HostClient::connect(options).await.unwrap()
}

async fn expect_write_denied(client: &HostClient, session: &Target) {
    let reply = client
        .request(RpcRequest::Invoke(tx(
            client,
            session,
            b"must not reach the serial port",
            ExecutionMode::Independent,
            None,
        )))
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Failure {error, ..} if error.code == "PERMISSION_DENIED"));
}

async fn verify_takeover(
    owner: &Host,
    auth: &crate::auth::AuthService,
    admin: &HostClient,
    local: &HostClient,
    selected: &HostClient,
    sibling: &HostClient,
    session: &Target,
) {
    assert_ne!(
        selected.attachment().actor_id,
        sibling.attachment().actor_id
    );
    let raw = selected.connect_raw().await.unwrap();
    let (held, release) = owner.hold_next_session_dispatch();
    let stale_call = tx(
        selected,
        session,
        b"selected write held before backend",
        ExecutionMode::Independent,
        None,
    );
    let stale = submit(selected, stale_call.clone()).await;
    timeout(Duration::from_secs(5), held)
        .await
        .unwrap()
        .unwrap();
    let sibling_tx = submit(
        sibling,
        tx(
            sibling,
            session,
            b"sibling data",
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    let local_tx = submit(
        local,
        tx(
            local,
            session,
            b"local data",
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    let mut changes = auth.subscribe_changes();
    let takeover = submit(
        admin,
        call(
            admin,
            "session.takeover",
            session,
            json!({"actorId": selected.attachment().actor_id, "reason": "user"}),
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    timeout(Duration::from_secs(5), changes.changed())
        .await
        .expect("B never revoked the selected LAN writer")
        .unwrap();
    expect_write_denied(selected, session).await;
    assert!(!operation(admin, &takeover).await.state.is_terminal());
    release.send(()).unwrap();

    let takeover = settled(admin, &takeover).await;
    assert_eq!(takeover.state, OperationState::Succeeded, "{takeover:?}");
    assert!(
        matches!(takeover.result, Some(ActionResult::Takeover(receipt))
        if receipt.affected_operation_ids == [stale.operation_id.clone()])
    );
    let original = settled(selected, &stale).await;
    assert_rejected_without_write(original.clone());
    for (client, tx) in [(sibling, sibling_tx), (local, local_tx)] {
        let receipt = settled(client, &tx).await;
        assert_eq!(receipt.state, OperationState::Succeeded, "{receipt:?}");
        assert!(
            matches!(receipt.result, Some(ActionResult::Tx(tx)) if tx.outcome == TxOutcome::Accepted)
        );
    }
    let page = raw_result(
        raw.request(RpcRequest::Query(query(
            selected.attachment(),
            "stream.read",
            session,
            json!({"sessionId":session.id,"sessionEpoch":session.session_epoch,
                "startEventSeq":"1","maxEvents":"100","maxBytes":"262144"}),
        )))
        .await
        .unwrap(),
    );
    assert!(!page.events.is_empty());

    let reattached = selected.reconnect().await.unwrap();
    assert_eq!(
        reattached.attachment().actor_id,
        selected.attachment().actor_id
    );
    expect_write_denied(&reattached, session).await;
    let host_target = Target {
        host_id: session.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: session.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let grant = submit(
        admin,
        call(
            admin,
            "auth.authorize",
            &host_target,
            json!({"clientId": reattached.attachment().client_id, "permissions":["device.modify"],
                "targets":[session]}),
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    let grant = settled(admin, &grant).await;
    assert_eq!(grant.state, OperationState::Succeeded, "{grant:?}");
    assert_eq!(submit(&reattached, stale_call).await, original);
    let fresh = submit(
        &reattached,
        tx(
            &reattached,
            session,
            b"new approved write",
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    assert_eq!(
        settled(&reattached, &fresh).await.state,
        OperationState::Succeeded
    );
    println!(
        "B took over one client; the sibling and local writer continued, reconnect stayed read-only, and explicit authorization accepted only a new TX"
    );
}

#[tokio::test]
async fn stopped_caller_host_loses_its_interactive_lease_but_owner_settles_independent_tx() {
    let owner_profile = profile();
    let caller_profile = profile();
    let mut owner_server = HostServer::bind(owner_profile.path()).await.unwrap();
    let mut caller_server = HostServer::bind(caller_profile.path()).await.unwrap();
    let clock = Arc::new(ManualClock(0.into()));
    let owner =
        Host::with_native_test_clock(owner_server.store(), owner_server.auth(), clock.clone())
            .await
            .unwrap();
    let caller = Host::new(caller_server.store(), caller_server.auth())
        .await
        .unwrap();
    let owner_endpoint = owner_server.lan_endpoint().unwrap();
    let caller_endpoint = caller_server.lan_endpoint().unwrap();
    let owner_peer = owner_endpoint.peer();
    let caller_peer = caller_endpoint.peer();
    let device = Target {
        host_id: owner_peer.host_id.clone(),
        kind: ResourceKind::try_from("device").unwrap(),
        id: id("virtual:echo"),
        session_id: None,
        session_epoch: None,
    };
    let owner_operator = operator(&owner_server, &owner_profile);
    let owner_auth = owner_server.auth();
    owner_endpoint
        .set_shares(
            &owner_operator,
            caller_peer.clone(),
            &[LanShare {
                target: device.clone(),
                access: LanShareAccess::Operate,
            }],
        )
        .unwrap();
    let caller_operator = operator(&caller_server, &caller_profile);
    caller_endpoint
        .set_shares(&caller_operator, owner_peer.clone(), &[])
        .unwrap();
    let caller_auth = caller_server.auth();
    let owner_task = serve(owner_server, owner.clone());
    let caller_task = serve(caller_server, caller);
    let owner_control = admin(owner_profile.path()).await;
    let local = HostClient::connect(ConnectOptions::new(
        owner_profile.path().to_path_buf(),
        id("lease-owner-writer"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let listener = manage(
        &owner_control,
        LanAccessParams::Enable {
            address: "127.0.0.1:0".into(),
        },
    )
    .await;
    let LanListenerState::Listening { address } = listener.listener else {
        panic!("Expected a listener");
    };
    let route = LanRoute {
        host_id: owner_peer.host_id,
        address,
    };
    let remote = route_client(
        caller_profile.path(),
        "lease-remote-peer",
        &caller_auth,
        &caller_operator,
        &caller_endpoint.peer().host_id,
        &route,
    )
    .await;
    let sibling = route_client(
        caller_profile.path(),
        "lease-remote-sibling",
        &caller_auth,
        &caller_operator,
        &caller_endpoint.peer().host_id,
        &route,
    )
    .await;
    let requested_open = submit(
        &remote,
        call(
            &remote,
            "device.open",
            &device,
            json!({"configuration": SerialConfiguration::default()}),
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    let opened = settled(&remote, &requested_open).await;
    assert_eq!(opened.state, OperationState::Succeeded, "{opened:?}");
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("Expected B to open the shared device");
    };
    let session = Target {
        id: opened.session_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..device.clone()
    };
    let scopes = success(
        remote
            .request(RpcRequest::Query(query(
                remote.attachment(),
                "state.scopes",
                &Target {
                    host_id: device.host_id.clone(),
                    id: device.host_id.clone(),
                    kind: ResourceKind::try_from("host").unwrap(),
                    session_id: None,
                    session_epoch: None,
                },
                json!({}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Query(QueryResult::Scopes(scopes)) = scopes else {
        panic!("Expected the shared scopes");
    };
    assert!(scopes.scopes.iter().any(|scope| scope.target == session));
    owner_auth
        .authorize(
            &owner_operator,
            AuthorizeParams {
                client_id: local.attachment().client_id.clone(),
                permissions: vec![
                    "metadata.read".into(),
                    "content.read".into(),
                    "device.modify".into(),
                ],
                targets: vec![session.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let controller = local.connect_raw().await.unwrap();

    let lease_request = submit(
        &remote,
        call(
            &remote,
            "lease.acquire",
            &session,
            json!({"kind":"transaction", "ttlMs":"15000"}),
            ExecutionMode::Interactive,
            None,
        ),
    )
    .await;
    let lease = timeout(Duration::from_secs(5), async {
        loop {
            if let Some(lease) = owner.devices().snapshot(&session).await.unwrap().lease
                && lease.state == LeaseState::Active
            {
                break lease;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(lease.actor_id, remote.attachment().actor_id);
    assert_eq!(lease.owner_operation_id, lease_request.operation_id);

    let (held, release) = owner.hold_next_session_dispatch();
    let held_call = tx(
        &remote,
        &session,
        b"obsolete held",
        ExecutionMode::Interactive,
        Some(lease.lease_id.clone()),
    );
    let pending = submit(&remote, held_call.clone()).await;
    timeout(Duration::from_secs(5), held)
        .await
        .unwrap()
        .unwrap();
    let queued = submit(
        &remote,
        tx(
            &remote,
            &session,
            b"obsolete queued",
            ExecutionMode::Interactive,
            Some(lease.lease_id.clone()),
        ),
    )
    .await;
    let caller_frame = b"A\0\r\nframe";
    let owner_frame = b"B\0\r\nframe";
    let independent_call = tx(
        &remote,
        &session,
        caller_frame,
        ExecutionMode::Independent,
        None,
    );
    let independent = submit(&remote, independent_call.clone()).await;
    let local_tx = submit(
        &local,
        tx(
            &local,
            &session,
            owner_frame,
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    for accepted in [&pending, &queued, &independent, &local_tx] {
        assert_eq!(
            operation(&local, accepted).await.state,
            OperationState::Queued
        );
    }
    let read = json!({"sessionId":session.id,"sessionEpoch":session.session_epoch,
        "startEventSeq":"1","maxEvents":"100","maxBytes":"262144"});
    let read_raw = || async {
        raw_result(
            controller
                .request(RpcRequest::Query(query(
                    local.attachment(),
                    "stream.read",
                    &session,
                    read.clone(),
                )))
                .await
                .unwrap(),
        )
    };
    timeout(Duration::from_secs(5), async {
        loop {
            let page = read_raw().await;
            assert!(page.events.iter().all(|event| !matches!(event.payload, RawPayload::Rx(_))));
            if [&pending, &queued, &independent, &local_tx].iter().all(|accepted|
                page.events.iter().any(|event|
                    matches!(&event.payload, RawPayload::TxIntent(intent) if intent.operation_id == accepted.operation_id)
                )
            ) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("all four TX intents are queued behind the lease or active writer");

    stop(caller_task).await;
    timeout(Duration::from_secs(5), remote.wait_for_disconnect())
        .await
        .unwrap();
    assert_eq!(
        owner
            .devices()
            .snapshot(&session)
            .await
            .unwrap()
            .lease
            .unwrap()
            .state,
        LeaseState::Active
    );
    clock.advance_ms(15001);
    timeout(Duration::from_secs(5), async {
        loop {
            if owner
                .devices()
                .snapshot(&session)
                .await
                .unwrap()
                .lease
                .is_some_and(|lease| lease.state == LeaseState::Revoking)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("B never started lease revocation");
    release.send(()).unwrap();

    let expired = settled(&local, &lease_request).await;
    assert!(
        matches!(expired.result, Some(ActionResult::Lease(lease)) if lease.state == LeaseState::Expired)
    );
    for stale in [&pending, &queued] {
        assert_rejected_without_write(settled(&local, stale).await);
    }
    let original = settled(&local, &independent).await;
    let local_done = settled(&local, &local_tx).await;
    assert_eq!(original.state, OperationState::Succeeded);
    assert_eq!(local_done.state, OperationState::Succeeded);
    assert_ne!(original.actor_id, local_done.actor_id);

    let restarted_server = HostServer::bind(caller_profile.path()).await.unwrap();
    let restarted_host = Host::new(restarted_server.store(), restarted_server.auth())
        .await
        .unwrap();
    let restarted = serve(restarted_server, restarted_host);
    let restored = remote.reconnect().await.unwrap();
    assert_eq!(restored.attachment().actor_id, remote.attachment().actor_id);
    assert_eq!(operation(&restored, &independent).await, original);
    assert_eq!(submit(&restored, independent_call).await, original);
    assert_eq!(
        submit(&restored, held_call).await,
        settled(&local, &pending).await
    );

    let (result, received) = timeout(Duration::from_secs(5), async {
        loop {
            let page = read_raw().await;
            let received: Vec<u8> = page
                .events
                .iter()
                .filter_map(|item| match &item.payload {
                    RawPayload::Rx(rx) => Some(STANDARD.decode(rx.bytes_base64.as_str()).unwrap()),
                    _ => None,
                })
                .flatten()
                .collect();
            if received.len() >= caller_frame.len() + owner_frame.len() {
                break (page, received);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("expected both surviving replies");
    assert!(
        received == [caller_frame.as_slice(), owner_frame.as_slice()].concat()
            || received == [owner_frame.as_slice(), caller_frame.as_slice()].concat(),
        "TX frames were interleaved, dropped, or repeated: {received:?}"
    );
    let actual_tx_count = result
        .events
        .iter()
        .filter(
            |item| matches!(&item.payload, RawPayload::Tx(v) if v.outcome == TxOutcome::Accepted),
        )
        .count();
    assert_eq!(actual_tx_count, 2);
    assert_eq!(
        owner.devices().snapshot(&session).await.unwrap().state,
        SessionState::Open
    );
    let sibling = sibling.reconnect().await.unwrap();
    verify_takeover(
        &owner,
        &owner_auth,
        &owner_control,
        &local,
        &restored,
        &sibling,
        &session,
    )
    .await;

    // Shared authority can also be revoked after an independent task is admitted.
    let (waiting, allow_dispatch) = owner.hold_next_session_dispatch();
    let revoke_candidate = submit(
        &restored,
        tx(
            &restored,
            &session,
            b"revoked A task",
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    let continuing_local = submit(
        &local,
        tx(
            &local,
            &session,
            b"continuing B task",
            ExecutionMode::Independent,
            None,
        ),
    )
    .await;
    manage(
        &owner_control,
        LanAccessParams::SetShares {
            peer: caller_peer,
            shares: vec![],
        },
    )
    .await;
    let denied = restored
        .request(RpcRequest::Invoke(tx(
            &restored,
            &session,
            b"new A request",
            ExecutionMode::Independent,
            None,
        )))
        .await
        .unwrap();
    assert!(matches!(denied, RpcReply::Failure {error, ..} if error.code == "PERMISSION_DENIED"));
    allow_dispatch.send(()).unwrap();
    assert_rejected_without_write(settled(&local, &revoke_candidate).await);
    let continuing_local = settled(&local, &continuing_local).await;
    assert_eq!(continuing_local.state, OperationState::Succeeded);
    assert!(
        matches!(continuing_local.result, Some(ActionResult::Tx(receipt)) if receipt.outcome == TxOutcome::Accepted)
    );
    println!(
        "B revoked A's admitted independent TX before backend dispatch and completed B's own TX"
    );
    println!(
        "Interactive lease expired; 2 obsolete TX rejected without payload; 2 independent TX completed in whole frames; A reattached to original receipts"
    );
    stop(restarted).await;
    stop(owner_task).await;
}
