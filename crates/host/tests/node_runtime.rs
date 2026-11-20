use serial_workbench_host::node_runtime::{
    NodeRuntimeLimits, current_node_target, resource_root_for_executable, verify_node_runtime,
};
use std::{fs, sync::atomic::AtomicBool};
#[cfg(unix)]
mod support;

#[cfg(unix)]
fn copy_runtime_tree(source: &std::path::Path, destination: &std::path::Path) {
    fs::create_dir_all(destination).unwrap();
    for item in fs::read_dir(source).unwrap() {
        let item = item.unwrap();
        let path = item.path();
        let target = destination.join(item.file_name());
        let kind = item.file_type().unwrap();
        if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(path).unwrap(), target).unwrap();
        } else if kind.is_dir() {
            copy_runtime_tree(&path, &target);
        } else {
            fs::copy(path, target).unwrap();
        }
    }
}

#[cfg(unix)]
fn native_runtime_fixture() -> (support::Profile, std::path::PathBuf) {
    let source = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let source = std::path::Path::new(&source);
    let profile = support::Profile::isolated("node-runtime-execution-identity-");
    let root = profile.path().join("resources");
    fs::create_dir_all(root.join("runtime")).unwrap();
    fs::copy(
        source.join("runtime/node-release.json"),
        root.join("runtime/node-release.json"),
    )
    .unwrap();
    if source.join("runtime/node-image.json").exists() {
        fs::copy(
            source.join("runtime/node-image.json"),
            root.join("runtime/node-image.json"),
        )
        .unwrap();
    }
    copy_runtime_tree(&source.join("runtime/node"), &root.join("runtime/node"));
    (profile, root)
}

#[cfg(unix)]
fn assert_changed_runtime_cannot_execute_unverified_code(replace: bool) {
    let (_profile, root) = native_runtime_fixture();
    let limits = NodeRuntimeLimits::default();
    let cancel = AtomicBool::new(false);
    let runtime = verify_node_runtime(&root, &limits, &cancel).unwrap();
    let marker = runtime.runtime_directory().join("unverified-code-ran");
    let executable = runtime.executable();
    if replace {
        fs::rename(executable, executable.with_extension("original")).unwrap();
    } else {
        fs::copy(executable, executable.with_extension("original")).unwrap();
    }
    fs::write(executable, b"#!/bin/sh\n: > unverified-code-ran\nexit 0\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(executable, fs::Permissions::from_mode(0o755)).unwrap();
    let report = runtime.self_test(&limits, &cancel);
    assert!(
        !marker.exists(),
        "The substituted program must never run, even if ABI checks later reject it"
    );
    if let Some(pid) = report.diagnostics.process_id {
        assert!(report.diagnostics.reaped);
        assert_child_exited(pid);
    }
    if let Ok(probe) = report.outcome {
        assert_eq!(probe.version.as_str(), "26.13.0");
        assert_eq!(probe.modules_abi.get(), 147);
    }
}

#[cfg(unix)]
#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn replacing_node_after_verification_cannot_run_the_substitute() {
    assert_changed_runtime_cannot_execute_unverified_code(true);
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "Requires the prepared native macOS distribution and its compiled image binding"]
fn failed_native_exec_keeps_start_error_and_reaps_owned_processes() {
    use std::os::unix::fs::PermissionsExt;
    let (_profile, root) = native_runtime_fixture();
    let limits = NodeRuntimeLimits::default();
    let cancel = AtomicBool::new(false);
    let runtime = verify_node_runtime(&root, &limits, &cancel).unwrap();
    let mut permissions = fs::metadata(runtime.executable()).unwrap().permissions();
    permissions.set_mode(permissions.mode() & !0o111);
    fs::set_permissions(runtime.executable(), permissions).unwrap();
    let report = runtime.self_test(&limits, &cancel);
    assert_eq!(
        report.outcome.unwrap_err().code,
        "NODE_RUNTIME_START_FAILED"
    );
    assert_eq!(report.diagnostics.launch_errno, Some(libc::EACCES));
    assert_eq!(
        report.diagnostics.io_error,
        Some(std::io::Error::from_raw_os_error(libc::EACCES).to_string())
    );
    assert!(report.diagnostics.reaped);
    assert_child_exited(report.diagnostics.process_id.unwrap());
}

