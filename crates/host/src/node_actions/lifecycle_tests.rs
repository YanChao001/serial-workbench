//! 停用控制尚未产生原生效果时失败，不应撤下仍真实存活的A贡献。
use super::*;
use crate::test_support::{self as support, node_host_actions};
use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient};
use std::time::Duration;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_revoked_before_dispose_preserves_original_active_owner() {
    stop_before_effect(false).await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_cancelled_before_dispose_preserves_original_active_owner() {
    stop_before_effect(true).await;
}

async fn stop_before_effect(cancelled: bool) {
    let markers = support::Profile::isolated("host-node-backend-stop-before-effect-");
    let events = markers.path().join("events.txt");
    let pid = markers.path().join("node.pid");
    let source = format!(
        "import {{appendFileSync,writeFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(c){{event('register');writeFileSync({},String(process.pid));let calls=0;c.actions.register('example.terminal.compute',q=>{{event('call');return {{value:q.params.value,calls:++calls}};}});return ()=>event('dispose');}}",
        serde_json::to_string(&events).unwrap(),
        serde_json::to_string(&pid).unwrap()
    );
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
    let archive = fixture.archive.clone();
    let mut native = support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(&pid).unwrap().parse().unwrap(),
    );
    let controller = controller(&fixture).await;
    let original_call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":1}),
    );
    let original = fixture.invoke(&fixture.client, original_call.clone()).await;
    let original = fixture.wait(&fixture.client, &original.operation_id).await;
    assert_eq!(original.state, OperationState::Succeeded);
    assert_eq!(
        fixture.result(&fixture.client, &original).await,
        json!({"value":1,"calls":1})
    );
    let before = runtime(&fixture).await;
    let mut stopping = fixture.host.inner.node_test_gates.before_dispose.arm();
    let mut call = fixture.call(
        &controller,
        &fixture.target,
        "node.packages.setEnabled",
        json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":false}),
    );
    call.expected_revision = Some(3.into());
    let accepted = fixture.invoke(&controller, call.clone()).await;
    stopping.entered().await;
    let during = runtime(&fixture).await;
    assert_eq!(during.phase, NodePackageRuntimePhase::Stopping);
    reject_control(&fixture, &controller, &accepted, cancelled).await;
    stopping.release();
    let rejected = fixture.wait(&controller, &accepted.operation_id).await;
    let after = runtime(&fixture).await;
    let QueryResult::NodePackages(installed) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected installation");
    };
    let replay = fixture.invoke(&fixture.client, original_call).await;
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":2}),
        )))
        .await
        .unwrap();
    let fresh = if let RpcReply::Success { result, .. } = reply {
        let RpcResult::Operation(value) = *result else {
            panic!("Expected accepted business");
        };
        Some(
            fixture
                .wait(&fixture.client, &value.operation.operation_id)
                .await,
        )
    } else {
        if let RpcReply::Failure { error, .. } = &reply {
            eprintln!("native_stop_before_effect fresh_error={}", error.code);
        }
        None
    };
    let observed = std::fs::read_to_string(&events).unwrap();
    let owner_alive = !native.exited();
    let fresh_result = if let Some(value) = &fresh {
        Some(fixture.result(&fixture.client, value).await)
    } else {
        None
    };
    if !cancelled {
        let grant=fixture.invoke(&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.authorize",json!({"clientId":controller.attachment().client_id,"permissions":["plugins.manage"],"targets":[fixture.target]}))).await;
        assert_eq!(
            fixture.wait(&fixture.user, &grant.operation_id).await.state,
            OperationState::Succeeded
        );
    }
    let replay_control = fixture.invoke(&controller, call.clone()).await;
    let replay_events = std::fs::read_to_string(&events).unwrap();
    let stopped = fixture
        .mutate(
            &controller,
            "node.packages.setEnabled",
            json!({"id":"example.terminal","archiveSha256":archive,"enabled":false}),
            3,
        )
        .await;
    let stopped_runtime = runtime(&fixture).await;
    let owner_exited_after_stop = native.exited();
    let replay_after_commit = fixture.invoke(&controller, call).await;
    let _profile = fixture.finish().await;
    eprintln!(
        "native_stop_before_effect cancelled={cancelled} control_state={:?} phase={:?} original_owner_alive={owner_alive} installation_revision={} enabled={} fresh_business_succeeded={}",
        rejected.state,
        after.phase,
        installed.revision,
        installed.packages[0].enabled,
        fresh
            .as_ref()
            .is_some_and(|value| value.state == OperationState::Succeeded)
    );
    assert_eq!(
        rejected.state,
        if cancelled {
            OperationState::Cancelled
        } else {
            OperationState::Interrupted
        },
        "{rejected:?}"
    );
    assert!(
        rejected.result.is_none(),
        "A rejected pre-effect disable cannot fabricate a committed change"
    );
    assert_eq!(
        rejected.error.as_ref().unwrap().code,
        if cancelled {
            "CANCELLED"
        } else {
            "PERMISSION_DENIED"
        }
    );
    assert_eq!(
        replay_control, rejected,
        "The rejected control must replay its original receipt"
    );
    assert_eq!(
        replay_after_commit, rejected,
        "A later successful CAS cannot replace the old control receipt"
    );
    assert_eq!(
        replay_events, observed,
        "Replaying control cannot execute dispose"
    );
    assert_eq!(installed.revision, 3.into());
    assert!(installed.packages[0].enabled && installed.packages[0].execution_approved);
    assert_eq!(installed.packages[0].archive_sha256, archive);
    assert_eq!(replay, original);
    assert!(
        owner_alive,
        "Failed pre-effect control cannot stop A's actual owner"
    );
    assert!(
        native.exited(),
        "Final fixture shutdown must reap the original owner"
    );
    assert_eq!(
        after.phase,
        NodePackageRuntimePhase::Active,
        "A still-registered owner was left permanently unavailable"
    );
    assert_eq!(after.generation, before.generation);
    assert_eq!(after.archive_sha256, before.archive_sha256);
    assert_eq!(
        fresh.as_ref().map(|value| value.state),
        Some(OperationState::Succeeded)
    );
    assert_eq!(observed, "register\ncall\ncall\n");
    assert_eq!(fresh_result, Some(json!({"value":2,"calls":2})));
    assert_eq!(stopped.state, OperationState::Succeeded, "{stopped:?}");
    let Some(ActionResult::NodePackageChanged(stopped)) = stopped.result else {
        panic!("Expected committed stop");
    };
    assert_eq!(stopped.revision, 4.into());
    assert!(!stopped.package.enabled);
    assert_eq!(stopped_runtime.phase, NodePackageRuntimePhase::Inactive);
    assert!(
        owner_exited_after_stop,
        "A fresh successful disable must reap the actual owner before its receipt"
    );
    assert_eq!(
        std::fs::read_to_string(events).unwrap(),
        format!("{observed}dispose\n")
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_empty_registered_subset_survives_pre_effect_cancel() {
    let markers = support::Profile::isolated("host-node-backend-stop-empty-");
    let fixture = empty_package(&markers).await;
    let controller = controller(&fixture).await;
    let before = runtime(&fixture).await;
    let mut native = process(&markers);
    let mut stopping = fixture.host.inner.node_test_gates.before_dispose.arm();
    let call = disable_call(&fixture, &controller);
    let accepted = fixture.invoke(&controller, call.clone()).await;
    stopping.entered().await;
    reject_control(&fixture, &controller, &accepted, true).await;
    stopping.release();
    let rejected = fixture.wait(&controller, &accepted.operation_id).await;
    let after = runtime(&fixture).await;
    let installed = installed(&fixture).await;
    let reply = business(&fixture).await;
    let replay = fixture.invoke(&controller, call).await;
    let owner_alive = !native.exited();
    let observed = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    assert_eq!(rejected.state, OperationState::Cancelled);
    assert_eq!(rejected.error.as_ref().unwrap().code, "CANCELLED");
    assert_eq!(replay, rejected);
    assert!(rejected.result.is_none());
    assert_eq!(installed.revision, 3.into());
    assert!(installed.packages[0].enabled && installed.packages[0].execution_approved);
    assert_eq!(after.phase, NodePackageRuntimePhase::Active);
    assert_eq!(after.generation, before.generation);
    assert_eq!(after.archive_sha256, before.archive_sha256);
    assert!(owner_alive && native.exited());
    unsupported(reply);
    assert_eq!(observed, "register\n");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        "register\ndispose\n"
    );
    eprintln!(
        "native_stop_empty same_generation_active=true no_fabricated_handlers=true actual_exit=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_cannot_restore_an_invalid_original_authority_or_source() {
    use sha2::{Digest as _, Sha256};
    for source in [false, true] {
        let markers = support::Profile::isolated("host-node-backend-stop-invalid-original-");
        let fixture = empty_package(&markers).await;
        let controller = controller(&fixture).await;
        let before = runtime(&fixture).await;
        let mut native = process(&markers);
        let mut stopping = fixture.host.inner.node_test_gates.before_dispose.arm();
        let accepted = fixture
            .invoke(&controller, disable_call(&fixture, &controller))
            .await;
        stopping.entered().await;
        reject_control(&fixture, &controller, &accepted, true).await;
        let changed = if source {
            let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
                .verifying_key()
                .to_bytes();
            let fingerprint = format!("{:x}", Sha256::digest(key));
            fixture.mutate(&fixture.user, "node.sources.revokeKey", json!({"source":"test-source","keyId":"test-key","publicKeySha256":fingerprint}), 1).await
        } else {
            let changed=fixture.invoke(&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.revoke",json!({"actorId":fixture.client.attachment().actor_id,"permissions":["plugins.manage"],"targets":[fixture.target]}))).await;
            fixture.wait(&fixture.user, &changed.operation_id).await
        };
        assert_eq!(changed.state, OperationState::Succeeded, "{changed:?}");
        stopping.release();
        let rejected = fixture.wait(&controller, &accepted.operation_id).await;
        wait_exit(&mut native).await;
        let after = runtime(&fixture).await;
        let installed = installed(&fixture).await;
        let reply = business(&fixture).await;
        let observed = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
        let _profile = fixture.finish().await;
        assert_eq!(rejected.state, OperationState::Cancelled, "{rejected:?}");
        assert!(rejected.result.is_none());
        assert_eq!(installed.revision, 3.into());
        assert!(installed.packages[0].enabled && installed.packages[0].execution_approved);
        assert_eq!(after.phase, NodePackageRuntimePhase::Failed, "{after:?}");
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.archive_sha256, before.archive_sha256);
        unsupported(reply);
        assert_eq!(
            observed.matches("register\n").count(),
            1,
            "Invalid original authority cannot import again: {observed:?}"
        );
        eprintln!(
            "native_stop_invalid_original source={source} same_generation_failed=true actual_exit_before_shutdown=true installation_unchanged=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_after_actual_dispose_entry_never_restores_the_old_generation() {
    for cancelled in [false, true] {
        let markers = support::Profile::isolated("host-node-backend-stop-effect-started-");
        let events = markers.path().join("events.txt");
        let pid = markers.path().join("node.pid");
        let entered = markers.path().join("dispose-entered");
        let source = format!(
            "import {{appendFileSync,writeFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(c){{event('register');writeFileSync({},String(process.pid));c.actions.register('example.terminal.compute',q=>{{event('call');return {{value:q.params.value,calls:1}};}});return async()=>{{event('dispose-enter');writeFileSync({},'entered');await new Promise(()=>{{}});event('dispose-complete');}};}}",
            serde_json::to_string(&events).unwrap(),
            serde_json::to_string(&pid).unwrap(),
            serde_json::to_string(&entered).unwrap()
        );
        let fixture =
            node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
        let controller = controller(&fixture).await;
        let before = runtime(&fixture).await;
        let mut native = process(&markers);
        let original_call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":1}),
        );
        let original = fixture.invoke(&fixture.client, original_call.clone()).await;
        let original = fixture.wait(&fixture.client, &original.operation_id).await;
        assert_eq!(original.state, OperationState::Succeeded);
        let mut restore = fixture
            .host
            .inner
            .node_test_gates
            .recovery_before_restore
            .arm();
        let call = disable_call(&fixture, &controller);
        let accepted = fixture.invoke(&controller, call.clone()).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !entered.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Actual JS disposer did not enter");
        reject_control(&fixture, &controller, &accepted, cancelled).await;
        let rejected = fixture.wait(&controller, &accepted.operation_id).await;
        restore.entered().await;
        let actual_exit = native.exited();
        let after = runtime(&fixture).await;
        let installed = installed(&fixture).await;
        let replay_business = fixture.invoke(&fixture.client, original_call).await;
        let fresh = business(&fixture).await;
        if !cancelled {
            grant_controller(&fixture, &controller).await;
        }
        let replay_control = fixture.invoke(&controller, call).await;
        let observed = std::fs::read_to_string(&events).unwrap();
        fixture.host.inner.node_packages.request_quiesce(true);
        restore.release();
        let _profile = fixture.finish().await;
        assert!(
            actual_exit,
            "Post-effect failure must actually reap before its control receipt"
        );
        assert_eq!(after.phase, NodePackageRuntimePhase::Failed, "{after:?}");
        assert_eq!(after.generation, before.generation);
        assert_eq!(after.archive_sha256, before.archive_sha256);
        assert_eq!(
            rejected.state,
            if cancelled {
                OperationState::Cancelled
            } else {
                OperationState::Interrupted
            },
            "{rejected:?}"
        );
        assert_eq!(
            rejected.error.as_ref().unwrap().code,
            if cancelled {
                "CANCELLED"
            } else {
                "PERMISSION_DENIED"
            }
        );
        assert!(rejected.result.is_none());
        assert_eq!(replay_control, rejected);
        assert_eq!(replay_business, original);
        assert_eq!(installed.revision, 3.into());
        assert!(installed.packages[0].enabled && installed.packages[0].execution_approved);
        unsupported(fresh);
        assert_eq!(observed, "register\ncall\ndispose-enter\n");
        assert_eq!(std::fs::read_to_string(events).unwrap(), observed);
        eprintln!(
            "native_stop_effect_started cancelled={cancelled} js_dispose_entered=true actual_exit_before_receipt=true no_old_generation_restore=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_restore_retains_exit_facts_across_real_storage_saturation() {
    let markers = support::Profile::isolated("host-node-backend-stop-store-full-");
    let fixture = empty_package(&markers).await;
    let controller = controller(&fixture).await;
    let before = runtime(&fixture).await;
    let mut native = process(&markers);
    let mut stopping = fixture.host.inner.node_test_gates.before_dispose.arm();
    let mut restore = fixture
        .host
        .inner
        .node_test_gates
        .before_dispose_restore
        .arm();
    let mut restore_failed = fixture
        .host
        .inner
        .node_test_gates
        .dispose_restore_failed
        .arm();
    let mut exit_failed = fixture.host.inner.node_test_gates.exit_publish_failed.arm();
    let mut recovery = fixture
        .host
        .inner
        .node_test_gates
        .recovery_before_restore
        .arm();
    let call = disable_call(&fixture, &controller);
    let accepted = fixture.invoke(&controller, call.clone()).await;
    stopping.entered().await;
    reject_control(&fixture, &controller, &accepted, true).await;
    stopping.release();
    restore.entered().await;
    let store = fixture.host.inner.store.clone();
    let mut saturation = tokio::task::spawn_blocking(move || store.saturate_writer_for_test())
        .await
        .unwrap();
    restore.release();
    restore_failed.entered().await;
    restore_failed.release();
    exit_failed.entered().await;
    let actual_exit = native.exited();
    let unpublished = fixture
        .host
        .inner
        .registry
        .runtime
        .status(&NodePackageId::try_from("example.terminal").unwrap())
        .unwrap();
    tokio::task::spawn_blocking(move || saturation.release())
        .await
        .unwrap();
    exit_failed.release();
    let rejected = fixture.wait(&controller, &accepted.operation_id).await;
    if rejected.state != OperationState::Cancelled {
        fixture.host.inner.node_packages.request_quiesce(true);
        recovery.release();
        let _profile = fixture.finish().await;
        panic!(
            "Real saturated exit publication lost the original cancellation: state={:?} error={:?} phase={:?} actual_exit={actual_exit}",
            rejected.state, rejected.error, unpublished.phase
        );
    }
    let reconciled = runtime(&fixture).await;
    if reconciled.phase != NodePackageRuntimePhase::Failed {
        fixture.host.inner.node_packages.request_quiesce(true);
        recovery.release();
        let _profile = fixture.finish().await;
        panic!(
            "Actual exit fact remained unpublished after the real queue drained: phase={:?} generation={} actual_exit={actual_exit}",
            reconciled.phase, reconciled.generation
        );
    }
    recovery.entered().await;
    recovery.release();
    let mut recovered = None;
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = runtime(&fixture).await;
            let active = status.phase == NodePackageRuntimePhase::Active;
            recovered = Some(status);
            if active {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    let installed = installed(&fixture).await;
    let replay = fixture.invoke(&controller, call).await;
    let observed = std::fs::read_to_string(markers.path().join("events.txt")).unwrap();
    let _profile = fixture.finish().await;
    assert!(
        actual_exit,
        "Exit projection failure must follow actual physical cleanup"
    );
    assert_eq!(unpublished.phase, NodePackageRuntimePhase::Stopping);
    assert_eq!(
        reconciled.phase,
        NodePackageRuntimePhase::Failed,
        "Pending exit fact must publish before a new owner is admitted"
    );
    assert_eq!(reconciled.generation, before.generation);
    assert_eq!(reconciled.error.as_ref().unwrap().code, "HOST_BUSY");
    assert!(
        completed.is_ok(),
        "Previous real Active must recover after the actual queue drains: {recovered:?}"
    );
    let recovered = recovered.unwrap();
    assert!(recovered.generation > before.generation);
    assert_eq!(recovered.archive_sha256, before.archive_sha256);
    assert_eq!(rejected.error.as_ref().unwrap().code, "CANCELLED");
    assert!(rejected.result.is_none());
    assert_eq!(replay, rejected);
    assert_eq!(installed.revision, 3.into());
    assert!(installed.packages[0].enabled);
    assert_eq!(observed, "register\ndispose\nregister\n");
    assert_eq!(
        std::fs::read_to_string(markers.path().join("events.txt")).unwrap(),
        "register\ndispose\nregister\ndispose\n"
    );
    eprintln!(
        "native_stop_storage_saturation actual_writer_positions=256 actual_exit=true exit_fact_reconciled=true original_cancel_preserved=true recovered_generation={}",
        recovered.generation
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_restore_rejects_a_query_captured_before_stopping() {
    let markers = support::Profile::isolated("host-node-backend-stop-old-binding-");
    let events = markers.path().join("events.txt");
    let source = format!(
        "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(c){{event('register');let calls=0;c.queries.register('example.terminal.compute',q=>{{event('call');return {{value:q.params.value,calls:++calls}};}});return ()=>event('dispose');}}",
        serde_json::to_string(&events).unwrap()
    );
    let mut spec = node_host_actions::spec();
    spec.kind = ActionKind::Query;
    let fixture = node_host_actions::Fixture::program(spec, source.as_bytes()).await;
    let controller = controller(&fixture).await;
    let before = runtime(&fixture).await;
    let mut resolved = fixture.host.inner.node_test_gates.query_resolved.arm();
    let query = fixture.query_call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":1}),
    );
    let waiting = fixture.client.request(RpcRequest::Query(query));
    let control = async {
        resolved.entered().await;
        let mut stopping = fixture.host.inner.node_test_gates.before_dispose.arm();
        let accepted = fixture
            .invoke(&controller, disable_call(&fixture, &controller))
            .await;
        stopping.entered().await;
        reject_control(&fixture, &controller, &accepted, true).await;
        stopping.release();
        assert_eq!(
            fixture
                .wait(&controller, &accepted.operation_id)
                .await
                .state,
            OperationState::Cancelled
        );
        assert_eq!(
            runtime(&fixture).await.phase,
            NodePackageRuntimePhase::Active
        );
        resolved.release();
    };
    let (reply, ()) = tokio::join!(waiting, control);
    let QueryResult::Extension(fresh) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":2}),
        )
        .await
    else {
        panic!("Expected real query result");
    };
    let after = runtime(&fixture).await;
    let observed = std::fs::read_to_string(&events).unwrap();
    let _profile = fixture.finish().await;
    let RpcReply::Failure { error, .. } = reply.unwrap() else {
        panic!("A captured old binding must remain invalid");
    };
    assert_eq!(error.code, "CATALOG_CHANGED");
    assert_eq!(
        serde_json::to_value(fresh).unwrap(),
        json!({"value":2,"calls":1})
    );
    assert_eq!(after.generation, before.generation);
    assert_eq!(observed, "register\ncall\n");
    assert_eq!(
        std::fs::read_to_string(events).unwrap(),
        "register\ncall\ndispose\n"
    );
    eprintln!(
        "native_stop_old_binding old_query=CATALOG_CHANGED fresh_query_succeeded=true same_generation=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_disable_restore_cannot_reopen_a_quiesced_catalog() {
    let markers = support::Profile::isolated("host-node-backend-stop-quiesce-");
    let fixture = empty_package(&markers).await;
    let controller = controller(&fixture).await;
    let mut native = process(&markers);
    let mut stopping = fixture.host.inner.node_test_gates.before_dispose.arm();
    let mut restore = fixture
        .host
        .inner
        .node_test_gates
        .before_dispose_restore
        .arm();
    let accepted = fixture
        .invoke(&controller, disable_call(&fixture, &controller))
        .await;
    stopping.entered().await;
    reject_control(&fixture, &controller, &accepted, true).await;
    stopping.release();
    restore.entered().await;
    // 已取得真实登记且原A已复核，随后真实关闭；发布必须在同一关闭边界拒绝。
    fixture.host.inner.node_packages.request_quiesce(true);
    assert_eq!(
        runtime(&fixture).await.phase,
        NodePackageRuntimePhase::Stopping
    );
    restore.release();
    let rejected = fixture.wait(&controller, &accepted.operation_id).await;
    let after = runtime(&fixture).await;
    let installed = installed(&fixture).await;
    let actual_exit = native.exited();
    let _profile = fixture.finish().await;
    assert_eq!(rejected.state, OperationState::Interrupted, "{rejected:?}");
    assert_eq!(rejected.error.as_ref().unwrap().code, "HOST_CLOSING");
    assert!(rejected.result.is_none());
    assert_ne!(after.phase, NodePackageRuntimePhase::Active);
    assert_ne!(after.phase, NodePackageRuntimePhase::Starting);
    assert_eq!(installed.revision, 3.into());
    assert!(installed.packages[0].enabled);
    assert!(
        actual_exit,
        "A rejected rollback publication must retain and complete actual cleanup"
    );
    eprintln!(
        "native_stop_quiesce closed_before_restore_publish=true reopened=false actual_exit_before_receipt=true"
    );
}

async fn empty_package(markers: &support::Profile) -> node_host_actions::Fixture {
    let source = format!(
        "import {{appendFileSync,writeFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(){{event('register');writeFileSync({},String(process.pid));return ()=>event('dispose');}}",
        serde_json::to_string(&markers.path().join("events.txt")).unwrap(),
        serde_json::to_string(&markers.path().join("node.pid")).unwrap()
    );
    node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await
}
fn process(markers: &support::Profile) -> support::node_owner_exit::ProcessExit {
    support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(markers.path().join("node.pid"))
            .unwrap()
            .parse()
            .unwrap(),
    )
}
async fn wait_exit(native: &mut support::node_owner_exit::ProcessExit) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !native.exited() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Original owner did not actually exit");
}
pub(super) async fn controller(fixture: &node_host_actions::Fixture) -> HostClient {
    let client = HostClient::connect(ConnectOptions::new(
        fixture.dir.path().to_path_buf(),
        id("stop-controller"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    grant_controller(fixture, &client).await;
    client
}
pub(super) async fn grant_controller(fixture: &node_host_actions::Fixture, client: &HostClient) {
    let grant=fixture.invoke(&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.authorize",json!({"clientId":client.attachment().client_id,"permissions":["plugins.manage"],"targets":[fixture.target]}))).await;
    assert_eq!(
        fixture.wait(&fixture.user, &grant.operation_id).await.state,
        OperationState::Succeeded
    );
}
pub(super) fn disable_call(fixture: &node_host_actions::Fixture, controller: &HostClient) -> Call {
    let mut call = fixture.call(
        controller,
        &fixture.target,
        "node.packages.setEnabled",
        json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":false}),
    );
    call.expected_revision = Some(3.into());
    call
}
pub(super) async fn reject_control(
    fixture: &node_host_actions::Fixture,
    controller: &HostClient,
    accepted: &Operation,
    cancelled: bool,
) {
    let (client, call) = if cancelled {
        let target = Target {
            kind: ResourceKind::try_from("operation").unwrap(),
            id: accepted.operation_id.clone(),
            ..fixture.target.clone()
        };
        (
            controller,
            fixture.call(
                controller,
                &target,
                "operation.cancel",
                json!({"reason":"user"}),
            ),
        )
    } else {
        (&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.revoke",json!({"actorId":controller.attachment().actor_id,"permissions":["plugins.manage"],"targets":[fixture.target]})))
    };
    let changed = fixture.invoke(client, call).await;
    assert_eq!(
        fixture.wait(client, &changed.operation_id).await.state,
        OperationState::Succeeded
    );
}
pub(super) async fn installed(fixture: &node_host_actions::Fixture) -> NodePackageListResult {
    let QueryResult::NodePackages(value) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected installation");
    };
    value
}
async fn business(fixture: &node_host_actions::Fixture) -> RpcReply {
    fixture
        .client
        .request(RpcRequest::Invoke(fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":2}),
        )))
        .await
        .unwrap()
}
fn unsupported(reply: RpcReply) {
    let RpcReply::Failure { error, .. } = reply else {
        panic!("Expected unregistered business: {reply:?}");
    };
    assert_eq!(error.code, "UNSUPPORTED_CAPABILITY");
}

pub(super) async fn runtime(fixture: &node_host_actions::Fixture) -> NodePackageRuntimeStatus {
    let QueryResult::NodePackageRuntime(status) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.runtime",
            json!({"id":"example.terminal"}),
        )
        .await
    else {
        panic!("Expected runtime status");
    };
    status
}
