use crate::*;
use schemars::{
    JsonSchema, Schema,
    generate::SchemaSettings,
    transform::{RecursiveTransform, Transform},
};
use serde::{Deserialize, Serialize};
use specta::Type;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Query,
    Action,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionLocation {
    ResourceHost,
    Client,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum Cancellation {
    None,
    Cooperative,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionSpec {
    pub action_id: Id,
    pub kind: ActionKind,
    pub input_schema: SchemaObject,
    pub output_schema: SchemaObject,
    pub target_kinds: Vec<ResourceKind>,
    pub execution_location: ExecutionLocation,
    pub permissions: Vec<String>,
    pub state_scopes: Vec<String>,
    pub event_types: Vec<String>,
    pub cancellation: Cancellation,
    pub reveal_target: RevealTarget,
}
pub struct ActionMetadata {
    pub action_id: Id,
    pub kind: ActionKind,
    pub target_kinds: Vec<ResourceKind>,
    pub execution_location: ExecutionLocation,
    pub permissions: Vec<String>,
    pub state_scopes: Vec<String>,
    pub event_types: Vec<String>,
    pub cancellation: Cancellation,
    pub reveal_target: RevealTarget,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaDialect {
    Draft07,
    Draft202012,
}
impl ActionSpec {
    pub fn of<I: JsonSchema, O: JsonSchema>(meta: ActionMetadata) -> Self {
        Self::of_with_dialect::<I, O>(meta, SchemaDialect::Draft07)
    }
    pub fn of_with_dialect<I: JsonSchema, O: JsonSchema>(
        meta: ActionMetadata,
        dialect: SchemaDialect,
    ) -> Self {
        Self {
            action_id: meta.action_id,
            kind: meta.kind,
            input_schema: serde_json::from_value(schema_for::<I>(dialect)).expect("schema object"),
            output_schema: serde_json::from_value(schema_for::<O>(dialect)).expect("schema object"),
            target_kinds: meta.target_kinds,
            execution_location: meta.execution_location,
            permissions: meta.permissions,
            state_scopes: meta.state_scopes,
            event_types: meta.event_types,
            cancellation: meta.cancellation,
            reveal_target: meta.reveal_target,
        }
    }
}
pub fn schema<T: JsonSchema>() -> serde_json::Value {
    schema_for::<T>(SchemaDialect::Draft07)
}
pub fn schema_for<T: JsonSchema>(dialect: SchemaDialect) -> serde_json::Value {
    let mut schema = match dialect {
        SchemaDialect::Draft07 => SchemaSettings::draft07(),
        SchemaDialect::Draft202012 => SchemaSettings::draft2020_12(),
    }
    .into_generator()
    .into_root_schema_for::<T>();
    // 把机器整数格式转换成标准数值范围，保留更严格的字段约束。
    RecursiveTransform(|schema: &mut Schema| {
        if schema.get("type").and_then(serde_json::Value::as_str) != Some("integer") {
            return;
        }
        let (minimum, maximum) = match schema.get("format").and_then(serde_json::Value::as_str) {
            Some("uint8") => (0, i64::from(u8::MAX)),
            Some("uint16") => (0, i64::from(u16::MAX)),
            Some("uint32") => (0, i64::from(u32::MAX)),
            Some("int8") => (i64::from(i8::MIN), i64::from(i8::MAX)),
            Some("int16") => (i64::from(i16::MIN), i64::from(i16::MAX)),
            Some("int32") => (i64::from(i32::MIN), i64::from(i32::MAX)),
            _ => return,
        };
        if schema
            .get("minimum")
            .and_then(serde_json::Value::as_f64)
            .is_none_or(|value| value < minimum as f64)
        {
            schema.insert("minimum".into(), minimum.into());
        }
        if schema
            .get("maximum")
            .and_then(serde_json::Value::as_f64)
            .is_none_or(|value| value > maximum as f64)
        {
            schema.insert("maximum".into(), maximum.into());
        }
        schema.remove("format");
    })
    .transform(&mut schema);
    serde_json::to_value(schema).expect("schema serializes")
}
/// 只有已经实现的 handler 才能进入目录；业务任务在接线时添加目录项。
pub fn builtin_catalog() -> &'static [ActionSpec] {
    builtin_specs(SchemaDialect::Draft07)
}
fn builtin_specs(dialect: SchemaDialect) -> &'static [ActionSpec] {
    static DRAFT07: std::sync::LazyLock<Vec<ActionSpec>> = std::sync::LazyLock::new(|| {
        BuiltinAction::ALL
            .into_iter()
            .map(|action| action.build_spec(SchemaDialect::Draft07))
            .collect()
    });
    static DRAFT202012: std::sync::LazyLock<Vec<ActionSpec>> = std::sync::LazyLock::new(|| {
        BuiltinAction::ALL
            .into_iter()
            .map(|action| action.build_spec(SchemaDialect::Draft202012))
            .collect()
    });
    match dialect {
        SchemaDialect::Draft07 => &DRAFT07,
        SchemaDialect::Draft202012 => &DRAFT202012,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuiltinAction {
    ActionCheck,
    WorkspaceImportPreview,
    WorkspaceConfigurationInspect,
    WorkspaceConfigurationImport,
    WorkspaceConfigurationExport,
    WorkspaceStartupPlan,
    ExperimentExport,
    ExperimentInspect,
    Client(ClientCapability),
    ClientList,
    HostMetrics,
    StartupConfigGet,
    NodePackagesList,
    NodePackageDetailsRead,
    NodePackagesInstall,
    NodePackageSetEnabled,
    NodePackageUninstall,
    NodePackageRuntime,
    NodeViewAssetRead,
    NodeThemesList,
    NodePackageConfirmExecutionTrust,
    NodePackageRevokeExecutionTrust,
    NodeSourcesList,
    NodeSourceApproveKey,
    NodeSourceRevokeKey,
    CaptureStart,
    CaptureStop,
    CaptureStatus,
    CaptureTail,
    CaptureRedactionPreview,
    CaptureVerify,
    CaptureRecover,
    CaptureExport,
    ReplayOpen,
    ReplayPeerOpen,
    ReplayPeerState,
    ReplayPeerSubmit,
    ReplayRead,
    ReplaySearch,
    ReplayControl,
    ReplayClose,
    DeviceRefresh,
    RecentList,
    DeviceRebind,
    FavoritesSave,
    FileRegister,
    FileMetadata,
    FileRead,
    TransferReceiptsRead,
    TransferReadProgress,
    StreamCursor,
    TransferFile,
    TransferPaste,
    StateScopes,
    SettingsRead,
    SettingsSave,
    SettingsExport,
    SettingsImport,
    WorkspaceList,
    CommandLibraryRead,
    CommandLibraryChange,
    CommandLibraryImport,
    CommandLibraryExport,
    WorkspaceRead,
    WorkspaceSave,
    WorkspaceExport,
    WorkspaceImport,
    CatalogList,
    OperationGet,
    OperationInput,
    OperationCancel,
    StateSnapshot,
    StateSubscribe,
    SubscriptionClose,
    Authorize,
    Revoke,
    DeviceList,
    DeviceOpen,
    SessionGet,
    SessionMetrics,
    SessionInputs,
    SessionClose,
    ToolHandoff,
    SessionTx,
    SessionConfigure,
    SessionControl,
    SessionBreak,
    SessionSetReadOnly,
    SessionTakeover,
    LeaseAcquire,
    LeaseRenew,
    LeaseRelease,
    TxWaitBoundary,
    TxQueueStatus,
    TxDrain,
    SessionPurge,
    StreamRead,
    StreamDerivedRead,
    StreamSubscribe,
    StreamCredit,
    HostShutdown,
}
impl BuiltinAction {
    pub const ALL: [Self; 122] = [
        Self::ActionCheck,
        Self::WorkspaceImportPreview,
        Self::WorkspaceConfigurationInspect,
        Self::WorkspaceConfigurationImport,
        Self::WorkspaceConfigurationExport,
        Self::WorkspaceStartupPlan,
        Self::ExperimentExport,
        Self::ExperimentInspect,
        Self::Client(ClientCapability::WindowRead),
        Self::Client(ClientCapability::WindowMinimize),
        Self::Client(ClientCapability::WindowToggleMaximize),
        Self::Client(ClientCapability::WindowSetFullscreen),
        Self::Client(ClientCapability::WindowSetSize),
        Self::Client(ClientCapability::WindowResetGeometry),
        Self::Client(ClientCapability::WindowShowMain),
        Self::Client(ClientCapability::WindowOpenSecondary),
        Self::Client(ClientCapability::WindowClose),
        Self::Client(ClientCapability::ClipboardReadText),
        Self::Client(ClientCapability::ClipboardWriteText),
        Self::Client(ClientCapability::SystemRead),
        Self::Client(ClientCapability::SystemSetAutostart),
        Self::Client(ClientCapability::SettingsApplyEffects),
        Self::Client(ClientCapability::UpdaterCheck),
        Self::Client(ClientCapability::UpdaterRead),
        Self::Client(ClientCapability::UpdaterInstall),
        Self::Client(ClientCapability::AppRestart),
        Self::Client(ClientCapability::AppQuit),
        Self::Client(ClientCapability::DiagnosticsRead),
        Self::Client(ClientCapability::RecoveryRead),
        Self::Client(ClientCapability::RecoveryStage),
        Self::ClientList,
        Self::HostMetrics,
        Self::StartupConfigGet,
        Self::NodePackagesList,
        Self::NodePackageDetailsRead,
        Self::NodePackagesInstall,
        Self::NodePackageSetEnabled,
        Self::NodePackageUninstall,
        Self::NodePackageRuntime,
        Self::NodeViewAssetRead,
        Self::NodeThemesList,
        Self::NodePackageConfirmExecutionTrust,
        Self::NodePackageRevokeExecutionTrust,
        Self::NodeSourcesList,
        Self::NodeSourceApproveKey,
        Self::NodeSourceRevokeKey,
        Self::CaptureStart,
        Self::CaptureStop,
        Self::CaptureStatus,
        Self::CaptureTail,
        Self::CaptureRedactionPreview,
        Self::CaptureVerify,
        Self::CaptureRecover,
        Self::CaptureExport,
        Self::ReplayOpen,
        Self::ReplayPeerOpen,
        Self::ReplayPeerState,
        Self::ReplayPeerSubmit,
        Self::ReplayRead,
        Self::ReplaySearch,
        Self::ReplayControl,
        Self::ReplayClose,
        Self::DeviceRefresh,
        Self::RecentList,
        Self::DeviceRebind,
        Self::FavoritesSave,
        Self::FileRegister,
        Self::FileMetadata,
        Self::FileRead,
        Self::TransferReceiptsRead,
        Self::TransferReadProgress,
        Self::StreamCursor,
        Self::TransferFile,
        Self::TransferPaste,
        Self::StateScopes,
        Self::SettingsRead,
        Self::SettingsSave,
        Self::SettingsExport,
        Self::SettingsImport,
        Self::WorkspaceList,
        Self::CommandLibraryRead,
        Self::CommandLibraryChange,
        Self::CommandLibraryImport,
        Self::CommandLibraryExport,
        Self::WorkspaceRead,
        Self::WorkspaceSave,
        Self::WorkspaceExport,
        Self::WorkspaceImport,
        Self::CatalogList,
        Self::OperationGet,
        Self::OperationInput,
        Self::OperationCancel,
        Self::StateSnapshot,
        Self::StateSubscribe,
        Self::SubscriptionClose,
        Self::Authorize,
        Self::Revoke,
        Self::DeviceList,
        Self::DeviceOpen,
        Self::SessionGet,
        Self::SessionMetrics,
        Self::SessionInputs,
        Self::SessionClose,
        Self::ToolHandoff,
        Self::SessionTx,
        Self::SessionConfigure,
        Self::SessionControl,
        Self::SessionBreak,
        Self::SessionSetReadOnly,
        Self::SessionTakeover,
        Self::LeaseAcquire,
        Self::LeaseRenew,
        Self::LeaseRelease,
        Self::TxWaitBoundary,
        Self::TxQueueStatus,
        Self::TxDrain,
        Self::SessionPurge,
        Self::StreamRead,
        Self::StreamDerivedRead,
        Self::StreamSubscribe,
        Self::StreamCredit,
        Self::HostShutdown,
    ];
    pub fn action_id(self) -> &'static str {
        match self {
            Self::Client(capability) => capability.action_id(),
            Self::ClientList => "client.list",
            Self::HostMetrics => "host.metrics",
            Self::StartupConfigGet => "startup.config.get",
            Self::NodePackagesList => "node.packages.list",
            Self::NodePackageDetailsRead => "node.packages.detailsRead",
            Self::NodePackagesInstall => "node.packages.install",
            Self::NodePackageSetEnabled => "node.packages.setEnabled",
            Self::NodePackageUninstall => "node.packages.uninstall",
            Self::NodePackageRuntime => "node.packages.runtime",
            Self::NodeViewAssetRead => "node.views.assetRead",
            Self::NodeThemesList => "node.themes.list",
            Self::NodePackageConfirmExecutionTrust => "node.packages.confirmExecutionTrust",
            Self::NodePackageRevokeExecutionTrust => "node.packages.revokeExecutionTrust",
            Self::NodeSourcesList => "node.sources.list",
            Self::NodeSourceApproveKey => "node.sources.approveKey",
            Self::NodeSourceRevokeKey => "node.sources.revokeKey",
            Self::CaptureStart => "capture.start",
            Self::CaptureStop => "capture.stop",
            Self::CaptureStatus => "capture.status",
            Self::CaptureTail => "capture.tail",
            Self::CaptureRedactionPreview => "capture.redactionPreview",
            Self::CaptureVerify => "capture.verify",
            Self::CaptureRecover => "capture.recover",
            Self::CaptureExport => "capture.export",
            Self::ReplayOpen => "replay.open",
            Self::ReplayPeerOpen => "replay.peer.open",
            Self::ReplayPeerState => "replay.peer.state",
            Self::ReplayPeerSubmit => "replay.peer.submit",
            Self::ReplayRead => "replay.read",
            Self::ReplaySearch => "replay.search",
            Self::ReplayControl => "replay.control",
            Self::ReplayClose => "replay.close",
            Self::DeviceRefresh => "device.refresh",
            Self::RecentList => "recent.list",
            Self::DeviceRebind => "device.rebind",
            Self::FavoritesSave => "favorites.save",
            Self::FileRegister => "file.register",
            Self::FileMetadata => "file.metadata",
            Self::FileRead => "file.read",
            Self::TransferReceiptsRead => "transfer.receiptsRead",
            Self::TransferReadProgress => "transfer.readProgress",
            Self::StreamCursor => "stream.cursor",
            Self::TransferFile => "transfer.file",
            Self::TransferPaste => "transfer.paste",
            Self::StateScopes => "state.scopes",
            Self::SettingsRead => "settings.read",
            Self::SettingsSave => "settings.save",
            Self::SettingsExport => "settings.export",
            Self::SettingsImport => "settings.import",
            Self::ActionCheck => "action.check",
            Self::WorkspaceImportPreview => "workspace.importPreview",
            Self::WorkspaceConfigurationInspect => "workspace.configuration.inspect",
            Self::WorkspaceConfigurationImport => "workspace.configuration.import",
            Self::WorkspaceConfigurationExport => "workspace.configuration.export",
            Self::WorkspaceStartupPlan => "workspace.startupPlan",
            Self::ExperimentExport => "workspace.experiment.export",
            Self::ExperimentInspect => "workspace.experiment.inspect",
            Self::WorkspaceList => "workspace.list",
            Self::CommandLibraryRead => "workspace.commands.read",
            Self::CommandLibraryChange => "workspace.commands.change",
            Self::CommandLibraryImport => "workspace.commands.import",
            Self::CommandLibraryExport => "workspace.commands.export",
            Self::WorkspaceRead => "workspace.read",
            Self::WorkspaceSave => "workspace.save",
            Self::WorkspaceExport => "workspace.export",
            Self::WorkspaceImport => "workspace.import",
            Self::CatalogList => "catalog.list",
            Self::OperationGet => "operation.get",
            Self::OperationInput => "operation.input",
            Self::OperationCancel => "operation.cancel",
            Self::StateSnapshot => "state.snapshot",
            Self::StateSubscribe => "state.subscribe",
            Self::SubscriptionClose => "subscription.close",
            Self::Authorize => "auth.authorize",
            Self::Revoke => "auth.revoke",
            Self::DeviceList => "device.list",
            Self::DeviceOpen => "device.open",
            Self::SessionGet => "session.get",
            Self::SessionMetrics => "session.metrics",
            Self::SessionInputs => "session.inputs",
            Self::SessionClose => "session.close",
            Self::ToolHandoff => "session.toolHandoff",
            Self::SessionTx => "session.tx",
            Self::SessionConfigure => "session.configure",
            Self::SessionControl => "session.control",
            Self::SessionBreak => "session.break",
            Self::SessionSetReadOnly => "session.setReadOnly",
            Self::SessionTakeover => "session.takeover",
            Self::LeaseAcquire => "lease.acquire",
            Self::LeaseRenew => "lease.renew",
            Self::LeaseRelease => "lease.release",
            Self::TxWaitBoundary => "tx.waitBoundary",
            Self::TxQueueStatus => "tx.queueStatus",
            Self::TxDrain => "tx.drain",
            Self::SessionPurge => "session.purge",
            Self::StreamRead => "stream.read",
            Self::StreamDerivedRead => "stream.derivedRead",
            Self::StreamSubscribe => "stream.subscribe",
            Self::StreamCredit => "stream.credit",
            Self::HostShutdown => "host.shutdown",
        }
    }
    pub fn find(id: &str) -> HostResult<Self> {
        Self::ALL
            .into_iter()
            .find(|action| action.action_id() == id)
            .ok_or_else(|| {
                HostError::new("UNSUPPORTED_CAPABILITY", "Action handler is not registered")
            })
    }
    pub fn is_device_action(self) -> bool {
        matches!(
            self,
            Self::DeviceOpen
                | Self::TransferFile
                | Self::TransferPaste
                | Self::SessionClose
                | Self::ToolHandoff
                | Self::SessionTx
                | Self::SessionConfigure
                | Self::SessionControl
                | Self::SessionBreak
                | Self::SessionSetReadOnly
                | Self::SessionTakeover
                | Self::LeaseAcquire
                | Self::LeaseRenew
                | Self::LeaseRelease
                | Self::TxWaitBoundary
                | Self::TxDrain
                | Self::SessionPurge
        )
    }
    pub fn is_node_mutation(self) -> bool {
        matches!(
            self,
            Self::NodePackagesInstall
                | Self::NodePackageSetEnabled
                | Self::NodePackageUninstall
                | Self::NodePackageConfirmExecutionTrust
                | Self::NodePackageRevokeExecutionTrust
                | Self::NodeSourceApproveKey
                | Self::NodeSourceRevokeKey
        )
    }
    pub fn is_capture_api(self) -> bool {
        matches!(
            self,
            Self::CaptureStart
                | Self::CaptureStop
                | Self::CaptureStatus
                | Self::CaptureTail
                | Self::CaptureRedactionPreview
                | Self::CaptureVerify
                | Self::CaptureRecover
                | Self::CaptureExport
                | Self::ReplayOpen
                | Self::ReplayPeerOpen
                | Self::ReplayPeerState
                | Self::ReplayPeerSubmit
                | Self::ReplayRead
                | Self::ReplaySearch
                | Self::ReplayControl
                | Self::ReplayClose
        )
    }
    pub fn is_document_action(self) -> bool {
        matches!(
            self,
            Self::SettingsSave
                | Self::SettingsImport
                | Self::WorkspaceSave
                | Self::WorkspaceImport
                | Self::WorkspaceConfigurationImport
                | Self::DeviceRebind
                | Self::FavoritesSave
                | Self::CommandLibraryChange
                | Self::CommandLibraryImport
                | Self::CommandLibraryExport
        )
    }
    pub fn spec(self) -> &'static ActionSpec {
        self.spec_with_dialect(SchemaDialect::Draft07)
    }
    pub fn spec_with_dialect(self, dialect: SchemaDialect) -> &'static ActionSpec {
        &builtin_specs(dialect)[Self::ALL
            .iter()
            .position(|action| *action == self)
            .expect("builtin action")]
    }
    fn build_spec(self, dialect: SchemaDialect) -> ActionSpec {
        let action = self.is_device_action()
            || matches!(self, Self::Client(capability) if !capability.is_query())
            || self.is_document_action()
            || (self.is_capture_api()
                && !matches!(
                    self,
                    Self::CaptureStatus
                        | Self::CaptureTail
                        | Self::CaptureRedactionPreview
                        | Self::ReplayRead
                        | Self::ReplayPeerState
                        | Self::ReplaySearch
                ))
            || matches!(
                self,
                Self::OperationCancel
                    | Self::NodePackagesInstall
                    | Self::NodePackageSetEnabled
                    | Self::NodePackageUninstall
                    | Self::NodePackageConfirmExecutionTrust
                    | Self::NodePackageRevokeExecutionTrust
                    | Self::NodeSourceApproveKey
                    | Self::NodeSourceRevokeKey
                    | Self::Authorize
                    | Self::Revoke
                    | Self::HostShutdown
                    | Self::FileRegister
            );
        let auth = matches!(
            self,
            Self::Authorize
                | Self::Revoke
                | Self::HostShutdown
                | Self::FileRegister
                | Self::ToolHandoff
                | Self::NodeSourceApproveKey
                | Self::NodePackageConfirmExecutionTrust
                | Self::NodePackageRevokeExecutionTrust
                | Self::NodeSourceRevokeKey
        );
        let kinds: &[&str] = match self {
            Self::ActionCheck => &[
                "host",
                "device",
                "session",
                "operation",
                "workspace",
                "settings",
                "capture",
                "capture_record",
                "transfer_receipts",
                "file",
                "plugin",
                "client",
            ],
            Self::WorkspaceImportPreview
            | Self::WorkspaceConfigurationInspect
            | Self::WorkspaceConfigurationImport
            | Self::WorkspaceConfigurationExport
            | Self::WorkspaceStartupPlan
            | Self::ExperimentExport
            | Self::ExperimentInspect => &["workspace"],
            Self::Client(_) => &["client"],
            Self::CaptureStart | Self::CaptureRecover => &["file"],
            Self::CaptureStop => &["capture"],
            Self::CaptureStatus
            | Self::CaptureTail
            | Self::CaptureVerify
            | Self::CaptureExport
            | Self::ReplayOpen
            | Self::ReplayPeerOpen => &["file", "capture"],
            Self::ReplayRead
            | Self::ReplaySearch
            | Self::ReplayControl
            | Self::ReplayClose
            | Self::ReplayPeerState
            | Self::ReplayPeerSubmit => &["session"],
            Self::DeviceRebind | Self::FavoritesSave => &["workspace"],
            Self::FileMetadata => &["file", "capture", "plugin_result"],
            Self::FileRead => &["file", "capture_record", "plugin_result"],
            Self::TransferReceiptsRead | Self::TransferReadProgress => &["transfer_receipts"],
            Self::SettingsRead
            | Self::SettingsSave
            | Self::SettingsExport
            | Self::SettingsImport => &["settings"],
            Self::WorkspaceRead
            | Self::WorkspaceSave
            | Self::WorkspaceExport
            | Self::WorkspaceImport
            | Self::CommandLibraryRead
            | Self::CommandLibraryChange
            | Self::CommandLibraryImport
            | Self::CommandLibraryExport => &["workspace"],
            Self::DeviceOpen => &["device"],
            Self::SessionGet
            | Self::SessionMetrics
            | Self::SessionInputs
            | Self::TransferFile
            | Self::TransferPaste
            | Self::StreamCursor
            | Self::SessionClose
            | Self::ToolHandoff
            | Self::SessionTx
            | Self::SessionConfigure
            | Self::SessionControl
            | Self::SessionBreak
            | Self::SessionSetReadOnly
            | Self::SessionTakeover
            | Self::LeaseAcquire
            | Self::LeaseRenew
            | Self::LeaseRelease
            | Self::TxWaitBoundary
            | Self::TxQueueStatus
            | Self::TxDrain
            | Self::SessionPurge
            | Self::StreamRead
            | Self::StreamDerivedRead
            | Self::StreamSubscribe
            | Self::StreamCredit => &["session"],
            Self::OperationCancel | Self::NodeViewAssetRead => &["operation"],
            Self::StateSnapshot | Self::StateSubscribe | Self::SubscriptionClose => {
                &["host", "settings", "workspace", "session"]
            }
            Self::OperationGet | Self::OperationInput => &["host", "operation"],
            _ => &["host"],
        };
        let panel = match self {
            Self::DeviceList
            | Self::DeviceRefresh
            | Self::RecentList
            | Self::DeviceRebind
            | Self::FavoritesSave => Some("devices"),
            Self::WorkspaceList
            | Self::WorkspaceRead
            | Self::WorkspaceSave
            | Self::WorkspaceExport
            | Self::WorkspaceImport
            | Self::WorkspaceConfigurationInspect
            | Self::WorkspaceConfigurationImport
            | Self::WorkspaceConfigurationExport
            | Self::WorkspaceStartupPlan
            | Self::CommandLibraryRead
            | Self::CommandLibraryChange
            | Self::CommandLibraryImport
            | Self::CommandLibraryExport => Some("workspace"),
            Self::SessionConfigure => Some("parameters"),
            Self::SessionControl
            | Self::SessionBreak
            | Self::SessionSetReadOnly
            | Self::SessionPurge
            | Self::TxDrain => Some("controls"),
            Self::TransferFile
            | Self::TransferPaste
            | Self::TransferReceiptsRead
            | Self::TransferReadProgress => Some("transfer"),
            Self::OperationGet
            | Self::OperationInput
            | Self::OperationCancel
            | Self::SessionTakeover => Some("activity"),
            Self::SessionGet | Self::DeviceOpen => Some("terminal"),
            Self::SessionTx => Some("send"),
            action if action.is_capture_api() => Some("capture"),
            _ => None,
        };
        let mut meta = ActionMetadata {
            action_id: Id::try_from(self.action_id()).expect("builtin Id"),
            kind: if action {
                ActionKind::Action
            } else {
                ActionKind::Query
            },
            target_kinds: kinds
                .iter()
                .map(|kind| ResourceKind::try_from(*kind).expect("builtin kind"))
                .collect(),
            execution_location: ExecutionLocation::ResourceHost,
            permissions: vec![
                if matches!(
                    self,
                    Self::NodePackagesInstall
                        | Self::NodePackageSetEnabled
                        | Self::NodePackageUninstall
                ) {
                    "plugins.manage"
                } else if matches!(self, Self::SettingsSave | Self::SettingsImport) {
                    "settings.modify"
                } else if matches!(
                    self,
                    Self::WorkspaceSave
                        | Self::WorkspaceImport
                        | Self::WorkspaceConfigurationImport
                        | Self::DeviceRebind
                        | Self::FavoritesSave
                        | Self::CommandLibraryChange
                        | Self::CommandLibraryImport
                ) {
                    "workspace.modify"
                } else if auth || self == Self::SessionTakeover {
                    "auth.manage"
                } else if self.is_device_action() {
                    "device.modify"
                } else if matches!(
                    self,
                    Self::StreamCursor
                        | Self::FileRead
                        | Self::TransferReceiptsRead
                        | Self::TransferReadProgress
                        | Self::StreamRead
                        | Self::StreamDerivedRead
                        | Self::StreamSubscribe
                        | Self::StreamCredit
                        | Self::CommandLibraryRead
                        | Self::CommandLibraryExport
                ) {
                    "content.read"
                } else {
                    "metadata.read"
                }
                .into(),
            ],
            state_scopes: vec![
                if action {
                    "host.operations"
                } else {
                    "host.activity"
                }
                .into(),
            ],
            event_types: vec![
                if action {
                    "operations.changed"
                } else {
                    "activity.changed"
                }
                .into(),
            ],
            cancellation: if self.is_device_action()
                || matches!(self, Self::CaptureStart)
                || self.is_node_mutation()
            {
                Cancellation::Cooperative
            } else {
                Cancellation::None
            },
            reveal_target: RevealTarget {
                page_id: Id::try_from("workbench").expect("page"),
                workspace_id: None,
                session_id: None,
                panel_id: panel.map(|id| Id::try_from(id).expect("panel")),
                result_ref: None,
            },
        };
        if matches!(self, Self::TransferFile | Self::NodePackagesInstall) {
            meta.permissions.push("content.read".into());
        }
        if matches!(
            self,
            Self::SessionMetrics | Self::SessionInputs | Self::NodeViewAssetRead
        ) {
            meta.state_scopes.clear();
            meta.event_types.clear();
        }
        if matches!(self, Self::CatalogList | Self::WorkspaceList) {
            // Authentication identifies whose filtered catalog is returned; no global grant is needed.
            meta.permissions.clear();
        }
        if self == Self::StartupConfigGet {
            meta.reveal_target.page_id = Id::try_from("settings").expect("page");
        }
        if matches!(
            self,
            Self::SettingsRead | Self::SettingsSave | Self::SettingsExport | Self::SettingsImport
        ) {
            meta.state_scopes.push("settings:shared".into());
            meta.reveal_target.page_id = Id::try_from("settings").expect("page");
            if action {
                meta.event_types.push("settings.changed".into());
            }
        } else if matches!(
            self,
            Self::WorkspaceRead
                | Self::WorkspaceSave
                | Self::WorkspaceExport
                | Self::WorkspaceImport
                | Self::WorkspaceConfigurationImport
                | Self::DeviceRebind
                | Self::FavoritesSave
        ) {
            meta.state_scopes.push("workspace:<id>".into());
            if action {
                meta.event_types.push("workspace.changed".into());
            }
        }
        if self == Self::ActionCheck {
            meta.permissions.clear();
        }
        if matches!(
            self,
            Self::ActionCheck
                | Self::WorkspaceImportPreview
                | Self::WorkspaceConfigurationInspect
                | Self::WorkspaceConfigurationExport
                | Self::WorkspaceStartupPlan
                | Self::ExperimentInspect
                | Self::ExperimentExport
        ) {
            meta.state_scopes.clear();
            meta.event_types.clear();
        }
        if let Self::Client(capability) = self {
            meta.permissions = capability
                .permissions()
                .iter()
                .map(|permission| (*permission).into())
                .collect();
            meta.execution_location = ExecutionLocation::Client;
            meta.reveal_target.page_id = Id::try_from("settings").expect("page");
        }
        if self.is_capture_api() {
            meta.permissions = match self {
                Self::CaptureStart => vec!["workspace.modify", "content.read", "metadata.read"],
                Self::CaptureStop => vec!["workspace.modify", "metadata.read"],
                Self::CaptureStatus | Self::CaptureRedactionPreview => vec!["metadata.read"],
                Self::CaptureRecover | Self::CaptureExport => {
                    vec!["content.read", "workspace.modify"]
                }
                _ => vec!["content.read"],
            }
            .into_iter()
            .map(str::to_owned)
            .collect();
        }
        match self {
            Self::ClientList => {
                ActionSpec::of_with_dialect::<EmptyParams, ClientListResult>(meta, dialect)
            }
            Self::Client(capability) => match capability {
                ClientCapability::WindowSetFullscreen => ActionSpec::of_with_dialect::<
                    ClientFullscreenParams,
                    ClientEffectResult,
                >(meta, dialect),
                ClientCapability::WindowSetSize => ActionSpec::of_with_dialect::<
                    ClientWindowSizeParams,
                    ClientEffectResult,
                >(meta, dialect),
                ClientCapability::WindowResetGeometry => ActionSpec::of_with_dialect::<
                    ClientResetGeometryParams,
                    ClientEffectResult,
                >(meta, dialect),
                ClientCapability::ClipboardWriteText => ActionSpec::of_with_dialect::<
                    ClientClipboardWriteParams,
                    ClientEffectResult,
                >(meta, dialect),
                ClientCapability::SystemSetAutostart => ActionSpec::of_with_dialect::<
                    ClientAutostartParams,
                    ClientEffectResult,
                >(meta, dialect),
                _ => ActionSpec::of_with_dialect::<EmptyParams, ClientEffectResult>(meta, dialect),
            },
            Self::HostMetrics => {
                ActionSpec::of_with_dialect::<HostMetricsParams, HostMetrics>(meta, dialect)
            }
            Self::StartupConfigGet => {
                ActionSpec::of_with_dialect::<EmptyParams, StartupConfigSnapshot>(meta, dialect)
            }
            Self::NodePackagesList => ActionSpec::of_with_dialect::<
                NodePackageListParams,
                NodePackageListResult,
            >(meta, dialect),
            Self::NodePackageDetailsRead => ActionSpec::of_with_dialect::<
                NodePackageDetailsReadParams,
                NodePackageDetailsReadResult,
            >(meta, dialect),
            Self::NodePackagesInstall => ActionSpec::of_with_dialect::<
                NodePackageInstallParams,
                NodePackageChangeResult,
            >(meta, dialect),
            Self::NodePackageSetEnabled => ActionSpec::of_with_dialect::<
                NodePackageSetEnabledParams,
                NodePackageChangeResult,
            >(meta, dialect),
            Self::NodePackageUninstall => ActionSpec::of_with_dialect::<
                NodePackageIdentityParams,
                NodePackageUninstallResult,
            >(meta, dialect),
            Self::NodePackageRuntime => ActionSpec::of_with_dialect::<
                NodePackageRuntimeParams,
                NodePackageRuntimeStatus,
            >(meta, dialect),
            Self::NodeThemesList => {
                ActionSpec::of_with_dialect::<EmptyParams, NodeThemesResult>(meta, dialect)
            }
            Self::NodeViewAssetRead => ActionSpec::of_with_dialect::<
                NodeViewAssetReadParams,
                NodeViewAssetReadResult,
            >(meta, dialect),
            Self::NodePackageConfirmExecutionTrust | Self::NodePackageRevokeExecutionTrust => {
                ActionSpec::of_with_dialect::<NodePackageIdentityParams, NodePackageChangeResult>(
                    meta, dialect,
                )
            }
            Self::NodeSourcesList => ActionSpec::of_with_dialect::<
                NodeSourceListParams,
                NodeSourceListResult,
            >(meta, dialect),
            Self::NodeSourceApproveKey => ActionSpec::of_with_dialect::<
                NodeSourceApproveParams,
                NodeSourceChangeResult,
            >(meta, dialect),
            Self::NodeSourceRevokeKey => ActionSpec::of_with_dialect::<
                NodeSourceRevokeParams,
                NodeSourceChangeResult,
            >(meta, dialect),
            Self::CaptureStart => ActionSpec::of_with_dialect::<
                CaptureStartParams,
                CaptureStatusResult,
            >(meta, dialect),
            Self::CaptureStop => {
                ActionSpec::of_with_dialect::<CaptureStopParams, CaptureStatusResult>(meta, dialect)
            }
            Self::CaptureStatus => ActionSpec::of_with_dialect::<
                CaptureVerifyParams,
                CaptureStatusResult,
            >(meta, dialect),
            Self::CaptureTail => {
                ActionSpec::of_with_dialect::<CaptureTailParams, CaptureTailResult>(meta, dialect)
            }
            Self::CaptureRedactionPreview => ActionSpec::of_with_dialect::<
                CaptureRedactionPreviewParams,
                CaptureRedactionPreviewResult,
            >(meta, dialect),
            Self::CaptureVerify => ActionSpec::of_with_dialect::<
                CaptureVerifyParams,
                VerificationReport,
            >(meta, dialect),
            Self::CaptureRecover => {
                ActionSpec::of_with_dialect::<RecoverPrefixParams, ResultReference>(meta, dialect)
            }
            Self::CaptureExport => {
                ActionSpec::of_with_dialect::<TextExportParams, ResultReference>(meta, dialect)
            }
            Self::ReplayOpen => {
                ActionSpec::of_with_dialect::<ReplayOpenParams, OpenResult>(meta, dialect)
            }
            Self::ReplayRead => {
                ActionSpec::of_with_dialect::<ReplayReadParams, ReplayReadResult>(meta, dialect)
            }
            Self::ReplayPeerOpen => {
                ActionSpec::of_with_dialect::<ReplayPeerOpenParams, OpenResult>(meta, dialect)
            }
            Self::ReplayPeerState => {
                ActionSpec::of_with_dialect::<EmptyParams, ReplayPeerState>(meta, dialect)
            }
            Self::ReplayPeerSubmit => ActionSpec::of_with_dialect::<
                ReplayPeerSubmitParams,
                ReplayPeerProgress,
            >(meta, dialect),
            Self::ReplaySearch => {
                ActionSpec::of_with_dialect::<ReplaySearchParams, ReplaySearchResult>(meta, dialect)
            }
            Self::ReplayControl => {
                ActionSpec::of_with_dialect::<ReplayControlParams, ReplayReadResult>(meta, dialect)
            }
            Self::ReplayClose => {
                ActionSpec::of_with_dialect::<EmptyParams, SessionSnapshot>(meta, dialect)
            }
            Self::DeviceRefresh => {
                ActionSpec::of_with_dialect::<EmptyParams, DeviceList>(meta, dialect)
            }
            Self::RecentList => {
                ActionSpec::of_with_dialect::<EmptyParams, RecentList>(meta, dialect)
            }
            Self::DeviceRebind => {
                ActionSpec::of_with_dialect::<RebindParams, WorkspaceDocumentResult>(meta, dialect)
            }
            Self::FavoritesSave => ActionSpec::of_with_dialect::<
                FavoritesSaveParams,
                WorkspaceDocumentResult,
            >(meta, dialect),
            Self::FileRegister => {
                ActionSpec::of_with_dialect::<RegisterFileParams, FileMetadata>(meta, dialect)
            }
            Self::FileMetadata => {
                ActionSpec::of_with_dialect::<FileMetadataParams, FileMetadata>(meta, dialect)
            }
            Self::FileRead => {
                ActionSpec::of_with_dialect::<FileReadParams, FileReadResult>(meta, dialect)
            }
            Self::TransferReadProgress => ActionSpec::of_with_dialect::<
                FileTransferReadProgressParams,
                FileTransferReadProgress,
            >(meta, dialect),
            Self::TransferReceiptsRead => ActionSpec::of_with_dialect::<
                FileTransferReceiptsParams,
                FileTransferReceiptsResult,
            >(meta, dialect),
            Self::StreamCursor => {
                ActionSpec::of_with_dialect::<EmptyParams, StreamCursorResult>(meta, dialect)
            }
            Self::TransferFile => {
                ActionSpec::of_with_dialect::<FileTransferParams, FileTransferResult>(meta, dialect)
            }
            Self::TransferPaste => ActionSpec::of_with_dialect::<
                PasteTransferParams,
                FileTransferResult,
            >(meta, dialect),
            Self::StateScopes => {
                ActionSpec::of_with_dialect::<EmptyParams, StateScopesResult>(meta, dialect)
            }
            Self::SettingsRead => {
                ActionSpec::of_with_dialect::<EmptyParams, SettingsDocumentResult>(meta, dialect)
            }
            Self::SettingsSave => ActionSpec::of_with_dialect::<
                SettingsSaveParams,
                SettingsDocumentResult,
            >(meta, dialect),
            Self::SettingsImport => ActionSpec::of_with_dialect::<
                DocumentImportParams,
                SettingsDocumentResult,
            >(meta, dialect),
            Self::ActionCheck => {
                ActionSpec::of_with_dialect::<ActionCheckParams, ActionCheckResult>(meta, dialect)
            }
            Self::WorkspaceImportPreview => ActionSpec::of_with_dialect::<
                DocumentImportParams,
                WorkspaceDocument,
            >(meta, dialect),
            Self::WorkspaceConfigurationInspect => ActionSpec::of_with_dialect::<
                DocumentImportParams,
                WorkspaceConfigurationInspection,
            >(meta, dialect),
            Self::WorkspaceConfigurationImport => ActionSpec::of_with_dialect::<
                WorkspaceConfigurationImportParams,
                WorkspaceConfigurationImportResult,
            >(meta, dialect),
            Self::WorkspaceConfigurationExport => ActionSpec::of_with_dialect::<
                WorkspaceConfigurationExportParams,
                DocumentJsonResult,
            >(meta, dialect),
            Self::WorkspaceStartupPlan => ActionSpec::of_with_dialect::<
                WorkspaceStartupPlanParams,
                WorkspaceStartupPlan,
            >(meta, dialect),
            Self::ExperimentExport => ActionSpec::of_with_dialect::<
                ExperimentExportParams,
                ExperimentPackage,
            >(meta, dialect),
            Self::ExperimentInspect => ActionSpec::of_with_dialect::<
                DocumentImportParams,
                ExperimentInspection,
            >(meta, dialect),
            Self::CommandLibraryRead => ActionSpec::of_with_dialect::<
                CommandLibraryReadParams,
                CommandLibraryReadResult,
            >(meta, dialect),
            Self::CommandLibraryChange => ActionSpec::of_with_dialect::<
                CommandLibraryChange,
                CommandLibraryRevision,
            >(meta, dialect),
            Self::CommandLibraryImport => ActionSpec::of_with_dialect::<
                CommandLibraryFileParams,
                CommandLibraryRevision,
            >(meta, dialect),
            Self::CommandLibraryExport => ActionSpec::of_with_dialect::<
                CommandLibraryFileParams,
                ResultReference,
            >(meta, dialect),
            Self::WorkspaceList => ActionSpec::of_with_dialect::<
                WorkspaceListParams,
                WorkspaceListResult,
            >(meta, dialect),
            Self::WorkspaceRead => {
                ActionSpec::of_with_dialect::<EmptyParams, WorkspaceDocumentResult>(meta, dialect)
            }
            Self::WorkspaceSave => ActionSpec::of_with_dialect::<
                WorkspaceSaveParams,
                WorkspaceDocumentResult,
            >(meta, dialect),
            Self::WorkspaceImport => ActionSpec::of_with_dialect::<
                DocumentImportParams,
                WorkspaceDocumentResult,
            >(meta, dialect),
            Self::SettingsExport | Self::WorkspaceExport => {
                ActionSpec::of_with_dialect::<EmptyParams, DocumentJsonResult>(meta, dialect)
            }
            Self::HostShutdown => {
                ActionSpec::of_with_dialect::<EmptyParams, ShutdownRequested>(meta, dialect)
            }
            Self::StreamRead => {
                ActionSpec::of_with_dialect::<StreamReadParams, StreamReadResult>(meta, dialect)
            }
            Self::StreamDerivedRead => {
                ActionSpec::of_with_dialect::<DerivedReadParams, DerivedReadResult>(meta, dialect)
            }
            Self::StreamSubscribe => ActionSpec::of_with_dialect::<
                StreamSubscribeParams,
                StreamSubscribeResult,
            >(meta, dialect),
            Self::StreamCredit => {
                ActionSpec::of_with_dialect::<StreamCreditParams, StreamCreditResult>(meta, dialect)
            }
            Self::DeviceList => {
                ActionSpec::of_with_dialect::<EmptyParams, DeviceList>(meta, dialect)
            }
            Self::DeviceOpen => {
                ActionSpec::of_with_dialect::<OpenParams, OpenResult>(meta, dialect)
            }
            Self::ToolHandoff => {
                ActionSpec::of_with_dialect::<ToolHandoffParams, ToolHandoffResult>(meta, dialect)
            }
            Self::SessionGet | Self::SessionClose => {
                ActionSpec::of_with_dialect::<EmptyParams, SessionSnapshot>(meta, dialect)
            }
            Self::SessionMetrics => {
                ActionSpec::of_with_dialect::<EmptyParams, SessionMetrics>(meta, dialect)
            }
            Self::SessionInputs => {
                ActionSpec::of_with_dialect::<EmptyParams, SessionInputs>(meta, dialect)
            }
            Self::SessionTx => ActionSpec::of_with_dialect::<TxParams, TxReceipt>(meta, dialect),
            Self::SessionConfigure => {
                ActionSpec::of_with_dialect::<ConfigureParams, ConfigReceipt>(meta, dialect)
            }
            Self::SessionControl => {
                ActionSpec::of_with_dialect::<ControlParams, ControlReceipt>(meta, dialect)
            }
            Self::SessionBreak => {
                ActionSpec::of_with_dialect::<BreakParams, BreakReceipt>(meta, dialect)
            }
            Self::SessionSetReadOnly => {
                ActionSpec::of_with_dialect::<SetReadOnlyParams, SessionSnapshot>(meta, dialect)
            }
            Self::SessionTakeover => {
                ActionSpec::of_with_dialect::<TakeoverParams, TakeoverReceipt>(meta, dialect)
            }
            Self::LeaseAcquire => {
                ActionSpec::of_with_dialect::<LeaseAcquireParams, Lease>(meta, dialect)
            }
            Self::LeaseRenew => {
                ActionSpec::of_with_dialect::<LeaseRenewParams, Lease>(meta, dialect)
            }
            Self::LeaseRelease => {
                ActionSpec::of_with_dialect::<LeaseReleaseParams, Lease>(meta, dialect)
            }
            Self::TxWaitBoundary => ActionSpec::of_with_dialect::<
                WaitBoundaryParams,
                WaitBoundaryReceipt,
            >(meta, dialect),
            Self::TxQueueStatus => {
                ActionSpec::of_with_dialect::<EmptyParams, QueueStatus>(meta, dialect)
            }
            Self::TxDrain => {
                ActionSpec::of_with_dialect::<DrainParams, DrainReceipt>(meta, dialect)
            }
            Self::SessionPurge => {
                ActionSpec::of_with_dialect::<PurgeParams, PurgeReceipt>(meta, dialect)
            }
            Self::CatalogList => {
                ActionSpec::of_with_dialect::<CatalogListParams, CatalogListResult>(meta, dialect)
            }
            Self::OperationGet => {
                ActionSpec::of_with_dialect::<OperationGetParams, OperationResult>(meta, dialect)
            }
            Self::OperationInput => {
                ActionSpec::of_with_dialect::<OperationInputParams, OperationInput>(meta, dialect)
            }
            Self::OperationCancel => ActionSpec::of_with_dialect::<
                OperationCancelParams,
                CancellationResult,
            >(meta, dialect),
            Self::StateSnapshot => {
                ActionSpec::of_with_dialect::<StateSnapshotParams, Snapshot>(meta, dialect)
            }
            Self::StateSubscribe => ActionSpec::of_with_dialect::<
                StateSubscribeParams,
                SubscriptionResult,
            >(meta, dialect),
            Self::SubscriptionClose => {
                ActionSpec::of_with_dialect::<SubscriptionCloseParams, ClosedResult>(meta, dialect)
            }
            Self::Authorize => {
                ActionSpec::of_with_dialect::<AuthorizeParams, AuthorizationResult>(meta, dialect)
            }
            Self::Revoke => {
                ActionSpec::of_with_dialect::<RevokeParams, AuthorizationResult>(meta, dialect)
            }
        }
    }
}
