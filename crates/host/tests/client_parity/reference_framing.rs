//! 用签名随包清单和真实 Host 验证帧与原始字节范围。
use super::*;
use serial_workbench_host::device::DeviceService;
use std::collections::BTreeMap;
use support::{
    node_host_actions::Fixture,
    node_package::{archive, with_metadata},
};

const PACKAGE: &str = "swb.reference.framing";
const SCAN: &str = "swb.reference.framing.scan";
const MANIFEST: &[u8] =
    include_bytes!("../../../../packages/plugin-sdk/examples/reference-framing/manifest.json");
const WIRE: &[u8] = &[
    0xa5, 0x5a, 250, 0xa5, 0x5a, 2, 0x10, 0xef, 0x0d, 0xa5, 0x5a, 1, 0x44, 0x0d,
];

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_reference_framing_reads_real_session_and_preserves_ranges() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let backend = std::fs::read(root.join(".cache/plugin-sdk/examples/reference-framing/main.js"))
        .expect("Compile the public SDK framing plugin");
    let fixture = Arc::new(
        Fixture::connected(
            vec!["plugins.manage".into(), "content.read".into()],
            DeviceService::virtual_opener(),
        )
        .await,
    );
    let checked_fixture = fixture.clone();
    let checked = tokio::spawn(async move { check_scan(&checked_fixture, backend).await });
    let outcome = checked.await;
    let fixture =
        Arc::try_unwrap(fixture).unwrap_or_else(|_| panic!("Framing test retained its Host"));
    fixture.finish().await;
    outcome.expect("Framing test on the real Host");
}

async fn check_scan(fixture: &Fixture, backend: Vec<u8>) {
    fixture.approve_test_source().await;
    let files = BTreeMap::from([
        (
            "LICENSE".to_string(),
            include_bytes!("../../../../LICENSE").to_vec(),
        ),
        (
            "NOTICE".into(),
            include_bytes!("../../../../NOTICE").to_vec(),
        ),
        ("manifest.json".into(), MANIFEST.to_vec()),
        ("dist/main.mjs".into(), backend),
    ]);
    let path = fixture.dir.path().join("reference-framing.zip");
    std::fs::write(&path, archive(&with_metadata(files, true))).unwrap();
    let installed = fixture
        .install_archive(
            &path,
            json!({"kind":"trusted","source":"test-source","keyId":"test-key"}),
        )
        .await;
    assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
    let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
        panic!("Expected a signed package receipt");
    };
    assert_eq!(installed.package.id.as_str(), PACKAGE);
    let digest = installed.package.archive_sha256;
    let trusted = fixture
        .mutate(
            &fixture.user,
            "node.packages.confirmExecutionTrust",
            json!({"id":PACKAGE,"archiveSha256":digest}),
            1,
        )
        .await;
    assert_eq!(trusted.state, OperationState::Succeeded, "{trusted:?}");
    let enabled = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":PACKAGE,"archiveSha256":digest,"enabled":true}),
            2,
        )
        .await;
    assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");

    let device = Target {
        kind: ResourceKind::try_from("device").unwrap(),
        id: id("virtual:echo"),
        ..fixture.target.clone()
    };
    grant(fixture, &device, &["device.modify"]).await;
    let opened = settle(
        fixture,
        &fixture.client,
        &device,
        "device.open",
        json!({"configuration":SerialConfiguration::default()}),
    )
    .await;
    let Some(ActionResult::Opened(open)) = opened.result else {
        panic!("Expected virtual device open receipt: {opened:?}");
    };
    let session = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: open.session_id.clone(),
        session_id: Some(open.session_id.clone()),
        session_epoch: Some(open.session_epoch),
        ..fixture.target.clone()
    };
    grant(fixture, &session, &["content.read", "device.modify"]).await;
    for bytes in [&WIRE[..7], &WIRE[7..]] {
        let sent = settle(
            fixture,
            &fixture.client,
            &session,
            "session.tx",
            json!({"bytesBase64":STANDARD.encode(bytes),"writeWaitMs":"1000"}),
        )
        .await;
        assert_eq!(sent.state, OperationState::Succeeded, "{sent:?}");
    }
    let raw = fixture.client.connect_raw().await.unwrap();
    let read = timeout(Duration::from_secs(5), async {
        loop {
            let query = fixture.query_call(
                    &fixture.client,
                    &session,
                    "stream.read",
                    json!({"sessionId":open.session_id,"sessionEpoch":open.session_epoch,
                           "startEventSeq":"1","maxEvents":"100","maxBytes":"4096"}),
                );
            let RpcResult::Query(QueryResult::StreamRead(read)) =
                success(raw.request(RpcRequest::Query(query)).await.unwrap())
            else {
                panic!("Expected the actual Raw stream");
            };
            if read.events.iter().any(|event| {
                matches!(&event.payload, RawPayload::Rx(rx) if rx.byte_end.get() >= WIRE.len() as u64)
            }) {
                break read;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Virtual Echo should expose all sent bytes");

    let scan = settle(
        fixture,
        &fixture.client,
        &session,
        SCAN,
        json!({"startEventSeq":"1","endEventSeq":read.next_event_seq,
               "headerBase64":"pVo=","footerBase64":"DQ==","maxFrameLength":32,
               "lengthField":{"offset":2,"width":1,"byteOrder":"be","adjustment":4}}),
    )
    .await;
    assert_eq!(scan.state, OperationState::Succeeded, "{scan:?}");
    let result = fixture.result_on_raw(&fixture.client, &raw, &scan).await;
    assert_eq!(result["incompleteBytes"], 3);
    let frames = result["frames"].as_array().unwrap();
    assert_eq!(frames.len(), 2);
    let event_at = |byte| {
        read.events
            .iter()
            .find(|event| {
                matches!(&event.payload, RawPayload::Rx(rx) if rx.byte_start.get() <= byte && byte < rx.byte_end.get())
            })
            .unwrap()
            .event_seq
            .get()
    };
    for (frame, (start, end, encoded)) in
        frames.iter().zip([(3, 9, "pVoCEO8N"), (9, 14, "pVoBRA0=")])
    {
        assert_eq!(
            *frame,
            json!({
                "bytesBase64":encoded,
                "source":{"hostId":session.host_id,"sessionId":open.session_id,
                          "sessionEpoch":open.session_epoch,"direction":"rx",
                          "eventStart":event_at(start).to_string(),
                          "eventEnd":(event_at(end - 1) + 1).to_string(),
                          "byteStart":start.to_string(),"byteEnd":end.to_string()}
            })
        );
    }
    eprintln!(
        "reference_framing signed_archive={digest} operation={} frames=2 raw_bytes={} incomplete_bytes=3",
        scan.operation_id,
        WIRE.len()
    );
}

async fn grant(fixture: &Fixture, target: &Target, permissions: &[&str]) {
    let result = settle(
        fixture,
        &fixture.user,
        &fixture.target,
        "auth.authorize",
        json!({"clientId":fixture.client.attachment().client_id,"permissions":permissions,"targets":[target]}),
    )
    .await;
    assert_eq!(result.state, OperationState::Succeeded, "{result:?}");
}

async fn settle(
    fixture: &Fixture,
    client: &HostClient,
    target: &Target,
    action: &str,
    params: Value,
) -> Operation {
    let accepted = fixture
        .invoke(client, fixture.call(client, target, action, params))
        .await;
    fixture.wait(client, &accepted.operation_id).await
}
