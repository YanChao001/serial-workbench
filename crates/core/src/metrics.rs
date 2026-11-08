use crate::{Id, Timestamp, U64};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostMetricsParams {}

/// 同一资源预算拥有者的当前占用和自启动以来的峰值，单位为字节。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryBudget {
    pub used_bytes: U64,
    pub peak_bytes: U64,
    pub limit_bytes: U64,
}

/// RSS 峰值由操作系统提供；各预算快照独立读取，不构成跨资源事务。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostMetrics {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub observed_at: Timestamp,
    pub process_id: U64,
    pub rss_bytes: U64,
    pub rss_peak_bytes: U64,
    pub source: MemoryBudget,
    pub reader: MemoryBudget,
    pub capture_queue: MemoryBudget,
}
