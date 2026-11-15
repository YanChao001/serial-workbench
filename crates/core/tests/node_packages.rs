use serde_json::{Value, json};
use serial_workbench_core::{
    ActionKind, NodePackageVersion, builtin_catalog, parse_node_integrity, parse_node_manifest,
    parse_node_registration, parse_node_signature, validate_node_package_metadata,
};

fn manifest() -> Value {
    json!({
        "schemaVersion": "0.1",
        "id": "example.terminal",
        "version": "1.2.3-beta.1+build.7",
        "displayName": "串口终端",
        "description": "离线终端参考包",
        "license": "MIT",
        "notices": ["许可证/LICENSE.txt"],
        "hostProtocolVersion": "0.1",
        "runtimeRef": "node-26.13.0",
        "main": "dist/main.mjs",
        "webUi": { "entry": "界面/index.html" },
        "dependencies": [],
        "platformResources": [],
        "activation": ["startup"],
        "permissions": {
            "hostApi": [],
            "executionPurposes": ["终端后台处理"],
            "externalTools": []
        },
        "contributes": {
            "actions": [], "queries": [], "transports": [], "parsers": [],
            "views": [], "themes": [], "configuration": []
        },
        "dataSchemaVersion": "1"
    })
}

#[test]
fn formal_manifest_roundtrips_unicode_paths_and_independent_versions() {
    let value = manifest();
    let parsed = parse_node_manifest(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(parsed.id.as_str(), "example.terminal");
    assert_eq!(parsed.version.as_str(), "1.2.3-beta.1+build.7");
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
}

#[test]
fn metadata_rejects_unknown_fields_and_duplicate_keys_before_they_are_lost() {
    let mut value = manifest();
    value["scripts"] = json!({ "postinstall": "must never execute" });
    assert!(parse_node_manifest(&serde_json::to_vec(&value).unwrap()).is_err());
    let mut value = manifest();
    value["permissions"]["grantAll"] = json!(true);
    assert!(parse_node_manifest(&serde_json::to_vec(&value).unwrap()).is_err());

    let raw = serde_json::to_string(&manifest()).unwrap();
    for (from, to) in [
        (
            "\"schemaVersion\":\"0.1\"",
            "\"schemaVersion\":\"0.1\",\"schemaVersion\":\"0.1\"",
        ),
        ("\"hostApi\":[]", "\"hostApi\":[],\"hostApi\":[]"),
    ] {
        assert!(raw.contains(from));
        assert!(parse_node_manifest(raw.replacen(from, to, 1).as_bytes()).is_err());
    }
}

#[test]
fn manifest_paths_reject_absolute_parent_and_ambiguous_components() {
    for path in [
        "../escape.mjs",
        "/absolute.mjs",
        "C:/outside.mjs",
        "x\\main.mjs",
        "dist/../main.mjs",
        "./main.mjs",
        "dist//main.mjs",
        "dist/.",
        "dist/\0main.mjs",
    ] {
        let mut value = manifest();
        value["main"] = json!(path);
        assert!(
            parse_node_manifest(&serde_json::to_vec(&value).unwrap()).is_err(),
            "accepted {path:?}"
        );
    }
}

fn contributed_manifest() -> Value {
    let mut value = manifest();
    let mut action = builtin_catalog()[0].clone();
    action.action_id = "example.terminal.open".try_into().unwrap();
    action.kind = ActionKind::Action;
    action.input_schema = Default::default();
    action.output_schema = Default::default();
    action.state_scopes = vec!["session".into()];
    value["contributes"]["actions"] = json!([action]);
    value["contributes"]["views"] = json!([{
        "id": "example.terminal.view",
        "actionId": "example.terminal.open",
        "stateScopes": ["session"]
    }]);
    value["activation"] = json!(["example.terminal.view"]);
    value
}

#[test]
fn semantic_validation_rejects_unbound_or_conflicting_contributions() {
    assert!(parse_node_manifest(&serde_json::to_vec(&contributed_manifest()).unwrap()).is_ok());
    let mut cases = Vec::new();

    let mut value = contributed_manifest();
    let duplicate = value["contributes"]["actions"][0].clone();
    value["contributes"]["actions"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    cases.push(("duplicate contribution", value));

    let mut value = contributed_manifest();
    value["activation"] = json!(["example.terminal.missing"]);
    cases.push(("unknown activation", value));

    let mut value = contributed_manifest();
    value["contributes"]["views"][0]["actionId"] = json!("example.terminal.absent");
    cases.push(("missing view action", value));

    let mut value = contributed_manifest();
    value["contributes"]["views"][0]["stateScopes"] = json!(["settings"]);
    cases.push(("view scope expansion", value));

    let mut value = contributed_manifest();
    value["contributes"]["queries"] = value["contributes"]["actions"].clone();
    value["contributes"]["actions"] = json!([]);
    cases.push(("wrong catalog kind", value));

    let mut value = contributed_manifest();
    value["platformResources"] = json!([{
        "id": "example.terminal.addon",
        "target": "x86_64-pc-windows-msvc",
        "path": "native/addon.node",
        "kind": "nativeAddon",
        "version": "1"
    }]);
    cases.push(("unlocked addon runtime", value));

    let mut value = contributed_manifest();
    value["permissions"]["externalTools"] = json!(["example.terminal.tool"]);
    cases.push(("undeclared tool", value));

    let mut value = contributed_manifest();
    value["contributes"]["actions"][0]["actionId"] = json!("session.tx");
    cases.push(("foreign contribution namespace", value));

    let mut value = contributed_manifest();
    value.as_object_mut().unwrap().remove("webUi");
    cases.push(("view without UI resources", value));

    for (name, value) in cases {
        assert!(
            parse_node_manifest(&serde_json::to_vec(&value).unwrap()).is_err(),
            "accepted {name}"
        );
    }
}

#[test]
fn package_upgrade_uses_semver_precedence_not_text_or_build_metadata_order() {
    let version = |value: &str| NodePackageVersion::try_from(value).unwrap();
    assert!(version("1.10.0").is_upgrade_from(&version("1.9.9")));
    assert!(version("1.0.0").is_upgrade_from(&version("1.0.0-beta.9")));
    assert!(!version("1.0.0+build.9").is_upgrade_from(&version("1.0.0+build.1")));
    assert!(!version("1.0.0").is_upgrade_from(&version("1.0.0")));
    for value in ["1", "1.2", "01.2.3", "v1.2.3", "1.0.0-alpha.01", "latest"] {
        assert!(
            NodePackageVersion::try_from(value).is_err(),
            "accepted {value}"
        );
    }
}

fn integrity() -> Value {
    let files = [
        "dist/main.mjs",
        "manifest.json",
        "界面/index.html",
        "许可证/LICENSE.txt",
    ]
    .map(|path| json!({ "path": path, "size": "1", "sha256": "0".repeat(64) }));
    json!({
        "schemaVersion": "0.1", "id": "example.terminal", "version": "1.2.3-beta.1+build.7",
        "source": "local", "keyId": "local-unverified", "files": files
    })
}

#[test]
fn integrity_and_manifest_bind_identity_and_every_referenced_payload() {
    let parsed_manifest = parse_node_manifest(&serde_json::to_vec(&manifest()).unwrap()).unwrap();
    let parsed_integrity =
        parse_node_integrity(&serde_json::to_vec(&integrity()).unwrap()).unwrap();
    validate_node_package_metadata(&parsed_manifest, &parsed_integrity).unwrap();

    let mut value = integrity();
    value["files"].as_array_mut().unwrap().remove(0);
    let missing = parse_node_integrity(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(validate_node_package_metadata(&parsed_manifest, &missing).is_err());
    let mut value = integrity();
    value["id"] = json!("other.package");
    let other = parse_node_integrity(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(validate_node_package_metadata(&parsed_manifest, &other).is_err());
}

#[test]
fn integrity_rejects_unsorted_aliases_reserved_entries_and_numeric_sizes() {
    let mut cases = Vec::new();
    let mut value = integrity();
    value["files"].as_array_mut().unwrap().swap(0, 1);
    cases.push(value);
    let mut value = integrity();
    value["files"][0]["size"] = json!(1);
    cases.push(value);
    let mut value = integrity();
    value["files"][0]["path"] = json!("integrity.json");
    cases.push(value);
    let mut value = integrity();
    let mut alias = value["files"][0].clone();
    alias["path"] = json!("DIST/main.mjs");
    value["files"].as_array_mut().unwrap().insert(0, alias);
    cases.push(value);
    for value in cases {
        assert!(parse_node_integrity(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}

#[test]
fn signature_metadata_has_a_fixed_algorithm_and_canonical_64_byte_payload() {
    let value = json!({
        "algorithm": "Ed25519", "keyId": "release-key",
        "signatureBase64": format!("{}==", "A".repeat(86))
    });
    assert!(parse_node_signature(&serde_json::to_vec(&value).unwrap()).is_ok());
    for (key, replacement) in [
        ("algorithm", json!("none")),
        ("signatureBase64", json!(format!("{}B==", "A".repeat(85)))),
        ("signatureBase64", json!("AA==")),
        (
            "publicKey",
            json!("a package cannot establish its own source trust"),
        ),
    ] {
        let mut invalid = value.clone();
        invalid[key] = replacement;
        assert!(parse_node_signature(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
}

#[test]
fn dynamic_registration_selects_declared_contributions_without_replacing_metadata() {
    let parsed =
        parse_node_manifest(&serde_json::to_vec(&contributed_manifest()).unwrap()).unwrap();
    let value = json!({
        "id": "example.terminal", "version": "1.2.3-beta.1+build.7",
        "contributes": {
            "actions": ["example.terminal.open"], "queries": [], "transports": [], "parsers": [],
            "views": ["example.terminal.view"], "themes": [], "configuration": []
        }
    });
    let registration = parse_node_registration(&serde_json::to_vec(&value).unwrap()).unwrap();
    registration.validate_against(&parsed).unwrap();
    for (category, ids) in [
        ("actions", json!(["session.tx"])),
        ("queries", json!(["example.terminal.open"])),
        (
            "actions",
            json!(["example.terminal.open", "example.terminal.open"]),
        ),
    ] {
        let mut invalid = value.clone();
        invalid["contributes"][category] = ids;
        let registration = parse_node_registration(&serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(registration.validate_against(&parsed).is_err());
    }
    let mut replacement = value;
    replacement["contributes"]["actions"] = json!([{
        "actionId": "example.terminal.open", "permissions": []
    }]);
    assert!(parse_node_registration(&serde_json::to_vec(&replacement).unwrap()).is_err());
}
