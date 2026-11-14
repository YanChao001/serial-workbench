use serde_json::Value;
use std::process::Command;

#[test]
fn exports_self_contained_schemas_and_rust_owned_types_only_to_requested_directory() {
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("contracts");
    let result = Command::new(env!("CARGO_BIN_EXE_export-contracts"))
        .args(["--out", output.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let mut names = std::fs::read_dir(&output)
        .unwrap()
        .map(|p| p.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(
        names,
        [
            "catalog.json",
            "defaults.json",
            "fixtures.json",
            "schemas.json",
            "types.ts"
        ]
    );
    let defaults_bytes = std::fs::read(output.join("defaults.json")).unwrap();
    let defaults: Value = serde_json::from_slice(&defaults_bytes).unwrap();
    assert_eq!(
        defaults
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "captureStorageLimits",
            "serialConfiguration",
            "settings",
            "terminalTypography",
            "workspace"
        ]
    );
    assert_eq!(
        defaults["settings"],
        serde_json::to_value(serial_workbench_core::SharedSettings::default()).unwrap()
    );
    assert_eq!(
        defaults["workspace"],
        serde_json::to_value(serial_workbench_core::WorkspaceDocument::default()).unwrap()
    );
    assert_eq!(
        defaults["serialConfiguration"],
        serde_json::to_value(serial_workbench_core::SerialConfiguration::default()).unwrap()
    );
    assert_eq!(
        defaults["terminalTypography"],
        serde_json::to_value(serial_workbench_core::TerminalTypography::default()).unwrap()
    );
    assert_eq!(
        defaults["captureStorageLimits"],
        serde_json::to_value(serial_workbench_core::CaptureStorageLimits::default()).unwrap()
    );
    assert_eq!(
        defaults["captureStorageLimits"],
        serde_json::json!({"capacityBytes":"1073741824","reserveBytes":"134217728"})
    );
    let schemas: Value =
        serde_json::from_slice(&std::fs::read(output.join("schemas.json")).unwrap()).unwrap();
    assert_eq!(schemas["schemaVersion"], 1);
    assert_eq!(schemas["protocolVersion"], "0.1");
    assert_eq!(
        schemas["schemas"]["RpcReply"]["$schema"],
        "http://json-schema.org/draft-07/schema#"
    );
    let types = std::fs::read_to_string(output.join("types.ts")).unwrap();
    assert!(types.contains("ok: true"));
    assert!(types.contains("ok: false"));
    assert!(types.contains("export type U64 = string"));
    for name in [
        "IpcChannel",
        "IpcMessage",
        "WireFrame",
        "AuthorizeParams",
        "RevokeParams",
    ] {
        assert!(types.contains(&format!("export type {name} =")));
        assert!(schemas["schemas"][name].is_object());
    }
    assert!(types.contains("authenticateUserControl"));
    assert!(types.contains("expectedHostId?: Id"));
    let fixtures: Value =
        serde_json::from_slice(&std::fs::read(output.join("fixtures.json")).unwrap()).unwrap();
    for name in [
        "root-call",
        "ipc-rawAttached",
        "ipc-authenticateUserControl",
        "authorize",
        "revoke",
    ] {
        assert!(
            fixtures["valid"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["name"] == name)
        );
    }
    for name in [
        "ipc-rawAttached-unknown",
        "ipc-user-control-null-credential",
        "authorize-null-expiry",
    ] {
        assert!(
            fixtures["invalid"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["name"] == name)
        );
    }
    let first = std::fs::read(output.join("schemas.json")).unwrap();
    assert!(
        Command::new(env!("CARGO_BIN_EXE_export-contracts"))
            .args(["--out", output.to_str().unwrap()])
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(first, std::fs::read(output.join("schemas.json")).unwrap());
    assert_eq!(
        defaults_bytes,
        std::fs::read(output.join("defaults.json")).unwrap()
    );
}

#[test]
fn exports_complete_m1_wire_roots_and_catalog_uses_the_same_schemas() {
    let output = tempfile::tempdir().unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_export-contracts"))
        .args(["--out", output.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let read = |name| {
        serde_json::from_slice::<Value>(&std::fs::read(output.path().join(name)).unwrap()).unwrap()
    };
    let document = read("schemas.json");
    let schemas = &document["schemas"];
    let types = std::fs::read_to_string(output.path().join("types.ts")).unwrap();
    for name in [
        "DataBits",
        "Parity",
        "StopBits",
        "FlowControl",
        "TransportSemantics",
        "SessionState",
        "ControlState",
        "ControlLine",
        "PurgeDirection",
        "PurgeScope",
        "PurgeOutcome",
        "LeaseKind",
        "ExplicitLeaseKind",
        "LeaseState",
        "TakeoverReason",
        "SerialConfiguration",
        "LineEnding",
        "TransportCapabilities",
        "SessionSnapshot",
        "SessionMetrics",
        "SessionInputs",
        "CaptureStorageLimits",
        "OpenParams",
        "OpenResult",
        "TransformReference",
        "TxParams",
        "ConfigureParams",
        "ControlParams",
        "ControlReceipt",
        "BreakParams",
        "SetReadOnlyParams",
        "Lease",
        "LeaseAcquireParams",
        "LeaseRenewParams",
        "LeaseReleaseParams",
        "TakeoverParams",
        "TakeoverReceipt",
        "WaitBoundaryParams",
        "WaitBoundaryReceipt",
        "QueueStatus",
        "DrainParams",
        "DrainReceipt",
        "PurgeParams",
        "PurgeReceipt",
        "DeviceDescriptor",
        "DeviceList",
        "EmptyParams",
        "TxIntent",
        "ShutdownRequested",
    ] {
        assert!(schemas[name].is_object(), "missing standalone {name}");
        assert!(
            types.contains(&format!("export type {name} =")),
            "missing TypeScript {name}"
        );
    }
    for internal in [
        "BackendError",
        "BackendWrite",
        "ReadBlock",
        "ConfigApplication",
        "ControlCommand",
        "ControlResult",
        "Transport",
    ] {
        assert!(
            schemas.get(internal).is_none(),
            "internal schema {internal}"
        );
        assert!(
            !types.contains(&format!("export type {internal} =")),
            "internal TypeScript {internal}"
        );
    }
    assert!(types.contains("actual?: Exclude<JsonValue, null>"));
    fn check_refs(root: &Value, current: &Value) {
        match current {
            Value::Object(map) => {
                if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
                    assert!(
                        reference == "#" || reference.starts_with("#/"),
                        "external schema reference {reference}"
                    );
                    assert!(
                        root.pointer(&reference[1..]).is_some(),
                        "unresolved schema reference {reference}"
                    );
                }
                for value in map.values() {
                    check_refs(root, value);
                }
            }
            Value::Array(values) => {
                for value in values {
                    check_refs(root, value);
                }
            }
            _ => {}
        }
    }
    for (name, schema) in schemas.as_object().unwrap() {
        assert_eq!(
            schema["$schema"], "http://json-schema.org/draft-07/schema#",
            "{name}"
        );
        check_refs(schema, schema);
    }
    let catalog = read("catalog.json");
    let read_schema = |value: &Value| {
        serde_json::from_value::<serial_workbench_core::SchemaObject>(value.clone()).unwrap()
    };
    for (action, input, output) in [
        ("host.shutdown", "EmptyParams", "ShutdownRequested"),
        ("device.list", "EmptyParams", "DeviceList"),
        ("device.open", "OpenParams", "OpenResult"),
        ("session.get", "EmptyParams", "SessionSnapshot"),
        ("session.metrics", "EmptyParams", "SessionMetrics"),
        ("session.inputs", "EmptyParams", "SessionInputs"),
        ("session.close", "EmptyParams", "SessionSnapshot"),
        ("session.tx", "TxParams", "TxReceipt"),
        ("session.configure", "ConfigureParams", "ConfigReceipt"),
        ("session.control", "ControlParams", "ControlReceipt"),
        ("session.break", "BreakParams", "BreakReceipt"),
        (
            "session.setReadOnly",
            "SetReadOnlyParams",
            "SessionSnapshot",
        ),
        ("session.takeover", "TakeoverParams", "TakeoverReceipt"),
        ("lease.acquire", "LeaseAcquireParams", "Lease"),
        ("lease.renew", "LeaseRenewParams", "Lease"),
        ("lease.release", "LeaseReleaseParams", "Lease"),
        (
            "tx.waitBoundary",
            "WaitBoundaryParams",
            "WaitBoundaryReceipt",
        ),
        ("tx.queueStatus", "EmptyParams", "QueueStatus"),
        ("tx.drain", "DrainParams", "DrainReceipt"),
        ("session.purge", "PurgeParams", "PurgeReceipt"),
        ("stream.read", "StreamReadParams", "StreamReadResult"),
        (
            "stream.subscribe",
            "StreamSubscribeParams",
            "StreamSubscribeResult",
        ),
        ("stream.credit", "StreamCreditParams", "StreamCreditResult"),
    ] {
        let spec = catalog["actions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["actionId"] == action)
            .unwrap();
        if action == "host.shutdown" {
            assert_eq!(spec["kind"], "action");
            assert_eq!(spec["targetKinds"], serde_json::json!(["host"]));
            assert_eq!(spec["permissions"], serde_json::json!(["auth.manage"]));
            assert_eq!(spec["cancellation"], "none");
            assert_eq!(spec["executionLocation"], "resource_host");
        }
        assert_eq!(
            read_schema(&spec["inputSchema"]),
            read_schema(&schemas[input]),
            "{action} input"
        );
        assert_eq!(
            read_schema(&spec["outputSchema"]),
            read_schema(&schemas[output]),
            "{action} output"
        );
    }
    let fixtures = read("fixtures.json");
    for (category, required) in [
        (
            "valid",
            &[
                "serial-configuration",
                "session-snapshot",
                "tx-limit-16384",
                "tx-limit-16385",
                "tx-draft-16500",
                "tx-limit-maximum",
                "takeover",
                "raw-tx-intent",
                "raw-tx-final",
                "stream-zero-credit",
                "query-stream-read",
                "action-opened",
                "shutdown-requested",
                "action-shutdown-requested",
                "ipc-catalogChanged",
            ][..],
        ),
        (
            "invalid",
            &[
                "serial-configuration-missing-baudRate",
                "serial-data-bits-number",
                "tx-limit-over-one",
                "tx-limit-over-two",
                "tx-empty",
                "takeover-missing-actorId",
                "control-receipt-null-actual",
                "configuration-field-null-actual",
                "configuration-receipt-requested-missing-baudRate",
                "tx-intent-missing-operationId",
                "shutdown-requested-missing-instanceEpoch",
                "ipc-catalogChanged-missing-visibilityToken",
            ][..],
        ),
    ] {
        let entries = fixtures[category].as_array().unwrap();
        for name in required {
            assert!(
                entries.iter().any(|entry| entry["name"] == *name),
                "missing fixture {name}"
            );
        }
    }
    let mut fixture_names = std::collections::BTreeSet::new();
    for category in ["valid", "invalid"] {
        for entry in fixtures[category].as_array().unwrap() {
            let name = entry["name"].as_str().unwrap();
            assert!(fixture_names.insert(name), "duplicate fixture {name}");
            assert!(
                schemas[entry["schema"].as_str().unwrap()].is_object(),
                "fixture schema missing for {name}"
            );
        }
    }
}
