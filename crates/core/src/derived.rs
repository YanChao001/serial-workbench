use crate::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid derived stream range or budget")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRange {
    pub host_id: Id,
    pub session_id: Id,
    pub session_epoch: U64,
    pub event_start: U64,
    pub event_end: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type = U64, optional)]
    pub byte_start: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type = U64, optional)]
    pub byte_end: Option<U64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "Direction")]
    #[specta(type = Direction, optional)]
    pub direction: Option<Direction>,
}

impl SourceRange {
    fn validate(&self) -> HostResult<u64> {
        if self.event_start.get() == 0 || self.event_end <= self.event_start {
            return Err(invalid());
        }
        match (self.byte_start, self.byte_end) {
            (None, None) => {}
            (Some(start), Some(end)) if start < end && self.direction.is_some() => {}
            _ => return Err(invalid()),
        }
        Ok(self.event_end.get() - self.event_start.get())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "snake_case")]
pub enum DerivedQuality {
    Complete,
    Gap,
    Partial,
    Unknown,
    Transformed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedPublishParams {
    #[schemars(length(min = 1, max = 8))]
    pub sources: Vec<SourceRange>,
    #[schemars(length(min = 1, max = 5))]
    pub quality: Vec<DerivedQuality>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String", length(min = 1, max = 64))]
    #[specta(type = String, optional)]
    pub unit: Option<String>,
    pub value: QueryValue,
}

impl DerivedPublishParams {
    pub fn validate(&self) -> HostResult<()> {
        if !(1..=8).contains(&self.sources.len())
            || !(1..=5).contains(&self.quality.len())
            || self
                .unit
                .as_ref()
                .is_some_and(|unit| !(1..=64).contains(&unit.chars().count()))
            || self
                .quality
                .iter()
                .enumerate()
                .any(|(index, quality)| self.quality[..index].contains(quality))
            || (self.quality.contains(&DerivedQuality::Complete)
                && self.quality.iter().any(|quality| {
                    matches!(
                        quality,
                        DerivedQuality::Gap | DerivedQuality::Partial | DerivedQuality::Unknown
                    )
                }))
        {
            return Err(invalid());
        }
        let mut events = 0;
        for source in &self.sources {
            events += source.validate()?.min(101);
            if events > 100 {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedProvenance {
    pub sources: Vec<SourceRange>,
    pub parser_id: Id,
    pub parser_version: String,
    pub configuration_digest: Digest,
    pub quality: Vec<DerivedQuality>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "String")]
    #[specta(type = String, optional)]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedSample {
    pub position: U64,
    pub provenance: DerivedProvenance,
    pub value: QueryValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedPublishResult {
    pub operation_id: Id,
    pub position: U64,
}

pub const DERIVED_PAGE_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedReadParams {
    pub operation_id: Id,
    pub after: U64,
    pub max_samples: U64,
    pub max_bytes: U64,
}

impl DerivedReadParams {
    pub fn validate(&self) -> HostResult<()> {
        if !(1..=64).contains(&self.max_samples.get())
            || !(1..=DERIVED_PAGE_MAX_BYTES as u64).contains(&self.max_bytes.get())
        {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedReadResult {
    pub operation_id: Id,
    pub instance_epoch: U64,
    pub samples: Vec<DerivedSample>,
    pub next_position: U64,
    pub has_more: bool,
}
