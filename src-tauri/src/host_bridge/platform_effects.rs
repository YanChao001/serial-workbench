//! 固定平台服务执行器；桥拥有投递身份、窗口实例与工作队列。
use std::{future::Future, pin::Pin};

use serial_workbench_core::{
    CLIENT_DIAGNOSTICS_MAX_LOG_BYTES, ClientCapability, ClientDesktopStatus,
    ClientDiagnosticsReport, ClientEffectAction, ClientEffectResult, ClientPlatformEffects,
    ClientRecoveryStatus, ClientRequestedEffect, ClientSettingsEffectsReceipt, ClientSystemStatus,
    ClientUpdateProgress, ClientUpdateSnapshot, ClientUpdateStage, ClientUpdateStatus,
    ClientWindowGeometry, ClientWindowSnapshot, HostError, HostResult, Timestamp, True, U64,
};
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::{
    blocking, desktop,
    diagnostics::DiagnosticsReport,
    error::{ErrorCode, NativeError},
    lifecycle::{self, LifecycleAction},
    recovery, updater,
    window_geometry::{self, WindowGeometry},
};

pub(super) trait PlatformEffectExecutor: Send + Sync {
    fn capabilities(&self) -> Vec<ClientCapability>;
    fn execute<'a>(
        &'a self,
        action: ClientEffectAction,
    ) -> Pin<Box<dyn Future<Output = HostResult<ClientEffectResult>> + Send + 'a>>;
}

pub(super) struct PlatformEffects {
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    generation: U64,
}

impl PlatformEffects {
    pub(super) fn new(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        generation: U64,
    ) -> Self {
        Self {
            app,
            window,
            generation,
        }
    }
}

impl PlatformEffectExecutor for PlatformEffects {
    fn capabilities(&self) -> Vec<ClientCapability> {
        implemented_capabilities()
    }