#[cfg(unix)]
#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn rewriting_node_after_verification_cannot_run_the_substitute() {
    assert_changed_runtime_cannot_execute_unverified_code(false);
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn changed_library_does_not_replace_the_sealed_loader_input() {
    let (_profile, root) = native_runtime_fixture();
    let limits = NodeRuntimeLimits::default();
    let cancel = AtomicBool::new(false);
    let runtime = verify_node_runtime(&root, &limits, &cancel).unwrap();
    fs::write(
        runtime.runtime_directory().join("lib/libatomic.so.1.2.0"),
        b"unverified library",
    )
    .unwrap();
    let report = runtime.self_test(&limits, &cancel);
    assert_eq!(report.outcome.unwrap().version.as_str(), "26.13.0");
    assert!(report.diagnostics.image_sealed);
    assert!(report.diagnostics.reaped);
    assert_child_exited(report.diagnostics.process_id.unwrap());
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn unlisted_library_in_the_install_directory_cannot_shadow_a_system_dependency() {
    let (_profile, root) = native_runtime_fixture();
    let limits = NodeRuntimeLimits::default();
    let cancel = AtomicBool::new(false);
    let runtime = verify_node_runtime(&root, &limits, &cancel).unwrap();
    let libraries = runtime.runtime_directory().join("lib");
    // 有效本架构 ELF 冒充 libstdc++。若旧目录仍参与搜索，Node 无法取得所需符号版本。
    fs::copy(
        libraries.join("libatomic.so.1.2.0"),
        libraries.join("libstdc++.so.6"),
    )
    .unwrap();
    let report = runtime.self_test(&limits, &cancel);
    assert_eq!(report.outcome.unwrap().version.as_str(), "26.13.0");
    assert!(report.diagnostics.image_sealed);
    assert!(report.diagnostics.reaped);
    assert_child_exited(report.diagnostics.process_id.unwrap());
}

#[test]
fn rejects_a_descriptor_that_changes_the_compiled_runtime_abi() {
    let directory = tempfile::Builder::new()
        .prefix("private-runtime-marker-")
        .tempdir()
        .unwrap();
    fs::create_dir(directory.path().join("runtime")).unwrap();
    let mut descriptor: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../resources/runtime/node-release.json"
    ))
    .unwrap();
    descriptor["modulesAbi"] = serde_json::json!("148");
    fs::write(
        directory.path().join("runtime/node-release.json"),
        serde_json::to_vec(&descriptor).unwrap(),
    )
    .unwrap();
    let error = verify_node_runtime(
        directory.path(),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert_eq!(error.code, "NODE_RUNTIME_INCOMPATIBLE");
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("private-runtime-marker-")
    );
}

#[test]
fn locates_only_resources_paired_with_the_installed_executable() {
    use serial_workbench_core::NodePackageTarget;
    let directory = tempfile::Builder::new()
        .prefix("runtime 中文 with spaces-")
        .tempdir()
        .unwrap();
    for (target, executable, resource_root) in [
        (
            NodePackageTarget::WindowsX64,
            "portable/host.exe",
            "portable",
        ),
        (
            NodePackageTarget::MacosArm64,
            "Example.app/Contents/MacOS/host",
            "Example.app/Contents/Resources",
        ),
        (
            NodePackageTarget::MacosX64,
            "Intel.app/Contents/MacOS/host",
            "Intel.app/Contents/Resources",
        ),
        (
            NodePackageTarget::LinuxX64,
            "mount/usr/bin/host",
            "mount/usr/lib/Custom Product",
        ),
    ] {
        let executable = directory.path().join(executable);
        let expected = directory.path().join(resource_root);
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::create_dir_all(&expected).unwrap();
        fs::write(&executable, "installed Host fixture").unwrap();
        assert_eq!(
            resource_root_for_executable(&executable, target, "Custom Product").unwrap(),
            expected.canonicalize().unwrap()
        );
    }
    let executable = directory.path().join("standalone/host");
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, "unpaired executable").unwrap();
    assert!(
        resource_root_for_executable(&executable, NodePackageTarget::LinuxX64, "Custom Product")
            .is_err()
    );
    assert!(
        resource_root_for_executable(&executable, NodePackageTarget::LinuxX64, "../elsewhere")
            .is_err()
    );
}

