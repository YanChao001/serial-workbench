use super::UpdatePolicy;
use crate::update_signature::{
    windows_stage::stage_download,
    windows_switch::{
        DesktopExit, RegisteredRelease, SuiteDigests, SwitchPhase, replace_windows_suite,
    },
};
use serde::{Deserialize, Serialize};
use serial_workbench_core::RequestId;
use serial_workbench_ipc::{
    create_private_directory_new, current_process_creation_time,
    install_switch::{InstallRegistration, suite_digest},
};
use std::{
    env,
    error::Error,
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{self, Command, Stdio},
    sync::mpsc,
    thread,
    time::Duration,
};
use tauri_plugin_updater::Update;

const EXECUTABLE: &str = "serial-workbench.exe";
const COORDINATE: &str = "--swb-coordinate-windows-update";
const READY: &[u8] = b"serial-workbench update ready\n";
const READY_TIMEOUT: Duration = Duration::from_secs(45);
const REQUEST_LIMIT: usize = 64 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UpdateRequest {
    profile: PathBuf,
    active: PathBuf,
    operation: RequestId,
    suites: SuiteDigests,
}

pub(super) struct PreparedUpdate {
    coordinator: PathBuf,
    request: UpdateRequest,
}

pub(super) fn prepare(
    profile: PathBuf,
    product: String,
    policy: &UpdatePolicy,
    update: &Update,
    bytes: &[u8],
) -> Result<PreparedUpdate, Box<dyn Error>> {
    let executable = env::current_exe()?.canonicalize()?;
    if executable.file_name() != Some(OsStr::new(EXECUTABLE)) {
        return Err("Unexpected desktop executable for a current-user NSIS update".into());
    }
    let active = executable
        .parent()
        .ok_or("Missing current install directory")?;
    let staged = stage_download(
        active,
        bytes,
        &policy.public_key,
        &update.signature,
        &update.version,
    )?;
    let operation = staged.paths.operation().clone();
    let previous = suite_digest(active)?;
    let candidate_kib = u32::try_from(staged.size_bytes.div_ceil(1024))?;
    InstallRegistration::capture(
        active,
        &product,
        &update.current_version,
        &update.version,
        candidate_kib,
    )?;
    let coordinator = coordinator_path(active, &operation)?;
    let work = coordinator
        .parent()
        .ok_or("Missing update coordinator directory")?;
    let _directory = create_private_directory_new(work)?;
    let mut copy = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&coordinator)?;
    io::copy(&mut File::open(&executable)?, &mut copy)?;
    copy.sync_all()?;
    let request = UpdateRequest {
        profile,
        active: active.to_path_buf(),
        operation,
        suites: SuiteDigests {
            previous,
            candidate: staged.digest,
            registration: Some(RegisteredRelease {
                product,
                previous_version: update.current_version.clone(),
                candidate_version: update.version.clone(),
                candidate_kib,
            }),
            desktop: Some(DesktopExit {
                pid: process::id(),
                created: current_process_creation_time()?.into(),
                image: PathBuf::from(EXECUTABLE),
            }),
        },
    };
    Ok(PreparedUpdate {
        coordinator,
        request,
    })
}

impl PreparedUpdate {
    /// 在协调器取得排他锁前保留旧桌面。超时或断管让旧桌面继续运行。
    pub(super) fn start(self) -> Result<(), Box<dyn Error>> {
        let request = serde_json::to_vec(&self.request)?;
        if request.len() > REQUEST_LIMIT {
            return Err("Windows update coordinator request is too large".into());
        }
        let work = self
            .coordinator
            .parent()
            .ok_or("Missing update coordinator directory")?;
        let mut child = Command::new(&self.coordinator)
            .arg(COORDINATE)
            .current_dir(work)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
        let mut input = child.stdin.take().expect("piped coordinator input");
        let mut output = child.stdout.take().expect("piped coordinator output");
        let (send, receive) = mpsc::sync_channel(1);
        let exchange = thread::spawn(move || {
            let result = (|| -> io::Result<()> {
                input.write_all(&request)?;
                drop(input);
                let mut response = [0; READY.len()];
                output.read_exact(&mut response)?;
                if response != READY {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Invalid update coordinator readiness",
                    ));
                }
                Ok(())
            })();
            let _ = send.send(result);
        });
        match receive.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            result => {
                let _ = child.kill();
                child.wait()?;
                let _ = exchange.join();
                match result {
                    Ok(Err(error)) => Err(error.into()),
                    Err(error) => Err(error.into()),
                    Ok(Ok(())) => unreachable!(),
                }
            }
        }
    }
}

pub(crate) fn run_if_requested() {
    if env::args_os().nth(1).as_deref() != Some(OsStr::new(COORDINATE)) {
        return;
    }
    let result = coordinate();
    if let Err(error) = &result {
        eprintln!("{}", crate::redaction::redact(&error.to_string()));
    }
    process::exit(if result.is_ok() { 0 } else { 1 });
}

fn coordinate() -> Result<(), Box<dyn Error>> {
    if env::args_os().len() != 2 {
        return Err("Unexpected update coordinator arguments".into());
    }
    let mut input = Vec::new();
    io::stdin()
        .take((REQUEST_LIMIT + 1) as u64)
        .read_to_end(&mut input)?;
    if input.len() > REQUEST_LIMIT {
        return Err("Windows update coordinator request is too large".into());
    }
    let request: UpdateRequest = serde_json::from_slice(&input)?;
    let active = request.active.canonicalize()?;
    let coordinator = coordinator_path(&active, &request.operation)?;
    if request
        .suites
        .desktop
        .as_ref()
        .map(|desktop| desktop.image.as_path())
        != Some(Path::new(EXECUTABLE))
        || request.suites.registration.is_none()
        || env::current_exe()?.canonicalize()? != coordinator
    {
        return Err("Windows update coordinator does not match the active installation".into());
    }
    let mut recovered = false;
    let transition = replace_windows_suite(
        &request.profile,
        &active,
        &request.operation,
        &request.suites,
        |phase| match phase {
            SwitchPhase::Ready => {
                let mut output = io::stdout().lock();
                output.write_all(READY)?;
                output.flush()
            }
            SwitchPhase::Recovered => {
                recovered = true;
                Ok(())
            }
        },
    );
    // 失败路径只重启已经恢复、且整体摘要仍与原安装一致的套件。
    let restored = recovered
        && suite_digest(&active).is_ok_and(|digest| {
            digest == request.suites.previous || digest == request.suites.candidate
        });
    let result = if transition.is_ok() || restored {
        let launch = Command::new(active.join(EXECUTABLE))
            .current_dir(&active)
            .env("SWB_PROFILE", &request.profile)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        launch.map(|_| ()).map_err(Into::into).and(transition)
    } else {
        transition
    };
    if let Err(error) = &result {
        let directory = coordinator
            .parent()
            .ok_or("Missing update coordinator directory")?;
        let _ = fs::write(
            directory.join("update-error.txt"),
            crate::redaction::redact(&error.to_string()),
        );
    }
    result
}

fn coordinator_path(active: &Path, operation: &RequestId) -> Result<PathBuf, Box<dyn Error>> {
    let parent = active
        .parent()
        .ok_or("Missing parent of the active install")?;
    Ok(parent
        .join(format!(".swb-update-{operation}"))
        .join(EXECUTABLE))
}
