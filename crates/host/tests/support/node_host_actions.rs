//! 正式签名动作包的真实Host IPC夹具；所有业务仍走公开调用与结果读取。
use super as support;
use super::node_package::{archive, manifest, payloads, with_metadata};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::Digest;
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    clock::SystemClock,
    ipc::HostServer,
    node_runtime::{NodeRuntimeLimits, verify_node_runtime},
};
use sha2::{Digest as _, Sha256};
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
use tokio::sync::oneshot;

pub(crate) fn registry_copy_input(resources: usize, uri_bytes: usize, conditions: usize) -> Value {
    let mut definitions = (0..resources)
        .map(|index| {
            (
                format!("r{index}"),
                json!({"$id":format!("?v={index}"),"type":"object"}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    definitions.insert(
        "anchor".into(),
        json!({"$dynamicAnchor":"state","type":"object"}),
    );
    let mut dependencies = serde_json::Map::new();
    for index in 0..conditions {
        let name = if conditions == 1 {
            "options".into()
        } else {
            format!("options{index}")
        };
        let reference = format!("{name}.json");
        definitions.insert(name, json!({"$id":reference,"if":{"type":"object"},"then":{"properties":{"value":{"default":7}}}}));
        dependencies.insert(
            if conditions == 1 {
                "trigger".into()
            } else {
                format!("p{index}")
            },
            json!({"$ref":reference}),
        );
    }
    let mut properties = serde_json::Map::from_iter([("value".into(), json!({"type":"integer"}))]);
    if conditions == 1 {
        properties.insert("trigger".into(), json!({"type":"boolean"}));
    }
    json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$id":format!("https://registry-copy.example.invalid/{}", "x".repeat(uri_bytes)),
        "$defs":definitions,"type":"object","properties":properties,"required":["value"],
        "additionalProperties":if conditions == 1 { json!(false) } else { json!({"type":"boolean"}) },
        "dependentSchemas":dependencies
    })
}

pub(crate) struct Fixture {
    pub(crate) host: Host,
    pub(crate) client: HostClient,
    pub(crate) user: HostClient,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
    pub(crate) target: Target,
    pub(crate) archive: Digest,
    pub(crate) dir: support::Profile,
}
pub(crate) fn spec() -> ActionSpec {
    let mut spec = BuiltinAction::HostShutdown.spec().clone();
    spec.action_id = support::id("example.terminal.compute");
    spec.permissions = vec!["content.read".into()];
    spec.cancellation = Cancellation::Cooperative;
    spec.state_scopes.clear();
    spec.event_types.clear();
    spec.reveal_target = serde_json::from_value(json!({"pageId":"workbench"})).unwrap();
    spec.input_schema=serde_json::from_value(json!({"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false})).unwrap();
    spec.output_schema=serde_json::from_value(json!({"type":"object","properties":{"value":{"type":"number"},"calls":{"type":"integer"}},"required":["value","calls"],"additionalProperties":false})).unwrap();
    spec
}
impl Fixture {
    pub(crate) async fn new() -> Self {
        Self::program(spec(),b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({value:call.params.value+0.25,calls:++calls}));return ()=>{};}").await
    }
    pub(crate) async fn program(spec: ActionSpec, source: &[u8]) -> Self {
        Self::installed_program(spec, source).await.enabled().await
    }
    pub(crate) async fn program_with_virtual(spec: ActionSpec, source: &[u8]) -> Self {
        Self::installed_program_with_opener(
            spec,
            source,
            vec![
                "plugins.manage".into(),
                "content.read".into(),
                "device.modify".into(),
            ],
            vec![support::id("startup")],
            serial_workbench_host::device::DeviceService::virtual_opener(),
        )
        .await
        .enabled()
        .await
    }
    pub(crate) async fn program_with_client_permissions(
        spec: ActionSpec,
        source: &[u8],
        permissions: Vec<String>,
    ) -> Self {
        Self::installed_program_with_permissions(
            spec,
            source,
            permissions,
            vec![support::id("startup")],
        )
        .await
        .enabled()
        .await
    }
    async fn enabled(self) -> Self {
        let fixture = self;
        let enabled = fixture
            .mutate(
                &fixture.client,
                "node.packages.setEnabled",
                json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
                2,
            )
            .await;
        assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
        fixture
    }
    pub(crate) async fn installed_program(spec: ActionSpec, source: &[u8]) -> Self {
        Self::installed_program_with_activation(spec, source, vec![support::id("startup")]).await
    }
    pub(crate) async fn installed_program_with_activation(
        spec: ActionSpec,
        source: &[u8],
        activation: Vec<Id>,
    ) -> Self {
        Self::installed_program_with_permissions(
            spec,
            source,
            vec![
                "plugins.manage".into(),
                "content.read".into(),
                "device.modify".into(),
            ],
            activation,
        )
        .await
    }
    async fn installed_program_with_permissions(
        spec: ActionSpec,
        source: &[u8],
        permissions: Vec<String>,
        activation: Vec<Id>,
    ) -> Self {
        Self::installed_program_with_opener(
            spec,
            source,
            permissions,
            activation,
            Arc::new(|_, _| {
                Err(HostError::new(
                    "DEVICE_NOT_FOUND",
                    "No physical transport in this Host API fixture",
                )
                .into())
            }),
        )
        .await
    }
    async fn installed_program_with_opener(
        spec: ActionSpec,
        source: &[u8],
        permissions: Vec<String>,
        activation: Vec<Id>,
        opener: serial_workbench_host::device::TransportOpener,
    ) -> Self {
        let mut fixture = Self::connected(permissions, opener).await;
        fixture.approve_test_source().await;
        let mut metadata = manifest();
        metadata["activation"] = json!(activation);
        metadata["permissions"]["hostApi"] =
            json!([{"permissions":spec.permissions,"targetKinds":spec.target_kinds}]);
        metadata["contributes"][if spec.kind == ActionKind::Query {
            "queries"
        } else {
            "actions"
        }] = json!([spec]);
        let mut files = payloads();
        files.insert(
            "manifest.json".into(),
            serde_json::to_vec(&metadata).unwrap(),
        );
        files.insert("dist/main.mjs".into(), source.to_vec());
        let path = fixture.dir.path().join("signed-actions.zip");
        std::fs::write(&path, archive(&with_metadata(files, true))).unwrap();
        let installed = fixture
            .install_archive(
                &path,
                json!({"kind":"trusted","source":"test-source","keyId":"test-key"}),
            )
            .await;
        assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
        let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
            panic!("Expected package")
        };
        fixture.archive = installed.package.archive_sha256;
        let confirmed = fixture
            .mutate(
                &fixture.user,
                "node.packages.confirmExecutionTrust",
                json!({"id":"example.terminal","archiveSha256":fixture.archive}),
                1,
            )
            .await;
        assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
        fixture
    }
    pub(crate) async fn connected(
        permissions: Vec<String>,
        opener: serial_workbench_host::device::TransportOpener,
    ) -> Self {
        let runtime = tokio::task::spawn_blocking(|| {
            verify_node_runtime(
                std::path::Path::new(&std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap()),
                &NodeRuntimeLimits::default(),
                &AtomicBool::new(false),
            )
            .unwrap()
        })
        .await
        .unwrap();
        let dir = support::Profile::isolated("host-node-backend-public-");
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        let store = server.store();
        let auth = server.auth();
        let secret =
            serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
                .unwrap()
                .unwrap();
        let credential = ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap();
        let operator = auth
            .authenticate_user_control(&support::id("action-user"), &credential)
            .unwrap();
        let host = Host::with_verified_node_runtime(
            store,
            auth.clone(),
            Arc::new(SystemClock::new().unwrap()),
            opener,
            runtime,
        )
        .await
        .unwrap();
        let (stop, done) = oneshot::channel();
        let running_host = host.clone();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(running_host), async {
                    let _ = done.await;
                })
                .await
        });
        let client = HostClient::connect(ConnectOptions::new(
            dir.path().to_path_buf(),
            support::id("action-client"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        let mut options = ConnectOptions::new(
            dir.path().to_path_buf(),
            support::id("action-user"),
            ClientKind::Desktop,
        );
        options.user_control_credential = Some(credential);
        let user = HostClient::connect(options).await.unwrap();
        let target = Target {
            host_id: client.attachment().host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: client.attachment().host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: client.attachment().client_id.clone(),
                permissions,
                targets: vec![target.clone()],
                expires_at: None,
            },
        )
        .unwrap();
        Self {
            host,
            client,
            user,
            stop,
            running,
            target,
            archive: Digest::try_from("0".repeat(64).as_str()).unwrap(),
            dir,
        }
    }
    pub(crate) async fn approve_test_source(&self) {
        let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
        let key_digest = Digest::try_from(format!("{:x}", Sha256::digest(key)).as_str()).unwrap();
        let approved=self.mutate(&self.user,"node.sources.approveKey",json!({"source":"test-source","keyId":"test-key","publicKey":key,"publicKeySha256":key_digest}),0).await;
        assert_eq!(approved.state, OperationState::Succeeded, "{approved:?}");
    }
    pub(crate) async fn install_archive(&self, path: &std::path::Path, source: Value) -> Operation {
        let registered = self
            .invoke(
                &self.user,
                self.call(
                    &self.user,
                    &self.target,
                    "file.register",
                    json!({"path":path.to_str().unwrap(),"purpose":"read_file"}),
                ),
            )
            .await;
        let registered = self.wait(&self.user, &registered.operation_id).await;
        let Some(ActionResult::FileMetadata(reference)) = registered.result else {
            panic!("Expected registered archive");
        };
        self.mutate(
            &self.client,
            "node.packages.install",
            json!({"archiveRef":reference.file_ref,"source":source}),
            0,
        )
        .await
    }
    pub(crate) fn query_call(
        &self,
        client: &HostClient,
        target: &Target,
        action: &str,
        params: Value,
    ) -> Query {
        let a = client.attachment();
        Query {
            protocol_version: ProtocolVersion::V1_0,
            host_id: a.host_id.clone(),
            instance_epoch: a.instance_epoch,
            actor_id: a.actor_id.clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            action_id: support::id(action),
            target: target.clone(),
            params: serde_json::from_value(params).unwrap(),
            reveal_target: serde_json::from_value(json!({"pageId":"workbench"})).unwrap(),
        }
    }
    pub(crate) fn call(
        &self,
        client: &HostClient,
        target: &Target,
        action: &str,
        params: Value,
    ) -> Call {
        let q = self.query_call(client, target, action, params);
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
            execution_mode: Some(ExecutionMode::Independent),
        }
    }
    pub(crate) async fn query(
        &self,
        client: &HostClient,
        target: &Target,
        action: &str,
        params: Value,
    ) -> QueryResult {
        let RpcResult::Query(result) = success(
            client
                .request(RpcRequest::Query(
                    self.query_call(client, target, action, params),
                ))
                .await
                .unwrap(),
        ) else {
            panic!("Expected query")
        };
        result
    }
    pub(crate) async fn invoke(&self, client: &HostClient, call: Call) -> Operation {
        let RpcResult::Operation(result) =
            success(client.request(RpcRequest::Invoke(call)).await.unwrap())
        else {
            panic!("Expected operation")
        };
        result.operation
    }
    pub(crate) async fn mutate(
        &self,
        client: &HostClient,
        action: &str,
        params: Value,
        revision: u64,
    ) -> Operation {
        let mut call = self.call(client, &self.target, action, params);
        call.expected_revision = Some(revision.into());
        let accepted = self.invoke(client, call).await;
        self.wait(client, &accepted.operation_id).await
    }
    pub(crate) async fn wait(&self, client: &HostClient, id: &Id) -> Operation {
        self.wait_with_budget(client, id, Duration::from_secs(5))
            .await
    }
    pub(crate) async fn wait_with_budget(
        &self,
        client: &HostClient,
        id: &Id,
        budget: Duration,
    ) -> Operation {
        let mut last_observed = None;
        tokio::time::timeout(budget, async {
            loop {
                let QueryResult::Operation(value) = self
                    .query(
                        client,
                        &self.target,
                        "operation.get",
                        json!({"operationId":id}),
                    )
                    .await
                else {
                    panic!("Expected operation")
                };
                last_observed = Some((
                    value.operation.action_id.clone(),
                    value.operation.state,
                    value.operation.revision.to_string(),
                ));
                if value.operation.state.is_terminal() {
                    return value.operation;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!("Actual public operation did not settle: last_observed={last_observed:?}")
        })
    }
    pub(crate) async fn result(&self, client: &HostClient, operation: &Operation) -> Value {
        let Some(ActionResult::Reference(result)) = &operation.result else {
            panic!("Expected controlled result: {operation:?}")
        };
        let reference = &result.result_ref;
        let target = Target {
            host_id: reference.host_id.clone(),
            kind: reference.kind.clone(),
            id: reference.id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let raw = client.connect_raw().await.unwrap();
        let RpcResult::Query(QueryResult::FileRead(read)) = success(
            raw.request(RpcRequest::Query(self.query_call(
                client,
                &target,
                "file.read",
                json!({"fileRef":reference,"offset":"0","maxBytes":"65536"}),
            )))
            .await
            .unwrap(),
        ) else {
            panic!("Expected result bytes")
        };
        assert!(read.at_end);
        serde_json::from_slice(&STANDARD.decode(read.bytes_base64.as_str()).unwrap()).unwrap()
    }
    pub(crate) async fn finish(self) -> support::Profile {
        let _ = self.stop.send(());
        self.running.await.unwrap().unwrap();
        self.dir
    }
}
fn success(reply: RpcReply) -> RpcResult {
    let RpcReply::Success { result, .. } = reply else {
        panic!("Expected success: {reply:?}")
    };
    *result
}
