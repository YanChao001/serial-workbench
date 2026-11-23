//! 离线正式包的验证、原子安装与内容复核；来源由 Host 信任仓库提供，包内声明不能自授权。
mod archive;
mod external_tool;
mod install;
mod installed;
mod manager;
mod paths;
mod product;
mod runtime;
mod source;
mod source_store;
pub(crate) mod ui_assets;

pub use archive::verify_node_package;
pub(crate) use external_tool::VerifiedExternalTool;
pub use install::{
    InstalledNodePackage, NodePackageInstallReceipt, NodePackageInstaller, NodePackageSnapshot,
};
pub use installed::VerifiedNodeInstallation;
pub(crate) use manager::NodePackageManager;
use serial_workbench_core::{
    Digest, HostError, HostResult, Id, NodePackageIntegrity, NodePackageManifest,
};
pub use serial_workbench_core::{NodeExecutionTrust, VerifiedNodePackageSource};
pub use source_store::{NodePackageSourceKey, NodePackageSourceSnapshot, NodePackageSources};
use std::{
    fmt,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Debug, Clone)]
pub struct NodePackageLimits {
    pub max_archive_bytes: u64,
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    pub max_metadata_bytes: usize,
    pub max_path_bytes: usize,
    pub timeout: Duration,
}
impl Default for NodePackageLimits {
    fn default() -> Self {
        Self {
            max_archive_bytes: 256 * 1024 * 1024,
            max_files: 10_000,
            max_file_bytes: 64 * 1024 * 1024,
            max_total_bytes: 512 * 1024 * 1024,
            max_metadata_bytes: 1024 * 1024,
            max_path_bytes: 1024,
            timeout: Duration::from_secs(30),
        }
    }
}

/// Trusted 的密钥来自调用方已认可的来源记录；不能从归档创建此身份。
#[derive(Debug, Clone, Copy)]
pub enum NodePackageSource<'a> {
    Local,
    Trusted {
        source: &'a Id,
        key_id: &'a Id,
        public_key: &'a [u8; 32],
    },
}

pub struct VerifiedNodePackage {
    bytes: Vec<u8>,
    manifest: NodePackageManifest,
    integrity: NodePackageIntegrity,
    archive_sha256: Digest,
    verified_source: Option<VerifiedNodePackageSource>,
}
impl VerifiedNodePackage {
    pub fn manifest(&self) -> &NodePackageManifest {
        &self.manifest
    }
    pub fn integrity(&self) -> &NodePackageIntegrity {
        &self.integrity
    }
    pub fn archive_sha256(&self) -> &Digest {
        &self.archive_sha256
    }
    pub fn is_source_verified(&self) -> bool {
        self.verified_source.is_some()
    }
    pub fn verified_source(&self) -> Option<&VerifiedNodePackageSource> {
        self.verified_source.as_ref()
    }
    /// 保留已验证的不可变归档，后续安装不重新打开可能已被替换的来源路径。
    pub fn archive_bytes(&self) -> &[u8] {
        &self.bytes
    }
}
impl fmt::Debug for VerifiedNodePackage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VerifiedNodePackage")
            .field("id", &self.manifest.id)
            .field("version", &self.manifest.version)
            .field("archive_sha256", &self.archive_sha256)
            .field("verified_source", &self.verified_source)
            .finish_non_exhaustive()
    }
}

fn failure(code: &str, reason: &str) -> HostError {
    let mut error = HostError::new(code, "Node package verification failed");
    error.retryable = code == "HOST_BUSY";
    error.details = Some(Box::new(
        serde_json::from_value(serde_json::json!({
            "component":"nodePackage", "reason":reason
        }))
        .expect("static verification details"),
    ));
    error
}
fn invalid(reason: &str) -> HostError {
    failure("INVALID_ARGUMENT", reason)
}
fn limit(reason: &str) -> HostError {
    failure("LIMIT_EXCEEDED", reason)
}

struct Control<'a> {
    cancel: &'a AtomicBool,
    deadline: Instant,
}
impl<'a> Control<'a> {
    fn new(cancel: &'a AtomicBool, timeout: Duration) -> HostResult<Self> {
        Ok(Self {
            cancel,
            deadline: Instant::now()
                .checked_add(timeout)
                .ok_or_else(|| invalid("invalidBudget"))?,
        })
    }
    fn check(&self) -> HostResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(failure("CANCELLED", "cancelled"));
        }
        if Instant::now() >= self.deadline {
            return Err(limit("verificationDeadline"));
        }
        Ok(())
    }
    fn checked<T, E>(&self, result: Result<T, E>, reason: &str) -> HostResult<T> {
        self.check()?;
        result.map_err(|_| invalid(reason))
    }
}
