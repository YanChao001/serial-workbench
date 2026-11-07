use crate::{ConnectOptions, HostClient, discovery};
use serial_workbench_core::{HostError, HostResult};
#[cfg(unix)]
use std::process::Stdio;
use std::{path::PathBuf, time::Duration};
#[cfg(unix)]
use tokio::process::{Child, Command};
use tokio::time::{Instant, sleep, timeout_at};
#[cfg(unix)]
type StartedHost = Child;
#[cfg(windows)]
type StartedHost = std::os::windows::io::OwnedHandle;

const STARTUP_LIMIT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The Host shipped beside this client. No PATH lookup or older-installation fallback.
pub fn adjacent_host_executable() -> HostResult<PathBuf> {
    let executable = std::env::current_exe().map_err(spawn_error)?;
    let parent = executable
        .parent()
        .ok_or_else(|| start_failed("Client executable has no parent directory"))?;
    Ok(parent.join(format!(
        "serial-workbench-host{}",
        std::env::consts::EXE_SUFFIX
    )))
}

impl HostClient {
    /// Attach first, or start the adjacent Host after the existing OS instance lock proves idle.
    /// Readiness requires the normal authenticated attach. No business request is replayed.
    pub async fn connect_or_start(options: ConnectOptions) -> HostResult<Self> {
        let deadline = Instant::now() + STARTUP_LIMIT;
        let last_code = match timeout_at(deadline, Self::connect_for_startup(options.clone())).await
        {
            Ok(Ok(client)) => return Ok(client),
            Ok(Err(error)) if retryable_attachment(&error) => error.code,
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(waiting_for_host()),
        };
        let running = instance_running(&options, deadline).await?;
        Self::connect_after_probe(options, deadline, running, last_code).await
    }

    async fn connect_after_probe(
        options: ConnectOptions,
        deadline: Instant,
        running: bool,
        mut last_code: String,
    ) -> HostResult<Self> {
        let mut child = if running {
            None
        } else {
            let validate = options.clone();
            let preflight = timeout_at(
                deadline,
                tokio::task::spawn_blocking(move || discovery::validate_start(&validate)),
            )
            .await
            .map_err(|_| waiting_for_host())?
            .map_err(|_| start_failed("Host identity check could not complete"))?;
            match preflight {
                Ok(()) => Some(start_host(&options)?),
                Err(error) => {
                    // A contender can acquire the OS lock after our idle probe and legitimately
                    // expose incomplete bootstrap files. Only its lock, not those files, proves liveness.
                    if instance_running(&options, deadline).await? {
                        None
                    } else {
                        return Err(error);
                    }
                }
            }
        };
        loop {
            if Instant::now() >= deadline {
                break;
            }
            sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now()))).await;
            match timeout_at(deadline, Self::connect_for_startup(options.clone())).await {
                Ok(Ok(client)) => return Ok(client),
                Ok(Err(error)) if retryable_attachment(&error) => last_code = error.code,
                Ok(Err(error)) => return Err(error),
                Err(_) => break,
            }
        }
        // A losing candidate may exit while the winning Host is still booting. Give authenticated
        // attachment the full deadline, rather than mistaking that candidate's exit for global failure.
        match child.as_mut() {
            Some(child) => {
                let status = child_status(child)?;
                let reason = status.map_or_else(
                    || "Host is not ready".to_owned(),
                    |status| format!("Host exited with {status}"),
                );
                Err(start_failed(&format!(
                    "{reason} before authenticated attachment (last code {last_code}); start the adjacent serial-workbench-host --profile <directory> from an independent terminal to inspect"
                )))
            }
            None => Err(waiting_for_host()),
        }
    }
}

fn retryable_attachment(error: &HostError) -> bool {
    matches!(error.code.as_str(), "STORAGE_UNAVAILABLE" | "HOST_BUSY")
}

