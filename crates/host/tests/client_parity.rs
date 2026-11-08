use base64::{Engine, engine::general_purpose::STANDARD};
use rmcp::{ServiceExt, model::CallToolRequestParams, transport::TokioChildProcess};
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::oneshot, time::timeout};

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

fn request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap()
}

fn binary(variable: &str, name: &str) -> PathBuf {
    let path = std::env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .unwrap()
                .parent()
                .expect("test executable directory")
                .parent()
                .expect("target profile directory")
                .join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
        });
    path.canonicalize().ok().filter(|path| path.is_file()).unwrap_or_else(|| {
        panic!(
            "Missing test binary {} ({variable}); from the workspace root first run: cargo build --locked -p serial-workbench-cli -p serial-workbench-mcp",
            path.display()
        )
    })
}

fn query(client: &HostClient, action: &str, target: &Target, params: Value) -> Query {
    let attached = client.attachment();
    let mut reveal_target = BuiltinAction::find(action).unwrap().spec().reveal_target;
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
        RpcReply::Failure { error, .. } => panic!("Host rejected parity request: {error:?}"),
    }
}

fn query_result(result: RpcResult) -> QueryResult {
    match result {
        RpcResult::Query(result) => result,
        other => panic!("Expected generic Query result: {other:?}"),
    }
}

async fn drain(mut stream: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            return Ok(retained);
        }
        // Continue draining after the diagnostic cap so the child cannot block on stderr.
        let keep = count.min((1024 * 1024_usize).saturating_sub(retained.len()));
        retained.extend_from_slice(&buffer[..keep]);
    }
}

struct Cli {
    binary: PathBuf,
    profile: PathBuf,
}

