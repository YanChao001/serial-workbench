use super::{decode, verify_reader};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use serial_workbench_ipc::{
    create_private_directory_new,
    install_switch::{InstallPaths, suite_digest},
};
use std::{
    error::Error,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek},
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const STAGE_INSTALLER: &str = "serial-workbench-nsis-stage-v1.exe";
const STAGE_TIMEOUT: Duration = Duration::from_secs(120);
const FILE_SHARE_READ: u32 = 1;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageRequest {
    active_install: PathBuf,
    artifact: PathBuf,
    signature: PathBuf,
    public_key: String,
    version: String,
}

pub fn stage_windows_release(input: &Path) -> Result<(), Box<dyn Error>> {
    let request: StageRequest = serde_json::from_str(&read_text(input, 64 * 1024)?)?;
    let key = PublicKey::decode(&decode(&request.public_key)?)?;
    let encoded = read_text(&request.signature, 16 * 1024)?;
    let mut input = File::open(&request.artifact)?;
    let signature = verify_reader(&key, &input, &encoded, &request.version)?;
    require_stage_support(&signature)?;

    let paths = InstallPaths::fresh(&request.active_install)?;
    let _directory = create_private_directory_new(paths.staged())?;
    let executable = paths.staged().join(STAGE_INSTALLER);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&executable)?;
    input.rewind()?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    drop(output);

    // Keep the verified file open without write or delete sharing through the installer's terminal.
    let installer = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&executable)?;
    verify_reader(&key, &installer, &encoded, &request.version)?;
    let mut command = Command::new(&executable);
    command
        .args(["/S", "/SWB-STAGE"])
        .current_dir(paths.staged())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let status = wait_for_installer(command.spawn()?)?;
    if !status.success() {
        return Err(format!("NSIS staging failed ({status})").into());
    }
    drop(installer);
    fs::remove_file(executable)?;
    let digest = suite_digest(paths.staged())?;
    println!(
        "{}",
        serde_json::json!({
            "operation": paths.operation(),
            "staged": paths.staged(),
            "digest": digest,
            "version": request.version,
        })
    );
    Ok(())
}

pub(super) fn read_text(path: &Path, limit: u64) -> Result<String, Box<dyn Error>> {
    let mut text = String::new();
    File::open(path)?
        .take(limit + 1)
        .read_to_string(&mut text)?;
    if text.len() as u64 > limit {
        return Err("Stage input is too large".into());
    }
    Ok(text)
}

fn require_stage_support(signature: &Signature) -> Result<(), Box<dyn Error>> {
    let mut files = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|field| field.strip_prefix("file:"));
    if files.next() != Some(STAGE_INSTALLER) || files.next().is_some() {
        return Err("Signed update does not declare the current-user NSIS stage protocol".into());
    }
    Ok(())
}

fn wait_for_installer(mut installer: Child) -> io::Result<ExitStatus> {
    let started = Instant::now();
    let error = loop {
        match installer.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) if started.elapsed() < STAGE_TIMEOUT => {
                thread::sleep(Duration::from_millis(25))
            }
            Ok(None) => {
                break io::Error::new(
                    io::ErrorKind::TimedOut,
                    "NSIS staging exceeded its deadline",
                );
            }
            Err(error) => break error,
        }
    };
    let _ = installer.kill();
    installer.wait()?;
    Err(error)
}
