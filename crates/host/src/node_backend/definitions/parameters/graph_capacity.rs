//! 初次和缓存编译图共同持有进程级逻辑额度；不表示整个堆或进程RSS。
use super::{GraphReservation, MAX_BYTES, error};
use serial_workbench_core::{HostError, HostResult};
use std::sync::{Mutex, OnceLock};

const GLOBAL_GRAPH_BYTES: usize = 128 * MAX_BYTES;

fn capacity() -> &'static Mutex<usize> {
    static USED: OnceLock<Mutex<usize>> = OnceLock::new();
    USED.get_or_init(|| Mutex::new(0))
}
fn limit() -> HostError {
    error("LIMIT_EXCEEDED", "backendSchemaGraphLifetimeBudget")
}
fn busy() -> HostError {
    let mut error = error("HOST_BUSY", "backendSchemaGraphCapacity");
    error.retryable = true;
    error
}
impl GraphReservation {
    pub(super) fn reserve(bytes: usize) -> HostResult<Self> {
        let mut reservation = Self { bytes: 0 };
        reservation.extend(bytes)?;
        Ok(reservation)
    }
    pub(super) fn extend(&mut self, bytes: usize) -> HostResult<()> {
        let own = self.bytes.checked_add(bytes).ok_or_else(limit)?;
        if own > GLOBAL_GRAPH_BYTES {
            return Err(limit());
        }
        let mut used = capacity().lock().map_err(|_| busy())?;
        let total = used.checked_add(bytes).ok_or_else(limit)?;
        if total > GLOBAL_GRAPH_BYTES {
            return Err(busy());
        }
        *used = total;
        self.bytes = own;
        Ok(())
    }
}
impl Drop for GraphReservation {
    fn drop(&mut self) {
        let mut used = capacity()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *used = used.saturating_sub(self.bytes);
    }
}
