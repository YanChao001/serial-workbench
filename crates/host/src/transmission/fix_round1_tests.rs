use super::*;
use crate::{
    storage::{Acceptance, canonical_digest},
    test_support as support,
};

#[tokio::test]
async fn boundary_capture_includes_owner_tracked_and_settled_during_capture() {
    let h = support::Harness::new().await;
    let target = h.open("boundary-capture-transition").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
    );
    let preparation = service.prepare(&call).unwrap();
    let admission = service.admission();
    let Acceptance::New(operation) = h
        .store
        .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!()
    };
    let first_id = operation.operation_id.clone();
    let first = AcceptedCall {
        actor: h.actor.clone(),
        call,
        operation,
    };
    let (anchor, anchor_preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ),
    );
    let anchor_id = anchor.operation.operation_id.clone();
    service.execute(anchor, anchor_preparation).await.unwrap();
    let (boundary, boundary_preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "tx.waitBoundary",
            serde_json::json!({"throughOperationId":anchor_id,"queueWaitMs":"5"}),
        ),
    );
    let boundary_id = boundary.operation.operation_id.clone();
    let (capturing, captured) = tokio::sync::oneshot::channel();
    let (resume_capture, capture_wait) = tokio::sync::oneshot::channel();
    *service.boundary_gap.lock().unwrap() = Some((capturing, capture_wait));
    let boundary_service = service.clone();
    let waiter = tokio::spawn(async move {
        boundary_service
            .execute(boundary, boundary_preparation)
            .await
    });
    captured.await.unwrap();
    // A 早于锚点接纳；旧实现拍照时尚未 track，此后真实执行并持久终态。
    let (settling, settled) = tokio::sync::oneshot::channel();
    let (finish_owner, owner_wait) = tokio::sync::oneshot::channel();
    *service.settlement_gap.lock().unwrap() = Some((settling, owner_wait));
    service
        .track(
            &first.operation,
            h.auth.capture_grants(&h.actor).unwrap(),
            None,
        )
        .unwrap();
    drop(admission);
    let first_service = service.clone();
    let first_job = tokio::spawn(async move { first_service.execute(first, preparation).await });
    settled.await.unwrap();
    assert_eq!(h.write_count(), 2);
    assert_eq!(
        h.store.get(&h.actor, &first_id).unwrap().state,
        OperationState::Succeeded
    );
    assert!(service.tokens.lock().unwrap().contains_key(&first_id));
    // 放行 SQL 后仍固定持有 A 的 owner；时间截止不能把遗漏误报为成功。
    let (dispatching, dispatched) = tokio::sync::oneshot::channel();
    let (resume_dispatch, dispatch_wait) = tokio::sync::oneshot::channel();
    *service.dispatch_gap.lock().unwrap() = Some((dispatching, dispatch_wait));
    resume_capture.send(()).unwrap();
    dispatched.await.unwrap();
    h.clock.advance_ms(10);
    resume_dispatch.send(()).unwrap();
    waiter.await.unwrap().unwrap();
    let result = h.store.get(&h.actor, &boundary_id).unwrap();
    let owner_still_running = service.tokens.lock().unwrap().contains_key(&first_id);
    finish_owner.send(()).unwrap();
    first_job.await.unwrap().unwrap();
    h.host.shutdown().await.unwrap();
    assert!(owner_still_running);
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(result.error.unwrap().code, "QUEUE_TIMEOUT");
}

#[tokio::test]
async fn boundary_waits_for_owner_even_after_persistent_terminal() {
    let h = support::Harness::new().await;
    let target = h.open("boundary-terminal-owner").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let (tx, tx_preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ),
    );
    let tx_id = tx.operation.operation_id.clone();
    // Store 已提交，但同一个 owner token 仍持有完成清理责任。
    h.store
        .settle(
            &tx_id,
            Settlement {
                state: OperationState::Interrupted,
                result: None,
                error: None,
            },
        )
        .unwrap();
    let (boundary, preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "tx.waitBoundary",
            serde_json::json!({"throughOperationId":tx_id,"queueWaitMs":"5"}),
        ),
    );
    let boundary_id = boundary.operation.operation_id.clone();
    let (entered, held) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    *service.dispatch_gap.lock().unwrap() = Some((entered, wait));
    let worker = service.clone();
    let job = tokio::spawn(async move { worker.execute(boundary, preparation).await });
    held.await.unwrap();
    h.clock.advance_ms(10);
    release.send(()).unwrap();
    job.await.unwrap().unwrap();
    let result = h.store.get(&h.actor, &boundary_id).unwrap();
    service.tokens.lock().unwrap().remove(&tx_id);
    drop(tx_preparation);
    h.host.shutdown().await.unwrap();
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(result.error.unwrap().code, "QUEUE_TIMEOUT");
}

