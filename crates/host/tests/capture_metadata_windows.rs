#![cfg(windows)]

use serial_workbench_host::capture::format::{open_read, rename_no_replace, write_json};
use std::{fs, io::Read, os::windows::fs::OpenOptionsExt, time::Duration};
use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

#[test]
fn capture_metadata_replace_allows_a_live_shared_reader() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("manifest.json");
    for revision in 0..100 {
        let before = serde_json::json!({"revision": revision});
        write_json(&path, &before).unwrap();
        let mut reader = open_read(&path).unwrap();
        let after = serde_json::json!({"revision": revision + 1});
        write_json(&path, &after).unwrap();
        let mut old = String::new();
        reader.read_to_string(&mut old).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&old).unwrap(),
            before
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
            after
        );
    }
}

#[test]
fn capture_metadata_replace_preserves_both_files_until_explicit_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("manifest.json");
    let before = serde_json::json!({"state": "finalizing"});
    let after = serde_json::json!({"state": "complete"});
    write_json(&path, &before).unwrap();
    let reader = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&path)
        .unwrap();
    let started = std::time::Instant::now();
    let error = write_json(&path, &after).unwrap_err();
    assert_eq!(error.code, "CAPTURE_IO_FAILED");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
        before
    );
    let pending = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".pending-")
        })
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&pending).unwrap()).unwrap(),
        after
    );
    drop(reader);
    write_json(&path, &after).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
        after
    );
    assert!(
        pending.exists(),
        "the earlier failed candidate remains evidence"
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn capture_metadata_replace_does_not_override_readonly_protection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("manifest.json");
    let before = serde_json::json!({"state": "finalizing"});
    write_json(&path, &before).unwrap();
    let original_permissions = fs::metadata(&path).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).unwrap();
    let result = write_json(&path, &serde_json::json!({"state": "complete"}));
    fs::set_permissions(&path, original_permissions).unwrap();
    assert_eq!(result.unwrap_err().code, "CAPTURE_IO_FAILED");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&path).unwrap()).unwrap(),
        before
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}

#[test]
fn capture_no_replace_still_rejects_an_existing_target_with_a_live_reader() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let source = root.join("candidate.json");
    let target = root.join("original.json");
    fs::write(&source, b"candidate").unwrap();
    fs::write(&target, b"original").unwrap();
    let reader = open_read(&target).unwrap();
    assert_eq!(
        rename_no_replace(&source, &target).unwrap_err().code,
        "TARGET_EXISTS"
    );
    assert_eq!(fs::read(&source).unwrap(), b"candidate");
    assert_eq!(fs::read(&target).unwrap(), b"original");
    drop(reader);
}
