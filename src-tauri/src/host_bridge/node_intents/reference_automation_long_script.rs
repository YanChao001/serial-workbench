use super::*;
use rmcp::model::CallToolRequestParams;
use std::collections::BTreeSet;

const ROUNDS: usize = 6;
const FRAMES: [&[u8]; 2] = [b"ping\0\n", b"\xffpong\n"];
const CANCEL_FRAME: &[u8] = b"cancel\n";
const AFTER_CANCEL: &[u8] = b"still-open\n";

#[tokio::test]
#[ignore = "requires prepared Node, the signed automation receipt and same-source CLI/MCP"]
async fn native_automation_long_script_survives_caller_disconnect_and_settles_workers() {
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
                OpenParams {
                    configuration: SerialConfiguration::default(),
                    binding: None,
                    transport_params: None,
                },
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
        let capture_path = profile.join("automation-long-script.swbcap");
        let capture_start = automation_source_position(&bridge, client, &session).await;
        let (capture, live, _) =
            start_reference_capture(&bridge, &desktop, &session, &capture_path).await;
        let mcp_actor = authorize_automation_clients(&bridge, &desktop, profile, &session).await;
        let sdk = start_reference_mcp(profile).await;
        let launch = tokio::time::Instant::now();
        let started = run_script(&sdk, &session, 1.into(), &FRAMES).await;
        assert_eq!(started.actor_id, mcp_actor);
        assert_eq!(started.execution_mode, ExecutionMode::Independent);
        assert_eq!(started.target, session);
        wait_checkpoint(&bridge, client, &started, FRAMES.len() as u64).await;
        timeout(Duration::from_secs(12), sdk.cancel())
            .await
            .expect("Initiating MCP did not exit")
            .unwrap();
        let disconnected = operation_snapshot(&bridge, client, &started.operation_id).await;
        assert_eq!(disconnected.state, OperationState::Running);
        let disconnected_steps = disconnected.progress.unwrap().completed.get();
        let advanced = wait_checkpoint(&bridge, client, &started, disconnected_steps + 1).await;
        let advanced_steps = advanced.progress.unwrap().completed.get();
        let sdk = start_reference_mcp(profile).await;
        let settled = wait(&bridge, client, started).await;
        let elapsed_ms = launch.elapsed().as_millis();
        assert_workers_reaped(&settled);
        let progress = settled.progress.as_ref().unwrap();
        let steps = (ROUNDS * FRAMES.len()) as u64;
        assert_eq!(progress.completed.get(), steps);
        assert_eq!(progress.total, Some(steps.into()));
        assert_eq!(progress.unit, "steps");
        assert_eq!(settled.child_high_watermark.get(), steps * 3);
        let result = read_result_from_reattached_clients(&sdk, profile, &settled).await;
        assert_eq!(result["outcome"], "matched");
        assert_eq!(result["completedSteps"], steps);
        let attempts = result["attempted"].as_array().unwrap();
        assert_eq!(attempts.len() as u64, steps);
        let mut child_ids = BTreeSet::new();
        let mut rx_end = 0;
        for (attempt, frame) in attempts.iter().zip(FRAMES.iter().cycle()) {
            assert_eq!(attempt["outcome"], "matched");
            assert!(child_ids.insert(attempt["operationId"].as_str().unwrap()));
            let source: SourceRange = serde_json::from_value(attempt["source"].clone()).unwrap();
            assert_eq!(source.host_id, session.host_id);
            assert_eq!(source.session_id, session.id);
            assert_eq!(Some(source.session_epoch), session.session_epoch);
            assert_eq!(source.direction, Some(Direction::Rx));
            assert_eq!(source.byte_start, Some(rx_end.into()));
            rx_end += frame.len() as u64;
            assert_eq!(source.byte_end, Some(rx_end.into()));
        }
        let end = wait_reference_rx_end(&bridge, client, &session, rx_end).await;

        let cancelled = run_script(&sdk, &session, end.next_event_seq, &[CANCEL_FRAME]).await;
        assert_eq!(cancelled.actor_id, mcp_actor);
        wait_checkpoint(&bridge, client, &cancelled, 1).await;
        let target = Target {
            host_id: session.host_id.clone(),
            kind: ResourceKind::try_from("operation").unwrap(),
            id: cancelled.operation_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let reply = timeout(
            Duration::from_secs(10),
            parity_clients::tool_reply(
                sdk.peer(),
                "swb_operation_x2E_cancel",
                &target,
                json!({"reason":"user"}),
            ),
        )
        .await
        .expect("MCP script cancellation admission timed out")
        .unwrap();
        let request = wait(
            &bridge,
            client,
            serde_json::from_value(parity_clients::structured(reply)).unwrap(),
        )
        .await;
        let Some(ActionResult::CancellationRequested(receipt)) = request.result else {
            panic!("Missing cancellation receipt: {request:?}");
        };
        assert_eq!(receipt.operation_id, cancelled.operation_id);
        let cancelled = wait_terminal(&bridge, client, &cancelled.operation_id).await;
        assert_eq!(cancelled.state, OperationState::Cancelled, "{cancelled:?}");
        assert_eq!(cancelled.error.as_ref().unwrap().code, "CANCELLED");
        assert!(cancelled.result.is_none());
        assert_eq!(cancelled.child_high_watermark.get(), 3);
        assert_eq!(cancelled.progress.as_ref().unwrap().completed.get(), 1);
        assert_workers_reaped(&cancelled);
        timeout(Duration::from_secs(12), sdk.cancel())
            .await
            .expect("Reattached MCP did not exit")
            .unwrap();

        let final_tx = submit_tx(&bridge, client, &session, AFTER_CANCEL).await;
        let mut expected_rx = FRAMES.concat().repeat(ROUNDS);
        expected_rx.extend_from_slice(CANCEL_FRAME);
        expected_rx.extend_from_slice(AFTER_CANCEL);
        wait_automation_capture(
            &bridge,
            client,
            &session,
            &live,
            capture_start,
            &final_tx,
            expected_rx.len() as u64,
        )
        .await;
        let stopped = invoke(
            &bridge,
            client,
            &resource_target(&live),
            "capture.stop",
            json!({"captureRef":live}),
            ExecutionMode::Interactive,
        )
        .await;
        wait(&bridge, client, stopped).await;
        let finalized = wait(&bridge, client, capture).await;
        let Some(ActionResult::CaptureStatus(finalized)) = finalized.result else {
            panic!("Missing completed script capture receipt");
        };
        assert!(finalized.summary.source_continuous && finalized.summary.container_complete);
        let samples = terminal_capture::check(&capture_path, &expected_rx).unwrap();
        assert!(samples.report.source_continuous);
        assert!(samples.rx.iter().all(|sample| {
            sample.session_id == session.id && Some(sample.session_epoch) == session.session_epoch
        }));
        eprintln!(
            "reference_automation_long_script rounds={ROUNDS} elapsed_ms={elapsed_ms} completed_steps={steps} steps_at_caller_exit={disconnected_steps} steps_before_reattach={advanced_steps} cancelled_after_steps=1 live_workers_at_terminals=0 child_receipts={} capture_rx_bytes={} same_cli_mcp_result=true",
            child_ids.len(),
            expected_rx.len()
        );
    })
    .await;
}

