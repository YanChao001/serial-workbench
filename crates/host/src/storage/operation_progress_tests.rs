use super::{Acceptance, Settlement, Store, canonical_digest};
use crate::auth;
use serial_workbench_core::*;

#[test]
fn progress_is_monotone_and_terminal_updates_preserve_original_evidence() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let actor = auth::actor("progress-owner");
    let call: Call = serde_json::from_value(serde_json::json!({"protocolVersion":"0.1","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,"actorId":actor.id(),"requestId":"33333333-3333-4333-8333-333333333333","requestContext":store.issue_context(&actor).unwrap().token,"actionId":"capture.start","target":{"hostId":identity.host_id,"kind":"file","id":"target"},"params":{},"revealTarget":{"pageId":"workbench"},"executionMode":"independent"})).unwrap();
    let Acceptance::New(operation) = store
        .accept(&actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!("new operation")
    };
    let progress = Progress {
        completed: 3.into(),
        unit: "records".into(),
        total: None,
    };
    assert_eq!(
        store
            .record_progress(&operation.operation_id, &progress)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    store.mark_dispatch(&operation.operation_id).unwrap();
    let reference = ActionResult::Reference(ResultReference {
        result_ref: ObjectRef {
            host_id: identity.host_id,
            kind: ResourceKind::try_from("capture").unwrap(),
            id: Id::try_from("capture").unwrap(),
            revision: None,
        },
    });
    store
        .record_result_evidence(&operation.operation_id, &reference)
        .unwrap();
    let first = store
        .record_progress(&operation.operation_id, &progress)
        .unwrap();
    assert_eq!(first.progress, Some(progress.clone()));
    assert_eq!(first.result, Some(reference.clone()));
    assert_eq!(
        store
            .record_progress(&operation.operation_id, &progress)
            .unwrap()
            .revision,
        first.revision
    );
    let mut backwards = progress.clone();
    backwards.completed = 2.into();
    assert_eq!(
        store
            .record_progress(&operation.operation_id, &backwards)
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let mut changed_unit = progress.clone();
    changed_unit.unit = "bytes".into();
    assert_eq!(
        store
            .record_progress(&operation.operation_id, &changed_unit)
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let settled = store
        .settle(
            &operation.operation_id,
            Settlement {
                state: OperationState::Unknown,
                result: Some(reference),
                error: None,
            },
        )
        .unwrap();
    let mut late = progress;
    late.completed = 4.into();
    assert_eq!(
        store
            .record_progress(&operation.operation_id, &late)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(store.get(&actor, &operation.operation_id).unwrap(), settled);
}
