use crate::{
    DurationMs, Id, PositiveU64, SerialConfiguration, TransportCapabilities, U64,
    identity::non_null_option,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub enum DeviceTransportKind {
    Serial,
    Pty,
    Virtual,
    Replay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub enum IdentityEvidence {
    SerialNumber,
    Topology,
    Unreliable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceFingerprint {
    pub transport: DeviceTransportKind,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "u16")]
    #[specta(type = u16, optional)]
    pub vid: Option<u16>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "u16")]
    #[specta(type = u16, optional)]
    pub pid: Option<u16>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type = String, optional)]
    pub serial_number: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type = String, optional)]
    pub topology_path: Option<String>,
    pub evidence: IdentityEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceDescriptor {
    pub device_id: Id,
    pub host_id: Id,
    pub system_name: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type = String, optional)]
    pub description: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type = String, optional)]
    pub manufacturer: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type = String, optional)]
    pub driver: Option<String>,
    pub fingerprint: DeviceFingerprint,
    pub capabilities: TransportCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceList {
    pub devices: Vec<DeviceDescriptor>,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconnectPolicy {
    pub enabled: bool,
    pub max_delay_ms: DurationMs,
    pub max_attempts: PositiveU64,
}
impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            max_delay_ms: DurationMs::try_from(U64::from(30_000)).expect("valid default"),
            max_attempts: PositiveU64::try_from(U64::from(10)).expect("valid default"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceBinding {
    pub binding_id: Id,
    pub host_id: Id,
    pub device_id: Id,
    pub fingerprint: DeviceFingerprint,
    pub configuration: SerialConfiguration,
    pub reconnect: ReconnectPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentConnection {
    pub device_id: Id,
    pub fingerprint: DeviceFingerprint,
    pub configuration: SerialConfiguration,
    pub opened_at: crate::Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentList {
    pub revision: U64,
    pub entries: Vec<RecentConnection>,
}

impl DeviceBinding {
    pub fn validate(&self) -> crate::HostResult<()> {
        if self.reconnect.enabled
            && self.reconnect.max_delay_ms.get() < self.configuration.reconnect_backoff_ms.get()
        {
            return Err(crate::HostError::new(
                "INVALID_ARGUMENT",
                "Reconnect maximum delay is shorter than the initial delay",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceBindingReference {
    pub workspace_id: Id,
    pub binding_id: Id,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReconnectState {
    Idle,
    Waiting,
    Attempting,
    RequiresRebind,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReconnectStatus {
    pub state: ReconnectState,
    pub attempts: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_option"
    )]
    #[schemars(with = "crate::HostError")]
    #[specta(type=crate::HostError, optional)]
    pub last_error: Option<crate::HostError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RebindParams {
    pub binding_id: Id,
    pub device_id: Id,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FavoritesSaveParams {
    pub binding_ids: Vec<Id>,
}
