use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    ipc::HostServer,
    settings::SettingsService,
    storage::Store,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

struct Fixture {
    _dir: tempfile::TempDir,
    first: HostClient,
    second: HostClient,
    auth: AuthService,
    operator: AuthenticatedActor,
    store: Store,
    host: Host,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl Fixture {
    async fn new(seed_revisions: u64) -> Self {
        Self::with_document(seed_revisions, None).await
    }
    async fn with_document(seed_revisions: u64, persisted: Option<Value>) -> Self {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        let store = server.store();
        let settings = SettingsService::new(store.clone());
        for revision in 0..seed_revisions {
            settings
                .save(revision.into(), SharedSettings::default())
                .unwrap();
        }
        if let Some(persisted) = persisted {
            store
                .compare_and_swap_document(
                    &id("settings:shared"),
                    seed_revisions.into(),
                    serde_json::from_value(persisted).unwrap(),
                )
                .unwrap();
        }
        let auth = server.auth();
        let secret =
            serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
                .unwrap()
                .unwrap();
        let operator = auth
            .authenticate_user_control(
                &id("document-operator"),
                &ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap(),
            )
            .unwrap();
        let host = Host::new(store.clone(), auth.clone()).await.unwrap();
        let handler = host.clone();
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(handler), async {
                    let _ = done.await;
                })
                .await
        });
        let first = HostClient::connect(ConnectOptions::new(
            dir.path().to_path_buf(),
            id("document-a"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        let second = HostClient::connect(ConnectOptions::new(
            dir.path().to_path_buf(),
            id("document-b"),
            ClientKind::Mcp,
        ))
        .await
        .unwrap();
        Self {
            _dir: dir,
            first,
            second,
            auth,
            operator,
            store,
            host,
            stop,
            running,
        }
    }
    fn target(&self, kind: &str, name: &str) -> Target {
        Target {
            host_id: self.first.attachment().host_id.clone(),
            kind: ResourceKind::try_from(kind).unwrap(),
            id: id(name),
            session_id: None,
            session_epoch: None,
        }
    }
    fn host_target(&self) -> Target {
        self.target("host", self.first.attachment().host_id.as_str())
    }
    fn grant(&self, client: &str, permission: &str, target: &Target) {
        self.auth
            .authorize(
                &self.operator,
                AuthorizeParams {
                    client_id: id(client),
                    permissions: vec![permission.into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
    }
}
fn query(client: &HostClient, target: &Target, action: &str, params: Value) -> Query {
    let attach = client.attachment();
    Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: attach.host_id.clone(),
        instance_epoch: attach.instance_epoch,
        actor_id: attach.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id(action),
        target: target.clone(),
        params: serde_json::from_value(params).unwrap(),
        reveal_target: RevealTarget {
            page_id: id("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    }
}
fn call(
    client: &HostClient,
    target: &Target,
    action: &str,
    revision: Option<U64>,
    params: Value,
) -> Call {
    let q = query(client, target, action, params);
    Call {
        protocol_version: q.protocol_version,
        host_id: q.host_id,
        instance_epoch: q.instance_epoch,
        actor_id: q.actor_id,
        request_id: q.request_id,
        request_context: client.attachment().request_context.clone(),
        action_id: q.action_id,
        target: q.target,
        params: q.params,
        reveal_target: q.reveal_target,
        expected_revision: revision,
        lease_id: None,
        execution_mode: None,
    }
}
async fn read(client: &HostClient, target: &Target, action: &str, params: Value) -> Value {
    let reply = client
        .request(RpcRequest::Query(query(client, target, action, params)))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("query {action} failed: {reply:?}")
    };
    let RpcResult::Query(result) = *result else {
        panic!("unexpected query result: {result:?}")
    };
    serde_json::to_value(result).unwrap()["value"].clone()
}
async fn invoke(client: &HostClient, call: Call) -> Operation {
    let reply = client.request(RpcRequest::Invoke(call)).await.unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("invoke rejected: {reply:?}")
    };
    let RpcResult::Operation(operation) = *result else {
        panic!("unexpected invoke result: {result:?}")
    };
    operation.operation
}
async fn settled(client: &HostClient, target: &Target, operation: Operation) -> Operation {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let result = read(
                client,
                target,
                "operation.get",
                json!({"operationId": operation.operation_id}),
            )
            .await;
            let op: Operation = serde_json::from_value(result["operation"].clone()).unwrap();
            if !matches!(
                op.state,
                OperationState::Queued | OperationState::Running | OperationState::CancelRequested
            ) {
                return op;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}
async fn delta(client: &HostClient, subscription: &Id) -> Delta {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match client.next_event().await.unwrap().unwrap().body {
                IpcMessage::Delta {
                    subscription_id,
                    delta,
                } if &subscription_id == subscription => return *delta,
                IpcMessage::CatalogChanged { .. } => {}
                other => panic!("unexpected state event: {other:?}"),
            }
        }
    })
    .await
    .unwrap()
}

// Catches a service-only implementation and document CAS being reused as projection revision.
#[tokio::test]
async fn real_clients_receive_typed_document_scope_and_independent_projection_revision() {
    let f = Fixture::new(3).await;
    let target = f.target("settings", "shared");
    let a = read(&f.first, &target, "settings.read", json!({})).await;
    let b = read(&f.second, &target, "settings.read", json!({})).await;
    assert_eq!(a, b);
    assert_eq!(a["document"]["revision"], "3");
    assert_eq!(a["document"]["value"]["theme"], "dark");
    assert_eq!(a["scope"]["target"], serde_json::to_value(&target).unwrap());
    let snapshot = read(
        &f.second,
        &target,
        "state.snapshot",
        json!({"scopeId": a["scope"]["scopeId"]}),
    )
    .await;
    assert_eq!(snapshot["revision"], "0");
    assert_eq!(snapshot["state"], a);
    f.finish().await;
}

// Catches stale writers overwriting a winner, failed saves publishing state, and missed history between snapshot/subscribe.
#[tokio::test]
async fn two_real_actors_cas_once_and_late_subscription_replays_only_successful_save() {
    let f = Fixture::new(3).await;
    let target = f.target("settings", "shared");
    f.grant("document-a", "settings.modify", &target);
    f.grant("document-b", "settings.modify", &target);
    let initial = read(&f.first, &target, "settings.read", json!({})).await;
    let scope = initial["scope"]["scopeId"].clone();
    let snapshot = read(
        &f.second,
        &target,
        "state.snapshot",
        json!({"scopeId": scope}),
    )
    .await;
    let mut a = initial["document"]["value"].clone();
    a["theme"] = json!("light");
    let mut b = initial["document"]["value"].clone();
    b["theme"] = json!("system");
    let (a, b) = tokio::join!(
        invoke(
            &f.first,
            call(
                &f.first,
                &target,
                "settings.save",
                Some(3.into()),
                json!({"value": a})
            )
        ),
        invoke(
            &f.second,
            call(
                &f.second,
                &target,
                "settings.save",
                Some(3.into()),
                json!({"value": b})
            )
        )
    );
    let host_target = f.host_target();
    let (a, b) = tokio::join!(
        settled(&f.first, &host_target, a),
        settled(&f.second, &host_target, b)
    );
    let (winner, loser) = if a.state == OperationState::Succeeded {
        (a, b)
    } else {
        (b, a)
    };
    assert_eq!(winner.state, OperationState::Succeeded);
    assert_eq!(loser.state, OperationState::Failed);
    assert_eq!(loser.error.unwrap().code, "REVISION_CONFLICT");
    assert!(loser.result.is_none());
    let current = read(&f.second, &target, "settings.read", json!({})).await;
    assert_eq!(current["document"]["revision"], "4");
    assert_eq!(
        serde_json::to_value(winner.result.unwrap()).unwrap()["value"],
        current
    );
    let subscription = read(
        &f.second,
        &target,
        "state.subscribe",
        json!({"scopeId": scope, "after": snapshot["cursor"]}),
    )
    .await;
    let subscription: Id = serde_json::from_value(subscription["subscriptionId"].clone()).unwrap();
    let event = delta(&f.second, &subscription).await;
    assert_eq!(event.revision, U64::from(1));
    assert_eq!(
        serde_json::to_value(event.previous_cursor).unwrap(),
        snapshot["cursor"]
    );
    assert_eq!(serde_json::to_value(event.payload).unwrap(), current);
    let after = read(
        &f.second,
        &target,
        "state.snapshot",
        json!({"scopeId": scope}),
    )
    .await;
    assert_eq!(after["revision"], "1");
    assert_eq!(after["state"], current);
    f.finish().await;
}

// Catches privilege-free writes and subscriptions surviving explicit metadata revocation.
#[tokio::test]
async fn writes_require_document_permission_and_revocation_ends_real_subscription() {
    let f = Fixture::new(0).await;
    let target = f.target("workspace", "bench");
    let initial = read(&f.first, &target, "workspace.read", json!({})).await;
    let save = call(
        &f.first,
        &target,
        "workspace.save",
        Some(0.into()),
        json!({"value": initial["document"]["value"]}),
    );
    let reply = f.first.request(RpcRequest::Invoke(save)).await.unwrap();
    assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"));
    let scope = initial["scope"]["scopeId"].clone();
    let snapshot = read(
        &f.second,
        &target,
        "state.snapshot",
        json!({"scopeId": scope}),
    )
    .await;
    let subscription = read(
        &f.second,
        &target,
        "state.subscribe",
        json!({"scopeId": scope, "after": snapshot["cursor"]}),
    )
    .await;
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.second.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(3), f.second.next_event())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(event.body, IpcMessage::SubscriptionEnded { subscription_id, error } if serde_json::to_value(&subscription_id).unwrap() == subscription["subscriptionId"] && error.code == "PERMISSION_DENIED")
    );
    let reply = f
        .second
        .request(RpcRequest::Query(query(
            &f.second,
            &target,
            "workspace.read",
            json!({}),
        )))
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"));
    assert_eq!(
        read(&f.first, &target, "workspace.read", json!({})).await["document"]["revision"],
        "0"
    );
    f.finish().await;
}

