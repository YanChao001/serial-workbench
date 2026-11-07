use crate::{Id, JsonObject, RevealTarget, identity::non_null_option};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
pub type HostResult<T> = Result<T, HostError>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "JsonObject")]
    #[specta(type=JsonObject, optional)]
    pub details: Option<Box<JsonObject>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "Id")]
    #[specta(type=Id, optional)]
    pub operation_id: Option<Id>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "RevealTarget")]
    #[specta(type=RevealTarget, optional)]
    pub reveal_target: Option<Box<RevealTarget>>,
}
impl HostError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            details: None,
            operation_id: None,
            reveal_target: None,
        }
    }
}
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for HostError {}
