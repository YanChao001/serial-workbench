use tauri_specta::{Builder, collect_commands};

use crate::commands;
use crate::extension_commands;
use crate::wallpaper_commands;
use crate::{lifecycle, recovery, system_commands};

pub fn builder() -> Builder<tauri::Wry> {
    Builder::new()
        .commands(collect_commands![
            crate::file_commands::save_text_export,
            extension_commands::save_extension_session,
            extension_commands::extension_snapshot,
            extension_commands::extension_run_status,
            extension_commands::prepare_enabled_extensions,
            crate::extension_services::request_extension_service,
            extension_commands::preview_extension_archive,
            extension_commands::archive_legacy_extensions,
            crate::extension_market_commands::extension_market_snapshot,
            crate::extension_market_commands::download_market_extension,
            extension_commands::preview_extension,
            extension_commands::install_extension,
            extension_commands::install_market_extension,
            extension_commands::rollback_extension,
            extension_commands::set_extension_enabled,
            extension_commands::uninstall_extension,
            extension_commands::cancel_extension,
            extension_commands::run_extension,
            extension_commands::view_extension,
            extension_commands::validate_extension_view,
            extension_commands::pick_extension_files,
            extension_commands::save_extension_artifact,
            extension_commands::extension_storage_info,
            extension_commands::clear_extension_storage,
            extension_commands::extension_credential_slots,
            extension_commands::set_extension_credential,
            extension_commands::delete_extension_credential,
            crate::extension_windows::open_extension_window,
            crate::extension_windows::open_extension_center,
            crate::extensions::ui::open_extension_ui,
            crate::extensions::ui::close_extension_ui,
            wallpaper_commands::list_wallpapers,
            wallpaper_commands::choose_wallpaper_video,
            wallpaper_commands::add_wallpaper,
            wallpaper_commands::rename_wallpaper,
            wallpaper_commands::remove_wallpaper,
            commands::load_settings_snapshot,
            commands::save_settings_snapshot,
            commands::reset_settings_snapshot,
            commands::open_secondary_window,
            commands::complete_frontend_startup,
            commands::get_window_geometry,
            commands::set_window_size,
            commands::reset_window_geometry,
            commands::get_desktop_status,
            commands::get_autostart_enabled,
            commands::set_autostart_enabled,
            commands::record_frontend_error,
            commands::get_diagnostics_report,
            commands::check_for_update,
            commands::get_update_snapshot,
            commands::download_and_install_update,
            commands::relaunch_app,
            commands::quit_app,
            lifecycle::set_window_work_state,
            lifecycle::respond_lifecycle,
            system_commands::activation_snapshot,
            system_commands::get_workspace,
            system_commands::save_workspace_route,
            system_commands::restore_workspace,
            system_commands::activate_main,
            recovery::recovery_status,
            recovery::stage_recovery,
        ])
        .typ::<crate::updater::UpdateProgress>()
        .typ::<crate::lifecycle::LifecycleRequest>()
        .typ::<crate::extension_windows::ExtensionWindowRequest>()
        .typ::<crate::extension_windows::ExtensionWindowState>()
        .typ::<crate::extension_resources::ExtensionResourcePreviewSize>()
        .typ::<crate::extension_wallpaper::ExtensionWallpaperApplyResult>()
        .typ::<crate::extension_wallpaper::ExtensionWallpaperPreviewResult>()
}

pub fn export(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    builder().export(specta_typescript::Typescript::default(), path)?;
    Ok(())
}
