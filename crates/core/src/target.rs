use crate::*;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use std::borrow::Cow;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(transparent)]
pub struct ResourceKind(String);
impl ResourceKind {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl TryFrom<&str> for ResourceKind {
    type Error = HostError;
    fn try_from(value: &str) -> HostResult<Self> {
        let builtin = [
            "host",
            "device",
            "session",
            "operation",
            "workspace",
            "settings",
            "capture",
            "file",
            "plugin",
            "client",
        ]
        .contains(&value);
        let plugin = value.split_once(':').is_some_and(|(a, b)| {
            !a.is_empty()
                && !b.is_empty()
                && a.bytes()
                    .chain(b.bytes())
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        });
        if builtin || plugin {
            Ok(Self(value.into()))
        } else {
            Err(HostError::new("INVALID_ARGUMENT", "Invalid resource kind"))
        }
    }
}
impl<'de> Deserialize<'de> for ResourceKind {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::try_from(String::deserialize(d)?.as_str()).map_err(serde::de::Error::custom)
    }
}
impl JsonSchema for ResourceKind {
    fn schema_name() -> Cow<'static, str> {
        "ResourceKind".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({"type":"string","pattern":"^(?:host|device|session|operation|workspace|settings|capture|file|plugin|client|[A-Za-z0-9._-]+:[A-Za-z0-9._-]+)$"})
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub host_id: Id,
    pub kind: ResourceKind,
    pub id: Id,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type=Id,optional)]
    pub session_id: Option<Id>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type=U64,optional)]
    pub session_epoch: Option<U64>,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetFields {
    host_id: Id,
    kind: ResourceKind,
    id: Id,
    #[serde(default, deserialize_with = "crate::identity::non_null_option")]
    #[schemars(with = "Id")]
    session_id: Option<Id>,
    #[serde(default, deserialize_with = "crate::identity::non_null_option")]
    #[schemars(with = "U64")]
    session_epoch: Option<U64>,
}
impl<'de> Deserialize<'de> for Target {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = TargetFields::deserialize(d)?;
        if v.session_id.is_some() != v.session_epoch.is_some()
            || v.kind.as_str() == "session" && v.session_id.is_none()
        {
            return Err(serde::de::Error::custom(
                "Session identity requires id and epoch",
            ));
        }
        Ok(Self {
            host_id: v.host_id,
            kind: v.kind,
            id: v.id,
            session_id: v.session_id,
            session_epoch: v.session_epoch,
        })
    }
}
impl Target {
    /// 身份等值属于领域校验；dispatcher 在授权与寻址前调用。
    pub fn validate(&self) -> HostResult<()> {
        if self.kind.as_str() == "session" && self.session_id.as_ref() != Some(&self.id)
            || self.kind.as_str() == "host" && self.id != self.host_id
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Target identity mismatch",
            ));
        }
        Ok(())
    }
}
impl JsonSchema for Target {
    fn schema_name() -> Cow<'static, str> {
        "Target".into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut s = TargetFields::json_schema(generator);
        s.insert(
            if generator
                .settings()
                .meta_schema
                .as_deref()
                .is_some_and(|uri| uri.contains("2020-12"))
            {
                "dependentRequired"
            } else {
                "dependencies"
            }
            .into(),
            serde_json::json!({"sessionId":["sessionEpoch"],"sessionEpoch":["sessionId"]}),
        );
        s.insert(
            "if".into(),
            serde_json::json!({"properties":{"kind":{"const":"session"}},"required":["kind"]}),
        );
        s.insert(
            "then".into(),
            serde_json::json!({"required":["sessionId","sessionEpoch"]}),
        );
        s
    }
}
