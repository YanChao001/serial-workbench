//! 共享Node真实退出及恢复期间，Rust持有的Virtual、Raw与录制保持同源连续。
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_restart_preserves_rust_raw_and_capture_continuity() {
    let markers = support::Profile::isolated("host-node-backend-capture-restart-");
    let events = markers.path().join("node.events");
    let node_pid = markers.path().join("node.pid");
    let source = format!(
        r#"import {{appendFileSync,renameSync,writeFileSync}} from 'node:fs';
{marker_source}
const event=s=>appendFileSync({events},s+'\n');
export function register(context){{
  event('register:'+process.pid);publishMarker({node_pid},String(process.pid));let calls=0;
  context.actions.register('example.terminal.compute',call=>{{
    const value=call.params.value;const count=++calls;event('call:'+value+':'+process.pid);
    if(value===77){{event('exit-request:'+process.pid);process.exit(77);}}
    return {{value,calls:count}};
  }});return ()=>event('dispose:'+process.pid);
}}"#,
        events = serde_json::to_string(&events).unwrap(),
        node_pid = serde_json::to_string(&node_pid).unwrap(),
        marker_source = support::PUBLISH_MARKER_JS,
    );
    let fixture = node_host_actions::Fixture::program_with_virtual(
        node_host_actions::spec(),
        source.as_bytes(),
    )
    .await;
    let old_pid: u32 = std::fs::read_to_string(&node_pid).unwrap().parse().unwrap();
    let mut old_node = support::node_owner_exit::ProcessExit::observe(old_pid);
    let before = runtime(&fixture, "example.terminal").await;
    assert_eq!(before.phase, NodePackageRuntimePhase::Active);
    assert!(!old_node.exited());
    let mut capture = capture_tests::CaptureProbe::start(&fixture).await;
    capture.phase(&fixture, b"node-before-exit-01").await;

    let mut restoring = fixture
        .host
        .inner
        .node_test_gates
        .recovery_before_restore
        .arm();
    let original = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":77}),
    );
    let accepted = fixture.invoke(&fixture.client, original.clone()).await;
    wait_worker_event(&events, "exit-request:", 1).await;
    restoring.entered().await;
    // gate只控制恢复时序；必须另观察旧进程实际退出，不能借shutdown补证。
    assert!(
        old_node.exited(),
        "Old Node must actually exit before the Rust-only capture phase"
    );
    assert_eq!(read_events(&events).matches("register:").count(), 1);
    assert_eq!(
        std::fs::read_to_string(&node_pid).unwrap(),
        old_pid.to_string()
    );
    capture.phase(&fixture, b"node-absent-rust-02").await;
    assert!(old_node.exited());
    assert_eq!(read_events(&events).matches("register:").count(), 1);
    assert_eq!(
        std::fs::read_to_string(&node_pid).unwrap(),
        old_pid.to_string()
    );
    restoring.release();

    let crashed = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(crashed.state, OperationState::Unknown, "{crashed:?}");
    assert_eq!(
        crashed.error.as_ref().unwrap().code,
        "NODE_BACKEND_INTERRUPTED"
    );
    assert!(crashed.result.is_none());
    let (after, new_pid) = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = runtime(&fixture, "example.terminal").await;
            let current_pid: u32 = std::fs::read_to_string(&node_pid).unwrap().parse().unwrap();
            if status.phase == NodePackageRuntimePhase::Active
                && status.generation.get() > before.generation.get()
                && current_pid != old_pid
            {
                break (status, current_pid);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Actual Node recovery did not publish a new PID and generation within five seconds");
    let mut new_node = support::node_owner_exit::ProcessExit::observe(new_pid);
    assert_eq!(after.archive_sha256, before.archive_sha256);
    assert_eq!(read_events(&events).matches("register:").count(), 2);
    assert!(!new_node.exited());
    let fresh = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":9}),
            ),
        )
        .await;
    let fresh = fixture.wait(&fixture.client, &fresh.operation_id).await;
    assert_eq!(fresh.state, OperationState::Succeeded, "{fresh:?}");
    assert_eq!(
        fixture.result(&fixture.client, &fresh).await,
        json!({"value":9,"calls":1})
    );
    let before_replay = read_events(&events);
    assert_eq!(fixture.invoke(&fixture.client, original).await, crashed);
    assert_eq!(read_events(&events), before_replay);
    capture.phase(&fixture, b"node-restored-rust-03").await;
    assert_eq!(read_events(&events), before_replay);
    assert_eq!(
        runtime(&fixture, "example.terminal").await.generation,
        after.generation
    );
    assert_eq!(
        std::fs::read_to_string(&node_pid).unwrap(),
        new_pid.to_string()
    );
    assert!(!new_node.exited());
    let QueryResult::NodePackages(installed) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected actual installation revision before stopping the last plugin");
    };
    assert_eq!(installed.packages.len(), 1);
    let package = &installed.packages[0];
    assert_eq!(package.id.as_str(), "example.terminal");
    assert!(package.enabled);
    let stopped = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":package.id,"archiveSha256":package.archive_sha256,"enabled":false}),
            installed.revision.get(),
        )
        .await;
    assert_eq!(stopped.state, OperationState::Succeeded, "{stopped:?}");
    assert!(stopped.error.is_none());
    let Some(ActionResult::NodePackageChanged(committed)) = &stopped.result else {
        panic!("Expected the last plugin's committed stop receipt: {stopped:?}");
    };
    assert_eq!(
        committed.revision,
        installed.revision.checked_next().unwrap()
    );
    assert!(!committed.package.enabled);
    assert!(
        new_node.exited(),
        "The recovered Node must actually exit before the final Rust-only capture phase"
    );
    let inactive = runtime(&fixture, "example.terminal").await;
    assert_eq!(inactive.phase, NodePackageRuntimePhase::Inactive);
    let QueryResult::NodePackages(disabled) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected the persisted disabled installation");
    };
    assert_eq!(disabled.revision, committed.revision);
    assert_eq!(disabled.packages.len(), 1);
    assert_eq!(disabled.packages[0], committed.package);
    assert!(!disabled.packages[0].enabled);
    let stopped_events = read_events(&events);
    assert_eq!(
        stopped_events,
        format!("{before_replay}dispose:{new_pid}\n")
    );
    capture.phase(&fixture, b"node-stopped-rust-04").await;
    assert!(new_node.exited());
    assert_eq!(read_events(&events), stopped_events);
    assert_eq!(
        runtime(&fixture, "example.terminal").await.phase,
        NodePackageRuntimePhase::Inactive
    );
    assert_eq!(
        std::fs::read_to_string(&node_pid).unwrap(),
        new_pid.to_string()
    );
    capture.finish(&fixture).await;
    let _profile = fixture.finish().await;
    assert!(
        new_node.wait(),
        "The already stopped Node must remain exited after normal Host cleanup"
    );
    let final_events = read_events(&events);
    assert_eq!(final_events.matches("call:77:").count(), 1);
    assert_eq!(final_events.matches("call:9:").count(), 1);
    assert_eq!(final_events.matches("call:").count(), 2);
    assert_eq!(final_events.matches("register:").count(), 2);
    eprintln!(
        "task_worker_node_restart old_pid={old_pid} new_pid={new_pid} actual_exit_before_rust_phase=true recovery_gate_held_for_middle_phase=true old_operation_unknown=true replay_no_execution=true fresh_business_succeeded=true last_plugin_disabled=true persisted_enabled_false=true runtime_inactive=true actual_exit_before_final_rust_phase=true normal_node_exit=true virtual_capture_verified=true"
    );
}
