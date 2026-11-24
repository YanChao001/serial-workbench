use super::*;
use crate::host_bridge::DesktopAttachment;
use rmcp::{ServiceError, model::ErrorCode};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use tokio::time::timeout;

#[path = "reference_automation_long_script.rs"]
mod long_script;

const RUN: &str = "swb.reference.automation.run";
const REPEAT: &str = "swb.reference.automation.repeat";
const MCP_RUN: &str = "swb_swb_x2E_reference_x2E_automation_x2E_run";
const CAPTURED_RX: &[u8] = b"one\ntwo\nwrong\nwait\nlate\nafter-late\ncancel\nqueued\nafter\n";
const PARITY_RX: &[u8] = b"mcp\n";
const BEFORE_LATE: u64 = b"one\ntwo\nwrong\nwait\n".len() as u64;
const LATE_RX: &[u8] = b"late\n";
const AFTER_LATE: &[u8] = b"after-late\n";
const RESPONSE_TIMEOUT_MS: u64 = 200;
const MODBUS: &str = "swb.reference.automation.modbus";
const MODBUS_REQUEST: &[u8] = &[0, 7, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1];
const MODBUS_LATE_REQUEST: &[u8] = &[0, 8, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1];
const MODBUS_REPLY: &[u8] = &[0, 7, 0, 0, 0, 5, 1, 3, 2, 0x12, 0x34];
const MODBUS_FOREIGN_REPLY: &[u8] = &[0, 9, 0, 0, 0, 5, 1, 3, 2, 0x12, 0x34];
const MODBUS_LATE_REPLY: &[u8] = &[0, 8, 0, 0, 0, 3, 1, 0x83, 2];
const MODBUS_RETRY_START: &[u8] = &[0xff, 0xff, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1];
const MODBUS_RETRY_NEXT: &[u8] = &[0, 0, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1];
const MODBUS_STALE_REPLY: &[u8] = &[0xff, 0xff, 0, 0, 0, 5, 1, 3, 2, 0x12, 0x34];
const MODBUS_RETRY_REPLY: &[u8] = &[0, 0, 0, 0, 0, 5, 1, 3, 2, 0x12, 0x34];

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

struct ModbusPeer {
    inner: Box<dyn Transport>,
    chunks: VecDeque<(std::time::Instant, Arc<[u8]>)>,
    first_attempt_dropped: bool,
}

