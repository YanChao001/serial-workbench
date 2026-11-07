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
    #[schemars(with = "JsonValue")]
    #[specta(type=JsonValue, optional)]
    pub actual: Option<JsonValue>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigReceipt {
    pub requested: JsonObject,
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
