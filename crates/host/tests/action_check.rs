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
                &id("document-a"),
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

fn operation_count(f: &Fixture) -> i64 {
    let database = rusqlite::Connection::open(f._dir.path().join("host-v0/state.sqlite3")).unwrap();
    database
        .query_row("SELECT COUNT(*) FROM operations", [], |row| row.get(0))
        .unwrap()
}
fn revoke(f: &Fixture, permission: &str, target: &Target) {
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.first.attachment().actor_id.clone(),
                permissions: vec![permission.into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
}
async fn checked(f: &Fixture, target: &Target, action: &str, params: Value) -> bool {
    let before = (
        f.auth.current_revision().unwrap(),
        operation_count(f),
        f.host.files().file_read_bytes(),
        f.host.activity_count(),
    );
    let reply = f
        .first
        .request(RpcRequest::Query(query(
            &f.first,
            target,
            "action.check",
            json!({"actionId":action,"params":params}),
        )))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("check failed: {reply:?}")
    };
    let RpcResult::Query(QueryResult::ActionCheck(result)) = *result else {
        panic!("typed check reply: {result:?}")
    };
    assert_eq!(result.action_id, id(action));
    assert_eq!(&result.target, target);
    assert_eq!(
        (
            f.auth.current_revision().unwrap(),
            operation_count(f),
            f.host.files().file_read_bytes(),
            f.host.activity_count()
        ),
        before
    );
    let wire = serde_json::to_value(&result).unwrap();
    assert_eq!(
        wire.as_object().unwrap().len(),
        3,
        "no actor, rules, token or body in result"
    );
    result.allowed
}
fn denied(reply: RpcReply) {
    assert!(
        matches!(&reply, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"),
        "{reply:?}"
    );
}

// Catches catalog-wide discovery being substituted for current actor + full target authority.
#[tokio::test]
async fn checks_current_target_without_changing_grants() {
    let f = Fixture::new(0).await;
    let a = f.target("workspace", "allowed");
    let b = f.target("workspace", "denied");
    f.grant("document-a", "workspace.modify", &f.host_target());
    revoke(&f, "workspace.modify", &b);
    let params = json!({"value":WorkspaceDocument::default()});
    assert!(checked(&f, &a, "workspace.save", params.clone()).await);
    assert!(!checked(&f, &b, "workspace.save", params.clone()).await);
    let allowed = invoke(
        &f.first,
        call(
            &f.first,
            &a,
            "workspace.save",
            Some(0.into()),
            params.clone(),
        ),
    )
    .await;
    assert_eq!(
        settled(&f.first, &f.host_target(), allowed).await.state,
        OperationState::Succeeded
    );
    denied(
        f.first
            .request(RpcRequest::Invoke(call(
                &f.first,
                &b,
                "workspace.save",
                Some(0.into()),
                params,
            )))
            .await
            .unwrap(),
    );
    let other = f
        .second
        .request(RpcRequest::Query(query(
            &f.second,
            &a,
            "action.check",
            json!({"actionId":"workspace.save","params":{"value":WorkspaceDocument::default()}}),
        )))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = other else {
        panic!("{other:?}")
    };
    assert!(matches!(
        *result,
        RpcResult::Query(QueryResult::ActionCheck(ActionCheckResult {
            allowed: false,
            ..
        }))
    ));
    for (params, code) in [
        (
            json!({"actionId":"action.check","params":{}}),
            "INVALID_ARGUMENT",
        ),
        (
            json!({"actionId":"workspace.save","params":{},"actorId":f.operator.id()}),
            "INVALID_ARGUMENT",
        ),
        (
            json!({"actionId":"device.open","params":{}}),
            "INVALID_ARGUMENT",
        ),
    ] {
        let reply = f
            .first
            .request(RpcRequest::Query(query(
                &f.first,
                &a,
                "action.check",
                params,
            )))
            .await
            .unwrap();
        assert!(
            matches!(&reply, RpcReply::Failure { error, .. } if error.code == code),
            "{reply:?}"
        );
    }
    let mut forged = query(
        &f.first,
        &a,
        "action.check",
        json!({"actionId":"workspace.save","params":{}}),
    );
    forged.actor_id = f.second.attachment().actor_id.clone();
    let reply = f.first.request(RpcRequest::Query(forged)).await.unwrap();
    assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "ACTOR_MISMATCH"));
    f.finish().await;
}

