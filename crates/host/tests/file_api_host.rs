use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    files::FileService,
    ipc::HostServer,
    storage::Store,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    client: HostClient,
    user: HostClient,
    operator: AuthenticatedActor,
    auth: AuthService,
    store: Store,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        let store = server.store();
        let auth = server.auth();
        let secret =
            serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
                .unwrap()
                .unwrap();
        let credential = ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap();
        let operator = auth
            .authenticate_user_control(&id("file-user"), &credential)
            .unwrap();
        let host = Host::new(store.clone(), auth.clone()).await.unwrap();
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        let client = HostClient::connect(ConnectOptions::new(
            dir.path().to_path_buf(),
            id("file-reader"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        let mut options = ConnectOptions::new(
            dir.path().to_path_buf(),
            id("file-user"),
            ClientKind::Desktop,
        );
        options.user_control_credential = Some(credential);
        let user = HostClient::connect(options).await.unwrap();
        Self {
            dir,
            client,
            user,
            operator,
            auth,
            store,
            stop,
            running,
        }
    }
    fn host(&self) -> Target {
        Target {
            host_id: self.client.attachment().host_id.clone(),
            id: self.client.attachment().host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        }
    }
    fn target(&self, reference: &ObjectRef) -> Target {
        Target {
            host_id: reference.host_id.clone(),
            kind: reference.kind.clone(),
            id: reference.id.clone(),
            session_id: None,
            session_epoch: None,
        }
    }
    fn grant(&self, permission: &str, target: Target) {
        self.auth
            .authorize(
                &self.operator,
                AuthorizeParams {
                    client_id: self.client.attachment().client_id.clone(),
                    permissions: vec![permission.into()],
                    targets: vec![target],
                    expires_at: None,
                },
            )
            .unwrap();
    }
    fn source(&self, name: &str) -> ObjectRef {
        let path = self.dir.path().join(name);
        std::fs::write(&path, b"file-api-plaintext").unwrap();
        FileService::new(
            self.store.clone(),
            self.auth.clone(),
            self.store.identity().unwrap(),
        )
        .register(
            RegisterFileParams {
                path: path.to_str().unwrap().into(),
                purpose: FilePurpose::ReadFile,
            },
            &self.operator,
        )
        .unwrap()
    }
    fn query(
        &self,
        client: &HostClient,
        target: Target,
        action: &str,
        params: serde_json::Value,
    ) -> Query {
        let a = client.attachment();
        Query {
            protocol_version: ProtocolVersion::V0_1,
            host_id: a.host_id.clone(),
            instance_epoch: a.instance_epoch,
            actor_id: a.actor_id.clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            action_id: id(action),
            target,
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
    fn registration(&self, client: &HostClient, params: serde_json::Value) -> Call {
        let q = self.query(client, self.host(), "file.register", params);
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
            expected_revision: None,
            lease_id: None,
            execution_mode: None,
        }
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
    }
}
fn success(reply: RpcReply) -> RpcResult {
    let RpcReply::Success { result, .. } = reply else {
        panic!("expected success: {reply:?}")
    };
    *result
}
fn error(reply: RpcReply) -> HostError {
    let RpcReply::Failure { error, .. } = reply else {
        panic!("expected failure: {reply:?}")
    };
    error
}

#[tokio::test]
async fn file_registration_requires_user_control_and_returns_only_typed_metadata() {
    let f = Fixture::new().await;
    let path = f.dir.path().join("private-name.bin");
    std::fs::write(&path, b"body").unwrap();
    let params = json!({"path":path.to_str().unwrap(),"purpose":"read_file"});
    assert_eq!(
        error(
            f.client
                .request(RpcRequest::Invoke(
                    f.registration(&f.client, params.clone())
                ))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    let mut forged = params.clone();
    forged["clientId"] = json!("other");
    assert_eq!(
        error(
            f.user
                .request(RpcRequest::Invoke(f.registration(&f.user, forged)))
                .await
                .unwrap()
        )
        .code,
        "INVALID_ARGUMENT"
    );
    let RpcResult::Operation(accepted) = success(
        f.user
            .request(RpcRequest::Invoke(f.registration(&f.user, params)))
            .await
            .unwrap(),
    ) else {
        panic!("operation")
    };
    let operation = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = f
                .store
                .get(&f.operator, &accepted.operation.operation_id)
                .unwrap();
            if !matches!(
                value.state,
                OperationState::Queued | OperationState::Running
            ) {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        operation.state,
        OperationState::Succeeded,
        "{:?}",
        operation.error
    );
    let Some(ActionResult::FileMetadata(metadata)) = &operation.result else {
        panic!("typed file metadata")
    };
    assert_eq!(metadata.length, U64::from(4));
    assert_eq!(metadata.file_ref.kind.as_str(), "file");
    assert!(
        !serde_json::to_string(&operation)
            .unwrap()
            .contains("private-name.bin")
    );
    f.finish().await;
}

#[tokio::test]
async fn file_metadata_uses_current_parent_permission_across_actors_and_strict_refs() {
    let f = Fixture::new().await;
    let reference = f.source("metadata.bin");
    let target = f.target(&reference);
    f.grant("metadata.read", target.clone());
    let query = || {
        f.query(
            &f.client,
            target.clone(),
            "file.metadata",
            json!({"fileRef":reference}),
        )
    };
    let RpcResult::Query(QueryResult::FileMetadata(metadata)) =
        success(f.client.request(RpcRequest::Query(query())).await.unwrap())
    else {
        panic!("metadata")
    };
    assert_eq!(metadata.file_ref.id, reference.id);
    let mut extra = query();
    extra
        .params
        .insert("path".into(), JsonValue::String("forged".into()));
    assert_eq!(
        error(f.client.request(RpcRequest::Query(extra)).await.unwrap()).code,
        "INVALID_ARGUMENT"
    );
    let mut foreign = query();
    foreign.target.host_id = id("foreign-host");
    assert_eq!(
        error(f.client.request(RpcRequest::Query(foreign)).await.unwrap()).code,
        "HOST_ID_MISMATCH"
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.client.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        error(f.client.request(RpcRequest::Query(query())).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.finish().await;
}

#[tokio::test]
async fn file_read_is_raw_bounded_and_rechecks_source_permission_after_revocation() {
    let f = Fixture::new().await;
    let reference = f.source("read.bin");
    let target = f.target(&reference);
    f.grant("metadata.read", target.clone());
    let query = || {
        f.query(
            &f.client,
            target.clone(),
            "file.read",
            json!({"fileRef":reference,"offset":"0","maxBytes":"65536"}),
        )
    };
    let raw = f.client.connect_raw().await.unwrap();
    assert_eq!(
        error(raw.request(RpcRequest::Query(query())).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.grant("content.read", target.clone());
    assert_eq!(
        error(f.client.request(RpcRequest::Query(query())).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    let RpcResult::Query(QueryResult::FileRead(read)) =
        success(raw.request(RpcRequest::Query(query())).await.unwrap())
    else {
        panic!("file bytes")
    };
    assert_eq!(read.total_bytes, U64::from(18));
    assert!(read.at_end);
    let mut oversized = query();
    oversized
        .params
        .insert("maxBytes".into(), JsonValue::String("65537".into()));
    assert_eq!(
        error(raw.request(RpcRequest::Query(oversized)).await.unwrap()).code,
        "INVALID_ARGUMENT"
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.client.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        error(raw.request(RpcRequest::Query(query())).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.finish().await;
}

#[tokio::test]
async fn receipt_query_uses_saved_source_authority_and_bounded_typed_raw_page() {
    let f = Fixture::new().await;
    let source = f.source("receipts.bin");
    let authority = f.target(&source);
    let reference = ObjectRef {
        host_id: source.host_id.clone(),
        kind: ResourceKind::try_from("transfer_receipts").unwrap(),
        id: id("receipt-operation"),
        revision: None,
    };
    f.store.compare_and_swap_document(&id("transfer-receipts-receipt-operation"), 0.into(), serde_json::from_value(json!({"formatVersion":"0.1","sourceRef":source,"authority":authority,"count":"0","sealed":false})).unwrap()).unwrap();
    f.grant("content.read", authority.clone());
    let raw = f.client.connect_raw().await.unwrap();
    let query = || {
        f.query(
            &f.client,
            f.target(&reference),
            "transfer.receiptsRead",
            json!({"receiptsRef":reference,"startOrdinal":"0","maxReceipts":"8","maxBytes":"4096"}),
        )
    };
    let RpcResult::Query(QueryResult::FileTransferReceipts(page)) =
        success(raw.request(RpcRequest::Query(query())).await.unwrap())
    else {
        panic!("receipt page")
    };
    assert_eq!(page.receipts_ref, reference);
    assert_eq!(page.count, U64::from(0));
    assert!(page.receipts.is_empty());
    assert!(!page.sealed);
    assert_eq!(
        error(f.client.request(RpcRequest::Query(query())).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.client.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![authority],
            },
        )
        .unwrap();
    assert_eq!(
        error(raw.request(RpcRequest::Query(query())).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.finish().await;
}

#[tokio::test]
async fn file_catalog_exposes_rust_schemas_and_filters_user_control_registration() {
    let f = Fixture::new().await;
    let reference = f.source("catalog.bin");
    let target = f.target(&reference);
    f.grant("metadata.read", f.host());
    f.grant("content.read", target);
    let query =
        |client: &HostClient| f.query(client, f.host(), "catalog.list", json!({"pageSize":"100"}));
    let RpcResult::Query(QueryResult::Catalog(catalog)) = success(
        f.client
            .request(RpcRequest::Query(query(&f.client)))
            .await
            .unwrap(),
    ) else {
        panic!("catalog")
    };
    assert!(
        !catalog
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "file.register")
    );
    for (name, output) in [
        (
            "file.metadata",
            schema_for::<FileMetadata>(SchemaDialect::Draft07),
        ),
        (
            "file.read",
            schema_for::<FileReadResult>(SchemaDialect::Draft07),
        ),
        (
            "transfer.receiptsRead",
            schema_for::<FileTransferReceiptsResult>(SchemaDialect::Draft07),
        ),
    ] {
        let spec = catalog
            .items
            .iter()
            .find(|spec| spec.action_id.as_str() == name)
            .expect(name);
        assert_eq!(serde_json::to_value(&spec.output_schema).unwrap(), output);
    }
    let RpcResult::Query(QueryResult::Catalog(catalog)) = success(
        f.user
            .request(RpcRequest::Query(query(&f.user)))
            .await
            .unwrap(),
    ) else {
        panic!("user catalog")
    };
    let registration = catalog
        .items
        .iter()
        .find(|spec| spec.action_id.as_str() == "file.register")
        .expect("registration");
    assert_eq!(registration.kind, ActionKind::Action);
    assert_eq!(
        serde_json::to_value(&registration.input_schema).unwrap(),
        schema_for::<RegisterFileParams>(SchemaDialect::Draft07)
    );
    f.finish().await;
}
