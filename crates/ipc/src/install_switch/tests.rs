use super::*;
use crate::{
    profile_has_running_host, reserve_host_instance, try_lock_private_file, write_secret_new,
};
use serial_workbench_core::{Id, ProtocolVersion};
use tempfile::TempDir;

struct Fixture {
    _root: TempDir,
    profile: PathBuf,
    paths: InstallPaths,
    old: Digest,
    new: Digest,
}

impl Fixture {
    fn new() -> Self {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let root = tempfile::Builder::new()
            .prefix("sw-install-switch-")
            .tempdir_in(base)
            .unwrap();
        let profile = root.path().join("profile");
        let namespace = profile.join("host-v0");
        let guard = reserve_host_instance(&namespace).unwrap();
        let identity = IdentityPin::new(Id::try_from("old-host").unwrap(), &profile).unwrap();
        write_secret_new(
            &namespace.join("identity.secret"),
            &serde_json::to_vec(&identity).unwrap(),
        )
        .unwrap();
        DiscoveryRecord {
            host_id: identity.host_id,
            instance_epoch: 42.into(),
            endpoint: "fixture".into(),
            pid: std::process::id(),
            protocol_version: ProtocolVersion::V0_1,
            executable: None,
        }
        .write(&namespace.join("discovery.json"))
        .unwrap();
        fs::write(profile.join("profile-data"), b"saved recordings").unwrap();
        drop(guard);

        let installation = root.path().join("installation");
        fs::create_dir(&installation).unwrap();
        let active = installation.join("Serial Workbench");
        let operation = uuid::Uuid::new_v4().to_string();
        let paths =
            InstallPaths::new(&active, RequestId::try_from(operation.as_str()).unwrap()).unwrap();
        put_suite(&paths.active, "old");
        put_suite(paths.staged(), "new");
        let old = suite_digest(&paths.active).unwrap();
        let new = suite_digest(paths.staged()).unwrap();
        Self {
            _root: root,
            profile,
            paths,
            old,
            new,
        }
    }

    fn open(&self) -> InstallSwitch {
        // The suite is synthetic. The product constructor separately verifies actual Host exit.
        InstallSwitch::open_verified_identity(
            &self.profile,
            self.paths.clone(),
            reserve_host_instance(&self.profile.join("host-v0")).unwrap(),
        )
        .unwrap()
    }

    fn verify_original(&self, files: &(Vec<u8>, Vec<u8>, Vec<u8>)) {
        assert_eq!(self.profile_files(), *files);
        assert_eq!(suite_digest(&self.paths.active).unwrap(), self.old);
        assert!(!self.paths.backup().exists());
    }

    fn profile_files(&self) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let namespace = self.profile.join("host-v0");
        (
            fs::read(namespace.join("identity.secret")).unwrap(),
            fs::read(namespace.join("discovery.json")).unwrap(),
            fs::read(self.profile.join("profile-data")).unwrap(),
        )
    }

    fn interrupted(&self, fail_at: Checkpoint) {
        let mut guard = self.open();
        assert!(
            guard
                .replace_with(&self.old, &self.new, None, |current| {
                    if current == fail_at {
                        Err(storage())
                    } else {
                        Ok(())
                    }
                })
                .is_err()
        );
    }
}

fn put_suite(path: &Path, version: &str) {
    for entry in [
        "desktop.exe",
        "uninstall.exe",
        "serial-workbench-host.exe",
        "serial-workbench-cli.exe",
        "serial-workbench-mcp.exe",
        "runtime/node.exe",
        "runtime/metadata/runtime.json",
    ] {
        let target = path.join(entry);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, format!("{version}:{entry}")).unwrap();
    }
    fs::create_dir(path.join("empty")).unwrap();
}

