//! 单实例生命周期与认证后的本地连接。
mod connection;
mod protocol;
mod server;
use serial_workbench_core::{HostError, HostResult};
pub use server::{ConnectionContext, HandlerFuture, HandlerReply, HostServer, RequestHandler};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub struct InstanceGuard {
    _lock: serial_workbench_ipc::PrivateFileLock,
    profile: PathBuf,
    namespace: PathBuf,
}
impl InstanceGuard {
    pub fn acquire(profile: &Path) -> HostResult<Self> {
        let profile = if profile.is_absolute() {
            profile.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|_| unavailable())?
                .join(profile)
        };
        let namespace = profile.join("host-v0");
        serial_workbench_ipc::prepare_private_directory(&namespace)?;
        let lock_path = namespace.join(serial_workbench_ipc::INSTANCE_LOCK_NAME);
        match fs::symlink_metadata(&lock_path) {
            Ok(metadata) if !metadata.file_type().is_file() => return Err(unavailable()),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(unavailable()),
            _ => {}
        }
        // 新锁原子指定当前用户 owner 和私有权限；已有未知对象只验证，不修复。
        let file = serial_workbench_ipc::try_lock_private_file(&lock_path)?.ok_or_else(|| {
            HostError::new("HOST_BUSY", "This profile already has a running Host")
        })?;
        Ok(Self {
            _lock: file,
            profile,
            namespace,
        })
    }
    pub fn profile(&self) -> &Path {
        &self.profile
    }
    pub fn namespace(&self) -> &Path {
        &self.namespace
    }
}
fn unavailable() -> HostError {
    HostError::new("STORAGE_UNAVAILABLE", "Host instance lock is unavailable")
}
