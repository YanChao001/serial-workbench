use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    device::{DeviceProvider, virtual_backend::VirtualTransport},
    ipc::HostServer,
    storage::Store,
    workspace::WorkspaceService,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::oneshot;
fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Provider {
    host: Id,
    opens: AtomicUsize,
}
impl DeviceProvider for Provider {
    fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>> {
        Ok(vec![DeviceDescriptor {
            device_id: id("provider-id"),
            host_id: self.host.clone(),
            system_name: "COM42".into(),
            description: None,
            manufacturer: None,
            driver: None,
            fingerprint: DeviceFingerprint {
                transport: DeviceTransportKind::Serial,
                vid: Some(1),
                pid: Some(2),
                serial_number: Some("runtime-host".into()),
                topology_path: Some("socket".into()),
                evidence: IdentityEvidence::SerialNumber,
            },
            capabilities: VirtualTransport::new(SerialConfiguration::default()).capabilities(),
        }])
    }
    fn open(
        &self,
        _: &DeviceDescriptor,
        configuration: &SerialConfiguration,
    ) -> BackendResult<Box<dyn Transport>> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(VirtualTransport::new(configuration.clone())))
    }
}
struct Fixture {
    _dir: tempfile::TempDir,
    client: HostClient,
    store: Store,
    auth: AuthService,
    operator: AuthenticatedActor,
    provider: Arc<Provider>,
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
        let operator = auth
            .authenticate_user_control(
                &id("runtime-operator"),
                &ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap(),
            )
            .unwrap();
        let provider = Arc::new(Provider {
            host: store.identity().unwrap().host_id,
            opens: AtomicUsize::new(0),
        });
        let host = Host::with_device_provider(
            store.clone(),
            auth.clone(),
            Arc::new(serial_workbench_host::clock::SystemClock::new().unwrap()),
            provider.clone(),
        )
        .await
        .unwrap();
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
            id("runtime-client"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        let f = Self {
            _dir: dir,
            client,
            store,
            auth,
            operator,
            provider,
            stop,
            running,
        };
        f.auth
            .authorize(
                &f.operator,
                AuthorizeParams {
                    client_id: f.client.attachment().client_id.clone(),
                    permissions: vec![
                        "metadata.read".into(),
                        "device.modify".into(),
                        "workspace.modify".into(),
                    ],
                    targets: vec![f.host()],
                    expires_at: None,
                },
            )
            .unwrap();
        f
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
    fn target(&self, kind: &str, key: &str) -> Target {
        Target {
            kind: ResourceKind::try_from(kind).unwrap(),
            id: id(key),
            ..self.host()
        }
    }
    fn query(&self, target: &Target, action: &str, params: serde_json::Value) -> Query {
        let a = self.client.attachment();
        Query {
            protocol_version: ProtocolVersion::V0_1,
            host_id: a.host_id.clone(),
            instance_epoch: a.instance_epoch,
            actor_id: a.actor_id.clone(),
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
    async fn read(&self, target: &Target, action: &str) -> QueryResult {
        let RpcResult::Query(result) = success(
            self.client
                .request(RpcRequest::Query(self.query(target, action, json!({}))))
                .await
                .unwrap(),
        ) else {
            panic!("query")
        };
        result
    }
    async fn invoke(
        &self,
        target: &Target,
        action: &str,
        params: serde_json::Value,
        revision: Option<U64>,
    ) -> Operation {
        let q = self.query(target, action, params);
        let call = Call {
            protocol_version: q.protocol_version,
            host_id: q.host_id,
            instance_epoch: q.instance_epoch,
            actor_id: q.actor_id,
            request_id: q.request_id,
            request_context: self.client.attachment().request_context.clone(),
            action_id: q.action_id,
            target: q.target,
            params: q.params,
            reveal_target: q.reveal_target,
            expected_revision: revision,
            lease_id: None,
            execution_mode: None,
        };
        let RpcResult::Operation(result) =
            success(self.client.request(RpcRequest::Invoke(call)).await.unwrap())
        else {
            panic!("operation")
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = self
                    .store
                    .get(&self.operator, &result.operation.operation_id)
                    .unwrap();
                if !matches!(
                    current.state,
                    OperationState::Queued
                        | OperationState::Running
                        | OperationState::CancelRequested
                ) {
                    break current;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap()
    }
    fn workspace(&self) -> WorkspaceDocument {
        let binding = DeviceBinding {
            binding_id: id("binding"),
            host_id: self.host().host_id,
            device_id: id("old-device"),
            fingerprint: self.provider.enumerate().unwrap()[0].fingerprint.clone(),
            configuration: SerialConfiguration::default(),
            reconnect: ReconnectPolicy::default(),
        };
        WorkspaceDocument {
            bindings: vec![binding],
            ..WorkspaceDocument::default()
        }
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
    }
}
fn success(reply: RpcReply) -> RpcResult {
    let RpcReply::Success { result, .. } = reply else {
        panic!("unexpected failure: {reply:?}")
    };
    *result
}

#[tokio::test]
async fn host_directory_refresh_publishes_real_provider_snapshot_and_open_records_recent() {
    let f = Fixture::new().await;
    let QueryResult::Devices(devices) = f.read(&f.host(), "device.refresh").await else {
        panic!("devices")
    };
    let serial = devices
        .devices
        .iter()
        .find(|device| device.system_name == "COM42")
        .expect("injected provider directory");
    assert!(
        devices
            .devices
            .iter()
            .any(|device| device.device_id == id("virtual:echo"))
    );
    let target = f.target("device", serial.device_id.as_str());
    let opened = f
        .invoke(
            &target,
            "device.open",
            json!({"configuration":SerialConfiguration::default()}),
            None,
        )
        .await;
    assert_eq!(
        opened.state,
        OperationState::Succeeded,
        "{:?}",
        opened.error
    );
    assert_eq!(f.provider.opens.load(Ordering::SeqCst), 1);
    let QueryResult::Recent(recent) = f.read(&f.host(), "recent.list").await else {
        panic!("recent")
    };
    assert_eq!(recent.entries.len(), 1);
    assert_eq!(recent.entries[0].device_id, target.id);
    let query = f.query(
        &f.host(),
        "state.snapshot",
        json!({"scopeId":"host.devices"}),
    );
    let RpcResult::Query(QueryResult::Snapshot(snapshot)) =
        success(f.client.request(RpcRequest::Query(query)).await.unwrap())
    else {
        panic!("snapshot")
    };
    let published: DeviceList =
        serde_json::from_value(serde_json::to_value(snapshot.state).unwrap()).unwrap();
    assert_eq!(published, devices);
    let forged = f
        .invoke(
            &f.target("device", "COM42"),
            "device.open",
            json!({"configuration":SerialConfiguration::default()}),
            None,
        )
        .await;
    assert_eq!(forged.state, OperationState::Failed);
    assert_eq!(f.provider.opens.load(Ordering::SeqCst), 1);
    f.finish().await;
}

#[tokio::test]
async fn host_favorites_and_rebind_share_document_cas_and_preserve_binding_preferences() {
    let f = Fixture::new().await;
    let workspace = f.workspace();
    WorkspaceService::new(f.store.clone(), id("bench"))
        .save(0.into(), workspace.clone())
        .unwrap();
    let target = f.target("workspace", "bench");
    let favorites = f
        .invoke(
            &target,
            "favorites.save",
            json!({"bindingIds":["binding"]}),
            Some(1.into()),
        )
        .await;
    assert_eq!(
        favorites.state,
        OperationState::Succeeded,
        "{:?}",
        favorites.error
    );
    let Some(ActionResult::Workspace(saved)) = favorites.result else {
        panic!("workspace")
    };
    assert_eq!(saved.document.revision, U64::from(2));
    assert_eq!(
        saved.document.value.favorite_binding_ids,
        vec![id("binding")]
    );
    let rebound = f
        .invoke(
            &target,
            "device.rebind",
            json!({"bindingId":"binding","deviceId":"virtual:echo"}),
            Some(2.into()),
        )
        .await;
    assert_eq!(
        rebound.state,
        OperationState::Succeeded,
        "{:?}",
        rebound.error
    );
    let Some(ActionResult::Workspace(saved)) = rebound.result else {
        panic!("workspace")
    };
    assert_eq!(saved.document.revision, U64::from(3));
    assert_eq!(
        saved.document.value.bindings[0].device_id,
        id("virtual:echo")
    );
    assert_eq!(
        saved.document.value.bindings[0].configuration,
        workspace.bindings[0].configuration
    );
    assert_eq!(
        saved.document.value.bindings[0].reconnect,
        workspace.bindings[0].reconnect
    );
    let conflict = f
        .invoke(
            &target,
            "favorites.save",
            json!({"bindingIds":[]}),
            Some(2.into()),
        )
        .await;
    assert_eq!(conflict.error.unwrap().code, "REVISION_CONFLICT");
    assert_eq!(
        WorkspaceService::new(f.store.clone(), id("bench"))
            .read()
            .unwrap(),
        saved.document
    );
    assert_eq!(f.provider.opens.load(Ordering::SeqCst), 0);
    f.finish().await;
}

#[tokio::test]
async fn bound_open_resolves_current_workspace_and_requires_its_read_permission() {
    let f = Fixture::new().await;
    let mut workspace = f.workspace();
    workspace.bindings[0].device_id = id("virtual:echo");
    workspace.bindings[0].fingerprint = DeviceFingerprint {
        transport: DeviceTransportKind::Virtual,
        vid: None,
        pid: None,
        serial_number: Some("echo".into()),
        topology_path: None,
        evidence: IdentityEvidence::SerialNumber,
    };
    WorkspaceService::new(f.store.clone(), id("bench"))
        .save(0.into(), workspace)
        .unwrap();
    let target = f.target("device", "virtual:echo");
    let params = json!({"configuration":SerialConfiguration::default(),"binding":{"workspaceId":"bench","bindingId":"binding"}});
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.client.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![f.target("workspace", "bench")],
            },
        )
        .unwrap();
    let before = f.store.operation_metadata().unwrap();
    let q = f.query(&target, "device.open", params);
    let call = Call {
        protocol_version: q.protocol_version,
        host_id: q.host_id,
        instance_epoch: q.instance_epoch,
        actor_id: q.actor_id,
        request_id: q.request_id,
        request_context: f.client.attachment().request_context.clone(),
        action_id: q.action_id,
        target: q.target,
        params: q.params,
        reveal_target: q.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    };
    let reply = f.client.request(RpcRequest::Invoke(call)).await.unwrap();
    let RpcReply::Failure { error, .. } = reply else {
        panic!("expected admission denial: {reply:?}")
    };
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert_eq!(error.operation_id, None);
    assert_eq!(f.store.operation_metadata().unwrap(), before);
    f.finish().await;
}