async fn instance_running(options: &ConnectOptions, deadline: Instant) -> HostResult<bool> {
    let profile = options.profile.clone();
    timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || {
            serial_workbench_ipc::profile_has_running_host(&profile)
        }),
    )
    .await
    .map_err(|_| waiting_for_host())?
    .map_err(|_| start_failed("Host instance check could not complete"))?
}

#[cfg(unix)]
fn start_host(options: &ConnectOptions) -> HostResult<StartedHost> {
    let mut command = Command::new(adjacent_host_executable()?);
    command
        .arg("--profile")
        .arg(&options.profile)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    configure_background(&mut command)?;
    command.spawn().map_err(spawn_error)
}

#[cfg(unix)]
fn child_status(child: &mut StartedHost) -> HostResult<Option<String>> {
    child
        .try_wait()
        .map(|status| status.map(|status| status.to_string()))
        .map_err(spawn_error)
}

#[cfg(windows)]
fn child_status(child: &mut StartedHost) -> HostResult<Option<String>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Threading::GetExitCodeProcess;
    let mut code = 0;
    if unsafe { GetExitCodeProcess(child.as_raw_handle(), &mut code) } == 0 {
        return Err(spawn_error(std::io::Error::last_os_error()));
    }
    Ok((code != 259).then(|| code.to_string()))
}

#[cfg(windows)]
fn start_host(options: &ConnectOptions) -> HostResult<StartedHost> {
    use std::{
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Security::SECURITY_ATTRIBUTES,
        Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
        System::Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
            InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES,
            STARTUPINFOEXW, UpdateProcThreadAttribute,
        },
    };
    let flags = windows_creation_flags()?;
    let executable = adjacent_host_executable()?;
    let mut application: Vec<u16> = executable.as_os_str().encode_wide().collect();
    let mut command_line = windows_argument(executable.as_os_str())?;
    command_line.extend(" --profile ".encode_utf16());
    command_line.extend(windows_argument(options.profile.as_os_str())?);
    command_line.push(0);
    application.push(0);
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    // Only this NUL handle may cross the process boundary. Command's stable Windows API otherwise
    // inherits unrelated adapter pipe handles even when all three stdio streams are redirected.
    let raw_null = unsafe {
        CreateFileW(
            [78, 85, 76, 0].as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &security,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if raw_null == INVALID_HANDLE_VALUE {
        return Err(spawn_error(std::io::Error::last_os_error()));
    }
    let null_file = unsafe { OwnedHandle::from_raw_handle(raw_null) };
    let inherited = [null_file.as_raw_handle()];
    let mut size = 0;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
    }
    if size == 0 {
        return Err(spawn_error(std::io::Error::last_os_error()));
    }
    let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
    let list: LPPROC_THREAD_ATTRIBUTE_LIST = storage.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
        return Err(spawn_error(std::io::Error::last_os_error()));
    }
    struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
    impl Drop for Attributes {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.0);
            }
        }
    }
    // Drop the initialized list before its aligned storage, handle array and NUL handle.
    let _attributes = Attributes(list);
    if unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited.as_ptr().cast(),
            std::mem::size_of_val(&inherited),
            null_mut(),
            null_mut(),
        )
    } == 0
    {
        return Err(spawn_error(std::io::Error::last_os_error()));
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = null_file.as_raw_handle();
    startup.StartupInfo.hStdOutput = null_file.as_raw_handle();
    startup.StartupInfo.hStdError = null_file.as_raw_handle();
    startup.lpAttributeList = list;
    let mut process = PROCESS_INFORMATION::default();
    if unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            flags | EXTENDED_STARTUPINFO_PRESENT,
            null(),
            null(),
            &startup.StartupInfo,
            &mut process,
        )
    } == 0
    {
        return Err(spawn_error(std::io::Error::last_os_error()));
    }
    // These handles are created only on success. Dropping the process handle never terminates Host.
    let _thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    Ok(unsafe { OwnedHandle::from_raw_handle(process.hProcess) })
}

