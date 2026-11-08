//! Real IPC startup facts: explicit injection, unavailable library facts and current rights.
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

struct Fixture {
    _profile: tempfile::TempDir,
    client: HostClient,
    auth: serial_workbench_host::auth::AuthService,
    operator: serial_workbench_host::auth::AuthenticatedActor,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl Fixture {
    async fn new(snapshot: Option<StartupConfigSnapshot>) -> Self {
        let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(profile.path()).await.unwrap();
        let auth = server.auth();
        let credential =
            serial_workbench_client::read_user_control_credential(profile.path()).unwrap();
        let operator = auth
            .authenticate_user_control(&id("startup-control"), &credential)
            .unwrap();
        let host = match snapshot {
            Some(snapshot) => Host::with_startup_config(server.store(), auth.clone(), snapshot)
                .await
                .unwrap(),
            None => Host::new(server.store(), auth.clone()).await.unwrap(),
        };
        let (stop, stopped) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = stopped.await;
                })
                .await
        });
        let client = HostClient::connect(ConnectOptions::new(
            profile.path().into(),
            id("startup-reader"),
            ClientKind::Desktop,
        ))
        .await
        .unwrap();
        Self {
            _profile: profile,
            client,
            auth,
            operator,
            stop,
            running,
        }
    }
    fn target(&self) -> Target {
        Target {
            host_id: self.client.attachment().host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: self.client.attachment().host_id.clone(),
            session_id: None,
            session_epoch: None,
        }
    }
    fn query(&self, params: serde_json::Value) -> Query {
        let a = self.client.attachment();
        Query {
            protocol_version: a.protocol_version,
            host_id: a.host_id.clone(),
            instance_epoch: a.instance_epoch,
            actor_id: a.actor_id.clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            action_id: id("startup.config.get"),
            target: self.target(),
            params: serde_json::from_value(params).unwrap(),
            reveal_target: RevealTarget {
                page_id: id("settings"),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
        }
    }
    async fn read(&self) -> RpcReply {
        self.client
            .request(RpcRequest::Query(self.query(serde_json::json!({}))))
            .await
            .unwrap()
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(8), self.running)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
fn snapshot() -> StartupConfigSnapshot {
    StartupConfigSnapshot {
        profile_reference: StartupProfileReference::HostProfile,
        profile_source: StartupConfigSource::Argument,
        log_level: StartupLogLevel::Debug,
        log_level_source: StartupConfigSource::Environment,
    }
}
fn error(reply: RpcReply) -> HostError {
    match reply {
        RpcReply::Failure { error, .. } => error,
        other => panic!("expected error, got {other:?}"),
    }
}

#[tokio::test]
async fn actual_host_returns_only_injected_startup_facts() {
    let expected = snapshot();
    let f = Fixture::new(Some(expected.clone())).await;
    let RpcReply::Success { result, .. } = f.read().await else {
        panic!("startup query failed")
    };
    let RpcResult::Query(result) = *result else {
        panic!("typed query result")
    };
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["kind"], "startup_config");
    assert_eq!(value["value"], serde_json::to_value(expected).unwrap());
    let bytes = serde_json::to_string(&value).unwrap();
    assert!(!bytes.contains(f._profile.path().to_str().unwrap()));
    assert!(!bytes.contains("credential"));
    assert_eq!(
        error(
            f.client
                .request(RpcRequest::Query(
                    f.query(serde_json::json!({"extra":true}))
                ))
                .await
                .unwrap()
        )
        .code,
        "INVALID_ARGUMENT"
    );
    f.finish().await;
}

#[tokio::test]
async fn library_host_has_no_fabricated_process_configuration() {
    let f = Fixture::new(None).await;
    assert_eq!(error(f.read().await).code, "STARTUP_CONFIG_UNAVAILABLE");
    f.finish().await;
}

#[tokio::test]
async fn startup_configuration_requires_current_business_metadata_read() {
    let f = Fixture::new(Some(snapshot())).await;
    assert!(matches!(f.read().await, RpcReply::Success { .. }));
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.client.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![f.target()],
            },
        )
        .unwrap();
    assert_eq!(error(f.read().await).code, "PERMISSION_DENIED");
    f.auth
        .authorize(
            &f.operator,
            AuthorizeParams {
                client_id: f.client.attachment().client_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![f.target()],
                expires_at: None,
            },
        )
        .unwrap();
    assert!(matches!(f.read().await, RpcReply::Success { .. }));
    f.finish().await;
}
