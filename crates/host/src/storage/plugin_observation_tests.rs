//! 插件观察写入由当前真实派发实例限定，不放宽Host进度写口。
use super::*;
use crate::auth;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

#[test]
fn plugin_observations_bind_dispatch_owner_and_preserve_terminal_facts() {
    let profile = crate::test_support::Profile::isolated("plugin-observation-storage-");
    let store = Store::open(profile.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let actor = auth::actor("observed-plugin");
    let instance = id("actual-plugin-instance");
    let mut spec = BuiltinAction::HostShutdown.spec().clone();
    spec.action_id = id("example.observed.compute");
    spec.cancellation = Cancellation::Cooperative;
    let plugin = PluginOperation {
        format_version: "0.1".into(),
        package: NodePackageId::try_from("example.observed").unwrap(),
        version: NodePackageVersion::try_from("1.0.0").unwrap(),
        archive_sha256: Digest::try_from("a".repeat(64).as_str()).unwrap(),
        instance_id: instance.clone(),
        host_api: Vec::new(),
        spec,
    };
    let call: Call = serde_json::from_value(serde_json::json!({
        "protocolVersion":"1.0","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,
        "actorId":actor.id(),"requestId":"33333333-3333-4333-8333-333333333333",
        "requestContext":store.issue_context(&actor).unwrap().token,
        "actionId":"example.observed.compute","target":{"hostId":identity.host_id,"kind":"host","id":identity.host_id},
        "params":{},"revealTarget":{"pageId":"workbench"},"executionMode":"independent"
    })).unwrap();
    let Acceptance::New(accepted) = store
        .accept_plugin(&actor, &call, &canonical_digest(&call).unwrap(), &plugin)
        .unwrap()
    else {
        panic!("Expected actual plugin admission");
    };
    let operation = &accepted.operation_id;
    let progress = Progress {
        completed: 3.into(),
        unit: "records".into(),
        total: Some(10.into()),
    };
    let sample = WorkerMemorySample {
        sampled_at: Timestamp::try_from("2026-11-18T00:00:00Z").unwrap(),
        measured_workers: 2.into(),
        v8_heap_used_bytes: 16384.into(),
    };
    let workers = WorkerObservation {
        live_workers: 2.into(),
        peak_workers: 2.into(),
        last_memory: Some(sample.clone()),
    };
    assert_eq!(
        store
            .record_plugin_observation(
                operation,
                &instance,
                identity.instance_epoch,
                Some(progress.clone()),
                Some(workers.clone())
            )
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(store.get(&actor, operation).unwrap(), accepted);
    store.dispatch_task(operation, &instance).unwrap();
    assert_eq!(
        store
            .record_progress(operation, &progress)
            .unwrap_err()
            .code,
        "INVALID_OPERATION_OWNER"
    );
    let mut changes = store.subscribe_operation_changes();
    changes.borrow_and_update();
    let mut states = store.subscribe_operation_state_changes();
    states.borrow_and_update();
    let before = store.get(&actor, operation).unwrap();
    let oversized = Progress {
        unit: "x".repeat(serial_workbench_ipc::frame::MAX_FRAME_BYTES - 128),
        ..progress.clone()
    };
    serial_workbench_ipc::frame::encoded_length(
        &oversized,
        serial_workbench_ipc::frame::MAX_FRAME_BYTES,
    )
    .unwrap();
    assert_eq!(
        store
            .record_plugin_observation(
                operation,
                &instance,
                identity.instance_epoch,
                Some(oversized),
                None
            )
            .unwrap_err()
            .code,
        "LIMIT_EXCEEDED"
    );
    assert_eq!(store.get(&actor, operation).unwrap(), before);
    let first = store
        .record_plugin_observation(
            operation,
            &instance,
            identity.instance_epoch,
            Some(progress.clone()),
            Some(workers.clone()),
        )
        .unwrap();
    assert_eq!(first.progress, Some(progress.clone()));
    assert_eq!(first.worker_observation, Some(workers.clone()));
    assert!(changes.has_changed().unwrap());
    assert!(!states.has_changed().unwrap());
    let duplicate = store
        .record_plugin_observation(
            operation,
            &instance,
            identity.instance_epoch,
            Some(progress.clone()),
            Some(workers.clone()),
        )
        .unwrap();
    assert_eq!(duplicate, first);
    assert_eq!(
        store
            .record_plugin_observation(
                operation,
                &id("foreign-instance"),
                identity.instance_epoch,
                Some(progress.clone()),
                None
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        store
            .record_plugin_observation(
                operation,
                &instance,
                identity.instance_epoch.checked_next().unwrap(),
                Some(progress.clone()),
                None
            )
            .unwrap_err()
            .code,
        "EPOCH_MISMATCH"
    );
    let mut backwards = progress.clone();
    backwards.completed = 2.into();
    assert_eq!(
        store
            .record_plugin_observation(
                operation,
                &instance,
                identity.instance_epoch,
                Some(backwards),
                None
            )
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let mut changed_unit = progress.clone();
    changed_unit.unit = "bytes".into();
    assert_eq!(
        store
            .record_plugin_observation(
                operation,
                &instance,
                identity.instance_epoch,
                Some(changed_unit),
                None
            )
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let invalid = WorkerObservation {
        live_workers: 3.into(),
        ..workers.clone()
    };
    assert_eq!(
        store
            .record_plugin_observation(
                operation,
                &instance,
                identity.instance_epoch,
                None,
                Some(invalid)
            )
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    assert_eq!(store.get(&actor, operation).unwrap(), first);
    let cancelled = store.request_cancel(&actor, operation).unwrap();
    assert_eq!(cancelled.state, OperationState::CancelRequested);
    let final_progress = Progress {
        completed: 5.into(),
        ..progress
    };
    let exited = WorkerObservation {
        live_workers: 0.into(),
        peak_workers: 2.into(),
        last_memory: None,
    };
    let final_fact = store
        .record_plugin_observation(
            operation,
            &instance,
            identity.instance_epoch,
            Some(final_progress.clone()),
            Some(exited),
        )
        .unwrap();
    assert_eq!(final_fact.state, OperationState::CancelRequested);
    assert_eq!(final_fact.progress, Some(final_progress.clone()));
    assert_eq!(
        final_fact.worker_observation.as_ref().unwrap().last_memory,
        Some(sample)
    );
    let settled = store
        .settle(
            operation,
            Settlement {
                state: OperationState::Cancelled,
                result: None,
                error: None,
            },
        )
        .unwrap();
    assert_eq!(
        store
            .record_plugin_observation(
                operation,
                &instance,
                identity.instance_epoch,
                Some(final_progress),
                None
            )
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(store.get(&actor, operation).unwrap(), settled);
    drop(store);
    let reopened = Store::open(profile.path()).unwrap();
    let next = reopened.begin_instance().unwrap();
    assert!(next.instance_epoch > identity.instance_epoch);
    assert_eq!(
        reopened
            .record_plugin_observation(operation, &instance, identity.instance_epoch, None, None)
            .unwrap_err()
            .code,
        "EPOCH_MISMATCH"
    );
    assert_eq!(reopened.get(&actor, operation).unwrap(), settled);
}