// Catches duplicate revision params being accepted and CAS being silently optional.
#[tokio::test]
async fn document_save_requires_envelope_revision_and_rejects_unknown_fields_before_admission() {
    let f = Fixture::new(0).await;
    for (kind, name, permission) in [
        ("settings", "shared", "settings.modify"),
        ("workspace", "bench", "workspace.modify"),
    ] {
        let target = f.target(kind, name);
        f.grant("document-a", permission, &target);
        let value =
            read(&f.first, &target, &format!("{kind}.read"), json!({})).await["document"]["value"]
                .clone();
        for (revision, params) in [
            (None, json!({"value": value})),
            (
                Some(0.into()),
                json!({"value": value, "expectedRevision": "0"}),
            ),
        ] {
            let reply = f
                .first
                .request(RpcRequest::Invoke(call(
                    &f.first,
                    &target,
                    &format!("{kind}.save"),
                    revision,
                    params,
                )))
                .await
                .unwrap();
            assert!(
                matches!(reply, RpcReply::Failure { error, .. } if error.code == "INVALID_ARGUMENT")
            );
        }
        assert_eq!(
            read(&f.first, &target, &format!("{kind}.read"), json!({})).await["document"]["revision"],
            "0"
        );
    }
    f.finish().await;
}

// Catches import bypassing version/strict-field protection or export changing authoritative data.
#[tokio::test]
async fn import_export_roundtrip_and_invalid_imports_preserve_durable_document() {
    let f = Fixture::new(1).await;
    let target = f.target("settings", "shared");
    f.grant("document-a", "settings.modify", &target);
    let exported = read(&f.first, &target, "settings.export", json!({})).await;
    let original = f
        .store
        .read_document(&id("settings:shared"))
        .unwrap()
        .unwrap();
    let mut unknown: Value = serde_json::from_str(exported["json"].as_str().unwrap()).unwrap();
    unknown["futureField"] = json!(true);
    for (json, code) in [
        (
            "{\"formatVersion\":\"99.0\",\"value\":{}}".to_string(),
            "FUTURE_FORMAT",
        ),
        ("{".into(), "INVALID_DOCUMENT"),
        (unknown.to_string(), "INVALID_DOCUMENT"),
    ] {
        let operation = invoke(
            &f.first,
            call(
                &f.first,
                &target,
                "settings.import",
                Some(1.into()),
                json!({"json": json}),
            ),
        )
        .await;
        let result = settled(&f.first, &f.host_target(), operation).await;
        assert_eq!(result.state, OperationState::Failed);
        assert_eq!(result.error.unwrap().code, code);
        assert!(result.result.is_none());
        assert_eq!(
            f.store
                .read_document(&id("settings:shared"))
                .unwrap()
                .unwrap(),
            original
        );
    }
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &target,
            "settings.import",
            Some(1.into()),
            exported.clone(),
        ),
    )
    .await;
    assert_eq!(
        settled(&f.first, &f.host_target(), operation).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        read(&f.second, &target, "settings.export", json!({})).await,
        exported
    );
    f.finish().await;
}