#[cfg(windows)]
fn windows_argument(argument: &std::ffi::OsStr) -> HostResult<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    let mut result = vec![34];
    let mut slashes = 0;
    for unit in argument.encode_wide() {
        if unit == 0 {
            return Err(start_failed(
                "Host startup argument contains a null character",
            ));
        }
        if unit == 92 {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            92,
            if unit == 34 { slashes * 2 + 1 } else { slashes },
        ));
        result.push(unit);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n(92, slashes * 2));
    result.push(34);
    Ok(result)
}

#[cfg(unix)]
fn configure_background(command: &mut Command) -> HostResult<()> {
    // setsid is async-signal-safe; the pre-exec closure performs no allocation or locking.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    Ok(())
}

#[cfg(windows)]
fn windows_creation_flags() -> HostResult<u32> {
    use windows_sys::Win32::System::{
        JobObjects::{
            IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            QueryInformationJobObject,
        },
        Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NO_WINDOW, GetCurrentProcess},
    };
    let failure = || {
        start_failed(
            "The parent Windows Job does not permit independent Host startup; start the adjacent serial-workbench-host --profile <directory> from an independent terminal",
        )
    };
    let mut flags = CREATE_NO_WINDOW;
    let mut in_job = 0;
    // All pointers reference initialized stack storage; the current-process pseudo handle is borrowed.
    unsafe {
        if IsProcessInJob(GetCurrentProcess(), std::ptr::null_mut(), &mut in_job) == 0 {
            return Err(failure());
        }
        if in_job != 0 {
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            if QueryInformationJobObject(
                std::ptr::null_mut(),
                JobObjectExtendedLimitInformation,
                (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(failure());
            }
            let limits = limits.BasicLimitInformation.LimitFlags;
            if limits & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK != 0 {
                // The OS applies the Job's configured silent breakaway policy.
            } else if limits & JOB_OBJECT_LIMIT_BREAKAWAY_OK != 0 {
                flags |= CREATE_BREAKAWAY_FROM_JOB;
            } else {
                return Err(failure());
            }
        }
    }
    Ok(flags)
}