// Catches checking lookup resources while ignoring file, capture, transfer and retained operation sources.
#[tokio::test]
async fn compound_checks_match_real_source_authorization() {
    let f = Fixture::new(0).await;
    let device = f.target("device", "virtual:echo");
    f.grant("document-a", "device.modify", &device);
    let opened = invoke(
        &f.first,
        call(
            &f.first,
            &device,
            "device.open",
            None,
            json!({"configuration":SerialConfiguration::default()}),
        ),
    )
    .await;
    let opened = settled(&f.first, &f.host_target(), opened).await;
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("{opened:?}")
    };
    let session = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..device
    };
    f.grant("document-a", "device.modify", &session);
    f.grant("document-a", "content.read", &session);
    let path = f._dir.path().join("check-source.bin");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    let reference = f
        .host
        .files()
        .register(
            RegisterFileParams {
                path: path.to_str().unwrap().into(),
                purpose: FilePurpose::ReadFile,
            },
            &f.operator,
        )
        .unwrap();
    let source = f.target(reference.kind.as_str(), reference.id.as_str());
    f.grant("document-a", "content.read", &source);
    let transfer = json!({"sourceRef":reference,"offset":"0","length":"3","chunkBytes":"3","bytesPerSecond":"1000000","interChunkMs":"0","writeWaitMs":"1000"});
    assert!(checked(&f, &session, "transfer.file", transfer.clone()).await);
    assert!(checked(&f, &source, "file.metadata", json!({"fileRef":reference})).await);
    read(
        &f.first,
        &source,
        "file.metadata",
        json!({"fileRef":reference}),
    )
    .await;
    revoke(&f, "content.read", &source);
    assert!(!checked(&f, &session, "transfer.file", transfer.clone()).await);
    denied(
        f.first
            .request(RpcRequest::Invoke(call(
                &f.first,
                &session,
                "transfer.file",
                None,
                transfer,
            )))
            .await
            .unwrap(),
    );
    revoke(&f, "metadata.read", &source);
    assert!(!checked(&f, &source, "file.metadata", json!({"fileRef":reference})).await);
    denied(
        f.first
            .request(RpcRequest::Query(query(
                &f.first,
                &source,
                "file.metadata",
                json!({"fileRef":reference}),
            )))
            .await
            .unwrap(),
    );
    let capture_path = f._dir.path().join("check-capture");
    let destination = f
        .host
        .files()
        .register(
            RegisterFileParams {
                path: capture_path.to_str().unwrap().into(),
                purpose: FilePurpose::CaptureTarget,
            },
            &f.operator,
        )
        .unwrap();
    let capture_target = f.target(destination.kind.as_str(), destination.id.as_str());
    f.grant("document-a", "workspace.modify", &capture_target);
    let capture = json!({"sessionRefs":[session],"targetRef":destination,"overflowPolicy":"stop"});
    assert!(checked(&f, &capture_target, "capture.start", capture.clone()).await);
    revoke(&f, "content.read", &session);
    assert!(!checked(&f, &capture_target, "capture.start", capture.clone()).await);
    let mut request = call(&f.first, &capture_target, "capture.start", None, capture);
    request.execution_mode = Some(ExecutionMode::Independent);
    denied(f.first.request(RpcRequest::Invoke(request)).await.unwrap());
    assert!(!capture_path.exists(), "check must not start capture");
    assert_eq!(std::fs::read(&path).unwrap(), [1, 2, 3]);
    let workspace = f.target("workspace", "operation-source");
    f.grant("document-a", "workspace.modify", &workspace);
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &workspace,
            "workspace.save",
            Some(0.into()),
            json!({"value":WorkspaceDocument::default()}),
        ),
    )
    .await;
    let operation = settled(&f.first, &f.host_target(), operation).await;
    let params = json!({"operationId":operation.operation_id});
    assert!(checked(&f, &f.host_target(), "operation.get", params.clone()).await);
    revoke(&f, "metadata.read", &workspace);
    assert!(!checked(&f, &f.host_target(), "operation.get", params.clone()).await);
    denied(
        f.first
            .request(RpcRequest::Query(query(
                &f.first,
                &f.host_target(),
                "operation.get",
                params,
            )))
            .await
            .unwrap(),
    );
    f.finish().await;
}

