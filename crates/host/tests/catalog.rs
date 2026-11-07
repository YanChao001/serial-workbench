use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    registry::Registry,
    storage::Store,
};

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Fixture {
    _dir: tempfile::TempDir,
    store: Store,
    auth: AuthService,
    actor: AuthenticatedActor,
    operator: AuthenticatedActor,
    target: Target,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let identity = store.begin_instance().unwrap();
        let secret = ContextToken::try_from("test-operator-secret").unwrap();
        let auth = AuthService::new(store.clone(), secret.clone());
        let actor = auth.authenticate(&id("client"), None).unwrap().actor;
        let operator = auth
            .authenticate_user_control(&id("operator"), &secret)
            .unwrap();
        let target = Target {
            id: identity.host_id.clone(),
            host_id: identity.host_id,
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        Self {
            _dir: dir,
            store,
            auth,
            actor,
            operator,
            target,
        }
    }
    fn query(&self, action: &str, params: serde_json::Value) -> Query {
        Query {
            protocol_version: ProtocolVersion::V0_1,
            host_id: self.target.host_id.clone(),
            instance_epoch: self.store.identity().unwrap().instance_epoch,
            actor_id: self.actor.id().clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            action_id: id(action),
            target: self.target.clone(),
            params: serde_json::from_value(params).unwrap(),
            reveal_target: RevealTarget {
                page_id: id("workbench"),
                panel_id: None,
                session_id: None,
                workspace_id: None,
                result_ref: None,
            },
        }
    }
    fn call(&self, actor: &AuthenticatedActor, action: &str, params: serde_json::Value) -> Call {
        let q = self.query(action, params);
        Call {
            protocol_version: q.protocol_version,
            host_id: q.host_id,
            instance_epoch: q.instance_epoch,
            actor_id: actor.id().clone(),
            request_id: q.request_id,
            request_context: self.store.issue_context(actor).unwrap().token,
            action_id: q.action_id,
            target: q.target,
            params: q.params,
            reveal_target: q.reveal_target,
            expected_revision: None,
            lease_id: None,
            execution_mode: None,
        }
    }
}
fn page(size: u64, token: Option<String>) -> CatalogListParams {
    CatalogListParams {
        page_size: size.into(),
        page_token: token,
        catalog_version: None,
    }
}

