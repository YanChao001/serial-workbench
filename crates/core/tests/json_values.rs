use serde_json::json;
use serial_workbench_core::{JsonObject, JsonValue, SchemaObject, SchemaValue};

#[test]
fn nested_json_keeps_scalar_types_and_canonical_safe_integers() {
    let source =
        r#"{"payload":[null,false,true,"false",0,-1,1.0,1e3,{"中文":"值","empty":[],"map":{}}]}"#;
    let expected =
        json!({"payload":[null,false,true,"false",0,-1,1,1000,{"中文":"值","empty":[],"map":{}}]});
    let from_text: JsonObject = serde_json::from_str(source).unwrap();
    let from_value: JsonObject =
        serde_json::from_value(serde_json::from_str::<serde_json::Value>(source).unwrap()).unwrap();
    assert_eq!(from_text, from_value);
    assert_eq!(serde_json::to_value(from_text).unwrap(), expected);
}

#[test]
fn business_json_rejects_fractional_and_unsafe_numbers_at_nested_positions() {
    for number in [
        "0.1",
        "-0.5",
        "9007199254740992",
        "-9007199254740992",
        "9223372036854775807",
        "18446744073709551615",
        "1e40",
    ] {
        let source = format!(r#"{{"payload":{{"nested":[{number}]}}}}"#);
        assert!(
            serde_json::from_str::<JsonValue>(&source).is_err(),
            "accepted {number}"
        );
        let value = serde_json::from_str::<serde_json::Value>(&source).unwrap();
        assert!(
            serde_json::from_value::<JsonValue>(value).is_err(),
            "accepted Value {number}"
        );
        assert!(
            serde_json::from_str::<SchemaValue>(&source).is_ok(),
            "schema rejected {number}"
        );
    }
    for number in ["9007199254740991", "-9007199254740991", "-0.0"] {
        assert!(serde_json::from_str::<JsonValue>(number).is_ok());
    }
}

#[test]
fn schema_json_preserves_decimal_constraints_and_large_unsigned_metadata() {
    let expected = json!({"properties":{"level":{"minimum":-0.25,"maximum":1.5,"multipleOf":0.1,"examples":[18446744073709551615u64]}}});
    let from_value: SchemaObject = serde_json::from_value(expected.clone()).unwrap();
    let from_text: SchemaObject =
        serde_json::from_slice(&serde_json::to_vec(&expected).unwrap()).unwrap();
    assert_eq!(from_value, from_text);
    assert_eq!(serde_json::to_value(from_text).unwrap(), expected);
}

#[test]
fn nested_json_and_duplicate_keys_follow_the_existing_object_semantics() {
    let mut value = json!({"$ref":"#/definitions/Name", "null":null,"false":false});
    for _ in 0..24 {
        value = json!({"child":[value]});
    }
    let decoded: JsonValue = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
    let duplicates: JsonObject = serde_json::from_str(r#"{"key":1,"key":2}"#).unwrap();
    assert_eq!(serde_json::to_value(duplicates).unwrap(), json!({"key":2}));
}
