use schemars::JsonSchema;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use serial_workbench_core::*;
use std::{collections::BTreeMap, error::Error, path::PathBuf};

#[derive(Serialize)]
struct Fixture {
    name: String,
    schema: String,
    value: Value,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Fixtures {
    schema_version: u32,
    valid: Vec<Fixture>,
    invalid: Vec<Fixture>,
}
impl Fixtures {
    fn add<T: DeserializeOwned + JsonSchema>(
        &mut self,
        name: &str,
        value: Value,
        valid: bool,
    ) -> Result<(), Box<dyn Error>> {
        let actual = serde_json::from_value::<T>(value.clone());
        if actual.is_ok() != valid {
            return Err(format!(
                "Fixture {name}: expected valid={valid}, got {}",
                actual
                    .err()
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "accepted".into())
            )
            .into());
        }
        let fixture = Fixture {
            name: name.into(),
            schema: T::schema_name().into_owned(),
            value,
        };
        if valid {
            self.valid.push(fixture)
        } else {
            self.invalid.push(fixture)
        }
        Ok(())
    }
}
fn replay_fixtures(f: &mut Fixtures) -> Result<(), Box<dyn Error>> {
    f.add::<ReplayReadParams>(
        "replay-legacy-read",
        json!({"sessionId":"replay","sessionEpoch":"1","maxRecords":"100","maxBytes":"65536"}),
        true,
    )?;
    f.add::<ReplayReadParams>(
        "replay-step-with-playback-state",
        json!({"sessionId":"replay","sessionEpoch":"1","maxRecords":"1","maxBytes":"65536","singleStep":true,"reportPlayback":true}),
        true,
    )?;
    f.add::<ReplayReadParams>(
        "replay-inspect-without-consuming",
        json!({"sessionId":"replay","sessionEpoch":"1","maxRecords":"1","maxBytes":"65536","inspectPlayback":true}),
        true,
    )?;
    f.add::<ReplayReadParams>(
        "replay-null-step",
        json!({"sessionId":"replay","sessionEpoch":"1","maxRecords":"1","maxBytes":"65536","singleStep":null}),
        false,
    )?;
    f.add::<ReplayControlParams>(
        "replay-set-timed-rate",
        json!({"sessionId":"replay","sessionEpoch":"1","paused":false,"playback":{"kind":"set_rate","rate":{"kind":"timed","speedPercent":200}}}),
        true,
    )?;
    f.add::<ReplayControlParams>(
        "replay-control-rejects-query-only-state",
        json!({"sessionId":"replay","sessionEpoch":"1","paused":false,"reportPlayback":true}),
        false,
    )?;
    f.add::<ReplayControlParams>(
        "replay-clear-breakpoint",
        json!({"sessionId":"replay","sessionEpoch":"1","paused":false,"playback":{"kind":"set_breakpoint"}}),
        true,
    )?;
    f.add::<ReplayControlParams>(
        "replay-null-breakpoint",
        json!({"sessionId":"replay","sessionEpoch":"1","paused":false,"playback":{"kind":"set_breakpoint","record":null}}),
        false,
    )?;
    f.add::<ReplayReadResult>(
        "replay-breakpoint-before-record",
        json!({"records":[],"readerGeneration":"3","nextRecord":"42","atEnd":false,"playback":{"rate":{"kind":"fastest"},"paused":true,"breakpointRecord":"42","breakpointHit":true}}),
        true,
    )?;
    Ok(())
}

