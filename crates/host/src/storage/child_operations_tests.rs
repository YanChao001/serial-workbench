//! 使用真实Store边界验证父子接纳；不把请求上下文用于延长根请求窗口。
use super::{Acceptance, Store, canonical_digest};
use crate::auth;
use serial_workbench_core::*;
use std::sync::{
    Arc, Barrier,
    atomic::{AtomicU64, Ordering},
};

#[path = "child_summary_tests.rs"]
mod summary_tests;

#[test]
fn running_owner_admits_child_once_and_advances_parent_watermark_atomically() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let actor = auth::actor("task-owner");
    let call: Call = serde_json::from_value(serde_json::json!({
        "protocolVersion":"1.0","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,
        "actorId":actor.id(),"requestId":"33333333-3333-4333-8333-333333333333",
        "requestContext":store.issue_context(&actor).unwrap().token,"actionId":"example.parent",
        "target":{"hostId":identity.host_id,"kind":"host","id":identity.host_id},
        "params":{},"executionMode":"independent","revealTarget":{"pageId":"workbench"}
    }))
    .unwrap();
    let Acceptance::New(parent) = store
        .accept(&actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!("Expected parent")
    };
    store.mark_dispatch(&parent.operation_id).unwrap();
    let owner_instance = parent.operation_id.clone();
    let token = store
        .issue_task_context(&parent.operation_id, &owner_instance)
        .unwrap();
    let mut child: ChildCall = serde_json::from_value(serde_json::json!({
        "protocolVersion":"1.0","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,
        "actorId":actor.id(),"taskContext":token,"parentOperationId":parent.operation_id,"childKey":"1",
        "actionId":"workspace.create","target":call.target,"params":{"name":"child"},"revealTarget":{"pageId":"workbench"}
    })).unwrap();
    let Acceptance::New(first) = store.accept_child(&actor, &child, &owner_instance).unwrap()
    else {
        panic!("Expected child")
    };
    assert_eq!(first.root_operation_id, parent.operation_id);
    assert_eq!(first.execution_mode, ExecutionMode::Independent);
    assert_ne!(first.request_id, parent.request_id);
    assert!(
        matches!(&first.admission,Admission::Child{parent_operation_id,child_key,..} if parent_operation_id==&parent.operation_id && child_key.get()==1)
    );
    let parent_after = store.get(&actor, &parent.operation_id).unwrap();
    assert_eq!(parent_after.child_high_watermark.get(), 1);
    assert_eq!(parent_after.revision.get(), 3);
    let Acceptance::Existing(replayed) =
        store.accept_child(&actor, &child, &owner_instance).unwrap()
    else {
        panic!("Expected replay")
    };
    assert_eq!(replayed, first);
    assert_eq!(
        store.get(&actor, &parent.operation_id).unwrap(),
        parent_after
    );
    child.params = serde_json::from_value(serde_json::json!({"name":"conflict"})).unwrap();
    assert_eq!(
        store
            .accept_child(&actor, &child, &owner_instance)
            .unwrap_err()
            .code,
        "REQUEST_CONFLICT"
    );
    child.child_key = serde_json::from_value(serde_json::json!("3")).unwrap();
    assert_eq!(
        store
            .accept_child(&actor, &child, &owner_instance)
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(
        store.get(&actor, &parent.operation_id).unwrap(),
        parent_after
    );
}

