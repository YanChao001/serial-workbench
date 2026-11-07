//! 设置启动故障隔离与下次启动时的替换；原件先归档，未提交的替换可恢复。

use crate::{
    blocking,
    error::{ErrorCode, NativeError, NativeResult},
    storage::{
        DataPaths, MAX_SETTINGS_FILE_SIZE, SettingsSnapshot, SettingsStore, atomic_write,
        future_settings_schema, validate_settings,
    },
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, TryLockError},
};
use tauri::Manager;

const PENDING: &str = ".recovery-pending.json";
const JOURNAL: &str = ".recovery-transaction.json";

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub active: bool,
    pub reason: Option<String>,
    pub pending: bool,
    pub archive_id: Option<String>,
}

pub struct RecoveryState {
    paths: DataPaths,
    temporary: Option<tempfile::TempDir>,
    status: Mutex<RecoveryStatus>,
    operation: Mutex<()>,
}

pub struct InitializedStorage {
    pub settings: SettingsStore,
    pub recovery: RecoveryState,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    token: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    request: Pending,
    originals: Vec<String>,
    installed: bool,
}

fn failure(message: &str, error: impl std::fmt::Display) -> NativeError {
    NativeError::operation(ErrorCode::StorageIo, message, error)
}

fn invalid(message: &str) -> NativeError {
    NativeError::new(ErrorCode::StorageCorrupt, message)
}

fn json<T: serde::de::DeserializeOwned>(path: &Path) -> NativeResult<T> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut bytes))
        .map_err(|e| failure("Cannot read recovery metadata", e))?;
    if bytes.len() > 1024 * 1024 {
        return Err(invalid("Recovery metadata exceeds the supported size"));
    }
    serde_json::from_slice(&bytes).map_err(|e| failure("Invalid recovery metadata", e))
}

fn write_json(path: &Path, value: &impl Serialize) -> NativeResult<()> {
    let bytes =
        serde_json::to_vec(value).map_err(|e| failure("Cannot encode recovery metadata", e))?;
    atomic_write(path, &bytes)
}

fn validate_token(token: &str) -> NativeResult<()> {
    if token.is_empty()
        || token.len() > 80
        || !token.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(invalid("Invalid recovery identity"));
    }
    Ok(())
}

fn candidate(paths: &DataPaths, token: &str) -> PathBuf {
    paths.config.join(format!(".recovery-next-{token}.json"))
}

fn regular(path: &Path) -> NativeResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_file() && !info.is_symlink() => Ok(true),
        Ok(_) => Err(invalid("Recovery refuses a storage file link or directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(failure("Cannot inspect recovery storage", error)),
    }
}

fn root_dir(path: &Path) -> NativeResult<()> {
    let info =
        fs::symlink_metadata(path).map_err(|e| failure("Cannot inspect storage directory", e))?;
    if !info.is_dir() || info.is_symlink() {
        return Err(invalid("Recovery requires a real storage directory"));
    }
    Ok(())
}

fn location(paths: &DataPaths, name: &str) -> NativeResult<PathBuf> {
    match name {
        "settings.json" => Ok(paths.config.join(name)),
        _ => Err(invalid("Invalid recovery archive entry")),
    }
}

fn archive(paths: &DataPaths, token: &str, name: &str) -> NativeResult<PathBuf> {
    Ok(location(paths, name)?
        .parent()
        .ok_or_else(|| invalid("Invalid storage parent"))?
        .join(format!("recovery-archive-{token}"))
        .join(name))
}

fn remove_metadata(path: &Path) -> NativeResult<()> {
    if regular(path)? {
        fs::remove_file(path).map_err(|e| failure("Cannot finish recovery metadata", e))?;
    }
    Ok(())
}

fn verify_settings(path: &Path) -> NativeResult<()> {
    if !regular(path)? {
        return Err(invalid("Recovery settings candidate is missing"));
    }
    if fs::metadata(path)
        .map_err(|e| failure("Cannot inspect recovery settings candidate", e))?
        .len()
        > MAX_SETTINGS_FILE_SIZE as u64
    {
        return Err(invalid(
            "Recovery settings candidate exceeds the supported size",
        ));
    }
    let settings: SettingsSnapshot = json(path)?;
    if settings.revision < 0
        || future_settings_schema(&settings.settings)
        || validate_settings(&settings.settings).is_err()
    {
        return Err(invalid("Invalid or newer recovery settings candidate"));
    }
    Ok(())
}

