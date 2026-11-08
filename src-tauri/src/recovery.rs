//! 设置启动故障隔离与下次启动时的替换；原件先归档，未提交的替换可恢复。

use crate::{
    blocking,
    client_state::{
        CLIENT_STATE_FILE, ClientStateDocument, ClientStateStore, MAX_CLIENT_STATE_FILE_SIZE,
        future_client_format, read_document,
    },
    error::{ErrorCode, NativeError, NativeResult},
    storage::{DataPaths, atomic_write},
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

const PENDING: &str = ".client-recovery-pending-v0.json";
const JOURNAL: &str = ".client-recovery-transaction-v0.json";

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
    _temporary: Option<tempfile::TempDir>,
    status: Mutex<RecoveryStatus>,
    operation: Mutex<()>,
}

pub struct InitializedStorage {
    pub client_state: ClientStateStore,
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
    paths
        .config
        .join(format!(".client-recovery-next-{token}.json"))
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
        "client-state-v0.json" => Ok(paths.config.join(name)),
        _ => Err(invalid("Invalid recovery archive entry")),
    }
}

fn archive(paths: &DataPaths, token: &str, name: &str) -> NativeResult<PathBuf> {
    Ok(location(paths, name)?
        .parent()
        .ok_or_else(|| invalid("Invalid storage parent"))?
        .join(format!("client-recovery-archive-{token}"))
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
        > MAX_CLIENT_STATE_FILE_SIZE as u64
    {
        return Err(invalid(
            "Recovery settings candidate exceeds the supported size",
        ));
    }
    read_document(path)?;
    Ok(())
}

fn protect_future(paths: &DataPaths) -> NativeResult<()> {
    let settings = paths.config.join("client-state-v0.json");
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
            && future_client_format(&value)
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
    let destination = paths.config.join("client-state-v0.json");
    if !regular(&staged)?
        && regular(&destination)?
        && (regular(&archive(
            paths,
            &journal.request.token,
            "client-state-v0.json",
        )?)? || !journal
            .originals
            .iter()
            .any(|entry| entry == "client-state-v0.json"))
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
            verify_settings(&paths.config.join("client-state-v0.json"))?;
            remove_metadata(&paths.data.join(PENDING))?;
            remove_metadata(&paths.data.join(JOURNAL))?;
            return Ok(Some(format!(
                "client-recovery-archive-{}",
                journal.request.token
            )));
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
    let originals = if regular(&paths.config.join("client-state-v0.json"))? {
        vec!["client-state-v0.json".to_owned()]
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
            paths.config.join("client-state-v0.json"),
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
    Ok(Some(format!(
        "client-recovery-archive-{}",
        journal.request.token
    )))
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
        ClientStateStore::open(paths.config.join(CLIENT_STATE_FILE))
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
            client_state: settings?,
            recovery: RecoveryState {
                paths: paths.clone(),
                _temporary: None,
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
        client_state: ClientStateStore::open(temporary.path().join(CLIENT_STATE_FILE))?,
        recovery: RecoveryState {
            paths: paths.clone(),
            _temporary: Some(temporary),
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
        self._temporary.is_some()
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
    write_json(&path, &ClientStateDocument::default())?;
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
        fs::write(
            paths.config.join("client-state-v0.json"),
            vec![b'x'; 520 * 1024],
        )
        .unwrap();
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
        let original = fs::read(paths.config.join("client-state-v0.json")).unwrap();
        assert!(initialized.recovery.is_isolated());

        stage(&initialized.recovery).unwrap();
        assert_eq!(
            fs::read(paths.config.join("client-state-v0.json")).unwrap(),
            original
        );
        drop(initialized);
        let restarted = initialize(&paths).unwrap();
        let status = restarted.recovery.report().unwrap();
        assert!(!status.active);
        assert_eq!(
            restarted.client_state.snapshot("main").unwrap().state,
            crate::client_state::ClientWindowState::default()
        );
        assert_eq!(
            fs::read(
                paths
                    .config
                    .join(status.archive_id.unwrap())
                    .join("client-state-v0.json")
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
        let original = fs::read(paths.config.join("client-state-v0.json")).unwrap();
        stage(&initialized.recovery).unwrap();
        let request: Pending = json(&paths.data.join(PENDING)).unwrap();
        assert!(
            apply_pending_with(&paths, || Err(invalid("simulated installation failure"))).is_err()
        );
        assert_eq!(
            fs::read(paths.config.join("client-state-v0.json")).unwrap(),
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
        let original = fs::read(paths.config.join("client-state-v0.json")).unwrap();
        stage(&initialized.recovery).unwrap();
        drop(initialized);
        let request: Pending = json(&paths.data.join(PENDING)).unwrap();
        let journal = Journal {
            request,
            originals: vec!["client-state-v0.json".into()],
            installed: false,
        };
        let saved = archive(&paths, &journal.request.token, "client-state-v0.json").unwrap();
        fs::create_dir(saved.parent().unwrap()).unwrap();
        write_json(&paths.data.join(JOURNAL), &journal).unwrap();
        fs::rename(paths.config.join("client-state-v0.json"), &saved).unwrap();
        fs::rename(
            candidate(&paths, &journal.request.token),
            paths.config.join("client-state-v0.json"),
        )
        .unwrap();
        let archive_id = apply_pending(&paths).unwrap().unwrap();
        assert_eq!(
            fs::read(paths.config.join(archive_id).join("client-state-v0.json")).unwrap(),
            original
        );
        assert_eq!(
            ClientStateStore::open(paths.config.join("client-state-v0.json"))
                .unwrap()
                .snapshot("main")
                .unwrap()
                .state,
            crate::client_state::ClientWindowState::default()
        );
        assert!(!paths.data.join(JOURNAL).exists());
    }

    #[test]
    fn future_settings_are_never_overwritten_during_staging_or_restart() {
        let (_root, paths) = fixture();
        let initialized = isolated(&paths);
        let original = fs::read(paths.config.join("client-state-v0.json")).unwrap();
        let future = serde_json::json!({"formatVersion": "9.0", "windows": {}});
        write_json(&paths.config.join("client-state-v0.json"), &future).unwrap();
        assert!(stage(&initialized.recovery).is_err());
        assert!(!paths.data.join(PENDING).exists());
        fs::write(paths.config.join("client-state-v0.json"), original).unwrap();
        stage(&initialized.recovery).unwrap();
        write_json(&paths.config.join("client-state-v0.json"), &future).unwrap();
        let bytes = fs::read(paths.config.join("client-state-v0.json")).unwrap();
        assert!(apply_pending(&paths).is_err());
        assert_eq!(
            fs::read(paths.config.join("client-state-v0.json")).unwrap(),
            bytes
        );
        assert!(paths.data.join(PENDING).exists());
        assert!(!paths.data.join(JOURNAL).exists());
    }

    #[test]
    fn future_window_format_refuses_staging_without_creating_recovery_metadata() {
        for label in ["main", "secondary"] {
            let (_root, paths) = fixture();
            let mut future = serde_json::to_value(ClientStateDocument::default()).unwrap();
            future["windows"][label]["formatVersion"] = "0.2".into();
            let path = paths.config.join("client-state-v0.json");
            write_json(&path, &future).unwrap();
            let original = fs::read(&path).unwrap();
            assert!(read_document(&path).is_err());
            let initialized = initialize(&paths).unwrap();
            assert!(initialized.recovery.is_isolated());

            assert_eq!(
                stage(&initialized.recovery).unwrap_err().code,
                ErrorCode::StorageCorrupt
            );
            assert_eq!(fs::read(&path).unwrap(), original);
            assert!(!initialized.recovery.report().unwrap().pending);
            assert!(!paths.data.join(PENDING).exists());
            assert!(!paths.data.join(JOURNAL).exists());
            assert_eq!(fs::read_dir(&paths.config).unwrap().count(), 1);
            assert_eq!(fs::read_dir(&paths.data).unwrap().count(), 0);
        }
    }

    #[test]
    fn future_window_format_refuses_restart_and_preserves_pending_candidate() {
        for label in ["main", "secondary"] {
            let (_root, paths) = fixture();
            let initialized = isolated(&paths);
            stage(&initialized.recovery).unwrap();
            let pending_bytes = fs::read(paths.data.join(PENDING)).unwrap();
            let request: Pending = serde_json::from_slice(&pending_bytes).unwrap();
            let staged = candidate(&paths, &request.token);
            let candidate_bytes = fs::read(&staged).unwrap();
            let mut future = serde_json::to_value(ClientStateDocument::default()).unwrap();
            future["windows"][label]["formatVersion"] = "0.2".into();
            let path = paths.config.join("client-state-v0.json");
            write_json(&path, &future).unwrap();
            let original = fs::read(&path).unwrap();
            assert!(read_document(&path).is_err());
            drop(initialized);

            let restarted = initialize(&paths).unwrap();
            assert_eq!(fs::read(&path).unwrap(), original);
            assert!(restarted.recovery.is_isolated());
            assert_eq!(fs::read(paths.data.join(PENDING)).unwrap(), pending_bytes);
            assert_eq!(fs::read(&staged).unwrap(), candidate_bytes);
            assert!(!paths.data.join(JOURNAL).exists());
            assert!(
                !paths
                    .config
                    .join(format!("client-recovery-archive-{}", request.token))
                    .exists()
            );
        }
    }

    #[test]
    fn invalid_or_future_candidates_leave_originals_and_recovery_evidence_untouched() {
        for contents in [
            r#"{"revision":1,"settings":{"runInBackground":"yes"}}"#.to_owned(),
            r#"{"revision":-1,"settings":{}}"#.to_owned(),
            r#"{"formatVersion":"9.0","windows":{}}"#.to_owned(),
            format!(
                "{}{}",
                r#"{"revision":1,"settings":{}}"#,
                " ".repeat(MAX_CLIENT_STATE_FILE_SIZE)
            ),
        ] {
            let (_root, paths) = fixture();
            let initialized = isolated(&paths);
            let original = fs::read(paths.config.join("client-state-v0.json")).unwrap();
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
                fs::read(paths.config.join("client-state-v0.json")).unwrap(),
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
            fs::write(
                paths.config.join("client-state-v0.json"),
                b"original settings",
            )
            .unwrap();
            write_json(&paths.data.join(PENDING), &request).unwrap();
            let pending = fs::read(paths.data.join(PENDING)).unwrap();
            let initialized = initialize(&paths).unwrap();
            assert!(initialized.recovery.is_isolated());
            assert!(stage(&initialized.recovery).is_err());
            assert_eq!(fs::read(paths.data.join(PENDING)).unwrap(), pending);
            assert_eq!(
                fs::read(paths.config.join("client-state-v0.json")).unwrap(),
                b"original settings"
            );
        }
    }

    #[test]
    fn healthy_client_state_and_unwritable_logs_do_not_trigger_isolation() {
        let (_root, paths) = fixture();
        let original = serde_json::to_vec(&ClientStateDocument::default()).unwrap();
        fs::write(paths.config.join("client-state-v0.json"), &original).unwrap();
        fs::remove_dir(&paths.logs).unwrap();
        fs::write(&paths.logs, b"log path blocked").unwrap();
        let initialized = initialize(&paths).unwrap();
        assert!(!initialized.recovery.is_isolated());
        assert_eq!(
            initialized.client_state.snapshot("main").unwrap().revision,
            0.into()
        );
        assert_eq!(
            fs::read(paths.config.join("client-state-v0.json")).unwrap(),
            original
        );
        assert!(stage(&initialized.recovery).is_err());
    }
}

#[cfg(test)]
mod client_state_tests {
    use super::*;
    #[test]
    fn client_state_recovery_does_not_read_or_replace_legacy_settings() {
        let directory = tempfile::tempdir().unwrap();
        let paths = DataPaths {
            config: directory.path().join("config"),
            data: directory.path().join("data"),
            logs: directory.path().join("logs"),
        };
        fs::create_dir(&paths.config).unwrap();
        fs::write(paths.config.join("settings.json"), b"legacy user original").unwrap();
        let initialized = initialize(&paths).unwrap();
        assert!(!initialized.recovery.is_isolated());
        assert_eq!(
            fs::read(paths.config.join("settings.json")).unwrap(),
            b"legacy user original"
        );
        assert!(
            !paths
                .config
                .join(crate::client_state::CLIENT_STATE_FILE)
                .exists()
        );
    }
}
