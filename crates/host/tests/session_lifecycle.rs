use serial_workbench_core::*;
use std::sync::atomic::Ordering;
mod support;

#[tokio::test]
async fn closed_devices_release_live_session_capacity() {
    let h = support::Harness::new().await;
    for index in 0..17 {
        let target = h.open(&format!("device-{index}")).await;
        let closed = h
            .action(&target, "session.close", serde_json::json!({}))
            .await;
        assert_eq!(closed.state, OperationState::Succeeded);
    }
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 17);
    assert_eq!(h.probe.closes.load(Ordering::SeqCst), 17);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn raw_source_records_open_and_closed_lifecycle_boundaries() {
    let h = support::Harness::new().await;
    let target = h.open("lifecycle").await;
    h.action(&target, "session.close", serde_json::json!({}))
        .await;
    let (raw, _lease) = h
        .host
        .streams()
        .read_prepared(
            &h.actor,
            StreamReadParams {
                session_id: target.id,
                session_epoch: target.session_epoch.unwrap(),
                start_event_seq: 1.into(),
                max_events: 10.into(),
                max_bytes: 100000.into(),
            },
        )
        .await
        .unwrap()
        .into_parts();
    h.host.shutdown().await.unwrap();
    let states = raw
        .events
        .iter()
        .filter_map(|event| match &event.payload {
            RawPayload::Lifecycle(value) => value.get("state"),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        states,
        vec![
            &JsonValue::String("open".into()),
            &JsonValue::String("closed".into())
        ]
    );
}

#[tokio::test]
async fn backend_read_failure_publishes_disconnected_and_allows_explicit_new_epoch() {
    let h = support::Harness::new().await;
    let target = h.open("failed-read").await;
    h.probe.read_fails.store(true, Ordering::SeqCst);
    support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
    let projection = h
        .host
        .projections()
        .snapshot(&h.actor, &support::id(&format!("session:{}", target.id)))
        .await
        .unwrap();
    h.probe.read_fails.store(false, Ordering::SeqCst);
    let reopened = h
        .host
        .devices()
        .open(
            &h.device("failed-read"),
            OpenParams {
                binding: None,
                configuration: SerialConfiguration::default(),
            },
        )
        .await;
    let _ = h.host.shutdown().await;
    assert_eq!(
        projection.state.get("state"),
        Some(&JsonValue::String("disconnected".into()))
    );
    assert!(reopened.unwrap().session_epoch > target.session_epoch.unwrap());
}
