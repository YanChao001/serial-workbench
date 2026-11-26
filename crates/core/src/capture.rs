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
    Redacted(Box<CaptureRedactedRecord>),
    TxSettlement(Box<CaptureTxSettlement>),
    ReaderGap(Box<ReaderGap>),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRedactedRecord {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub session_id: Id,
    pub session_epoch: U64,
    pub event_start: U64,
    pub event_end: U64,
    pub timestamp: Timestamp,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "DirectionalRange")]
    #[specta(type = DirectionalRange, optional)]
    pub byte_range: Option<DirectionalRange>,
    pub result: CaptureRedactedResult,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CaptureRedactedResult {
    Text { text: String, replacements: U64 },
    Omitted { reason: CaptureRedactionOmission },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum CaptureRedactionOmission {
    Boundary,
    InvalidText,
    LineTooLong,
    Incomplete,
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
impl CaptureMode {
    pub(crate) fn is_raw(&self) -> bool {
        *self == Self::Raw
    }
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
    #[serde(default, skip_serializing_if = "CaptureMode::is_raw")]
    #[specta(optional)]
    pub mode: CaptureMode,
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
pub struct CaptureStorageLimits {
    pub capacity_bytes: PositiveU64,
    pub reserve_bytes: U64,
}
impl Default for CaptureStorageLimits {
    fn default() -> Self {
        Self {
            capacity_bytes: PositiveU64::try_from(U64::from(1_073_741_824))
                .expect("positive default capture capacity"),
            reserve_bytes: 134_217_728.into(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRedactionRule {
    pub pattern: String,
    pub replacement: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRedactionPreviewParams {
    pub rules: Vec<CaptureRedactionRule>,
    pub sample: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRedactionPreviewResult {
    pub text: String,
    pub replacements: U64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureStartParams {
    pub session_refs: Vec<Target>,
    pub target_ref: ObjectRef,
    #[serde(default)]
    pub mode: CaptureMode,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Vec<CaptureRedactionRule>")]
    #[specta(type = Vec<CaptureRedactionRule>, optional)]
    pub redaction_rules: Option<Vec<CaptureRedactionRule>>,
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "CaptureStorageLimits")]
    #[specta(type=CaptureStorageLimits,optional)]
    pub storage_limits: Option<CaptureStorageLimits>,
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
    #[serde(default, skip_serializing_if = "CaptureMode::is_raw")]
    #[specta(optional)]
    pub mode: CaptureMode,
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReplayRate {
    Fastest,
    #[serde(rename_all = "camelCase")]
    Timed {
        #[schemars(range(min = 25, max = 400))]
        speed_percent: u16,
    },
}
impl From<ReplayMode> for ReplayRate {
    fn from(mode: ReplayMode) -> Self {
        match mode {
            ReplayMode::Fastest => Self::Fastest,
            ReplayMode::OriginalTiming => Self::Timed { speed_percent: 100 },
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReplayPlaybackControl {
    SetRate {
        rate: ReplayRate,
    },
    SetBreakpoint {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::identity::non_null_option"
        )]
        #[schemars(with = "U64")]
        #[specta(type=U64,optional)]
        record: Option<U64>,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayPlaybackState {
    pub rate: ReplayRate,
    pub paused: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64,optional)]
    pub breakpoint_record: Option<U64>,
    pub breakpoint_hit: bool,
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ReplayPlaybackControl")]
    #[specta(type=ReplayPlaybackControl,optional)]
    pub playback: Option<ReplayPlaybackControl>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayReadParams {
    pub session_id: Id,
    pub session_epoch: U64,
    pub max_records: U64,
    pub max_bytes: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "bool")]
    #[specta(type=bool,optional)]
    pub single_step: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "bool")]
    #[specta(type=bool,optional)]
    pub inspect_playback: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "bool")]
    #[specta(type=bool,optional)]
    pub report_playback: Option<bool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayReadResult {
    #[serde(default, skip_serializing_if = "CaptureMode::is_raw")]
    #[specta(optional)]
    pub mode: CaptureMode,
    pub records: Vec<ReplayRecord>,
    pub reader_generation: U64,
    pub next_record: U64,
    pub at_end: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "ReplayPlaybackState")]
    #[specta(type=ReplayPlaybackState,optional)]
    pub playback: Option<ReplayPlaybackState>,
}
pub const REPLAY_SEARCH_MAX_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaySearchParams {
    pub session_id: Id,
    pub session_epoch: U64,
    pub command: ReplaySearchCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReplaySearchCommand {
    Start {
        search_id: RequestId,
        #[serde(deserialize_with = "replay_search_bytes")]
        #[schemars(schema_with = "replay_search_bytes_schema")]
        #[specta(type = Bytes)]
        bytes_base64: Bytes,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::identity::non_null_option"
        )]
        #[schemars(with = "Direction")]
        #[specta(type = Direction, optional)]
        direction: Option<Direction>,
    },
    Next {
        search_id: RequestId,
        page: PositiveU64,
    },
    Stop {
        search_id: RequestId,
    },
}

fn replay_search_bytes<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Bytes, D::Error> {
    let value = Bytes::deserialize(deserializer)?;
    let text = value.as_str();
    let decoded = text.len() / 4 * 3 - text.bytes().rev().take_while(|byte| *byte == b'=').count();
    if !(1..=REPLAY_SEARCH_MAX_BYTES).contains(&decoded) {
        return Err(serde::de::Error::custom(format!(
            "Replay search needs 1 to {REPLAY_SEARCH_MAX_BYTES} decoded bytes",
        )));
    }
    Ok(value)
}

fn replay_search_bytes_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    let complete = REPLAY_SEARCH_MAX_BYTES / 3 * 4;
    let maximum = REPLAY_SEARCH_MAX_BYTES.div_ceil(3) * 4;
    schemars::json_schema!({"allOf":[generator.subschema_for::<Bytes>(),{
        "type":"string","minLength":4,"maxLength":maximum,
        "anyOf":[{"maxLength":complete},{"pattern":"==$"}]
    }]})
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaySearchHit {
    pub direction: Direction,
    pub first_record: U64,
    pub last_record: U64,
    pub byte_start: U64,
    pub byte_end: U64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplaySearchPage {
    pub hits: Vec<ReplaySearchHit>,
    pub scanned_records: U64,
    pub total_records: U64,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ReplaySearchResult {
    Page {
        search_id: RequestId,
        page: PositiveU64,
        result: ReplaySearchPage,
    },
    Stopped {
        search_id: RequestId,
        stopped: bool,
    },
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "TextExportFormat")]
    #[specta(type = TextExportFormat, optional)]
    pub format: Option<TextExportFormat>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum TextExportFormat {
    #[default]
    Jsonl,
    Csv,
}
