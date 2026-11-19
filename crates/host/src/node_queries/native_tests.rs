use super::*;
use crate::{
    node_test_gates::{NativeExit, NodeTestGates},
    test_support::{
        self as support,
        node_owner_exit::{ParentReaper, ProcessExit, assert_gone},
        node_package,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use std::{path::PathBuf, sync::atomic::AtomicBool, time::Duration};

struct Fixture {
    h: support::Harness,
    operator: AuthenticatedActor,
    target: Target,
    archive: Digest,
    source_key: Digest,
    calls: PathBuf,
    disposed: PathBuf,
    processes: Processes,
}
#[derive(Deserialize)]
struct Processes {
    node: u32,
    child: u32,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
            .expect("Explicit native runtime fixture is required");
        let runtime = tokio::task::spawn_blocking(move || {
            crate::node_runtime::verify_node_runtime(
                std::path::Path::new(&root),
                &crate::node_runtime::NodeRuntimeLimits::default(),
                &AtomicBool::new(false),
            )
        })
        .await
        .unwrap()
        .unwrap();
        let h = support::Harness::with_node_runtime(runtime).await;
        let target = Target {
            host_id: h.host_id.clone(),
            id: h.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let operator = h
            .auth
            .authenticate_user_control(
                &support::id("native-gate-operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        h.auth
            .authorize(
                &operator,
                AuthorizeParams {
                    client_id: h.actor.client_id().clone(),
                    permissions: vec!["plugins.manage".into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
            .verifying_key()
            .to_bytes();
        let source_key = Digest::try_from(format!("{:x}", Sha256::digest(key)).as_str()).unwrap();
        let approved = mutate(&h, &operator, &target, "node.sources.approveKey", json!({"source":"test-source","keyId":"test-key","publicKey":key,"publicKeySha256":source_key}), 0).await;
        assert_eq!(approved.state, OperationState::Succeeded, "{approved:?}");
        let calls = h.dir.path().join("query-calls.txt");
        let disposed = h.dir.path().join("query-disposed.txt");
        let marker = h.dir.path().join("query-processes.json");
        let mut spec = BuiltinAction::HostMetrics.spec().clone();
        spec.action_id = support::id("example.terminal.echo");
        spec.permissions = vec!["content.read".into()];
        spec.state_scopes.clear();
        spec.event_types.clear();
        spec.reveal_target = serde_json::from_value(json!({"pageId":"workbench"})).unwrap();
        spec.input_schema =
            serde_json::from_value(json!({"type":"object","additionalProperties":false})).unwrap();
        spec.output_schema = serde_json::from_value(json!({"type":"object","properties":{"answer":{"const":"ready"}},"required":["answer"],"additionalProperties":false})).unwrap();
        let mut manifest = node_package::manifest();
        manifest["permissions"]["hostApi"] =
            json!([{"permissions":["content.read"],"targetKinds":["host"]}]);
        manifest["contributes"]["queries"] = json!([spec]);
        let script = format!(
            "import {{writeFileSync}} from 'node:fs'; import {{spawn}} from 'node:child_process'; export function register(context) {{ const windows=process.platform==='win32'; const child=spawn(windows?process.execPath:'/bin/sleep',windows?['--eval','setInterval(()=>{{}},1000)']:['60'],{{stdio:'ignore',windowsHide:true}}); writeFileSync({}, JSON.stringify({{node:process.pid,child:child.pid}})); let calls=0; context.queries.register('example.terminal.echo',()=>{{ writeFileSync({},String(++calls)); return {{answer:'ready'}}; }}); return ()=>writeFileSync({},'disposed'); }}",
            serde_json::to_string(&marker).unwrap(),
            serde_json::to_string(&calls).unwrap(),
            serde_json::to_string(&disposed).unwrap(),
        );
        let mut files = node_package::payloads();
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        files.insert("dist/main.mjs".into(), script.into_bytes());
        let path = h.dir.path().join("signed-query.zip");
        let archive = node_package::archive(&node_package::with_metadata(files, true));
        std::fs::write(&path, archive).unwrap();
        let reference = h
            .host
            .files()
            .register(
                RegisterFileParams {
                    path: path.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &operator,
            )
            .unwrap();
        let installed = mutate(&h, &h.actor, &target, "node.packages.install", json!({"archiveRef":reference,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}}), 0).await;
        assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
        let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
            panic!("Expected installed package")
        };
        let archive = installed.package.archive_sha256.clone();
        let confirmed = mutate(
            &h,
            &operator,
            &target,
            "node.packages.confirmExecutionTrust",
            json!({"id":"example.terminal","archiveSha256":archive}),
            1,
        )
        .await;
        assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
        let enabled = mutate(
            &h,
            &h.actor,
            &target,
            "node.packages.setEnabled",
            json!({"id":"example.terminal","archiveSha256":archive,"enabled":true}),
            2,
        )
        .await;
        assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
        let processes = serde_json::from_slice(&std::fs::read(marker).unwrap()).unwrap();
        let fixture = Self {
            h,
            operator,
            target,
            archive,
            source_key,
            calls,
            disposed,
            processes,
        };
        assert_eq!(
            serde_json::to_value(
                fixture
                    .query("example.terminal.echo", json!({}))
                    .await
                    .unwrap()
            )
            .unwrap(),
            json!({"kind":"extension","value":{"answer":"ready"}})
        );
        assert_eq!(fixture.call_count(), "1");
        fixture
    }
    fn gates(&self) -> &NodeTestGates {
        &self.h.host.inner.node_test_gates
    }
    fn call_count(&self) -> String {
        std::fs::read_to_string(&self.calls).unwrap()
    }
    async fn query(&self, action: &str, params: Value) -> HostResult<QueryResult> {
        let call = self.h.call(&self.target, action, params);
        self.h.host.query(&self.h.actor, to_query(call)).await
    }
    async fn catalog(&self) -> CatalogListResult {
        let QueryResult::Catalog(catalog) = self
            .query("catalog.list", json!({"pageSize":"100"}))
            .await
            .unwrap()
        else {
            panic!("Expected catalog")
        };
        catalog
    }
    async fn exit(&self) -> Option<NativeExit> {
        let mut events = self.gates().exited.subscribe();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(report) = events.borrow().clone() {
                    return report;
                }
                events.changed().await.unwrap();
            }
        })
        .await
        .ok()
    }
}
fn to_query(call: Call) -> Query {
    Query {
        protocol_version: call.protocol_version,
        host_id: call.host_id,
        instance_epoch: call.instance_epoch,
        actor_id: call.actor_id,
        request_id: call.request_id,
        action_id: call.action_id,
        target: call.target,
        params: call.params,
        reveal_target: call.reveal_target,
    }
}
async fn mutate(
    h: &support::Harness,
    actor: &AuthenticatedActor,
    target: &Target,
    action: &str,
    params: Value,
    revision: u64,
) -> Operation {
    let mut call = h.call_as(actor, target, action, params);
    call.expected_revision = Some(revision.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(actor, call).await.unwrap();
    h.wait_as(actor, &accepted.operation_id).await
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_catalog_source_revocation_stays_denied_until_actual_owner_exit() {
    let _reaper = ParentReaper::install();
    for read_runtime_first in [true, false] {
        source_revocation_scenario(read_runtime_first).await;
    }
}
async fn source_revocation_scenario(read_runtime_first: bool) {
    let fixture = Fixture::new().await;
    let mut node = ProcessExit::observe(fixture.processes.node);
    let mut child = ProcessExit::observe(fixture.processes.child);
    let before = fixture.catalog().await.catalog_version;
    let mut gate = fixture.gates().before_authority.arm();
    gate.entered().await;
    let revoked = mutate(
        &fixture.h,
        &fixture.operator,
        &fixture.target,
        "node.sources.revokeKey",
        json!({"source":"test-source","keyId":"test-key","publicKeySha256":fixture.source_key}),
        1,
    )
    .await;
    assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
    // owner仍在屏障内，由公共目录首先消费同一lease的来源变化。
    let catalog = fixture.catalog().await;
    assert!(catalog.catalog_version > before);
    assert!(
        !catalog
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "example.terminal.echo")
    );
    gate.release();
    let before_shutdown = fixture.exit().await;
    let physical_before_shutdown = before_shutdown.is_some() && node.wait() && child.wait();
    if read_runtime_first {
        let QueryResult::NodePackageRuntime(status) = fixture
            .query("node.packages.runtime", json!({"id":"example.terminal"}))
            .await
            .unwrap()
        else {
            panic!("Expected runtime state")
        };
        assert_eq!(status.phase, NodePackageRuntimePhase::Failed);
    }
    // 失败反例也完成清理；主动关停产生的退出不能补作撤权的成功证据。
    let shutdown = fixture.h.host.shutdown().await;
    assert!(
        node.wait() && child.wait(),
        "Owned Node and ordinary child must actually exit"
    );
    eprintln!(
        "native_source_catalog_first exit_before_shutdown={}",
        before_shutdown.is_some()
    );
    let report =
        before_shutdown.expect("Directory denial must remain denied for the actual shared owner");
    assert!(
        physical_before_shutdown,
        "Revocation must end owned processes before explicit Host shutdown"
    );
    assert_eq!(report.process_id, fixture.processes.node);
    assert!(report.reaped);
    let error = report
        .error
        .expect("Source revocation must retain its actual cause");
    let error = serde_json::to_value(error).unwrap();
    assert_eq!(error["code"], "NODE_BACKEND_INTERRUPTED");
    assert_eq!(error["details"]["reason"], "backendActiveAuthorityChanged");
    assert_eq!(error["details"]["causeCode"], "PERMISSION_DENIED");
    shutdown.expect("A reaped historical backend failure must not prevent actual Host cleanup");
    let QueryResult::NodePackageRuntime(retained) = fixture
        .query("node.packages.runtime", json!({"id":"example.terminal"}))
        .await
        .unwrap()
    else {
        panic!("Expected retained runtime failure")
    };
    assert_eq!(retained.phase, NodePackageRuntimePhase::Failed);
    assert_eq!(
        retained.error.unwrap().code,
        "PERMISSION_DENIED",
        "Successful cleanup must preserve the original runtime failure"
    );
    assert_gone(fixture.processes.node);
    let fixture_reaped_child = child.reap_adopted_after_observation();
    eprintln!(
        "native_node_receipt {}",
        json!({"case":"catalogSourceRevocation","nodePid":fixture.processes.node,"ordinaryChildPid":fixture.processes.child,"exitBeforeHostShutdown":physical_before_shutdown,"reaped":report.reaped,"reason":"backendActiveAuthorityChanged","causeCode":"PERMISSION_DENIED","readRuntimeBeforeShutdown":read_runtime_first,"shutdownCompleted":true,"historicalFailureRetained":true,"fixtureReapedChild":fixture_reaped_child})
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_quiesce_signal_preserves_runtime_cause_before_catalog_transition() {
    let _reaper = ParentReaper::install();
    let fixture = Fixture::new().await;
    let mut node = ProcessExit::observe(fixture.processes.node);
    let mut child = ProcessExit::observe(fixture.processes.child);
    let mut restore = fixture.gates().recovery_before_restore.arm();
    let mut authority = fixture.gates().before_authority.arm();
    authority.entered().await;
    let revoked = mutate(
        &fixture.h,
        &fixture.operator,
        &fixture.target,
        "node.sources.revokeKey",
        json!({"source":"test-source","keyId":"test-key","publicKeySha256":fixture.source_key}),
        1,
    )
    .await;
    assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
    let catalog = fixture.catalog().await;
    assert!(
        !catalog
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "example.terminal.echo")
    );
    authority.release();
    let report = fixture
        .exit()
        .await
        .expect("Revocation must end its actual owner");
    let physical_before_close = node.exited() && child.exited();
    restore.entered().await;
    let before = fixture
        .query("node.packages.runtime", json!({"id":"example.terminal"}))
        .await
        .unwrap();
    let mut signalled = fixture.gates().quiesce_signalled.arm();
    let mut scanned = fixture.gates().recovery_failed_scan.arm();
    let manager = fixture.h.host.inner.node_packages.clone();
    let closing = tokio::task::spawn_blocking(move || manager.request_quiesce(true));
    signalled.entered().await;
    // 停止信号已真实可见，目录transition尚未进入；只放行已经持有名额的真实恢复轮。
    restore.release();
    scanned.entered().await;
    let during = fixture
        .query("node.packages.runtime", json!({"id":"example.terminal"}))
        .await
        .unwrap();
    scanned.release();
    signalled.release();
    closing.await.unwrap();
    fixture.h.host.shutdown().await.unwrap();
    let after = fixture
        .query("node.packages.runtime", json!({"id":"example.terminal"}))
        .await
        .unwrap();
    let QueryResult::NodePackageRuntime(before) = before else {
        panic!("Expected original runtime failure");
    };
    let QueryResult::NodePackageRuntime(during) = during else {
        panic!("Expected intermediate runtime failure");
    };
    let QueryResult::NodePackageRuntime(after) = after else {
        panic!("Expected retained runtime failure");
    };
    eprintln!(
        "native_quiesce_signal actual_recovery_round_completed=true node_exited_before_close={physical_before_close} before_error={} during_error={} after_error={}",
        before.error.as_ref().unwrap().code,
        during.error.as_ref().unwrap().code,
        after.error.as_ref().unwrap().code
    );
    assert!(report.reaped && physical_before_close);
    assert_eq!(before.error.as_ref().unwrap().code, "PERMISSION_DENIED");
    assert_eq!(during.phase, NodePackageRuntimePhase::Failed);
    assert_eq!(
        during.error.as_ref().unwrap().code,
        "PERMISSION_DENIED",
        "A stopping recovery cannot overwrite history before catalog transition"
    );
    assert_eq!(after, during);
    assert_eq!(fixture.call_count(), "1");
    assert_gone(fixture.processes.node);
    child.reap_adopted_after_observation();
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_stopping_rejects_a_captured_query_before_dispose_is_enqueued() {
    let _reaper = ParentReaper::install();
    let fixture = Fixture::new().await;
    let mut node = ProcessExit::observe(fixture.processes.node);
    let mut child = ProcessExit::observe(fixture.processes.child);
    let mut resolved = fixture.gates().query_resolved.arm();
    let host = fixture.h.host.clone();
    let actor = fixture.h.actor.clone();
    let query = to_query(
        fixture
            .h
            .call(&fixture.target, "example.terminal.echo", json!({})),
    );
    let waiting_query = tokio::spawn(async move { host.query(&actor, query).await });
    resolved.entered().await;
    let mut disposing = fixture.gates().before_dispose.arm();
    let host = fixture.h.host.clone();
    let actor = fixture.h.actor.clone();
    let mut disable = fixture.h.call(
        &fixture.target,
        "node.packages.setEnabled",
        json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":false}),
    );
    disable.expected_revision = Some(3.into());
    disable.execution_mode = Some(ExecutionMode::Independent);
    let stopping = tokio::spawn(async move { host.invoke(&actor, disable).await });
    disposing.entered().await;
    let catalog = fixture.catalog().await;
    assert!(
        !catalog
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "example.terminal.echo")
    );
    let QueryResult::NodePackageRuntime(status) = fixture
        .query("node.packages.runtime", json!({"id":"example.terminal"}))
        .await
        .unwrap()
    else {
        panic!("Expected runtime status")
    };
    assert_eq!(status.phase, NodePackageRuntimePhase::Stopping);
    resolved.release();
    let query_result = waiting_query.await.unwrap();
    let calls = fixture.call_count();
    disposing.release();
    let accepted = stopping.await.unwrap().unwrap();
    let disabled = fixture.h.wait(&accepted.operation_id).await;
    assert_eq!(disabled.state, OperationState::Succeeded, "{disabled:?}");
    let closed_when_completed = node.exited() && child.exited();
    let report = fixture
        .exit()
        .await
        .expect("Disposal must finish its actual owner");
    assert!(report.reaped && report.error.is_none());
    assert_eq!(report.process_id, fixture.processes.node);
    assert!(
        closed_when_completed,
        "Actual Node/child exit must precede public completion"
    );
    assert_eq!(
        std::fs::read_to_string(&fixture.disposed).unwrap(),
        "disposed"
    );
    fixture.h.host.shutdown().await.unwrap();
    eprintln!("native_stopping_query result={query_result:?} handler_calls={calls}");
    assert_eq!(query_result.unwrap_err().code, "CATALOG_CHANGED");
    assert_eq!(
        calls, "1",
        "A query resumed after Stopping must not enter the real handler"
    );
    assert_gone(fixture.processes.node);
    let fixture_reaped_child = child.reap_adopted_after_observation();
    eprintln!(
        "native_node_receipt {}",
        json!({"case":"stoppingBeforeDispose","nodePid":fixture.processes.node,"ordinaryChildPid":fixture.processes.child,"closedWhenCompleted":closed_when_completed,"reaped":report.reaped,"handlerCalls":calls,"queryError":"CATALOG_CHANGED","operationState":"succeeded","fixtureReapedChild":fixture_reaped_child})
    );
}
