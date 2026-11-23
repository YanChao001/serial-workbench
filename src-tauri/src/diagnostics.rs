use std::{
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Instant, SystemTime},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::{
    desktop::{self, DesktopStatus},
    error::{ErrorCode, NativeError, NativeResult, bounded_text},
    platform_settings::PlatformSettings,
    redaction::redact,
    storage::DataPaths,
    updater,
};

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FrontendError {
    pub message: String,
    pub stack: Option<String>,
    pub component_stack: Option<String>,
}

pub struct DiagnosticsState(Mutex<(Instant, u32)>);
impl Default for DiagnosticsState {
    fn default() -> Self {
        Self(Mutex::new((Instant::now(), 0)))
    }
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub format_version: String,
    pub collected_at: String,
    pub app_version: String,
    pub tauri_version: String,
    pub platform: String,
    pub architecture: String,
    pub window_label: String,
    pub settings_revision: Option<serial_workbench_core::U64>,
    pub configuration: Option<DiagnosticsConfiguration>,
    pub desktop: DesktopStatus,
    pub autostart_enabled: Option<bool>,
    pub updater_configured: bool,
    pub recent_logs: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsConfiguration {
    pub language: serial_workbench_core::Language,
    pub network_mode: serial_workbench_core::settings::NetworkMode,
    pub run_in_background: bool,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save_diagnostics_json(
    window: tauri::WebviewWindow,
    content: String,
) -> NativeResult<bool> {
    let app = window.app_handle().clone();
    let owner = diagnostic_owner(&window)?;
    crate::blocking::run(move || {
        crate::file_access::save_text_content_with_picker(&content, 512 * 1024, || {
            let Some(selected) = app
                .dialog()
                .file()
                .set_parent(&window)
                .add_filter("JSON", &["json"])
                .set_file_name("serial-workbench-diagnostics.json")
                .blocking_save_file()
            else {
                return Ok(None);
            };
            if diagnostic_owner(&window)? != owner {
                return Err(NativeError::new(
                    ErrorCode::Conflict,
                    "Diagnostics window changed",
                ));
            }
            let path = selected.into_path().map_err(|error| {
                NativeError::operation(
                    ErrorCode::InvalidArgument,
                    "Invalid diagnostics destination",
                    error,
                )
            })?;
            Ok(Some(diagnostics_destination(path)?))
        })
        .map(|path| path.is_some())
    })
    .await
}

fn diagnostic_owner(window: &tauri::WebviewWindow) -> NativeResult<u64> {
    window
        .state::<crate::host_bridge::DesktopHostBridge>()
        .bind_window(window)
        .map_err(|error| NativeError::new(ErrorCode::Conflict, error.message))
}

fn diagnostics_destination(path: PathBuf) -> NativeResult<PathBuf> {
    let extension = path.extension().and_then(|value| value.to_str());
    if !extension.is_some_and(|value| value.eq_ignore_ascii_case("json")) {
        return Err(NativeError::new(
            ErrorCode::InvalidArgument,
            "Select a .json diagnostics destination",
        ));
    }
    Ok(path)
}

pub fn record(state: &DiagnosticsState, error: FrontendError) -> NativeResult<()> {
    bounded_text(&error.message, 4096, "Error message")?;
    bounded_text(
        error.stack.as_deref().unwrap_or_default(),
        8192,
        "Error stack",
    )?;
    bounded_text(
        error.component_stack.as_deref().unwrap_or_default(),
        8192,
        "Component stack",
    )?;
    let mut rate = state
        .0
        .lock()
        .map_err(|_| NativeError::new(ErrorCode::Internal, "Diagnostics state is unavailable"))?;
    if rate.0.elapsed().as_secs() >= 60 {
        *rate = (Instant::now(), 0);
    }
    if rate.1 >= 30 {
        return Ok(());
    }
    rate.1 += 1;
    log::error!(target: "frontend", "{}\n{}\n{}", redact(&error.message), redact(error.stack.as_deref().unwrap_or_default()), redact(error.component_stack.as_deref().unwrap_or_default()));
    Ok(())
}

pub fn report(app: &tauri::AppHandle, label: &str) -> NativeResult<DiagnosticsReport> {
    let paths = app.state::<DataPaths>();
    let settings = app.state::<PlatformSettings>().snapshot()?;
    let collected_at = chrono::DateTime::<chrono::Utc>::from(SystemTime::now());
    Ok(DiagnosticsReport {
        format_version: "0.1".into(),
        collected_at: collected_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        app_version: app.package_info().version.to_string(),
        tauri_version: tauri::VERSION.into(),
        platform: std::env::consts::OS.into(),
        architecture: std::env::consts::ARCH.into(),
        window_label: label.into(),
        settings_revision: settings.as_ref().map(|snapshot| snapshot.revision),
        configuration: settings.map(|snapshot| DiagnosticsConfiguration {
            language: snapshot.value.language,
            network_mode: snapshot.value.network_mode,
            run_in_background: snapshot.value.run_in_background,
        }),
        desktop: desktop::status(app),
        autostart_enabled: desktop::get_autostart(app).ok(),
        updater_configured: updater::load_policy(&paths).is_ok_and(|value| value.is_some()),
        recent_logs: collect_log_tail(&paths.logs.join("app.log")),
    })
}

fn collect_log_tail(path: &Path) -> Option<String> {
    const TAIL_BYTES: u64 = 64 * 1024;
    let Some(mut file) = serial_workbench_ipc::open_local_log(path).ok()? else {
        return Some(String::new());
    };
    let start = file.metadata().ok()?.len().saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.take(TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    Some(redact_log_tail(&bytes, start != 0))
}

fn redact_log_tail(bytes: &[u8], starts_mid_file: bool) -> String {
    // 起始半行可能没有脱敏规则需要的字段名。
    let complete = if starts_mid_file {
        bytes
            .splitn(2, |byte| *byte == b'\n')
            .nth(1)
            .unwrap_or_default()
    } else {
        bytes
    };
    static RECORD_START: OnceLock<regex::Regex> = OnceLock::new();
    let prefix = RECORD_START.get_or_init(|| {
        regex::Regex::new(r"^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[(?:ERROR|WARN|INFO|DEBUG|TRACE)\]\[[\w.:-]+\] ")
            .expect("valid application log prefix")
    });
    // 应用 logger 的记录首行可独立脱敏。续行可能来自堆栈、序列化凭据或密钥正文。
    redact(&String::from_utf8_lossy(complete))
        .split_inclusive('\n')
        .filter(|line| line.ends_with('\n') && prefix.is_match(line))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{collect_log_tail, diagnostics_destination, redact_log_tail};
    use crate::file_access::save_text_content_with_picker;
    use std::path::PathBuf;

    #[test]
    fn diagnostics_save_refuses_to_replace_the_source_log() {
        assert!(diagnostics_destination(PathBuf::from("app.log")).is_err());
        assert!(diagnostics_destination(PathBuf::from("diagnostics.JSON")).is_ok());
    }

    #[test]
    fn omitted_log_tail_distinguishes_missing_log_from_an_unusable_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("app.log");
        assert_eq!(collect_log_tail(&path), Some(String::new()));
        std::fs::create_dir(&path).unwrap();
        assert_eq!(collect_log_tail(&path), None);
    }

    #[test]
    fn diagnostics_save_writes_the_preview_bytes_and_cancel_leaves_the_destination() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("diagnostics.json");
        let preview = "{\n  \"recentLogs\": \"测试 [redacted]\"\n}";
        save_text_content_with_picker(preview, 512 * 1024, || {
            diagnostics_destination(path.clone()).map(Some)
        })
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), preview.as_bytes());
        save_text_content_with_picker("another report", 512 * 1024, || Ok(None)).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), preview.as_bytes());
    }

    #[test]
    fn export_excludes_a_clipped_credential_and_redacts_visible_fields() {
        let prefix = "[2026-11-23][12:00:00][INFO][frontend] ";
        let bytes = format!(
            "clipped-private-suffix\nprivate-continuation\n{prefix}pairing_code=123456 credential=private-token\n{prefix}connection refused\nbacktrace continuation\n"
        );
        assert_eq!(
            redact_log_tail(bytes.as_bytes(), true),
            format!(
                "{prefix}pairing_code=[redacted] credential=[redacted]\n{prefix}connection refused\n"
            )
        );
        assert!(redact_log_tail(b"only-a-clipped-line", true).is_empty());
        assert!(
            redact_log_tail(format!("{prefix}incomplete final record").as_bytes(), false)
                .is_empty()
        );
    }
}
