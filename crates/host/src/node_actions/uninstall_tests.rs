//! 公开卸载只删除当前安装对象；共享证明、旧回执与失败原件分别核对。
use super::*;
use crate::node_packages::NodePackageInstaller;
use serde_json::Value;
use serial_workbench_core::{NodePackageListResult, ObjectRef};
use std::path::PathBuf;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_uninstall_stops_actual_owner_and_replay_preserves_reinstallation() {
    let markers = support::Profile::isolated("host-node-backend-uninstall-sole-");
    let events = markers.path().join("events.txt");
    let pid_path = markers.path().join("node.pid");
    let fixture = node_host_actions::Fixture::program(
        node_host_actions::spec(),
        &program_with_pid(&events, &pid_path),
    )
    .await;
    let old = current_installation(&fixture).await;
    let original_zip = fixture.dir.path().join("signed-actions.zip");
    let original_bytes = std::fs::read(&original_zip).unwrap();
    // 独立文件哨兵验证保留边界，不宣称已有产品dataDir API。
    let private = fixture
        .dir
        .path()
        .join("plugin-private-files/terminal/state.json");
    std::fs::create_dir_all(private.parent().unwrap()).unwrap();
    std::fs::write(&private, b"retained plugin state").unwrap();
    let mut node = observe_node(&pid_path);
    assert!(!node.exited());

    let outsider = HostClient::connect(ConnectOptions::new(
        fixture.dir.path().to_path_buf(),
        id("uninstall-without-management"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let denied = outsider
        .request(RpcRequest::Invoke(uninstall_call(
            &fixture,
            &outsider,
            &fixture.archive,
            old.revision,
        )))
        .await
        .unwrap();
    assert!(
        matches!(&denied, RpcReply::Failure { error, .. } if error.code=="PERMISSION_DENIED"),
        "{denied:?}"
    );
    let mut stale = uninstall_call(&fixture, &fixture.client, &fixture.archive, 2.into());
    let accepted = fixture.invoke(&fixture.client, stale.clone()).await;
    let stale_result = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_failed(&stale_result, "REVISION_CONFLICT");
    stale.request_id = RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
    stale.expected_revision = Some(old.revision);
    stale.params = serde_json::from_value(json!({
        "id":"example.terminal","archiveSha256":"0".repeat(64)
    }))
    .unwrap();
    let accepted = fixture.invoke(&fixture.client, stale).await;
    let wrong_archive = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_failed(&wrong_archive, "INTEGRITY_FAILED");
    let unchanged = current_installation(&fixture).await;
    assert_eq!(unchanged.record, old.record);
    assert_eq!(unchanged.revision, old.revision);
    assert!(old.code.is_dir() && old.zip.is_file());
    assert!(!node.exited());
    assert_eq!(std::fs::read_to_string(&events).unwrap(), "register-1\n");
    business(&fixture, "example.terminal.compute", 7, 8, 1).await;

    let call = uninstall_call(&fixture, &fixture.client, &fixture.archive, old.revision);
    let accepted = fixture.invoke(&fixture.client, call.clone()).await;
    let removed = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_uninstalled(&removed, &fixture.archive, 4.into());
    assert!(
        node.exited(),
        "Uninstall must reap the actual sole Node before its receipt"
    );
    let empty = packages(&fixture).await;
    assert_eq!(empty.revision, 4.into());
    assert!(empty.packages.is_empty());
    assert!(
        !old.code.exists(),
        "Current code object survived successful uninstall"
    );
    assert!(
        !old.zip.exists(),
        "Current staged ZIP survived successful uninstall"
    );
    assert_eq!(std::fs::read(&original_zip).unwrap(), original_bytes);
    assert_eq!(std::fs::read(&private).unwrap(), b"retained plugin state");
    let stopped_events = std::fs::read_to_string(&events).unwrap();
    assert_eq!(stopped_events, "register-1\ncall-1\ndispose-1\n");

    let request = upgrade_request(
        &fixture,
        &fixture.client,
        &events,
        false,
        2,
        4,
        vec![id("startup")],
    )
    .await;
    let accepted = fixture.invoke(&fixture.client, request).await;
    let installed = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
    let replacement = current_installation(&fixture).await;
    assert_eq!(replacement.revision, 5.into());
    assert_ne!(
        replacement.code, old.code,
        "Reinstallation must use a new UUID"
    );
    assert!(replacement.code.is_dir() && replacement.zip.is_file());
    assert_eq!(replacement.record["enabled"], false);
    assert_eq!(fixture.invoke(&fixture.client, call).await, removed);
    let after_replay = current_installation(&fixture).await;
    assert_eq!(after_replay.record, replacement.record);
    assert_eq!(after_replay.revision, replacement.revision);
    assert!(replacement.code.is_dir() && replacement.zip.is_file());
    assert_eq!(std::fs::read_to_string(&events).unwrap(), stopped_events);
    assert_eq!(std::fs::read(&private).unwrap(), b"retained plugin state");
    assert_eq!(std::fs::read(&original_zip).unwrap(), original_bytes);
    let _profile = fixture.finish().await;
    eprintln!(
        "native_uninstall_sole actual_exit_before_receipt=true current_code_and_zip_removed=true original_zip_and_private_files_retained=true denied_stale_digest_preserved=true new_uuid_reinstall=true old_uninstall_replay_preserves_new_record=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_uninstall_shared_proof_preserves_q_and_distinguishes_current_object() {
    for dormant_replacement in [false, true] {
        let markers = support::Profile::isolated("host-node-backend-uninstall-shared-");
        let events = markers.path().join("p.events");
        let pid_path = markers.path().join("p.pid");
        let q_events = markers.path().join("q.events");
        let q_pid_path = markers.path().join("q.pid");
        let fixture = node_host_actions::Fixture::program(
            node_host_actions::spec(),
            &program_with_pid(&events, &pid_path),
        )
        .await;
        let q_archive = install_q(&fixture, &q_events, &q_pid_path).await;
        let old = current_installation(&fixture).await;
        assert_eq!(old.revision, 6.into());
        let p_before = runtime(&fixture).await;
        let q_before = package_runtime(&fixture, "example.graph").await;
        assert_eq!(p_before.phase, NodePackageRuntimePhase::Active);
        assert_eq!(q_before.phase, NodePackageRuntimePhase::Active);
        let pid_text = std::fs::read_to_string(&pid_path).unwrap();
        assert_eq!(std::fs::read_to_string(&q_pid_path).unwrap(), pid_text);
        let mut node = observe_node(&pid_path);
        let p_events = std::fs::read_to_string(&events).unwrap();
        let before_q_events = std::fs::read_to_string(&q_events).unwrap();
        let busy_call = uninstall_call(&fixture, &fixture.client, &fixture.archive, 6.into());
        let accepted = fixture.invoke(&fixture.client, busy_call.clone()).await;
        let busy = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_failed(&busy, "HOST_BUSY");
        let held = current_installation(&fixture).await;
        assert_eq!(held.record, old.record);
        assert_eq!(held.revision, old.revision);
        assert!(old.code.is_dir() && old.zip.is_file());
        assert_eq!(runtime(&fixture).await, p_before);
        assert_eq!(package_runtime(&fixture, "example.graph").await, q_before);
        assert_eq!(std::fs::read_to_string(&events).unwrap(), p_events);
        assert_eq!(std::fs::read_to_string(&q_events).unwrap(), before_q_events);
        assert!(!node.exited());
        business(&fixture, "example.terminal.compute", 3, 4, 1).await;
        business(&fixture, "example.graph.compute", 5, 5, 1).await;

        if dormant_replacement {
            // 权限扩大的新安装保持Dormant；旧P的proof仍由运行Q的同一Node持有。
            let request = upgrade_request(
                &fixture,
                &fixture.client,
                &events,
                true,
                2,
                6,
                vec![id("startup")],
            )
            .await;
            let accepted = fixture.invoke(&fixture.client, request).await;
            let installed = fixture.wait(&fixture.client, &accepted.operation_id).await;
            assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
            let Some(ActionResult::NodePackageInstalled(receipt)) = &installed.result else {
                panic!("Expected replacement installation: {installed:?}");
            };
            assert!(!receipt.package.enabled && !receipt.package.execution_approved);
            let current = current_installation(&fixture).await;
            assert_eq!(current.revision, 7.into());
            assert_ne!(current.code, old.code);
            assert!(old.code.is_dir() && old.zip.is_file());
            assert!(!node.exited());
            let call = uninstall_call(
                &fixture,
                &fixture.client,
                &receipt.package.archive_sha256,
                7.into(),
            );
            let accepted = fixture.invoke(&fixture.client, call).await;
            let removed = fixture.wait(&fixture.client, &accepted.operation_id).await;
            assert_uninstalled(&removed, &receipt.package.archive_sha256, 8.into());
            assert!(!current.code.exists() && !current.zip.exists());
            assert!(
                old.code.is_dir() && old.zip.is_file(),
                "Old proof and history must survive"
            );
            assert!(
                !node.exited(),
                "Removing an unproved current object must not stop Q"
            );
            assert_eq!(package_runtime(&fixture, "example.graph").await, q_before);
            business(&fixture, "example.graph.compute", 6, 6, 2).await;
            assert_eq!(std::fs::read_to_string(&q_pid_path).unwrap(), pid_text);
            assert_eq!(fixture.invoke(&fixture.client, busy_call).await, busy);
            let remaining = packages(&fixture).await;
            assert_eq!(remaining.revision, 8.into());
            assert_eq!(remaining.packages.len(), 1);
            assert_eq!(remaining.packages[0].id.as_str(), "example.graph");
        } else {
            let stopped_q = fixture
                .mutate(
                    &fixture.client,
                    "node.packages.setEnabled",
                    json!({"id":"example.graph","archiveSha256":q_archive,"enabled":false}),
                    6,
                )
                .await;
            assert_eq!(stopped_q.state, OperationState::Succeeded, "{stopped_q:?}");
            assert!(!node.exited(), "P is still active after only Q stops");
            let call = uninstall_call(&fixture, &fixture.client, &fixture.archive, 7.into());
            let accepted = fixture.invoke(&fixture.client, call).await;
            let removed = fixture.wait(&fixture.client, &accepted.operation_id).await;
            assert_uninstalled(&removed, &fixture.archive, 8.into());
            assert!(
                node.exited(),
                "Last active package must release the actual shared Node"
            );
            assert!(!old.code.exists() && !old.zip.exists());
            assert_eq!(fixture.invoke(&fixture.client, busy_call).await, busy);
            let remaining = packages(&fixture).await;
            assert_eq!(remaining.revision, 8.into());
            assert_eq!(remaining.packages.len(), 1);
            assert_eq!(remaining.packages[0].id.as_str(), "example.graph");
            assert!(!remaining.packages[0].enabled);
        }
        let _profile = fixture.finish().await;
        assert!(node.wait(), "Normal cleanup must reap any surviving Q Node");
        eprintln!(
            "native_uninstall_shared dormant_replacement={dormant_replacement} initial_busy_preserves_p_q=true same_pid_generation=true current_object_only=true old_request_replay_unchanged=true actual_node_exit=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_uninstall_revoked_source_and_corrupt_code_retains_failed_upgrade_evidence() {
    let markers = support::Profile::isolated("host-node-backend-uninstall-revoked-");
    let events = markers.path().join("events.txt");
    let pid_path = markers.path().join("node.pid");
    let fixture = node_host_actions::Fixture::program(
        node_host_actions::spec(),
        &program_with_pid(&events, &pid_path),
    )
    .await;
    let old = current_installation(&fixture).await;
    let original_zip = fixture.dir.path().join("signed-actions.zip");
    let original_bytes = std::fs::read(&original_zip).unwrap();
    let private = fixture
        .dir
        .path()
        .join("plugin-private-files/terminal/state.json");
    std::fs::create_dir_all(private.parent().unwrap()).unwrap();
    std::fs::write(&private, b"retained after source revocation").unwrap();
    let mut node = observe_node(&pid_path);
    let request = upgrade_request(
        &fixture,
        &fixture.client,
        &events,
        false,
        2,
        3,
        vec![id("startup")],
    )
    .await;
    // 复用已有提交前调度门，不增加产品gate；候选已落盘且旧P已实际收敛。
    let mut committing = fixture
        .host
        .inner
        .node_test_gates
        .upgrade_before_commit
        .arm();
    let accepted = fixture.invoke(&fixture.client, request).await;
    committing.entered().await;
    assert!(
        node.exited(),
        "The old Node must exit before tampering or uninstall"
    );
    let sources = source_keys(&fixture).await;
    let key = sources
        .keys
        .iter()
        .find(|key| key.source.as_str() == "test-source" && key.key_id.as_str() == "test-key")
        .unwrap();
    let revoked = fixture
        .mutate(
            &fixture.user,
            "node.sources.revokeKey",
            json!({"source":key.source,"keyId":key.key_id,"publicKeySha256":key.public_key_sha256}),
            sources.revision.get(),
        )
        .await;
    assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
    committing.release();
    let rejected = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(rejected.state, OperationState::Interrupted, "{rejected:?}");
    assert_eq!(rejected.error.as_ref().unwrap().code, "PERMISSION_DENIED");
    assert!(rejected.result.is_none());
    let preserved = current_installation(&fixture).await;
    assert_eq!(preserved.revision, old.revision);
    assert_eq!(preserved.record, old.record);
    let failed = failed_upgrade_files(&fixture);
    let failed_bytes: Vec<_> = failed
        .iter()
        .map(|path| std::fs::read(path).unwrap())
        .collect();
    let corrupt = old.code.join("dist/main.mjs");
    make_writable(&corrupt);
    std::fs::write(&corrupt, b"throw new Error('corrupted installed source');").unwrap();
    let removed = fixture
        .mutate(
            &fixture.client,
            "node.packages.uninstall",
            json!({"id":"example.terminal","archiveSha256":fixture.archive}),
            old.revision.get(),
        )
        .await;
    assert_uninstalled(&removed, &fixture.archive, 4.into());
    assert!(node.exited());
    assert!(!old.code.exists() && !old.zip.exists());
    let empty = packages(&fixture).await;
    assert_eq!(empty.revision, 4.into());
    assert!(empty.packages.is_empty());
    for (path, bytes) in failed.iter().zip(failed_bytes) {
        assert_eq!(
            std::fs::read(path).unwrap(),
            bytes,
            "Failed evidence changed: {path:?}"
        );
    }
    assert_eq!(std::fs::read(&original_zip).unwrap(), original_bytes);
    assert_eq!(
        std::fs::read(&private).unwrap(),
        b"retained after source revocation"
    );
    assert!(source_keys(&fixture).await.keys.iter().any(|key| {
        key.source.as_str() == "test-source" && key.key_id.as_str() == "test-key" && !key.approved
    }));
    assert_eq!(
        std::fs::read_to_string(&events).unwrap(),
        "register-1\ndispose-1\n"
    );
    let _profile = fixture.finish().await;
    eprintln!(
        "native_uninstall_revoked_corrupt source_remains_revoked=true damaged_code_removed_without_verification=true actual_old_node_exit=true current_zip_removed=true real_failed_upgrade_code_zip_receipt_retained=true original_zip_private_files_retained=true"
    );
}

struct Installation {
    revision: U64,
    record: Value,
    code: PathBuf,
    zip: PathBuf,
}

async fn current_installation(fixture: &node_host_actions::Fixture) -> Installation {
    let store = fixture.host.inner.store.clone();
    let (revision, record, object) = tokio::task::spawn_blocking(move || {
        let snapshot = NodePackageInstaller::read_snapshot(&store).unwrap();
        let package = snapshot
            .packages
            .iter()
            .find(|package| package.manifest.id.as_str() == "example.terminal")
            .expect("Expected current P installation");
        (
            snapshot.revision,
            serde_json::to_value(package).unwrap(),
            package.object_id(),
        )
    })
    .await
    .unwrap();
    let root = fixture.dir.path().join("host-v0/node-packages");
    Installation {
        revision,
        record,
        code: root.join("objects").join(object.to_string()),
        zip: root
            .join("staging")
            .join(object.to_string())
            .join("input.zip"),
    }
}

async fn packages(fixture: &node_host_actions::Fixture) -> NodePackageListResult {
    let QueryResult::NodePackages(packages) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected public package list");
    };
    packages
}

async fn source_keys(
    fixture: &node_host_actions::Fixture,
) -> serial_workbench_core::NodeSourceListResult {
    let QueryResult::NodePackageSources(sources) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.sources.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected public source keys");
    };
    sources
}

fn uninstall_call(
    fixture: &node_host_actions::Fixture,
    client: &HostClient,
    archive: &Digest,
    revision: U64,
) -> Call {
    let mut call = fixture.call(
        client,
        &fixture.target,
        "node.packages.uninstall",
        json!({
            "id":"example.terminal","archiveSha256":archive
        }),
    );
    call.expected_revision = Some(revision);
    call
}

fn assert_uninstalled(operation: &Operation, archive: &Digest, revision: U64) {
    assert_eq!(operation.state, OperationState::Succeeded, "{operation:?}");
    assert!(operation.error.is_none());
    let Some(ActionResult::NodePackageUninstalled(result)) = &operation.result else {
        panic!("Expected committed uninstall receipt: {operation:?}");
    };
    assert_eq!(result.revision, revision);
    assert_eq!(result.id.as_str(), "example.terminal");
    assert_eq!(&result.archive_sha256, archive);
}

fn assert_failed(operation: &Operation, code: &str) {
    assert_eq!(operation.state, OperationState::Failed, "{operation:?}");
    assert_eq!(operation.error.as_ref().unwrap().code, code);
    assert!(operation.result.is_none());
}

fn program_with_pid(events: &Path, pid: &Path) -> Vec<u8> {
    let mut source = format!(
        "import {{writeFileSync}} from 'node:fs';writeFileSync({},String(process.pid));",
        serde_json::to_string(pid).unwrap(),
    )
    .into_bytes();
    source.extend(program(events, 1));
    source
}

fn observe_node(pid: &Path) -> support::node_owner_exit::ProcessExit {
    support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(pid).unwrap().parse().unwrap(),
    )
}

async fn business(
    fixture: &node_host_actions::Fixture,
    action: &str,
    input: u64,
    output: u64,
    calls: u64,
) {
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                action,
                json!({"value":input}),
            ),
        )
        .await;
    let result = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(result.state, OperationState::Succeeded, "{result:?}");
    assert_eq!(
        fixture.result(&fixture.client, &result).await,
        json!({"value":output,"calls":calls})
    );
}

async fn package_runtime(
    fixture: &node_host_actions::Fixture,
    package: &str,
) -> NodePackageRuntimeStatus {
    let QueryResult::NodePackageRuntime(status) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.runtime",
            json!({"id":package}),
        )
        .await
    else {
        panic!("Expected public runtime state");
    };
    status
}

