use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Queued,
    Running,
    CancelRequested,
    Succeeded,
    Failed,
    Cancelled,
    Interrupted,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum OwnerKind {
    Host,
    Plugin,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub kind: OwnerKind,
    pub id: Id,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub version: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Dependency {
    pub id: Id,
    pub version: String,
    pub digest: Digest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Progress {
    pub completed: U64,
    pub unit: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub total: Option<U64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Admission {
    Request {
        request_context_digest: Digest,
    },
    Child {
        task_context_digest: Digest,
        parent_operation_id: Id,
        child_key: PositiveU64,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ActionResult {
    ClientEffect(ClientEffectResult),
    CaptureStatus(CaptureStatusResult),
    CaptureVerification(VerificationReport),
    ReplayPosition(ReplayReadResult),
    FileMetadata(FileMetadata),
    FileTransfer(FileTransferResult),
    Settings(SettingsDocumentResult),
    Workspace(WorkspaceDocumentResult),
    ShutdownRequested(ShutdownRequested),
    Opened(OpenResult),
    Session(SessionSnapshot),
    Control(ControlReceipt),
    Lease(Lease),
    Takeover(TakeoverReceipt),
    Boundary(WaitBoundaryReceipt),
    Drained(DrainReceipt),
    Purged(PurgeReceipt),
    Tx(TxReceipt),
    Configuration(ConfigReceipt),
    Break(BreakReceipt),
    Reference(ResultReference),
    AuthorizationChanged(AuthorizationResult),
    CancellationRequested(CancellationResult),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultReference {
    pub result_ref: ObjectRef,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Operation {
    pub operation_id: Id,
    pub execution_host_id: Id,
    pub actor_id: Id,
    pub request_id: RequestId,
    pub admission: Admission,
    pub root_operation_id: Id,
    pub child_high_watermark: U64,
    pub action_id: Id,
    pub target: Target,
    pub execution_mode: ExecutionMode,
    pub state: OperationState,
    pub revision: U64,
    pub reveal_target: RevealTarget,
    pub accepted_at: Timestamp,
    pub owner: Owner,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Vec<Dependency>")]
    #[specta(type=Vec<Dependency>, optional)]
    pub dependencies: Option<Vec<Dependency>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Timestamp")]
    #[specta(type=Timestamp, optional)]
    pub started_at: Option<Timestamp>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Timestamp")]
    #[specta(type=Timestamp, optional)]
    pub settled_at: Option<Timestamp>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Timestamp")]
    #[specta(type=Timestamp, optional)]
    pub result_expires_at: Option<Timestamp>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Progress")]
    #[specta(type=Progress, optional)]
    pub progress: Option<Progress>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ActionResult")]
    #[specta(type=ActionResult, optional)]
    pub result: Option<ActionResult>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ClientEffectReceipt")]
    #[specta(type=ClientEffectReceipt, optional)]
    pub client_effect_receipt: Option<ClientEffectReceipt>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "HostError")]
    #[specta(type=HostError, optional)]
    pub error: Option<HostError>,
}
