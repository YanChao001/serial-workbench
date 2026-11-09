//! Real IPC evidence for history whose service lease/session can disappear.
use super::*;

async fn captured(f: &Fixture) -> (ObjectRef, ObjectRef) {
    let session = f.open().await;
    let destination = f.register("history-source").await;
    let (owner, live) = f.start(&f.user, &session, &destination).await;
    let tx = f
        .action(
            &f.user,
            "session.tx",
            session,
            json!({"bytesBase64":"AQID","writeWaitMs":"1000"}),
        )
        .await;
    assert_eq!(tx.state, OperationState::Succeeded);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.store
                .get(&f.operator, &owner.operation_id)
                .unwrap()
                .progress
                .is_some_and(|progress| progress.completed.get() > 0)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    let stopped = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(stopped.state, OperationState::Succeeded);
    let done = f.wait(&owner, false).await;
    let Some(ActionResult::CaptureStatus(status)) = done.result else {
        panic!("fixed capture")
    };
    (destination, status.capture_ref)
}
async fn inspected(f: &Fixture, operation: &Operation) -> RpcReply {
    f.observer
        .request(RpcRequest::Query(f.query(
            &f.observer,
            "operation.get",
            f.host(),
            json!({"operationId":operation.operation_id}),
        )))
        .await
        .unwrap()
}
fn read_operation(reply: RpcReply) -> Operation {
    let RpcResult::Query(QueryResult::Operation(result)) = success(reply) else {
        panic!("operation")
    };
    result.operation
}
fn revoke_source(f: &Fixture, source: &ObjectRef) {
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.reference_target(source)],
            },
        )
        .unwrap();
}

#[tokio::test]
async fn recovery_history_reads_saved_source_after_verification_lease_is_consumed() {
    let f = Fixture::new().await;
    let (source, fixed) = captured(&f).await;
    let verified = f
        .action(
            &f.user,
            "capture.verify",
            f.reference_target(&fixed),
            json!({"captureRef":fixed}),
        )
        .await;
    let Some(ActionResult::CaptureVerification(verification)) = verified.result else {
        panic!("verification")
    };
    let destination = f.register("history-recovered").await;
    let params = json!({"verificationId":verification.verification_id,"sourceFingerprint":verification.source_fingerprint,"targetRef":destination});
    let recovered = f
        .action(
            &f.user,
            "capture.recover",
            f.reference_target(&destination),
            params.clone(),
        )
        .await;
    assert_eq!(
        recovered.state,
        OperationState::Succeeded,
        "{:?}",
        recovered.error
    );
    let before = f.store.operation_metadata().unwrap();
    let consumed = f
        .rejected_action("capture.recover", f.reference_target(&destination), params)
        .await;
    assert_eq!(
        consumed.code, "NOT_FOUND",
        "verification lease must be consumed"
    );
    assert_eq!(f.store.operation_metadata().unwrap(), before);
    f.grant("content.read", f.reference_target(&destination));
    assert_eq!(
        failure(inspected(&f, &recovered).await).code,
        "PERMISSION_DENIED"
    );
    f.grant("content.read", f.reference_target(&source));
    let shared = inspected(&f, &recovered).await;
    revoke_source(&f, &source);
    let revoked = inspected(&f, &recovered).await;
    f.finish().await;
    assert_eq!(read_operation(shared).result, recovered.result);
    assert_eq!(failure(revoked).code, "PERMISSION_DENIED");
}

#[tokio::test]
async fn replay_close_history_survives_normal_closed_session_cache_eviction() {
    let f = Fixture::new().await;
    let (source, fixed) = captured(&f).await;
    let mut first = None;
    for _ in 0..65 {
        let opened = f
            .action(
                &f.user,
                "replay.open",
                f.reference_target(&fixed),
                json!({"captureRef":fixed}),
            )
            .await;
        let Some(ActionResult::Opened(opened)) = opened.result else {
            panic!("replay open")
        };
        let mut target = f.target("session", opened.session_id.as_str());
        target.session_id = Some(opened.session_id);
        target.session_epoch = Some(opened.session_epoch);
        let closed = f
            .action(&f.user, "replay.close", target.clone(), json!({}))
            .await;
        assert_eq!(
            closed.state,
            OperationState::Succeeded,
            "{:?}",
            closed.error
        );
        first.get_or_insert((target, closed));
    }
    let (target, closed) = first.unwrap();
    let gone = f
        .user
        .request(RpcRequest::Query(f.query(
            &f.user,
            "session.get",
            target.clone(),
            json!({}),
        )))
        .await
        .unwrap();
    assert!(
        matches!(gone, RpcReply::Failure { .. }),
        "the first service entry must actually be gone"
    );
    f.grant("content.read", target);
    let wrong = inspected(&f, &closed).await;
    f.grant("content.read", f.reference_target(&source));
    let shared = inspected(&f, &closed).await;
    revoke_source(&f, &source);
    let revoked = inspected(&f, &closed).await;
    f.finish().await;
    assert!(matches!(wrong, RpcReply::Failure { .. }));
    assert_eq!(read_operation(shared).result, closed.result);
    assert_eq!(failure(revoked).code, "PERMISSION_DENIED");
}

#[tokio::test]
async fn source_fact_persistence_failure_rejects_admission_without_operation_or_output() {
    let f = Fixture::new().await;
    let (_, fixed) = captured(&f).await;
    let verified = f
        .action(
            &f.user,
            "capture.verify",
            f.reference_target(&fixed),
            json!({"captureRef":fixed}),
        )
        .await;
    let Some(ActionResult::CaptureVerification(verification)) = verified.result else {
        panic!("verification")
    };
    let destination = f.register("no-history-fact-no-output").await;
    let before = f.store.operation_metadata().unwrap();
    let db = rusqlite::Connection::open(f.dir.path().join("host-v0/state.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_source_fact BEFORE INSERT ON documents WHEN NEW.id GLOB 'operation-source-*' BEGIN SELECT RAISE(FAIL,'test authority persistence failure'); END;").unwrap();
    let reply = f.user.request(RpcRequest::Invoke(f.call(&f.user, "capture.recover", f.reference_target(&destination), json!({"verificationId":verification.verification_id,"sourceFingerprint":verification.source_fingerprint,"targetRef":destination})))).await.unwrap();
    let output_exists = f.dir.path().join("no-history-fact-no-output").exists();
    let after = f.store.operation_metadata().unwrap();
    db.execute_batch("DROP TRIGGER reject_source_fact;")
        .unwrap();
    f.finish().await;
    assert_eq!(failure(reply).code, "STORAGE_UNAVAILABLE");
    assert_eq!(
        before, after,
        "failed admission must roll back its operation"
    );
    assert!(
        !output_exists,
        "no recovery artifact without durable source authority"
    );
}
