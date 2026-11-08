use crate::{DeviceBinding, Id, ObjectRef, TerminalMode, U64};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutTemplate {
    pub sidebar_width: u32,
    pub panel_height: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceView {
    pub id: Id,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub pinned: bool,
    pub receive_mode: TerminalMode,
    pub send_mode: TerminalMode,
    pub binding_id: Id,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDocument {
    pub name: String,
    pub views: Vec<WorkspaceView>,
    pub bindings: Vec<DeviceBinding>,
    pub favorite_binding_ids: Vec<Id>,
    pub layout: LayoutTemplate,
    pub captures: Vec<ObjectRef>,
}
impl Default for WorkspaceDocument {
    fn default() -> Self {
        Self {
            name: "Workspace".into(),
            views: Vec::new(),
            bindings: Vec::new(),
            favorite_binding_ids: Vec::new(),
            layout: LayoutTemplate {
                sidebar_width: 224,
                panel_height: 240,
            },
            captures: Vec::new(),
        }
    }
}
impl WorkspaceDocument {
    pub fn validate(&self) -> crate::HostResult<()> {
        use std::collections::HashSet;
        let invalid = || crate::HostError::new("INVALID_ARGUMENT", "Invalid workspace references");
        let mut bindings = HashSet::new();
        for binding in &self.bindings {
            binding.validate()?;
            if !bindings.insert(&binding.binding_id) {
                return Err(invalid());
            }
        }
        let mut views = HashSet::new();
        for view in &self.views {
            if !views.insert(&view.id) || !bindings.contains(&view.binding_id) {
                return Err(invalid());
            }
        }
        let mut favorites = HashSet::new();
        for favorite in &self.favorite_binding_ids {
            if !favorites.insert(favorite) || !bindings.contains(favorite) {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub revision: U64,
    pub value: WorkspaceDocument,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSaveParams {
    pub value: WorkspaceDocument,
}