// Catches wire catalog missing implemented handlers, permissions, or typed payload schemas.
#[tokio::test]
async fn live_catalog_exposes_strict_typed_document_actions_only_with_required_permissions() {
    let f = Fixture::new(0).await;
    let before = read(
        &f.first,
        &f.host_target(),
        "catalog.list",
        json!({"pageSize":"100"}),
    )
    .await;
    let before = before["items"].as_array().unwrap();
    assert!(before.iter().any(|v| v["actionId"] == "settings.read"));
    assert!(!before.iter().any(|v| v["actionId"] == "settings.save"));
    f.grant(
        "document-a",
        "settings.modify",
        &f.target("settings", "shared"),
    );
    f.grant(
        "document-a",
        "workspace.modify",
        &f.target("workspace", "bench"),
    );
    let after = read(
        &f.first,
        &f.host_target(),
        "catalog.list",
        json!({"pageSize":"100"}),
    )
    .await;
    let after = after["items"].as_array().unwrap();
    for (domain, permission) in [
        ("settings", "settings.modify"),
        ("workspace", "workspace.modify"),
    ] {
        for (verb, kind) in [
            ("read", "query"),
            ("export", "query"),
            ("save", "action"),
            ("import", "action"),
        ] {
            let name = format!("{domain}.{verb}");
            let spec = after
                .iter()
                .find(|v| v["actionId"] == name)
                .unwrap_or_else(|| panic!("missing {name}"));
            assert_eq!(spec["kind"], kind);
            assert_eq!(spec["targetKinds"], json!([domain]));
            assert_eq!(
                spec["permissions"],
                json!([if kind == "action" {
                    permission
                } else {
                    "metadata.read"
                }])
            );
            assert_eq!(spec["inputSchema"]["additionalProperties"], false);
            assert_eq!(spec["outputSchema"]["additionalProperties"], false);
            let properties = spec["outputSchema"]["properties"].as_object().unwrap();
            assert!(properties.contains_key(if verb == "export" { "json" } else { "document" }));
        }
    }
    f.finish().await;
}

