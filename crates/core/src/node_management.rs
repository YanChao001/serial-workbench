//! 插件管理的公共快照；启用意图与历史执行确认不代表后台已经激活。
use crate::{
    Bytes, Digest, Id, NodePackageId, NodePackageManifest, NodePackagePath, NodePackagePermissions,
    NodePackageVersion, NodePackageView, ObjectRef, Target, U64,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

pub const NODE_VIEW_ASSET_CHUNK_BYTES: usize = 32768;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeThemeReference {
    pub package_id: NodePackageId,
    pub theme_id: Id,
    pub archive_sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeThemeTokens {
    #[serde(deserialize_with = "crate::settings::accent_color")]
    #[schemars(regex(pattern = "^#[0-9A-Fa-f]{6}$"))]
    #[specta(type = String)]
    pub accent: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeThemeEntry {
    pub package_id: NodePackageId,
    pub theme_id: Id,
    pub archive_sha256: Digest,
    pub display_name: String,
    #[serde(deserialize_with = "crate::settings::accent_color")]
    #[schemars(regex(pattern = "^#[0-9A-Fa-f]{6}$"))]
    #[specta(type = String)]
    pub accent: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeThemesResult {
    pub themes: Vec<NodeThemeEntry>,
}

/// 此查询的 operation 目标引用已完成的视图打开动作。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeViewAssetReadParams {
    pub view_id: Id,
    pub offset: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "NodePackagePath")]
    #[specta(type = NodePackagePath, optional)]
    pub path: Option<NodePackagePath>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeViewAssetReadResult {
    pub package_id: NodePackageId,
    pub version: NodePackageVersion,
    pub archive_sha256: Digest,
    pub activation_id: Id,
    pub view: NodePackageView,
    pub target: Target,
    pub entry: NodePackagePath,
    pub path: NodePackagePath,
    pub offset: U64,
    pub total_bytes: U64,
    pub sha256: Digest,
    pub bytes_base64: Bytes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VerifiedNodePackageSource {
    pub source: Id,
    pub key_id: Id,
    pub public_key_sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeExecutionTrust {
    pub archive_sha256: Digest,
    pub permissions: NodePackagePermissions,
    pub verified_source: Option<VerifiedNodePackageSource>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageInstallation {
    pub manifest: NodePackageManifest,
    pub archive_sha256: Digest,
    pub verified_source: Option<VerifiedNodePackageSource>,
    pub enabled: bool,
    pub execution_trust: Option<NodeExecutionTrust>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageSummary {
    pub id: NodePackageId,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type = String, optional)]
    pub display_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type = String, optional)]
    pub version: Option<String>,
    pub archive_sha256: Digest,
    pub enabled: bool,
    pub source_verified: bool,
    pub execution_approved: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageListParams {
    #[serde(default = "package_page_size")]
    pub page_size: U64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[specta(optional)]
    pub parser_only: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "NodePackageId")]
    #[specta(type=NodePackageId, optional)]
    pub after: Option<NodePackageId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub expected_revision: Option<U64>,
}
fn package_page_size() -> U64 {
    20.into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageListResult {
    pub revision: U64,
    pub packages: Vec<NodePackageSummary>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "NodePackageId")]
    #[specta(type=NodePackageId, optional)]
    pub next_after: Option<NodePackageId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageDetailsReadParams {
    pub id: NodePackageId,
    pub expected_revision: U64,
    pub archive_sha256: Digest,
    pub offset: U64,
    pub length: U64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageDetailsReadResult {
    pub revision: U64,
    pub id: NodePackageId,
    pub archive_sha256: Digest,
    pub json_sha256: Digest,
    pub offset: U64,
    pub total_bytes: U64,
    pub bytes_base64: Bytes,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NodePackageInstallSource {
    Local,
    Trusted { source: Id, key_id: Id },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageInstallParams {
    pub archive_ref: ObjectRef,
    pub source: NodePackageInstallSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageChangeResult {
    pub revision: U64,
    pub package: NodePackageSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageIdentityParams {
    pub id: NodePackageId,
    pub archive_sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageUninstallResult {
    pub revision: U64,
    pub id: NodePackageId,
    pub archive_sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageSetEnabledParams {
    pub id: NodePackageId,
    pub archive_sha256: Digest,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageRuntimeParams {
    pub id: NodePackageId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum NodePackageRuntimePhase {
    Inactive,
    Starting,
    Active,
    Stopping,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageRuntimeStatus {
    pub id: NodePackageId,
    pub phase: NodePackageRuntimePhase,
    pub generation: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Digest")]
    #[specta(type=Digest, optional)]
    pub archive_sha256: Option<Digest>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "crate::HostError")]
    #[specta(type=crate::HostError, optional)]
    pub error: Option<crate::HostError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodePackageSourceKey {
    pub source: Id,
    pub key_id: Id,
    pub public_key: [u8; 32],
    pub public_key_sha256: Digest,
    pub approved: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSourceListParams {
    #[serde(default = "package_page_size")]
    pub page_size: U64,
    #[serde(default = "source_list_offset")]
    pub offset: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    pub expected_revision: Option<U64>,
}
fn source_list_offset() -> U64 {
    0.into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSourceListResult {
    pub revision: U64,
    pub keys: Vec<NodePackageSourceKey>,
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
pub struct NodeSourceApproveParams {
    pub source: Id,
    pub key_id: Id,
    pub public_key: [u8; 32],
    pub public_key_sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSourceRevokeParams {
    pub source: Id,
    pub key_id: Id,
    pub public_key_sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSourceChangeResult {
    pub revision: U64,
    pub key: NodePackageSourceKey,
}
