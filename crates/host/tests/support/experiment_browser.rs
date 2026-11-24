use super::*;
use serial_workbench_host::workspace::WorkspaceService;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
};

async fn pair(host: &Fixture, assets: &Path) -> BrowserEntry {
    let RpcResult::BrowserAccess(BrowserAccessResult {
        browser_access: BrowserAccessState::Pairing { entry, .. },
    }) = success(
        host.control
            .request(RpcRequest::BrowserAccess(BrowserAccessParams::Pair {
                assets_dir: assets.to_str().unwrap().into(),
                mode: BrowserAccessMode::Operate,
            }))
            .await
            .unwrap(),
    )
    else {
        panic!("Missing experiment pairing");
    };
    host.auth
        .authorize(
            &host.operator,
            AuthorizeParams {
                client_id: entry.client_id.clone(),
                permissions: vec![
                    "metadata.read".into(),
                    "content.read".into(),
                    "workspace.modify".into(),
                ],
                targets: vec![host.host()],
                expires_at: None,
            },
        )
        .unwrap();
    entry
}

#[tokio::test]
#[ignore = "requires built browser assets and headless Chromium"]
async fn paired_browsers_exchange_experiment_between_two_hosts() {
    let output = PathBuf::from(
        std::env::var_os("SWB_TEST_EXPERIMENT_BROWSER_OUTPUT")
            .expect("experiment evidence directory"),
    );
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let assets = repository
        .join("dist-web")
        .canonicalize()
        .expect("build web assets for the experiment acceptance");
    let source = Fixture::with_bundled_packages(true).await;
    let destination = Fixture::new().await;
    assert_ne!(source.host(), destination.host());

    let session = source.open().await;
    let file = source.register("private-recording-directory").await;
    let (owner, live) = source.start(&source.user, &session, &file).await;
    let sent = source
        .action(
            &source.user,
            "session.tx",
            session,
            json!({"bytesBase64":"QUJD","writeWaitMs":"100"}),
        )
        .await;
    assert_eq!(sent.state, OperationState::Succeeded);
    let stop = source
        .action(
            &source.user,
            "capture.stop",
            source.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(stop.state, OperationState::Succeeded, "{:?}", stop.error);
    let captured = source.wait(&owner, false).await;
    assert_eq!(captured.state, OperationState::Succeeded);
    let Some(ActionResult::CaptureStatus(capture)) = captured.result else {
        panic!("Expected a settled capture");
    };
    let written = capture.summary.watermarks.written;
    assert!(written.get() > 0);
    let recording = capture.capture_ref;
    assert!(recording.revision.is_some());
    let verified = source
        .action(
            &source.user,
            "capture.verify",
            source.reference_target(&recording),
            json!({"captureRef":recording}),
        )
        .await;
    assert_eq!(
        verified.state,
        OperationState::Succeeded,
        "{:?}",
        verified.error
    );
    let Some(ActionResult::CaptureVerification(verification)) = verified.result else {
        panic!("Expected a capture verification report");
    };
    assert!(verification.container_complete);

    let configuration = SerialConfiguration {
        baud_rate: U64::from(115_200).try_into().unwrap(),
        ..SerialConfiguration::default()
    };
    let binding_id = id("private-binding");
    let source_workspaces = WorkspaceService::new(source.store.clone(), id("default"));
    let source_before = source_workspaces
        .save(
            0.into(),
            WorkspaceDocument {
                name: "Private source bench".into(),
                bindings: vec![DeviceBinding {
                    binding_id: binding_id.clone(),
                    host_id: source.host().host_id,
                    device_id: id("virtual:echo"),
                    port_name: Some("private-port".into()),
                    fingerprint: DeviceFingerprint {
                        transport: DeviceTransportKind::Virtual,
                        vid: None,
                        pid: None,
                        serial_number: Some("private-serial".into()),
                        topology_path: Some("private-topology".into()),
                        evidence: IdentityEvidence::SerialNumber,
                    },
                    configuration: configuration.clone(),
                    reconnect: ReconnectPolicy {
                        enabled: true,
                        ..ReconnectPolicy::default()
                    },
                }],
                views: vec![WorkspaceView {
                    id: id("private-view"),
                    name: "Private view".into(),
                    color: "#64748b".into(),
                    icon: "terminal".into(),
                    pinned: false,
                    receive_mode: TerminalMode::Text,
                    send_mode: TerminalMode::Text,
                    receive_encoding: None,
                    send_encoding: TextEncoding::Utf8,
                    binding_id,
                }],
                captures: vec![recording.clone()],
                ..WorkspaceDocument::default()
            },
        )
        .unwrap();
    let destination_workspaces = WorkspaceService::new(destination.store.clone(), id("default"));
    let destination_before = destination_workspaces
        .save(
            0.into(),
            WorkspaceDocument {
                name: "Receiving bench".into(),
                ..WorkspaceDocument::default()
            },
        )
        .unwrap();
    let source_entry = pair(&source, &assets).await;
    let destination_entry = pair(&destination, &assets).await;
    let mut browser = tokio::process::Command::new("node")
        .arg(repository.join("e2e/paired-browser-experiment.mjs"))
        .arg(&output)
        .stdin(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let fixture = json!({
        "source": source_entry,
        "destination": destination_entry,
        "recording": recording,
        "destinationName": destination_before.value.name,
    });
    {
        use tokio::io::AsyncWriteExt;
        let mut input = browser.stdin.take().unwrap();
        input
            .write_all(fixture.to_string().as_bytes())
            .await
            .unwrap();
        input.write_all(b"\n").await.unwrap();
    }
    let status = tokio::time::timeout(Duration::from_secs(120), browser.wait())
        .await
        .expect("Chromium experiment timed out")
        .unwrap();
    assert!(status.success(), "Chromium experiment: {status}");

    assert_eq!(source_workspaces.read().unwrap(), source_before);
    let saved = destination_workspaces.read().unwrap();
    assert_eq!(saved.revision.get(), destination_before.revision.get() + 2);
    assert_eq!(saved.value.name, destination_before.value.name);
    assert_eq!(saved.value.views.len(), 1);
    let [imported] = saved.value.bindings.as_slice() else {
        panic!("Expected one imported binding");
    };
    assert_eq!(imported.configuration, configuration);
    assert_ne!(imported.host_id, source.host().host_id);
    assert_eq!(imported.host_id, destination.host().host_id);
    assert_eq!(imported.device_id, id("virtual:echo"));
    assert_eq!(imported.port_name.as_deref(), Some("virtual:echo"));
    assert!(imported.fingerprint.serial_number.is_none());
    assert!(!imported.reconnect.enabled);
    assert!(saved.value.captures.is_empty());
    let receipt = json!({
        "sourceHostId": source.host().host_id,
        "destinationHostId": destination.host().host_id,
        "sourceRevision": source_before.revision,
        "destinationRevisionBefore": destination_before.revision,
        "destinationRevisionAfter": saved.revision,
        "recordingWritten": written,
        "verifiedCaptureContainer": verification.container_complete,
        "persistedDestinationDevice": imported.device_id,
    });
    source.finish().await;
    destination.finish().await;
    let mut encoded = serde_json::to_string_pretty(&receipt).unwrap();
    encoded.push('\n');
    std::fs::write(output.join("host-receipt.json"), encoded).unwrap();
}
