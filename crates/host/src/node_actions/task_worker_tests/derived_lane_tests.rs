use super::*;
use serial_workbench_client::{ConnectOptions, HostClient};
use sha2::{Digest as _, Sha256};

#[path = "../../../tests/support/parity_clients.rs"]
#[allow(dead_code)]
mod parity_clients;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_derived_lane_preserves_raw_control_and_capture() {
    let markers = support::Profile::isolated("host-node-task-derived-");
    let events = markers.path().join("derived.events");
    let source = PLUGIN.replace("__EVENTS__", &serde_json::to_string(&events).unwrap());
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
            "scale":{"type":"integer","default":2},
            "mode":{"enum":["pressure","retention","cancel"]}
        },
        "required":["sessionId","sessionEpoch","operationId","mode"],
        "additionalProperties":false
    }))
    .unwrap();
    spec.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = node_host_actions::Fixture::program_with_virtual(spec, source.as_bytes()).await;
    let mut capture = capture_tests::CaptureProbe::start(&fixture).await;
    let session = capture.session().clone();
    let input = capture.phase(&fixture, b"derived-before-hold").await;
    let call = |mode: &str| {
        fixture.call(
            &fixture.client, &fixture.target, "example.terminal.compute",
            json!({"mode":mode,"sessionId":session.id,"sessionEpoch":session.session_epoch,"operationId":input}),
        )
    };

    let read = |client: &HostClient, operation: &Id, after: u64, samples: u64| {
        RpcRequest::Query(fixture.query_call(client, &session, "stream.derivedRead",
            json!({"operationId":operation,"after":U64::from(after),"maxSamples":U64::from(samples),"maxBytes":"16384"})))
    };
    let reader = HostClient::connect(ConnectOptions::new(
        fixture.dir.path().to_path_buf(),
        id("derived-reader"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let authorize = fixture.call(&fixture.user, &fixture.target, "auth.authorize",
        json!({"clientId":reader.attachment().client_id,"permissions":["content.read"],"targets":[session]}));
    let authorized = fixture.invoke(&fixture.user, authorize).await;
    assert_eq!(
        fixture
            .wait(&fixture.user, &authorized.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    let reader_raw = reader.connect_raw().await.unwrap();
    let producer = fixture.client.reconnect().await.unwrap();
    let producer_raw = producer.connect_raw().await.unwrap();

    let gate = &fixture.host.inner.node_test_gates.task_derived_ready;
    let mut held = gate.arm();
    let running = fixture.invoke(&fixture.client, call("pressure")).await;
    held.entered().await;
    wait_worker_event(
        &events,
        "control:succeeded:HOST_BUSY:derived-before-hold",
        1,
    )
    .await;
    assert!(!read_events(&events).contains("publishes-finished"));
    capture.phase(&fixture, b"derived-during-hold").await;
    held.release();
    let completed = fixture.wait(&fixture.client, &running.operation_id).await;
    assert_eq!(completed.state, OperationState::Succeeded, "{completed:?}");
    let plugin = fixture.result(&fixture.client, &completed).await;
    assert_eq!(plugin["forged"], "INVALID_ARGUMENT");
    assert_eq!(plugin["oldEpoch"], "EPOCH_MISMATCH");
    let params = serde_json::from_value::<JsonObject>(json!({
        "mode":"pressure","operationId":input,"scale":2,"sessionEpoch":session.session_epoch,"sessionId":session.id
    })).unwrap();
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&params).unwrap()));
    let first = page(
        reader_raw
            .request(read(&reader, &running.operation_id, 0, 1))
            .await
            .unwrap(),
    );
    let all = page(
        producer_raw
            .request(read(&producer, &running.operation_id, 0, 16))
            .await
            .unwrap(),
    );
    assert_eq!(first.operation_id, running.operation_id);
    assert_eq!(
        first.instance_epoch,
        fixture.client.attachment().instance_epoch
    );
    assert_eq!(first.samples.len(), 1);
    assert_eq!(first.samples[0], all.samples[0]);
    assert_eq!(first.next_position.get(), 1);
    assert!(first.has_more);
    assert_eq!(all.samples.len(), 4);
    assert_eq!(all.next_position.get(), 4);
    assert!(!all.has_more);
    for (index, sample) in all.samples.iter().enumerate() {
        assert_eq!(sample.position.get(), index as u64 + 1);
        let provenance = &sample.provenance;
        assert_eq!(provenance.parser_id.as_str(), "example.terminal.compute");
        assert_eq!(provenance.parser_version, "1.0.0");
        assert_eq!(provenance.configuration_digest.as_str(), digest);
        assert_eq!(
            provenance.quality,
            [DerivedQuality::Complete, DerivedQuality::Transformed]
        );
        assert_eq!(provenance.unit.as_deref(), Some("bytes"));
        assert_eq!(
            provenance.sources,
            serde_json::from_value::<Vec<SourceRange>>(plugin["sources"].clone()).unwrap()
        );
        assert_eq!(serde_json::to_value(&sample.value).unwrap(), json!(38));
    }
    let next = page(
        reader_raw
            .request(read(&reader, &running.operation_id, 1, 16))
            .await
            .unwrap(),
    );
    assert_eq!(next.samples, all.samples[1..]);

    let repeated = fixture.invoke(&fixture.client, call("retention")).await;
    let repeated = fixture.wait(&fixture.client, &repeated.operation_id).await;
    assert_eq!(repeated.state, OperationState::Succeeded, "{repeated:?}");
    let expired = failure(
        reader_raw
            .request(read(&reader, &repeated.operation_id, 0, 16))
            .await
            .unwrap(),
    );
    assert_eq!(expired.code, "CURSOR_EXPIRED");
    assert_eq!(
        serde_json::to_value(expired.details.unwrap()).unwrap(),
        json!({"oldestPosition":"3"})
    );
    let retained = page(
        reader_raw
            .request(read(&reader, &repeated.operation_id, 2, 1))
            .await
            .unwrap(),
    );
    assert_eq!(retained.next_position.get(), 3);
    assert!(retained.has_more);

    let mut held = gate.arm();
    let cancelled = fixture.invoke(&fixture.client, call("cancel")).await;
    held.entered().await;
    cancel_worker_task(&fixture, &cancelled).await;
    let terminal = worker_terminal(&fixture, &cancelled).await.unwrap();
    assert_eq!(terminal.state, OperationState::Cancelled, "{terminal:?}");
    assert_eq!(
        fixture.host.inner.node_derived_capacity.available_permits(),
        3
    );
    held.release();
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.host.inner.node_derived_capacity.available_permits() != 4 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Actual publication work did not return its permit");
    let uncommitted = failure(
        reader_raw
            .request(read(&reader, &cancelled.operation_id, 0, 16))
            .await
            .unwrap(),
    );
    assert_eq!(uncommitted.code, "NOT_FOUND");
    let revoke = fixture.call(&fixture.user, &fixture.target, "auth.revoke",
        json!({"actorId":reader.attachment().actor_id,"permissions":["content.read"],"targets":[session]}));
    let revoked = fixture.invoke(&fixture.user, revoke).await;
    assert_eq!(
        fixture
            .wait(&fixture.user, &revoked.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    let denied = failure(
        reader_raw
            .request(read(&reader, &running.operation_id, 1, 16))
            .await
            .unwrap(),
    );
    assert_eq!(denied.code, "PERMISSION_DENIED");
    let unaffected = page(
        producer_raw
            .request(read(&producer, &running.operation_id, 1, 16))
            .await
            .unwrap(),
    );
    assert_eq!(unaffected.samples, next.samples);
    verify_public_pages(&fixture, &session, &all).await;

    capture.phase(&fixture, b"derived-after-cancel").await;
    capture.finish(&fixture).await;
    if let Some(destination) = std::env::var_os("SWB_TEST_DERIVED_EVIDENCE") {
        let destination = std::path::PathBuf::from(destination);
        std::fs::create_dir(&destination).unwrap();
        std::fs::copy(
            fixture.dir.path().join("signed-actions.zip"),
            destination.join("signed-actions.zip"),
        )
        .unwrap();
        std::fs::copy(events, destination.join("derived.events")).unwrap();
        std::fs::write(
            destination.join("derived-page.json"),
            serde_json::to_vec_pretty(&all).unwrap(),
        )
        .unwrap();
    }
    eprintln!(
        "task_derived_lane archive={} pending=4 overflow=HOST_BUSY exact_provenance=true independent_reader=true cursor_expired=true revoke=PERMISSION_DENIED cancel_before_commit=true same_epoch_capture=true",
        fixture.archive.as_str()
    );
    let _profile = fixture.finish().await;
}

async fn verify_public_pages(
    fixture: &node_host_actions::Fixture,
    session: &Target,
    expected: &DerivedReadResult,
) {
    use parity_clients::{Cli, binary, drain, structured, tool_reply};
    use rmcp::{ServiceExt, transport::TokioChildProcess};
    use std::process::Stdio;
    use tokio::{process::Command, time::timeout};

    match (
        std::env::var_os("SWB_TEST_CLI_BIN"),
        std::env::var_os("SWB_TEST_MCP_BIN"),
    ) {
        (None, None) => {
            eprintln!(
                "task_derived_public_pages skipped: CLI and MCP binary paths were not supplied"
            );
            return;
        }
        (Some(_), Some(_)) => {}
        _ => panic!("Provide both SWB_TEST_CLI_BIN and SWB_TEST_MCP_BIN"),
    }
    let profile = fixture.dir.path();
    let cli = Cli {
        binary: binary("SWB_TEST_CLI_BIN", "serial-workbench-cli"),
        profile: profile.to_path_buf(),
    };
    let mut actors = Vec::with_capacity(2);
    for (kind, name) in [
        (ClientKind::Cli, "serial-workbench-cli"),
        (ClientKind::Mcp, "serial-workbench-mcp"),
    ] {
        let client =
            HostClient::connect(ConnectOptions::new(profile.to_path_buf(), id(name), kind))
                .await
                .unwrap();
        let authorize = fixture.call(
            &fixture.user, &fixture.target, "auth.authorize", json!({
                "clientId":client.attachment().client_id,"permissions":["content.read"],"targets":[session]
            }),
        );
        let authorization = fixture.invoke(&fixture.user, authorize).await;
        let authorized = fixture
            .wait(&fixture.user, &authorization.operation_id)
            .await;
        assert_eq!(
            authorized.state,
            OperationState::Succeeded,
            "{authorized:?}"
        );
        actors.push(client.attachment().actor_id.clone());
    }
    let context_path = profile.join("derived-cli-context.json");
    let context: AttachResult = serde_json::from_value(
        cli.json(&["context", "--out", context_path.to_str().unwrap(), "--json"])
            .await,
    )
    .unwrap();
    assert_eq!(context.actor_id, actors[0]);
    assert_ne!(actors[0], actors[1]);
    let params = json!({"operationId":expected.operation_id,"after":"0","maxSamples":"16","maxBytes":"16384"});
    assert_eq!(
        page(
            cli.query_reply("stream.derivedRead", session, &params)
                .await
        ),
        *expected
    );

    let mut command = Command::new(binary("SWB_TEST_MCP_BIN", "serial-workbench-mcp"));
    command.arg("--profile").arg(profile).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let (transport, stderr) = TokioChildProcess::builder(command)
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut exit = support::node_owner_exit::ProcessExit::observe(transport.id().unwrap());
    let stderr = tokio::spawn(drain(stderr.unwrap()));
    let sdk = timeout(Duration::from_secs(10), ().serve(transport))
        .await
        .unwrap()
        .unwrap();
    let reply = timeout(Duration::from_secs(10), async {
        tool_reply(sdk.peer(), "swb_stream_x2E_derivedRead", session, params).await
    })
    .await;
    let cancelled = timeout(Duration::from_secs(12), sdk.cancel()).await;
    let diagnostics = timeout(Duration::from_secs(5), stderr).await;
    assert!(
        tokio::task::spawn_blocking(move || exit.wait())
            .await
            .unwrap()
    );
    let _ = cancelled.unwrap().unwrap();
    let stderr = diagnostics.unwrap().unwrap().unwrap();
    let reply = reply.unwrap().unwrap_or_else(|error| {
        panic!(
            "MCP derived read: {error}; stderr={}",
            String::from_utf8_lossy(&stderr)
        )
    });
    assert_eq!(
        serde_json::from_value::<DerivedReadResult>(structured(reply)).unwrap(),
        *expected
    );
    eprintln!("task_derived_public_pages cli=true official_mcp_sdk=true match_host_pages=true");
}

fn page(reply: RpcReply) -> DerivedReadResult {
    match reply {
        RpcReply::Success { result, .. } => match *result {
            RpcResult::Query(QueryResult::StreamDerivedRead(result)) => result,
            other => panic!("Expected derived page: {other:?}"),
        },
        other => panic!("Expected derived read success: {other:?}"),
    }
}

fn failure(reply: RpcReply) -> HostError {
    match reply {
        RpcReply::Failure { error, .. } => error,
        other => panic!("Expected derived read failure: {other:?}"),
    }
}

const PLUGIN: &str = r#"
import { appendFileSync } from "node:fs";
const event = (line) => appendFileSync(__EVENTS__, line + "\n");
const code = (promise) => promise.then(() => "UNEXPECTED_VALUE", (error) => error.code);
const rx = (page) => page.events.find((event) => event.kind === "rx");
export function register(context) {
  context.actions.register("example.terminal.compute", async (call, task) => {
    const {sessionId, sessionEpoch, operationId, mode, scale} = call.params;
    const read = {sessionId, sessionEpoch, startEventSeq:"1", maxEvents:"100", maxBytes:"32768"};
    const raw = rx(await task.streams.read(read));
    const {hostId, eventSeq, payload} = raw;
    const range = {hostId, sessionId, sessionEpoch, eventStart:eventSeq, eventEnd:String(BigInt(eventSeq)+1n),
      byteStart:payload.byteStart, byteEnd:payload.byteEnd, direction:"rx"};
    const sources = [range];
    const params = {sources, quality:["complete","transformed"], unit:"bytes",
      value:Buffer.from(payload.bytesBase64,"base64").length * scale};
    if (mode === "cancel") {
      const abort = new Promise((_, reject) => task.signal.addEventListener("abort", () => reject(task.signal.reason), {once:true}));
      await Promise.race([task.streams.publishDerived(params), abort]);
      throw Error("Publication finished before cancellation");
    }
    if (mode === "retention") {
      let receipt;
      for (let i = 0; i < 66; i++) receipt = await task.streams.publishDerived(params);
      return {receipt};
    }
    const pending = Array.from({length:4}, () => task.streams.publishDerived(params));
    const excess = await code(task.streams.publishDerived(params));
    const control = await task.operations.get({operationId});
    const stillReading = rx(await task.streams.read(read));
    event("control:" + control.state + ":" + excess + ":" + Buffer.from(stillReading.payload.bytesBase64,"base64"));
    await Promise.all(pending);
    event("publishes-finished");
    const forged = await code(task.streams.publishDerived({...params,
      sources:[{...range, byteEnd:String(BigInt(range.byteEnd)+1n)}]}));
    const oldEpoch = await code(task.streams.publishDerived({...params,
      sources:[{...range, sessionEpoch:String(BigInt(sessionEpoch)-1n)}]}));
    return {sources, forged, oldEpoch};
  });
  return () => {};
}
"#;
