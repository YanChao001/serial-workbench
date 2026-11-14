mod support;
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    device::{TransportOpener, virtual_backend::VirtualTransport},
    storage::Store,
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::{Harness, ManualClock, id};

fn query(host: &Store, actor: &AuthenticatedActor, target: &Target, action: &str) -> Query {
    Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: target.host_id.clone(),
        instance_epoch: host.identity().unwrap().instance_epoch,
        actor_id: actor.id().clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id(action),
        target: target.clone(),
        params: JsonObject::default(),
        reveal_target: RevealTarget {
            page_id: id("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    }
}
async fn metrics(h: &Harness, actor: &AuthenticatedActor, target: &Target) -> serde_json::Value {
    let result = h
        .host
        .query(actor, query(&h.store, actor, target, "session.metrics"))
        .await;
    assert!(
        result.is_ok(),
        "session.metrics must be a public read query: {result:?}"
    );
    let wire = serde_json::to_value(result.unwrap()).unwrap();
    assert_eq!(wire["kind"], "session_metrics");
    wire["value"].clone()
}

// Break caught: query replay or another observer counts intent bytes again.
#[tokio::test]
async fn metrics_are_shared_and_count_only_unique_final_accepted_and_unknown_ranges() {
    let h = Harness::new().await;
    let target = h.open("observability-tx").await;
    let observer = h.auth.authenticate(&id("observer"), None).unwrap().actor;
    let before = h.host.activity_count();
    assert_eq!(
        metrics(&h, &observer, &target).await["txAcceptedBytes"],
        "0"
    );
    assert_eq!(
        h.host.activity_count(),
        before,
        "polling must not publish activity projections"
    );
    let mut unknown_operation = None;
    for (accepted, unknown, expected_accepted, expected_unknown) in [
        (3, false, "3", "0"),
        (0, false, "3", "0"),
        (2, true, "5", "3"),
    ] {
        h.probe.steps.lock().unwrap().push_back(support::WriteStep {
            accepted,
            unknown,
            gate: None,
            advance_ms: 0,
        });
        let call = h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        );
        let operation = h.invoke(call.clone()).await;
        let settled = h.wait(&operation.operation_id).await;
        if unknown {
            assert_eq!(settled.state, OperationState::Unknown);
            unknown_operation = Some(settled);
        }
        let duplicate = h.invoke(call).await;
        assert_eq!(duplicate.operation_id, operation.operation_id);
        let first = metrics(&h, &h.actor, &target).await;
        let second = metrics(&h, &observer, &target).await;
        assert_eq!(first, second);
        assert_eq!(first["txAcceptedBytes"], expected_accepted);
        assert_eq!(first["txUnknownBytes"], expected_unknown);
        assert_eq!(first["txAcceptedBytesPerSecond"], expected_accepted);
    }
    h.clock.advance_ms(1000);
    let idle = metrics(&h, &observer, &target).await;
    assert_eq!(idle["txAcceptedBytesPerSecond"], "0");
    assert_eq!(idle["txAcceptedBytes"], "5");
    assert_eq!(idle["txWriteErrors"], "3");
    assert_eq!(idle["lineErrorsAvailable"], false);
    assert_eq!(idle["frameCountsAvailable"], false);
    // 真实关闭允许退出，但历史 unknown TX、隔离标记和证据仍须保留。
    let unknown_operation = unknown_operation.unwrap();
    let report = h.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
    assert_eq!(
        report,
        ShutdownReport {
            mode: ShutdownMode::CancelAndSettle,
            completed: true,
            excluded_operation_id: None,
            unsettled_operation_ids: vec![],
            quarantined_sessions: vec![],
            evidence_refs: vec![ObjectRef {
                host_id: unknown_operation.execution_host_id.clone(),
                kind: ResourceKind::try_from("operation").unwrap(),
                id: unknown_operation.operation_id.clone(),
                revision: Some(unknown_operation.revision),
            }],
            failures: vec![],
        }
    );
    assert_eq!(
        h.store
            .get(&h.actor, &unknown_operation.operation_id)
            .unwrap(),
        unknown_operation,
        "shutdown must retain the unique unknown TX settlement"
    );
    let state = h.host.devices().snapshot(&target).await.unwrap();
    assert_eq!(state.state, SessionState::Closed);
    assert_eq!(state.tx_gate, TxGate::ControlUnknown);
    assert_eq!(h.probe.close_calls.load(Ordering::SeqCst), 1);
    assert_eq!(h.probe.closes.load(Ordering::SeqCst), 1);
    h.host.shutdown().await.unwrap();
}

// Break caught: reconnect resets totals, starts duration before native open, or keeps duration running after disconnect.
#[tokio::test]
async fn reconnect_preserves_totals_and_restarts_only_connection_duration() {
    let h = Harness::new().await;
    let first = h.open("observability-reconnect").await;
    h.send(&first).await;
    h.clock.advance_ms(750);
    h.probe.read_fails.store(true, Ordering::SeqCst);
    support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
    let disconnected = metrics(&h, &h.actor, &first).await;
    assert_eq!(disconnected["connectionDurationMs"], "750");
    assert_eq!(disconnected["rxReadErrors"], "1");
    h.clock.advance_ms(2250);
    assert_eq!(
        metrics(&h, &h.actor, &first).await["connectionDurationMs"],
        "750"
    );
    h.probe.read_fails.store(false, Ordering::SeqCst);
    let second = h.open("observability-reconnect").await;
    assert_eq!(first.id, second.id);
    assert_ne!(first.session_epoch, second.session_epoch);
    h.clock.advance_ms(20);
    let reconnected = metrics(&h, &h.actor, &second).await;
    assert_eq!(reconnected["txAcceptedBytes"], "5");
    assert_eq!(reconnected["rxReadErrors"], "1");
    assert_eq!(reconnected["connectionDurationMs"], "20");
    assert_eq!(reconnected["txAcceptedBytesPerSecond"], "0");
    let stale = h
        .host
        .query(
            &h.actor,
            query(&h.store, &h.actor, &first, "session.metrics"),
        )
        .await;
    assert_eq!(stale.unwrap_err().code, "EPOCH_MISMATCH");
    h.host.shutdown().await.unwrap();
}

#[derive(Default)]
struct InputProbe {
    mask: AtomicUsize,
    error: Mutex<Option<&'static str>>,
    read_gate: Mutex<Option<Arc<support::Gate>>>,
    rx: AtomicUsize,
    samples: AtomicUsize,
}
struct InputTransport {
    inner: VirtualTransport,
    probe: Arc<InputProbe>,
    clock: Arc<ManualClock>,
}
impl Transport for InputTransport {
    fn capabilities(&self) -> TransportCapabilities {
        self.inner.capabilities()
    }
    fn read(&mut self, _: usize, _: Duration) -> BackendResult<ReadBlock> {
        let gate = self.probe.read_gate.lock().unwrap().take();
        if let Some(gate) = gate {
            gate.hold();
        }
        Ok(ReadBlock {
            bytes: vec![7; self.probe.rx.swap(0, Ordering::SeqCst)].into(),
            message: None,
        })
    }
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        self.inner.begin_write(bytes, wait, cancelled, closing)
    }
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        self.inner.configure(config)
    }
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        if matches!(command, ControlCommand::ModemStatus) {
            self.probe.samples.fetch_add(1, Ordering::SeqCst);
            self.clock.advance_ms(7);
            if let Some(code) = *self.probe.error.lock().unwrap() {
                return Err(HostError::new(code, "scripted input failure").into());
            }
            let mask = self.probe.mask.load(Ordering::SeqCst);
            return Ok(ControlResult::Modem {
                cts: mask & 1 != 0,
                dsr: mask & 2 != 0,
                ring: mask & 4 != 0,
                carrier: mask & 8 != 0,
            });
        }
        self.inner.control(command)
    }
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        self.inner.begin_drain(request)
    }
    fn close(&mut self) -> BackendResult<()> {
        self.inner.close()
    }
}
struct InputHarness {
    _dir: tempfile::TempDir,
    store: Store,
    host: Host,
    actor: AuthenticatedActor,
    clock: Arc<ManualClock>,
    probe: Arc<InputProbe>,
    target: Target,
}
impl InputHarness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let store = Store::open_with_clock(dir.path(), clock.clone()).unwrap();
        let identity = store.begin_instance().unwrap();
        let auth = AuthService::with_clock(
            store.clone(),
            ContextToken::try_from("observability-secret").unwrap(),
            clock.clone(),
        );
        let actor = auth
            .authenticate(&id("read-only-observer"), None)
            .unwrap()
            .actor;
        let probe = Arc::new(InputProbe::default());
        let p = probe.clone();
        let c = clock.clone();
        let opener: TransportOpener = Arc::new(move |_, config| {
            c.advance_ms(40);
            Ok(Box::new(InputTransport {
                inner: VirtualTransport::new(config.clone()),
                probe: p.clone(),
                clock: c.clone(),
            }))
        });
        let host = Host::with_runtime(store.clone(), auth, clock.clone(), opener)
            .await
            .unwrap();
        let device = Target {
            host_id: identity.host_id,
            kind: ResourceKind::try_from("device").unwrap(),
            id: id("observability-inputs"),
            session_id: None,
            session_epoch: None,
        };
        let opened = host
            .devices()
            .open(
                &device,
                OpenParams {
                    binding: None,
                    configuration: SerialConfiguration::default(),
                },
            )
            .await
            .unwrap();
        let target = Target {
            host_id: device.host_id,
            kind: ResourceKind::try_from("session").unwrap(),
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
        };
        Self {
            _dir: dir,
            store,
            host,
            actor,
            clock,
            probe,
            target,
        }
    }
    async fn sample(&self) -> HostResult<QueryResult> {
        self.host
            .query(
                &self.actor,
                query(&self.store, &self.actor, &self.target, "session.inputs"),
            )
            .await
    }
}

