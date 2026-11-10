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
            // 空名表示尚未命名，客户端只本地化显示，不改写用户名称。
            name: String::new(),
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

#[cfg(test)]
mod tests {
    use super::WorkspaceDocument;

    #[test]
    fn unnamed_workspace_is_valid_and_round_trips_without_a_display_name() {
        let workspace = WorkspaceDocument::default();
        assert!(workspace.name.is_empty());
        workspace.validate().unwrap();
        let encoded = serde_json::to_vec(&workspace).unwrap();
        assert_eq!(
            serde_json::from_slice::<WorkspaceDocument>(&encoded).unwrap(),
            workspace
        );
    }

    #[test]
    fn a_literal_workspace_name_is_preserved() {
        let workspace = WorkspaceDocument {
            name: "Workspace".into(),
            ..WorkspaceDocument::default()
        };
        let encoded = serde_json::to_vec(&workspace).unwrap();
        assert_eq!(
            serde_json::from_slice::<WorkspaceDocument>(&encoded)
                .unwrap()
                .name,
            "Workspace"
        );
    }
}
