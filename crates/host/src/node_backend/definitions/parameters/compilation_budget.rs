//! 在克隆和首次编译前检查schema结构；迭代帧只随已检查的深度增长。
use super::{MAX_BYTES, Work, error, evaluation_budget, json_bytes, schema_error};
use serde_json::Value;
use serial_workbench_core::{HostError, HostResult, SchemaObject, SchemaValue};
use std::{collections::btree_map, slice};

enum Frame<'a> {
    Object(btree_map::Iter<'a, String, SchemaValue>),
    Array(slice::Iter<'a, SchemaValue>),
}
impl<'a> Frame<'a> {
    fn next(&mut self) -> Option<(&'a SchemaValue, usize)> {
        match self {
            Self::Object(values) => values.next().map(|(key, value)| (value, key.len())),
            Self::Array(values) => values.next().map(|value| (value, 0)),
        }
    }
}
fn limit() -> HostError {
    error("LIMIT_EXCEEDED", "backendSchemaBudget")
}
pub(super) fn prepare(schema: &SchemaObject) -> HostResult<(Value, usize)> {
    let mut work = Work::default();
    work.step(0, std::mem::size_of::<Value>())
        .map_err(|_| limit())?;
    let mut frames = vec![Frame::Object(schema.iter())];
    while !frames.is_empty() {
        let depth = frames.len();
        let Some((value, key_bytes)) = frames.last_mut().and_then(Frame::next) else {
            frames.pop();
            continue;
        };
        let string_bytes = match value {
            SchemaValue::String(value) => value.len(),
            _ => 0,
        };
        let bytes = key_bytes
            .checked_add(string_bytes)
            .and_then(|bytes| bytes.checked_add(std::mem::size_of::<Value>()))
            .ok_or_else(limit)?;
        work.step(depth, bytes).map_err(|_| limit())?;
        match value {
            SchemaValue::Object(object) => frames.push(Frame::Object(object.iter())),
            SchemaValue::Array(array) => frames.push(Frame::Array(array.iter())),
            _ => {}
        }
    }
    // 此时深度已受限，精确计数转义后的JSON字节不需要分配完整缓冲。
    json_bytes::measure(schema, MAX_BYTES).map_err(|_| limit())?;
    let value = serde_json::to_value(schema).map_err(|_| schema_error())?;
    let max_path = evaluation_budget::max_schema_path(&value)?;
    Ok((value, max_path))
}
