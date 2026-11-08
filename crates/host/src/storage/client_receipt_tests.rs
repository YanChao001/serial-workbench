use super::{Acceptance, Settlement, Store, canonical_digest};
use crate::auth;
use serial_workbench_core::*;

struct Fixture {
    _dir: tempfile::TempDir,
    store: Store,
    actor: auth::AuthenticatedActor,
    operation: Operation,
    receipt: ClientEffectReceipt,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let identity = store.begin_instance().unwrap();
        let actor = auth::actor("effect-owner");
        let call:Call=serde_json::from_value(serde_json::json!({"protocolVersion":"0.1","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,"actorId":actor.id(),"requestId":"33333333-3333-4333-8333-333333333333","requestContext":store.issue_context(&actor).unwrap().token,"actionId":"client.window.minimize","target":{"hostId":identity.host_id,"kind":"client","id":"viewer"},"params":{},"revealTarget":{"pageId":"settings"}})).unwrap();
        let Acceptance::New(operation) = store
            .accept(&actor, &call, &canonical_digest(&call).unwrap())
            .unwrap()
        else {
            panic!("new")
        };
        store.mark_dispatch(&operation.operation_id).unwrap();
        let operation = store.get(&actor, &operation.operation_id).unwrap();
        let receipt = ClientEffectReceipt {
            host_id: identity.host_id,
            instance_epoch: identity.instance_epoch,
            client_target_id: Id::try_from("viewer").unwrap(),
            generation: 1.into(),
            delivery_id: Id::try_from("delivery").unwrap(),
            outcome: ClientEffectOutcome::Succeeded {
                result: ClientEffectResult::Applied {},
            },
        };
        Self {
            _dir: dir,
            store,
            actor,
            operation,
            receipt,
        }
    }
}
#[test]
fn client_receipt_is_atomic_idempotent_and_conflicting_receipt_cannot_replace_evidence() {
    let f = Fixture::new();
    let first = f
        .store
        .record_client_receipt_evidence(&f.operation.operation_id, &f.receipt)
        .unwrap();
    assert_eq!(first.state, f.operation.state);
    assert_eq!(first.result, f.operation.result);
    assert_eq!(first.error, f.operation.error);
    assert_eq!(first.settled_at, f.operation.settled_at);
    assert_eq!(first.result_expires_at, f.operation.result_expires_at);
    assert_eq!(
        serde_json::to_value(&first).unwrap()["clientEffectReceipt"],
        serde_json::to_value(&f.receipt).unwrap()
    );
    assert_eq!(
        f.store
            .record_client_receipt_evidence(&f.operation.operation_id, &f.receipt)
            .unwrap(),
        first
    );
    let mut conflict = f.receipt.clone();
    conflict.outcome = ClientEffectOutcome::Failed {
        error: HostError::new("PLATFORM_FAILED", "Platform effect failed"),
    };
    assert_eq!(
        f.store
            .record_client_receipt_evidence(&f.operation.operation_id, &conflict)
            .unwrap_err()
            .code,
        "REQUEST_CONFLICT"
    );
    assert_eq!(
        f.store.get(&f.actor, &f.operation.operation_id).unwrap(),
        first
    );
}
#[test]
fn late_receipt_preserves_unknown_state_and_original_settlement_and_retention() {
    let f = Fixture::new();
    let unknown = f
        .store
        .settle(
            &f.operation.operation_id,
            Settlement {
                state: OperationState::Unknown,
                result: None,
                error: Some(HostError::new(
                    "BACKEND_DISCONNECTED",
                    "Receiver disconnected",
                )),
            },
        )
        .unwrap();
    let late = f
        .store
        .record_client_receipt_evidence(&f.operation.operation_id, &f.receipt)
        .unwrap();
    assert_eq!(late.state, OperationState::Unknown);
    assert_eq!(late.result, unknown.result);
    assert_eq!(late.error, unknown.error);
    assert_eq!(late.settled_at, unknown.settled_at);
    assert_eq!(late.result_expires_at, unknown.result_expires_at);
    assert_eq!(late.revision, unknown.revision.checked_next().unwrap());
    assert_eq!(
        serde_json::to_value(&late).unwrap()["clientEffectReceipt"],
        serde_json::to_value(&f.receipt).unwrap()
    );
}
#[test]
fn client_receipt_storage_failure_preserves_the_exact_operation() {
    let f = Fixture::new();
    let database = rusqlite::Connection::open(f._dir.path().join("host-v0/state.sqlite3")).unwrap();
    database.execute_batch("CREATE TRIGGER fail_client_receipt BEFORE UPDATE OF operation_json ON operations BEGIN SELECT RAISE(ABORT,'receipt write denied'); END;").unwrap();
    assert_eq!(
        f.store
            .record_client_receipt_evidence(&f.operation.operation_id, &f.receipt)
            .unwrap_err()
            .code,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(
        f.store.get(&f.actor, &f.operation.operation_id).unwrap(),
        f.operation
    );
}