// Catches treating check as a grant/token and skipping authorization at actual admission.
#[tokio::test]
async fn revocation_after_check_still_blocks_invoke() {
    let f = Fixture::new(0).await;
    let target = f.target("workspace", "revoked-after-check");
    f.grant("document-a", "workspace.modify", &target);
    let params = json!({"value":WorkspaceDocument::default()});
    assert!(checked(&f, &target, "workspace.save", params.clone()).await);
    revoke(&f, "workspace.modify", &target);
    let before = operation_count(&f);
    denied(
        f.first
            .request(RpcRequest::Invoke(call(
                &f.first,
                &target,
                "workspace.save",
                Some(0.into()),
                params,
            )))
            .await
            .unwrap(),
    );
    assert_eq!(operation_count(&f), before);
    assert!(
        f.store
            .read_document(&id("workspace:revoked-after-check"))
            .unwrap()
            .is_none()
    );
    f.finish().await;
}

fn check_observations(f: &Fixture) -> (U64, i64, u64, usize) {
    (
        f.auth.current_revision().unwrap(),
        operation_count(f),
        f.host.files().file_read_bytes(),
        f.host.activity_count(),
    )
}
async fn check_error(f: &Fixture, target: &Target, action: &str, params: Value, code: &str) {
    let before = check_observations(f);
    let reply = f
        .first
        .request(RpcRequest::Query(query(
            &f.first,
            target,
            "action.check",
            json!({"actionId":action,"params":params}),
        )))
        .await
        .unwrap();
    assert_eq!(check_observations(f), before, "failed check has no effects");
    assert!(
        matches!(&reply, RpcReply::Failure {error,..} if error.code == code),
        "expected {code}: {reply:?}"
    );
}
async fn open_check_session(f: &Fixture) -> Target {
    let device = f.target("device", "virtual:echo");
    f.grant("document-a", "device.modify", &device);
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            &device,
            "device.open",
            None,
            json!({"configuration":SerialConfiguration::default()}),
        ),
    )
    .await;
    let operation = settled(&f.first, &f.host_target(), operation).await;
    let Some(ActionResult::Opened(opened)) = operation.result else {
        panic!("{operation:?}")
    };
    let target = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..device
    };
    f.grant("document-a", "device.modify", &target);
    f.grant("document-a", "content.read", &target);
    target
}
async fn live_lease(f: &Fixture, session: &Target) -> Operation {
    let operation = invoke(
        &f.first,
        call(
            &f.first,
            session,
            "lease.acquire",
            None,
            json!({"kind":"exclusive","ttlMs":"30000"}),
        ),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let current = f.store.get(&f.operator, &operation.operation_id).unwrap();
            if matches!(current.result, Some(ActionResult::Lease(_))) {
                assert_eq!(current.state, OperationState::Running);
                return current;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap()
}

// Catches allowing a typed action with missing fields or nested actor/permission injection fields.
#[tokio::test]
async fn fix1_document_checks_reject_invalid_typed_params() {
    let f = Fixture::new(0).await;
    for (domain, name, permission, value) in [
        (
            "workspace",
            "typed-check",
            "workspace.modify",
            json!(WorkspaceDocument::default()),
        ),
        (
            "settings",
            "shared",
            "settings.modify",
            json!(SharedSettings::default()),
        ),
    ] {
        let target = f.target(domain, name);
        f.grant("document-a", permission, &target);
        for params in [
            json!({}),
            json!({"value":value,"actorId":f.operator.id()}),
            json!({"value":value,"permissions":[permission]}),
        ] {
            let action = format!("{domain}.save");
            check_error(&f, &target, &action, params.clone(), "INVALID_ARGUMENT").await;
            let actual = f
                .first
                .request(RpcRequest::Invoke(call(
                    &f.first,
                    &target,
                    &action,
                    Some(0.into()),
                    params,
                )))
                .await
                .unwrap();
            assert!(
                matches!(actual, RpcReply::Failure { error,..} if error.code == "INVALID_ARGUMENT")
            );
        }
        for (verb, params) in [
            ("import", json!({})),
            ("read", json!({"actorId":f.operator.id()})),
            ("export", json!({"permissions":[]})),
        ] {
            check_error(
                &f,
                &target,
                &format!("{domain}.{verb}"),
                params,
                "INVALID_ARGUMENT",
            )
            .await;
        }
    }
    f.finish().await;
}

// Catches authorizing session A while stream params identify another session, epoch or scope.
#[tokio::test]
async fn fix1_stream_checks_reject_cross_target_params() {
    let f = Fixture::new(0).await;
    let session = open_check_session(&f).await;
    let raw = f.first.connect_raw().await.unwrap();
    for (session_id, epoch) in [
        (id("another-session"), session.session_epoch.unwrap()),
        (
            session.id.clone(),
            session.session_epoch.unwrap().checked_next().unwrap(),
        ),
    ] {
        let params = json!({"sessionId":session_id,"sessionEpoch":epoch,"startEventSeq":"0","maxEvents":"1","maxBytes":"1024"});
        check_error(
            &f,
            &session,
            "stream.read",
            params.clone(),
            "INVALID_ARGUMENT",
        )
        .await;
        let actual = raw
            .request(RpcRequest::Query(query(
                &f.first,
                &session,
                "stream.read",
                params,
            )))
            .await
            .unwrap();
        assert!(matches!(actual, RpcReply::Failure {error,..} if error.code == "INVALID_ARGUMENT"));
    }
    let other_scope = id("raw:another-session:1");
    let after = Cursor {
        host_id: session.host_id.clone(),
        instance_epoch: f.first.attachment().instance_epoch,
        scope_id: other_scope.clone(),
        position: 0.into(),
    };
    let params = json!({"scopeId":other_scope,"after":after,"queueBytes":"65536","initialCreditBytes":"65536","overflowPolicy":"drop_with_gap"});
    check_error(
        &f,
        &session,
        "stream.subscribe",
        params.clone(),
        "INVALID_ARGUMENT",
    )
    .await;
    let actual = raw
        .request(RpcRequest::Query(query(
            &f.first,
            &session,
            "stream.subscribe",
            params,
        )))
        .await
        .unwrap();
    assert!(matches!(actual, RpcReply::Failure {error,..} if error.code == "INVALID_ARGUMENT"));
    f.finish().await;
}

// Catches treating cancel as unsupported or using metadata access in place of cancellation ownership.
#[tokio::test]
async fn fix1_cancel_checks_owner_and_reason_without_requesting_cancel() {
    let f = Fixture::new(0).await;
    let session = open_check_session(&f).await;
    let lease = live_lease(&f, &session).await;
    let target = f.target("operation", lease.operation_id.as_str());
    assert!(checked(&f, &target, "operation.cancel", json!({"reason":"user"})).await);
    assert_eq!(
        f.store.get(&f.operator, &lease.operation_id).unwrap(),
        lease,
        "check must not request cancellation"
    );
    for reason in ["revoked", "takeover", "shutdown"] {
        assert!(!checked(&f, &target, "operation.cancel", json!({"reason":reason})).await);
        denied(
            f.first
                .request(RpcRequest::Invoke(call(
                    &f.first,
                    &target,
                    "operation.cancel",
                    None,
                    json!({"reason":reason}),
                )))
                .await
                .unwrap(),
        );
    }
    let other = f
        .second
        .request(RpcRequest::Query(query(
            &f.second,
            &target,
            "action.check",
            json!({"actionId":"operation.cancel","params":{"reason":"user"}}),
        )))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = other else {
        panic!("{other:?}")
    };
    assert!(matches!(
        *result,
        RpcResult::Query(QueryResult::ActionCheck(ActionCheckResult {
            allowed: false,
            ..
        }))
    ));
    denied(
        f.second
            .request(RpcRequest::Invoke(call(
                &f.second,
                &target,
                "operation.cancel",
                None,
                json!({"reason":"user"}),
            )))
            .await
            .unwrap(),
    );
    // A real user-control connection may cancel another actor's operation for shutdown.
    let secret =
        serial_workbench_ipc::read_secret(&f._dir.path().join("host-v0/user-control.secret"))
            .unwrap()
            .unwrap();
    let mut options = ConnectOptions::new(
        f._dir.path().to_path_buf(),
        id("document-a"),
        ClientKind::Cli,
    );
    options.user_control_credential =
        Some(ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap());
    let control = HostClient::connect(options).await.unwrap();
    let before = check_observations(&f);
    let reply = control
        .request(RpcRequest::Query(query(
            &control,
            &target,
            "action.check",
            json!({"actionId":"operation.cancel","params":{"reason":"shutdown"}}),
        )))
        .await
        .unwrap();
    assert_eq!(check_observations(&f), before);
    assert!(
        matches!(reply, RpcReply::Success {result,..} if matches!(*result, RpcResult::Query(QueryResult::ActionCheck(ActionCheckResult {allowed:true,..}))))
    );
    let cancelled = invoke(
        &control,
        call(
            &control,
            &target,
            "operation.cancel",
            None,
            json!({"reason":"shutdown"}),
        ),
    )
    .await;
    let cancelled = settled(&control, &f.host_target(), cancelled).await;
    assert_eq!(cancelled.state, OperationState::Succeeded);
    let current = f.store.get(&f.operator, &lease.operation_id).unwrap();
    assert!(matches!(
        current.state,
        OperationState::CancelRequested | OperationState::Cancelled
    ));
    f.finish().await;
}

// Catches check creating a cancellation capability that remains valid after target read permission is revoked.
#[tokio::test]
async fn fix1_cancel_rechecks_grants_before_actual_invoke() {
    let f = Fixture::new(0).await;
    let session = open_check_session(&f).await;
    let lease = live_lease(&f, &session).await;
    let target = f.target("operation", lease.operation_id.as_str());
    assert!(checked(&f, &target, "operation.cancel", json!({"reason":"user"})).await);
    revoke(&f, "metadata.read", &target);
    let before = check_observations(&f);
    denied(
        f.first
            .request(RpcRequest::Invoke(call(
                &f.first,
                &target,
                "operation.cancel",
                None,
                json!({"reason":"user"}),
            )))
            .await
            .unwrap(),
    );
    assert_eq!(check_observations(&f), before);
    assert_eq!(
        f.store.get(&f.operator, &lease.operation_id).unwrap(),
        lease
    );
    f.finish().await;
}

// Catches accepting cancel params that name an extra target or a target of the wrong resource kind.
#[tokio::test]
async fn fix1_cancel_rejects_invalid_params_and_target() {
    let f = Fixture::new(0).await;
    let target = f.target("operation", "missing-operation");
    for params in [
        json!({}),
        json!({"reason":"user","operationId":"other"}),
        json!({"reason":"user","actorId":f.operator.id()}),
    ] {
        check_error(&f, &target, "operation.cancel", params, "INVALID_ARGUMENT").await;
    }
    check_error(
        &f,
        &f.host_target(),
        "operation.cancel",
        json!({"reason":"user"}),
        "INVALID_ARGUMENT",
    )
    .await;
    check_error(
        &f,
        &target,
        "operation.cancel",
        json!({"reason":"user"}),
        "NOT_FOUND",
    )
    .await;
    f.finish().await;
}