    fn execute<'a>(
        &'a self,
        action: ClientEffectAction,
    ) -> Pin<Box<dyn Future<Output = HostResult<ClientEffectResult>> + Send + 'a>> {
        Box::pin(async move {
            action.validate()?;
            if !self.capabilities().contains(&action.capability()) {
                return Err(HostError::new(
                    "PERMISSION_DENIED",
                    "该窗口未登记此平台能力",
                ));
            }
            let app = self.app.clone();
            let window = self.window.clone();
            let capability = action.capability();
            let result = match action {
                ClientEffectAction::WindowRead {} => {
                    let snapshot = blocking::run(move || {
                        Ok(ClientWindowSnapshot {
                            geometry: geometry(window_geometry::read(window.clone())?),
                            maximized: window.is_maximized().map_err(window_error)?,
                            fullscreen: window.is_fullscreen().map_err(window_error)?,
                        })
                    })
                    .await
                    .map_err(native_error)?;
                    ClientEffectResult::Window(snapshot)
                }
                ClientEffectAction::WindowMinimize {} => {
                    blocking::run(move || window.minimize().map_err(window_error))
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::Applied {}
                }
                ClientEffectAction::WindowToggleMaximize {} => {
                    let maximized = blocking::run(move || {
                        if window.is_maximized().map_err(window_error)? {
                            window.unmaximize().map_err(window_error)?;
                        } else {
                            window.maximize().map_err(window_error)?;
                        }
                        window.is_maximized().map_err(window_error)
                    })
                    .await
                    .map_err(native_error)?;
                    ClientEffectResult::Maximized { maximized }
                }
                ClientEffectAction::WindowSetFullscreen { fullscreen } => {
                    let fullscreen = blocking::run(move || {
                        window.set_fullscreen(fullscreen).map_err(window_error)?;
                        window.is_fullscreen().map_err(window_error)
                    })
                    .await
                    .map_err(native_error)?;
                    ClientEffectResult::Fullscreen { fullscreen }
                }
                ClientEffectAction::WindowSetSize { width, height } => {
                    let value = blocking::run(move || {
                        window_geometry::set_size(window, width.get() as f64, height.get() as f64)
                    })
                    .await
                    .map_err(native_error)?;
                    ClientEffectResult::Geometry(geometry(value))
                }
                ClientEffectAction::WindowResetGeometry { center } => {
                    let value = blocking::run(move || window_geometry::reset(window, center))
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::Geometry(geometry(value))
                }
                ClientEffectAction::WindowShowMain {} => {
                    blocking::run(move || desktop::show_main(&app))
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::Requested {
                        effect: ClientRequestedEffect::MainWindowRequested,
                    }
                }
                ClientEffectAction::WindowOpenSecondary {} => {
                    blocking::run(move || desktop::open_secondary(&app))
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::Requested {
                        effect: ClientRequestedEffect::SecondaryWindowRequested,
                    }
                }
                ClientEffectAction::ClipboardReadText {} => {
                    let text = blocking::run(move || {
                        app.clipboard().read_text().map_err(|_| {
                            NativeError::new(ErrorCode::PlatformUnavailable, "无法读取系统剪贴板")
                        })
                    })
                    .await
                    .map_err(native_error)?;
                    clipboard_text(text)?
                }
                ClientEffectAction::ClipboardWriteText { text } => {
                    // 正文已由 Core 验证；错误与日志不包含剪贴板内容。
                    blocking::run(move || {
                        app.clipboard().write_text(text).map_err(|_| {
                            NativeError::new(ErrorCode::PlatformUnavailable, "无法写入系统剪贴板")
                        })
                    })
                    .await
                    .map_err(native_error)?;
                    ClientEffectResult::ClipboardWritten { written: True }
                }
                ClientEffectAction::SystemRead {} => {
                    let status = blocking::run(move || {
                        Ok(ClientSystemStatus {
                            desktop: desktop_status(desktop::status(&app)),
                            autostart_enabled: desktop::get_autostart(&app).ok(),
                        })
                    })
                    .await
                    .map_err(native_error)?;
                    ClientEffectResult::System(status)
                }
                ClientEffectAction::SystemSetAutostart { enabled } => {
                    let enabled = blocking::run(move || desktop::set_autostart(&app, enabled))
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::Autostart { enabled }
                }
                ClientEffectAction::UpdaterCheck {} => {
                    let status = app
                        .state::<updater::UpdateManager>()
                        .check(&app)
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::UpdateStatus(update_status(status)?)
                }
                ClientEffectAction::UpdaterRead {} => {
                    let progress = app
                        .state::<updater::UpdateManager>()
                        .snapshot()
                        .map_err(native_error)?
                        .map(update_progress)
                        .transpose()?;
                    ClientEffectResult::UpdateProgress(ClientUpdateSnapshot { progress })
                }
                ClientEffectAction::UpdaterInstall {} => {
                    // 此服务内部进行 InstallUpdate 授权与策略复核，真实安装成功才回执。
                    app.state::<updater::UpdateManager>()
                        .install(&app)
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::Installed {}
                }
                ClientEffectAction::AppRestart {} => {
                    lifecycle::request_action(&app, LifecycleAction::Restart, None);
                    ClientEffectResult::Requested {
                        effect: ClientRequestedEffect::RestartRequested,
                    }
                }
                ClientEffectAction::AppQuit {} => {
                    lifecycle::request_action(&app, LifecycleAction::Quit, None);
                    ClientEffectResult::Requested {
                        effect: ClientRequestedEffect::QuitRequested,
                    }
                }
                ClientEffectAction::DiagnosticsRead {} => {
                    let label = window.label().to_owned();
                    let report = blocking::run(move || crate::diagnostics::report(&app, &label))
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::Diagnostics(diagnostics(report))
                }
                ClientEffectAction::RecoveryRead {} => {
                    let value = blocking::run(move || {
                        recovery::recovery_status(app.state::<recovery::RecoveryState>())
                    })
                    .await
                    .map_err(native_error)?;
                    ClientEffectResult::Recovery(recovery_status(value))
                }
                ClientEffectAction::RecoveryStage {} => {
                    let value = recovery::stage_recovery(app, window)
                        .await
                        .map_err(native_error)?;
                    ClientEffectResult::Recovery(recovery_status(value))
                }
                ClientEffectAction::WindowClose {} => {
                    let instance = app
                        .state::<super::DesktopHostBridge>()
                        .bind_window(&window)?;
                    lifecycle::request_bound_window_close(&app, window, instance)?;
                    ClientEffectResult::Requested {
                        effect: ClientRequestedEffect::CloseRequested,
                    }
                }
                ClientEffectAction::SettingsApplyEffects {} => {
                    let value = crate::commands::apply_host_settings_effects_for_generation(
                        app,
                        window,
                        self.generation,
                    )
                    .await?;
                    ClientEffectResult::SettingsApplied(ClientSettingsEffectsReceipt {
                        host_id: value.host_id,
                        instance_epoch: value.instance_epoch,
                        revision: value.revision,
                        effects: ClientPlatformEffects {
                            tray_language: value.effects.tray_language,
                            network_mode: value.effects.network_mode,
                            run_in_background: value.effects.run_in_background,
                        },
                    })
                }
            };
            result.validate_for(capability)?;
            Ok(result)
        })
    }
}

