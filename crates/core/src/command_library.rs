//! 按工作区归属的命令正文和有界目录读取契约。
use crate::{HostError, HostResult, Id, LineEnding, ObjectRef, TerminalMode, TextEncoding, U64};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandGroup {
    pub id: Id,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandSummary {
    pub id: Id,
    pub group_id: Id,
    pub name: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandDraft {
    pub summary: CommandSummary,
    pub body: String,
    pub mode: TerminalMode,
    pub encoding: TextEncoding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_ending: Option<LineEnding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "view",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandLibraryView {
    Groups {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<Id>,
    },
    Commands {
        group_id: Id,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after: Option<Id>,
    },
    Entry {
        id: Id,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandLibraryReadParams {
    pub selection: CommandLibraryView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<U64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "view",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandLibraryRecords {
    Groups {
        groups: Vec<CommandGroup>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_cursor: Option<Id>,
    },
    Commands {
        commands: Vec<CommandSummary>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next_cursor: Option<Id>,
    },
    Entry {
        command: CommandDraft,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandLibraryReadResult {
    pub revision: U64,
    pub records: CommandLibraryRecords,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CommandLibraryChange {
    SaveGroup {
        group: CommandGroup,
    },
    DeleteGroup {
        id: Id,
    },
    SaveCommand {
        command: CommandDraft,
    },
    MoveCommand {
        id: Id,
        group_id: Id,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before: Option<Id>,
    },
    DeleteCommand {
        id: Id,
    },
}

impl CommandLibraryChange {
    pub fn validate(&self) -> HostResult<()> {
        match self {
            Self::SaveGroup { group } => group.validate(),
            Self::SaveCommand { command } => command.validate(),
            _ => Ok(()),
        }
    }
}

impl CommandGroup {
    pub fn validate(&self) -> HostResult<()> {
        validate_name(&self.name)
    }
}

impl CommandDraft {
    pub fn validate(&self) -> HostResult<()> {
        validate_name(&self.summary.name)?;
        if self.summary.note.len() > 1024
            || self.body.len() > 65_536
            || matches!(&self.line_ending, Some(LineEnding::Custom { bytes_base64 }) if bytes_base64.as_str().len() > 1024)
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Command field exceeds its byte limit",
            ));
        }
        Ok(())
    }
}

fn validate_name(name: &str) -> HostResult<()> {
    if name.trim().is_empty() || name.len() > 192 || name.chars().any(char::is_control) {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "Invalid command library name",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandLibraryRevision {
    pub revision: U64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandLibraryFileParams {
    pub file_ref: ObjectRef,
}
