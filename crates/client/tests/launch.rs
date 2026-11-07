use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::{ClientKind, Id, U64};
use serial_workbench_ipc::DiscoveryRecord;
use std::{
    cell::RefCell,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};

// 并行测试派生子进程时会暂时继承其它线程的复制写入 fd，CLOEXEC 要到 exec 才关闭。
// 只互斥复制与 spawn；进程启动后立即释放，保留真实客户端的并发连接与启动竞争。
static EXECUTABLE_ACCESS: Mutex<()> = Mutex::new(());

fn copy_executable(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
    let _guard = EXECUTABLE_ACCESS.lock().unwrap();
    fs::copy(from, to)
}

fn spawn_executable(command: &mut Command) -> io::Result<Child> {
    let _guard = EXECUTABLE_ACCESS.lock().unwrap();
    command.spawn()
}

fn temporary() -> tempfile::TempDir {
    let base = fs::canonicalize(std::env::temp_dir()).unwrap();
    tempfile::Builder::new()
        .prefix("sw-l-")
        .tempdir_in(base)
        .unwrap()
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

struct Fixture {
    directory: tempfile::TempDir,
    profile: PathBuf,
    adapter: PathBuf,
    stopped: RefCell<Option<(u32, U64)>>,
    owned_host: RefCell<Option<Child>>,
}

struct SupportedAdapter {
    child: Child,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}

fn finish_supported(adapter: SupportedAdapter) -> Output {
    finish(adapter.child)
}
impl Fixture {
    fn new(with_host: bool) -> Self {
        let directory = temporary();
        let profile = directory.path().join("profile 数据");
        let adapter = directory
            .path()
            .join(format!("adapter{}", std::env::consts::EXE_SUFFIX));
        let current = std::env::current_exe().unwrap();
        copy_executable(&current, &adapter).unwrap();
        if with_host {
            let filename = format!("serial-workbench-host{}", std::env::consts::EXE_SUFFIX);
            let host = current.parent().unwrap().parent().unwrap().join(&filename);
            assert!(
                host.is_file(),
                "build serial-workbench-host before this integration test"
            );
            copy_executable(host, directory.path().join(filename)).unwrap();
        }
        Self {
            directory,
            profile,
            adapter,
            stopped: RefCell::new(None),
            owned_host: RefCell::new(None),
        }
    }
    fn with_running_host() -> Self {
        let fixture = Self::new(true);
        let mut command = Command::new(fixture.directory.path().join(format!(
            "serial-workbench-host{}",
            std::env::consts::EXE_SUFFIX
        )));
        let child = spawn_executable(
            hidden(&mut command)
                .arg("--profile")
                .arg(&fixture.profile)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .unwrap();
        *fixture.owned_host.borrow_mut() = Some(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while DiscoveryRecord::read(&fixture.profile.join("host-v0/discovery.json")).is_err() {
            assert!(
                Instant::now() < deadline,
                "owned Host did not publish discovery"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        // Individual tests still require a real authenticated attach before using this Host.
        fixture
    }
    fn spawn(&self, client: &str, expected: Option<&str>) -> Child {
        self.spawn_with_gate(client, expected, None)
    }
    fn spawn_supported(&self, client: &str, expected: Option<&str>) -> SupportedAdapter {
        #[cfg(windows)]
        {
            // This explicitly permitted test Job is a controlled environment, not a claim that
            // the invoking application or an arbitrary enclosing Job allows background startup.
            let (child, job) = job_adapter(self, client, expected, true);
            SupportedAdapter { child, _job: job }
        }
        #[cfg(unix)]
        SupportedAdapter {
            child: self.spawn(client, expected),
        }
    }
    fn spawn_with_gate(&self, client: &str, expected: Option<&str>, gate: Option<&Path>) -> Child {
        let mut command = Command::new(&self.adapter);
        hidden(&mut command)
            .args(["--exact", "launch_driver", "--ignored", "--nocapture"])
            .env("SWB_LAUNCH_PROFILE", &self.profile)
            .env("SWB_LAUNCH_CLIENT", client)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(expected) = expected {
            command.env("SWB_LAUNCH_EXPECTED", expected);
        }
        if let Some(gate) = gate {
            command.env("SWB_LAUNCH_GATE", gate);
        }
        spawn_executable(&mut command).unwrap()
    }
    fn discovery(&self) -> DiscoveryRecord {
        DiscoveryRecord::read(&self.profile.join("host-v0/discovery.json")).unwrap()
    }
    fn stop_host(&self) {
        let record = self.discovery();
        kill_owned_host(record.pid);
        let deadline = Instant::now() + Duration::from_secs(5);
        while serial_workbench_ipc::profile_has_running_host(&self.profile).unwrap() {
            assert!(
                Instant::now() < deadline,
                "owned Host did not release its OS lock"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        *self.stopped.borrow_mut() = Some((record.pid, record.instance_epoch));
    }
}

#[cfg(windows)]
fn job_adapter(
    fixture: &Fixture,
    client: &str,
    expected: Option<&str>,
    breakaway: bool,
) -> (Child, std::os::windows::io::OwnedHandle) {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    let gate = fixture
        .directory
        .path()
        .join(format!("start-adapter-{}", uuid::Uuid::new_v4()));
    // The job and process are both created by this test. The gate prevents launch before assignment.
    let job = unsafe {
        let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
        OwnedHandle::from_raw_handle(handle)
    };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | if breakaway {
            JOB_OBJECT_LIMIT_BREAKAWAY_OK
        } else {
            0
        };
    assert_ne!(
        unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        },
        0
    );
    let mut child = fixture.spawn_with_gate(client, expected, Some(&gate));
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
        let error = std::io::Error::last_os_error();
        let _ = child.kill();
        let _ = child.wait();
        panic!("cannot assign owned child to test Job: {error}");
    }
    fs::write(gate, b"start").unwrap();
    (child, job)
}

#[cfg(windows)]
#[test]
fn restricted_windows_job_returns_an_explicit_failure_without_spawning_host() {
    let fixture = Fixture::new(true);
    let (child, job) = job_adapter(&fixture, "launch-restricted-job", None, false);
    let response = result(&finish(child));
    drop(job);
    assert_eq!(response["code"], "HOST_START_FAILED");
    assert!(
        response["message"]
            .as_str()
            .unwrap()
            .contains("Windows Job")
    );
    assert!(!fixture.profile.join("host-v0/discovery.json").exists());
}

#[cfg(windows)]
#[test]
fn host_survives_closing_a_job_that_explicitly_allows_breakaway() {
    let mut fixture = Fixture::new(true);
    fixture.profile.push("");
    let (child, job) = job_adapter(&fixture, "launch-permitted-job", None, true);
    let first = result(&finish(child));
    assert!(first.get("hostId").is_some(), "{first}");
    drop(job);
    let second = result(&finish(fixture.spawn("launch-after-job", None)));
    assert_eq!(first["hostId"], second["hostId"]);
    assert_eq!(first["instanceEpoch"], second["instanceEpoch"]);
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let mut owned_pid = None;
        if let Some(mut child) = self.owned_host.borrow_mut().take() {
            owned_pid = Some(child.id());
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        // Only this fixture creates Hosts in this fresh profile. Never enumerate global processes.
        if let Ok(record) = DiscoveryRecord::read(&self.profile.join("host-v0/discovery.json"))
            && owned_pid != Some(record.pid)
            && self.stopped.borrow().as_ref() != Some(&(record.pid, record.instance_epoch))
        {
            kill_owned_host(record.pid);
        }
    }
}

#[cfg(windows)]
fn kill_owned_host(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            OpenProcess, PROCESS_TERMINATE, SYNCHRONIZATION_SYNCHRONIZE, TerminateProcess,
            WaitForSingleObject,
        },
    };
    // PID comes only from this test's private profile; keep the handle until termination completes.
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZATION_SYNCHRONIZE, 0, pid);
        if !process.is_null() {
            TerminateProcess(process, 0);
            WaitForSingleObject(process, 5000);
            CloseHandle(process);
        }
    }
}
#[cfg(unix)]
fn kill_owned_host(pid: u32) {
    // PID comes only from this test's private profile.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

fn finish(mut child: Child) -> Output {
    fn read_pipe(reader: impl Read + Send + 'static) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            reader.take(65_537).read_to_end(&mut bytes).unwrap();
            let _ = send.send(bytes);
        });
        receive
    }
    let stdout = read_pipe(child.stdout.take().unwrap());
    let stderr = read_pipe(child.stderr.take().unwrap());
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("controlled launch adapter exceeded deadline");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let status = child.wait().unwrap();
    let stdout = stdout
        .recv_timeout(Duration::from_secs(2))
        .expect("adapter stdout did not reach EOF after adapter exit");
    let stderr = stderr
        .recv_timeout(Duration::from_secs(2))
        .expect("adapter stderr did not reach EOF after adapter exit");
    assert!(
        stdout.len() <= 65_536 && stderr.len() <= 65_536,
        "adapter output exceeded test budget"
    );
    Output {
        status,
        stdout,
        stderr,
    }
}
fn result(output: &Output) -> serde_json::Value {
    assert!(
        output.status.success(),
        "adapter failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "Host diagnostics leaked into adapter stderr"
    );
    let stdout = std::str::from_utf8(&output.stdout).unwrap();
    let value = stdout
        .split_once("SWB_RESULT=")
        .and_then(|(_, value)| value.lines().next())
        .unwrap_or_else(|| panic!("adapter result missing: {stdout}"));
    serde_json::from_str(value).unwrap()
}