impl Transport for ModbusPeer {
    fn capabilities(&self) -> TransportCapabilities {
        self.inner.capabilities()
    }

    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        let empty = || ReadBlock {
            bytes: Arc::from([]),
            message: None,
        };
        if let Some((due, _)) = self.chunks.front() {
            std::thread::sleep(
                due.saturating_duration_since(std::time::Instant::now())
                    .min(wait),
            );
            return Ok(if *due <= std::time::Instant::now() {
                let (_, bytes) = self.chunks.pop_front().unwrap();
                assert!(bytes.len() <= limit);
                ReadBlock {
                    bytes,
                    message: None,
                }
            } else {
                empty()
            });
        }
        let echoed = self.inner.read(limit, wait)?;
        let now = std::time::Instant::now();
        if echoed.bytes.as_ref() == MODBUS_REQUEST {
            let mixed = [MODBUS_FOREIGN_REPLY, &MODBUS_REPLY[..3]].concat();
            self.chunks
                .push_back((now + Duration::from_millis(20), Arc::from(mixed)));
            self.chunks.push_back((
                now + Duration::from_millis(40),
                Arc::from(&MODBUS_REPLY[3..]),
            ));
        } else if echoed.bytes.as_ref() == MODBUS_LATE_REQUEST {
            self.chunks.push_back((
                now + Duration::from_millis(180),
                Arc::from(MODBUS_LATE_REPLY),
            ));
        } else if echoed.bytes.as_ref() == MODBUS_RETRY_START {
            assert!(
                !self.first_attempt_dropped,
                "TCP retry reused the previous ID"
            );
            self.first_attempt_dropped = true;
        } else if echoed.bytes.as_ref() == MODBUS_RETRY_NEXT {
            assert!(std::mem::take(&mut self.first_attempt_dropped));
            let mixed = [MODBUS_STALE_REPLY, MODBUS_RETRY_REPLY].concat();
            self.chunks
                .push_back((now + Duration::from_millis(20), Arc::from(mixed)));
        } else {
            assert!(
                echoed.bytes.is_empty(),
                "Virtual peer received an unexpected request"
            );
        }
        Ok(empty())
    }

    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        self.inner.begin_write(bytes, wait, cancelled, closing)
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
#[ignore = "requires prepared Node and the signed automation receipt"]
async fn native_automation_modbus_matches_owned_tx_and_reports_a_late_exception() {
    let package = signed_reference("SWB_TEST_SIGNED_AUTOMATION_RECEIPT");
    let open_virtual = DeviceService::virtual_opener();
    let opener: TransportOpener = Arc::new(move |id, config| {
        Ok(Box::new(ModbusPeer {
            inner: open_virtual(id, config)?,
            chunks: VecDeque::new(),
            first_attempt_dropped: false,
        }))
    });
    with_embedded_opener(opener, async move |profile| {
        let bridge = DesktopHostBridge::new(profile.to_owned());
        let desktop = bridge.attach("main").await.unwrap();
        let client = &desktop.attachment;
        install_signed_reference(&bridge, &desktop, package, "swb.reference.automation").await;
        let opened = bridge.connect_device_intent(
            "main", desktop.generation, Id::try_from("virtual:echo").unwrap(),
            OpenParams { transport_params: None, configuration: SerialConfiguration::default(), binding: None },
        ).await.unwrap();
        let session = Target {
            host_id: client.host_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
        };
        let first = invoke(
            &bridge, client, &session, MODBUS,
            json!({"transport":"tcp", "requestBase64":STANDARD.encode(MODBUS_REQUEST), "includeTrace":true}),
            ExecutionMode::Independent,
        ).await;
        let matched = result(&bridge, client, first).await;
        assert_eq!(matched["outcome"], "matched", "{matched:?}");
        assert_eq!(matched["ignoredFrames"], 1);
        assert_eq!(matched["response"]["bytesBase64"], STANDARD.encode(MODBUS_REPLY));
        assert_eq!(matched["response"]["source"]["byteStart"], "11");
        assert_eq!(matched["response"]["source"]["byteEnd"], "22");
        let matched_trace = &matched["attempts"][0]["trace"];
        assert_eq!(matched_trace["tx"]["clockId"], matched_trace["rxFirst"]["clockId"]);
        assert_eq!(matched_trace["rxFirst"]["eventSeq"], matched["response"]["source"]["eventStart"]);
        assert_ne!(matched_trace["rxFirst"]["eventSeq"], matched_trace["rxLast"]["eventSeq"]);
        assert!(matched["response"]["timing"]["elapsedNs"].as_str().unwrap().parse::<u64>().unwrap() > 0);
        assert!(matched["response"]["timing"]["rxPrecision"]["source"].is_string());

        let second = invoke(
            &bridge, client, &session, MODBUS,
            json!({
                "transport":"tcp", "requestBase64":STANDARD.encode(MODBUS_LATE_REQUEST),
                "responseTimeoutMs": 50, "lateResponseWaitMs": 3000, "retryLimit": 1,
            }),
            ExecutionMode::Independent,
        ).await;
        let late = result(&bridge, client, second).await;
        assert_eq!(late["outcome"], "response_timeout", "{late:?}");
        assert_ne!(late["operationId"], matched["operationId"]);
        assert!(late.get("response").is_none());
        assert_eq!(late["lateResponse"]["exceptionCode"], 2);
        assert_eq!(late["lateResponse"]["bytesBase64"], STANDARD.encode(MODBUS_LATE_REPLY));
        assert_eq!(late["lateResponse"]["source"]["byteStart"], "22");
        assert_eq!(late["lateResponse"]["source"]["byteEnd"], "31");
        assert!(late["lateResponse"]["timing"]["elapsedNs"].as_str().unwrap().parse::<u64>().unwrap() > 50_000_000);
        assert_eq!(late["attempts"].as_array().unwrap().len(), 1);
        eprintln!("modbus_transaction coalesced_foreign_frames=1 matched_rx_range=11..22 late_exception=2 late_rx_range=22..31");

        let third = invoke(
            &bridge, client, &session, MODBUS,
            json!({
                "transport":"tcp", "requestBase64":STANDARD.encode(MODBUS_RETRY_START),
                "responseTimeoutMs": 400, "retryLimit": 1, "includeTrace":true,
            }),
            ExecutionMode::Independent,
        ).await;
        let retried = result(&bridge, client, third).await;
        assert_eq!(retried["outcome"], "matched", "{retried:?}");
        let attempts = retried["attempts"].as_array().unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0]["outcome"], "response_timeout");
        assert_eq!(attempts[0]["requestTransactionId"], 65535);
        assert!(attempts[0]["trace"]["tx"]["eventSeq"].is_string());
        assert!(attempts[0]["trace"].get("rxFirst").is_none());
        assert_eq!(attempts[1]["requestTransactionId"], 0);
        assert_eq!(attempts[1]["ignoredFrames"], 1);
        assert_ne!(attempts[0]["operationId"], attempts[1]["operationId"]);
        assert_eq!(retried["operationId"], attempts[1]["operationId"]);
        assert_eq!(retried["response"]["bytesBase64"], STANDARD.encode(MODBUS_RETRY_REPLY));
        assert_eq!(retried["response"]["source"]["byteStart"], "42");
        assert_eq!(retried["response"]["source"]["byteEnd"], "53");
        assert_eq!(attempts[1]["trace"]["rxLast"]["monoNs"], retried["response"]["timing"]["rxMonoNs"]);
        eprintln!("modbus_retry attempts=2 transaction_ids=65535,0 stale_frames=1 matched_rx_range=42..53");
    }).await;
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
                OpenParams { transport_params: None, configuration: SerialConfiguration::default(), binding: None },
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
        let capture_start = automation_source_position(&bridge, client, &session).await;
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
        let final_tx = submit_tx(&bridge, client, &session, b"after\n").await;
        let end = wait_automation_capture(
            &bridge,
            client,
            &session,
            &live,
            capture_start,
            &final_tx,
            CAPTURED_RX.len() as u64,
        )
        .await;
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
        verify_repeat_send(&bridge, client, &session).await;
        verify_command_sequence(&bridge, client, &session).await;
        eprintln!("reference_automation matched_steps=2 mismatch_stopped=true timeout_stopped=true late_reply_attributed=true cancellation_settled=true competing_mcp_after_release=true capture_rx_bytes={} source_continuous=true mcp_step=true cli_same_result=true", CAPTURED_RX.len());
    })
    .await;
}

