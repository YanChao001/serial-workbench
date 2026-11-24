use crate::Timestamp;

/// 经过时长用单调时钟；墙钟用来判断绝对日历条件，以及展示与审计。
pub trait Clock: Send + Sync {
    fn mono_ns(&self) -> u64;
    fn wall_time(&self) -> Timestamp;
}