fn fixtures() -> Result<Fixtures, Box<dyn Error>> {
    let mut f = Fixtures {
        schema_version: 1,
        ..Fixtures::default()
    };
    node_package_fixtures(&mut f)?;
    replay_fixtures(&mut f)?;
    f.add::<RpcRequest>(
        "local-lan-enable",
        json!({"method":"lan.access","params":{"kind":"enable","address":"[::1]:9240"}}),
        true,
    )?;
    f.add::<RpcRequest>(
        "local-lan-unknown-control-field",
        json!({"method":"lan.access","params":{"kind":"disable","confirmed":true}}),
        false,
    )?;
    let capture_ref = json!({"hostId":"host","kind":"capture","id":"capture"});
    for (name, receive, send, valid) in [
        ("terminal-gbk", json!("gbk"), json!("gbk"), true),
        ("terminal-auto", Value::Null, json!("utf-16be"), true),
        (
            "terminal-invalid-codec",
            json!("utf-7"),
            json!("utf-8"),
            false,
        ),
        (
            "terminal-invalid-send-auto",
            Value::Null,
            json!("auto"),
            false,
        ),
    ] {
        f.add::<TerminalSettings>(
            name,
            json!({
                "receiveMode": "text", "sendMode": "text", "lineEnding": {"kind": "none"},
                "receiveEncoding": receive, "sendEncoding": send,
            }),
            valid,
        )?;
    }
    f.add::<CaptureTailParams>(
        "capture-tail-defaults",
        json!({"captureRef":capture_ref}),
        true,
    )?;
    f.add::<CaptureTailParams>(
        "capture-tail-record-limit",
        json!({"captureRef":capture_ref,"maxRecords":"101"}),
        false,
    )?;
    f.add::<CaptureTailParams>(
        "capture-tail-byte-limit",
        json!({"captureRef":capture_ref,"maxBytes":"262145"}),
        false,
    )?;
    f.add::<CaptureTailParams>(
        "capture-tail-unknown-field",
        json!({"captureRef":capture_ref,"path":"forged"}),
        false,
    )?;
    f.add::<CaptureTailResult>(
        "capture-tail-result",
        json!({
            "captureRef":capture_ref,
            "sourceFingerprint":"0000000000000000000000000000000000000000000000000000000000000000",
            "state":"incomplete","verifiedPrefix":"0","containerComplete":false,
            "sourceContinuous":true,"firstRecord":"1","records":[]
        }),
        true,
    )?;
    f.add::<RpcRequest>(
        "client-register-controlled-rpc",
        json!({"method":"client.register","params":{"generation":"1","capabilities":["client.window.read"]}}),
        true,
    )?;
    f.add::<RpcRequest>(
        "client-register-rejects-claimed-actor",
        json!({"method":"client.register","params":{"generation":"1","capabilities":["client.window.read"],"actorId":"forged"}}),
        false,
    )?;
    f.add::<ClientRegisterParams>(
        "client-register-rejects-unknown-capability",
        json!({"generation":"1","capabilities":["client.future.execute"]}),
        false,
    )?;
    f.add::<RegisterFileParams>(
        "file-registration-actor-derived",
        json!({"path":"fixture-source.bin","purpose":"read_file"}),
        true,
    )?;
    f.add::<RegisterFileParams>(
        "file-registration-forged-client",
        json!({"path":"fixture-source.bin","purpose":"read_file","clientId":"forged"}),
        false,
    )?;
    for kind in ["transfer_receipts", "capture_record"] {
        f.add::<ResourceKind>(&format!("registered-{kind}"), json!(kind), true)?;
        f.object::<ObjectRef>(
            &format!("reference-{kind}"),
            json!({"hostId":"host","kind":kind,"id":"derived"}),
            &["revision"],
        )?;
    }
    f.add::<ResourceKind>(
        "resource-kind-unknown-unqualified",
        json!("future_resource"),
        false,
    )?;
    for (name, v) in [
        ("zero", "0"),
        ("beyond-js-precision", "9007199254740993"),
        ("u64-max", "18446744073709551615"),
    ] {
        f.add::<U64>(name, json!(v), true)?;
    }
    for (name, v) in [
        ("leading-zero", json!("01")),
        ("plus", json!("+1")),
        ("exponent-string", json!("1e3")),
        ("json-number", json!(1)),
        ("u64-overflow", json!("18446744073709551616")),
        ("empty-counter", json!("")),
        ("counter-null", Value::Null),
    ] {
        f.add::<U64>(name, v, false)?;
    }
    for (name, v, valid) in [
        ("base64-empty", "", true),
        ("base64-padded", "DQo=", true),
        ("base64-one-byte", "AA==", true),
        ("base64-no-padding", "DQo", false),
        ("base64-invalid-pad-bits", "AB==", false),
        ("base64-url-alphabet", "_w==", false),
    ] {
        f.add::<Bytes>(name, json!(v), valid)?;
    }
    for (name, v, valid) in [
        ("utc-leap-day", "2000-02-29T00:00:00.123Z", true),
        ("utc-normal", "2026-11-07T00:00:00Z", true),
        ("utc-not-leap", "2100-02-29T00:00:00Z", false),
        ("utc-impossible-date", "2026-02-31T00:00:00Z", false),
        ("utc-month-30", "2026-04-31T00:00:00Z", false),
        ("utc-lowercase", "2026-11-07t00:00:00z", true),
        ("utc-explicit-offset", "2026-11-07T00:00:00+00:00", true),
        ("utc-leap-second", "2016-12-31T23:59:60Z", true),
        ("utc-leap-wrong-day", "2016-12-30T23:59:60Z", false),
        ("utc-leap-wrong-hour", "2016-12-31T12:59:60Z", false),
        (
            "utc-leap-february-not-month-end",
            "2000-02-28T23:59:60Z",
            false,
        ),
        ("utc-nonzero-offset", "2026-11-07T00:00:00+08:00", false),
        (
            "utc-unknown-local-offset",
            "2026-11-07T00:00:00-00:00",
            false,
        ),
    ] {
        f.add::<Timestamp>(name, json!(v), valid)?;
    }
    for (name, v, valid) in [
        ("safe-number", json!(9007199254740991i64), true),
        ("safe-number-negative", json!(-9007199254740991i64), true),
        ("unsafe-number", json!(9007199254740992u64), false),
        ("fractional-number", json!(1.5), false),
        ("json-null", Value::Null, true),
        ("json-recursive", json!({"a":[null,true,"1",1]}), true),
    ] {
        f.add::<JsonValue>(name, v, valid)?;
    }
    let call = json!({"protocolVersion":"0.1","hostId":"host","instanceEpoch":"7","actorId":"actor","requestId":"33333333-3333-4333-8333-333333333333","requestContext":"dG9rZW4","actionId":"session.tx","target":{"hostId":"host","kind":"session","id":"session","sessionId":"session","sessionEpoch":"9007199254740993"},"params":{"bytesBase64":"DQo=","writeWaitMs":"1000"},"revealTarget":{"pageId":"workbench"}});
    f.add::<Call>("root-call", call.clone(), true)?;
    let mut query = call.clone();
    query.as_object_mut().unwrap().remove("requestContext");
    query["actionId"] = json!("catalog.list");
    query["target"] = json!({"hostId":"host","kind":"host","id":"host"});
    query["params"] = json!({"pageSize":"100"});
    f.add::<RpcRequest>(
        "generic-query",
        json!({"method":"action.query","params":query}),
        true,
    )?;
    f.add::<QueryResult>(
        "query-catalog-result",
        json!({"kind":"catalog","value":{"catalogVersion":"1","items":[]}}),
        true,
    )?;
    f.add::<QueryResult>(
        "query-result-unknown-kind",
        json!({"kind":"future","value":{}}),
        false,
    )?;
    f.add::<QueryResult>(
        "query-extension-decimal-result",
        json!({"kind":"extension","value":{"measurement":{"ratio":1.5},"epoch":"9007199254740993"}}),
        true,
    )?;
    f.add::<QueryResult>(
        "query-extension-scalar-result",
        json!({"kind":"extension","value":-0.25}),
        true,
    )?;
    f.add::<QueryResult>(
        "query-extension-null-result",
        json!({"kind":"extension","value":null}),
        true,
    )?;
    f.add::<QueryResult>(
        "query-extension-unknown-envelope",
        json!({"kind":"extension","value":{},"private":"forbidden"}),
        false,
    )?;
    f.add::<ActionResult>(
        "authorization-result",
        json!({"kind":"authorization_changed","value":{"grantRevision":"9007199254740993"}}),
        true,
    )?;
    f.add::<ActionResult>(
        "action-result-unknown-fields",
        json!({"kind":"authorization_changed","value":{"grantRevision":"1","secret":"forbidden"}}),
        false,
    )?;
    let handoff = json!({
        "packageId": "example.serial-tool",
        "expectedInstallRevision": "1",
        "archiveSha256": "a".repeat(64),
        "toolId": "probe",
        "timeoutMs": "2000"
    });
    f.add::<ToolHandoffParams>("tool-handoff", handoff.clone(), true)?;
    let mut handoff_extra = handoff;
    handoff_extra["executablePath"] = json!("unsigned.exe");
    f.add::<ToolHandoffParams>("tool-handoff-local-path", handoff_extra, false)?;
    f.add::<ActionResult>(
        "tool-handoff-receipt",
        json!({"kind":"tool_handoff","value":{"exitCode":0,"ownershipUnconfirmed":false}}),
        true,
    )?;
    for key in ["requestContext", "instanceEpoch", "revealTarget"] {
        let mut v = call.clone();
        v.as_object_mut().unwrap().remove(key);
        f.add::<Call>(&format!("call-missing-{key}"), v, false)?;
    }
    for key in ["expectedRevision", "leaseId", "executionMode"] {
        let mut v = call.clone();
        v[key] = Value::Null;
        f.add::<Call>(&format!("call-null-{key}"), v, false)?;
    }
    for key in ["sessionId", "sessionEpoch"] {
        let mut v = call.clone();
        v["target"].as_object_mut().unwrap().remove(key);
        f.add::<Call>(&format!("target-missing-{key}"), v, false)?;
    }
    let mut child = call.clone();
    child.as_object_mut().unwrap().remove("requestId");
    child.as_object_mut().unwrap().remove("requestContext");
    child["taskContext"] = json!("dG9rZW4");
    child["parentOperationId"] = json!("parent");
    child["childKey"] = json!("1");
    f.add::<ChildCall>("child-call", child.clone(), true)?;
    for key in [
        "requestId",
        "requestContext",
        "executionMode",
        "rootOperationId",
    ] {
        let mut v = child.clone();
        v[key] = json!("forbidden");
        f.add::<ChildCall>(&format!("child-forbidden-{key}"), v, false)?;
    }
    child["childKey"] = json!("0");
    f.add::<ChildCall>("child-zero-key", child, false)?;
    let op = json!({"operationId":"op","executionHostId":"host","actorId":"actor","requestId":"33333333-3333-4333-8333-333333333333","admission":{"kind":"request","requestContextDigest":"a".repeat(64)},"rootOperationId":"op","childHighWatermark":"0","actionId":"session.tx","target":{"hostId":"host","kind":"host","id":"host"},"executionMode":"interactive","state":"queued","revision":"1","revealTarget":{"pageId":"workbench"},"acceptedAt":"2026-11-07T00:00:00Z","owner":{"kind":"host","id":"host"}});
    f.add::<Operation>("root-operation", op.clone(), true)?;
    let mut receipt_op = op.clone();
    receipt_op["clientEffectReceipt"] = json!({"hostId":"host","instanceEpoch":"1","clientTargetId":"viewer","generation":"1","deliveryId":"delivery","outcome":{"kind":"succeeded","result":{"kind":"applied","value":{}}}});
    f.add::<Operation>("operation-client-receipt", receipt_op.clone(), true)?;
    receipt_op["clientEffectReceipt"] = serde_json::Value::Null;
    f.add::<Operation>("operation-client-receipt-null", receipt_op, false)?;
    let mut invalid = op.clone();
    invalid["state"] = json!("partial");
    f.add::<Operation>("partial-is-not-state", invalid, false)?;
    for key in ["admission", "rootOperationId", "childHighWatermark"] {
        let mut v = op.clone();
        v.as_object_mut().unwrap().remove(key);
        f.add::<Operation>(&format!("operation-missing-{key}"), v, false)?;
    }
    let mut child_op = op.clone();
    child_op["admission"] = json!({"kind":"child","taskContextDigest":"b".repeat(64),"parentOperationId":"parent","childKey":"1"});
    f.add::<Operation>("child-operation", child_op, true)?;
    let success = json!({"ok":true,"result":{"operation":op}});
    f.add::<RpcReply>("reply-operation", success.clone(), true)?;
    let failure =
        json!({"ok":false,"error":{"code":"NOT_FOUND","message":"Missing","retryable":false}});
    f.add::<RpcReply>("reply-error", failure.clone(), true)?;
    let mut bad = failure;
    bad["ok"] = json!(true);
    f.add::<RpcReply>("reply-wrong-discriminant", bad, false)?;
    f.add::<RpcReply>(
        "reply-unknown-success",
        json!({"ok":true,"result":{"unknown":true}}),
        false,
    )?;
    f.add::<RpcRequest>("rpc-attach",json!({"method":"host.attach","params":{"supportedProtocolVersions":["0.1"],"clientKind":"cli","clientId":"cli"}}),true)?;
    f.add::<HttpControlRequest>(
        "http-control-attach",
        json!({"requestId":"33333333-3333-4333-8333-333333333333","request":{"method":"host.attach","params":{"supportedProtocolVersions":["0.1"],"clientKind":"cli","clientId":"http-client"}}}),
        true,
    )?;
    f.add::<RpcRequest>(
        "rpc-unknown-method",
        json!({"method":"unknown","params":{}}),
        false,
    )?;
    for (n, v, valid) in [
        ("duration-min", "1", true),
        ("duration-max", "2147483647", true),
        ("duration-zero", "0", false),
        ("duration-overflow", "2147483648", false),
    ] {
        f.add::<DurationMs>(n, json!(v), valid)?;
    }
    f.add::<RetentionMs>("retention-seven-days", json!("604800000"), true)?;
    f.add::<RetentionMs>("retention-too-short", json!("604799999"), false)?;
    let event = json!({"hostId":"host","instanceEpoch":"7","sessionId":"session","sessionEpoch":"2","eventSeq":"9007199254740993","configurationRevision":"1","kind":"rx","time":{"clockId":"clock","sourceMonoNs":"1","receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1000000","syncMethod":"none"}},"payload":{"bytesBase64":"DQo=","byteStart":"0","byteEnd":"2"}});
    f.add::<RawEvent>("raw-rx", event.clone(), true)?;
    let cursor = json!({"hostId":"host","instanceEpoch":"7","scopeId":"scope","position":"9007199254740993"});
    let batch = json!({"subscriptionId":"subscription","cursor":cursor,"previousCursor":{"hostId":"host","instanceEpoch":"7","scopeId":"scope","position":"9007199254740992"},"items":[{"kind":"source","event":event}]});
    f.add::<RawBatch>("raw-source-batch", batch.clone(), true)?;
    let mut bad = batch.clone();
    bad["items"] = json!([]);
    f.add::<RawBatch>("raw-empty-batch", bad, false)?;
    let gap = json!({"hostId":"host","instanceEpoch":"7","sessionId":"session","sessionEpoch":"2","reason":"reader_overflow","missingEventRange":{"start":"100","end":"151"},"missingByteRanges":[]});
    f.add::<ReaderGap>("reader-gap-known-no-byte-loss", gap.clone(), true)?;
    let mut bad = gap.clone();
    bad["eventSeq"] = json!("100");
    f.add::<ReaderGap>("reader-gap-no-source-seq", bad, false)?;
    let mut gap_batch = batch;
    gap_batch["items"] = json!([{"kind":"reader_gap","gap":gap}]);
    f.add::<RawBatch>("raw-reader-gap-batch", gap_batch, true)?;
    let tx = json!({"operationId":"op","sessionId":"session","sessionEpoch":"2","outcome":"partial","bytesBase64":"DQo=","byteStart":"0","byteEnd":"2","acceptedRanges":[{"start":"0","end":"1"}],"unknownRanges":[],"peerAcknowledged":false});
    f.add::<TxReceipt>("partial-tx", tx.clone(), true)?;
    let mut bad = tx;
    bad["peerAcknowledged"] = json!(true);
    f.add::<TxReceipt>("tx-no-peer-proof", bad, false)?;
    ipc_fixtures(&mut f)?;
    m1_fixtures(&mut f, &op)?;
    worker_observation_fixtures(&mut f, &op)?;
    Ok(f)
}

