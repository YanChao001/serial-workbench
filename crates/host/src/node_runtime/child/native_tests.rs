//! 固定运行时公开自检边界；测试 hook 只暂停时序，不改变验签或实际进程实现。
use crate::node_runtime::{NodeRuntimeLimits, verify_node_runtime};
use crate::test_support::node_owner_exit;
use std::{
    cell::{Cell, RefCell},
    fs,
    os::unix::process::CommandExt as _,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

#[test]
fn already_exited_group_leader_can_be_stopped_before_reap() {
    use crate::node_runtime::macos_supervisor;

    let mut child = Command::new("/bin/sh")
        .args(["-c", "exit 17"])
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = (|| -> std::io::Result<()> {
        while !macos_supervisor::owner_exited(pid)? {
            if Instant::now() >= deadline {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        macos_supervisor::stop_group(pid)?;
        macos_supervisor::wait_group_gone(pid)
    })();
    assert_eq!(child.wait().unwrap().code(), Some(17));
    result.unwrap();
}

type StartupObserver = Box<dyn Fn(u32, u32, u32)>;
thread_local! {
    static BEFORE_AUTH: RefCell<Option<StartupObserver>> = RefCell::new(None);
    static BEFORE_FORK: Cell<Option<std::os::fd::RawFd>> = const { Cell::new(None) };
    static BEFORE_EXEC: Cell<Option<(std::os::fd::RawFd, std::os::fd::RawFd)>> = const { Cell::new(None) };
    static BEFORE_OBSERVER_ID: Cell<Option<std::os::fd::RawFd>> = const { Cell::new(None) };
}
pub(super) fn before_fork_descriptor() -> Option<std::os::fd::RawFd> {
    BEFORE_FORK.get()
}
pub(super) fn before_exec_descriptors() -> Option<(std::os::fd::RawFd, std::os::fd::RawFd)> {
    BEFORE_EXEC.get()
}
pub(super) fn before_observer_descriptor() -> Option<std::os::fd::RawFd> {
    BEFORE_OBSERVER_ID.get()
}
pub(super) fn observe(node: u32, supervisor: u32, observer_pid: u32) {
    BEFORE_AUTH.with_borrow(|observer| {
        if let Some(observer) = observer {
            observer(node, supervisor, observer_pid);
        }
    });
}
struct Profile(Option<tempfile::TempDir>);
impl Profile {
    fn new() -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/rust-failures");
        fs::create_dir_all(&root).unwrap();
        Self(Some(
            tempfile::Builder::new()
                .prefix("macos-node-before-auth-")
                .tempdir_in(root)
                .unwrap(),
        ))
    }
    fn path(&self) -> &Path {
        self.0.as_ref().unwrap().path()
    }
}
impl Drop for Profile {
    fn drop(&mut self) {
        if std::thread::panicking()
            && let Some(directory) = self.0.take()
        {
            eprintln!("host_test_failed_profile={}", directory.keep().display());
        }
    }
}
struct Parent(Child);
impl Drop for Parent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn copy_resources(source: &Path, target: &Path) {
    fs::create_dir(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            copy_resources(&entry.path(), &destination);
        } else {
            assert!(kind.is_file());
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}

#[test]
#[ignore = "Internal child entry: requires the owned native startup fixture directory"]
fn macos_startup_parent_fixture() {
    let directory = PathBuf::from(std::env::var_os("SWB_MACOS_STARTUP_FIXTURE").unwrap());
    let mode = std::env::var("SWB_MACOS_STARTUP_SIGNAL").unwrap();
    match mode.as_str() {
        "default" => {}
        "before-fork" | "observer-before-publish" => {}
        "sigchld-ignore" | "sigchld-no-wait" => {
            let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
            action.sa_sigaction = if mode == "sigchld-ignore" {
                libc::SIG_IGN
            } else {
                libc::SIG_DFL
            };
            action.sa_flags = if mode == "sigchld-no-wait" {
                libc::SA_NOCLDWAIT
            } else {
                0
            };
            assert_eq!(unsafe { libc::sigemptyset(&mut action.sa_mask) }, 0);
            assert_eq!(
                unsafe { libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut()) },
                0
            );
        }
        "ignore" => unsafe {
            libc::signal(libc::SIGHUP, libc::SIG_IGN);
        },
        "blocked" => {
            let mut mask = unsafe { std::mem::zeroed() };
            unsafe {
                libc::sigemptyset(&mut mask);
                libc::sigaddset(&mut mask, libc::SIGHUP);
                assert_eq!(
                    libc::pthread_sigmask(libc::SIG_BLOCK, &mask, std::ptr::null_mut()),
                    0
                );
            }
        }
        _ => panic!("Unknown native signal mode"),
    }
    let resources = directory.join("resources");
    let build_root = PathBuf::from(std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap());
    fs::create_dir(&resources).unwrap();
    copy_resources(&build_root.join("runtime"), &resources.join("runtime"));
    let limits = NodeRuntimeLimits::default();
    let runtime = verify_node_runtime(&resources, &limits, &AtomicBool::new(false)).unwrap();
    if mode.starts_with("sigchld-") {
        let report = runtime.self_test(&limits, &AtomicBool::new(false));
        let error = report.outcome.unwrap_err();
        assert_eq!(error.code, "NODE_RUNTIME_START_FAILED");
        assert_eq!(
            serde_json::to_value(&error).unwrap()["details"]["reason"],
            "parentChildWaitPolicy"
        );
        assert!(report.diagnostics.process_id.is_none());
        fs::write(directory.join("policy-rejected"), b"before spawn").unwrap();
        return;
    }
    if mode == "before-fork" || mode == "observer-before-publish" {
        use std::os::fd::AsRawFd;
        let marker = fs::File::create_new(directory.join("guardian-ready.bin")).unwrap();
        if mode == "before-fork" {
            BEFORE_FORK.set(Some(marker.as_raw_fd()));
        } else {
            BEFORE_OBSERVER_ID.set(Some(marker.as_raw_fd()));
        }
        let report = runtime.self_test(&limits, &AtomicBool::new(false));
        BEFORE_FORK.set(None);
        BEFORE_OBSERVER_ID.set(None);
        assert_eq!(
            report.outcome.unwrap_err().code,
            "NODE_RUNTIME_START_FAILED"
        );
        assert!(report.diagnostics.reaped);
        fs::write(
            directory.join("early-owner-reaped"),
            b"actual wait completed",
        )
        .unwrap();
        return;
    }
    // 保留已验证原件，再换为可执行、有效签名但身份不符的真实 Mach-O。
    fs::rename(
        runtime.executable(),
        directory.join("verified-node-original"),
    )
    .unwrap();
    fs::copy(directory.join("replacement"), runtime.executable()).unwrap();
    use std::os::fd::AsRawFd;
    let before_exec =
        std::env::var("SWB_MACOS_STARTUP_STAGE").is_ok_and(|stage| stage == "before-exec");
    let native_marker = fs::File::create_new(directory.join("before-exec.bin")).unwrap();
    let native_release = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(directory.join("release-exec"))
        .unwrap();
    if before_exec {
        BEFORE_EXEC.set(Some((
            native_marker.as_raw_fd(),
            native_release.as_raw_fd(),
        )));
    }
    BEFORE_AUTH.with_borrow_mut(|observer| {
        *observer = Some(Box::new(move |node, supervisor, observer_pid| {
            let output = Command::new("/bin/ps")
                .args(["-p", &node.to_string(), "-o", "state="])
                .output()
                .unwrap();
            assert!(output.status.success());
            let state = String::from_utf8(output.stdout).unwrap();
            fs::write(
                directory.join("ready.tmp"),
                serde_json::to_vec(
                    &serde_json::json!({"node":node,"supervisor":supervisor,"observer":observer_pid,"state":state}),
                )
                .unwrap(),
            )
            .unwrap();
            fs::rename(directory.join("ready.tmp"), directory.join("ready.json")).unwrap();
            loop {
                std::thread::park();
            }
        }))
    });
    let _ = runtime.self_test(&limits, &AtomicBool::new(false));
    panic!("The native parent fixture must be killed before authentication");
}

#[test]
#[ignore = "Requires the prepared native macOS distribution and its compiled image binding"]
fn native_macos_parent_death_before_authentication_never_executes_replaced_image() {
    let _reaper = node_owner_exit::ParentReaper::install();
    for (mode, whole_group, before_exec) in
        ["default", "ignore", "blocked"]
            .into_iter()
            .flat_map(|mode| {
                [
                    (mode, false, false),
                    (mode, true, false),
                    (mode, true, true),
                ]
            })
    {
        let profile = Profile::new();
        let source = profile.path().join("replacement.c");
        let replacement = profile.path().join("replacement");
        fs::write(&source, b"#include <fcntl.h>\n#include <stdlib.h>\n#include <unistd.h>\nint main(void){const char*p=getenv(\"SWB_MACOS_REPLACEMENT_MARKER\");if(p){int f=open(p,O_WRONLY|O_CREAT|O_EXCL,0600);if(f>=0){write(f,\"executed\",8);close(f);}}for(;;)pause();}\n").unwrap();
        assert!(
            Command::new("/usr/bin/clang")
                .arg(&source)
                .arg("-o")
                .arg(&replacement)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-", "--options", "runtime,hard,kill"])
                .arg(&replacement)
                .status()
                .unwrap()
                .success()
        );
        let marker = profile.path().join("unverified-executed");
        let mut command = Command::new(std::env::current_exe().unwrap());
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let mut parent = Parent(
            command
                .args([
                    "--ignored",
                    "--exact",
                    "node_runtime::child::native_tests::macos_startup_parent_fixture",
                    "--nocapture",
                ])
                .env("SWB_MACOS_STARTUP_FIXTURE", profile.path())
                .env("SWB_MACOS_STARTUP_SIGNAL", mode)
                .env(
                    "SWB_MACOS_STARTUP_STAGE",
                    if before_exec {
                        "before-exec"
                    } else {
                        "stopped"
                    },
                )
                .env("SWB_MACOS_REPLACEMENT_MARKER", &marker)
                .stdin(Stdio::null())
                .stdout(fs::File::create_new(profile.path().join("parent.stdout")).unwrap())
                .stderr(fs::File::create_new(profile.path().join("parent.stderr")).unwrap())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        let ready = profile.path().join(if before_exec {
            "before-exec.bin"
        } else {
            "ready.json"
        });
        while (!ready.exists() || (before_exec && fs::metadata(&ready).unwrap().len() != 12))
            && Instant::now() < deadline
        {
            assert!(
                parent.0.try_wait().unwrap().is_none(),
                "Fixture ended before pre-authentication barrier; inspect parent.stderr"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let data: serde_json::Value = if before_exec {
            let bytes = fs::read(ready).unwrap();
            assert_eq!(bytes.len(), 12);
            let pid = |offset| u32::from_ne_bytes(bytes[offset..offset + 4].try_into().unwrap());
            let node = pid(0);
            let output = Command::new("/bin/ps")
                .args(["-p", &node.to_string(), "-o", "state="])
                .output()
                .unwrap();
            assert!(output.status.success());
            serde_json::json!({"node":node,"supervisor":pid(4),"observer":pid(8),"state":String::from_utf8(output.stdout).unwrap()})
        } else {
            serde_json::from_slice(&fs::read(ready).unwrap()).unwrap()
        };
        let node_pid = u32::try_from(data["node"].as_u64().unwrap()).unwrap();
        let owner_pid = u32::try_from(data["supervisor"].as_u64().unwrap()).unwrap();
        assert!(
            data["state"].as_str().unwrap().trim().starts_with('T') != before_exec,
            "The native barrier must distinguish pre-SETEXEC from already stopped image: {data}"
        );
        assert_ne!(node_pid, owner_pid);
        let mut node = node_owner_exit::ProcessExit::new(node_pid);
        let mut owner = node_owner_exit::ProcessExit::new(owner_pid);
        let mut observer = node_owner_exit::ProcessExit::new(
            u32::try_from(data["observer"].as_u64().unwrap()).unwrap(),
        );
        assert!(!node.exited() && !owner.exited() && !observer.exited());
        assert!(!marker.exists());
        if whole_group {
            assert_eq!(
                unsafe { libc::kill(-(parent.0.id() as libc::pid_t), libc::SIGKILL) },
                0
            );
        } else {
            parent.0.kill().unwrap();
        }
        parent.0.wait().unwrap();
        if before_exec {
            fs::write(profile.path().join("release-exec"), b"R").unwrap();
        }
        assert!(
            node.wait(),
            "Stopped substituted image must exit after Host death ({mode})"
        );
        assert!(
            owner.wait(),
            "Native owner must exit after reaping Node ({mode})"
        );
        assert!(
            observer.wait(),
            "Native observer must actually exit after Host loss ({mode}, before_exec={before_exec})"
        );
        assert!(
            !marker.exists(),
            "Unverified Mach-O must never execute even when Host inherits {mode} SIGHUP"
        );
        node_owner_exit::assert_gone(node_pid);
        node_owner_exit::assert_gone(owner_pid);
    }
}

#[test]
#[ignore = "Requires the prepared native macOS distribution and its compiled image binding"]
fn native_macos_parent_wait_policy_rejects_automatic_child_reaping_before_spawn() {
    for mode in ["sigchld-ignore", "sigchld-no-wait"] {
        let profile = Profile::new();
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "node_runtime::child::native_tests::macos_startup_parent_fixture",
                "--nocapture",
            ])
            .env("SWB_MACOS_STARTUP_FIXTURE", profile.path())
            .env("SWB_MACOS_STARTUP_SIGNAL", mode)
            .stdin(Stdio::null())
            .stdout(fs::File::create_new(profile.path().join("parent.stdout")).unwrap())
            .stderr(fs::File::create_new(profile.path().join("parent.stderr")).unwrap())
            .status()
            .unwrap();
        assert!(
            result.success(),
            "Unsupported parent wait policy must be rejected without spawning Node ({mode}); inspect parent.stderr"
        );
        assert!(profile.path().join("policy-rejected").exists());
    }
}

#[test]
#[ignore = "Requires the prepared native macOS distribution and its compiled image binding"]
fn native_macos_guardian_loss_before_node_fork_returns_after_actual_reap() {
    for mode in ["before-fork", "observer-before-publish"] {
        let profile = Profile::new();
        let mut parent = Parent(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "node_runtime::child::native_tests::macos_startup_parent_fixture",
                    "--nocapture",
                ])
                .env("SWB_MACOS_STARTUP_FIXTURE", profile.path())
                .env("SWB_MACOS_STARTUP_SIGNAL", mode)
                .stdin(Stdio::null())
                .stdout(fs::File::create_new(profile.path().join("parent.stdout")).unwrap())
                .stderr(fs::File::create_new(profile.path().join("parent.stderr")).unwrap())
                .spawn()
                .unwrap(),
        );
        let marker = profile.path().join("guardian-ready.bin");
        let deadline = Instant::now() + Duration::from_secs(10);
        let bytes = loop {
            if let Ok(bytes) = fs::read(&marker)
                && bytes.len() == if mode == "before-fork" { 4 } else { 8 }
            {
                break bytes;
            }
            assert!(
                Instant::now() < deadline,
                "Guardian did not reach the native pre-fork barrier"
            );
            assert!(
                parent.0.try_wait().unwrap().is_none(),
                "Fixture failed; inspect parent.stderr"
            );
            std::thread::sleep(Duration::from_millis(5));
        };
        let pid = u32::from_ne_bytes(bytes[..4].try_into().unwrap());
        let mut guardian = node_owner_exit::ProcessExit::new(pid);
        let mut observer = (mode == "observer-before-publish").then(|| {
            node_owner_exit::ProcessExit::new(u32::from_ne_bytes(bytes[4..8].try_into().unwrap()))
        });
        assert!(!guardian.exited() && observer.as_mut().is_none_or(|observer| !observer.exited()));
        assert_eq!(
            unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) },
            0
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = parent.0.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "Host must return its failure after reaping early guardian; inspect parent.stderr"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "An unreaped guardian in its original group must not deadlock cleanup"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(profile.path().join("early-owner-reaped").exists());
        assert!(guardian.exited());
        assert!(
            observer
                .as_mut()
                .is_none_or(node_owner_exit::ProcessExit::exited),
            "An unpublished observer must also be fully reaped before the public failure returns"
        );
    }
}
