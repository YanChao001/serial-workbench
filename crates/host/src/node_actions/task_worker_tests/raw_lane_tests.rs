use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_raw_lane_bounds_reads_preserves_control_and_capture() {
    let markers = support::Profile::isolated("host-node-backend-task-raw-");
    let events = markers.path().join("raw.events");
    let source = RAW_PLUGIN.replace("__EVENTS__", &serde_json::to_string(&events).unwrap());
    let mut spec = node_host_actions::spec();
    spec.target_kinds = ["host", "session"]
        .map(|kind| ResourceKind::try_from(kind).unwrap())
        .into();
    spec.permissions = vec!["metadata.read".into(), "content.read".into()];
    spec.input_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "sessionId":{"type":"string"},
            "sessionEpoch":{"type":"string"},
            "operationId":{"type":"string"},
            "mode":{"enum":["pressure","scope","cancel"]}
        },
        "required":["sessionId","sessionEpoch","operationId","mode"],
        "additionalProperties":false
    }))
    .unwrap();
    spec.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = node_host_actions::Fixture::program_with_virtual(spec, source.as_bytes()).await;
    let mut capture = capture_tests::CaptureProbe::start(&fixture).await;
    let session = capture.session().clone();
    let input = capture.phase(&fixture, b"raw-before-hold").await;
    let call = |mode: &str, target: &Target| {
        fixture.call(
        &fixture.client, target, "example.terminal.compute",
        json!({"mode": mode, "sessionId":session.id, "sessionEpoch":session.session_epoch, "operationId":input}),
    )
    };

    let gates = &fixture.host.inner.node_test_gates;
    let mut held = gates.task_raw_read_ready.arm();
    let running = fixture
        .invoke(&fixture.client, call("pressure", &fixture.target))
        .await;
    held.entered().await;
    wait_worker_event(&events, "control:succeeded:HOST_BUSY", 1).await;
    assert!(!read_events(&events).contains("pages-finished"));
    capture.phase(&fixture, b"raw-during-hold").await;
    held.release();
    let completed = fixture.wait(&fixture.client, &running.operation_id).await;
    assert_eq!(completed.state, OperationState::Succeeded, "{completed:?}");
    let result = fixture.result(&fixture.client, &completed).await;
    let pages: Vec<String> = serde_json::from_value(result["pages"].clone()).unwrap();
    assert_eq!(pages.len(), 4);
    assert!(pages.iter().all(|page| page.starts_with("raw-before-hold")));
    assert!(pages.iter().any(|page| page == "raw-before-hold"));

    let exact = fixture
        .invoke(&fixture.client, call("scope", &session))
        .await;
    let exact = fixture.wait(&fixture.client, &exact.operation_id).await;
    assert_eq!(exact.state, OperationState::Succeeded, "{exact:?}");
    assert_eq!(
        fixture.result(&fixture.client, &exact).await,
        json!({
            "wrongEpoch": "PERMISSION_DENIED",
            "missingParams": "INVALID_ARGUMENT",
            "exact": "raw-before-holdraw-during-hold",
        })
    );

    let baseline = fixture.host.streams().memory_usage().reader_bytes;
    let mut held = gates.task_raw_read_ready.arm();
    let cancelled = fixture
        .invoke(&fixture.client, call("cancel", &fixture.target))
        .await;
    held.entered().await;
    let reserved = fixture.host.streams().memory_usage().reader_bytes;
    assert!(reserved >= baseline + 32768);
    cancel_worker_task(&fixture, &cancelled).await;
    let terminal = worker_terminal(&fixture, &cancelled).await.unwrap();
    assert_eq!(terminal.state, OperationState::Cancelled, "{terminal:?}");
    assert!(read_events(&events).contains("read-cancelled"));
    assert!(!read_events(&events).contains("late-value"));
    assert!(fixture.host.streams().memory_usage().reader_bytes >= reserved);
    held.release();
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.host.streams().memory_usage().reader_bytes >= reserved {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Actual Raw work did not return its memory");

    capture.phase(&fixture, b"raw-after-cancel").await;
    capture.finish(&fixture).await;
    let _profile = fixture.finish().await;
    eprintln!(
        "task_raw_lane pending=4 raw_overflow=HOST_BUSY control_while_raw_held=true same_epoch_capture=true cancel_while_raw_held=true"
    );
}

const RAW_PLUGIN: &str = r#"
import { appendFileSync } from "node:fs";
const event = (line) => appendFileSync(__EVENTS__, line + "\n");
const rx = (page) => Buffer.concat(page.events.filter((e) => e.kind === "rx")
  .map((e) => Buffer.from(e.payload.bytesBase64, "base64"))).toString();
const code = (promise) => promise.then(() => "UNEXPECTED_VALUE", (error) => error.code);
export function register(context) {
  context.actions.register("example.terminal.compute", async (call, task) => {
    const {sessionId, sessionEpoch, operationId, mode} = call.params;
    const params = {sessionId, sessionEpoch, startEventSeq:"1", maxEvents:"100", maxBytes:"32768"};
    if (mode === "scope") {
      const wrongEpoch = await code(task.streams.read({...params, sessionEpoch:String(BigInt(sessionEpoch)+1n)}));
      const missingParams = await code(task.streams.read({}));
      return {wrongEpoch, missingParams, exact:rx(await task.streams.read(params))};
    }
    if (mode === "cancel") {
      try {
        await task.streams.read(params);
        event("late-value");
      } catch (error) {
        if (error.code !== "CANCELLED" && !task.signal.aborted) throw error;
        if (!task.signal.aborted)
          throw Error("The Host must abort the task before rejecting its data request");
        event("read-cancelled");
      }
      task.signal.throwIfAborted();
      throw Error("Raw request was not cancelled");
    }
    const pending = Array.from({length:4}, () => task.streams.read(params));
    const excess = await code(task.streams.read(params));
    const control = await task.operations.get({operationId});
    event("control:" + control.state + ":" + excess);
    const pages = (await Promise.all(pending)).map(rx);
    event("pages-finished");
    return {pages};
  });
  return () => {};
}
"#;