// Catches workspace calls accidentally sharing one storage key or returning only an accepted operation.
#[tokio::test]
async fn workspace_save_is_shared_between_actors_but_independent_between_workspaces() {
    let f = Fixture::new(0).await;
    let bench = f.target("workspace", "bench");
    let other = f.target("workspace", "other");
    f.grant("document-a", "workspace.modify", &bench);
    let before = read(&f.first, &bench, "workspace.read", json!({})).await;
    let mut value = before["document"]["value"].clone();
    value["name"] = json!("UART bench");
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &bench,
            "workspace.save",
            Some(0.into()),
            json!({"value": value}),
        ),
    )
    .await;
    let operation = settled(&f.first, &f.host_target(), operation).await;
    assert_eq!(operation.state, OperationState::Succeeded);
    let shared = read(&f.second, &bench, "workspace.read", json!({})).await;
    assert_eq!(shared["document"]["value"]["name"], "UART bench");
    assert_eq!(shared["document"]["revision"], "1");
    assert_eq!(
        serde_json::to_value(operation.result.unwrap()).unwrap()["value"],
        shared
    );
    assert_eq!(
        shared["scope"]["target"],
        serde_json::to_value(&bench).unwrap()
    );
    let independent = read(&f.second, &other, "workspace.read", json!({})).await;
    assert_eq!(independent["document"]["revision"], "0");
    assert_eq!(independent["document"]["value"]["name"], "");
    assert_ne!(independent["scope"]["scopeId"], shared["scope"]["scopeId"]);
    let exported = read(&f.second, &bench, "workspace.export", json!({})).await;
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &bench,
            "workspace.import",
            Some(1.into()),
            exported.clone(),
        ),
    )
    .await;
    assert_eq!(
        settled(&f.first, &f.host_target(), operation).await.state,
        OperationState::Succeeded
    );
    assert_eq!(
        read(&f.second, &bench, "workspace.export", json!({})).await,
        exported
    );
    let snapshot = read(
        &f.first,
        &bench,
        "state.snapshot",
        json!({"scopeId": shared["scope"]["scopeId"]}),
    )
    .await;
    assert_eq!(snapshot["revision"], "2");
    assert_eq!(snapshot["state"]["document"]["revision"], "2");
    f.finish().await;
}

