mod support;

use serial_workbench_core::*;
use serial_workbench_host::{
    capture::{CaptureRuntime, CaptureService},
    metrics::snapshot,
    stream::{StreamHub, StreamKey, StreamLimits},
};

#[test]
fn metrics_wire_preserves_u64_and_rejects_unknown_fields() {
    let value = serde_json::json!({
        "hostId":"host", "instanceEpoch":"18446744073709551615",
        "observedAt":"2026-11-07T00:00:00Z", "processId":"123",
        "rssBytes":"9007199254740993", "rssPeakBytes":"18446744073709551615",
        "source":{"usedBytes":"1","peakBytes":"2","limitBytes":"3"},
        "reader":{"usedBytes":"4","peakBytes":"5","limitBytes":"6"},
        "captureQueue":{"usedBytes":"7","peakBytes":"8","limitBytes":"9"}
    });
    let metrics: HostMetrics = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(metrics.instance_epoch.get(), u64::MAX);
    assert_eq!(metrics.rss_bytes.get(), 9_007_199_254_740_993);
    assert_eq!(serde_json::to_value(metrics).unwrap(), value);
    let mut unknown = value.clone();
    unknown["wrapperRss"] = "1".into();
    assert!(serde_json::from_value::<HostMetrics>(unknown).is_err());
    let mut wrong_number = value.clone();
    wrong_number["rssBytes"] = 123.into();
    assert!(serde_json::from_value::<HostMetrics>(wrong_number).is_err());
    let mut invalid_time = value;
    invalid_time["observedAt"] = "yesterday".into();
    assert!(serde_json::from_value::<HostMetrics>(invalid_time).is_err());
    assert!(serde_json::from_value::<HostMetricsParams>(serde_json::json!({})).is_ok());
    assert!(serde_json::from_value::<HostMetricsParams>(serde_json::json!({"pid":"1"})).is_err());
}

#[tokio::test]
async fn snapshot_reads_live_budgets_without_allocating_a_reader() {
    let f = support::Harness::new().await;
    let identity = f.store.identity().unwrap();
    let limits = StreamLimits {
        total_source_bytes: 12 * 1024 * 1024,
        total_reader_bytes: 20 * 1024 * 1024,
        ..StreamLimits::default()
    };
    let hub = StreamHub::new(identity.clone(), f.auth.clone(), limits);
    let capture = CaptureService::new(CaptureRuntime {
        store: f.store.clone(),
        auth: f.auth.clone(),
        identity: identity.clone(),
        files: f.host.files().clone(),
        streams: hub.clone(),
        devices: f.host.devices().clone(),
        clock: f.clock.clone(),
    });
    let target = Target {
        host_id: identity.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: support::id("metrics-session"),
        session_id: Some(support::id("metrics-session")),
        session_epoch: Some(1.into()),
    };
    let source = hub
        .register_source(
            StreamKey {
                session_id: target.id.clone(),
                session_epoch: 1.into(),
            },
            target,
        )
        .unwrap();
    let reader = hub
        .subscribe(
            &f.actor,
            StreamSubscribeParams {
                scope_id: source.initial_cursor().scope_id,
                after: source.initial_cursor(),
                queue_bytes: (1024 * 1024).into(),
                initial_credit_bytes: 0.into(),
                overflow_policy: OverflowPolicy::DropWithGap,
            },
        )
        .await
        .unwrap();
    let before = hub.memory_usage();
    let queued = capture.memory_usage();
    assert!(before.source_bytes > 0);
    assert!(before.reader_bytes > 0);
    for _ in 0..3 {
        let metrics = snapshot(
            &identity,
            hub.memory_usage(),
            capture.memory_usage(),
            &*f.clock,
        )
        .expect("actual process RSS is available");
        assert_eq!(metrics.host_id, identity.host_id);
        assert_eq!(metrics.instance_epoch, identity.instance_epoch);
        assert_eq!(metrics.observed_at, f.clock.wall_time());
        assert_eq!(metrics.process_id.get(), u64::from(std::process::id()));
        assert!(metrics.rss_bytes.get() > 0);
        assert!(metrics.rss_peak_bytes.get() >= metrics.rss_bytes.get());
        assert_eq!(metrics.source.used_bytes.get(), before.source_bytes as u64);
        assert_eq!(metrics.source.peak_bytes.get(), before.source_peak as u64);
        assert_eq!(
            metrics.source.limit_bytes.get(),
            limits.total_source_bytes as u64
        );
        assert_eq!(metrics.reader.used_bytes.get(), before.reader_bytes as u64);
        assert_eq!(metrics.reader.peak_bytes.get(), before.reader_peak as u64);
        assert_eq!(
            metrics.reader.limit_bytes.get(),
            limits.total_reader_bytes as u64
        );
        assert_eq!(
            metrics.capture_queue.used_bytes.get(),
            queued.queued_bytes as u64
        );
        assert_eq!(
            metrics.capture_queue.peak_bytes.get(),
            queued.peak_queued_bytes as u64
        );
        assert_eq!(
            metrics.capture_queue.limit_bytes.get(),
            queued.queue_limit as u64
        );
    }
    let after = hub.memory_usage();
    assert_eq!(after.source_bytes, before.source_bytes);
    assert_eq!(after.source_peak, before.source_peak);
    assert_eq!(after.reader_bytes, before.reader_bytes);
    assert_eq!(after.reader_peak, before.reader_peak);
    reader.close();
    let released = snapshot(
        &identity,
        hub.memory_usage(),
        capture.memory_usage(),
        &*f.clock,
    )
    .unwrap();
    assert_eq!(released.reader.used_bytes.get(), 0);
    assert_eq!(released.reader.peak_bytes.get(), before.reader_peak as u64);
    source.close().unwrap();
    f.host.shutdown().await.unwrap();
}