#[test]
#[ignore = "requires an isolated Windows runner with a disposable user registry"]
fn isolated_registered_switch_recovers_files_and_current_user_values() {
    assert_eq!(
        std::env::var("SWB_TEST_WINDOWS_INSTALL_REGISTRATION").as_deref(),
        Ok("1")
    );
    use windows_registry::CURRENT_USER;
    for interrupted in [false, true] {
        let fixture = Fixture::new();
        let product = format!("Serial Workbench Upgrade Test {}", uuid::Uuid::new_v4());
        let path = format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{product}");
        struct TestKey(String);
        impl Drop for TestKey {
            fn drop(&mut self) {
                let _ = CURRENT_USER.remove_tree(&self.0);
            }
        }
        let key_guard = TestKey(path);
        let key = CURRENT_USER.create(&key_guard.0).unwrap();
        let quoted = |path: &Path| format!("\"{}\"", path.display());
        key.set_string("DisplayName", &product).unwrap();
        key.set_string("MainBinaryName", "serial-workbench.exe")
            .unwrap();
        key.set_string("InstallLocation", quoted(&fixture.paths.active))
            .unwrap();
        key.set_string(
            "UninstallString",
            quoted(&fixture.paths.active.join("uninstall.exe")),
        )
        .unwrap();
        key.set_string("DisplayVersion", "0.1.0").unwrap();
        key.set_u32("EstimatedSize", 100).unwrap();
        key.set_string("Publisher", "Registry Fixture").unwrap();
        let registration =
            InstallRegistration::capture(&fixture.paths.active, &product, "0.1.0", "0.1.1", 200)
                .unwrap();
        {
            let mut switch = fixture.open();
            let result =
                switch.replace_with(&fixture.old, &fixture.new, Some(registration), |phase| {
                    if interrupted && phase == Checkpoint::Commit {
                        return Err(storage());
                    }
                    Ok(())
                });
            assert_eq!(result.is_err(), interrupted);
            assert_eq!(key.get_string("DisplayVersion").unwrap(), "0.1.1");
            assert_eq!(key.get_u32("EstimatedSize").unwrap(), 200);
        }
        let mut reopened = fixture.open();
        let outcome = if interrupted {
            InstallOutcome::RolledBack
        } else {
            InstallOutcome::Committed
        };
        assert_eq!(reopened.recover().unwrap(), Some(outcome));
        assert_eq!(reopened.recover().unwrap(), Some(outcome));
        let (digest, version, kib) = if interrupted {
            (fixture.old, "0.1.0", 100)
        } else {
            (fixture.new, "0.1.1", 200)
        };
        assert_eq!(suite_digest(&fixture.paths.active).unwrap(), digest);
        assert_eq!(key.get_string("DisplayVersion").unwrap(), version);
        assert_eq!(key.get_u32("EstimatedSize").unwrap(), kib);
        assert_eq!(
            key.get_string("UninstallString").unwrap(),
            quoted(&fixture.paths.active.join("uninstall.exe"))
        );
        assert_eq!(key.get_string("Publisher").unwrap(), "Registry Fixture");
        println!(
            "outcome={outcome:?} version={version} kib={kib} stableRegistrationPreserved=true"
        );
    }
}

fn hold_without_delete_share(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .unwrap()
}

#[test]
fn committed_suite_and_old_backup_are_rechecked_on_reopen() {
    let fixture = Fixture::new();
    let before = fixture.profile_files();
    fixture.open().replace(&fixture.old, &fixture.new).unwrap();
    let mut reopened = fixture.open();
    assert_eq!(reopened.recover().unwrap(), Some(InstallOutcome::Committed));
    assert_eq!(reopened.recover().unwrap(), Some(InstallOutcome::Committed));
    assert_eq!(suite_digest(&fixture.paths.active).unwrap(), fixture.new);
    assert_eq!(suite_digest(fixture.paths.backup()).unwrap(), fixture.old);
    assert!(!fixture.paths.staged().exists());
    assert_eq!(fixture.profile_files(), before);
    println!(
        "fixtureHost=old-host epoch=42 previous={} candidate={} profileBytesPreserved=true outcome=Committed",
        fixture.old, fixture.new
    );
    fs::write(fixture.paths.active.join("runtime/node.exe"), b"tampered").unwrap();
    assert!(reopened.recover().is_err());
    assert_eq!(suite_digest(fixture.paths.backup()).unwrap(), fixture.old);
}

#[test]
fn failure_before_intent_preserves_all_original_bytes() {
    let fixture = Fixture::new();
    let before = fixture.profile_files();
    fixture.interrupted(Checkpoint::Intent);
    assert_eq!(fixture.open().recover().unwrap(), None);
    assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
    fixture.verify_original(&before);
}