#[test]
fn first_launch_is_authenticated_and_host_survives_adapter_exit_in_supported_environment() {
    // Omitting spawn, attaching before authentication, or killing on adapter exit breaks this.
    let fixture = Fixture::new(true);
    let first = result(&finish_supported(
        fixture.spawn_supported("launch-first", None),
    ));
    assert!(first.get("hostId").is_some(), "{first}");
    let record = fixture.discovery();
    let second = result(&finish(fixture.spawn("launch-second", None)));
    assert_eq!(first["hostId"], second["hostId"]);
    assert_eq!(first["instanceEpoch"], second["instanceEpoch"]);
    assert_eq!(record.pid, fixture.discovery().pid);
}

#[test]
fn concurrent_first_clients_attach_the_same_surviving_host_in_supported_environment() {
    let fixture = Fixture::new(true);
    let left = fixture.spawn_supported("launch-left", None);
    let right = fixture.spawn_supported("launch-right", None);
    let left = result(&finish_supported(left));
    let right = result(&finish_supported(right));
    assert!(left.get("hostId").is_some(), "{left}");
    assert_eq!(left["hostId"], right["hostId"]);
    assert_eq!(left["instanceEpoch"], right["instanceEpoch"]);
    let record = fixture.discovery();
    let third = result(&finish(fixture.spawn("launch-third", None)));
    assert_eq!(left["instanceEpoch"], third["instanceEpoch"]);
    assert_eq!(record.pid, fixture.discovery().pid);
}

