use super::protocol::blocking;
use crate::{
    auth::{AuthService, AuthenticatedActor, GrantStamp, HostIdentity},
    lan::LanEndpoint,
};
use serial_workbench_core::*;
use serial_workbench_ipc::LocalStream;
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::{net::TcpStream, sync::watch, time::timeout};
use tokio_rustls::client::TlsStream;

pub(super) type PeerStream = TlsStream<TcpStream>;

#[derive(Clone)]
pub(super) struct LanEndpoints {
    namespace: PathBuf,
    identity: HostIdentity,
    pub(super) auth: AuthService,
    cached: Arc<Mutex<Option<Arc<LanEndpoint>>>>,
}

impl LanEndpoints {
    pub(super) fn new(namespace: PathBuf, identity: HostIdentity, auth: AuthService) -> Self {
        Self {
            namespace,
            identity,
            auth,
            cached: Default::default(),
        }
    }

    pub(super) async fn get(&self) -> HostResult<Arc<LanEndpoint>> {
        let endpoints = self.clone();
        blocking(move || {
            // 保持锁到密钥落盘，即使发起附着的客户端已经退出。
            let mut cached = endpoints.cached.lock().map_err(|_| unavailable())?;
            if let Some(endpoint) = &*cached {
                return Ok(endpoint.clone());
            }
            let endpoint = Arc::new(LanEndpoint::load(
                &endpoints.namespace,
                endpoints.identity,
                endpoints.auth,
            )?);
            *cached = Some(endpoint.clone());
            Ok(endpoint)
        })
        .await
    }

    pub(super) async fn route(
        &self,
        route: LanRoute,
        mut actor: AuthenticatedActor,
        kind: ClientKind,
    ) -> HostResult<(LanRelay, PeerStream)> {
        let scope = route.authorization_target(&self.identity.host_id);
        let address = route.socket_address()?;
        if kind == ClientKind::Mcp {
            actor.observe_as_mcp();
        }
        let endpoint_actor = actor.clone();
        let endpoint_scope = scope.clone();
        let auth = self.auth.clone();
        let grant = blocking(move || {
            auth.snapshot(&endpoint_actor)?
                .capture_bound_grants(&[(LAN_CONNECT_PERMISSION, &endpoint_scope)])
        })
        .await?;
        let endpoint = self.get().await?;
        let origin = endpoint.local_origin(Some(&actor)).await?;
        let mut remote = endpoint.connect(address, &route.host_id).await?;
        let (client_id, raw_token) = remote.open_control(origin).await?;
        let peer = remote.peer.clone();
        let auth = self.auth.clone();
        let pairing = blocking(move || auth.authenticate_lan(&peer)).await?;
        let relay = LanRelay {
            endpoint,
            auth: self.auth.clone(),
            actor,
            grant,
            peer: remote.peer,
            pairing_id: pairing.id().clone(),
            address,
            instance_epoch: remote.instance_epoch,
            client_id,
            raw_token,
        };
        relay.check().await?;
        Ok((relay, remote.stream))
    }
}

#[derive(Clone)]
pub(super) struct LanRelay {
    endpoint: Arc<LanEndpoint>,
    auth: AuthService,
    actor: AuthenticatedActor,
    grant: GrantStamp,
    peer: LanPeer,
    pairing_id: Id,
    address: SocketAddr,
    instance_epoch: U64,
    client_id: Id,
    raw_token: ContextToken,
}

impl LanRelay {
    pub(super) fn receipt(&self) -> IpcMessage {
        IpcMessage::LanRouted {
            host_id: self.peer.host_id.clone(),
            instance_epoch: self.instance_epoch,
            client_id: self.client_id.clone(),
        }
    }

    pub(super) async fn raw(&self) -> HostResult<PeerStream> {
        timeout(LAN_ATTACH_TIMEOUT, async {
            self.check().await?;
            let origin = self.endpoint.local_origin(Some(&self.actor)).await?;
            let mut remote = self
                .endpoint
                .connect(self.address, &self.peer.host_id)
                .await?;
            if remote.peer != self.peer || remote.instance_epoch != self.instance_epoch {
                return Err(HostError::new(
                    "EPOCH_MISMATCH",
                    "The paired Host changed before Raw attached",
                ));
            }
            remote.open_raw(self.raw_token.clone(), origin).await?;
            self.check().await?;
            Ok(remote.stream)
        })
        .await
        .map_err(|_| unavailable())?
    }

    pub(super) async fn forward(
        &self,
        mut local: LocalStream,
        mut remote: PeerStream,
        mut alive: watch::Receiver<bool>,
    ) {
        if !*alive.borrow_and_update() {
            return;
        }
        let mut changes = self.auth.subscribe_changes();
        let transfer = tokio::io::copy_bidirectional(&mut local, &mut remote);
        tokio::pin!(transfer);
        while self.check().await.is_ok() {
            // 验权时暂停两向转发，保留已读取的字节以便无关授权变更后继续。
            let recheck = tokio::select! {
                biased;
                _ = alive.changed() => false,
                change = changes.changed() => change.is_ok(),
                _ = self.auth.wait_grant_expiry(Some(&self.grant)) => false,
                _ = &mut transfer => false,
            };
            if !recheck {
                return;
            }
        }
    }

    async fn check(&self) -> HostResult<()> {
        let relay = self.clone();
        blocking(move || {
            relay.auth.validate_grants(&relay.grant)?;
            let pairing = relay.auth.authenticate_lan(&relay.peer)?;
            if pairing.id() != &relay.pairing_id {
                return Err(HostError::new(
                    "ACTOR_MISMATCH",
                    "The LAN route pairing changed",
                ));
            }
            Ok(())
        })
        .await
    }
}

pub(super) fn unavailable() -> HostError {
    HostError::new("LAN_UNAVAILABLE", "The LAN route is unavailable")
}
