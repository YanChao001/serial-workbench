//! 单实例生命周期与认证后的本地连接。
mod browser;
mod connection;
mod http_control;
mod lan_access;
mod lan_route;
mod loopback;
mod protocol;
mod server;
pub use serial_workbench_core::{BrowserEntry, HttpControlEntry};
use serial_workbench_core::{HostError, HostResult};
pub(crate) use server::ControlReplyGuard;
#[cfg(test)]
pub(crate) use server::test_context;
pub use server::{ConnectionContext, HandlerFuture, HandlerReply, HostServer, RequestHandler};
use std::path::{Path, PathBuf};

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
        let file = serial_workbench_ipc::reserve_host_instance(&namespace)?;
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
