//! Real IPC inspection tests: current resource rights, typed inputs and safe projections.
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient, RawConnection};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    ipc::HostServer,
    storage::Store,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

fn id(s: &str) -> Id {
    Id::try_from(s).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    store: Store,
    auth: AuthService,
    operator: AuthenticatedActor,
    control: HostClient,
    mcp: HostClient,
    gui: HostClient,
    gui_raw: RawConnection,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        let store = server.store();
        let auth = server.auth();
        let credential = serial_workbench_client::read_user_control_credential(dir.path()).unwrap();
        let operator = auth
            .authenticate_user_control(&id("mcp-input"), &credential)
            .unwrap();
        let host = Host::new(store.clone(), auth.clone()).await.unwrap();
        let served = host.clone();
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(served), async {
                    let _ = done.await;
                })
                .await
        });
        let mcp = HostClient::connect(ConnectOptions::new(
            dir.path().into(),
            id("mcp-input"),
            ClientKind::Mcp,
        ))
        .await
        .unwrap();
        let gui = HostClient::connect(ConnectOptions::new(
            dir.path().into(),
            id("desktop-observer"),
            ClientKind::Desktop,
        ))
        .await
        .unwrap();
        let mut options =
            ConnectOptions::new(dir.path().into(), id("mcp-input"), ClientKind::Desktop);
        options.user_control_credential = Some(credential);
        let control = HostClient::connect(options).await.unwrap();
        let gui_raw = gui.connect_raw().await.unwrap();
        let f = Self {
            dir,
            store,
            auth,
            operator,
            control,
            mcp,
            gui,
            gui_raw,
            stop,
            running,
        };
        f.grant(
            &f.mcp,
            "device.modify",
            f.target("host", f.mcp.attachment().host_id.as_str()),
        );
        f.grant(
            &f.mcp,
            "content.read",
            f.target("host", f.mcp.attachment().host_id.as_str()),
        );
        f.grant(
            &f.mcp,
            "workspace.modify",
            f.target("host", f.mcp.attachment().host_id.as_str()),
        );
        f
    }
    fn target(&self, kind: &str, key: &str) -> Target {
        Target {
            host_id: self.mcp.attachment().host_id.clone(),
            kind: ResourceKind::try_from(kind).unwrap(),
            id: id(key),
            session_id: None,
            session_epoch: None,
        }
    }
    fn host_target(&self) -> Target {
        self.target("host", self.mcp.attachment().host_id.as_str())
    }
    fn ref_target(&self, r: &ObjectRef) -> Target {
        self.target(r.kind.as_str(), r.id.as_str())
    }
    fn grant(&self, client: &HostClient, permission: &str, target: Target) {
        self.auth
            .authorize(
                &self.operator,
                AuthorizeParams {
                    client_id: client.attachment().client_id.clone(),
                    permissions: vec![permission.into()],
                    targets: vec![target],
                    expires_at: None,
                },
            )
            .unwrap();
    }
    fn revoke(&self, client: &HostClient, permission: &str, target: Target) {
        self.auth
            .revoke(
                &self.operator,
                RevokeParams {
                    actor_id: client.attachment().actor_id.clone(),
                    permissions: vec![permission.into()],
                    targets: vec![target],
                },
            )
            .unwrap();
    }
    fn query(&self, client: &HostClient, action: &str, target: Target, params: Value) -> Query {
        let a = client.attachment();
        Query {
            protocol_version: a.protocol_version,
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
    fn call(&self, client: &HostClient, action: &str, target: Target, params: Value) -> Call {
        let q = self.query(client, action, target, params);
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
            execution_mode: matches!(action, "capture.start" | "transfer.file")
                .then_some(ExecutionMode::Independent),
        }
    }
    async fn invoke(&self, client: &HostClient, call: Call) -> Operation {
        let RpcResult::Operation(result) =
            success(client.request(RpcRequest::Invoke(call)).await.unwrap())
        else {
            panic!("operation reply")
        };
        result.operation
    }
    async fn wait(&self, operation: &Operation) -> Operation {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = self
                    .store
                    .get(&self.operator, &operation.operation_id)
                    .unwrap();
                if !matches!(
                    current.state,
                    OperationState::Queued
                        | OperationState::Running
                        | OperationState::CancelRequested
                ) {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn open(&self) -> Target {
        let pending = self
            .invoke(
                &self.mcp,
                self.call(
                    &self.mcp,
                    "device.open",
                    self.target("device", "virtual:echo"),
                    json!({"configuration":SerialConfiguration::default()}),
                ),
            )
            .await;
        let operation = self.wait(&pending).await;
        assert_eq!(
            operation.state,
            OperationState::Succeeded,
            "{:?}",
            operation.error
        );
        let Some(ActionResult::Opened(opened)) = operation.result else {
            panic!("opened")
        };
        Target {
            session_id: Some(opened.session_id.clone()),
            session_epoch: Some(opened.session_epoch),
            ..self.target("session", opened.session_id.as_str())
        }
    }
    async fn tx(&self, target: &Target) -> Operation {
        let accepted = self
            .invoke(
                &self.mcp,
                self.call(
                    &self.mcp,
                    "session.tx",
                    target.clone(),
                    json!({"bytesBase64":"AQID","writeWaitMs":"1000"}),
                ),
            )
            .await;
        let done = self.wait(&accepted).await;
        assert_eq!(done.state, OperationState::Succeeded, "{:?}", done.error);
        done
    }
    async fn get(&self, client: &HostClient, operation: &Operation) -> RpcReply {
        client
            .request(RpcRequest::Query(self.query(
                client,
                "operation.get",
                self.host_target(),
                json!({"operationId":operation.operation_id}),
            )))
            .await
            .unwrap()
    }
    async fn input(&self, client: &HostClient, operation: &Operation) -> RpcReply {
        assert_eq!(client.attachment().actor_id, self.gui.attachment().actor_id);
        self.gui_raw
            .request(RpcRequest::Query(self.query(
                client,
                "operation.input",
                self.host_target(),
                json!({"operationId":operation.operation_id}),
            )))
            .await
            .unwrap()
    }
    async fn registered(&self, name: &str, purpose: FilePurpose) -> (Operation, ObjectRef) {
        let op = self
            .invoke(
                &self.control,
                self.call(
                    &self.control,
                    "file.register",
                    self.host_target(),
                    json!({"path":self.dir.path().join(name).to_str().unwrap(),"purpose":purpose}),
                ),
            )
            .await;
        let op = self.wait(&op).await;
        assert_eq!(op.state, OperationState::Succeeded, "{:?}", op.error);
        let Some(ActionResult::FileMetadata(metadata)) = &op.result else {
            panic!("file")
        };
        let reference = metadata.file_ref.clone();
        (op, reference)
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(8), self.running)
            .await
            .expect("visibility fixture Host did not settle")
            .unwrap()
            .unwrap();
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
fn operation(reply: RpcReply) -> Operation {
    let RpcResult::Query(QueryResult::Operation(value)) = success(reply) else {
        panic!("operation query")
    };
    value.operation
}
fn query_value(reply: RpcReply) -> Value {
    let RpcResult::Query(result) = success(reply) else {
        panic!("typed query")
    };
    serde_json::to_value(result).unwrap()["value"].clone()
}

#[tokio::test]
async fn scoped_reader_discovers_inspection_without_host_metadata_and_loses_it_on_revocation() {
    let f = Fixture::new().await;
    let session = f.open().await;
    f.revoke(&f.gui, "metadata.read", f.host_target());
    f.grant(&f.gui, "metadata.read", session.clone());
    f.grant(&f.gui, "content.read", session.clone());
    let catalog = query_value(
        f.gui
            .request(RpcRequest::Query(f.query(
                &f.gui,
                "catalog.list",
                f.host_target(),
                json!({"pageSize":"100"}),
            )))
            .await
            .unwrap(),
    );
    let actions: Vec<&str> = catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["actionId"].as_str().unwrap())
        .collect();
    assert!(actions.contains(&"operation.get"));
    assert!(actions.contains(&"operation.input"));
    assert!(!actions.contains(&"file.register"));
    f.revoke(&f.gui, "metadata.read", session);
    let catalog = query_value(
        f.gui
            .request(RpcRequest::Query(f.query(
                &f.gui,
                "catalog.list",
                f.host_target(),
                json!({"pageSize":"100"}),
            )))
            .await
            .unwrap(),
    );
    assert!(catalog["items"].as_array().unwrap().iter().all(|item| {
        !matches!(
            item["actionId"].as_str(),
            Some("operation.get" | "operation.input")
        )
    }));
    f.finish().await;
}

#[tokio::test]
async fn desktop_reads_same_session_mcp_operation_with_current_scope_read_permission() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let tx = f.tx(&session).await;
    f.revoke(&f.gui, "metadata.read", f.host_target());
    f.grant(&f.gui, "metadata.read", session.clone());
    f.grant(&f.gui, "content.read", session.clone());
    let read = operation(f.get(&f.gui, &tx).await);
    assert_eq!(read.operation_id, tx.operation_id);
    assert_eq!(read.result, tx.result);
    assert_eq!(read.actor_id, f.mcp.attachment().actor_id);
    f.finish().await;
}
#[tokio::test]
async fn metadata_and_device_modify_do_not_grant_tx_input_or_receipt_and_revocation_is_current() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let tx = f.tx(&session).await;
    f.grant(&f.gui, "device.modify", session.clone());
    assert_eq!(error(f.get(&f.gui, &tx).await).code, "PERMISSION_DENIED");
    assert_eq!(error(f.input(&f.gui, &tx).await).code, "PERMISSION_DENIED");
    f.grant(&f.gui, "content.read", session.clone());
    assert_eq!(
        query_value(f.input(&f.gui, &tx).await)["value"]["bytesBase64"],
        "AQID"
    );
    f.revoke(&f.gui, "content.read", session);
    assert_eq!(error(f.get(&f.gui, &tx).await).code, "PERMISSION_DENIED");
    assert_eq!(error(f.input(&f.gui, &tx).await).code, "PERMISSION_DENIED");
    f.finish().await;
}
#[tokio::test]
async fn typed_public_summary_exposes_target_time_and_progress_without_private_envelope() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let tx = f.tx(&session).await;
    let snapshot = query_value(
        f.gui
            .request(RpcRequest::Query(f.query(
                &f.gui,
                "state.snapshot",
                f.host_target(),
                json!({"scopeId":"host.operations"}),
            )))
            .await
            .unwrap(),
    );
    let rows: &Vec<Value> = snapshot["state"]["items"].as_array().unwrap();
    let summary = rows
        .iter()
        .find(|row| row["operationId"] == tx.operation_id.as_str())
        .unwrap();
    assert_eq!(summary["target"], serde_json::to_value(&session).unwrap());
    assert_eq!(
        summary["acceptedAt"],
        serde_json::to_value(&tx.accepted_at).unwrap()
    );
    for private in [
        "admission",
        "requestContext",
        "requestId",
        "result",
        "clientEffectReceipt",
        "input",
        "error",
    ] {
        assert!(summary.get(private).is_none(), "public {private}");
    }
    assert!(summary["revealTarget"].get("resultRef").is_none());
    f.finish().await;
}
#[tokio::test]
async fn transfer_history_requires_both_session_and_saved_source_read_without_reopening_source() {
    let f = Fixture::new().await;
    let session = f.open().await;
    std::fs::write(f.dir.path().join("source.bin"), [1, 2, 3]).unwrap();
    let (_, source) = f.registered("source.bin", FilePurpose::ReadFile).await;
    let accepted=f.invoke(&f.mcp,f.call(&f.mcp,"transfer.file",session.clone(),json!({"sourceRef":source,"offset":"0","length":"3","chunkBytes":"3","bytesPerSecond":"1000000","interChunkMs":"0","writeWaitMs":"1000"}))).await;
    let done = f.wait(&accepted).await;
    assert_eq!(done.state, OperationState::Succeeded, "{:?}", done.error);
    f.grant(&f.gui, "content.read", session.clone());
    assert_eq!(error(f.get(&f.gui, &done).await).code, "PERMISSION_DENIED");
    f.grant(&f.gui, "content.read", f.ref_target(&source));
    assert_eq!(operation(f.get(&f.gui, &done).await).result, done.result);
    std::fs::write(f.dir.path().join("source.bin"), [9, 8, 7, 6]).unwrap();
    assert_eq!(operation(f.get(&f.gui, &done).await).result, done.result);
    assert_eq!(
        query_value(f.input(&f.gui, &done).await)["value"]["sourceRef"],
        serde_json::to_value(&source).unwrap()
    );
    f.revoke(&f.gui, "content.read", f.ref_target(&source));
    assert_eq!(error(f.get(&f.gui, &done).await).code, "PERMISSION_DENIED");
    f.finish().await;
}
#[tokio::test]
async fn registration_input_is_explicitly_redacted_and_request_lookup_remains_owner_only() {
    let f = Fixture::new().await;
    std::fs::write(f.dir.path().join("secret-local-path.bin"), [1]).unwrap();
    let (op, reference) = f
        .registered("secret-local-path.bin", FilePurpose::ReadFile)
        .await;
    f.grant(&f.gui, "content.read", f.ref_target(&reference));
    let value = query_value(f.input(&f.gui, &op).await);
    assert_eq!(value["kind"], "redacted");
    let serialized = serde_json::to_string(&value).unwrap();
    assert!(!serialized.contains("secret-local-path"));
    assert!(!serialized.contains("requestContext"));
    let by_request=f.gui.request(RpcRequest::Query(f.query(&f.gui,"operation.get",f.host_target(),json!({"actorId":f.control.attachment().actor_id,"requestId":op.request_id,"requestContext":f.control.attachment().request_context})))).await.unwrap();
    assert_eq!(error(by_request).code, "PERMISSION_DENIED");
    f.finish().await;
}

