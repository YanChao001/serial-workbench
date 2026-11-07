use serial_workbench_host::ipc::InstanceGuard;
use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

fn temporary_profile() -> TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}

#[test]
fn newly_created_instance_lock_is_private_and_can_be_reopened_without_repair() {
    let profile = temporary_profile();
    let owner = InstanceGuard::acquire(profile.path()).unwrap();
    assert!(serial_workbench_ipc::profile_has_running_host(profile.path()).unwrap());
    drop(owner);
    let path = profile.path().join("host-v0/instance.lock");
    let reopened = serial_workbench_ipc::try_lock_private_file(&path)
        .unwrap()
        .unwrap();
    assert!(serial_workbench_ipc::profile_has_running_host(profile.path()).unwrap());
    drop(reopened);
    assert!(!serial_workbench_ipc::profile_has_running_host(profile.path()).unwrap());
    assert!(InstanceGuard::acquire(profile.path()).is_ok());
}

// 每个测试只停止自己创建且仍持有句柄的子进程。
struct Children(Vec<Child>);
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

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready() {
        assert!(Instant::now() < deadline, "owned child process timed out");
        thread::sleep(Duration::from_millis(10));
    }
}

fn spawn_contenders(profile: &Path, count: usize) -> Children {
    let mut children = Children(Vec::with_capacity(count));
    for slot in 0..count {
        let mut command = Command::new(std::env::current_exe().unwrap());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        children.0.push(
            command
                .args(["--exact", "instance_lock_child", "--ignored", "--nocapture"])
                .env("SWB_LOCK_TEST_PROFILE", profile)
                .env("SWB_LOCK_TEST_SLOT", slot.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap(),
        );
    }
    children
}

#[test]
#[ignore = "仅由拥有临时 profile 的父测试调用的进程入口"]
fn instance_lock_child() {
    let profile = std::env::var_os("SWB_LOCK_TEST_PROFILE").expect("owned child profile");
    let profile = Path::new(&profile);
    let slot = std::env::var("SWB_LOCK_TEST_SLOT").unwrap();
    wait_until(|| profile.join("start").exists());
    let result = InstanceGuard::acquire(profile);
    let status = match &result {
        Ok(_) => "acquired",
        Err(error) => error.code.as_str(),
    };
    let pending = profile.join(format!("pending-{slot}"));
    fs::write(&pending, status).unwrap();
    fs::rename(pending, profile.join(format!("result-{slot}"))).unwrap();
    // 保持 Result 中的 guard，防止忙进程退出后顺序误计成多个成功。
    wait_until(|| profile.join("release").exists());
    drop(result);
}

#[test]
fn twenty_processes_same_profile_have_exactly_one_live_owner() {
    let profile = temporary_profile();
    let mut children = spawn_contenders(profile.path(), 20);
    fs::write(profile.path().join("start"), b"").unwrap();
    wait_until(|| (0..20).all(|slot| profile.path().join(format!("result-{slot}")).exists()));
    let results: Vec<_> = (0..20)
        .map(|slot| fs::read_to_string(profile.path().join(format!("result-{slot}"))).unwrap())
        .collect();
    assert_eq!(
        results
            .iter()
            .filter(|result| *result == "acquired")
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| *result == "HOST_BUSY")
            .count(),
        19
    );
    assert!(
        matches!(InstanceGuard::acquire(profile.path()), Err(error) if error.code == "HOST_BUSY")
    );
    fs::write(profile.path().join("release"), b"").unwrap();
    for child in &mut children.0 {
        assert!(child.wait().unwrap().success());
    }
    assert!(InstanceGuard::acquire(profile.path()).is_ok());
}

#[test]
fn stale_discovery_pid_cannot_steal_a_live_lock() {
    let profile = temporary_profile();
    let owner = InstanceGuard::acquire(profile.path()).unwrap();
    let runtime = profile.path().join("host-v0");
    fs::create_dir_all(&runtime).unwrap();
    fs::write(
        runtime.join("discovery.json"),
        br#"{"hostId":"stale-host","instanceEpoch":"1","endpoint":"stale-endpoint","pid":4294967295,"protocolVersion":"0.1"}"#,
    )
    .unwrap();
    let mut children = spawn_contenders(profile.path(), 1);
    fs::write(profile.path().join("start"), b"").unwrap();
    wait_until(|| profile.path().join("result-0").exists());
    assert_eq!(
        fs::read_to_string(profile.path().join("result-0")).unwrap(),
        "HOST_BUSY"
    );
    fs::write(profile.path().join("release"), b"").unwrap();
    assert!(children.0[0].wait().unwrap().success());
    drop(owner);
    InstanceGuard::acquire(profile.path())
        .unwrap_or_else(|error| panic!("released instance lock remains unavailable: {error:?}"));
}
