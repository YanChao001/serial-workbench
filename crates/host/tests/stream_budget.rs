use base64::{Engine, engine::general_purpose::STANDARD};
use serial_workbench_core::*;
use serial_workbench_host::{
    auth::{AuthService, AuthenticatedActor},
    storage::Store,
    stream::*,
};
use std::sync::Arc;

fn id(s: &str) -> Id {
    Id::try_from(s).unwrap()
}
fn meta() -> SourceMeta {
    SourceMeta {
        configuration_revision: 1.into(),
        time: EventTime {
            clock_id: id("clock"),
            source_mono_ns: 0.into(),
            received_wall_time: Timestamp::try_from("2026-11-07T00:00:00Z").unwrap(),
            precision: TimePrecision {
                source: TimeSource::HostRead,
                resolution_ns: 1.into(),
                sync_method: "host".into(),
                offset_estimate_ns: None,
                offset_error_ns: None,
                rtt_ns: None,
            },
            source_wall_time: None,
        },
    }
}
struct Fixture {
    _dir: tempfile::TempDir,
    hub: StreamHub,
    source: StreamSource,
    actor: AuthenticatedActor,
    auth: AuthService,
    control: AuthenticatedActor,
    target: Target,
}
impl Fixture {
    fn new(limits: StreamLimits) -> Self {
        Self::with_clock(
            limits,
            Arc::new(serial_workbench_host::clock::SystemClock::new().unwrap()),
        )
    }
    fn with_clock(limits: StreamLimits, clock: Arc<dyn Clock>) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_with_clock(dir.path(), clock.clone()).unwrap();
        let identity = store.begin_instance().unwrap();
        let secret = ContextToken::try_from("stream-control").unwrap();
        let auth = AuthService::with_clock(store, secret.clone(), clock);
        let actor = auth.authenticate(&id("stream-client"), None).unwrap().actor;
        let control = auth
            .authenticate_user_control(&id("operator"), &secret)
            .unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: id("session"),
            session_id: Some(id("session")),
            session_epoch: Some(1.into()),
        };
        auth.authorize(
            &control,
            AuthorizeParams {
                client_id: id("stream-client"),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        let hub = StreamHub::new(identity, auth.clone(), limits);
        let source = hub
            .register_source(
                StreamKey {
                    session_id: id("session"),
                    session_epoch: 1.into(),
                },
                target.clone(),
            )
            .unwrap();
        Self {
            _dir: dir,
            hub,
            source,
            actor,
            auth,
            control,
            target,
        }
    }
    async fn read(&self) -> Vec<RawEvent> {
        let (result, _lease) = self
            .hub
            .read_prepared(
                &self.actor,
                StreamReadParams {
                    session_id: id("session"),
                    session_epoch: 1.into(),
                    start_event_seq: 1.into(),
                    max_events: 100.into(),
                    max_bytes: (256 * 1024).into(),
                },
            )
            .await
            .unwrap()
            .into_parts();
        result.events
    }
    async fn subscribe(&self, credit: u64, policy: OverflowPolicy) -> RawSubscription {
        self.hub
            .subscribe(
                &self.actor,
                StreamSubscribeParams {
                    scope_id: self.source.initial_cursor().scope_id,
                    after: self.source.initial_cursor(),
                    queue_bytes: (4 * 1024 * 1024).into(),
                    initial_credit_bytes: credit.into(),
                    overflow_policy: policy,
                },
            )
            .await
            .unwrap()
    }
    async fn grant(
        &self,
        sub: &RawSubscription,
        ack: Cursor,
        total: u64,
    ) -> HostResult<StreamCreditResult> {
        self.hub
            .credit(
                &self.actor,
                StreamCreditParams {
                    subscription_id: sub.id().clone(),
                    ack_cursor: ack,
                    granted_bytes_total: total.into(),
                },
            )
            .await
    }
}
#[tokio::test]
async fn oversized_rx_splits_without_losing_tail_or_message_offsets() {
    let f = Fixture::new(StreamLimits::default());
    let bytes: Vec<u8> = (0..40003).map(|n| (n % 251) as u8).collect();
    f.source
        .append_rx(
            meta(),
            Arc::from(bytes.clone()),
            Some(MessageFragment {
                message_id: id("message"),
                fragment_offset: 7.into(),
                message_length: 50000.into(),
                message_type: "binary".into(),
            }),
        )
        .unwrap();
    let events = f.read().await;
    assert_eq!(events.len(), 3);
    let mut actual = Vec::new();
    for (index, event) in events.iter().enumerate() {
        assert_eq!(event.event_seq.get(), index as u64 + 1);
        let RawPayload::Rx(rx) = &event.payload else {
            panic!("Expected RX")
        };
        assert_eq!(rx.byte_start.get(), actual.len() as u64);
        assert_eq!(
            rx.message.as_ref().unwrap().fragment_offset.get(),
            7 + actual.len() as u64
        );
        let block = STANDARD.decode(rx.bytes_base64.as_str()).unwrap();
        assert!(block.len() <= 16384);
        actual.extend(block);
        assert_eq!(rx.byte_end.get(), actual.len() as u64);
    }
    assert_eq!(actual, bytes);
}
#[tokio::test]
async fn tx_intent_is_immediate_and_receipt_does_not_recount_offsets() {
    let f = Fixture::new(StreamLimits::default());
    let intent = f
        .source
        .append_tx_intent(meta(), id("operation"), Arc::from(&b"hello"[..]))
        .unwrap();
    f.source
        .append_rx(meta(), Arc::from(&b"rx"[..]), None)
        .unwrap();
    let first = f.read().await;
    assert_eq!(first.len(), 2);
    assert!(matches!(first[0].payload, RawPayload::TxIntent(_)));
    let settlement = TxSettlement {
        outcome: TxOutcome::Partial,
        accepted_ranges: vec![ByteRange {
            start: 0.into(),
            end: 3.into(),
        }],
        unknown_ranges: vec![],
        backend_error: None,
    };
    assert_eq!(
        f.source
            .complete_tx(&intent, meta(), settlement.clone())
            .unwrap(),
        3.into()
    );
    assert_eq!(
        f.source.complete_tx(&intent, meta(), settlement).unwrap(),
        3.into()
    );
    let next = f
        .source
        .append_tx_intent(meta(), id("second"), Arc::from(&b"!"[..]))
        .unwrap();
    assert_eq!(
        next.byte_range(),
        ByteRange {
            start: 5.into(),
            end: 6.into()
        }
    );
    let all = f.read().await;
    assert_eq!(all.len(), 4);
    assert_eq!(all[0], first[0]);
    assert_eq!(all[1], first[1]);
    assert!(matches!(all[2].payload, RawPayload::Tx(_)));
}

