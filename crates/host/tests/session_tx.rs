use serial_workbench_core::*;
use serial_workbench_host::{
    auth::AuthService,
    clock::SystemClock,
    device::{DeviceService, TransportOpener},
    state::{ProjectionLimits, ProjectionStore},
    storage::Store,
    stream::{StreamHub, StreamLimits},
};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
mod support;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Fixture {
    _dir: tempfile::TempDir,
    service: DeviceService,
    target: Target,
    opens: Arc<AtomicUsize>,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let identity = store.begin_instance().unwrap();
        let auth = AuthService::new(
            store.clone(),
            ContextToken::try_from("test-control-token").unwrap(),
        );
        let hub = StreamHub::new(identity.clone(), auth.clone(), StreamLimits::default());
        let opens = Arc::new(AtomicUsize::new(0));
        let count = opens.clone();
        let opener: TransportOpener = Arc::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(TestTransport))
        });
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("fixture"),
            session_id: None,
            session_epoch: None,
        };
        let service = DeviceService::new(
            store,
            auth.clone(),
            identity.clone(),
            hub,
            Arc::new(SystemClock::default()),
            opener,
            ProjectionStore::new(identity, auth, ProjectionLimits::default()),
        );
        Self {
            _dir: dir,
            service,
            target,
            opens,
        }
    }
}
struct TestTransport;
impl Transport for TestTransport {
    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            semantics: TransportSemantics::Stream,
            configuration: true,
            dtr: true,
            rts: true,
            finite_break: true,
            queue_status: true,
            drain: true,
            purge_rx: true,
            purge_tx: true,
        }
    }
    fn read(&mut self, _: usize, _: std::time::Duration) -> BackendResult<ReadBlock> {
        Ok(ReadBlock {
            bytes: Arc::from([]),
            message: None,
        })
    }
    fn write(&mut self, bytes: &[u8], _: std::time::Duration) -> BackendResult<BackendWrite> {
        Ok(BackendWrite {
            accepted_ranges: vec![ByteRange {
                start: 0.into(),
                end: (bytes.len() as u64).into(),
            }],
            unknown_ranges: vec![],
            error: None,
        })
    }
    fn configure(&mut self, _: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        unreachable!()
    }
    fn control(&mut self, _: ControlCommand) -> BackendResult<ControlResult> {
        unreachable!()
    }
    fn close(&mut self) -> BackendResult<()> {
        Ok(())
    }
}
#[tokio::test]
async fn concurrent_open_of_one_device_opens_backend_once() {
    let fixture = Fixture::new();
    let params = OpenParams {
        configuration: SerialConfiguration::default(),
    };
    let (one, two) = tokio::join!(
        fixture.service.open(&fixture.target, params.clone()),
        fixture.service.open(&fixture.target, params)
    );
    let (one, two) = (one.unwrap(), two.unwrap());
    assert_eq!(one.session_id, two.session_id);
    assert_ne!(one.reused, two.reused);
    assert_eq!(fixture.opens.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn different_configuration_never_silently_reconfigures_open_device() {
    let fixture = Fixture::new();
    fixture
        .service
        .open(
            &fixture.target,
            OpenParams {
                configuration: SerialConfiguration::default(),
            },
        )
        .await
        .unwrap();
    let configuration = SerialConfiguration {
        parity: Parity::Even,
        ..SerialConfiguration::default()
    };
    assert_eq!(
        fixture
            .service
            .open(&fixture.target, OpenParams { configuration })
            .await
            .unwrap_err()
            .code,
        "CONFIGURATION_CONFLICT"
    );
    assert_eq!(fixture.opens.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn five_bytes_with_three_backend_accepted_have_partial_receipt_and_no_replay() {
    let h = support::Harness::new().await;
    let target = h.open("partial").await;
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 3,
        unknown: false,
        gate: None,
        advance_ms: 0,
    });
    let call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
    );
    let initial = h.invoke(call.clone()).await;
    let done = h.wait(&initial.operation_id).await;
    assert_eq!(support::receipt(&done).outcome, TxOutcome::Partial);
    assert_eq!(
        support::receipt(&done).accepted_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: 3.into()
        }]
    );
    let duplicate = h.invoke(call).await;
    assert_eq!(duplicate.operation_id, done.operation_id);
    assert_eq!(h.write_count(), 1);
    let (events, _lease) = h
        .host
        .streams()
        .read_prepared(
            &h.actor,
            StreamReadParams {
                session_id: target.id.clone(),
                session_epoch: target.session_epoch.unwrap(),
                start_event_seq: 1.into(),
                max_events: 100.into(),
                max_bytes: 100000.into(),
            },
        )
        .await
        .unwrap()
        .into_parts();
    let intent=events.events.iter().find(|event|matches!(&event.payload,RawPayload::TxIntent(v) if v.operation_id==done.operation_id && v.bytes_base64.as_str()=="AQIDBAU=")).unwrap();
    let receipt=events.events.iter().find(|event|matches!(&event.payload,RawPayload::Tx(v) if v.operation_id==done.operation_id && v.outcome==TxOutcome::Partial)).unwrap();
    assert!(intent.event_seq < receipt.event_seq);
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn unknown_write_preserves_prefix_and_does_not_replay() {
    let h = support::Harness::new().await;
    let target = h.open("unknown").await;
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 3,
        unknown: true,
        gate: None,
        advance_ms: 0,
    });
    let op = h.send(&target).await;
    assert_eq!(op.state, OperationState::Unknown);
    assert_eq!(
        support::receipt(&op).unknown_ranges,
        vec![ByteRange {
            start: 3.into(),
            end: 5.into()
        }]
    );
    assert_eq!(h.write_count(), 1);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn blocked_backend_does_not_block_another_session() {
    let h = support::Harness::new().await;
    let a = h.open("a").await;
    let b = h.open("b").await;
    let gate = Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let first = h
        .invoke(h.call(
            &a,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    gate.entered().await;
    let second = h.send(&b).await;
    assert_eq!(support::receipt(&second).outcome, TxOutcome::Accepted);
    assert!(!support::terminal(
        h.store.get(&h.actor, &first.operation_id).unwrap().state
    ));
    gate.release();
    h.wait(&first.operation_id).await;
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn queued_cancel_completes_rejected_receipt_without_backend_write() {
    let h = support::Harness::new().await;
    let target = h.open("cancel").await;
    let acquire = h
        .invoke(h.call(
            &target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"100"}),
        ))
        .await;
    support::until(|| {
        h.store
            .get(&h.actor, &acquire.operation_id)
            .unwrap()
            .result
            .is_some()
    })
    .await;
    let queued = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    h.cancel(&queued).await;
    let done = h.wait(&queued.operation_id).await;
    assert_eq!(done.state, OperationState::Cancelled);
    assert_eq!(support::receipt(&done).outcome, TxOutcome::Rejected);
    assert_eq!(h.write_count(), 0);
    h.cancel(&acquire).await;
    h.wait(&acquire.operation_id).await;
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancellation_during_partial_write_preserves_accepted_prefix() {
    let h = support::Harness::new().await;
    let target = h.open("partial-cancel").await;
    let gate = Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 3,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let op = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    gate.entered().await;
    h.cancel(&op).await;
    gate.release();
    let done = h.wait(&op.operation_id).await;
    assert_eq!(done.state, OperationState::Cancelled);
    assert_eq!(support::receipt(&done).outcome, TxOutcome::Partial);
    assert_eq!(support::receipt(&done).accepted_ranges[0].end, U64::from(3));
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn backend_owner_loss_after_dispatch_is_unknown_and_duplicate_never_replays() {
    let h = support::Harness::new().await;
    let target = h.open("lost-owner").await;
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: usize::MAX,
        unknown: false,
        gate: None,
        advance_ms: 0,
    });
    let call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
    );
    let op = h.invoke(call.clone()).await;
    let done = h.wait(&op.operation_id).await;
    assert_eq!(done.state, OperationState::Unknown);
    assert_eq!(
        support::receipt(&done).unknown_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: 5.into()
        }]
    );
    assert_eq!(h.invoke(call).await.operation_id, done.operation_id);
    assert_eq!(h.write_count(), 1);
    let _ = h.host.shutdown().await;
}