impl Cli {
    async fn json(&self, args: &[&str]) -> Value {
        let mut command = Command::new(&self.binary);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        command
            .args(args)
            .arg("--profile")
            .arg(&self.profile)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn real CLI");
        let mut stdout = tokio::spawn(drain(child.stdout.take().unwrap()));
        let mut stderr = tokio::spawn(drain(child.stderr.take().unwrap()));
        let status = timeout(Duration::from_secs(10), child.wait()).await;
        if !matches!(&status, Ok(Ok(_))) {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let output = timeout(Duration::from_secs(3), &mut stdout).await;
        let errors = timeout(Duration::from_secs(3), &mut stderr).await;
        if output.is_err() {
            stdout.abort();
            let _ = stdout.await;
        }
        if errors.is_err() {
            stderr.abort();
            let _ = stderr.await;
        }
        let output = output.expect("CLI stdout drain timeout").unwrap().unwrap();
        let errors = errors.expect("CLI stderr drain timeout").unwrap().unwrap();
        let status = status
            .expect("CLI timeout (child killed and reaped)")
            .unwrap();
        assert!(
            status.success(),
            "CLI {args:?}: stdout={} stderr={}",
            String::from_utf8_lossy(&output),
            String::from_utf8_lossy(&errors)
        );
        assert!(
            errors.is_empty(),
            "CLI stderr={}",
            String::from_utf8_lossy(&errors)
        );
        serde_json::from_slice(&output).expect("CLI stdout must be one JSON value")
    }

    fn file(&self, name: &str, value: &impl serde::Serialize) -> PathBuf {
        let path = self.profile.join(name);
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        path
    }

    async fn query(&self, action: &str, target: &Target, params: Value) -> QueryResult {
        let target = self.file("query-target.json", target);
        let params = self.file("query-params.json", &params);
        let reply = self
            .json(&[
                "query",
                action,
                "--target-json",
                target.to_str().unwrap(),
                "--params-json",
                params.to_str().unwrap(),
                "--json",
            ])
            .await;
        query_result(success(serde_json::from_value(reply).unwrap()))
    }

    async fn invoke(
        &self,
        action: &str,
        target: &Target,
        params: Value,
        request: &RequestId,
    ) -> Operation {
        let target = self.file("call-target.json", target);
        let params = self.file("call-params.json", &params);
        let context = self.profile.join("context.json");
        let reply = self
            .json(&[
                "invoke",
                action,
                "--target-json",
                target.to_str().unwrap(),
                "--params-json",
                params.to_str().unwrap(),
                "--request-id",
                request.as_str(),
                "--request-context-json",
                context.to_str().unwrap(),
                "--json",
            ])
            .await;
        match success(serde_json::from_value(reply).unwrap()) {
            RpcResult::Operation(result) => result.operation,
            other => panic!("Expected accepted CLI Operation: {other:?}"),
        }
    }

    async fn settled(&self, operation: &Operation) -> Operation {
        timeout(Duration::from_secs(15), async {
            loop {
                let reply = self
                    .json(&[
                        "operation",
                        "get",
                        operation.operation_id.as_str(),
                        "--json",
                    ])
                    .await;
                let RpcResult::Operation(result) = success(serde_json::from_value(reply).unwrap())
                else {
                    panic!("Expected CLI operation.get result")
                };
                if !matches!(
                    result.operation.state,
                    OperationState::Queued
                        | OperationState::Running
                        | OperationState::CancelRequested
                ) {
                    assert_eq!(
                        result.operation.state,
                        OperationState::Succeeded,
                        "{:?}",
                        result.operation
                    );
                    return result.operation;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("CLI operation did not finish")
    }
}

async fn tool(
    peer: &rmcp::Peer<rmcp::RoleClient>,
    name: &str,
    target: &Target,
    params: Value,
) -> rmcp::model::CallToolResult {
    peer.call_tool(
        CallToolRequestParams::new(name.to_owned()).with_arguments(
            json!({"target":target,"params":params})
                .as_object()
                .unwrap()
                .clone(),
        ),
    )
    .await
    .expect("official SDK call_tool")
}

fn structured(result: rmcp::model::CallToolResult) -> Value {
    assert_ne!(
        result.is_error,
        Some(true),
        "MCP business error: {result:?}"
    );
    result
        .structured_content
        .expect("MCP structured domain result")
}

fn rx_bytes(events: &[RawEvent]) -> Vec<u8> {
    events
        .iter()
        .filter_map(|event| match &event.payload {
            RawPayload::Rx(rx) => Some(STANDARD.decode(rx.bytes_base64.as_str()).unwrap()),
            _ => None,
        })
        .flatten()
        .collect()
}

#[tokio::test]
async fn cli_client_and_official_mcp_share_virtual_session_events_and_receipt() {
    let cli_binary = binary("SWB_TEST_CLI_BIN", "serial-workbench-cli");
    let mcp_binary = binary("SWB_TEST_MCP_BIN", "serial-workbench-mcp");
    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let auth = server.auth();
    let control = serial_workbench_client::read_user_control_credential(directory.path()).unwrap();
    let operator = auth
        .authenticate_user_control(&id("parity-local-user"), &control)
        .unwrap();
    let host = Host::new(server.store(), auth.clone()).await.unwrap();
    let handler = host.clone();
    let (stop, done) = oneshot::channel();
    let mut running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(handler), async {
                let _ = done.await;
            })
            .await
    });
    let profile = directory.path().to_path_buf();
    // Keep the SDK handle outside the assertion task, so a panic still gets explicit teardown.
    let (sdk_sender, sdk_receiver) = oneshot::channel();
    let mut checked = tokio::spawn(async move {
        let options =
            ConnectOptions::new(profile.clone(), id("serial-workbench-cli"), ClientKind::Cli);
        let registered = HostClient::connect(options.clone()).await.unwrap();
        let cli_actor = registered.attachment().actor_id.clone();
        let host_target = Target {
            host_id: registered.attachment().host_id.clone(),
            id: registered.attachment().host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let mcp = HostClient::connect(ConnectOptions::new(
            profile.clone(),
            id("serial-workbench-mcp"),
            ClientKind::Mcp,
        ))
        .await
        .unwrap();
        assert_ne!(cli_actor, mcp.attachment().actor_id);
        let mcp_actor = mcp.attachment().actor_id.clone();
        for (client, permissions) in [
            (
                "serial-workbench-cli",
                vec!["device.modify".into(), "content.read".into()],
            ),
            ("serial-workbench-mcp", vec!["content.read".into()]),
        ] {
            auth.authorize(
                &operator,
                AuthorizeParams {
                    client_id: id(client),
                    permissions,
                    targets: vec![host_target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        }
        drop(mcp);
        drop(registered);
        // Reuse the real CLI clientId and its OS-protected credential through normal discovery.
        let client = HostClient::connect(options).await.unwrap();
        assert_eq!(client.attachment().actor_id, cli_actor);
        let cli = Cli {
            binary: cli_binary,
            profile,
        };
        let context_path = cli.profile.join("context.json");
        let context: AttachResult = serde_json::from_value(
            cli.json(&["context", "--out", context_path.to_str().unwrap(), "--json"])
                .await,
        )
        .unwrap();
        assert_eq!(context.actor_id, cli_actor);
        assert_eq!(context.host_id, client.attachment().host_id);
        assert_eq!(context.instance_epoch, client.attachment().instance_epoch);

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
        let stderr = tokio::spawn(drain(stderr.unwrap()));
        // serve performs the official initialize handshake before returning the ready service.
        let sdk = timeout(Duration::from_secs(10), ().serve(transport))
            .await
            .unwrap()
            .unwrap();
        let peer = sdk.peer().clone();
        assert!(
            sdk_sender.send((sdk, stderr)).is_ok(),
            "SDK cleanup receiver dropped"
        );
        let tools = peer.list_tools(None).await.unwrap();
        for name in [
            "swb_session_x2E_get",
            "swb_stream_x2E_read",
            "swb_operation_x2E_get",
        ] {
            assert!(
                tools.tools.iter().any(|tool| tool.name == name),
                "Missing discoverable {name}"
            );
        }
        assert!(
            !tools
                .tools
                .iter()
                .any(|tool| tool.name == "swb_session_x2E_tx"),
            "MCP has no device.modify grant"
        );

        let device = Target {
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("virtual:echo"),
            ..host_target.clone()
        };
        let open_request = request_id();
        let accepted = cli
            .invoke(
                "device.open",
                &device,
                json!({"configuration":SerialConfiguration::default()}),
                &open_request,
            )
            .await;
        let opened = cli.settled(&accepted).await;
        assert_eq!(opened.request_id, open_request);
        let Some(ActionResult::Opened(open)) = opened.result else {
            panic!("Expected real open receipt")
        };
        let session = Target {
            kind: ResourceKind::try_from("session").unwrap(),
            id: open.session_id.clone(),
            session_id: Some(open.session_id.clone()),
            session_epoch: Some(open.session_epoch),
            ..host_target.clone()
        };
        let QueryResult::Session(cli_snapshot) =
            cli.query("session.get", &session, json!({})).await
        else {
            panic!("CLI session snapshot")
        };
        let direct = success(
            client
                .request(RpcRequest::Query(query(
                    &client,
                    "session.get",
                    &session,
                    json!({}),
                )))
                .await
                .unwrap(),
        );
        let QueryResult::Session(direct_snapshot) = query_result(direct) else {
            panic!("Client session snapshot")
        };
        let mcp_snapshot: SessionSnapshot = serde_json::from_value(structured(
            tool(&peer, "swb_session_x2E_get", &session, json!({})).await,
        ))
        .unwrap();
        assert_eq!(cli_snapshot, direct_snapshot);
        assert_eq!(cli_snapshot, mcp_snapshot);
        assert_eq!(cli_snapshot.session_id, open.session_id);
        assert_eq!(cli_snapshot.session_epoch, open.session_epoch);
        assert_eq!(cli_snapshot.configuration, SerialConfiguration::default());
        assert_eq!(cli_snapshot.state, SessionState::Open);

        let tx_request = request_id();
        let accepted = cli
            .invoke(
                "session.tx",
                &session,
                json!({"bytesBase64":"U0FNRQ0K","writeWaitMs":"1000"}),
                &tx_request,
            )
            .await;
        let tx = cli.settled(&accepted).await;
        assert_eq!(tx.operation_id, accepted.operation_id);
        assert_eq!(tx.request_id, tx_request);
        assert_eq!(tx.actor_id, cli_actor);
        let operation_target = Target {
            kind: ResourceKind::try_from("operation").unwrap(),
            id: tx.operation_id.clone(),
            ..host_target.clone()
        };
        let direct = success(
            client
                .request(RpcRequest::OperationGet(query(
                    &client,
                    "operation.get",
                    &operation_target,
                    json!({"operationId":tx.operation_id}),
                )))
                .await
                .unwrap(),
        );
        let RpcResult::Operation(direct) = direct else {
            panic!("Client operation.get receipt")
        };
        assert_eq!(
            direct.operation, tx,
            "same-owner CLI/HostClient full Operation and original requestId"
        );
        let Some(ActionResult::Tx(receipt)) = &tx.result else {
            panic!("Expected TX receipt: {tx:?}")
        };
        assert_eq!(receipt.operation_id, tx.operation_id);
        assert_eq!(receipt.session_id, open.session_id);
        assert_eq!(receipt.session_epoch, open.session_epoch);
        assert_eq!(
            STANDARD.decode(receipt.bytes_base64.as_str()).unwrap(),
            b"SAME\r\n"
        );
        assert_eq!(receipt.outcome, TxOutcome::Accepted);
        assert_eq!(receipt.byte_start, 0.into());
        assert_eq!(receipt.byte_end, 6.into());
        assert_eq!(
            receipt.accepted_ranges,
            vec![ByteRange {
                start: 0.into(),
                end: 6.into()
            }]
        );
        assert!(receipt.unknown_ranges.is_empty());
        assert!(receipt.backend_error.is_none());

        let read_params = json!({"sessionId":session.id,"sessionEpoch":session.session_epoch,
            "startEventSeq":"1","maxEvents":"100","maxBytes":"262144"});
        let raw = client.connect_raw().await.unwrap();
        let direct_read = timeout(Duration::from_secs(10), async {
            loop {
                let result = success(raw.request(RpcRequest::Query(query(&client, "stream.read", &session, read_params.clone()))).await.unwrap());
                let QueryResult::StreamRead(read) = query_result(result) else { panic!("Client raw stream.read") };
                if rx_bytes(&read.events) == b"SAME\r\n" && read.events.iter().any(|event| matches!(&event.payload, RawPayload::Tx(value) if value.operation_id == tx.operation_id)) {
                    return read;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("Virtual echo and TX receipt did not arrive");
        let QueryResult::StreamRead(cli_read) = cli
            .query("stream.read", &session, read_params.clone())
            .await
        else {
            panic!("CLI raw stream.read")
        };
        let mcp_read: StreamReadResult = serde_json::from_value(structured(
            tool(&peer, "swb_stream_x2E_read", &session, read_params).await,
        ))
        .unwrap();
        assert_eq!(
            cli_read, direct_read,
            "CLI and direct Client independent raw connections"
        );
        assert_eq!(
            mcp_read, direct_read,
            "official MCP SDK independent raw connection"
        );
        assert!(!direct_read.has_more);
        assert!(
            direct_read
                .events
                .windows(2)
                .all(|pair| pair[0].event_seq.get() + 1 == pair[1].event_seq.get())
        );
        for read in [&cli_read, &direct_read, &mcp_read] {
            let mut intents = 0;
            let mut receipts = 0;
            for event in &read.events {
                assert_eq!(event.host_id, context.host_id);
                assert_eq!(event.instance_epoch, context.instance_epoch);
                assert_eq!(event.session_id, open.session_id);
                assert_eq!(event.session_epoch, open.session_epoch);
                match &event.payload {
                    RawPayload::TxIntent(intent) => {
                        intents += 1;
                        assert_eq!(intent.operation_id, tx.operation_id);
                        assert_eq!(intent.bytes_base64, receipt.bytes_base64);
                        assert_eq!(intent.byte_start, receipt.byte_start);
                        assert_eq!(intent.byte_end, receipt.byte_end);
                    }
                    RawPayload::Tx(value) => {
                        receipts += 1;
                        assert_eq!(
                            value.as_ref(),
                            receipt,
                            "full same-TX receipt including accepted/unknown ranges"
                        );
                    }
                    _ => {}
                }
            }
            assert_eq!(
                (intents, receipts),
                (1, 1),
                "exactly one business TX across the three entries"
            );
            assert_eq!(rx_bytes(&read.events), b"SAME\r\n");
        }

        let mcp_operation: OperationResult = serde_json::from_value(structured(
            tool(
                &peer,
                "swb_operation_x2E_get",
                &operation_target,
                json!({"operationId":tx.operation_id}),
            )
            .await,
        ))
        .unwrap();
        assert_eq!(
            mcp_operation.operation, tx,
            "MCP with current session read rights sees the full original CLI Operation"
        );
        auth.revoke(
            &operator,
            RevokeParams {
                actor_id: mcp_actor,
                permissions: vec!["content.read".into()],
                targets: vec![session.clone()],
            },
        )
        .unwrap();
        let denied = tool(
            &peer,
            "swb_operation_x2E_get",
            &operation_target,
            json!({"operationId":tx.operation_id}),
        )
        .await;
        assert_eq!(denied.is_error, Some(true));
        assert!(denied.structured_content.is_none());
        assert_eq!(denied.content.len(), 1);
        let error: HostError = serde_json::from_str(
            &denied.content[0]
                .as_text()
                .expect("MCP business error text")
                .text,
        )
        .unwrap();
        assert_eq!(
            error.code, "PERMISSION_DENIED",
            "MCP cannot read the retained TX Operation after session content.read is revoked"
        );

        let close = cli
            .invoke("session.close", &session, json!({}), &request_id())
            .await;
        let closed = cli.settled(&close).await;
        let Some(ActionResult::Session(closed)) = closed.result else {
            panic!("Expected session.close snapshot")
        };
        assert_eq!(closed.session_id, open.session_id);
        assert_eq!(closed.session_epoch, open.session_epoch);
        assert_eq!(closed.state, SessionState::Closed);
    });

    let mut failures = Vec::new();
    let setup = timeout(Duration::from_secs(30), sdk_receiver).await;
    let sdk = match setup {
        Ok(Ok(sdk)) => Some(sdk),
        Ok(Err(error)) => {
            failures.push(format!(
                "SDK setup task ended before cleanup handoff: {error}"
            ));
            None
        }
        Err(error) => {
            failures.push(format!("SDK setup timed out: {error}"));
            None
        }
    };
    if sdk.is_none() {
        checked.abort();
    }
    match timeout(Duration::from_secs(60), &mut checked).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => failures.push(format!("Parity assertions: {error}")),
        Err(_) => {
            checked.abort();
            let _ = checked.await;
            failures.push("Parity assertions timed out (task aborted and joined)".into());
        }
    }
    if let Some((sdk, mut stderr)) = sdk {
        match timeout(Duration::from_secs(12), sdk.cancel()).await {
            Ok(Ok(_)) => {}
            other => failures.push(format!("SDK child shutdown: {other:?}")),
        }
        match timeout(Duration::from_secs(5), &mut stderr).await {
            Ok(Ok(Ok(bytes))) if !bytes.is_empty() && !failures.is_empty() => {
                failures.push(format!("MCP stderr: {}", String::from_utf8_lossy(&bytes)))
            }
            Ok(Ok(Ok(_))) => {}
            other => {
                stderr.abort();
                let _ = stderr.await;
                failures.push(format!("MCP stderr drain: {other:?}"));
            }
        }
    }
    match timeout(Duration::from_secs(10), host.shutdown()).await {
        Ok(Ok(())) => {}
        other => failures.push(format!("Host shutdown: {other:?}")),
    }
    let _ = stop.send(());
    match timeout(Duration::from_secs(10), &mut running).await {
        Ok(Ok(Ok(()))) => {}
        other => {
            running.abort();
            let _ = running.await;
            failures.push(format!("Host server shutdown: {other:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