fn tracked(
    h: &support::Harness,
    service: &TransmissionService,
    call: Call,
) -> (AcceptedCall, OperationPreparation) {
    let preparation = service.prepare(&call).unwrap();
    let Acceptance::New(operation) = h
        .store
        .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!()
    };
    service
        .track(
            &operation,
            h.auth.capture_grants(&h.actor).unwrap(),
            call.lease_id.clone(),
        )
        .unwrap();
    (
        AcceptedCall {
            actor: h.actor.clone(),
            call,
            operation,
        },
        preparation,
    )
}
fn seed_lease(
    h: &support::Harness,
    service: &TransmissionService,
    target: &Target,
    expires: u64,
) -> Lease {
    let (accepted, _) = tracked(
        h,
        service,
        h.call(
            target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"100"}),
        ),
    );
    h.store
        .mark_dispatch(&accepted.operation.operation_id)
        .unwrap();
    let lease = Lease {
        lease_id: new_id(),
        session_id: target.id.clone(),
        session_epoch: target.session_epoch.unwrap(),
        actor_id: h.actor.id().clone(),
        owner_operation_id: accepted.operation.operation_id.clone(),
        kind: LeaseKind::Exclusive,
        state: LeaseState::Active,
        execution_mode: ExecutionMode::Interactive,
        expires_at_mono_ns: expires.into(),
    };
    h.store
        .record_result_evidence(
            &lease.owner_operation_id,
            &ActionResult::Lease(lease.clone()),
        )
        .unwrap();
    *service.runtime(target).unwrap().lease.lock().unwrap() = Some(lease.clone());
    // 不启动异步到期任务：后端提交必须同步执行期限检查。
    lease
}

#[tokio::test]
async fn configuration_terminal_failure_never_resumes_backend_rx() {
    let h = support::Harness::new().await;
    let target = h.open("configuration-terminal-failure").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let mut call = h.call(
        &target,
        "session.configure",
        serde_json::json!({"requested":SerialConfiguration::default()}),
    );
    call.expected_revision = Some(1.into());
    let (accepted, prepared) = tracked(&h, &service, call);
    let operation_id = accepted.operation.operation_id.clone();
    let connection =
        rusqlite::Connection::open(h.dir.path().join("host-v0/state.sqlite3")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_terminal BEFORE UPDATE OF terminal ON operations WHEN NEW.terminal=1 BEGIN SELECT RAISE(ABORT,'terminal fixture'); END;").unwrap();
    assert!(service.execute(accepted, prepared).await.is_err());
    let snapshot = h.host.devices().snapshot(&target).await.unwrap();
    h.host.shutdown().await.unwrap();
    assert_eq!(
        h.probe.configured_reads.load(Ordering::SeqCst),
        0,
        "RX resumed while receipt was not durable"
    );
    assert_eq!(snapshot.tx_gate, TxGate::ConfigurationPending);
    assert_eq!(
        h.store.get(&h.actor, &operation_id).unwrap().state,
        OperationState::Running
    );
}

#[tokio::test]
async fn queued_acquire_ttl_is_not_restarted_after_previous_write() {
    let h = support::Harness::new().await;
    let target = h.open("queued-acquire-ttl").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let gate = Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let (tx, prep) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ),
    );
    let tx_service = service.clone();
    let tx_job = tokio::spawn(async move { tx_service.execute(tx, prep).await });
    gate.entered().await;
    let (acquire, prep) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"5"}),
        ),
    );
    let id = acquire.operation.operation_id.clone();
    let acq_service = service.clone();
    let acquisition = tokio::spawn(async move { acq_service.execute(acquire, prep).await });
    let runtime = service.runtime(&target).unwrap();
    support::until(|| {
        runtime
            .queue
            .lock()
            .unwrap()
            .entries
            .iter()
            .any(|entry| entry.id == id)
    })
    .await;
    h.clock.advance_ms(10);
    gate.release();
    tx_job.await.unwrap().unwrap();
    support::until(|| {
        let op = h.store.get(&h.actor, &id).unwrap();
        op.result.is_some() || terminal(op.state)
    })
    .await;
    let late_lease = h.store.get(&h.actor, &id).unwrap().result;
    h.clock.advance_ms(100);
    acquisition.await.unwrap().unwrap();
    h.host.shutdown().await.unwrap();
    assert!(
        late_lease.is_none(),
        "expired acquire installed a new active lease: {late_lease:?}"
    );
}

