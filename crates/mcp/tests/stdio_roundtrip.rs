use rmcp::{
    ClientHandler, ClientLifecycleMode, ClientServiceExt, ServiceExt, model::CallToolRequestParams,
    transport::TokioChildProcess,
};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot};

struct Notifications(mpsc::Sender<()>);
impl ClientHandler for Notifications {
    async fn on_tool_list_changed(
        &self,
        _context: rmcp::service::NotificationContext<rmcp::RoleClient>,
    ) {
        let _ = self.0.try_send(());
    }
}

async fn changed(
    subscription: &mut Option<rmcp::service::Subscription>,
    legacy: &mut mpsc::Receiver<()>,
) {
    match subscription {
        Some(subscription) => {
            let event = subscription.next().await.unwrap().unwrap();
            assert!(matches!(
                event,
                rmcp::model::ServerNotification::ToolListChangedNotification(_)
            ));
        }
        None => legacy.recv().await.unwrap(),
    }
}

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

async fn tool(
    sdk: &rmcp::Peer<rmcp::RoleClient>,
    action: &str,
    target: &Target,
    params: serde_json::Value,
    request_id: Option<&RequestId>,
) -> rmcp::model::CallToolResult {
    let mut input = serde_json::json!({"target":target,"params":params});
    if let Some(request_id) = request_id {
        input["requestId"] = serde_json::to_value(request_id).unwrap();
    }
    let mut name = String::from("swb_");
    for byte in action.bytes() {
        if byte.is_ascii_alphanumeric() {
            name.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(name, "_x{byte:02X}_").unwrap();
        }
    }
    sdk.call_tool(
        CallToolRequestParams::new(name).with_arguments(input.as_object().unwrap().clone()),
    )
    .await
    .unwrap()
}

