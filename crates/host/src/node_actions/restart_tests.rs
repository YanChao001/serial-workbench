//! 真实 Host 进程退出后的持久任务恢复，不以调用 recover 代替进程边界。
use super::*;
use crate::test_support::{self as support, node_host_actions};
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    sync::atomic::AtomicBool,
    time::Duration,
};

struct OwnedHost {
    child: Child,
    stop: std::path::PathBuf,
}
impl OwnedHost {
    async fn start(profile: &Path, markers: &Path, generation: &str) -> Self {
        Self::start_with_scan_marker(profile, markers, generation, None).await
    }
    async fn start_with_scan_marker(
        profile: &Path,
        markers: &Path,
        generation: &str,
        scanned: Option<&Path>,
    ) -> Self {
        let ready = markers.join(format!("{generation}.ready"));
        let stop = markers.join(format!("{generation}.stop"));
        let mut command = Command::new(std::env::current_exe().unwrap());
        if let Some(scanned) = scanned {
            command.env("SWB_NODE_TASK_RESTART_SCANNED", scanned);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut owned = Self {
            child: command
                .args([
                    "--ignored",
                    "--exact",
                    "dispatch::node_actions::restart_tests::native_node_task_restart_host_fixture",
                    "--nocapture",
                ])
                .env("SWB_NODE_TASK_RESTART_PROFILE", profile)
                .env("SWB_NODE_TASK_RESTART_READY", &ready)
                .env("SWB_NODE_TASK_RESTART_STOP", &stop)
                .stdin(Stdio::null())
                .stdout(Stdio::from(
                    std::fs::File::create_new(markers.join(format!("{generation}.stdout")))
                        .unwrap(),
                ))
                .stderr(Stdio::from(
                    std::fs::File::create_new(markers.join(format!("{generation}.stderr")))
                        .unwrap(),
                ))
                .spawn()
                .unwrap(),
            stop,
        };
        tokio::time::timeout(Duration::from_secs(10), async {
            while !ready.exists() {
                assert!(
                    owned.child.try_wait().unwrap().is_none(),
                    "Owned Host exited before readiness; inspect {generation}.stderr"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Owned Host startup did not finish");
        owned
    }
    fn crash(&mut self) {
        assert!(self.child.try_wait().unwrap().is_none());
        self.child.kill().unwrap();
        self.child.wait().unwrap();
    }
    async fn finish(&mut self) {
        std::fs::write(&self.stop, b"stop").unwrap();
        let status = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(status) = self.child.try_wait().unwrap() {
                    return status;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Owned Host did not finish actual cleanup");
        assert!(status.success(), "Owned Host shutdown failed: {status}");
    }
}
impl Drop for OwnedHost {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[tokio::test]
#[ignore = "Private subprocess entry for the owned Host restart test"]
async fn native_node_task_restart_host_fixture() {
    let Some(profile) = std::env::var_os("SWB_NODE_TASK_RESTART_PROFILE") else {
        return;
    };
    let ready = std::env::var_os("SWB_NODE_TASK_RESTART_READY").unwrap();
    let stop = std::path::PathBuf::from(std::env::var_os("SWB_NODE_TASK_RESTART_STOP").unwrap());
    let runtime = tokio::task::spawn_blocking(|| {
        crate::node_runtime::verify_node_runtime(
            Path::new(&std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap()),
            &crate::node_runtime::NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
    })
    .await
    .unwrap();
    let mut server = crate::ipc::HostServer::bind(Path::new(&profile))
        .await
        .unwrap();
    let host = Host::with_verified_node_runtime(
        server.store(),
        server.auth(),
        Arc::new(crate::clock::SystemClock::new().unwrap()),
        Arc::new(|_, _| {
            Err(HostError::new(
                "DEVICE_NOT_FOUND",
                "No physical transport in restart fixture",
            )
            .into())
        }),
        runtime,
    )
    .await
    .unwrap();
    let scanned = std::env::var_os("SWB_NODE_TASK_RESTART_SCANNED").map(|path| {
        let mut scan = host.inner.node_test_gates.recovery_scan_completed.arm();
        tokio::spawn(async move {
            scan.entered().await;
            scan.release();
            std::fs::write(path, b"scanned").unwrap();
        })
    });
    std::fs::write(ready, b"ready").unwrap();
    server
        .serve_until(Arc::new(host), async {
            while !stop.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    if let Some(scanned) = scanned {
        scanned.await.unwrap();
    }
}

#[path = "activation_tests.rs"]
mod activation_tests;

fn call(client: &HostClient, target: &Target, action: &str, params: Value) -> Call {
    let a = client.attachment();
    Call {
        protocol_version: ProtocolVersion::V0_1,
        host_id: a.host_id.clone(),
        instance_epoch: a.instance_epoch,
        actor_id: a.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        request_context: a.request_context.clone(),
        action_id: id(action),
        target: target.clone(),
        params: serde_json::from_value(params).unwrap(),
        reveal_target: serde_json::from_value(json!({"pageId":"workbench"})).unwrap(),
        expected_revision: None,
        lease_id: None,
        execution_mode: Some(ExecutionMode::Independent),
    }
}
async fn query(client: &HostClient, target: &Target, action: &str, params: Value) -> QueryResult {
    let reply = client
        .request(RpcRequest::Query(call_query(&call(
            client, target, action, params,
        ))))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("Expected query: {reply:?}");
    };
    let RpcResult::Query(value) = *result else {
        panic!("Expected query result");
    };
    value
}
async fn invoke(client: &HostClient, call: Call) -> Operation {
    let reply = client.request(RpcRequest::Invoke(call)).await.unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("Expected action: {reply:?}");
    };
    let RpcResult::Operation(value) = *result else {
        panic!("Expected operation result");
    };
    value.operation
}
async fn operation(client: &HostClient, target: &Target, selector: Value) -> Operation {
    let QueryResult::Operation(value) = query(client, target, "operation.get", selector).await
    else {
        panic!("Expected operation");
    };
    value.operation
}
async fn wait(client: &HostClient, target: &Target, id: &Id) -> Operation {
    let mut last = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = operation(client, target, json!({"operationId":id})).await;
            if value.state.is_terminal() {
                return value;
            }
            last = Some(value);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Operation did not settle: {last:?}"))
}
async fn enable(client: &HostClient, target: &Target, archive: &Digest, revision: u64) {
    let mut request = call(
        client,
        target,
        "node.packages.setEnabled",
        json!({
            "id":"example.terminal","archiveSha256":archive,"enabled":true
        }),
    );
    request.expected_revision = Some(revision.into());
    let accepted = invoke(client, request).await;
    let settled = wait(client, target, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_host_process_restart_preserves_child_receipts_without_replay() {
    restart_task(RestartBoundary::Host, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_owner_restart_preserves_child_receipts_without_replay() {
    restart_task(RestartBoundary::Node, false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_host_restart_automatically_registers_without_replaying_tasks() {
    restart_task(RestartBoundary::Host, true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_owner_restart_automatically_registers_without_replaying_tasks() {
    restart_task(RestartBoundary::Node, true).await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_initial_registration_failure_is_not_automatically_retried() {
    let markers = support::Profile::isolated("host-node-backend-registration-failure-");
    let calls = markers.path().join("register-calls.txt");
    let source = format!(
        "import {{appendFileSync}} from 'node:fs'; export function register() {{ appendFileSync({},'called\\n'); throw new Error('Registration refused'); }}",
        serde_json::to_string(&calls).unwrap()
    );
    let fixture =
        node_host_actions::Fixture::installed_program(node_host_actions::spec(), source.as_bytes())
            .await;
    let failed = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
            2,
        )
        .await;
    let mut scanned = fixture
        .host
        .inner
        .node_test_gates
        .recovery_failed_scan
        .arm();
    scanned.entered().await;
    let register_calls = std::fs::read_to_string(&calls).unwrap().lines().count();
    scanned.release();
    let _profile = fixture.finish().await;
    assert_eq!(failed.state, OperationState::Failed, "{failed:?}");
    assert_eq!(
        failed.error.as_ref().unwrap().code,
        "NODE_REGISTRATION_FAILED"
    );
    assert_eq!(
        register_calls, 1,
        "Initial activation failure must await explicit intent; recovery called register {register_calls} times"
    );
    eprintln!(
        "native_initial_registration_failure register_calls={register_calls} automatic_retry=false"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_explicit_enable_joins_same_package_recovery() {
    let markers = support::Profile::isolated("host-node-backend-recovery-join-");
    let calls = markers.path().join("register-calls.txt");
    let pid = markers.path().join("node.pid");
    let source = format!(
        "import {{appendFileSync,writeFileSync}} from 'node:fs'; export function register(context) {{appendFileSync({},'called\\n');writeFileSync({},String(process.pid));context.actions.register('example.terminal.compute',call=>{{if(call.params.value===77) process.exit(77);return {{value:call.params.value,calls:1}};}});return ()=>{{}};}}",
        serde_json::to_string(&calls).unwrap(),
        serde_json::to_string(&pid).unwrap()
    );
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
    let mut native = support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(&pid).unwrap().parse().unwrap(),
    );
    let mut finishing = fixture
        .host
        .inner
        .node_test_gates
        .recovery_before_release
        .arm();
    let mut joined = fixture
        .host
        .inner
        .node_test_gates
        .waiting_for_recovery
        .arm();
    let failed = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":77}),
            ),
        )
        .await;
    let failed = fixture.wait(&fixture.client, &failed.operation_id).await;
    finishing.entered().await;
    let mut request = fixture.call(
        &fixture.client,
        &fixture.target,
        "node.packages.setEnabled",
        json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
    );
    request.expected_revision = Some(3.into());
    let accepted = fixture.invoke(&fixture.client, request).await;
    joined.entered().await;
    let QueryResult::Operation(waiting) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "operation.get",
            json!({"operationId":accepted.operation_id}),
        )
        .await
    else {
        panic!("Expected joined operation");
    };
    joined.release();
    finishing.release();
    let enabled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    let _profile = fixture.finish().await;
    assert!(
        native.exited(),
        "Previous owner must exit before a recovery join"
    );
    assert_eq!(failed.state, OperationState::Unknown, "{failed:?}");
    assert_eq!(waiting.operation.state, OperationState::Queued);
    assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
    assert_eq!(std::fs::read_to_string(calls).unwrap().lines().count(), 2);
    eprintln!(
        "native_recovery_join actual_wait_observed=true queued_before_slot=true operation=succeeded registrations=2"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_recovery_failure_cannot_overwrite_a_new_explicit_activation() {
    let markers = support::Profile::isolated("host-node-backend-recovery-finalize-");
    let calls = markers.path().join("register-calls.txt");
    let source = format!(
        "import {{appendFileSync}} from 'node:fs'; export function register(context) {{appendFileSync({},'called\\n');context.actions.register('example.terminal.compute',call=>{{if(call.params.value===77) process.exit(77);return {{value:call.params.value,calls:1}};}});return ()=>{{}};}}",
        serde_json::to_string(&calls).unwrap()
    );
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
    let replacement = HostClient::connect(ConnectOptions::new(
        fixture.dir.path().to_path_buf(),
        id("replacement-activation-client"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let authorized=fixture.invoke(&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.authorize",json!({"clientId":replacement.attachment().client_id,"permissions":["plugins.manage","content.read"],"targets":[fixture.target]}))).await;
    assert_eq!(
        fixture
            .wait(&fixture.user, &authorized.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    let mut scanned = fixture
        .host
        .inner
        .node_test_gates
        .recovery_failed_scan
        .arm();
    let mut restoring = fixture
        .host
        .inner
        .node_test_gates
        .recovery_before_restore
        .arm();
    let mut publishing = fixture
        .host
        .inner
        .node_test_gates
        .recovery_failure_publish
        .arm();
    let mut joining = fixture
        .host
        .inner
        .node_test_gates
        .waiting_for_recovery
        .arm();
    let crashed = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":77}),
            ),
        )
        .await;
    let crashed = fixture.wait(&fixture.client, &crashed.operation_id).await;
    restoring.entered().await;
    let revoked=fixture.invoke(&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.revoke",json!({"actorId":fixture.client.attachment().actor_id,"permissions":["plugins.manage"],"targets":[fixture.target]}))).await;
    assert_eq!(
        fixture
            .wait(&fixture.user, &revoked.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    restoring.release();
    publishing.entered().await;
    assert_eq!(
        std::fs::read_to_string(&calls).unwrap().lines().count(),
        1,
        "The denied old actor must not import package code"
    );
    let mut request = fixture.call(
        &replacement,
        &fixture.target,
        "node.packages.setEnabled",
        json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
    );
    request.expected_revision = Some(3.into());
    let accepted = fixture.invoke(&replacement, request).await;
    let (joined, activated) = {
        let activation = fixture.wait(&replacement, &accepted.operation_id);
        tokio::pin!(activation);
        // 等待进入恢复槽位时，保留可能正在写入的查询及其连接。
        let early = tokio::select! {
            _ = joining.entered() => None,
            result = &mut activation => Some(result),
        };
        let joined = early.is_none();
        joining.release();
        publishing.release();
        scanned.entered().await;
        scanned.release();
        let activated = match early {
            Some(result) => result,
            None => activation.await,
        };
        (joined, activated)
    };
    let QueryResult::NodePackageRuntime(status) = fixture
        .query(
            &replacement,
            &fixture.target,
            "node.packages.runtime",
            json!({"id":"example.terminal"}),
        )
        .await
    else {
        panic!("Expected runtime status");
    };
    let probe = replacement
        .request(RpcRequest::Invoke(fixture.call(
            &replacement,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":5}),
        )))
        .await
        .unwrap();
    let probe = match probe {
        RpcReply::Success { result, .. } => match *result {
            RpcResult::Operation(value) => Some(
                fixture
                    .wait(&replacement, &value.operation.operation_id)
                    .await,
            ),
            _ => None,
        },
        _ => None,
    };
    let register_calls = std::fs::read_to_string(&calls).unwrap().lines().count();
    let _profile = fixture.finish().await;
    eprintln!(
        "native_recovery_finalize joined={joined} explicit={:?} runtime={:?} generation={} registrations={register_calls}",
        activated.state, status.phase, status.generation
    );
    assert!(
        joined,
        "Recovery released its slot before publishing the failure; a new activation overtook finalization"
    );
    assert_eq!(crashed.state, OperationState::Unknown, "{crashed:?}");
    assert_eq!(activated.state, OperationState::Succeeded, "{activated:?}");
    assert_eq!(status.phase, NodePackageRuntimePhase::Active);
    assert_eq!(status.generation, 2.into());
    assert_eq!(probe.unwrap().state, OperationState::Succeeded);
    assert_eq!(register_calls, 2);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_recovery_retries_a_full_storage_queue_without_other_changes() {
    let markers = support::Profile::isolated("host-node-backend-storage-recovery-");
    let calls = markers.path().join("register-calls.txt");
    let source = format!(
        "import {{appendFileSync}} from 'node:fs'; export function register(context) {{appendFileSync({},'called\\n');context.actions.register('example.terminal.compute',call=>({{value:call.params.value,calls:1}}));return ()=>{{}};}}",
        serde_json::to_string(&calls).unwrap()
    );
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
    let profile = fixture.finish().await;
    let runtime = tokio::task::spawn_blocking(|| {
        crate::node_runtime::verify_node_runtime(
            Path::new(&std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap()),
            &crate::node_runtime::NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
    })
    .await
    .unwrap();
    let server = crate::ipc::HostServer::bind(profile.path()).await.unwrap();
    let store = server.store();
    let auth = server.auth();
    let identity = server.identity().clone();
    let root = profile.path().to_path_buf();
    let gates = crate::node_test_gates::NodeTestGates::default();
    let mut busy = gates.recovery_snapshot_busy.arm();
    let (manager, operator, target) = tokio::task::spawn_blocking(move || {
        let credential =
            serial_workbench_ipc::read_secret(&root.join("host-v0/user-control.secret"))
                .unwrap()
                .unwrap();
        let operator = auth
            .authenticate_user_control(
                &id("storage-recovery-operator"),
                &ContextToken::try_from(std::str::from_utf8(&credential).unwrap()).unwrap(),
            )
            .unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: identity.host_id,
            session_id: None,
            session_epoch: None,
        };
        let registry = crate::registry::Registry::new(store.clone(), auth.clone()).unwrap();
        let files =
            crate::files::FileService::new(store.clone(), auth.clone(), store.identity().unwrap());
        let manager = Arc::new(crate::node_packages::NodePackageManager::new(
            store,
            auth,
            files,
            registry.runtime,
            gates,
        ));
        manager.provide_runtime(runtime).unwrap();
        (manager, operator, target)
    })
    .await
    .unwrap();
    let store = server.store();
    let mut saturated = tokio::task::spawn_blocking(move || store.saturate_writer_for_test())
        .await
        .unwrap();
    let running = crate::node_packages::NodePackageManager::start_recovery(&manager);
    busy.entered().await;
    tokio::task::spawn_blocking(move || saturated.release())
        .await
        .unwrap();
    busy.release();
    let restored = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let manager = manager.clone();
            let actor = operator.clone();
            let target = target.clone();
            let status = tokio::task::spawn_blocking(move || {
                manager.runtime_status(
                    &actor,
                    &target,
                    NodePackageRuntimeParams {
                        id: NodePackageId::try_from("example.terminal").unwrap(),
                    },
                )
            })
            .await
            .unwrap()
            .unwrap();
            if status.phase == NodePackageRuntimePhase::Active {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    manager.request_quiesce(true);
    manager.shutdown_runtime().await.unwrap();
    running.await.unwrap();
    drop(manager);
    drop(server);
    assert!(
        restored.is_ok(),
        "Full storage queue drained without any package/source/grant change, but recovery never retried its initial snapshot"
    );
    assert_eq!(std::fs::read_to_string(calls).unwrap().lines().count(), 2);
    eprintln!(
        "native_recovery_snapshot_busy real_queue_capacity=256 drained=true unrelated_change=false registrations=2"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_host_startup_rechecks_revoked_activation_authority_and_source() {
    use sha2::{Digest as _, Sha256};
    for denial in ["grant", "source"] {
        let markers = support::Profile::isolated("host-node-backend-denied-recovery-");
        let calls = markers.path().join("register-calls.txt");
        let pid = markers.path().join("node.pid");
        let source = format!(
            "import {{appendFileSync,writeFileSync}} from 'node:fs'; export function register(context) {{appendFileSync({},'called\\n');writeFileSync({},String(process.pid));context.actions.register('example.terminal.compute',call=>({{value:call.params.value,calls:1}}));return ()=>{{}};}}",
            serde_json::to_string(&calls).unwrap(),
            serde_json::to_string(&pid).unwrap()
        );
        let fixture =
            node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
        let mut native = support::node_owner_exit::ProcessExit::observe(
            std::fs::read_to_string(&pid).unwrap().parse().unwrap(),
        );
        let revoked = if denial == "grant" {
            let accepted=fixture.invoke(&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.revoke",json!({
                "actorId":fixture.client.attachment().actor_id,"permissions":["plugins.manage"],"targets":[fixture.target]
            }))).await;
            fixture.wait(&fixture.user, &accepted.operation_id).await
        } else {
            let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
                .verifying_key()
                .to_bytes();
            let fingerprint = format!("{:x}", Sha256::digest(key));
            fixture.mutate(&fixture.user,"node.sources.revokeKey",json!({"source":"test-source","keyId":"test-key","publicKeySha256":fingerprint}),1).await
        };
        assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
        let target = fixture.target.clone();
        let profile = fixture.finish().await;
        assert!(
            native.exited(),
            "Original Node must exit before reopening its profile"
        );
        let mut restarted = OwnedHost::start(profile.path(), markers.path(), "denied").await;
        let client = HostClient::connect(ConnectOptions::new(
            profile.path().to_path_buf(),
            id("action-client"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        let mut status = None;
        let observed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let QueryResult::NodePackageRuntime(value) = query(
                    &client,
                    &target,
                    "node.packages.runtime",
                    json!({"id":"example.terminal"}),
                )
                .await
                else {
                    panic!("Expected runtime status");
                };
                let denied = value.phase == NodePackageRuntimePhase::Failed;
                status = Some(value);
                if denied {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        let QueryResult::NodePackages(installed) =
            query(&client, &target, "node.packages.list", json!({})).await
        else {
            panic!("Expected installed intent");
        };
        restarted.finish().await;
        assert!(
            observed.is_ok(),
            "Recovery did not report current {denial} denial: {status:?}"
        );
        let status = status.unwrap();
        assert_eq!(status.error.as_ref().unwrap().code, "PERMISSION_DENIED");
        assert_eq!(status.generation, 0.into());
        assert!(installed.packages[0].enabled && installed.packages[0].execution_approved);
        assert_eq!(std::fs::read_to_string(calls).unwrap().lines().count(), 1);
        eprintln!(
            "native_recovery_denied kind={denial} original_node_exited=true enabled_intent=true generation=0 registrations=1"
        );
    }
}

#[derive(Clone, Copy, Debug)]
enum RestartBoundary {
    Host,
    Node,
}

async fn restart_task(boundary: RestartBoundary, automatic: bool) {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-task-restart-markers-");
    let started = markers.path().join("child-committed.json");
    let calls = markers.path().join("handler-calls.txt");
    let registrations = markers.path().join("registrations.txt");
    let node_pid = markers.path().join("node.pid");
    let crash_node = markers.path().join("crash-node");
    let source = format!(
        r#"
        import {{appendFileSync,existsSync,renameSync,writeFileSync}} from 'node:fs';
        {marker_source}
        export function register(context) {{
          appendFileSync({},'registered\n'); writeFileSync({},String(process.pid));
          context.actions.register('example.terminal.compute',async (call,task)=>{{
            if(call.params.probe) return {{alive:true}};
            appendFileSync({},'called\n');
            const child=await task.actions.invokeChild({{actionId:'workspace.save',target:call.params.target,
              expectedRevision:'0',params:{{value:{{...call.params.value,name:'Committed before Host exit'}}}}}});
            let saved=await task.operations.get({{operationId:child.operationId}});
            while(['queued','running','cancel_requested'].includes(saved.state)) {{
              await new Promise(resolve=>setTimeout(resolve,10));
              saved=await task.operations.get({{operationId:child.operationId}});
            }}
            if(saved.state!=='succeeded') throw new Error('Child did not commit');
            publishMarker({},JSON.stringify({{operationId:child.operationId}}));
            while(true) {{
              if(existsSync({})) process.exit(77);
              task.signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,10));
            }}
          }}); return ()=>{{}};
        }}
    "#,
        serde_json::to_string(&registrations).unwrap(),
        serde_json::to_string(&node_pid).unwrap(),
        serde_json::to_string(&calls).unwrap(),
        serde_json::to_string(&started).unwrap(),
        serde_json::to_string(&crash_node).unwrap(),
        marker_source = support::PUBLISH_MARKER_JS,
    );
    let mut spec = node_host_actions::spec();
    spec.permissions = vec![
        "metadata.read".into(),
        "content.read".into(),
        "workspace.modify".into(),
    ];
    spec.target_kinds
        .push(ResourceKind::try_from("workspace").unwrap());
    spec.input_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    spec.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = node_host_actions::Fixture::installed_program(spec, source.as_bytes()).await;
    let grant = fixture.invoke(&fixture.user,fixture.call(&fixture.user,&fixture.target,"auth.authorize",json!({
        "clientId":fixture.client.attachment().client_id,"permissions":["workspace.modify"],"targets":[fixture.target]
    }))).await;
    assert_eq!(
        fixture.wait(&fixture.user, &grant.operation_id).await.state,
        OperationState::Succeeded
    );
    let target = fixture.target.clone();
    let workspace = Target {
        kind: ResourceKind::try_from("workspace").unwrap(),
        id: id("restart-workspace"),
        ..target.clone()
    };
    let QueryResult::Workspace(initial) = fixture
        .query(&fixture.client, &workspace, "workspace.read", json!({}))
        .await
    else {
        panic!("Expected workspace");
    };
    let archive = fixture.archive.clone();
    let profile = fixture.finish().await;
    let connect = || {
        ConnectOptions::new(
            profile.path().to_path_buf(),
            id("action-client"),
            ClientKind::Cli,
        )
    };
    let mut first = OwnedHost::start(profile.path(), markers.path(), "first").await;
    let client = HostClient::connect(connect()).await.unwrap();
    enable(&client, &target, &archive, 2).await;
    let QueryResult::NodePackageRuntime(before_runtime) = query(
        &client,
        &target,
        "node.packages.runtime",
        json!({"id":"example.terminal"}),
    )
    .await
    else {
        panic!("Expected runtime status");
    };
    let root = call(
        &client,
        &target,
        "example.terminal.compute",
        json!({"target":workspace,"value":initial.document.value}),
    );
    let parent = invoke(&client, root.clone()).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !started.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Native child did not commit before Host termination");
    let child_marker: Value = serde_json::from_slice(&std::fs::read(&started).unwrap()).unwrap();
    let active = operation(&client, &target, json!({"operationId":parent.operation_id})).await;
    let committed = operation(
        &client,
        &target,
        json!({"parentOperationId":parent.operation_id,"childKey":"1"}),
    )
    .await;
    assert_eq!(active.state, OperationState::Running);
    assert_eq!(active.child_high_watermark, 1.into());
    assert_eq!(committed.state, OperationState::Succeeded);
    let pid = std::fs::read_to_string(&node_pid).unwrap().parse().unwrap();
    let mut native = support::node_owner_exit::ProcessExit::observe(pid);
    assert!(!native.exited());
    match boundary {
        RestartBoundary::Host => first.crash(),
        RestartBoundary::Node => std::fs::write(&crash_node, b"crash").unwrap(),
    }
    let mut native = tokio::task::spawn_blocking(move || {
        assert!(native.wait(), "Owned Node did not actually exit");
        native
    })
    .await
    .unwrap();
    assert!(native.exited());
    native.reap_adopted_after_observation();
    drop(client);

    let mut second = match boundary {
        RestartBoundary::Host => {
            Some(OwnedHost::start(profile.path(), markers.path(), "second").await)
        }
        RestartBoundary::Node => {
            assert!(
                first.child.try_wait().unwrap().is_none(),
                "Node failure must preserve the Host process"
            );
            None
        }
    };
    let fresh = HostClient::connect(connect()).await.unwrap();
    let recovered = wait(&fresh, &target, &parent.operation_id).await;
    let saved = operation(
        &fresh,
        &target,
        json!({"parentOperationId":parent.operation_id,"childKey":"1"}),
    )
    .await;
    let selected=operation(&fresh,&target,json!({"actorId":root.actor_id,"requestId":root.request_id,"requestContext":root.request_context})).await;
    let QueryResult::Workspace(value) =
        query(&fresh, &workspace, "workspace.read", json!({})).await
    else {
        panic!("Expected workspace");
    };
    let restored_generation = match boundary {
        RestartBoundary::Host => before_runtime.generation,
        RestartBoundary::Node => before_runtime.generation.checked_next().unwrap(),
    };
    if automatic {
        let mut last = None;
        let restored = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let QueryResult::NodePackageRuntime(status) = query(
                    &fresh,
                    &target,
                    "node.packages.runtime",
                    json!({"id":"example.terminal"}),
                )
                .await
                else {
                    panic!("Expected runtime status");
                };
                if status.phase == NodePackageRuntimePhase::Active
                    && status.generation == restored_generation
                    && status.archive_sha256.as_ref() == Some(&archive)
                {
                    break;
                }
                last = Some(status);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if restored.is_err() {
            match second.as_mut() {
                Some(second) => second.finish().await,
                None => first.finish().await,
            }
            panic!(
                "Enabled package was not automatically registered after {boundary:?} restart: {last:?}"
            );
        }
    } else {
        // 显式恢复另验；不能借新根身份重建旧子任务。
        enable(&fresh, &target, &archive, 3).await;
    }
    let QueryResult::NodePackageRuntime(after_runtime) = query(
        &fresh,
        &target,
        "node.packages.runtime",
        json!({"id":"example.terminal"}),
    )
    .await
    else {
        panic!("Expected runtime status");
    };
    let mut old_context = root.clone();
    old_context.instance_epoch = fresh.attachment().instance_epoch;
    let expired = fresh
        .request(RpcRequest::Invoke(old_context))
        .await
        .unwrap();
    let old_epoch = fresh
        .request(RpcRequest::Invoke(root.clone()))
        .await
        .unwrap();
    let probe = invoke(
        &fresh,
        call(
            &fresh,
            &target,
            "example.terminal.compute",
            json!({"probe":true}),
        ),
    )
    .await;
    let probe = wait(&fresh, &target, &probe.operation_id).await;
    let QueryResult::Workspace(after) =
        query(&fresh, &workspace, "workspace.read", json!({})).await
    else {
        panic!("Expected workspace");
    };
    match second.as_mut() {
        Some(second) => second.finish().await,
        None => first.finish().await,
    }
    assert_eq!(fresh.attachment().host_id, root.host_id);
    assert_eq!(fresh.attachment().actor_id, root.actor_id);
    match boundary {
        RestartBoundary::Host => assert_ne!(fresh.attachment().instance_epoch, root.instance_epoch),
        RestartBoundary::Node => assert_eq!(fresh.attachment().instance_epoch, root.instance_epoch),
    }
    assert_eq!(recovered.state, OperationState::Unknown, "{recovered:?}");
    assert_eq!(recovered.child_high_watermark, 1.into());
    assert_eq!(selected.operation_id, recovered.operation_id);
    assert_eq!(selected.state, OperationState::Unknown);
    assert_eq!(saved, committed);
    assert_eq!(child_marker["operationId"], saved.operation_id.as_str());
    assert_eq!(value.document.revision, 1.into());
    assert_eq!(value.document.value.name, "Committed before Host exit");
    assert_eq!(after.document, value.document);
    assert_eq!(before_runtime.phase, NodePackageRuntimePhase::Active);
    assert_eq!(after_runtime.phase, NodePackageRuntimePhase::Active);
    assert_eq!(after_runtime.generation, restored_generation);
    match boundary {
        RestartBoundary::Host => {
            assert!(
                matches!(expired,RpcReply::Failure {ref error,..} if error.code=="RESULT_EXPIRED"),
                "{expired:?}"
            );
            assert!(
                matches!(old_epoch,RpcReply::Failure {ref error,..} if error.code=="EPOCH_MISMATCH"),
                "{old_epoch:?}"
            );
        }
        RestartBoundary::Node => {
            for reply in [expired, old_epoch] {
                let RpcReply::Success { result, .. } = reply else {
                    panic!("Same-epoch retry must retain its receipt: {reply:?}");
                };
                let RpcResult::Operation(value) = *result else {
                    panic!("Expected old operation");
                };
                assert_eq!(value.operation.operation_id, recovered.operation_id);
                assert_eq!(value.operation.state, OperationState::Unknown);
            }
        }
    }
    assert_eq!(probe.state, OperationState::Succeeded, "{probe:?}");
    assert_eq!(std::fs::read_to_string(&calls).unwrap().lines().count(), 1);
    assert_eq!(
        std::fs::read_to_string(&registrations)
            .unwrap()
            .lines()
            .count(),
        2
    );
    eprintln!(
        "native_task_restart boundary={boundary:?} old_node_exited=true parent=unknown child=succeeded workspace_revision=1 handler_calls=1 registrations=2 explicit_registration={}",
        !automatic
    );
}