fn implemented_capabilities() -> Vec<ClientCapability> {
    use ClientCapability as C;
    let mut capabilities = vec![
        C::WindowRead,
        C::WindowMinimize,
        C::WindowToggleMaximize,
        C::WindowSetFullscreen,
        C::WindowSetSize,
        C::WindowResetGeometry,
        C::WindowShowMain,
        C::WindowOpenSecondary,
        C::WindowClose,
        C::ClipboardReadText,
        C::ClipboardWriteText,
        C::SystemRead,
        C::SettingsApplyEffects,
        C::UpdaterCheck,
        C::UpdaterRead,
        C::UpdaterInstall,
        C::AppRestart,
        C::AppQuit,
        C::DiagnosticsRead,
        C::RecoveryRead,
        C::RecoveryStage,
    ];
    if !cfg!(feature = "e2e") {
        capabilities.push(C::SystemSetAutostart);
    }
    capabilities
}
fn geometry(value: WindowGeometry) -> ClientWindowGeometry {
    ClientWindowGeometry {
        width: u64::from(value.width).into(),
        height: u64::from(value.height).into(),
        min_width: u64::from(value.min_width).into(),
        min_height: u64::from(value.min_height).into(),
        max_width: u64::from(value.max_width).into(),
        max_height: u64::from(value.max_height).into(),
        default_width: u64::from(value.default_width).into(),
        default_height: u64::from(value.default_height).into(),
    }
}
fn window_error(error: tauri::Error) -> NativeError {
    NativeError::operation(ErrorCode::WindowError, "无法执行窗口操作", error)
}
fn native_error(value: NativeError) -> HostError {
    let code = match value.code {
        ErrorCode::InvalidArgument => "INVALID_ARGUMENT",
        ErrorCode::UserCancelled => "USER_CANCELLED",
        ErrorCode::InputTooLong => "INPUT_TOO_LONG",
        ErrorCode::StorageIo => "STORAGE_IO",
        ErrorCode::StorageCorrupt => "STORAGE_CORRUPT",
        ErrorCode::SettingsConflict => "SETTINGS_CONFLICT",
        ErrorCode::NotFound => "NOT_FOUND",
        ErrorCode::Conflict => "CONFLICT",
        ErrorCode::PlatformUnavailable => "PLATFORM_UNAVAILABLE",
        ErrorCode::NativeBusy => "HOST_BUSY",
        ErrorCode::AutostartError => "AUTOSTART_ERROR",
        ErrorCode::UpdateNotConfigured => "UPDATE_NOT_CONFIGURED",
        ErrorCode::UpdateBusy => "UPDATE_BUSY",
        ErrorCode::UpdateCheckFailed => "UPDATE_CHECK_FAILED",
        ErrorCode::UpdateCheckTimeout => "UPDATE_CHECK_TIMEOUT",
        ErrorCode::UpdateFeedUnavailable => "UPDATE_FEED_UNAVAILABLE",
        ErrorCode::UpdatePlatformUnavailable => "UPDATE_PLATFORM_UNAVAILABLE",
        ErrorCode::UpdateDownloadFailed => "UPDATE_DOWNLOAD_FAILED",
        ErrorCode::UpdateInstallFailed => "UPDATE_INSTALL_FAILED",
        ErrorCode::WindowError => "WINDOW_ERROR",
        ErrorCode::Internal => "INTERNAL",
    };
    let mut error = HostError::new(code, crate::redaction::redact(&value.message));
    error.retryable = value.retryable;
    error
}
fn counter(value: f64) -> HostResult<U64> {
    if !value.is_finite()
        || value.fract() != 0.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&value)
    {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "原生更新计数无法精确表示",
        ));
    }
    Ok((value as u64).into())
}
fn checked_at(value: f64) -> HostResult<Timestamp> {
    let millis = counter(value.floor())?.get();
    let millis = i64::try_from(millis)
        .map_err(|_| HostError::new("INVALID_ARGUMENT", "原生更新时间超出范围"))?;
    let date = chrono::DateTime::from_timestamp_millis(millis)
        .ok_or_else(|| HostError::new("INVALID_ARGUMENT", "原生更新时间超出范围"))?;
    Timestamp::try_from(
        date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            .as_str(),
    )
}
fn update_status(value: updater::UpdateStatus) -> HostResult<ClientUpdateStatus> {
    let native_operation_id = u64::try_from(value.operation_id)
        .map_err(|_| HostError::new("INVALID_ARGUMENT", "原生更新操作编号无效"))?
        .into();
    Ok(ClientUpdateStatus {
        native_operation_id,
        configured: value.configured,
        available: value.available,
        current_version: value.current_version,
        endpoint: value.endpoint,
        checked_at: value.checked_at.map(checked_at).transpose()?,
        version: value.version,
        body: value.body,
        date: value.date,
    })
}
fn update_progress(value: updater::UpdateProgress) -> HostResult<ClientUpdateProgress> {
    let native_operation_id = u64::try_from(value.operation_id)
        .map_err(|_| HostError::new("INVALID_ARGUMENT", "原生更新操作编号无效"))?
        .into();
    let stage = match value.stage {
        updater::UpdateStage::Checking => ClientUpdateStage::Checking,
        updater::UpdateStage::Checked => ClientUpdateStage::Checked,
        updater::UpdateStage::Downloading => ClientUpdateStage::Downloading,
        updater::UpdateStage::Installing => ClientUpdateStage::Installing,
        updater::UpdateStage::Installed => ClientUpdateStage::Installed,
        updater::UpdateStage::Cancelled => ClientUpdateStage::Cancelled,
        updater::UpdateStage::Failed => ClientUpdateStage::Failed,
    };
    Ok(ClientUpdateProgress {
        native_operation_id,
        stage,
        downloaded: counter(value.downloaded)?,
        total: value.total.map(counter).transpose()?,
        status: value.status.map(update_status).transpose()?,
        error: value.error.map(native_error),
    })
}
fn clipboard_text(text: String) -> HostResult<ClientEffectResult> {
    let result = ClientEffectResult::ClipboardText { text };
    result.validate_for(ClientCapability::ClipboardReadText)?;
    Ok(result)
}
fn desktop_status(value: desktop::DesktopStatus) -> ClientDesktopStatus {
    ClientDesktopStatus {
        tray_available: value.tray_available,
        secondary_open: value.secondary_open,
        autostart_supported: value.autostart_supported,
        run_in_background: value.run_in_background,
    }
}
fn recovery_status(value: recovery::RecoveryStatus) -> ClientRecoveryStatus {
    ClientRecoveryStatus {
        active: value.active,
        reason: value.reason.map(|reason| crate::redaction::redact(&reason)),
        pending: value.pending,
        archive_id: value.archive_id,
    }
}
fn diagnostics(value: DiagnosticsReport) -> ClientDiagnosticsReport {
    let mut recent_logs = crate::redaction::redact(&value.recent_logs);
    if recent_logs.len() > CLIENT_DIAGNOSTICS_MAX_LOG_BYTES {
        // 脱敏可能扩展文本；保留最新日志并沿 UTF-8 边界去掉最早部分。
        let mut start = recent_logs.len() - CLIENT_DIAGNOSTICS_MAX_LOG_BYTES;
        while !recent_logs.is_char_boundary(start) {
            start += 1;
        }
        recent_logs.drain(..start);
    }
    ClientDiagnosticsReport {
        app_version: value.app_version,
        tauri_version: value.tauri_version,
        platform: value.platform,
        architecture: value.architecture,
        window_label: value.window_label,
        settings_revision: value.settings_revision,
        desktop: desktop_status(value.desktop),
        autostart_enabled: value.autostart_enabled,
        updater_configured: value.updater_configured,
        recent_logs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{desktop::DesktopStatus, error::ErrorCode};
    use serial_workbench_core::{
        CLIENT_CLIPBOARD_MAX_BYTES, CLIENT_DIAGNOSTICS_MAX_LOG_BYTES, ClientUpdateStage,
    };

    #[test]
    fn advertises_closed_fixed_services_and_respects_autostart_platform_support() {
        let capabilities = implemented_capabilities();
        assert!(capabilities.contains(&ClientCapability::WindowRead));
        assert!(capabilities.contains(&ClientCapability::ClipboardReadText));
        assert!(capabilities.contains(&ClientCapability::UpdaterInstall));
        assert!(capabilities.contains(&ClientCapability::WindowClose));
        assert!(capabilities.contains(&ClientCapability::SettingsApplyEffects));
        assert_eq!(
            capabilities.contains(&ClientCapability::SystemSetAutostart),
            !cfg!(feature = "e2e")
        );
        assert_eq!(
            capabilities.len(),
            ClientCapability::ALL.len() - usize::from(cfg!(feature = "e2e"))
        );
        let mut unique = std::collections::HashSet::new();
        assert!(capabilities.into_iter().all(|item| unique.insert(item)));
    }

    #[test]
    fn preserves_logical_geometry_and_constraints() {
        let result = geometry(WindowGeometry {
            width: 901,
            height: 602,
            min_width: 400,
            min_height: 300,
            max_width: 2000,
            max_height: 1500,
            default_width: 1100,
            default_height: 760,
        });
        assert_eq!((result.width.get(), result.height.get()), (901, 602));
        assert_eq!(
            (result.min_width.get(), result.min_height.get()),
            (400, 300)
        );
        assert_eq!(
            (result.max_width.get(), result.max_height.get()),
            (2000, 1500)
        );
        assert_eq!(
            (result.default_width.get(), result.default_height.get()),
            (1100, 760)
        );
    }

    #[test]
    fn native_errors_keep_code_retryability_and_redact_credentials() {
        let mapped = native_error(NativeError::new(
            ErrorCode::UpdateCheckTimeout,
            "https://user:secret@example.com/update?token=private",
        ));
        assert_eq!(mapped.code, "UPDATE_CHECK_TIMEOUT");
        assert!(mapped.retryable);
        assert!(!mapped.message.contains("secret"));
        assert!(!mapped.message.contains("private"));
        assert_eq!(
            native_error(NativeError::new(ErrorCode::UserCancelled, "取消")).code,
            "USER_CANCELLED"
        );
        assert_eq!(
            native_error(NativeError::new(ErrorCode::NativeBusy, "繁忙")).code,
            "HOST_BUSY"
        );
    }

    #[test]
    fn update_counter_rejects_fractional_negative_nonfinite_and_unsafe_values() {
        for value in [-1.0, 1.5, f64::NAN, f64::INFINITY, 9_007_199_254_740_992.0] {
            assert!(counter(value).is_err(), "{value}");
        }
        assert_eq!(
            counter(9_007_199_254_740_991.0).unwrap().get(),
            9_007_199_254_740_991
        );
    }

    fn status() -> updater::UpdateStatus {
        updater::UpdateStatus {
            operation_id: 7,
            configured: true,
            available: true,
            current_version: "1.0.0".into(),
            endpoint: Some("https://example.com/update".into()),
            checked_at: Some(1_800_000_000_123.0),
            version: Some("1.1.0".into()),
            body: Some("修复".into()),
            date: Some("2026-11-08".into()),
        }
    }

    #[test]
    fn update_mapping_preserves_native_operation_and_optional_metadata() {
        let mapped = update_status(status()).unwrap();
        assert_eq!(mapped.native_operation_id.get(), 7);
        assert_eq!(
            mapped.checked_at.unwrap().as_str(),
            "2027-01-15T08:00:00.123Z"
        );
        assert_eq!(mapped.body.as_deref(), Some("修复"));
        let mut fractional_time = status();
        fractional_time.checked_at = Some(1_800_000_000_123.75);
        assert_eq!(
            update_status(fractional_time)
                .unwrap()
                .checked_at
                .unwrap()
                .as_str(),
            "2027-01-15T08:00:00.123Z"
        );
        let mut invalid = status();
        invalid.operation_id = -1;
        assert!(update_status(invalid).is_err());
        let mapped = update_progress(updater::UpdateProgress {
            operation_id: 8,
            stage: updater::UpdateStage::Installing,
            downloaded: 4096.0,
            total: Some(8192.0),
            status: Some(status()),
            error: Some(NativeError::new(
                ErrorCode::UpdateDownloadFailed,
                "下载失败",
            )),
        })
        .unwrap();
        assert_eq!(mapped.native_operation_id.get(), 8);
        assert_eq!(mapped.stage, ClientUpdateStage::Installing);
        assert_eq!(mapped.downloaded.get(), 4096);
        assert_eq!(mapped.total.unwrap().get(), 8192);
        assert!(mapped.error.unwrap().retryable);
    }

    #[test]
    fn clipboard_read_obeys_utf8_budget_without_truncating_content() {
        let text = "汉".repeat(CLIENT_CLIPBOARD_MAX_BYTES / 3);
        assert_eq!(
            clipboard_text(text.clone()).unwrap(),
            ClientEffectResult::ClipboardText { text }
        );
        assert_eq!(
            clipboard_text("汉".repeat(CLIENT_CLIPBOARD_MAX_BYTES / 3 + 1))
                .unwrap_err()
                .code,
            "LIMIT_EXCEEDED"
        );
    }

    #[test]
    fn diagnostics_redacts_and_truncates_on_utf8_boundary() {
        let result = diagnostics(DiagnosticsReport {
            app_version: "1.0.0".into(),
            tauri_version: "2".into(),
            platform: "windows".into(),
            architecture: "x86_64".into(),
            window_label: "main".into(),
            settings_revision: Some(3.into()),
            desktop: DesktopStatus {
                tray_available: true,
                secondary_open: false,
                autostart_supported: true,
                run_in_background: true,
            },
            autostart_enabled: Some(false),
            updater_configured: true,
            recent_logs: format!(
                "https://user:secret@example.com/?token=private\n{}",
                "汉".repeat(CLIENT_DIAGNOSTICS_MAX_LOG_BYTES)
            ),
        });
        assert!(result.recent_logs.len() <= CLIENT_DIAGNOSTICS_MAX_LOG_BYTES);
        assert!(!result.recent_logs.contains("secret"));
        assert!(!result.recent_logs.contains("private"));
        assert_eq!(result.settings_revision.unwrap().get(), 3);
        assert!(result.desktop.tray_available);
    }
}