// Catches eager document decoding preventing Host startup and saves overwriting unreadable originals.
#[tokio::test]
async fn future_and_corrupt_persisted_documents_keep_host_available_and_original_intact() {
    for (document, code) in [
        (
            json!({"formatVersion":"99.0","value":{"future":true}}),
            "FUTURE_FORMAT",
        ),
        (
            json!({"formatVersion":"0.1","value":{"theme":"unrecognized"}}),
            "INVALID_DOCUMENT",
        ),
    ] {
        let f = Fixture::with_document(0, Some(document)).await;
        let target = f.target("settings", "shared");
        f.grant("document-a", "settings.modify", &target);
        let original = f
            .store
            .read_document(&id("settings:shared"))
            .unwrap()
            .unwrap();
        let reply = f
            .first
            .request(RpcRequest::Query(query(
                &f.first,
                &target,
                "settings.read",
                json!({}),
            )))
            .await
            .unwrap();
        assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == code));
        let operation = invoke(
            &f.first,
            call(
                &f.first,
                &target,
                "settings.save",
                Some(1.into()),
                json!({"value": SharedSettings::default()}),
            ),
        )
        .await;
        let operation = settled(&f.first, &f.host_target(), operation).await;
        assert_eq!(operation.state, OperationState::Failed);
        assert_eq!(operation.error.unwrap().code, code);
        assert!(operation.result.is_none());
        assert_eq!(
            f.store
                .read_document(&id("settings:shared"))
                .unwrap()
                .unwrap(),
            original
        );
        assert!(
            read(
                &f.second,
                &f.host_target(),
                "catalog.list",
                json!({"pageSize":"100"})
            )
            .await["items"]
                .is_array()
        );
        f.finish().await;
    }
}

// Catches scope metadata leaking hidden targets or inventing a session epoch from a scope string.
#[tokio::test]
async fn scope_metadata_is_authorized_and_returns_registered_target_epoch() {
    let f = Fixture::new(0).await;
    let workspace = f.target("workspace", "scope-workspace");
    let document = read(&f.first, &workspace, "workspace.read", json!({})).await;
    let mut session = f.target("session", "scope-session");
    session.session_id = Some(session.id.clone());
    session.session_epoch = Some(7.into());
    f.host
        .projections()
        .register_scope(
            id("session:scope-session"),
            session.clone(),
            "content.read".into(),
            JsonObject::new(),
        )
        .unwrap();
    let visible = read(&f.first, &f.host_target(), "state.scopes", json!({})).await;
    let scopes = visible["scopes"].as_array().unwrap();
    assert!(scopes.iter().any(|v| v == &document["scope"]));
    assert!(
        !scopes
            .iter()
            .any(|v| v["scopeId"] == "session:scope-session")
    );
    f.grant("document-a", "content.read", &session);
    let visible = read(&f.first, &f.host_target(), "state.scopes", json!({})).await;
    assert!(
        visible["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["scopeId"] == "session:scope-session"
                && v["target"] == serde_json::to_value(&session).unwrap())
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.first.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![workspace],
            },
        )
        .unwrap();
    let visible = read(&f.first, &f.host_target(), "state.scopes", json!({})).await;
    assert!(
        !visible["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == &document["scope"])
    );
    f.finish().await;
}

// Catches state.snapshot/subscribe accepting a caller's stale target while authorizing the newer internal scope.
#[tokio::test]
async fn state_calls_reject_stale_registered_session_target_epoch() {
    let f = Fixture::new(0).await;
    let mut target = f.target("session", "epoch-session");
    target.session_id = Some(target.id.clone());
    target.session_epoch = Some(2.into());
    f.host
        .projections()
        .register_scope(
            id("session:epoch-session"),
            target.clone(),
            "metadata.read".into(),
            JsonObject::new(),
        )
        .unwrap();
    let snapshot = read(
        &f.first,
        &target,
        "state.snapshot",
        json!({"scopeId":"session:epoch-session"}),
    )
    .await;
    target.session_epoch = Some(1.into());
    for (action, params) in [
        ("state.snapshot", json!({"scopeId":"session:epoch-session"})),
        (
            "state.subscribe",
            json!({"scopeId":"session:epoch-session", "after":snapshot["cursor"]}),
        ),
    ] {
        let reply = f
            .first
            .request(RpcRequest::Query(query(&f.first, &target, action, params)))
            .await
            .unwrap();
        assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "EPOCH_MISMATCH"));
    }
    f.finish().await;
}

