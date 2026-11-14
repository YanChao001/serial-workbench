#[test]
fn stop_without_a_running_host_does_not_launch_one() {
    let base = std::env::temp_dir().canonicalize().unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let profile = root.path().join("profile-without-host");
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_serial-workbench-cli"))
        .args(["host", "stop", "--profile"])
        .arg(&profile)
        .arg("--json")
        .env(
            "SWB_DEV_EXPECTED_HOST_EXECUTABLE",
            root.path().join("must-not-launch-host"),
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "an absent Host must be an explicit already-stopped result: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["stopped"], true);
    assert_eq!(reply["alreadyStopped"], true);
    assert!(reply.get("operation").is_none());
    assert!(!profile.exists(), "stop must not create an absent profile");
    assert!(
        !profile.join("host-v0").join("state.sqlite3").exists(),
        "host stop must not create a Host database"
    );
    assert!(
        !profile.join("host-v0").join("discovery.json").exists(),
        "host stop must not launch an absent Host"
    );
}

#[test]
fn stop_does_not_report_success_when_the_existing_lock_cannot_be_verified() {
    let base = std::env::temp_dir().canonicalize().unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let namespace = root.path().join("host-v0");
    serial_workbench_ipc::prepare_private_directory(&namespace).unwrap();
    let lock = namespace.join("instance.lock");
    std::fs::create_dir(&lock).unwrap();
    let expected = serial_workbench_ipc::profile_has_running_host(root.path()).unwrap_err();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_serial-workbench-cli"))
        .args(["host", "stop", "--profile"])
        .arg(root.path())
        .arg("--json")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["error"]["code"], expected.code);
    assert_ne!(reply["stopped"], true);
    assert!(lock.is_dir());
    assert!(!namespace.join("state.sqlite3").exists());
}