// Break caught: returning DTR/RTS values, stale cache, query-time timestamps, or requiring a write lease.
#[tokio::test]
async fn public_inputs_sample_all_bits_at_owner_time_without_write_authority() {
    let h = InputHarness::new().await;
    for mask in 0..16 {
        h.probe.mask.store(mask, Ordering::SeqCst);
        let result = h.sample().await;
        assert!(
            result.is_ok(),
            "read-only public input sampling: {result:?}"
        );
        let wire = serde_json::to_value(result.unwrap()).unwrap();
        assert_eq!(wire["kind"], "session_inputs");
        let value = &wire["value"];
        assert_eq!(value["sessionId"], h.target.id.as_str());
        assert_eq!(value["sessionEpoch"], "1");
        assert_eq!(value["cts"], mask & 1 != 0);
        assert_eq!(value["dsr"], mask & 2 != 0);
        assert_eq!(value["ri"], mask & 4 != 0);
        assert_eq!(value["cd"], mask & 8 != 0);
        assert_eq!(
            value["sampledMonoNs"],
            (40_000_000 + (mask + 1) * 7_000_000).to_string()
        );
        assert_eq!(value["sampledAt"], "2026-11-07T00:00:00Z");
    }
    assert_eq!(h.host.activity_count(), 0);
    assert!(
        h.host
            .devices()
            .snapshot(&h.target)
            .await
            .unwrap()
            .lease
            .is_none()
    );
    h.host.shutdown().await.unwrap();
}

