//! 实际文件及SQLite覆盖崩溃后的判定；不替代公开卸载和Node退出验收。
use super::*;
use crate::{storage::Store, test_support::Profile};

#[tokio::test]
async fn future_uninstall_journal_keeps_rust_io_and_source_revocation_available() {
    use crate::test_support::{Harness, id};
    use serial_workbench_core::*;
    let directory = tempfile::tempdir().unwrap();
    let removal = directory
        .path()
        .join("host-v0/node-packages/uninstall")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&removal).unwrap();
    for name in ["objects", "staging"] {
        fs::create_dir_all(directory.path().join("host-v0/node-packages").join(name)).unwrap();
    }
    let journal = removal.join(JOURNAL);
    let future_bytes = br#"{"formatVersion":"2"}"#;
    fs::write(&journal, future_bytes).unwrap();
    let h = Harness::in_profile(directory).await;
    let session = h.open("future-uninstall-journal").await;
    let sent = h.send(&session).await;
    assert_eq!(sent.state, OperationState::Succeeded, "{sent:?}");
    assert_eq!(h.write_count(), 1);
    let target = Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: h.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let operator = h
        .auth
        .authenticate_user_control(
            &id("future-journal-operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
        .verifying_key()
        .to_bytes();
    let fingerprint = format!("{:x}", Sha256::digest(key));
    for (action, params, revision) in [
        (
            "node.sources.approveKey",
            serde_json::json!({"source":"pending-test","keyId":"test-key","publicKey":key,"publicKeySha256":fingerprint}),
            0_u64,
        ),
        (
            "node.sources.revokeKey",
            serde_json::json!({"source":"pending-test","keyId":"test-key","publicKeySha256":fingerprint}),
            1,
        ),
    ] {
        let mut call = h.call_as(&operator, &target, action, params);
        call.expected_revision = Some(revision.into());
        call.execution_mode = Some(ExecutionMode::Independent);
        let accepted = h.host.invoke(&operator, call).await.unwrap();
        let done = h.wait_as(&operator, &accepted.operation_id).await;
        assert_eq!(done.state, OperationState::Succeeded, "{done:?}");
    }
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["plugins.manage".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let mut call = h.call(
        &target,
        "node.packages.uninstall",
        serde_json::json!({
            "id":"example.terminal","archiveSha256":"0".repeat(64)
        }),
    );
    call.expected_revision = Some(0.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.invoke(call).await;
    let rejected = h.wait(&accepted.operation_id).await;
    assert_eq!(rejected.state, OperationState::Interrupted, "{rejected:?}");
    assert_eq!(rejected.error.as_ref().unwrap().code, "FUTURE_FORMAT");
    assert!(rejected.result.is_none());
    assert_eq!(fs::read(&journal).unwrap(), future_bytes);
    let sent_again = h.send(&session).await;
    assert_eq!(
        sent_again.state,
        OperationState::Succeeded,
        "{sent_again:?}"
    );
    assert_eq!(h.write_count(), 2);
    h.host.shutdown().await.unwrap();
    eprintln!(
        "node_uninstall_future_journal rust_tx_before_after=true source_revoke_succeeded=true node_mutation_rejected=true journal_unchanged=true"
    );
}
use std::{
    sync::{Arc, atomic::Ordering},
    time::Duration,
};

struct Prepared {
    installer: NodePackageInstaller,
    journal: Journal,
    profile: Profile,
}
impl Prepared {
    fn new() -> Self {
        let profile = Profile::isolated("node-uninstall-journal-");
        let store = Store::open(profile.path()).unwrap();
        fs::create_dir_all(profile.path().join("host-v0")).unwrap();
        let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
        let locations = Locations::create(profile.path()).unwrap();
        let object_id = uuid::Uuid::new_v4();
        let name = object_id.to_string();
        for parent in [&locations.objects, &locations.staging] {
            fs::create_dir(parent.checked_path().join(&name)).unwrap();
        }
        fs::write(
            locations
                .objects
                .checked_path()
                .join(&name)
                .join("main.mjs"),
            b"current code",
        )
        .unwrap();
        fs::write(
            locations
                .staging
                .checked_path()
                .join(&name)
                .join("input.zip"),
            b"opaque original archive",
        )
        .unwrap();
        fs::write(profile.path().join("private-data"), b"must remain").unwrap();
        let cancel = AtomicBool::new(false);
        let limits = NodePackageLimits::default();
        let control = Control::new(&cancel, limits.timeout).unwrap();
        let post_image = document_hash(&InstallDocument::default(), &control).unwrap();
        let journal = Journal {
            format_version: 1.into(),
            id: NodePackageId::try_from("example.terminal").unwrap(),
            archive_sha256: Digest::try_from("0".repeat(64).as_str()).unwrap(),
            object_id,
            pre_revision: 0.into(),
            pre_image: Digest::try_from("1".repeat(64).as_str()).unwrap(),
            post_image,
            object: inspect_directory(&locations.objects, &name).unwrap(),
            stage: inspect_directory(&locations.staging, &name).unwrap(),
        };
        let mut removal = locations.removals.child(&name).unwrap();
        removal.create_directory().unwrap();
        write_json(&removal, JOURNAL, &journal, &limits, &control).unwrap();
        move_original(&locations.objects, &name, &removal, "code", &journal.object).unwrap();
        move_original(&locations.staging, &name, &removal, "stage", &journal.stage).unwrap();
        Self {
            installer,
            journal,
            profile,
        }
    }
    fn removal(&self) -> std::path::PathBuf {
        self.profile
            .path()
            .join("host-v0/node-packages")
            .join(REMOVALS)
            .join(self.journal.object_id.to_string())
    }
    fn commit_empty(&self, expected: u64) {
        let value = serde_json::from_value(serde_json::json!({
            "formatVersion":"1","packages":{}
        }))
        .unwrap();
        self.installer
            .store
            .compare_and_swap_schema_document(&document_id(), expected.into(), value)
            .unwrap();
    }
    fn recover(&self) -> HostResult<()> {
        self.installer
            .recover_uninstalls(&NodePackageLimits::default(), &AtomicBool::new(false))
    }
    fn assert_quarantined(&self) {
        assert_eq!(
            fs::read(self.removal().join("code/main.mjs")).unwrap(),
            b"current code"
        );
        assert_eq!(
            fs::read(self.removal().join("stage/input.zip")).unwrap(),
            b"opaque original archive"
        );
        assert!(self.removal().join(JOURNAL).exists());
    }
}

#[test]
fn exact_post_image_recovers_a_commit_without_the_late_marker() {
    let prepared = Prepared::new();
    prepared.commit_empty(0);
    prepared.recover().unwrap();
    assert!(!prepared.removal().exists());
    assert_eq!(
        fs::read(prepared.profile.path().join("private-data")).unwrap(),
        b"must remain"
    );
    assert_eq!(prepared.installer.snapshot().unwrap().revision, 1.into());
}

#[test]
fn unreferenced_object_with_a_changed_revision_requires_commit_evidence() {
    let prepared = Prepared::new();
    prepared.commit_empty(0);
    prepared.commit_empty(1);
    assert_eq!(
        prepared.recover().unwrap_err().code,
        "NODE_UNINSTALL_RECOVERY_REQUIRED"
    );
    prepared.assert_quarantined();
    let locations = Locations::open(prepared.profile.path()).unwrap();
    let mut removal = locations
        .removals
        .child(&prepared.journal.object_id.to_string())
        .unwrap();
    removal.open_existing_directory().unwrap();
    let cancel = AtomicBool::new(false);
    let limits = NodePackageLimits::default();
    let control = Control::new(&cancel, limits.timeout).unwrap();
    write_json(
        &removal,
        MARKER,
        &CommitMarker {
            format_version: 1.into(),
            object_id: prepared.journal.object_id,
            post_image: prepared.journal.post_image.clone(),
            result: NodePackageUninstallResult {
                revision: 1.into(),
                id: prepared.journal.id.clone(),
                archive_sha256: prepared.journal.archive_sha256.clone(),
            },
        },
        &limits,
        &control,
    )
    .unwrap();
    drop(removal);
    drop(locations);
    prepared.recover().unwrap();
    assert!(!prepared.removal().exists());
    assert_eq!(prepared.installer.snapshot().unwrap().revision, 2.into());
}

#[test]
fn restore_preserves_both_original_directories_and_their_bytes() {
    let prepared = Prepared::new();
    let locations = Locations::open(prepared.profile.path()).unwrap();
    let mut removal = locations
        .removals
        .child(&prepared.journal.object_id.to_string())
        .unwrap();
    removal.open_existing_directory().unwrap();
    restore(&locations, &removal, &prepared.journal).unwrap();
    finish_metadata(&mut removal).unwrap();
    let name = prepared.journal.object_id.to_string();
    assert_eq!(
        fs::read(
            locations
                .objects
                .checked_path()
                .join(&name)
                .join("main.mjs")
        )
        .unwrap(),
        b"current code"
    );
    assert_eq!(
        fs::read(
            locations
                .staging
                .checked_path()
                .join(&name)
                .join("input.zip")
        )
        .unwrap(),
        b"opaque original archive"
    );
    assert!(!prepared.removal().exists());
    assert_eq!(prepared.installer.snapshot().unwrap().revision, 0.into());
}

#[test]
fn future_installation_or_journal_keeps_quarantine_untouched() {
    for future in ["installation", "journal"] {
        let prepared = Prepared::new();
        let journal_path = prepared.removal().join(JOURNAL);
        if future == "installation" {
            prepared
                .installer
                .store
                .compare_and_swap_schema_document(
                    &document_id(),
                    0.into(),
                    serde_json::from_value(serde_json::json!({
                        "formatVersion":"2","future":{"preserve":true}
                    }))
                    .unwrap(),
                )
                .unwrap();
        } else {
            fs::write(
                &journal_path,
                br#"{"formatVersion":"2","future":{"preserve":true}}"#,
            )
            .unwrap();
        }
        let original = fs::read(&journal_path).unwrap();
        let stored = prepared
            .installer
            .store
            .read_schema_document(&document_id())
            .unwrap()
            .map(|document| {
                (
                    document.revision,
                    serde_json::to_value(document.value).unwrap(),
                )
            });
        assert_eq!(prepared.recover().unwrap_err().code, "FUTURE_FORMAT");
        prepared.assert_quarantined();
        assert_eq!(fs::read(&journal_path).unwrap(), original);
        assert_eq!(
            prepared
                .installer
                .store
                .read_schema_document(&document_id())
                .unwrap()
                .map(|document| (
                    document.revision,
                    serde_json::to_value(document.value).unwrap()
                )),
            stored
        );
    }
}

#[test]
fn uninstall_audit_counts_the_exact_relative_path_without_a_root_separator() {
    for path_bytes in [64, 65] {
        let profile = Profile::isolated("node-uninstall-path-budget-");
        let root = profile.path().join("object");
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("nested")).unwrap();
        let relative = format!("nested/{}", "x".repeat(path_bytes - "nested/".len()));
        assert_eq!(relative.len(), path_bytes);
        serial_workbench_core::NodePackagePath::try_from(relative.as_str()).unwrap();
        fs::write(root.join(&relative), b"exact path bytes").unwrap();
        let limits = NodePackageLimits {
            max_path_bytes: 64,
            timeout: Duration::from_secs(5),
            ..NodePackageLimits::default()
        };
        let cancel = AtomicBool::new(false);
        let control = Control::new(&cancel, limits.timeout).unwrap();
        let mut budget = WalkBudget::new(&limits).unwrap();
        // 只审计代码对象，stage中的元数据路径不能替代这个真实边界。
        let result = walk_tree(
            PathGuard::new(&root).unwrap(),
            0,
            &mut budget,
            &control,
            false,
        );
        if path_bytes == 64 {
            result.expect("A legal 64-byte relative path must fit the 64-byte audit budget");
        } else {
            assert_eq!(result.unwrap_err().code, "LIMIT_EXCEEDED");
        }
        assert_eq!(fs::read(root.join(&relative)).unwrap(), b"exact path bytes");
    }
    eprintln!("node_uninstall_path_budget limit=64 exact_64_accepted=true over_65_rejected=true");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uninstall_full_writer_restores_originals_before_the_queue_is_released() {
    let (_profile, installer, receipt, payloads, stage, stage_bytes, original_value) =
        tokio::task::spawn_blocking(|| {
            use crate::test_support::node_package;
            let profile = Profile::isolated("node-uninstall-full-writer-");
            let store = Store::open(profile.path()).unwrap();
            let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
            let payloads = node_package::with_metadata(node_package::payloads(), false);
            let archive = node_package::archive(&payloads);
            let limits = NodePackageLimits {
                timeout: Duration::from_secs(5),
                ..NodePackageLimits::default()
            };
            let cancel = AtomicBool::new(false);
            let verified = crate::node_packages::verify_node_package(
                archive,
                crate::node_packages::NodePackageSource::Local,
                &limits,
                &cancel,
            )
            .unwrap();
            let receipt = installer
                .install(verified, 0.into(), &limits, &cancel)
                .unwrap();
            let stage = installer
                .profile
                .join("host-v0/node-packages/staging")
                .join(receipt.package.object_id.to_string());
            let stage_bytes: Vec<_> = fs::read_dir(&stage)
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    (entry.file_name(), fs::read(entry.path()).unwrap())
                })
                .collect();
            assert!(stage.join("input.zip").is_file());
            assert!(stage.join("installation.json").is_file());
            for (name, bytes) in &payloads {
                assert_eq!(
                    fs::read(receipt.code_directory().join(name)).unwrap(),
                    *bytes
                );
            }
            let document = installer
                .store
                .read_schema_document(&document_id())
                .unwrap()
                .unwrap();
            assert_eq!(document.revision, receipt.revision);
            let original_value = serde_json::to_value(document.value).unwrap();
            (
                profile,
                installer,
                receipt,
                payloads,
                stage,
                stage_bytes,
                original_value,
            )
        })
        .await
        .unwrap();
    let code = receipt.code_directory().to_path_buf();
    let quarantine = installer
        .profile
        .join("host-v0/node-packages")
        .join(REMOVALS)
        .join(receipt.package.object_id.to_string());
    let revision = receipt.revision;
    let params = NodePackageIdentityParams {
        id: receipt.package.manifest.id.clone(),
        archive_sha256: receipt.package.archive_sha256.clone(),
    };
    let committed = Arc::new(AtomicBool::new(false));
    let actual_committed = committed.clone();
    let mut committing = installer.store.schema_commit_ready.arm();
    let worker_installer = installer.clone();
    let worker = tokio::task::spawn_blocking(move || {
        let limits = NodePackageLimits {
            timeout: Duration::from_secs(5),
            ..NodePackageLimits::default()
        };
        worker_installer.uninstall_authorized(
            &params,
            revision,
            &limits,
            &AtomicBool::new(false),
            || Ok(()),
            |_| {
                actual_committed.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
    });
    committing.entered().await;
    assert!(!code.exists() && !stage.exists());
    assert!(quarantine.join("code").is_dir() && quarantine.join("stage").is_dir());
    let store = installer.store.clone();
    let mut saturated = tokio::task::spawn_blocking(move || store.saturate_writer_for_test())
        .await
        .unwrap();
    committing.release();
    let result = tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .expect("A real Full rejection must finish without waiting for the saturated writer")
        .unwrap();
    assert_eq!(result.unwrap_err().code, "HOST_BUSY");
    assert!(!committed.load(Ordering::SeqCst));
    // 此时真实writer仍停住且256个位置仍满，不能先排空再把恢复归给产品。
    assert!(code.is_dir() && stage.is_dir());
    for (name, bytes) in &payloads {
        assert_eq!(fs::read(code.join(name)).unwrap(), *bytes);
    }
    for (name, bytes) in &stage_bytes {
        assert_eq!(fs::read(stage.join(name)).unwrap(), *bytes);
    }
    assert!(
        !quarantine.exists(),
        "Completed rollback must remove its quarantine metadata"
    );
    tokio::task::spawn_blocking(move || saturated.release())
        .await
        .unwrap();
    let retained = installer
        .store
        .read_schema_document(&document_id())
        .unwrap()
        .unwrap();
    assert_eq!(retained.revision, revision);
    assert_eq!(
        serde_json::to_value(retained.value).unwrap(),
        original_value
    );
    let snapshot = installer.snapshot().unwrap();
    assert_eq!(snapshot.revision, revision);
    assert_eq!(snapshot.packages, vec![receipt.package]);
    eprintln!(
        "node_uninstall_full_writer real_queue_256_full=true rejection=HOST_BUSY originals_restored_before_drain=true quarantine_cleared=true commit_callback=false original_document_revision_retained=true"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uninstall_lost_schema_receipt_and_late_cancel_preserve_the_real_commit() {
    let (profile, installer, receipt) = tokio::task::spawn_blocking(|| {
        use crate::test_support::node_package;
        let profile = Profile::isolated("node-uninstall-lost-receipt-");
        let store = Store::open(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
        let archive = node_package::archive(&node_package::with_metadata(
            node_package::payloads(),
            false,
        ));
        let limits = NodePackageLimits {
            timeout: Duration::from_secs(5),
            ..NodePackageLimits::default()
        };
        let cancel = AtomicBool::new(false);
        let verified = crate::node_packages::verify_node_package(
            archive,
            crate::node_packages::NodePackageSource::Local,
            &limits,
            &cancel,
        )
        .unwrap();
        let receipt = installer
            .install(verified, 0.into(), &limits, &cancel)
            .unwrap();
        fs::write(profile.path().join("private-data"), b"must remain").unwrap();
        (profile, installer, receipt)
    })
    .await
    .unwrap();
    let code = receipt.code_directory().to_path_buf();
    let stage = installer
        .profile
        .join("host-v0/node-packages/staging")
        .join(receipt.package.object_id.to_string());
    let quarantine = installer
        .profile
        .join("host-v0/node-packages")
        .join(REMOVALS)
        .join(receipt.package.object_id.to_string());
    let expected = NodePackageUninstallResult {
        revision: receipt.revision.checked_next().unwrap(),
        id: receipt.package.manifest.id.clone(),
        archive_sha256: receipt.package.archive_sha256.clone(),
    };
    let params = NodePackageIdentityParams {
        id: expected.id.clone(),
        archive_sha256: expected.archive_sha256.clone(),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut lost = installer.store.lose_schema_receipt_once.lock().unwrap();
        assert!(lost.is_none());
        *lost = Some(cancel.clone());
    }
    let worker_installer = installer.clone();
    let worker_cancel = cancel.clone();
    let worker = tokio::task::spawn_blocking(move || {
        let limits = NodePackageLimits {
            timeout: Duration::from_secs(5),
            ..NodePackageLimits::default()
        };
        let started = std::time::Instant::now();
        let mut recorded = None;
        // 只在真实SQL成功后丢弃回执并置取消；不是模拟磁盘故障或替换CAS。
        let result = worker_installer.uninstall_authorized(
            &params,
            receipt.revision,
            &limits,
            worker_cancel.as_ref(),
            || Ok(()),
            |receipt| {
                recorded = Some(receipt.clone());
                Ok(())
            },
        );
        (result, recorded, started.elapsed())
    });
    let (result, recorded, elapsed) = tokio::time::timeout(Duration::from_secs(5), worker)
        .await
        .expect("The proved commit and cleanup must finish within the original five seconds")
        .unwrap();
    assert!(
        cancel.load(Ordering::SeqCst),
        "The post-CAS return fault must actually fire"
    );
    assert!(
        installer
            .store
            .lose_schema_receipt_once
            .lock()
            .unwrap()
            .is_none()
    );
    let snapshot = installer.snapshot().unwrap();
    assert_eq!(snapshot.revision, expected.revision);
    assert!(
        snapshot.packages.is_empty(),
        "The actual SQL removal must be committed"
    );
    let cleaned = !code.exists() && !stage.exists() && !quarantine.exists();
    assert!(
        result.is_ok(),
        "A proved synchronous commit must survive the lost return and late cancel: result={result:?} recorded={recorded:?} cleaned={cleaned} revision={} elapsed={elapsed:?}",
        snapshot.revision
    );
    assert_eq!(result.unwrap(), expected);
    assert_eq!(recorded, Some(expected));
    assert!(
        cleaned,
        "Successful completion must physically finish the same object cleanup"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "This case must finish within the original budget"
    );
    assert_eq!(
        fs::read(profile.path().join("private-data")).unwrap(),
        b"must remain"
    );
    eprintln!(
        "node_uninstall_lost_receipt injected_return_only=true real_sql_committed=true late_cancel=true committed_callback=true physical_cleanup_complete=true original_five_second_budget=true"
    );
}

#[cfg(unix)]
#[test]
fn recovery_refuses_a_link_without_touching_its_external_target() {
    let prepared = Prepared::new();
    let outside = prepared.profile.path().join("external");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel"), b"outside original").unwrap();
    std::os::unix::fs::symlink(&outside, prepared.removal().join("code/foreign")).unwrap();
    prepared.commit_empty(0);
    assert_eq!(
        prepared.recover().unwrap_err().code,
        "NODE_UNINSTALL_RECOVERY_REQUIRED"
    );
    assert_eq!(
        fs::read(outside.join("sentinel")).unwrap(),
        b"outside original"
    );
    assert!(prepared.removal().join(JOURNAL).exists());
    assert_eq!(prepared.installer.snapshot().unwrap().revision, 1.into());
}
