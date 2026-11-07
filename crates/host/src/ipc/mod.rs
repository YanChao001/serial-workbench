//! 单实例生命周期与认证后的本地连接。
mod connection;
mod protocol;
mod server;
use serial_workbench_core::{HostError, HostResult};
pub use server::{ConnectionContext, HandlerFuture, HostServer, RequestHandler};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    path::{Path, PathBuf},
};

pub struct InstanceGuard {
    _file: File,
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
        let lock_path = namespace.join("instance.lock");
        match fs::symlink_metadata(&lock_path) {
            Ok(metadata) if !metadata.file_type().is_file() => return Err(unavailable()),
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(unavailable()),
            _ => {}
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(lock_path).map_err(|_| unavailable())?;
        file.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => {
                HostError::new("HOST_BUSY", "This profile already has a running Host")
            }
            TryLockError::Error(_) => unavailable(),
        })?;
        Ok(Self {
            _file: file,
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
