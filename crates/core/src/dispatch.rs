//! 已实现 Host 动作的具体输入输出；通用查询只增加可辨识的 wire 包装。
use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogListParams {
    pub page_size: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub page_token: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub catalog_version: Option<U64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(untagged, rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum OperationGetParams {
    ById {
        operation_id: Id,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::identity::non_null_option"
        )]
        #[schemars(with = "ContextToken")]
        #[specta(type=ContextToken, optional)]
        request_context: Option<ContextToken>,
    },
    ByRequest {
        actor_id: Id,
        request_id: RequestId,
        request_context: ContextToken,
    },
    ByChild {
        parent_operation_id: Id,
        child_key: PositiveU64,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    User,
    Revoked,
    Takeover,
    Shutdown,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationCancelParams {
    pub reason: CancelReason,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateSnapshotParams {
    pub scope_id: Id,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateSubscribeParams {
    pub scope_id: Id,
    pub after: Cursor,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionCloseParams {
    pub subscription_id: Id,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizationResult {
    pub grant_revision: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancellationResult {
    pub operation_id: Id,
    pub state: OperationState,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownRequested {
    pub instance_epoch: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamCursorResult {
    pub target: Target,
    pub cursor: Cursor,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum QueryResult {
    ClientEffect(ClientEffectResult),
    Clients(ClientListResult),
    HostMetrics(HostMetrics),
    StartupConfig(StartupConfigSnapshot),
    CaptureStatus(CaptureStatusResult),
    ReplayRead(ReplayReadResult),
    Recent(RecentList),
    FileMetadata(FileMetadata),
    FileRead(FileReadResult),
    FileTransferReceipts(FileTransferReceiptsResult),
    StreamCursor(StreamCursorResult),
    Scopes(StateScopesResult),
    Settings(SettingsDocumentResult),
    Workspace(WorkspaceDocumentResult),
    DocumentJson(DocumentJsonResult),
    StreamRead(StreamReadResult),
    StreamSubscribe(StreamSubscribeResult),
    StreamCredit(StreamCreditResult),
    Devices(DeviceList),
    Session(SessionSnapshot),
    Queue(QueueStatus),
    Catalog(CatalogListResult),
    Operation(Box<OperationResult>),
    OperationInput(OperationInput),
    Snapshot(Snapshot),
    Subscription(SubscriptionResult),
    Closed(ClosedResult),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestChannel {
    Control,
    Raw,
    Either,
}

impl RpcRequest {
    /// 物理连接限制从 actionId 推导，通用入口不能绕过专用 RPC 的限制。
    pub fn required_channel(&self) -> HostResult<RequestChannel> {
        let (id, expected) = match self {
            Self::Attach(_)
            | Self::ClientRegister(_)
            | Self::ClientUnregister(_)
            | Self::ClientReceipt(_) => return Ok(RequestChannel::Control),
            Self::Query(q) => (q.action_id.as_str(), None),
            Self::Invoke(c) => (c.action_id.as_str(), None),
            Self::InvokeChild(c) => (c.action_id.as_str(), None),
            Self::CatalogList(q) => (q.action_id.as_str(), Some("catalog.list")),
            Self::OperationGet(q) => (q.action_id.as_str(), Some("operation.get")),
            Self::OperationCancel(c) => (c.action_id.as_str(), Some("operation.cancel")),
            Self::StateSnapshot(q) => (q.action_id.as_str(), Some("state.snapshot")),
            Self::StateSubscribe(q) => (q.action_id.as_str(), Some("state.subscribe")),
            Self::SubscriptionClose(q) => (q.action_id.as_str(), Some("subscription.close")),
            Self::ObjectRead(q) => (q.action_id.as_str(), Some("object.read")),
            Self::StreamRead(q) => (q.action_id.as_str(), Some("stream.read")),
            Self::StreamSubscribe(q) => (q.action_id.as_str(), Some("stream.subscribe")),
            Self::StreamCredit(q) => (q.action_id.as_str(), Some("stream.credit")),
        };
        if expected.is_some_and(|expected| expected != id) {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "RPC method and action identity differ",
            ));
        }
        Ok(match id {
            "stream.cursor"
            | "stream.read"
            | "stream.subscribe"
            | "stream.credit"
            | "file.read"
            | "transfer.receiptsRead"
            | "operation.input"
            | "replay.read" => RequestChannel::Raw,
            "subscription.close" => RequestChannel::Either,
            _ => RequestChannel::Control,
        })
    }
}