async fn install_q(fixture: &node_host_actions::Fixture, events: &Path, pid: &Path) -> Digest {
    let mut spec = node_host_actions::spec();
    spec.action_id = id("example.graph.compute");
    let mut metadata = node_package::manifest();
    metadata["id"] = json!("example.graph");
    metadata["activation"] = json!(["startup"]);
    metadata["permissions"]["hostApi"] = json!([{
        "permissions":spec.permissions,"targetKinds":spec.target_kinds
    }]);
    metadata["contributes"]["actions"] = json!([spec]);
    let source = format!(
        "import {{appendFileSync,writeFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(context){{writeFileSync({},String(process.pid));event('register-q');let calls=0;context.actions.register('example.graph.compute',call=>{{event('call-q');return {{value:call.params.value,calls:++calls}};}});return ()=>event('dispose-q');}}",
        serde_json::to_string(events).unwrap(),
        serde_json::to_string(pid).unwrap(),
    );
    let mut files = node_package::payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&metadata).unwrap(),
    );
    files.insert("dist/main.mjs".into(), source.into_bytes());
    let path = fixture.dir.path().join("signed-uninstall-q.zip");
    std::fs::write(
        &path,
        node_package::archive(&node_package::with_metadata(files, true)),
    )
    .unwrap();
    let reference = register_archive(fixture, &path).await;
    let installed = fixture.mutate(
        &fixture.client, "node.packages.install",
        json!({"archiveRef":reference,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}}), 3,
    ).await;
    assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
    let Some(ActionResult::NodePackageInstalled(receipt)) = &installed.result else {
        panic!("Expected installed Q: {installed:?}");
    };
    assert_eq!(receipt.revision, 4.into());
    let archive = receipt.package.archive_sha256.clone();
    let confirmed = fixture
        .mutate(
            &fixture.user,
            "node.packages.confirmExecutionTrust",
            json!({"id":"example.graph","archiveSha256":archive}),
            4,
        )
        .await;
    assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
    assert!(
        !events.exists(),
        "Installing and confirming Q cannot import its code"
    );
    let enabled = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":"example.graph","archiveSha256":archive,"enabled":true}),
            5,
        )
        .await;
    assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
    archive
}