// Catches a persisted operation being reported successful when the document's actual SQLite CAS fails.
#[tokio::test]
async fn storage_failure_never_returns_success_or_advances_document_projection() {
    let f = Fixture::new(1).await;
    let target = f.target("settings", "shared");
    f.grant("document-a", "settings.modify", &target);
    let before = read(&f.first, &target, "settings.read", json!({})).await;
    let scope = before["scope"]["scopeId"].clone();
    let snapshot = read(
        &f.second,
        &target,
        "state.snapshot",
        json!({"scopeId":scope}),
    )
    .await;
    let database = rusqlite::Connection::open(f._dir.path().join("host-v0/state.sqlite3")).unwrap();
    database.execute_batch("CREATE TRIGGER reject_settings BEFORE UPDATE ON documents WHEN NEW.id='settings:shared' BEGIN SELECT RAISE(ABORT, 'injected document failure'); END;").unwrap();
    let mut value = before["document"]["value"].clone();
    value["theme"] = json!("light");
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &target,
            "settings.save",
            Some(1.into()),
            json!({"value":value}),
        ),
    )
    .await;
    let operation = settled(&f.first, &f.host_target(), operation).await;
    assert_eq!(operation.state, OperationState::Failed);
    assert_eq!(operation.error.unwrap().code, "STORAGE_UNAVAILABLE");
    assert!(operation.result.is_none());
    assert_eq!(
        read(&f.second, &target, "settings.read", json!({})).await,
        before
    );
    assert_eq!(
        read(
            &f.second,
            &target,
            "state.snapshot",
            json!({"scopeId":scope})
        )
        .await,
        snapshot
    );
    f.finish().await;
}

// Catches settings aliases accidentally accessing the shared document under a different authorization target.
#[tokio::test]
async fn settings_rejects_unregistered_alias_target() {
    let f = Fixture::new(0).await;
    let alias = f.target("settings", "other");
    f.grant("document-a", "settings.modify", &alias);
    let reply = f
        .first
        .request(RpcRequest::Query(query(
            &f.first,
            &alias,
            "settings.read",
            json!({}),
        )))
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "INVALID_ARGUMENT"));
    let reply = f
        .first
        .request(RpcRequest::Invoke(call(
            &f.first,
            &alias,
            "settings.save",
            Some(0.into()),
            json!({"value":SharedSettings::default()}),
        )))
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "INVALID_ARGUMENT"));
    assert!(
        f.store
            .read_document(&id("settings:shared"))
            .unwrap()
            .is_none()
    );
    f.finish().await;
}