#[tokio::test]
async fn credit_uses_exact_json_and_initial_cursor_without_ack_inflation() {
    let f = Fixture::new(StreamLimits::default());
    let sub = f.subscribe(0, OverflowPolicy::DropWithGap).await;
    f.source
        .append_rx(meta(), Arc::from(&b"hello"[..]), None)
        .unwrap();
    let event = f.read().await.remove(0);
    let expected = RawBatch {
        subscription_id: sub.id().clone(),
        cursor: f.source.cursor(1),
        previous_cursor: f.source.cursor(0),
        items: vec![StreamItem::Source {
            event: Box::new(event),
        }],
    };
    let length = serde_json::to_vec(&expected).unwrap().len() as u64;
    f.grant(&sub, f.source.cursor(0), length - 1).await.unwrap();
    assert!(sub.try_next().await.unwrap().is_none());
    f.grant(&sub, f.source.cursor(0), length).await.unwrap();
    let batch = sub.try_next().await.unwrap().unwrap();
    assert_eq!(batch.batch(), &expected);
    sub.mark_sent(&batch).unwrap();
    sub.mark_sent(&batch).unwrap();
    let first = f.grant(&sub, f.source.cursor(1), length).await.unwrap();
    let replay = f.grant(&sub, f.source.cursor(1), length).await.unwrap();
    assert_eq!(first, replay);
    assert_eq!(first.sent_bytes_total.get(), length);
    assert_eq!(first.acknowledged_bytes_total.get(), length);
    assert_eq!(
        f.grant(&sub, f.source.cursor(0), length)
            .await
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        f.grant(&sub, f.source.cursor(2), length)
            .await
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        f.grant(&sub, f.source.cursor(1), length + 4 * 1024 * 1024 + 1)
            .await
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
}

#[tokio::test]
async fn eight_mib_slow_reader_gap_does_not_change_independent_consumer_hashes() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new(StreamLimits::default());
    let fast = f
        .subscribe(4 * 1024 * 1024, OverflowPolicy::DropWithGap)
        .await;
    let capture = f.subscribe(4 * 1024 * 1024, OverflowPolicy::Stop).await;
    let slow = f.subscribe(0, OverflowPolicy::DropWithGap).await;
    let mut expected = Sha256::new();
    let mut fast_hash = Sha256::new();
    let mut capture_hash = Sha256::new();
    let mut fast_total = 4 * 1024 * 1024;
    let mut capture_total = 4 * 1024 * 1024;
    for n in 0..512 {
        let data: Vec<u8> = (0..16384)
            .map(|offset| ((offset + n) % 251) as u8)
            .collect();
        expected.update(&data);
        f.source.append_rx(meta(), Arc::from(data), None).unwrap();
        for (sub, hash, total) in [
            (&fast, &mut fast_hash, &mut fast_total),
            (&capture, &mut capture_hash, &mut capture_total),
        ] {
            let batch = sub.try_next().await.unwrap().unwrap();
            assert_eq!(batch.batch().cursor.position.get(), n as u64 + 1);
            for item in &batch.batch().items {
                let StreamItem::Source { event } = item else {
                    panic!("Fast consumer lost data")
                };
                let RawPayload::Rx(rx) = &event.payload else {
                    panic!("Expected RX")
                };
                hash.update(STANDARD.decode(rx.bytes_base64.as_str()).unwrap());
            }
            *total += serde_json::to_vec(batch.batch()).unwrap().len() as u64;
            sub.mark_sent(&batch).unwrap();
            f.grant(sub, batch.batch().cursor.clone(), *total)
                .await
                .unwrap();
        }
    }
    let expected = expected.finalize();
    assert_eq!(fast_hash.finalize(), expected);
    assert_eq!(capture_hash.finalize(), expected);
    assert!(slow.try_next().await.unwrap().is_none());
    f.grant(&slow, f.source.cursor(0), 4 * 1024 * 1024)
        .await
        .unwrap();
    let batch = slow.try_next().await.unwrap().unwrap();
    let StreamItem::ReaderGap { gap } = &batch.batch().items[0] else {
        panic!("Slow reader must report its exact gap")
    };
    assert_eq!(gap.missing_event_range.start.get(), 1);
    assert!(gap.missing_event_range.end.get() > 1);
    assert_eq!(
        batch.batch().cursor.position.get(),
        gap.missing_event_range.end.get() - 1
    );
    assert_eq!(
        gap.missing_byte_ranges.as_ref().unwrap(),
        &vec![DirectionalRange {
            direction: Direction::Rx,
            start: 0.into(),
            end: ((gap.missing_event_range.end.get() - 1) * 16384).into()
        }]
    );
    let mut middle = batch.batch().cursor.clone();
    middle.position = (middle.position.get() - 1).into();
    slow.mark_sent(&batch).unwrap();
    assert_eq!(
        f.grant(&slow, middle, 4 * 1024 * 1024)
            .await
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let memory = f.hub.memory_usage();
    assert!(memory.source_peak <= 128 * 1024 * 1024);
    assert!(memory.reader_peak <= 128 * 1024 * 1024);
}

#[tokio::test]
async fn revoked_then_regranted_subscription_cannot_release_old_queued_content() {
    let f = Fixture::new(StreamLimits::default());
    let sub = f
        .subscribe(4 * 1024 * 1024, OverflowPolicy::DropWithGap)
        .await;
    f.source
        .append_rx(meta(), Arc::from(&b"private"[..]), None)
        .unwrap();
    let prepared = sub.try_next().await.unwrap().unwrap();
    f.auth
        .revoke(
            &f.control,
            RevokeParams {
                actor_id: f.actor.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.target.clone()],
            },
        )
        .unwrap();
    f.auth
        .authorize(
            &f.control,
            AuthorizeParams {
                client_id: id("stream-client"),
                permissions: vec!["content.read".into()],
                targets: vec![f.target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    assert_eq!(
        sub.try_next().await.err().unwrap().code,
        "PERMISSION_DENIED"
    );
    assert!(sub.mark_sent(&prepared).is_err());
}

#[tokio::test]
async fn completed_tx_backing_pressure_drops_only_slow_reader_projections() {
    use sha2::{Digest, Sha256};
    let f = Fixture::new(StreamLimits::default());
    let fast = f.subscribe(4 * 1024 * 1024, OverflowPolicy::Stop).await;
    let slow = f.subscribe(0, OverflowPolicy::DropWithGap).await;
    let stopped = f.subscribe(0, OverflowPolicy::Stop).await;
    let mut expected = Sha256::new();
    let mut actual = Sha256::new();
    let mut next_seq = 1;
    let mut total = 4 * 1024 * 1024;
    for n in 0..143 {
        let bytes: Vec<u8> = (0..16384)
            .map(|offset| ((offset + n) % 251) as u8)
            .collect();
        let count = if n < 15 {
            expected.update(&bytes);
            expected.update(&bytes);
            let intent = f
                .source
                .append_tx_intent(meta(), id(&format!("pressure-{n}")), Arc::from(bytes))
                .unwrap();
            f.source
                .complete_tx(
                    &intent,
                    meta(),
                    TxSettlement {
                        outcome: TxOutcome::Accepted,
                        accepted_ranges: vec![ByteRange {
                            start: 0.into(),
                            end: 16384.into(),
                        }],
                        unknown_ranges: vec![],
                        backend_error: None,
                    },
                )
                .unwrap();
            2
        } else {
            expected.update(&bytes);
            f.source
                .append_rx(meta(), Arc::from(bytes), None)
                .expect("A zero-credit reader must not stop RX after completed TX");
            1
        };
        for _ in 0..count {
            let batch = fast.try_next().await.unwrap().unwrap();
            let StreamItem::Source { event } = &batch.batch().items[0] else {
                panic!("Timely reader must receive every source event")
            };
            assert_eq!(event.event_seq.get(), next_seq);
            let bytes = match &event.payload {
                RawPayload::TxIntent(intent) => &intent.bytes_base64,
                RawPayload::Tx(receipt) => &receipt.bytes_base64,
                RawPayload::Rx(rx) => &rx.bytes_base64,
                _ => panic!("Unexpected source event"),
            };
            actual.update(STANDARD.decode(bytes.as_str()).unwrap());
            next_seq += 1;
            total += serde_json::to_vec(batch.batch()).unwrap().len() as u64;
            fast.mark_sent(&batch).unwrap();
            f.grant(&fast, batch.batch().cursor.clone(), total)
                .await
                .unwrap();
        }
    }
    assert_eq!(next_seq, 159);
    assert_eq!(actual.finalize(), expected.finalize());
    assert_eq!(
        stopped.try_next().await.err().unwrap().code,
        "READER_OVERFLOW"
    );
    f.grant(&slow, f.source.cursor(0), 4 * 1024 * 1024)
        .await
        .unwrap();
    let batch = slow.try_next().await.unwrap().unwrap();
    let StreamItem::ReaderGap { gap } = &batch.batch().items[0] else {
        panic!("Source pressure must report the discarded prefix")
    };
    let end = gap.missing_event_range.end.get();
    assert_eq!(gap.missing_event_range.start.get(), 1);
    assert!(
        (2..=31).contains(&end),
        "Only oldest completed TX needs reclamation"
    );
    assert_eq!(batch.batch().cursor.position.get(), end - 1);
    assert_eq!(
        gap.missing_byte_ranges.as_ref().unwrap(),
        &vec![DirectionalRange {
            direction: Direction::Tx,
            start: 0.into(),
            end: ((end / 2) * 16384).into(),
        }]
    );
    slow.mark_sent(&batch).unwrap();
    let mut slow_total = 4 * 1024 * 1024 + serde_json::to_vec(batch.batch()).unwrap().len() as u64;
    f.grant(&slow, batch.batch().cursor.clone(), slow_total)
        .await
        .unwrap();
    for seq in end..next_seq {
        let batch = slow.try_next().await.unwrap().unwrap();
        assert!(
            matches!(&batch.batch().items[0], StreamItem::Source {event} if event.event_seq.get()==seq)
        );
        slow_total += serde_json::to_vec(batch.batch()).unwrap().len() as u64;
        slow.mark_sent(&batch).unwrap();
        f.grant(&slow, batch.batch().cursor.clone(), slow_total)
            .await
            .unwrap();
    }
    let memory = f.hub.memory_usage();
    assert!(memory.source_peak <= 16 * 1024 * 1024);
    assert!(memory.reader_peak <= 128 * 1024 * 1024);
}

#[tokio::test]
async fn sliced_rx_backing_pressure_preserves_unsettled_intent_reservation() {
    let f = Fixture::new(StreamLimits::default());
    let slow = f.subscribe(0, OverflowPolicy::DropWithGap).await;
    let intent = f
        .source
        .append_tx_intent(meta(), id("unsettled"), Arc::from(vec![7u8; 16384]))
        .unwrap();
    f.source
        .append_rx(meta(), Arc::from(vec![11u8; 8 * 1024 * 1024]), None)
        .unwrap();
    let first = f.hub.memory_usage().source_bytes;
    f.source
        .append_rx(meta(), Arc::from(vec![13u8; 8 * 1024 * 1024]), None)
        .expect("Tail slices retained by a slow reader must not pin the previous input allocation");
    // The previous RX allocation left the ring, while the original intent still owns its reservation.
    assert_eq!(f.hub.memory_usage().source_bytes, first);
    let receipt_seq = f
        .source
        .complete_tx(
            &intent,
            meta(),
            TxSettlement {
                outcome: TxOutcome::Rejected,
                accepted_ranges: vec![],
                unknown_ranges: vec![],
                backend_error: None,
            },
        )
        .unwrap();
    assert_eq!(receipt_seq.get(), 1026);
    assert_eq!(
        intent.byte_range(),
        ByteRange {
            start: 0.into(),
            end: 16384.into()
        }
    );
    f.grant(&slow, f.source.cursor(0), 4 * 1024 * 1024)
        .await
        .unwrap();
    let batch = slow.try_next().await.unwrap().unwrap();
    let StreamItem::ReaderGap { gap } = &batch.batch().items[0] else {
        panic!("Expected exact gap")
    };
    assert_eq!(gap.missing_event_range.start.get(), 1);
    let end = gap.missing_event_range.end.get();
    assert!((514..1026).contains(&end));
    assert_eq!(
        gap.missing_byte_ranges.as_ref().unwrap(),
        &vec![
            DirectionalRange {
                direction: Direction::Tx,
                start: 0.into(),
                end: 16384.into()
            },
            DirectionalRange {
                direction: Direction::Rx,
                start: 0.into(),
                end: ((end - 2) * 16384).into()
            },
        ]
    );
    assert_eq!(batch.batch().cursor.position.get(), end - 1);
    let memory = f.hub.memory_usage();
    assert!(memory.source_peak <= 16 * 1024 * 1024);
    assert!(memory.reader_peak <= 128 * 1024 * 1024);
}

#[tokio::test]
async fn maximum_tx_intent_fits_reader_and_shared_payload_remains_charged() {
    let f = Fixture::new(StreamLimits::default());
    let sub = f
        .subscribe(4 * 1024 * 1024, OverflowPolicy::DropWithGap)
        .await;
    let intent = f
        .source
        .append_tx_intent(meta(), id("max-tx"), Arc::from(vec![42u8; 16384]))
        .unwrap();
    let batch = sub.try_next().await.unwrap().unwrap();
    assert!(
        matches!(&batch.batch().items[0],StreamItem::Source {event} if matches!(event.payload,RawPayload::TxIntent(_)))
    );
    sub.mark_sent(&batch).unwrap();
    let replay = sub.replay(&batch.batch().cursor).unwrap();
    assert!(Arc::ptr_eq(&batch, &replay));
    let before = f.hub.memory_usage().source_bytes;
    f.source
        .complete_tx(
            &intent,
            meta(),
            TxSettlement {
                outcome: TxOutcome::Accepted,
                accepted_ranges: vec![ByteRange {
                    start: 0.into(),
                    end: 16384.into(),
                }],
                unknown_ranges: vec![],
                backend_error: None,
            },
        )
        .unwrap();
    assert_eq!(f.hub.memory_usage().source_bytes, before);
    sub.close();
    assert!(f.hub.memory_usage().reader_bytes > 0);
    drop(batch);
    drop(replay);
    drop(sub);
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
}

#[tokio::test]
async fn stop_and_epoch_end_are_observable_and_flow_control_is_not_faked() {
    let f = Fixture::new(StreamLimits::default());
    let stopped = f.subscribe(0, OverflowPolicy::Stop).await;
    for _ in 0..300 {
        f.source
            .append_rx(meta(), Arc::from(vec![1u8; 16384]), None)
            .unwrap();
    }
    assert_eq!(
        stopped.try_next().await.err().unwrap().code,
        "READER_OVERFLOW"
    );
    let after = f.source.cursor(300);
    let live = f
        .hub
        .subscribe(
            &f.actor,
            StreamSubscribeParams {
                scope_id: after.scope_id.clone(),
                after: after.clone(),
                queue_bytes: 65536.into(),
                initial_credit_bytes: 0.into(),
                overflow_policy: OverflowPolicy::DropWithGap,
            },
        )
        .await
        .unwrap();
    f.source.close().unwrap();
    assert_eq!(live.try_next().await.err().unwrap().code, "EPOCH_MISMATCH");
    assert_eq!(
        f.hub
            .subscribe(
                &f.actor,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after,
                    queue_bytes: 65536.into(),
                    initial_credit_bytes: 0.into(),
                    overflow_policy: OverflowPolicy::FlowControl
                }
            )
            .await
            .err()
            .unwrap()
            .code,
        "UNSUPPORTED_CAPABILITY"
    );
}

#[tokio::test]
async fn closed_epochs_do_not_exhaust_active_source_slots() {
    let f = Fixture::new(StreamLimits::default());
    f.source.close().unwrap();
    for epoch in 2..20 {
        let mut target = f.target.clone();
        target.session_epoch = Some(epoch.into());
        let source = f
            .hub
            .register_source(
                StreamKey {
                    session_id: id("session"),
                    session_epoch: epoch.into(),
                },
                target,
            )
            .unwrap();
        source.close().unwrap();
    }
}

#[tokio::test]
async fn pull_read_lease_moves_with_reply_and_releases_on_drop() {
    let f = Fixture::new(StreamLimits::default());
    f.source
        .append_rx(meta(), Arc::from(vec![7u8; 32768]), None)
        .unwrap();
    let prepared = f
        .hub
        .read_prepared(
            &f.actor,
            StreamReadParams {
                session_id: id("session"),
                session_epoch: 1.into(),
                start_event_seq: 1.into(),
                max_events: 100.into(),
                max_bytes: (256 * 1024).into(),
            },
        )
        .await
        .unwrap();
    assert!(f.hub.memory_usage().reader_bytes > 32768);
    let (result, lease) = prepared.into_parts();
    assert_eq!(result.events.len(), 2);
    drop(result);
    assert!(f.hub.memory_usage().reader_bytes > 0);
    drop(lease);
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
}

#[tokio::test]
async fn idle_reader_expires_without_new_events_or_authorization_writes() {
    struct Elapsed(std::time::Instant);
    impl Clock for Elapsed {
        fn mono_ns(&self) -> u64 {
            self.0.elapsed().as_nanos() as u64
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2026-11-07T00:00:00Z").unwrap()
        }
    }
    let f = Fixture::with_clock(
        StreamLimits::default(),
        Arc::new(Elapsed(std::time::Instant::now())),
    );
    f.auth
        .authorize(
            &f.control,
            AuthorizeParams {
                client_id: id("stream-client"),
                permissions: vec!["content.read".into()],
                targets: vec![f.target.clone()],
                expires_at: Some(Timestamp::try_from("2026-11-07T00:00:00.200Z").unwrap()),
            },
        )
        .unwrap();
    let sub = f.subscribe(0, OverflowPolicy::DropWithGap).await;
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), sub.next())
        .await
        .unwrap();
    assert_eq!(result.err().unwrap().code, "PERMISSION_DENIED");
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
}

