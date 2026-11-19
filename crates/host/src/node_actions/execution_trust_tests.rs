//! 撤销执行确认复用停用的真实退出与提交边界，不由门代替dispose或进程回收。
use super::*;
use crate::node_packages::NodePackageInstaller;
use serde_json::Value;
use serial_workbench_client::HostClient;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_execution_trust_revocation_stops_owner_and_requires_confirmation() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-execution-trust-");
    let fixture = fixture(&markers, false).await;
    let (mut node, mut child) = processes(&markers);
    let archive = fixture.archive.clone();
    let before = runtime(&fixture).await;
    let original = installation_record(&fixture).await;
    // register 实际写出的插件文件；不引入尚未接线的产品私有数据目录约定。
    let plugin_state_path = markers.path().join("processes.json");
    let original_plugin_state = std::fs::read(&plugin_state_path).unwrap();
    let code_path = fixture
        .dir
        .path()
        .join("host-v0/node-packages/objects")
        .join(original["objectId"].as_str().unwrap())
        .join("dist/main.mjs");
    let original_code = std::fs::read(&code_path).unwrap();
    let archive_path = fixture.dir.path().join("signed-actions.zip");
    let original_archive = std::fs::read(&archive_path).unwrap();
    let business_call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":7}),
    );
    let business = fixture.invoke(&fixture.client, business_call.clone()).await;
    let business = fixture.wait(&fixture.client, &business.operation_id).await;
    let business_value = fixture.result(&fixture.client, &business).await;
    let call = execution_revoke_call(&fixture, &fixture.user);
    let accepted = fixture.invoke(&fixture.user, call.clone()).await;
    let terminal = fixture.wait(&fixture.user, &accepted.operation_id).await;
    let node_exited = node.exited();
    let child_exited = child.exited();
    let saved = installed(&fixture).await;
    let revoked_record = installation_record(&fixture).await;
    let stopped = runtime(&fixture).await;
    let replay = fixture.invoke(&fixture.user, call.clone()).await;
    let business_replay = fixture.invoke(&fixture.client, business_call).await;
    let enable = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
            4,
        )
        .await;
    let after_enable = installed(&fixture).await;
    let confirmed = fixture
        .mutate(
            &fixture.user,
            "node.packages.confirmExecutionTrust",
            json!({"id":"example.terminal","archiveSha256":fixture.archive}),
            4,
        )
        .await;
    let after_confirm = installed(&fixture).await;
    let confirmed_runtime = runtime(&fixture).await;
    let replay_after_confirm = fixture.invoke(&fixture.user, call).await;
    let retained_code = std::fs::read(&code_path).unwrap();
    let retained_archive = std::fs::read(&archive_path).unwrap();
    let retained_plugin_state = std::fs::read(&plugin_state_path).unwrap();
    let events = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    assert!(
        child.exited(),
        "Fixture cleanup must observe the child's actual exit"
    );
    child.reap_adopted_after_observation();

    assert_eq!(business.state, OperationState::Succeeded, "{business:?}");
    assert_eq!(business_value, json!({"value":7,"calls":1}));
    assert!(
        node_exited && child_exited,
        "Actual Node and child exit must precede the revocation receipt"
    );
    committed(&terminal, &saved, OperationState::Succeeded);
    assert!(terminal.error.is_none());
    assert!(!saved.packages[0].execution_approved);
    assert!(saved.packages[0].source_verified);
    assert_revoked_record(&original, &revoked_record);
    assert_eq!(retained_code, original_code);
    assert_eq!(retained_archive, original_archive);
    assert_eq!(retained_plugin_state, original_plugin_state);
    assert_eq!(replay, terminal);
    assert_eq!(replay_after_confirm, terminal);
    assert_eq!(business_replay, business);
    assert_eq!(enable.state, OperationState::Interrupted, "{enable:?}");
    assert_eq!(enable.error.as_ref().unwrap().code, "PERMISSION_DENIED");
    assert!(enable.result.is_none());
    assert_eq!(after_enable, saved);
    assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
    let Some(ActionResult::NodePackageChanged(confirmation)) = &confirmed.result else {
        panic!("Expected a new manual execution confirmation: {confirmed:?}");
    };
    assert_eq!(after_confirm.revision, 5.into());
    assert_eq!(confirmation.revision, after_confirm.revision);
    assert_eq!(confirmation.package, after_confirm.packages[0]);
    assert!(!after_confirm.packages[0].enabled);
    assert!(after_confirm.packages[0].execution_approved);
    assert!(after_confirm.packages[0].source_verified);
    assert_eq!(after_confirm.packages[0].archive_sha256, archive);
    assert_eq!(stopped.phase, NodePackageRuntimePhase::Inactive);
    assert_eq!(confirmed_runtime.phase, NodePackageRuntimePhase::Inactive);
    assert_eq!(stopped.generation, before.generation);
    assert_eq!(confirmed_runtime.generation, before.generation);
    assert_eq!(events, "register\ndispose\n");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        events
    );
    eprintln!(
        "native_execution_trust_revoke revision=4 enabled=false execution_approved=false actual_exit_before_receipt=true replay_unchanged=true manual_confirmation_revision=5 inactive=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_execution_trust_invalid_control_preserves_active_owner() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-execution-trust-invalid-");
    let fixture = fixture(&markers, false).await;
    let (mut node, mut child) = processes(&markers);
    let before = runtime(&fixture).await;
    let original = installation_record(&fixture).await;
    let controller = controller(&fixture).await;
    let ordinary = controller
        .request(RpcRequest::Invoke(execution_revoke_call(
            &fixture,
            &controller,
        )))
        .await
        .unwrap();
    let after_ordinary = installed(&fixture).await;
    let grant = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "auth.authorize",
                json!({"clientId":controller.attachment().client_id,"permissions":["auth.manage"],"targets":[fixture.target]}),
            ),
        )
        .await;
    let grant = fixture.wait(&fixture.user, &grant.operation_id).await;
    // auth.manage本就不是可转授的业务scope；保留真实拒绝，不能伪造已授权的测试前提。
    assert_eq!(grant.state, OperationState::Failed, "{grant:?}");
    assert_eq!(grant.error.as_ref().unwrap().code, "INVALID_ARGUMENT");
    assert!(grant.result.is_none());
    let ordinary_after_invalid_grant = controller
        .request(RpcRequest::Invoke(execution_revoke_call(
            &fixture,
            &controller,
        )))
        .await
        .unwrap();
    let after_invalid_grant = installed(&fixture).await;
    let mut stale_call = execution_revoke_call(&fixture, &fixture.user);
    stale_call.expected_revision = Some(2.into());
    let stale = fixture.invoke(&fixture.user, stale_call).await;
    let stale = fixture.wait(&fixture.user, &stale.operation_id).await;
    let after_stale = installed(&fixture).await;
    let mut wrong_archive_call = execution_revoke_call(&fixture, &fixture.user);
    wrong_archive_call.params = serde_json::from_value(json!({
        "id":"example.terminal","archiveSha256":"0".repeat(64)
    }))
    .unwrap();
    let wrong_archive = fixture.invoke(&fixture.user, wrong_archive_call).await;
    let wrong_archive = fixture
        .wait(&fixture.user, &wrong_archive.operation_id)
        .await;
    let after_wrong_archive = installed(&fixture).await;
    let unchanged = installation_record(&fixture).await;
    let after = runtime(&fixture).await;
    let owner_alive = !node.exited();
    let child_alive = !child.exited();
    let events = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    let node_exited = node.exited();
    let child_exited = child.exited();
    child.reap_adopted_after_observation();

    let RpcReply::Failure { error, .. } = ordinary else {
        panic!("Ordinary plugins.manage must not revoke execution trust: {ordinary:?}");
    };
    assert_eq!(error.code, "PERMISSION_DENIED");
    let RpcReply::Failure { error, .. } = ordinary_after_invalid_grant else {
        panic!(
            "Rejected authorization must not create local user control: {ordinary_after_invalid_grant:?}"
        );
    };
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert_eq!(stale.state, OperationState::Failed, "{stale:?}");
    assert_eq!(stale.error.as_ref().unwrap().code, "REVISION_CONFLICT");
    assert!(stale.result.is_none());
    assert_eq!(
        wrong_archive.state,
        OperationState::Failed,
        "{wrong_archive:?}"
    );
    assert_eq!(
        wrong_archive.error.as_ref().unwrap().code,
        "INTEGRITY_FAILED"
    );
    assert!(wrong_archive.result.is_none());
    assert_eq!(after_ordinary.revision, 3.into());
    assert_eq!(after_invalid_grant, after_ordinary);
    assert_eq!(after_stale, after_ordinary);
    assert_eq!(after_wrong_archive, after_ordinary);
    assert!(after_ordinary.packages[0].enabled && after_ordinary.packages[0].execution_approved);
    assert_eq!(unchanged, original);
    assert!(
        owner_alive && child_alive,
        "Rejected control cannot dispose the actual owner or child"
    );
    assert_eq!(after.phase, NodePackageRuntimePhase::Active);
    assert_eq!(after.generation, before.generation);
    assert_eq!(after.archive_sha256, before.archive_sha256);
    assert_eq!(events, "register\n");
    assert!(
        node_exited && child_exited,
        "Normal fixture shutdown must still reap both processes"
    );
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        "register\ndispose\n"
    );
    eprintln!(
        "native_execution_trust_invalid ordinary=PERMISSION_DENIED auth_manage_delegation=INVALID_ARGUMENT still_ordinary=true stale=REVISION_CONFLICT archive=INTEGRITY_FAILED revision=3 no_dispose=true same_owner=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_execution_trust_failed_dispose_keeps_committed_revocation() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-execution-trust-dispose-error-");
    let fixture = fixture(&markers, true).await;
    let original = installation_record(&fixture).await;
    let (mut node, mut child) = processes(&markers);
    let call = execution_revoke_call(&fixture, &fixture.user);
    let accepted = fixture.invoke(&fixture.user, call.clone()).await;
    let terminal = fixture.wait(&fixture.user, &accepted.operation_id).await;
    let node_exited = node.exited();
    let child_exited = child.exited();
    let saved = installed(&fixture).await;
    let record = installation_record(&fixture).await;
    let after = runtime(&fixture).await;
    let replay = fixture.invoke(&fixture.user, call).await;
    let events = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    assert!(
        child.exited(),
        "Fixture cleanup must observe the child's actual exit"
    );
    child.reap_adopted_after_observation();

    assert!(
        node_exited && child_exited,
        "Failed disposal must actually reap before its failed receipt"
    );
    committed(&terminal, &saved, OperationState::Failed);
    assert_eq!(terminal.error.as_ref().unwrap().code, "NODE_DISPOSE_FAILED");
    assert!(!saved.packages[0].execution_approved);
    assert!(saved.packages[0].source_verified);
    assert_revoked_record(&original, &record);
    assert_eq!(replay, terminal);
    assert_eq!(after.phase, NodePackageRuntimePhase::Failed);
    assert!(
        !serde_json::to_string(&terminal)
            .unwrap()
            .contains("Private disposer failure")
    );
    assert_eq!(events, "register\ndispose\n");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        events
    );
    eprintln!(
        "native_execution_trust_dispose_error failed_code=NODE_DISPOSE_FAILED committed_revision=4 enabled=false execution_approved=false actual_exit_before_receipt=true replay_unchanged=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_execution_trust_delivery_failure_keeps_owner_until_new_request() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-execution-trust-delivery-");
    let fixture = fixture(&markers, false).await;
    let (mut node, mut child) = processes(&markers);
    let before = runtime(&fixture).await;
    let original = installation_record(&fixture).await;
    let initial = installed(&fixture).await;
    // 只在接纳前投递边界返回一次真实错误，不代表已填满实际控制队列。
    fixture
        .host
        .inner
        .node_test_gates
        .fail_dispose_request_once
        .store(true, std::sync::atomic::Ordering::Release);
    let call = execution_revoke_call(&fixture, &fixture.user);
    let accepted = fixture.invoke(&fixture.user, call.clone()).await;
    let rejected = fixture.wait(&fixture.user, &accepted.operation_id).await;
    let after_failure = installed(&fixture).await;
    let record_after_failure = installation_record(&fixture).await;
    let running = runtime(&fixture).await;
    let owner_alive = !node.exited();
    let child_alive = !child.exited();
    let replay = fixture.invoke(&fixture.user, call.clone()).await;
    let business = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":11}),
            ),
        )
        .await;
    let business = fixture.wait(&fixture.client, &business.operation_id).await;
    let business_value = fixture.result(&fixture.client, &business).await;
    let events_after_failure = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let retry_call = execution_revoke_call(&fixture, &fixture.user);
    let retry = fixture.invoke(&fixture.user, retry_call.clone()).await;
    let retry = fixture.wait(&fixture.user, &retry.operation_id).await;
    let node_exited = node.exited();
    let child_exited = child.exited();
    let saved = installed(&fixture).await;
    let revoked_record = installation_record(&fixture).await;
    let stopped = runtime(&fixture).await;
    let replay_after_commit = fixture.invoke(&fixture.user, call).await;
    let retry_replay = fixture.invoke(&fixture.user, retry_call).await;
    let events = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    assert!(
        child.exited(),
        "Fixture cleanup must observe the child's actual exit"
    );
    child.reap_adopted_after_observation();

    assert_eq!(rejected.state, OperationState::Failed, "{rejected:?}");
    assert_eq!(rejected.error.as_ref().unwrap().code, "HOST_BUSY");
    assert!(rejected.result.is_none());
    assert_eq!(initial.revision, 3.into());
    assert_eq!(after_failure, initial);
    assert!(after_failure.packages[0].enabled && after_failure.packages[0].execution_approved);
    assert_eq!(record_after_failure, original);
    assert!(
        owner_alive && child_alive,
        "A failed pre-delivery revoke must leave the original processes alive"
    );
    assert_eq!(running.phase, NodePackageRuntimePhase::Active);
    assert_eq!(running.generation, before.generation);
    assert_eq!(running.archive_sha256, before.archive_sha256);
    assert_eq!(business.state, OperationState::Succeeded, "{business:?}");
    assert_eq!(business_value, json!({"value":11,"calls":1}));
    assert_eq!(events_after_failure, "register\n");
    assert_eq!(replay, rejected);
    assert_eq!(replay_after_commit, rejected);
    assert_ne!(retry.operation_id, rejected.operation_id);
    assert!(
        node_exited && child_exited,
        "The new request must actually stop Node and child before its receipt"
    );
    committed(&retry, &saved, OperationState::Succeeded);
    assert!(retry.error.is_none());
    assert!(!saved.packages[0].execution_approved);
    assert_revoked_record(&original, &revoked_record);
    assert_eq!(retry_replay, retry);
    assert_eq!(stopped.phase, NodePackageRuntimePhase::Inactive);
    assert_eq!(events, "register\ndispose\n");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        events
    );
    eprintln!(
        "native_execution_trust_delivery_failure rejected=HOST_BUSY revision=3 same_owner_active=true business=succeeded original_replay_unchanged=true new_request_revision=4 actual_exit_before_receipt=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_execution_trust_cancellation_respects_commit_boundary() {
    for after_commit in [false, true] {
        let _reaper = support::node_owner_exit::ParentReaper::install();
        let markers = support::Profile::isolated("host-node-backend-execution-trust-cancel-");
        let fixture = fixture(&markers, false).await;
        let original = installation_record(&fixture).await;
        let (mut node, mut child) = processes(&markers);
        let mut committing = if after_commit {
            fixture
                .host
                .inner
                .node_test_gates
                .disable_after_commit
                .arm()
        } else {
            fixture
                .host
                .inner
                .node_test_gates
                .disable_before_commit
                .arm()
        };
        let call = execution_revoke_call(&fixture, &fixture.user);
        let accepted = fixture.invoke(&fixture.user, call.clone()).await;
        committing.entered().await;
        let node_exited = node.exited();
        let child_exited = child.exited();
        let at_gate = installed(&fixture).await;
        reject_control(&fixture, &fixture.user, &accepted, true).await;
        committing.release();
        let terminal = fixture.wait(&fixture.user, &accepted.operation_id).await;
        let saved = installed(&fixture).await;
        let record = installation_record(&fixture).await;
        let after = runtime(&fixture).await;
        let replay = fixture.invoke(&fixture.user, call).await;
        let events = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
        let _profile = fixture.finish().await;
        assert!(
            child.exited(),
            "Fixture cleanup must observe the child's actual exit"
        );
        child.reap_adopted_after_observation();

        assert!(
            node_exited && child_exited,
            "Actual disposal must precede the selected CAS boundary"
        );
        assert_eq!(
            at_gate.revision,
            if after_commit { 4.into() } else { 3.into() }
        );
        assert_eq!(saved, at_gate);
        if after_commit {
            committed(&terminal, &saved, OperationState::Succeeded);
            assert!(terminal.error.is_none());
            assert!(!saved.packages[0].execution_approved);
            assert_revoked_record(&original, &record);
        } else {
            assert_eq!(terminal.state, OperationState::Cancelled, "{terminal:?}");
            assert_eq!(terminal.error.as_ref().unwrap().code, "CANCELLED");
            assert!(terminal.result.is_none());
            assert!(saved.packages[0].enabled && saved.packages[0].execution_approved);
            assert_eq!(record, original);
        }
        assert_eq!(replay, terminal);
        assert_eq!(after.phase, NodePackageRuntimePhase::Inactive);
        assert_eq!(events, "register\ndispose\n");
        assert_eq!(
            std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
            events
        );
        eprintln!(
            "native_execution_trust_cancel after_commit={after_commit} revision={} state={:?} actual_exit_before_cas=true replay_unchanged=true",
            saved.revision, terminal.state
        );
    }
}

