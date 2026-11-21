use super::{operator, profile};
use crate::{
    Host,
    ipc::HostServer,
    lan::{LanShare, LanShareAccess},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
use serial_workbench_core::*;
use std::{sync::Arc, time::Duration};
use tokio::{sync::oneshot, time::timeout};

#[path = "lease_tests.rs"]
mod leases;

#[tokio::test]
async fn paired_host_uses_owner_session_for_tx_and_raw_and_unpair_closes_only_lan() {
    let owner_profile = profile();
    let peer_profile = profile();
    let mut owner = HostServer::bind(owner_profile.path()).await.unwrap();
    let mut peer = HostServer::bind(peer_profile.path()).await.unwrap();
    let owner_operator = operator(&owner, &owner_profile);
    let auth = owner.auth();
    let host = Host::new(owner.store(), auth.clone()).await.unwrap();
    let device = Target {
        host_id: owner.identity().host_id.clone(),
        kind: ResourceKind::try_from("device").unwrap(),
        id: id("virtual:echo"),
        session_id: None,
        session_epoch: None,
    };
    let opened = host
        .devices()
        .open(
            &device,
            OpenParams {
                binding: None,
                configuration: SerialConfiguration::default(),
            },
        )
        .await
        .unwrap();
    let session = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..device
    };
    let owner_endpoint = owner.lan_endpoint().unwrap();
    let peer_endpoint = peer.lan_endpoint().unwrap();
    let owner_id = owner_endpoint.peer();
    let peer_id = peer_endpoint.peer();
    peer_endpoint
        .set_shares(&operator(&peer, &peer_profile), owner_id.clone(), &[])
        .unwrap();
    let peer_auth = peer.auth();
    let mut source_a = peer_auth
        .authenticate(&id("lan-assistant"), None)
        .unwrap()
        .actor;
    source_a.observe_as_mcp();
    let source_b = peer_auth.authenticate(&id("lan-cli"), None).unwrap().actor;
    let (stop, closed) = oneshot::channel();
    let running = tokio::spawn(async move {
        owner
            .serve_until(Arc::new(host), async {
                let _ = closed.await;
            })
            .await
    });

    let local = HostClient::connect(ConnectOptions::new(
        owner_profile.path().to_path_buf(),
        id("lan-local-reader"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    auth.authorize(
        &owner_operator,
        AuthorizeParams {
            client_id: local.attachment().client_id.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![session.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let local_raw = local.connect_raw().await.unwrap();
    let ordinary = local
        .request(RpcRequest::LanAccess(LanAccessParams::Status {}))
        .await
        .unwrap();
    assert!(
        matches!(ordinary, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
    );
    let mut admin_options = ConnectOptions::new(
        owner_profile.path().to_path_buf(),
        id("local-lan-admin"),
        ClientKind::Cli,
    );
    admin_options.user_control_credential =
        Some(read_user_control_credential(owner_profile.path()).unwrap());
    let admin = HostClient::connect(admin_options).await.unwrap();
    let status = manage(&admin, LanAccessParams::Status {}).await;
    assert_eq!(status.local_peer, owner_id);
    assert!(matches!(status.listener, LanListenerState::Disabled {}));
    let enabled = manage(
        &admin,
        LanAccessParams::Enable {
            address: "127.0.0.1:0".into(),
        },
    )
    .await;
    let LanListenerState::Listening { address } = enabled.listener else {
        panic!("Expected LAN listener")
    };
    let address = address.parse().unwrap();
    let shares = vec![LanShare {
        target: session.clone(),
        access: LanShareAccess::Operate,
    }];
    let shared = manage(
        &admin,
        LanAccessParams::SetShares {
            peer: peer_id.clone(),
            shares: shares.clone(),
        },
    )
    .await;
    assert_eq!(
        shared.peers,
        vec![LanPeerSettings {
            peer: peer_id.clone(),
            shares: shares.clone()
        }]
    );

    let client = peer_endpoint
        .connect_client(address, &owner_id.host_id, &source_a)
        .await
        .unwrap();
    let attached = client.control().attachment();
    let unsupported = client
        .control()
        .request(RpcRequest::Attach(AttachParams {
            supported_protocol_versions: vec!["future".into()],
            client_kind: ClientKind::Peer,
            client_id: attached.client_id.clone(),
            expected_host_id: Some(owner_id.host_id.clone()),
        }))
        .await
        .unwrap();
    let RpcReply::Failure { error, .. } = unsupported else {
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
    assert_eq!(attached.protocol_version, ProtocolVersion::V0_1);
    let remote = client
        .control()
        .request(RpcRequest::LanAccess(LanAccessParams::Status {}))
        .await
        .unwrap();
    assert!(matches!(remote, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"));
    assert_eq!(attached.host_id, owner_id.host_id);
    assert_eq!(attached.instance_epoch, local.attachment().instance_epoch);
    assert_ne!(attached.actor_id, local.attachment().actor_id);
    assert_ne!(attached.actor_id, *source_a.id());
    let visible = client.visible_scopes().await.unwrap();
    let [share, ..] = visible.scopes.as_slice() else {
        panic!("Expected the shared session")
    };
    assert!(visible.scopes.iter().all(|share| share.target == session));
    let host_target = Target {
        host_id: owner_id.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: owner_id.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let listed = query(attached, "device.list", &host_target, json!({}));
    let RpcResult::Query(QueryResult::Devices(devices)) = success(
        client
            .control()
            .request(RpcRequest::Query(listed))
            .await
            .unwrap(),
    ) else {
        panic!("Expected LAN device directory");
    };
    assert_eq!(devices.devices.len(), 1);
    assert_eq!(devices.devices[0].device_id, id("virtual:echo"));
    assert!(devices.devices[0].description.is_none());
    assert!(devices.devices[0].capabilities.configuration);
    let session = share.target.clone();
    let activity_scope = crate::state::session_activity_scope(&session.id).unwrap();
    assert!(
        visible
            .scopes
            .iter()
            .any(|share| share.scope_id == activity_scope)
    );
    let second = peer_endpoint
        .connect_client(address, &owner_id.host_id, &source_b)
        .await
        .unwrap();
    let second_attached = second.control().attachment();
    let global = query(
        second_attached,
        "state.snapshot",
        &host_target,
        json!({"scopeId":"host.activity"}),
    );
    assert!(matches!(
        second.control().request(RpcRequest::StateSnapshot(global)).await.unwrap(),
        RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"
    ));
    let snapshot = query(
        second_attached,
        "state.snapshot",
        &session,
        json!({"scopeId":activity_scope}),
    );
    let RpcResult::Snapshot(initial) = success(
        second
            .control()
            .request(RpcRequest::StateSnapshot(snapshot))
            .await
            .unwrap(),
    ) else {
        panic!("Expected scoped activity snapshot");
    };
    let empty: ActivitySnapshot =
        serde_json::from_value(serde_json::to_value(initial.state).unwrap()).unwrap();
    assert!(empty.items.is_empty());
    let subscribe = query(
        second_attached,
        "state.subscribe",
        &session,
        json!({"scopeId":activity_scope,"after":initial.cursor}),
    );
    let RpcResult::Subscription(watching) = success(
        second
            .control()
            .request(RpcRequest::StateSubscribe(subscribe))
            .await
            .unwrap(),
    ) else {
        panic!("Expected scoped activity subscription");
    };
    let raw = client.connect_raw(&peer_endpoint).await.unwrap();

    // 同一对端 Host 持有另一个调用者的令牌也不能替换 Raw 的来源。
    let mut control_lane = peer_endpoint
        .connect(address, &owner_id.host_id)
        .await
        .unwrap();
    let (_, token) = control_lane
        .open_control(Some(source_a.local_lan_origin().unwrap()))
        .await
        .unwrap();
    let mut wrong_lane = peer_endpoint
        .connect(address, &owner_id.host_id)
        .await
        .unwrap();
    assert!(
        wrong_lane
            .open_raw(token, Some(source_b.local_lan_origin().unwrap()))
            .await
            .is_err()
    );
    drop(control_lane);

    let sent = [0, b'A', b'\r', b'\n', 0xff];
    let action = query(
        attached,
        "session.tx",
        &session,
        json!({"bytesBase64":STANDARD.encode(sent),"writeWaitMs":"1000"}),
    );
    let call = Call {
        protocol_version: action.protocol_version,
        host_id: action.host_id,
        instance_epoch: action.instance_epoch,
        actor_id: action.actor_id,
        request_id: action.request_id,
        request_context: attached.request_context.clone(),
        action_id: action.action_id,
        target: action.target,
        params: action.params,
        reveal_target: action.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    };
    let RpcResult::Operation(accepted) = success(
        client
            .control()
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap(),
    ) else {
        panic!("Expected accepted TX")
    };
    let update = timeout(Duration::from_secs(5), async {
        loop {
            if let IpcMessage::Delta {
                subscription_id,
                delta,
            } = second.control().next_event().await.unwrap().unwrap().body
                && subscription_id == watching.subscription_id
            {
                break delta;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(update.cursor.scope_id, activity_scope);
    let observed: ActivitySnapshot =
        serde_json::from_value(serde_json::to_value(update.payload).unwrap()).unwrap();
    let [item] = observed.items.as_slice() else {
        panic!("Expected one named assistant activity");
    };
    assert_eq!(item.target, session);
    assert_eq!(item.mcp_client_id, Some(id("lan-assistant")));
    assert_eq!(item.actor_id, attached.actor_id);
    assert_eq!(
        item.operation_id.as_ref(),
        Some(&accepted.operation.operation_id)
    );
    assert!(observed.pending_takeover.is_none());

    let read_params = json!({"sessionId":session.id,"sessionEpoch":session.session_epoch,
        "startEventSeq":"1","maxEvents":"100","maxBytes":"262144"});
    let source = timeout(Duration::from_secs(5), async {
        loop {
            let read = query(attached, "stream.read", &session, read_params.clone());
            let result = raw_result(raw.request(RpcRequest::Query(read)).await.unwrap());
            let received: Vec<_> = result.events.iter().filter_map(|event| {
                if let RawPayload::Rx(payload) = &event.payload {
                    Some(STANDARD.decode(payload.bytes_base64.as_str()).unwrap())
                } else {
                    None
                }
            }).flatten().collect();
            if received == sent && result.events.iter().any(|event| {
                matches!(&event.payload, RawPayload::Tx(tx) if tx.operation_id == accepted.operation.operation_id)
            }) {
                break result;
            }
            tokio::task::yield_now().await;
        }
    }).await.expect("LAN raw data and TX receipt");

    client.control().close().await.unwrap();
    timeout(Duration::from_secs(5), raw.wait_for_disconnect())
        .await
        .unwrap();
    let wrong_profile = client.reconnect(&owner_endpoint).await;
    assert!(matches!(wrong_profile, Err(error) if error.code == "LAN_HOST_ID_MISMATCH"));
    let reconnected = client.reconnect(&peer_endpoint).await.unwrap();
    assert_eq!(
        attached.actor_id,
        reconnected.control().attachment().actor_id
    );
    let operation = Target {
        id: accepted.operation.operation_id.clone(),
        kind: ResourceKind::try_from("operation").unwrap(),
        session_id: None,
        session_epoch: None,
        ..session.clone()
    };
    let mut status = query(
        reconnected.control().attachment(),
        "operation.get",
        &operation,
        json!({"operationId":operation.id}),
    );
    let settled = timeout(Duration::from_secs(5), async {
        loop {
            let reply = reconnected
                .control()
                .request(RpcRequest::OperationGet(status.clone()))
                .await
                .unwrap();
            let RpcResult::Operation(result) = success(reply) else {
                panic!("Expected LAN operation receipt")
            };
            if result.operation.state == OperationState::Succeeded {
                break result.operation;
            }
            status.request_id = request_id();
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(settled.request_id, call.request_id);
    let replay = reconnected
        .control()
        .request(RpcRequest::Invoke(call.clone()))
        .await
        .unwrap();
    let RpcResult::Operation(replayed) = success(replay) else {
        panic!("Expected original operation")
    };
    assert_eq!(replayed.operation, settled);
    let mut conflicting = call.clone();
    conflicting.params =
        serde_json::from_value(json!({"bytesBase64":"AA==","writeWaitMs":"1000"})).unwrap();
    let conflict = reconnected
        .control()
        .request(RpcRequest::Invoke(conflicting))
        .await
        .unwrap();
    assert!(
        matches!(conflict, RpcReply::Failure { error, .. } if error.code == "REQUEST_CONFLICT")
    );

    let reconnected_raw = reconnected.connect_raw(&peer_endpoint).await.unwrap();
    let local_read = query(
        local.attachment(),
        "stream.read",
        &session,
        read_params.clone(),
    );
    let local_source = raw_result(
        local_raw
            .request(RpcRequest::Query(local_read))
            .await
            .unwrap(),
    );
    assert_eq!(source.events, local_source.events);

    assert_ne!(second_attached.actor_id, attached.actor_id);
    assert_ne!(second_attached.client_id, attached.client_id);
    let mut same_id = call.clone();
    same_id.actor_id = second_attached.actor_id.clone();
    same_id.request_context = second_attached.request_context.clone();
    same_id.params =
        serde_json::from_value(json!({"bytesBase64":"Wg==","writeWaitMs":"1000"})).unwrap();
    let RpcResult::Operation(second_result) = success(
        second
            .control()
            .request(RpcRequest::Invoke(same_id))
            .await
            .unwrap(),
    ) else {
        panic!("Expected independent second client TX")
    };
    assert_eq!(second_result.operation.request_id, call.request_id);
    assert_eq!(second_result.operation.actor_id, second_attached.actor_id);
    assert_ne!(second_result.operation.operation_id, settled.operation_id);
    let second_raw = second.connect_raw(&peer_endpoint).await.unwrap();
    timeout(Duration::from_secs(5), async {
        loop {
            let read = query(second_attached, "stream.read", &session, read_params.clone());
            let result = raw_result(second_raw.request(RpcRequest::Query(read)).await.unwrap());
            if result.events.iter().any(|event| {
                matches!(&event.payload, RawPayload::Tx(tx) if tx.operation_id == second_result.operation.operation_id)
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    }).await.expect("Second client's actual TX receipt");

    manage(
        &admin,
        LanAccessParams::SetShares {
            peer: peer_id.clone(),
            shares: Vec::new(),
        },
    )
    .await;
    let listed = query(second_attached, "device.list", &host_target, json!({}));
    let RpcResult::Query(QueryResult::Devices(devices)) = success(
        second
            .control()
            .request(RpcRequest::Query(listed))
            .await
            .unwrap(),
    ) else {
        panic!("Expected empty LAN device directory");
    };
    assert!(devices.devices.is_empty());
    timeout(Duration::from_secs(5), async {
        loop {
            if let IpcMessage::SubscriptionEnded {
                subscription_id,
                error,
            } = second.control().next_event().await.unwrap().unwrap().body
                && subscription_id == watching.subscription_id
            {
                assert_eq!(error.code, "PERMISSION_DENIED");
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(second.visible_scopes().await.unwrap().scopes.is_empty());

    let removed = manage(
        &admin,
        LanAccessParams::Unpair {
            peer: peer_id.clone(),
        },
    )
    .await;
    assert!(removed.peers.is_empty());
    timeout(Duration::from_secs(5), async {
        tokio::join!(
            reconnected.control().wait_for_disconnect(),
            reconnected_raw.wait_for_disconnect(),
            second.control().wait_for_disconnect(),
            second_raw.wait_for_disconnect()
        );
    })
    .await
    .unwrap();
    manage(
        &admin,
        LanAccessParams::SetShares {
            peer: peer_id,
            shares,
        },
    )
    .await;
    let replaced_actor = reconnected.reconnect(&peer_endpoint).await;
    assert!(matches!(replaced_actor, Err(error) if error.code == "ACTOR_MISMATCH"));
    let fresh = peer_endpoint
        .connect_host(address, &owner_id.host_id)
        .await
        .unwrap();
    let fresh_raw = fresh.connect_raw(&peer_endpoint).await.unwrap();
    let status = manage(&admin, LanAccessParams::Disable {}).await;
    assert!(matches!(status.listener, LanListenerState::Disabled {}));
    assert_eq!(status.peers.len(), 1);
    timeout(Duration::from_secs(5), async {
        tokio::join!(
            fresh.control().wait_for_disconnect(),
            fresh_raw.wait_for_disconnect()
        );
    })
    .await
    .unwrap();
    let local_read = query(local.attachment(), "stream.read", &session, read_params);
    let final_local_source = raw_result(
        local_raw
            .request(RpcRequest::Query(local_read))
            .await
            .unwrap(),
    );
    assert!(final_local_source.events.starts_with(&source.events));
    stop.send(()).unwrap();
    timeout(Duration::from_secs(5), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

async fn manage(admin: &HostClient, params: LanAccessParams) -> LanAccessResult {
    let reply = admin.request(RpcRequest::LanAccess(params)).await.unwrap();
    let RpcResult::LanAccess(state) = success(reply) else {
        panic!("Expected LAN status")
    };
    state
}

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

fn request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap()
}

fn query(attached: &AttachResult, action: &str, target: &Target, params: Value) -> Query {
    let mut reveal_target = BuiltinAction::find(action)
        .unwrap()
        .spec()
        .reveal_target
        .clone();
    reveal_target.session_id = target.session_id.clone();
    Query {
        protocol_version: attached.protocol_version,
        host_id: attached.host_id.clone(),
        instance_epoch: attached.instance_epoch,
        actor_id: attached.actor_id.clone(),
        request_id: request_id(),
        action_id: id(action),
        target: target.clone(),
        params: serde_json::from_value(params).unwrap(),
        reveal_target,
    }
}

fn success(reply: RpcReply) -> RpcResult {
    match reply {
        RpcReply::Success { result, .. } => *result,
        RpcReply::Failure { error, .. } => panic!("Expected successful RPC: {error:?}"),
    }
}

fn raw_result(reply: RpcReply) -> StreamReadResult {
    let RpcResult::Query(result) = success(reply) else {
        panic!("Expected query result")
    };
    let QueryResult::StreamRead(result) = result else {
        panic!("Expected raw events")
    };
    result
}