#[test]
fn diagnoses_a_foreign_executable_target_before_launch() {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir(directory.path().join("runtime")).unwrap();
    fs::write(
        directory.path().join("runtime/node-release.json"),
        include_bytes!("../../../resources/runtime/node-release.json"),
    )
    .unwrap();
    let spec = serial_workbench_core::bundled_node_runtime_release()
        .for_target(current_node_target().unwrap())
        .unwrap();
    let executable = directory
        .path()
        .join(spec.executable.resource_path.as_str());
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    let mut foreign = vec![0u8; 128];
    foreign[..2].copy_from_slice(b"MZ");
    foreign[60..64].copy_from_slice(&64u32.to_le_bytes());
    foreign[64..68].copy_from_slice(b"PE\0\0");
    foreign[68..70].copy_from_slice(&0xaa64u16.to_le_bytes());
    fs::write(executable, foreign).unwrap();
    let error = verify_node_runtime(
        directory.path(),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert_eq!(error.code, "NODE_RUNTIME_TARGET_UNSUPPORTED");
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn validates_and_probes_the_actual_pinned_native_runtime() {
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let limits = NodeRuntimeLimits::default();
    let cancel = AtomicBool::new(false);
    let runtime = verify_node_runtime(std::path::Path::new(&root), &limits, &cancel).unwrap();
    let report = runtime.self_test(&limits, &cancel);
    let probe = report.outcome.unwrap();
    assert_eq!(probe.version.as_str(), "26.13.0");
    assert_eq!(probe.modules_abi.get(), 147);
    assert_eq!(probe.node_api_version.get(), 10);
    #[cfg(not(target_os = "linux"))]
    assert_eq!(
        std::path::Path::new(&probe.exec_path)
            .canonicalize()
            .unwrap(),
        runtime.executable().canonicalize().unwrap()
    );
    #[cfg(target_os = "linux")]
    assert!(matches!(
        probe.exec_path.as_str(),
        "/memfd:serial-workbench-node" | "/memfd:serial-workbench-node (deleted)"
    ));
    assert_eq!(report.diagnostics.exit_code, Some(0));
    assert!(report.diagnostics.reaped);
    assert_child_exited(report.diagnostics.process_id.expect("Actual child process"));
    #[cfg(windows)]
    assert!(
        fs::OpenOptions::new()
            .write(true)
            .open(runtime.executable())
            .is_err(),
        "Verified file remains protected until its owner is released"
    );
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        assert!(
            fs::OpenOptions::new()
                .access_mode(0x10000)
                .share_mode(1 | 2 | 4)
                .custom_flags(0x02000000)
                .open(runtime.runtime_directory())
                .is_err(),
            "The actual runtime directory must remain protected against replacement"
        );
    }
    #[cfg(windows)]
    {
        let executable = runtime.executable().to_path_buf();
        drop(runtime);
        assert!(
            fs::OpenOptions::new().write(true).open(executable).is_ok(),
            "Ownership release restores update access without writing bytes"
        );
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn output_overflow_reaps_the_actual_child_and_keeps_bounded_evidence() {
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
        .expect("Explicit native runtime fixture is required");
    let limits = NodeRuntimeLimits {
        max_output_bytes: 8,
        ..Default::default()
    };
    let cancel = AtomicBool::new(false);
    let runtime = verify_node_runtime(std::path::Path::new(&root), &limits, &cancel).unwrap();
    let report = runtime.self_test(&limits, &cancel);
    let error = report.outcome.unwrap_err();
    assert_eq!(error.code, "LIMIT_EXCEEDED");
    assert!(report.diagnostics.stdout.len() + report.diagnostics.stderr.len() <= 8);
    assert!(report.diagnostics.reaped);
    assert_child_exited(report.diagnostics.process_id.expect("Actual child process"));
}

fn assert_child_exited(pid: u32) {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid.try_into().unwrap(), 0) };
        assert_eq!(
            result, -1,
            "Probe process must be gone, including any unreaped zombie"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            assert_eq!(GetLastError(), ERROR_INVALID_PARAMETER);
        } else {
            let mut code = 259;
            let queried = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            assert_ne!(queried, 0);
            assert_ne!(code, 259, "Probe process must no longer be active");
        }
    }
}

#[test]
fn missing_cancelled_and_expired_runtime_checks_remain_distinct() {
    let directory = tempfile::Builder::new()
        .prefix("private-runtime-marker-")
        .tempdir()
        .unwrap();
    let defaults = NodeRuntimeLimits::default();
    let error =
        verify_node_runtime(directory.path(), &defaults, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(error.code, "NODE_RUNTIME_MISSING");
    let unavailable = directory.path().join("unavailable");
    let error = verify_node_runtime(&unavailable, &defaults, &AtomicBool::new(true)).unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    let expired = NodeRuntimeLimits {
        verification_timeout: std::time::Duration::ZERO,
        ..Default::default()
    };
    let error = verify_node_runtime(&unavailable, &expired, &AtomicBool::new(false)).unwrap_err();
    assert_eq!(error.code, "NODE_RUNTIME_START_TIMEOUT");
    let error = verify_node_runtime(
        std::path::Path::new("relative-root"),
        &defaults,
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("private-runtime-marker-")
    );
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn missing_private_soname_is_a_dependency_failure_without_launching_node() {
    let root = std::path::PathBuf::from(
        std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
            .expect("Explicit native runtime fixture is required"),
    );
    let directory = tempfile::tempdir().unwrap();
    let release = serial_workbench_core::bundled_node_runtime_release();
    let spec = release.for_target(current_node_target().unwrap()).unwrap();
    let base = std::path::Path::new(spec.executable.resource_path.as_str())
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let library = serial_workbench_core::bundled_node_runtime_library();
    let mut paths = vec![
        std::path::PathBuf::from("runtime/node-release.json"),
        spec.executable.resource_path.as_str().into(),
        spec.license.resource_path.as_str().into(),
    ];
    paths.extend(
        [&library.library, &library.copyright, &library.gpl_license]
            .map(|file| base.join(file.resource_path.as_str())),
    );
    for path in paths {
        let destination = directory.path().join(&path);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(root.join(path), destination).unwrap();
    }
    let error = verify_node_runtime(
        directory.path(),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap_err();
    assert_eq!(error.code, "NODE_RUNTIME_DEPENDENCY_MISSING");
}
