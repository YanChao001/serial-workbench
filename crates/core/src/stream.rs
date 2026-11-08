use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Rx,
    Tx,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum TimeSource {
    HostRead,
    Device,
    LineCapture,
    SampleClock,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum SourceGapReason {
    NetworkLoss,
    BackendLoss,
    Purge,
    SourceUnknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReaderGapReason {
    ReaderOverflow,
    CaptureOverflow,
    CapturePaused,
    NetworkLoss,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum OverflowPolicy {
    DropWithGap,
    Stop,
    FlowControl,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum Certainty {
    Confirmed,
    Uncertain,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimePrecision {
    pub source: TimeSource,
    pub resolution_ns: U64,
    pub sync_method: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "SignedDecimal")]
    #[specta(type=SignedDecimal, optional)]
    pub offset_estimate_ns: Option<SignedDecimal>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub offset_error_ns: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub rtt_ns: Option<U64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventTime {
    pub clock_id: Id,
    pub source_mono_ns: U64,
    pub received_wall_time: Timestamp,
    pub precision: TimePrecision,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Timestamp")]
    #[specta(type=Timestamp, optional)]
    pub source_wall_time: Option<Timestamp>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageFragment {
    pub message_id: Id,
    pub fragment_offset: U64,
    pub message_length: U64,
    pub message_type: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RxPayload {
    pub bytes_base64: Bytes,
    pub byte_start: U64,
    pub byte_end: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "MessageFragment")]
    #[specta(type=MessageFragment, optional)]
    pub message: Option<MessageFragment>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectionalRange {
    pub direction: Direction,
    pub start: U64,
    pub end: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceGap {
    pub reason: SourceGapReason,
    pub known_extent: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ByteRange")]
    #[specta(type=ByteRange, optional)]
    pub missing_event_range: Option<ByteRange>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "DirectionalRange")]
    #[specta(type=DirectionalRange, optional)]
    pub missing_byte_range: Option<DirectionalRange>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Direction")]
    #[specta(type=Direction, optional)]
    pub direction: Option<Direction>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationBoundary {
    pub revision: U64,
    pub certainty: Certainty,
    pub receipt_ref: ObjectRef,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TxIntent {
    pub operation_id: Id,
    pub bytes_base64: Bytes,
    pub byte_start: U64,
    pub byte_end: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum RawPayload {
    Rx(RxPayload),
    TxIntent(TxIntent),
    Tx(Box<TxReceipt>),
    Gap(SourceGap),
    ConfigurationBoundary(ConfigurationBoundary),
    Lifecycle(JsonObject),
    Control(JsonObject),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawEvent {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub session_id: Id,
    pub session_epoch: U64,
    pub event_seq: U64,
    pub configuration_revision: U64,
    pub time: EventTime,
    #[serde(flatten)]
    pub payload: RawPayload,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReaderGap {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub session_id: Id,
    pub session_epoch: U64,
    pub reason: ReaderGapReason,
    pub missing_event_range: ByteRange,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Vec<DirectionalRange>")]
    #[specta(type=Vec<DirectionalRange>, optional)]
    pub missing_byte_ranges: Option<Vec<DirectionalRange>>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StreamItem {
    Source { event: Box<RawEvent> },
    ReaderGap { gap: ReaderGap },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawBatch {
    pub subscription_id: Id,
    pub cursor: Cursor,
    pub previous_cursor: Cursor,
    #[schemars(length(min = 1))]
    #[serde(deserialize_with = "non_empty_items")]
    #[specta(type=Vec<StreamItem>)]
    pub items: Vec<StreamItem>,
}
fn non_empty_items<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<StreamItem>, D::Error> {
    let items = Vec::<StreamItem>::deserialize(d)?;
    if items.is_empty() {
        Err(serde::de::Error::custom("RawBatch requires items"))
    } else {
        Ok(items)
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamReadParams {
    pub session_id: Id,
    pub session_epoch: U64,
    pub start_event_seq: U64,
    pub max_events: U64,
    pub max_bytes: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamReadResult {
    pub events: Vec<RawEvent>,
    pub next_event_seq: U64,
    pub has_more: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamSubscribeParams {
    pub scope_id: Id,
    pub after: Cursor,
    pub queue_bytes: U64,
    pub initial_credit_bytes: U64,
    pub overflow_policy: OverflowPolicy,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamSubscribeResult {
    pub subscription_id: Id,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamCreditParams {
    pub subscription_id: Id,
    pub ack_cursor: Cursor,
    pub granted_bytes_total: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamCreditResult {
    pub ack_cursor: Cursor,
    pub granted_bytes_total: U64,
    pub sent_bytes_total: U64,
    pub acknowledged_bytes_total: U64,
}