#[test]
fn intent_path_write_failure_stops_before_replacement() {
    let fixture = Fixture::new();
    let before = fixture.profile_files();
    let mut guard = fixture.open();
    let blocked = guard.journal.clone();
    assert!(
        guard
            .replace_with(&fixture.old, &fixture.new, None, |checkpoint| {
                if checkpoint == Checkpoint::Intent {
                    fs::create_dir(&blocked).unwrap();
                }
                Ok(())
            })
            .is_err()
    );
    assert!(guard.journal.is_dir());
    assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
    fixture.verify_original(&before);
}

#[test]
fn windows_refuses_to_publish_a_reserved_staged_directory() {
    let fixture = Fixture::new();
    let before = fixture.profile_files();
    let busy = hold_without_delete_share(fixture.paths.staged());
    let mut guard = fixture.open();
    let error = guard.replace(&fixture.old, &fixture.new).unwrap_err();
    println!("publishError={error}");
    assert!(!fixture.paths.active.exists());
    assert_eq!(suite_digest(fixture.paths.backup()).unwrap(), fixture.old);
    drop(busy);
    assert_eq!(guard.recover().unwrap(), Some(InstallOutcome::RolledBack));
    assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
    fixture.verify_original(&before);
}

#[test]
fn interrupted_restore_can_retry_after_staged_candidate_was_already_preserved() {
    let fixture = Fixture::new();
    let before = fixture.profile_files();
    fixture.interrupted(Checkpoint::Commit);
    let busy = hold_without_delete_share(fixture.paths.backup());
    let mut recovery = fixture.open();
    let error = recovery.recover().unwrap_err();
    println!("restoreError={error}");
    assert!(!fixture.paths.active.exists());
    assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
    assert_eq!(suite_digest(fixture.paths.backup()).unwrap(), fixture.old);
    drop(busy);
    drop(recovery);
    let mut reopened = fixture.open();
    assert_eq!(
        reopened.recover().unwrap(),
        Some(InstallOutcome::RolledBack)
    );
    assert_eq!(
        reopened.recover().unwrap(),
        Some(InstallOutcome::RolledBack)
    );
    assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
    fixture.verify_original(&before);
    println!(
        "fixtureHost=old-host epoch=42 previous={} candidate={} profileBytesPreserved=true outcome=RolledBack",
        fixture.old, fixture.new
    );
}

#[test]
fn failures_after_each_move_restore_old_suite_and_preserve_candidate() {
    for failure in [Checkpoint::Publish, Checkpoint::Commit] {
        let fixture = Fixture::new();
        let before = fixture.profile_files();
        fixture.interrupted(failure);
        assert_eq!(suite_digest(fixture.paths.backup()).unwrap(), fixture.old);
        if failure == Checkpoint::Publish {
            assert!(!fixture.paths.active.exists());
            assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
        } else {
            assert_eq!(suite_digest(&fixture.paths.active).unwrap(), fixture.new);
            assert!(!fixture.paths.staged().exists());
        }
        let mut reopened = fixture.open();
        assert_eq!(
            reopened.recover().unwrap(),
            Some(InstallOutcome::RolledBack)
        );
        assert_eq!(
            reopened.recover().unwrap(),
            Some(InstallOutcome::RolledBack)
        );
        assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
        fixture.verify_original(&before);
    }
}

#[test]
fn conflict_preserves_foreign_directory_and_retry_restores_old_suite() {
    let fixture = Fixture::new();
    let before = fixture.profile_files();
    fixture.interrupted(Checkpoint::Publish);
    put_suite(&fixture.paths.active, "foreign");
    let foreign = suite_digest(&fixture.paths.active).unwrap();
    let mut reopened = fixture.open();
    assert!(reopened.recover().is_err());
    assert_eq!(suite_digest(&fixture.paths.active).unwrap(), foreign);
    assert_eq!(suite_digest(fixture.paths.backup()).unwrap(), fixture.old);
    assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
    let preserved = fixture.paths.active.with_file_name("foreign");
    move_directory(&fixture.paths.active, &preserved).unwrap();
    assert_eq!(
        reopened.recover().unwrap(),
        Some(InstallOutcome::RolledBack)
    );
    assert_eq!(suite_digest(&preserved).unwrap(), foreign);
    fixture.verify_original(&before);
}

