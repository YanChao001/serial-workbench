//! 只缓存当前实际Node的标量观测；任务正文交给所属任务处理，不进入进程指标。
use super::{
    error,
    observation::{RawObservation, deserialize_present},
};
use serde::Deserialize;
use serial_workbench_core::{HostResult, NodeMetrics as CoreNodeMetrics, U64};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

const MAX_WORKERS: u64 = 32;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeSample {
    #[serde(default, deserialize_with = "deserialize_present")]
    pub rss_bytes: Option<U64>,
    pub live_workers: U64,
    pub peak_workers: U64,
    #[serde(default, deserialize_with = "deserialize_present")]
    pub task: Option<TaskSample>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskSample {
    pub request_id: U64,
    pub observation: RawObservation,
}

#[derive(Debug, Clone, Copy)]
struct ReceivedSample {
    process_id: u32,
    rss_bytes: Option<U64>,
    live_workers: U64,
    peak_workers: U64,
    received: Instant,
}

#[derive(Debug, Clone)]
pub(crate) struct NodeMetricsCache {
    finished: Arc<AtomicBool>,
    latest: Arc<Mutex<Option<ReceivedSample>>>,
}

impl NodeMetricsCache {
    pub(crate) fn new(finished: Arc<AtomicBool>) -> Self {
        Self {
            finished,
            latest: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn update(&self, pid: u32, sample: &NodeSample) -> HostResult<()> {
        // 已退出owner的迟到观测不能复活缓存，也不改变实际工作终态。
        if self.finished.load(Ordering::Acquire) {
            return Ok(());
        }
        let received = Instant::now();
        if pid == 0
            || sample.live_workers > sample.peak_workers
            || sample.peak_workers.get() > MAX_WORKERS
        {
            return Err(error("INVALID_ARGUMENT", "backendTelemetrySample"));
        }
        let mut latest = self.latest.lock().map_err(|_| {
            let mut cause = error("HOST_BUSY", "backendTelemetryLock");
            cause.retryable = true;
            cause
        })?;
        if self.finished.load(Ordering::Acquire) {
            return Ok(());
        }
        if let Some(previous) = latest.as_ref()
            && (previous.process_id != pid || sample.peak_workers < previous.peak_workers)
        {
            return Err(error("INVALID_ARGUMENT", "backendTelemetryInstance"));
        }
        // None表示本次RSS不可得；不制造零值，也不挪用旧RSS的新鲜度。
        *latest = Some(ReceivedSample {
            process_id: pid,
            rss_bytes: sample.rss_bytes,
            live_workers: sample.live_workers,
            peak_workers: sample.peak_workers,
            received,
        });
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> Option<CoreNodeMetrics> {
        if self.finished.load(Ordering::Acquire) {
            return None;
        }
        // 只复制几个标量；查询者既不等待观测锁，也不持有长生命周期owner锁。
        let sample = self.latest.try_lock().ok().and_then(|latest| *latest)?;
        if self.finished.load(Ordering::Acquire) {
            return None;
        }
        let age = u64::try_from(sample.received.elapsed().as_millis()).unwrap_or(u64::MAX);
        Some(CoreNodeMetrics {
            process_id: u64::from(sample.process_id).into(),
            sample_age_ms: age.into(),
            rss_bytes: sample.rss_bytes,
            live_workers: sample.live_workers,
            peak_workers: sample.peak_workers,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn sample(rss: Option<u64>, live: u64, peak: u64) -> NodeSample {
        NodeSample {
            rss_bytes: rss.map(U64::from),
            live_workers: live.into(),
            peak_workers: peak.into(),
            task: None,
        }
    }

    #[test]
    fn missing_and_finished_owners_never_publish_a_sample() {
        let finished = Arc::new(AtomicBool::new(false));
        let cache = NodeMetricsCache::new(finished.clone());
        let reader = cache.clone();
        assert!(reader.snapshot().is_none());
        cache.update(71, &sample(Some(500), 2, 2)).unwrap();
        assert_eq!(reader.snapshot().unwrap().process_id.get(), 71);
        finished.store(true, Ordering::Release);
        assert!(cache.snapshot().is_none());
        cache.update(71, &sample(Some(600), 1, 2)).unwrap();
        assert!(reader.snapshot().is_none());
    }

    #[test]
    fn rss_can_fall_or_become_unavailable_without_resetting_the_worker_peak() {
        let cache = NodeMetricsCache::new(Arc::new(AtomicBool::new(false)));
        cache.update(72, &sample(Some(900), 3, 3)).unwrap();
        cache.update(72, &sample(Some(200), 1, 3)).unwrap();
        let lower = cache.snapshot().unwrap();
        assert_eq!(lower.rss_bytes.unwrap().get(), 200);
        assert_eq!(lower.live_workers.get(), 1);
        assert_eq!(lower.peak_workers.get(), 3);
        cache.update(72, &sample(None, 0, 3)).unwrap();
        let unavailable = cache.snapshot().unwrap();
        assert!(unavailable.rss_bytes.is_none());
        assert_eq!(unavailable.live_workers.get(), 0);
        assert_eq!(unavailable.peak_workers.get(), 3);
    }

    #[test]
    fn invalid_counts_or_another_pid_preserve_the_last_received_sample() {
        let cache = NodeMetricsCache::new(Arc::new(AtomicBool::new(false)));
        cache.update(73, &sample(Some(300), 2, 4)).unwrap();
        let before = cache.latest.lock().unwrap().unwrap();
        for (pid, invalid) in [
            (73, sample(Some(100), 3, 2)),
            (73, sample(Some(100), 2, 33)),
            (73, sample(Some(100), 1, 3)),
            (0, sample(Some(100), 1, 4)),
            (74, sample(Some(100), 1, 4)),
        ] {
            assert_eq!(
                cache.update(pid, &invalid).unwrap_err().code,
                "INVALID_ARGUMENT"
            );
            let latest = cache.latest.lock().unwrap().unwrap();
            assert_eq!(latest.process_id, before.process_id);
            assert_eq!(latest.rss_bytes, before.rss_bytes);
            assert_eq!(latest.live_workers, before.live_workers);
            assert_eq!(latest.peak_workers, before.peak_workers);
            assert_eq!(latest.received, before.received);
        }
    }

    #[test]
    fn replacement_backends_have_independent_identity_peak_and_finish_signals() {
        let old_finished = Arc::new(AtomicBool::new(false));
        let old = NodeMetricsCache::new(old_finished.clone());
        old.update(75, &sample(Some(800), 1, 32)).unwrap();
        let current = NodeMetricsCache::new(Arc::new(AtomicBool::new(false)));
        current.update(76, &sample(Some(100), 1, 1)).unwrap();
        old_finished.store(true, Ordering::Release);
        assert!(old.snapshot().is_none());
        let latest = current.snapshot().unwrap();
        assert_eq!(latest.process_id.get(), 76);
        assert_eq!(latest.live_workers.get(), 1);
        assert_eq!(latest.peak_workers.get(), 1);
    }

    #[test]
    fn snapshot_uses_monotonic_receipt_age_and_does_not_wait_for_the_cache_lock() {
        let cache = NodeMetricsCache::new(Arc::new(AtomicBool::new(false)));
        cache.update(77, &sample(None, 0, 0)).unwrap();
        {
            let mut latest = cache.latest.lock().unwrap();
            latest.as_mut().unwrap().received = Instant::now()
                .checked_sub(Duration::from_millis(123))
                .unwrap();
            assert!(cache.snapshot().is_none());
        }
        let first = cache.snapshot().unwrap().sample_age_ms.get();
        assert!(first >= 123);
        assert!(cache.snapshot().unwrap().sample_age_ms.get() >= first);
    }

    #[test]
    fn telemetry_wire_rejects_unknown_fields_and_present_null_values() {
        for raw in [
            r#"{"liveWorkers":"0","peakWorkers":"0","rssBytes":null}"#,
            r#"{"liveWorkers":"0","peakWorkers":"0","task":null}"#,
            r#"{"liveWorkers":"0","peakWorkers":"0","processId":"77"}"#,
            r#"{"liveWorkers":0,"peakWorkers":"0"}"#,
            r#"{"liveWorkers":"0","peakWorkers":"0","task":{"requestId":"1","observation":{},"extra":0}}"#,
        ] {
            assert!(serde_json::from_str::<NodeSample>(raw).is_err(), "{raw}");
        }
        let minimal: NodeSample =
            serde_json::from_str(r#"{"liveWorkers":"0","peakWorkers":"0"}"#).unwrap();
        assert!(minimal.rss_bytes.is_none() && minimal.task.is_none());
    }
}