#[test]
fn concurrent_first_connections_of_one_client_reuse_one_saved_credential() {
    let fixture = Fixture::with_running_host();
    let bootstrap = result(&finish(fixture.spawn("launch-prepare", None)));
    assert!(bootstrap.get("hostId").is_some(), "{bootstrap}");
    let children: Vec<_> = (0..12)
        .map(|_| fixture.spawn("launch-shared-client", None))
        .collect();
    let responses: Vec<_> = children
        .into_iter()
        .map(|child| result(&finish(child)))
        .collect();
    for response in &responses {
        assert!(response.get("hostId").is_some(), "{response}");
        assert_eq!(response["actorId"], responses[0]["actorId"]);
        assert_eq!(response["instanceEpoch"], bootstrap["instanceEpoch"]);
    }
    let reconnect = result(&finish(fixture.spawn("launch-shared-client", None)));
    assert_eq!(reconnect["actorId"], responses[0]["actorId"]);
}

#[tokio::test]
async fn connect_waits_for_the_same_clients_registration_lock_before_authentication() {
    use sha2::{Digest as _, Sha256};
    let fixture = Fixture::with_running_host();
    let first = result(&finish(fixture.spawn("launch-lock-prepare", None)));
    assert!(first.get("hostId").is_some(), "{first}");
    let client_id = Id::try_from("launch-locked-client").unwrap();
    let path = fixture.profile.join("host-v0/clients").join(format!(
        "{:x}.lock",
        Sha256::digest(client_id.as_str().as_bytes())
    ));
    let guard = serial_workbench_ipc::try_lock_private_file(&path)
        .unwrap()
        .unwrap();
    let options = ConnectOptions::new(fixture.profile.clone(), client_id, ClientKind::Cli);
    let result = tokio::time::timeout(
        Duration::from_millis(250),
        HostClient::connect(options.clone()),
    )
    .await;
    let secret_was_written = path.with_extension("secret").exists();
    drop(guard);
    assert!(
        result.is_err(),
        "connection must wait before authenticating while another process owns its credential lock"
    );
    assert!(
        !secret_was_written,
        "credential was written outside its registration lock"
    );
    let client = HostClient::connect(options).await.unwrap();
    assert_eq!(
        client.attachment().host_id.as_str(),
        first["hostId"].as_str().unwrap()
    );
}

