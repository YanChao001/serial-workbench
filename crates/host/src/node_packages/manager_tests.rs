//! 实际执行器排队与持久 Operation 的边界，不更改生产时间预算。
use super::*;
use crate::{
    storage::{Acceptance, canonical_digest},
    test_support as support,
};
use serde_json::json;
use std::time::Duration;

#[test]
fn queued_install_deadline_settles_without_dispatching_or_reading_the_archive() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let h = support::Harness::new().await;
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
                &support::id("operator"),
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
        let path = h.dir.path().join("must-not-be-read.zip");
        std::fs::write(&path, b"deadline prevents inspecting these bytes").unwrap();
        let registration =
            FileService::new(h.store.clone(), h.auth.clone(), h.store.identity().unwrap());
        let reference = registration
            .register(
                RegisterFileParams {
                    path: path.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &operator,
            )
            .unwrap();
        let catalog = crate::registry::Registry::new(h.store.clone(), h.auth.clone())
            .unwrap()
            .runtime;
        let manager = NodePackageManager::new(
            h.store.clone(),
            h.auth.clone(),
            h.host.files().clone(),
            catalog,
            crate::node_test_gates::NodeTestGates::default(),
        );
        let params = NodePackageInstallParams {
            archive_ref: reference,
            source: NodePackageInstallSource::Local,
        };
        manager.authorize(&h.actor, &target, &params).unwrap();
        let mut call = h.call(&target, "node.packages.install", json!(params));
        call.execution_mode = Some(ExecutionMode::Independent);
        call.expected_revision = Some(0.into());
        let Acceptance::New(operation) = h
            .store
            .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
            .unwrap()
        else {
            panic!("Expected a new admission")
        };
        let operation_id = operation.operation_id.clone();
        let accepted = AcceptedCall {
            actor: h.actor.clone(),
            call,
            operation,
        };
        let stamp = h.auth.capture_grants(&h.actor).unwrap();

        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, held) = std::sync::mpsc::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            entered.send(()).unwrap();
            held.recv_timeout(Duration::from_secs(40)).unwrap();
        });
        ready.await.unwrap();
        let executing = tokio::spawn(async move { manager.execute(&accepted, stamp).await });
        // 真实排队超过既有30秒预算，worker尚未得到线程，不以缩短生产期限模拟。
        tokio::time::sleep(NodePackageLimits::default().timeout + Duration::from_millis(100)).await;
        assert!(!executing.is_finished());
        assert_eq!(h.host.files().file_read_bytes(), 0);
        release.send(()).unwrap();
        blocker.await.unwrap();
        let settlement = tokio::time::timeout(Duration::from_secs(5), executing)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(settlement.error.as_ref().unwrap().code, "LIMIT_EXCEEDED");
        let store = h.store.clone();
        let completed =
            tokio::task::spawn_blocking(move || store.settle(&operation_id, settlement))
                .await
                .unwrap()
                .unwrap();
        assert_eq!(completed.state, OperationState::Interrupted);
        assert!(completed.started_at.is_none());
        assert_eq!(completed.error.unwrap().code, "LIMIT_EXCEEDED");
        assert_eq!(h.host.files().file_read_bytes(), 0);
        h.host.shutdown().await.unwrap();
    });
}
