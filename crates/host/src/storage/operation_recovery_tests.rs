use crate::{auth, storage};

use serial_workbench_core::*;
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
    sync::{
        Arc, Barrier, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use storage::{Acceptance, Settlement, Store, canonical_digest};

struct TestClock {
    mono: AtomicU64,
    wall: Mutex<Timestamp>,
}
impl TestClock {
    fn new() -> Self {
        Self {
            mono: AtomicU64::new(0),
            wall: Mutex::new(Timestamp::try_from("2026-11-07T12:00:00Z").unwrap()),
        }
    }
    fn set(&self, mono: u64, wall: &str) {
        self.mono.store(mono, Ordering::SeqCst);
        *self.wall.lock().unwrap() = Timestamp::try_from(wall).unwrap();
    }
}
impl Clock for TestClock {
    fn mono_ns(&self) -> u64 {
        self.mono.load(Ordering::SeqCst)
    }
    fn wall_time(&self) -> Timestamp {
        self.wall.lock().unwrap().clone()
    }
}
fn call(store: &Store, actor: &auth::AuthenticatedActor) -> Call {
    let identity = store.identity().unwrap();
    serde_json::from_value(serde_json::json!({
        "protocolVersion":"0.1", "hostId":identity.host_id, "instanceEpoch":identity.instance_epoch,
        "actorId":actor.id(), "requestId":"33333333-3333-4333-8333-333333333333",
        "requestContext":store.issue_context(actor).unwrap().token,
        "actionId":"session.tx", "target":{"hostId":identity.host_id,"kind":"session","id":"session","sessionId":"session","sessionEpoch":"18446744073709551615"},
        "params":{"bytesBase64":"DQo=","writeWaitMs":"1000"}, "revealTarget":{"pageId":"workbench"}
    })).unwrap()
}
fn accepted(store: &Store, actor: &auth::AuthenticatedActor, call: &Call) -> Operation {
    match store
        .accept(actor, call, &canonical_digest(call).unwrap())
        .unwrap()
    {
        Acceptance::New(operation) | Acceptance::Existing(operation) => operation,
    }
}
#[derive(Default)]
struct Backend {
    writes: AtomicU64,
}
impl Backend {
    fn write(&self) {
        self.writes.fetch_add(1, Ordering::SeqCst);
    }
    fn write_count(&self) -> u64 {
        self.writes.load(Ordering::SeqCst)
    }
}

#[test]
fn concurrent_identical_requests_dispatch_once_and_changed_intents_conflict() {
    let profile = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(profile.path()).unwrap());
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    let backend = Arc::new(Backend::default());
    let barrier = Arc::new(Barrier::new(16));
    let handles = (0..16)
        .map(|_| {
            let (store, actor, request, backend, barrier) = (
                store.clone(),
                actor.clone(),
                request.clone(),
                backend.clone(),
                barrier.clone(),
            );
            std::thread::spawn(move || {
                barrier.wait();
                let admission = store
                    .accept(&actor, &request, &canonical_digest(&request).unwrap())
                    .unwrap();
                match admission {
                    Acceptance::New(operation) => {
                        store.mark_dispatch(&operation.operation_id).unwrap();
                        backend.write();
                        operation.operation_id
                    }
                    Acceptance::Existing(operation) => operation.operation_id,
                }
            })
        })
        .collect::<Vec<_>>();
    let ids = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert!(ids.iter().all(|id| id == &ids[0]));
    assert_eq!(backend.write_count(), 1);
    for change in ["params", "target", "mode", "revision", "lease"] {
        let mut other = request.clone();
        match change {
            "params" => {
                other
                    .params
                    .insert("bytesBase64".into(), JsonValue::String("Cg==".into()));
            }
            "target" => {
                other.target.id = Id::try_from("other").unwrap();
                other.target.session_id = Some(other.target.id.clone());
            }
            "mode" => other.execution_mode = Some(ExecutionMode::Independent),
            "revision" => other.expected_revision = Some(U64::from(u64::MAX)),
            _ => other.lease_id = Some(Id::try_from("lease").unwrap()),
        }
        assert_eq!(
            store
                .accept(&actor, &other, &canonical_digest(&other).unwrap())
                .unwrap_err()
                .code,
            "REQUEST_CONFLICT"
        );
    }
    let mut presentation = request.clone();
    presentation.reveal_target.panel_id = Some(Id::try_from("other-panel").unwrap());
    presentation.execution_mode = Some(ExecutionMode::Interactive);
    assert_eq!(
        canonical_digest(&request).unwrap(),
        canonical_digest(&presentation).unwrap()
    );
    assert!(matches!(
        store
            .accept(
                &actor,
                &presentation,
                &canonical_digest(&presentation).unwrap()
            )
            .unwrap(),
        Acceptance::Existing(_)
    ));
    assert_eq!(backend.write_count(), 1);
}