#[tokio::test]
async fn actor_fifo_rotates_without_interleaving_requests() {
    let h = support::Harness::new().await;
    let target = h.open("fair").await;
    let actor_b = h.new_actor("actor-b");
    let gate = Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let first = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    gate.entered().await;
    let a2 = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"Ag==","writeWaitMs":"100"}),
        ))
        .await;
    let a3 = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"Aw==","writeWaitMs":"100"}),
        ))
        .await;
    let b = h
        .host
        .invoke(
            &actor_b,
            h.call_as(
                &actor_b,
                &target,
                "session.tx",
                serde_json::json!({"bytesBase64":"CQ==","writeWaitMs":"100"}),
            ),
        )
        .await
        .unwrap();
    gate.release();
    h.wait(&first.operation_id).await;
    h.wait(&a2.operation_id).await;
    h.wait(&a3.operation_id).await;
    support::until(|| support::terminal(h.store.get(&actor_b, &b.operation_id).unwrap().state))
        .await;
    let writes = h
        .probe
        .writes
        .lock()
        .unwrap()
        .iter()
        .map(|(_, bytes, _)| bytes.clone())
        .collect::<Vec<_>>();
    assert_eq!(writes[0], vec![1, 2, 3, 4, 5]);
    let b_index = writes.iter().position(|v| v == &vec![9]).unwrap();
    let a2_index = writes.iter().position(|v| v == &vec![2]).unwrap();
    let a3_index = writes.iter().position(|v| v == &vec![3]).unwrap();
    assert!(b_index < a3_index);
    assert!(a2_index < a3_index);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn closing_session_cancels_old_queued_epoch_without_backend_write() {
    let h = support::Harness::new().await;
    let target = h.open("epoch").await;
    let gate = Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let first = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    gate.entered().await;
    let queued = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    let close = h
        .invoke(h.call(&target, "session.close", serde_json::json!({})))
        .await;
    // close和TX在同一owner协调，关闭信号应先让旧队列停止。
    gate.release();
    h.wait(&first.operation_id).await;
    h.wait(&close.operation_id).await;
    let done = h.wait(&queued.operation_id).await;
    assert_eq!(support::receipt(&done).outcome, TxOutcome::Rejected);
    assert_eq!(h.write_count(), 1);
    let reopened = h.open("epoch").await;
    assert!(reopened.session_epoch > target.session_epoch);
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 2);
    let fresh = h.send(&reopened).await;
    assert_eq!(support::receipt(&fresh).outcome, TxOutcome::Accepted);
    let stale = h
        .host
        .invoke(
            &h.actor,
            h.call(
                &target,
                "session.tx",
                serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
            ),
        )
        .await;
    assert_eq!(stale.unwrap_err().code, "EPOCH_MISMATCH");
    assert_eq!(h.write_count(), 2);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn queue_capacity_is_reserved_before_accept_and_duplicate_needs_no_new_capacity() {
    let h = support::Harness::new().await;
    let target = h.open("queue-admission").await;
    let lease = h
        .invoke(h.call(
            &target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"30000"}),
        ))
        .await;
    support::until(|| {
        h.store
            .get(&h.actor, &lease.operation_id)
            .unwrap()
            .result
            .is_some()
    })
    .await;
    let call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
    );
    let first = h.invoke(call.clone()).await;
    for _ in 0..126 {
        h.invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
        ))
        .await;
    }
    let rejected = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
    );
    let overflow = h.host.invoke(&h.actor, rejected.clone()).await;
    let duplicate = h.host.invoke(&h.actor, call).await;
    let selected = h.store.get_selected(
        &h.actor,
        &OperationGetParams::ByRequest {
            actor_id: h.actor.id().clone(),
            request_id: rejected.request_id,
            request_context: rejected.request_context,
        },
    );
    h.host.shutdown().await.unwrap();
    assert!(matches!(overflow,Err(ref error) if error.code=="HOST_BUSY"));
    assert!(matches!(selected,Err(ref error) if error.code=="NOT_FOUND"));
    assert_eq!(duplicate.unwrap().operation_id, first.operation_id);
    assert_eq!(h.write_count(), 0);
}

#[tokio::test]
async fn lease_release_with_lease_context_does_not_wait_for_itself() {
    let h = support::Harness::new().await;
    let target = h.open("lease-release-context").await;
    let op = h
        .invoke(h.call(
            &target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"30000"}),
        ))
        .await;
    support::until(|| {
        h.store
            .get(&h.actor, &op.operation_id)
            .unwrap()
            .result
            .is_some()
    })
    .await;
    let Some(ActionResult::Lease(lease)) = h.store.get(&h.actor, &op.operation_id).unwrap().result
    else {
        panic!()
    };
    let mut call = h.call(
        &target,
        "lease.release",
        serde_json::json!({"leaseId":lease.lease_id}),
    );
    call.lease_id = Some(lease.lease_id);
    let release = h.invoke(call).await;
    let done = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        h.wait(&release.operation_id),
    )
    .await
    .expect("release waited on its own operation");
    assert_eq!(done.state, OperationState::Succeeded);
    h.host.shutdown().await.unwrap();
}