#[tokio::test]
async fn delayed_renew_cannot_extend_from_execution_time() {
    let h = support::Harness::new().await;
    let target = h.open("renew-ttl").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let lease = seed_lease(&h, &service, &target, 100_000_000);
    let (renew, prep) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "lease.renew",
            serde_json::json!({"leaseId":lease.lease_id,"ttlMs":"5"}),
        ),
    );
    let id = renew.operation.operation_id.clone();
    h.clock.advance_ms(10);
    service.execute(renew, prep).await.unwrap();
    let result = h.store.get(&h.actor, &id).unwrap();
    let current = service
        .runtime(&target)
        .unwrap()
        .lease
        .lock()
        .unwrap()
        .clone()
        .unwrap();
    h.host.shutdown().await.unwrap();
    assert_eq!(current.expires_at_mono_ns, lease.expires_at_mono_ns);
    assert_ne!(result.state, OperationState::Succeeded);
}

#[tokio::test]
async fn expired_lease_is_rechecked_after_arbitration_without_expiry_watcher() {
    let h = support::Harness::new().await;
    let target = h.open("late-backend-lease").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let lease = seed_lease(&h, &service, &target, 5_000_000);
    let mut call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
    );
    call.lease_id = Some(lease.lease_id);
    let (tx, prep) = tracked(&h, &service, call);
    let (entered, held) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    *service.dispatch_gap.lock().unwrap() = Some((entered, wait));
    let execution_service = service.clone();
    let execution = tokio::spawn(async move { execution_service.execute(tx, prep).await });
    held.await.unwrap();
    h.clock.advance_ms(6);
    release.send(()).unwrap();
    execution.await.unwrap().unwrap();
    h.host.shutdown().await.unwrap();
    assert_eq!(
        h.write_count(),
        0,
        "expired lease reached actual backend write"
    );
}

#[tokio::test]
async fn release_after_unknown_write_keeps_persistent_isolation() {
    let h = support::Harness::new().await;
    let target = h.open("unknown-release").await;
    let owner = h
        .invoke(h.call(
            &target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"100"}),
        ))
        .await;
    support::until(|| {
        h.store
            .get(&h.actor, &owner.operation_id)
            .unwrap()
            .result
            .is_some()
    })
    .await;
    let Some(ActionResult::Lease(lease)) =
        h.store.get(&h.actor, &owner.operation_id).unwrap().result
    else {
        panic!()
    };
    let gate = Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 3,
        unknown: true,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let mut call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
    );
    call.lease_id = Some(lease.lease_id.clone());
    let tx = h.invoke(call).await;
    gate.entered().await;
    let release = h
        .invoke(h.call(
            &target,
            "lease.release",
            serde_json::json!({"leaseId":lease.lease_id}),
        ))
        .await;
    support::until(|| {
        h.host
            .devices()
            .session(&target)
            .unwrap()
            .snapshot()
            .unwrap()
            .lease
            .is_some_and(|v| v.state == LeaseState::Revoking)
    })
    .await;
    gate.release();
    assert_eq!(
        h.wait(&tx.operation_id).await.state,
        OperationState::Unknown
    );
    let release = h.wait(&release.operation_id).await;
    let owner = h.wait(&owner.operation_id).await;
    let snapshot = h.host.devices().snapshot(&target).await.unwrap();
    let before = h.write_count();
    let later = h.send(&target).await;
    h.host.shutdown().await.unwrap();
    assert_eq!(release.state, OperationState::Unknown);
    assert_eq!(owner.state, OperationState::Unknown);
    assert_eq!(snapshot.tx_gate, TxGate::ControlUnknown);
    assert_eq!(h.write_count(), before);
    assert_eq!(support::receipt(&later).outcome, TxOutcome::Rejected);
}

