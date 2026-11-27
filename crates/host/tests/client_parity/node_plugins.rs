//! 正式签名插件通过实际 CLI/MCP 程序访问同一 Host 的目录与业务。
use super::*;
use rmcp::model::{ErrorCode, PaginatedRequestParams, Tool};

use support::node_host_actions::{Fixture, spec};

#[path = "reference_theme.rs"]
mod reference_theme;

#[path = "reference_statistics.rs"]
mod reference_statistics;

#[path = "uart_gold.rs"]
mod uart_gold;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT and same-source SWB_TEST_CLI_BIN/SWB_TEST_MCP_BIN"]
async fn native_node_dynamic_action_cli_and_official_mcp_preserve_receipts_and_revocation() {
    dynamic_plugin_parity(spec()).await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT and same-source SWB_TEST_CLI_BIN/SWB_TEST_MCP_BIN"]
async fn native_node_dynamic_query_cli_and_official_mcp_preserve_decimal_and_revocation() {
    let mut definition = spec();
    let query = BuiltinAction::HostMetrics.spec();
    definition.kind = query.kind;
    definition.cancellation = query.cancellation;
    // 合法贡献 ID 的工具名超过可直接编码的长度；只使用真实列表返回的名称。
    definition.action_id = id(&format!("example.terminal.{}", "q".repeat(110)));
    dynamic_plugin_parity(definition).await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_dynamic_send_preprocess_preserves_session_and_write_authority() {
    const ACTION: &str = "example.terminal.preprocess";
    let mut definition = spec();
    definition.action_id = id(ACTION);
    definition.kind = ActionKind::Query;
    definition.cancellation = Cancellation::None;
    definition.target_kinds = vec![ResourceKind::try_from("session").unwrap()];
    definition.input_schema = serde_json::from_value(json!({
        "type":"object","properties":{"payload":{"type":"string"}},
        "required":["payload"],"additionalProperties":false
    }))
    .unwrap();
    definition.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{"output":{"type":"string"}},
        "required":["output"],"additionalProperties":false
    }))
    .unwrap();
    let fixture = Fixture::program_with_virtual(
        definition,
        br#"export function register(context) {
            context.queries.register('example.terminal.preprocess', query => ({
                output: Buffer.from(query.params.payload, 'base64').reverse().toString('base64')
            }));
            return () => {};
        }"#,
    )
    .await;
    use futures_util::FutureExt;
    let checked = std::panic::AssertUnwindSafe(async {
        let reader = HostClient::connect(ConnectOptions::new(
            fixture.dir.path().to_path_buf(),
            id("send-preprocess-client"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        let client = &reader;
        let device = Target {
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("virtual:echo"),
            ..fixture.target.clone()
        };
        let grant = |target: Target, permission: &'static str| {
            let fixture = &fixture;
            async move {
                let call = fixture.call(
                    &fixture.user,
                    &fixture.target,
                    "auth.authorize",
                    json!({"clientId":client.attachment().client_id,
                           "permissions":[permission],"targets":[target]}),
                );
                let operation = fixture.invoke(&fixture.user, call).await;
                let settled = fixture.wait(&fixture.user, &operation.operation_id).await;
                assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
            }
        };
        grant(device.clone(), "device.modify").await;
        let opened = fixture
            .invoke(
                client,
                fixture.call(
                    client,
                    &device,
                    "device.open",
                    json!({"configuration":SerialConfiguration::default()}),
                ),
            )
            .await;
        let opened = fixture.wait(client, &opened.operation_id).await;
        let Some(ActionResult::Opened(opened)) = opened.result else {
            panic!("Expected Virtual Echo open receipt: {opened:?}");
        };
        let session = Target {
            kind: ResourceKind::try_from("session").unwrap(),
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
            ..fixture.target.clone()
        };
        let request = RpcRequest::Query(fixture.query_call(
            client,
            &session,
            ACTION,
            json!({"payload":"AEH/"}),
        ));
        let denied = client.request(request.clone()).await.unwrap();
        assert!(
            matches!(&denied, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"),
            "{denied:?}"
        );
        grant(session.clone(), "content.read").await;
        let RpcResult::Query(QueryResult::Extension(transformed)) =
            success(client.request(request).await.unwrap())
        else {
            panic!("Expected the signed session query result");
        };
        let value = serde_json::to_value(transformed).unwrap();
        assert_eq!(value, json!({"output":"/0EA"}));
        let call = fixture.call(
            client,
            &session,
            "session.tx",
            json!({"bytesBase64":value["output"],"writeWaitMs":"1000"}),
        );
        let denied = client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        assert!(
            matches!(&denied, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"),
            "{denied:?}"
        );
        grant(session.clone(), "device.modify").await;
        let mut call = call;
        call.request_id = request_id();
        let sent = fixture.invoke(client, call).await;
        let sent = fixture.wait(client, &sent.operation_id).await;
        let Some(ActionResult::Tx(receipt)) = sent.result else {
            panic!("Expected transformed bytes to reach Virtual Echo: {sent:?}");
        };
        assert_eq!(sent.state, OperationState::Succeeded);
        assert_eq!(receipt.outcome, TxOutcome::Accepted);
        assert_eq!(Some(receipt.session_id), session.session_id);
        assert_eq!(Some(receipt.session_epoch), session.session_epoch);
        assert_eq!(receipt.byte_start, 0.into());
        assert_eq!(receipt.byte_end, 3.into());
        assert_eq!(receipt.bytes_base64.as_str(), "/0EA");
    })
    .catch_unwind()
    .await;
    fixture.finish().await;
    if let Err(failure) = checked {
        std::panic::resume_unwind(failure);
    }
}

async fn dynamic_plugin_parity(definition: ActionSpec) {
    let cli_binary = binary("SWB_TEST_CLI_BIN", "serial-workbench-cli");
    let mcp_binary = binary("SWB_TEST_MCP_BIN", "serial-workbench-mcp");
    let action = definition.action_id.to_string();
    let kind = definition.kind;
    let register = if kind == ActionKind::Action {
        "registerAction"
    } else {
        "registerQuery"
    };
    let fixture_path = std::env::var_os("SWB_TEST_NODE_SDK_FIXTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../.cache/plugin-sdk/examples/native-parity.js")
        });
    let compiled = std::fs::read_to_string(&fixture_path).unwrap_or_else(|error| {
        panic!("Build the typed public SDK fixture with pnpm plugin-sdk:fixture: {error}")
    });
    let marker = "\"__SWB_TEST_ACTION_ID__\"";
    assert_eq!(compiled.matches(marker).count(), 1);
    let mut source = compiled.replace(marker, &serde_json::to_string(&action).unwrap());
    source.push_str(&format!("\nexport const register = {register};\n"));
    let fixture = Arc::new(Fixture::program(definition, source.as_bytes()).await);
    let checked_fixture = fixture.clone();
    let process_cleanup = Arc::new(std::sync::Mutex::new(None));
    let checked_cleanup = process_cleanup.clone();
    // 断言任务 panic 时，外层仍持有 SDK、进程观察和签名包夹具的清理责任。
    let (sdk_sender, sdk_receiver) = oneshot::channel();
    let mut checked = tokio::spawn(async move {
        let fixture = checked_fixture;
        let cli = Cli {
            binary: cli_binary,
            profile: fixture.dir.path().to_path_buf(),
        };
        let cli_client = HostClient::connect(ConnectOptions::new(
            cli.profile.clone(),
            id("serial-workbench-cli"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        let mcp_client = HostClient::connect(ConnectOptions::new(
            cli.profile.clone(),
            id("serial-workbench-mcp"),
            ClientKind::Mcp,
        ))
        .await
        .unwrap();
        assert_ne!(
            cli_client.attachment().actor_id,
            mcp_client.attachment().actor_id
        );
        for client in [&cli_client, &mcp_client] {
            visibility(&fixture, client, true).await;
        }
        let context_path = cli.profile.join("context.json");
        let context: AttachResult = serde_json::from_value(
            cli.json(&["context", "--out", context_path.to_str().unwrap(), "--json"])
                .await,
        )
        .unwrap();
        assert_eq!(context.actor_id, cli_client.attachment().actor_id);
        assert_eq!(context.host_id, fixture.target.host_id);
        assert_eq!(
            context.instance_epoch,
            cli_client.attachment().instance_epoch
        );

        let mut command = Command::new(mcp_binary);
        command
            .arg("--profile")
            .arg(&cli.profile)
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let (transport, stderr) = TokioChildProcess::builder(command)
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let exited = support::node_owner_exit::ProcessExit::observe(transport.id().unwrap());
        let stderr = tokio::spawn(drain(stderr.unwrap()));
        // 初始化失败也由外层等待自有子进程及 stderr，不能只覆盖握手后的 panic。
        *checked_cleanup.lock().unwrap() = Some((stderr, exited));
        let sdk = timeout(Duration::from_secs(10), ().serve(transport))
            .await
            .unwrap()
            .unwrap();
        let peer = sdk.peer().clone();
        assert!(sdk_sender.send(sdk).is_ok(), "SDK cleanup receiver dropped");

        let listed = dynamic_tool(&peer, &action)
            .await
            .expect("authorized dynamic MCP tool");
        if kind == ActionKind::Query {
            assert!(
                listed.name.starts_with("swb_h_"),
                "long ID must have a bounded tool name"
            );
        }
        assert!(listed.name.len() <= 128);
        assert_cli_visibility(&cli, &action, true).await;
        let mcp_request = request_id();
        let mcp_identity = (kind == ActionKind::Action).then_some(&mcp_request);
        let first = mcp_value(&peer, &listed.name, &fixture.target, mcp_identity).await;
        assert_eq!(first.0, json!({"value":7.25,"calls":1}));
        if kind == ActionKind::Action {
            let replay = mcp_value(&peer, &listed.name, &fixture.target, mcp_identity).await;
            assert_eq!(
                replay, first,
                "same MCP request must retain its real Operation/result"
            );
        }
        let cli_request = request_id();
        let second = cli_value(&cli, &fixture, &cli_client, &action, kind, &cli_request).await;
        assert_eq!(second.0, json!({"value":7.25,"calls":2}));
        if kind == ActionKind::Action {
            let replay = cli_value(&cli, &fixture, &cli_client, &action, kind, &cli_request).await;
            assert_eq!(
                replay, second,
                "same CLI request must retain its real Operation/result"
            );
            assert_ne!(
                first.1, second.1,
                "independent actors have distinct operations"
            );
        }

        for client in [&cli_client, &mcp_client] {
            visibility(&fixture, client, false).await;
        }
        assert!(dynamic_tool(&peer, &action).await.is_none());
        assert_cli_visibility(&cli, &action, false).await;
        let denied = peer
            .call_tool(
                CallToolRequestParams::new(listed.name.to_string()).with_arguments(
                    json!({"target":fixture.target,"params":{"value":7}})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await;
        match denied {
            Err(rmcp::ServiceError::McpError(error)) => {
                assert_eq!(error.code, ErrorCode::METHOD_NOT_FOUND)
            }
            other => {
                panic!("Revoked MCP tool must be unknown in the current visible catalog: {other:?}")
            }
        }
        assert_cli_denied(&cli, &action, &fixture.target, kind).await;

        for client in [&cli_client, &mcp_client] {
            visibility(&fixture, client, true).await;
        }
        let restored = dynamic_tool(&peer, &action)
            .await
            .expect("restored dynamic MCP tool");
        assert_eq!(restored.name, listed.name);
        assert_cli_visibility(&cli, &action, true).await;
        let restored_request = request_id();
        let restored_identity = (kind == ActionKind::Action).then_some(&restored_request);
        let third = mcp_value(&peer, &restored.name, &fixture.target, restored_identity).await;
        assert_eq!(
            third.0,
            json!({"value":7.25,"calls":3}),
            "denied requests must not execute JS"
        );
        let fourth = cli_value(&cli, &fixture, &cli_client, &action, kind, &request_id()).await;
        assert_eq!(fourth.0, json!({"value":7.25,"calls":4}));
        eprintln!(
            "native_dynamic_client_parity kind={kind:?} action={action} signed=true js_calls=4 denied_calls=0 mcp_cli_same_host=true"
        );
    });

    let mut failures = Vec::new();
    let sdk = match timeout(Duration::from_secs(30), sdk_receiver).await {
        Ok(Ok(value)) => Some(value),
        Ok(Err(error)) => {
            failures.push(format!("SDK cleanup handoff: {error}"));
            None
        }
        Err(error) => {
            failures.push(format!("SDK cleanup handoff timeout: {error}"));
            None
        }
    };
    if sdk.is_none() {
        checked.abort();
    }
    match timeout(Duration::from_secs(60), &mut checked).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => failures.push(format!("Dynamic parity assertions: {error}")),
        Err(_) => {
            checked.abort();
            let _ = checked.await;
            failures.push("Dynamic parity assertions timed out (aborted and joined)".into());
        }
    }
    if let Some(sdk) = sdk {
        // rmcp 的 cancel 关闭 stdio，并等待/必要时终止和 wait 自有 Child。
        match timeout(Duration::from_secs(12), sdk.cancel()).await {
            Ok(Ok(_)) => {}
            other => failures.push(format!("SDK child shutdown: {other:?}")),
        }
    }
    let cleanup = process_cleanup.lock().unwrap().take();
    if let Some((mut stderr, mut exited)) = cleanup {
        match timeout(Duration::from_secs(5), &mut stderr).await {
            Ok(Ok(Ok(bytes))) => {
                if !bytes.is_empty() && !failures.is_empty() {
                    failures.push(format!("MCP stderr: {}", String::from_utf8_lossy(&bytes)));
                }
            }
            other => {
                let diagnostic = format!("MCP stderr drain: {other:?}");
                stderr.abort();
                let _ = stderr.await;
                failures.push(diagnostic);
            }
        }
        match tokio::task::spawn_blocking(move || exited.wait()).await {
            Ok(true) => {}
            other => failures.push(format!("Actual MCP process exit: {other:?}")),
        }
    }
    match timeout(Duration::from_secs(10), fixture.host.shutdown()).await {
        Ok(Ok(())) => {}
        other => failures.push(format!("Host shutdown: {other:?}")),
    }
    let fixture =
        Arc::try_unwrap(fixture).unwrap_or_else(|_| panic!("Parity task retained its fixture"));
    let profile = fixture.finish().await;
    assert!(
        failures.is_empty(),
        "{}; profile={}",
        failures.join("\n"),
        profile.path().display()
    );
}

async fn visibility(fixture: &Fixture, client: &HostClient, enabled: bool) {
    let (action, params) = if enabled {
        (
            "auth.authorize",
            json!({"clientId":client.attachment().client_id,"permissions":["content.read"],"targets":[fixture.target]}),
        )
    } else {
        (
            "auth.revoke",
            json!({"actorId":client.attachment().actor_id,"permissions":["content.read"],"targets":[fixture.target]}),
        )
    };
    let accepted = fixture
        .invoke(
            &fixture.user,
            fixture.call(&fixture.user, &fixture.target, action, params),
        )
        .await;
    let settled = fixture.wait(&fixture.user, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
}

async fn dynamic_tool(peer: &rmcp::Peer<rmcp::RoleClient>, action: &str) -> Option<Tool> {
    let mut cursor = None;
    let mut found = None;
    loop {
        let page = peer
            .list_tools(
                cursor.map(|value| PaginatedRequestParams::default().with_cursor(Some(value))),
            )
            .await
            .unwrap();
        for tool in page.tools {
            if tool
                .description
                .as_deref()
                .is_some_and(|description| description.contains(action))
            {
                assert!(
                    found.replace(tool).is_none(),
                    "ambiguous action description"
                );
            }
        }
        cursor = page.next_cursor;
        if cursor.is_none() {
            return found;
        }
    }
}

async fn assert_cli_visibility(cli: &Cli, action: &str, visible: bool) {
    let RpcResult::Catalog(page) =
        success(serde_json::from_value(cli.json(&["catalog", "--json"]).await).unwrap())
    else {
        panic!("Expected real CLI catalog")
    };
    assert_eq!(
        page.items
            .iter()
            .any(|spec| spec.action_id.as_str() == action),
        visible
    );
}

async fn mcp_value(
    peer: &rmcp::Peer<rmcp::RoleClient>,
    name: &str,
    target: &Target,
    request: Option<&RequestId>,
) -> (Value, Option<Id>) {
    let Some(request) = request else {
        return (
            structured(tool(peer, name, target, json!({"value":7})).await),
            None,
        );
    };
    let accepted: Operation = serde_json::from_value(structured(
        peer.call_tool(
            CallToolRequestParams::new(name.to_owned()).with_arguments(
                json!({"target":target,"params":{"value":7},"requestId":request})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap(),
    ))
    .unwrap();
    assert_eq!(&accepted.request_id, request);
    let settled: Operation = timeout(Duration::from_secs(5), async {
        loop {
            let result: OperationResult = serde_json::from_value(structured(
                tool(
                    peer,
                    "swb_operation_x2E_get",
                    target,
                    json!({"operationId":accepted.operation_id}),
                )
                .await,
            ))
            .unwrap();
            if result.operation.state.is_terminal() {
                break result.operation;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Actual MCP Operation did not settle within five seconds");
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let reference = result_reference(&settled);
    let read: FileReadResult = serde_json::from_value(structured(
        tool(
            peer,
            "swb_file_x2E_read",
            &reference_target(reference),
            json!({"fileRef":reference,"offset":"0","maxBytes":"65536"}),
        )
        .await,
    ))
    .unwrap();
    (read_result(read), Some(settled.operation_id))
}

async fn cli_value(
    cli: &Cli,
    fixture: &Fixture,
    client: &HostClient,
    action: &str,
    kind: ActionKind,
    request: &RequestId,
) -> (Value, Option<Id>) {
    if kind == ActionKind::Query {
        let QueryResult::Extension(value) =
            cli.query(action, &fixture.target, json!({"value":7})).await
        else {
            panic!("Expected CLI dynamic query domain result")
        };
        return (serde_json::to_value(value).unwrap(), None);
    }
    let accepted = cli
        .invoke(action, &fixture.target, json!({"value":7}), request)
        .await;
    assert_eq!(&accepted.request_id, request);
    let observed = fixture.wait(client, &accepted.operation_id).await;
    let RpcResult::Operation(receipt) = success(
        serde_json::from_value(
            cli.json(&["operation", "get", accepted.operation_id.as_str(), "--json"])
                .await,
        )
        .unwrap(),
    ) else {
        panic!("Expected actual CLI operation.get receipt")
    };
    let settled = receipt.operation;
    assert_eq!(settled, observed);
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let reference = result_reference(&settled);
    let QueryResult::FileRead(read) = cli
        .query(
            "file.read",
            &reference_target(reference),
            json!({"fileRef":reference,"offset":"0","maxBytes":"65536"}),
        )
        .await
    else {
        panic!("Expected actual CLI result bytes")
    };
    (read_result(read), Some(settled.operation_id))
}

fn result_reference(operation: &Operation) -> &ObjectRef {
    let Some(ActionResult::Reference(result)) = &operation.result else {
        panic!("Expected persisted plugin result: {operation:?}")
    };
    &result.result_ref
}

fn reference_target(reference: &ObjectRef) -> Target {
    Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    }
}

fn read_result(read: FileReadResult) -> Value {
    assert!(read.at_end, "small plugin result must be fully read");
    serde_json::from_slice(&STANDARD.decode(read.bytes_base64.as_str()).unwrap()).unwrap()
}

async fn assert_cli_denied(cli: &Cli, action: &str, target: &Target, kind: ActionKind) {
    let target = cli.file("denied-target.json", target);
    let params = cli.file("denied-params.json", &json!({"value":7}));
    let request = request_id();
    let context = cli.profile.join("context.json");
    let mut args = vec![
        if kind == ActionKind::Action {
            "invoke"
        } else {
            "query"
        },
        action,
        "--target-json",
        target.to_str().unwrap(),
        "--params-json",
        params.to_str().unwrap(),
        "--json",
    ];
    if kind == ActionKind::Action {
        args.extend([
            "--request-id",
            request.as_str(),
            "--request-context-json",
            context.to_str().unwrap(),
        ]);
    }
    let mut command = Command::new(&cli.binary);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command
        .args(&args)
        .arg("--profile")
        .arg(&cli.profile)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdout = tokio::spawn(drain(child.stdout.take().unwrap()));
    let mut stderr = tokio::spawn(drain(child.stderr.take().unwrap()));
    let status = timeout(Duration::from_secs(10), child.wait()).await;
    if !matches!(&status, Ok(Ok(_))) {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let output = timeout(Duration::from_secs(3), &mut stdout).await;
    let diagnostic = timeout(Duration::from_secs(3), &mut stderr).await;
    if output.is_err() {
        stdout.abort();
        let _ = stdout.await;
    }
    if diagnostic.is_err() {
        stderr.abort();
        let _ = stderr.await;
    }
    let output = output.expect("denied CLI stdout timeout").unwrap().unwrap();
    let diagnostic = diagnostic
        .expect("denied CLI stderr timeout")
        .unwrap()
        .unwrap();
    assert!(
        !status
            .expect("denied CLI timeout: child killed and reaped")
            .unwrap()
            .success()
    );
    let RpcReply::Failure { error, .. } = serde_json::from_slice(&output).unwrap() else {
        panic!(
            "CLI must emit a structured permission failure; stderr={}",
            String::from_utf8_lossy(&diagnostic)
        )
    };
    assert_eq!(error.code, "PERMISSION_DENIED");
}
