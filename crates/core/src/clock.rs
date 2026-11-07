use crate::Timestamp;

/// 单调计时用于期限；墙钟仅用于展示和审计。
pub trait Clock: Send + Sync {
    fn mono_ns(&self) -> u64;
    fn wall_time(&self) -> Timestamp;
}
