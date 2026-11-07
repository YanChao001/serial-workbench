use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use serial_workbench_core::*;

fn bodies() -> Vec<Value> {
    let cursor = json!({"hostId":"host","instanceEpoch":"7","scopeId":"scope","position":"1"});
    vec![
        json!({"type":"clientHello","supportedProtocolVersions":["0.1"],"clientNonce":"nonce"}),
        json!({"type":"hostHello","protocolVersion":"0.1","hostId":"host","instanceEpoch":"9007199254740993","serverNonce":"nonce","proof":"proof"}),
        json!({"type":"authenticate","clientId":"client"}),
        json!({"type":"authenticated","rawAttachToken":"token"}),
        json!({"type":"rawAttach","token":"token"}),
        json!({"type":"rawAttached"}),
        json!({"type":"request","request":{"method":"host.attach","params":{"supportedProtocolVersions":["0.1"],"clientKind":"cli","clientId":"client"}}}),
        json!({"type":"reply","reply":{"ok":true,"result":{"closed":true}}}),
        json!({"type":"error","error":{"code":"NOT_FOUND","message":"Missing","retryable":false}}),
        json!({"type":"rawBatch","batch":{"subscriptionId":"subscription","cursor":cursor,"previousCursor":cursor,"items":[{"kind":"reader_gap","gap":{"hostId":"host","instanceEpoch":"7","sessionId":"session","sessionEpoch":"2","reason":"reader_overflow","missingEventRange":{"start":"1","end":"2"},"missingByteRanges":[]}}]}}),
        json!({"type":"delta","subscriptionId":"subscription","delta":{"cursor":cursor,"previousCursor":cursor,"revision":"1","eventType":"changed","payload":{}}}),
        json!({"type":"subscriptionEnded","subscriptionId":"subscription","error":{"code":"CURSOR_EXPIRED","message":"New snapshot required","retryable":false}}),
    ]
}

fn roundtrip<T: DeserializeOwned + Serialize>(value: Value) {
    let decoded: T = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), value);
}

#[test]
fn catalog_change_notice_is_strict_and_carries_only_visibility_identity() {
    let body = json!({"type":"catalogChanged","catalogVersion":"9007199254740993","visibilityToken":"a".repeat(64)});
    roundtrip::<IpcMessage>(body.clone());
    roundtrip::<WireFrame>(frame(body.clone()));
    for field in ["type", "catalogVersion", "visibilityToken"] {
        let mut missing = body.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<IpcMessage>(missing).is_err());
        let mut null = body.clone();
        null[field] = Value::Null;
        assert!(serde_json::from_value::<IpcMessage>(null).is_err());
    }
    for field in ["actorId", "credential", "permissions", "unknown"] {
        let mut unknown = body.clone();
        unknown[field] = json!("forbidden");
        assert!(serde_json::from_value::<IpcMessage>(unknown).is_err());
    }
    let mut numeric = body.clone();
    numeric["catalogVersion"] = json!(1);
    assert!(serde_json::from_value::<IpcMessage>(numeric).is_err());
    let mut invalid_digest = body;
    invalid_digest["visibilityToken"] = json!("token");
    assert!(serde_json::from_value::<IpcMessage>(invalid_digest).is_err());
}

fn frame(body: Value) -> Value {
    json!({"requestId":"33333333-3333-4333-8333-333333333333","channel":"control","body":body})
}

#[test]
fn all_message_shapes_and_channels_roundtrip() {
    for body in bodies() {
        roundtrip::<IpcMessage>(body.clone());
        for channel in ["control", "raw", "state"] {
            let mut value = frame(body.clone());
            value["channel"] = json!(channel);
            roundtrip::<WireFrame>(value);
        }
    }
    for body in [
        json!({"type":"clientHello","supportedProtocolVersions":["future","0.1"],"clientNonce":"nonce","expectedHostId":"host"}),
        json!({"type":"authenticate","clientId":"client","credential":"credential"}),
        json!({"type":"authenticated","credential":"credential","rawAttachToken":"token"}),
        json!({"type":"reply","reply":{"ok":false,"error":{"code":"DENIED","message":"Denied","retryable":false}}}),
    ] {
        roundtrip::<IpcMessage>(body);
    }
}

#[test]
fn unknown_fields_are_rejected_in_every_body_including_empty_raw_attached() {
    for mut body in bodies() {
        body["unexpected"] = json!(true);
        assert!(
            serde_json::from_value::<IpcMessage>(body.clone()).is_err(),
            "{body}"
        );
    }
    let mut value = frame(bodies().remove(0));
    value["unexpected"] = json!(true);
    assert!(serde_json::from_value::<WireFrame>(value).is_err());
}

