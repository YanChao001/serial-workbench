//! 请求执行与已接纳 Operation 使用同一停止分类，分别持有各自的容量。
pub(crate) const NORMAL_OPERATIONS: usize = 224;
pub(crate) const STOP_OPERATIONS: usize = 32;
pub(crate) fn is_stop(action: &str) -> bool {
    matches!(
        action,
        "operation.cancel"
            | "session.close"
            | "lease.release"
            | "subscription.close"
            | "host.shutdown"
    )
}