fn spawn_error(error: std::io::Error) -> HostError {
    start_failed(&format!(
        "Unable to start the adjacent Host (OS kind {:?}, code {:?}); start serial-workbench-host --profile <directory> from an independent terminal",
        error.kind(),
        error.raw_os_error()
    ))
}
fn start_failed(message: &str) -> HostError {
    HostError::new("HOST_START_FAILED", message)
}
fn waiting_for_host() -> HostError {
    HostError::new(
        "HOST_BUSY",
        "The existing Host did not complete authenticated attachment before the startup deadline",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_core::{ClientKind, Id};
    use std::{
        fs,
        path::Path,
        process::{Child as OwnedChild, Command as TestCommand, Stdio},
    };

    struct Children(Vec<OwnedChild>);
    impl Drop for Children {
        fn drop(&mut self) {
            for child in &mut self.0 {
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
        }
    }

    fn hidden(command: &mut TestCommand) -> &mut TestCommand {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
    }

    fn profile() -> tempfile::TempDir {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        tempfile::Builder::new()
            .prefix("sw-probe-")
            .tempdir_in(base)
            .unwrap()
    }

    #[tokio::test]
    async fn preflight_race_waits_for_the_new_lock_owner_then_authenticates() {
        let directory = profile();
        let options = ConnectOptions::new(
            directory.path().to_path_buf(),
            Id::try_from("probe-race").unwrap(),
            ClientKind::Cli,
        );
        let failed_attach = HostClient::connect_for_startup(options.clone())
            .await
            .err()
            .unwrap();
        // The production continuation receives the actual first probe result before another owner starts.
        let running = serial_workbench_ipc::profile_has_running_host(directory.path()).unwrap();
        assert!(!running);
        let executable = std::env::current_exe().unwrap();
        let mut contender = TestCommand::new(&executable);
        let mut children = Children(vec![
            hidden(&mut contender)
                .args([
                    "--ignored",
                    "--exact",
                    "launch::tests::booting_contender_driver",
                    "--nocapture",
                ])
                .env("SWB_PREFLIGHT_PROFILE", directory.path())
                .spawn()
                .unwrap(),
        ]);
        let checkpoint_deadline = Instant::now() + Duration::from_secs(5);
        while !directory.path().join("checkpoint").exists() {
            assert!(
                Instant::now() < checkpoint_deadline,
                "contender did not reach booting checkpoint"
            );
            sleep(Duration::from_millis(5)).await;
        }
        assert!(serial_workbench_ipc::profile_has_running_host(directory.path()).unwrap());
        assert_eq!(
            discovery::validate_start(&options).unwrap_err().code,
            "UNAUTHENTICATED"
        );
        let mut attachment = Box::pin(HostClient::connect_after_probe(
            options,
            Instant::now() + STARTUP_LIMIT,
            running,
            failed_attach.code,
        ));
        let premature =
            match tokio::time::timeout(Duration::from_millis(150), &mut attachment).await {
                Err(_) => None,
                Ok(Err(error)) => Some(error.code),
                Ok(Ok(_)) => Some("unexpected ready".into()),
            };
        fs::write(directory.path().join("release"), b"continue").unwrap();
        assert!(children.0[0].wait().unwrap().success());
        assert!(
            premature.is_none(),
            "preflight race returned before the lock owner finished booting: {premature:?}"
        );
        let host_path = executable.parent().unwrap().parent().unwrap().join(format!(
            "serial-workbench-host{}",
            std::env::consts::EXE_SUFFIX
        ));
        assert!(
            host_path.is_file(),
            "build Host before the controlled launch regression"
        );
        let mut host = TestCommand::new(host_path);
        children.0.push(
            hidden(&mut host)
                .arg("--profile")
                .arg(directory.path())
                .spawn()
                .unwrap(),
        );
        let client = attachment.await.unwrap();
        let record = serial_workbench_ipc::DiscoveryRecord::read(
            &directory.path().join("host-v0/discovery.json"),
        )
        .unwrap();
        assert_eq!(record.pid, children.0[1].id());
        assert_eq!(client.attachment().host_id, record.host_id);
    }

    #[tokio::test]
    async fn preflight_failure_without_a_new_lock_owner_preserves_the_error() {
        let directory = profile();
        let namespace = directory.path().join("host-v0");
        serial_workbench_ipc::prepare_private_directory(&namespace).unwrap();
        fs::write(
            namespace.join("state.sqlite3"),
            b"incomplete initialization",
        )
        .unwrap();
        let options = ConnectOptions::new(
            directory.path().to_path_buf(),
            Id::try_from("probe-idle").unwrap(),
            ClientKind::Cli,
        );
        let expected = discovery::validate_start(&options).unwrap_err();
        let error = HostClient::connect_after_probe(
            options,
            Instant::now() + STARTUP_LIMIT,
            false,
            "STORAGE_UNAVAILABLE".into(),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error, expected);
        assert!(!namespace.join("identity.secret").exists());
    }

    #[test]
    #[ignore = "controlled bootstrap-checkpoint subprocess, invoked by its parent test"]
    fn booting_contender_driver() {
        let directory = std::env::var_os("SWB_PREFLIGHT_PROFILE").expect("controlled child only");
        let directory = Path::new(&directory);
        let namespace = directory.join("host-v0");
        serial_workbench_ipc::prepare_private_directory(&namespace).unwrap();
        let guard = serial_workbench_ipc::try_lock_private_file(
            &namespace.join(serial_workbench_ipc::INSTANCE_LOCK_NAME),
        )
        .unwrap()
        .unwrap();
        // Reproduce exactly the externally visible bootstrap checkpoint: DB exists, pin not yet written.
        // No SQLite contents are consumed by preflight. The real Host completes attachment after release.
        let pending_database = namespace.join("state.sqlite3");
        fs::write(&pending_database, b"initializing").unwrap();
        fs::write(directory.join("checkpoint"), b"locked").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !directory.join("release").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "test parent did not release checkpoint"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        fs::remove_file(pending_database).unwrap();
        drop(guard);
        std::process::exit(0);
    }
}
