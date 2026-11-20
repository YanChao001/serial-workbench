use super::*;
use crate::test_support::{self as support, node_host_actions::spec, node_package};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use std::sync::atomic::AtomicBool;

struct TaskHost {
    h: support::Harness,
    target: Target,
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

impl TaskHost {
    async fn new(source: &[u8]) -> Self {
        let mut action = spec();
        action.permissions = vec![
            "metadata.read".into(),
            "content.read".into(),
            "workspace.modify".into(),
        ];
        action
            .target_kinds
            .push(ResourceKind::try_from("workspace").unwrap());
        action.input_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
        action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
        Self::new_with_spec(source, action).await
    }

    async fn new_with_spec(source: &[u8], action: ActionSpec) -> Self {
        let runtime = tokio::task::spawn_blocking(|| {
            crate::node_runtime::verify_node_runtime(
                std::path::Path::new(&std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap()),
                &crate::node_runtime::NodeRuntimeLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap()
        })
        .await
        .unwrap();
        let h = support::Harness::with_node_runtime(runtime).await;
        let target = Target {
            host_id: h.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: h.host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let operator = h
            .auth
            .authenticate_user_control(
                &id("task-lifetime-operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        h.auth
            .authorize(
                &operator,
                AuthorizeParams {
                    client_id: h.actor.client_id().clone(),
                    permissions: vec!["plugins.manage".into(), "workspace.modify".into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
            .verifying_key()
            .to_bytes();
        let digest =
            serial_workbench_core::Digest::try_from(format!("{:x}", Sha256::digest(key)).as_str())
                .unwrap();
        let approved = mutate(
            &h,
            &operator,
            &target,
            "node.sources.approveKey",
            json!({
                "source":"test-source","keyId":"test-key","publicKey":key,"publicKeySha256":digest
            }),
            0,
        )
        .await;
        assert_eq!(approved.state, OperationState::Succeeded, "{approved:?}");
        let mut manifest = node_package::manifest();
        manifest["permissions"]["hostApi"] =
            json!([{"permissions":action.permissions,"targetKinds":action.target_kinds}]);
        manifest["contributes"]["actions"] = json!([action]);
        let mut files = node_package::payloads();
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&manifest).unwrap(),
        );
        files.insert("dist/main.mjs".into(), source.to_vec());
        let archive_path = h.dir.path().join("signed-task-lifetime.zip");
        std::fs::write(
            &archive_path,
            node_package::archive(&node_package::with_metadata(files, true)),
        )
        .unwrap();
        let archive_ref = h
            .host
            .files()
            .register(
                RegisterFileParams {
                    path: archive_path.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &operator,
            )
            .unwrap();
        let installed = mutate(&h,&h.actor,&target,"node.packages.install",json!({
            "archiveRef":archive_ref,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}
        }),0).await;
        assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
        let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
            panic!("Expected package")
        };
        let archive = installed.package.archive_sha256;
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
        Self { h, target }
    }

    async fn query(&self, target: &Target, action: &str, params: Value) -> QueryResult {
        self.h
            .host
            .query(
                &self.h.actor,
                call_query(&self.h.call(target, action, params)),
            )
            .await
            .unwrap()
    }
}

#[path = "task_h16_tests.rs"]
mod task_h16_tests;

#[path = "task_tx_identity_tests.rs"]
mod task_tx_identity_tests;

#[path = "task_tx_retention_tests.rs"]
mod task_tx_retention_tests;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_independent_task_outlives_root_admission_window() {
    root_window(false).await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_expired_resource_grant_stays_denied_after_root_window() {
    root_window(true).await;
}

async fn root_window(finite_grant: bool) {
    let source = [support::node_package::PUBLISH_MARKER_JS, r#"
        import {existsSync,renameSync,writeFileSync} from 'node:fs';
        export function register(context) {
          context.actions.register('example.terminal.compute',async (call,task)=>{
            if(call.params.probe) return {alive:true};
            const save=(revision,name)=>task.actions.invokeChild({actionId:'workspace.save',target:call.params.target,
              params:{value:{...call.params.value,name}},expectedRevision:revision});
            const first=await save('0','Before root window expires');
            let receipt=await task.operations.get({operationId:first.operationId});
            while(['queued','running','cancel_requested'].includes(receipt.state)) {
              await new Promise(resolve=>setTimeout(resolve,10));
              receipt=await task.operations.get({operationId:first.operationId});
            }
            if(receipt.state!=='succeeded') throw new Error('First save did not commit');
            publishMarker(call.params.ready,JSON.stringify({firstOperationId:first.operationId}));
            while(!existsSync(call.params.release)) {
              task.signal.throwIfAborted();
              await new Promise(resolve=>setTimeout(resolve,10));
            }
            const second=await save('1','After root window expires');
            return {first,second};
          });return ()=>{};
        }
    "#].concat();
    let fixture = TaskHost::new(source.as_bytes()).await;
    let target = Target {
        kind: ResourceKind::try_from("workspace").unwrap(),
        id: id("task-after-root-window"),
        ..fixture.target.clone()
    };
    if finite_grant {
        let operator = fixture
            .h
            .auth
            .authenticate_user_control(
                &id("finite-task-grant-operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        fixture
            .h
            .auth
            .authorize(
                &operator,
                AuthorizeParams {
                    client_id: fixture.h.actor.client_id().clone(),
                    permissions: vec!["workspace.modify".into()],
                    targets: vec![target.clone()],
                    expires_at: Some(Timestamp::try_from("2026-11-07T00:00:01Z").unwrap()),
                },
            )
            .unwrap();
    }
    let QueryResult::Workspace(initial) = fixture.query(&target, "workspace.read", json!({})).await
    else {
        panic!("Expected workspace")
    };
    let ready = fixture.h.dir.path().join("before-expiry.json");
    let release = fixture.h.dir.path().join("after-expiry.ready");
    let mut call = fixture.h.call(
        &fixture.target,
        "example.terminal.compute",
        json!({
            "target":target,"value":initial.document.value,
            "ready":ready.to_str().unwrap(),"release":release.to_str().unwrap()
        }),
    );
    call.execution_mode = Some(ExecutionMode::Independent);
    let parent = fixture.h.invoke(call.clone()).await;
    let started = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while !ready.exists() {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    if started.is_err() {
        std::fs::write(&release, b"release").unwrap();
        fixture.h.host.shutdown().await.unwrap();
        panic!("Task did not commit its first child before clock advancement");
    }
    let first_marker: Value = serde_json::from_slice(&std::fs::read(&ready).unwrap()).unwrap();
    fixture.h.clock.advance_ms(86_400_001);
    let expired_replay = fixture.h.host.invoke(&fixture.h.actor, call.clone()).await;
    let mut new_from_expired = call;
    new_from_expired.request_id =
        RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
    let expired_new = fixture
        .h
        .host
        .invoke(&fixture.h.actor, new_from_expired)
        .await;
    let mut fresh = fixture.h.call(
        &fixture.target,
        "example.terminal.compute",
        json!({"probe":true}),
    );
    fresh.execution_mode = Some(ExecutionMode::Independent);
    let probe = fixture.h.invoke(fresh).await;
    let probe = fixture.h.wait(&probe.operation_id).await;
    let QueryResult::Operation(active) = fixture
        .query(
            &fixture.target,
            "operation.get",
            json!({"operationId":parent.operation_id}),
        )
        .await
    else {
        panic!("Expected active parent")
    };
    std::fs::write(&release, b"release").unwrap();
    let parent = fixture.h.wait(&parent.operation_id).await;
    let mut children = Vec::new();
    let keys: &[&str] = if finite_grant { &["1"] } else { &["1", "2"] };
    for key in keys {
        let QueryResult::Operation(child) = fixture
            .query(
                &fixture.target,
                "operation.get",
                json!({
                    "parentOperationId":parent.operation_id,"childKey":key
                }),
            )
            .await
        else {
            panic!("Expected child")
        };
        children.push(child.operation);
    }
    let QueryResult::Workspace(saved) = fixture.query(&target, "workspace.read", json!({})).await
    else {
        panic!("Expected workspace")
    };
    fixture.h.host.shutdown().await.unwrap();
    assert!(
        matches!(expired_replay,Err(ref error) if error.code=="RESULT_EXPIRED"),
        "{expired_replay:?}"
    );
    assert!(
        matches!(expired_new,Err(ref error) if error.code=="RESULT_EXPIRED"),
        "{expired_new:?}"
    );
    assert_eq!(probe.state, OperationState::Succeeded, "{probe:?}");
    if finite_grant {
        assert!(matches!(
            active.operation.state,
            OperationState::Running | OperationState::Interrupted
        ));
    } else {
        assert_eq!(active.operation.state, OperationState::Running);
    }
    assert_eq!(active.operation.child_high_watermark, 1.into());
    assert_eq!(parent.execution_mode, ExecutionMode::Independent);
    assert_eq!(
        parent.child_high_watermark,
        (if finite_grant { 1_u64 } else { 2 }).into()
    );
    assert_eq!(
        first_marker["firstOperationId"],
        children[0].operation_id.as_str()
    );
    for child in &children {
        assert_eq!(child.state, OperationState::Succeeded, "{child:?}");
        assert_eq!(child.actor_id, parent.actor_id);
        assert_eq!(child.root_operation_id, parent.operation_id);
        assert_eq!(child.execution_mode, ExecutionMode::Independent);
    }
    if finite_grant {
        // 原授权快照的单调期限已经届满；父任务停止，不能靠TaskContext延长授权。
        assert_eq!(parent.state, OperationState::Interrupted, "{parent:?}");
        assert_eq!(parent.error.as_ref().unwrap().code, "PERMISSION_DENIED");
        assert!(parent.result.is_none());
        assert_eq!(saved.document.revision, 1.into());
        assert_eq!(saved.document.value.name, "Before root window expires");
    } else {
        assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
        assert_ne!(children[0].request_id, children[1].request_id);
        assert_ne!(children[0].operation_id, children[1].operation_id);
        assert_eq!(saved.document.revision, 2.into());
        assert_eq!(saved.document.value.name, "After root window expires");
    }
    eprintln!(
        "native_task_root_window advanced_ms=86400001 old_context_rejected=true finite_grant={finite_grant} parent={:?} child_watermark={} workspace_revision={}",
        parent.state, parent.child_high_watermark, saved.document.revision
    );
}
