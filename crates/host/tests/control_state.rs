mod support;
use serial_workbench_core::*;
use std::sync::atomic::Ordering;

#[derive(Default)]
struct ControlProbe {
    commands: std::sync::Mutex<Vec<ControlCommand>>,
    writes: std::sync::atomic::AtomicUsize,
    configure_error: std::sync::atomic::AtomicBool,
    write_gate: std::sync::Mutex<Option<std::sync::Arc<support::Gate>>>,
    assert_gate: std::sync::Mutex<Option<std::sync::Arc<support::Gate>>>,
    purge_ranges: std::sync::Mutex<Vec<DirectionalRange>>,
}
struct ControlTransport(std::sync::Arc<ControlProbe>);
impl Transport for ControlTransport {
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
            bytes: std::sync::Arc::from([]),
            message: None,
        })
    }
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        _: std::time::Duration,
        _: std::sync::Arc<std::sync::atomic::AtomicBool>,
        _: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        self.0.writes.fetch_add(1, Ordering::SeqCst);
        let gate = self.0.write_gate.lock().unwrap().take();
        Ok(support::pending_write(
            BackendWrite {
                accepted_ranges: vec![ByteRange {
                    start: 0.into(),
                    end: (bytes.len() as u64).into(),
                }],
                unknown_ranges: vec![],
                error: None,
            },
            gate,
        ))
    }
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        if self.0.configure_error.load(Ordering::SeqCst) {
            // 后端可能已应用部分字段，错误本身不能证明未修改硬件。
            return Err(HostError::new(
                "BACKEND_CONFIGURATION",
                "Configuration stopped after hardware change",
            )
            .into());
        }
        let readback: JsonObject =
            serde_json::from_value(serde_json::to_value(config).unwrap()).unwrap();
        Ok(ConfigApplication {
            fields: readback
                .iter()
                .map(|(field, actual)| ConfigField {
                    field: field.clone(),
                    status: FieldStatus::Applied,
                    actual: Some(actual.clone()),
                })
                .collect(),
            readback,
        })
    }
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        self.0.commands.lock().unwrap().push(command.clone());
        Ok(match command {
            ControlCommand::Purge { .. } => ControlResult::Purged {
                ranges: self.0.purge_ranges.lock().unwrap().clone(),
                unknown_extent: true,
            },
            ControlCommand::SetLine { line, value } => ControlResult::Line { line, value },
            ControlCommand::AssertBreak => {
                if let Some(gate) = self.0.assert_gate.lock().unwrap().take() {
                    gate.hold();
                }
                ControlResult::Break { asserted: true }
            }
            ControlCommand::ClearBreak => ControlResult::Break { asserted: false },
            ControlCommand::QueueStatus => ControlResult::Queue {
                pending_bytes: 0.into(),
            },
            ControlCommand::ModemStatus => {
                return Err(HostError::new("UNSUPPORTED_CAPABILITY", "No modem inputs").into());
            }
        })
    }
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        serial_workbench_host::device::virtual_backend::VirtualTransport::new(
            SerialConfiguration::default(),
        )
        .begin_drain(request)
    }
    fn close(&mut self) -> BackendResult<()> {
        Ok(())
    }
}
async fn control_harness() -> (support::Harness, std::sync::Arc<ControlProbe>) {
    let mut h = support::Harness::new().await;
    h.host.shutdown().await.unwrap();
    let probe = std::sync::Arc::new(ControlProbe::default());
    let p = probe.clone();
    h.host = serial_workbench_host::Host::with_runtime(
        h.store.clone(),
        h.auth.clone(),
        h.clock.clone(),
        std::sync::Arc::new(move |_, _| Ok(Box::new(ControlTransport(p.clone())))),
    )
    .await
    .unwrap();
    (h, probe)
}

