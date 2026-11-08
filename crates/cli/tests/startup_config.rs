use serial_workbench_core::HostResult;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{
    path::PathBuf,
    process::{Output, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{process::Command, sync::oneshot, task::JoinHandle};

struct Fixture {
    directory: tempfile::TempDir,
    profile: PathBuf,
    stop: Option<oneshot::Sender<()>>,
    running: Option<JoinHandle<HostResult<()>>>,
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let profile = directory.path().join("selected-private-profile");
        let mut server = HostServer::bind(&profile).await.unwrap();
        let host = Host::new(server.store(), server.auth()).await.unwrap();
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        block_default(directory.path());
        Self {
            directory,
            profile,
            stop: Some(stop),
            running: Some(running),
        }
    }

    fn command(&self) -> Command {
        command(self.directory.path(), &self.profile)
    }

    async fn finish(mut self) {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), self.running.take().unwrap())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(running) = self.running.take() {
            running.abort();
        }
    }
}

fn block_default(directory: &std::path::Path) {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../app.config.json")).unwrap();
    #[cfg(not(target_os = "macos"))]
    let base = directory.join("default-base");
    #[cfg(target_os = "macos")]
    let base = directory.join("home/Library/Application Support");
    std::fs::create_dir_all(&base).unwrap();
    block_profile(&base.join(config["identifier"].as_str().unwrap()));
}

fn block_profile(profile: &std::path::Path) {
    // host-v0 本身为文件时，Unix/Windows 的 instance probe 均拒绝，不能进入子 Host launch。
    std::fs::create_dir_all(profile).unwrap();
    std::fs::write(
        profile.join("host-v0"),
        b"blocked namespace: never launch Host",
    )
    .unwrap();
}

fn command(directory: &std::path::Path, profile: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_serial-workbench-cli"));
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .env("LOCALAPPDATA", directory.join("default-base"))
        .env("XDG_DATA_HOME", directory.join("default-base"))
        .env("HOME", directory.join("home"))
        .env("SWB_PROFILE", profile)
        .env("SWB_LOG_LEVEL", "info")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

async fn output(mut command: Command) -> Output {
    tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .unwrap()
        .unwrap()
}

fn json(output: &Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout must be one JSON value: {error}; status={} stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[tokio::test]
async fn environment_profile_connects_to_the_selected_host_with_quiet_info_logging() {
    let fixture = Fixture::new().await;
    let mut child = fixture.command();
    child.arg("catalog");
    let result = output(child).await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(json(&result).is_object());
    assert!(
        result.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    fixture.finish().await;
}

#[tokio::test]
async fn explicit_profile_beats_environment_and_debug_logs_only_controlled_sources_to_stderr() {
    let fixture = Fixture::new().await;
    let rejected = fixture.directory.path().join("rejected-env-profile");
    block_profile(&rejected);
    let mut child = fixture.command();
    child
        .args(["catalog", "--profile"])
        .arg(&fixture.profile)
        .env("SWB_PROFILE", &rejected)
        .env("SWB_LOG_LEVEL", "debug");
    let result = output(child).await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(json(&result).is_object());
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert!(stderr.contains("profileSource=Argument"), "{stderr}");
    assert!(stderr.contains("logLevel=Debug"), "{stderr}");
    assert!(stderr.contains("logLevelSource=Environment"), "{stderr}");
    assert!(!stderr.contains("selected-private-profile"));
    assert!(!stderr.contains("rejected-env-profile"));
    fixture.finish().await;
}

#[tokio::test]
async fn off_preserves_fatal_stderr_and_structured_json_errors() {
    let directory = tempfile::tempdir().unwrap();
    block_default(directory.path());
    let rejected = directory.path().join("rejected-explicit-profile");
    block_profile(&rejected);
    let mut child = command(
        directory.path(),
        &directory.path().join("unselected-profile"),
    );
    child
        .args(["catalog", "--profile"])
        .arg(&rejected)
        .env("SWB_LOG_LEVEL", "off");
    let result = output(child).await;
    assert!(!result.status.success());
    let value = json(&result);
    let code = value["error"]["code"].as_str().unwrap();
    assert!(!code.is_empty());
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert!(stderr.contains(code), "{stderr}");
    assert!(!stderr.contains("profileSource="));
}

#[tokio::test]
async fn invalid_level_is_rejected_before_connecting_or_creating_a_new_profile() {
    let directory = tempfile::tempdir().unwrap();
    block_default(directory.path());
    let profile = directory.path().join("must-not-create");
    let mut child = command(directory.path(), &profile);
    child
        .arg("catalog")
        .env("SWB_LOG_LEVEL", "private-secret=trace");
    let result = output(child).await;
    assert_eq!(result.status.code(), Some(2));
    assert_eq!(json(&result)["error"]["code"], "INVALID_ARGUMENT");
    let stderr = String::from_utf8(result.stderr).unwrap();
    assert!(stderr.contains("SWB_LOG_LEVEL"), "{stderr}");
    assert!(!stderr.contains("private-secret"));
    assert!(!profile.exists());
}

#[tokio::test]
async fn help_and_invalid_syntax_do_not_resolve_environment_or_start_host() {
    let directory = tempfile::tempdir().unwrap();
    block_default(directory.path());
    let profile = directory.path().join("must-not-create");
    for args in [["--help"].as_slice(), ["unknown-command"].as_slice()] {
        let mut child = command(directory.path(), &profile);
        child
            .args(args)
            .env("SWB_PROFILE", "")
            .env("SWB_LOG_LEVEL", "private-secret");
        let result = output(child).await;
        if args[0] == "--help" {
            assert!(result.status.success());
            assert!(result.stderr.is_empty());
        } else {
            assert_eq!(result.status.code(), Some(2));
            assert_eq!(json(&result)["error"]["code"], "INVALID_ARGUMENT");
        }
        assert!(!String::from_utf8_lossy(&result.stderr).contains("private-secret"));
        assert!(!profile.exists());
    }
}
