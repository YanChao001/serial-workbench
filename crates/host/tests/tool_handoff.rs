#![cfg(windows)]

mod support;

use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{sync::Arc, time::Duration};
use support::{Profile, id};
use tokio::sync::oneshot;

fn query(client: &HostClient, action: &str, target: &Target, params: Value) -> Query {
    let attached = client.attachment();
    Query {
        protocol_version: attached.protocol_version,
        host_id: attached.host_id.clone(),
        instance_epoch: attached.instance_epoch,
        actor_id: attached.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id(action),
        target: target.clone(),
        params: serde_json::from_value(params).unwrap(),
        reveal_target: serde_json::from_value(json!({"pageId":"workbench"})).unwrap(),
    }
}

fn call(client: &HostClient, action: &str, target: &Target, params: Value) -> Call {
    let q = query(client, action, target, params);
    Call {
        protocol_version: q.protocol_version,
        host_id: q.host_id,
        instance_epoch: q.instance_epoch,
        actor_id: q.actor_id,
        request_id: q.request_id,
        request_context: client.attachment().request_context.clone(),
        action_id: q.action_id,
        target: q.target,
        params: q.params,
        reveal_target: q.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: (action == "session.toolHandoff").then_some(ExecutionMode::Independent),
    }
}

fn accepted(reply: RpcReply) -> Operation {
    let RpcReply::Success { result, .. } = reply else {
        panic!("expected an accepted operation: {reply:?}");
    };
    let RpcResult::Operation(result) = *result else {
        panic!("unexpected reply: {result:?}");
    };
    result.operation
}

async fn settle(client: &HostClient, mut operation: Operation) -> Operation {
    let target = Target {
        host_id: client.attachment().host_id.clone(),
        kind: ResourceKind::try_from("operation").unwrap(),
        id: operation.operation_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        while !operation.state.is_terminal() {
            let reply = client
                .request(RpcRequest::Query(query(
                    client,
                    "operation.get",
                    &target,
                    json!({"operationId":target.id}),
                )))
                .await
                .unwrap();
            let RpcReply::Success { result, .. } = reply else {
                panic!(
                    "operation {} was not readable: {reply:?}",
                    operation.action_id.as_str()
                );
            };
            let RpcResult::Query(inspection) = *result else {
                panic!("unexpected operation reply: {result:?}");
            };
            let value = serde_json::to_value(inspection).unwrap();
            operation = serde_json::from_value(value["value"]["operation"].clone()).unwrap();
            if !operation.state.is_terminal() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        operation
    })
    .await
    .expect("operation did not settle")
}

async fn assert_tx_remains_usable(client: &HostClient, session: &Target) {
    let reply = client
        .request(RpcRequest::Invoke(call(
            client,
            "session.tx",
            session,
            json!({"bytesBase64":"AQID","writeWaitMs":"1000"}),
        )))
        .await
        .unwrap();
    let sent = settle(client, accepted(reply)).await;
    assert_eq!(sent.state, OperationState::Succeeded, "{sent:?}");
    assert_eq!(sent.target, *session);
    let Some(ActionResult::Tx(receipt)) = sent.result else {
        panic!("expected TX receipt: {sent:?}");
    };
    assert_eq!(Some(receipt.session_epoch), session.session_epoch);
    assert_eq!(Some(&receipt.session_id), session.session_id.as_ref());
    assert_eq!(receipt.outcome, TxOutcome::Accepted);
    assert_eq!(receipt.bytes_base64.as_str(), "AQID");
    assert_eq!(receipt.byte_end.get() - receipt.byte_start.get(), 3);
    assert!(receipt.unknown_ranges.is_empty());
}

#[tokio::test]
async fn rejected_tool_handoffs_leave_the_original_serial_session_writable() {
    let profile = Profile::isolated("tool-handoff-ipc-");
    let mut server = HostServer::bind(profile.path()).await.unwrap();
    let auth = server.auth();
    let credential = read_user_control_credential(profile.path()).unwrap();
    let operator = auth
        .authenticate_user_control(&id("handoff-operator"), &credential)
        .unwrap();
    let host = Host::new(server.store(), auth.clone()).await.unwrap();
    let (stop, stopped) = oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = stopped.await;
            })
            .await
    });
    let operator_id = id("handoff-operator");
    let actor_id = id("handoff-ordinary");
    let client = HostClient::connect(ConnectOptions::new(
        profile.path().to_path_buf(),
        actor_id.clone(),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let mut control_options = ConnectOptions::new(
        profile.path().to_path_buf(),
        operator_id,
        ClientKind::Desktop,
    );
    control_options.user_control_credential = Some(credential);
    let control = HostClient::connect(control_options).await.unwrap();

    let device = Target {
        host_id: client.attachment().host_id.clone(),
        kind: ResourceKind::try_from("device").unwrap(),
        id: id("virtual:echo"),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: actor_id.clone(),
            permissions: vec!["device.modify".into(), "metadata.read".into()],
            targets: vec![device.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let open = client
        .request(RpcRequest::Invoke(call(
            &client,
            "device.open",
            &device,
            json!({"configuration":SerialConfiguration::default()}),
        )))
        .await
        .unwrap();
    let open = settle(&client, accepted(open)).await;
    let Some(ActionResult::Opened(opened)) = open.result else {
        panic!("could not open Virtual Echo: {open:?}");
    };
    let session = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..device
    };
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: actor_id,
            permissions: vec![
                "device.modify".into(),
                "metadata.read".into(),
                "content.read".into(),
            ],
            targets: vec![session.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let params = serde_json::to_value(ToolHandoffParams {
        package_id: NodePackageId::try_from("example.tool-handoff").unwrap(),
        expected_install_revision: U64::from(0),
        archive_sha256: Digest::try_from("0".repeat(64).as_str()).unwrap(),
        tool_id: id("serial-probe"),
        timeout_ms: DurationMs::try_from(U64::from(2000)).unwrap(),
    })
    .unwrap();
    let denied = client
        .request(RpcRequest::Invoke(call(
            &client,
            "session.toolHandoff",
            &session,
            params.clone(),
        )))
        .await
        .unwrap();
    let RpcReply::Failure { error, .. } = denied else {
        panic!("an ordinary serial owner submitted a tool handoff: {denied:?}");
    };
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert_tx_remains_usable(&client, &session).await;

    let absent = control
        .request(RpcRequest::Invoke(call(
            &control,
            "session.toolHandoff",
            &session,
            params,
        )))
        .await
        .unwrap();
    let absent = settle(&control, accepted(absent)).await;
    assert!(absent.state.is_terminal());
    assert_ne!(absent.state, OperationState::Succeeded, "{absent:?}");
    assert_eq!(
        absent.error.as_ref().map(|error| error.code.as_str()),
        Some("PERMISSION_DENIED"),
        "{absent:?}",
    );
    assert_tx_remains_usable(&client, &session).await;

    drop((client, control));
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .expect("Host did not stop")
        .unwrap()
        .unwrap();
}
