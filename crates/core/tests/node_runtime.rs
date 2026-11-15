use serde_json::{Value, json};
use serial_workbench_core::{
    NodePackageTarget, NodeRuntimeSelfTest, bundled_node_runtime_release,
    parse_node_runtime_release,
};

fn release() -> Value {
    serde_json::from_slice(include_bytes!(
        "../../../resources/runtime/node-release.json"
    ))
    .unwrap()
}

#[test]
fn fixed_release_binds_four_targets_and_independent_runtime_abi() {
    let release = parse_node_runtime_release(&serde_json::to_vec(&release()).unwrap()).unwrap();
    assert_eq!(release.id.as_str(), "node-26.13.0");
    assert_eq!(release.modules_abi.get(), 147);
    assert_eq!(release.node_api_version.get(), 10);
    assert_eq!(&release, bundled_node_runtime_release());
    assert_eq!(release.targets.len(), 4);
    for target in [
        NodePackageTarget::WindowsX64,
        NodePackageTarget::MacosArm64,
        NodePackageTarget::MacosX64,
        NodePackageTarget::LinuxX64,
    ] {
        let spec = release.for_target(target).unwrap();
        assert!(
            spec.executable
                .resource_path
                .as_str()
                .starts_with("runtime/node/26.13.0/")
        );
        assert!(spec.license.size.get() > 100_000);
    }
}

#[test]
fn rejects_runtime_substitution_floating_sources_and_inconsistent_targets() {
    let mut cases = Vec::new();
    let mut value = release();
    value["systemNode"] = json!(true);
    cases.push(value);
    let mut value = release();
    value["id"] = json!("node-latest");
    cases.push(value);
    let mut value = release();
    value["targets"][0]["archive"]["url"] = json!("https://example.com/node.zip");
    cases.push(value);
    let mut value = release();
    value["targets"][0]["executable"]["resourcePath"] = json!("bin/node.exe");
    cases.push(value);
    let mut value = release();
    value["targets"][0]["arch"] = json!("arm64");
    cases.push(value);
    let mut value = release();
    value["targets"][3]["requiredPrivateLibraries"] = json!([]);
    cases.push(value);
    let mut value = release();
    value["upstream"]["keyringCommit"] = json!("main");
    cases.push(value);
    let mut value = release();
    value["modulesAbi"] = json!(147);
    cases.push(value);
    let mut value = release();
    value["nodeApiVersion"] = json!("0");
    cases.push(value);
    let mut value = release();
    value["targets"].as_array_mut().unwrap().remove(0);
    cases.push(value);
    let mut value = release();
    value["targets"][0] = value["targets"][1].clone();
    cases.push(value);
    for value in cases {
        assert!(parse_node_runtime_release(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}

#[test]
fn rejects_duplicate_runtime_source_keys_before_deserialization() {
    let raw = serde_json::to_string(&release()).unwrap();
    let from = "\"schemaVersion\":\"0.1\"";
    assert!(raw.contains(from));
    assert!(
        parse_node_runtime_release(
            raw.replacen(
                from,
                "\"schemaVersion\":\"0.1\",\"schemaVersion\":\"0.1\"",
                1
            )
            .as_bytes()
        )
        .is_err()
    );
}

#[test]
fn self_test_matches_release_platform_architecture_and_both_abis() {
    let release = bundled_node_runtime_release();
    let target = release.for_target(NodePackageTarget::WindowsX64).unwrap();
    let value = json!({"version":"26.13.0","platform":"win32","arch":"x64","modulesAbi":"147","nodeApiVersion":"10","execPath":"D:/Application/runtime/node.exe"});
    let probe: NodeRuntimeSelfTest = serde_json::from_value(value.clone()).unwrap();
    target.validate_self_test(release, &probe).unwrap();
    for (field, replacement) in [
        ("version", "26.13.1"),
        ("platform", "darwin"),
        ("arch", "arm64"),
        ("modulesAbi", "148"),
        ("nodeApiVersion", "9"),
        ("execPath", ""),
    ] {
        let mut invalid = value.clone();
        invalid[field] = json!(replacement);
        let probe: NodeRuntimeSelfTest = serde_json::from_value(invalid).unwrap();
        assert!(target.validate_self_test(release, &probe).is_err());
    }
}
