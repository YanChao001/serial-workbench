use crate::{Id, RequestId, U64};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScriptDebugCommand {
    Continue { revision: U64 },
    StepOver { revision: U64 },
    StepInto { revision: U64 },
    StepOut { revision: U64 },
    InspectFrame { revision: U64, frame: u8 },
}

impl ScriptDebugCommand {
    pub fn revision(&self) -> U64 {
        match self {
            Self::Continue { revision }
            | Self::StepOver { revision }
            | Self::StepInto { revision }
            | Self::StepOut { revision }
            | Self::InspectFrame { revision, .. } => *revision,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptDebugFrame {
    pub name: String,
    pub line: u32,
    pub column: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "lowercase")]
pub enum ScriptDebugValueType {
    Unavailable,
    String,
    Number,
    Boolean,
    Bigint,
    Null,
    Undefined,
    Object,
    Function,
    Symbol,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptDebugVariable {
    pub name: String,
    #[serde(rename = "type")]
    pub value_type: ScriptDebugValueType,
    pub preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScriptDebugSnapshot {
    Starting {
        revision: U64,
    },
    Running {
        revision: U64,
    },
    Paused {
        revision: U64,
        frames: Vec<ScriptDebugFrame>,
        selected_frame: u8,
        variables: Vec<ScriptDebugVariable>,
    },
}

impl ScriptDebugSnapshot {
    pub fn revision(&self) -> U64 {
        match self {
            Self::Starting { revision }
            | Self::Running { revision }
            | Self::Paused { revision, .. } => *revision,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptDebugRequest {
    pub request_id: RequestId,
    pub client_id: Id,
    pub actor_id: Id,
    pub operation_id: Id,
    pub intent: ScriptDebugIntent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ScriptDebugIntent {
    Inspect,
    Command { command: ScriptDebugCommand },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptDebugResponse {
    pub script_debug: ScriptDebugResult,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ScriptDebugResult {
    Snapshot { snapshot: ScriptDebugSnapshot },
    Accepted,
}
