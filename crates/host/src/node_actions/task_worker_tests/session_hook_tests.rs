use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_session_hooks_follow_actual_virtual_epoch_and_release_reader() {
    let markers = support::Profile::isolated("host-node-task-session-hooks-");
    let events = markers.path().join("session-hooks.events");
    let release = markers.path().join("session-hooks.release");
    let source = PLUGIN
        .replace("__EVENTS__", &serde_json::to_string(&events).unwrap())
        .replace("__RELEASE__", &serde_json::to_string(&release).unwrap());
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
            "mode":{"enum":["follow","callback_failure"]}
        },
        "required":["sessionId","sessionEpoch","mode"],
        "additionalProperties":false
    }))
    .unwrap();
    spec.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = node_host_actions::Fixture::program_with_virtual(spec, source.as_bytes()).await;
    let mut capture = capture_tests::CaptureProbe::start(&fixture).await;
    let session = capture.session().clone();
    let payload = b"session-hook-echo";
    capture.phase(&fixture, payload).await;
    let call = |mode: &str| {
        fixture.call(
            &fixture.client,
            &session,
            "example.terminal.compute",
            json!({"mode":mode,"sessionId":session.id,"sessionEpoch":session.session_epoch}),
        )
    };

    let baseline = fixture.host.streams().memory_usage().reader_bytes;
    let failed = fixture
        .invoke(&fixture.client, call("callback_failure"))
        .await;
    wait_worker_event(&events, "callback-rejected", 1).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.host.streams().memory_usage().reader_bytes > baseline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Callback cleanup must release the reader while its task remains active");
    assert_eq!(
        operation(
            &fixture.client,
            &fixture.target,
            json!({"operationId":failed.operation_id}),
        )
        .await
        .state,
        OperationState::Running,
    );
    std::fs::File::create_new(&release).unwrap();
    let failed = fixture.wait(&fixture.client, &failed.operation_id).await;
    assert_eq!(failed.state, OperationState::Succeeded, "{failed:?}");
    assert_eq!(
        fixture.result(&fixture.client, &failed).await["failure"],
        "callback refused",
    );

    let watch = fixture.invoke(&fixture.client, call("follow")).await;
    wait_worker_event(&events, "follow-rx", 1).await;
    wait_worker_event(&events, "follow-tx", 1).await;
    assert!(!read_events(&events).contains("follow-end"));
    capture.finish(&fixture).await;
    let watch = fixture.wait(&fixture.client, &watch.operation_id).await;
    assert_eq!(watch.state, OperationState::Succeeded, "{watch:?}");
    let answer = fixture.result(&fixture.client, &watch).await;
    let entries = answer["observations"].as_array().unwrap();
    assert_eq!(entries.len(), 4, "{answer:?}");
    assert_eq!(entries[0]["kind"], "open");
    assert_eq!(entries[3]["kind"], "close");
    let expected_text = std::str::from_utf8(payload).unwrap();
    assert!(
        entries
            .iter()
            .any(|entry| entry["kind"] == "rx" && entry["text"] == expected_text)
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry["kind"] == "tx" && entry["outcome"] == "accepted")
    );
    assert!(entries[3]["position"].is_string(), "{answer:?}");
    assert_eq!(read_events(&events).matches("follow-end").count(), 1);
    let _profile = fixture.finish().await;
    eprintln!(
        "task_session_hooks virtual_echo=true real_rx_and_tx=true real_close=true callback_failure_reader_released=true"
    );
}

const PLUGIN: &str = r#"
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";

const marker = (line) => appendFileSync(__EVENTS__, line + "\n");
export function register(context) {
  context.actions.register("example.terminal.compute", async (call, task) => {
    const {sessionId, sessionEpoch, mode} = call.params;
    const observations = [];
    try {
      await task.streams.followSession({
        sessionId, sessionEpoch, startEventSeq:"1", maxEvents:"1", maxBytes:"32768"
      }, {
        onConnect(event) {
          observations.push({kind:"open", position:event.eventSeq});
        },
        async onReceive(event) {
          if (mode === "callback_failure") throw new Error("callback refused");
          observations.push({kind:"rx", position:event.eventSeq,
            text:Buffer.from(event.payload.bytesBase64, "base64").toString("utf8")});
          marker("follow-rx");
        },
        onSend(event) {
          observations.push({kind:"tx", position:event.eventSeq, outcome:event.payload.outcome});
          if (mode === "follow") marker("follow-tx");
        },
        onError(error) {
          throw new Error("unexpected source notification: " + error.kind);
        },
        onDisconnect(end) {
          if (end.reason.kind !== "closed") throw new Error("expected actual close");
          observations.push({kind:"close", position:end.after.position});
          marker("follow-end");
        }
      });
      return {observations};
    } catch (error) {
      if (mode !== "callback_failure" || error.message !== "callback refused") throw error;
      marker("callback-rejected");
      for (let attempt = 0; attempt < 300; attempt++) {
        if (existsSync(__RELEASE__)) return {failure:error.message};
        await wait(20, undefined, {signal:task.signal});
      }
      throw new Error("callback release was not verified");
    }
  });
  return () => {};
}
"#;
