//! Safe operation projections and explicitly typed inspection inputs.
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivitySummary {
    pub activity_id: Id,
    pub actor_id: Id,
    pub request_id: RequestId,
    pub action_id: Id,
    pub target: Target,
    pub reveal_target: RevealTarget,
    pub observations: U64,
    pub observed_at: Timestamp,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id,optional)]
    pub mcp_client_id: Option<Id>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id,optional)]
    pub operation_id: Option<Id>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivitySnapshot {
    pub items: Vec<ActivitySummary>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "BrowserTakeoverRequest")]
    #[specta(type=BrowserTakeoverRequest,optional)]
    pub pending_takeover: Option<BrowserTakeoverRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationSummary {
    pub operation_id: Id,
    pub execution_host_id: Id,
    pub actor_id: Id,
    pub action_id: Id,
    pub target: Target,
    pub execution_mode: ExecutionMode,
    pub state: OperationState,
    pub revision: U64,
    pub reveal_target: RevealTarget,
    pub accepted_at: Timestamp,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Timestamp")]
    #[specta(type=Timestamp,optional)]
    pub started_at: Option<Timestamp>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Timestamp")]
    #[specta(type=Timestamp,optional)]
    pub settled_at: Option<Timestamp>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Progress")]
    #[specta(type=Progress,optional)]
    pub progress: Option<Progress>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String,optional)]
    pub error_code: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationsSnapshot {
    pub items: Vec<OperationSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationInputParams {
    pub operation_id: Id,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum OperationInputRedaction {
    SensitivePath,
    Management,
    UnsupportedAction,
    InvalidStoredInput,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum OperationInput {
    Open(OpenParams),
    Tx(TxParams),
    FileTransfer(FileTransferParams),
    PasteTransfer(PasteTransferParams),
    CaptureStart(CaptureStartParams),
    Configure(ConfigureParams),
    Control(ControlParams),
    Break(BreakParams),
    Client(ClientEffectAction),
    SettingsSave(SettingsSaveParams),
    WorkspaceSave(WorkspaceSaveParams),
    Redacted { reason: OperationInputRedaction },
}