struct TaskFixture {
    store: Store,
    actor: auth::AuthenticatedActor,
    parent: Operation,
    root_call: Call,
    child: ChildCall,
    _profile: crate::test_support::Profile,
}
impl TaskFixture {
    fn new(clock: Arc<dyn Clock>) -> Self {
        let profile = crate::test_support::Profile::isolated("host-child-admission-");
        let store = Store::open_with_clock(profile.path(), clock).unwrap();
        let identity = store.begin_instance().unwrap();
        let actor = auth::actor("task-owner");
        let root_call: Call = serde_json::from_value(serde_json::json!({
            "protocolVersion":"1.0","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,
            "actorId":actor.id(),"requestId":"33333333-3333-4333-8333-333333333333",
            "requestContext":store.issue_context(&actor).unwrap().token,"actionId":"example.parent",
            "target":{"hostId":identity.host_id,"kind":"host","id":identity.host_id},
            "params":{},"executionMode":"independent","revealTarget":{"pageId":"workbench"}
        })).unwrap();
        let Acceptance::New(parent) = store
            .accept(&actor, &root_call, &canonical_digest(&root_call).unwrap())
            .unwrap()
        else {
            panic!("Expected parent")
        };
        let token = store
            .dispatch_task(&parent.operation_id, &parent.operation_id)
            .unwrap();
        let child = serde_json::from_value(serde_json::json!({
            "protocolVersion":"1.0","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,
            "actorId":actor.id(),"taskContext":token,"parentOperationId":parent.operation_id,"childKey":"1",
            "actionId":"workspace.create","target":root_call.target,"params":{"name":"child"},"revealTarget":{"pageId":"workbench"}
        })).unwrap();
        Self {
            store,
            actor,
            parent,
            root_call,
            child,
            _profile: profile,
        }
    }
    fn accept(&self, child: &ChildCall) -> HostResult<Acceptance> {
        self.store
            .accept_child(&self.actor, child, &self.parent.operation_id)
    }
    fn watermark(&self) -> u64 {
        self.store
            .get(&self.actor, &self.parent.operation_id)
            .unwrap()
            .child_high_watermark
            .get()
    }
}