fn protect_future(paths: &DataPaths) -> NativeResult<()> {
    let settings = paths.config.join("settings.json");
    if regular(&settings)? {
        let mut contents = Vec::new();
        File::open(settings)
            .and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut contents))
            .map_err(|e| failure("Cannot inspect original settings", e))?;
        if contents.len() > 1024 * 1024 {
            return Err(invalid(
                "Original settings are too large to validate safely",
            ));
        }
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&contents)
            && future_settings_schema(value.get("settings").unwrap_or(&value))
        {
            return Err(invalid(
                "Settings from a newer application must not be overwritten",
            ));
        }
    }
    Ok(())
}

fn rollback(paths: &DataPaths, journal: &Journal) -> NativeResult<()> {
    validate_token(&journal.request.token)?;
    for name in &journal.originals {
        location(paths, name)?;
    }
    let staged = candidate(paths, &journal.request.token);
    let destination = paths.config.join("settings.json");
    if !regular(&staged)?
        && regular(&destination)?
        && (regular(&archive(paths, &journal.request.token, "settings.json")?)?
            || !journal
                .originals
                .iter()
                .any(|entry| entry == "settings.json"))
    {
        fs::rename(&destination, &staged)
            .map_err(|e| failure("Cannot preserve uncommitted recovered settings", e))?;
    }
    for name in &journal.originals {
        let saved = archive(paths, &journal.request.token, name)?;
        if regular(&saved)? {
            let destination = location(paths, name)?;
            if regular(&destination)? {
                return Err(invalid(
                    "Settings changed during recovery; originals remain archived for manual review",
                ));
            }
            fs::rename(saved, destination)
                .map_err(|e| failure("Cannot restore the original settings", e))?;
        }
    }
    remove_metadata(&paths.data.join(JOURNAL))
}

fn apply_pending(paths: &DataPaths) -> NativeResult<Option<String>> {
    apply_pending_with(paths, || Ok(()))
}

fn apply_pending_with(
    paths: &DataPaths,
    mut before_install: impl FnMut() -> NativeResult<()>,
) -> NativeResult<Option<String>> {
    root_dir(&paths.data)?;
    root_dir(&paths.config)?;
    if regular(&paths.data.join(JOURNAL))? {
        let journal: Journal = json(&paths.data.join(JOURNAL))?;
        validate_token(&journal.request.token)?;
        for name in &journal.originals {
            location(paths, name)?;
        }
        if journal.installed {
            verify_settings(&paths.config.join("settings.json"))?;
            remove_metadata(&paths.data.join(PENDING))?;
            remove_metadata(&paths.data.join(JOURNAL))?;
            return Ok(Some(format!("recovery-archive-{}", journal.request.token)));
        }
        rollback(paths, &journal)?;
    }
    if !regular(&paths.data.join(PENDING))? {
        return Ok(None);
    }
    let request: Pending = json(&paths.data.join(PENDING))?;
    validate_token(&request.token)?;
    protect_future(paths)?;
    verify_settings(&candidate(paths, &request.token))?;
    let originals = if regular(&paths.config.join("settings.json"))? {
        vec!["settings.json".to_owned()]
    } else {
        Vec::new()
    };
    let mut journal = Journal {
        request,
        originals,
        installed: false,
    };
    write_json(&paths.data.join(JOURNAL), &journal)?;
    let install = (|| {
        for name in &journal.originals {
            let saved = archive(paths, &journal.request.token, name)?;
            let parent = saved
                .parent()
                .ok_or_else(|| invalid("Invalid archive directory"))?;
            if !parent.exists() {
                fs::create_dir(parent)
                    .map_err(|e| failure("Cannot create original settings archive", e))?;
            }
            root_dir(parent)?;
            if saved.exists() {
                return Err(invalid(
                    "Recovery archive already exists; original settings were not overwritten",
                ));
            }
            fs::rename(location(paths, name)?, saved)
                .map_err(|e| failure("Cannot archive original settings", e))?;
        }
        before_install()?;
        fs::rename(
            candidate(paths, &journal.request.token),
            paths.config.join("settings.json"),
        )
        .map_err(|e| failure("Cannot install recovered settings", e))?;
        journal.installed = true;
        write_json(&paths.data.join(JOURNAL), &journal)
    })();
    if let Err(error) = install {
        rollback(paths, &journal).map_err(|rollback_error| {
            failure(
                "Recovery could not finish restoring originals; archive and journal retained",
                rollback_error,
            )
        })?;
        return Err(error);
    }
    remove_metadata(&paths.data.join(PENDING))?;
    remove_metadata(&paths.data.join(JOURNAL))?;
    Ok(Some(format!("recovery-archive-{}", journal.request.token)))
}