async fn settled(
    sdk: &rmcp::Peer<rmcp::RoleClient>,
    target: &Target,
    operation: &Operation,
) -> Operation {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let result = tool(
                sdk,
                "operation.get",
                target,
                serde_json::json!({"operationId":operation.operation_id}),
                None,
            )
            .await;
            assert_ne!(result.is_error, Some(true), "{result:?}");
            let result: OperationResult =
                serde_json::from_value(result.structured_content.unwrap()).unwrap();
            if !matches!(
                result.operation.state,
                OperationState::Queued | OperationState::Running | OperationState::CancelRequested
            ) {
                return result.operation;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn sdk_stdio_virtual_open_tx_raw_read_receipt_and_close() {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let auth = server.auth();
    let control = serial_workbench_client::read_user_control_credential(directory.path()).unwrap();
    let operator = auth
        .authenticate_user_control(&id("test-local-user"), &control)
        .unwrap();
    let host = Host::new(server.store(), auth.clone()).await.unwrap();
    let (stop, done) = oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    // 先建立相同的普通 actor，明确由测试持有的本地用户控制授权。
    let ordinary = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("serial-workbench-mcp"),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    let host_target = Target {
        host_id: ordinary.attachment().host_id.clone(),
        id: ordinary.attachment().host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: id("serial-workbench-mcp"),
            permissions: vec!["device.modify".into(), "content.read".into()],
            targets: vec![host_target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_serial-workbench-mcp"));
    command.arg("--profile").arg(directory.path());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let sdk = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let peer = sdk.peer().clone();
    let calls_target = host_target.clone();
    let checked = tokio::spawn(async move {
    let sdk = peer;
    let host_target = calls_target;
    let listed = sdk.list_tools(None).await.unwrap();
    assert!(
        listed
            .tools
            .iter()
            .any(|value| value.name == "swb_session_x2E_tx")
    );
    // 同一个入口表覆盖每个可发现工具；不满足领域前置条件时仍返回可读业务结果。
    for entry in &listed.tools {
        let result = sdk
            .call_tool(
                CallToolRequestParams::new(entry.name.clone()).with_arguments(
                    serde_json::json!({"target":host_target,"params":{}})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert!(
            result.is_error == Some(true) || result.structured_content.is_some(),
            "{}",
            entry.name
        );
    }
    let device = Target {
        kind: ResourceKind::try_from("device").unwrap(),
        id: id("virtual:echo"),
        ..host_target.clone()
    };
    let opened = tool(
        &sdk,
        "device.open",
        &device,
        serde_json::json!({"configuration":SerialConfiguration::default()}),
        None,
    )
    .await;
    assert_ne!(opened.is_error, Some(true), "{opened:?}");
    let accepted: Operation = serde_json::from_value(opened.structured_content.unwrap()).unwrap();
    let operation = settled(&sdk, &host_target, &accepted).await;
    let Some(ActionResult::Opened(opened)) = operation.result else {
        panic!("{operation:?}")
    };
    let session = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id.clone()),
        session_epoch: Some(opened.session_epoch),
        ..host_target.clone()
    };
    let request_id = RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
    let tx = tool(
        &sdk,
        "session.tx",
        &session,
        serde_json::json!({"bytesBase64":"SGVsbG8=","writeWaitMs":"1000"}),
        Some(&request_id),
    )
    .await;
    assert_ne!(tx.is_error, Some(true), "{tx:?}");
    let accepted: Operation = serde_json::from_value(tx.structured_content.unwrap()).unwrap();
    assert_eq!(accepted.request_id, request_id);
    let receipt = settled(&sdk, &host_target, &accepted).await;
    assert!(
        matches!(&receipt.result, Some(ActionResult::Tx(value)) if value.outcome == TxOutcome::Accepted)
    );
    let duplicate = tool(
        &sdk,
        "session.tx",
        &session,
        serde_json::json!({"bytesBase64":"SGVsbG8=","writeWaitMs":"1000"}),
        Some(&request_id),
    )
    .await;
    let duplicate: Operation =
        serde_json::from_value(duplicate.structured_content.unwrap()).unwrap();
    assert_eq!(duplicate.operation_id, accepted.operation_id);
    let read = tool(
        &sdk,
        "stream.read",
        &session,
        serde_json::json!({
            "sessionId":session.id,"sessionEpoch":session.session_epoch,
            "startEventSeq":"1","maxEvents":"100","maxBytes":"262144",
        }),
        None,
    )
    .await;
    assert_ne!(read.is_error, Some(true), "{read:?}");
    let read: StreamReadResult = serde_json::from_value(read.structured_content.unwrap()).unwrap();
    assert!(read.events.iter().any(|event| matches!(&event.payload, RawPayload::Tx(value) if value.operation_id == accepted.operation_id)));
    let close = tool(&sdk, "session.close", &session, serde_json::json!({}), None).await;
    let close: Operation = serde_json::from_value(close.structured_content.unwrap()).unwrap();
    assert_eq!(
        settled(&sdk, &host_target, &close).await.state,
        OperationState::Succeeded
    );
    (receipt, accepted, request_id)
    }).await;
    host.shutdown().await.unwrap();
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    let (receipt, accepted, request_id) = match checked {
        Ok(result) => result,
        Err(error) => {
            sdk.cancel().await.unwrap();
            panic!("Virtual assertions failed after child cleanup: {error}");
        }
    };
    let mut restarted = HostServer::bind(directory.path()).await.unwrap();
    let restarted_host = Host::new(restarted.store(), restarted.auth())
        .await
        .unwrap();
    let (stop, done) = oneshot::channel();
    let handler = restarted_host.clone();
    let running = tokio::spawn(async move {
        restarted
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let peer = sdk.peer().clone();
    let checked = tokio::spawn(async move {
        let sdk = peer;
        // 已失败的请求不自动重放；接着显式查询原 Operation，允许重新 attach。
        let first = tool(
            &sdk,
            "operation.get",
            &host_target,
            serde_json::json!({"operationId":accepted.operation_id}),
            None,
        )
        .await;
        let recovered = if first.is_error == Some(true) {
            tool(
                &sdk,
                "operation.get",
                &host_target,
                serde_json::json!({"operationId":accepted.operation_id}),
                None,
            )
            .await
        } else {
            first
        };
        assert_ne!(recovered.is_error, Some(true), "{recovered:?}");
        let recovered: OperationResult =
            serde_json::from_value(recovered.structured_content.unwrap()).unwrap();
        assert_eq!(recovered.operation.operation_id, receipt.operation_id);
        assert_eq!(recovered.operation.request_id, request_id);
        assert_eq!(recovered.operation.result, receipt.result);
    })
    .await;
    sdk.cancel().await.unwrap();
    restarted_host.shutdown().await.unwrap();
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    checked.unwrap();
}

#[tokio::test]
async fn sdk_tool_changes_follow_this_actor_grants_before_first_tools_list() {
    let legacy = tokio::spawn(assert_tool_changes(ClientLifecycleMode::Initialize)).await;
    let modern = tokio::spawn(assert_tool_changes(ClientLifecycleMode::Discover {
        preferred_versions: vec![rmcp::model::ProtocolVersion::V_2026_07_28],
    }))
    .await;
    legacy.unwrap();
    modern.unwrap();
}

async fn assert_tool_changes(lifecycle: ClientLifecycleMode) {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let auth = server.auth();
    let control = serial_workbench_client::read_user_control_credential(directory.path()).unwrap();
    let operator = auth
        .authenticate_user_control(&id("test-local-user"), &control)
        .unwrap();
    let host = Host::new(server.store(), auth.clone()).await.unwrap();
    let (stop, done) = oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let ordinary = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("serial-workbench-mcp"),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    let target = Target {
        host_id: ordinary.attachment().host_id.clone(),
        id: ordinary.attachment().host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_serial-workbench-mcp"));
    command.arg("--profile").arg(directory.path());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let modern = matches!(&lifecycle, ClientLifecycleMode::Discover { .. });
    let (notifications, mut legacy) = mpsc::channel(8);
    let sdk = Notifications(notifications)
        .serve_with_lifecycle(TokioChildProcess::new(command).unwrap(), lifecycle)
        .await
        .unwrap();
    let mut filter = rmcp::model::SubscriptionFilter::default();
    filter.tools_list_changed = Some(true);
    let mut subscription = if modern {
        Some(sdk.listen(filter).await.unwrap())
    } else {
        None
    };
    // listen 的确认先于 handler 就绪；真实通知作为屏障，避免重启打断初始基线。
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: id("serial-workbench-mcp"),
            permissions: vec!["device.modify".into()],
            targets: vec![target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        changed(&mut subscription, &mut legacy),
    )
    .await
    .unwrap();
    let device = Target {
        id: id("virtual:echo"),
        kind: ResourceKind::try_from("device").unwrap(),
        ..target.clone()
    };
    let opened = tool(
        &sdk,
        "device.open",
        &device,
        serde_json::json!({"configuration":SerialConfiguration::default()}),
        None,
    )
    .await;
    assert_ne!(opened.is_error, Some(true), "{opened:?}");
    let seed: Operation = serde_json::from_value(opened.structured_content.unwrap()).unwrap();
    let seed = settled(&sdk, &target, &seed).await;
    assert_eq!(seed.actor_id, ordinary.attachment().actor_id);
    assert_eq!(seed.state, OperationState::Succeeded);
    assert!(
        matches!(&seed.result, Some(ActionResult::Opened(_))),
        "{seed:?}"
    );
    auth.revoke(
        &operator,
        RevokeParams {
            actor_id: ordinary.attachment().actor_id.clone(),
            permissions: vec!["device.modify".into()],
            targets: vec![target.clone()],
        },
    )
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        changed(&mut subscription, &mut legacy),
    )
    .await
    .unwrap();
    // 已终态的自身 Operation 可用 metadata 权限取消；Virtual Session 由下方 shutdown 清理。
    let operation_target = Target {
        id: seed.operation_id.clone(),
        kind: ResourceKind::try_from("operation").unwrap(),
        ..target.clone()
    };
    let accepted = tool(
        &sdk,
        "operation.cancel",
        &operation_target,
        serde_json::json!({"reason":"user"}),
        None,
    )
    .await;
    assert_ne!(accepted.is_error, Some(true), "{accepted:?}");
    let accepted: Operation = serde_json::from_value(accepted.structured_content.unwrap()).unwrap();
    let original = settled(&sdk, &target, &accepted).await;
    assert_eq!(original.state, OperationState::Succeeded);
    assert!(
        matches!(&original.result, Some(ActionResult::CancellationRequested(result))
            if result.operation_id == seed.operation_id && result.state == OperationState::Succeeded),
        "{original:?}"
    );
    host.shutdown().await.unwrap();
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();

    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let auth = server.auth();
    let operator = auth
        .authenticate_user_control(&id("test-local-user"), &control)
        .unwrap();
    let host = Host::new(server.store(), auth.clone()).await.unwrap();
    let (stop, done) = oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let peer = sdk.peer().clone();
    let checked = tokio::spawn(async move {
        let sdk = peer;
        let first = tool(
            &sdk,
            "operation.get",
            &target,
            serde_json::json!({"operationId":original.operation_id}),
            None,
        )
        .await;
        let recovered = if first.is_error == Some(true) {
            tool(
                &sdk,
                "operation.get",
                &target,
                serde_json::json!({"operationId":original.operation_id}),
                None,
            )
            .await
        } else {
            first
        };
        assert_ne!(recovered.is_error, Some(true), "{recovered:?}");
        let recovered: OperationResult =
            serde_json::from_value(recovered.structured_content.unwrap()).unwrap();
        assert_eq!(recovered.operation.operation_id, original.operation_id);
        assert_eq!(recovered.operation.request_id, original.request_id);
        assert_eq!(recovered.operation.state, original.state);
        assert_eq!(recovered.operation.result, original.result);
        // 恢复后不先调用 tools/list；授予/撤权必须直接唤醒原 MCP 会话。
        assert_eq!(
            sdk.peer_info().unwrap().protocol_version,
            if modern {
                rmcp::model::ProtocolVersion::V_2026_07_28
            } else {
                rmcp::model::ProtocolVersion::LATEST_WITH_INITIALIZE
            }
        );
        let mut subscription = subscription;
        auth.authenticate(&id("unrelated"), None).unwrap();
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: id("unrelated"),
                permissions: vec!["device.modify".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(200),
                changed(&mut subscription, &mut legacy)
            )
            .await
            .is_err()
        );
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: id("serial-workbench-mcp"),
                permissions: vec!["device.modify".into(), "content.read".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            changed(&mut subscription, &mut legacy),
        )
        .await
        .unwrap();
        let allowed = sdk.list_tools(None).await.unwrap();
        assert!(
            allowed
                .tools
                .iter()
                .any(|tool| tool.name == "swb_session_x2E_tx")
        );
        auth.revoke(
            &operator,
            RevokeParams {
                actor_id: ordinary.attachment().actor_id.clone(),
                permissions: vec!["device.modify".into(), "content.read".into()],
                targets: vec![target],
            },
        )
        .unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            changed(&mut subscription, &mut legacy),
        )
        .await
        .unwrap();
        let denied = sdk.list_tools(None).await.unwrap();
        assert!(
            !denied
                .tools
                .iter()
                .any(|tool| tool.name == "swb_session_x2E_tx")
        );
        if let Some(subscription) = &mut subscription {
            subscription.cancel().await.unwrap();
        }
    })
    .await;
    sdk.cancel().await.unwrap();
    host.shutdown().await.unwrap();
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    checked.unwrap();
}

#[tokio::test]
async fn sdk_stdio_lists_authorized_host_tools_and_returns_domain_values() {
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let (stop, done) = oneshot::channel();
    let handler = host.clone();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let client = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("observer"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let target = serde_json::json!({
        "hostId":client.attachment().host_id,"kind":"host","id":client.attachment().host_id,
    });
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_serial-workbench-mcp"));
    command.arg("--profile").arg(directory.path());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let transport = TokioChildProcess::new(command).unwrap();
    assert!(transport.id().is_some());
    let sdk = tokio::time::timeout(Duration::from_secs(10), ().serve(transport))
        .await
        .unwrap()
        .unwrap();
    let listed = sdk.list_tools(None).await;
    let result = sdk
        .call_tool(
            CallToolRequestParams::new("swb_catalog_x2E_list").with_arguments(
                serde_json::json!({"target":target,"params":{"pageSize":"100"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await;
    let invalid = sdk
        .call_tool(
            CallToolRequestParams::new("swb_catalog_x2E_list").with_arguments(
                serde_json::json!({"target":target,"params":{"pageSize":"0"}})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await;
    let bad_cursor = sdk
        .list_tools(Some(
            rmcp::model::PaginatedRequestParams::default()
                .with_cursor(Some("invalid-page-token".into())),
        ))
        .await;
    sdk.cancel().await.unwrap();
    // MCP 退出后 Host 仍然能接纳另一个已认证客户端。
    let after = HostClient::connect(ConnectOptions::new(
        directory.path().to_path_buf(),
        id("after-mcp"),
        ClientKind::Cli,
    ))
    .await;
    host.shutdown().await.unwrap();
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert!(after.is_ok());
    let invalid = invalid.unwrap();
    let listed = listed.unwrap();
    assert_eq!(invalid.is_error, Some(true));
    assert!(invalid.structured_content.is_none());
    let error: HostError =
        serde_json::from_str(&invalid.content[0].as_text().unwrap().text).unwrap();
    assert_eq!(error.code, "INVALID_PAGE_TOKEN");
    assert!(bad_cursor.is_err());
    assert!(
        listed
            .tools
            .iter()
            .any(|tool| tool.name == "swb_catalog_x2E_list")
    );
    assert!(
        !listed
            .tools
            .iter()
            .any(|tool| tool.name == "swb_session_x2E_tx")
    );
    let result = result.unwrap();
    assert_ne!(result.is_error, Some(true));
    let value = result.structured_content.unwrap();
    assert!(value.get("items").is_some(), "{value}");
    assert!(
        value.get("kind").is_none(),
        "QueryResult wire wrapper leaked: {value}"
    );
}