#[tokio::test]
async fn source_failure_ends_readers_and_preserves_the_first_cause() {
    let f = Fixture::new(StreamLimits::default());
    let reader = f.subscribe(0, OverflowPolicy::DropWithGap).await;
    f.source
        .append_rx(meta(), Arc::from(&b"queued"[..]), None)
        .unwrap();
    f.source
        .fail(HostError::new("BACKEND_DISCONNECTED", "Backend read ended"))
        .unwrap();
    f.source
        .fail(HostError::new("LIMIT_EXCEEDED", "Later cleanup"))
        .unwrap();
    f.source.close().unwrap();
    assert_eq!(
        reader.try_next().await.err().unwrap().code,
        "BACKEND_DISCONNECTED"
    );
    assert!(
        f.source
            .append_rx(meta(), Arc::from(&b"late"[..]), None)
            .is_err()
    );
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
}

struct BurstTransport {
    inner: serial_workbench_host::device::virtual_backend::VirtualTransport,
    probe: Arc<BurstProbe>,
}
#[derive(Default)]
struct BurstProbe {
    remaining: std::sync::atomic::AtomicUsize,
    delivered: std::sync::atomic::AtomicUsize,
    settled: std::sync::atomic::AtomicUsize,
    closed: std::sync::atomic::AtomicBool,
}
impl Transport for BurstTransport {
    fn capabilities(&self) -> TransportCapabilities {
        self.inner.capabilities()
    }
    fn read(&mut self, max: usize, wait: std::time::Duration) -> BackendResult<ReadBlock> {
        use std::sync::atomic::Ordering;
        self.probe.settled.store(
            self.probe.delivered.load(Ordering::SeqCst),
            Ordering::SeqCst,
        );
        if self
            .probe
            .remaining
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(1)
            })
            .is_ok()
        {
            self.probe.delivered.fetch_add(1, Ordering::SeqCst);
            return Ok(ReadBlock {
                bytes: Arc::from(vec![37u8; max.min(16384)]),
                message: None,
            });
        }
        self.inner.read(max, wait)
    }
    fn write(&mut self, bytes: &[u8], wait: std::time::Duration) -> BackendResult<BackendWrite> {
        self.inner.write(bytes, wait)
    }
    fn configure(&mut self, value: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        self.inner.configure(value)
    }
    fn control(&mut self, value: ControlCommand) -> BackendResult<ControlResult> {
        self.inner.control(value)
    }
    fn close(&mut self) -> BackendResult<()> {
        self.probe
            .closed
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.inner.close()
    }
}
struct LiveRaw {
    dir: tempfile::TempDir,
    host: serial_workbench_host::Host,
    client: serial_workbench_client::HostClient,
    target: Target,
    host_target: Target,
    probe: Arc<BurstProbe>,
    stop: tokio::sync::oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl LiveRaw {
    async fn new() -> Self {
        Self::with_gate(None).await
    }
    async fn with_gate(gate: Option<Arc<LateRawGate>>) -> Self {
        use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
        use serial_workbench_host::{
            Host, clock::SystemClock, device::TransportOpener, ipc::HostServer,
        };
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        let auth = server.auth();
        let probe = Arc::new(BurstProbe::default());
        let cloned = probe.clone();
        let opener: TransportOpener = Arc::new(move |_, configuration| {
            Ok(Box::new(BurstTransport {
                inner: serial_workbench_host::device::virtual_backend::VirtualTransport::new(
                    configuration.clone(),
                ),
                probe: cloned.clone(),
            }))
        });
        let host = Host::with_runtime(
            server.store(),
            auth.clone(),
            Arc::new(SystemClock::new().unwrap()),
            opener,
        )
        .await
        .unwrap();
        let host_target = Target {
            host_id: server.identity().host_id.clone(),
            id: server.identity().host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let operator = auth
            .authenticate_user_control(
                &id("raw-ipc-operator"),
                &read_user_control_credential(dir.path()).unwrap(),
            )
            .unwrap();
        let (stop, done) = tokio::sync::oneshot::channel();
        let handler: Arc<dyn serial_workbench_host::ipc::RequestHandler> = match gate {
            Some(gate) => Arc::new(DelayedRaw {
                host: host.clone(),
                gate,
            }),
            None => Arc::new(host.clone()),
        };
        let running = tokio::spawn(async move {
            server
                .serve_until(handler, async {
                    let _ = done.await;
                })
                .await
        });
        let client = HostClient::connect(ConnectOptions::new(
            dir.path().to_path_buf(),
            id("raw-ipc-reader"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: id("raw-ipc-reader"),
                permissions: vec!["device.modify".into(), "content.read".into()],
                targets: vec![host_target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        let device = Target {
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("burst"),
            ..host_target.clone()
        };
        let open = host
            .devices()
            .open(
                &device,
                OpenParams {
                    configuration: SerialConfiguration::default(),
                },
            )
            .await
            .unwrap();
        let target = Target {
            host_id: host_target.host_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: open.session_id.clone(),
            session_id: Some(open.session_id),
            session_epoch: Some(open.session_epoch),
        };
        Self {
            dir,
            host,
            client,
            target,
            host_target,
            probe,
            stop,
            running,
        }
    }
    fn query(
        &self,
        client: &serial_workbench_client::HostClient,
        action: &str,
        target: &Target,
        params: serde_json::Value,
    ) -> Query {
        let attach = client.attachment();
        Query {
            protocol_version: ProtocolVersion::V0_1,
            host_id: attach.host_id.clone(),
            instance_epoch: attach.instance_epoch,
            actor_id: attach.actor_id.clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            action_id: id(action),
            target: target.clone(),
            params: serde_json::from_value(params).unwrap(),
            reveal_target: RevealTarget {
                page_id: id("workbench"),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
        }
    }
    fn initial(&self) -> Cursor {
        Cursor {
            host_id: self.target.host_id.clone(),
            instance_epoch: self.client.attachment().instance_epoch,
            scope_id: id(&format!(
                "raw:{}:{}",
                self.target.id,
                self.target.session_epoch.unwrap()
            )),
            position: 0.into(),
        }
    }
    async fn subscribe(
        &self,
        client: &serial_workbench_client::HostClient,
        raw: &serial_workbench_client::RawConnection,
    ) -> Id {
        let cursor = self.initial();
        let reply=raw.request(RpcRequest::StreamSubscribe(self.query(client,"stream.subscribe",&self.target,serde_json::json!({"scopeId":cursor.scope_id,"after":cursor,"queueBytes":"4194304","initialCreditBytes":"0","overflowPolicy":"drop_with_gap"})))).await.unwrap();
        match rpc_success(reply) {
            RpcResult::Subscription(result) => result.subscription_id,
            other => panic!("{other:?}"),
        }
    }
    async fn finish(self) {
        drop(self.client);
        let _ = self.stop.send(());
        self.running.await.unwrap().unwrap();
    }
}
fn rpc_success(reply: RpcReply) -> RpcResult {
    match reply {
        RpcReply::Success { result, .. } => *result,
        other => panic!("{other:?}"),
    }
}
async fn until_raw(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn host_raw_read_credit_and_close_use_real_dispatch_and_writer() {
    let f = LiveRaw::new().await;
    f.probe
        .remaining
        .store(1, std::sync::atomic::Ordering::SeqCst);
    until_raw(|| f.probe.settled.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
    let raw = f.client.connect_raw().await.unwrap();
    let result=rpc_success(raw.request(RpcRequest::StreamRead(f.query(&f.client,"stream.read",&f.target,serde_json::json!({"sessionId":f.target.id,"sessionEpoch":f.target.session_epoch,"startEventSeq":"1","maxEvents":"100","maxBytes":"262144"})))).await.unwrap());
    assert!(matches!(result,RpcResult::StreamRead(result) if !result.events.is_empty()));
    until_raw(|| f.host.streams().memory_usage().reader_bytes == 0).await;
    let subscription = f.subscribe(&f.client, &raw).await;
    let result=rpc_success(raw.request(RpcRequest::StreamCredit(f.query(&f.client,"stream.credit",&f.target,serde_json::json!({"subscriptionId":subscription,"ackCursor":f.initial(),"grantedBytesTotal":"65536"})))).await.unwrap());
    assert!(
        matches!(result,RpcResult::StreamCredit(result) if result.granted_bytes_total.get()==65536)
    );
    let event = tokio::time::timeout(std::time::Duration::from_secs(3), raw.next_event())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let IpcMessage::RawBatch { batch } = event.body else {
        panic!("Expected raw batch")
    };
    let bytes = serde_json::to_vec(&batch).unwrap().len() as u64;
    let result=rpc_success(raw.request(RpcRequest::StreamCredit(f.query(&f.client,"stream.credit",&f.target,serde_json::json!({"subscriptionId":subscription,"ackCursor":batch.cursor,"grantedBytesTotal":"65536"})))).await.unwrap());
    assert!(
        matches!(result,RpcResult::StreamCredit(result) if result.sent_bytes_total.get()>=bytes && result.acknowledged_bytes_total.get()==bytes)
    );
    rpc_success(
        raw.request(RpcRequest::SubscriptionClose(f.query(
            &f.client,
            "subscription.close",
            &f.target,
            serde_json::json!({"subscriptionId":subscription}),
        )))
        .await
        .unwrap(),
    );
    until_raw(|| f.host.streams().memory_usage().reader_bytes == 0).await;
    drop(raw);
    f.finish().await;
}
#[tokio::test]
async fn host_raw_connections_are_isolated_and_zero_credit_does_not_block_session_close() {
    use serial_workbench_client::{ConnectOptions, HostClient};
    use std::sync::atomic::Ordering;
    let f = LiveRaw::new().await;
    let second = HostClient::connect(ConnectOptions::new(
        f.dir.path().to_path_buf(),
        id("raw-ipc-reader"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let snapshot = rpc_success(
        f.client
            .request(RpcRequest::StateSnapshot(f.query(
                &f.client,
                "state.snapshot",
                &f.host_target,
                serde_json::json!({"scopeId":"host.devices"}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Snapshot(snapshot) = snapshot else {
        panic!()
    };
    rpc_success(
        f.client
            .request(RpcRequest::StateSubscribe(f.query(
                &f.client,
                "state.subscribe",
                &f.host_target,
                serde_json::json!({"scopeId":"host.devices","after":snapshot.cursor}),
            )))
            .await
            .unwrap(),
    );
    let raw = f.client.connect_raw().await.unwrap();
    let raw_second = second.connect_raw().await.unwrap();
    let first_id = f.subscribe(&f.client, &raw).await;
    f.subscribe(&second, &raw_second).await;
    let forbidden=raw_second.request(RpcRequest::StreamCredit(f.query(&second,"stream.credit",&f.target,serde_json::json!({"subscriptionId":first_id,"ackCursor":f.initial(),"grantedBytesTotal":"65536"})))).await.unwrap();
    assert!(matches!(forbidden,RpcReply::Failure {error,..} if error.code=="PERMISSION_DENIED"));
    assert_eq!(
        f.host.streams().memory_usage().reader_bytes,
        8 * 1024 * 1024
    );
    drop(raw);
    until_raw(|| f.host.streams().memory_usage().reader_bytes == 4 * 1024 * 1024).await;
    assert_eq!(f.host.projections().reader_count(), 1);
    drop(second);
    until_raw(|| f.host.streams().memory_usage().reader_bytes == 0).await;
    assert_eq!(f.host.projections().reader_count(), 1);
    drop(raw_second);
    f.host
        .projections()
        .commit(
            &id("host.devices"),
            id("devices.changed"),
            JsonObject::new(),
            JsonObject::new(),
        )
        .unwrap();
    let state_event =
        tokio::time::timeout(std::time::Duration::from_secs(3), f.client.next_event())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    assert!(matches!(state_event.body, IpcMessage::Delta { .. }));
    let slow = f.client.connect_raw().await.unwrap();
    f.subscribe(&f.client, &slow).await;
    f.probe.remaining.store(512, Ordering::SeqCst);
    // Device owner's 1 ms receive wait may round up to Windows timer resolution.
    // Input preparation has a separate bound from the control response below.
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        while f.probe.settled.load(Ordering::SeqCst) < 512 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap_or_else(|error| {
        panic!(
            "RX preparation: {error}; delivered={}, settled={}, closed={}, budget={:?}",
            f.probe.delivered.load(Ordering::SeqCst),
            f.probe.settled.load(Ordering::SeqCst),
            f.probe.closed.load(Ordering::SeqCst),
            f.host.streams().memory_usage()
        )
    });
    let query = f.query(&f.client, "session.close", &f.target, serde_json::json!({}));
    let call = Call {
        protocol_version: query.protocol_version,
        host_id: query.host_id,
        instance_epoch: query.instance_epoch,
        actor_id: query.actor_id,
        request_id: query.request_id,
        request_context: f.client.attachment().request_context.clone(),
        action_id: query.action_id,
        target: query.target,
        params: query.params,
        reveal_target: query.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    };
    rpc_success(
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            f.client.request(RpcRequest::Invoke(call)),
        )
        .await
        .unwrap()
        .unwrap(),
    );
    until_raw(|| f.probe.closed.load(Ordering::SeqCst)).await;
    until_raw(|| f.host.streams().memory_usage().reader_bytes == 0).await;
    assert!(f.host.streams().memory_usage().reader_peak <= 128 * 1024 * 1024);
    drop(slow);
    f.finish().await;
}

struct LateRawGate {
    entered: tokio::sync::Notify,
    disconnected: tokio::sync::Notify,
    completed: tokio::sync::Notify,
    release: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}
struct DelayedRaw {
    host: serial_workbench_host::Host,
    gate: Arc<LateRawGate>,
}
impl serial_workbench_host::ipc::RequestHandler for DelayedRaw {
    fn handle(
        &self,
        context: serial_workbench_host::ipc::ConnectionContext,
        request: RpcRequest,
    ) -> serial_workbench_host::ipc::HandlerFuture {
        let release = if matches!(request, RpcRequest::StreamSubscribe(_)) {
            self.gate.release.lock().unwrap().take()
        } else {
            None
        };
        let host = self.host.clone();
        let gate = self.gate.clone();
        Box::pin(async move {
            if let Some(release) = release {
                gate.entered.notify_one();
                let _ = release.await;
            }
            let result =
                serial_workbench_host::ipc::RequestHandler::handle(&host, context, request).await;
            gate.completed.notify_one();
            result
        })
    }
    fn disconnected(&self, context: &serial_workbench_host::ipc::ConnectionContext) {
        serial_workbench_host::ipc::RequestHandler::disconnected(&self.host, context);
        if context.channel == IpcChannel::Raw {
            self.gate.disconnected.notify_one();
        }
    }
    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<()>> + Send>> {
        serial_workbench_host::ipc::RequestHandler::shutdown(&self.host)
    }
}
#[tokio::test]
async fn host_raw_late_subscribe_after_disconnect_releases_all_reader_budget() {
    let (release, held) = tokio::sync::oneshot::channel();
    let gate = Arc::new(LateRawGate {
        entered: tokio::sync::Notify::new(),
        disconnected: tokio::sync::Notify::new(),
        completed: tokio::sync::Notify::new(),
        release: std::sync::Mutex::new(Some(held)),
    });
    let f = LiveRaw::with_gate(Some(gate.clone())).await;
    let raw = f.client.connect_raw().await.unwrap();
    let cursor = f.initial();
    let query=f.query(&f.client,"stream.subscribe",&f.target,serde_json::json!({"scopeId":cursor.scope_id,"after":cursor,"queueBytes":"4194304","initialCreditBytes":"0","overflowPolicy":"drop_with_gap"}));
    let request =
        tokio::spawn(async move { raw.request(RpcRequest::StreamSubscribe(query)).await });
    gate.entered.notified().await;
    request.abort();
    let _ = request.await;
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        gate.disconnected.notified(),
    )
    .await
    .unwrap();
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), gate.completed.notified())
        .await
        .unwrap();
    until_raw(|| f.host.streams().memory_usage().reader_bytes == 0).await;
    rpc_success(
        f.client
            .request(RpcRequest::StateSnapshot(f.query(
                &f.client,
                "state.snapshot",
                &f.host_target,
                serde_json::json!({"scopeId":"host.devices"}),
            )))
            .await
            .unwrap(),
    );
    let replacement = f.client.connect_raw().await.unwrap();
    f.subscribe(&f.client, &replacement).await;
    drop(replacement);
    until_raw(|| f.host.streams().memory_usage().reader_bytes == 0).await;
    f.finish().await;
}
#[tokio::test]
async fn reader_count_and_shared_pull_budget_are_hard_limits_released_on_close() {
    let f = Fixture::new(StreamLimits::default());
    let after = f.source.initial_cursor();
    let mut readers = Vec::new();
    for _ in 0..64 {
        readers.push(
            f.hub
                .subscribe(
                    &f.actor,
                    StreamSubscribeParams {
                        scope_id: after.scope_id.clone(),
                        after: after.clone(),
                        queue_bytes: 65536.into(),
                        initial_credit_bytes: 0.into(),
                        overflow_policy: OverflowPolicy::DropWithGap,
                    },
                )
                .await
                .unwrap(),
        );
    }
    assert_eq!(
        f.hub
            .subscribe(
                &f.actor,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after: after.clone(),
                    queue_bytes: 65536.into(),
                    initial_credit_bytes: 0.into(),
                    overflow_policy: OverflowPolicy::DropWithGap
                }
            )
            .await
            .err()
            .unwrap()
            .code,
        "LIMIT_EXCEEDED"
    );
    for reader in readers {
        reader.close();
    }
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
    let f = Fixture::new(StreamLimits {
        total_reader_bytes: 4 * 1024 * 1024,
        ..StreamLimits::default()
    });
    let reader = f.subscribe(0, OverflowPolicy::DropWithGap).await;
    let params = StreamReadParams {
        session_id: id("session"),
        session_epoch: 1.into(),
        start_event_seq: 1.into(),
        max_events: 100.into(),
        max_bytes: 262144.into(),
    };
    assert_eq!(
        f.hub
            .read_prepared(&f.actor, params.clone())
            .await
            .err()
            .unwrap()
            .code,
        "LIMIT_EXCEEDED"
    );
    reader.close();
    let (result, lease) = f
        .hub
        .read_prepared(&f.actor, params)
        .await
        .unwrap()
        .into_parts();
    assert!(result.events.is_empty());
    assert!(f.hub.memory_usage().reader_bytes > 0);
    drop(lease);
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
    assert!(f.hub.memory_usage().reader_peak <= 4 * 1024 * 1024);
}

#[tokio::test]
async fn empty_reader_cannot_bypass_metadata_accounting_with_one_byte_queue() {
    let f = Fixture::new(StreamLimits::default());
    let after = f.source.initial_cursor();
    let result = f
        .hub
        .subscribe(
            &f.actor,
            StreamSubscribeParams {
                scope_id: after.scope_id.clone(),
                after,
                queue_bytes: 1.into(),
                initial_credit_bytes: 0.into(),
                overflow_policy: OverflowPolicy::DropWithGap,
            },
        )
        .await;
    assert_eq!(
        result
            .err()
            .expect("Reader metadata needs a budget before allocation")
            .code,
        "LIMIT_EXCEEDED"
    );
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
}
#[test]
fn empty_source_metadata_is_part_of_the_source_budget() {
    let f = Fixture::new(StreamLimits::default());
    assert!(
        f.hub.memory_usage().source_bytes > 0,
        "An empty source still owns metadata and synchronization objects"
    );
}

#[tokio::test]
async fn tx_source_reservation_precedes_admission_without_sequence_or_offset_and_survives_close() {
    let f = Fixture::new(StreamLimits::default());
    let baseline = f.hub.memory_usage().source_bytes;
    let abandoned = f
        .source
        .reserve_tx_intent(meta(), Arc::from(&b"hello"[..]))
        .unwrap();
    assert!(f.hub.memory_usage().source_bytes > baseline);
    assert!(f.read().await.is_empty());
    drop(abandoned);
    assert_eq!(f.hub.memory_usage().source_bytes, baseline);
    let prepared = f
        .source
        .reserve_tx_intent(meta(), Arc::from(&b"hello"[..]))
        .unwrap();
    f.source
        .append_rx(meta(), Arc::from(&b"rx"[..]), None)
        .unwrap();
    assert_eq!(f.read().await[0].event_seq.get(), 1);
    f.source.close().unwrap();
    let intent = f
        .source
        .commit_tx_intent(prepared, id("reserved-op"))
        .unwrap();
    assert_eq!(intent.event_seq().get(), 2);
    assert_eq!(
        intent.byte_range(),
        ByteRange {
            start: 0.into(),
            end: 5.into()
        }
    );
    assert_eq!(
        f.source
            .complete_tx(
                &intent,
                meta(),
                TxSettlement {
                    outcome: TxOutcome::Rejected,
                    accepted_ranges: vec![],
                    unknown_ranges: vec![],
                    backend_error: None
                }
            )
            .unwrap()
            .get(),
        3
    );
    assert_eq!(f.read().await.len(), 3);
    assert_eq!(
        f.source
            .append_rx(meta(), Arc::from(&b"not-live"[..]), None)
            .unwrap_err()
            .code,
        "EPOCH_MISMATCH"
    );
    assert_eq!(
        f.source
            .reserve_tx_intent(meta(), Arc::from(&b"new"[..]))
            .err()
            .unwrap()
            .code,
        "EPOCH_MISMATCH"
    );
}
#[tokio::test]
async fn single_pull_including_candidate_never_exceeds_reader_memory_limit() {
    let f = Fixture::new(StreamLimits::default());
    let intent = f
        .source
        .append_tx_intent(meta(), id("fragmented-tx"), Arc::from(vec![7u8; 16384]))
        .unwrap();
    let accepted_ranges = (0..16384u64)
        .step_by(2)
        .map(|start| ByteRange {
            start: start.into(),
            end: (start + 1).into(),
        })
        .collect();
    let unknown_ranges = (1..16384u64)
        .step_by(2)
        .map(|start| ByteRange {
            start: start.into(),
            end: (start + 1).into(),
        })
        .collect();
    f.source
        .complete_tx(
            &intent,
            meta(),
            TxSettlement {
                outcome: TxOutcome::Unknown,
                accepted_ranges,
                unknown_ranges,
                backend_error: None,
            },
        )
        .unwrap();
    let result = f
        .hub
        .read_prepared(
            &f.actor,
            StreamReadParams {
                session_id: id("session"),
                session_epoch: 1.into(),
                start_event_seq: 2.into(),
                max_events: 1.into(),
                max_bytes: 262144.into(),
            },
        )
        .await;
    assert_eq!(result.err().unwrap().code, "LIMIT_EXCEEDED");
    assert!(
        f.hub.memory_usage().reader_peak <= 4 * 1024 * 1024,
        "One pull must include its candidate in the 4 MiB reader bound"
    );
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
}

#[tokio::test]
async fn pull_keeps_the_grant_stamp_from_before_its_permission_check() {
    #[derive(Default)]
    struct RevokeClock {
        hook: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }
    impl Clock for RevokeClock {
        fn mono_ns(&self) -> u64 {
            let hook = self.hook.lock().unwrap().take();
            if let Some(hook) = hook {
                hook();
            }
            0
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2026-11-07T00:00:00Z").unwrap()
        }
    }
    let clock = Arc::new(RevokeClock::default());
    let f = Fixture::with_clock(StreamLimits::default(), clock.clone());
    f.auth
        .authorize(
            &f.control,
            AuthorizeParams {
                client_id: f.actor.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.target.clone()],
                expires_at: Some(Timestamp::try_from("2026-11-07T01:00:00Z").unwrap()),
            },
        )
        .unwrap();
    f.source
        .append_rx(meta(), Arc::from(&b"private-pull"[..]), None)
        .unwrap();
    let auth = f.auth.clone();
    let operator = f.control.clone();
    let actor_id = f.actor.id().clone();
    let target = f.target.clone();
    *clock.hook.lock().unwrap() = Some(Box::new(move || {
        auth.revoke(
            &operator,
            RevokeParams {
                actor_id,
                permissions: vec!["content.read".into()],
                targets: vec![target],
            },
        )
        .unwrap();
    }));
    let result = f
        .hub
        .read_prepared(
            &f.actor,
            StreamReadParams {
                session_id: id("session"),
                session_epoch: 1.into(),
                start_event_seq: 1.into(),
                max_events: 100.into(),
                max_bytes: 262144.into(),
            },
        )
        .await;
    assert_eq!(
        result
            .err()
            .expect("A permission check racing revoke cannot adopt the newer grant stamp")
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(f.hub.memory_usage().reader_bytes, 0);
}