fn execution_revoke_call(fixture: &Fixture, client: &HostClient) -> Call {
    let mut call = fixture.call(
        client,
        &fixture.target,
        "node.packages.revokeExecutionTrust",
        json!({"id":"example.terminal","archiveSha256":fixture.archive}),
    );
    call.expected_revision = Some(3.into());
    call
}

async fn installation_record(fixture: &Fixture) -> Value {
    let store = fixture.host.inner.store.clone();
    tokio::task::spawn_blocking(move || {
        let snapshot = NodePackageInstaller::read_snapshot(&store).unwrap();
        assert_eq!(snapshot.packages.len(), 1);
        serde_json::to_value(&snapshot.packages[0]).unwrap()
    })
    .await
    .unwrap()
}

fn assert_revoked_record(original: &Value, revoked: &Value) {
    let mut expected = original.clone();
    assert!(expected["enabled"].as_bool().unwrap());
    assert!(expected["executionTrust"].is_object());
    assert!(expected["activationAuthority"].is_object());
    expected["enabled"] = json!(false);
    expected["executionTrust"] = Value::Null;
    expected
        .as_object_mut()
        .unwrap()
        .remove("activationAuthority");
    assert_eq!(
        revoked, &expected,
        "Revocation must retain the original manifest, archive, source proof and code object"
    );
}
