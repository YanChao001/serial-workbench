//! 安装意图的最终提交与公开撤权排序；真实dispose和物理退出不由门替代。
use super::lifecycle_tests::{
    controller, disable_call, grant_controller, installed, reject_control, runtime,
};
use super::*;
use crate::test_support::{
    self as support,
    node_host_actions::{Fixture, spec},
};
use serde_json::json;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_commit_before_rejects_cancelled_or_revoked_control() {
    for cancelled in [false, true] {
        at_commit(false, cancelled).await;
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_commit_after_preserves_receipt_for_cancel_and_revoke() {
    for cancelled in [false, true] {
        at_commit(true, cancelled).await;
    }
}

async fn at_commit(after: bool, cancelled: bool) {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-disable-cas-control-");
    let fixture = fixture(&markers, false).await;
    let archive = fixture.archive.clone();
    let before = runtime(&fixture).await;
    let (mut node, mut child) = processes(&markers);
    let controller = controller(&fixture).await;
    let mut committing = if after {
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
    let call = disable_call(&fixture, &controller);
    let accepted = fixture.invoke(&controller, call.clone()).await;
    committing.entered().await;
    let physical_exit = node.exited() && child.exited();
    let at_gate = installed(&fixture).await;
    reject_control(&fixture, &controller, &accepted, cancelled).await;
    committing.release();
    let terminal = fixture.wait(&controller, &accepted.operation_id).await;
    let saved = installed(&fixture).await;
    let runtime = runtime(&fixture).await;
    if !cancelled {
        grant_controller(&fixture, &controller).await;
    }
    let replay = fixture.invoke(&controller, call).await;
    let events = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    child.reap_adopted_after_observation();
    assert!(
        physical_exit,
        "Actual disposal must finish before the selected CAS boundary"
    );
    assert_eq!(at_gate.revision, if after { 4.into() } else { 3.into() });
    assert_eq!(saved.revision, at_gate.revision);
    assert_eq!(saved.packages[0].archive_sha256, archive);
    assert!(saved.packages[0].source_verified && saved.packages[0].execution_approved);
    if after {
        committed(&terminal, &saved, OperationState::Succeeded);
        assert!(terminal.error.is_none());
    } else {
        assert!(saved.packages[0].enabled);
        assert_eq!(
            terminal.state,
            if cancelled {
                OperationState::Cancelled
            } else {
                OperationState::Interrupted
            },
            "{terminal:?}"
        );
        assert_eq!(
            terminal.error.as_ref().unwrap().code,
            if cancelled {
                "CANCELLED"
            } else {
                "PERMISSION_DENIED"
            }
        );
        assert!(terminal.result.is_none());
    }
    assert_eq!(replay, terminal);
    assert_eq!(runtime.phase, NodePackageRuntimePhase::Inactive);
    assert_eq!(runtime.generation, before.generation);
    assert_eq!(runtime.archive_sha256, before.archive_sha256);
    assert_eq!(events, "register\ndispose\n");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        events
    );
    eprintln!(
        "native_disable_cas_control after={after} cancelled={cancelled} physical_exit=true revision={} state={:?} replay_unchanged=true",
        saved.revision, terminal.state
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_commit_during_cancel_preserves_admitted_synchronous_commit() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-disable-sync-cancel-");
    let fixture = fixture(&markers, false).await;
    let (mut node, mut child) = processes(&markers);
    let controller = controller(&fixture).await;
    let mut committing = fixture.host.inner.store.schema_commit_ready.arm();
    let call = disable_call(&fixture, &controller);
    let accepted = fixture.invoke(&controller, call.clone()).await;
    committing.entered().await;
    let physical_exit = node.exited() && child.exited();
    // 已通过最后合作检查并进入同步提交调用；取消请求不伪造已提交的结果为未执行。
    reject_control(&fixture, &controller, &accepted, true).await;
    committing.release();
    let terminal = fixture.wait(&controller, &accepted.operation_id).await;
    let saved = installed(&fixture).await;
    let replay = fixture.invoke(&controller, call).await;
    let _profile = fixture.finish().await;
    child.reap_adopted_after_observation();
    assert!(physical_exit);
    committed(&terminal, &saved, OperationState::Succeeded);
    assert_eq!(replay, terminal);
    assert!(terminal.error.is_none());
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        "register\ndispose\n"
    );
    eprintln!(
        "native_disable_sync_cancel admitted_commit=true cancel_requested=true actual_revision=4 receipt_preserved=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_commit_waiting_for_authorization_remains_cancellable() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-disable-auth-wait-");
    let fixture = fixture(&markers, false).await;
    let (mut node, mut child) = processes(&markers);
    let controller = controller(&fixture).await;
    let target = Target {
        kind: ResourceKind::try_from("workspace").unwrap(),
        id: id("held-auth-commit"),
        ..fixture.target.clone()
    };
    let granted = fixture.invoke(&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.authorize",json!({"clientId":controller.attachment().client_id,"permissions":["metadata.read","content.read","workspace.modify"],"targets":[target]}))).await;
    assert_eq!(
        fixture
            .wait(&fixture.user, &granted.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    let QueryResult::Workspace(initial) = fixture
        .query(&controller, &target, "workspace.read", json!({}))
        .await
    else {
        panic!("Expected workspace");
    };
    let mut holding = fixture.host.inner.auth.commit_ready.arm();
    let mut save = fixture.call(
        &controller,
        &target,
        "workspace.save",
        json!({"value":initial.document.value}),
    );
    save.expected_revision = Some(0.into());
    let save = fixture.invoke(&controller, save).await;
    holding.entered().await;
    let mut waiting = fixture.host.inner.auth.commit_waiting.arm();
    let accepted = fixture
        .invoke(&controller, disable_call(&fixture, &controller))
        .await;
    waiting.entered().await;
    let physical_exit = node.exited() && child.exited();
    waiting.release();
    reject_control(&fixture, &controller, &accepted, true).await;
    let terminal = fixture.wait(&controller, &accepted.operation_id).await;
    let QueryResult::Operation(still_held) = fixture
        .query(
            &controller,
            &fixture.target,
            "operation.get",
            json!({"operationId":save.operation_id}),
        )
        .await
    else {
        panic!("Expected held commit operation");
    };
    let saved = installed(&fixture).await;
    holding.release();
    let save = fixture.wait(&controller, &save.operation_id).await;
    let _profile = fixture.finish().await;
    child.reap_adopted_after_observation();
    assert!(physical_exit);
    assert_eq!(
        still_held.operation.state,
        OperationState::Running,
        "The unrelated real Auth commit must remain held while disable cancellation settles"
    );
    assert_eq!(terminal.state, OperationState::Cancelled, "{terminal:?}");
    assert_eq!(terminal.error.as_ref().unwrap().code, "CANCELLED");
    assert!(terminal.result.is_none());
    assert_eq!(saved.revision, 3.into());
    assert!(saved.packages[0].enabled);
    assert_eq!(save.state, OperationState::Succeeded, "{save:?}");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        "register\ndispose\n"
    );
    eprintln!(
        "native_disable_auth_wait actual_serial_contention=true cancelled_before_serial_release=true revision=3 physical_exit=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_commit_failed_dispose_keeps_disabled_receipt() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-disable-dispose-error-");
    let fixture = fixture(&markers, true).await;
    let (mut node, mut child) = processes(&markers);
    let controller = controller(&fixture).await;
    let call = disable_call(&fixture, &controller);
    let accepted = fixture.invoke(&controller, call.clone()).await;
    let terminal = fixture.wait(&controller, &accepted.operation_id).await;
    let physical_exit = node.exited() && child.exited();
    let saved = installed(&fixture).await;
    let runtime = runtime(&fixture).await;
    let replay = fixture.invoke(&controller, call).await;
    let events = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    child.reap_adopted_after_observation();
    assert!(
        physical_exit,
        "Failed disposal must actually reap before its failed receipt"
    );
    committed(&terminal, &saved, OperationState::Failed);
    assert_eq!(terminal.error.as_ref().unwrap().code, "NODE_DISPOSE_FAILED");
    assert!(
        !serde_json::to_string(&terminal)
            .unwrap()
            .contains("Private disposer failure")
    );
    assert_eq!(replay, terminal);
    assert_eq!(runtime.phase, NodePackageRuntimePhase::Failed);
    assert_eq!(events, "register\ndispose\n");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        events
    );
    eprintln!(
        "native_disable_dispose_error failed_code=NODE_DISPOSE_FAILED committed_revision=4 enabled=false actual_exit_before_receipt=true replay_unchanged=true"
    );
}

fn committed(terminal: &Operation, saved: &NodePackageListResult, state: OperationState) {
    assert_eq!(terminal.state, state, "{terminal:?}");
    assert_eq!(saved.revision, 4.into());
    assert!(!saved.packages[0].enabled);
    let Some(ActionResult::NodePackageChanged(changed)) = &terminal.result else {
        panic!("Expected real committed installation receipt: {terminal:?}");
    };
    assert_eq!(changed.revision, saved.revision);
    assert_eq!(changed.package, saved.packages[0]);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_commit_during_orders_revocation() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-disable-commit-");
    let fixture = fixture(&markers, false).await;
    let (mut node, mut child) = processes(&markers);
    let controller = controller(&fixture).await;
    let mut committing = fixture.host.inner.store.schema_commit_ready.arm();
    let call = disable_call(&fixture, &controller);
    let accepted = fixture.invoke(&controller, call.clone()).await;
    committing.entered().await;
    let physical_before_cas = node.exited() && child.exited();
    let mut waiting = fixture.host.inner.auth.revocation_waiting.arm();
    let revoked = fixture
        .invoke(&fixture.user, revoke_call(&fixture, &controller))
        .await;
    let mut observed_wait = false;
    let early = tokio::select! {
        () = waiting.entered() => {observed_wait=true;None},
        result = fixture.wait(&fixture.user,&revoked.operation_id) => Some(result),
    };
    let revoked_before_cas = early.is_some();
    committing.release();
    waiting.release();
    let revoked = match early {
        Some(result) => result,
        None => fixture.wait(&fixture.user, &revoked.operation_id).await,
    };
    let terminal = fixture.wait(&controller, &accepted.operation_id).await;
    let saved = installed(&fixture).await;
    let runtime = runtime(&fixture).await;
    let events = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    child.reap_adopted_after_observation();
    eprintln!(
        "native_disable_commit_order waited={observed_wait} revoked_before_cas={revoked_before_cas} physical_exit_before_cas={physical_before_cas} revision={} enabled={} state={:?}",
        saved.revision, saved.packages[0].enabled, terminal.state
    );
    assert!(
        physical_before_cas,
        "Disposal and actual owner/child exit must precede the final installation commit"
    );
    assert_eq!(revoked.state, OperationState::Succeeded);
    if revoked_before_cas {
        assert_eq!(
            saved.revision,
            3.into(),
            "Public revocation completed before actual CAS, but the old controller still persisted a change"
        );
        assert!(saved.packages[0].enabled);
        assert_eq!(terminal.state, OperationState::Interrupted, "{terminal:?}");
        assert!(terminal.result.is_none());
    } else {
        assert!(observed_wait);
        assert_eq!(saved.revision, 4.into());
        assert!(!saved.packages[0].enabled);
        assert_eq!(terminal.state, OperationState::Succeeded, "{terminal:?}");
        let Some(ActionResult::NodePackageChanged(changed)) = terminal.result else {
            panic!("Expected committed installation receipt");
        };
        assert_eq!(changed.revision, saved.revision);
        assert_eq!(changed.package, saved.packages[0]);
    }
    assert_eq!(runtime.phase, NodePackageRuntimePhase::Inactive);
    assert_eq!(events, "register\ndispose\n");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        events
    );
}

async fn fixture(markers: &support::Profile, dispose_fails: bool) -> Fixture {
    let source = format!(
        "import {{appendFileSync,writeFileSync}} from 'node:fs';import {{spawn}} from 'node:child_process';const event=s=>appendFileSync({},s+'\\n');export function register(c){{event('register');const windows=process.platform==='win32';const child=spawn(windows?process.execPath:'/bin/sleep',windows?['--eval','setInterval(()=>{{}},1000)']:['60'],{{stdio:'ignore',windowsHide:true}});writeFileSync({},JSON.stringify({{node:process.pid,child:child.pid}}));c.actions.register('example.terminal.compute',q=>({{value:q.params.value,calls:1}}));return ()=>{{event('dispose');if({dispose_fails})throw Error('Private disposer failure');}};}}",
        serde_json::to_string(&markers.path().join("events.txt")).unwrap(),
        serde_json::to_string(&markers.path().join("processes.json")).unwrap()
    );
    Fixture::program(spec(), source.as_bytes()).await
}
fn processes(
    markers: &support::Profile,
) -> (
    support::node_owner_exit::ProcessExit,
    support::node_owner_exit::ProcessExit,
) {
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(markers.path().join("processes.json")).unwrap())
            .unwrap();
    (
        support::node_owner_exit::ProcessExit::observe(
            u32::try_from(value["node"].as_u64().unwrap()).unwrap(),
        ),
        support::node_owner_exit::ProcessExit::observe(
            u32::try_from(value["child"].as_u64().unwrap()).unwrap(),
        ),
    )
}
fn revoke_call(fixture: &Fixture, controller: &serial_workbench_client::HostClient) -> Call {
    fixture.call(&fixture.user,&fixture.target,"auth.revoke",json!({"actorId":controller.attachment().actor_id,"permissions":["plugins.manage"],"targets":[fixture.target]}))
}

#[path = "execution_trust_tests.rs"]
mod execution_trust_tests;