// Break caught: masking backend errors with an older successful modem sample.
#[tokio::test]
async fn inputs_propagate_backend_failure_and_reject_old_epoch() {
    let h = InputHarness::new().await;
    let initial = h.sample().await;
    assert!(
        initial.is_ok(),
        "initial sample must be available: {initial:?}"
    );
    for code in ["UNSUPPORTED_CAPABILITY", "BACKEND_IO"] {
        *h.probe.error.lock().unwrap() = Some(code);
        assert_eq!(h.sample().await.unwrap_err().code, code);
    }
    let mut stale = h.target.clone();
    stale.session_epoch = Some(0.into());
    let before = h.probe.samples.load(Ordering::SeqCst);
    let result = h
        .host
        .query(
            &h.actor,
            query(&h.store, &h.actor, &stale, "session.inputs"),
        )
        .await;
    assert_eq!(result.unwrap_err().code, "EPOCH_MISMATCH");
    assert_eq!(h.probe.samples.load(Ordering::SeqCst), before);
    h.host.shutdown().await.unwrap();
}

// Break caught: observable RX is counted only when a client reads its stream, or duration includes opener time.
#[tokio::test]
async fn rx_metrics_are_counted_before_any_observer_and_expire_when_idle() {
    let h = InputHarness::new().await;
    h.probe.rx.store(13, Ordering::SeqCst);
    support::until(|| h.probe.rx.load(Ordering::SeqCst) == 0).await;
    // A sample is an owner barrier after the RX read has completed.
    let barrier = h.sample().await;
    assert!(barrier.is_ok(), "owner sample barrier: {barrier:?}");
    let result = h
        .host
        .query(
            &h.actor,
            query(&h.store, &h.actor, &h.target, "session.metrics"),
        )
        .await;
    assert!(result.is_ok(), "public RX metrics: {result:?}");
    let value = serde_json::to_value(result.unwrap()).unwrap()["value"].clone();
    assert_eq!(value["rxBytes"], "13");
    assert_eq!(value["rxBytesPerSecond"], "13");
    assert_eq!(value["connectionDurationMs"], "7");
    h.clock.advance_ms(1000);
    let value = serde_json::to_value(
        h.host
            .query(
                &h.actor,
                query(&h.store, &h.actor, &h.target, "session.metrics"),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(value["value"]["rxBytesPerSecond"], "0");
    assert_eq!(value["value"]["rxBytes"], "13");
    h.host.shutdown().await.unwrap();
}

// Break caught: queued cancellation is misclassified as physical write failure.
#[tokio::test]
async fn cancellation_before_dispatch_does_not_count_as_a_write_error() {
    let h = Harness::new().await;
    let target = h.open("observability-cancel").await;
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
    h.cancel(&queued).await;
    gate.release();
    h.wait(&first.operation_id).await;
    h.wait(&queued.operation_id).await;
    let value = metrics(&h, &h.actor, &target).await;
    assert_eq!(value["txAcceptedBytes"], "5");
    assert_eq!(value["txUnknownBytes"], "0");
    assert_eq!(value["txWriteErrors"], "0");
    h.host.shutdown().await.unwrap();
}

// Break caught: sampling fills all owner slots or a cancelled sample still touches the backend.
#[tokio::test]
async fn sampling_is_bounded_and_cancelled_query_releases_without_blocking_control_or_close() {
    let h = InputHarness::new().await;
    let gate = Arc::new(support::Gate::default());
    *h.probe.read_gate.lock().unwrap() = Some(gate.clone());
    gate.entered().await;
    let mut first = Box::pin(h.sample());
    assert!(
        tokio::time::timeout(Duration::from_millis(10), first.as_mut())
            .await
            .is_err(),
        "first sample must be queued behind current read"
    );
    for _ in 0..12 {
        let result = tokio::time::timeout(Duration::from_millis(100), h.sample())
            .await
            .expect("sampling flood must reject promptly");
        assert_eq!(result.unwrap_err().code, "HOST_BUSY");
    }
    let mut queue = Box::pin(h.host.query(
        &h.actor,
        query(&h.store, &h.actor, &h.target, "tx.queueStatus"),
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(10), queue.as_mut())
            .await
            .is_err(),
        "normal queue query must retain capacity"
    );
    drop(first);
    gate.release();
    assert!(
        tokio::time::timeout(Duration::from_secs(1), queue)
            .await
            .unwrap()
            .is_ok()
    );
    assert_eq!(
        h.probe.samples.load(Ordering::SeqCst),
        0,
        "cancelled sample never reaches modem read"
    );
    assert!(h.sample().await.is_ok());
    tokio::time::timeout(Duration::from_secs(1), h.host.shutdown())
        .await
        .unwrap()
        .unwrap();
}