#[test]
fn expired_context_stays_expired_after_wall_clock_rollback_and_running_is_retained() {
    let profile = tempfile::tempdir().unwrap();
    let clock = Arc::new(TestClock::new());
    let store = Store::open_with_clock(profile.path(), clock.clone()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    let operation = accepted(&store, &actor, &request);
    store.mark_dispatch(&operation.operation_id).unwrap();
    clock.set(86_400_000_000_000, "2026-11-05T12:00:00Z");
    assert_eq!(
        store
            .accept(&actor, &request, &canonical_digest(&request).unwrap())
            .unwrap_err()
            .code,
        "RESULT_EXPIRED"
    );
    clock.set(9 * 86_400_000_000_000, "2026-11-14T12:00:00Z");
    store.prune().unwrap();
    assert_eq!(
        store.get(&actor, &operation.operation_id).unwrap().state,
        OperationState::Running
    );
}

#[test]
fn restart_advances_epoch_rejects_old_invocation_and_preserves_query() {
    let profile = tempfile::tempdir().unwrap();
    let actor = auth::actor("actor-a");
    let store = Store::open(profile.path()).unwrap();
    let first = store.begin_instance().unwrap();
    let request = call(&store, &actor);
    let operation = accepted(&store, &actor, &request);
    drop(store);
    let store = Store::open(profile.path()).unwrap();
    let second = store.begin_instance().unwrap();
    assert_eq!(first.host_id, second.host_id);
    assert_eq!(second.instance_epoch.get(), first.instance_epoch.get() + 1);
    assert_eq!(
        store
            .accept(&actor, &request, &canonical_digest(&request).unwrap())
            .unwrap_err()
            .code,
        "EPOCH_MISMATCH"
    );
    let recovered = store.recover().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].state, OperationState::Interrupted);
    assert_eq!(
        store
            .get(&actor, &operation.operation_id)
            .unwrap()
            .operation_id,
        operation.operation_id
    );
    let mut old_context = request;
    old_context.instance_epoch = second.instance_epoch;
    assert_eq!(
        store
            .accept(
                &actor,
                &old_context,
                &canonical_digest(&old_context).unwrap()
            )
            .unwrap_err()
            .code,
        "RESULT_EXPIRED"
    );
}

