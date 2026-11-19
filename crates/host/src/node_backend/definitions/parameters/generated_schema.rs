//! 生成schema先计费，再构造Value；scope定义按增量计数后移动，避免整图再复制。
use super::{
    Work, schema_error,
    validator_cache::{self, Reservation},
};
use serde::{Serialize, Serializer, ser::SerializeMap};
use serde_json::{Map, Value};
use serial_workbench_core::HostResult;

const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";
struct Property<'a, T> {
    key: &'a str,
    value: T,
}
impl<T: Serialize> Serialize for Property<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        map.serialize_entry(self.key, &self.value)?;
        map.end()
    }
}
#[derive(Serialize)]
struct Anchor<'a> {
    #[serde(rename = "$dynamicAnchor")]
    name: &'a str,
    #[serde(rename = "$ref")]
    reference: &'a str,
}
#[derive(Serialize)]
struct Wrapper<'a> {
    #[serde(rename = "$schema")]
    dialect: &'a str,
    #[serde(rename = "$ref")]
    reference: &'a str,
    #[serde(rename = "$defs")]
    definitions: &'a Map<String, Value>,
}
pub(super) struct Scope<'a> {
    reference: &'a str,
    definitions: Map<String, Value>,
    bytes: usize,
}
impl<'a> Scope<'a> {
    pub(super) fn new(
        reference: &'a str,
        reservation: &mut Reservation,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<Self> {
        let definitions = Map::new();
        let bytes = validator_cache::source_bytes(&Wrapper {
            dialect: DIALECT,
            reference,
            definitions: &definitions,
        })?;
        reservation.charge(bytes, work, depth, 4)?;
        Ok(Self {
            reference,
            definitions,
            bytes,
        })
    }
    pub(super) fn insert(
        &mut self,
        name: &str,
        reference: &str,
        reservation: &mut Reservation,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<()> {
        let schema = Anchor { name, reference };
        let bytes = validator_cache::source_bytes(name)?
            .checked_add(validator_cache::source_bytes(&schema)?)
            .and_then(|n| n.checked_add(1 + usize::from(!self.definitions.is_empty())))
            .ok_or_else(schema_error)?;
        let total = self.bytes.checked_add(bytes).ok_or_else(schema_error)?;
        if total > validator_cache::MAX_CACHE_BYTES {
            return Err(super::limit());
        }
        reservation.charge(bytes, work, depth, 3)?;
        self.definitions.insert(
            name.to_owned(),
            serde_json::to_value(&schema).map_err(|_| schema_error())?,
        );
        self.bytes = total;
        Ok(())
    }
    pub(super) fn finish(self) -> HostResult<Value> {
        let bytes = validator_cache::source_bytes(&Wrapper {
            dialect: DIALECT,
            reference: self.reference,
            definitions: &self.definitions,
        })?;
        if bytes != self.bytes {
            return Err(schema_error());
        }
        Ok(Value::Object(Map::from_iter([
            ("$schema".into(), Value::String(DIALECT.into())),
            ("$ref".into(), Value::String(self.reference.to_owned())),
            ("$defs".into(), Value::Object(self.definitions)),
        ])))
    }
}
pub(super) fn reference(
    reference: &str,
    reservation: &mut Reservation,
    work: &mut Work,
    depth: usize,
) -> HostResult<Value> {
    reservation.input(
        &Property {
            key: "$ref",
            value: reference,
        },
        work,
        depth,
    )
}
pub(super) fn pattern(
    pattern: &str,
    property: bool,
    reservation: &mut Reservation,
    work: &mut Work,
    depth: usize,
) -> HostResult<Value> {
    if property {
        reservation.input(
            &Property {
                key: "patternProperties",
                value: Property {
                    key: pattern,
                    value: false,
                },
            },
            work,
            depth,
        )
    } else {
        reservation.input(
            &Property {
                key: "pattern",
                value: pattern,
            },
            work,
            depth,
        )
    }
}