async fn register_archive(fixture: &node_host_actions::Fixture, path: &Path) -> ObjectRef {
    let registered = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "file.register",
                json!({"path":path.to_str().unwrap(),"purpose":"read_file"}),
            ),
        )
        .await;
    let registered = fixture.wait(&fixture.user, &registered.operation_id).await;
    assert_eq!(
        registered.state,
        OperationState::Succeeded,
        "{registered:?}"
    );
    let Some(ActionResult::FileMetadata(reference)) = registered.result else {
        panic!("Expected registered signed archive");
    };
    reference.file_ref
}

fn failed_upgrade_files(fixture: &node_host_actions::Fixture) -> Vec<PathBuf> {
    let root = fixture.dir.path().join("host-v0/node-packages");
    let stages: Vec<_> = std::fs::read_dir(root.join("staging")).unwrap().map(|entry| {
        entry.unwrap().path()
    }).filter(|stage| {
        let evidence = stage.join("installation.json");
        evidence.is_file() && serde_json::from_slice::<Value>(&std::fs::read(evidence).unwrap()).unwrap()["outcome"]["committed"] == false
    }).collect();
    assert_eq!(
        stages.len(),
        1,
        "Expected one actual failed prepared upgrade"
    );
    let stage = &stages[0];
    vec![
        stage.join("input.zip"),
        stage.join("installation.json"),
        root.join("objects")
            .join(stage.file_name().unwrap())
            .join("dist/main.mjs"),
    ]
}

fn make_writable(path: &Path) {
    let mut permissions = std::fs::metadata(path).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(permissions.mode() | 0o200);
    }
    #[cfg(windows)]
    #[expect(
        clippy::permissions_set_readonly_false,
        reason = "Windows夹具只清除只读属性；Unix分支仅增加属主写权限"
    )]
    permissions.set_readonly(false);
    std::fs::set_permissions(path, permissions).unwrap();
}