pub fn initialize(paths: &DataPaths) -> NativeResult<InitializedStorage> {
    let preparation = [&paths.config, &paths.data]
        .into_iter()
        .try_for_each(|path| {
            fs::create_dir_all(path)
                .map_err(|error| failure("Cannot create application storage directory", error))
        });
    let applied = preparation.and_then(|()| apply_pending(paths));
    let settings = if applied.is_ok() {
        SettingsStore::open(paths.config.join("settings.json"))
    } else {
        Err(invalid(
            "Original settings remain unopened after recovery preparation failed",
        ))
    };
    let reason = applied
        .as_ref()
        .err()
        .map(|error| error.message.clone())
        .or_else(|| settings.as_ref().err().map(|error| error.message.clone()));
    if reason.is_none() {
        return Ok(InitializedStorage {
            settings: settings?,
            recovery: RecoveryState {
                paths: paths.clone(),
                temporary: None,
                operation: Mutex::new(()),
                status: Mutex::new(RecoveryStatus {
                    active: false,
                    reason: None,
                    pending: false,
                    archive_id: applied?,
                }),
            },
        });
    }
    let temporary = tempfile::Builder::new()
        .prefix("serial-workbench-recovery-")
        .tempdir()
        .map_err(|e| failure("Cannot create isolated recovery workspace", e))?;
    Ok(InitializedStorage {
        settings: SettingsStore::open(temporary.path().join("settings.json"))?,
        recovery: RecoveryState {
            paths: paths.clone(),
            temporary: Some(temporary),
            operation: Mutex::new(()),
            status: Mutex::new(RecoveryStatus {
                active: true,
                reason,
                pending: false,
                archive_id: None,
            }),
        },
    })
}

impl RecoveryState {
    fn enter(&self) -> NativeResult<MutexGuard<'_, ()>> {
        self.operation.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => NativeError::new(
                ErrorCode::NativeBusy,
                "Another recovery operation is in progress",
            ),
            TryLockError::Poisoned(_) => invalid("Recovery operation is unavailable"),
        })
    }

    #[cfg(test)]
    fn is_isolated(&self) -> bool {
        self.temporary.is_some()
    }

    pub fn wallpaper_path(&self) -> PathBuf {
        self.temporary.as_ref().map_or_else(
            || self.paths.data.join("wallpapers.json"),
            |directory| directory.path().join("wallpapers.json"),
        )
    }

    fn report(&self) -> NativeResult<RecoveryStatus> {
        self.status
            .lock()
            .map(|value| value.clone())
            .map_err(|_| invalid("Recovery status is unavailable"))
    }
}

#[tauri::command]
#[specta::specta]
pub fn recovery_status(state: tauri::State<'_, RecoveryState>) -> NativeResult<RecoveryStatus> {
    state.report()
}

fn stage(state: &RecoveryState) -> NativeResult<RecoveryStatus> {
    let _operation = state.enter()?;
    let status = state.report()?;
    if !status.active {
        return Err(invalid("Settings recovery is not active"));
    }
    if status.pending {
        return Err(invalid(
            "Recovery is already scheduled; restart before making another replacement",
        ));
    }
    if state.paths.data.join(JOURNAL).exists() || state.paths.data.join(PENDING).exists() {
        return Err(invalid(
            "An interrupted recovery must be reviewed before scheduling another replacement",
        ));
    }
    protect_future(&state.paths)?;
    let temporary = tempfile::Builder::new()
        .prefix(".recovery-token-")
        .tempfile_in(&state.paths.data)
        .map_err(|e| failure("Cannot stage recovery in the original data directory", e))?;
    let token = temporary
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(".recovery-token-"))
        .ok_or_else(|| invalid("Invalid recovery token"))?
        .to_owned();
    validate_token(&token)?;
    let path = candidate(&state.paths, &token);
    write_json(
        &path,
        &SettingsSnapshot {
            revision: 0,
            settings: serde_json::json!({}),
        },
    )?;
    verify_settings(&path)?;
    write_json(&state.paths.data.join(PENDING), &Pending { token })?;
    let mut status = state
        .status
        .lock()
        .map_err(|_| invalid("Recovery status is unavailable"))?;
    status.pending = true;
    Ok(status.clone())
}

