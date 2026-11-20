use super::*;
use crate::host_bridge::DesktopAttachment;
use rmcp::{ServiceError, model::ErrorCode};
use serde_json::{Value, json};
use tokio::time::timeout;

const RUN: &str = "swb.reference.automation.run";
const MCP_RUN: &str = "swb_swb_x2E_reference_x2E_automation_x2E_run";

fn step(send: &[u8], expected: &[u8]) -> Value {
    json!({"sendBase64": STANDARD.encode(send), "expectBase64": STANDARD.encode(expected)})
}

async fn result(bridge: &DesktopHostBridge, client: &AttachResult, operation: Operation) -> Value {
    let operation = wait(bridge, client, operation).await;
    let Some(ActionResult::Reference(output)) = operation.result else {
        panic!("Missing automation result reference: {operation:?}");
    };
    let RpcResult::Query(QueryResult::FileRead(page)) = read_reference_raw(
        bridge,
        client,
        &resource_target(&output.result_ref),
        "file.read",
        json!({"fileRef": output.result_ref, "offset": "0", "maxBytes": "8192"}),
    )
    .await
    else {
        panic!("Missing automation result bytes");
    };
    decode_result(&page)
}

#[tokio::test]
#[ignore = "requires prepared Node, the signed automation receipt and same-source CLI/MCP"]
async fn native_automation_uses_exact_responses_and_keeps_capture_running() {
    let package = signed_reference("SWB_TEST_SIGNED_AUTOMATION_RECEIPT");
    with_embedded_host(async move |profile| {
        let bridge = DesktopHostBridge::new(profile.to_owned());
        let desktop = bridge.attach("main").await.unwrap();
        let client = &desktop.attachment;
        install_signed_reference(&bridge, &desktop, package, "swb.reference.automation").await;

        let opened = bridge
            .connect_device_intent(
                "main",
                desktop.generation,
                Id::try_from("virtual:echo").unwrap(),
                OpenParams { configuration: SerialConfiguration::default(), binding: None },
            )
            .await
            .unwrap();
        let session = Target {
            host_id: client.host_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
        };
        let capture_path = profile.join("automation-continuity.swbcap");
        let (capture, live, _) = start_reference_capture(&bridge, &desktop, &session, &capture_path).await;

        let matched = invoke(
            &bridge,
            client,
            &session,
            RUN,
            json!({"steps": [step(b"one\n", b"one\n"), step(b"two\n", b"two\n")]}),
            ExecutionMode::Independent,
        )
        .await;
        let output = result(&bridge, client, matched).await;
        assert_eq!(output["outcome"], "matched", "{output:?}");
        assert_eq!(output["completedSteps"], 2);
        let steps = output["attempted"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        for (step, (start, end)) in steps.iter().zip([("0", "4"), ("4", "8")]) {
            assert_eq!(step["outcome"], "matched");
            assert_eq!(step["source"]["sessionId"], session.id.as_str());
            assert_eq!(step["source"]["direction"], "rx");
            assert_eq!(step["source"]["byteStart"], start);
            assert_eq!(step["source"]["byteEnd"], end);
        }
        assert_ne!(steps[0]["operationId"], steps[1]["operationId"]);

        let mismatch = invoke(
            &bridge,
            client,
            &session,
            RUN,
            json!({"steps": [step(b"wrong\n", b"right\n"), step(b"never\n", b"never\n")]}),
            ExecutionMode::Independent,
        )
        .await;
        let output = result(&bridge, client, mismatch).await;
        assert_eq!(output["outcome"], "unexpected_response", "{output:?}");
        assert_eq!(output["completedSteps"], 0);
        assert_eq!(output["attempted"].as_array().unwrap().len(), 1);

        let timeout = invoke(
            &bridge,
            client,
            &session,
            RUN,
            json!({
                "responseTimeoutMs": 300,
                "steps": [step(b"wait\n", b"wait\nmore"), step(b"never\n", b"never\n")]
            }),
            ExecutionMode::Independent,
        )
        .await;
        let output = result(&bridge, client, timeout).await;
        assert_eq!(output["outcome"], "response_timeout", "{output:?}");
        assert_eq!(output["completedSteps"], 0);
        assert_eq!(output["attempted"].as_array().unwrap().len(), 1);

        let running = invoke(
            &bridge,
            client,
            &session,
            RUN,
            json!({
                "responseTimeoutMs": 5000,
                "steps": [step(b"cancel\n", b"cancel\nmore"), step(b"never\n", b"never\n")]
            }),
            ExecutionMode::Independent,
        )
        .await;
        wait_reference_rx_end(&bridge, client, &session, 26).await;
        let waiting = operation_snapshot(&bridge, client, &running.operation_id).await;
        assert_eq!(waiting.state, OperationState::Running, "{waiting:?}");
        let stop = invoke(
            &bridge,
            client,
            &Target {
                host_id: client.host_id.clone(),
                kind: ResourceKind::try_from("operation").unwrap(),
                id: running.operation_id.clone(),
                session_id: None,
                session_epoch: None,
            },
            "operation.cancel",
            json!({"reason":"user"}),
            ExecutionMode::Interactive,
        )
        .await;
        let request = wait(&bridge, client, stop).await;
        let Some(ActionResult::CancellationRequested(receipt)) = request.result else {
            panic!("Missing cancellation receipt: {request:?}");
        };
        assert_eq!(receipt.operation_id, running.operation_id);
        let cancelled = wait_terminal(&bridge, client, &running.operation_id).await;
        assert_eq!(cancelled.state, OperationState::Cancelled, "{cancelled:?}");
        assert_eq!(cancelled.error.as_ref().unwrap().code, "CANCELLED");
        assert!(cancelled.result.is_none());
        assert_eq!(cancelled.child_high_watermark.get(), 1);

        tx(&bridge, client, &session, b"after\n").await;
        let end = wait_reference_rx_end(&bridge, client, &session, 32).await;
        let stopped = invoke(
            &bridge,
            client,
            &resource_target(&live),
            "capture.stop",
            json!({"captureRef": live}),
            ExecutionMode::Interactive,
        )
        .await;
        wait(&bridge, client, stopped).await;
        let finalized = wait(&bridge, client, capture).await;
        let Some(ActionResult::CaptureStatus(finalized)) = finalized.result else {
            panic!("Missing automation capture receipt");
        };
        assert!(finalized.summary.source_continuous);
        assert!(finalized.summary.container_complete);
        let samples =
            terminal_capture::check(&capture_path, b"one\ntwo\nwrong\nwait\ncancel\nafter\n").unwrap();
        assert!(samples.report.source_continuous);
        assert!(samples.rx.iter().all(|sample| {
            sample.session_id == session.id && Some(sample.session_epoch) == session.session_epoch
        }));

        verify_public_automation(&bridge, &desktop, profile, &session, end.next_event_seq).await;
        eprintln!("reference_automation matched_steps=2 mismatch_stopped=true timeout_stopped=true cancellation_settled=true capture_rx_bytes=32 source_continuous=true mcp_step=true cli_same_result=true");
    })
    .await;
}

async fn verify_public_automation(
    bridge: &DesktopHostBridge,
    desktop: &DesktopAttachment,
    profile: &Path,
    session: &Target,
    start_event_seq: U64,
) {
    let mcp_id = Id::try_from("serial-workbench-mcp").unwrap();
    let cli_id = Id::try_from("serial-workbench-cli").unwrap();
    let mcp = HostClient::connect(ConnectOptions::new(
        profile.to_path_buf(),
        mcp_id.clone(),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    let cli = HostClient::connect(ConnectOptions::new(
        profile.to_path_buf(),
        cli_id.clone(),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    for (id, permissions) in [
        (
            &mcp_id,
            &["metadata.read", "content.read", "device.modify"][..],
        ),
        (&cli_id, &["content.read"][..]),
    ] {
        invoke_control(
            bridge,
            "main",
            desktop.generation,
            "auth.authorize",
            json!({
                "clientId":id,"permissions":permissions,"targets":[session]
            }),
        )
        .await
        .unwrap();
    }
    let mcp_actor = mcp.attachment().actor_id.clone();
    mcp.close().await.unwrap();
    cli.close().await.unwrap();

    let sdk = start_reference_mcp(profile).await;
    let reply = timeout(
        Duration::from_secs(10),
        parity_clients::tool_reply(
            sdk.peer(),
            MCP_RUN,
            session,
            json!({"startEventSeq":start_event_seq,"steps":[step(b"mcp\n", b"mcp\n")]}),
        ),
    )
    .await
    .expect("MCP automation admission timed out")
    .unwrap();
    let accepted: Operation = serde_json::from_value(parity_clients::structured(reply)).unwrap();
    assert_eq!(accepted.actor_id, mcp_actor);
    assert_eq!(&accepted.target, session);
    let settled = wait(bridge, &desktop.attachment, accepted).await;
    let Some(ActionResult::Reference(output)) = &settled.result else {
        panic!("Missing MCP automation result reference: {settled:?}");
    };
    assert_eq!(output.result_ref.kind.as_str(), "plugin_result");
    let target = resource_target(&output.result_ref);
    let params = json!({"fileRef":output.result_ref,"offset":"0","maxBytes":"8192"});
    let reply = timeout(
        Duration::from_secs(10),
        parity_clients::tool_reply(sdk.peer(), "swb_file_x2E_read", &target, params.clone()),
    )
    .await
    .expect("MCP result read timed out")
    .unwrap();
    invoke_control(
        bridge,
        "main",
        desktop.generation,
        "auth.revoke",
        json!({"actorId":mcp_actor,"permissions":["content.read"],"targets":[session]}),
    )
    .await
    .unwrap();
    let denied = timeout(
        Duration::from_secs(10),
        parity_clients::tool_reply(sdk.peer(), "swb_file_x2E_read", &target, params.clone()),
    )
    .await;
    timeout(Duration::from_secs(12), sdk.cancel())
        .await
        .expect("MCP cancellation timed out")
        .unwrap();
    assert!(matches!(
        denied.expect("MCP revoked result read timed out"),
        Err(ServiceError::McpError(error)) if error.code == ErrorCode::METHOD_NOT_FOUND
    ));
    let mcp_page: FileReadResult =
        serde_json::from_value(parity_clients::structured(reply)).unwrap();
    let cli = parity_clients::Cli {
        binary: parity_clients::binary("SWB_TEST_CLI_BIN", "serial-workbench-cli"),
        profile: profile.to_path_buf(),
    };
    let RpcResult::Query(QueryResult::FileRead(cli_page)) =
        success(cli.query_reply("file.read", &target, &params).await)
    else {
        panic!("Missing CLI automation result bytes");
    };
    assert_eq!(cli_page, mcp_page);
    let result = decode_result(&mcp_page);
    assert_eq!(result["outcome"], "matched");
    assert_eq!(result["completedSteps"], 1);
    let [attempt] = result["attempted"].as_array().unwrap().as_slice() else {
        panic!("Expected one MCP automation step: {result:?}");
    };
    assert_eq!(attempt["source"]["sessionId"], session.id.as_str());
    assert_eq!(attempt["source"]["direction"], "rx");
    assert_eq!(attempt["source"]["byteStart"], "32");
    assert_eq!(attempt["source"]["byteEnd"], "36");
}

fn decode_result(page: &FileReadResult) -> Value {
    assert!(page.at_end);
    serde_json::from_slice(&STANDARD.decode(page.bytes_base64.as_str()).unwrap()).unwrap()
}