#[derive(Default)]
struct TestClock(AtomicU64);
impl Clock for TestClock {
    fn mono_ns(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
    fn wall_time(&self) -> Timestamp {
        Timestamp::try_from("2026-11-17T00:00:00Z").unwrap()
    }
}

#[test]
fn concurrent_same_child_key_has_one_persisted_acceptance() {
    let fixture = TaskFixture::new(Arc::new(crate::clock::SystemClock::default()));
    let ready = Barrier::new(12);
    let results = std::thread::scope(|scope| {
        let workers = (0..12)
            .map(|_| {
                scope.spawn(|| {
                    ready.wait();
                    fixture.accept(&fixture.child).unwrap()
                })
            })
            .collect::<Vec<_>>();
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        results
            .iter()
            .filter(|value| matches!(value, Acceptance::New(_)))
            .count(),
        1
    );
    let ids = results
        .iter()
        .map(|value| match value {
            Acceptance::New(op) | Acceptance::Existing(op) => op.operation_id.clone(),
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(ids.len(), 1);
    assert_eq!(fixture.watermark(), 1);
    assert_eq!(
        fixture
            .store
            .get(&fixture.actor, &fixture.parent.operation_id)
            .unwrap()
            .revision
            .get(),
        3
    );
}

#[test]
fn task_credentials_reject_wrong_actor_owner_and_tampering_without_consuming_key() {
    let fixture = TaskFixture::new(Arc::new(crate::clock::SystemClock::default()));
    let wrong = Id::try_from("wrong-owner").unwrap();
    assert_eq!(
        fixture
            .store
            .accept_child(&fixture.actor, &fixture.child, &wrong)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let stranger = auth::actor("stranger");
    let mut child = fixture.child.clone();
    child.actor_id = stranger.id().clone();
    assert_eq!(
        fixture
            .store
            .accept_child(&stranger, &child, &fixture.parent.operation_id)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    child = fixture.child.clone();
    let mut token = child.task_context.as_str().as_bytes().to_vec();
    let last = token.last_mut().unwrap();
    *last = if *last == b'A' { b'B' } else { b'A' };
    child.task_context = ContextToken::try_from(std::str::from_utf8(&token).unwrap()).unwrap();
    assert_eq!(fixture.accept(&child).unwrap_err().code, "UNAUTHENTICATED");
    child.task_context = fixture.root_call.request_context.clone();
    assert_eq!(fixture.accept(&child).unwrap_err().code, "UNAUTHENTICATED");
    assert_eq!(fixture.watermark(), 0);
    assert!(matches!(
        fixture.accept(&fixture.child).unwrap(),
        Acceptance::New(_)
    ));
}

#[test]
fn parent_cancellation_closes_child_admission_and_queued_dispatch() {
    let fixture = TaskFixture::new(Arc::new(crate::clock::SystemClock::default()));
    let Acceptance::New(child) = fixture.accept(&fixture.child).unwrap() else {
        panic!("Expected child")
    };
    fixture
        .store
        .request_cancel(&fixture.actor, &fixture.parent.operation_id)
        .unwrap();
    assert_eq!(
        fixture.accept(&fixture.child).unwrap_err().code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(
        fixture
            .store
            .issue_task_context(&fixture.parent.operation_id, &fixture.parent.operation_id)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(
        fixture
            .store
            .mark_dispatch(&child.operation_id)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(
        fixture
            .store
            .get(&fixture.actor, &child.operation_id)
            .unwrap()
            .state,
        OperationState::Cancelled
    );
    assert_eq!(fixture.watermark(), 1);
}

#[test]
fn running_task_outlives_root_acceptance_window_and_expired_child_key_never_readmits() {
    let clock = Arc::new(TestClock::default());
    let fixture = TaskFixture::new(clock.clone());
    let after_root = 86_400_000_000_001_u64;
    clock.0.store(after_root, Ordering::SeqCst);
    assert_eq!(
        fixture
            .store
            .accept(
                &fixture.actor,
                &fixture.root_call,
                &canonical_digest(&fixture.root_call).unwrap()
            )
            .unwrap_err()
            .code,
        "RESULT_EXPIRED"
    );
    let Acceptance::New(child) = fixture.accept(&fixture.child).unwrap() else {
        panic!("Expected child")
    };
    fixture.store.mark_dispatch(&child.operation_id).unwrap();
    fixture
        .store
        .settle(
            &child.operation_id,
            super::Settlement {
                state: OperationState::Succeeded,
                result: None,
                error: None,
            },
        )
        .unwrap();
    clock
        .0
        .store(after_root + 604_800_000_000_001, Ordering::SeqCst);
    let selector = OperationGetParams::ByChild {
        parent_operation_id: fixture.parent.operation_id.clone(),
        child_key: fixture.child.child_key,
    };
    assert_eq!(
        fixture
            .store
            .get_selected(&fixture.actor, &selector)
            .unwrap_err()
            .code,
        "RESULT_EXPIRED"
    );
    assert_eq!(
        fixture.accept(&fixture.child).unwrap_err().code,
        "RESULT_EXPIRED"
    );
    let mut next = fixture.child.clone();
    next.child_key = serde_json::from_value(serde_json::json!("2")).unwrap();
    assert!(matches!(fixture.accept(&next).unwrap(), Acceptance::New(_)));
    assert_eq!(fixture.watermark(), 2);
}

#[test]
fn parent_cannot_commit_a_terminal_state_while_an_accepted_child_is_running() {
    let fixture = TaskFixture::new(Arc::new(crate::clock::SystemClock::default()));
    let Acceptance::New(child) = fixture.accept(&fixture.child).unwrap() else {
        panic!("Expected child")
    };
    fixture.store.mark_dispatch(&child.operation_id).unwrap();
    let error = fixture
        .store
        .settle(
            &fixture.parent.operation_id,
            super::Settlement {
                state: OperationState::Succeeded,
                result: None,
                error: None,
            },
        )
        .expect_err("Parent terminal commit must wait for its running child");
    assert_eq!(error.code, "OPERATION_HAS_CHILDREN");
    assert_eq!(
        fixture
            .store
            .get(&fixture.actor, &fixture.parent.operation_id)
            .unwrap()
            .state,
        OperationState::Running
    );
    fixture
        .store
        .settle(
            &child.operation_id,
            super::Settlement {
                state: OperationState::Succeeded,
                result: None,
                error: None,
            },
        )
        .unwrap();
    assert_eq!(
        fixture
            .store
            .settle(
                &fixture.parent.operation_id,
                super::Settlement {
                    state: OperationState::Succeeded,
                    result: None,
                    error: None
                }
            )
            .unwrap()
            .state,
        OperationState::Succeeded
    );
}

#[test]
fn reopening_host_cannot_reissue_a_task_for_an_old_running_owner() {
    let TaskFixture {
        store,
        actor,
        parent,
        child,
        _profile,
        ..
    } = TaskFixture::new(Arc::new(crate::clock::SystemClock::default()));
    drop(store);
    let reopened = Store::open(_profile.path()).unwrap();
    let identity = reopened.begin_instance().unwrap();
    assert!(identity.instance_epoch > child.instance_epoch);
    assert_eq!(
        reopened
            .accept_child(&actor, &child, &parent.operation_id)
            .unwrap_err()
            .code,
        "EPOCH_MISMATCH"
    );
    assert_eq!(
        reopened
            .issue_task_context(&parent.operation_id, &parent.operation_id)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
}

#[test]
fn parent_cancellation_propagates_to_queued_running_and_nested_children() {
    let fixture = TaskFixture::new(Arc::new(crate::clock::SystemClock::default()));
    let Acceptance::New(first) = fixture.accept(&fixture.child).unwrap() else {
        panic!("Expected child")
    };
    let token = fixture
        .store
        .dispatch_task(&first.operation_id, &first.operation_id)
        .unwrap();
    let mut next = fixture.child.clone();
    next.child_key = serde_json::from_value(serde_json::json!("2")).unwrap();
    let Acceptance::New(second) = fixture.accept(&next).unwrap() else {
        panic!("Expected child")
    };
    let mut nested = fixture.child.clone();
    nested.parent_operation_id = first.operation_id.clone();
    nested.task_context = token;
    let Acceptance::New(nested) = fixture
        .store
        .accept_child(&fixture.actor, &nested, &first.operation_id)
        .unwrap()
    else {
        panic!("Expected nested child")
    };
    let cancelled = fixture
        .store
        .request_cancel(&fixture.actor, &fixture.parent.operation_id)
        .unwrap();
    assert_eq!(cancelled.state, OperationState::CancelRequested);
    assert_eq!(
        fixture
            .store
            .get(&fixture.actor, &first.operation_id)
            .unwrap()
            .state,
        OperationState::CancelRequested
    );
    for id in [&second.operation_id, &nested.operation_id] {
        assert_eq!(
            fixture.store.get(&fixture.actor, id).unwrap().state,
            OperationState::Cancelled
        );
    }
    fixture
        .store
        .settle(
            &first.operation_id,
            super::Settlement {
                state: OperationState::Cancelled,
                result: None,
                error: None,
            },
        )
        .unwrap();
    assert_eq!(
        fixture
            .store
            .settle(
                &fixture.parent.operation_id,
                super::Settlement {
                    state: OperationState::Cancelled,
                    result: None,
                    error: None
                }
            )
            .unwrap()
            .state,
        OperationState::Cancelled
    );
}

#[test]
fn expired_unknown_child_is_summarized_before_pruning_and_forces_parent_unknown() {
    let clock = Arc::new(TestClock::default());
    let fixture = TaskFixture::new(clock.clone());
    let Acceptance::New(child) = fixture.accept(&fixture.child).unwrap() else {
        panic!("Expected child")
    };
    fixture.store.mark_dispatch(&child.operation_id).unwrap();
    fixture
        .store
        .settle(
            &child.operation_id,
            super::Settlement {
                state: OperationState::Unknown,
                result: None,
                error: None,
            },
        )
        .unwrap();
    clock.0.store(604_800_000_000_001, Ordering::SeqCst);
    fixture.store.prune().unwrap();
    assert_eq!(
        fixture
            .store
            .get(&fixture.actor, &child.operation_id)
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    let settled = fixture
        .store
        .settle(
            &fixture.parent.operation_id,
            super::Settlement {
                state: OperationState::Succeeded,
                result: None,
                error: None,
            },
        )
        .unwrap();
    assert_eq!(settled.state, OperationState::Unknown);
    assert_eq!(settled.error.unwrap().code, "CHILD_OUTCOME_UNKNOWN");
}
