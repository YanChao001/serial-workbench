use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use serial_workbench_core::*;

fn configuration() -> Value {
    json!({"baudRate":"9600","dataBits":"8","parity":"none","stopBits":"one","flowControl":"none","readWaitMs":"1","writeWaitMs":"1000","reconnectBackoffMs":"2147483647"})
}
fn roundtrip<T: DeserializeOwned + Serialize>(value: Value) {
    let actual: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(actual).unwrap(), value);
}

#[test]
fn full_serial_configuration_rejects_partial_null_and_unknown_fields() {
    roundtrip::<SerialConfiguration>(configuration());
    for field in configuration().as_object().unwrap().keys() {
        let mut value = configuration();
        value.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<SerialConfiguration>(value).is_err(),
            "missing {field}"
        );
        let mut value = configuration();
        value[field] = Value::Null;
        assert!(
            serde_json::from_value::<SerialConfiguration>(value).is_err(),
            "null {field}"
        );
    }
    let mut value = configuration();
    value["unknown"] = json!(true);
    assert!(serde_json::from_value::<SerialConfiguration>(value).is_err());
    for field in ["readWaitMs", "writeWaitMs", "reconnectBackoffMs"] {
        for invalid in [json!("0"), json!("2147483648"), json!(1)] {
            let mut value = configuration();
            value[field] = invalid;
            assert!(
                serde_json::from_value::<SerialConfiguration>(value).is_err(),
                "{field}"
            );
        }
    }
    for invalid in [json!("0"), json!(9600)] {
        let mut value = configuration();
        value["baudRate"] = invalid;
        assert!(serde_json::from_value::<SerialConfiguration>(value).is_err());
    }
    let mut maximum = configuration();
    maximum["baudRate"] = json!("18446744073709551615");
    roundtrip::<SerialConfiguration>(maximum);
}

#[test]
fn serial_enumerations_keep_string_data_bits_and_camel_case_values() {
    for value in ["5", "6", "7", "8"] {
        roundtrip::<DataBits>(json!(value));
    }
    for value in ["none", "even", "odd", "mark", "space"] {
        roundtrip::<Parity>(json!(value));
    }
    for value in ["one", "onePointFive", "two"] {
        roundtrip::<StopBits>(json!(value));
    }
    for value in ["none", "rtsCts", "xonXoff", "dsrDtr"] {
        roundtrip::<FlowControl>(json!(value));
    }
    for value in [json!(8), json!("9"), Value::Null] {
        assert!(serde_json::from_value::<DataBits>(value).is_err());
    }
    assert!(serde_json::from_value::<StopBits>(json!("one_point_five")).is_err());
    assert!(serde_json::from_value::<FlowControl>(json!("rts_cts")).is_err());
}

#[test]
fn configuration_receipt_requires_the_complete_requested_configuration() {
    let value = json!({"requested":configuration(),"fields":[],"readback":{},"revision":"1","boundaryEventSeq":"1","txGate":"configuration_pending"});
    roundtrip::<ConfigReceipt>(value.clone());
    for field in configuration().as_object().unwrap().keys() {
        let mut invalid = value.clone();
        invalid["requested"].as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<ConfigReceipt>(invalid).is_err(),
            "missing requested.{field}"
        );
    }
    let mut unknown = value;
    unknown["requested"]["unknown"] = json!(true);
    assert!(serde_json::from_value::<ConfigReceipt>(unknown).is_err());
}

#[test]
fn manual_tx_accepts_a_16_point_5_kb_ascii_draft() {
    let value = json!({"bytesBase64":"MTIz".repeat(5500),"writeWaitMs":"22000"});
    let actual = serde_json::from_value::<TxParams>(value);
    assert!(actual.is_ok(), "16.50 KB draft rejected: {actual:?}");
}

#[test]
fn tx_params_limit_decoded_bytes_even_when_base64_lengths_match() {
    // 最大值和紧邻的超限值仍占相同的 Base64 字符数。
    let maximum = format!("{}AAA=", "AAAA".repeat(TX_MAX_BYTES / 3));
    let over_one = "AAAA".repeat(TX_MAX_BYTES / 3 + 1);
    assert_eq!(maximum.len(), over_one.len());
    roundtrip::<TxParams>(json!({"bytesBase64":maximum,"writeWaitMs":"1"}));
    for invalid in [
        over_one,
        format!("{}AA==", "AAAA".repeat(TX_MAX_BYTES / 3 + 1)),
    ] {
        assert!(
            serde_json::from_value::<TxParams>(json!({"bytesBase64":invalid,"writeWaitMs":"1"}))
                .is_err(),
            "oversized TX accepted"
        );
    }
    assert!(
        serde_json::from_value::<TxParams>(json!({"bytesBase64":"","writeWaitMs":"1"})).is_err()
    );
    roundtrip::<Bytes>(json!(""));
}

