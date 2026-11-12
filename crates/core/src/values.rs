use crate::*;
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use specta::Type;
use std::{borrow::Cow, collections::BTreeMap};

pub type JsonObject = BTreeMap<String, JsonValue>;
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema, Type)]
#[serde(untagged)]
pub enum JsonValue {
    Null(()),
    Bool(bool),
    Number(SafeInteger),
    String(String),
    Array(Vec<JsonValue>),
    Object(JsonObject),
}

/// schema 元数据可使用小数约束；业务 params 继续使用仅安全整数的 JsonValue。
pub type SchemaObject = BTreeMap<String, SchemaValue>;
#[derive(Debug, Clone, PartialEq, Serialize, JsonSchema, Type)]
#[serde(untagged)]
pub enum SchemaValue {
    Null(()),
    Bool(bool),
    Number(
        #[schemars(schema_with = "schema_number")]
        #[specta(type=specta_typescript::Number)]
        serde_json::Number,
    ),
    String(String),
    Array(Vec<SchemaValue>),
    Object(SchemaObject),
}

// 递归 untagged 派生会为每个节点反复缓存和尝试其它类型；大投影与目录因此阻塞 RPC。
// JSON 已提供节点类型，直接分派一次；数字仍交给各自原有的校验器，wire/schema 不变。
macro_rules! deserialize_json_value {
    ($name:ident, $number:ty) => {
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                struct ValueVisitor;
                impl<'de> serde::de::Visitor<'de> for ValueVisitor {
                    type Value = $name;
                    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                        formatter.write_str("a JSON value")
                    }
                    fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                        Ok($name::Null(()))
                    }
                    fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                        Ok($name::Null(()))
                    }
                    fn visit_bool<E: serde::de::Error>(
                        self,
                        value: bool,
                    ) -> Result<Self::Value, E> {
                        Ok($name::Bool(value))
                    }
                    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                        <$number>::deserialize(serde::de::value::I64Deserializer::<E>::new(value))
                            .map($name::Number)
                    }
                    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                        <$number>::deserialize(serde::de::value::U64Deserializer::<E>::new(value))
                            .map($name::Number)
                    }
                    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                        <$number>::deserialize(serde::de::value::F64Deserializer::<E>::new(value))
                            .map($name::Number)
                    }
                    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                        Ok($name::String(value.to_owned()))
                    }
                    fn visit_string<E: serde::de::Error>(
                        self,
                        value: String,
                    ) -> Result<Self::Value, E> {
                        Ok($name::String(value))
                    }
                    fn visit_seq<A: serde::de::SeqAccess<'de>>(
                        self,
                        mut source: A,
                    ) -> Result<Self::Value, A::Error> {
                        let mut values = Vec::new();
                        while let Some(value) = source.next_element::<$name>()? {
                            values.push(value);
                        }
                        Ok($name::Array(values))
                    }
                    fn visit_map<A: serde::de::MapAccess<'de>>(
                        self,
                        mut source: A,
                    ) -> Result<Self::Value, A::Error> {
                        let mut values = BTreeMap::new();
                        while let Some((key, value)) = source.next_entry::<String, $name>()? {
                            values.insert(key, value);
                        }
                        Ok($name::Object(values))
                    }
                }
                deserializer.deserialize_any(ValueVisitor)
            }
        }
    };
}
deserialize_json_value!(JsonValue, SafeInteger);
deserialize_json_value!(SchemaValue, serde_json::Number);

fn schema_number(_: &mut SchemaGenerator) -> Schema {
    schemars::json_schema!({"type":"number"})
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(transparent)]
pub struct SafeInteger(#[specta(type=specta_typescript::Number)] i64);
impl<'de> Deserialize<'de> for SafeInteger {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let number = serde_json::Number::deserialize(d)?;
        let v = number
            .as_f64()
            .ok_or_else(|| serde::de::Error::custom("Expected number"))?;
        if !v.is_finite() || v.fract() != 0.0 || v.abs() > 9_007_199_254_740_991.0 {
            return Err(serde::de::Error::custom("Expected safe integer"));
        }
        Ok(Self(v as i64))
    }
}
impl JsonSchema for SafeInteger {
    fn schema_name() -> Cow<'static, str> {
        "SafeInteger".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({"type":"integer","minimum":-9007199254740991i64,"maximum":9007199254740991i64})
    }
}
macro_rules! literal_bool {
    ($name:ident,$value:literal) => {
        #[derive(Debug,Clone,Copy,PartialEq,Eq,Default)] pub struct $name;
        impl Serialize for $name { fn serialize<S:Serializer>(&self,s:S)->Result<S::Ok,S::Error>{s.serialize_bool($value)} }
        impl<'de> Deserialize<'de> for $name {fn deserialize<D:Deserializer<'de>>(d:D)->Result<Self,D::Error>{if bool::deserialize(d)?==$value{Ok(Self)}else{Err(serde::de::Error::custom("Wrong boolean literal"))}}}
        impl JsonSchema for $name { fn schema_name()->Cow<'static,str>{stringify!($name).into()} fn json_schema(_: &mut SchemaGenerator)->Schema{schemars::json_schema!({"type":"boolean","const":$value})} }
        impl Type for $name { fn definition(_: &mut specta::Types)->specta::datatype::DataType {specta::datatype::DataType::Reference(specta_typescript::define($value.to_string()))} }
    }
}
literal_bool!(True, true);
literal_bool!(False, false);
macro_rules! bounded_counter {
    ($name:ident,$min:literal,$max:expr) => {
        #[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Type)]
        #[serde(transparent)] pub struct $name(U64);
        impl $name { pub fn get(self)->u64{self.0.get()} }
        impl TryFrom<U64> for $name {type Error=HostError; fn try_from(value:U64)->HostResult<Self>{if ($min..=$max).contains(&value.get()){Ok(Self(value))}else{Err(HostError::new("INVALID_ARGUMENT",concat!("Invalid ",stringify!($name))))}}}
        impl<'de> Deserialize<'de> for $name { fn deserialize<D:Deserializer<'de>>(d:D)->Result<Self,D::Error>{Self::try_from(U64::deserialize(d)?).map_err(serde::de::Error::custom)} }
        impl JsonSchema for $name {fn schema_name()->Cow<'static,str>{stringify!($name).into()} fn json_schema(_: &mut SchemaGenerator)->Schema {schemars::json_schema!({"type":"string","pattern":crate::identity::decimal_pattern($max,0),"not":{"pattern":crate::identity::decimal_pattern($min-1,0)}})} }
    }
}
bounded_counter!(PositiveU64, 1, u64::MAX);
bounded_counter!(DurationMs, 1, 2147483647);
bounded_counter!(RetentionMs, 604800000, u64::MAX);