// 文档落盘后的终态持久化失败仍须留下可恢复回执，不能只剩无法判定的 Running。
#[tokio::test]
async fn saved_document_evidence_survives_operation_terminal_write_failure() {
    let f = Fixture::new(1).await;
    let target = f.target("settings", "shared");
    f.grant("document-a", "settings.modify", &target);
    let before = read(&f.first, &target, "settings.read", json!({})).await;
    let database = rusqlite::Connection::open(f._dir.path().join("host-v0/state.sqlite3")).unwrap();
    database.execute_batch("CREATE TRIGGER reject_document_terminal BEFORE UPDATE ON operations WHEN NEW.terminal=1 AND json_extract(NEW.operation_json,'$.actionId')='settings.save' BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;").unwrap();
    let mut value = before["document"]["value"].clone();
    value["theme"] = json!("light");
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &target,
            "settings.save",
            Some(1.into()),
            json!({"value":value}),
        ),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while SettingsService::new(f.store.clone())
            .read()
            .unwrap()
            .revision
            != U64::from(2)
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    // shutdown 等待已经接纳的真实任务退出，作为 terminal UPDATE 已尝试的屏障。
    let error = f.host.shutdown().await.unwrap_err();
    assert_eq!(error.code, "SHUTDOWN_INCOMPLETE");
    let report: ShutdownReport =
        serde_json::from_value(serde_json::to_value(error.details.unwrap()).unwrap()).unwrap();
    let persisted = f.store.get(&f.operator, &operation.operation_id).unwrap();
    assert_eq!(persisted.state, OperationState::Running);
    assert_eq!(persisted.operation_id, operation.operation_id);
    assert_eq!(persisted.execution_host_id, operation.execution_host_id);
    assert_eq!(persisted.actor_id, operation.actor_id);
    assert_eq!(persisted.request_id, operation.request_id);
    assert_eq!(persisted.action_id.as_str(), "settings.save");
    assert_eq!(persisted.target, target);
    assert_eq!(
        report,
        ShutdownReport {
            mode: ShutdownMode::CancelAndSettle,
            completed: false,
            excluded_operation_id: None,
            unsettled_operation_ids: vec![operation.operation_id.clone()],
            quarantined_sessions: vec![],
            evidence_refs: vec![ObjectRef {
                host_id: persisted.execution_host_id.clone(),
                kind: ResourceKind::try_from("operation").unwrap(),
                id: persisted.operation_id.clone(),
                revision: Some(persisted.revision),
            }],
            failures: vec![],
        }
    );
    let evidence = serde_json::to_value(
        persisted
            .result
            .as_ref()
            .expect("saved document receipt must be persisted before terminal settlement"),
    )
    .unwrap();
    assert_eq!(evidence["value"]["document"]["revision"], "2");
    assert_eq!(evidence["value"]["document"]["value"]["theme"], "light");
    let saved = SettingsService::new(f.store.clone()).read().unwrap();
    assert_eq!(saved.revision, U64::from(2));
    assert_eq!(saved.value.theme, Theme::Light);
    assert_eq!(
        f.store.get(&f.operator, &operation.operation_id).unwrap(),
        persisted,
        "the settled barrier must not redispatch the failed terminal write"
    );
    database
        .execute_batch("DROP TRIGGER reject_document_terminal;")
        .unwrap();
    let recovered = f.store.recover().unwrap();
    let recovered = recovered
        .iter()
        .find(|candidate| candidate.operation_id == operation.operation_id)
        .unwrap();
    assert_eq!(recovered.state, OperationState::Unknown);
    assert_eq!(
        serde_json::to_value(recovered.result.as_ref().unwrap()).unwrap(),
        evidence
    );
    f.finish().await;
}

// 查询活动定位到实际目标工作区，不能沿用当前客户端恰好打开的工作区。
#[tokio::test]
async fn workspace_read_reveal_targets_requested_workspace() {
    let f = Fixture::new(0).await;
    let target = f.target("workspace", "reveal-workspace");
    read(&f.first, &target, "workspace.read", json!({})).await;
    let snapshot = read(
        &f.first,
        &f.host_target(),
        "state.snapshot",
        json!({"scopeId":"host.activity"}),
    )
    .await;
    let activity = snapshot["state"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["actionId"] == "workspace.read")
        .unwrap();
    assert_eq!(activity["revealTarget"]["pageId"], "workbench");
    assert_eq!(activity["revealTarget"]["workspaceId"], "reveal-workspace");
    f.finish().await;
}

// 持久操作回执定位到保存的工作区，与调用者自报的reveal位置无关。
#[tokio::test]
async fn workspace_save_reveal_targets_requested_workspace() {
    let f = Fixture::new(0).await;
    let target = f.target("workspace", "reveal-workspace");
    f.grant("document-a", "workspace.modify", &target);
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &target,
            "workspace.save",
            Some(0.into()),
            json!({"value":WorkspaceDocument::default()}),
        ),
    )
    .await;
    let operation = settled(&f.first, &f.host_target(), operation).await;
    assert_eq!(operation.state, OperationState::Succeeded);
    assert_eq!(operation.reveal_target.page_id, id("workbench"));
    assert_eq!(
        operation.reveal_target.workspace_id,
        Some(id("reveal-workspace"))
    );
    f.finish().await;
}

fn preview_document(name: &str) -> WorkspaceDocument {
    WorkspaceDocument {
        name: name.into(),
        ..WorkspaceDocument::default()
    }
}
fn preview_json(value: &WorkspaceDocument) -> String {
    json!({"formatVersion":"0.1","value":value}).to_string()
}

