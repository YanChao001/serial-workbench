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

/// 派生留存和读页各自的计账预算，单位为字节。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedMemoryMetrics {
    pub retained: MemoryBudget,
    pub reader: MemoryBudget,
}

/// Node 原生采样完成时的 worker V8 堆使用量；不是进程 RSS。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerMemorySample {
    /// 经验证的 Node 原生采样完成时刻，不是 Host 收到快照的时刻。
    pub sampled_at: Timestamp,
    pub measured_workers: U64,
    pub v8_heap_used_bytes: U64,
}

/// 实际任务拥有的 worker 数量及最后一次内存样本；退出不把旧样本改成零。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerObservation {
    pub live_workers: U64,
    pub peak_workers: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "WorkerMemorySample")]
    #[specta(type=WorkerMemorySample, optional)]
    pub last_memory: Option<WorkerMemorySample>,
}

/// 真实 Node owner 的聚合观测；RSS 属于整个 Node 进程，不按 worker 重复计数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeMetrics {
    /// 由 Rust 持有的实际 owner 注入，不接受插件自报 PID。
    pub process_id: U64,
    /// 从 Host 收到 Node 快照起计算的单调年龄，不是墙钟时间差。
    pub sample_age_ms: U64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "U64")]
    #[specta(type=U64, optional)]
    /// Node 原生 memoryUsage.rss 的全进程读数；缺省表示不可得，不代表零。
    pub rss_bytes: Option<U64>,
    pub live_workers: U64,
    pub peak_workers: U64,
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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "DerivedMemoryMetrics")]
    #[specta(type = DerivedMemoryMetrics, optional)]
    pub derived: Option<DerivedMemoryMetrics>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::identity::non_null_option"
    )]
    #[schemars(with = "NodeMetrics")]
    #[specta(type=NodeMetrics, optional)]
    pub node: Option<NodeMetrics>,
}
