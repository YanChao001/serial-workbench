//! 用户主动选择的文件授权与导出；授权仅保留在当前应用进程，路径不暴露给插件。

use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::error::{ErrorCode, NativeError, NativeResult, bounded_text};

const FILE_BYTES: usize = 2 * 1024 * 1024;
const MAX_GRANTED_FILES: usize = 100;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct GrantedFile {
    id: String,
    path: PathBuf,
}

#[derive(Default)]
pub struct FileAccess(Mutex<Vec<GrantedFile>>);

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

fn name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

impl FileAccess {
    fn grant(&self, path: &Path) -> NativeResult<String> {
        let path = checked_file(path)?;
        let mut grants = self
            .0
            .lock()
            .map_err(|_| invalid("Selected file grants are unavailable"))?;
        let id = grants
            .iter()
            .find(|entry| entry.path == path)
            .map(|entry| entry.id.clone())
            .unwrap_or_else(|| format!("resource-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)));
        grants.retain(|entry| entry.path != path);
        grants.insert(
            0,
            GrantedFile {
                id: id.clone(),
                path,
            },
        );
        grants.truncate(MAX_GRANTED_FILES);
        Ok(id)
    }

    /// 扩展只读取用户已授权资源的有界字节，不获得磁盘路径或目录能力。
    pub fn read_extension_resource(&self, id: &str) -> NativeResult<(String, Vec<u8>)> {
        bounded_text(id, 160, "Resource ID")?;
        let path = self
            .0
            .lock()
            .map_err(|_| invalid("Selected file grants are unavailable"))?
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.path.clone())
            .ok_or_else(|| NativeError::new(ErrorCode::NotFound, "Select this file again"))?;
        if checked_file(&path)? != path {
            return Err(invalid("The resource path changed; select it again"));
        }
        Ok((name(&path), read_bounded(&path, FILE_BYTES)?))
    }
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

fn read_bounded(path: &Path, limit: usize) -> NativeResult<Vec<u8>> {
    checked_file(path)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(io_error)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > limit {
        return Err(NativeError::new(
            ErrorCode::InputTooLong,
            "The selected file exceeds the supported size",
        ));
    }
    Ok(bytes)
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

pub fn save_binary_content(
    app: &tauri::AppHandle,
    default_name: &str,
    content: &[u8],
) -> NativeResult<Option<String>> {
    if content.len() > FILE_BYTES {
        return Err(invalid("Extension artifact exceeds 2 MiB"));
    }
    let Some(path) = pick_save_path(app, default_name)? else {
        return Ok(None);
    };
    atomic_save(&path, content)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub fn pick_extension_resources(
    app: &tauri::AppHandle,
) -> NativeResult<Vec<crate::extensions::ExtensionFileChoice>> {
    let Some(paths) = app.dialog().file().blocking_pick_files() else {
        return Ok(Vec::new());
    };
    if paths.len() > 16 {
        return Err(invalid("Select at most 16 extension input files"));
    }
    let mut selected = Vec::new();
    let mut total = 0_u64;
    for path in paths {
        let path = checked_file(&path.into_path().map_err(io_error)?)?;
        let bytes = fs::metadata(&path).map_err(io_error)?.len();
        total = total
            .checked_add(bytes)
            .ok_or_else(|| invalid("Selected files exceed 2 MiB"))?;
        if total > FILE_BYTES as u64 {
            return Err(invalid("Selected files exceed 2 MiB in total"));
        }
        selected.push((path, bytes));
    }
    let state = app.state::<FileAccess>();
    selected
        .into_iter()
        .map(|(path, bytes)| {
            Ok(crate::extensions::ExtensionFileChoice {
                id: state.grant(&path)?,
                name: name(&path),
                bytes: bytes as f64,
                media_type: "application/octet-stream".into(),
            })
        })
        .collect()
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
    fn file_grants_are_bounded_and_do_not_survive_the_owning_state() {
        let directory = tempfile::tempdir().unwrap();
        let state = FileAccess::default();
        let first = directory.path().join("first.bin");
        fs::write(&first, [0, 0xff, 0xfe]).unwrap();
        let id = state.grant(&first).unwrap();
        assert_eq!(
            state.read_extension_resource(&id).unwrap(),
            ("first.bin".into(), vec![0, 0xff, 0xfe])
        );
        assert_eq!(
            FileAccess::default()
                .read_extension_resource(&id)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        for index in 0..MAX_GRANTED_FILES {
            let path = directory.path().join(format!("{index}.bin"));
            fs::write(&path, b"file").unwrap();
            state.grant(&path).unwrap();
        }
        assert_eq!(
            state.read_extension_resource(&id).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(state.0.lock().unwrap().len(), MAX_GRANTED_FILES);
    }

    #[test]
    fn reading_selected_files_remains_bounded_and_export_cancellation_does_not_write() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("large-session.json");
        let content = "x".repeat(FILE_BYTES + 1);
        fs::write(&path, &content).unwrap();
        let state = FileAccess::default();
        let id = state.grant(&path).unwrap();
        assert_eq!(
            state.read_extension_resource(&id).unwrap_err().code,
            ErrorCode::InputTooLong
        );
        assert_eq!(
            save_text_content_with_picker(&content, 32 * 1024 * 1024, || Ok(None)).unwrap(),
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
