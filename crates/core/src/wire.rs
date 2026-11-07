use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ProtocolVersion {
    #[serde(rename = "0.1")]
    V0_1,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    #[default]
    Interactive,
    Independent,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectRef {
    pub host_id: Id,
    pub kind: ResourceKind,
    pub id: Id,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub revision: Option<U64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevealTarget {
    pub page_id: Id,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub workspace_id: Option<Id>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub session_id: Option<Id>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub panel_id: Option<Id>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ObjectRef")]
    #[specta(type=ObjectRef, optional)]
    pub result_ref: Option<ObjectRef>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cursor {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub scope_id: Id,
    pub position: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    pub protocol_version: ProtocolVersion,
    pub host_id: Id,
    pub instance_epoch: U64,
    pub actor_id: Id,
    pub request_id: RequestId,
    pub action_id: Id,
    pub target: Target,
    pub params: JsonObject,
    pub reveal_target: RevealTarget,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Call {
    pub protocol_version: ProtocolVersion,
    pub host_id: Id,
    pub instance_epoch: U64,
    pub actor_id: Id,
    pub request_id: RequestId,
    pub request_context: ContextToken,
    pub action_id: Id,
    pub target: Target,
    pub params: JsonObject,
    pub reveal_target: RevealTarget,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub expected_revision: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub lease_id: Option<Id>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ExecutionMode")]
    #[specta(type=ExecutionMode, optional)]
    pub execution_mode: Option<ExecutionMode>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildCall {
    pub protocol_version: ProtocolVersion,
    pub host_id: Id,
    pub instance_epoch: U64,
    pub actor_id: Id,
    pub task_context: ContextToken,
    pub parent_operation_id: Id,
    pub child_key: PositiveU64,
    pub action_id: Id,
    pub target: Target,
    pub params: JsonObject,
    pub reveal_target: RevealTarget,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub expected_revision: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub lease_id: Option<Id>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub revision: U64,
    pub cursor: Cursor,
    pub state: JsonObject,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delta {
    pub cursor: Cursor,
    pub previous_cursor: Cursor,
    pub revision: U64,
    pub event_type: Id,
    pub payload: JsonObject,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub max_request_bytes: U64,
    pub max_page_items: U64,
    pub max_batch_bytes: U64,
    pub max_reader_queue_bytes: U64,
    pub result_retention_ms: RetentionMs,
    pub max_lease_ttl_ms: DurationMs,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ClientKind {
    Desktop,
    Browser,
    Cli,
    Mcp,
    Node,
    Peer,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachParams {
    pub supported_protocol_versions: Vec<String>,
    pub client_kind: ClientKind,
    pub client_id: Id,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub expected_host_id: Option<Id>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachResult {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub protocol_version: ProtocolVersion,
    pub catalog_version: U64,
    pub actor_id: Id,
    pub client_id: Id,
    pub limits: Limits,
    pub request_context: ContextToken,
    pub request_context_accept_until: Timestamp,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationResult {
    pub operation: Operation,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionResult {
    pub subscription_id: Id,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClosedResult {
    pub closed: True,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectReadResult {
    pub bytes_base64: Bytes,
    pub revision: U64,
    pub length: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub next_offset: Option<U64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogListResult {
    pub catalog_version: U64,
    pub items: Vec<ActionSpec>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type=String, optional)]
    pub next_page_token: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "method", content = "params", deny_unknown_fields)]
pub enum RpcRequest {
    #[serde(rename = "action.query")]
    Query(Query),
    #[serde(rename = "host.attach")]
    Attach(AttachParams),
    #[serde(rename = "catalog.list")]
    CatalogList(Query),
    #[serde(rename = "action.invoke")]
    Invoke(Call),
    #[serde(rename = "action.invokeChild")]
    InvokeChild(ChildCall),
    #[serde(rename = "operation.get")]
    OperationGet(Query),
    #[serde(rename = "operation.cancel")]
    OperationCancel(Call),
    #[serde(rename = "state.snapshot")]
    StateSnapshot(Query),
    #[serde(rename = "state.subscribe")]
    StateSubscribe(Query),
    #[serde(rename = "subscription.close")]
    SubscriptionClose(Query),
    #[serde(rename = "object.read")]
    ObjectRead(Query),
    #[serde(rename = "stream.read")]
    StreamRead(Query),
    #[serde(rename = "stream.subscribe")]
    StreamSubscribe(Query),
    #[serde(rename = "stream.credit")]
    StreamCredit(Query),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(untagged)]
pub enum RpcResult {
    Query(QueryResult),
    Attach(AttachResult),
    Operation(Box<OperationResult>),
    Catalog(CatalogListResult),
    Snapshot(Snapshot),
    Subscription(SubscriptionResult),
    Closed(ClosedResult),
    Object(ObjectReadResult),
    StreamRead(StreamReadResult),
    StreamCredit(StreamCreditResult),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(untagged, deny_unknown_fields)]
pub enum RpcReply {
    Success { ok: True, result: Box<RpcResult> },
    Failure { ok: False, error: HostError },
}
