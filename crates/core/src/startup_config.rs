//! 启动配置的公开投影；私有目录只保留固定引用。
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "lowercase")]
pub enum StartupConfigSource {
    Argument,
    Environment,
    Default,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "lowercase")]
pub enum StartupLogLevel {
    Off,
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
pub enum StartupProfileReference {
    #[serde(rename = "host:profile")]
    HostProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupConfigSnapshot {
    pub profile_reference: StartupProfileReference,
    pub profile_source: StartupConfigSource,
    pub log_level: StartupLogLevel,
    pub log_level_source: StartupConfigSource,
}
