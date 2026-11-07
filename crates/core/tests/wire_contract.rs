use serde_json::{Value, json};
use serial_workbench_core::{Call, ChildCall, Operation, RpcReply, U64};

#[test]
fn query_action_results_and_selectors_are_concrete() {
    use serial_workbench_core::*;
    let value =
        json!({"kind":"authorization_changed","value":{"grantRevision":"9007199254740993"}});
    let result: ActionResult = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(result).unwrap(), value);
    assert!(serde_json::from_value::<ActionResult>(json!({"arbitrary":true})).is_err());
    assert!(serde_json::from_value::<OperationGetParams>(json!({"operationId":"op","actorId":"actor","requestId":"33333333-3333-4333-8333-333333333333","requestContext":"token"})).is_err());
    let mut envelope = call();
    envelope.as_object_mut().unwrap().remove("requestContext");
    envelope["actionId"] = json!("stream.read");
    let query: Query = serde_json::from_value(envelope).unwrap();
    assert_eq!(
        RpcRequest::Query(query.clone()).required_channel().unwrap(),
        RequestChannel::Raw
    );
    assert_eq!(
        RpcRequest::StateSnapshot(query)
            .required_channel()
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
}

#[test]
fn typed_catalog_schema_dialects_keep_correct_target_dependency_keyword() {
    use serial_workbench_core::*;
    let old = schema_for::<Target>(SchemaDialect::Draft07);
    let current = schema_for::<Target>(SchemaDialect::Draft202012);
    assert!(old.get("dependencies").is_some());
    assert!(old.get("dependentRequired").is_none());
    assert!(current.get("dependentRequired").is_some());
    assert!(current.get("dependencies").is_none());
    for action in BuiltinAction::ALL {
        let modern =
            serde_json::to_value(action.spec_with_dialect(SchemaDialect::Draft202012)).unwrap();
        assert_eq!(
            modern["inputSchema"]["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
        assert_eq!(modern["actionId"], action.action_id());
    }
}

fn call() -> Value {
    json!({"protocolVersion":"0.1","hostId":"host","instanceEpoch":"7","actorId":"actor",
        "requestId":"33333333-3333-4333-8333-333333333333","requestContext":"dG9rZW4",
        "actionId":"session.tx","target":{"hostId":"host","kind":"session","id":"session",
        "sessionId":"session","sessionEpoch":"9007199254740993"},"params":{"bytesBase64":"DQo=","writeWaitMs":"1000"},
        "revealTarget":{"pageId":"workbench"}})
}

#[test]
fn counters_roundtrip_without_javascript_precision_loss() {
    let n: U64 = serde_json::from_value(json!("9007199254740993")).unwrap();
    assert_eq!(serde_json::to_value(n).unwrap(), json!("9007199254740993"));
    assert_eq!(
        serde_json::to_value(n.checked_next().unwrap()).unwrap(),
        json!("9007199254740994")
    );
    let max = U64::try_from("18446744073709551615").unwrap();
    assert_eq!(max.checked_next().unwrap_err().code, "COUNTER_EXHAUSTED");
}

#[test]
fn counters_reject_noncanonical_and_out_of_range_values() {
    for value in [
        json!("01"),
        json!("+1"),
        json!("1e3"),
        json!(1),
        json!("18446744073709551616"),
        json!(""),
        json!("-1"),
    ] {
        assert!(
            serde_json::from_value::<U64>(value.clone()).is_err(),
            "{value}"
        );
    }
}

#[test]
fn call_requires_context_epoch_and_reveal_and_checks_target_identity() {
    assert!(serde_json::from_value::<Call>(call()).is_ok());
    for field in ["requestContext", "instanceEpoch", "revealTarget"] {
        let mut value = call();
        value.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Call>(value).is_err(), "{field}");
    }
    for field in ["sessionId", "sessionEpoch"] {
        let mut value = call();
        value["target"].as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<Call>(value).is_err(), "{field}");
    }
    let mut value = call();
    value["target"]["id"] = json!("different");
    assert!(
        serde_json::from_value::<Call>(value)
            .unwrap()
            .target
            .validate()
            .is_err()
    );
}

