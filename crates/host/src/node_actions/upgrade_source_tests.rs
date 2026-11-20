//! 候选完整暂存后撤来源，必须在真实安装CAS前拒绝发布。
use super::*;
use crate::node_packages::NodePackageInstaller;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_prepared_upgrade_rechecks_source_revocation_before_commit() {
    let markers = support::Profile::isolated("host-node-backend-upgrade-source-commit-");
    let events = markers.path().join("events.txt");
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), &program(&events, 1)).await;
    let installer = installer(&fixture).await;
    let before = retained_installation(&fixture).await;
    assert_eq!(before.0, 3.into());
    let request = upgrade_request(
        &fixture,
        &installer,
        &events,
        false,
        2,
        before.0.get(),
        vec![id("startup")],
    )
    .await;
    let mut committing = fixture
        .host
        .inner
        .node_test_gates
        .upgrade_before_commit
        .arm();
    let accepted = fixture.invoke(&installer, request.clone()).await;
    committing.entered().await;

    // 原门位于实际候选暂存、旧代收敛之后，最终effect/Auth/CAS锁之前。
    let QueryResult::NodePackageSources(sources) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.sources.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected actual source trust snapshot");
    };
    let key = sources
        .keys
        .iter()
        .find(|key| key.source.as_str() == "test-source" && key.key_id.as_str() == "test-key")
        .unwrap();
    assert!(key.approved);
    let revoke = fixture
        .mutate(
            &fixture.user,
            "node.sources.revokeKey",
            json!({"source":key.source,"keyId":key.key_id,"publicKeySha256":key.public_key_sha256}),
            sources.revision.get(),
        )
        .await;
    assert_eq!(revoke.state, OperationState::Succeeded, "{revoke:?}");
    let Some(ActionResult::NodeSourceChanged(changed)) = &revoke.result else {
        panic!("Expected committed source revocation: {revoke:?}");
    };
    assert_eq!(changed.revision, sources.revision.checked_next().unwrap());
    assert!(!changed.key.approved);
    assert_eq!(changed.key.public_key_sha256, key.public_key_sha256);
    let QueryResult::NodePackageSources(revoked_sources) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.sources.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected source revocation to be observable before install CAS");
    };
    assert_eq!(revoked_sources.revision, changed.revision);
    assert!(
        revoked_sources
            .keys
            .iter()
            .any(|entry| entry.source == key.source
                && entry.key_id == key.key_id
                && !entry.approved)
    );
    let at_gate = retained_installation(&fixture).await;
    committing.release();

    let rejected = fixture.wait(&installer, &accepted.operation_id).await;
    let after = retained_installation(&fixture).await;
    let replay = fixture.invoke(&installer, request).await;
    let observed = std::fs::read_to_string(&events).unwrap();
    let candidate_retained = fixture.dir.path().join("signed-upgrade-2.zip").is_file();
    let _profile = fixture.finish().await;
    assert_eq!(rejected.state, OperationState::Interrupted, "{rejected:?}");
    assert_eq!(rejected.error.as_ref().unwrap().code, "PERMISSION_DENIED");
    assert!(
        rejected.result.is_none(),
        "No installation commit was allowed"
    );
    assert_eq!(at_gate, before);
    assert_eq!(
        after, before,
        "Source revocation must not replace the old installation record"
    );
    assert_eq!(replay, rejected);
    assert!(candidate_retained);
    // 旧版来源也已撤销，不能把恢复旧版Active作为这条路径的成功条件。
    assert_eq!(observed, "register-1\ndispose-1\n");
    assert_eq!(std::fs::read_to_string(events).unwrap(), observed);
    eprintln!(
        "native_prepared_upgrade_source revoked_before_cas=true revision=3 old_record_unchanged=true install=permission_denied uncommitted_imports=0 replay_unchanged=true"
    );
}

async fn retained_installation(fixture: &node_host_actions::Fixture) -> (U64, serde_json::Value) {
    let store = fixture.host.inner.store.clone();
    tokio::task::spawn_blocking(move || {
        let snapshot = NodePackageInstaller::read_snapshot(&store).unwrap();
        (
            snapshot.revision,
            serde_json::to_value(snapshot.packages).unwrap(),
        )
    })
    .await
    .unwrap()
}
