//! Shared harness for the installed CLI and the official MCP SDK.
use rmcp::model::CallToolRequestParams;
use serde_json::{Value, json};
use serial_workbench_core::{RpcReply, Target};
use std::{
    path::PathBuf,
    process::{Output, Stdio},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command, time::timeout};

pub(crate) fn binary(variable: &str, name: &str) -> PathBuf {
    let path = std::env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .unwrap()
                .parent()
                .expect("test executable directory")
                .parent()
                .expect("target profile directory")
                .join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
        });
    path.canonicalize().ok().filter(|path| path.is_file()).unwrap_or_else(|| {
        panic!(
            "Missing test binary {} ({variable}); from the workspace root first run: cargo build --locked -p serial-workbench-cli -p serial-workbench-mcp",
            path.display()
        )
    })
}

pub(crate) async fn drain(
    mut stream: impl tokio::io::AsyncRead + Unpin,
) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = stream.read(&mut buffer).await?;
        if count == 0 {
            return Ok(retained);
        }
        // Continue draining after the diagnostic cap so the child cannot block on stderr.
        let keep = count.min((1024 * 1024_usize).saturating_sub(retained.len()));
        retained.extend_from_slice(&buffer[..keep]);
    }
}

pub(crate) struct Cli {
    pub(crate) binary: PathBuf,
    pub(crate) profile: PathBuf,
}

impl Cli {
    pub(crate) async fn json(&self, args: &[&str]) -> Value {
        let output = self.run(args).await;
        assert!(
            output.status.success(),
            "CLI {args:?}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stderr.is_empty(),
            "CLI stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("CLI stdout must be one JSON value")
    }

    async fn run(&self, args: &[&str]) -> Output {
        let mut command = Command::new(&self.binary);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        command
            .args(args)
            .arg("--profile")
            .arg(&self.profile)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn().expect("spawn real CLI");
        let mut stdout = tokio::spawn(drain(child.stdout.take().unwrap()));
        let mut stderr = tokio::spawn(drain(child.stderr.take().unwrap()));
        let status = timeout(Duration::from_secs(10), child.wait()).await;
        if !matches!(&status, Ok(Ok(_))) {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let output = timeout(Duration::from_secs(3), &mut stdout).await;
        let errors = timeout(Duration::from_secs(3), &mut stderr).await;
        if output.is_err() {
            stdout.abort();
            let _ = stdout.await;
        }
        if errors.is_err() {
            stderr.abort();
            let _ = stderr.await;
        }
        let output = output.expect("CLI stdout drain timeout").unwrap().unwrap();
        let errors = errors.expect("CLI stderr drain timeout").unwrap().unwrap();
        let status = status
            .expect("CLI timeout (child killed and reaped)")
            .unwrap();
        Output {
            status,
            stdout: output,
            stderr: errors,
        }
    }

    pub(crate) fn file(&self, name: &str, value: &impl serde::Serialize) -> PathBuf {
        let path = self.profile.join(name);
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        path
    }

    pub(crate) async fn query_reply(
        &self,
        action: &str,
        target: &Target,
        params: &Value,
    ) -> RpcReply {
        let target = self.file("query-target.json", target);
        let params = self.file("query-params.json", params);
        let output = self
            .run(&[
                "query",
                action,
                "--target-json",
                target.to_str().unwrap(),
                "--params-json",
                params.to_str().unwrap(),
                "--json",
            ])
            .await;
        let reply = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "CLI query {action}: {error}, stderr={}",
                String::from_utf8_lossy(&output.stderr)
            )
        });
        match &reply {
            RpcReply::Success { .. } => {
                assert!(
                    output.status.success() && output.stderr.is_empty(),
                    "{output:?}"
                );
            }
            RpcReply::Failure { error, .. } => {
                assert!(!output.status.success(), "{output:?}");
                assert!(
                    output
                        .stderr
                        .starts_with(format!("{}: ", error.code).as_bytes()),
                    "{output:?}"
                );
            }
        }
        reply
    }
}

pub(crate) async fn tool(
    peer: &rmcp::Peer<rmcp::RoleClient>,
    name: &str,
    target: &Target,
    params: Value,
) -> rmcp::model::CallToolResult {
    tool_reply(peer, name, target, params)
        .await
        .expect("official SDK call_tool")
}

pub(crate) async fn tool_reply(
    peer: &rmcp::Peer<rmcp::RoleClient>,
    name: &str,
    target: &Target,
    params: Value,
) -> Result<rmcp::model::CallToolResult, rmcp::ServiceError> {
    peer.call_tool(
        CallToolRequestParams::new(name.to_owned()).with_arguments(
            json!({"target":target,"params":params})
                .as_object()
                .unwrap()
                .clone(),
        ),
    )
    .await
}

pub(crate) fn structured(result: rmcp::model::CallToolResult) -> Value {
    assert_ne!(
        result.is_error,
        Some(true),
        "MCP business error: {result:?}"
    );
    result
        .structured_content
        .expect("MCP structured domain result")
}