#[tauri::command]
#[specta::specta]
pub async fn stage_recovery(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> NativeResult<RecoveryStatus> {
    crate::commands::require_host_window(window.label())?;
    blocking::run(move || stage(&app.state::<RecoveryState>())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, DataPaths) {
        let root = tempfile::tempdir().unwrap();
        let paths = DataPaths {
            config: root.path().join("config"),
            data: root.path().join("data"),
            logs: root.path().join("logs"),
        };
        for path in [&paths.config, &paths.data, &paths.logs] {
            fs::create_dir(path).unwrap();
        }
        (root, paths)
    }

    fn isolated(paths: &DataPaths) -> InitializedStorage {
        fs::write(paths.config.join("settings.json"), vec![b'x'; 140 * 1024]).unwrap();
        let initialized = initialize(paths).unwrap();
        assert!(initialized.recovery.report().unwrap().active);
        initialized
    }

    #[test]
    fn status_remains_available_while_overlapping_recovery_changes_are_rejected() {
        let (_root, paths) = fixture();
        let initialized = isolated(&paths);
        let state = &initialized.recovery;
        let operation = state.enter().unwrap();
        assert!(state.report().unwrap().active);
        assert_eq!(stage(state).unwrap_err().code, ErrorCode::NativeBusy);
        assert!(!state.report().unwrap().pending);
        assert!(!paths.data.join(PENDING).exists());
        drop(operation);
        assert!(stage(state).unwrap().pending);
    }

    #[test]
    fn settings_reset_only_replaces_after_restart_and_archives_the_original() {
        let (_root, paths) = fixture();
        let initialized = isolated(&paths);
        let original = fs::read(paths.config.join("settings.json")).unwrap();
        assert!(initialized.recovery.is_isolated());
        assert_ne!(
            initialized.recovery.wallpaper_path(),
            paths.data.join("wallpapers.json")
        );
        stage(&initialized.recovery).unwrap();
        assert_eq!(
            fs::read(paths.config.join("settings.json")).unwrap(),
            original
        );
        drop(initialized);
        let restarted = initialize(&paths).unwrap();
        let status = restarted.recovery.report().unwrap();
        assert!(!status.active);
        assert_eq!(
            restarted.settings.snapshot().unwrap().settings,
            serde_json::json!({})
        );
        assert_eq!(
            fs::read(
                paths
                    .config
                    .join(status.archive_id.unwrap())
                    .join("settings.json")
            )
            .unwrap(),
            original
        );
        assert!(!paths.data.join(PENDING).exists());
        assert!(!paths.data.join(JOURNAL).exists());
    }

    #[test]
    fn failed_installation_restores_original_settings_and_preserves_the_candidate() {
        let (_root, paths) = fixture();
        let initialized = isolated(&paths);
        let original = fs::read(paths.config.join("settings.json")).unwrap();
        stage(&initialized.recovery).unwrap();
        let request: Pending = json(&paths.data.join(PENDING)).unwrap();
        assert!(
            apply_pending_with(&paths, || Err(invalid("simulated installation failure"))).is_err()
        );
        assert_eq!(
            fs::read(paths.config.join("settings.json")).unwrap(),
            original
        );
        assert!(candidate(&paths, &request.token).exists());
        assert!(paths.data.join(PENDING).exists());
        assert!(!paths.data.join(JOURNAL).exists());
    }

    #[test]
    fn interrupted_installation_rolls_back_before_retrying() {
        let (_root, paths) = fixture();
        let initialized = isolated(&paths);
        let original = fs::read(paths.config.join("settings.json")).unwrap();
        stage(&initialized.recovery).unwrap();
        drop(initialized);
        let request: Pending = json(&paths.data.join(PENDING)).unwrap();
        let journal = Journal {
            request,
            originals: vec!["settings.json".into()],
            installed: false,
        };
        let saved = archive(&paths, &journal.request.token, "settings.json").unwrap();
        fs::create_dir(saved.parent().unwrap()).unwrap();
        write_json(&paths.data.join(JOURNAL), &journal).unwrap();
        fs::rename(paths.config.join("settings.json"), &saved).unwrap();
        fs::rename(
            candidate(&paths, &journal.request.token),
            paths.config.join("settings.json"),
        )
        .unwrap();
        let archive_id = apply_pending(&paths).unwrap().unwrap();
        assert_eq!(
            fs::read(paths.config.join(archive_id).join("settings.json")).unwrap(),
            original
        );
        assert_eq!(
            SettingsStore::open(paths.config.join("settings.json"))
                .unwrap()
                .snapshot()
                .unwrap()
                .settings,
            serde_json::json!({})
        );
        assert!(!paths.data.join(JOURNAL).exists());
    }

    #[test]
    fn future_settings_are_never_overwritten_during_staging_or_restart() {
        let (_root, paths) = fixture();
        let initialized = isolated(&paths);
        let original = fs::read(paths.config.join("settings.json")).unwrap();
        let future = serde_json::json!({"revision": 1, "settings": {"schemaVersion": crate::storage::SETTINGS_SCHEMA_VERSION + 1}});
        write_json(&paths.config.join("settings.json"), &future).unwrap();
        assert!(stage(&initialized.recovery).is_err());
        assert!(!paths.data.join(PENDING).exists());
        fs::write(paths.config.join("settings.json"), original).unwrap();
        stage(&initialized.recovery).unwrap();
        write_json(&paths.config.join("settings.json"), &future).unwrap();
        let bytes = fs::read(paths.config.join("settings.json")).unwrap();
        assert!(apply_pending(&paths).is_err());
        assert_eq!(fs::read(paths.config.join("settings.json")).unwrap(), bytes);
        assert!(paths.data.join(PENDING).exists());
        assert!(!paths.data.join(JOURNAL).exists());
    }

    #[test]
    fn invalid_or_future_candidates_leave_originals_and_recovery_evidence_untouched() {
        for contents in [
            r#"{"revision":1,"settings":{"runInBackground":"yes"}}"#.to_owned(),
            r#"{"revision":-1,"settings":{}}"#.to_owned(),
            format!(
                r#"{{"revision":1,"settings":{{"schemaVersion":{}}}}}"#,
                crate::storage::SETTINGS_SCHEMA_VERSION + 1
            ),
            format!(
                "{}{}",
                r#"{"revision":1,"settings":{}}"#,
                " ".repeat(MAX_SETTINGS_FILE_SIZE)
            ),
        ] {
            let (_root, paths) = fixture();
            let initialized = isolated(&paths);
            let original = fs::read(paths.config.join("settings.json")).unwrap();
            stage(&initialized.recovery).unwrap();
            let pending_bytes = fs::read(paths.data.join(PENDING)).unwrap();
            let pending: Pending = serde_json::from_slice(&pending_bytes).unwrap();
            let path = candidate(&paths, &pending.token);
            fs::write(&path, &contents).unwrap();
            assert_eq!(
                apply_pending(&paths).unwrap_err().code,
                ErrorCode::StorageCorrupt
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
            assert_eq!(
                fs::read(paths.config.join("settings.json")).unwrap(),
                original
            );
            assert_eq!(fs::read(paths.data.join(PENDING)).unwrap(), pending_bytes);
            assert!(!paths.data.join(JOURNAL).exists());
        }
    }

    #[test]
    fn malformed_recovery_requests_remain_untouched_for_review() {
        for request in [
            serde_json::json!({"token": "../../outside"}),
            serde_json::json!({"token": "invalid", "unknown": true}),
        ] {
            let (_root, paths) = fixture();
            fs::write(paths.config.join("settings.json"), b"original settings").unwrap();
            write_json(&paths.data.join(PENDING), &request).unwrap();
            let pending = fs::read(paths.data.join(PENDING)).unwrap();
            let initialized = initialize(&paths).unwrap();
            assert!(initialized.recovery.is_isolated());
            assert!(stage(&initialized.recovery).is_err());
            assert_eq!(fs::read(paths.data.join(PENDING)).unwrap(), pending);
            assert_eq!(
                fs::read(paths.config.join("settings.json")).unwrap(),
                b"original settings"
            );
        }
    }

    #[test]
    fn healthy_older_settings_and_unwritable_logs_do_not_trigger_isolation() {
        let (_root, paths) = fixture();
        let original =
            br#"{"revision":7,"settings":{"schemaVersion":3,"windowPosition":"center"}}"#;
        fs::write(paths.config.join("settings.json"), original).unwrap();
        fs::remove_dir(&paths.logs).unwrap();
        fs::write(&paths.logs, b"log path blocked").unwrap();
        let initialized = initialize(&paths).unwrap();
        assert!(!initialized.recovery.is_isolated());
        assert_eq!(initialized.settings.snapshot().unwrap().revision, 7);
        assert_eq!(
            fs::read(paths.config.join("settings.json")).unwrap(),
            original
        );
        assert_eq!(fs::read(&paths.logs).unwrap(), b"log path blocked");
        assert!(stage(&initialized.recovery).is_err());
    }
}
