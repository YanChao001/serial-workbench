#[test]
fn stop_without_a_running_host_does_not_launch_one() {
    let root = tempfile::tempdir().unwrap();
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
        !output.status.success(),
        "no running Host must not report a completed shutdown"
    );
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        reply["error"]["code"], "STORAGE_UNAVAILABLE",
        "stop must report absent discovery without attempting executable bootstrap"
    );
    assert!(
        !profile.join("host-v0").join("state.sqlite3").exists(),
        "host stop must not create a Host database"
    );
    assert!(
        !profile.join("host-v0").join("discovery.json").exists(),
        "host stop must not launch an absent Host"
    );
}
