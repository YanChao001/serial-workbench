use serial_workbench_core::HostResult;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::oneshot,
    task::JoinHandle,
};

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

fn block_default(directory: &Path) {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../app.config.json")).unwrap();
    let base = directory.join("default-base");
    #[cfg(target_os = "macos")]
    let base = directory.join("home/Library/Application Support");
    std::fs::create_dir_all(&base).unwrap();
    block_profile(&base.join(config["identifier"].as_str().unwrap()));
}

fn block_profile(profile: &Path) {
    // host-v0 本身为文件时，Unix/Windows 的 instance probe 均拒绝，不能进入子 Host launch。
    std::fs::create_dir_all(profile).unwrap();
    std::fs::write(
        profile.join("host-v0"),
        b"blocked namespace: never launch Host",
    )
    .unwrap();
}

fn command(directory: &Path, profile: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_serial-workbench-mcp"));
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    command
        .env("LOCALAPPDATA", directory.join("default-base"))
        .env("XDG_DATA_HOME", directory.join("default-base"))
        .env("HOME", directory.join("home"))
        .env("SWB_PROFILE", profile)
        .env("SWB_LOG_LEVEL", "info")
        .kill_on_drop(true);
    command
}

async fn output(mut command: Command) -> Output {
    command.stdin(Stdio::null());
    tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .unwrap()
        .unwrap()
}

async fn handshake(mut command: Command) -> Output {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let request = serde_json::json!({
        "jsonrpc":"2.0", "id":1, "method":"initialize", "params":{
            "protocolVersion":rmcp::model::ProtocolVersion::LATEST_WITH_INITIALIZE,
            "capabilities":{}, "clientInfo":{"name":"startup-test","version":"0"}
        }
    });
    input
        .write_all(format!("{request}\n").as_bytes())
        .await
        .unwrap();
    let mut first = String::new();
    let read = tokio::time::timeout(Duration::from_secs(15), stdout.read_line(&mut first))
        .await
        .unwrap()
        .unwrap();
    if read > 0 {
        input
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
            .await
            .unwrap();
    }
    drop(input);
    let mut result = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    let mut trailing = Vec::new();
    stdout.read_to_end(&mut trailing).await.unwrap();
    result.stdout = first.into_bytes();
    result.stdout.extend(trailing);
    result
}

fn assert_initialize_only(output: &Output) {
    assert!(
        output.status.success(),
        "status={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let lines: Vec<_> = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .collect();
    assert!(
        !lines.is_empty(),
        "MCP initialization returned no protocol reply"
    );
    for line in &lines {
        let value: serde_json::Value =
            serde_json::from_slice(line).expect("stdout must contain only JSON-RPC");
        assert_eq!(value["jsonrpc"], "2.0");
    }
    let response: serde_json::Value = serde_json::from_slice(lines[0]).unwrap();
    assert_eq!(response["id"], 1);
    assert!(response["result"]["serverInfo"].is_object(), "{response}");
}

#[tokio::test]
async fn environment_profile_and_debug_filter_preserve_real_mcp_stdio() {
    let fixture = Fixture::new().await;
    let mut command = fixture.command();
    command.env("SWB_LOG_LEVEL", "debug");
    let output = handshake(command).await;
    assert_initialize_only(&output);
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("profileSource=Environment"), "{stderr}");
    assert!(stderr.contains("logLevel=Debug"), "{stderr}");
    assert!(stderr.contains("logLevelSource=Environment"), "{stderr}");
    assert!(!stderr.contains("selected-private-profile"));
    fixture.finish().await;
}

#[tokio::test]
async fn explicit_profile_beats_environment_and_off_keeps_stdio_clean() {
    let fixture = Fixture::new().await;
    let rejected = fixture.directory.path().join("rejected-env-profile");
    block_profile(&rejected);
    let mut command = fixture.command();
    command
        .arg("--profile")
        .arg(&fixture.profile)
        .env("SWB_PROFILE", rejected)
        .env("SWB_LOG_LEVEL", "off");
    let output = handshake(command).await;
    assert_initialize_only(&output);
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.finish().await;
}

#[tokio::test]
async fn invalid_level_is_fatal_before_profile_creation_and_never_writes_stdout() {
    let directory = tempfile::tempdir().unwrap();
    block_default(directory.path());
    let profile = directory.path().join("must-not-create");
    let mut command = command(directory.path(), &profile);
    command.env("SWB_LOG_LEVEL", "private-secret=trace");
    let output = output(command).await;
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("INVALID_ARGUMENT"), "{stderr}");
    assert!(stderr.contains("SWB_LOG_LEVEL"), "{stderr}");
    assert!(!stderr.contains("private-secret"));
    assert!(!profile.exists());
}

#[tokio::test]
async fn invalid_syntax_does_not_resolve_environment_or_start_host() {
    let directory = tempfile::tempdir().unwrap();
    block_default(directory.path());
    let profile = directory.path().join("must-not-create");
    let mut command = command(directory.path(), &profile);
    command
        .arg("--unknown")
        .env("SWB_PROFILE", "")
        .env("SWB_LOG_LEVEL", "private-secret");
    let output = output(command).await;
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("Usage:"), "{stderr}");
    assert!(!stderr.contains("SWB_LOG_LEVEL"));
    assert!(!stderr.contains("private-secret"));
    assert!(!profile.exists());
}