#[test]
fn catalog_exposes_only_real_authorized_handlers_and_sorted_pages() {
    let f = Fixture::new();
    let registry = Registry::new(f.store.clone(), f.auth.clone()).unwrap();
    let ordinary = registry.list(&f.actor, page(100, None)).unwrap();
    assert!(!ordinary.items.is_empty());
    assert!(
        ordinary
            .items
            .windows(2)
            .all(|pair| pair[0].action_id.as_str() < pair[1].action_id.as_str())
    );
    assert!(
        ordinary
            .items
            .iter()
            .all(|item| item.reveal_target.page_id.as_str() == "workbench")
    );
    assert!(
        !ordinary
            .items
            .iter()
            .any(|item| item.action_id.as_str() == "auth.authorize"
                || item.action_id.as_str() == "session.tx")
    );
    assert!(
        registry
            .list(&f.operator, page(100, None))
            .unwrap()
            .items
            .iter()
            .any(|item| item.action_id.as_str() == "auth.authorize")
    );
}
#[test]
fn changing_actor_grants_invalidates_old_page_but_other_actor_does_not() {
    let f = Fixture::new();
    let registry = Registry::new(f.store.clone(), f.auth.clone()).unwrap();
    let first = registry.list(&f.actor, page(1, None)).unwrap();
    f.auth.authenticate(&id("unrelated"), None).unwrap();
    assert!(
        registry
            .list(&f.actor, page(1, first.next_page_token.clone()))
            .is_ok()
    );
    f.auth
        .authorize(
            &f.operator,
            AuthorizeParams {
                client_id: f.actor.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    assert_eq!(
        registry
            .list(&f.actor, page(1, first.next_page_token))
            .unwrap_err()
            .code,
        "CATALOG_CHANGED"
    );
}
#[tokio::test]
async fn query_polling_reuses_activity_and_rejects_target_identity_mismatch() {
    let f = Fixture::new();
    let host = Host::new(f.store.clone(), f.auth.clone()).await.unwrap();
    let q = f.query("catalog.list", serde_json::json!({"pageSize":"100"}));
    host.query(&f.actor, q.clone()).await.unwrap();
    host.query(&f.actor, q.clone()).await.unwrap();
    assert_eq!(host.activity_count(), 1);
    let mut bad = q;
    bad.target.id = id("other-host");
    assert_eq!(
        host.query(&f.actor, bad).await.unwrap_err().code,
        "INVALID_ARGUMENT"
    );
}
#[tokio::test]
async fn known_action_cannot_bypass_permission_or_kind_through_generic_entry() {
    let f = Fixture::new();
    let host = Host::new(f.store.clone(), f.auth.clone()).await.unwrap();
    let call=f.call(&f.actor,"auth.authorize",serde_json::json!({"clientId":"client","permissions":["content.read"],"targets":[f.target]}));
    assert_eq!(
        host.invoke(&f.actor, call).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    let q = f.query("auth.authorize", serde_json::json!({}));
    assert_eq!(
        host.query(&f.actor, q).await.unwrap_err().code,
        "INVALID_ARGUMENT"
    );
}

#[test]
fn catalog_version_is_durable_and_changes_only_with_registered_contract() {
    let f = Fixture::new();
    let before = f.store.identity().unwrap().catalog_version;
    Registry::new(f.store.clone(), f.auth.clone()).unwrap();
    let first = f.store.identity().unwrap().catalog_version;
    assert!(first > before);
    Registry::new(f.store.clone(), f.auth.clone()).unwrap();
    assert_eq!(f.store.identity().unwrap().catalog_version, first);
    let changed =
        Digest::try_from("1111111111111111111111111111111111111111111111111111111111111111")
            .unwrap();
    assert_eq!(
        f.store.synchronize_catalog(&changed).unwrap(),
        first.checked_next().unwrap()
    );
    // 同profile独立读取直接核对持久行，不以缓存值当持久证据。
    let db = rusqlite::Connection::open(f._dir.path().join("host-v0/state.sqlite3")).unwrap();
    let persisted: String = db
        .query_row("SELECT catalog_version FROM host_identity", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(persisted, first.checked_next().unwrap().to_string());
}
#[test]
fn queued_cancel_is_terminal_and_prevents_dispatch_and_selectors_reuse_record() {
    use serial_workbench_host::storage::{Acceptance, canonical_digest};
    let f = Fixture::new();
    let call = f.call(&f.actor, "device.future", serde_json::json!({}));
    let Acceptance::New(operation) = f
        .store
        .accept(&f.actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!()
    };
    let cancelled = f
        .store
        .request_cancel(&f.actor, &operation.operation_id)
        .unwrap();
    assert_eq!(cancelled.state, OperationState::Cancelled);
    assert!(cancelled.result_expires_at.is_some());
    assert_eq!(
        f.store
            .mark_dispatch(&operation.operation_id)
            .unwrap_err()
            .code,
        "OPERATION_NOT_RUNNING"
    );
    assert_eq!(
        f.store
            .request_cancel(&f.actor, &operation.operation_id)
            .unwrap(),
        cancelled
    );
    let selector = OperationGetParams::ByRequest {
        actor_id: f.actor.id().clone(),
        request_id: call.request_id,
        request_context: call.request_context,
    };
    assert_eq!(
        f.store.get_selected(&f.actor, &selector).unwrap(),
        cancelled
    );
}
#[test]
fn resource_grant_discovery_preserves_kind_and_explicit_revoke() {
    let f = Fixture::new();
    let target = Target {
        host_id: f.target.host_id.clone(),
        id: id("session-a"),
        kind: ResourceKind::try_from("session").unwrap(),
        session_id: Some(id("session-a")),
        session_epoch: Some(1.into()),
    };
    f.auth
        .authorize(
            &f.operator,
            AuthorizeParams {
                client_id: f.actor.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    assert!(
        f.auth
            .can_discover(&f.actor, "content.read", std::slice::from_ref(&target.kind))
            .unwrap()
    );
    assert!(
        !f.auth
            .can_discover(
                &f.actor,
                "content.read",
                &[ResourceKind::try_from("file").unwrap()]
            )
            .unwrap()
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.actor.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    assert!(
        !f.auth
            .can_discover(&f.actor, "content.read", &[target.kind])
            .unwrap()
    );
}
#[tokio::test]
async fn query_activity_memory_is_bounded_and_does_not_store_inputs() {
    let f = Fixture::new();
    let host = Host::new(f.store.clone(), f.auth.clone()).await.unwrap();
    for _ in 0..1030 {
        host.query(
            &f.actor,
            f.query("catalog.list", serde_json::json!({"pageSize":"100"})),
        )
        .await
        .unwrap();
    }
    assert_eq!(host.activity_count(), 1024);
    let snapshot = host
        .projections()
        .snapshot(&f.actor, &id("host.activity"))
        .await
        .unwrap();
    let value = serde_json::to_value(snapshot.state).unwrap();
    assert!(
        value["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.get("params").is_none() && item.get("requestContext").is_none())
    );
}
