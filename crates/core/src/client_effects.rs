//! Fixed client effects. This contract never carries native command names or code.
use crate::{HostError, HostResult, Id, JsonObject, RequestId, Target, Timestamp, True, U64};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

pub const CLIENT_CLIPBOARD_MAX_BYTES: usize = 256 * 1024;
pub const CLIENT_DIAGNOSTICS_MAX_LOG_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientFullscreenParams {
    pub fullscreen: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientWindowSizeParams {
    pub width: U64,
    pub height: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientResetGeometryParams {
    pub center: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientClipboardWriteParams {
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientAutostartParams {
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, Type)]
pub enum ClientCapability {
    #[serde(rename = "client.window.read")]
    WindowRead,
    #[serde(rename = "client.window.minimize")]
    WindowMinimize,
    #[serde(rename = "client.window.toggleMaximize")]
    WindowToggleMaximize,
    #[serde(rename = "client.window.setFullscreen")]
    WindowSetFullscreen,
    #[serde(rename = "client.window.setSize")]
    WindowSetSize,
    #[serde(rename = "client.window.resetGeometry")]
    WindowResetGeometry,
    #[serde(rename = "client.window.showMain")]
    WindowShowMain,
    #[serde(rename = "client.window.openSecondary")]
    WindowOpenSecondary,
    #[serde(rename = "client.window.close")]
    WindowClose,
    #[serde(rename = "client.clipboard.readText")]
    ClipboardReadText,
    #[serde(rename = "client.clipboard.writeText")]
    ClipboardWriteText,
    #[serde(rename = "client.system.read")]
    SystemRead,
    #[serde(rename = "client.system.setAutostart")]
    SystemSetAutostart,
    #[serde(rename = "client.settings.applyEffects")]
    SettingsApplyEffects,
    #[serde(rename = "client.updater.check")]
    UpdaterCheck,
    #[serde(rename = "client.updater.read")]
    UpdaterRead,
    #[serde(rename = "client.updater.install")]
    UpdaterInstall,
    #[serde(rename = "client.app.restart")]
    AppRestart,
    #[serde(rename = "client.app.quit")]
    AppQuit,
    #[serde(rename = "client.diagnostics.read")]
    DiagnosticsRead,
    #[serde(rename = "client.recovery.read")]
    RecoveryRead,
    #[serde(rename = "client.recovery.stage")]
    RecoveryStage,
}
impl ClientCapability {
    pub const ALL: [Self; 22] = [
        Self::WindowRead,
        Self::WindowMinimize,
        Self::WindowToggleMaximize,
        Self::WindowSetFullscreen,
        Self::WindowSetSize,
        Self::WindowResetGeometry,
        Self::WindowShowMain,
        Self::WindowOpenSecondary,
        Self::WindowClose,
        Self::ClipboardReadText,
        Self::ClipboardWriteText,
        Self::SystemRead,
        Self::SystemSetAutostart,
        Self::SettingsApplyEffects,
        Self::UpdaterCheck,
        Self::UpdaterRead,
        Self::UpdaterInstall,
        Self::AppRestart,
        Self::AppQuit,
        Self::DiagnosticsRead,
        Self::RecoveryRead,
        Self::RecoveryStage,
    ];
    pub fn action_id(self) -> &'static str {
        match self {
            Self::WindowRead => "client.window.read",
            Self::WindowMinimize => "client.window.minimize",
            Self::WindowToggleMaximize => "client.window.toggleMaximize",
            Self::WindowSetFullscreen => "client.window.setFullscreen",
            Self::WindowSetSize => "client.window.setSize",
            Self::WindowResetGeometry => "client.window.resetGeometry",
            Self::WindowShowMain => "client.window.showMain",
            Self::WindowOpenSecondary => "client.window.openSecondary",
            Self::WindowClose => "client.window.close",
            Self::ClipboardReadText => "client.clipboard.readText",
            Self::ClipboardWriteText => "client.clipboard.writeText",
            Self::SystemRead => "client.system.read",
            Self::SystemSetAutostart => "client.system.setAutostart",
            Self::SettingsApplyEffects => "client.settings.applyEffects",
            Self::UpdaterCheck => "client.updater.check",
            Self::UpdaterRead => "client.updater.read",
            Self::UpdaterInstall => "client.updater.install",
            Self::AppRestart => "client.app.restart",
            Self::AppQuit => "client.app.quit",
            Self::DiagnosticsRead => "client.diagnostics.read",
            Self::RecoveryRead => "client.recovery.read",
            Self::RecoveryStage => "client.recovery.stage",
        }
    }
    pub fn find(action_id: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|capability| capability.action_id() == action_id)
    }
    pub fn is_query(self) -> bool {
        matches!(
            self,
            Self::WindowRead
                | Self::ClipboardReadText
                | Self::SystemRead
                | Self::UpdaterRead
                | Self::DiagnosticsRead
                | Self::RecoveryRead
        )
    }
    pub fn permissions(self) -> &'static [&'static str] {
        match self {
            Self::WindowRead | Self::SystemRead | Self::UpdaterRead | Self::RecoveryRead => {
                &["metadata.read"]
            }
            Self::ClipboardReadText => &["client.clipboard.read"],
            Self::ClipboardWriteText => &["client.clipboard.write"],
            Self::DiagnosticsRead => &["metadata.read", "content.read"],
            Self::WindowMinimize
            | Self::WindowToggleMaximize
            | Self::WindowSetFullscreen
            | Self::WindowSetSize
            | Self::WindowResetGeometry
            | Self::WindowShowMain
            | Self::WindowOpenSecondary
            | Self::WindowClose => &["client.window.modify"],
            _ => &["client.system.modify"],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "actionId", content = "params", deny_unknown_fields)]
pub enum ClientEffectAction {
    #[serde(rename = "client.window.read")]
    WindowRead {},
    #[serde(rename = "client.window.minimize")]
    WindowMinimize {},
    #[serde(rename = "client.window.toggleMaximize")]
    WindowToggleMaximize {},
    #[serde(rename = "client.window.setFullscreen")]
    WindowSetFullscreen { fullscreen: bool },
    #[serde(rename = "client.window.setSize")]
    WindowSetSize { width: U64, height: U64 },
    #[serde(rename = "client.window.resetGeometry")]
    WindowResetGeometry { center: bool },
    #[serde(rename = "client.window.showMain")]
    WindowShowMain {},
    #[serde(rename = "client.window.openSecondary")]
    WindowOpenSecondary {},
    #[serde(rename = "client.window.close")]
    WindowClose {},
    #[serde(rename = "client.clipboard.readText")]
    ClipboardReadText {},
    #[serde(rename = "client.clipboard.writeText")]
    ClipboardWriteText { text: String },
    #[serde(rename = "client.system.read")]
    SystemRead {},
    #[serde(rename = "client.system.setAutostart")]
    SystemSetAutostart { enabled: bool },
    #[serde(rename = "client.settings.applyEffects")]
    SettingsApplyEffects {},
    #[serde(rename = "client.updater.check")]
    UpdaterCheck {},
    #[serde(rename = "client.updater.read")]
    UpdaterRead {},
    #[serde(rename = "client.updater.install")]
    UpdaterInstall {},
    #[serde(rename = "client.app.restart")]
    AppRestart {},
    #[serde(rename = "client.app.quit")]
    AppQuit {},
    #[serde(rename = "client.diagnostics.read")]
    DiagnosticsRead {},
    #[serde(rename = "client.recovery.read")]
    RecoveryRead {},
    #[serde(rename = "client.recovery.stage")]
    RecoveryStage {},
}
impl ClientEffectAction {
    pub fn capability(&self) -> ClientCapability {
        match self {
            Self::WindowRead {} => ClientCapability::WindowRead,
            Self::WindowMinimize {} => ClientCapability::WindowMinimize,
            Self::WindowToggleMaximize {} => ClientCapability::WindowToggleMaximize,
            Self::WindowSetFullscreen { .. } => ClientCapability::WindowSetFullscreen,
            Self::WindowSetSize { .. } => ClientCapability::WindowSetSize,
            Self::WindowResetGeometry { .. } => ClientCapability::WindowResetGeometry,
            Self::WindowShowMain {} => ClientCapability::WindowShowMain,
            Self::WindowOpenSecondary {} => ClientCapability::WindowOpenSecondary,
            Self::WindowClose {} => ClientCapability::WindowClose,
            Self::ClipboardReadText {} => ClientCapability::ClipboardReadText,
            Self::ClipboardWriteText { .. } => ClientCapability::ClipboardWriteText,
            Self::SystemRead {} => ClientCapability::SystemRead,
            Self::SystemSetAutostart { .. } => ClientCapability::SystemSetAutostart,
            Self::SettingsApplyEffects {} => ClientCapability::SettingsApplyEffects,
            Self::UpdaterCheck {} => ClientCapability::UpdaterCheck,
            Self::UpdaterRead {} => ClientCapability::UpdaterRead,
            Self::UpdaterInstall {} => ClientCapability::UpdaterInstall,
            Self::AppRestart {} => ClientCapability::AppRestart,
            Self::AppQuit {} => ClientCapability::AppQuit,
            Self::DiagnosticsRead {} => ClientCapability::DiagnosticsRead,
            Self::RecoveryRead {} => ClientCapability::RecoveryRead,
            Self::RecoveryStage {} => ClientCapability::RecoveryStage,
        }
    }
    pub fn from_params(capability: ClientCapability, params: &JsonObject) -> HostResult<Self> {
        let action: Self = serde_json::from_value(serde_json::json!({
            "actionId": capability.action_id(), "params": params,
        }))
        .map_err(|_| invalid("Invalid fixed client action parameters"))?;
        action.validate()?;
        Ok(action)
    }
    pub fn validate(&self) -> HostResult<()> {
        match self {
            Self::ClipboardWriteText { text } if text.len() > CLIENT_CLIPBOARD_MAX_BYTES => Err(
                HostError::new("LIMIT_EXCEEDED", "Clipboard text exceeds the byte limit"),
            ),
            Self::WindowSetSize { width, height }
                if width.get() == 0
                    || height.get() == 0
                    || width.get() > u32::MAX as u64
                    || height.get() > u32::MAX as u64 =>
            {
                Err(invalid("Invalid logical window size"))
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientRegisterParams {
    pub generation: U64,
    pub capabilities: Vec<ClientCapability>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientRegistration {
    pub target: Target,
    pub generation: U64,
    pub capabilities: Vec<ClientCapability>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientUnregisterParams {
    pub client_target_id: Id,
    pub generation: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientListResult {
    pub clients: Vec<ClientListItem>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientListItem {
    pub registration: ClientRegistration,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ClientSettingsObservation")]
    #[specta(type=ClientSettingsObservation, optional)]
    pub settings_application: Option<ClientSettingsObservation>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientEffectAcknowledged {
    pub accepted: True,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientEffectRequest {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub client_target_id: Id,
    pub generation: U64,
    pub delivery_id: Id,
    pub request_id: RequestId,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub operation_id: Option<Id>,
    pub action: ClientEffectAction,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientEffectReceipt {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub client_target_id: Id,
    pub generation: U64,
    pub delivery_id: Id,
    pub outcome: ClientEffectOutcome,
}
/// A delivery receipt can settle only its matching pending operation. A settings
/// observation updates one live target's latest applied revision, never an operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ClientReceiptSubmission {
    Effect(Box<ClientEffectReceipt>),
    SettingsObserved(ClientSettingsObservation),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientSettingsObservation {
    pub client_target_id: Id,
    pub generation: U64,
    pub receipt: ClientSettingsEffectsReceipt,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientEffectOutcome {
    Succeeded { result: ClientEffectResult },
    Failed { error: HostError },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ClientEffectResult {
    Window(ClientWindowSnapshot),
    Geometry(ClientWindowGeometry),
    Maximized { maximized: bool },
    Fullscreen { fullscreen: bool },
    Applied {},
    Requested { effect: ClientRequestedEffect },
    ClipboardText { text: String },
    ClipboardWritten { written: True },
    System(ClientSystemStatus),
    Autostart { enabled: bool },
    SettingsApplied(ClientSettingsEffectsReceipt),
    UpdateStatus(ClientUpdateStatus),
    UpdateProgress(ClientUpdateSnapshot),
    Installed {},
    Diagnostics(ClientDiagnosticsReport),
    Recovery(ClientRecoveryStatus),
}
impl ClientEffectResult {
    pub fn validate_for(&self, capability: ClientCapability) -> HostResult<()> {
        use ClientCapability as C;
        let matches = matches!(
            (self, capability),
            (Self::Window(_), C::WindowRead)
                | (Self::Applied {}, C::WindowMinimize)
                | (Self::Maximized { .. }, C::WindowToggleMaximize)
                | (Self::Fullscreen { .. }, C::WindowSetFullscreen)
                | (Self::Geometry(_), C::WindowSetSize | C::WindowResetGeometry)
                | (
                    Self::Requested {
                        effect: ClientRequestedEffect::MainWindowRequested
                    },
                    C::WindowShowMain
                )
                | (
                    Self::Requested {
                        effect: ClientRequestedEffect::SecondaryWindowRequested
                    },
                    C::WindowOpenSecondary
                )
                | (
                    Self::Requested {
                        effect: ClientRequestedEffect::CloseRequested
                    },
                    C::WindowClose
                )
                | (
                    Self::Requested {
                        effect: ClientRequestedEffect::RestartRequested
                    },
                    C::AppRestart
                )
                | (
                    Self::Requested {
                        effect: ClientRequestedEffect::QuitRequested
                    },
                    C::AppQuit
                )
                | (Self::ClipboardText { .. }, C::ClipboardReadText)
                | (Self::ClipboardWritten { .. }, C::ClipboardWriteText)
                | (Self::System(_), C::SystemRead)
                | (Self::Autostart { .. }, C::SystemSetAutostart)
                | (Self::SettingsApplied(_), C::SettingsApplyEffects)
                | (Self::UpdateStatus(_), C::UpdaterCheck)
                | (Self::UpdateProgress(_), C::UpdaterRead)
                | (Self::Installed {}, C::UpdaterInstall)
                | (Self::Diagnostics(_), C::DiagnosticsRead)
                | (Self::Recovery(_), C::RecoveryRead | C::RecoveryStage)
        );
        if !matches {
            return Err(invalid(
                "Client receipt result does not match the dispatched action",
            ));
        }
        match self {
            Self::ClipboardText { text } if text.len() > CLIENT_CLIPBOARD_MAX_BYTES => Err(
                HostError::new("LIMIT_EXCEEDED", "Clipboard text exceeds the byte limit"),
            ),
            Self::Diagnostics(report)
                if report.recent_logs.len() > CLIENT_DIAGNOSTICS_MAX_LOG_BYTES =>
            {
                Err(HostError::new(
                    "LIMIT_EXCEEDED",
                    "Diagnostic logs exceed the byte limit",
                ))
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ClientRequestedEffect {
    MainWindowRequested,
    SecondaryWindowRequested,
    CloseRequested,
    RestartRequested,
    QuitRequested,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientWindowGeometry {
    pub width: U64,
    pub height: U64,
    pub min_width: U64,
    pub min_height: U64,
    pub max_width: U64,
    pub max_height: U64,
    pub default_width: U64,
    pub default_height: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientWindowSnapshot {
    pub geometry: ClientWindowGeometry,
    pub maximized: bool,
    pub fullscreen: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientDesktopStatus {
    pub tray_available: bool,
    pub secondary_open: bool,
    pub autostart_supported: bool,
    pub run_in_background: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientSystemStatus {
    pub desktop: ClientDesktopStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "bool")]
    #[specta(type=bool, optional)]
    pub autostart_enabled: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientPlatformEffects {
    pub tray_language: bool,
    pub network_mode: bool,
    pub run_in_background: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientSettingsEffectsReceipt {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub revision: U64,
    pub effects: ClientPlatformEffects,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientUpdateStatus {
    pub native_operation_id: U64,
    pub configured: bool,
    pub available: bool,
    pub current_version: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub endpoint: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Timestamp")]
    #[specta(type=Timestamp, optional)]
    pub checked_at: Option<Timestamp>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub version: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub body: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub date: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "lowercase")]
pub enum ClientUpdateStage {
    Checking,
    Checked,
    Downloading,
    Installing,
    Installed,
    Cancelled,
    Failed,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientUpdateProgress {
    pub native_operation_id: U64,
    pub stage: ClientUpdateStage,
    pub downloaded: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub total: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ClientUpdateStatus")]
    #[specta(type=ClientUpdateStatus, optional)]
    pub status: Option<ClientUpdateStatus>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "HostError")]
    #[specta(type=HostError, optional)]
    pub error: Option<HostError>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientUpdateSnapshot {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ClientUpdateProgress")]
    #[specta(type=ClientUpdateProgress, optional)]
    pub progress: Option<ClientUpdateProgress>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientDiagnosticsReport {
    pub app_version: String,
    pub tauri_version: String,
    pub platform: String,
    pub architecture: String,
    pub window_label: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub settings_revision: Option<U64>,
    pub desktop: ClientDesktopStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "bool")]
    #[specta(type=bool, optional)]
    pub autostart_enabled: Option<bool>,
    pub updater_configured: bool,
    pub recent_logs: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientRecoveryStatus {
    pub active: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub reason: Option<String>,
    pub pending: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub archive_id: Option<String>,
}

fn invalid(message: &str) -> HostError {
    HostError::new("INVALID_ARGUMENT", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Catches an arbitrary command channel or permissive native parameter bag.
    #[test]
    fn fixed_action_rejects_unknown_command_and_unknown_params() {
        for value in [
            json!({"actionId":"native.invoke","params":{"command":"quit_app"}}),
            json!({"actionId":"client.window.read","params":{"command":"quit_app"}}),
            json!({"actionId":"client.window.setSize","params":{"width":900,"height":"600"}}),
        ] {
            assert!(serde_json::from_value::<ClientEffectAction>(value).is_err());
        }
    }

    // Catches counting UTF-16 characters in place of the wire UTF-8 budget.
    #[test]
    fn clipboard_budget_is_utf8_bytes_and_applies_to_results_too() {
        let text = "汉".repeat(CLIENT_CLIPBOARD_MAX_BYTES / 3 + 1);
        assert_eq!(
            ClientEffectAction::ClipboardWriteText { text: text.clone() }
                .validate()
                .unwrap_err()
                .code,
            "LIMIT_EXCEEDED"
        );
        assert_eq!(
            ClientEffectResult::ClipboardText { text }
                .validate_for(ClientCapability::ClipboardReadText)
                .unwrap_err()
                .code,
            "LIMIT_EXCEEDED"
        );
    }

    // Catches treating a lifecycle request as a completed installation or exit.
    #[test]
    fn receipt_result_is_bound_to_the_original_effect() {
        let result = ClientEffectResult::Requested {
            effect: ClientRequestedEffect::CloseRequested,
        };
        assert!(result.validate_for(ClientCapability::WindowClose).is_ok());
        assert_eq!(
            result
                .validate_for(ClientCapability::AppRestart)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            ClientEffectResult::Installed {}
                .validate_for(ClientCapability::WindowClose)
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }
}
