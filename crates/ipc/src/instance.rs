use serial_workbench_core::{HostError, HostResult};
use std::{
    fs::{File, TryLockError},
    path::Path,
};

pub const INSTANCE_LOCK_NAME: &str = "instance.lock";

/// 持有当前调用取得的协调锁；释放时显式解锁，不等待派生进程关闭继承句柄。
pub struct PrivateFileLock {
    file: File,
}

impl Drop for PrivateFileLock {
    fn drop(&mut self) {
        if self.file.unlock().is_err() {
            eprintln!("Local coordination lock release failed: STORAGE_UNAVAILABLE");
        }
    }
}

/// Observe the Host's existing OS lock. No file is created, removed or repaired.
pub fn profile_has_running_host(profile: &Path) -> HostResult<bool> {
    let profile = if profile.is_absolute() {
        profile.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| unavailable())?
            .join(profile)
    };
    let Some(file) = crate::open_existing_instance_lock(&profile.join("host-v0"))? else {
        return Ok(false);
    };
    match file.try_lock() {
        Ok(()) => {
            file.unlock().map_err(|_| unavailable())?;
            Ok(false)
        }
        Err(TryLockError::WouldBlock) => Ok(true),
        Err(TryLockError::Error(_)) => Err(unavailable()),
    }
}

/// A private, persistent coordination file. Dropping the returned guard releases its OS lock.
pub fn try_lock_private_file(path: &Path) -> HostResult<Option<PrivateFileLock>> {
    let file = crate::open_private_lock_file(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(PrivateFileLock { file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(_)) => Err(unavailable()),
    }
}

fn unavailable() -> HostError {
    HostError::new(
        "STORAGE_UNAVAILABLE",
        "Local coordination lock is unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn profile() -> tempfile::TempDir {
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        tempfile::Builder::new()
            .prefix("sw-lock-")
            .tempdir_in(base)
            .unwrap()
    }

    #[test]
    fn missing_profile_probe_does_not_create_any_files() {
        let root = profile();
        let path = root.path().join("missing");
        assert!(!profile_has_running_host(&path).unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn probe_observes_existing_os_lock_without_replacing_it() {
        let root = profile();
        let namespace = root.path().join("host-v0");
        crate::prepare_private_directory(&namespace).unwrap();
        let path = namespace.join(INSTANCE_LOCK_NAME);
        let file = crate::open_private_lock_file(&path).unwrap();
        assert!(!profile_has_running_host(root.path()).unwrap());
        file.try_lock().unwrap();
        let guard = PrivateFileLock { file };
        assert!(profile_has_running_host(root.path()).unwrap());
        drop(guard);
        assert!(!profile_has_running_host(root.path()).unwrap());
        assert!(path.is_file());
        assert_eq!(fs::read_dir(namespace).unwrap().count(), 1);
    }

    #[test]
    fn unsafe_lock_type_is_rejected_without_mutating_it() {
        let root = profile();
        let namespace = root.path().join("host-v0");
        crate::prepare_private_directory(&namespace).unwrap();
        let path = namespace.join(INSTANCE_LOCK_NAME);
        fs::create_dir(&path).unwrap();
        assert!(profile_has_running_host(root.path()).is_err());
        assert!(path.is_dir());
    }

    #[test]
    fn private_file_lock_serializes_the_same_client_only_and_preserves_the_file() {
        let root = profile();
        let directory = root.path().join("clients");
        crate::prepare_private_directory(&directory).unwrap();
        let first_path = directory.join("first.lock");
        let guard = try_lock_private_file(&first_path).unwrap().unwrap();
        assert!(try_lock_private_file(&first_path).unwrap().is_none());
        let second = try_lock_private_file(&directory.join("second.lock"))
            .unwrap()
            .unwrap();
        drop(second);
        drop(guard);
        assert!(first_path.is_file());
        assert!(try_lock_private_file(&first_path).unwrap().is_some());
    }

    #[test]
    fn dropping_guard_releases_lock_even_while_a_duplicate_handle_remains() {
        let root = profile();
        let namespace = root.path().join("host-v0");
        crate::prepare_private_directory(&namespace).unwrap();
        let path = namespace.join(INSTANCE_LOCK_NAME);
        let owner = try_lock_private_file(&path).unwrap().unwrap();
        // 与 fork 继承的 FD 一样，副本引用同一个打开文件描述。
        let duplicate = owner.file.try_clone().unwrap();
        assert!(profile_has_running_host(root.path()).unwrap());
        assert!(try_lock_private_file(&path).unwrap().is_none());
        drop(owner);
        let replacement = try_lock_private_file(&path)
            .unwrap()
            .expect("released coordination lock remains busy");
        drop(duplicate);
        assert!(profile_has_running_host(root.path()).unwrap());
        assert!(try_lock_private_file(&path).unwrap().is_none());
        drop(replacement);
        assert!(!profile_has_running_host(root.path()).unwrap());
        assert!(try_lock_private_file(&path).unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn missing_namespace_below_a_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = profile();
        let alias = root.path().join("alias");
        symlink(root.path(), &alias).unwrap();
        assert!(profile_has_running_host(&alias.join("missing")).is_err());
        assert!(!root.path().join("missing").exists());
    }
}