#[test]
fn missing_sibling_reports_launch_failure_without_creating_identity_in_supported_environment() {
    let fixture = Fixture::new(false);
    let response = result(&finish_supported(
        fixture.spawn_supported("launch-missing", None),
    ));
    assert_eq!(response["code"], "HOST_START_FAILED");
    assert!(
        response["message"].as_str().unwrap().contains("NotFound"),
        "{response}"
    );
    assert!(!fixture.profile.join("host-v0/identity.secret").exists());
}

#[test]
fn failed_host_output_does_not_enter_adapter_protocol_in_supported_environment() {
    let fixture = Fixture::new(false);
    // The libtest executable rejects Host's --profile argument and emits a real stderr diagnostic.
    copy_executable(
        &fixture.adapter,
        fixture.directory.path().join(format!(
            "serial-workbench-host{}",
            std::env::consts::EXE_SUFFIX
        )),
    )
    .unwrap();
    let output = finish_supported(fixture.spawn_supported("launch-failure", None));
    let response = result(&output);
    assert_eq!(response["code"], "HOST_START_FAILED");
    assert!(
        response["message"]
            .as_str()
            .unwrap()
            .contains("Host exited"),
        "{response}"
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Unrecognized option"));
    assert!(response["message"].as_str().unwrap().len() < 1024);
}

#[test]
fn identity_mismatch_does_not_launch_a_replacement() {
    let fixture = Fixture::with_running_host();
    let first = result(&finish(fixture.spawn("launch-trusted", None)));
    assert!(first.get("hostId").is_some(), "{first}");
    let before = fixture.discovery();
    let pin = fs::read(fixture.profile.join("host-v0/identity.secret")).unwrap();
    let response = result(&finish(
        fixture.spawn("launch-mismatch", Some("different-host")),
    ));
    assert_eq!(response["code"], "HOST_ID_MISMATCH");
    assert_eq!(before.pid, fixture.discovery().pid);
    assert_eq!(before.instance_epoch, fixture.discovery().instance_epoch);
    assert_eq!(
        pin,
        fs::read(fixture.profile.join("host-v0/identity.secret")).unwrap()
    );
}

#[test]
fn stopped_host_is_restarted_with_the_same_protected_identity_in_supported_environment() {
    let fixture = Fixture::new(true);
    let first = result(&finish_supported(
        fixture.spawn_supported("launch-restart", None),
    ));
    assert!(first.get("hostId").is_some(), "{first}");
    fixture.stop_host();
    let second = result(&finish_supported(
        fixture.spawn_supported("launch-restart", None),
    ));
    assert!(second.get("hostId").is_some(), "{second}");
    assert_eq!(first["hostId"], second["hostId"]);
    assert_ne!(first["instanceEpoch"], second["instanceEpoch"]);
}

#[test]
fn corrupted_saved_identity_is_not_repaired_by_starting_a_host() {
    let fixture = Fixture::with_running_host();
    let first = result(&finish(fixture.spawn("launch-corrupted", None)));
    assert!(first.get("hostId").is_some(), "{first}");
    let record = fixture.discovery();
    fixture.stop_host();
    let namespace = fixture.profile.join("host-v0");
    serial_workbench_ipc::write_atomic(&namespace.join("identity.secret"), b"broken-private-pin")
        .unwrap();
    let response = result(&finish(fixture.spawn("launch-corrupted", None)));
    assert!(response.get("code").is_some(), "{response}");
    assert_eq!(record.instance_epoch, fixture.discovery().instance_epoch);
    assert_eq!(
        fs::read(namespace.join("identity.secret")).unwrap(),
        b"broken-private-pin"
    );
}

#[tokio::test]
async fn reconnect_preserves_identity_and_does_not_start_a_stopped_host() {
    let fixture = Fixture::with_running_host();
    let options = ConnectOptions::new(
        fixture.profile.clone(),
        Id::try_from("launch-reconnect").unwrap(),
        ClientKind::Cli,
    );
    let first = HostClient::connect(options).await.unwrap();
    let second = first.reconnect().await.unwrap();
    assert_eq!(first.attachment().actor_id, second.attachment().actor_id);
    assert_eq!(
        first.attachment().instance_epoch,
        second.attachment().instance_epoch
    );
    fixture.stop_host();
    let error = first
        .reconnect()
        .await
        .err()
        .expect("reconnect must not launch a Host");
    assert!(
        matches!(error.code.as_str(), "HOST_BUSY" | "STORAGE_UNAVAILABLE"),
        "{error}"
    );
    assert!(!serial_workbench_ipc::profile_has_running_host(&fixture.profile).unwrap());
}

#[test]
fn booting_host_lock_is_waited_for_without_launching_another_candidate() {
    let fixture = Fixture::new(false);
    let namespace = fixture.profile.join("host-v0");
    serial_workbench_ipc::prepare_private_directory(&namespace).unwrap();
    let _lock = serial_workbench_ipc::try_lock_private_file(
        &namespace.join(serial_workbench_ipc::INSTANCE_LOCK_NAME),
    )
    .unwrap()
    .unwrap();
    let response = result(&finish(fixture.spawn("launch-booting", None)));
    assert_eq!(response["code"], "HOST_BUSY");
    assert!(!namespace.join("identity.secret").exists());
}

#[tokio::test]
#[ignore = "controlled subprocess fixture, invoked only by the parent tests"]
async fn launch_driver() {
    let profile = std::env::var_os("SWB_LAUNCH_PROFILE").expect("controlled driver only");
    let client = std::env::var("SWB_LAUNCH_CLIENT").unwrap();
    if let Some(gate) = std::env::var_os("SWB_LAUNCH_GATE") {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !Path::new(&gate).exists() {
            assert!(
                Instant::now() < deadline,
                "test parent did not open the launch gate"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    let mut options = ConnectOptions::new(
        Path::new(&profile).to_path_buf(),
        Id::try_from(client.as_str()).unwrap(),
        ClientKind::Cli,
    );
    options.expected_host_id = std::env::var("SWB_LAUNCH_EXPECTED")
        .ok()
        .map(|id| Id::try_from(id.as_str()).unwrap());
    let response = match HostClient::connect_or_start(options).await {
        Ok(client) => serde_json::to_value(client.attachment()).unwrap(),
        Err(error) => serde_json::to_value(error).unwrap(),
    };
    println!("SWB_RESULT={response}");
    // No libtest epilogue; this is the adapter process's actual exit, with no Host cleanup.
    std::process::exit(0);
}
