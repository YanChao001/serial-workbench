use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileTransferParams {
    pub source_ref: ObjectRef,
    pub offset: U64,
    pub length: U64,
    #[serde(default = "default_chunk_bytes")]
    pub chunk_bytes: U64,
    pub bytes_per_second: U64,
    pub inter_chunk_ms: U64,
    pub write_wait_ms: DurationMs,
}
fn default_chunk_bytes() -> U64 {
    4096.into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileTransferResult {
    pub requested: U64,
    pub accepted: U64,
    pub unknown: U64,
    pub receipts_ref: ObjectRef,
    pub peer_acknowledged: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileTransferReceipt {
    pub source_offset: U64,
    pub receipt: TxReceipt,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileTransferReceiptsParams {
    pub receipts_ref: ObjectRef,
    pub start_ordinal: U64,
    pub max_receipts: U64,
    pub max_bytes: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileTransferReceiptsResult {
    pub receipts_ref: ObjectRef,
    pub count: U64,
    pub receipts: Vec<FileTransferReceipt>,
    pub next_ordinal: U64,
    pub has_more: bool,
    pub sealed: bool,
}
