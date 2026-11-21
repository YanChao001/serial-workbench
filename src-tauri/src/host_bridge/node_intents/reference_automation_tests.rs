use super::*;
use crate::host_bridge::DesktopAttachment;
use rmcp::{ServiceError, model::ErrorCode};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;
use tokio::time::timeout;

const RUN: &str = "swb.reference.automation.run";
const MCP_RUN: &str = "swb_swb_x2E_reference_x2E_automation_x2E_run";
const CAPTURED_RX: &[u8] = b"one\ntwo\nwrong\nwait\nlate\nafter-late\ncancel\nqueued\nafter\n";
const PARITY_RX: &[u8] = b"mcp\n";
const BEFORE_LATE: u64 = b"one\ntwo\nwrong\nwait\n".len() as u64;
const LATE_RX: &[u8] = b"late\n";
const AFTER_LATE: &[u8] = b"after-late\n";
const RESPONSE_TIMEOUT_MS: u64 = 200;

struct DelayedEcho {
    inner: Box<dyn Transport>,
    allow_late: Arc<AtomicBool>,
    held: bool,
}

impl Transport for DelayedEcho {
    fn capabilities(&self) -> TransportCapabilities {
        self.inner.capabilities()
    }

    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        if self.held && !self.allow_late.load(Ordering::Acquire) {
            return Ok(ReadBlock {
                bytes: Arc::from([]),
                message: None,
            });
        }
        self.held = false;
        self.inner.read(limit, wait)
    }

    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        let hold = &*bytes == LATE_RX;
        let pending = self.inner.begin_write(bytes, wait, cancelled, closing)?;
        self.held |= hold;
        Ok(pending)
    }

    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        self.inner.configure(config)
    }

    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        self.inner.control(command)
    }

    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        self.inner.begin_drain(request)
    }

    fn close(&mut self) -> BackendResult<()> {
        self.inner.close()
    }
}

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
    let allow_late = Arc::new(AtomicBool::new(false));
    let gate = allow_late.clone();
    let open_virtual = DeviceService::virtual_opener();
    let opener: TransportOpener = Arc::new(move |id, config| {
        Ok(Box::new(DelayedEcho {
            inner: open_virtual(id, config)?,
            allow_late: gate.clone(),
            held: false,
        }))
    });
    with_embedded_opener(opener, async move |profile| {
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

        let timed_out = invoke(
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
        let output = result(&bridge, client, timed_out).await;
        assert_eq!(output["outcome"], "response_timeout", "{output:?}");
        assert_eq!(output["completedSteps"], 0);
        assert_eq!(output["attempted"].as_array().unwrap().len(), 1);

        let competing_mcp = start_reference_mcp(profile).await;
        invoke_control(
            &bridge,
            "main",
            desktop.generation,
            "auth.authorize",
            json!({"clientId":"serial-workbench-mcp","permissions":["metadata.read","device.modify"],"targets":[session]}),
        )
        .await
        .unwrap();
        let after_late_rx = verify_late_response(&bridge, client, &session, &competing_mcp, &allow_late).await;

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
        let partial_rx_end = after_late_rx + b"cancel\n".len() as u64;
        wait_reference_rx_end(&bridge, client, &session, partial_rx_end).await;
        let waiting = operation_snapshot(&bridge, client, &running.operation_id).await;
        assert_eq!(waiting.state, OperationState::Running, "{waiting:?}");
        let mut session_query = host_query(client, "session.get", json!({}));
        session_query.target = session.clone();
        let RpcResult::Query(QueryResult::Session(snapshot)) = success(
            bridge.request("main", RpcRequest::Query(session_query)).await.unwrap(),
        ) else {
            panic!("Missing exact serial session snapshot");
        };
        let lease = snapshot.lease.expect("Automation must hold a lease while awaiting RX");
        assert_eq!(lease.kind, LeaseKind::Transaction);
        assert_eq!(lease.state, LeaseState::Active);
        assert_eq!(lease.actor_id, waiting.actor_id);

        let queued = queue_mcp_write(&competing_mcp, &session, b"queued\n").await;
        assert_ne!(queued.actor_id, waiting.actor_id);
        assert_queued(&bridge, client, &session, &queued).await;
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
        assert_eq!(cancelled.child_high_watermark.get(), 2);

        wait_reference_rx_end(&bridge, client, &session, partial_rx_end + b"queued\n".len() as u64).await;
        timeout(Duration::from_secs(12), competing_mcp.cancel())
            .await.expect("Competing MCP did not exit").unwrap();
        tx(&bridge, client, &session, b"after\n").await;
        let end = wait_reference_rx_end(&bridge, client, &session, CAPTURED_RX.len() as u64).await;
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
        let samples = terminal_capture::check(&capture_path, CAPTURED_RX).unwrap();
        assert!(samples.report.source_continuous);
        assert!(samples.rx.iter().all(|sample| {
            sample.session_id == session.id && Some(sample.session_epoch) == session.session_epoch
        }));

        verify_public_automation(&bridge, &desktop, profile, &session, end.next_event_seq).await;
        eprintln!("reference_automation matched_steps=2 mismatch_stopped=true timeout_stopped=true late_reply_attributed=true cancellation_settled=true competing_mcp_after_release=true capture_rx_bytes={} source_continuous=true mcp_step=true cli_same_result=true", CAPTURED_RX.len());
    })
    .await;
}

