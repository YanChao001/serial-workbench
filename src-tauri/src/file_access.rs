//! 用户主动导出文本；保存路径只由原生对话框授权。

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use tauri_plugin_dialog::DialogExt;

use crate::error::{ErrorCode, NativeError, NativeResult, bounded_text};

fn io_error(error: impl std::fmt::Display) -> NativeError {
    NativeError::operation(
        ErrorCode::StorageIo,
        "Cannot access the selected file",
        error,
    )
}

fn invalid(message: &str) -> NativeError {
    NativeError::new(ErrorCode::InvalidArgument, message)
}

fn checked_file(path: &Path) -> NativeResult<PathBuf> {
    let info = fs::symlink_metadata(path).map_err(io_error)?;
    if info.file_type().is_symlink() || !info.is_file() {
        return Err(invalid(
            "Select a regular file; links and special files are not followed",
        ));
    }
    fs::canonicalize(path).map_err(io_error)
}

fn atomic_save(path: &Path, bytes: &[u8]) -> NativeResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("Invalid save destination"))?;
    let canonical_parent = fs::canonicalize(parent).map_err(io_error)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&canonical_parent).map_err(io_error)?;
    temporary.write_all(bytes).map_err(io_error)?;
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            checked_file(path)?;
            temporary
                .as_file()
                .set_permissions(metadata.permissions())
                .map_err(io_error)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    temporary.as_file().sync_all().map_err(io_error)?;
    if fs::canonicalize(parent).map_err(io_error)? != canonical_parent {
        return Err(invalid("Save directory changed; select it again"));
    }
    // 最终目标沿用已核验目录，兼容 Windows 扩展路径。
    let destination = canonical_parent.join(
        path.file_name()
            .ok_or_else(|| invalid("Invalid save destination"))?,
    );
    temporary.persist(destination).map_err(io_error)?;
    Ok(())
}

/// 另存路径来自系统对话框；取消不写文件，写入使用同目录临时文件替换。
pub fn save_text_content(
    app: &tauri::AppHandle,
    default_name: &str,
    content: &str,
    max_bytes: usize,
) -> NativeResult<Option<String>> {
    save_text_content_with_picker(content, max_bytes, || pick_save_path(app, default_name))
}

pub(crate) fn save_text_content_with_picker(
    content: &str,
    max_bytes: usize,
    pick_path: impl FnOnce() -> NativeResult<Option<PathBuf>>,
) -> NativeResult<Option<String>> {
    bounded_text(content, max_bytes, "Export")?;
    let Some(path) = pick_path()? else {
        return Ok(None);
    };
    atomic_save(&path, content.as_bytes())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn pick_save_path(app: &tauri::AppHandle, default_name: &str) -> NativeResult<Option<PathBuf>> {
    bounded_text(default_name, 200, "File name")?;
    if default_name.contains(['/', '\\']) {
        return Err(invalid("Use a file name, not a path"));
    }
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .blocking_save_file()
    else {
        return Ok(None);
    };
    Ok(Some(path.into_path().map_err(io_error)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_cancellation_does_not_write() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.json");
        let content = "original";
        fs::write(&path, content).unwrap();
        assert_eq!(
            save_text_content_with_picker(content, 8 * 1024 * 1024, || Ok(None)).unwrap(),
            None
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_save_rejects_existing_and_dangling_symbolic_links() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.txt");
        let link = directory.path().join("link.txt");
        fs::write(&target, b"original").unwrap();
        symlink(&target, &link).unwrap();
        assert_eq!(
            atomic_save(&link, b"replacement").unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert_eq!(fs::read(&target).unwrap(), b"original");
        fs::remove_file(&target).unwrap();
        assert_eq!(
            atomic_save(&link, b"replacement").unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
        assert!(!target.exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn atomic_save_supports_long_windows_paths() {
        use std::os::windows::ffi::OsStrExt;
        let directory = tempfile::tempdir().unwrap();
        let raw = directory.path().to_string_lossy();
        let mut parent = PathBuf::from(raw.trim_start_matches(r"\\?\"));
        while parent.as_os_str().encode_wide().count() < 230 {
            parent.push("nested-export-directory");
        }
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join(format!("{}.txt", "report".repeat(12)));
        assert!(path.as_os_str().encode_wide().count() > 260);
        atomic_save(&path, b"original").unwrap();
        atomic_save(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
    }
}