// 完成的预览查询只能返回候选，不写文档或扩大授权。
#[tokio::test]
async fn workspace_import_preview_validates_without_writing_or_granting() {
    let f = Fixture::new(0).await;
    let target = f.target("workspace", "preview");
    let original = read(&f.first, &target, "workspace.read", json!({})).await;
    let revision = f.auth.current_revision().unwrap();
    let stored = f.store.read_document(&id("workspace:preview")).unwrap();
    let value = preview_document("Imported workspace");
    let request = query(
        &f.first,
        &target,
        "workspace.importPreview",
        json!({"json":preview_json(&value)}),
    );
    let reply = f.first.request(RpcRequest::Query(request)).await.unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("preview failed: {reply:?}")
    };
    assert!(
        matches!(*result, RpcResult::Query(QueryResult::WorkspaceImportPreview(ref preview)) if preview == &value)
    );
    assert_eq!(
        read(&f.first, &target, "workspace.read", json!({})).await,
        original
    );
    assert_eq!(
        f.store.read_document(&id("workspace:preview")).unwrap(),
        stored
    );
    assert_eq!(f.auth.current_revision().unwrap(), revision);
    let reply = f
        .first
        .request(RpcRequest::Invoke(call(
            &f.first,
            &target,
            "workspace.save",
            Some(0.into()),
            json!({"value":value}),
        )))
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"));
    f.finish().await;
}

// Catches bypassed version checks and references that deserialize but violate workspace invariants.
#[tokio::test]
async fn workspace_import_preview_rejects_future_or_invalid_references() {
    let f = Fixture::new(0).await;
    let target = f.target("workspace", "invalid-preview");
    let revision = f.auth.current_revision().unwrap();
    let original = read(&f.first, &target, "workspace.read", json!({})).await;
    let binding = DeviceBinding {
        binding_id: id("binding"),
        host_id: target.host_id.clone(),
        device_id: id("virtual:echo"),
        fingerprint: DeviceFingerprint {
            transport: DeviceTransportKind::Virtual,
            vid: None,
            pid: None,
            serial_number: None,
            topology_path: None,
            evidence: IdentityEvidence::Unreliable,
        },
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy::default(),
    };
    let view = WorkspaceView {
        id: id("duplicate"),
        name: "View".into(),
        color: "".into(),
        icon: "terminal".into(),
        pinned: false,
        receive_mode: TerminalMode::Text,
        send_mode: TerminalMode::Text,
        binding_id: id("binding"),
    };
    let mut dangling = preview_document("Dangling");
    dangling.views.push(view.clone());
    let mut duplicate = preview_document("Duplicate views");
    duplicate.bindings.push(binding.clone());
    duplicate.views = vec![view.clone(), view];
    let mut duplicate_binding = preview_document("Duplicate bindings");
    duplicate_binding.bindings = vec![binding.clone(), binding];
    let mut favorite = preview_document("Favorite");
    favorite.favorite_binding_ids.push(id("missing"));
    for (json, code) in [
        ("{".to_owned(), "INVALID_DOCUMENT"),
        (
            "{\"formatVersion\":\"99.0\",\"value\":{}}".into(),
            "FUTURE_FORMAT",
        ),
        (preview_json(&dangling), "INVALID_ARGUMENT"),
        (preview_json(&duplicate), "INVALID_ARGUMENT"),
        (preview_json(&duplicate_binding), "INVALID_ARGUMENT"),
        (preview_json(&favorite), "INVALID_ARGUMENT"),
    ] {
        let reply = f
            .first
            .request(RpcRequest::Query(query(
                &f.first,
                &target,
                "workspace.importPreview",
                json!({"json":json}),
            )))
            .await
            .unwrap();
        assert!(
            matches!(&reply, RpcReply::Failure { error, .. } if error.code == code),
            "{reply:?}"
        );
        assert_eq!(f.auth.current_revision().unwrap(), revision);
        assert_eq!(
            read(&f.first, &target, "workspace.read", json!({})).await,
            original
        );
    }
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.first.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    let reply = f
        .first
        .request(RpcRequest::Query(query(
            &f.first,
            &target,
            "workspace.importPreview",
            json!({"json":preview_json(&preview_document("Hidden"))}),
        )))
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"));
    f.finish().await;
}