async fn run_script(
    sdk: &RunningService<RoleClient, ()>,
    session: &Target,
    start_event_seq: U64,
    frames: &[&[u8]],
) -> Operation {
    let steps: Vec<Value> = frames.iter().map(|frame| step(frame, frame)).collect();
    let request = CallToolRequestParams::new(MCP_RUN.to_owned()).with_arguments(
        json!({
            "target": session,
            "executionMode": "independent",
            "params": {"startEventSeq": start_event_seq, "rounds": ROUNDS, "steps": steps}
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let reply = timeout(Duration::from_secs(10), sdk.peer().call_tool(request))
        .await
        .expect("MCP script admission timed out")
        .unwrap();
    serde_json::from_value(parity_clients::structured(reply)).unwrap()
}

async fn wait_checkpoint(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    operation: &Operation,
    min_steps: u64,
) -> Operation {
    timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = operation_snapshot(bridge, client, &operation.operation_id).await;
            assert!(!snapshot.state.is_terminal(), "{snapshot:?}");
            if snapshot
                .progress
                .as_ref()
                .is_some_and(|progress| progress.completed.get() >= min_steps)
                && snapshot
                    .worker_observation
                    .as_ref()
                    .is_some_and(|workers| workers.live_workers.get() == 1)
            {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("Script did not reach the next live worker checkpoint")
}

fn assert_workers_reaped(operation: &Operation) {
    let workers = operation.worker_observation.as_ref().unwrap();
    assert_eq!(workers.peak_workers.get(), 1);
    assert_eq!(workers.live_workers.get(), 0);
}

async fn read_result_from_reattached_clients(
    sdk: &RunningService<RoleClient, ()>,
    profile: &Path,
    operation: &Operation,
) -> Value {
    let Some(ActionResult::Reference(output)) = &operation.result else {
        panic!("Missing script result reference: {operation:?}");
    };
    let target = resource_target(&output.result_ref);
    let params = json!({"fileRef":output.result_ref,"offset":"0","maxBytes":"8192"});
    let reply = timeout(
        Duration::from_secs(10),
        parity_clients::tool_reply(sdk.peer(), "swb_file_x2E_read", &target, params.clone()),
    )
    .await
    .expect("Reattached MCP result read timed out")
    .unwrap();
    let mcp_page: FileReadResult =
        serde_json::from_value(parity_clients::structured(reply)).unwrap();
    let cli = parity_clients::Cli {
        binary: parity_clients::binary("SWB_TEST_CLI_BIN", "serial-workbench-cli"),
        profile: profile.to_path_buf(),
    };
    let RpcResult::Query(QueryResult::FileRead(cli_page)) =
        success(cli.query_reply("file.read", &target, &params).await)
    else {
        panic!("Missing CLI script result");
    };
    assert_eq!(cli_page, mcp_page);
    decode_result(&mcp_page)
}
