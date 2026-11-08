use serial_workbench_core::*;
use serial_workbench_host::capture::{
    format::CaptureSource,
    recovery::recover_directory,
    verify::verify_directory,
    writer::{CaptureLimits, CaptureWriter},
};
#[test]
fn recovery_checks_source_change_and_never_clobbers() {
    let d = tempfile::tempdir().unwrap();
    let source = d.path().canonicalize().unwrap().join("source");
    let target = d.path().canonicalize().unwrap().join("target");
    CaptureWriter::create(
        &source,
        Vec::<CaptureSource>::new(),
        CaptureLimits::default(),
    )
    .unwrap()
    .finish()
    .unwrap();
    let scan = verify_directory(&source).unwrap();
    let before = std::fs::read(source.join("manifest.json")).unwrap();
    recover_directory(&source, &target, &scan.report).unwrap();
    assert_eq!(std::fs::read(source.join("manifest.json")).unwrap(), before);
    assert_eq!(
        verify_directory(&target).unwrap().summary.state,
        CaptureState::Incomplete
    );
    assert_eq!(
        recover_directory(&source, &target, &scan.report)
            .unwrap_err()
            .code,
        "TARGET_EXISTS"
    );
    std::fs::write(source.join("index.json"), b"{}").unwrap();
    assert_eq!(
        recover_directory(
            &source,
            &d.path().canonicalize().unwrap().join("changed"),
            &scan.report
        )
        .unwrap_err()
        .code,
        "SOURCE_CHANGED"
    );
}
#[tokio::test]
async fn file_registration_scopes_reference_and_detects_changed_bytes() {
    use serial_workbench_host::{auth::AuthService, files::FileService, storage::Store};
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("input.bin");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    let store = Store::open(d.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let secret = ContextToken::try_from("secret").unwrap();
    let auth = AuthService::new(store.clone(), secret.clone());
    let user = auth
        .authenticate_user_control(&Id::try_from("operator").unwrap(), &secret)
        .unwrap();
    let actor = auth
        .authenticate(&Id::try_from("client").unwrap(), None)
        .unwrap()
        .actor;
    let files = FileService::new(store.clone(), auth.clone(), identity.clone());
    let params = RegisterFileParams {
        path: path.to_string_lossy().into_owned(),
        purpose: FilePurpose::ReadFile,
    };
    assert_eq!(
        files.register(params.clone(), &actor).unwrap_err().code,
        "PERMISSION_DENIED"
    );
    let mut forged = serde_json::to_value(&params).unwrap();
    forged["clientId"] = "forged-client".into();
    assert!(serde_json::from_value::<RegisterFileParams>(forged).is_err());
    let reference = files.register(params, &user).unwrap();
    let audit = store
        .read_document(&Id::try_from(format!("ref:{}", reference.id).as_str()).unwrap())
        .unwrap()
        .unwrap();
    let audit = serde_json::to_value(audit.value).unwrap();
    assert_eq!(audit["bindings"][0]["clientId"], user.client_id().as_str());
    assert_eq!(
        files.open_fixed(&reference, &actor).err().unwrap().code,
        "PERMISSION_DENIED"
    );
    auth.authorize(
        &user,
        AuthorizeParams {
            client_id: actor.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![Target {
                host_id: identity.host_id,
                kind: reference.kind.clone(),
                id: reference.id.clone(),
                session_id: None,
                session_epoch: None,
            }],
            expires_at: None,
        },
    )
    .unwrap();
    let mut file = files.open_fixed(&reference, &actor).unwrap();
    assert_eq!(file.read_chunk(0, 2).unwrap(), vec![1, 2]);
    std::fs::write(path, [1, 9, 3]).unwrap();
    assert_eq!(file.read_chunk(2, 1).unwrap_err().code, "SOURCE_CHANGED");
}
#[tokio::test]
async fn registration_rejects_parent_traversal_without_touching_target() {
    use serial_workbench_host::{auth::AuthService, files::FileService, storage::Store};
    let d = tempfile::tempdir().unwrap();
    let nested = d.path().canonicalize().unwrap().join("nested");
    std::fs::create_dir(&nested).unwrap();
    let store = Store::open(d.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let secret = ContextToken::try_from("secret").unwrap();
    let auth = AuthService::new(store.clone(), secret.clone());
    let user = auth
        .authenticate_user_control(&Id::try_from("operator").unwrap(), &secret)
        .unwrap();
    let files = FileService::new(store, auth, identity);
    // Joining a verbatim Windows PathBuf normalizes `..` before registration.
    let target = format!(
        "{}{}..{}capture",
        nested.display(),
        std::path::MAIN_SEPARATOR,
        std::path::MAIN_SEPARATOR
    );
    assert!(
        std::path::Path::new(&target)
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    );
    assert_eq!(
        files
            .register(
                RegisterFileParams {
                    path: target,
                    purpose: FilePurpose::CaptureTarget
                },
                &user
            )
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert!(!d.path().canonicalize().unwrap().join("capture").exists());
}

#[test]
fn simultaneous_publications_never_overwrite_the_winner() {
    use serial_workbench_host::capture::format::rename_no_replace;
    let d = tempfile::tempdir().unwrap();
    let a = d.path().canonicalize().unwrap().join("a");
    let b = d.path().canonicalize().unwrap().join("b");
    let target = d.path().canonicalize().unwrap().join("target");
    std::fs::create_dir(&a).unwrap();
    std::fs::create_dir(&b).unwrap();
    std::fs::write(a.join("marker"), b"a").unwrap();
    std::fs::write(b.join("marker"), b"b").unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let (left, right) = std::thread::scope(|scope| {
        let x = barrier.clone();
        let a = &a;
        let target = &target;
        let left = scope.spawn(move || {
            x.wait();
            rename_no_replace(a, target)
        });
        let x = barrier.clone();
        let b = &b;
        let right = scope.spawn(move || {
            x.wait();
            rename_no_replace(b, target)
        });
        barrier.wait();
        (left.join().unwrap(), right.join().unwrap())
    });
    assert_ne!(left.is_ok(), right.is_ok());
    let failure = left.err().or_else(|| right.err()).unwrap();
    assert_eq!(failure.code, "TARGET_EXISTS");
    let winner = std::fs::read(target.join("marker")).unwrap();
    assert!(winner == b"a" || winner == b"b");
    let loser = if winner == b"a" { &b } else { &a };
    assert!(loser.join("marker").exists());
}

#[tokio::test]
async fn bounded_file_read_respects_offsets_and_rechecks_permission() {
    use base64::Engine as _;
    use serial_workbench_host::{auth::AuthService, files::FileService, storage::Store};
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("bounded.bin");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    let store = Store::open(d.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let secret = ContextToken::try_from("secret").unwrap();
    let auth = AuthService::new(store.clone(), secret.clone());
    let user = auth
        .authenticate_user_control(&Id::try_from("operator").unwrap(), &secret)
        .unwrap();
    let actor = auth
        .authenticate(&Id::try_from("reader").unwrap(), None)
        .unwrap()
        .actor;
    let files = FileService::new(store, auth.clone(), identity.clone());
    let reference = files
        .register(
            RegisterFileParams {
                path: path.to_string_lossy().into_owned(),
                purpose: FilePurpose::ReadFile,
            },
            &user,
        )
        .unwrap();
    let target = Target {
        host_id: identity.host_id,
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &user,
        AuthorizeParams {
            client_id: actor.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let params = FileReadParams {
        file_ref: reference.clone(),
        offset: 1.into(),
        max_bytes: 2.into(),
    };
    let read = files.read(params.clone(), &actor).unwrap();
    assert_eq!(read.offset, U64::from(1));
    assert_eq!(read.next_offset, U64::from(3));
    assert!(read.at_end);
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(read.bytes_base64.as_str())
            .unwrap(),
        vec![2, 3]
    );
    assert_eq!(
        files
            .read(
                FileReadParams {
                    max_bytes: 65537.into(),
                    ..params.clone()
                },
                &actor
            )
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    auth.revoke(
        &user,
        RevokeParams {
            actor_id: actor.id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![target],
        },
    )
    .unwrap();
    assert_eq!(
        files.read(params, &actor).unwrap_err().code,
        "PERMISSION_DENIED"
    );
}

#[tokio::test]
async fn receipt_pages_are_bounded_shared_and_keep_historical_evidence() {
    use serial_workbench_host::{auth::AuthService, files::FileService, storage::Store};
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("receipt-source.bin");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    let store = Store::open(d.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let secret = ContextToken::try_from("secret").unwrap();
    let auth = AuthService::new(store.clone(), secret.clone());
    let user = auth
        .authenticate_user_control(&Id::try_from("operator").unwrap(), &secret)
        .unwrap();
    let reader = auth
        .authenticate(&Id::try_from("reader").unwrap(), None)
        .unwrap()
        .actor;
    let files = FileService::new(store.clone(), auth.clone(), identity.clone());
    let source_ref = files
        .register(
            RegisterFileParams {
                path: path.to_string_lossy().into_owned(),
                purpose: FilePurpose::ReadFile,
            },
            &user,
        )
        .unwrap();
    let authority = Target {
        host_id: identity.host_id.clone(),
        kind: source_ref.kind.clone(),
        id: source_ref.id.clone(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &user,
        AuthorizeParams {
            client_id: reader.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![authority.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let operation_id = Id::try_from("receipt-owner").unwrap();
    let manifest = serde_json::from_value(serde_json::json!({"formatVersion":"0.1","sourceRef":source_ref,"authority":authority,"count":"3","sealed":true})).unwrap();
    store
        .compare_and_swap_document(
            &Id::try_from("transfer-receipts-receipt-owner").unwrap(),
            0.into(),
            manifest,
        )
        .unwrap();
    let mut expected = Vec::new();
    for ordinal in 0..3u64 {
        let receipt: FileTransferReceipt = serde_json::from_value(serde_json::json!({"sourceOffset":ordinal.to_string(),"receipt":{"operationId":format!("chunk-{ordinal}"),"sessionId":"s","sessionEpoch":"1","outcome":"accepted","bytesBase64":"AQ==","byteStart":ordinal.to_string(),"byteEnd":(ordinal+1).to_string(),"acceptedRanges":[{"start":ordinal.to_string(),"end":(ordinal+1).to_string()}],"unknownRanges":[],"peerAcknowledged":false}})).unwrap();
        let value = serde_json::from_value(serde_json::to_value(&receipt).unwrap()).unwrap();
        store
            .compare_and_swap_document(
                &Id::try_from(format!("transfer-receipts-receipt-owner-{ordinal}").as_str())
                    .unwrap(),
                0.into(),
                value,
            )
            .unwrap();
        expected.push(receipt);
    }
    let reference = ObjectRef {
        host_id: identity.host_id,
        kind: ResourceKind::try_from("transfer_receipts").unwrap(),
        id: operation_id,
        revision: Some(1.into()),
    };
    files.authorize_receipts(&reference, &reader).unwrap();
    // Receipts describe past effects; changing the original file cannot erase them.
    std::fs::write(&path, [9, 9, 9]).unwrap();
    let params = FileTransferReceiptsParams {
        receipts_ref: reference.clone(),
        start_ordinal: 0.into(),
        max_receipts: 1.into(),
        max_bytes: 1024.into(),
    };
    let page = files.read_receipts(params.clone(), &reader).unwrap();
    assert_eq!(page.receipts, expected[..1]);
    assert_eq!(page.count, U64::from(3));
    assert_eq!(page.next_ordinal, U64::from(1));
    assert_eq!(page.receipts_ref, reference);
    assert!(page.has_more && page.sealed);
    assert!(serde_json::to_vec(&page).unwrap().len() <= 1024);
    let tail = files
        .read_receipts(
            FileTransferReceiptsParams {
                start_ordinal: 3.into(),
                ..params.clone()
            },
            &reader,
        )
        .unwrap();
    assert!(tail.receipts.is_empty() && !tail.has_more);
    assert_eq!(
        files
            .read_receipts(
                FileTransferReceiptsParams {
                    max_bytes: 1.into(),
                    ..params.clone()
                },
                &reader
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    auth.revoke(
        &user,
        RevokeParams {
            actor_id: reader.id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![authority],
        },
    )
    .unwrap();
    assert_eq!(
        files.read_receipts(params, &reader).unwrap_err().code,
        "PERMISSION_DENIED"
    );
}

#[tokio::test]
async fn sequential_ranges_reuse_bounded_proofs_and_still_validate_source_and_authority() {
    use base64::Engine as _;
    use serial_workbench_host::{auth::AuthService, files::FileService, storage::Store};
    use std::io::{Seek, SeekFrom, Write};
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("media.bin");
    let bytes: Vec<u8> = (0..512 * 1024).map(|n| (n % 251) as u8).collect();
    std::fs::write(&path, &bytes).unwrap();
    let store = Store::open(d.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let secret = ContextToken::try_from("secret").unwrap();
    let auth = AuthService::new(store.clone(), secret.clone());
    let user = auth
        .authenticate_user_control(&Id::try_from("operator").unwrap(), &secret)
        .unwrap();
    let actor = auth
        .authenticate(&Id::try_from("media-reader").unwrap(), None)
        .unwrap()
        .actor;
    let files = FileService::new(store, auth.clone(), identity.clone());
    let reference = files
        .register(
            RegisterFileParams {
                path: path.to_string_lossy().into_owned(),
                purpose: FilePurpose::ReadFile,
            },
            &user,
        )
        .unwrap();
    let target = Target {
        host_id: identity.host_id,
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let grant = AuthorizeParams {
        client_id: actor.client_id().clone(),
        permissions: vec!["content.read".into()],
        targets: vec![target.clone()],
        expires_at: None,
    };
    auth.authorize(&user, grant.clone()).unwrap();
    let before = files.file_read_bytes();
    for offset in (0..bytes.len()).step_by(65536) {
        let page = files
            .clone()
            .read(
                FileReadParams {
                    file_ref: reference.clone(),
                    offset: (offset as u64).into(),
                    max_bytes: 65536.into(),
                },
                &actor,
            )
            .unwrap();
        let actual = base64::engine::general_purpose::STANDARD
            .decode(page.bytes_base64.as_str())
            .unwrap();
        assert_eq!(actual, bytes[offset..offset + 65536]);
        assert_eq!(page.file_ref, reference);
    }
    let io_bytes = files.file_read_bytes() - before;
    let first = FileReadParams {
        file_ref: reference.clone(),
        offset: 0.into(),
        max_bytes: 1.into(),
    };
    auth.revoke(
        &user,
        RevokeParams {
            actor_id: actor.id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![target],
        },
    )
    .unwrap();
    assert_eq!(
        files.read(first.clone(), &actor).unwrap_err().code,
        "PERMISSION_DENIED"
    );
    auth.authorize(&user, grant).unwrap();
    let mut stale = first.clone();
    stale.file_ref.revision = Some(2.into());
    assert_eq!(
        files.read(stale, &actor).unwrap_err().code,
        "REVISION_CONFLICT"
    );
    // A write outside this range must invalidate the old revision too.
    let mut changed = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    changed.seek(SeekFrom::End(-1)).unwrap();
    changed.write_all(&[255]).unwrap();
    changed
        .set_times(
            std::fs::FileTimes::new().set_modified(
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(2_000_000_000),
            ),
        )
        .unwrap();
    changed.sync_all().unwrap();
    drop(changed);
    assert_eq!(
        files.read(first, &actor).unwrap_err().code,
        "SOURCE_CHANGED"
    );
    assert!(
        io_bytes <= bytes.len() as u64 * 2,
        "one initial proof plus requested bytes must suffice; read {io_bytes} bytes for {} bytes",
        bytes.len()
    );
}
