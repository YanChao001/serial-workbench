use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host, auth::AuthenticatedActor, files::FileService, ipc::HostServer, storage::Store,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
fn call(client: &HostClient, target: &Target, action: &str, params: serde_json::Value) -> Call {
    let attached = client.attachment();
    Call {
        protocol_version: ProtocolVersion::V0_1,
        host_id: attached.host_id.clone(),
        instance_epoch: attached.instance_epoch,
        actor_id: attached.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        request_context: attached.request_context.clone(),
        action_id: id(action),
        target: target.clone(),
        params: serde_json::from_value(params).unwrap(),
        reveal_target: RevealTarget {
            page_id: id("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    }
}
fn accepted(reply: RpcReply) -> Operation {
    let RpcReply::Success { result, .. } = reply else {
        panic!("expected success: {reply:?}")
    };
    let RpcResult::Operation(result) = *result else {
        panic!("expected operation")
    };
    result.operation
}
async fn terminal(store: &Store, actor: &AuthenticatedActor, operation: &Id) -> Operation {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let current = store.get(actor, operation).unwrap();
            if !matches!(
                current.state,
                OperationState::Queued | OperationState::Running | OperationState::CancelRequested
            ) {
                return current;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn duplicate_transfer_result_requires_current_source_read_permission() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(dir.path()).await.unwrap();
    let store = server.store();
    let auth = server.auth();
    let secret = serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
        .unwrap()
        .unwrap();
    let operator = auth
        .authenticate_user_control(
            &id("operator"),
            &ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap(),
        )
        .unwrap();
    let host = Host::new(store.clone(), auth.clone()).await.unwrap();
    let (stop, done) = oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let client = HostClient::connect(ConnectOptions::new(
        dir.path().to_path_buf(),
        id("transfer-reader"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let host_target = Target {
        host_id: client.attachment().host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: client.attachment().host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: client.attachment().client_id.clone(),
            permissions: vec!["metadata.read".into(), "device.modify".into()],
            targets: vec![host_target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let device = Target {
        kind: ResourceKind::try_from("device").unwrap(),
        id: id("virtual:echo"),
        ..host_target.clone()
    };
    let opened = accepted(
        client
            .request(RpcRequest::Invoke(call(
                &client,
                &device,
                "device.open",
                json!({"configuration":SerialConfiguration::default()}),
            )))
            .await
            .unwrap(),
    );
    let opened = terminal(&store, &operator, &opened.operation_id).await;
    assert_eq!(
        opened.state,
        OperationState::Succeeded,
        "{:?}",
        opened.error
    );
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("opened result")
    };
    let target = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..host_target.clone()
    };
    let path = dir.path().join("source.bin");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    let reference = FileService::new(store.clone(), auth.clone(), store.identity().unwrap())
        .register(
            RegisterFileParams {
                path: path.to_str().unwrap().into(),
                purpose: FilePurpose::ReadFile,
            },
            &operator,
        )
        .unwrap();
    let source_target = Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: client.attachment().client_id.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![source_target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let mut transfer = call(
        &client,
        &target,
        "transfer.file",
        json!({"sourceRef":reference,"offset":"0","length":"3","chunkBytes":"3","bytesPerSecond":"1000000","interChunkMs":"0","writeWaitMs":"1000"}),
    );
    transfer.execution_mode = Some(ExecutionMode::Independent);
    let first = accepted(
        client
            .request(RpcRequest::Invoke(transfer.clone()))
            .await
            .unwrap(),
    );
    let first = terminal(&store, &operator, &first.operation_id).await;
    assert_eq!(first.state, OperationState::Succeeded, "{:?}", first.error);
    assert!(matches!(first.result, Some(ActionResult::FileTransfer(_))));
    // 历史回执不重新打开已变更的源文件，也不重复派发传输。
    std::fs::write(&path, [9, 8, 7, 6]).unwrap();
    let duplicate = accepted(
        client
            .request(RpcRequest::Invoke(transfer.clone()))
            .await
            .unwrap(),
    );
    assert_eq!(duplicate.operation_id, first.operation_id);
    assert_eq!(duplicate.result, first.result);
    auth.revoke(
        &operator,
        RevokeParams {
            actor_id: client.attachment().actor_id.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![source_target],
        },
    )
    .unwrap();
    let query = Query {
        protocol_version: transfer.protocol_version,
        host_id: transfer.host_id.clone(),
        instance_epoch: transfer.instance_epoch,
        actor_id: transfer.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id("operation.get"),
        target: host_target,
        params: serde_json::from_value(json!({"operationId":first.operation_id})).unwrap(),
        reveal_target: transfer.reveal_target.clone(),
    };
    let get_reply = client.request(RpcRequest::Query(query)).await.unwrap();
    assert!(
        matches!(get_reply, RpcReply::Failure { ref error, .. } if error.code == "PERMISSION_DENIED"),
        "{get_reply:?}"
    );
    let reply = client.request(RpcRequest::Invoke(transfer)).await.unwrap();
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert!(
        matches!(reply, RpcReply::Failure { ref error, .. } if error.code == "PERMISSION_DENIED"),
        "duplicate must recheck source authority: {reply:?}"
    );
}
