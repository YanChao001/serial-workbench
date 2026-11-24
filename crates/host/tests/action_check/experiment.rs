use super::*;
use serial_workbench_host::{
    files::FileService, node_packages::NodePackageInstaller, workspace::WorkspaceService,
};

async fn experiment_failure(
    client: &HostClient,
    target: &Target,
    action: &str,
    params: Value,
    expected: &str,
) {
    let reply = client
        .request(RpcRequest::Query(query(client, target, action, params)))
        .await
        .unwrap();
    assert!(
        matches!(&reply, RpcReply::Failure { error, .. } if error.code == expected),
        "{action} should return {expected}: {reply:?}"
    );
}

#[tokio::test]
async fn experiment_package_exports_only_portable_data_and_checks_dependencies_without_writes() {
    let f = Fixture::start(0, None, true).await;
    let workspace_target = f.target("workspace", "experiment-test");
    for permission in ["metadata.read", "workspace.modify"] {
        f.grant("document-a", permission, &workspace_target);
    }
    f.grant("document-b", "metadata.read", &workspace_target);
    f.grant("document-a", "metadata.read", &f.host_target());

    let binding = DeviceBinding {
        binding_id: id("binding-secret"),
        host_id: f.host_target().host_id.clone(),
        device_id: id("device-secret"),
        port_name: Some("my-secret-port".into()),
        fingerprint: DeviceFingerprint {
            transport: DeviceTransportKind::Serial,
            vid: Some(0x1234),
            pid: Some(0x5678),
            serial_number: Some("private-serial-number".into()),
            topology_path: Some("private-topology".into()),
            evidence: IdentityEvidence::SerialNumber,
        },
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy {
            enabled: true,
            ..ReconnectPolicy::default()
        },
    };
    let workspace = WorkspaceDocument {
        name: "private-workspace-name".into(),
        views: vec![WorkspaceView {
            id: id("private-view-id"),
            name: "private-view-name".into(),
            color: "private-color".into(),
            icon: "private-icon".into(),
            pinned: true,
            receive_mode: TerminalMode::Hex,
            send_mode: TerminalMode::Hex,
            receive_encoding: None,
            send_encoding: TextEncoding::Utf8,
            binding_id: binding.binding_id.clone(),
        }],
        favorite_binding_ids: vec![binding.binding_id.clone()],
        bindings: vec![binding],
        ..WorkspaceDocument::default()
    };
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &workspace_target,
            "workspace.save",
            Some(0.into()),
            json!({"value": workspace}),
        ),
    )
    .await;
    let saved = settled(&f.first, &f.host_target(), operation).await;
    assert_eq!(saved.state, OperationState::Succeeded);

    let directory = f._dir.path().join("private-recording-location");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("manifest.json"), b"private-recording-body").unwrap();
    let reference = FileService::new(f.store.clone(), f.auth.clone(), f.store.identity().unwrap())
        .register(
            RegisterFileParams {
                path: directory.to_string_lossy().into_owned(),
                purpose: FilePurpose::CaptureSource,
            },
            &f.operator,
        )
        .unwrap();
    let capture_target = f.target(reference.kind.as_str(), reference.id.as_str());
    f.grant("document-a", "metadata.read", &capture_target);
    f.grant("document-a", "content.read", &capture_target);

    let export_action = "workspace.experiment.export";
    let inspect_action = "workspace.experiment.inspect";
    let inputs = json!({
        "workspaceRevision": "1", "parsers": ["swb.reference.framing"],
        "recordings": [reference], "firmware": [{"binding":1,"version":"v2.7.3"}],
        "operations": [saved.operation_id],
    });
    experiment_failure(&f.first, &workspace_target, export_action,
        json!({ "workspaceRevision":"0", "parsers":[], "recordings":[], "firmware":[], "operations":[] }), "REVISION_CONFLICT").await;
    experiment_failure(
        &f.second,
        &workspace_target,
        export_action,
        inputs.clone(),
        "PERMISSION_DENIED",
    )
    .await;

    let before = operation_count(&f);
    let archive = read(&f.first, &workspace_target, export_action, inputs).await;
    let encoded = serde_json::to_string(&archive).unwrap();
    for sensitive in [
        "private-",
        "binding-secret",
        "device-secret",
        "my-secret-port",
        "operationId",
        "actorId",
        "requestContext",
    ] {
        assert!(
            !encoded.contains(sensitive),
            "{sensitive} escaped the portable projection"
        );
    }
    assert_eq!(
        archive["workspace"]["bindings"][0]["fingerprint"]["vid"],
        0x1234
    );
    assert_eq!(
        archive["workspace"]["bindings"][0]["reconnect"]["enabled"],
        false
    );
    assert_eq!(
        archive["workspace"]["views"][0]["bindingId"],
        "experiment-device-1"
    );
    assert_eq!(
        archive["workspace"]["favoriteBindingIds"][0],
        "experiment-device-1"
    );
    assert_eq!(archive["firmware"][0]["version"], "v2.7.3");
    assert_eq!(archive["runs"][0]["state"], "succeeded");
    let inspected = read(
        &f.first,
        &workspace_target,
        inspect_action,
        json!({"json": encoded}),
    )
    .await;
    assert_eq!(inspected["recordingStatus"], json!(["matched"]));
    assert_eq!(inspected["parserStatus"], json!(["matched"]));
    let snapshot = NodePackageInstaller::read_snapshot(&f.store).unwrap();
    let parser = snapshot
        .packages
        .iter()
        .find(|package| package.manifest.id.as_str() == "swb.reference.framing")
        .unwrap();
    assert_eq!(
        archive["parsers"][0]["archiveSha256"],
        parser.archive_sha256.as_str()
    );
    NodePackageInstaller::new(f.store.clone(), f._dir.path())
        .unwrap()
        .set_enabled(
            &parser.manifest.id,
            false,
            snapshot.revision,
            &parser.archive_sha256,
        )
        .unwrap();
    let after_disable = read(
        &f.first,
        &workspace_target,
        inspect_action,
        json!({"json": encoded}),
    )
    .await;
    assert_eq!(after_disable["parserStatus"], json!(["unavailable"]));
    let mut parser_drift = archive.clone();
    parser_drift["parsers"][0]["archiveSha256"] = json!("b".repeat(64));
    let after_drift = read(
        &f.first,
        &workspace_target,
        inspect_action,
        json!({"json": parser_drift.to_string()}),
    )
    .await;
    assert_eq!(after_drift["parserStatus"], json!(["changed"]));
    let unprivileged = read(
        &f.second,
        &workspace_target,
        inspect_action,
        json!({"json": encoded}),
    )
    .await;
    assert_eq!(unprivileged["recordingStatus"], json!(["unavailable"]));
    assert_eq!(unprivileged["parserStatus"], json!(["unavailable"]));

    let mut other = archive.clone();
    other["recordings"][0]["reference"]["hostId"] = json!("another-host");
    other["parsers"] = json!([{
        "id":"swb.test.not-installed", "version":"1.0.0", "archiveSha256":"a".repeat(64)
    }]);
    let result = read(
        &f.first,
        &workspace_target,
        inspect_action,
        json!({"json": other.to_string()}),
    )
    .await;
    assert_eq!(result["recordingStatus"], json!(["other_host"]));
    assert_eq!(result["parserStatus"], json!(["missing"]));
    let mut changed = archive.clone();
    changed["recordings"][0]["fingerprint"] = json!("a".repeat(64));
    let result = read(
        &f.first,
        &workspace_target,
        inspect_action,
        json!({"json": changed.to_string()}),
    )
    .await;
    assert_eq!(result["recordingStatus"], json!(["changed"]));
    let mut stale = archive.clone();
    stale["recordings"][0]["reference"]["revision"] = json!("2");
    let result = read(
        &f.first,
        &workspace_target,
        inspect_action,
        json!({"json": stale.to_string()}),
    )
    .await;
    assert_eq!(result["recordingStatus"], json!(["changed"]));
    let result = read(
        &f.second,
        &workspace_target,
        inspect_action,
        json!({"json": stale.to_string()}),
    )
    .await;
    assert_eq!(result["recordingStatus"], json!(["unavailable"]));
    let mut unsafe_workspace = archive.clone();
    unsafe_workspace["workspace"]["bindings"][0]["portName"] = json!("private-port");
    experiment_failure(
        &f.first,
        &workspace_target,
        inspect_action,
        json!({"json": unsafe_workspace.to_string()}),
        "INVALID_ARGUMENT",
    )
    .await;
    let future = json!({"formatVersion":"2","key":"irrelevant"});
    experiment_failure(
        &f.first,
        &workspace_target,
        inspect_action,
        json!({"json": future.to_string()}),
        "UNSUPPORTED_FORMAT",
    )
    .await;
    assert_eq!(operation_count(&f), before);
    let persisted = WorkspaceService::new(f.store.clone(), workspace_target.id.clone())
        .read()
        .unwrap();
    assert_eq!(persisted.revision.get(), 1);
    assert_eq!(persisted.value, workspace);
    f.finish().await;
}
