//! 面向渲染进程的命令，数据结构与稳定错误码由 Rust 统一导出。

use tauri::{Manager, State};

use crate::{
    blocking,
    client_state::{ClientStateSnapshot, ClientStateStore, ClientWindowState},
    desktop::{self, DesktopStatus},
    diagnostics::{self, DiagnosticsReport, DiagnosticsState, FrontendError},
    error::{ErrorCode, NativeError, NativeResult},
    updater::{UpdateManager, UpdateProgress, UpdateStatus},
    window_geometry::{self, WindowGeometry},
};

pub(crate) fn require_host_window(label: &str) -> NativeResult<()> {
    if matches!(label, "main" | "secondary") {
        Ok(())
    } else {
        Err(NativeError::new(
            ErrorCode::PlatformUnavailable,
            "This operation is available only in the main and secondary windows",
        ))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn client_state_read(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> NativeResult<ClientStateSnapshot> {
    require_host_window(window.label())?;
    blocking::run(move || app.state::<ClientStateStore>().snapshot(window.label())).await
}
#[tauri::command]
#[specta::specta]
pub async fn client_state_save(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: ClientWindowState,
    expected_revision: serial_workbench_core::U64,
) -> NativeResult<ClientStateSnapshot> {
    require_host_window(window.label())?;
    blocking::run(move || {
        app.state::<ClientStateStore>()
            .save(window.label(), state, expected_revision)
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub async fn apply_host_settings_effects(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> serial_workbench_core::HostResult<crate::platform_settings::HostSettingsEffectsReceipt> {
    let bridge = app.state::<crate::host_bridge::DesktopHostBridge>();
    let instance = bridge.bind_window(&window)?;
    let current = bridge
        .attachment_for_instance(window.label(), instance)
        .await?;
    apply_host_settings_effects_for_generation(app.clone(), window, current.generation).await
}

pub(crate) async fn apply_host_settings_effects_for_generation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    generation: serial_workbench_core::U64,
) -> serial_workbench_core::HostResult<crate::platform_settings::HostSettingsEffectsReceipt> {
    use crate::platform_settings::{HostSettingsEffectsReceipt, PlatformEffects, PlatformSettings};
    use serial_workbench_core::{
        HostError, Id, Query, QueryResult, ResourceKind, RevealTarget, RpcReply, RpcRequest,
        RpcResult, Target,
    };
    require_host_window(window.label())
        .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot apply Host settings"))?;
    let bridge = app.state::<crate::host_bridge::DesktopHostBridge>();
    let instance = bridge.bind_window(&window)?;
    if bridge
        .window_instance_at_generation(window.label(), generation)
        .await?
        != instance
    {
        return Err(HostError::new("EPOCH_MISMATCH", "Window instance changed"));
    }
    let attachment = bridge
        .settings_attachment_for_generation(window.label(), generation)
        .await?;
    let query = Query {
        protocol_version: attachment.protocol_version,
        host_id: attachment.host_id.clone(),
        instance_epoch: attachment.instance_epoch,
        actor_id: attachment.actor_id.clone(),
        request_id: crate::platform_settings::next_effects_request_id()?,
        action_id: Id::try_from("settings.read")?,
        target: Target {
            host_id: attachment.host_id.clone(),
            kind: ResourceKind::try_from("settings")?,
            id: Id::try_from("shared")?,
            session_id: None,
            session_epoch: None,
        },
        params: Default::default(),
        reveal_target: RevealTarget {
            page_id: Id::try_from("settings")?,
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    };
    let document = match bridge
        .read_request_at_generation(window.label(), generation, RpcRequest::Query(query))
        .await?
    {
        RpcReply::Failure { error, .. } => return Err(error),
        RpcReply::Success { result, .. } => match *result {
            RpcResult::Query(QueryResult::Settings(result)) => result.document,
            _ => {
                return Err(HostError::new(
                    "INVALID_ARGUMENT",
                    "Host returned an invalid settings document",
                ));
            }
        },
    };
    let receipt = bridge
        .with_current_generation(window.label(), generation, || {
            let revision = document.revision;
            app.state::<PlatformSettings>()
                .apply(
                    attachment.host_id.clone(),
                    attachment.instance_epoch,
                    document,
                )
                .map_err(|error| {
                    HostError::new(
                        if error.code == ErrorCode::Conflict {
                            "CONFLICT"
                        } else {
                            "INTERNAL"
                        },
                        error.message,
                    )
                })?;
            Ok(HostSettingsEffectsReceipt {
                host_id: attachment.host_id.clone(),
                instance_epoch: attachment.instance_epoch,
                revision,
                effects: PlatformEffects {
                    tray_language: true,
                    network_mode: true,
                    run_in_background: true,
                },
            })
        })
        .await?;
    // 托盘 API 等待主线程；释放 bridge 锁后再读取最新内存策略，
    // 避免窗口销毁清理与菜单刷新相互等待。失败不回滚已应用策略。
    desktop::refresh_tray(&app)
        .map_err(|error| HostError::new("PLATFORM_EFFECT_FAILED", error.message))?;
    Ok(receipt)
}

#[tauri::command]
#[specta::specta]
pub async fn open_secondary_window(app: tauri::AppHandle) -> NativeResult<()> {
    blocking::run(move || desktop::open_secondary(&app)).await
}

#[tauri::command]
#[specta::specta]
pub async fn complete_frontend_startup(window: tauri::WebviewWindow) -> NativeResult<()> {
    blocking::run(move || desktop::complete_frontend_startup(window)).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_window_geometry(window: tauri::WebviewWindow) -> NativeResult<WindowGeometry> {
    blocking::run(move || window_geometry::read(window)).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_window_size(
    window: tauri::WebviewWindow,
    width: u32,
    height: u32,
) -> NativeResult<WindowGeometry> {
    blocking::run(move || window_geometry::set_size(window, f64::from(width), f64::from(height)))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn reset_window_geometry(
    window: tauri::WebviewWindow,
    center: bool,
) -> NativeResult<WindowGeometry> {
    blocking::run(move || window_geometry::reset(window, center)).await
}

#[tauri::command]
#[specta::specta]
pub fn get_desktop_status(app: tauri::AppHandle) -> NativeResult<DesktopStatus> {
    Ok(desktop::status(&app))
}

#[tauri::command]
#[specta::specta]
pub async fn get_autostart_enabled(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> NativeResult<bool> {
    require_host_window(window.label())?;
    blocking::run(move || desktop::get_autostart(&app)).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_autostart_enabled(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    enabled: bool,
) -> NativeResult<bool> {
    require_host_window(window.label())?;
    blocking::run(move || desktop::set_autostart(&app, enabled)).await
}

#[tauri::command]
#[specta::specta]
pub fn record_frontend_error(
    state: State<'_, DiagnosticsState>,
    error: FrontendError,
) -> NativeResult<()> {
    diagnostics::record(&state, error)
}

#[tauri::command]
#[specta::specta]
pub async fn get_diagnostics_report(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> NativeResult<DiagnosticsReport> {
    let label = window.label().to_owned();
    blocking::run(move || diagnostics::report(&app, &label)).await
}

#[tauri::command]
#[specta::specta]
pub async fn check_for_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> NativeResult<UpdateStatus> {
    require_host_window(window.label())?;
    app.state::<UpdateManager>().check(&app).await
}

#[tauri::command]
#[specta::specta]
pub fn get_update_snapshot(
    manager: State<'_, UpdateManager>,
) -> NativeResult<Option<UpdateProgress>> {
    manager.snapshot()
}

#[tauri::command]
#[specta::specta]
pub async fn download_and_install_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> NativeResult<()> {
    require_host_window(window.label())?;
    app.state::<UpdateManager>().install(&app).await
}

#[tauri::command]
#[specta::specta]
pub fn relaunch_app(app: tauri::AppHandle, window: tauri::WebviewWindow) -> NativeResult<()> {
    require_host_window(window.label())?;
    crate::lifecycle::request_action(&app, crate::lifecycle::LifecycleAction::Restart, None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn quit_app(app: tauri::AppHandle, window: tauri::WebviewWindow) -> NativeResult<()> {
    require_host_window(window.label())?;
    crate::lifecycle::request_action(&app, crate::lifecycle::LifecycleAction::Quit, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_management_rejects_unknown_windows() {
        for label in ["main", "secondary"] {
            assert!(require_host_window(label).is_ok());
        }
        for label in [
            "",
            "unknown-main",
            "unknown-123",
            "main-1",
            "https://remote",
        ] {
            assert_eq!(
                require_host_window(label).unwrap_err().code,
                ErrorCode::PlatformUnavailable
            );
        }
    }
}
