use tauri_specta::{Builder, collect_commands};

use crate::commands;
use crate::wallpaper_commands;
use crate::{lifecycle, recovery, system_commands};

pub fn builder() -> Builder<tauri::Wry> {
    Builder::new()
        .commands(collect_commands![
            crate::file_commands::save_text_export,
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
}

pub fn export(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    builder().export(specta_typescript::Typescript::default(), path)?;
    Ok(())
}
