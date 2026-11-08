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
    ActionCheck(ActionCheckResult),
    WorkspaceImportPreview(WorkspaceDocument),
    ClientEffect(ClientEffectResult),
    Clients(ClientListResult),
    HostMetrics(HostMetrics),
    StartupConfig(StartupConfigSnapshot),
    CaptureStatus(CaptureStatusResult),
    CaptureTail(CaptureTailResult),
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
    SessionMetrics(SessionMetrics),
    SessionInputs(SessionInputs),
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
            | "capture.tail"
            | "replay.read" => RequestChannel::Raw,
            "subscription.close" => RequestChannel::Either,
            _ => RequestChannel::Control,
        })
    }
}

impl BuiltinAction {
    /// Pure wire validation shared by normal admission and permission checks.
    /// Execution state, leases and CAS remain the responsibility of execution.
    pub fn validate_query_params(self, query: &Query) -> HostResult<()> {
        fn decode<T: serde::de::DeserializeOwned>(params: &JsonObject) -> HostResult<T> {
            serde_json::from_value(serde_json::to_value(params).map_err(|_| invalid())?)
                .map_err(|_| invalid())
        }
        fn invalid() -> HostError {
            HostError::new(
                "INVALID_ARGUMENT",
                "Action parameters or target identity are invalid",
            )
        }
        macro_rules! typed {
            ($ty:ty) => {{
                let _: $ty = decode(&query.params)?;
            }};
        }
        match self {
            Self::ActionCheck => typed!(ActionCheckParams),
            Self::Client(capability) => {
                ClientEffectAction::from_params(capability, &query.params)?;
            }
            Self::HostMetrics => typed!(HostMetricsParams),
            Self::CaptureStart => typed!(CaptureStartParams),
            Self::CaptureStop => typed!(CaptureStopParams),
            Self::CaptureStatus | Self::CaptureVerify => typed!(CaptureVerifyParams),
            Self::CaptureTail => typed!(CaptureTailParams),
            Self::CaptureRecover => typed!(RecoverPrefixParams),
            Self::CaptureExport => typed!(TextExportParams),
            Self::ReplayOpen => typed!(ReplayOpenParams),
            Self::ReplayRead => typed!(ReplayReadParams),
            Self::ReplayControl => typed!(ReplayControlParams),
            Self::DeviceRebind => typed!(RebindParams),
            Self::FavoritesSave => typed!(FavoritesSaveParams),
            Self::FileRegister => typed!(RegisterFileParams),
            Self::FileMetadata => typed!(FileMetadataParams),
            Self::FileRead => typed!(FileReadParams),
            Self::TransferReceiptsRead => typed!(FileTransferReceiptsParams),
            Self::TransferFile => typed!(FileTransferParams),
            Self::SettingsSave => typed!(SettingsSaveParams),
            Self::WorkspaceSave => typed!(WorkspaceSaveParams),
            Self::SettingsImport | Self::WorkspaceImport | Self::WorkspaceImportPreview => {
                typed!(DocumentImportParams)
            }
            Self::CatalogList => typed!(CatalogListParams),
            Self::OperationGet => typed!(OperationGetParams),
            Self::OperationInput => typed!(OperationInputParams),
            Self::OperationCancel => typed!(OperationCancelParams),
            Self::StateSnapshot => typed!(StateSnapshotParams),
            Self::StateSubscribe => typed!(StateSubscribeParams),
            Self::SubscriptionClose => typed!(SubscriptionCloseParams),
            Self::Authorize => typed!(AuthorizeParams),
            Self::Revoke => typed!(RevokeParams),
            Self::DeviceOpen => typed!(OpenParams),
            Self::SessionTx => typed!(TxParams),
            Self::SessionConfigure => typed!(ConfigureParams),
            Self::SessionControl => typed!(ControlParams),
            Self::SessionBreak => typed!(BreakParams),
            Self::SessionSetReadOnly => typed!(SetReadOnlyParams),
            Self::SessionTakeover => typed!(TakeoverParams),
            Self::LeaseAcquire => typed!(LeaseAcquireParams),
            Self::LeaseRenew => typed!(LeaseRenewParams),
            Self::LeaseRelease => typed!(LeaseReleaseParams),
            Self::TxWaitBoundary => typed!(WaitBoundaryParams),
            Self::TxDrain => typed!(DrainParams),
            Self::SessionPurge => typed!(PurgeParams),
            Self::StreamRead => {
                let params: StreamReadParams = decode(&query.params)?;
                if params.session_id != query.target.id
                    || Some(params.session_epoch) != query.target.session_epoch
                {
                    return Err(invalid());
                }
            }
            Self::StreamSubscribe => {
                let params: StreamSubscribeParams = decode(&query.params)?;
                if params.scope_id.as_str()
                    != format!(
                        "raw:{}:{}",
                        query.target.id,
                        query.target.session_epoch.ok_or_else(invalid)?
                    )
                    || params.after.scope_id != params.scope_id
                    || params.after.host_id != query.host_id
                    || params.after.instance_epoch != query.instance_epoch
                {
                    return Err(invalid());
                }
            }
            Self::StreamCredit => typed!(StreamCreditParams),
            Self::StateScopes => {
                typed!(EmptyParams);
                if query.target.id != query.host_id {
                    return Err(invalid());
                }
            }
            Self::ClientList
            | Self::StartupConfigGet
            | Self::ReplayClose
            | Self::DeviceRefresh
            | Self::RecentList
            | Self::StreamCursor
            | Self::SettingsRead
            | Self::SettingsExport
            | Self::WorkspaceRead
            | Self::WorkspaceExport
            | Self::DeviceList
            | Self::SessionGet
            | Self::SessionMetrics
            | Self::SessionInputs
            | Self::SessionClose
            | Self::TxQueueStatus
            | Self::HostShutdown => typed!(EmptyParams),
        }
        Ok(())
    }
}