#[tokio::test]
async fn configuration_error_retains_unknown_receipt_boundary_and_closed_gate() {
    let (h, probe) = control_harness().await;
    let target = h.open("configuration-error").await;
    probe.configure_error.store(true, Ordering::SeqCst);
    let config = SerialConfiguration {
        parity: Parity::Even,
        ..Default::default()
    };
    let mut call = h.call(
        &target,
        "session.configure",
        serde_json::json!({"requested":config}),
    );
    call.expected_revision = Some(1.into());
    let op = h.invoke(call).await;
    let done = h.wait(&op.operation_id).await;
    assert_eq!(done.state, OperationState::Unknown);
    let receipt = match done.result {
        Some(ActionResult::Configuration(v)) => v,
        other => panic!("Missing configuration evidence: {other:?}"),
    };
    assert_eq!(receipt.tx_gate, TxGate::ConfigurationPending);
    assert_eq!(receipt.revision, 2.into());
    assert!(receipt.boundary_event_seq.get() > 0);
    assert!(receipt.readback.is_empty());
    assert_eq!(
        receipt.fields.len(),
        serde_json::to_value(&receipt.requested)
            .unwrap()
            .as_object()
            .unwrap()
            .len()
    );
    assert!(
        receipt
            .fields
            .iter()
            .all(|f| f.status == FieldStatus::Unknown && f.actual.is_none())
    );
    assert_eq!(
        h.host
            .devices()
            .snapshot(&target)
            .await
            .unwrap()
            .configuration_revision,
        receipt.revision
    );
    let persisted = h
        .store
        .read_document(&support::id("device:configuration-error"))
        .unwrap()
        .unwrap();
    let snapshot: SessionSnapshot =
        serde_json::from_value(serde_json::to_value(persisted.value).unwrap()).unwrap();
    assert_eq!(snapshot.revision, 2.into());
    assert_eq!(snapshot.configuration_revision, receipt.revision);
    assert_eq!(snapshot.configuration, SerialConfiguration::default());
    assert_eq!(snapshot.tx_gate, TxGate::ConfigurationPending);
    let prepared = h
        .host
        .streams()
        .read_prepared(
            &h.actor,
            StreamReadParams {
                session_id: target.id.clone(),
                session_epoch: target.session_epoch.unwrap(),
                start_event_seq: 1.into(),
                max_events: 100.into(),
                max_bytes: (256 * 1024).into(),
            },
        )
        .await
        .unwrap();
    let (page, _lease) = prepared.into_parts();
    assert!(page.events.iter().any(|event| event.event_seq==receipt.boundary_event_seq && event.configuration_revision==receipt.revision
        && matches!(&event.payload, RawPayload::ConfigurationBoundary(v) if v.revision==U64::from(2) && v.certainty==Certainty::Uncertain && v.receipt_ref.id==op.operation_id)));
    assert_eq!(
        support::receipt(&h.send(&target).await).outcome,
        TxOutcome::Rejected
    );
    assert_eq!(probe.writes.load(Ordering::SeqCst), 0);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn application_rx_purge_does_not_clear_driver_buffers() {
    let (h, probe) = control_harness().await;
    let target = h.open("rx-application").await;
    let done = h
        .action(
            &target,
            "session.purge",
            serde_json::json!({"direction":"rx","scope":"application"}),
        )
        .await;
    assert!(
        probe.commands.lock().unwrap().is_empty(),
        "Application purge reached driver"
    );
    assert!(
        matches!(done.result, Some(ActionResult::Purged(v)) if v.outcome==PurgeOutcome::Completed && !v.unknown_extent && v.affected_operation_ids.is_empty())
    );
    let driver = h
        .action(
            &target,
            "session.purge",
            serde_json::json!({"direction":"rx","scope":"driver"}),
        )
        .await;
    assert!(
        matches!(driver.result, Some(ActionResult::Purged(v)) if v.outcome==PurgeOutcome::Unknown && v.unknown_extent && v.ranges.is_empty())
    );
    assert_eq!(probe.commands.lock().unwrap().len(), 1);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn both_purge_retains_application_operations_and_driver_extent() {
    let (h, probe) = control_harness().await;
    let target = h.open("both-purge").await;
    let gate = std::sync::Arc::new(support::Gate::default());
    *probe.write_gate.lock().unwrap() = Some(gate.clone());
    let range = DirectionalRange {
        direction: Direction::Tx,
        start: 3.into(),
        end: 5.into(),
    };
    *probe.purge_ranges.lock().unwrap() = vec![range.clone()];
    let first = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    gate.entered().await;
    let second = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    wait_intent(&h, &target, &second.operation_id).await;
    let purge = h
        .invoke(h.call(
            &target,
            "session.purge",
            serde_json::json!({"direction":"tx","scope":"both"}),
        ))
        .await;
    let second = h.wait(&second.operation_id).await;
    gate.release();
    let done = h.wait(&purge.operation_id).await;
    let first = h.wait(&first.operation_id).await;
    h.host.shutdown().await.unwrap();
    assert_eq!(support::receipt(&first).outcome, TxOutcome::Accepted);
    assert_eq!(support::receipt(&second).outcome, TxOutcome::Rejected);
    assert!(
        matches!(done.result, Some(ActionResult::Purged(ref v)) if v.affected_operation_ids==vec![second.operation_id] && v.ranges==vec![range] && v.unknown_extent && v.outcome==PurgeOutcome::Unknown)
    );
    assert_eq!(probe.writes.load(Ordering::SeqCst), 1);
}

fn operator(h: &support::Harness) -> serial_workbench_host::auth::AuthenticatedActor {
    h.auth
        .authenticate_user_control(
            &support::id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap()
}
async fn wait_as(
    h: &support::Harness,
    actor: &serial_workbench_host::auth::AuthenticatedActor,
    id: &Id,
) -> Operation {
    support::until(|| support::terminal(h.store.get(actor, id).unwrap().state)).await;
    h.store.get(actor, id).unwrap()
}
async fn wait_intent(h: &support::Harness, target: &Target, id: &Id) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let prepared = h
                .host
                .streams()
                .read_prepared(
                    &h.actor,
                    StreamReadParams {
                        session_id: target.id.clone(),
                        session_epoch: target.session_epoch.unwrap(),
                        start_event_seq: 1.into(),
                        max_events: 100.into(),
                        max_bytes: (256 * 1024).into(),
                    },
                )
                .await
                .unwrap();
            let (page, _lease) = prepared.into_parts();
            if page.events.iter().any(
                |event| matches!(&event.payload, RawPayload::TxIntent(v) if &v.operation_id==id),
            ) {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn targeted_takeover_waits_for_a_and_preserves_b_lease_and_reauthorization() {
    let h = support::Harness::new().await;
    let target = h.open("takeover-target").await;
    let other = h.open("takeover-unrelated").await;
    let b = h.new_actor("actor-b");
    let operator = operator(&h);
    let lease = h
        .host
        .invoke(
            &b,
            h.call_as(
                &b,
                &other,
                "lease.acquire",
                serde_json::json!({"kind":"exclusive","ttlMs":"30000"}),
            ),
        )
        .await
        .unwrap();
    support::until(|| {
        h.store
            .get(&b, &lease.operation_id)
            .unwrap()
            .result
            .is_some()
    })
    .await;
    let gate = std::sync::Arc::new(support::Gate::default());
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
    let second = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    let other_tx = h
        .host
        .invoke(
            &b,
            h.call_as(
                &b,
                &target,
                "session.tx",
                serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
            ),
        )
        .await
        .unwrap();
    wait_intent(&h, &target, &second.operation_id).await;
    wait_intent(&h, &target, &other_tx.operation_id).await;
    let takeover = h
        .host
        .invoke(
            &operator,
            h.call_as(
                &operator,
                &target,
                "session.takeover",
                serde_json::json!({"actorId":h.actor.id(),"reason":"user"}),
            ),
        )
        .await
        .unwrap();
    support::until(|| {
        h.store
            .get(&operator, &takeover.operation_id)
            .unwrap()
            .state
            != OperationState::Queued
    })
    .await;
    // Running precedes the takeover's token snapshot and authorization revocation.
    // Keep the write blocked until revocation proves that snapshot has happened.
    support::until(|| h.auth.require(&h.actor, "device.modify", &target).is_err()).await;
    let waited = !support::terminal(
        h.store
            .get(&operator, &takeover.operation_id)
            .unwrap()
            .state,
    );
    gate.release();
    let done = wait_as(&h, &operator, &takeover.operation_id).await;
    let revoked = h.auth.require(&h.actor, "device.modify", &target).is_err();
    let first = h.wait(&first.operation_id).await;
    let second = h.wait(&second.operation_id).await;
    let b_done = wait_as(&h, &b, &other_tx.operation_id).await;
    let lease_running =
        h.store.get(&b, &lease.operation_id).unwrap().state == OperationState::Running;
    let ids = match done.result {
        Some(ActionResult::Takeover(v)) => v.affected_operation_ids,
        other => panic!("{other:?}"),
    };
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: support::id("client"),
                permissions: vec!["device.modify".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let fresh = h.send(&target).await;
    h.host.shutdown().await.unwrap();
    assert!(revoked, "Takeover did not revoke target actor");
    assert!(waited, "Takeover returned before started write settled");
    assert!(ids.contains(&first.operation_id) && ids.contains(&second.operation_id));
    assert!(!ids.contains(&other_tx.operation_id));
    assert_eq!(support::receipt(&first).outcome, TxOutcome::Accepted);
    assert_eq!(support::receipt(&second).outcome, TxOutcome::Rejected);
    assert_eq!(support::receipt(&b_done).outcome, TxOutcome::Accepted);
    assert!(lease_running);
    assert_eq!(support::receipt(&fresh).outcome, TxOutcome::Accepted);
}

#[tokio::test]
async fn takeover_preserves_unknown_break_cleanup_instead_of_claiming_success() {
    let h = support::Harness::new().await;
    let target = h.open("takeover-break").await;
    let operator = operator(&h);
    h.probe.clear_fails.store(true, Ordering::SeqCst);
    let pulse = h
        .invoke(h.call(
            &target,
            "session.break",
            serde_json::json!({"durationMs":"100"}),
        ))
        .await;
    support::until(|| h.probe.break_asserted.load(Ordering::SeqCst)).await;
    let takeover = h
        .host
        .invoke(
            &operator,
            h.call_as(
                &operator,
                &target,
                "session.takeover",
                serde_json::json!({"actorId":h.actor.id(),"reason":"user"}),
            ),
        )
        .await
        .unwrap();
    let done = wait_as(&h, &operator, &takeover.operation_id).await;
    let pulse = h.wait(&pulse.operation_id).await;
    let gate = h.host.devices().snapshot(&target).await.unwrap().tx_gate;
    let shutdown = h.host.shutdown().await.unwrap_err();
    assert_eq!(shutdown.code, "SHUTDOWN_INCOMPLETE");
    let report: ShutdownReport =
        serde_json::from_value(serde_json::to_value(shutdown.details.unwrap()).unwrap()).unwrap();
    assert_eq!(report.mode, ShutdownMode::CancelAndSettle);
    assert_eq!(report.excluded_operation_id, None);
    assert!(!report.completed);
    assert!(report.unsettled_operation_ids.is_empty());
    assert_eq!(report.quarantined_sessions, vec![target.clone()]);
    assert!(
        matches!(pulse.result, Some(ActionResult::Break(ref v)) if v.clear.status==ControlStatus::Failed)
    );
    assert_eq!(gate, TxGate::ControlUnknown);
    assert_eq!(done.state, OperationState::Unknown);
    assert!(
        matches!(done.result, Some(ActionResult::Takeover(ref v)) if v.affected_operation_ids.contains(&pulse.operation_id))
    );
    assert_eq!(h.probe.clear_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn break_revocation_then_regrant_clears_without_resuming_the_old_operation() {
    let (h, probe) = control_harness().await;
    let target = h.open("break-regrant").await;
    let gate = std::sync::Arc::new(support::Gate::default());
    *probe.assert_gate.lock().unwrap() = Some(gate.clone());
    let pulse = h
        .invoke(h.call(
            &target,
            "session.break",
            serde_json::json!({"durationMs":"100"}),
        ))
        .await;
    gate.entered().await;
    let document = h
        .store
        .read_document(&support::id("device:break-regrant"))
        .unwrap()
        .unwrap();
    let responsible: SessionSnapshot =
        serde_json::from_value(serde_json::to_value(document.value).unwrap()).unwrap();
    let operator = operator(&h);
    h.auth
        .revoke(
            &operator,
            RevokeParams {
                actor_id: h.actor.id().clone(),
                permissions: vec!["device.modify".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: support::id("client"),
                permissions: vec!["device.modify".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    gate.release();
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if h.host
                .devices()
                .snapshot(&target)
                .await
                .unwrap()
                .control_state
                == ControlState::Asserted
                || support::terminal(h.store.get(&h.actor, &pulse.operation_id).unwrap().state)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    h.clock.advance_ms(100);
    let done = h.wait(&pulse.operation_id).await;
    let snapshot = h.host.devices().snapshot(&target).await.unwrap();
    let commands = probe.commands.lock().unwrap().clone();
    h.host.shutdown().await.unwrap();
    assert_eq!(responsible.control_state, ControlState::Asserting);
    assert_eq!(responsible.tx_gate, TxGate::ControlUnknown);
    assert_eq!(done.state, OperationState::Cancelled);
    assert!(
        matches!(done.result, Some(ActionResult::Break(ref v)) if v.clear.status==ControlStatus::Confirmed)
    );
    assert_eq!(
        commands
            .iter()
            .filter(|v| matches!(v, ControlCommand::ClearBreak))
            .count(),
        1
    );
    assert_eq!(snapshot.tx_gate, TxGate::Ready);
}
#[tokio::test]
async fn partial_configuration_closes_gate_until_full_confirmed_configuration() {
    let h = support::Harness::new().await;
    let target = h.open("config").await;
    h.probe.partial_configuration.store(true, Ordering::SeqCst);
    let config = SerialConfiguration {
        parity: Parity::Even,
        ..Default::default()
    };
    let mut call = h.call(
        &target,
        "session.configure",
        serde_json::json!({"requested":config}),
    );
    call.expected_revision = Some(1.into());
    let initial = h.invoke(call).await;
    let op = h.wait(&initial.operation_id).await;
    assert!(
        matches!(op.result,Some(ActionResult::Configuration(ref v)) if v.tx_gate==TxGate::ConfigurationPending && v.revision==U64::from(2))
    );
    let snapshot = h.host.devices().snapshot(&target).await.unwrap();
    assert_eq!(snapshot.configuration_revision, 2.into());
    assert_eq!(snapshot.configuration, SerialConfiguration::default());
    let tx = h.send(&target).await;
    assert_eq!(support::receipt(&tx).outcome, TxOutcome::Rejected);
    assert_eq!(h.write_count(), 0);
    h.probe.partial_configuration.store(false, Ordering::SeqCst);
    let mut call = h.call(
        &target,
        "session.configure",
        serde_json::json!({"requested":config}),
    );
    call.expected_revision = Some(2.into());
    let op = h.invoke(call).await;
    h.wait(&op.operation_id).await;
    assert_eq!(
        support::receipt(&h.send(&target).await).outcome,
        TxOutcome::Accepted
    );
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn break_clear_failure_isolates_transmission_and_prevents_reopen() {
    let h = support::Harness::new().await;
    let target = h.open("break").await;
    h.probe.clear_fails.store(true, Ordering::SeqCst);
    let op = h
        .invoke(h.call(
            &target,
            "session.break",
            serde_json::json!({"durationMs":"10"}),
        ))
        .await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if h.host
                .devices()
                .snapshot(&target)
                .await
                .unwrap()
                .control_state
                == ControlState::Asserted
            {
                break;
            }
            let store = h.store.clone();
            let actor = h.actor.clone();
            let id = op.operation_id.clone();
            let operation = tokio::task::spawn_blocking(move || store.get(&actor, &id))
                .await
                .unwrap()
                .unwrap();
            if support::terminal(operation.state) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    h.clock.advance_ms(10);
    let done = h.wait(&op.operation_id).await;
    assert!(
        matches!(done.result,Some(ActionResult::Break(ref v)) if v.clear.status==ControlStatus::Failed)
    );
    assert_eq!(
        h.host.devices().snapshot(&target).await.unwrap().tx_gate,
        TxGate::ControlUnknown
    );
    assert_eq!(
        support::receipt(&h.send(&target).await).outcome,
        TxOutcome::Rejected
    );
    assert_eq!(
        h.host
            .devices()
            .open(
                &h.device("break"),
                OpenParams {
                    binding: None,
                    configuration: SerialConfiguration::default()
                }
            )
            .await
            .unwrap_err()
            .code,
        "CONTROL_UNKNOWN"
    );
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    assert_eq!(h.write_count(), 0);
    let shutdown = h.host.shutdown().await.unwrap_err();
    assert_eq!(shutdown.code, "SHUTDOWN_INCOMPLETE");
    let report: ShutdownReport =
        serde_json::from_value(serde_json::to_value(shutdown.details.unwrap()).unwrap()).unwrap();
    assert_eq!(report.mode, ShutdownMode::CancelAndSettle);
    assert_eq!(report.excluded_operation_id, None);
    assert!(!report.completed);
    assert!(report.unsettled_operation_ids.is_empty());
    assert_eq!(report.quarantined_sessions, vec![target]);
}

#[tokio::test]
async fn read_only_requires_explicit_revision_checked_release() {
    let h = support::Harness::new().await;
    let target = h.open("readonly").await;
    let mut call = h.call(
        &target,
        "session.setReadOnly",
        serde_json::json!({"readOnly":true}),
    );
    call.expected_revision = Some(1.into());
    let op = h.invoke(call).await;
    assert!(
        matches!(h.wait(&op.operation_id).await.result,Some(ActionResult::Session(v)) if v.read_only)
    );
    assert_eq!(
        support::receipt(&h.send(&target).await).outcome,
        TxOutcome::Rejected
    );
    for (action, params) in [
        (
            "session.control",
            serde_json::json!({"line":"dtr","value":true}),
        ),
        ("session.break", serde_json::json!({"durationMs":"1"})),
        ("tx.drain", serde_json::json!({"writeWaitMs":"1"})),
        (
            "session.purge",
            serde_json::json!({"direction":"tx","scope":"application"}),
        ),
    ] {
        assert_eq!(
            h.action(&target, action, params).await.error.unwrap().code,
            "READ_ONLY"
        );
    }
    let mut call = h.call(
        &target,
        "session.setReadOnly",
        serde_json::json!({"readOnly":false}),
    );
    call.expected_revision = Some(2.into());
    let op = h.invoke(call).await;
    h.wait(&op.operation_id).await;
    assert_eq!(
        support::receipt(&h.send(&target).await).outcome,
        TxOutcome::Accepted
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn lease_ttl_queue_wait_and_write_wait_have_independent_fake_clock_origins() {
    let h = support::Harness::new().await;
    let target = h.open("deadlines").await;
    let acquire = h
        .invoke(h.call(
            &target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"20"}),
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
    let lease = match h
        .store
        .get(&h.actor, &acquire.operation_id)
        .unwrap()
        .result
        .unwrap()
    {
        ActionResult::Lease(v) => v,
        other => panic!("{other:?}"),
    };
    let queued = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"7","queueWaitMs":"5"}),
        ))
        .await;
    wait_intent(&h, &target, &queued.operation_id).await;
    // 观察该操作的真实源意图后推进时钟，不把缓存元数据当成已排队证据。
    h.clock.advance_ms(5);
    let expired_queue = h.wait(&queued.operation_id).await;
    assert_eq!(
        support::receipt(&expired_queue)
            .backend_error
            .as_ref()
            .unwrap()
            .code,
        "QUEUE_TIMEOUT"
    );
    assert_eq!(h.write_count(), 0);
    h.clock.advance_ms(15);
    let released = h.wait(&acquire.operation_id).await;
    assert!(matches!(released.result,Some(ActionResult::Lease(v)) if v.state==LeaseState::Expired));
    let renew = h
        .action(
            &target,
            "lease.renew",
            serde_json::json!({"leaseId":lease.lease_id,"ttlMs":"20"}),
        )
        .await;
    assert_eq!(renew.error.unwrap().code, "LEASE_EXPIRED");
    let done = h
        .action(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"7"}),
        )
        .await;
    assert_eq!(support::receipt(&done).outcome, TxOutcome::Accepted);
    assert_eq!(
        h.probe.writes.lock().unwrap()[0].2,
        std::time::Duration::from_millis(7)
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn application_purge_and_cancelled_boundary_preserve_already_started_tx() {
    let h = support::Harness::new().await;
    let target = h.open("purge").await;
    let gate = std::sync::Arc::new(support::Gate::default());
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
    let second = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    let boundary = h
        .invoke(h.call(
            &target,
            "tx.waitBoundary",
            serde_json::json!({"throughOperationId":first.operation_id,"queueWaitMs":"100"}),
        ))
        .await;
    h.cancel(&boundary).await;
    let purge = h
        .action(
            &target,
            "session.purge",
            serde_json::json!({"direction":"tx","scope":"application"}),
        )
        .await;
    assert!(matches!(purge.result, Some(ActionResult::Purged(_))));
    gate.release();
    assert_eq!(
        support::receipt(&h.wait(&first.operation_id).await).outcome,
        TxOutcome::Accepted
    );
    assert_eq!(
        support::receipt(&h.wait(&second.operation_id).await).outcome,
        TxOutcome::Rejected
    );
    assert_eq!(h.write_count(), 1);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn active_lease_is_published_before_its_operation_finishes() {
    let h = support::Harness::new().await;
    let target = h.open("lease-projection").await;
    let acquire = h
        .invoke(h.call(
            &target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"30000"}),
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
    let snapshot = h.host.devices().snapshot(&target).await.unwrap();
    let operation = h.store.get(&h.actor, &acquire.operation_id).unwrap();
    h.host.shutdown().await.unwrap();
    assert_eq!(operation.state, OperationState::Running);
    assert!(matches!(
        snapshot.lease,
        Some(Lease {
            state: LeaseState::Active,
            ..
        })
    ));
}