#[tokio::test]
async fn shared_capture_operation_uses_saved_file_parent_and_original_session_read_rights() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let (_, destination) = f
        .registered("shared-recording", FilePurpose::CaptureTarget)
        .await;
    let owner = f
        .invoke(
            &f.mcp,
            f.call(
                &f.mcp,
                "capture.start",
                f.ref_target(&destination),
                json!({"sessionRefs":[session],"targetRef":destination,"overflowPolicy":"stop"}),
            ),
        )
        .await;
    let live = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let operation = f.store.get(&f.operator, &owner.operation_id).unwrap();
            if let Some(ActionResult::Reference(reference)) = operation.result {
                break reference.result_ref;
            }
            assert!(matches!(
                operation.state,
                OperationState::Queued | OperationState::Running
            ));
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    f.grant(&f.gui, "content.read", session.clone());
    f.grant(&f.gui, "content.read", f.ref_target(&live));
    let wrong_parent = f.get(&f.gui, &owner).await;
    f.grant(&f.gui, "content.read", f.ref_target(&destination));
    let shared = f.get(&f.gui, &owner).await;
    let shared_input = f.input(&f.gui, &owner).await;
    let stopped = f
        .invoke(
            &f.mcp,
            f.call(
                &f.mcp,
                "capture.stop",
                f.ref_target(&live),
                json!({"captureRef":live}),
            ),
        )
        .await;
    assert_eq!(f.wait(&stopped).await.state, OperationState::Succeeded);
    assert_eq!(f.wait(&owner).await.state, OperationState::Succeeded);
    f.finish().await;
    assert_eq!(error(wrong_parent).code, "PERMISSION_DENIED");
    assert_eq!(operation(shared).operation_id, owner.operation_id);
    let input = query_value(shared_input);
    assert_eq!(input["kind"], "capture_start");
    assert_eq!(input["value"]["sessionRefs"], json!([session]));
}

