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
        ["catalog.json", "fixtures.json", "schemas.json", "types.ts"]
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
}
