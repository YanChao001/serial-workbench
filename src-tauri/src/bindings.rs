use tauri_specta::{Builder, collect_commands};

use crate::commands;
use crate::{
    file_resource_commands, host_bridge, lifecycle, media_protocol, recovery, system_commands,
};

pub fn builder() -> Builder<tauri::Wry> {
    Builder::new()
        .commands(collect_commands![
            crate::file_commands::save_text_export,
            file_resource_commands::choose_file_resource,
            media_protocol::media_resolve,
            media_protocol::media_release,
            commands::client_state_read,
            commands::client_state_save,
            commands::apply_host_settings_effects,
            host_bridge::host_attachment,
            host_bridge::host_connect_device,
            host_bridge::document_intents::host_apply_document_intent,
            host_bridge::host_request,
            host_bridge::host_subscribe,
            host_bridge::host_unsubscribe,
            host_bridge::host_raw_request,
            host_bridge::host_raw_subscribe,
            host_bridge::host_raw_unsubscribe,
            host_bridge::host_delivery_ack,
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

pub fn export_client_defaults(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    crate::client_state::export_defaults(path)
}
