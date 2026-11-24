mod support;

use serde_json::{Value, json};
use serial_workbench_core::*;
use serial_workbench_host::auth::AuthenticatedActor;
use sha2::{Digest as _, Sha256};
use support::{Harness, id};

fn host_target(h: &Harness) -> Target {
    Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: h.host_id.clone(),
        session_id: None,
        session_epoch: None,
    }
}
fn operator(h: &Harness) -> AuthenticatedActor {
    h.auth
        .authenticate_user_control(
            &id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap()
}
async fn query(
    h: &Harness,
    actor: &AuthenticatedActor,
    action: &str,
    params: Value,
) -> HostResult<QueryResult> {
    let call = h.call_as(actor, &host_target(h), action, params);
    h.host
        .query(
            actor,
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
            },
        )
        .await
}
async fn change_source(
    h: &Harness,
    actor: &AuthenticatedActor,
    action: &str,
    params: Value,
    revision: u64,
) -> Operation {
    let mut call = h.call_as(actor, &host_target(h), action, params);
    call.expected_revision = Some(revision.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted = h.host.invoke(actor, call).await.unwrap();
    h.wait_as(actor, &accepted.operation_id).await
}

#[tokio::test]
async fn source_approval_rotation_and_revocation_are_user_controlled_paged_and_content_bound() {
    let h = Harness::new().await;
    let user = operator(&h);
    let reader = h
        .auth
        .authenticate(&id("source-metadata-reader"), None)
        .unwrap()
        .actor;
    assert!(
        h.auth
            .require(&reader, "content.read", &host_target(&h))
            .is_err()
    );
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
        .verifying_key()
        .to_bytes();
    let next = ed25519_dalek::SigningKey::from_bytes(&[8; 32])
        .verifying_key()
        .to_bytes();
    let params = |key: [u8; 32]| json!({"source":"test-source","keyId":"test-key","publicKey":key,"publicKeySha256":format!("{:x}", Sha256::digest(key))});
    let empty = query(&h, &reader, "node.sources.list", json!({}))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(empty).unwrap(),
        json!({"kind":"node_package_sources","value":{"revision":"0","keys":[]}})
    );
    let approved = change_source(&h, &user, "node.sources.approveKey", params(key), 0).await;
    assert_eq!(
        approved.state,
        OperationState::Succeeded,
        "{:?}",
        approved.error
    );
    let approved = serde_json::to_value(approved.result).unwrap();
    assert_eq!(approved["kind"], "node_source_changed");
    assert_eq!(approved["value"]["revision"], "1");
    assert_eq!(approved["value"]["key"]["approved"], true);
    assert!(
        h.auth
            .require(&h.actor, "plugins.manage", &host_target(&h))
            .is_err()
    );
    assert!(
        h.auth
            .require(&h.actor, "code.execute", &host_target(&h))
            .is_err()
    );
    let rotated = change_source(&h, &user, "node.sources.approveKey", params(next), 1).await;
    assert_eq!(
        rotated.state,
        OperationState::Succeeded,
        "{:?}",
        rotated.error
    );
    let first = query(&h, &reader, "node.sources.list", json!({"pageSize":"1"}))
        .await
        .unwrap();
    let first = serde_json::to_value(first).unwrap();
    assert_eq!(first["value"]["revision"], "2");
    assert_eq!(first["value"]["keys"][0]["publicKey"], json!(key));
    assert_eq!(first["value"]["keys"][0]["approved"], false);
    assert_eq!(first["value"]["nextOffset"], "1");
    let second = query(
        &h,
        &h.actor,
        "node.sources.list",
        json!({"pageSize":"1","offset":"1","expectedRevision":"2"}),
    )
    .await
    .unwrap();
    let second = serde_json::to_value(second).unwrap();
    assert_eq!(second["value"]["keys"][0]["publicKey"], json!(next));
    assert_eq!(second["value"]["keys"][0]["approved"], true);
    assert!(second["value"].get("nextOffset").is_none());
    let revoke = json!({"source":"test-source","keyId":"test-key","publicKeySha256":format!("{:x}",Sha256::digest(next))});
    let stale = change_source(&h, &user, "node.sources.revokeKey", revoke.clone(), 1).await;
    assert_eq!(stale.state, OperationState::Failed);
    assert_eq!(stale.error.unwrap().code, "REVISION_CONFLICT");
    let mut wrong = revoke.clone();
    wrong["publicKeySha256"] = json!(format!("{:x}", Sha256::digest(key)));
    let wrong = change_source(&h, &user, "node.sources.revokeKey", wrong, 2).await;
    assert_eq!(wrong.state, OperationState::Failed);
    assert_eq!(wrong.error.unwrap().code, "INTEGRITY_FAILED");
    let revoked = change_source(&h, &user, "node.sources.revokeKey", revoke, 2).await;
    assert_eq!(
        revoked.state,
        OperationState::Succeeded,
        "{:?}",
        revoked.error
    );
    let history = query(&h, &reader, "node.sources.list", json!({}))
        .await
        .unwrap();
    let history = serde_json::to_value(history).unwrap();
    assert_eq!(history["value"]["revision"], "3");
    assert_eq!(history["value"]["keys"].as_array().unwrap().len(), 2);
    assert!(
        history["value"]["keys"]
            .as_array()
            .unwrap()
            .iter()
            .all(|key| key["approved"] == false)
    );
    for params in [
        json!({"pageSize":"0"}),
        json!({"pageSize":"101"}),
        json!({"offset":"1"}),
        json!({"offset":"3","expectedRevision":"3"}),
    ] {
        assert_eq!(
            query(&h, &h.actor, "node.sources.list", params)
                .await
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }
    assert_eq!(
        query(
            &h,
            &h.actor,
            "node.sources.list",
            json!({"offset":"1","expectedRevision":"2"})
        )
        .await
        .unwrap_err()
        .code,
        "REVISION_CONFLICT"
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn ordinary_plugin_and_code_grants_cannot_establish_source_trust_or_discover_control_actions()
{
    let h = Harness::new().await;
    let user = operator(&h);
    h.auth
        .authorize(
            &user,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["plugins.manage".into(), "code.execute".into()],
                targets: vec![host_target(&h)],
                expires_at: None,
            },
        )
        .unwrap();
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
        .verifying_key()
        .to_bytes();
    let mut call = h.call(&host_target(&h), "node.sources.approveKey", json!({"source":"test-source","keyId":"test-key","publicKey":key,"publicKeySha256":format!("{:x}",Sha256::digest(key))}));
    call.expected_revision = Some(0.into());
    call.execution_mode = Some(ExecutionMode::Independent);
    assert_eq!(
        h.host.invoke(&h.actor, call).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    let catalog = query(&h, &h.actor, "catalog.list", json!({"pageSize":"100"}))
        .await
        .unwrap();
    let QueryResult::Catalog(catalog) = catalog else {
        panic!("Expected catalog")
    };
    assert!(
        catalog
            .items
            .iter()
            .all(|item| item.action_id.as_str() != "node.sources.approveKey"
                && item.action_id.as_str() != "node.sources.revokeKey")
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn source_approval_rejects_wrong_fingerprints_weak_keys_and_missing_revision_without_writing()
{
    let h = Harness::new().await;
    let user = operator(&h);
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
        .verifying_key()
        .to_bytes();
    let params = |key: [u8; 32], fingerprint: String| json!({"source":"test-source","keyId":"test-key","publicKey":key,"publicKeySha256":fingerprint});
    let wrong = change_source(
        &h,
        &user,
        "node.sources.approveKey",
        params(key, "0".repeat(64)),
        0,
    )
    .await;
    assert_eq!(wrong.state, OperationState::Failed);
    assert_eq!(wrong.error.unwrap().code, "INTEGRITY_FAILED");
    let weak = change_source(
        &h,
        &user,
        "node.sources.approveKey",
        params([0; 32], format!("{:x}", Sha256::digest([0; 32]))),
        0,
    )
    .await;
    assert_eq!(weak.state, OperationState::Failed);
    assert_eq!(weak.error.unwrap().code, "INVALID_ARGUMENT");
    let call = h.call_as(
        &user,
        &host_target(&h),
        "node.sources.approveKey",
        params(key, format!("{:x}", Sha256::digest(key))),
    );
    assert_eq!(
        h.host.invoke(&user, call).await.unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    let empty = query(&h, &h.actor, "node.sources.list", json!({}))
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(empty).unwrap(),
        json!({"kind":"node_package_sources","value":{"revision":"0","keys":[]}})
    );
    let catalog = query(&h, &user, "catalog.list", json!({"pageSize":"100"}))
        .await
        .unwrap();
    let QueryResult::Catalog(catalog) = catalog else {
        panic!("Expected catalog")
    };
    for action in ["node.sources.approveKey", "node.sources.revokeKey"] {
        assert!(
            catalog
                .items
                .iter()
                .any(|item| item.action_id.as_str() == action)
        );
    }
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn metadata_client_can_query_the_installed_package_revision_without_starting_node() {
    let h = Harness::new().await;
    let reader = h
        .auth
        .authenticate(&id("node-package-reader"), None)
        .unwrap()
        .actor;
    let identity = h.store.identity().unwrap();
    let target = Target {
        host_id: identity.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: identity.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let result = h
        .host
        .query(
            &reader,
            Query {
                protocol_version: ProtocolVersion::V1_0,
                host_id: identity.host_id,
                instance_epoch: identity.instance_epoch,
                actor_id: reader.id().clone(),
                request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
                action_id: id("node.packages.list"),
                target,
                params: serde_json::from_value(serde_json::json!({})).unwrap(),
                reveal_target: RevealTarget {
                    page_id: id("workbench"),
                    workspace_id: None,
                    session_id: None,
                    panel_id: None,
                    result_ref: None,
                },
            },
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap(),
        serde_json::json!({
            "kind": "node_packages",
            "value": {"revision": "0", "packages": []}
        })
    );
    h.host.shutdown().await.unwrap();
}
