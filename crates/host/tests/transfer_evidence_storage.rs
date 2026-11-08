use serial_workbench_core::*;
use serial_workbench_host::{
    auth::{AuthService, AuthenticatedActor},
    storage::{Acceptance, Settlement, Store, canonical_digest},
};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

struct TestClock(AtomicU64);
impl Clock for TestClock {
    fn mono_ns(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    fn wall_time(&self) -> Timestamp {
        Timestamp::try_from("2026-11-08T00:00:00Z").unwrap()
    }
}
fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    actor: AuthenticatedActor,
    clock: Arc<TestClock>,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(TestClock(AtomicU64::new(0)));
        let store = Store::open_with_clock(dir.path(), clock.clone()).unwrap();
        store.begin_instance().unwrap();
        let auth = AuthService::with_clock(
            store.clone(),
            ContextToken::try_from("test-control").unwrap(),
            clock.clone(),
        );
        let actor = auth
            .authenticate(&id("storage-client"), None)
            .unwrap()
            .actor;
        Self {
            dir,
            store,
            actor,
            clock,
        }
    }
    fn running(&self) -> Operation {
        let identity = self.store.identity().unwrap();
        let call: Call = serde_json::from_value(serde_json::json!({
            "protocolVersion":"0.1", "hostId":identity.host_id, "instanceEpoch":identity.instance_epoch,
            "actorId":self.actor.id(), "requestId":uuid::Uuid::new_v4().to_string(),
            "requestContext":self.store.issue_context(&self.actor).unwrap().token,
            "actionId":"transfer.file", "executionMode":"independent",
            "target":{"hostId":identity.host_id,"kind":"session","id":"session","sessionId":"session","sessionEpoch":"1"},
            "params":{}, "revealTarget":{"pageId":"workbench"}
        })).unwrap();
        let Acceptance::New(operation) = self
            .store
            .accept(&self.actor, &call, &canonical_digest(&call).unwrap())
            .unwrap()
        else {
            panic!("new operation")
        };
        self.store.mark_dispatch(&operation.operation_id).unwrap();
        operation
    }
    fn result(&self, operation: &Operation, accepted: u64, unknown: u64) -> ActionResult {
        ActionResult::FileTransfer(FileTransferResult {
            requested: 5.into(),
            accepted: accepted.into(),
            unknown: unknown.into(),
            peer_acknowledged: false,
            receipts_ref: ObjectRef {
                host_id: operation.execution_host_id.clone(),
                kind: ResourceKind::try_from("transfer_receipts").unwrap(),
                id: operation.operation_id.clone(),
                revision: None,
            },
        })
    }
    fn document(&self, key: &str, value: serde_json::Value) {
        self.store
            .compare_and_swap_document(&id(key), 0.into(), serde_json::from_value(value).unwrap())
            .unwrap();
    }
    fn journal(&self, operation: &Operation) -> Vec<String> {
        let prefix = format!("transfer-receipts-{}", operation.operation_id);
        self.document(&prefix, serde_json::json!({
            "formatVersion":"0.1", "sourceRef":{"hostId":operation.execution_host_id,"kind":"file","id":"source"},
            "authority":{"hostId":operation.execution_host_id,"kind":"file","id":"source"},
            "count":"1", "sealed":false
        }));
        // ordinal=count 是 chunk 提交成功、manifest 提交失败时的孤立证据。
        for ordinal in [0, 1] {
            self.document(
                &format!("{prefix}-{ordinal}"),
                serde_json::json!({"pending":true}),
            );
        }
        vec![prefix.clone(), format!("{prefix}-0"), format!("{prefix}-1")]
    }
    fn terminal(&self, operation: &Operation) {
        self.store
            .settle(
                &operation.operation_id,
                Settlement {
                    state: OperationState::Failed,
                    result: Some(self.result(operation, 2, 3)),
                    error: Some(HostError::new("IO_ERROR", "partial write")),
                },
            )
            .unwrap();
    }
    fn advance_days(&self, days: u64) {
        self.clock
            .0
            .fetch_add(days * 86_400_000_000_000, Ordering::SeqCst);
    }
}

#[test]
fn transfer_evidence_persists_progress_through_cancel_and_recovery() {
    let f = Fixture::new();
    let operation = f.running();
    f.store
        .record_result_evidence(&operation.operation_id, &f.result(&operation, 2, 3))
        .unwrap();
    let saved = f.store.get(&f.actor, &operation.operation_id).unwrap();
    let progress = saved.progress.expect("durable accepted-byte progress");
    assert_eq!(progress.completed, U64::from(2));
    assert_eq!(progress.total, Some(U64::from(5)));
    assert_eq!(progress.unit, "bytes");
    f.store
        .request_cancel(&f.actor, &operation.operation_id)
        .unwrap();
    f.store
        .record_result_evidence(&operation.operation_id, &f.result(&operation, 3, 0))
        .unwrap();
    f.store.recover().unwrap();
    let recovered = f.store.get(&f.actor, &operation.operation_id).unwrap();
    assert_eq!(recovered.state, OperationState::Unknown);
    assert_eq!(recovered.progress.unwrap().completed, U64::from(3));
    assert_eq!(recovered.result, Some(f.result(&operation, 3, 0)));
}

#[test]
fn retention_removes_only_expired_operations_exact_receipt_journals() {
    let f = Fixture::new();
    let expired = f.running();
    let removed = f.journal(&expired);
    f.terminal(&expired);
    let running = f.running();
    let mut retained = f.journal(&running);
    f.advance_days(6);
    let recent = f.running();
    retained.extend(f.journal(&recent));
    f.terminal(&recent);
    for suffix in ["-01", "-0-extra", "-other-0"] {
        let key = format!("{}{}", removed[0], suffix);
        f.document(&key, serde_json::json!({"unrelated":true}));
        retained.push(key);
    }
    f.document("source", serde_json::json!({"original":true}));
    retained.push("source".into());
    f.advance_days(1);
    f.store.prune().unwrap();
    for key in retained {
        assert!(
            f.store.read_document(&id(&key)).unwrap().is_some(),
            "must retain {key}"
        );
    }
    assert_eq!(
        f.store.get(&f.actor, &running.operation_id).unwrap().state,
        OperationState::Running
    );
    assert_eq!(
        f.store.get(&f.actor, &recent.operation_id).unwrap().state,
        OperationState::Failed
    );
    for key in removed {
        assert!(
            f.store.read_document(&id(&key)).unwrap().is_none(),
            "must prune {key}"
        );
    }
}

#[test]
fn receipt_prune_failure_preserves_operation_and_all_evidence_atomically() {
    let f = Fixture::new();
    let expired = f.running();
    let keys = f.journal(&expired);
    f.terminal(&expired);
    f.advance_days(7);
    let db = rusqlite::Connection::open(f.dir.path().join("host-v0/state.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_receipt_prune BEFORE DELETE ON documents BEGIN SELECT RAISE(FAIL,'test prune failure'); END;").unwrap();
    assert_eq!(f.store.prune().unwrap_err().code, "STORAGE_UNAVAILABLE");
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM operations WHERE operation_id=?1",
            [expired.operation_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    for key in &keys {
        assert!(f.store.read_document(&id(key)).unwrap().is_some());
    }
    db.execute_batch("DROP TRIGGER reject_receipt_prune;")
        .unwrap();
    f.store.prune().unwrap();
    for key in keys {
        assert!(f.store.read_document(&id(&key)).unwrap().is_none());
    }
}
