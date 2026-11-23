use crate::{
    node_packages::{NodePackageInstaller, NodePackageLimits, NodePackageSources},
    storage::Store,
    test_support::{id, node_package},
};
use ed25519_dalek::SigningKey;
use serde_json::json;
use serial_workbench_core::{Digest, DurationMs, Id, NodePackageId, ToolHandoffParams, U64};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
};

pub(super) struct SignedHandoffFixture {
    directory: PathBuf,
    package_id: NodePackageId,
    tool_id: Id,
    revision: U64,
    archive_sha256: Digest,
}

impl SignedHandoffFixture {
    pub(super) fn install(store: &Store, control_dir: &Path, locator: &str) -> Self {
        fs::create_dir(control_dir).unwrap();
        let directory = control_dir.canonicalize().unwrap();
        // 模拟提供器和独立工具进程争用同一个 Windows 独占文件句柄。
        fs::File::create(directory.join("device.lock")).unwrap();

        let package_id = NodePackageId::try_from("example.tool-handoff").unwrap();
        let tool_id = id("serial-probe");
        let resource = "bin/serial-probe.exe";
        let target = crate::node_runtime::current_node_target().unwrap();
        let mut manifest = node_package::manifest();
        manifest["id"] = json!(package_id);
        manifest["platformResources"] = json!([{
            "id":tool_id,
            "target":target,
            "path":resource,
            "kind":"tool",
            "version":"1.0.0"
        }]);
        manifest["permissions"]["externalTools"] = json!([tool_id]);

        let mut files = node_package::payloads();
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        files.insert(
            "dist/main.mjs".into(),
            b"export function register() { return () => {}; }".to_vec(),
        );
        files.insert(resource.into(), compile_probe(&directory, locator));
        let archive = node_package::archive(&node_package::with_metadata(files, true));
        fs::write(directory.join("signed-serial-probe.zip"), &archive).unwrap();

        let source = id("test-source");
        let key_id = id("test-key");
        let public_key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
        let sources = NodePackageSources::new(store.clone());
        sources
            .approve_key(
                source.clone(),
                key_id.clone(),
                public_key,
                sources.snapshot().unwrap().revision,
            )
            .unwrap();
        let limits = NodePackageLimits::default();
        let cancel = AtomicBool::new(false);
        let verified = sources
            .verify(archive, &source, &key_id, &limits, &cancel)
            .unwrap();
        let installer = NodePackageInstaller::new(store.clone(), store.profile()).unwrap();
        let installed = installer
            .install(
                verified,
                installer.snapshot().unwrap().revision,
                &limits,
                &cancel,
            )
            .unwrap();
        let archive_sha256 = installed.package.archive_sha256;
        let trusted = installer
            .confirm_execution_trust(&package_id, installed.revision, &archive_sha256)
            .unwrap();
        // 通过正式安装器写入启用偏好。该验收只启动受监督的外部工具。
        let enabled = installer
            .set_enabled(&package_id, true, trusted.revision, &archive_sha256)
            .unwrap();
        Self {
            directory,
            package_id,
            tool_id,
            revision: enabled.revision,
            archive_sha256,
        }
    }

    pub(super) fn params(&self, timeout_ms: u64) -> ToolHandoffParams {
        ToolHandoffParams {
            package_id: self.package_id.clone(),
            expected_install_revision: self.revision,
            archive_sha256: self.archive_sha256.clone(),
            tool_id: self.tool_id.clone(),
            timeout_ms: DurationMs::try_from(U64::from(timeout_ms)).unwrap(),
        }
    }

    pub(super) fn device_lock(&self) -> PathBuf {
        self.directory.join("device.lock")
    }

    pub(super) fn tool_entered(&self) -> bool {
        self.directory.join("tool-entered").is_file()
    }

    pub(super) fn allow_tool_exit(&self) {
        fs::File::create(self.directory.join("tool-release")).unwrap();
    }

    /// 进程主动释放模拟设备的见证。Job 与真实进程退出以操作终态为准。
    pub(super) fn tool_exited(&self) -> bool {
        self.directory.join("tool-exited").is_file()
    }
}

fn compile_probe(directory: &Path, locator: &str) -> Vec<u8> {
    let source = directory.join("tool_handoff_sim_probe.rs");
    let executable = directory.join("serial-probe.exe");
    fs::write(&source, include_bytes!("tool_handoff_sim_probe.rs")).unwrap();
    // 固定源码纳入该次 Host 测试编译。只有 rustc 子进程拿到夹具参数。
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = Command::new(compiler)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "--edition",
            "2024",
            "--crate-name",
            "serial_probe",
            "-C",
            "debuginfo=0",
        ])
        .arg(&source)
        .arg("-o")
        .arg(&executable)
        .env("SWB_TOOL_HANDOFF_PROBE_DIRECTORY", directory)
        .env("SWB_TOOL_HANDOFF_PROBE_LOCATOR", locator)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "simulated tool probe compilation failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
    fs::read(executable).unwrap()
}
