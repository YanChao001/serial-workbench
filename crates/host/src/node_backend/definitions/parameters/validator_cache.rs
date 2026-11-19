//! 键、生成输入及可达编译图的逻辑权重按validator生命期持有，不等同整个校验器的RSS。
use super::{GraphReservation, MAX_BYTES, ValidationKey, Work, error, json_bytes, schema_error};
use jsonschema::Validator;
use serde::Serialize;
use serial_workbench_core::HostResult;
use std::{
    collections::BTreeMap,
    ops::Deref,
    sync::{Arc, Mutex},
};

const MAX_ENTRIES: usize = 128;
pub(super) const MAX_CACHE_BYTES: usize = 8 * MAX_BYTES;

#[derive(Default)]
pub(super) struct Cache {
    entries: Mutex<BTreeMap<ValidationKey, Arc<CachedValidator>>>,
    capacity: Arc<Capacity>,
}
#[derive(Default)]
struct Capacity(Mutex<Usage>);
#[derive(Default)]
struct Usage {
    entries: usize,
    bytes: usize,
}
pub(super) struct Reservation {
    capacity: Arc<Capacity>,
    bytes: usize,
    global: GraphReservation,
}
pub(super) struct CachedValidator {
    // 按字段顺序先析构validator，再归还其额度。
    validator: Validator,
    _reservation: Reservation,
}
impl CachedValidator {
    pub(super) fn new(validator: Validator, reservation: Reservation) -> Self {
        Self {
            validator,
            _reservation: reservation,
        }
    }
}
impl Deref for CachedValidator {
    type Target = Validator;
    fn deref(&self) -> &Validator {
        &self.validator
    }
}
fn limit() -> serial_workbench_core::HostError {
    error("LIMIT_EXCEEDED", "backendParametersCacheBudget")
}
impl Cache {
    pub(super) fn get(&self, key: &ValidationKey) -> HostResult<Option<Arc<CachedValidator>>> {
        self.entries
            .lock()
            .map(|entries| entries.get(key).cloned())
            .map_err(|_| error("HOST_BUSY", "backendParametersCache"))
    }
    pub(super) fn reserve(&self, key: &ValidationKey) -> HostResult<Reservation> {
        let mut bytes = std::mem::size_of::<ValidationKey>()
            + std::mem::size_of::<CachedValidator>()
            + std::mem::size_of::<Arc<CachedValidator>>()
            + 2 * std::mem::size_of::<usize>();
        let mut add = |amount: usize| -> HostResult<()> {
            bytes = bytes.checked_add(amount).ok_or_else(limit)?;
            Ok(())
        };
        match key {
            ValidationKey::Predicate { base, scope, .. } => {
                add(base.capacity())?;
                add(scope
                    .capacity()
                    .checked_mul(std::mem::size_of::<String>())
                    .ok_or_else(limit)?)?;
                for uri in scope {
                    add(uri.capacity())?;
                }
            }
            ValidationKey::Pattern { draft, expression }
            | ValidationKey::PropertyPattern { draft, expression } => {
                add(draft.capacity())?;
                add(expression.capacity())?;
            }
        }
        let mut usage = self
            .capacity
            .0
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendParametersCache"))?;
        let entries = usage.entries.checked_add(1).ok_or_else(limit)?;
        let total = usage.bytes.checked_add(bytes).ok_or_else(limit)?;
        if entries > MAX_ENTRIES || total > MAX_CACHE_BYTES {
            return Err(limit());
        }
        let global = GraphReservation::reserve(bytes)?;
        usage.entries = entries;
        usage.bytes = total;
        Ok(Reservation {
            capacity: self.capacity.clone(),
            bytes,
            global,
        })
    }
    pub(super) fn insert(
        &self,
        key: ValidationKey,
        validator: Arc<CachedValidator>,
    ) -> HostResult<Arc<CachedValidator>> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendParametersCache"))?;
        Ok(entries.entry(key).or_insert(validator).clone())
    }
}
impl Reservation {
    pub(super) fn charge(
        &mut self,
        bytes: usize,
        work: &mut Work,
        depth: usize,
        nodes: usize,
    ) -> HostResult<()> {
        work.charge(depth, nodes, bytes)?;
        self.retain(bytes)
    }
    pub(super) fn graph(&mut self, bytes: usize) -> HostResult<()> {
        // 遍历已使用当前请求的Work；这里只持有常驻额度，避免重复扣同一份工作量。
        self.retain(bytes)
    }
    fn retain(&mut self, bytes: usize) -> HostResult<()> {
        let mut usage = self
            .capacity
            .0
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendParametersCache"))?;
        let own = self.bytes.checked_add(bytes).ok_or_else(limit)?;
        let total = usage.bytes.checked_add(bytes).ok_or_else(limit)?;
        if total > MAX_CACHE_BYTES {
            return Err(limit());
        }
        self.global.extend(bytes)?;
        usage.bytes = total;
        self.bytes = own;
        Ok(())
    }
    pub(super) fn input<T: Serialize>(
        &mut self,
        schema: &T,
        work: &mut Work,
        depth: usize,
    ) -> HostResult<serde_json::Value> {
        let bytes = source_bytes(schema)?;
        self.charge(bytes, work, depth, 3)?;
        serde_json::to_value(schema).map_err(|_| schema_error())
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        let mut usage = self
            .capacity
            .0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        usage.bytes = usage.bytes.saturating_sub(self.bytes);
        usage.entries = usage.entries.saturating_sub(1);
    }
}
pub(super) fn source_bytes<T: Serialize + ?Sized>(schema: &T) -> HostResult<usize> {
    json_bytes::measure(schema, MAX_CACHE_BYTES).map_err(|_| limit())
}
