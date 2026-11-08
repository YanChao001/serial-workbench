//! Application paths and atomic file replacement.
use crate::error::{ErrorCode, NativeError, NativeResult};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
#[cfg(not(feature = "e2e"))]
use tauri::Manager;

#[derive(Clone)]
pub struct DataPaths {
    pub config: PathBuf,
    pub data: PathBuf,
    pub logs: PathBuf,
}

impl DataPaths {
    pub fn resolve(app: &tauri::AppHandle) -> NativeResult<Self> {
        #[cfg(feature = "e2e")]
        {
            if !app.config().identifier.ends_with(".e2e") {
                return Err(NativeError::new(
                    ErrorCode::InvalidArgument,
                    "E2E builds require a separate .e2e application identifier",
                ));
            }
            let root = std::env::var_os("STARTER_TEST_DATA_DIR")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute() && path.parent().is_some())
                .ok_or_else(|| {
                    NativeError::new(
                        ErrorCode::InvalidArgument,
                        "STARTER_TEST_DATA_DIR must be an absolute test directory",
                    )
                })?;
            let paths = Self {
                config: root.join("config"),
                data: root.join("data"),
                logs: root.join("logs"),
            };
            Ok(paths)
        }
        #[cfg(not(feature = "e2e"))]
        {
            let paths = Self {
                config: app.path().app_config_dir().map_err(|e| {
                    NativeError::operation(
                        ErrorCode::StorageIo,
                        "Cannot locate configuration directory",
                        e,
                    )
                })?,
                data: app.path().app_data_dir().map_err(|e| {
                    NativeError::operation(
                        ErrorCode::StorageIo,
                        "Cannot locate application data directory",
                        e,
                    )
                })?,
                logs: app.path().app_log_dir().map_err(|e| {
                    NativeError::operation(ErrorCode::StorageIo, "Cannot locate log directory", e)
                })?,
            };
            Ok(paths)
        }
    }
}

pub fn atomic_write(path: &Path, contents: &[u8]) -> NativeResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| NativeError::new(ErrorCode::StorageIo, "Invalid storage path"))?;
    fs::create_dir_all(parent).map_err(|e| {
        NativeError::operation(ErrorCode::StorageIo, "Cannot create storage directory", e)
    })?;
    // tempfile 的 Windows persist 直接调用 Win32；临时文件和目标都使用扩展路径，
    // 避免深层缓存目录在 MoveFileExW 阶段触发传统 MAX_PATH 限制。
    #[cfg(windows)]
    let path = {
        let name = path
            .file_name()
            .ok_or_else(|| NativeError::new(ErrorCode::StorageIo, "Invalid storage path"))?;
        fs::canonicalize(if parent.as_os_str().is_empty() {
            Path::new(".")
        } else {
            parent
        })
        .map_err(|e| {
            NativeError::operation(ErrorCode::StorageIo, "Cannot resolve storage directory", e)
        })?
        .join(name)
    };
    #[cfg(windows)]
    let parent = path
        .parent()
        .ok_or_else(|| NativeError::new(ErrorCode::StorageIo, "Invalid storage path"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| {
        NativeError::operation(
            ErrorCode::StorageIo,
            "Cannot create temporary settings file",
            e,
        )
    })?;
    temporary
        .write_all(contents)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|e| NativeError::operation(ErrorCode::StorageIo, "Cannot write settings", e))?;
    temporary.persist(path).map_err(|e| {
        NativeError::operation(ErrorCode::StorageIo, "Cannot replace settings file", e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn atomic_write_replaces_long_windows_paths_without_changing_system_settings() {
        use std::os::windows::ffi::OsStrExt;

        let directory = tempfile::tempdir().unwrap();
        let raw = directory.path().to_string_lossy();
        let mut parent = PathBuf::from(raw.trim_start_matches(r"\\?\"));
        while parent.as_os_str().encode_wide().count() < 230 {
            parent.push("nested-attachment-cache");
        }
        let path = parent.join("f".repeat(64));
        assert!(!path.to_string_lossy().starts_with(r"\\?\"));
        assert!(path.as_os_str().encode_wide().count() > 260);

        atomic_write(&path, b"original attachment").unwrap();
        atomic_write(&path, b"replacement attachment").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement attachment");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
    }
}