fn worker_observation_fixtures(f: &mut Fixtures, operation: &Value) -> Result<(), Box<dyn Error>> {
    let sample = json!({
        "sampledAt":"2026-11-18T00:00:00Z",
        "measuredWorkers":"2",
        "v8HeapUsedBytes":"9007199254740993"
    });
    f.add::<WorkerMemorySample>("worker-memory-sample", sample.clone(), true)?;
    let mut invalid = sample.clone();
    invalid["sampledAt"] = json!("not-a-timestamp");
    f.add::<WorkerMemorySample>("worker-memory-invalid-time", invalid, false)?;
    let mut invalid = sample.clone();
    invalid["v8HeapUsedBytes"] = json!(9007199254740993_u64);
    f.add::<WorkerMemorySample>("worker-memory-numeric-u64", invalid, false)?;
    let mut invalid = sample.clone();
    invalid["rssBytes"] = json!("1");
    f.add::<WorkerMemorySample>("worker-memory-is-not-rss", invalid, false)?;

    let observation = json!({"liveWorkers":"2","peakWorkers":"3","lastMemory":sample});
    f.add::<WorkerObservation>("worker-observation", observation.clone(), true)?;
    f.add::<WorkerObservation>(
        "worker-observation-no-sample",
        json!({"liveWorkers":"0","peakWorkers":"3"}),
        true,
    )?;
    let mut invalid = observation.clone();
    invalid["lastMemory"] = Value::Null;
    f.add::<WorkerObservation>("worker-observation-null-sample", invalid, false)?;
    let mut invalid = observation.clone();
    invalid["operationId"] = json!("self-selected");
    f.add::<WorkerObservation>("worker-observation-self-selected-owner", invalid, false)?;

    let node = json!({
        "processId":"1234","sampleAgeMs":"25","rssBytes":"18446744073709551615",
        "liveWorkers":"2","peakWorkers":"3"
    });
    f.add::<NodeMetrics>("node-metrics", node.clone(), true)?;
    let mut no_rss = node.clone();
    no_rss.as_object_mut().unwrap().remove("rssBytes");
    f.add::<NodeMetrics>("node-metrics-no-rss", no_rss, true)?;
    let mut invalid = node.clone();
    invalid["rssBytes"] = Value::Null;
    f.add::<NodeMetrics>("node-metrics-null-rss", invalid, false)?;
    let mut invalid = node.clone();
    invalid["sampleAgeMs"] = json!("-1");
    f.add::<NodeMetrics>("node-metrics-negative-age", invalid, false)?;
    let mut invalid = node.clone();
    invalid["actorId"] = json!("self-selected");
    f.add::<NodeMetrics>("node-metrics-no-actor", invalid, false)?;

    let mut observed_operation = operation.clone();
    observed_operation["actionId"] = json!("example.terminal.compute");
    observed_operation["state"] = json!("running");
    observed_operation["startedAt"] = json!("2026-11-18T00:00:00Z");
    observed_operation["owner"] =
        json!({"kind":"plugin","id":"example.terminal","version":"1.0.0"});
    observed_operation["dependencies"] =
        json!([{"id":"example.terminal","version":"1.0.0","digest":"a".repeat(64)}]);
    observed_operation["workerObservation"] = observation;
    f.add::<Operation>(
        "operation-worker-observation",
        observed_operation.clone(),
        true,
    )?;
    observed_operation["workerObservation"] = Value::Null;
    f.add::<Operation>(
        "operation-null-worker-observation",
        observed_operation,
        false,
    )?;

    let budget = json!({"usedBytes":"1","peakBytes":"2","limitBytes":"3"});
    let mut metrics = json!({
        "hostId":"host","instanceEpoch":"1","observedAt":"2026-11-18T00:00:00Z",
        "processId":"123","rssBytes":"4","rssPeakBytes":"5",
        "source":budget,"reader":budget,"captureQueue":budget
    });
    f.add::<HostMetrics>("host-metrics-without-node", metrics.clone(), true)?;
    metrics["node"] = node;
    f.add::<HostMetrics>("host-metrics-with-node", metrics.clone(), true)?;
    let derived = json!({"retained":budget,"reader":budget});
    f.object::<DerivedMemoryMetrics>("derived-memory-metrics", derived.clone(), &[])?;
    metrics["derived"] = derived;
    f.add::<HostMetrics>("host-metrics-with-derived", metrics.clone(), true)?;
    metrics["derived"] = Value::Null;
    f.add::<HostMetrics>("host-metrics-null-derived", metrics.clone(), false)?;
    metrics.as_object_mut().unwrap().remove("derived");
    metrics["node"] = Value::Null;
    f.add::<HostMetrics>("host-metrics-null-node", metrics, false)?;
    Ok(())
}

fn ipc_fixtures(f: &mut Fixtures) -> Result<(), Box<dyn Error>> {
    let cursor = json!({"hostId":"host","instanceEpoch":"7","scopeId":"scope","position":"1"});
    let catalog_changed = json!({"type":"catalogChanged","catalogVersion":"9007199254740993","visibilityToken":"a".repeat(64)});
    let bodies = [
        json!({"type":"clientHello","supportedProtocolVersions":["0.1"],"clientNonce":"nonce"}),
        json!({"type":"hostHello","protocolVersion":"0.1","hostId":"host","instanceEpoch":"9007199254740993","serverNonce":"nonce","proof":"proof"}),
        json!({"type":"authenticate","clientId":"client"}),
        json!({"type":"authenticated","rawAttachToken":"token"}),
        json!({"type":"authenticateUserControl","clientId":"client","credential":"control-capability"}),
        json!({"type":"rawAttach","token":"token"}),
        json!({"type":"rawAttached"}),
        json!({"type":"request","request":{"method":"host.attach","params":{"supportedProtocolVersions":["0.1"],"clientKind":"cli","clientId":"client"}}}),
        json!({"type":"reply","reply":{"ok":true,"result":{"closed":true}}}),
        json!({"type":"error","error":{"code":"NOT_FOUND","message":"Missing","retryable":false}}),
        json!({"type":"rawBatch","batch":{"subscriptionId":"subscription","cursor":cursor,"previousCursor":cursor,"items":[{"kind":"reader_gap","gap":{"hostId":"host","instanceEpoch":"7","sessionId":"session","sessionEpoch":"2","reason":"reader_overflow","missingEventRange":{"start":"1","end":"2"},"missingByteRanges":[]}}]}}),
        json!({"type":"delta","subscriptionId":"subscription","delta":{"cursor":cursor,"previousCursor":cursor,"revision":"1","eventType":"changed","payload":{}}}),
        json!({"type":"subscriptionEnded","subscriptionId":"subscription","error":{"code":"CURSOR_EXPIRED","message":"New snapshot required","retryable":false}}),
        catalog_changed.clone(),
    ];
    for body in &bodies {
        let name = body["type"].as_str().unwrap();
        f.add::<IpcMessage>(&format!("ipc-{name}"), body.clone(), true)?;
        let mut unknown = body.clone();
        unknown["unknown"] = json!(true);
        f.add::<IpcMessage>(&format!("ipc-{name}-unknown"), unknown, false)?;
        for key in body.as_object().unwrap().keys() {
            let mut missing = body.clone();
            missing.as_object_mut().unwrap().remove(key);
            f.add::<IpcMessage>(&format!("ipc-{name}-missing-{key}"), missing, false)?;
        }
    }
    for field in ["catalogVersion", "visibilityToken"] {
        let mut null = catalog_changed.clone();
        null[field] = Value::Null;
        f.add::<IpcMessage>(&format!("ipc-catalogChanged-null-{field}"), null, false)?;
    }
    let mut numeric = catalog_changed.clone();
    numeric["catalogVersion"] = json!(1);
    f.add::<IpcMessage>("ipc-catalogChanged-number-version", numeric, false)?;
    let mut invalid_digest = catalog_changed.clone();
    invalid_digest["visibilityToken"] = json!("not-a-digest");
    f.add::<IpcMessage>(
        "ipc-catalogChanged-invalid-visibility-token",
        invalid_digest,
        false,
    )?;
    for (index, key, value) in [
        (0, "expectedHostId", "host"),
        (2, "credential", "credential"),
        (3, "credential", "credential"),
    ] {
        let name = bodies[index]["type"].as_str().unwrap();
        let mut body = bodies[index].clone();
        body[key] = json!(value);
        f.add::<IpcMessage>(&format!("ipc-{name}-with-{key}"), body.clone(), true)?;
        body[key] = Value::Null;
        f.add::<IpcMessage>(&format!("ipc-{name}-null-{key}"), body, false)?;
    }
    let mut control = bodies[4].clone();
    control["credential"] = Value::Null;
    f.add::<IpcMessage>("ipc-user-control-null-credential", control, false)?;
    let frame = json!({"requestId":"33333333-3333-4333-8333-333333333333","channel":"control","body":bodies[0]});
    for channel in ["control", "raw", "state"] {
        f.add::<IpcChannel>(&format!("ipc-channel-{channel}"), json!(channel), true)?;
        let mut value = frame.clone();
        value["channel"] = json!(channel);
        f.add::<WireFrame>(&format!("ipc-frame-{channel}"), value, true)?;
    }
    f.add::<IpcChannel>("ipc-channel-unknown", json!("unknown"), false)?;
    for key in ["requestId", "channel", "body"] {
        let mut value = frame.clone();
        value.as_object_mut().unwrap().remove(key);
        f.add::<WireFrame>(&format!("ipc-frame-missing-{key}"), value, false)?;
    }
    let mut value = frame.clone();
    value["channel"] = json!("unknown");
    f.add::<WireFrame>("ipc-frame-unknown-channel", value, false)?;
    let mut value = frame;
    value["unknown"] = json!(true);
    f.add::<WireFrame>("ipc-frame-unknown-field", value, false)?;
    f.add::<IpcMessage>("ipc-unknown-tag", json!({"type":"unknown"}), false)?;
    let mut host = bodies[1].clone();
    host["instanceEpoch"] = json!(7);
    f.add::<IpcMessage>("ipc-epoch-number", host, false)?;
    let mut host = bodies[1].clone();
    host["protocolVersion"] = json!("0.2");
    f.add::<IpcMessage>("ipc-host-unknown-protocol", host, false)?;
    for key in ["actorId", "credential", "unknown"] {
        let mut request = bodies[7].clone();
        request["request"]["params"][key] = json!("forged");
        f.add::<IpcMessage>(&format!("ipc-request-nested-{key}"), request, false)?;
    }
    let mut request = bodies[7].clone();
    request["request"]["actorId"] = json!("forged");
    f.add::<IpcMessage>("ipc-request-old-actor", request, false)?;
    let mut reply = bodies[8].clone();
    reply["reply"]["result"]["unknown"] = json!(true);
    f.add::<IpcMessage>("ipc-reply-unknown-result", reply, false)?;
    f.add::<IpcMessage>("ipc-failure-reply", json!({"type":"reply","reply":{"ok":false,"error":{"code":"DENIED","message":"Denied","retryable":false}}}), true)?;
    let authorize = json!({"clientId":"client","permissions":["content.read"],"targets":[{"hostId":"host","kind":"host","id":"host"}]});
    let revoke = json!({"actorId":"actor","permissions":["content.read"],"targets":[{"hostId":"host","kind":"host","id":"host"}]});
    f.add::<AuthorizeParams>("authorize", authorize.clone(), true)?;
    f.add::<RevokeParams>("revoke", revoke.clone(), true)?;
    let mut expiring = authorize.clone();
    expiring["expiresAt"] = json!("2026-11-07T00:00:00Z");
    f.add::<AuthorizeParams>("authorize-expiring", expiring, true)?;
    for key in ["clientId", "permissions", "targets"] {
        let mut value = authorize.clone();
        value.as_object_mut().unwrap().remove(key);
        f.add::<AuthorizeParams>(&format!("authorize-missing-{key}"), value, false)?;
    }
    for key in ["actorId", "permissions", "targets"] {
        let mut value = revoke.clone();
        value.as_object_mut().unwrap().remove(key);
        f.add::<RevokeParams>(&format!("revoke-missing-{key}"), value, false)?;
    }
    let mut null = authorize.clone();
    null["expiresAt"] = Value::Null;
    f.add::<AuthorizeParams>("authorize-null-expiry", null, false)?;
    let mut unknown = authorize;
    unknown["clientKind"] = json!("desktop");
    f.add::<AuthorizeParams>("authorize-unknown-kind", unknown, false)?;
    let mut unknown = revoke;
    unknown["clientId"] = json!("client");
    f.add::<RevokeParams>("revoke-unknown-client", unknown, false)?;
    Ok(())
}
impl Fixtures {
    fn object<T: DeserializeOwned + JsonSchema>(
        &mut self,
        name: &str,
        value: Value,
        optional: &[&str],
    ) -> Result<(), Box<dyn Error>> {
        self.add::<T>(name, value.clone(), true)?;
        let mut unknown = value.clone();
        unknown["unknown"] = json!(true);
        self.add::<T>(&format!("{name}-unknown-field"), unknown, false)?;
        for field in value.as_object().unwrap().keys() {
            if !optional.contains(&field.as_str()) {
                let mut missing = value.clone();
                missing.as_object_mut().unwrap().remove(field);
                self.add::<T>(&format!("{name}-missing-{field}"), missing, false)?;
            }
        }
        for field in optional {
            let mut null = value.clone();
            null[field] = Value::Null;
            self.add::<T>(&format!("{name}-null-{field}"), null, false)?;
        }
        Ok(())
    }
    fn enumeration<T: DeserializeOwned + JsonSchema>(
        &mut self,
        name: &str,
        values: &[&str],
    ) -> Result<(), Box<dyn Error>> {
        for value in values {
            self.add::<T>(&format!("{name}-{value}"), json!(value), true)?;
        }
        self.add::<T>(&format!("{name}-unregistered"), json!("future"), false)?;
        self.add::<T>(&format!("{name}-null"), Value::Null, false)?;
        Ok(())
    }
}

