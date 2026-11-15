mod support;
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use serial_workbench_core::{Id, NODE_PACKAGE_SIGNATURE_PREFIX};
use serial_workbench_host::node_packages::{
    NodePackageInstaller, NodePackageLimits, NodePackageSource, NodePackageSources,
    verify_node_package,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Cursor, Write},
    sync::atomic::AtomicBool,
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn manifest() -> Value {
    json!({
        "schemaVersion":"0.1","id":"example.terminal","version":"1.0.0",
        "displayName":"离线终端","description":"参考包","license":"MIT",
        "notices":["许可证/LICENSE.txt"],"hostProtocolVersion":"0.1",
        "runtimeRef":"node-26.13.0","main":"dist/main.mjs","webUi":{"entry":"界面/index.html"},
        "dependencies":[],"platformResources":[],"activation":["startup"],
        "permissions":{"hostApi":[],"executionPurposes":["terminal"],"externalTools":[]},
        "contributes":{"actions":[],"queries":[],"transports":[],"parsers":[],"views":[],"themes":[],"configuration":[]},
        "dataSchemaVersion":"1"
    })
}

fn payloads() -> BTreeMap<String, Vec<u8>> {
    BTreeMap::from([
        (
            "manifest.json".into(),
            serde_json::to_vec(&manifest()).unwrap(),
        ),
        (
            "dist/main.mjs".into(),
            b"throw new Error('installation must not execute this');".to_vec(),
        ),
        (
            "界面/index.html".into(),
            b"<!doctype html><title>Terminal</title>".to_vec(),
        ),
        ("许可证/LICENSE.txt".into(), b"MIT".to_vec()),
    ])
}

fn with_metadata(mut files: BTreeMap<String, Vec<u8>>, signed: bool) -> BTreeMap<String, Vec<u8>> {
    let manifest: Value = serde_json::from_slice(&files["manifest.json"]).unwrap();
    let integrity = json!({
        "schemaVersion":"0.1","id":manifest["id"],"version":manifest["version"],
        "source":if signed {"test-source"} else {"local"},
        "keyId":if signed {"test-key"} else {"local-unverified"},
        "files": files.iter().map(|(path, bytes)| json!({
            "path":path,"size":bytes.len().to_string(),"sha256":format!("{:x}", Sha256::digest(bytes))
        })).collect::<Vec<_>>()
    });
    let raw = serde_json::to_vec_pretty(&integrity).unwrap();
    if signed {
        // 固定测试种子只用于临时 fixture，不是发布密钥。
        let key = SigningKey::from_bytes(&[7; 32]);
        let message = [NODE_PACKAGE_SIGNATURE_PREFIX, &raw].concat();
        let signature = json!({
            "algorithm":"Ed25519","keyId":"test-key",
            "signatureBase64":STANDARD.encode(key.sign(&message).to_bytes())
        });
        files.insert(
            "signature.json".into(),
            serde_json::to_vec(&signature).unwrap(),
        );
    }
    files.insert("integrity.json".into(), raw);
    files
}

