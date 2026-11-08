use super::*;
use crate::{
    storage::{Acceptance, canonical_digest},
    test_support as support,
};

#[tokio::test]
async fn configuration_boundary_guard_pauses_rx_until_publication_finishes() {
    let h = support::Harness::new().await;
    let target = h.open("configuration-boundary").await;
    let session = h.host.devices().session(&target).unwrap();
    let mut change = session
        .configure(
            SerialConfiguration::default(),
            BackendAdmission {
                session_epoch: target.session_epoch.unwrap(),
                actor_id: h.actor.id().clone(),
                lease_id: None,
                lease: Arc::new(Mutex::new(None)),
                cancelled: Arc::new(AtomicBool::new(false)),
            },
        )
        .await;
    change.take_result().unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    let reads = h.probe.configured_reads.load(Ordering::SeqCst);
    change.resume();
    support::until(|| h.probe.configured_reads.load(Ordering::SeqCst) > 0).await;
    h.host.shutdown().await.unwrap();
    assert_eq!(
        reads, 0,
        "RX resumed before the configuration boundary owner released its guard"
    );
}

#[tokio::test]
async fn queue_wait_begins_at_owned_admission_before_the_job_is_polled() {
    let h = support::Harness::new().await;
    let service = TransmissionService::new(h.host.devices().clone());
    let target = h.open("delayed-job").await;
    let call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100","queueWaitMs":"5"}),
    );
    let preparation = service.prepare(&call).unwrap();
    let Acceptance::New(operation) = h
        .store
        .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!()
    };
    service
        .track(&operation, h.auth.capture_grants(&h.actor).unwrap(), None)
        .unwrap();
    h.clock.advance_ms(5);
    let id = operation.operation_id.clone();
    service
        .execute(
            AcceptedCall {
                actor: h.actor.clone(),
                call,
                operation,
            },
            preparation,
        )
        .await
        .unwrap();
    let done = h.wait(&id).await;
    h.host.shutdown().await.unwrap();
    assert_eq!(h.write_count(), 0);
    assert_eq!(
        support::receipt(&done).backend_error.as_ref().unwrap().code,
        "QUEUE_TIMEOUT"
    );
}

async fn accepted(
    h: &support::Harness,
    service: &TransmissionService,
) -> (AcceptedCall, OperationPreparation) {
    let target = h.open("race").await;
    let call = h.call(
        &target,
        "session.tx",
        serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"100"}),
    );
    let preparation = service.prepare(&call).unwrap();
    let Acceptance::New(operation) = h
        .store
        .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!()
    };
    (
        AcceptedCall {
            actor: h.actor.clone(),
            call,
            operation,
        },
        preparation,
    )
}

#[tokio::test]
async fn cancellation_between_persistent_accept_and_owner_tracking_has_zero_writes() {
    let h = support::Harness::new().await;
    let service = TransmissionService::new(h.host.devices().clone());
    let admission = service.admission(false).unwrap();
    let (accepted, preparation) = accepted(&h, &service).await;
    let op = accepted.operation.clone();
    let (entered, held) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    *service.cancel_gap.lock().unwrap() = Some((entered, wait));
    let cancel_service = service.clone();
    let actor = h.actor.clone();
    let id = op.operation_id.clone();
    let cancelling = tokio::spawn(async move { cancel_service.cancel(&actor, &id).await });
    held.await.unwrap();
    service
        .track(&op, h.auth.capture_grants(&h.actor).unwrap(), None)
        .unwrap();
    drop(admission);
    service.execute(accepted, preparation).await.unwrap();
    release.send(()).unwrap();
    let cancellation = cancelling.await.unwrap();
    let result = h.wait(&op.operation_id).await;
    h.host.shutdown().await.unwrap();
    assert_eq!(h.write_count(), 0);
    cancellation.unwrap();
    assert_eq!(result.state, OperationState::Cancelled);
    assert_eq!(support::receipt(&result).outcome, TxOutcome::Rejected);
}

#[tokio::test]
async fn cancellation_after_queue_selection_before_dispatch_has_zero_writes() {
    let h = support::Harness::new().await;
    let service = TransmissionService::new(h.host.devices().clone());
    let (accepted, preparation) = accepted(&h, &service).await;
    let op = accepted.operation.clone();
    service
        .track(&op, h.auth.capture_grants(&h.actor).unwrap(), None)
        .unwrap();
    let (entered, held) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel();
    *service.dispatch_gap.lock().unwrap() = Some((entered, wait));
    let executing = service.clone();
    let execution = tokio::spawn(async move { executing.execute(accepted, preparation).await });
    held.await.unwrap();
    let cancelling = service.clone();
    let actor = h.actor.clone();
    let id = op.operation_id.clone();
    let cancel = tokio::spawn(async move { cancelling.cancel(&actor, &id).await });
    support::until(|| {
        service
            .tokens
            .lock()
            .unwrap()
            .get(&op.operation_id)
            .unwrap()
            .cancelled
            .load(Ordering::SeqCst)
    })
    .await;
    release.send(()).unwrap();
    execution.await.unwrap().unwrap();
    cancel.await.unwrap().unwrap();
    let result = h.wait(&op.operation_id).await;
    h.host.shutdown().await.unwrap();
    assert_eq!(h.write_count(), 0);
    assert_eq!(result.state, OperationState::Cancelled);
    assert_eq!(support::receipt(&result).outcome, TxOutcome::Rejected);
}