#[test]
fn settlement_lock_wait_does_not_shorten_seven_day_retention() {
    use std::sync::atomic::AtomicBool;
    static WAITING: AtomicBool = AtomicBool::new(false);
    fn wait_for_lock(attempt: i32) -> bool {
        WAITING.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1));
        attempt < 2_000
    }
    let profile = tempfile::tempdir().unwrap();
    let clock = Arc::new(TestClock::new());
    let store = Store::open_with_clock(profile.path(), clock.clone()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let operation = accepted(&store, &actor, &call(&store, &actor));
    store.mark_dispatch(&operation.operation_id).unwrap();
    store
        .request(|database| {
            database
                .connection
                .busy_handler(Some(wait_for_lock))
                .unwrap();
            Ok(())
        })
        .unwrap();
    let database =
        rusqlite::Connection::open(profile.path().join("host-v0/state.sqlite3")).unwrap();
    database.execute_batch("BEGIN IMMEDIATE").unwrap();
    let worker_store = store.clone();
    let operation_id = operation.operation_id.clone();
    let worker = std::thread::spawn(move || {
        worker_store.settle(
            &operation_id,
            Settlement {
                state: OperationState::Succeeded,
                result: None,
                error: None,
            },
        )
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while !WAITING.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(WAITING.load(Ordering::SeqCst));
    clock.set(86_400_000_000_000, "2026-11-08T12:00:00Z");
    database.execute_batch("ROLLBACK").unwrap();
    worker.join().unwrap().unwrap();
    clock.set(7 * 86_400_000_000_000, "2026-11-14T12:00:00Z");
    store.prune().unwrap();
    assert_eq!(
        store.get(&actor, &operation.operation_id).unwrap().state,
        OperationState::Succeeded
    );
    clock.set(8 * 86_400_000_000_000, "2026-11-15T12:00:00Z");
    store.prune().unwrap();
    assert_eq!(
        store.get(&actor, &operation.operation_id).unwrap_err().code,
        "NOT_FOUND"
    );
}

#[test]
fn context_expiring_while_waiting_for_sqlite_lock_is_not_accepted() {
    use std::sync::atomic::AtomicBool;
    static WAITING: AtomicBool = AtomicBool::new(false);
    fn wait_for_lock(attempt: i32) -> bool {
        WAITING.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1));
        attempt < 2_000
    }
    let profile = tempfile::tempdir().unwrap();
    let clock = Arc::new(TestClock::new());
    let store = Store::open_with_clock(profile.path(), clock.clone()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    store
        .request(|database| {
            database
                .connection
                .busy_handler(Some(wait_for_lock))
                .unwrap();
            Ok(())
        })
        .unwrap();
    let database =
        rusqlite::Connection::open(profile.path().join("host-v0/state.sqlite3")).unwrap();
    database.execute_batch("BEGIN IMMEDIATE").unwrap();
    let worker_store = store.clone();
    let worker = std::thread::spawn(move || {
        worker_store.accept(&actor, &request, &canonical_digest(&request).unwrap())
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while !WAITING.load(Ordering::SeqCst) && Instant::now() < deadline {
        std::thread::yield_now();
    }
    assert!(
        WAITING.load(Ordering::SeqCst),
        "admission did not reach the held SQLite lock"
    );
    clock.set(86_400_000_000_000, "2026-11-05T12:00:00Z");
    database.execute_batch("ROLLBACK").unwrap();
    assert_eq!(worker.join().unwrap().unwrap_err().code, "RESULT_EXPIRED");
    assert_eq!(
        database
            .query_row("SELECT count(*) FROM operations", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn storage_rejection_happens_before_backend_write() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    let backend = Backend::default();
    let database =
        rusqlite::Connection::open(profile.path().join("host-v0/state.sqlite3")).unwrap();
    database.execute_batch("CREATE TRIGGER reject_accept BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'injected full disk'); END;").unwrap();
    let result = store.accept(&actor, &request, &canonical_digest(&request).unwrap());
    if matches!(result, Ok(Acceptance::New(_))) {
        backend.write();
    }
    assert_eq!(result.unwrap_err().code, "STORAGE_UNAVAILABLE");
    assert_eq!(backend.write_count(), 0);
    assert_eq!(
        database
            .query_row("SELECT count(*) FROM operations", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn dispatch_commit_failure_does_not_allow_backend_write_or_claim_unknown() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    let operation = accepted(&store, &actor, &request);
    let backend = Backend::default();
    let database =
        rusqlite::Connection::open(profile.path().join("host-v0/state.sqlite3")).unwrap();
    database.execute_batch("CREATE TRIGGER reject_dispatch BEFORE UPDATE OF dispatched ON operations WHEN NEW.dispatched=1 BEGIN SELECT RAISE(ABORT,'injected full disk'); END;").unwrap();
    let result = store.mark_dispatch(&operation.operation_id);
    if result.is_ok() {
        backend.write();
    }
    assert_eq!(result.unwrap_err().code, "STORAGE_UNAVAILABLE");
    assert_eq!(backend.write_count(), 0);
    assert_eq!(
        store.recover().unwrap()[0].state,
        OperationState::Interrupted
    );
}

#[test]
fn settled_operation_cannot_be_dispatched_or_settled_again() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    let operation = accepted(&store, &actor, &request);
    store.mark_dispatch(&operation.operation_id).unwrap();
    let finished = store
        .settle(
            &operation.operation_id,
            Settlement {
                state: OperationState::Succeeded,
                result: None,
                error: None,
            },
        )
        .unwrap();
    assert_eq!(
        store
            .mark_dispatch(&operation.operation_id)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(
        store
            .settle(
                &operation.operation_id,
                Settlement {
                    state: OperationState::Failed,
                    result: None,
                    error: None
                }
            )
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(
        store.get(&actor, &operation.operation_id).unwrap(),
        finished
    );
}

#[test]
fn future_database_is_rejected_without_touching_original_bytes() {
    let profile = tempfile::tempdir().unwrap();
    fs::create_dir(profile.path().join("host-v0")).unwrap();
    let path = profile.path().join("host-v0/state.sqlite3");
    let database = rusqlite::Connection::open(&path).unwrap();
    database.execute_batch("PRAGMA user_version=999; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('retain');").unwrap();
    drop(database);
    let before = fs::read(&path).unwrap();
    let error = match Store::open(profile.path()) {
        Ok(_) => panic!("future DB was opened for writes"),
        Err(error) => error,
    };
    assert_eq!(error.code, "FUTURE_FORMAT");
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(!path.with_extension("sqlite3-journal").exists());
}

#[test]
fn recovery_preserves_confirmed_partial_receipt_without_replaying_unknown_tail() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let mut request = call(&store, &actor);
    request
        .params
        .insert("bytesBase64".into(), JsonValue::String("AQIDBAU=".into()));
    let operation = accepted(&store, &actor, &request);
    store.mark_dispatch(&operation.operation_id).unwrap();
    let evidence = ActionResult::Tx(TxReceipt {
        operation_id: operation.operation_id.clone(),
        session_id: Id::try_from("session").unwrap(),
        session_epoch: U64::from(u64::MAX),
        outcome: TxOutcome::Unknown,
        bytes_base64: Bytes::try_from("AQIDBAU=").unwrap(),
        byte_start: U64::from(0),
        byte_end: U64::from(5),
        accepted_ranges: vec![ByteRange {
            start: U64::from(0),
            end: U64::from(3),
        }],
        unknown_ranges: vec![ByteRange {
            start: U64::from(3),
            end: U64::from(5),
        }],
        peer_acknowledged: False,
        backend_error: None,
    });
    let updated = store
        .record_result_evidence(&operation.operation_id, &evidence)
        .unwrap();
    assert_eq!(updated.revision.get(), 3);
    drop(store);
    let store = Store::open(profile.path()).unwrap();
    store.begin_instance().unwrap();
    store.recover().unwrap();
    let recovered = store.get(&actor, &operation.operation_id).unwrap();
    assert_eq!(recovered.state, OperationState::Unknown);
    assert_eq!(recovered.result, Some(evidence.clone()));
    assert_eq!(
        store
            .record_result_evidence(&operation.operation_id, &evidence)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
}

#[test]
fn terminal_retention_is_seven_days_and_old_request_never_reenters() {
    let profile = tempfile::tempdir().unwrap();
    let clock = Arc::new(TestClock::new());
    let store = Store::open_with_clock(profile.path(), clock.clone()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    let operation = accepted(&store, &actor, &request);
    store.mark_dispatch(&operation.operation_id).unwrap();
    store
        .settle(
            &operation.operation_id,
            Settlement {
                state: OperationState::Succeeded,
                result: None,
                error: None,
            },
        )
        .unwrap();
    clock.set(604_799_000_000_000, "2026-11-14T11:59:59Z");
    store.prune().unwrap();
    assert_eq!(
        store.get(&actor, &operation.operation_id).unwrap().state,
        OperationState::Succeeded
    );
    clock.set(604_800_000_000_000, "2026-11-14T12:00:00Z");
    store.prune().unwrap();
    assert_eq!(
        store.get(&actor, &operation.operation_id).unwrap_err().code,
        "NOT_FOUND"
    );
    assert_eq!(
        store
            .accept(&actor, &request, &canonical_digest(&request).unwrap())
            .unwrap_err()
            .code,
        "RESULT_EXPIRED"
    );
}

#[test]
fn context_authentication_binds_actor_host_epoch_and_rejects_tampering() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let clock = TestClock::new();
    let signer = auth::ContextSigner::new();
    let issued = signer.issue(&actor, &identity, &clock).unwrap();
    signer
        .validate(&issued.token, &actor, &identity, &clock)
        .unwrap();
    assert_eq!(
        signer
            .validate(&issued.token, &auth::actor("actor-b"), &identity, &clock)
            .unwrap_err()
            .code,
        "ACTOR_MISMATCH"
    );
    let mut other_host = identity.clone();
    other_host.host_id = Id::try_from("other-host").unwrap();
    assert_eq!(
        signer
            .validate(&issued.token, &actor, &other_host, &clock)
            .unwrap_err()
            .code,
        "HOST_ID_MISMATCH"
    );
    assert_eq!(
        auth::ContextSigner::new()
            .validate(&issued.token, &actor, &identity, &clock)
            .unwrap_err()
            .code,
        "RESULT_EXPIRED"
    );
    use base64::Engine;
    let mut bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(issued.token.as_str())
        .unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    let tampered = ContextToken::try_from(
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(bytes)
            .as_str(),
    )
    .unwrap();
    assert_eq!(
        signer
            .validate(&tampered, &actor, &identity, &clock)
            .unwrap_err()
            .code,
        "UNAUTHENTICATED"
    );
    assert_eq!(
        signer
            .validate(
                &ContextToken::try_from("AA").unwrap(),
                &actor,
                &identity,
                &clock
            )
            .unwrap_err()
            .code,
        "UNAUTHENTICATED"
    );
}

#[test]
fn all_u64_values_round_trip_as_text_without_signed_integer_conversion() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let mut request = call(&store, &actor);
    request.expected_revision = Some(U64::from(u64::MAX));
    let operation = accepted(&store, &actor, &request);
    assert_eq!(
        store
            .get(&actor, &operation.operation_id)
            .unwrap()
            .target
            .session_epoch
            .unwrap()
            .get(),
        u64::MAX
    );
    drop(store);
    let database =
        rusqlite::Connection::open(profile.path().join("host-v0/state.sqlite3")).unwrap();
    database
        .execute(
            "UPDATE host_identity SET instance_epoch=?1",
            [u64::MAX.to_string()],
        )
        .unwrap();
    let (value, kind): (String, String) = database
        .query_row(
            "SELECT instance_epoch,typeof(instance_epoch) FROM host_identity",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(value, "18446744073709551615");
    assert_eq!(kind, "text");
    drop(database);
    let store = Store::open(profile.path()).unwrap();
    assert_eq!(
        store.begin_instance().unwrap_err().code,
        "COUNTER_EXHAUSTED"
    );
    let database =
        rusqlite::Connection::open(profile.path().join("host-v0/state.sqlite3")).unwrap();
    assert_eq!(
        database
            .query_row("SELECT host_id FROM host_identity", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        identity.host_id.as_str()
    );
}

#[test]
fn actor_spoofing_and_forged_digest_do_not_create_operations() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    assert_eq!(
        store
            .accept(
                &auth::actor("actor-b"),
                &request,
                &canonical_digest(&request).unwrap()
            )
            .unwrap_err()
            .code,
        "ACTOR_MISMATCH"
    );
    let forged =
        Digest::try_from("0000000000000000000000000000000000000000000000000000000000000000")
            .unwrap();
    assert_eq!(
        store.accept(&actor, &request, &forged).unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    let database =
        rusqlite::Connection::open(profile.path().join("host-v0/state.sqlite3")).unwrap();
    assert_eq!(
        database
            .query_row("SELECT count(*) FROM operations", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn normal_restarts_accumulate_retention_without_comparing_clock_origins() {
    let profile = tempfile::tempdir().unwrap();
    let actor = auth::actor("actor-a");
    let clock = Arc::new(TestClock::new());
    let store = Store::open_with_clock(profile.path(), clock.clone()).unwrap();
    store.begin_instance().unwrap();
    let request = call(&store, &actor);
    let operation = accepted(&store, &actor, &request);
    store.mark_dispatch(&operation.operation_id).unwrap();
    store
        .settle(
            &operation.operation_id,
            Settlement {
                state: OperationState::Succeeded,
                result: None,
                error: None,
            },
        )
        .unwrap();
    clock.set(2 * 86_400_000_000_000, "2026-11-05T12:00:00Z");
    drop(store);
    for elapsed_days in [2, 2, 1] {
        let clock = Arc::new(TestClock::new());
        let store = Store::open_with_clock(profile.path(), clock.clone()).unwrap();
        store.begin_instance().unwrap();
        assert!(store.get(&actor, &operation.operation_id).is_ok());
        clock.set(elapsed_days * 86_400_000_000_000, "2026-11-05T12:00:00Z");
        store.prune().unwrap();
        if elapsed_days == 1 {
            assert_eq!(
                store.get(&actor, &operation.operation_id).unwrap_err().code,
                "NOT_FOUND"
            );
        }
        drop(store);
    }
}

#[test]
fn document_cas_rejects_stale_revision_and_preserves_committed_value() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    store.begin_instance().unwrap();
    let id = Id::try_from("settings").unwrap();
    assert!(store.read_document(&id).unwrap().is_none());
    let first = serde_json::from_value(serde_json::json!({"theme":"dark"})).unwrap();
    let saved = store
        .compare_and_swap_document(&id, U64::from(0), first)
        .unwrap();
    assert_eq!(saved.revision.get(), 1);
    let second = serde_json::from_value(serde_json::json!({"theme":"light"})).unwrap();
    assert_eq!(
        store
            .compare_and_swap_document(&id, U64::from(0), second)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(store.read_document(&id).unwrap().unwrap(), saved);
    drop(store);
    let store = Store::open(profile.path()).unwrap();
    assert_eq!(store.read_document(&id).unwrap().unwrap(), saved);
}

#[test]
#[ignore = "仅由进程恢复测试启动的隔离子进程"]
fn crash_fixture_child() {
    let Ok(path) = std::env::var("SWB_OPERATION_TEST_PROFILE") else {
        return;
    };
    let stage = std::env::var("SWB_OPERATION_TEST_STAGE").unwrap();
    let profile = Path::new(&path);
    let store = Store::open(profile).unwrap();
    store.begin_instance().unwrap();
    let actor = auth::actor("actor-a");
    let request = call(&store, &actor);
    let operation = accepted(&store, &actor, &request);
    if stage == "after_dispatch" {
        store.mark_dispatch(&operation.operation_id).unwrap();
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(profile.join("backend-writes"))
            .unwrap();
        file.write_all(b"write\n").unwrap();
        file.sync_all().unwrap();
    }
    fs::write(
        profile.join("operation.json"),
        serde_json::to_vec(&operation).unwrap(),
    )
    .unwrap();
    fs::write(profile.join("ready"), b"ready").unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
fn process_kill_before_and_after_dispatch_recovers_without_resending() {
    for (stage, want, writes) in [
        ("before_dispatch", OperationState::Interrupted, 0),
        ("after_dispatch", OperationState::Unknown, 1),
    ] {
        let profile = tempfile::tempdir().unwrap();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "--ignored",
                "storage::operation_recovery_tests::crash_fixture_child",
                "--nocapture",
            ])
            .env("SWB_OPERATION_TEST_PROFILE", profile.path())
            .env("SWB_OPERATION_TEST_STAGE", stage)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !profile.path().join("ready").exists() {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("crash fixture exited early: {status}");
            }
            if Instant::now() > deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("crash fixture did not become ready");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let operation: Operation =
            serde_json::from_slice(&fs::read(profile.path().join("operation.json")).unwrap())
                .unwrap();
        let store = Store::open(profile.path()).unwrap();
        store.begin_instance().unwrap();
        store.recover().unwrap();
        assert_eq!(
            store
                .get(&auth::actor("actor-a"), &operation.operation_id)
                .unwrap()
                .state,
            want
        );
        let count = fs::read_to_string(profile.path().join("backend-writes"))
            .unwrap_or_default()
            .lines()
            .count();
        assert_eq!(count, writes);
        assert!(store.recover().unwrap().is_empty());
        assert_eq!(
            fs::read_to_string(profile.path().join("backend-writes"))
                .unwrap_or_default()
                .lines()
                .count(),
            writes
        );
    }
}