#[test]
fn message_and_envelope_required_fields_are_rejected_when_missing() {
    for body in bodies() {
        for key in body.as_object().unwrap().keys() {
            let mut missing = body.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(
                serde_json::from_value::<IpcMessage>(missing).is_err(),
                "{key}: {body}"
            );
        }
    }
    let value = frame(bodies().remove(0));
    for key in ["requestId", "channel", "body"] {
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<WireFrame>(missing).is_err());
    }
}

#[test]
fn invalid_discriminants_epochs_and_nested_rpc_fields_are_rejected() {
    let mut value = frame(bodies().remove(0));
    value["channel"] = json!("unknown");
    assert!(serde_json::from_value::<WireFrame>(value).is_err());
    assert!(serde_json::from_value::<IpcMessage>(json!({"type":"unknown"})).is_err());
    let mut host = bodies().remove(1);
    host["instanceEpoch"] = json!(7);
    assert!(serde_json::from_value::<IpcMessage>(host).is_err());
    let mut host = bodies().remove(1);
    host["protocolVersion"] = json!("0.2");
    assert!(serde_json::from_value::<IpcMessage>(host).is_err());
    for key in ["actorId", "credential", "unknown"] {
        let mut request = bodies().remove(6);
        request["request"]["params"][key] = json!("forged");
        assert!(serde_json::from_value::<IpcMessage>(request).is_err());
    }
    let mut request = bodies().remove(6);
    request["request"]["actorId"] = json!("forged");
    assert!(serde_json::from_value::<IpcMessage>(request).is_err());
    let mut reply = bodies().remove(7);
    reply["reply"]["result"]["unknown"] = json!(true);
    assert!(serde_json::from_value::<IpcMessage>(reply).is_err());
}

#[test]
fn optional_message_fields_omit_absence_and_reject_explicit_null() {
    for (index, field) in [(0, "expectedHostId"), (2, "credential"), (3, "credential")] {
        let mut body = bodies().remove(index);
        roundtrip::<IpcMessage>(body.clone());
        body[field] = Value::Null;
        assert!(
            serde_json::from_value::<IpcMessage>(body.clone()).is_err(),
            "{body}"
        );
    }
}

#[test]
fn user_control_authentication_requires_its_own_credential() {
    let body = json!({"type":"authenticateUserControl","clientId":"client","credential":"control-capability"});
    roundtrip::<IpcMessage>(body.clone());
    for key in ["clientId", "credential"] {
        let mut missing = body.clone();
        missing.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<IpcMessage>(missing).is_err());
        let mut null = body.clone();
        null[key] = Value::Null;
        assert!(serde_json::from_value::<IpcMessage>(null).is_err());
    }
    let mut unknown = body;
    unknown["clientKind"] = json!("desktop");
    assert!(serde_json::from_value::<IpcMessage>(unknown).is_err());
}

#[test]
fn authorization_dtos_roundtrip_and_reject_unknown_missing_and_null_fields() {
    let authorize = json!({"clientId":"client","permissions":["content.read"],"targets":[{"hostId":"host","kind":"host","id":"host"}]});
    let revoke = json!({"actorId":"actor","permissions":["content.read"],"targets":[{"hostId":"host","kind":"host","id":"host"}]});
    roundtrip::<AuthorizeParams>(authorize.clone());
    roundtrip::<RevokeParams>(revoke.clone());
    let mut expiring = authorize.clone();
    expiring["expiresAt"] = json!("2026-11-07T00:00:00Z");
    roundtrip::<AuthorizeParams>(expiring);
    for key in ["clientId", "permissions", "targets"] {
        let mut value = authorize.clone();
        value.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<AuthorizeParams>(value).is_err());
    }
    for key in ["actorId", "permissions", "targets"] {
        let mut value = revoke.clone();
        value.as_object_mut().unwrap().remove(key);
        assert!(serde_json::from_value::<RevokeParams>(value).is_err());
    }
    let mut null = authorize.clone();
    null["expiresAt"] = Value::Null;
    assert!(serde_json::from_value::<AuthorizeParams>(null).is_err());
    let mut unknown = authorize;
    unknown["clientKind"] = json!("desktop");
    assert!(serde_json::from_value::<AuthorizeParams>(unknown).is_err());
    let mut unknown = revoke;
    unknown["clientId"] = json!("client");
    assert!(serde_json::from_value::<RevokeParams>(unknown).is_err());
}
