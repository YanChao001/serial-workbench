//! 正式包与真实后台公开边界，不替换处理器、授权或执行容器。
use super::*;
use serial_workbench_core::*;
use serial_workbench_host::{
    node_backend::{NodeBackend, NodeBackendLimits},
    node_packages::VerifiedNodeInstallation,
    node_runtime::{NodeRuntimeLimits, verify_node_runtime},
};
use std::sync::Arc;
#[path = "action_schema.rs"]
mod schema;

fn action_package(source: &[u8]) -> (support::Profile, VerifiedNodeInstallation, ActionSpec) {
    action_package_with_input_schema(
        source,
        serde_json::from_value(json!({
            "type":"object", "properties":{"value":{"type":"integer"}},
            "required":["value"], "additionalProperties":false
        }))
        .unwrap(),
    )
}
fn action_package_with_input_schema(
    source: &[u8],
    input_schema: SchemaObject,
) -> (support::Profile, VerifiedNodeInstallation, ActionSpec) {
    let profile = support::Profile::isolated("node-backend-actions-");
    let store = serial_workbench_host::storage::Store::open(profile.path()).unwrap();
    let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
    let mut spec = BuiltinAction::HostShutdown.spec().clone();
    spec.action_id = Id::try_from("example.terminal.compute").unwrap();
    spec.permissions.clear();
    spec.cancellation = Cancellation::Cooperative;
    spec.state_scopes.clear();
    spec.event_types.clear();
    spec.input_schema = input_schema;
    spec.output_schema = serde_json::from_value(json!({
        "type":"object", "properties":{"value":{"type":"integer"}},
        "required":["value"], "additionalProperties":false
    }))
    .unwrap();
    let mut unused = spec.clone();
    unused.action_id = Id::try_from("example.terminal.unregistered").unwrap();
    let mut query = spec.clone();
    query.action_id = Id::try_from("example.terminal.wait").unwrap();
    query.kind = ActionKind::Query;
    query.cancellation = Cancellation::None;
    let mut metadata = manifest();
    metadata["contributes"]["actions"] = json!([spec, unused]);
    metadata["contributes"]["queries"] = json!([query]);
    let mut files = payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&metadata).unwrap(),
    );
    files.insert("dist/main.mjs".into(), source.to_vec());
    let installed = installer
        .install(
            verify_local(&with_metadata(files, false)).unwrap(),
            0.into(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    let id = installed.package.manifest.id;
    let digest = installed.package.archive_sha256;
    let trusted = installer
        .confirm_execution_trust(&id, installed.revision, &digest)
        .unwrap();
    let enabled = installer
        .set_enabled(&id, true, trusted.revision, &digest)
        .unwrap();
    let proof = installer
        .verify_installed(
            &id,
            enabled.revision,
            &digest,
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
    (profile, proof, spec)
}
fn backend() -> NodeBackend {
    backend_with_stop().0
}
fn backend_with_stop() -> (NodeBackend, Arc<AtomicBool>) {
    let runtime = verify_node_runtime(
        std::path::Path::new(&std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap()),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let backend = NodeBackend::start(runtime, NodeBackendLimits::default(), stop.clone()).unwrap();
    (backend, stop)
}
struct StopOnDrop(Arc<AtomicBool>);
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
}
fn wait_marker(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !path.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(path.exists(), "Actual handler did not start");
}
fn action_call(spec: &ActionSpec, value: i32) -> Call {
    let host_id = Id::try_from("action-host").unwrap();
    Call {
        protocol_version: ProtocolVersion::V1_0,
        host_id: host_id.clone(),
        instance_epoch: 9_007_199_254_740_993u64.into(),
        actor_id: Id::try_from("action-caller").unwrap(),
        request_id: RequestId::try_from("11111111-2222-4333-8444-555555555555").unwrap(),
        request_context: ContextToken::try_from("original-action-context").unwrap(),
        action_id: spec.action_id.clone(),
        target: Target {
            host_id: host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: host_id,
            session_id: None,
            session_epoch: None,
        },
        params: serde_json::from_value(json!({"value":value})).unwrap(),
        reveal_target: spec.reveal_target.clone(),
        expected_revision: Some(7.into()),
        lease_id: Some(Id::try_from("original-lease").unwrap()),
        execution_mode: Some(ExecutionMode::Independent),
        workspace_startup: None,
    }
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_registers_only_actual_action_handlers() {
    let (_profile, proof, spec) = action_package(
        br#"
export function register(context) {
  context.actions.register('example.terminal.compute', call => ({value:call.params.value}));
  return () => {};
}
"#,
    );
    let backend = backend();
    let registration = backend.activate(proof, || Ok(())).unwrap();
    assert_eq!(registration.contributes.actions, vec![spec.action_id]);
    backend.dispose(registration.id, || Ok(())).unwrap();
    let report = backend.shutdown();
    assert!(report.reaped && report.error.is_none(), "{report:?}");
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_invokes_an_action_with_its_original_call() {
    let (_profile, proof, spec) = action_package(br#"
export function register(context) {
  context.actions.register('example.terminal.compute', (call, task) => {
    if(call.actorId!=='action-caller' || call.requestId!=='11111111-2222-4333-8444-555555555555'
      || call.requestContext!=='original-action-context' || call.instanceEpoch!=='9007199254740993'
      || call.expectedRevision!=='7' || call.leaseId!=='original-lease' || call.executionMode!=='independent'
      || !(task.signal instanceof AbortSignal)) throw new Error('Original action context changed');
    return {value:call.params.value+1};
  });
  return () => {};
}
"#);
    let id = proof.package().manifest.id.clone();
    let backend = backend();
    backend.activate(proof, || Ok(())).unwrap();
    let value = backend
        .invoke(id.clone(), action_call(&spec, 7), || Ok(()))
        .unwrap();
    assert_eq!(value, json!({"value":8}));
    backend.dispose(id, || Ok(())).unwrap();
    let report = backend.shutdown();
    assert!(report.reaped && report.error.is_none(), "{report:?}");
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_action_cancellation_waits_for_actual_handler_completion() {
    use std::{
        sync::{atomic::Ordering, mpsc},
        time::Duration,
    };
    let markers = support::Profile::isolated("node-action-cancel-markers-");
    let started = markers.path().join("started");
    let finished = markers.path().join("finished");
    let source = format!(
        r#"
import {{writeFileSync}} from 'node:fs';
export function register(context) {{
  context.actions.register('example.terminal.compute', async (call, task) => {{
    if(call.params.value!==7) return {{value:call.params.value+1}};
    writeFileSync({}, 'started');
    try {{
      await new Promise((_, reject) => task.signal.addEventListener('abort', () => reject(task.signal.reason), {{once:true}}));
    }} finally {{
      await new Promise(resolve => setTimeout(resolve, 250));
      writeFileSync({}, 'finished');
    }}
  }});
  return () => {{}};
}}
"#,
        serde_json::to_string(&started).unwrap(),
        serde_json::to_string(&finished).unwrap()
    );
    let (_profile, proof, spec) = action_package(source.as_bytes());
    let id = proof.package().manifest.id.clone();
    let (native, stop) = backend_with_stop();
    let _cleanup = StopOnDrop(stop);
    let backend = Arc::new(native);
    backend.activate(proof, || Ok(())).unwrap();
    let allowed = Arc::new(AtomicBool::new(true));
    let (sent, result) = mpsc::sync_channel(1);
    let job = {
        let backend = backend.clone();
        let allowed = allowed.clone();
        let id = id.clone();
        let call = action_call(&spec, 7);
        std::thread::spawn(move || {
            let value = backend.invoke(id, call, move || {
                if allowed.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(HostError::new("CANCELLED", "Action cancellation requested"))
                }
            });
            let _ = sent.send(value);
        })
    };
    wait_marker(&started);
    assert!(!finished.exists());
    allowed.store(false, Ordering::Release);
    let quick = backend
        .invoke(id.clone(), action_call(&spec, 2), || Ok(()))
        .unwrap();
    assert_eq!(quick, json!({"value":3}));
    assert_eq!(
        result
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert_eq!(std::fs::read_to_string(&finished).unwrap(), "finished");
    job.join().unwrap();
    backend.dispose(id, || Ok(())).unwrap();
    let report = Arc::try_unwrap(backend)
        .ok()
        .expect("all calls completed")
        .shutdown();
    assert!(report.reaped && report.error.is_none(), "{report:?}");
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_long_action_keeps_other_calls_and_heartbeats_reachable() {
    use std::{sync::mpsc, time::Duration};
    let markers = support::Profile::isolated("node-action-long-markers-");
    let started = markers.path().join("started");
    let source = format!(
        r#"
import {{writeFileSync}} from 'node:fs';
export function register(context) {{
  context.actions.register('example.terminal.compute', async call => {{
    if(call.params.value===7) {{
      writeFileSync({}, 'started');
      await new Promise(resolve => setTimeout(resolve, 6000));
    }}
    return {{value:call.params.value+1}};
  }});
  return () => {{}};
}}
"#,
        serde_json::to_string(&started).unwrap()
    );
    let (_profile, proof, spec) = action_package(source.as_bytes());
    let id = proof.package().manifest.id.clone();
    let (native, stop) = backend_with_stop();
    let _cleanup = StopOnDrop(stop);
    let backend = Arc::new(native);
    backend.activate(proof, || Ok(())).unwrap();
    let launch = |value| {
        let backend = backend.clone();
        let id = id.clone();
        let call = action_call(&spec, value);
        let (sent, result) = mpsc::sync_channel(1);
        let job = std::thread::spawn(move || {
            let _ = sent.send(backend.invoke(id, call, || Ok(())));
        });
        (job, result)
    };
    let (long_job, long) = launch(7);
    wait_marker(&started);
    let (quick_job, quick) = launch(2);
    assert_eq!(
        quick
            .recv_timeout(NodeBackendLimits::default().command_timeout)
            .unwrap()
            .unwrap(),
        json!({"value":3})
    );
    assert!(
        matches!(long.try_recv(), Err(mpsc::TryRecvError::Empty)),
        "A short call must complete while the long action still runs"
    );
    assert_eq!(
        long.recv_timeout(Duration::from_secs(10)).unwrap().unwrap(),
        json!({"value":8})
    );
    long_job.join().unwrap();
    quick_job.join().unwrap();
    backend.dispose(id, || Ok(())).unwrap();
    let report = Arc::try_unwrap(backend)
        .ok()
        .expect("all calls completed")
        .shutdown();
    assert!(report.reaped && report.error.is_none(), "{report:?}");
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_async_query_cannot_block_action_cancellation() {
    use std::{
        sync::{atomic::Ordering, mpsc},
        time::Duration,
    };
    let markers = support::Profile::isolated("node-action-query-cancel-markers-");
    let started = markers.path().join("started");
    let query_started = markers.path().join("query-started");
    let finished = markers.path().join("finished");
    let source = format!(
        r#"
import {{writeFileSync}} from 'node:fs';
export function register(context) {{
  let ended;
  const ending = new Promise(resolve => {{ended=resolve;}});
  context.actions.register('example.terminal.compute', async (call, task) => {{
    writeFileSync({}, 'started');
    try {{ await new Promise((_, reject) => task.signal.addEventListener('abort', () => reject(task.signal.reason), {{once:true}})); }}
    finally {{ writeFileSync({}, 'finished'); ended(); }}
  }});
  context.queries.register('example.terminal.wait', async () => {{
    writeFileSync({}, 'query-started');
    await ending;
    return {{value:1}};
  }});
  return () => {{}};
}}
"#,
        serde_json::to_string(&started).unwrap(),
        serde_json::to_string(&finished).unwrap(),
        serde_json::to_string(&query_started).unwrap()
    );
    let (_profile, proof, spec) = action_package(source.as_bytes());
    let id = proof.package().manifest.id.clone();
    let (native, stop) = backend_with_stop();
    let _cleanup = StopOnDrop(stop);
    let backend = Arc::new(native);
    backend.activate(proof, || Ok(())).unwrap();
    let allowed = Arc::new(AtomicBool::new(true));
    let (sent, action_result) = mpsc::sync_channel(1);
    let action_job = {
        let backend = backend.clone();
        let id = id.clone();
        let call = action_call(&spec, 7);
        let allowed = allowed.clone();
        std::thread::spawn(move || {
            let _ = sent.send(backend.invoke(id, call, move || {
                if allowed.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(HostError::new("CANCELLED", "Action cancellation requested"))
                }
            }));
        })
    };
    wait_marker(&started);
    let (sent, query_result) = mpsc::sync_channel(1);
    let query_job = {
        let backend = backend.clone();
        let id = id.clone();
        let call = action_call(&spec, 1);
        let query = Query {
            protocol_version: call.protocol_version,
            host_id: call.host_id,
            instance_epoch: call.instance_epoch,
            actor_id: call.actor_id,
            request_id: call.request_id,
            action_id: Id::try_from("example.terminal.wait").unwrap(),
            target: call.target,
            params: call.params,
            reveal_target: call.reveal_target,
        };
        std::thread::spawn(move || {
            let _ = sent.send(backend.query(id, query, || Ok(())));
        })
    };
    wait_marker(&query_started);
    allowed.store(false, Ordering::Release);
    let action = action_result.recv_timeout(Duration::from_secs(12)).unwrap();
    let query = query_result.recv_timeout(Duration::from_secs(12)).unwrap();
    action_job.join().unwrap();
    query_job.join().unwrap();
    let report = Arc::try_unwrap(backend)
        .ok()
        .expect("all calls completed")
        .shutdown();
    eprintln!("action_query_cancellation action={action:?} query={query:?} exit={report:?}");
    assert_eq!(action.unwrap_err().code, "CANCELLED");
    assert_eq!(query.unwrap(), json!({"value":1}));
    assert_eq!(std::fs::read_to_string(&finished).unwrap(), "finished");
    assert!(report.reaped && report.error.is_none());
}

#[test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
fn verified_backend_uncooperative_action_returns_only_after_actual_owner_exit() {
    use std::{
        sync::{atomic::Ordering, mpsc},
        time::Duration,
    };
    let markers = support::Profile::isolated("node-action-uncooperative-markers-");
    let started = markers.path().join("started");
    let source = format!(
        r#"
import {{renameSync,writeFileSync}} from 'node:fs';
{PUBLISH_MARKER_JS}
export function register(context) {{
  context.actions.register('example.terminal.compute', async () => {{
    publishMarker({}, String(process.pid));
    await new Promise(() => {{}});
  }});
  return () => {{}};
}}
"#,
        serde_json::to_string(&started).unwrap()
    );
    let (_profile, proof, spec) = action_package(source.as_bytes());
    let id = proof.package().manifest.id.clone();
    let (native, stop) = backend_with_stop();
    let _cleanup = StopOnDrop(stop);
    let backend = Arc::new(native);
    backend.activate(proof, || Ok(())).unwrap();
    let allowed = Arc::new(AtomicBool::new(true));
    let (sent, result) = mpsc::sync_channel(1);
    let job = {
        let backend = backend.clone();
        let allowed = allowed.clone();
        let call = action_call(&spec, 7);
        std::thread::spawn(move || {
            let _ = sent.send(backend.invoke(id, call, move || {
                if allowed.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(HostError::new("CANCELLED", "Action cancellation requested"))
                }
            }));
        })
    };
    wait_marker(&started);
    let pid = std::fs::read_to_string(&started).unwrap().parse().unwrap();
    let mut node = support::node_owner_exit::ProcessExit::observe(pid);
    allowed.store(false, Ordering::Release);
    let result = result.recv_timeout(Duration::from_secs(12)).unwrap();
    job.join().unwrap();
    assert!(
        node.exited(),
        "Action error must wait for actual owner exit"
    );
    support::node_owner_exit::assert_gone(pid);
    let report = Arc::try_unwrap(backend)
        .ok()
        .expect("all calls completed")
        .shutdown();
    assert_eq!(result.unwrap_err().code, "NODE_BACKEND_INTERRUPTED");
    assert_eq!(report.process_id, pid);
    assert!(report.reaped);
    let error = report.error.unwrap();
    assert_eq!(error.code, "NODE_BACKEND_INTERRUPTED");
    assert_eq!(
        serde_json::to_value(error.details.unwrap()).unwrap()["reason"],
        "backendActionCancellationDeadline"
    );
    eprintln!(
        "native_action_receipt {}",
        json!({"case":"uncooperativeCancellation","nodePid":pid,"ownerExitedBeforeResult":true,"reaped":true})
    );
}
