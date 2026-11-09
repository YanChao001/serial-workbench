use serde_json::{Value, json};
use serial_workbench_core::*;

fn start_params() -> Value {
    json!({
        "sessionRefs": [],
        "targetRef": {"hostId":"h","kind":"file","id":"location"},
        "overflowPolicy":"stop"
    })
}

#[test]
fn defaults_roundtrip_through_business_json_without_precision_loss() {
    let expected = json!({"capacityBytes":"1073741824","reserveBytes":"134217728"});
    assert_eq!(
        serde_json::to_value(CaptureStorageLimits::default()).unwrap(),
        expected
    );
    let mut value = start_params();
    value["storageLimits"] = expected.clone();
    let business: JsonObject = serde_json::from_value(value).unwrap();
    let decoded: CaptureStartParams =
        serde_json::from_value(serde_json::to_value(business).unwrap()).unwrap();
    assert_eq!(
        serde_json::to_value(decoded.storage_limits).unwrap(),
        expected
    );
    let omitted: CaptureStartParams = serde_json::from_value(start_params()).unwrap();
    assert!(omitted.storage_limits.is_none());
    assert!(
        serde_json::to_value(omitted)
            .unwrap()
            .get("storageLimits")
            .is_none()
    );
}

#[test]
fn storage_limits_accept_positive_capacity_and_zero_reserve_at_u64_boundaries() {
    for (capacity, reserve) in [("1", "0"), ("18446744073709551615", "18446744073709551615")] {
        let expected = json!({"capacityBytes":capacity,"reserveBytes":reserve});
        let business: JsonObject = serde_json::from_value(expected.clone()).unwrap();
        let decoded: CaptureStorageLimits =
            serde_json::from_value(serde_json::to_value(business).unwrap()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
    }
}

#[test]
fn storage_limits_reject_zero_capacity_invalid_numbers_null_and_unknown_fields() {
    for invalid in [
        json!("0"),
        json!("-1"),
        json!("18446744073709551616"),
        json!("01"),
        json!(1),
        json!(1.5),
        Value::Null,
    ] {
        assert!(
            serde_json::from_value::<CaptureStorageLimits>(
                json!({"capacityBytes":invalid,"reserveBytes":"0"})
            )
            .is_err(),
            "capacity {invalid}"
        );
    }
    for invalid in [
        json!("-1"),
        json!("18446744073709551616"),
        json!("01"),
        json!(0),
        json!(0.5),
        Value::Null,
    ] {
        assert!(
            serde_json::from_value::<CaptureStorageLimits>(
                json!({"capacityBytes":"1","reserveBytes":invalid})
            )
            .is_err(),
            "reserve {invalid}"
        );
    }
    for invalid in [
        json!({"capacityBytes":"1"}),
        json!({"reserveBytes":"0"}),
        json!({"capacityBytes":"1","reserveBytes":"0","path":"elsewhere"}),
    ] {
        assert!(serde_json::from_value::<CaptureStorageLimits>(invalid).is_err());
    }
    let mut params = start_params();
    params["storageLimits"] = Value::Null;
    assert!(serde_json::from_value::<CaptureStartParams>(params).is_err());
}

fn resolve<'a>(root: &'a Value, value: &'a Value) -> &'a Value {
    match value.get("$ref").and_then(Value::as_str) {
        Some(reference) => root.pointer(reference.strip_prefix('#').unwrap()).unwrap(),
        None => value,
    }
}

#[test]
fn schemas_preserve_strict_decimal_ranges_and_optional_non_null_storage_limits() {
    for dialect in [SchemaDialect::Draft07, SchemaDialect::Draft202012] {
        let schema = schema_for::<CaptureStorageLimits>(dialect);
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(schema["required"], json!(["capacityBytes", "reserveBytes"]));
        for (field, expected) in [
            ("capacityBytes", schema_for::<PositiveU64>(dialect)),
            ("reserveBytes", schema_for::<U64>(dialect)),
        ] {
            let property = resolve(&schema, &schema["properties"][field]);
            assert_eq!(property["type"], "string");
            assert_eq!(property["pattern"], expected["pattern"]);
            assert_eq!(property.get("not"), expected.get("not"));
        }
        let start = schema_for::<CaptureStartParams>(dialect);
        assert!(
            !start["required"]
                .as_array()
                .unwrap()
                .contains(&json!("storageLimits"))
        );
        let property = resolve(&start, &start["properties"]["storageLimits"]);
        assert_eq!(property["type"], "object");
        assert_eq!(property["additionalProperties"], false);
        assert_eq!(
            property["required"],
            json!(["capacityBytes", "reserveBytes"])
        );
    }
}
