//! 当前用户本机传输、帧边界与受保护秘密存储；不承载业务授权。
mod discovery;
pub mod frame;
pub mod identity;
#[cfg(windows)]
pub mod install_switch;
mod instance;
pub mod shutdown;
pub mod startup_config;
pub use discovery::DiscoveryRecord;
pub use instance::{
    INSTANCE_LOCK_NAME, PrivateFileLock, profile_has_host_state, profile_has_running_host,
    reserve_host_instance, try_lock_private_file,
};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
pub use windows::*;

#[cfg(all(test, any(unix, windows)))]
mod diagnostic_log_tests {
    use super::open_local_log;
    use std::{fs, io::Read};

    #[test]
    fn diagnostic_source_reads_only_unaliased_regular_files() {
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let path = root.path().join("app.log");
        assert!(open_local_log(&path).unwrap().is_none());
        fs::write(&path, "fixture log").unwrap();
        let mut text = String::new();
        open_local_log(&path)
            .unwrap()
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "fixture log");
        let alias = root.path().join("other.log");
        fs::hard_link(&path, &alias).unwrap();
        assert!(open_local_log(&path).is_err());
        assert!(open_local_log(&alias).is_err());
        assert!(open_local_log(root.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn diagnostic_source_rejects_symlinked_ancestors_and_leaf() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let actual = root.path().join("actual");
        fs::create_dir(&actual).unwrap();
        fs::write(actual.join("app.log"), "fixture only").unwrap();
        let linked = root.path().join("linked");
        symlink(&actual, &linked).unwrap();
        assert!(open_local_log(&linked.join("app.log")).is_err());
        let leaf = root.path().join("app.log");
        symlink(actual.join("app.log"), &leaf).unwrap();
        assert!(open_local_log(&leaf).is_err());
    }
}

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
