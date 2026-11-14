//! Real Host barriers; independent-process exit is covered by process scenarios.
mod support;

use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    device::TransportOpener,
    ipc::{HostServer, InstanceGuard},
    storage::Store,
};
use std::{sync::atomic::Ordering, time::Duration};
use tokio::sync::oneshot;

fn operator(h: &support::Harness) -> AuthenticatedActor {
    h.auth
        .authenticate_user_control(
            &support::id("client"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap()
}

fn host_target(h: &support::Harness) -> Target {
    Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: h.host_id.clone(),
        session_id: None,
        session_epoch: None,
    }
}

#[tokio::test]
async fn settle_closes_admission_and_retains_the_accepted_write_until_its_receipt() {
    let h = support::Harness::new().await;
    let target = h.open("shutdown-settle").await;
    let gate = std::sync::Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let operation = h
        .invoke(h.call(
            &target,
            "session.tx",
            json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    gate.entered().await;
    let host = h.host.clone();
    let quiescing = tokio::spawn(async move { host.quiesce(ShutdownMode::Settle).await });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let rejected = h
        .host
        .invoke(
            &h.actor,
            h.call(
                &target,
                "session.tx",
                json!({"bytesBase64":"Bg==","writeWaitMs":"100"}),
            ),
        )
        .await;
    let still_waiting = !quiescing.is_finished();
    gate.release();
    let report = tokio::time::timeout(Duration::from_secs(6), quiescing)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let settled = h.wait(&operation.operation_id).await;
    assert_eq!(rejected.unwrap_err().code, "HOST_BUSY");
    assert!(still_waiting, "accepted native work must retain its owner");
    assert_eq!(support::receipt(&settled).outcome, TxOutcome::Accepted);
    assert!(report.completed, "{report:?}");
    assert!(report.unsettled_operation_ids.is_empty());
    assert!(report.quarantined_sessions.is_empty());
    assert!(report.failures.is_empty());
}

#[tokio::test]
async fn confirmed_close_allows_shutdown_without_rewriting_an_unknown_transmission() {
    let h = support::Harness::new().await;
    let target = h.open("shutdown-closed-unknown-write").await;
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 2,
        unknown: true,
        gate: None,
        advance_ms: 0,
    });
    let operation = h
        .invoke(h.call(
            &target,
            "session.tx",
            json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    let before = h.wait(&operation.operation_id).await;
    assert_eq!(before.state, OperationState::Unknown);
    assert_eq!(support::receipt(&before).outcome, TxOutcome::Unknown);
    let close = h.invoke(h.call(&target, "session.close", json!({}))).await;
    assert_eq!(
        h.wait(&close.operation_id).await.state,
        OperationState::Succeeded
    );
    assert_eq!(h.probe.closes.load(Ordering::SeqCst), 1);

    let report = h.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
    let after = h.wait(&operation.operation_id).await;
    assert_eq!(
        after, before,
        "shutdown must preserve the original unknown receipt"
    );
    assert_eq!(
        h.host.devices().snapshot(&target).await.unwrap().tx_gate,
        TxGate::ControlUnknown
    );
    assert!(
        report.completed,
        "confirmed cleanup must allow process exit: {report:?}"
    );
    assert!(report.quarantined_sessions.is_empty());
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancel_and_settle_reports_failed_clear_without_erasing_unknown_evidence() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let profile = dir.path().canonicalize().unwrap();
    serial_workbench_ipc::prepare_private_directory(&profile.join("host-v0")).unwrap();
    let h = support::Harness::in_profile(dir).await;
    let instance_guard = InstanceGuard::acquire(&profile).unwrap();
    let target = h.open("shutdown-break-unknown").await;
    h.probe.clear_fails.store(true, Ordering::SeqCst);
    let original_call = h.call(&target, "session.break", json!({"durationMs":"100"}));
    let operation = h.invoke(original_call.clone()).await;
    support::until(|| h.probe.break_asserted.load(Ordering::SeqCst)).await;
    let report = tokio::time::timeout(
        Duration::from_secs(6),
        h.host.quiesce(ShutdownMode::CancelAndSettle),
    )
    .await
    .unwrap()
    .unwrap();
    let settled = h.wait(&operation.operation_id).await;
    assert_eq!(settled.state, OperationState::Unknown, "{settled:?}");
    assert!(matches!(
        settled.result,
        Some(ActionResult::Break(ref receipt))
            if receipt.assert.status == ControlStatus::Confirmed
                && receipt.clear.status == ControlStatus::Failed
    ));
    assert_eq!(h.probe.clear_count.load(Ordering::SeqCst), 1);
    assert!(!report.completed);
    assert!(report.quarantined_sessions.contains(&target));
    assert!(report.evidence_refs.iter().any(|reference| {
        reference.kind.as_str() == "operation"
            && reference.id == operation.operation_id
            && reference.revision == Some(settled.revision)
    }));
    assert_eq!(
        h.host.devices().snapshot(&target).await.unwrap().tx_gate,
        TxGate::ControlUnknown
    );
    let writes_before = h.write_count();
    let opens_before = h.probe.opens.load(Ordering::SeqCst);
    let first_identity = h.store.identity().unwrap();
    assert_eq!(h.store.begin_instance().unwrap_err().code, "HOST_BUSY");
    assert_eq!(
        InstanceGuard::acquire(&profile).err().unwrap().code,
        "HOST_BUSY",
        "an incomplete barrier must keep the lifecycle owner's instance lock"
    );
    let support::Harness {
        dir,
        store,
        auth,
        actor,
        host,
        clock,
        probe,
        ..
    } = h;
    drop(host);
    drop(auth);
    drop(store);
    drop(instance_guard);
    let _restarted_guard = InstanceGuard::acquire(&profile).unwrap();
    let restarted_store = Store::open_with_clock(dir.path(), clock.clone()).unwrap();
    let second_identity = restarted_store.begin_instance().unwrap();
    assert_eq!(second_identity.host_id, first_identity.host_id);
    assert_eq!(
        second_identity.instance_epoch.get(),
        first_identity.instance_epoch.get() + 1
    );
    assert!(restarted_store.recover().unwrap().is_empty());
    let retained = restarted_store
        .get(&actor, &operation.operation_id)
        .unwrap();
    assert_eq!(retained.state, OperationState::Unknown);
    assert_eq!(retained.result, settled.result);
    let restarted_auth = AuthService::with_clock(
        restarted_store.clone(),
        ContextToken::try_from("test-user-control").unwrap(),
        clock.clone(),
    );
    let opening_probe = probe.clone();
    let opener: TransportOpener = std::sync::Arc::new(move |_, _| {
        opening_probe.opens.fetch_add(1, Ordering::SeqCst);
        Err(HostError::new("UNEXPECTED_REPLAY", "Recovery must not open a device").into())
    });
    let restarted_host = Host::with_runtime(restarted_store.clone(), restarted_auth, clock, opener)
        .await
        .unwrap();
    assert_eq!(
        restarted_host
            .invoke(&actor, original_call)
            .await
            .unwrap_err()
            .code,
        "EPOCH_MISMATCH"
    );
    assert_eq!(probe.opens.load(Ordering::SeqCst), opens_before);
    assert_eq!(probe.writes.lock().unwrap().len(), writes_before);
    restarted_host.shutdown().await.unwrap();
}

#[tokio::test]
async fn capture_finalizes_before_its_long_lived_host_operation_is_joined() {
    let h = support::Harness::new().await;
    let user_control = operator(&h);
    h.auth
        .authorize(
            &user_control,
            AuthorizeParams {
                client_id: support::id("client"),
                permissions: vec![
                    "metadata.read".into(),
                    "content.read".into(),
                    "device.modify".into(),
                    "workspace.modify".into(),
                ],
                targets: vec![host_target(&h)],
                expires_at: None,
            },
        )
        .unwrap();
    let target = h.open("shutdown-capture").await;
    let register = h
        .host
        .invoke(
            &user_control,
            h.call_as(
                &user_control,
                &host_target(&h),
                "file.register",
                json!({"path":h.dir.path().join("capture").to_str().unwrap(),"purpose":"capture_target"}),
            ),
        )
        .await
        .unwrap();
    let registered = wait_as(&h, &user_control, &register.operation_id, false).await;
    let Some(ActionResult::FileMetadata(metadata)) = registered.result else {
        panic!("expected registered capture destination: {registered:?}")
    };
    let reference_target = Target {
        host_id: h.host_id.clone(),
        id: metadata.file_ref.id.clone(),
        kind: metadata.file_ref.kind.clone(),
        session_id: None,
        session_epoch: None,
    };
    let mut call = h.call_as(
        &h.actor,
        &reference_target,
        "capture.start",
        json!({"sessionRefs":[target],"targetRef":metadata.file_ref,"overflowPolicy":"stop"}),
    );
    call.execution_mode = Some(ExecutionMode::Independent);
    let owner = h.host.invoke(&h.actor, call).await.unwrap();
    let active = wait_as(&h, &h.actor, &owner.operation_id, true).await;
    let Some(ActionResult::Reference(live)) = active.result else {
        panic!("expected live capture evidence: {active:?}")
    };
    assert_eq!(active.state, OperationState::Running);
    let report = tokio::time::timeout(Duration::from_secs(6), h.host.quiesce(ShutdownMode::Settle))
        .await
        .unwrap()
        .unwrap();
    let settled = wait_as(&h, &h.actor, &owner.operation_id, false).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let published = h.host.files().metadata(&live.result_ref, &h.actor).unwrap();
    assert!(published.file_ref.revision.is_some());
    assert!(report.evidence_refs.contains(&published.file_ref));
    assert!(report.completed, "{report:?}");
}

#[tokio::test]
async fn settle_budget_reports_live_native_work_and_retry_observes_the_same_owner() {
    let h = support::Harness::new().await;
    let target = h.open("shutdown-uncooperative-write").await;
    let gate = std::sync::Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let operation = h
        .invoke(h.call(
            &target,
            "session.tx",
            json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    gate.entered().await;
    let outcome =
        tokio::time::timeout(Duration::from_secs(6), h.host.quiesce(ShutdownMode::Settle)).await;
    // Release even when the assertion below fails, so a RED run owns its cleanup.
    gate.release();
    let report = outcome.unwrap().unwrap();
    assert!(!report.completed);
    assert!(
        report
            .unsettled_operation_ids
            .contains(&operation.operation_id)
    );
    let settled = h.wait(&operation.operation_id).await;
    assert_eq!(support::receipt(&settled).outcome, TxOutcome::Accepted);
    let retry = h.host.quiesce(ShutdownMode::Settle).await.unwrap();
    assert!(retry.completed, "{retry:?}");
    assert_eq!(h.write_count(), 1, "retry must not resubmit accepted work");
}

#[tokio::test]
async fn cancelling_a_native_write_retains_the_unknown_receipt_and_is_bounded() {
    let h = support::Harness::new().await;
    let target = h.open("shutdown-cancelled-native-write").await;
    let gate = std::sync::Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let operation = h
        .invoke(h.call(
            &target,
            "session.tx",
            json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ))
        .await;
    gate.entered().await;
    let outcome = tokio::time::timeout(
        Duration::from_secs(6),
        h.host.quiesce(ShutdownMode::CancelAndSettle),
    )
    .await;
    gate.release();
    let report = outcome.unwrap().unwrap();
    assert!(
        report.completed,
        "the completed backend cleanup must allow exit: {report:?}"
    );
    assert!(report.quarantined_sessions.is_empty());
    let settled = h.wait(&operation.operation_id).await;
    assert_eq!(settled.state, OperationState::Unknown);
    assert_eq!(support::receipt(&settled).outcome, TxOutcome::Unknown);
    assert!(!support::receipt(&settled).unknown_ranges.is_empty());
    assert_eq!(h.write_count(), 1);
    assert_eq!(h.probe.closes.load(Ordering::SeqCst), 1);
    h.host.shutdown().await.unwrap();
    assert_eq!(h.wait(&operation.operation_id).await, settled);
}

async fn wait_as(
    h: &support::Harness,
    actor: &AuthenticatedActor,
    id: &Id,
    evidence_only: bool,
) -> Operation {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let operation = h.store.get(actor, id).unwrap();
            if (evidence_only && operation.result.is_some())
                || (!evidence_only && support::terminal(operation.state))
            {
                return operation;
            }
            assert!(
                !evidence_only || !support::terminal(operation.state),
                "capture failed before live evidence: {operation:?}"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}

struct ClientShutdownFixture {
    _profile: tempfile::TempDir,
    host: Host,
    executor: HostClient,
    caller: HostClient,
    target: Target,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}

impl ClientShutdownFixture {
    async fn new(capability: ClientCapability) -> Self {
        let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(profile.path()).await.unwrap();
        let store = server.store();
        let auth = server.auth();
        let host = Host::with_runtime(
            store.clone(),
            auth.clone(),
            std::sync::Arc::new(support::ManualClock(std::sync::atomic::AtomicU64::new(0))),
            serial_workbench_host::device::DeviceService::virtual_opener(),
        )
        .await
        .unwrap();
        let running_host = host.clone();
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(std::sync::Arc::new(running_host), async {
                    let _ = done.await;
                })
                .await
        });
        let credential =
            serial_workbench_client::read_user_control_credential(profile.path()).unwrap();
        let control_actor = auth
            .authenticate_user_control(&support::id("shutdown-executor"), &credential)
            .unwrap();
        let mut options = ConnectOptions::new(
            profile.path().to_owned(),
            support::id("shutdown-executor"),
            ClientKind::Desktop,
        );
        options.user_control_credential = Some(credential);
        let executor = HostClient::connect(options).await.unwrap();
        let reply = executor
            .request(RpcRequest::ClientRegister(ClientRegisterParams {
                generation: 1.into(),
                capabilities: vec![capability],
            }))
            .await
            .unwrap();
        let RpcReply::Success { result, .. } = reply else {
            panic!("executor registration failed: {reply:?}")
        };
        let RpcResult::ClientRegistration(registration) = *result else {
            panic!("expected client registration: {result:?}")
        };
        let caller_id = support::id("shutdown-caller");
        let first_caller = HostClient::connect(ConnectOptions::new(
            profile.path().to_owned(),
            caller_id.clone(),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        auth.authorize(
            &control_actor,
            AuthorizeParams {
                client_id: caller_id.clone(),
                permissions: capability
                    .permissions()
                    .iter()
                    .map(|p| (*p).into())
                    .collect(),
                targets: vec![registration.target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        let caller = first_caller.reconnect().await.unwrap();
        assert_eq!(
            caller.attachment().actor_id,
            first_caller.attachment().actor_id
        );
        Self {
            _profile: profile,
            host,
            executor,
            caller,
            target: registration.target,
            stop,
            running,
        }
    }

    fn query(&self, capability: ClientCapability, params: serde_json::Value) -> Query {
        let attached = self.caller.attachment();
        Query {
            protocol_version: attached.protocol_version,
            host_id: attached.host_id.clone(),
            instance_epoch: attached.instance_epoch,
            actor_id: attached.actor_id.clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            action_id: support::id(capability.action_id()),
            target: self.target.clone(),
            params: serde_json::from_value(params).unwrap(),
            reveal_target: RevealTarget {
                page_id: support::id("settings"),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
        }
    }

    async fn delivery(&self) -> ClientEffectRequest {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let event = self.executor.next_event().await.unwrap().unwrap();
                if let IpcMessage::ClientEffect { request } = event.body {
                    assert_eq!(event.channel, IpcChannel::Control);
                    return *request;
                }
            }
        })
        .await
        .expect("real control transport must deliver the fixed client effect")
    }

    async fn finish(self) {
        self.stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(6), self.running)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn dispatched_native_action_keeps_real_delivery_evidence_until_receipt_and_retry() {
    let f = ClientShutdownFixture::new(ClientCapability::ClipboardWriteText).await;
    let query = f.query(
        ClientCapability::ClipboardWriteText,
        json!({"text":"shutdown evidence"}),
    );
    let call = Call {
        protocol_version: query.protocol_version,
        host_id: query.host_id,
        instance_epoch: query.instance_epoch,
        actor_id: query.actor_id,
        request_id: query.request_id,
        request_context: f.caller.attachment().request_context.clone(),
        action_id: query.action_id,
        target: query.target,
        params: query.params,
        reveal_target: query.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    };
    let reply = f.caller.request(RpcRequest::Invoke(call)).await.unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("real Host action was not admitted: {reply:?}")
    };
    let RpcResult::Operation(accepted) = *result else {
        panic!("expected persistent action owner: {result:?}")
    };
    let request = f.delivery().await;
    assert!(!request.action.capability().is_query());
    assert_eq!(
        request.operation_id.as_ref(),
        Some(&accepted.operation.operation_id)
    );
    let mut owner_query = f.query(ClientCapability::WindowRead, json!({}));
    owner_query.action_id = support::id("operation.get");
    owner_query.target = Target {
        host_id: request.host_id.clone(),
        kind: ResourceKind::try_from("operation").unwrap(),
        id: accepted.operation.operation_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    owner_query.params = serde_json::from_value(
        serde_json::to_value(OperationGetParams::ById {
            operation_id: accepted.operation.operation_id.clone(),
            request_context: Some(f.caller.attachment().request_context.clone()),
        })
        .unwrap(),
    )
    .unwrap();
    let reply = f
        .caller
        .request(RpcRequest::OperationGet(owner_query))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("ordinary owner could not read its persisted action: {reply:?}")
    };
    let RpcResult::Operation(persisted) = *result else {
        panic!("expected persisted operation: {result:?}")
    };
    assert_eq!(persisted.operation.actor_id, f.caller.attachment().actor_id);
    assert_eq!(persisted.operation.state, OperationState::Running);
    let report = f.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
    let incomplete = report
        .failures
        .iter()
        .find(|error| error.code == "CLIENT_EFFECT_INCOMPLETE");
    // Submit the actual late receipt before asserting RED, so fixture teardown
    // does not lose Native delivery responsibility when the assertion fails.
    let reply = f
        .executor
        .request(RpcRequest::ClientReceipt(ClientReceiptSubmission::Effect(
            Box::new(ClientEffectReceipt {
                host_id: request.host_id.clone(),
                instance_epoch: request.instance_epoch,
                client_target_id: request.client_target_id.clone(),
                generation: request.generation,
                delivery_id: request.delivery_id.clone(),
                outcome: ClientEffectOutcome::Succeeded {
                    result: ClientEffectResult::ClipboardWritten { written: True },
                },
            }),
        )))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("correct Native receipt was rejected: {reply:?}")
    };
    assert!(matches!(
        *result,
        RpcResult::ClientEffectAcknowledged(ClientEffectAcknowledged { accepted: True })
    ));
    let retry = f.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
    let incomplete = incomplete.cloned();
    f.finish().await;
    assert!(
        !report.completed,
        "unconfirmed Native side effects must prevent teardown"
    );
    let incomplete = incomplete.expect("report must identify the real pending Native delivery");
    assert_eq!(incomplete.operation_id, request.operation_id);
    assert_eq!(
        serde_json::to_value(incomplete.details.unwrap()).unwrap(),
        json!({
            "deliveryId":request.delivery_id,
            "clientTargetId":request.client_target_id,
            "generation":request.generation,
        })
    );
    assert!(
        retry.completed,
        "a real receipt must permit a fresh barrier: {retry:?}"
    );
}

#[tokio::test]
async fn dispatched_read_only_client_query_can_end_its_waiter_and_complete_quiescence() {
    let f = ClientShutdownFixture::new(ClientCapability::WindowRead).await;
    let query = f.query(ClientCapability::WindowRead, json!({}));
    let caller = f.caller.reconnect().await.unwrap();
    let waiting = tokio::spawn(async move { caller.request(RpcRequest::Query(query)).await });
    let request = f.delivery().await;
    assert!(request.action.capability().is_query());
    assert!(request.operation_id.is_none());
    let report = f.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(reply, RpcReply::Failure { .. }),
        "query output must not outlive quiescence: {reply:?}"
    );
    assert!(
        report.completed,
        "a read-only waiter must not pin Native responsibility: {report:?}"
    );
    assert!(report.unsettled_operation_ids.is_empty());
    assert!(report.failures.is_empty());
    assert!(
        report.evidence_refs.is_empty(),
        "a read-only query must not invent a durable operation"
    );
    f.finish().await;
}