#[test]
fn business_json_rejects_unsafe_numbers_and_optional_nulls() {
    for number in [json!(9007199254740992u64), json!(1.5)] {
        let mut value = call();
        value["params"]["number"] = number;
        assert!(serde_json::from_value::<Call>(value).is_err());
    }
    let mut value = call();
    value["expectedRevision"] = Value::Null;
    assert!(serde_json::from_value::<Call>(value).is_err());
}

#[test]
fn child_call_cannot_override_root_identity_or_execution_mode() {
    let mut value = call();
    for field in ["requestId", "requestContext"] {
        value.as_object_mut().unwrap().remove(field);
    }
    value["taskContext"] = json!("dG9rZW4");
    value["parentOperationId"] = json!("parent");
    value["childKey"] = json!("1");
    assert!(serde_json::from_value::<ChildCall>(value.clone()).is_ok());
    for field in [
        "requestId",
        "requestContext",
        "rootOperationId",
        "executionMode",
    ] {
        let mut invalid = value.clone();
        invalid[field] = json!("forbidden");
        assert!(
            serde_json::from_value::<ChildCall>(invalid).is_err(),
            "{field}"
        );
    }
    value["childKey"] = json!("0");
    assert!(serde_json::from_value::<ChildCall>(value).is_err());
}

#[test]
fn operation_requires_admission_lineage_and_has_no_partial_state() {
    let mut value = json!({"operationId":"op","executionHostId":"host","actorId":"actor",
        "requestId":"33333333-3333-4333-8333-333333333333","admission":{"kind":"request","requestContextDigest":"a".repeat(64)},
        "rootOperationId":"op","childHighWatermark":"0","actionId":"session.tx","target":{"hostId":"host","kind":"host","id":"host"},
        "executionMode":"interactive","state":"queued","revision":"1","revealTarget":{"pageId":"workbench"},
        "acceptedAt":"2026-11-07T00:00:00Z","owner":{"kind":"host","id":"host"}});
    assert!(serde_json::from_value::<Operation>(value.clone()).is_ok());
    for field in ["admission", "rootOperationId", "childHighWatermark"] {
        let mut invalid = value.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<Operation>(invalid).is_err(),
            "{field}"
        );
    }
    value["state"] = json!("partial");
    assert!(serde_json::from_value::<Operation>(value).is_err());
}

#[test]
fn reply_boolean_discriminant_matches_payload() {
    assert!(
        serde_json::from_value::<RpcReply>(
            json!({"ok":false,"error":{"code":"NOT_FOUND","message":"Missing","retryable":false}})
        )
        .is_ok()
    );
    assert!(
        serde_json::from_value::<RpcReply>(
            json!({"ok":true,"error":{"code":"NOT_FOUND","message":"Missing","retryable":false}})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<RpcReply>(json!({"ok":true,"result":{"arbitrary":"success"}}))
            .is_err()
    );
}

#[test]
fn timestamp_rejects_nonexistent_calendar_dates() {
    for value in [
        "2026-02-29T00:00:00Z",
        "2026-02-31T00:00:00Z",
        "2100-02-29T00:00:00Z",
        "2026-04-31T00:00:00Z",
    ] {
        assert!(
            serde_json::from_value::<serial_workbench_core::Timestamp>(json!(value)).is_err(),
            "{value}"
        );
    }
    assert!(
        serde_json::from_value::<serial_workbench_core::Timestamp>(json!(
            "2000-02-29T00:00:00.123Z"
        ))
        .is_ok()
    );
}

#[test]
fn timestamp_accepts_utc_rfc3339_forms_and_bounds_leap_seconds() {
    for value in [
        "2026-11-07t00:00:00z",
        "2026-11-07T00:00:00+00:00",
        "2016-12-31T23:59:60Z",
    ] {
        assert!(
            serde_json::from_value::<serial_workbench_core::Timestamp>(json!(value)).is_ok(),
            "{value}"
        );
    }
    for value in [
        "2016-12-30T23:59:60Z",
        "2016-12-31T12:59:60Z",
        "2026-11-07T00:00:00+08:00",
        "2026-11-07T00:00:00-00:00",
    ] {
        assert!(
            serde_json::from_value::<serial_workbench_core::Timestamp>(json!(value)).is_err(),
            "{value}"
        );
    }
}
