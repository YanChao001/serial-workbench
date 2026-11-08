use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum TxOutcome {
    Accepted,
    Partial,
    Rejected,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum TxGate {
    Ready,
    ConfigurationPending,
    ControlUnknown,
    Closing,
    Disconnected,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum FieldStatus {
    Applied,
    Rejected,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ControlStatus {
    Confirmed,
    Failed,
    Unknown,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ByteRange {
    pub start: U64,
    pub end: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TxReceipt {
    pub operation_id: Id,
    pub session_id: Id,
    pub session_epoch: U64,
    pub outcome: TxOutcome,
    pub bytes_base64: Bytes,
    pub byte_start: U64,
    pub byte_end: U64,
    pub accepted_ranges: Vec<ByteRange>,
    pub unknown_ranges: Vec<ByteRange>,
    pub peer_acknowledged: False,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "HostError")]
    #[specta(type=HostError, optional)]
    pub backend_error: Option<HostError>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigField {
    pub field: String,
    pub status: FieldStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(schema_with = "config_actual_schema")]
    #[specta(type=NonNullJsonValue, optional)]
    pub actual: Option<JsonValue>,
}
fn config_actual_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"allOf":[generator.subschema_for::<JsonValue>(),{"not":{"type":"null"}}]})
}
struct NonNullJsonValue;
impl Type for NonNullJsonValue {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        let _ = JsonValue::definition(types);
        specta::datatype::DataType::Reference(specta_typescript::define("Exclude<JsonValue, null>"))
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigReceipt {
    pub requested: SerialConfiguration,
    pub fields: Vec<ConfigField>,
    pub readback: JsonObject,
    pub revision: U64,
    pub boundary_event_seq: U64,
    pub tx_gate: TxGate,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlTransition {
    pub status: ControlStatus,
    pub at: Timestamp,
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
pub struct BreakReceipt {
    pub assert: ControlTransition,
    pub clear: ControlTransition,
}

macro_rules! wire_enum {
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
        pub enum $name { $(#[serde(rename = $wire)] $variant),+ }
    };
}
wire_enum!(DataBits { Five => "5", Six => "6", Seven => "7", Eight => "8" });
wire_enum!(Parity { None => "none", Even => "even", Odd => "odd", Mark => "mark", Space => "space" });
wire_enum!(StopBits { One => "one", OnePointFive => "onePointFive", Two => "two" });
wire_enum!(FlowControl { None => "none", RtsCts => "rtsCts", XonXoff => "xonXoff", DsrDtr => "dsrDtr" });
wire_enum!(TransportSemantics { Stream => "stream", Message => "message" });
wire_enum!(SessionState { Closed => "closed", Opening => "opening", Open => "open", Disconnected => "disconnected", Closing => "closing" });
wire_enum!(ControlState { Clear => "clear", Asserting => "asserting", Asserted => "asserted", Clearing => "clearing", Unknown => "unknown" });
wire_enum!(ControlLine { Dtr => "dtr", Rts => "rts" });
wire_enum!(PurgeDirection { Rx => "rx", Tx => "tx", Both => "both" });
wire_enum!(PurgeScope { Application => "application", Driver => "driver", Both => "both" });
wire_enum!(PurgeOutcome { Completed => "completed", Partial => "partial", Unknown => "unknown" });
wire_enum!(LeaseKind { Ordinary => "ordinary", Transaction => "transaction", Exclusive => "exclusive" });
wire_enum!(ExplicitLeaseKind { Transaction => "transaction", Exclusive => "exclusive" });
wire_enum!(LeaseState { Active => "active", Revoking => "revoking", Released => "released", Expired => "expired" });
wire_enum!(TakeoverReason { User => "user" });

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SerialConfiguration {
    pub baud_rate: PositiveU64,
    pub data_bits: DataBits,
    pub parity: Parity,
    pub stop_bits: StopBits,
    pub flow_control: FlowControl,
    pub read_wait_ms: DurationMs,
    pub write_wait_ms: DurationMs,
    pub reconnect_backoff_ms: DurationMs,
}
impl Default for SerialConfiguration {
    fn default() -> Self {
        Self {
            baud_rate: PositiveU64::try_from(U64::from(9600)).expect("positive baud"),
            data_bits: DataBits::Eight,
            parity: Parity::None,
            stop_bits: StopBits::One,
            flow_control: FlowControl::None,
            read_wait_ms: DurationMs::try_from(U64::from(20)).expect("read wait"),
            write_wait_ms: DurationMs::try_from(U64::from(1000)).expect("write wait"),
            reconnect_backoff_ms: DurationMs::try_from(U64::from(500)).expect("reconnect wait"),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransportCapabilities {
    pub semantics: TransportSemantics,
    pub configuration: bool,
    pub dtr: bool,
    pub rts: bool,
    pub finite_break: bool,
    pub queue_status: bool,
    pub drain: bool,
    pub purge_rx: bool,
    pub purge_tx: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSnapshot {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ReconnectStatus")]
    #[specta(type=ReconnectStatus, optional)]
    pub reconnect: Option<ReconnectStatus>,
    pub session_id: Id,
    pub device_id: Id,
    pub session_epoch: U64,
    pub revision: U64,
    pub configuration_revision: U64,
    pub state: SessionState,
    pub configuration: SerialConfiguration,
    pub read_only: bool,
    pub tx_gate: TxGate,
    pub control_state: ControlState,
    pub capabilities: TransportCapabilities,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Lease")]
    #[specta(type=Lease, optional)]
    pub lease: Option<Lease>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenParams {
    pub configuration: SerialConfiguration,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "DeviceBindingReference")]
    #[specta(type=DeviceBindingReference, optional)]
    pub binding: Option<DeviceBindingReference>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenResult {
    pub session_id: Id,
    pub session_epoch: U64,
    pub revision: U64,
    pub reused: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "HostError")]
    #[specta(type=HostError, optional)]
    pub recent_error: Option<HostError>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransformReference {
    pub id: Id,
    pub version: String,
    pub configuration_digest: Digest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TxParams {
    #[serde(deserialize_with = "tx_bytes")]
    #[schemars(schema_with = "tx_bytes_schema")]
    #[specta(type=Bytes)]
    pub bytes_base64: Bytes,
    pub write_wait_ms: DurationMs,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "DurationMs")]
    #[specta(type=DurationMs, optional)]
    pub queue_wait_ms: Option<DurationMs>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ObjectRef")]
    #[specta(type=ObjectRef, optional)]
    pub source_input_ref: Option<ObjectRef>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Vec<TransformReference>")]
    #[specta(type=Vec<TransformReference>, optional)]
    pub transforms: Option<Vec<TransformReference>>,
}
fn tx_bytes<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Bytes, D::Error> {
    let value = Bytes::deserialize(deserializer)?;
    let text = value.as_str();
    let decoded = text.len() / 4 * 3 - text.bytes().rev().take_while(|byte| *byte == b'=').count();
    if !(1..=16384).contains(&decoded) {
        return Err(serde::de::Error::custom(
            "TX must contain 1 through 16384 decoded bytes",
        ));
    }
    Ok(value)
}
fn tx_bytes_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    // 最后一个四字符组只能表示一个字节，16384/16385的Base64总长度相同。
    schemars::json_schema!({"allOf":[generator.subschema_for::<Bytes>(),{"type":"string","minLength":4,"anyOf":[{"type":"string","maxLength":21844},{"type":"string","maxLength":21848,"pattern":"==$"}]}]})
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureParams {
    pub requested: SerialConfiguration,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlParams {
    pub line: ControlLine,
    pub value: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlReceipt {
    pub line: ControlLine,
    pub requested: bool,
    pub status: ControlStatus,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "bool")]
    #[specta(type=bool,optional)]
    pub actual: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BreakParams {
    pub duration_ms: DurationMs,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetReadOnlyParams {
    pub read_only: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    pub lease_id: Id,
    pub session_id: Id,
    pub session_epoch: U64,
    pub actor_id: Id,
    pub owner_operation_id: Id,
    pub kind: LeaseKind,
    pub state: LeaseState,
    pub execution_mode: ExecutionMode,
    pub expires_at_mono_ns: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseAcquireParams {
    pub kind: ExplicitLeaseKind,
    pub ttl_ms: DurationMs,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseRenewParams {
    pub lease_id: Id,
    pub ttl_ms: DurationMs,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseReleaseParams {
    pub lease_id: Id,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeoverParams {
    pub actor_id: Id,
    pub reason: TakeoverReason,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeoverReceipt {
    pub affected_operation_ids: Vec<Id>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitBoundaryParams {
    pub through_operation_id: Id,
    pub queue_wait_ms: DurationMs,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitBoundaryReceipt {
    pub through_operation_id: Id,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueStatus {
    pub pending_bytes: U64,
    pub observed_at: Timestamp,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrainParams {
    pub write_wait_ms: DurationMs,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DrainReceipt {
    pub status: ControlStatus,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeParams {
    pub direction: PurgeDirection,
    pub scope: PurgeScope,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PurgeReceipt {
    pub direction: PurgeDirection,
    pub scope: PurgeScope,
    pub outcome: PurgeOutcome,
    pub affected_operation_ids: Vec<Id>,
    pub ranges: Vec<DirectionalRange>,
    pub unknown_extent: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}
