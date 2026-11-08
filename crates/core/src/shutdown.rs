//! Host settlement barriers; completion is separate from process termination.
use crate::{HostError, Id, ObjectRef, Target};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ShutdownMode {
    Settle,
    CancelAndSettle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownReport {
    pub mode: ShutdownMode,
    pub completed: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub excluded_operation_id: Option<Id>,
    pub unsettled_operation_ids: Vec<Id>,
    pub quarantined_sessions: Vec<Target>,
    pub evidence_refs: Vec<ObjectRef>,
    pub failures: Vec<HostError>,
}