#[tokio::test]
async fn running_transfer_publishes_committed_progress_before_final_settlement() {
    let f = Fixture::new().await;
    let session = f.open().await;
    std::fs::write(f.dir.path().join("progress-source.bin"), [1, 2, 3, 4]).unwrap();
    let (_, source) = f
        .registered("progress-source.bin", FilePurpose::ReadFile)
        .await;
    let baseline = query_value(
        f.gui
            .request(RpcRequest::Query(f.query(
                &f.gui,
                "state.snapshot",
                f.host_target(),
                json!({"scopeId":"host.operations"}),
            )))
            .await
            .unwrap(),
    );
    let subscription = query_value(
        f.gui
            .request(RpcRequest::Query(f.query(
                &f.gui,
                "state.subscribe",
                f.host_target(),
                json!({"scopeId":"host.operations","after":baseline["cursor"]}),
            )))
            .await
            .unwrap(),
    );
    let accepted=f.invoke(&f.mcp,f.call(&f.mcp,"transfer.file",session.clone(),json!({"sourceRef":source,"offset":"0","length":"4","chunkBytes":"1","bytesPerSecond":"1000000","interChunkMs":"1000","writeWaitMs":"1000"}))).await;
    let durable = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let operation = f.store.get(&f.operator, &accepted.operation_id).unwrap();
            if operation
                .progress
                .as_ref()
                .is_some_and(|p| p.completed.get() > 0)
            {
                break operation;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(durable.state, OperationState::Running);
    let visible = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            let frame = f.gui.next_event().await.unwrap().unwrap();
            if let IpcMessage::Delta {
                subscription_id,
                delta,
            } = frame.body
            {
                if serde_json::to_value(subscription_id).unwrap() != subscription["subscriptionId"]
                {
                    continue;
                }
                let state = serde_json::to_value(delta.payload).unwrap();
                if let Some(item) = state["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["operationId"] == accepted.operation_id.as_str())
                    && item["state"] == "running"
                    && item["progress"]["completed"] == "1"
                {
                    break item.clone();
                }
            }
        }
    })
    .await;
    let cancel = f
        .invoke(
            &f.mcp,
            f.call(
                &f.mcp,
                "operation.cancel",
                f.target("operation", accepted.operation_id.as_str()),
                json!({"reason":"user"}),
            ),
        )
        .await;
    let _ = f.wait(&cancel).await;
    let done = f.wait(&accepted).await;
    f.finish().await;
    let visible = visible
        .expect("a committed intermediate progress update must arrive while the owner is running");
    assert_eq!(visible["progress"]["total"], "4");
    assert_eq!(visible["progress"]["unit"], "bytes");
    assert_eq!(done.state, OperationState::Cancelled);
}
