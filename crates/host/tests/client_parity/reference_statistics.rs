//! 在真实 Host 上安装按发布清单签名的窗口统计扩展。
use super::*;
use support::node_package::{archive, with_metadata};

const ACTION: &str = "swb.reference.statistics.windows";

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_statistics_reads_windows_from_signed_package() {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.cache/plugin-sdk/examples/reference-statistics/main.js");
    let source = std::fs::read(compiled).expect("Bundle the statistics worker");
    let files = std::collections::BTreeMap::from([
        (
            "LICENSE".into(),
            include_bytes!("../../../../LICENSE").to_vec(),
        ),
        (
            "NOTICE".into(),
            include_bytes!("../../../../NOTICE").to_vec(),
        ),
        ("dist/main.mjs".into(), source),
        (
            "manifest.json".into(),
            include_bytes!(
                "../../../../packages/plugin-sdk/examples/reference-statistics/manifest.json"
            )
            .to_vec(),
        ),
    ]);
    let fixture = Fixture::connected(
        vec![
            "plugins.manage".into(),
            "metadata.read".into(),
            "content.read".into(),
        ],
        serial_workbench_host::device::DeviceService::virtual_opener(),
    )
    .await;
    fixture.approve_test_source().await;
    let path = fixture.dir.path().join("signed-statistics.zip");
    std::fs::write(&path, archive(&with_metadata(files, true))).unwrap();
    let installed = fixture
        .install_archive(
            &path,
            json!({"kind":"trusted","source":"test-source","keyId":"test-key"}),
        )
        .await;
    assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
    let Some(ActionResult::NodePackageInstalled(installation)) = installed.result else {
        panic!("Expected the package installation receipt");
    };
    let package = installation.package;
    assert_eq!(package.id.as_str(), "swb.reference.statistics");
    assert!(package.source_verified && !package.enabled && !package.execution_approved);
    let identity = json!({"id":package.id,"archiveSha256":&package.archive_sha256});
    let trusted = fixture
        .mutate(
            &fixture.user,
            "node.packages.confirmExecutionTrust",
            identity.clone(),
            installation.revision.get(),
        )
        .await;
    let Some(ActionResult::NodePackageChanged(trusted)) = trusted.result else {
        panic!("Expected the execution trust receipt");
    };
    let mut activation = identity;
    activation["enabled"] = json!(true);
    let enabled = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            activation,
            trusted.revision.get(),
        )
        .await;
    assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");

    let params = json!({
        "firstPosition":"9007199254740993",
        "expectedSlots":3,
        "unit":"V",
        "samples":[
            {"position":"9007199254740993","value":4},
            {"position":"9007199254740995","value":8}
        ],
        "window":{
            "kind":"time",
            "clockId":"capture-source",
            "originMonoNs":"18000000000000000000",
            "periodNs":"4",
            "length":"3",
            "step":"3"
        }
    });
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(&fixture.client, &fixture.target, ACTION, params),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let report = fixture.result(&fixture.client, &settled).await;
    assert_eq!(report["clockId"], "capture-source");
    assert_eq!(report["unit"], "V");
    let rows = report["windows"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0]["fromPosition"], "9007199254740993");
    assert_eq!(rows[0]["metrics"]["average"].as_f64(), Some(4.0));
    assert_eq!(rows[1]["expectedCount"], 1);
    assert_eq!(rows[1]["missingCount"], 1);
    assert_eq!(rows[1]["missingRate"].as_f64(), Some(1.0));
    assert!(rows[1]["metrics"].is_null());
    assert_eq!(rows[3]["fromMonoNs"], "18000000000000000009");
    assert_eq!(rows[3]["toMonoNs"], "18000000000000000012");
    assert_eq!(rows[3]["expectedCount"], 0);
    assert!(rows[3]["missingRate"].is_null());
    let xy = json!({
        "x": {
            "sourceId": "x-channel",
            "clockId": "x-clock",
            "samples": [
                {"monoNs":"18000000000000000000","value":"1.5"},
                {"monoNs":"18000000000000000001","value":"2.5"}
            ]
        },
        "y": {
            "sourceId": "y-channel",
            "clockId": "y-clock",
            "samples": [
                {"monoNs":"100","value":"0"},
                {"monoNs":"101","value":"6"}
            ]
        },
        "method": "linear",
        "maxGapNs": "2",
        "anchors": [
            {"xMonoNs":"18000000000000000000","yMonoNs":"100"},
            {"xMonoNs":"18000000000000000003","yMonoNs":"102"}
        ]
    });
    let alignment = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "swb.reference.statistics.alignXY",
                xy,
            ),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &alignment.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let aligned = fixture.result(&fixture.client, &settled).await;
    assert_eq!(aligned["x"]["clockId"], "x-clock");
    assert_eq!(aligned["y"]["sourceId"], "y-channel");
    assert_eq!(
        aligned["clockRate"],
        json!({"numerator":"3","denominator":"2"})
    );
    assert_eq!(aligned["pairs"][0]["y"]["status"], "exact");
    let interpolated = &aligned["pairs"][1];
    assert_eq!(interpolated["x"]["monoNs"], "18000000000000000001");
    assert_eq!(interpolated["breakBefore"], false);
    assert_eq!(
        interpolated["y"],
        json!({
            "status":"interpolated",
            "before":{"index":0,"monoNs":"100","value":"0"},
            "after":{"index":1,"monoNs":"101","value":"6"},
            "value":"4",
            "fraction":{"numerator":"2","denominator":"3"}
        })
    );

    let _ = fixture.finish().await;
    eprintln!(
        "statistics_xy_signed archive={} operation={} pairs=2 interpolation=2/3",
        package.archive_sha256, alignment.operation_id
    );
    eprintln!(
        "statistics_signed archive={} operation={} windows=4 verified_loss=1 empty_rate=null clean_shutdown=true",
        package.archive_sha256, accepted.operation_id
    );
}