async fn verify_repeat_send(bridge: &DesktopHostBridge, client: &AttachResult, session: &Target) {
    let bytes = STANDARD.encode(b"repeat\n");
    let mut params = json!({
        "sendBase64": bytes,
        "expectBase64": bytes,
        "periodMs": 150,
        "jitterMs": 10,
        "startDelayMs": 20,
        "count": 3
    });
    let repeat = invoke(
        bridge,
        client,
        session,
        REPEAT,
        params.clone(),
        ExecutionMode::Independent,
    )
    .await;
    let complete = result(bridge, client, repeat).await;
    assert_eq!(complete["outcome"], "completed", "{complete:?}");
    assert_eq!(complete["completed"], 3);
    let attempts = complete["attempted"].as_array().unwrap();
    assert_eq!(attempts.len(), 3);
    assert_eq!(attempts[0]["scheduledMs"], 0);
    for attempt in attempts {
        assert_eq!(attempt["outcome"], "matched", "{complete:?}");
        let operation_id = Id::try_from(attempt["operationId"].as_str().unwrap()).unwrap();
        let tx = wait_terminal(bridge, client, &operation_id).await;
        let Some(ActionResult::Tx(receipt)) = tx.result else {
            panic!("Missing repeat-send TX receipt: {tx:?}");
        };
        assert_eq!(receipt.outcome, TxOutcome::Accepted);
        assert_eq!(receipt.bytes_base64.as_str(), bytes);
        assert_eq!(Some(receipt.session_epoch), session.session_epoch);
    }
    let schedule = attempts
        .iter()
        .map(|attempt| attempt["scheduledMs"].as_u64().unwrap())
        .collect::<Vec<_>>();
    assert!(schedule.windows(2).all(|pair| pair[1] - pair[0] >= 130));

    params["stopOnBase64"] = json!(bytes);
    let stop = invoke(
        bridge,
        client,
        session,
        REPEAT,
        params,
        ExecutionMode::Independent,
    )
    .await;
    let stopped = result(bridge, client, stop).await;
    assert_eq!(stopped["outcome"], "stop_condition", "{stopped:?}");
    assert_eq!(stopped["attempted"].as_array().unwrap().len(), 1);
    assert_eq!(stopped["attempted"][0]["outcome"], "stop_condition");
    eprintln!("reference_repeat_send complete_tx=3 exact_responses=true stop_condition_tx=1");
}

