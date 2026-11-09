use serde_json::{Value, json};
use serial_workbench_core::*;

#[test]
fn capture_tail_defaults_and_strict_budgets_are_rust_owned() {
    let reference = json!({"hostId":"h","kind":"capture","id":"c"});
    let params: CaptureTailParams =
        serde_json::from_value(json!({"captureRef":reference})).unwrap();
    assert_eq!(params.max_records.get(), 100);
    assert_eq!(params.max_bytes.get(), 262144);
    for (field, values) in [
        (
            "maxRecords",
            vec![
                json!("0"),
                json!("101"),
                json!(100),
                Value::Null,
                json!("01"),
            ],
        ),
        (
            "maxBytes",
            vec![
                json!("0"),
                json!("262145"),
                json!(262144),
                Value::Null,
                json!("18446744073709551615"),
            ],
        ),
    ] {
        for invalid in values {
            let mut value = json!({"captureRef":reference});
            value[field] = invalid;
            assert!(serde_json::from_value::<CaptureTailParams>(value).is_err());
        }
    }
    assert!(
        serde_json::from_value::<CaptureTailParams>(
            json!({"captureRef":reference,"path":"forged"})
        )
        .is_err()
    );
    let action = BuiltinAction::find("capture.tail").unwrap();
    let spec = action.spec();
    assert_eq!(spec.kind, ActionKind::Query);
    assert_eq!(spec.permissions, vec!["content.read"]);
    assert!(action.is_capture_api());
    for dialect in [SchemaDialect::Draft07, SchemaDialect::Draft202012] {
        let schema = schema_for::<CaptureTailParams>(dialect);
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["captureRef"]));
        assert_eq!(schema["properties"]["maxRecords"]["type"], "string");
        assert_eq!(schema["properties"]["maxBytes"]["type"], "string");
    }
}

#[test]
fn capture_tail_exporter_emits_real_positive_and_negative_vectors() {
    let temp = tempfile::tempdir().unwrap();
    let result = std::process::Command::new(env!("CARGO_BIN_EXE_export-contracts"))
        .args(["--out", temp.path().to_str().unwrap()])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let fixtures: Value =
        serde_json::from_slice(&std::fs::read(temp.path().join("fixtures.json")).unwrap()).unwrap();
    for (group, name) in [
        ("valid", "capture-tail-defaults"),
        ("valid", "capture-tail-result"),
        ("invalid", "capture-tail-record-limit"),
        ("invalid", "capture-tail-byte-limit"),
        ("invalid", "capture-tail-unknown-field"),
    ] {
        assert!(
            fixtures[group]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f["name"] == name),
            "missing {name}"
        );
    }
}