fn m1_fixtures(f: &mut Fixtures, operation: &Value) -> Result<(), Box<dyn Error>> {
    let shutdown_requested = json!({"instanceEpoch":"9007199254740993"});
    f.object::<ShutdownRequested>("shutdown-requested", shutdown_requested.clone(), &[])?;
    f.add::<ShutdownRequested>(
        "shutdown-requested-null-epoch",
        json!({"instanceEpoch":null}),
        false,
    )?;
    f.add::<ShutdownRequested>(
        "shutdown-requested-number-epoch",
        json!({"instanceEpoch":1}),
        false,
    )?;
    f.object::<ActionResult>(
        "action-shutdown-requested",
        json!({"kind":"shutdown_requested","value":shutdown_requested}),
        &[],
    )?;
    f.enumeration::<DataBits>("serial-data-bits", &["5", "6", "7", "8"])?;
    f.add::<DataBits>("serial-data-bits-number", json!(8), false)?;
    f.enumeration::<Parity>("serial-parity", &["none", "even", "odd", "mark", "space"])?;
    f.enumeration::<StopBits>("serial-stop-bits", &["one", "onePointFive", "two"])?;
    f.enumeration::<FlowControl>(
        "serial-flow-control",
        &["none", "rtsCts", "xonXoff", "dsrDtr"],
    )?;
    f.add::<StopBits>(
        "serial-stop-bits-snake-case",
        json!("one_point_five"),
        false,
    )?;
    f.add::<FlowControl>("serial-flow-control-snake-case", json!("rts_cts"), false)?;
    for kind in ["none", "cr", "lf", "crlf"] {
        f.object::<LineEnding>(&format!("line-ending-{kind}"), json!({"kind":kind}), &[])?;
    }
    f.object::<LineEnding>(
        "line-ending-custom",
        json!({"kind":"custom","bytesBase64":"AP8="}),
        &[],
    )?;
    f.add::<LineEnding>(
        "line-ending-custom-empty",
        json!({"kind":"custom","bytesBase64":""}),
        true,
    )?;
    f.add::<LineEnding>("line-ending-unknown-kind", json!({"kind":"future"}), false)?;
    f.add::<LineEnding>(
        "line-ending-custom-padding",
        json!({"kind":"custom","bytesBase64":"AQ"}),
        false,
    )?;
    f.add::<LineEnding>(
        "line-ending-custom-pad-bits",
        json!({"kind":"custom","bytesBase64":"AR=="}),
        false,
    )?;
    let settings = serde_json::to_value(SharedSettings::default())?;
    let workspace = serde_json::to_value(WorkspaceDocument::default())?;
    let settings_scope = json!({"scopeId":"settings:shared","target":{"hostId":"host","kind":"settings","id":"shared"}});
    let workspace_scope = json!({"scopeId":"workspace:bench","target":{"hostId":"host","kind":"workspace","id":"bench"}});
    let settings_document =
        json!({"document":{"revision":"3","value":settings},"scope":settings_scope});
    let workspace_document =
        json!({"document":{"revision":"2","value":workspace},"scope":workspace_scope});
    f.object::<SharedSettings>(
        "shared-settings-default",
        settings.clone(),
        &["customBackground"],
    )?;
    let mut picked_theme = settings.clone();
    picked_theme["nodeTheme"] = json!({
        "packageId":"swb.reference.theme",
        "themeId":"swb.reference.theme.bench-teal",
        "archiveSha256":"a".repeat(64),
    });
    f.add::<SharedSettings>("shared-settings-node-theme", picked_theme.clone(), true)?;
    picked_theme["nodeTheme"] = Value::Null;
    f.add::<SharedSettings>("shared-settings-null-node-theme", picked_theme, false)?;
    f.add::<NodeThemeTokens>("node-theme-color", json!({"accent":"#1A6A73"}), true)?;
    f.add::<NodeThemeTokens>(
        "node-theme-css",
        json!({"accent":"url(https://example.invalid/style.css)"}),
        false,
    )?;
    f.add::<NodeThemeTokens>(
        "node-theme-unknown-token",
        json!({"accent":"#1A6A73","script":"alert(1)"}),
        false,
    )?;
    f.object::<WorkspaceDocument>("workspace-document-default", workspace.clone(), &[])?;
    f.object::<SettingsSaveParams>("settings-save", json!({"value":settings}), &[])?;
    f.object::<WorkspaceSaveParams>("workspace-save", json!({"value":workspace}), &[])?;
    f.object::<StateScopeRef>("settings-scope-ref", settings_scope.clone(), &[])?;
    f.object::<StateScopesResult>(
        "state-scopes",
        json!({"scopes":[settings_scope,workspace_scope]}),
        &[],
    )?;
    f.object::<SettingsDocumentResult>("settings-document-result", settings_document.clone(), &[])?;
    f.object::<WorkspaceDocumentResult>(
        "workspace-document-result",
        workspace_document.clone(),
        &[],
    )?;
    f.object::<CommandLibraryReadParams>(
        "command-library-group-page",
        json!({"selection":{"view":"groups"}}),
        &[],
    )?;
    f.object::<CommandLibraryReadResult>(
        "command-library-empty-page",
        json!({"revision":"0","records":{"view":"groups","groups":[]}}),
        &[],
    )?;
    f.object::<CommandLibraryRevision>("command-library-revision", json!({"revision":"1"}), &[])?;
    f.object::<CommandLibraryChange>(
        "command-library-save-group",
        json!({"kind":"saveGroup","group":{"id":"bench","name":"Bench"}}),
        &[],
    )?;
    f.add::<CommandLibraryChange>(
        "command-library-move-invalid-group",
        json!({"kind":"moveCommand","id":"cmd","groupId":""}),
        false,
    )?;
    f.object::<WorkspaceListParams>("workspace-list-params", json!({}), &[])?;
    f.object::<WorkspaceSummary>(
        "workspace-summary",
        json!({"scope":workspace_document["scope"],"name":"Bench","revision":"2"}),
        &[],
    )?;
    f.object::<WorkspaceListResult>("workspace-list", json!({"workspaces":[]}), &[])?;
    f.object::<DocumentImportParams>("document-import", json!({"json":"{}"}), &[])?;
    f.object::<DocumentJsonResult>("document-json", json!({"json":"{}"}), &[])?;
    f.object::<QueryResult>(
        "query-settings-document",
        json!({"kind":"settings","value":settings_document}),
        &[],
    )?;
    f.object::<ActionResult>(
        "action-workspace-document",
        json!({"kind":"workspace","value":workspace_document}),
        &[],
    )?;
    f.enumeration::<TransportSemantics>("transport-semantics", &["stream", "message"])?;
    f.enumeration::<SessionState>(
        "session-state",
        &["closed", "opening", "open", "disconnected", "closing"],
    )?;
    f.enumeration::<ControlState>(
        "control-state",
        &["clear", "asserting", "asserted", "clearing", "unknown"],
    )?;
    f.enumeration::<ControlLine>("control-line", &["dtr", "rts"])?;
    f.enumeration::<PurgeDirection>("purge-direction", &["rx", "tx", "both"])?;
    f.enumeration::<PurgeScope>("purge-scope", &["application", "driver", "both"])?;
    f.enumeration::<PurgeOutcome>("purge-outcome", &["completed", "partial", "unknown"])?;
    f.enumeration::<LeaseKind>("lease-kind", &["ordinary", "transaction", "exclusive"])?;
    f.enumeration::<ExplicitLeaseKind>("explicit-lease-kind", &["transaction", "exclusive"])?;
    f.add::<ExplicitLeaseKind>("ordinary-is-not-explicit-lease", json!("ordinary"), false)?;
    f.enumeration::<LeaseState>(
        "lease-state",
        &["active", "revoking", "released", "expired"],
    )?;
    f.enumeration::<TakeoverReason>("takeover-reason", &["user"])?;
    let configuration = json!({"baudRate":"9600","dataBits":"8","parity":"none","stopBits":"one","flowControl":"none","readWaitMs":"1","writeWaitMs":"1000","reconnectBackoffMs":"2147483647"});
    f.object::<SerialConfiguration>("serial-configuration", configuration.clone(), &[])?;
    for field in configuration.as_object().unwrap().keys() {
        let mut null = configuration.clone();
        null[field] = Value::Null;
        f.add::<SerialConfiguration>(&format!("serial-configuration-null-{field}"), null, false)?;
    }
    for field in ["readWaitMs", "writeWaitMs", "reconnectBackoffMs"] {
        for (name, value) in [
            ("zero", json!("0")),
            ("overflow", json!("2147483648")),
            ("number", json!(1)),
        ] {
            let mut bad = configuration.clone();
            bad[field] = value;
            f.add::<SerialConfiguration>(
                &format!("serial-configuration-{field}-{name}"),
                bad,
                false,
            )?;
        }
    }
    let mut maximum = configuration.clone();
    maximum["baudRate"] = json!("18446744073709551615");
    f.add::<SerialConfiguration>("serial-baud-u64-max", maximum, true)?;
    let mut zero = configuration.clone();
    zero["baudRate"] = json!("0");
    f.add::<SerialConfiguration>("serial-baud-zero", zero, false)?;
    let capabilities = json!({"semantics":"stream","configuration":true,"dtr":true,"rts":true,"finiteBreak":true,"queueStatus":true,"drain":true,"purgeRx":true,"purgeTx":true});
    f.object::<TransportCapabilities>("transport-capabilities", capabilities.clone(), &[])?;
    let snapshot = json!({"sessionId":"session","deviceId":"virtual.echo","sessionEpoch":"9007199254740993","revision":"1","configurationRevision":"1","state":"open","configuration":configuration,"readOnly":false,"txGate":"ready","controlState":"clear","capabilities":capabilities});
    f.object::<SessionSnapshot>(
        "session-snapshot",
        snapshot.clone(),
        &["lease", "reconnect"],
    )?;
    f.enumeration::<ReconnectState>(
        "reconnect-state",
        &[
            "idle",
            "waiting",
            "attempting",
            "requires_rebind",
            "stopped",
        ],
    )?;
    let reconnect = json!({"state":"waiting","attempts":"9007199254740993"});
    f.object::<ReconnectStatus>("reconnect-status", reconnect.clone(), &["lastError"])?;
    let mut reconnecting_snapshot = snapshot.clone();
    reconnecting_snapshot["reconnect"] = reconnect;
    f.add::<SessionSnapshot>(
        "session-snapshot-with-reconnect",
        reconnecting_snapshot,
        true,
    )?;
    let lease = json!({"leaseId":"lease","sessionId":"session","sessionEpoch":"9007199254740993","actorId":"actor","ownerOperationId":"op","kind":"exclusive","state":"active","executionMode":"interactive","expiresAtMonoNs":"18446744073709551615"});
    f.object::<Lease>("lease", lease.clone(), &[])?;
    let mut leased_snapshot = snapshot.clone();
    leased_snapshot["lease"] = lease.clone();
    f.add::<SessionSnapshot>("session-snapshot-with-lease", leased_snapshot, true)?;
    f.object::<EmptyParams>("empty-params", json!({}), &[])?;
    let device = json!({"deviceId":"virtual.echo","hostId":"host","systemName":"virtual:echo","description":"Virtual Echo","fingerprint":{"transport":"virtual","evidence":"unreliable"},"capabilities":snapshot["capabilities"]});
    let devices = json!({"devices":[device],"stale":false});
    f.object::<DeviceDescriptor>(
        "virtual-device",
        device,
        &["description", "manufacturer", "driver"],
    )?;
    f.object::<DeviceList>("device-list", devices.clone(), &[])?;
    let mut port_selection = serde_json::to_value(WorkspaceDocument::default())?;
    port_selection["bindings"] = json!([{
        "bindingId":"binding", "hostId":"host", "deviceId":"old-device",
        "portName":"COM5", "fingerprint":{"transport":"serial","evidence":"unreliable"},
        "configuration":SerialConfiguration::default(), "reconnect":ReconnectPolicy::default()
    }]);
    f.add::<WorkspaceDocument>("workspace-binding-port-name", port_selection.clone(), true)?;
    port_selection["bindings"][0]
        .as_object_mut()
        .unwrap()
        .remove("portName");
    f.add::<WorkspaceDocument>(
        "workspace-binding-no-port-name",
        port_selection.clone(),
        true,
    )?;
    port_selection["bindings"][0]["portName"] = Value::Null;
    f.add::<WorkspaceDocument>("workspace-binding-null-port-name", port_selection, false)?;
    f.object::<DeviceBindingReference>(
        "device-binding-reference",
        json!({"workspaceId":"workspace","bindingId":"binding"}),
        &[],
    )?;
    f.object::<OpenParams>("open-params", json!({"configuration":configuration,"binding":{"workspaceId":"workspace","bindingId":"binding"}}), &["binding"])?;
    f.object::<OpenParams>(
        "plugin-open-params",
        json!({"configuration":configuration,"transportParams":{"port":43210}}),
        &["transportParams"],
    )?;
    let opened = json!({"sessionId":"session","sessionEpoch":"9007199254740993","revision":"1","reused":false});
    f.object::<OpenResult>("open-result", opened.clone(), &["recentError"])?;
    let transform =
        json!({"id":"terminal.crlf","version":"1","configurationDigest":"a".repeat(64)});
    f.object::<TransformReference>("transform-reference", transform.clone(), &[])?;
    f.object::<TxParams>("tx-params", json!({"bytesBase64":"DQo=","writeWaitMs":"1","queueWaitMs":"2147483647","sourceInputRef":{"hostId":"host","kind":"file","id":"input"},"transforms":[transform]}), &["queueWaitMs", "sourceInputRef", "transforms"])?;
    for (name, bytes, valid) in [
        (
            "tx-limit-16384",
            format!("{}AA==", "AAAA".repeat(5461)),
            true,
        ),
        (
            "tx-limit-16385",
            format!("{}AAA=", "AAAA".repeat(5461)),
            true,
        ),
        ("tx-draft-16500", "MTIz".repeat(5500), true),
        (
            "tx-limit-maximum",
            format!("{}AAA=", "AAAA".repeat(TX_MAX_BYTES / 3)),
            true,
        ),
        (
            "tx-limit-over-one",
            "AAAA".repeat(TX_MAX_BYTES / 3 + 1),
            false,
        ),
        (
            "tx-limit-over-two",
            format!("{}AA==", "AAAA".repeat(TX_MAX_BYTES / 3 + 1)),
            false,
        ),
        ("tx-empty", String::new(), false),
    ] {
        f.add::<TxParams>(name, json!({"bytesBase64":bytes,"writeWaitMs":"1"}), valid)?;
    }
    f.object::<ConfigureParams>("configure-params", json!({"requested":configuration}), &[])?;
    let config_receipt = json!({"requested":configuration,"fields":[{"field":"baudRate","status":"applied","actual":"9600"}],"readback":{"baudRate":"9600"},"revision":"2","boundaryEventSeq":"3","txGate":"configuration_pending"});
    f.object::<ConfigReceipt>("configuration-receipt", config_receipt.clone(), &[])?;
    for field in configuration.as_object().unwrap().keys() {
        let mut bad = config_receipt.clone();
        bad["requested"].as_object_mut().unwrap().remove(field);
        f.add::<ConfigReceipt>(
            &format!("configuration-receipt-requested-missing-{field}"),
            bad,
            false,
        )?;
    }
    f.object::<ConfigField>(
        "configuration-field",
        json!({"field":"parity","status":"unknown"}),
        &["actual"],
    )?;
    f.object::<ControlParams>("control-params", json!({"line":"rts","value":true}), &[])?;
    let control = json!({"line":"rts","requested":true,"status":"unknown"});
    f.object::<ControlReceipt>("control-receipt", control.clone(), &["actual"])?;
    f.add::<ControlReceipt>(
        "control-receipt-confirmed",
        json!({"line":"dtr","requested":false,"status":"confirmed","actual":false}),
        true,
    )?;
    f.object::<BreakParams>("break-params", json!({"durationMs":"1"}), &[])?;
    let transition = json!({"status":"confirmed","at":"2026-11-07T00:00:00Z"});
    f.object::<ControlTransition>("control-transition", transition.clone(), &["error"])?;
    let break_receipt = json!({"assert":transition,"clear":transition});
    f.object::<BreakReceipt>("break-receipt", break_receipt.clone(), &[])?;
    f.object::<SetReadOnlyParams>("set-read-only", json!({"readOnly":true}), &[])?;
    for (name, value, valid) in [
        ("minimum", "1", true),
        ("maximum", "2147483647", true),
        ("zero", "0", false),
        ("overflow", "2147483648", false),
    ] {
        f.add::<LeaseAcquireParams>(
            &format!("lease-acquire-ttl-{name}"),
            json!({"kind":"transaction","ttlMs":value}),
            valid,
        )?;
        f.add::<LeaseRenewParams>(
            &format!("lease-renew-ttl-{name}"),
            json!({"leaseId":"lease","ttlMs":value}),
            valid,
        )?;
    }
    f.object::<LeaseAcquireParams>(
        "lease-acquire",
        json!({"kind":"exclusive","ttlMs":"30000"}),
        &[],
    )?;
    f.object::<LeaseRenewParams>(
        "lease-renew",
        json!({"leaseId":"lease","ttlMs":"30000"}),
        &[],
    )?;
    f.object::<LeaseReleaseParams>("lease-release", json!({"leaseId":"lease"}), &[])?;
    f.object::<TakeoverParams>("takeover", json!({"actorId":"actor","reason":"user"}), &[])?;
    let takeover = json!({"affectedOperationIds":["op"]});
    f.object::<TakeoverReceipt>("takeover-receipt", takeover.clone(), &[])?;
    f.object::<WaitBoundaryParams>(
        "wait-boundary",
        json!({"throughOperationId":"op","queueWaitMs":"1"}),
        &[],
    )?;
    let boundary = json!({"throughOperationId":"op"});
    f.object::<WaitBoundaryReceipt>("wait-boundary-receipt", boundary.clone(), &[])?;
    let queue = json!({"pendingBytes":"9007199254740993","observedAt":"2026-11-07T00:00:00Z"});
    f.object::<QueueStatus>("queue-status", queue.clone(), &[])?;
    f.object::<DrainParams>("drain-params", json!({"writeWaitMs":"1"}), &[])?;
    let drained = json!({"status":"unknown"});
    f.object::<DrainReceipt>("drain-receipt", drained.clone(), &[])?;
    f.object::<PurgeParams>(
        "purge-params",
        json!({"direction":"both","scope":"application"}),
        &[],
    )?;
    let purged = json!({"direction":"tx","scope":"driver","outcome":"unknown","affectedOperationIds":[],"ranges":[],"unknownExtent":true});
    f.object::<PurgeReceipt>("purge-receipt", purged.clone(), &[])?;
    let intent = json!({"operationId":"op","bytesBase64":"DQo=","byteStart":"0","byteEnd":"2"});
    f.object::<TxIntent>("tx-intent", intent.clone(), &[])?;
    let receipt = json!({"operationId":"op","sessionId":"session","sessionEpoch":"2","outcome":"unknown","bytesBase64":"DQo=","byteStart":"0","byteEnd":"2","acceptedRanges":[{"start":"0","end":"1"}],"unknownRanges":[{"start":"1","end":"2"}],"peerAcknowledged":false,"backendError":{"code":"WRITE_INTERRUPTED","message":"Write result unavailable","retryable":false}});
    f.object::<TxReceipt>("unknown-tx-receipt", receipt.clone(), &["backendError"])?;
    let mut event = json!({"hostId":"host","instanceEpoch":"7","sessionId":"session","sessionEpoch":"2","eventSeq":"1","configurationRevision":"1","kind":"tx_intent","time":{"clockId":"clock","sourceMonoNs":"1","receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},"payload":intent});
    f.object::<RawEvent>("raw-tx-intent", event.clone(), &[])?;
    event["eventSeq"] = json!("2");
    event["kind"] = json!("tx");
    event["payload"] = receipt.clone();
    f.object::<RawEvent>("raw-tx-final", event.clone(), &[])?;
    let cursor = json!({"hostId":"host","instanceEpoch":"7","scopeId":"scope","position":"0"});
    f.object::<Cursor>("stream-cursor", cursor.clone(), &[])?;
    f.object::<StreamReadParams>("stream-read-params", json!({"sessionId":"session","sessionEpoch":"2","startEventSeq":"1","maxEvents":"100","maxBytes":"16384"}), &[])?;
    let source_range = json!({"hostId":"host","sessionId":"session","sessionEpoch":"2","eventStart":"1","eventEnd":"2","byteStart":"0","byteEnd":"4","direction":"rx"});
    f.object::<SourceRange>(
        "derived-source-range",
        source_range.clone(),
        &["byteStart", "byteEnd", "direction"],
    )?;
    f.object::<DerivedPublishParams>("derived-publish-params", json!({"sources":[source_range.clone()],"quality":["complete","transformed"],"unit":"ms","value":42}), &["unit"])?;
    f.object::<DerivedPublishResult>(
        "derived-publish-result",
        json!({"operationId":"operation","position":"1"}),
        &[],
    )?;
    f.object::<DerivedReadParams>(
        "derived-read-params",
        json!({"operationId":"operation","after":"0","maxSamples":"16","maxBytes":"16384"}),
        &[],
    )?;
    f.object::<DerivedReadResult>("derived-read-result", json!({
        "operationId":"operation","instanceEpoch":"7","nextPosition":"1","hasMore":false,
        "samples":[{"position":"1","provenance":{"sources":[source_range],"parserId":"plugin.reference.parse",
            "parserVersion":"1.0.0","configurationDigest":"ab".repeat(32),"quality":["complete","transformed"],"unit":"ms"},"value":42}]
    }), &[])?;
    let read_result = json!({"events":[event],"nextEventSeq":"3","hasMore":false});
    f.object::<StreamReadResult>("stream-read-result", read_result.clone(), &[])?;
    f.object::<StreamSubscribeParams>("stream-zero-credit", json!({"scopeId":"scope","after":cursor,"queueBytes":"4194304","initialCreditBytes":"0","overflowPolicy":"drop_with_gap"}), &[])?;
    let subscribed = json!({"subscriptionId":"subscription"});
    f.object::<StreamSubscribeResult>("stream-subscribe-result", subscribed.clone(), &[])?;
    f.object::<StreamCreditParams>(
        "stream-credit-params",
        json!({"subscriptionId":"subscription","ackCursor":cursor,"grantedBytesTotal":"256"}),
        &[],
    )?;
    let credited = json!({"ackCursor":cursor,"grantedBytesTotal":"256","sentBytesTotal":"0","acknowledgedBytesTotal":"0"});
    f.object::<StreamCreditResult>("stream-credit-result", credited.clone(), &[])?;
    f.object::<ReaderGap>("reader-gap-unknown-bytes", json!({"hostId":"host","instanceEpoch":"7","sessionId":"session","sessionEpoch":"2","reason":"reader_overflow","missingEventRange":{"start":"1","end":"2"}}), &["missingByteRanges"])?;
    for (name, kind, value) in [
        ("opened", "opened", opened),
        ("session", "session", snapshot.clone()),
        ("control", "control", control),
        ("lease", "lease", lease),
        ("takeover", "takeover", takeover),
        ("boundary", "boundary", boundary),
        ("drained", "drained", drained),
        ("purged", "purged", purged),
        ("tx", "tx", receipt),
        ("configuration", "configuration", config_receipt),
        ("break", "break", break_receipt),
        (
            "reference",
            "reference",
            json!({"resultRef":{"hostId":"host","kind":"file","id":"result"}}),
        ),
        (
            "cancellation",
            "cancellation_requested",
            json!({"operationId":"op","state":"cancelled"}),
        ),
    ] {
        f.object::<ActionResult>(
            &format!("action-{name}"),
            json!({"kind":kind,"value":value}),
            &[],
        )?;
    }
    f.add::<ActionResult>(
        "action-result-unknown-kind",
        json!({"kind":"future","value":{}}),
        false,
    )?;
    for (name, kind, value) in [
        ("devices", "devices", devices),
        ("session", "session", snapshot),
        ("queue", "queue", queue),
        ("stream-read", "stream_read", read_result),
        ("stream-subscribe", "stream_subscribe", subscribed),
        ("stream-credit", "stream_credit", credited),
        ("operation", "operation", json!({"operation":operation})),
        (
            "snapshot",
            "snapshot",
            json!({"hostId":"host","instanceEpoch":"7","revision":"1","cursor":cursor,"state":{}}),
        ),
        (
            "subscription",
            "subscription",
            json!({"subscriptionId":"subscription"}),
        ),
        ("closed", "closed", json!({"closed":true})),
    ] {
        f.object::<QueryResult>(
            &format!("query-{name}"),
            json!({"kind":kind,"value":value}),
            &[],
        )?;
    }
    Ok(())
}

fn node_package_fixtures(f: &mut Fixtures) -> Result<(), Box<dyn Error>> {
    let library = serde_json::to_value(bundled_node_runtime_library())?;
    f.add::<NodeRuntimeLibraryRelease>("node-runtime-private-library", library.clone(), true)?;
    let mut invalid = library.clone();
    invalid["systemLibrary"] = json!(true);
    f.add::<NodeRuntimeLibraryRelease>("node-runtime-private-library-unknown", invalid, false)?;
    let mut invalid = library;
    invalid["library"]["size"] = json!(30960);
    f.add::<NodeRuntimeLibraryRelease>(
        "node-runtime-private-library-numeric-size",
        invalid,
        false,
    )?;
    let runtime = serde_json::to_value(bundled_node_runtime_release())?;
    f.add::<NodeRuntimeRelease>("node-runtime-release", runtime.clone(), true)?;
    let mut invalid = runtime;
    invalid["systemNode"] = json!(true);
    f.add::<NodeRuntimeRelease>("node-runtime-unknown-substitution", invalid, false)?;
    let probe = json!({"version":"26.13.0","platform":"win32","arch":"x64","modulesAbi":"147","nodeApiVersion":"10","execPath":"R/runtime/node/26.13.0/x86_64-pc-windows-msvc/bin/node.exe"});
    f.add::<NodeRuntimeSelfTest>("node-runtime-self-test", probe.clone(), true)?;
    let mut invalid = probe;
    invalid["modulesAbi"] = json!(147);
    f.add::<NodeRuntimeSelfTest>("node-runtime-numeric-abi", invalid, false)?;
    let manifest = json!({
        "schemaVersion":"0.1","id":"example.terminal","version":"1.2.3-beta.1+build.7",
        "displayName":"离线终端","description":"参考包","license":"MIT",
        "notices":["许可证/LICENSE.txt"],"hostProtocolVersion":"0.1",
        "runtimeRef":"node-26.13.0","main":"dist/main.mjs","webUi":{"entry":"界面/index.html"},
        "dependencies":[],"platformResources":[],"activation":["startup"],
        "permissions":{"hostApi":[],"executionPurposes":["terminal"],"externalTools":[]},
        "contributes":{"actions":[],"queries":[],"transports":[],"parsers":[],"views":[],"themes":[],"configuration":[]},
        "dataSchemaVersion":"1"
    });
    parse_node_manifest(&serde_json::to_vec(&manifest)?)?;
    f.add::<NodePackageManifest>("node-package-manifest", manifest.clone(), true)?;
    for (name, field, value) in [
        (
            "unknown-field",
            "scripts",
            json!({"postinstall":"forbidden"}),
        ),
        ("null-ui", "webUi", Value::Null),
        ("future-schema", "schemaVersion", json!("0.2")),
        ("foreign-protocol", "hostProtocolVersion", json!("1.0")),
    ] {
        let mut invalid = manifest.clone();
        invalid[field] = value;
        f.add::<NodePackageManifest>(&format!("node-package-manifest-{name}"), invalid, false)?;
    }
    for (value, valid) in [
        ("1.2.3-beta.1+build.7", true),
        ("18446744073709551615.0.0", true),
        ("1.0.0-9999999999999999999999999999999999999999", true),
        ("1.0.0-alpha.01", false),
        ("01.2.3", false),
        ("1.2", false),
        ("latest", false),
        ("18446744073709551616.0.0", false),
        ("1.0.0\n", false),
    ] {
        f.add::<NodePackageVersion>(
            &format!("node-package-version-{value:?}"),
            json!(value),
            valid,
        )?;
    }
    for (value, valid) in [
        ("example.terminal", true),
        ("vendor.package-name_2", true),
        ("unqualified", false),
        ("example..terminal", false),
        ("example.terminal\n", false),
    ] {
        f.add::<NodePackageId>(&format!("node-package-id-{value:?}"), json!(value), valid)?;
    }
    for (value, valid) in [
        ("界面/index.html", true),
        ("dist/main.mjs", true),
        ("../escape.mjs", false),
        ("/absolute.mjs", false),
        ("C:/outside.mjs", false),
        ("dist\\main.mjs", false),
        ("dist//main.mjs", false),
        ("dist/../main.mjs", false),
        ("dist/main.mjs\n", false),
    ] {
        f.add::<NodePackagePath>(&format!("node-package-path-{value:?}"), json!(value), valid)?;
    }
    let integrity = json!({
        "schemaVersion":"0.1","id":"example.terminal","version":"1.2.3-beta.1+build.7",
        "source":"local","keyId":"local-unverified",
        "files":[
            {"path":"dist/main.mjs","size":"1","sha256":"0".repeat(64)},
            {"path":"manifest.json","size":"2","sha256":"0".repeat(64)},
            {"path":"界面/index.html","size":"1","sha256":"0".repeat(64)},
            {"path":"许可证/LICENSE.txt","size":"1","sha256":"0".repeat(64)}
        ]
    });
    validate_node_package_metadata(
        &parse_node_manifest(&serde_json::to_vec(&manifest)?)?,
        &parse_node_integrity(&serde_json::to_vec(&integrity)?)?,
    )?;
    f.add::<NodePackageIntegrity>("node-package-integrity", integrity.clone(), true)?;
    let mut invalid = integrity;
    invalid["files"][0]["size"] = json!(1);
    f.add::<NodePackageIntegrity>("node-package-integrity-numeric-size", invalid, false)?;
    let signature = json!({
        "algorithm":"Ed25519","keyId":"release-key","signatureBase64":format!("{}==", "A".repeat(86))
    });
    f.add::<NodePackageSignature>("node-package-signature", signature.clone(), true)?;
    for (name, field, value) in [
        (
            "noncanonical",
            "signatureBase64",
            json!(format!("{}B==", "A".repeat(85))),
        ),
        ("unknown-algorithm", "algorithm", json!("none")),
        (
            "trailing-newline",
            "signatureBase64",
            json!(format!("{}==\n", "A".repeat(86))),
        ),
        ("self-trust", "publicKey", json!("cannot-establish-trust")),
    ] {
        let mut invalid = signature.clone();
        invalid[field] = value;
        f.add::<NodePackageSignature>(&format!("node-package-signature-{name}"), invalid, false)?;
    }
    let registration = json!({
        "id":"example.terminal","version":"1.2.3-beta.1+build.7",
        "contributes":{"actions":[],"queries":[],"transports":[],"parsers":[],"views":[],"themes":[],"configuration":[]}
    });
    f.add::<NodePackageRegistration>("node-package-registration", registration.clone(), true)?;
    let mut invalid = registration;
    invalid["contributes"]["actions"] =
        json!([{"actionId":"example.terminal.open","permissions":[]}]);
    f.add::<NodePackageRegistration>(
        "node-package-registration-replaced-metadata",
        invalid,
        false,
    )?;
    f.add::<NodePackageListResult>(
        "node-packages-empty",
        json!({"revision":"0","packages":[]}),
        true,
    )?;
    let installed = json!({
        "revision":"1",
        "packages":[{
            "id":"example.terminal","archiveSha256":"a".repeat(64),
            "sourceVerified":false,"enabled":false,"executionApproved":false
        }]
    });
    f.add::<NodePackageInstallation>(
        "node-package-complete-details",
        json!({
            "manifest":manifest,"archiveSha256":"a".repeat(64),
            "verifiedSource":null,"enabled":false,"executionTrust":null
        }),
        true,
    )?;
    f.add::<NodePackageListParams>("node-packages-default-page", json!({}), true)?;
    f.add::<NodePackageListParams>(
        "node-packages-next-page",
        json!({"pageSize":"1","after":"example.terminal","expectedRevision":"1"}),
        true,
    )?;
    f.add::<NodePackageListParams>("node-packages-null-after", json!({"after":null}), false)?;
    f.add::<NodePackageListParams>(
        "node-packages-null-revision",
        json!({"expectedRevision":null}),
        false,
    )?;
    f.add::<NodePackageListParams>(
        "node-packages-numeric-page-size",
        json!({"pageSize":1}),
        false,
    )?;
    f.add::<NodePackageDetailsReadParams>("node-package-details-read", json!({"id":"example.terminal","expectedRevision":"1","archiveSha256":"a".repeat(64),"offset":"0","length":"32768"}), true)?;
    f.add::<NodePackageDetailsReadParams>("node-package-details-numeric-offset", json!({"id":"example.terminal","expectedRevision":"1","archiveSha256":"a".repeat(64),"offset":0,"length":"32768"}), false)?;
    f.add::<NodePackageDetailsReadResult>("node-package-details-chunk", json!({"revision":"1","id":"example.terminal","archiveSha256":"a".repeat(64),"jsonSha256":"b".repeat(64),"offset":"0","totalBytes":"1","bytesBase64":"eA=="}), true)?;
    f.add::<NodePackageListResult>("node-packages-installed", installed.clone(), true)?;
    let install_result = json!({"revision":"1","package":installed["packages"][0]});
    f.add::<NodePackageChangeResult>("node-package-install-result", install_result.clone(), true)?;
    let uninstall_result =
        json!({"revision":"2","id":"example.terminal","archiveSha256":"a".repeat(64)});
    f.add::<NodePackageUninstallResult>(
        "node-package-uninstall-result",
        uninstall_result.clone(),
        true,
    )?;
    f.add::<ActionResult>(
        "node-package-uninstalled",
        json!({"kind":"node_package_uninstalled","value":uninstall_result}),
        true,
    )?;
    f.add::<NodePackageUninstallResult>(
        "node-package-uninstall-numeric-revision",
        json!({"revision":2,"id":"example.terminal","archiveSha256":"a".repeat(64)}),
        false,
    )?;
    f.add::<NodePackageUninstallResult>("node-package-uninstall-delete-data", json!({"revision":"2","id":"example.terminal","archiveSha256":"a".repeat(64),"deleteData":true}), false)?;
    f.add::<NodePackageIdentityParams>(
        "node-package-identity",
        json!({"id":"example.terminal","archiveSha256":"a".repeat(64)}),
        true,
    )?;
    f.add::<NodePackageIdentityParams>(
        "node-package-identity-self-confirmation",
        json!({"id":"example.terminal","archiveSha256":"a".repeat(64),"userConfirmed":true}),
        false,
    )?;
    f.add::<ActionResult>(
        "node-package-preference-changed",
        json!({"kind":"node_package_changed","value":install_result}),
        true,
    )?;
    let mut enabled =
        json!({"id":"example.terminal","archiveSha256":"a".repeat(64),"enabled":true});
    f.add::<NodePackageSetEnabledParams>("node-package-enable", enabled.clone(), true)?;
    enabled["enabled"] = json!(false);
    f.add::<NodePackageSetEnabledParams>("node-package-disable", enabled.clone(), true)?;
    enabled["enabled"] = serde_json::Value::Null;
    f.add::<NodePackageSetEnabledParams>("node-package-enable-null", enabled, false)?;
    f.add::<NodePackageSetEnabledParams>(
        "node-package-enable-missing-intent",
        json!({"id":"example.terminal","archiveSha256":"a".repeat(64)}),
        false,
    )?;
    f.add::<NodePackageRuntimeParams>(
        "node-package-runtime-query",
        json!({"id":"example.terminal"}),
        true,
    )?;
    f.add::<NodePackageRuntimeParams>(
        "node-package-runtime-private-path",
        json!({"id":"example.terminal","path":"private"}),
        false,
    )?;
    let runtime = json!({"id":"example.terminal","phase":"active","generation":"1","archiveSha256":"a".repeat(64)});
    f.add::<NodePackageRuntimeStatus>("node-package-runtime-active", runtime.clone(), true)?;
    f.add::<QueryResult>(
        "node-package-runtime-result",
        json!({"kind":"node_package_runtime","value":runtime}),
        true,
    )?;
    f.add::<NodePackageRuntimeStatus>(
        "node-package-runtime-numeric-generation",
        json!({"id":"example.terminal","phase":"inactive","generation":0}),
        false,
    )?;
    f.add::<NodePackageRuntimeStatus>(
        "node-package-runtime-null-error",
        json!({"id":"example.terminal","phase":"inactive","generation":"0","error":null}),
        false,
    )?;
    f.add::<NodeViewAssetReadParams>(
        "node-view-asset-entry",
        json!({"viewId":"example.terminal.view","offset":"0"}),
        true,
    )?;
    f.add::<NodeViewAssetReadParams>(
        "node-view-asset-parent-path",
        json!({"viewId":"example.terminal.view","offset":"0","path":"ui/../private.html"}),
        false,
    )?;
    f.add::<QueryResult>(
        "node-view-asset-result",
        json!({"kind":"node_view_asset","value":{
            "packageId":"example.terminal","version":"1.0.0","archiveSha256":"a".repeat(64),
            "activationId":"activation-a",
            "view":{"id":"example.terminal.view","actionId":"example.terminal.open","stateScopes":[]},
            "target":{"hostId":"host","kind":"session","id":"terminal","sessionId":"terminal","sessionEpoch":"2"},
            "entry":"ui/index.html","path":"ui/index.html","offset":"0","totalBytes":"1",
            "sha256":"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
            "bytesBase64":"YQ==",
        }}),
        true,
    )?;
    f.add::<ActionResult>(
        "node-package-install-action-result",
        json!({"kind":"node_package_installed","value":install_result}),
        true,
    )?;
    let mut invalid = installed.clone();
    invalid["packages"][0]["objectId"] = json!("private-code-object");
    f.add::<NodePackageListResult>("node-packages-private-object", invalid, false)?;
    let mut invalid = installed;
    invalid["revision"] = json!(1);
    f.add::<NodePackageListResult>("node-packages-numeric-revision", invalid, false)?;
    let local = json!({"archiveRef":{"hostId":"host","kind":"file","id":"archive"},"source":{"kind":"local"}});
    f.add::<NodePackageInstallParams>("node-package-install-local", local.clone(), true)?;
    let mut trusted = local.clone();
    trusted["source"] = json!({"kind":"trusted","source":"source","keyId":"key"});
    f.add::<NodePackageInstallParams>("node-package-install-trusted", trusted.clone(), true)?;
    trusted["source"]["publicKey"] = json!("package-cannot-choose-a-trusted-key");
    f.add::<NodePackageInstallParams>("node-package-install-supplied-key", trusted, false)?;
    let mut invalid = local.clone();
    invalid["path"] = json!("unregistered.zip");
    f.add::<NodePackageInstallParams>("node-package-install-arbitrary-path", invalid, false)?;
    let mut invalid = local;
    invalid["source"] = Value::Null;
    f.add::<NodePackageInstallParams>("node-package-install-null-source", invalid, false)?;
    // 此处验证 wire 结构；实际公钥曲线、用户身份及提交条件另经 Host 验收。
    let source_fingerprint = "72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793";
    let source_key = json!({"source":"source","keyId":"key","publicKey":vec![1u8;32],"publicKeySha256":source_fingerprint,"approved":true});
    f.add::<NodePackageSourceKey>("node-source-key", source_key.clone(), true)?;
    f.add::<NodeSourceListParams>("node-sources-default-page", json!({}), true)?;
    f.add::<NodeSourceListParams>("node-sources-numeric-offset", json!({"offset":1}), false)?;
    f.add::<NodeSourceListParams>(
        "node-sources-null-revision",
        json!({"expectedRevision":null}),
        false,
    )?;
    f.add::<NodeSourceListResult>(
        "node-sources-empty",
        json!({"revision":"0","keys":[]}),
        true,
    )?;
    let source_result = json!({"revision":"1","key":source_key});
    f.add::<NodeSourceChangeResult>("node-source-changed", source_result.clone(), true)?;
    f.add::<ActionResult>(
        "node-source-action-result",
        json!({"kind":"node_source_changed","value":source_result}),
        true,
    )?;
    let source_approval = json!({"source":"source","keyId":"key","publicKey":vec![1u8;32],"publicKeySha256":source_fingerprint});
    f.add::<NodeSourceApproveParams>("node-source-approve", source_approval.clone(), true)?;
    for (name, key) in [
        ("short-key", json!(vec![1u8; 31])),
        ("out-of-range-key", json!(vec![256; 32])),
    ] {
        let mut invalid = source_approval.clone();
        invalid["publicKey"] = key;
        f.add::<NodeSourceApproveParams>(&format!("node-source-approve-{name}"), invalid, false)?;
    }
    let mut invalid = source_approval;
    invalid["userConfirmed"] = json!(true);
    f.add::<NodeSourceApproveParams>("node-source-cannot-self-confirm", invalid, false)?;
    f.add::<NodeSourceRevokeParams>(
        "node-source-revoke",
        json!({"source":"source","keyId":"key","publicKeySha256":source_fingerprint}),
        true,
    )?;
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() != 2 || args[0] != "--out" {
        return Err("Usage: export-contracts --out <directory>".into());
    }
    let out = PathBuf::from(&args[1]);
    let mut types = specta::Types::default();
    let mut schemas = BTreeMap::new();
    macro_rules! register {($($t:ty),* $(,)?)=>{$(types=types.register::<$t>();schemas.insert(<$t>::schema_name().into_owned(),schema::<$t>());)*};}
    register!(
        U64,
        Id,
        RequestId,
        Digest,
        ContextToken,
        IpcChannel,
        WireFrame,
        IpcMessage,
        HttpControlRequest,
        HttpControlEntry,
        LanAccessParams,
        LanAccessResult,
        ActionCheckParams,
        ActionCheckResult,
        AuthorizeParams,
        RevokeParams,
        Bytes,
        Timestamp,
        SignedDecimal,
        SafeInteger,
        JsonValue,
        QueryValue,
        PositiveU64,
        DurationMs,
        RetentionMs,
        ResourceKind,
        Target,
        ProtocolVersion,
        StartupConfigSource,
        StartupLogLevel,
        StartupProfileReference,
        StartupConfigSnapshot,
        ExecutionMode,
        ObjectRef,
        RevealTarget,
        Cursor,
        Query,
        Call,
        ChildCall,
        Snapshot,
        Delta,
        Limits,
        ClientKind,
        AttachParams,
        AttachResult,
        OperationResult,
        SubscriptionResult,
        ClosedResult,
        ObjectReadResult,
        CatalogListResult,
        CatalogListParams,
        OperationGetParams,
        OperationCancelParams,
        CancelReason,
        StateSnapshotParams,
        StateSubscribeParams,
        SubscriptionCloseParams,
        AuthorizationResult,
        CancellationResult,
        ShutdownRequested,
        QueryResult,
        RpcRequest,
        RpcResult,
        RpcReply,
        HostError,
        OperationState,
        OwnerKind,
        Owner,
        Dependency,
        Progress,
        Admission,
        ActionResult,
        ResultReference,
        Operation,
        DataBits,
        Parity,
        StopBits,
        FlowControl,
        TransportSemantics,
        SessionState,
        ControlState,
        ControlLine,
        PurgeDirection,
        PurgeScope,
        PurgeOutcome,
        LeaseKind,
        ExplicitLeaseKind,
        LeaseState,
        TakeoverReason,
        SerialConfiguration,
        LineEnding,
        Language,
        Theme,
        Accent,
        Radius,
        Font,
        FontSize,
        Motion,
        NetworkMode,
        BackgroundPreset,
        BackgroundSelection,
        BackgroundFit,
        TerminalMode,
        TerminalTypography,
        TerminalSettings,
        SharedSettings,
        SettingsSnapshot,
        SettingsSaveParams,
        LayoutTemplate,
        WorkspaceView,
        WorkspaceDocument,
        WorkspaceSnapshot,
        WorkspaceSaveParams,
        StateScopeRef,
        StateScopesResult,
        SettingsDocumentResult,
        WorkspaceDocumentResult,
        WorkspaceSummary,
        WorkspaceListParams,
        WorkspaceListResult,
        CommandLibraryReadParams,
        CommandLibraryReadResult,
        CommandLibraryChange,
        CommandLibraryRevision,
        DocumentImportParams,
        DocumentJsonResult,
        StreamCursorResult,
        FileTransferParams,
        PasteTransferParams,
        FileTransferResult,
        FileTransferReceipt,
        FileTransferReceiptsParams,
        FileTransferReceiptsResult,
        ReplayRecord,
        CaptureRecord,
        FileReadParams,
        FileReadResult,
        RegisterFileParams,
        FileMetadataParams,
        FileMetadata,
        CaptureTxSettlement,
        CaptureStatusResult,
        CaptureTailParams,
        CaptureTailResult,
        CaptureStorageLimits,
        CaptureStartParams,
        CaptureStopParams,
        CaptureVerifyParams,
        VerificationReport,
        RecoverPrefixParams,
        ReplayOpenParams,
        ReplayReadParams,
        ReplayReadResult,
        ReplayControlParams,
        TextExportParams,
        RecentList,
        RebindParams,
        FavoritesSaveParams,
        HostMetricsParams,
        MemoryBudget,
        DerivedMemoryMetrics,
        WorkerMemorySample,
        WorkerObservation,
        NodeMetrics,
        HostMetrics,
        ShutdownMode,
        ShutdownReport,
        ClientCapability,
        ClientEffectAction,
        ClientFullscreenParams,
        ClientWindowSizeParams,
        ClientResetGeometryParams,
        ClientClipboardWriteParams,
        ClientAutostartParams,
        ClientRegisterParams,
        ClientRegistration,
        ClientUnregisterParams,
        ClientReceiptSubmission,
        ClientSettingsObservation,
        ClientListItem,
        ClientListResult,
        ClientEffectRequest,
        ClientEffectReceipt,
        ClientUpdatePreparation,
        ClientEffectOutcome,
        ClientEffectResult,
        ClientEffectAcknowledged,
        OperationSummary,
        OperationsSnapshot,
        ActivitySnapshot,
        OperationInputParams,
        OperationInputRedaction,
        OperationInput,
        TransportCapabilities,
        SessionSnapshot,
        SessionMetrics,
        SessionInputs,
        ReconnectState,
        ReconnectStatus,
        OpenParams,
        DeviceBindingReference,
        OpenResult,
        ToolHandoffParams,
        ToolHandoffResult,
        TransformReference,
        TxParams,
        ConfigureParams,
        ControlParams,
        ControlReceipt,
        BreakParams,
        SetReadOnlyParams,
        Lease,
        LeaseAcquireParams,
        LeaseRenewParams,
        LeaseReleaseParams,
        TakeoverParams,
        TakeoverReceipt,
        WaitBoundaryParams,
        WaitBoundaryReceipt,
        QueueStatus,
        DrainParams,
        DrainReceipt,
        PurgeParams,
        PurgeReceipt,
        DeviceDescriptor,
        DeviceList,
        EmptyParams,
        TxOutcome,
        TxGate,
        FieldStatus,
        ControlStatus,
        ByteRange,
        TxReceipt,
        ConfigField,
        ConfigReceipt,
        ControlTransition,
        BreakReceipt,
        Direction,
        TimeSource,
        SourceGapReason,
        ReaderGapReason,
        OverflowPolicy,
        Certainty,
        TimePrecision,
        EventTime,
        MessageFragment,
        RxPayload,
        TxIntent,
        DirectionalRange,
        SourceGap,
        ConfigurationBoundary,
        RawPayload,
        RawEvent,
        ReaderGap,
        StreamItem,
        RawBatch,
        StreamReadParams,
        StreamReadResult,
        SourceRange,
        DerivedQuality,
        DerivedPublishParams,
        DerivedPublishResult,
        DerivedProvenance,
        DerivedSample,
        DerivedReadParams,
        DerivedReadResult,
        StreamSubscribeParams,
        StreamSubscribeResult,
        StreamCreditParams,
        StreamCreditResult,
        ActionKind,
        ExecutionLocation,
        Cancellation,
        ActionSpec,
        NodePackageId,
        NodePackageVersion,
        NodePackagePath,
        NodePackageManifest,
        NodePackageIntegrity,
        NodePackageSignature,
        NodePackageRegistration,
        VerifiedNodePackageSource,
        NodeExecutionTrust,
        NodePackageInstallation,
        NodePackageSummary,
        NodePackageListParams,
        NodePackageListResult,
        NodePackageDetailsReadParams,
        NodePackageDetailsReadResult,
        NodePackageInstallSource,
        NodePackageInstallParams,
        NodePackageChangeResult,
        NodePackageUninstallResult,
        NodePackageIdentityParams,
        NodePackageSetEnabledParams,
        NodePackageRuntimeParams,
        NodeViewAssetReadParams,
        NodeViewAssetReadResult,
        NodeThemeReference,
        NodeThemeTokens,
        NodeThemeEntry,
        NodeThemesResult,
        NodePackageRuntimePhase,
        NodePackageRuntimeStatus,
        NodePackageSourceKey,
        NodeSourceListParams,
        NodeSourceListResult,
        NodeSourceApproveParams,
        NodeSourceRevokeParams,
        NodeSourceChangeResult,
        NodeRuntimeRelease,
        NodeRuntimeSelfTest,
        NodeRuntimeLibraryRelease
    );
    let mut ts =
        specta_typescript::Typescript::default().export(&types, specta_serde::PhasesFormat)?;
    ts.push_str(&format!("\n/** 单次手动 TX 的最终字节上限，来源为 Rust 契约。 */\nexport const TX_MAX_BYTES = {TX_MAX_BYTES};\n"));
    ts.push_str(&format!(
        "\n/** 正式 Node 包的签名域前缀，来源为 Rust 契约。 */\nexport const NODE_PACKAGE_SIGNATURE_PREFIX = {};\n",
        serde_json::to_string(std::str::from_utf8(NODE_PACKAGE_SIGNATURE_PREFIX)?)?
    ));
    let fixtures = fixtures()?;
    let documents = [
        (
            "defaults.json",
            json!({
                "settings": SharedSettings::default(),
                "workspace": WorkspaceDocument::default(),
                "serialConfiguration": SerialConfiguration::default(),
                "terminalTypography": TerminalTypography::default(),
                "captureStorageLimits": CaptureStorageLimits::default(),
            }),
        ),
        (
            "schemas.json",
            json!({"schemaVersion":1,"protocolVersion":"0.1","schemas":schemas}),
        ),
        (
            "catalog.json",
            json!({"schemaVersion":1,"protocolVersion":"0.1","actions":builtin_catalog()}),
        ),
        ("fixtures.json", serde_json::to_value(fixtures)?),
    ];
    std::fs::create_dir_all(&out)?;
    std::fs::write(out.join("types.ts"), ts)?;
    for (name, value) in documents {
        std::fs::write(
            out.join(name),
            format!("{}\n", serde_json::to_string_pretty(&value)?),
        )?;
    }
    Ok(())
}
