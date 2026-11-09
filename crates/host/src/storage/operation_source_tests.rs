use super::{Acceptance, Settlement, Store, canonical_digest};
use crate::auth;
use serial_workbench_core::*;
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
fn id(s: &str) -> Id {
    Id::try_from(s).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    actor: auth::AuthenticatedActor,
    clock: Arc<TestClock>,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(TestClock(AtomicU64::new(0)));
        let store = Store::open_with_clock(dir.path(), clock.clone()).unwrap();
        store.begin_instance().unwrap();
        Self {
            dir,
            store,
            actor: auth::actor("source-owner"),
            clock,
        }
    }
    fn call(&self) -> Call {
        let identity = self.store.identity().unwrap();
        serde_json::from_value(serde_json::json!({
            "protocolVersion":"0.1", "hostId":identity.host_id, "instanceEpoch":identity.instance_epoch,
            "actorId":self.actor.id(), "requestId":uuid::Uuid::new_v4().to_string(),
            "requestContext":self.store.issue_context(&self.actor).unwrap().token,
            "actionId":"capture.recover", "target":self.source("output"), "params":{},
            "revealTarget":{"pageId":"workbench"}
        })).unwrap()
    }
    fn queued(&self) -> Operation {
        let call = self.call();
        let Acceptance::New(operation) = self
            .store
            .accept(&self.actor, &call, &canonical_digest(&call).unwrap())
            .unwrap()
        else {
            panic!("new")
        };
        operation
    }
    fn source(&self, name: &str) -> Target {
        Target {
            host_id: self.store.identity().unwrap().host_id,
            kind: ResourceKind::try_from("file").unwrap(),
            id: id(name),
            session_id: None,
            session_epoch: None,
        }
    }
    fn key(&self, op: &Operation) -> Id {
        id(&format!("operation-source-{}", op.operation_id))
    }
    fn seed(&self, op: &Operation) {
        self.store
            .compare_and_swap_document(
                &self.key(op),
                0.into(),
                serde_json::from_value(
                    serde_json::json!({"formatVersion":"0.1","source":self.source("original")}),
                )
                .unwrap(),
            )
            .unwrap();
    }
    fn finish(&self, op: &Operation) {
        self.store.mark_dispatch(&op.operation_id).unwrap();
        self.store
            .settle(
                &op.operation_id,
                Settlement {
                    state: OperationState::Failed,
                    result: None,
                    error: Some(HostError::new("TEST_FAILURE", "test")),
                },
            )
            .unwrap();
    }
    fn expire(&self) {
        self.clock.0.store(7 * 86_400_000_000_000, Ordering::SeqCst);
    }
}

#[test]
fn accepted_queued_operation_already_has_immutable_source_authority() {
    let f = Fixture::new();
    let call = f.call();
    let digest = canonical_digest(&call).unwrap();
    let source = f.source("original");
    let Acceptance::New(operation) = f
        .store
        .accept_with_source(&f.actor, &call, &digest, Some(&source))
        .unwrap()
    else {
        panic!("new operation")
    };
    assert_eq!(operation.state, OperationState::Queued);
    assert_eq!(
        f.store
            .operation_source_authority(&operation.operation_id)
            .unwrap(),
        source
    );
    let Acceptance::Existing(duplicate) = f
        .store
        .accept_with_source(&f.actor, &call, &digest, Some(&f.source("replacement")))
        .unwrap()
    else {
        panic!("duplicate operation")
    };
    assert_eq!(duplicate.operation_id, operation.operation_id);
    assert_eq!(
        f.store
            .operation_source_authority(&operation.operation_id)
            .unwrap(),
        source,
        "duplicate acceptance must not replace trusted provenance"
    );
}

#[test]
fn source_authority_is_bound_before_dispatch_idempotent_and_private() {
    let f = Fixture::new();
    let operation = f.queued();
    let source = f.source("original");
    f.store
        .record_operation_source_authority(&operation.operation_id, &source)
        .unwrap();
    f.store
        .record_operation_source_authority(&operation.operation_id, &source)
        .unwrap();
    assert_eq!(
        f.store
            .record_operation_source_authority(&operation.operation_id, &f.source("replacement"))
            .unwrap_err()
            .code,
        "REQUEST_CONFLICT"
    );
    assert_eq!(
        f.store.get(&f.actor, &operation.operation_id).unwrap(),
        operation
    );
    f.finish(&operation);
    assert_eq!(
        f.store
            .operation_source_authority(&operation.operation_id)
            .unwrap(),
        source
    );
    let late = f.queued();
    f.store.mark_dispatch(&late.operation_id).unwrap();
    assert_eq!(
        f.store
            .record_operation_source_authority(&late.operation_id, &source)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    let public =
        serde_json::to_string(&f.store.get(&f.actor, &operation.operation_id).unwrap()).unwrap();
    assert!(!public.contains("original"));
    assert!(
        !serde_json::to_string(&f.store.operation_metadata().unwrap())
            .unwrap()
            .contains("original")
    );
    f.expire();
    assert_eq!(
        f.store
            .operation_source_authority(&operation.operation_id)
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
}

#[test]
fn source_authority_prune_uses_exact_operation_retention_without_deleting_live_or_similar_facts() {
    let f = Fixture::new();
    let expired = f.queued();
    let live = f.queued();
    f.seed(&expired);
    f.seed(&live);
    f.finish(&expired);
    let similar = id(&format!("{}-other", f.key(&expired)));
    f.store
        .compare_and_swap_document(
            &similar,
            0.into(),
            serde_json::from_value(serde_json::json!({"unrelated":true})).unwrap(),
        )
        .unwrap();
    f.expire();
    f.store.prune().unwrap();
    assert!(f.store.read_document(&f.key(&expired)).unwrap().is_none());
    assert!(f.store.read_document(&f.key(&live)).unwrap().is_some());
    assert!(f.store.read_document(&similar).unwrap().is_some());
    assert_eq!(
        f.store.get(&f.actor, &live.operation_id).unwrap().state,
        OperationState::Queued
    );
}

#[test]
fn source_authority_prune_failure_preserves_operation_and_fact_in_the_same_transaction() {
    let f = Fixture::new();
    let expired = f.queued();
    f.seed(&expired);
    f.finish(&expired);
    f.expire();
    let db = rusqlite::Connection::open(f.dir.path().join("host-v0/state.sqlite3")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_source_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(FAIL,'test source delete failure'); END;").unwrap();
    assert_eq!(f.store.prune().unwrap_err().code, "STORAGE_UNAVAILABLE");
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM operations WHERE operation_id=?1",
            [expired.operation_id.as_str()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert!(f.store.read_document(&f.key(&expired)).unwrap().is_some());
    db.execute_batch("DROP TRIGGER reject_source_delete;")
        .unwrap();
    f.store.prune().unwrap();
    assert!(f.store.read_document(&f.key(&expired)).unwrap().is_none());
}