#[tokio::test]
async fn boundary_does_not_report_success_after_terminal_commit_failed() {
    let h = support::Harness::new().await;
    let target = h.open("boundary-terminal").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let (tx, prep) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ),
    );
    let id = tx.operation.operation_id.clone();
    let connection =
        rusqlite::Connection::open(h.dir.path().join("host-v0/state.sqlite3")).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_terminal BEFORE UPDATE OF terminal ON operations WHEN NEW.terminal=1 BEGIN SELECT RAISE(ABORT,'terminal fixture'); END;").unwrap();
    assert!(service.execute(tx, prep).await.is_err());
    connection
        .execute_batch("DROP TRIGGER reject_terminal;")
        .unwrap();
    let (boundary, prep) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "tx.waitBoundary",
            serde_json::json!({"throughOperationId":id,"queueWaitMs":"5"}),
        ),
    );
    let boundary_id = boundary.operation.operation_id.clone();
    let work = tokio::spawn(async move { service.execute(boundary, prep).await });
    h.clock.advance_ms(10);
    work.await.unwrap().unwrap();
    let result = h.store.get(&h.actor, &boundary_id).unwrap();
    h.host.shutdown().await.unwrap();
    assert_ne!(result.state, OperationState::Succeeded);
}

#[tokio::test]
async fn boundary_rejects_unknown_foreign_epoch_and_lease_anchors() {
    let h = support::Harness::new().await;
    let old_target = h.open("boundary-anchor-current").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let (old_tx, old_preparation) = tracked(
        &h,
        &service,
        h.call(
            &old_target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ),
    );
    let old_id = old_tx.operation.operation_id.clone();
    service.execute(old_tx, old_preparation).await.unwrap();
    let (close, close_preparation) = tracked(
        &h,
        &service,
        h.call(&old_target, "session.close", serde_json::json!({})),
    );
    service.execute(close, close_preparation).await.unwrap();
    let target = h.open("boundary-anchor-current").await;
    assert_eq!(target.id, old_target.id);
    assert_ne!(target.session_epoch, old_target.session_epoch);

    let foreign_target = h.open("boundary-anchor-foreign").await;
    let (foreign_tx, foreign_preparation) = tracked(
        &h,
        &service,
        h.call(
            &foreign_target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ),
    );
    let foreign_id = foreign_tx.operation.operation_id.clone();
    service
        .execute(foreign_tx, foreign_preparation)
        .await
        .unwrap();
    let (lease, lease_preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "lease.acquire",
            serde_json::json!({"kind":"exclusive","ttlMs":"100"}),
        ),
    );
    let lease_id = lease.operation.operation_id.clone();
    let mut outcomes = vec![];
    for (label, through) in [
        ("unknown", support::id("missing-boundary-operation")),
        ("foreign session", foreign_id),
        ("old epoch", old_id),
        ("lease owner", lease_id.clone()),
    ] {
        let (boundary, preparation) = tracked(
            &h,
            &service,
            h.call(
                &target,
                "tx.waitBoundary",
                serde_json::json!({"throughOperationId":through,"queueWaitMs":"5"}),
            ),
        );
        let id = boundary.operation.operation_id.clone();
        service.execute(boundary, preparation).await.unwrap();
        outcomes.push((label, h.store.get(&h.actor, &id).unwrap()));
    }
    // 非法 lease 锚点从未执行；明确终结并释放测试预留，不给夹具留下隐式 owner。
    h.store.request_cancel(&h.actor, &lease_id).unwrap();
    service
        .tokens
        .lock()
        .unwrap()
        .get(&lease_id)
        .unwrap()
        .cancel();
    service.execute(lease, lease_preparation).await.unwrap();
    h.host.shutdown().await.unwrap();
    for (label, outcome) in outcomes {
        assert_ne!(
            outcome.state,
            OperationState::Succeeded,
            "Accepted invalid {label} boundary"
        );
        assert!(
            outcome.error.is_some(),
            "Missing target error for {label}: {outcome:?}"
        );
    }
    assert_eq!(h.write_count(), 2);
}