fn archive(files: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        zip.start_file(
            name,
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn verify_local(
    files: &BTreeMap<String, Vec<u8>>,
) -> serial_workbench_core::HostResult<serial_workbench_host::node_packages::VerifiedNodePackage> {
    verify_node_package(
        archive(files),
        NodePackageSource::Local,
        &NodePackageLimits::default(),
        &AtomicBool::new(false),
    )
}

fn verified_manifest(
    manifest: Value,
    signing_seed: Option<u8>,
) -> serial_workbench_host::node_packages::VerifiedNodePackage {
    let mut files = payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&manifest).unwrap(),
    );
    let mut files = with_metadata(files, signing_seed.is_some());
    if let Some(seed) = signing_seed {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let message = [
            NODE_PACKAGE_SIGNATURE_PREFIX,
            files["integrity.json"].as_slice(),
        ]
        .concat();
        files.insert(
            "signature.json".into(),
            serde_json::to_vec(&json!({
                "algorithm":"Ed25519", "keyId":"test-key",
                "signatureBase64":STANDARD.encode(key.sign(&message).to_bytes()),
            }))
            .unwrap(),
        );
        verify_node_package(
            archive(&files),
            NodePackageSource::Trusted {
                source: &"test-source".try_into().unwrap(),
                key_id: &"test-key".try_into().unwrap(),
                public_key: &key.verifying_key().to_bytes(),
            },
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
    } else {
        verify_local(&files).unwrap()
    }
}

#[test]
fn verifies_unicode_offline_package_without_executing_main() {
    let bytes = archive(&with_metadata(payloads(), false));
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let verified = verify_node_package(
        bytes,
        NodePackageSource::Local,
        &NodePackageLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(verified.manifest().id.as_str(), "example.terminal");
    assert_eq!(verified.archive_sha256().as_str(), hash);
    assert!(!verified.is_source_verified());
    assert_eq!(verified.integrity().files.len(), 4);
}

#[test]
fn installs_verified_offline_bytes_disabled_without_executing_code_or_hooks() {
    let profile = support::Profile::isolated("node-install-");
    let profile_root = std::fs::canonicalize(profile.path()).unwrap();
    let marker = profile_root.join("must-not-execute.txt");
    let script = format!(
        "import {{writeFileSync}} from 'node:fs'; writeFileSync({}, 'executed');",
        serde_json::to_string(&marker).unwrap()
    );
    let mut files = payloads();
    files.insert("dist/main.mjs".into(), script.as_bytes().to_vec());
    files.insert(
        "package.json".into(),
        serde_json::to_vec(&json!({"scripts":{"postinstall":"node dist/main.mjs"}})).unwrap(),
    );
    let package = verify_local(&with_metadata(files.clone(), false)).unwrap();
    let archive_digest = package.archive_sha256().clone();
    let store = serial_workbench_host::storage::Store::open(&profile_root).unwrap();
    let installer = NodePackageInstaller::new(store.clone(), &profile_root).unwrap();
    let before = installer.snapshot().unwrap();
    assert_eq!(before.revision, 0.into());
    assert!(before.packages.is_empty());
    let installed = installer
        .install(
            package,
            before.revision,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(installed.revision, 1.into());
    assert_eq!(installed.package.manifest.id.as_str(), "example.terminal");
    assert_eq!(installed.package.archive_sha256, archive_digest);
    assert!(!installed.package.enabled);
    assert!(installed.package.execution_trust.is_none());
    assert!(installed.package.verified_source.is_none());
    for (path, bytes) in files {
        assert_eq!(
            std::fs::read(installed.code_directory().join(path)).unwrap(),
            bytes
        );
    }
    assert!(!marker.exists());
    drop(installer);
    let reopened = NodePackageInstaller::new(store, &profile_root).unwrap();
    let snapshot = reopened.snapshot().unwrap();
    assert_eq!(snapshot.revision, installed.revision);
    assert_eq!(snapshot.packages, [installed.package]);
}

#[test]
fn enabling_requires_explicit_trust_bound_to_the_current_archive_and_revision() {
    let profile = support::Profile::isolated("node-trust-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let installer = NodePackageInstaller::new(store, &root).unwrap();
    let installed = installer
        .install(
            verify_local(&with_metadata(payloads(), false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = &installed.package.manifest.id;
    let digest = &installed.package.archive_sha256;
    assert_eq!(
        installer
            .set_enabled(id, true, installed.revision, digest)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(installer.snapshot().unwrap().revision, installed.revision);
    let trusted = installer
        .confirm_execution_trust(id, installed.revision, digest)
        .unwrap();
    assert!(!trusted.packages[0].enabled);
    let confirmation = trusted.packages[0].execution_trust.as_ref().unwrap();
    assert_eq!(&confirmation.archive_sha256, digest);
    assert_eq!(
        confirmation.permissions,
        installed.package.manifest.permissions
    );
    assert!(confirmation.verified_source.is_none());
    let enabled = installer
        .set_enabled(id, true, trusted.revision, digest)
        .unwrap();
    assert!(enabled.packages[0].enabled);
    assert_eq!(
        installer
            .set_enabled(id, false, trusted.revision, digest)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    let stale_digest = "0".repeat(64).as_str().try_into().unwrap();
    assert_eq!(
        installer
            .confirm_execution_trust(id, enabled.revision, &stale_digest)
            .unwrap_err()
            .code,
        "INTEGRITY_FAILED"
    );
    assert_eq!(installer.snapshot().unwrap(), enabled);
    let disabled = installer
        .set_enabled(id, false, enabled.revision, digest)
        .unwrap();
    assert!(!disabled.packages[0].enabled);
    assert_eq!(
        disabled.packages[0].execution_trust,
        enabled.packages[0].execution_trust
    );
}

#[test]
fn compatible_signed_upgrade_inherits_trust_and_keeps_the_previous_code() {
    let profile = support::Profile::isolated("node-upgrade-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let installer = NodePackageInstaller::new(store, &root).unwrap();
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let verified = |version: &str| {
        let mut files = payloads();
        let mut manifest = manifest();
        manifest["version"] = json!(version);
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        verify_node_package(
            archive(&with_metadata(files, true)),
            NodePackageSource::Trusted {
                source: &source,
                key_id: &key_id,
                public_key: &key,
            },
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
    };
    let first = installer
        .install(
            verified("1.0.0"),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = &first.package.manifest.id;
    let trusted = installer
        .confirm_execution_trust(id, first.revision, &first.package.archive_sha256)
        .unwrap();
    let enabled = installer
        .set_enabled(id, true, trusted.revision, &first.package.archive_sha256)
        .unwrap();
    let upgraded = installer
        .install(
            verified("1.1.0"),
            enabled.revision,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(upgraded.package.manifest.version.as_str(), "1.1.0");
    assert!(upgraded.package.enabled);
    let inherited = upgraded.package.execution_trust.as_ref().unwrap();
    assert_eq!(inherited.archive_sha256, upgraded.package.archive_sha256);
    assert_eq!(inherited.verified_source, first.package.verified_source);
    assert_ne!(first.code_directory(), upgraded.code_directory());
    assert_eq!(
        std::fs::read(first.code_directory().join("dist/main.mjs")).unwrap(),
        payloads()["dist/main.mjs"]
    );
    assert_eq!(installer.snapshot().unwrap().packages, [upgraded.package]);
}

#[test]
fn upgrade_can_narrow_declared_scopes_but_expansion_needs_new_confirmation() {
    let profile = support::Profile::isolated("node-scopes-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let mut first_manifest = manifest();
    first_manifest["permissions"]["hostApi"] = json!([
        {"permissions":["content.read","device.modify"],"targetKinds":["session","device"]}
    ]);
    first_manifest["permissions"]["executionPurposes"] = json!(["terminal", "automation"]);
    let first = installer
        .install(
            verified_manifest(first_manifest.clone(), Some(7)),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = &first.package.manifest.id;
    let trusted = installer
        .confirm_execution_trust(id, first.revision, &first.package.archive_sha256)
        .unwrap();
    let enabled = installer
        .set_enabled(id, true, trusted.revision, &first.package.archive_sha256)
        .unwrap();
    let mut narrower = first_manifest;
    narrower["version"] = json!("1.1.0");
    narrower["permissions"]["hostApi"] = json!([
        {"permissions":["device.modify"],"targetKinds":["session"]},
        {"permissions":["content.read"],"targetKinds":["device"]}
    ]);
    narrower["permissions"]["executionPurposes"] = json!(["terminal"]);
    let upgraded = installer
        .install(
            verified_manifest(narrower.clone(), Some(7)),
            enabled.revision,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(upgraded.package.enabled);
    assert_eq!(
        upgraded
            .package
            .execution_trust
            .as_ref()
            .unwrap()
            .permissions,
        upgraded.package.manifest.permissions
    );
    narrower["version"] = json!("1.2.0");
    narrower["permissions"]["hostApi"][0]["permissions"] =
        json!(["device.modify", "settings.modify"]);
    let expanded = installer
        .install(
            verified_manifest(narrower, Some(7)),
            upgraded.revision,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(!expanded.package.enabled);
    assert!(expanded.package.execution_trust.is_none());
}

#[test]
fn revoking_execution_trust_disables_the_package_and_survives_reopen() {
    let profile = support::Profile::isolated("node-revoke-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let installer = NodePackageInstaller::new(store.clone(), &root).unwrap();
    let first = installer
        .install(
            verified_manifest(manifest(), Some(7)),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = &first.package.manifest.id;
    let digest = &first.package.archive_sha256;
    let trusted = installer
        .confirm_execution_trust(id, first.revision, digest)
        .unwrap();
    let enabled = installer
        .set_enabled(id, true, trusted.revision, digest)
        .unwrap();
    let revoked = installer
        .revoke_execution_trust(id, enabled.revision, digest)
        .unwrap();
    assert!(!revoked.packages[0].enabled);
    assert!(revoked.packages[0].execution_trust.is_none());
    assert_eq!(
        revoked.packages[0].verified_source,
        first.package.verified_source
    );
    assert_eq!(
        installer
            .set_enabled(id, true, revoked.revision, digest)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        NodePackageInstaller::new(store, &root)
            .unwrap()
            .snapshot()
            .unwrap(),
        revoked
    );
    assert!(first.code_directory().join("dist/main.mjs").is_file());
}

#[test]
fn changed_key_local_source_or_runtime_cannot_inherit_execution_trust() {
    for (name, seed, runtime) in [
        ("actual-key-change", Some(8), "node-26.13.0"),
        ("unverified-local", None, "node-26.13.0"),
        ("different-runtime", Some(7), "node-other"),
    ] {
        let profile = support::Profile::isolated("node-identity-");
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let first = installer
            .install(
                verified_manifest(manifest(), Some(7)),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let id = &first.package.manifest.id;
        let trusted = installer
            .confirm_execution_trust(id, first.revision, &first.package.archive_sha256)
            .unwrap();
        let enabled = installer
            .set_enabled(id, true, trusted.revision, &first.package.archive_sha256)
            .unwrap();
        let mut next = manifest();
        next["version"] = json!("1.1.0");
        next["runtimeRef"] = json!(runtime);
        let next = installer
            .install(
                verified_manifest(next, seed),
                enabled.revision,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert!(!next.package.enabled, "{name}");
        assert!(next.package.execution_trust.is_none(), "{name}");
        if seed == Some(8) {
            let old = first.package.verified_source.as_ref().unwrap();
            let new = next.package.verified_source.as_ref().unwrap();
            assert_eq!(old.source, new.source);
            assert_eq!(old.key_id, new.key_id);
            assert_ne!(old.public_key_sha256, new.public_key_sha256);
        }
    }
}

#[test]
fn future_installation_format_is_preserved_before_any_staging_write() {
    let profile = support::Profile::isolated("node-future-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let document_id = "node-packages:installed".try_into().unwrap();
    let future = store
        .compare_and_swap_document(
            &document_id,
            0.into(),
            serde_json::from_value(json!({
                "formatVersion":"2", "futureField":{"preserve":"original"}
            }))
            .unwrap(),
        )
        .unwrap();
    let installer = NodePackageInstaller::new(store.clone(), &root).unwrap();
    assert_eq!(installer.snapshot().unwrap_err().code, "FUTURE_FORMAT");
    assert_eq!(
        installer
            .install(
                verified_manifest(manifest(), None),
                future.revision,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(store.read_document(&document_id).unwrap(), Some(future));
    assert!(!root.join("host-v0/node-packages").exists());
}

#[test]
fn failed_staged_upgrade_preserves_installed_bytes_data_and_original_archive() {
    let profile = support::Profile::isolated("node-failed-stage-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let first = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let before = installer.snapshot().unwrap();
    let private_data = root.join("plugin-private-state.bin");
    std::fs::write(&private_data, b"unrelated private state").unwrap();
    let mut next = manifest();
    next["version"] = json!("1.1.0");
    let next = verified_manifest(next, None);
    let original_archive = next.archive_bytes().to_vec();
    let restricted = NodePackageLimits {
        max_file_bytes: 8,
        ..Default::default()
    };
    assert_eq!(
        installer
            .install(next, before.revision, &restricted, &AtomicBool::new(false))
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert_eq!(installer.snapshot().unwrap(), before);
    assert_eq!(
        std::fs::read(first.code_directory().join("dist/main.mjs")).unwrap(),
        payloads()["dist/main.mjs"]
    );
    assert_eq!(
        std::fs::read(private_data).unwrap(),
        b"unrelated private state"
    );
    let failures: Vec<_> = std::fs::read_dir(root.join("host-v0/node-packages/staging"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            let receipt: Value =
                serde_json::from_slice(&std::fs::read(path.join("installation.json")).unwrap())
                    .unwrap();
            receipt["outcome"]["committed"] == false
        })
        .collect();
    assert_eq!(failures.len(), 1);
    assert_eq!(
        std::fs::read(failures[0].join("input.zip")).unwrap(),
        original_archive
    );
}

#[test]
fn installation_rechecks_a_stricter_implicit_path_node_budget() {
    let profile = support::Profile::isolated("node-install-nodes-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    // 五个 ZIP 条目还包含 dist、界面、许可证三个隐式目录，不能仅按条目计数。
    let restricted = NodePackageLimits {
        max_files: 5,
        ..Default::default()
    };
    assert_eq!(
        installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &restricted,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert!(installer.snapshot().unwrap().packages.is_empty());
}

#[test]
fn installation_rechecks_stricter_metadata_bytes_before_commit() {
    let profile = support::Profile::isolated("node-install-metadata-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let restricted = NodePackageLimits {
        max_metadata_bytes: 8,
        ..Default::default()
    };
    assert_eq!(
        installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &restricted,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert!(installer.snapshot().unwrap().packages.is_empty());
}

#[test]
fn revalidates_committed_installed_bytes_without_enabling_or_executing_them() {
    let profile = support::Profile::isolated("node-installed-verify-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let before = installer.snapshot().unwrap();
    let verified = installer
        .verify_installed(
            &installed.package.manifest.id,
            installed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(verified.package(), &installed.package);
    assert_eq!(verified.revision(), installed.revision);
    assert_eq!(verified.code_directory(), installed.code_directory());
    assert!(!verified.package().enabled);
    assert!(verified.package().execution_trust.is_none());
    assert_eq!(installer.snapshot().unwrap(), before);
}

#[test]
fn installed_verification_rejects_a_hard_link_even_when_bytes_still_match() {
    let profile = support::Profile::isolated("node-installed-hardlink-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let shared = root.join("outside-code-object.mjs");
    std::fs::hard_link(installed.code_directory().join("dist/main.mjs"), &shared).unwrap();
    let error = installer
        .verify_installed(
            &installed.package.manifest.id,
            installed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert_eq!(error.code, "INTEGRITY_FAILED");
    assert_eq!(std::fs::read(shared).unwrap(), payloads()["dist/main.mjs"]);
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("node-installed-hardlink-")
    );
}

#[test]
fn installed_verification_requires_the_unchanged_unlinked_original_archive() {
    for fault in ["changed", "missing", "hardlink"] {
        let profile = support::Profile::isolated(&format!("node-installed-archive-{fault}-"));
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let installed = installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let input = root
            .join("host-v0/node-packages/staging")
            .join(installed.code_directory().file_name().unwrap())
            .join("input.zip");
        let original = root.join("original-archive.zip");
        match fault {
            "changed" => {
                std::fs::copy(&input, &original).unwrap();
                std::fs::write(&input, b"different archive bytes").unwrap();
            }
            "missing" => std::fs::rename(&input, &original).unwrap(),
            "hardlink" => std::fs::hard_link(&input, &original).unwrap(),
            _ => unreachable!(),
        }
        let before = installer.snapshot().unwrap();
        let error = installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, "INTEGRITY_FAILED", "{fault}");
        assert_eq!(installer.snapshot().unwrap(), before);
        assert!(original.is_file());
    }
}

#[test]
fn installed_verification_rejects_changed_missing_and_unlisted_code() {
    for fault in [
        "payload",
        "metadata",
        "missing-file",
        "missing-directory",
        "extra-file",
        "extra-directory",
    ] {
        let profile = support::Profile::isolated(&format!("node-installed-code-{fault}-"));
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let installed = installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let code = installed.code_directory();
        match fault {
            "payload" | "metadata" => {
                let path = code.join(if fault == "payload" {
                    "dist/main.mjs"
                } else {
                    "integrity.json"
                });
                let mut bytes = std::fs::read(&path).unwrap();
                if fault == "payload" {
                    bytes[0] ^= 1;
                } else {
                    *bytes.iter_mut().find(|byte| **byte == b' ').unwrap() = b'\t';
                }
                #[cfg(unix)]
                let previous = {
                    use std::os::unix::fs::PermissionsExt;
                    let previous = std::fs::metadata(&path).unwrap().permissions();
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                    previous
                };
                std::fs::write(&path, bytes).unwrap();
                #[cfg(unix)]
                std::fs::set_permissions(path, previous).unwrap();
            }
            "missing-file" => {
                std::fs::rename(code.join("dist/main.mjs"), root.join("retained-main.mjs")).unwrap()
            }
            "missing-directory" => {
                std::fs::rename(code.join("界面"), root.join("retained-ui")).unwrap()
            }
            "extra-file" => {
                std::fs::write(code.join("unlisted.mjs"), b"throw new Error('unlisted');").unwrap()
            }
            "extra-directory" => std::fs::create_dir(code.join("unlisted-directory")).unwrap(),
            _ => unreachable!(),
        }
        let before = installer.snapshot().unwrap();
        let error = installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, "INTEGRITY_FAILED", "{fault}");
        if matches!(fault, "payload" | "metadata") {
            assert_eq!(
                serde_json::to_value(&error).unwrap()["details"]["reason"],
                "installedFileDigest"
            );
        }
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("node-installed-code-")
        );
        assert_eq!(installer.snapshot().unwrap(), before);
    }
}

#[test]
fn installed_verification_rechecks_current_source_after_historical_installation() {
    let profile = support::Profile::isolated("node-installed-source-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let approval = sources
        .approve_key(
            source.clone(),
            key_id.clone(),
            SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes(),
            0.into(),
        )
        .unwrap();
    let installer = NodePackageInstaller::new(store, &root).unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), Some(7)),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let proof = installer
        .verify_installed(
            &installed.package.manifest.id,
            installed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        proof.package().verified_source,
        installed.package.verified_source
    );
    drop(proof);
    let before = installer.snapshot().unwrap();
    sources
        .revoke_key(&source, &key_id, approval.revision)
        .unwrap();
    assert_eq!(
        installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(installer.snapshot().unwrap(), before);
}

#[test]
fn installed_verification_rejects_a_manifest_record_that_disagrees_with_the_archive() {
    let profile = support::Profile::isolated("node-installed-record-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let installer = NodePackageInstaller::new(store.clone(), &root).unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let document_id = "node-packages:installed".try_into().unwrap();
    let mut value =
        serde_json::to_value(store.read_document(&document_id).unwrap().unwrap().value).unwrap();
    value["packages"]["example.terminal"]["manifest"]["description"] =
        json!("changed persisted description");
    let changed = store
        .compare_and_swap_document(
            &document_id,
            installed.revision,
            serde_json::from_value(value).unwrap(),
        )
        .unwrap();
    let error = installer
        .verify_installed(
            &installed.package.manifest.id,
            changed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap_err();
    assert_eq!(error.code, "INTEGRITY_FAILED");
    assert_eq!(
        serde_json::to_value(error).unwrap()["details"]["reason"],
        "installedRecordMismatch"
    );
    assert_eq!(store.read_document(&document_id).unwrap(), Some(changed));
}

#[test]
fn installed_verification_preserves_cancellation_budgets_and_expected_identity() {
    let profile = support::Profile::isolated("node-installed-control-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let before = installer.snapshot().unwrap();
    let id = &installed.package.manifest.id;
    let hash = &installed.package.archive_sha256;
    assert_eq!(
        installer
            .verify_installed(
                id,
                installed.revision,
                hash,
                &NodePackageLimits::default(),
                &AtomicBool::new(true)
            )
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    let expired = NodePackageLimits {
        timeout: std::time::Duration::ZERO,
        ..Default::default()
    };
    assert_eq!(
        installer
            .verify_installed(
                id,
                installed.revision,
                hash,
                &expired,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    let restricted = NodePackageLimits {
        max_archive_bytes: 8,
        ..Default::default()
    };
    assert_eq!(
        installer
            .verify_installed(
                id,
                installed.revision,
                hash,
                &restricted,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert_eq!(
        installer
            .verify_installed(
                id,
                0.into(),
                hash,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    let changed = "0".repeat(64).as_str().try_into().unwrap();
    assert_eq!(
        installer
            .verify_installed(
                id,
                installed.revision,
                &changed,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "INTEGRITY_FAILED"
    );
    assert_eq!(
        installer
            .verify_installed(
                &"example.missing".try_into().unwrap(),
                installed.revision,
                hash,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    assert_eq!(installer.snapshot().unwrap(), before);
}

#[cfg(windows)]
#[test]
fn installed_proof_pins_files_and_directories_until_the_owner_is_dropped() {
    let profile = support::Profile::isolated("node-installed-owner-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(
        serial_workbench_host::storage::Store::open(&root).unwrap(),
        &root,
    )
    .unwrap();
    let installed = installer
        .install(
            verified_manifest(manifest(), None),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let proof = installer
        .verify_installed(
            &installed.package.manifest.id,
            installed.revision,
            &installed.package.archive_sha256,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let file = installed.code_directory().join("dist/main.mjs");
    assert!(std::fs::OpenOptions::new().write(true).open(&file).is_err());
    assert!(std::fs::rename(&file, root.join("held-file.mjs")).is_err());
    let directory = installed.code_directory().join("dist");
    let moved = root.join("held-directory");
    assert!(std::fs::rename(&directory, &moved).is_err());
    drop(proof);
    assert!(std::fs::OpenOptions::new().write(true).open(&file).is_ok());
    std::fs::rename(&directory, &moved).unwrap();
    std::fs::rename(&moved, &directory).unwrap();
}

#[cfg(windows)]
#[test]
fn installed_verification_rejects_junction_directories_and_object_roots() {
    use std::os::windows::process::CommandExt;
    for fault in ["directory", "object-root"] {
        let profile = support::Profile::isolated(&format!("node-installed-junction-{fault}-"));
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let installed = installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let selected = if fault == "directory" {
            installed.code_directory().join("dist")
        } else {
            installed.code_directory().to_path_buf()
        };
        let original = root.join("retained-original");
        assert!(selected.starts_with(&root) && original.starts_with(&root));
        std::fs::rename(&selected, &original).unwrap();
        let output = std::process::Command::new("powershell.exe").creation_flags(0x08000000).args([
            "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
            "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:SWB_TEST_JUNCTION -Target $env:SWB_TEST_TARGET | Out-Null",
        ]).env("SWB_TEST_JUNCTION", &selected).env("SWB_TEST_TARGET", &original).output().unwrap();
        assert!(
            output.status.success(),
            "cannot create controlled junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let error = installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap_err();
        assert_eq!(error.code, "INTEGRITY_FAILED", "{fault}");
        let payload = if fault == "directory" {
            original.join("main.mjs")
        } else {
            original.join("dist/main.mjs")
        };
        assert_eq!(std::fs::read(payload).unwrap(), payloads()["dist/main.mjs"]);
        std::fs::remove_dir(&selected).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn installed_verification_rejects_symbolic_files_directories_and_object_roots() {
    for fault in ["file", "directory", "object-root"] {
        let profile = support::Profile::isolated(&format!("node-installed-symlink-{fault}-"));
        let root = std::fs::canonicalize(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(
            serial_workbench_host::storage::Store::open(&root).unwrap(),
            &root,
        )
        .unwrap();
        let installed = installer
            .install(
                verified_manifest(manifest(), None),
                0.into(),
                &NodePackageLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap();
        let selected = match fault {
            "file" => installed.code_directory().join("dist/main.mjs"),
            "directory" => installed.code_directory().join("dist"),
            _ => installed.code_directory().to_path_buf(),
        };
        let original = root.join("retained-original");
        std::fs::rename(&selected, &original).unwrap();
        std::os::unix::fs::symlink(&original, &selected).unwrap();
        assert_eq!(
            installer
                .verify_installed(
                    &installed.package.manifest.id,
                    installed.revision,
                    &installed.package.archive_sha256,
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false)
                )
                .unwrap_err()
                .code,
            "INTEGRITY_FAILED",
            "{fault}"
        );
        assert!(original.exists());
    }
}

#[test]
fn source_approval_verifies_the_actual_key_without_granting_execution_trust() {
    let profile = support::Profile::isolated("node-sources-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let input = archive(&with_metadata(payloads(), true));
    assert_eq!(
        sources
            .verify(
                input.clone(),
                &source,
                &key_id,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let approved = sources
        .approve_key(source.clone(), key_id.clone(), key, 0.into())
        .unwrap();
    assert_eq!(approved.revision, 1.into());
    let package = sources
        .verify(
            input,
            &source,
            &key_id,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(
        package
            .verified_source()
            .unwrap()
            .public_key_sha256
            .as_str(),
        format!("{:x}", Sha256::digest(key))
    );
    let installer = NodePackageInstaller::new(store.clone(), &root).unwrap();
    let installed = installer
        .install(
            package,
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert!(installed.package.verified_source.is_some());
    assert!(installed.package.execution_trust.is_none());
    assert!(!installed.package.enabled);
    assert_eq!(NodePackageSources::new(store).snapshot().unwrap(), approved);
}

#[test]
fn source_key_rotation_and_revocation_keep_history_and_reject_old_receipts() {
    let profile = support::Profile::isolated("node-source-rotation-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let old_key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let next_key = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    let approved = sources
        .approve_key(source.clone(), key_id.clone(), old_key, 0.into())
        .unwrap();
    let old_bytes = archive(&with_metadata(payloads(), true));
    let old = sources
        .verify(
            old_bytes.clone(),
            &source,
            &key_id,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let rotated = sources
        .approve_key(source.clone(), key_id.clone(), next_key, approved.revision)
        .unwrap();
    assert_eq!(rotated.keys.len(), 2);
    assert_eq!(rotated.keys[0].public_key, old_key);
    assert!(!rotated.keys[0].approved);
    assert_eq!(rotated.keys[1].public_key, next_key);
    assert!(rotated.keys[1].approved);
    assert_eq!(
        sources
            .require_current(old.verified_source().unwrap())
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        sources
            .verify(
                old_bytes,
                &source,
                &key_id,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let new_bytes = verified_manifest(manifest(), Some(8))
        .archive_bytes()
        .to_vec();
    let current = sources
        .verify(
            new_bytes.clone(),
            &source,
            &key_id,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let revoked = sources
        .revoke_key(&source, &key_id, rotated.revision)
        .unwrap();
    assert_eq!(revoked.keys.len(), 2);
    assert!(revoked.keys.iter().all(|key| !key.approved));
    assert_eq!(
        sources
            .require_current(current.verified_source().unwrap())
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        sources
            .verify(
                new_bytes,
                &source,
                &key_id,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        sources
            .approve_key(source.clone(), key_id.clone(), old_key, rotated.revision)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        sources
            .approve_key(source, key_id, [0; 32], revoked.revision)
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(NodePackageSources::new(store).snapshot().unwrap(), revoked);
}

#[test]
fn future_source_trust_format_is_preserved_by_reads_and_all_mutations() {
    let profile = support::Profile::isolated("node-source-future-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let document_id = "node-packages:sources".try_into().unwrap();
    let future = store
        .compare_and_swap_document(
            &document_id,
            0.into(),
            serde_json::from_value(json!({
                "formatVersion":"2", "futureField":{"preserve":"original"}
            }))
            .unwrap(),
        )
        .unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    assert_eq!(sources.snapshot().unwrap_err().code, "FUTURE_FORMAT");
    assert_eq!(
        sources
            .approve_key(source.clone(), key_id.clone(), key, future.revision)
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(
        sources
            .revoke_key(&source, &key_id, future.revision)
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(
        sources
            .verify(
                archive(&with_metadata(payloads(), true)),
                &source,
                &key_id,
                &NodePackageLimits::default(),
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(store.read_document(&document_id).unwrap(), Some(future));
}

#[test]
fn source_trust_storage_cannot_substitute_key_bytes_behind_an_old_fingerprint() {
    let profile = support::Profile::isolated("node-source-tamper-");
    let root = std::fs::canonicalize(profile.path()).unwrap();
    let store = serial_workbench_host::storage::Store::open(&root).unwrap();
    let sources = NodePackageSources::new(store.clone());
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let approved = sources
        .approve_key(source.clone(), key_id.clone(), key, 0.into())
        .unwrap();
    let mut substituted = serde_json::to_value(&approved.keys).unwrap();
    substituted[0]["publicKey"] =
        json!(SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes());
    let document_id = "node-packages:sources".try_into().unwrap();
    let original = store
        .compare_and_swap_document(
            &document_id,
            approved.revision,
            serde_json::from_value(json!({
                "formatVersion":"1", "keys":substituted
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(sources.snapshot().unwrap_err().code, "STORAGE_UNAVAILABLE");
    assert_eq!(
        sources
            .approve_key(source, key_id, key, original.revision)
            .unwrap_err()
            .code,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(store.read_document(&document_id).unwrap(), Some(original));
}

#[test]
fn verifies_only_a_pinned_source_key_over_original_integrity_bytes() {
    let files = with_metadata(payloads(), true);
    let source: Id = "test-source".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let trusted = || NodePackageSource::Trusted {
        source: &source,
        key_id: &key_id,
        public_key: &key,
    };
    let verified = verify_node_package(
        archive(&files),
        trusted(),
        &NodePackageLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    assert!(verified.is_source_verified());
    let receipt = verified.verified_source().unwrap();
    assert_eq!(receipt.source, source);
    assert_eq!(receipt.key_id, key_id);
    assert_eq!(
        receipt.public_key_sha256.as_str(),
        format!("{:x}", Sha256::digest(key))
    );
    let mut altered = files;
    altered.get_mut("integrity.json").unwrap().push(b' ');
    assert!(
        verify_node_package(
            archive(&altered),
            trusted(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
}

#[test]
fn rejects_tampering_missing_and_unlisted_payloads() {
    let good = with_metadata(payloads(), false);
    let mut tampered = good.clone();
    tampered.get_mut("dist/main.mjs").unwrap().push(b' ');
    let mut missing = good.clone();
    missing.remove("界面/index.html");
    let mut extra = good;
    extra.insert("unlisted.mjs".into(), b"throw 1".to_vec());
    for files in [tampered, missing, extra] {
        assert!(verify_local(&files).is_err());
    }
}

#[test]
fn rejects_traversal_and_portable_path_aliases() {
    let long_component = "a".repeat(256);
    for path in [
        "../escape.mjs",
        "C:/escape.mjs",
        "DIST/extra.mjs",
        "dist/main.mjs/child",
        "CON.txt",
        "dir./a",
        "dir /a",
        "a:stream",
        "x?y",
        long_component.as_str(),
        "con .txt",
        "COM¹.txt",
        "界面/cafe\u{301}.html",
    ] {
        let mut files = payloads();
        if path.contains("cafe") {
            files.insert("界面/café.html".into(), b"a".to_vec());
        }
        files.insert(path.into(), b"a".to_vec());
        assert!(
            verify_local(&with_metadata(files, false)).is_err(),
            "accepted {path:?}"
        );
    }
}

#[test]
fn preserves_nonconflicting_unicode_names_and_rejects_invalid_utf8() {
    let mut files = payloads();
    files.insert("界面/cafe\u{301}.html".into(), b"nfd".to_vec());
    assert!(verify_local(&with_metadata(files, false)).is_ok());
    let mut bytes = archive(&with_metadata(payloads(), false));
    let mut name = b"dist/main.mjs".to_vec();
    name[0] = 0xff;
    replace_name(&mut bytes, b"dist/main.mjs", &name);
    assert!(
        verify_node_package(
            bytes,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
}

#[test]
fn enforces_archive_payload_metadata_and_cancellation_budgets() {
    let bytes = archive(&with_metadata(payloads(), false));
    let limits = NodePackageLimits {
        max_archive_bytes: 1,
        ..Default::default()
    };
    assert!(
        verify_node_package(
            bytes.clone(),
            NodePackageSource::Local,
            &limits,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let limits = NodePackageLimits {
        max_total_bytes: 1,
        ..Default::default()
    };
    assert!(
        verify_node_package(
            bytes.clone(),
            NodePackageSource::Local,
            &limits,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let limits = NodePackageLimits {
        max_metadata_bytes: 1,
        ..Default::default()
    };
    assert!(
        verify_node_package(
            bytes.clone(),
            NodePackageSource::Local,
            &limits,
            &AtomicBool::new(false)
        )
        .is_err()
    );
    assert_eq!(
        verify_node_package(
            bytes,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(true)
        )
        .unwrap_err()
        .code,
        "CANCELLED"
    );
}

#[test]
fn rejects_unknown_duplicate_metadata_and_future_schema_without_fallback() {
    let good = with_metadata(payloads(), false);
    for (file, from, to) in [
        (
            "manifest.json",
            "\"schemaVersion\":\"0.1\"",
            "\"schemaVersion\":\"0.1\",\"schemaVersion\":\"0.1\"",
        ),
        (
            "manifest.json",
            "\"schemaVersion\":\"0.1\"",
            "\"schemaVersion\":\"0.2\"",
        ),
        (
            "integrity.json",
            "\"source\": \"local\"",
            "\"source\": \"local\",\"source\": \"local\"",
        ),
    ] {
        let mut files = good.clone();
        let raw = String::from_utf8(files[file].clone()).unwrap();
        assert!(raw.contains(from));
        files.insert(file.into(), raw.replacen(from, to, 1).into_bytes());
        assert!(verify_local(&files).is_err());
    }
}

#[test]
fn rejects_unknown_source_wrong_key_missing_signature_and_weak_key() {
    let source: Id = "test-source".try_into().unwrap();
    let other: Id = "other".try_into().unwrap();
    let key_id: Id = "test-key".try_into().unwrap();
    let good_key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let wrong_key = SigningKey::from_bytes(&[8; 32]).verifying_key().to_bytes();
    let weak_key = [0; 32];
    let files = with_metadata(payloads(), true);
    for (source, key_id, key) in [
        (&other, &key_id, &good_key),
        (&source, &other, &good_key),
        (&source, &key_id, &wrong_key),
        (&source, &key_id, &weak_key),
    ] {
        let error = verify_node_package(
            archive(&files),
            NodePackageSource::Trusted {
                source,
                key_id,
                public_key: key,
            },
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap_err();
        assert_eq!(error.code, "PERMISSION_DENIED");
    }
    let mut missing = files.clone();
    missing.remove("signature.json");
    assert!(
        verify_node_package(
            archive(&missing),
            NodePackageSource::Trusted {
                source: &source,
                key_id: &key_id,
                public_key: &good_key
            },
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    // 自述来源和即使真实有效的未知签名都不能通过 Local 路径建立信任。
    assert!(!verify_local(&files).unwrap().is_source_verified());
}

fn replace_name(bytes: &mut [u8], from: &[u8], to: &[u8]) {
    assert_eq!(from.len(), to.len());
    let mut replaced = 0;
    for i in 0..=bytes.len() - from.len() {
        if &bytes[i..i + from.len()] == from {
            bytes[i..i + from.len()].copy_from_slice(to);
            replaced += 1;
        }
    }
    assert!(replaced >= 2, "expected both ZIP headers");
}

#[test]
fn rejects_duplicate_names_and_local_central_header_disagreement() {
    let mut files = payloads();
    files.insert("extra-a.mjs".into(), b"a".to_vec());
    files.insert("extra-b.mjs".into(), b"b".to_vec());
    let mut duplicate = archive(&with_metadata(files, false));
    replace_name(&mut duplicate, b"extra-b.mjs", b"extra-a.mjs");
    assert!(
        verify_node_package(
            duplicate,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
    let mut inconsistent = archive(&with_metadata(payloads(), false));
    let name = inconsistent
        .windows(b"manifest.json".len())
        .position(|bytes| bytes == b"manifest.json")
        .unwrap();
    inconsistent[name + 7] = b'z';
    assert!(
        verify_node_package(
            inconsistent,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
}

#[test]
fn rejects_links_reparse_flags_and_special_file_modes() {
    for creator in [0, 3] {
        for attributes in [(0o120644u32) << 16, (0o010644u32) << 16, 0x400] {
            let mut bytes = archive(&with_metadata(payloads(), false));
            let header = bytes
                .windows(4)
                .position(|part| part == b"PK\x01\x02")
                .unwrap();
            bytes[header + 38..header + 42].copy_from_slice(&attributes.to_le_bytes());
            bytes[header + 5] = creator;
            assert!(
                verify_node_package(
                    bytes,
                    NodePackageSource::Local,
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false)
                )
                .is_err(),
                "accepted attributes={attributes:x} creator={creator}"
            );
        }
    }
}

#[test]
fn bounds_compressible_payload_entry_count_and_deadline() {
    let mut files = payloads();
    files.insert("data.bin".into(), vec![0; 128 * 1024]);
    let bytes = archive(&with_metadata(files, false));
    for limits in [
        NodePackageLimits {
            max_file_bytes: 64 * 1024,
            ..Default::default()
        },
        NodePackageLimits {
            max_files: 2,
            ..Default::default()
        },
        NodePackageLimits {
            timeout: std::time::Duration::ZERO,
            ..Default::default()
        },
    ] {
        assert_eq!(
            verify_node_package(
                bytes.clone(),
                NodePackageSource::Local,
                &limits,
                &AtomicBool::new(false)
            )
            .unwrap_err()
            .code,
            "LIMIT_EXCEEDED"
        );
    }
    let mut zip64 = bytes;
    let end = zip64.len() - 22;
    zip64[end + 10..end + 12].copy_from_slice(&u16::MAX.to_le_bytes());
    assert!(
        verify_node_package(
            zip64,
            NodePackageSource::Local,
            &NodePackageLimits::default(),
            &AtomicBool::new(false)
        )
        .is_err()
    );
}

#[test]
fn bounds_implicit_directory_nodes_even_with_few_archive_entries() {
    let mut files = payloads();
    files.insert(format!("nested/{}data.bin", "d/".repeat(80)), b"a".to_vec());
    let bytes = archive(&with_metadata(files, false));
    let limits = NodePackageLimits {
        max_files: 32,
        ..Default::default()
    };
    assert_eq!(
        verify_node_package(
            bytes,
            NodePackageSource::Local,
            &limits,
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .code,
        "LIMIT_EXCEEDED"
    );
}
