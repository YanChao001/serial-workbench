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
fn fixtures() -> Result<Fixtures, Box<dyn Error>> {
    let mut f = Fixtures {
        schema_version: 1,
        ..Fixtures::default()
    };
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
    Ok(f)
}

fn ipc_fixtures(f: &mut Fixtures) -> Result<(), Box<dyn Error>> {
    let cursor = json!({"hostId":"host","instanceEpoch":"7","scopeId":"scope","position":"1"});
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
        AuthorizeParams,
        RevokeParams,
        Bytes,
        Timestamp,
        SignedDecimal,
        SafeInteger,
        JsonValue,
        PositiveU64,
        DurationMs,
        RetentionMs,
        ResourceKind,
        Target,
        ProtocolVersion,
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
        StreamSubscribeParams,
        StreamSubscribeResult,
        StreamCreditParams,
        StreamCreditResult,
        ActionKind,
        ExecutionLocation,
        Cancellation,
        ActionSpec
    );
    let ts = specta_typescript::Typescript::default().export(&types, specta_serde::PhasesFormat)?;
    let fixtures = fixtures()?;
    let documents = [
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