async fn verify_command_sequence(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    session: &Target,
) {
    const ACTION: &str = "swb.reference.automation.sequence";
    let run = |definition: serde_json::Value| async move {
        let after = automation_source_position(bridge, client, session).await;
        let start_event_seq = after.get().checked_add(1).unwrap().to_string();
        let operation = invoke(
            bridge,
            client,
            session,
            ACTION,
            json!({"definition":definition.to_string(),"startEventSeq":start_event_seq}),
            ExecutionMode::Independent,
        )
        .await;
        result(bridge, client, operation).await
    };
    let report = run(json!({
        "version": 1,
        "variables": {"probe":"51"},
        "steps": [{
            "kind":"send", "hex":"${probe} 0A",
            "expect":{"hex":"51 0A","onMatch":[{"kind":"send","hex":"52 0A","expect":{"hex":"52 0A"}}]}
        }]
    })).await;
    assert_eq!(report["outcome"], "completed", "{report}");
    assert_eq!(report["completedSteps"], 2);
    let attempts = report["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    for (attempt, bytes) in attempts.iter().zip([b"Q\n", b"R\n"]) {
        assert_eq!(attempt["outcome"], "matched", "{report}");
        let source = &attempt["source"];
        assert_eq!(source["sessionId"], session.id.as_str());
        assert_eq!(source["direction"], "rx");
        let start = source["byteStart"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let end = source["byteEnd"].as_str().unwrap().parse::<u64>().unwrap();
        assert_eq!(end - start, bytes.len() as u64);
        let operation_id = Id::try_from(attempt["operationId"].as_str().unwrap()).unwrap();
        let tx = wait_terminal(bridge, client, &operation_id).await;
        let Some(ActionResult::Tx(receipt)) = tx.result else {
            panic!("Missing command-sequence TX: {tx:?}");
        };
        assert_eq!(receipt.outcome, TxOutcome::Accepted);
        assert_eq!(receipt.bytes_base64.as_str(), STANDARD.encode(bytes));
        assert_eq!(Some(receipt.session_epoch), session.session_epoch);
    }
    let timeout = run(json!({
        "version": 1,
        "steps": [{
            "kind":"send","hex":"57 0A",
            "expect":{"hex":"57 0A 45","timeoutMs":100,"onTimeout":[{"kind":"send","hex":"46 0A"}]}
        },{"kind":"send","hex":"4E 0A"}]
    }))
    .await;
    assert_eq!(timeout["outcome"], "response_timeout", "{timeout}");
    assert_eq!(timeout["stoppedAt"], "$.steps[0]");
    let attempts = timeout["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0]["outcome"], "response_timeout");
    assert_eq!(attempts[1]["outcome"], "written");
    assert_eq!(attempts[1]["path"], "$.steps[0].expect.onTimeout[0]");
    eprintln!(
        "reference_command_sequence confirmed_responses=2 timeout_fallback=1 later_step_stopped=true"
    );
}

async fn automation_source_position(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    session: &Target,
) -> U64 {
    let RpcResult::Query(QueryResult::StreamCursor(position)) =
        read_reference_raw(bridge, client, session, "stream.cursor", json!({})).await
    else {
        panic!("Missing automation recording start cursor");
    };
    position.cursor.position
}

async fn wait_automation_capture(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    session: &Target,
    live: &ObjectRef,
    capture_start: U64,
    final_tx: &TxReceipt,
    rx_end: u64,
) -> StreamReadResult {
    assert_eq!(final_tx.outcome, TxOutcome::Accepted, "{final_tx:?}");
    let end = wait_reference_page(bridge, client, session, |page| {
        page.events.iter().any(|event| {
            matches!(&event.payload, RawPayload::Rx(rx) if rx.byte_end.get() == rx_end)
        }) && page.events.iter().any(|event| {
            matches!(&event.payload, RawPayload::Tx(receipt) if receipt.operation_id == final_tx.operation_id)
        })
    })
    .await;
    // 单会话录制从启动游标之后开始。源读者已看到的事件仍需由录制读者写入。
    let required = end
        .next_event_seq
        .get()
        .checked_sub(1)
        .and_then(|last| last.checked_sub(capture_start.get()))
        .expect("Automation source cursor moved backwards");
    let target = resource_target(live);
    let mut written = 0;
    timeout(Duration::from_secs(5), async {
        loop {
            let mut request = host_query(client, "capture.status", json!({"captureRef":live}));
            request.target = target.clone();
            let RpcResult::Query(QueryResult::CaptureStatus(status)) = success(
                bridge
                    .request("main", RpcRequest::Query(request))
                    .await
                    .unwrap(),
            ) else {
                panic!("Missing automation capture status");
            };
            assert_eq!(status.summary.state, CaptureState::Recording, "{status:?}");
            written = status.summary.watermarks.written.get();
            if written >= required {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Automation capture wrote {written} of {required} source records"));
    eprintln!(
        "reference_automation_capture_ready source_records={required} written_records={written}"
    );
    end
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

async fn authorize_automation_clients(
    bridge: &DesktopHostBridge,
    desktop: &DesktopAttachment,
    profile: &Path,
    session: &Target,
) -> Id {
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
    mcp_actor
}

async fn verify_public_automation(
    bridge: &DesktopHostBridge,
    desktop: &DesktopAttachment,
    profile: &Path,
    session: &Target,
    start_event_seq: U64,
) {
    let mcp_actor = authorize_automation_clients(bridge, desktop, profile, session).await;
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