#[test]
fn changed_candidate_or_receipt_cannot_replace_or_restore_unknown_suite() {
    let fixture = Fixture::new();
    let before = fixture.profile_files();
    let mut guard = fixture.open();
    let candidate = fixture.paths.staged().join("serial-workbench-cli.exe");
    fs::write(&candidate, b"tainted").unwrap();
    assert!(guard.replace(&fixture.old, &fixture.new).is_err());
    assert!(!guard.journal.exists());
    fixture.verify_original(&before);

    fs::write(candidate, b"new:serial-workbench-cli.exe").unwrap();
    assert!(
        guard
            .replace_with(&fixture.old, &fixture.new, None, |current| {
                if current == Checkpoint::Commit {
                    Err(storage())
                } else {
                    Ok(())
                }
            })
            .is_err()
    );
    let receipt = fs::read(&guard.journal).unwrap();
    let mut parsed: serde_json::Value = serde_json::from_slice(&receipt).unwrap();
    parsed["intent"]["phase"] = serde_json::Value::String("Committed".into());
    write_atomic(&guard.journal, &serde_json::to_vec(&parsed).unwrap()).unwrap();
    assert!(guard.recover().is_err());
    assert_eq!(suite_digest(&fixture.paths.active).unwrap(), fixture.new);
    assert_eq!(suite_digest(fixture.paths.backup()).unwrap(), fixture.old);
    write_atomic(&guard.journal, &receipt).unwrap();
    assert_eq!(guard.recover().unwrap(), Some(InstallOutcome::RolledBack));
    fixture.verify_original(&before);
}

#[test]
fn host_namespace_reservation_is_held_and_public_entry_requires_exit_proof() {
    let fixture = Fixture::new();
    let namespace = fixture.profile.join("host-v0");
    let unrelated = try_lock_private_file(&namespace.join("other.lock"))
        .unwrap()
        .unwrap();
    assert!(
        InstallSwitch::open_verified_identity(&fixture.profile, fixture.paths.clone(), unrelated)
            .is_err()
    );
    let guard = fixture.open();
    assert!(profile_has_running_host(&fixture.profile).unwrap());
    assert!(reserve_host_instance(&namespace).is_err());
    drop(guard);
    assert!(!profile_has_running_host(&fixture.profile).unwrap());

    let other = fixture
        .profile
        .with_file_name("other-profile")
        .join("host-v0");
    let wrong_reservation = reserve_host_instance(&other).unwrap();
    assert!(
        InstallSwitch::open_verified_identity(
            &fixture.profile,
            fixture.paths.clone(),
            wrong_reservation,
        )
        .is_err()
    );

    assert!(
        InstallSwitch::open(
            &fixture.profile,
            fixture.paths,
            reserve_host_instance(&namespace).unwrap(),
            Duration::ZERO,
        )
        .is_err()
    );
    assert!(!profile_has_running_host(&fixture.profile).unwrap());
}

#[test]
fn changed_generation_rejects_recovery_without_touching_suites() {
    let fixture = Fixture::new();
    fixture.interrupted(Checkpoint::Publish);
    let discovery = fixture.profile.join("host-v0/discovery.json");
    let mut record = DiscoveryRecord::read(&discovery).unwrap();
    record.instance_epoch = record.instance_epoch.checked_next().unwrap();
    record.write(&discovery).unwrap();
    assert!(fixture.open().recover().is_err());
    assert!(!fixture.paths.active.exists());
    assert_eq!(suite_digest(fixture.paths.backup()).unwrap(), fixture.old);
    assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
}

#[test]
fn extra_files_and_links_are_detected_in_the_tree_digest() {
    let fixture = Fixture::new();
    let extra = fixture.paths.staged().join("extra");
    fs::write(&extra, b"unexpected").unwrap();
    assert_ne!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
    fs::remove_file(&extra).unwrap();
    fs::hard_link(fixture.paths.active.join("desktop.exe"), &extra).unwrap();
    assert!(suite_digest(fixture.paths.staged()).is_err());
    assert!(suite_digest(&fixture.paths.active).is_err());
    fs::remove_file(&extra).unwrap();
    assert_eq!(suite_digest(&fixture.paths.active).unwrap(), fixture.old);
    assert_eq!(suite_digest(fixture.paths.staged()).unwrap(), fixture.new);
}
