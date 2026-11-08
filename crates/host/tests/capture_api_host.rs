use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    ipc::HostServer,
    storage::Store,
};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;
#[path = "support/operation_source_host.rs"]
mod operation_source_host;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    user: HostClient,
    control: HostClient,
    observer: HostClient,
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
            .authenticate_user_control(&id("capture-user"), &credential)
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
        let mut options =
            ConnectOptions::new(dir.path().into(), id("capture-user"), ClientKind::Desktop);
        options.user_control_credential = Some(credential);
        let control = HostClient::connect(options).await.unwrap();
        let user = HostClient::connect(ConnectOptions::new(
            dir.path().into(),
            id("capture-user"),
            ClientKind::Desktop,
        ))
        .await
        .unwrap();
        let host_target = Target {
            host_id: user.attachment().host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: user.attachment().host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: user.attachment().client_id.clone(),
                permissions: vec![
                    "metadata.read".into(),
                    "content.read".into(),
                    "device.modify".into(),
                    "workspace.modify".into(),
                ],
                targets: vec![host_target],
                expires_at: None,
            },
        )
        .unwrap();
        let observer = HostClient::connect(ConnectOptions::new(
            dir.path().into(),
            id("capture-observer"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        Self {
            dir,
            user,
            control,
            observer,
            operator,
            auth,
            store,
            stop,
            running,
        }
    }
    fn target(&self, kind: &str, name: &str) -> Target {
        Target {
            host_id: self.user.attachment().host_id.clone(),
            kind: ResourceKind::try_from(kind).unwrap(),
            id: id(name),
            session_id: None,
            session_epoch: None,
        }
    }
    fn reference_target(&self, reference: &ObjectRef) -> Target {
        self.target(reference.kind.as_str(), reference.id.as_str())
    }
    fn host(&self) -> Target {
        self.target("host", self.user.attachment().host_id.as_str())
    }
    fn query(&self, client: &HostClient, action: &str, target: Target, params: Value) -> Query {
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
            execution_mode: (action == "capture.start").then_some(ExecutionMode::Independent),
        }
    }
    async fn invoke(
        &self,
        client: &HostClient,
        action: &str,
        target: Target,
        params: Value,
    ) -> Operation {
        let RpcResult::Operation(result) = success(
            client
                .request(RpcRequest::Invoke(
                    self.call(client, action, target, params),
                ))
                .await
                .unwrap(),
        ) else {
            panic!("operation reply")
        };
        result.operation
    }
    async fn wait(&self, operation: &Operation, evidence_only: bool) -> Operation {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = self
                    .store
                    .get(&self.operator, &operation.operation_id)
                    .unwrap();
                if if evidence_only {
                    current.result.is_some()
                } else {
                    !matches!(
                        current.state,
                        OperationState::Queued
                            | OperationState::Running
                            | OperationState::CancelRequested
                    )
                } {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap()
    }
    async fn action(
        &self,
        client: &HostClient,
        action: &str,
        target: Target,
        params: Value,
    ) -> Operation {
        let accepted = self.invoke(client, action, target, params).await;
        self.wait(&accepted, false).await
    }
    async fn rejected_action(&self, action: &str, target: Target, params: Value) -> HostError {
        let reply = self
            .user
            .request(RpcRequest::Invoke(
                self.call(&self.user, action, target, params),
            ))
            .await
            .unwrap();
        match reply {
            RpcReply::Failure { error, .. } => error,
            reply => {
                let RpcResult::Operation(accepted) = success(reply) else {
                    panic!("operation")
                };
                self.wait(&accepted.operation, false)
                    .await
                    .error
                    .expect("action must be rejected")
            }
        }
    }
    async fn register(&self, name: &str) -> ObjectRef {
        let result = self.action(&self.control, "file.register", self.host(), json!({"path":self.dir.path().join(name).to_str().unwrap(),"purpose":"capture_target"})).await;
        assert_eq!(
            result.state,
            OperationState::Succeeded,
            "{:?}",
            result.error
        );
        let Some(ActionResult::FileMetadata(metadata)) = result.result else {
            panic!("file metadata")
        };
        metadata.file_ref
    }
    async fn open(&self) -> Target {
        let operation = self
            .action(
                &self.user,
                "device.open",
                self.target("device", "virtual:echo"),
                json!({"configuration":SerialConfiguration::default()}),
            )
            .await;
        assert_eq!(
            operation.state,
            OperationState::Succeeded,
            "{:?}",
            operation.error
        );
        let Some(ActionResult::Opened(opened)) = operation.result else {
            panic!("opened")
        };
        let mut target = self.target("session", opened.session_id.as_str());
        target.session_id = Some(opened.session_id);
        target.session_epoch = Some(opened.session_epoch);
        target
    }
    async fn start(
        &self,
        client: &HostClient,
        session: &Target,
        destination: &ObjectRef,
    ) -> (Operation, ObjectRef) {
        let operation = self
            .invoke(
                client,
                "capture.start",
                self.reference_target(destination),
                json!({"sessionRefs":[session],"targetRef":destination,"overflowPolicy":"stop"}),
            )
            .await;
        let current = self.wait(&operation, true).await;
        assert_eq!(current.state, OperationState::Running);
        let Some(ActionResult::Reference(reference)) = current.result else {
            panic!("live ref evidence")
        };
        (operation, reference.result_ref)
    }
    fn grant(&self, permission: &str, target: Target) {
        self.auth
            .authorize(
                &self.operator,
                AuthorizeParams {
                    client_id: self.observer.attachment().client_id.clone(),
                    permissions: vec![permission.into()],
                    targets: vec![target],
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
fn success(reply: RpcReply) -> RpcResult {
    let RpcReply::Success { result, .. } = reply else {
        panic!("expected success: {reply:?}")
    };
    *result
}
fn failure(reply: RpcReply) -> HostError {
    let RpcReply::Failure { error, .. } = reply else {
        panic!("expected failure: {reply:?}")
    };
    error
}

#[tokio::test]
async fn trusted_capture_keeps_independent_owner_after_client_disconnect_and_replays_raw() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("private-capture-location").await;
    let transient = f.user.reconnect().await.unwrap();
    let (owner, live) = f.start(&transient, &session, &destination).await;
    drop(transient);
    let tx = f
        .action(
            &f.user,
            "session.tx",
            session.clone(),
            json!({"bytesBase64":"AQID","writeWaitMs":"100"}),
        )
        .await;
    assert_eq!(tx.state, OperationState::Succeeded);
    // Wait for real writer evidence rather than sleeping and assuming RX was captured.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = success(
                f.user
                    .request(RpcRequest::Query(f.query(
                        &f.user,
                        "capture.status",
                        f.reference_target(&live),
                        json!({"captureRef":live}),
                    )))
                    .await
                    .unwrap(),
            );
            let status = serde_json::to_value(status).unwrap();
            let written = status
                .pointer("/value/value/summary/watermarks/written")
                .or_else(|| status.pointer("/value/summary/watermarks/written"))
                .and_then(Value::as_str)
                .unwrap_or("0")
                .parse::<u64>()
                .unwrap();
            if written > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        f.store.get(&f.operator, &owner.operation_id).unwrap().state,
        OperationState::Running
    );
    let stop = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(stop.state, OperationState::Succeeded, "{:?}", stop.error);
    let owner = f.wait(&owner, false).await;
    assert_eq!(owner.state, OperationState::Succeeded, "{:?}", owner.error);
    let body = serde_json::to_value(owner.result.unwrap()).unwrap();
    let fixed: ObjectRef = serde_json::from_value(body["value"]["captureRef"].clone()).unwrap();
    assert!(fixed.revision.is_some());
    assert!(
        !serde_json::to_string(&body)
            .unwrap()
            .contains("private-capture-location")
    );
    let verified = f
        .action(
            &f.user,
            "capture.verify",
            f.reference_target(&fixed),
            json!({"captureRef":fixed}),
        )
        .await;
    assert_eq!(
        verified.state,
        OperationState::Succeeded,
        "{:?}",
        verified.error
    );
    let Some(ActionResult::CaptureVerification(verification)) = verified.result else {
        panic!("verification report")
    };
    assert!(verification.container_complete);
    let exported_target = f.register("exported-text.jsonl").await;
    let exported = f
        .action(
            &f.user,
            "capture.export",
            f.reference_target(&fixed),
            json!({"captureRef":fixed,"targetRef":exported_target}),
        )
        .await;
    assert_eq!(
        exported.state,
        OperationState::Succeeded,
        "{:?}",
        exported.error
    );
    let Some(ActionResult::Reference(exported)) = exported.result else {
        panic!("export reference")
    };
    assert!(exported.result_ref.revision.is_some());
    let recovery_target = f.register("recovered-copy").await;
    let recovered=f.action(&f.user,"capture.recover",f.reference_target(&recovery_target),json!({"verificationId":verification.verification_id,"sourceFingerprint":verification.source_fingerprint,"targetRef":recovery_target})).await;
    assert_eq!(
        recovered.state,
        OperationState::Succeeded,
        "{:?}",
        recovered.error
    );
    let Some(ActionResult::Reference(recovered)) = recovered.result else {
        panic!("recovered reference")
    };
    assert!(recovered.result_ref.revision.is_some());
    let opened = f
        .action(
            &f.user,
            "replay.open",
            f.reference_target(&fixed),
            json!({"captureRef":fixed,"mode":"fastest"}),
        )
        .await;
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("replay opened: {:?}", opened.error)
    };
    let mut replay = f.target("session", opened.session_id.as_str());
    replay.session_id = Some(opened.session_id.clone());
    replay.session_epoch = Some(opened.session_epoch);
    let query=f.query(&f.user,"replay.read",replay.clone(),json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"maxRecords":"100","maxBytes":"262144"}));
    assert_eq!(
        failure(
            f.user
                .request(RpcRequest::Query(query.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    let raw = f.user.connect_raw().await.unwrap();
    let records = success(raw.request(RpcRequest::Query(query)).await.unwrap());
    assert!(serde_json::to_string(&records).unwrap().contains("AQID"));
    let shared=f.query(&f.observer,"replay.read",replay.clone(),json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"maxRecords":"100","maxBytes":"262144"}));
    let observer_raw = f.observer.connect_raw().await.unwrap();
    assert_eq!(
        failure(
            observer_raw
                .request(RpcRequest::Query(shared.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    f.grant("content.read", f.reference_target(&destination));
    let reset=f.action(&f.user,"replay.control",replay.clone(),json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"paused":false,"seekRecord":"1"})).await;
    assert_eq!(reset.state, OperationState::Succeeded, "{:?}", reset.error);
    let shared_records = success(
        observer_raw
            .request(RpcRequest::Query(shared.clone()))
            .await
            .unwrap(),
    );
    assert!(
        serde_json::to_string(&shared_records)
            .unwrap()
            .contains("AQID")
    );
    let mut old = shared.clone();
    old.target.session_epoch = Some(2.into());
    old.params
        .insert("sessionEpoch".into(), JsonValue::String("2".into()));
    assert_eq!(
        failure(observer_raw.request(RpcRequest::Query(old)).await.unwrap()).code,
        "EPOCH_MISMATCH"
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.reference_target(&destination)],
            },
        )
        .unwrap();
    assert_eq!(
        failure(
            observer_raw
                .request(RpcRequest::Query(shared))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    let snapshot = success(
        f.user
            .request(RpcRequest::Query(f.query(
                &f.user,
                "session.get",
                replay.clone(),
                json!({}),
            )))
            .await
            .unwrap(),
    );
    assert!(
        serde_json::to_string(&snapshot)
            .unwrap()
            .contains("\"readOnly\":true")
    );
    for (action, params) in [
        (
            "session.tx",
            json!({"bytesBase64":"BA==","writeWaitMs":"100"}),
        ),
        (
            "session.configure",
            json!({"requested":SerialConfiguration::default()}),
        ),
        ("session.control", json!({"line":"dtr","value":true})),
    ] {
        assert_eq!(
            f.rejected_action(action, replay.clone(), params).await.code,
            "READ_ONLY"
        );
    }
    let closed = f.action(&f.user, "replay.close", replay, json!({})).await;
    assert_eq!(closed.state, OperationState::Succeeded);
    f.finish().await;
}

#[tokio::test]
async fn capture_status_requires_current_parent_permission_and_epoch() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("parent-authority").await;
    let (_, live) = f.start(&f.user, &session, &destination).await;
    // New clients receive Host-wide metadata.read. A narrower current denial
    // must override that default before we can test the saved parent scope.
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![f.reference_target(&destination)],
            },
        )
        .unwrap();
    let query = f.query(
        &f.observer,
        "capture.status",
        f.reference_target(&live),
        json!({"captureRef":live}),
    );
    assert_eq!(
        failure(
            f.observer
                .request(RpcRequest::Query(query.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    f.grant("metadata.read", f.reference_target(&destination));
    success(
        f.observer
            .request(RpcRequest::Query(query.clone()))
            .await
            .unwrap(),
    );
    let mut old = query.clone();
    old.instance_epoch = 0.into();
    assert_eq!(
        failure(f.observer.request(RpcRequest::Query(old)).await.unwrap()).code,
        "EPOCH_MISMATCH"
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![f.reference_target(&destination)],
            },
        )
        .unwrap();
    assert_eq!(
        failure(f.observer.request(RpcRequest::Query(query)).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    let stop = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(stop.state, OperationState::Succeeded);
    f.finish().await;
}

#[tokio::test]
async fn imported_capture_status_needs_only_metadata_and_omits_recording_owner() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("metadata-only-import").await;
    let (owner, live) = f.start(&f.user, &session, &destination).await;
    let stopped = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(
        stopped.state,
        OperationState::Succeeded,
        "{:?}",
        stopped.error
    );
    assert_eq!(f.wait(&owner, false).await.state, OperationState::Succeeded);
    let imported=f.action(&f.control,"file.register",f.host(),json!({"path":f.dir.path().join("metadata-only-import").to_str().unwrap(),"purpose":"capture_source"})).await;
    assert_eq!(
        imported.state,
        OperationState::Succeeded,
        "{:?}",
        imported.error
    );
    let Some(ActionResult::FileMetadata(imported)) = imported.result else {
        panic!("imported metadata")
    };
    f.grant("metadata.read", f.reference_target(&imported.file_ref));
    let status = success(
        f.observer
            .request(RpcRequest::Query(f.query(
                &f.observer,
                "capture.status",
                f.reference_target(&imported.file_ref),
                json!({"captureRef":imported.file_ref}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Query(QueryResult::CaptureStatus(status)) = status else {
        panic!("capture status")
    };
    assert_eq!(status.owner_operation_id, None);
    assert!(status.capture_ref.revision.is_some());
    assert_eq!(status.summary.state, CaptureState::Complete);
    assert!(
        serde_json::to_value(status)
            .unwrap()
            .get("ownerOperationId")
            .is_none()
    );
    f.finish().await;
}

#[tokio::test]
async fn capture_start_requires_explicit_independent_mode() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let target = f.register("explicit-independent").await;
    for mode in [None, Some(ExecutionMode::Interactive)] {
        let mut call = f.call(
            &f.user,
            "capture.start",
            f.reference_target(&target),
            json!({"sessionRefs":[session],"targetRef":target,"overflowPolicy":"stop"}),
        );
        call.execution_mode = mode;
        assert_eq!(
            failure(f.user.request(RpcRequest::Invoke(call)).await.unwrap()).code,
            "INVALID_ARGUMENT"
        );
    }
    assert!(!f.dir.path().join("explicit-independent").exists());
    f.finish().await;
}

#[tokio::test]
async fn running_capture_reports_synced_progress_without_replacing_live_reference() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("running-synced-progress").await;
    let (owner, live) = f.start(&f.user, &session, &destination).await;
    let RpcResult::Snapshot(snapshot) = success(
        f.user
            .request(RpcRequest::StateSnapshot(f.query(
                &f.user,
                "state.snapshot",
                f.host(),
                json!({"scopeId":"host.operations"}),
            )))
            .await
            .unwrap(),
    ) else {
        panic!("operation snapshot")
    };
    let RpcResult::Subscription(subscription) = success(
        f.user
            .request(RpcRequest::StateSubscribe(f.query(
                &f.user,
                "state.subscribe",
                f.host(),
                json!({"scopeId":"host.operations","after":snapshot.cursor}),
            )))
            .await
            .unwrap(),
    ) else {
        panic!("operation subscription")
    };
    let mut completed = 0u64;
    let mut revision = owner.revision;
    for payload in ["AQID", "BAUG"] {
        let tx = f
            .action(
                &f.user,
                "session.tx",
                session.clone(),
                json!({"bytesBase64":payload,"writeWaitMs":"100"}),
            )
            .await;
        assert_eq!(tx.state, OperationState::Succeeded, "{:?}", tx.error);
        let progress = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let RpcResult::Query(QueryResult::CaptureStatus(status)) = success(
                    f.user
                        .request(RpcRequest::Query(f.query(
                            &f.user,
                            "capture.status",
                            f.reference_target(&live),
                            json!({"captureRef":live}),
                        )))
                        .await
                        .unwrap(),
                ) else {
                    panic!("capture status")
                };
                assert_eq!(status.summary.state, CaptureState::Recording);
                assert_eq!(status.owner_operation_id, Some(owner.operation_id.clone()));
                let current = f.store.get(&f.operator, &owner.operation_id).unwrap();
                assert_eq!(current.state, OperationState::Running);
                assert_eq!(
                    current.result,
                    Some(ActionResult::Reference(ResultReference {
                        result_ref: live.clone()
                    }))
                );
                if status.summary.watermarks.synced.get() > completed
                    && let Some(progress) = current.progress
                    && progress.completed == status.summary.watermarks.synced
                {
                    assert!(current.revision > revision);
                    revision = current.revision;
                    break progress;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("durable synced records must update the still-running owner before stop");
        assert_eq!(progress.unit, "records");
        assert_eq!(progress.total, None);
        completed = progress.completed.get();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame = f.user.next_event().await.unwrap().expect("operation event");
                let IpcMessage::Delta {
                    subscription_id,
                    delta,
                } = frame.body
                else {
                    continue;
                };
                if subscription_id != subscription.subscription_id {
                    continue;
                }
                let payload = serde_json::to_value(delta.payload).unwrap();
                let found = payload["items"].as_array().is_some_and(|items| {
                    items.iter().any(|item| {
                        item["operationId"] == json!(owner.operation_id)
                            && item["state"] == json!("running")
                            && item["progress"]["completed"]
                                .as_str()
                                .and_then(|v| v.parse::<u64>().ok())
                                .is_some_and(|value| value >= completed)
                            && item["progress"]["unit"] == json!("records")
                    })
                });
                if found {
                    break;
                }
            }
        })
        .await
        .expect("host.operations subscription must publish running capture progress");
    }
    success(
        f.user
            .request(RpcRequest::SubscriptionClose(f.query(
                &f.user,
                "subscription.close",
                f.host(),
                json!({"subscriptionId":subscription.subscription_id}),
            )))
            .await
            .unwrap(),
    );
    let stopped = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(
        stopped.state,
        OperationState::Succeeded,
        "{:?}",
        stopped.error
    );
    assert_eq!(f.wait(&owner, false).await.state, OperationState::Succeeded);
    f.finish().await;
}

#[path = "support/capture_tail.rs"]
mod capture_tail;
