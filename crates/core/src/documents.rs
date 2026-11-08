//! 共享文档回执携带权威投影路由，文档 CAS revision 与投影序列分别维护。
use crate::{Id, SettingsSnapshot, Target, WorkspaceSnapshot};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateScopeRef {
    pub scope_id: Id,
    pub target: Target,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateScopesResult {
    pub scopes: Vec<StateScopeRef>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsDocumentResult {
    pub document: SettingsSnapshot,
    pub scope: StateScopeRef,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDocumentResult {
    pub document: WorkspaceSnapshot,
    pub scope: StateScopeRef,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentImportParams {
    pub json: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentJsonResult {
    pub json: String,
}
