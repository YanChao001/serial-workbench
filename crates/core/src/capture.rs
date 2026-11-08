use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum CaptureEntry {
    Event(Box<RawEvent>),
    TxSettlement(Box<CaptureTxSettlement>),
    ReaderGap(Box<ReaderGap>),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureTxSettlement {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub receipt: TxReceipt,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRecord {
    pub record_ordinal: U64,
    pub entry: CaptureEntry,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Recording,
    Finalizing,
    Complete,
    Incomplete,
    Failed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    #[default]
    Raw,
    Redacted,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum CaptureWriteMode {
    #[default]
    CreateNew,
    Append,
    Replace,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureWatermarks {
    pub written: U64,
    pub flushed: U64,
    pub synced: U64,
    pub verified: U64,
}
impl Default for CaptureWatermarks {
    fn default() -> Self {
        Self {
            written: 0.into(),
            flushed: 0.into(),
            synced: 0.into(),
            verified: 0.into(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureSummary {
    pub capture_id: Id,
    pub state: CaptureState,
    pub watermarks: CaptureWatermarks,
    pub container_complete: bool,
    pub source_continuous: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Digest")]
    #[specta(type=Digest,optional)]
    pub source_fingerprint: Option<Digest>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureStartParams {
    pub session_refs: Vec<Target>,
    pub target_ref: ObjectRef,
    #[serde(default)]
    pub mode: CaptureMode,
    pub overflow_policy: OverflowPolicy,
    #[serde(default)]
    pub write_mode: CaptureWriteMode,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Digest")]
    #[specta(type=Digest,optional)]
    pub expected_fingerprint: Option<Digest>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureStopParams {
    pub capture_ref: ObjectRef,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureVerifyParams {
    pub capture_ref: ObjectRef,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum CaptureVolumeStatus {
    Verified,
    Missing,
    Corrupt,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureVolumeResult {
    pub volume_id: Id,
    pub status: CaptureVolumeStatus,
    pub verified_prefix: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerificationReport {
    pub verification_id: Id,
    pub source_fingerprint: Digest,
    pub verified_prefix: U64,
    pub volume_results: Vec<CaptureVolumeResult>,
    pub recoverable: bool,
    pub container_complete: bool,
    pub source_continuous: bool,
    pub unsettled_operations: Vec<Id>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverPrefixParams {
    pub verification_id: Id,
    pub source_fingerprint: Digest,
    pub target_ref: ObjectRef,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum FilePurpose {
    ReadFile,
    CaptureSource,
    CaptureTarget,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterFileParams {
    pub path: String,
    pub purpose: FilePurpose,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileMetadataParams {
    pub file_ref: ObjectRef,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileMetadata {
    pub file_ref: ObjectRef,
    pub purpose: FilePurpose,
    pub length: U64,
    pub fingerprint: Digest,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReplayMode {
    OriginalTiming,
    #[default]
    Fastest,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayOpenParams {
    pub capture_ref: ObjectRef,
    #[serde(default)]
    pub mode: ReplayMode,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayControlParams {
    pub session_id: Id,
    pub session_epoch: U64,
    pub paused: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64,optional)]
    pub seek_record: Option<U64>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayReadParams {
    pub session_id: Id,
    pub session_epoch: U64,
    pub max_records: U64,
    pub max_bytes: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayReadResult {
    pub records: Vec<ReplayRecord>,
    pub reader_generation: U64,
    pub next_record: U64,
    pub at_end: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReplayRecord {
    Inline {
        record: CaptureRecord,
    },
    #[serde(rename_all = "camelCase")]
    Reference {
        record_ref: ObjectRef,
        record_ordinal: U64,
        json_bytes: U64,
        json_sha256: Digest,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReadParams {
    pub file_ref: ObjectRef,
    pub offset: U64,
    pub max_bytes: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileReadResult {
    pub file_ref: ObjectRef,
    pub offset: U64,
    pub next_offset: U64,
    pub total_bytes: U64,
    pub bytes_base64: Bytes,
    pub fingerprint: Digest,
    pub at_end: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextExportParams {
    pub capture_ref: ObjectRef,
    pub target_ref: ObjectRef,
}