#[tokio::test]
async fn boundary_cannot_succeed_for_persistently_accepted_untracked_tx() {
    let h = support::Harness::new().await;
    let target = h.open("boundary-untracked").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
    );
    let preparation = service.prepare(&call).unwrap();
    let admission = service.admission();
    let Acceptance::New(operation) = h
        .store
        .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!()
    };
    let tx_id = operation.operation_id.clone();
    // 此刻 TX 已进入真实 Store 接纳顺序，但尚无 token，亦未进入 scheduler。
    let tx = AcceptedCall {
        actor: h.actor.clone(),
        call,
        operation,
    };
    let (boundary, boundary_preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "tx.waitBoundary",
            serde_json::json!({"throughOperationId":tx_id,"queueWaitMs":"5"}),
        ),
    );
    let boundary_id = boundary.operation.operation_id.clone();
    let connection =
        rusqlite::Connection::open(h.dir.path().join("host-v0/state.sqlite3")).unwrap();
    let sql = format!(
        "CREATE TRIGGER reject_early_boundary BEFORE UPDATE OF terminal ON operations \
         WHEN NEW.operation_id='{}' AND NEW.terminal=1 \
         AND json_extract(NEW.operation_json,'$.state')='succeeded' \
         AND EXISTS(SELECT 1 FROM operations WHERE operation_id='{}' AND terminal=0) \
         BEGIN SELECT RAISE(ABORT,'boundary before TX terminal fixture'); END;",
        boundary_id.as_str(),
        tx_id.as_str()
    );
    // 两个 ID 均为本测试 Store 创建的 UUID，非外部输入；SQL 仅安装真实终态约束。
    connection.execute_batch(&sql).unwrap();
    let (entered, held) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    *service.dispatch_gap.lock().unwrap() = Some((entered, wait));
    let boundary_service = service.clone();
    let waiter = tokio::spawn(async move {
        boundary_service
            .execute(boundary, boundary_preparation)
            .await
    });
    held.await.unwrap();
    h.clock.advance_ms(10);
    release.send(()).unwrap();
    let execution = waiter.await.unwrap();
    let result = h.store.get(&h.actor, &boundary_id).unwrap();
    let still_queued = h.store.get(&h.actor, &tx_id).unwrap().state;
    connection
        .execute_batch("DROP TRIGGER reject_early_boundary;")
        .unwrap();
    // 直到 waiter 结束，TX 都未 track；之后才正常执行，完成夹具清理。
    service
        .track(
            &tx.operation,
            h.auth.capture_grants(&h.actor).unwrap(),
            None,
        )
        .unwrap();
    drop(admission);
    service.execute(tx, preparation).await.unwrap();
    h.host.shutdown().await.unwrap();
    assert!(
        execution.is_ok(),
        "Boundary attempted premature success and hit terminal trigger: {execution:?}"
    );
    assert_eq!(still_queued, OperationState::Queued);
    assert_ne!(result.state, OperationState::Succeeded);
    assert_eq!(result.error.unwrap().code, "QUEUE_TIMEOUT");
    assert_eq!(h.write_count(), 1);
}

#[tokio::test]
async fn completed_boundary_does_not_include_a_later_blocked_tx() {
    let h = support::Harness::new().await;
    let target = h.open("boundary-fixed-prefix").await;
    let service = TransmissionService::new(h.host.devices().clone());
    let (first, first_preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ),
    );
    let first_id = first.operation.operation_id.clone();
    service.execute(first, first_preparation).await.unwrap();
    assert!(terminal(h.store.get(&h.actor, &first_id).unwrap().state));
    let gate = Arc::new(support::Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let (later, later_preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
        ),
    );
    let later_id = later.operation.operation_id.clone();
    let later_service = service.clone();
    let later_job =
        tokio::spawn(async move { later_service.execute(later, later_preparation).await });
    gate.entered().await;
    let (boundary, boundary_preparation) = tracked(
        &h,
        &service,
        h.call(
            &target,
            "tx.waitBoundary",
            serde_json::json!({"throughOperationId":first_id,"queueWaitMs":"5"}),
        ),
    );
    let boundary_id = boundary.operation.operation_id.clone();
    let (entered, held) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    *service.dispatch_gap.lock().unwrap() = Some((entered, wait));
    let boundary_service = service.clone();
    let waiter = tokio::spawn(async move {
        boundary_service
            .execute(boundary, boundary_preparation)
            .await
    });
    held.await.unwrap();
    h.clock.advance_ms(10);
    release.send(()).unwrap();
    waiter.await.unwrap().unwrap();
    let boundary_result = h.store.get(&h.actor, &boundary_id).unwrap();
    let later_still_running = h.store.get(&h.actor, &later_id).unwrap().state;
    gate.release();
    later_job.await.unwrap().unwrap();
    let later_result = h.store.get(&h.actor, &later_id).unwrap();
    h.host.shutdown().await.unwrap();
    assert_eq!(
        boundary_result.state,
        OperationState::Succeeded,
        "Old completed prefix was extended by a newer TX: {boundary_result:?}"
    );
    assert_eq!(later_still_running, OperationState::Running);
    assert_eq!(support::receipt(&later_result).outcome, TxOutcome::Accepted);
    assert_eq!(h.write_count(), 2);
}
