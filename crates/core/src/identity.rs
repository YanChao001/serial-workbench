use crate::{HostError, HostResult};
use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use specta::Type;
use std::{borrow::Cow, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Type)]
pub struct U64(#[specta(type = String)] u64);

impl U64 {
    pub const fn get(self) -> u64 {
        self.0
    }
    pub fn checked_next(&self) -> HostResult<Self> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or_else(|| HostError::new("COUNTER_EXHAUSTED", "Counter exhausted"))
    }
}
impl From<u64> for U64 {
    fn from(value: u64) -> Self {
        Self(value)
    }
}
impl TryFrom<&str> for U64 {
    type Error = HostError;
    fn try_from(value: &str) -> HostResult<Self> {
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Expected canonical U64 string",
            ));
        }
        value
            .parse()
            .map(Self)
            .map_err(|_| HostError::new("INVALID_ARGUMENT", "U64 out of range"))
    }
}
impl fmt::Display for U64 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}
impl Serialize for U64 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for U64 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Self::try_from(String::deserialize(d)?.as_str()).map_err(serde::de::Error::custom)
    }
}

/// 将上限编译成标准正则，Rust 与 draft-07 无需依赖 JS 数值精度。
pub fn decimal_pattern(max: u64, min: u64) -> String {
    let upper = max.to_string();
    let mut alternatives = vec![upper.clone()];
    for (index, digit) in upper.bytes().enumerate() {
        let low = if index == 0 { b'1' } else { b'0' };
        if digit > low {
            let prefix = &upper[..index];
            let remain = upper.len() - index - 1;
            alternatives.push(format!(
                "{prefix}[{}-{}][0-9]{{{remain}}}",
                low as char,
                (digit - 1) as char
            ));
        }
    }
    if upper.len() > 1 {
        alternatives.push(format!("[1-9][0-9]{{0,{}}}", upper.len() - 2));
    }
    if min == 0 {
        alternatives.push("0".into());
    }
    format!("^(?:{})$", alternatives.join("|"))
}
impl JsonSchema for U64 {
    fn schema_name() -> Cow<'static, str> {
        "U64".into()
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        schemars::json_schema!({"type":"string","pattern":decimal_pattern(u64::MAX,0)})
    }
}

macro_rules! text_value {
    ($name:ident, $pattern:expr, $validate:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Type)]
        #[serde(transparent)]
        pub struct $name(String);
        impl $name { pub fn as_str(&self) -> &str { &self.0 } }
        impl TryFrom<&str> for $name {
            type Error = HostError;
            fn try_from(value: &str) -> HostResult<Self> {
                if ($validate)(value) { Ok(Self(value.into())) } else { Err(HostError::new("INVALID_ARGUMENT", concat!("Invalid ",stringify!($name)))) }
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self,D::Error> { Self::try_from(String::deserialize(d)?.as_str()).map_err(serde::de::Error::custom) }
        }
        impl JsonSchema for $name {
            fn schema_name() -> Cow<'static,str> { stringify!($name).into() }
            fn json_schema(_: &mut SchemaGenerator) -> Schema { schemars::json_schema!({"type":"string","pattern":$pattern}) }
        }
        impl fmt::Display for $name { fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result { self.0.fmt(f) } }
    }
}
text_value!(Id, "^[A-Za-z0-9._:-]{1,128}$", |v: &str| !v.is_empty()
    && v.len() <= 128
    && v.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)));
text_value!(
    RequestId,
    "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    |v: &str| v.len() == 36
        && v.bytes()
            .enumerate()
            .all(|(i, b)| if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            })
);
text_value!(Digest, "^[0-9a-f]{64}$", |v: &str| v.len() == 64
    && v.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
text_value!(ContextToken, "^[A-Za-z0-9_-]{1,2048}$", |v: &str| !v
    .is_empty()
    && v.len() <= 2048
    && v.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)));
text_value!(
    Bytes,
    "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$",
    valid_base64
);
text_value!(Timestamp, timestamp_pattern(), valid_timestamp);
text_value!(SignedDecimal, "^(?:0|-?[1-9][0-9]*)$", |v: &str| {
    let n = v.strip_prefix('-').unwrap_or(v);
    !n.is_empty()
        && n.bytes().all(|b| b.is_ascii_digit())
        && (n == "0" && !v.starts_with('-') || !n.starts_with('0'))
});

fn valid_base64(v: &str) -> bool {
    if !v.len().is_multiple_of(4) {
        return false;
    }
    let body = v.trim_end_matches('=');
    let padding = v.len() - body.len();
    if padding > 2
        || !body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b))
    {
        return false;
    }
    match padding {
        0 => true,
        1 => body
            .as_bytes()
            .last()
            .is_some_and(|b| b"AEIMQUYcgkosw048".contains(b)),
        2 => body.as_bytes().last().is_some_and(|b| b"AQgw".contains(b)),
        _ => false,
    }
}
fn timestamp_pattern() -> String {
    let leap_year = "(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)";
    let date = format!(
        "(?:[0-9]{{4}}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))|{leap_year}-02-29)"
    );
    let month_end = format!(
        "(?:[0-9]{{4}}-(?:(?:01|03|05|07|08|10|12)-31|(?:04|06|09|11)-30)|{leap_year}-02-29|(?!(?:{leap_year})-)[0-9]{{4}}-02-28)"
    );
    format!(
        "^(?:{date}[Tt](?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]|{month_end}[Tt]23:59:60)(?:\\.[0-9]+)?(?:[Zz]|\\+00:00)$"
    )
}
fn valid_timestamp(v: &str) -> bool {
    // RFC 3339 §4.3 的 -00:00 表示未知本地偏移，不作为协议显式 UTC 表示。
    let Some(v) = v
        .strip_suffix('Z')
        .or_else(|| v.strip_suffix('z'))
        .or_else(|| v.strip_suffix("+00:00"))
    else {
        return false;
    };
    let b = v.as_bytes();
    if b.len() < 19
        || !v.is_ascii()
        || b[4] != b'-'
        || b[7] != b'-'
        || !b"Tt".contains(&b[10])
        || b[13] != b':'
        || b[16] != b':'
    {
        return false;
    }
    for range in [0..4, 5..7, 8..10, 11..13, 14..16, 17..19] {
        if !b[range].iter().all(u8::is_ascii_digit) {
            return false;
        }
    }
    let n = |i: usize| (b[i] - b'0') * 10 + b[i + 1] - b'0';
    let year: u16 = v[..4].parse().expect("validated digits");
    let days = match n(5) {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) {
                29
            } else {
                28
            }
        }
        _ => 0,
    };
    (1..=days).contains(&n(8))
        && n(11) < 24
        && n(14) < 60
        // 只验证月末闰秒表示的位置，不维护 IERS 历史或预测未来闰秒。
        && (n(17) < 60 || n(17)==60 && n(11)==23 && n(14)==59 && n(8)==days)
        && (b.len() == 19
            || b[19] == b'.' && b.len() > 20 && b[20..].iter().all(u8::is_ascii_digit))
}

/// 缺失由 default 处理；显式 null 不能伪装成未提供。
pub fn non_null_option<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}
