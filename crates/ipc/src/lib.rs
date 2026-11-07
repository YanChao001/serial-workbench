//! 当前用户本机传输、帧边界与受保护秘密存储；不承载业务授权。
mod discovery;
pub mod frame;
pub mod identity;
mod instance;
pub use discovery::DiscoveryRecord;
pub use instance::{
    INSTANCE_LOCK_NAME, PrivateFileLock, profile_has_running_host, try_lock_private_file,
};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

/// 与桌面存档分开的 host-v0 namespace 由 Host 在此 profile 下创建。
pub fn default_profile() -> serial_workbench_core::HostResult<std::path::PathBuf> {
    use serial_workbench_core::HostError;
    use std::path::PathBuf;
    let unavailable = || {
        HostError::new(
            "STORAGE_UNAVAILABLE",
            "Current-user application data directory is unavailable",
        )
    };
    let config: serde_json::Value = serde_json::from_str(include_str!("../../../app.config.json"))
        .map_err(|_| unavailable())?;
    let identifier = config
        .get("identifier")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(unavailable)?;
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(unavailable)?;
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(unavailable)?
        .join("Library/Application Support");
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .ok_or_else(unavailable)?;
    if !base.is_absolute() {
        return Err(unavailable());
    }
    Ok(base.join(identifier))
}
