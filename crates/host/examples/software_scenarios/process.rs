use serde::Serialize;
use serde_json::Value;
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    task::JoinHandle,
    time::timeout,
};

pub(super) type Result<T> = std::result::Result<T, String>;
pub(super) fn checked<T>(value: std::result::Result<T, impl std::fmt::Debug>) -> Result<T> {
    value.map_err(|error| format!("{error:?}"))
}

#[derive(Serialize)]
pub(super) struct ProcessRecord {
    pub pid: u32,
    pub role: String,
    pub exited: bool,
    pub forced: bool,
    pub exit_code: Option<i32>,
}
pub(super) struct Owned {
    pub child: Child,
    pub record: ProcessRecord,
    ledger: PathBuf,
}
impl Owned {
    pub fn spawn(mut command: Command, role: &str, log_dir: &Path) -> Result<Self> {
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        command.kill_on_drop(true);
        let child = checked(command.spawn())?;
        let pid = child.id().ok_or("Owned child has no PID")?;
        let owned = Self {
            child,
            record: ProcessRecord {
                pid,
                role: role.into(),
                exited: false,
                forced: false,
                exit_code: None,
            },
            ledger: log_dir.join("owned-processes.jsonl"),
        };
        owned.record_event("spawned")?;
        Ok(owned)
    }
    fn record_event(&self, event: &str) -> Result<()> {
        let mut file = checked(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.ledger),
        )?;
        let value = serde_json::json!({"event":event,"process":self.record});
        checked(file.write_all(&checked(serde_json::to_vec(&value))?))?;
        checked(file.write_all(b"\n"))?;
        checked(file.sync_data())
    }
    pub async fn wait(&mut self, seconds: u64) -> Result<()> {
        let status = checked(timeout(Duration::from_secs(seconds), self.child.wait()).await)?;
        let status = checked(status)?;
        self.record.exited = true;
        self.record.exit_code = status.code();
        self.record_event("waited")?;
        if !status.success() {
            return Err(format!(
                "{} PID {} exited {status}",
                self.record.role, self.record.pid
            ));
        }
        Ok(())
    }
    pub async fn force_stop(&mut self) -> Result<()> {
        if self.record.exited {
            return Ok(());
        }
        if let Some(status) = checked(self.child.try_wait())? {
            self.record.exited = true;
            self.record.exit_code = status.code();
            self.record_event("waited")?;
            return Ok(());
        }
        self.record.forced = true;
        self.record_event("force-stop-requested")?;
        checked(self.child.kill().await)?;
        let status = checked(self.child.wait().await)?;
        self.record.exited = true;
        self.record.exit_code = status.code();
        self.record_event("waited")?;
        Ok(())
    }
}

pub(super) struct Processes {
    pub children: Vec<Owned>,
    pub archived: Vec<ProcessRecord>,
    pub log_dir: PathBuf,
}
impl Processes {
    pub fn new(log_dir: PathBuf) -> Self {
        Self {
            children: Vec::new(),
            archived: Vec::new(),
            log_dir,
        }
    }
    pub fn start_host(&mut self, binary: &Path, profile: &Path, private: bool) -> Result<usize> {
        let index = self.children.len();
        let log = checked(std::fs::File::create(
            self.log_dir.join(format!("host-{index}.log")),
        ))?;
        let mut command = Command::new(binary);
        if private {
            command.arg("--owned-fault-host");
        }
        command.arg("--profile").arg(profile);
        if private {
            command.arg("--log-dir").arg(&self.log_dir);
        }
        command
            .stdin(Stdio::null())
            .stdout(checked(log.try_clone())?)
            .stderr(log);
        self.children.push(Owned::spawn(
            command,
            if private {
                "private Host runtime"
            } else {
                "formal Host executable"
            },
            &self.log_dir,
        )?);
        Ok(index)
    }
    pub async fn cli(&mut self, binary: &Path, profile: &Path, args: &[String]) -> Result<Value> {
        let mut command = Command::new(binary);
        command
            .args(args)
            .arg("--profile")
            .arg(profile)
            .arg("--json");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = Owned::spawn(command, "CLI", &self.log_dir)?;
        let stdout = tokio::spawn(drain(
            child.child.stdout.take().ok_or("Missing CLI stdout")?,
        ));
        let stderr = tokio::spawn(drain(
            child.child.stderr.take().ok_or("Missing CLI stderr")?,
        ));
        let result = child.wait(15).await;
        let cleanup = if !child.record.exited {
            child.force_stop().await
        } else {
            Ok(())
        };
        self.archived.push(child.record);
        let stdout = joined(stdout).await?;
        let stderr = joined(stderr).await?;
        cleanup?;
        result.map_err(|error| format!("{error}; stderr={}", String::from_utf8_lossy(&stderr)))?;
        checked(serde_json::from_slice(&stdout))
    }
    pub async fn cleanup(&mut self) -> Result<()> {
        let mut errors = Vec::new();
        for child in &mut self.children {
            if let Err(error) = child.force_stop().await {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    pub fn records(&self) -> Vec<&ProcessRecord> {
        self.archived
            .iter()
            .chain(self.children.iter().map(|child| &child.record))
            .collect()
    }
}

pub(super) async fn drain(mut pipe: impl tokio::io::AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut block = [0; 4096];
    loop {
        let count = pipe.read(&mut block).await?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len() < 4 * 1024 * 1024 {
            bytes.extend_from_slice(&block[..count.min(4 * 1024 * 1024 - bytes.len())]);
        }
    }
}
async fn joined(mut job: JoinHandle<std::io::Result<Vec<u8>>>) -> Result<Vec<u8>> {
    match timeout(Duration::from_secs(5), &mut job).await {
        Ok(result) => checked(checked(result)?),
        Err(error) => {
            job.abort();
            let _ = job.await;
            Err(error.to_string())
        }
    }
}

pub(super) struct Binaries {
    pub host: PathBuf,
    pub cli: PathBuf,
    pub mcp: PathBuf,
    pub harness: PathBuf,
}
impl Binaries {
    pub fn discover() -> Result<Self> {
        let harness = checked(std::env::current_exe())?;
        let directory = harness
            .parent()
            .and_then(Path::parent)
            .ok_or("Cannot locate target profile directory")?;
        let find = |variable: &str, name: &str| -> Result<PathBuf> {
            let path = std::env::var_os(variable)
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    directory.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
                });
            let path = path.canonicalize().map_err(|error| format!("Missing required {variable} binary {}: {error}; build Host/CLI/MCP for the same target first", path.display()))?;
            if !path.is_file() {
                return Err(format!(
                    "Required binary is not a regular file: {}",
                    path.display()
                ));
            }
            Ok(path)
        };
        Ok(Self {
            host: find("SWB_TEST_HOST_BIN", "serial-workbench-host")?,
            cli: find("SWB_TEST_CLI_BIN", "serial-workbench-cli")?,
            mcp: find("SWB_TEST_MCP_BIN", "serial-workbench-mcp")?,
            harness,
        })
    }
}
