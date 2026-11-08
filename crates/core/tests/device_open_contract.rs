use serial_workbench_core::{OpenParams, OpenResult, SerialConfiguration};

#[test]
fn open_accepts_explicit_workspace_binding_reference() {
    let value = serde_json::json!({"configuration": SerialConfiguration::default(), "binding": {"workspaceId":"bench", "bindingId":"probe"}});
    let result = serde_json::from_value::<OpenParams>(value.clone());
    assert!(
        result.is_ok(),
        "explicit binding reference must be accepted: {result:?}"
    );
    assert_eq!(serde_json::to_value(result.unwrap()).unwrap(), value);
}
#[test]
fn opened_result_preserves_recent_save_failure_as_diagnostic() {
    let value = serde_json::json!({"sessionId":"session", "sessionEpoch":"1", "revision":"1", "reused":false, "recentError":{"code":"INVALID_DOCUMENT", "message":"Recent connections document is invalid or unsupported", "retryable":false}});
    let result = serde_json::from_value::<OpenResult>(value.clone());
    assert!(
        result.is_ok(),
        "recent failure must retain opened result: {result:?}"
    );
    assert_eq!(serde_json::to_value(result.unwrap()).unwrap(), value);
}

#[test]
fn optional_binding_and_recent_diagnostic_reject_explicit_null_and_extra_fields() {
    let config = serde_json::to_value(SerialConfiguration::default()).unwrap();
    assert!(
        serde_json::from_value::<OpenParams>(
            serde_json::json!({"configuration":config,"binding":null})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<OpenParams>(serde_json::json!({"configuration":config,"binding":{"workspaceId":"bench","bindingId":"probe","systemName":"COM1"}})).is_err());
    assert!(serde_json::from_value::<OpenResult>(serde_json::json!({"sessionId":"s","sessionEpoch":"1","revision":"1","reused":false,"recentError":null})).is_err());
}

#[test]
fn rebind_wire_has_binding_and_opaque_device_ids_only() {
    let value = serde_json::json!({"bindingId":"binding", "deviceId":"opaque-device"});
    let params = serde_json::from_value::<serial_workbench_core::RebindParams>(value.clone());
    assert!(params.is_ok(), "typed rebind parameters: {params:?}");
    assert_eq!(serde_json::to_value(params.unwrap()).unwrap(), value);
}
#[test]
fn favorite_wire_refers_to_existing_workspace_binding_ids() {
    let value = serde_json::json!({"bindingIds":["one","two"]});
    let params =
        serde_json::from_value::<serial_workbench_core::FavoritesSaveParams>(value.clone());
    assert!(params.is_ok(), "typed favorite parameters: {params:?}");
    assert_eq!(serde_json::to_value(params.unwrap()).unwrap(), value);
}
