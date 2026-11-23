use super::{decode, verify_reader};
use minisign_verify::PublicKey;
#[cfg(feature = "bindings")]
use serde::Deserialize;
use serial_workbench_core::Digest;
use serial_workbench_ipc::{
    create_private_directory_new,
    install_switch::{InstallPaths, suite_digest_and_size},
};
use std::{
    error::Error,
    fs::{self, OpenOptions},
    io::{self, Cursor, Read, Seek},
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
#[cfg(feature = "bindings")]
use std::{fs::File, path::PathBuf};

const STAGE_INSTALLER: &str = "serial-workbench-nsis-stage-v1.exe";
const VERIFIED_INSTALLER_PREFIX: &str = "serial-workbench-nsis-stage-v2-";
const STAGE_TIMEOUT: Duration = Duration::from_secs(120);
const FILE_SHARE_READ: u32 = 1;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) struct StagedUpdate {
    pub paths: InstallPaths,
    pub digest: Digest,
    pub size_bytes: u64,
    #[cfg(feature = "bindings")]
    pub verified: bool,
}

#[cfg(feature = "bindings")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageRequest {
    active_install: PathBuf,
    artifact: PathBuf,
    signature: PathBuf,
    public_key: String,
    version: String,
}

#[cfg(feature = "bindings")]
pub fn stage_windows_release(input: &Path) -> Result<(), Box<dyn Error>> {
    stage_from_request(input, StagePurpose::Verify)
}

#[cfg(feature = "bindings")]
pub fn measure_windows_release(input: &Path) -> Result<(), Box<dyn Error>> {
    stage_from_request(input, StagePurpose::Measure)
}

enum StagePurpose {
    #[cfg(feature = "bindings")]
    Measure,
    Verify,
}

#[cfg(feature = "bindings")]
fn stage_from_request(input: &Path, purpose: StagePurpose) -> Result<(), Box<dyn Error>> {
    let request: StageRequest = serde_json::from_str(&read_text(input, 64 * 1024)?)?;
    let encoded = read_text(&request.signature, 16 * 1024)?;
    let staged = stage(
        &request.active_install,
        File::open(&request.artifact)?,
        &request.public_key,
        &encoded,
        &request.version,
        purpose,
    )?;
    println!(
        "{}",
        serde_json::json!({
            "operation": staged.paths.operation(),
            "staged": staged.paths.staged(),
            "digest": staged.digest,
            "version": request.version,
            "suiteVerified": staged.verified,
        })
    );
    Ok(())
}

pub(crate) fn stage_download(
    active: &Path,
    artifact: &[u8],
    public_key: &str,
    signature: &str,
    version: &str,
) -> Result<StagedUpdate, Box<dyn Error>> {
    stage(
        active,
        Cursor::new(artifact),
        public_key,
        signature,
        version,
        StagePurpose::Verify,
    )
}

fn stage(
    active: &Path,
    mut input: impl Read + Seek,
    public_key: &str,
    encoded: &str,
    version: &str,
    purpose: StagePurpose,
) -> Result<StagedUpdate, Box<dyn Error>> {
    let key = PublicKey::decode(&decode(public_key)?)?;
    let signature = verify_reader(&key, &mut input, encoded, version)?;
    let expected_digest = stage_claim(signature.trusted_comment(), purpose)?;

    let paths = InstallPaths::fresh(active)?;
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

    // 保持已验签的文件不可写入或删除，直到安装器实际退出。
    let installer = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&executable)?;
    verify_reader(&key, &installer, encoded, version)?;
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
    let (digest, size_bytes) = suite_digest_and_size(paths.staged())?;
    #[cfg(feature = "bindings")]
    let verified = expected_digest.is_some();
    if expected_digest.is_some_and(|expected| expected != digest) {
        return Err("Staged Windows suite differs from the signed release digest".into());
    }
    Ok(StagedUpdate {
        paths,
        digest,
        size_bytes,
        #[cfg(feature = "bindings")]
        verified,
    })
}

#[cfg(feature = "bindings")]
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

fn stage_claim(comment: &str, purpose: StagePurpose) -> Result<Option<Digest>, Box<dyn Error>> {
    let mut files = comment
        .split('\t')
        .filter_map(|field| field.strip_prefix("file:"));
    let file = files
        .next()
        .filter(|_| files.next().is_none())
        .ok_or("Signed update does not declare a single current-user NSIS stage filename")?;
    match purpose {
        #[cfg(feature = "bindings")]
        StagePurpose::Measure if file == STAGE_INSTALLER => Ok(None),
        #[cfg(feature = "bindings")]
        StagePurpose::Measure => {
            Err("Signed update does not declare the NSIS measurement protocol".into())
        }
        StagePurpose::Verify => {
            let digest = file
                .strip_prefix(VERIFIED_INSTALLER_PREFIX)
                .and_then(|field| field.strip_suffix(".exe"))
                .ok_or("Signed update does not declare the current-user NSIS stage protocol with a suite digest")?;
            Ok(Some(Digest::try_from(digest)?))
        }
    }
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

#[cfg(all(test, feature = "bindings"))]
mod tests {
    use super::*;

    #[test]
    fn measurement_and_verified_staging_have_distinct_signed_claims() {
        let digest = "0123456789abcdef".repeat(4);
        let measured = format!("timestamp:1\tfile:{STAGE_INSTALLER}\tversion:1.2.3");
        let bound =
            format!("timestamp:1\tfile:{VERIFIED_INSTALLER_PREFIX}{digest}.exe\tversion:1.2.3");
        assert!(
            stage_claim(&measured, StagePurpose::Measure)
                .unwrap()
                .is_none()
        );
        assert!(stage_claim(&measured, StagePurpose::Verify).is_err());
        assert!(stage_claim(&bound, StagePurpose::Measure).is_err());
        assert_eq!(
            stage_claim(&bound, StagePurpose::Verify).unwrap(),
            Some(Digest::try_from(digest.as_str()).unwrap())
        );
        assert!(stage_claim(&format!("{bound}\tfile:other.exe"), StagePurpose::Verify).is_err());
        assert!(stage_claim(&bound.replace(&digest, "aabb"), StagePurpose::Verify).is_err());
    }
}
