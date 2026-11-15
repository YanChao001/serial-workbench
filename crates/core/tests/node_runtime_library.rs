use serde_json::{Value, json};
use serial_workbench_core::{
    NodePackageTarget, bundled_node_runtime_library, parse_node_runtime_library,
};

fn library() -> Value {
    serde_json::from_slice(include_bytes!(
        "../../../resources/runtime/libatomic-jammy.json"
    ))
    .unwrap()
}

#[test]
fn private_library_binds_signed_package_source_license_and_soname() {
    let release = parse_node_runtime_library(&serde_json::to_vec(&library()).unwrap()).unwrap();
    assert_eq!(&release, bundled_node_runtime_library());
    assert_eq!(release.target, NodePackageTarget::LinuxX64);
    assert_eq!(release.version, "12.3.0-1ubuntu1~22.04.3");
    assert_eq!(release.library.size.get(), 30960);
    assert_eq!(release.gpl_license.size.get(), 35147);
    assert_eq!(release.artifacts.len(), 5);
    assert_eq!(release.soname_link.target.as_str(), "libatomic.so.1.2.0");
}

#[test]
fn rejects_unrelated_platform_missing_source_and_link_escape() {
    let mut cases = Vec::new();
    let mut v = library();
    v["target"] = json!("x86_64-pc-windows-msvc");
    cases.push(v);
    let mut v = library();
    v["version"] = json!("latest");
    cases.push(v);
    let mut v = library();
    v["upstream"]["baseUrl"] = json!("http://untrusted.example/");
    cases.push(v);
    let mut v = library();
    v["sonameLink"]["target"] = json!("../../outside.so");
    cases.push(v);
    let mut v = library();
    v["library"]["resourcePath"] = json!("lib/other.so");
    cases.push(v);
    let mut v = library();
    v["artifacts"].as_array_mut().unwrap().pop();
    cases.push(v);
    let mut v = library();
    v["artifacts"][0]["version"] = json!("different");
    cases.push(v);
    let mut v = library();
    v["artifacts"][0]["filename"] = v["artifacts"][1]["filename"].clone();
    cases.push(v);
    let mut v = library();
    v["licenseExpression"] = json!("MIT");
    cases.push(v);
    let mut v = library();
    v["library"]["size"] = json!(30960);
    cases.push(v);
    for v in cases {
        assert!(parse_node_runtime_library(&serde_json::to_vec(&v).unwrap()).is_err());
    }
}