async fn queue_mcp_write(
    mcp: &RunningService<RoleClient, ()>,
    session: &Target,
    bytes: &[u8],
) -> Operation {
    let reply = parity_clients::tool_reply(
        mcp.peer(),
        "swb_session_x2E_tx",
        session,
        json!({"bytesBase64":STANDARD.encode(bytes),"queueWaitMs":"15000","writeWaitMs":"5000"}),
    )
    .await
    .unwrap();
    serde_json::from_value(parity_clients::structured(reply)).unwrap()
}

async fn assert_queued(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    session: &Target,
    queued: &Operation,
) {
    let observed = wait_reference_source(bridge, client, session, |event| {
        matches!(&event.payload, RawPayload::TxIntent(intent) if intent.operation_id == queued.operation_id)
    })
    .await;
    assert!(!observed.events.iter().any(|event| {
        matches!(&event.payload, RawPayload::Tx(receipt) if receipt.operation_id == queued.operation_id)
    }));
}

async fn verify_late_response(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    session: &Target,
    mcp: &RunningService<RoleClient, ()>,
    allow_late: &AtomicBool,
) -> u64 {
    let late_run = invoke(
        bridge,
        client,
        session,
        RUN,
        json!({
            "responseTimeoutMs": RESPONSE_TIMEOUT_MS,
            "lateResponseWaitMs": 3000,
            "steps": [step(LATE_RX, LATE_RX), step(b"never\n", b"never\n")]
        }),
        ExecutionMode::Independent,
    )
    .await;
    let encoded = STANDARD.encode(LATE_RX);
    let matching_tx = |event: &RawEvent| matches!(&event.payload, RawPayload::Tx(receipt) if receipt.bytes_base64.as_str() == encoded && receipt.outcome == TxOutcome::Accepted);
    let initial = wait_reference_source(bridge, client, session, matching_tx).await;
    let tx = initial
        .events
        .iter()
        .find(|event| matching_tx(event))
        .unwrap();
    let RawPayload::Tx(receipt) = &tx.payload else {
        unreachable!()
    };
    let queued = queue_mcp_write(mcp, session, AFTER_LATE).await;
    assert_ne!(queued.actor_id, late_run.actor_id);
    assert_queued(bridge, client, session, &queued).await;
    // Sleep only to make the released device response late. The source clock
    // and exact ranges below prove the boundary independently of RPC delivery.
    tokio::time::sleep(Duration::from_millis(RESPONSE_TIMEOUT_MS + 50)).await;
    allow_late.store(true, Ordering::Release);

    let output = result(bridge, client, late_run).await;
    assert_eq!(output["outcome"], "response_timeout", "{output:?}");
    assert_eq!(output["completedSteps"], 0);
    let [attempt] = output["attempted"].as_array().unwrap().as_slice() else {
        panic!("Expected exactly one transmission: {output:?}");
    };
    assert_eq!(attempt["operationId"], receipt.operation_id.as_str());
    assert_eq!(attempt["outcome"], "response_timeout");
    assert!(attempt.get("source").is_none());
    let late: SourceRange = serde_json::from_value(attempt["lateResponse"].clone()).unwrap();
    assert_eq!(late.host_id, session.host_id);
    assert_eq!(late.session_id, session.id);
    assert_eq!(Some(late.session_epoch), session.session_epoch);
    assert_eq!(late.direction, Some(Direction::Rx));
    let byte_start = late.byte_start.expect("Missing first late RX byte").get();
    let byte_end = late.byte_end.expect("Missing late RX end offset").get();
    assert_eq!(byte_start, BEFORE_LATE);
    assert_eq!(byte_end, BEFORE_LATE + LATE_RX.len() as u64);

    let end = byte_end + AFTER_LATE.len() as u64;
    wait_reference_rx_end(bridge, client, session, end).await;
    let queued_written = |event: &RawEvent| matches!(&event.payload, RawPayload::Tx(receipt) if receipt.operation_id == queued.operation_id && receipt.outcome == TxOutcome::Accepted);
    let page = wait_reference_source(bridge, client, session, queued_written).await;
    let late_event = page
        .events
        .iter()
        .find(|event| event.event_seq == late.event_start)
        .unwrap();
    let RawPayload::Rx(rx) = &late_event.payload else {
        panic!("Expected delayed device RX")
    };
    assert_eq!(rx.bytes_base64.as_str(), encoded);
    assert_eq!(late.event_end.get(), late_event.event_seq.get() + 1);
    assert_eq!(late_event.time.clock_id, tx.time.clock_id);
    let elapsed_ns = late_event.time.source_mono_ns.get() - tx.time.source_mono_ns.get();
    assert!(elapsed_ns > RESPONSE_TIMEOUT_MS * 1_000_000);
    let competing = page
        .events
        .iter()
        .find(|event| queued_written(event))
        .unwrap();
    assert!(competing.event_seq > late_event.event_seq);
    eprintln!(
        "reference_automation_late_reply timeout_ms={RESPONSE_TIMEOUT_MS} elapsed_ns={elapsed_ns} byte_start={byte_start} byte_end={byte_end} tx_event={} rx_event={} competing_tx_event={}",
        tx.event_seq, late_event.event_seq, competing.event_seq
    );
    end
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
            json!({"startEventSeq":start_event_seq,"steps":[step(PARITY_RX, PARITY_RX)]}),
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
    assert_eq!(
        attempt["source"]["byteStart"],
        CAPTURED_RX.len().to_string()
    );
    assert_eq!(
        attempt["source"]["byteEnd"],
        (CAPTURED_RX.len() + PARITY_RX.len()).to_string()
    );
}

fn decode_result(page: &FileReadResult) -> Value {
    assert!(page.at_end);
    serde_json::from_slice(&STANDARD.decode(page.bytes_base64.as_str()).unwrap()).unwrap()
}
