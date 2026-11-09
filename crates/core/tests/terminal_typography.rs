use serde_json::{Value, json};
use serial_workbench_core::{
    JsonObject, SchemaDialect, SettingsSaveParams, SharedSettings, TerminalSettings,
    TerminalTypography, schema_for,
};

fn typography() -> Value {
    json!({"fontFamily":"ui-monospace","fontSize":14,"lineHeightPercent":150,"ligatures":false})
}

#[test]
fn defaults_are_complete_and_shared_by_terminal_settings() {
    let expected = typography();
    assert_eq!(
        serde_json::to_value(TerminalTypography::default()).unwrap(),
        expected
    );
    assert_eq!(
        serde_json::to_value(TerminalSettings::default()).unwrap()["typography"],
        expected
    );
    assert_eq!(
        serde_json::to_value(SharedSettings::default()).unwrap()["terminal"]["typography"],
        expected
    );
}

#[test]
fn typography_roundtrips_legal_boundaries_and_unicode_scalar_font_names() {
    for (family, size, height, ligatures) in [
        ("a".to_owned(), 8, 100, false),
        ("🦀".repeat(128), 48, 300, true),
        ("JetBrains Mono, monospace".to_owned(), 14, 150, true),
    ] {
        let value = json!({"fontFamily":family,"fontSize":size,"lineHeightPercent":height,"ligatures":ligatures});
        let decoded: TerminalTypography = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
        let mut settings = serde_json::to_value(SharedSettings::default()).unwrap();
        settings["terminal"]["typography"] = value;
        let decoded: SharedSettings = serde_json::from_value(settings.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), settings);
    }
}

#[test]
fn typography_rejects_invalid_font_names_and_numeric_ranges() {
    for invalid in [r#""\uD800""#, r#""\uDC00""#] {
        let value = format!(
            r#"{{"fontFamily":{invalid},"fontSize":14,"lineHeightPercent":150,"ligatures":false}}"#
        );
        assert!(serde_json::from_str::<TerminalTypography>(&value).is_err());
    }
    for (field, invalid) in [
        ("fontFamily", json!("")),
        ("fontFamily", json!("mono\nspace")),
        ("fontFamily", json!("mono\u{7f}")),
        ("fontFamily", json!("mono\u{85}")),
        ("fontFamily", json!("🦀".repeat(129))),
        ("fontSize", json!(7)),
        ("fontSize", json!(49)),
        ("lineHeightPercent", json!(99)),
        ("lineHeightPercent", json!(301)),
        ("lineHeightPercent", json!(150.5)),
        ("lineHeightPercent", json!("150")),
        ("lineHeightPercent", Value::Null),
    ] {
        let mut value = typography();
        value[field] = invalid;
        assert!(
            serde_json::from_value::<TerminalTypography>(value.clone()).is_err(),
            "{value}"
        );
        let mut settings = serde_json::to_value(SharedSettings::default()).unwrap();
        settings["terminal"]["typography"] = value.clone();
        assert!(
            serde_json::from_value::<SharedSettings>(settings).is_err(),
            "{value}"
        );
    }
}

#[test]
fn only_the_new_typography_field_can_be_omitted() {
    let value = json!({"receiveMode":"text","sendMode":"hex","lineEnding":{"kind":"crlf"}});
    let decoded: TerminalSettings = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(decoded).unwrap()["typography"],
        typography()
    );
    for field in ["receiveMode", "sendMode", "lineEnding"] {
        let mut invalid = value.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<TerminalSettings>(invalid).is_err(),
            "{field}"
        );
    }
    for field in ["fontFamily", "fontSize", "lineHeightPercent", "ligatures"] {
        let mut invalid = typography();
        invalid.as_object_mut().unwrap().remove(field);
        assert!(
            serde_json::from_value::<TerminalTypography>(invalid).is_err(),
            "{field}"
        );
    }
    for invalid in [Value::Null, json!({}), json!({"legacyFont":"mono"})] {
        let mut terminal = value.clone();
        terminal["typography"] = invalid;
        assert!(serde_json::from_value::<TerminalSettings>(terminal).is_err());
    }
    let mut invalid = typography();
    invalid["legacyFont"] = json!("mono");
    assert!(serde_json::from_value::<TerminalTypography>(invalid).is_err());
    let mut invalid = typography();
    invalid.as_object_mut().unwrap().remove("lineHeightPercent");
    invalid["lineHeight"] = json!(1.5);
    assert!(serde_json::from_value::<TerminalTypography>(invalid).is_err());
}

#[test]
fn schemas_match_runtime_ranges_and_optional_input() {
    for dialect in [SchemaDialect::Draft07, SchemaDialect::Draft202012] {
        let schema = schema_for::<TerminalTypography>(dialect);
        assert_eq!(schema["properties"]["fontFamily"]["minLength"], 1);
        assert_eq!(schema["properties"]["fontFamily"]["maxLength"], 128);
        assert!(schema["properties"]["fontFamily"]["pattern"].is_string());
        assert_eq!(schema["properties"]["fontSize"]["minimum"], 8);
        assert_eq!(schema["properties"]["fontSize"]["maximum"], 48);
        assert_eq!(schema["properties"]["lineHeightPercent"]["minimum"], 100);
        assert_eq!(schema["properties"]["lineHeightPercent"]["maximum"], 300);
        assert_eq!(schema["properties"]["lineHeightPercent"]["type"], "integer");
        assert_eq!(
            schema["required"],
            json!(["fontFamily", "fontSize", "lineHeightPercent", "ligatures"])
        );
        assert_eq!(schema["additionalProperties"], false);
        let terminal = schema_for::<TerminalSettings>(dialect);
        assert_eq!(
            terminal["required"],
            json!(["receiveMode", "sendMode", "lineEnding"])
        );
    }
}

#[test]
fn default_settings_roundtrip_business_params_and_document_json() {
    let expected = serde_json::to_value(SharedSettings::default()).unwrap();
    let params: JsonObject = serde_json::from_value(json!({"value": expected})).unwrap();
    let decoded: SettingsSaveParams =
        serde_json::from_value(serde_json::to_value(params).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(decoded.value).unwrap(), expected);

    let document: JsonObject =
        serde_json::from_value(json!({"formatVersion":"0.1","value":expected})).unwrap();
    let document = serde_json::to_value(document).unwrap();
    let decoded: SharedSettings = serde_json::from_value(document["value"].clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
    assert_eq!(document["value"]["terminal"]["typography"], typography());
}
