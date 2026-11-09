use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureStatusResult {
    pub capture_ref: ObjectRef,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub owner_operation_id: Option<Id>,
    pub summary: CaptureSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureTailParams {
    pub capture_ref: ObjectRef,
    #[serde(default = "tail_records", deserialize_with = "read_tail_records")]
    #[schemars(schema_with = "tail_records_schema")]
    #[specta(type = U64)]
    pub max_records: U64,
    #[serde(default = "tail_bytes", deserialize_with = "read_tail_bytes")]
    #[schemars(schema_with = "tail_bytes_schema")]
    #[specta(type = U64)]
    pub max_bytes: U64,
}
fn tail_records() -> U64 {
    100.into()
}
fn tail_bytes() -> U64 {
    262144.into()
}
fn read_tail_records<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<U64, D::Error> {
    bounded_tail(deserializer, 100)
}
fn read_tail_bytes<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<U64, D::Error> {
    bounded_tail(deserializer, 262144)
}
fn bounded_tail<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
    max: u64,
) -> Result<U64, D::Error> {
    let value = U64::deserialize(deserializer)?;
    if !(1..=max).contains(&value.get()) {
        return Err(serde::de::Error::custom(
            "Capture tail budget is outside its range",
        ));
    }
    Ok(value)
}
fn tail_records_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"string","pattern":"^(?:[1-9]|[1-9][0-9]|100)$"})
}
fn tail_bytes_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"string","pattern":"^(?:[1-9][0-9]{0,4}|1[0-9]{5}|2[0-5][0-9]{4}|26[01][0-9]{3}|2620[0-9]{2}|2621[0-3][0-9]|26214[0-4])$"})
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureTailResult {
    pub capture_ref: ObjectRef,
    pub source_fingerprint: Digest,
    pub state: CaptureState,
    pub verified_prefix: U64,
    pub container_complete: bool,
    pub source_continuous: bool,
    pub first_record: U64,
    pub records: Vec<ReplayRecord>,
}