#[test]
fn lease_ttl_and_takeover_are_explicit_and_bounded() {
    for value in ["1", "2147483647"] {
        roundtrip::<LeaseAcquireParams>(json!({"kind":"exclusive","ttlMs":value}));
        roundtrip::<LeaseRenewParams>(json!({"leaseId":"lease","ttlMs":value}));
    }
    for value in [json!("0"), json!("2147483648"), json!(1), Value::Null] {
        assert!(
            serde_json::from_value::<LeaseAcquireParams>(
                json!({"kind":"transaction","ttlMs":value})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<LeaseRenewParams>(json!({"leaseId":"lease","ttlMs":value}))
                .is_err()
        );
    }
    assert!(
        serde_json::from_value::<LeaseAcquireParams>(json!({"kind":"ordinary","ttlMs":"1"}))
            .is_err()
    );
    roundtrip::<TakeoverParams>(json!({"actorId":"actor","reason":"user"}));
    for value in [
        json!({"reason":"user"}),
        json!({"actorId":"actor"}),
        json!({"actorId":"actor","reason":"takeover"}),
        json!({"actorId":null,"reason":"user"}),
    ] {
        assert!(serde_json::from_value::<TakeoverParams>(value).is_err());
    }
}

#[test]
fn control_optional_actual_omits_none_and_rejects_null() {
    let unknown: ControlReceipt =
        serde_json::from_value(json!({"line":"rts","requested":true,"status":"unknown"})).unwrap();
    assert!(unknown.actual.is_none());
    assert_eq!(
        serde_json::to_value(unknown).unwrap(),
        json!({"line":"rts","requested":true,"status":"unknown"})
    );
    roundtrip::<ControlReceipt>(
        json!({"line":"dtr","requested":false,"status":"confirmed","actual":false}),
    );
    assert!(
        serde_json::from_value::<ControlReceipt>(
            json!({"line":"rts","requested":true,"status":"unknown","actual":null})
        )
        .is_err()
    );
}

#[test]
fn stream_wire_distinguishes_intent_from_final_receipt() {
    let envelope = json!({"hostId":"host","instanceEpoch":"7","sessionId":"session","sessionEpoch":"2","eventSeq":"1","configurationRevision":"1","time":{"clockId":"clock","sourceMonoNs":"1","receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}}});
    let mut intent = envelope.clone();
    intent["kind"] = json!("tx_intent");
    intent["payload"] =
        json!({"operationId":"op","bytesBase64":"DQo=","byteStart":"0","byteEnd":"2"});
    roundtrip::<RawEvent>(intent.clone());
    let mut receipt = envelope;
    receipt["eventSeq"] = json!("2");
    receipt["kind"] = json!("tx");
    receipt["payload"] = json!({"operationId":"op","sessionId":"session","sessionEpoch":"2","outcome":"partial","bytesBase64":"DQo=","byteStart":"0","byteEnd":"2","acceptedRanges":[{"start":"0","end":"1"}],"unknownRanges":[],"peerAcknowledged":false});
    roundtrip::<RawEvent>(receipt);
    intent["payload"]
        .as_object_mut()
        .unwrap()
        .remove("operationId");
    assert!(serde_json::from_value::<RawEvent>(intent).is_err());
}

#[test]
fn configuration_field_unknown_omits_actual_and_rejects_explicit_null() {
    roundtrip::<ConfigField>(json!({"field":"parity","status":"unknown"}));
    roundtrip::<ConfigField>(json!({"field":"parity","status":"applied","actual":"even"}));
    assert!(
        serde_json::from_value::<ConfigField>(
            json!({"field":"parity","status":"unknown","actual":null})
        )
        .is_err()
    );
    // 业务 JSON 仍保留显式可空的值类型。
    roundtrip::<JsonValue>(Value::Null);
}
