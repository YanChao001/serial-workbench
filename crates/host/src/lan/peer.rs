use super::LanOrigin;
use super::{
    CONNECT_DEADLINE, LanIdentity, LanPeer, LanServer, LanShare, connection_error, protocol_error,
};
use crate::auth::{AuthService, AuthenticatedActor, HostIdentity};
use serde::{Deserialize, Serialize};
use serial_workbench_core::{Digest, HostError, HostResult, Id, U64};
use serial_workbench_ipc::frame::{read_json_frame, write_json_frame};
use std::{collections::HashMap, net::SocketAddr, path::Path};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    time::timeout,
};
use tokio_rustls::{client, server};

const MAX_HELLO_BYTES: usize = 1024;

pub struct LanEndpoint {
    identity: LanIdentity,
    hello: Hello,
    auth: AuthService,
}

pub struct LanAdmission {
    tls: LanServer,
    hello: Hello,
    approved: HashMap<Digest, Id>,
    auth: AuthService,
}

#[derive(Debug)]
pub struct LanConnection<S> {
    pub peer: LanPeer,
    pub instance_epoch: U64,
    pub stream: S,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hello {
    host_id: Id,
    instance_epoch: U64,
}

impl LanEndpoint {
    pub(crate) fn load(
        namespace: &Path,
        identity: HostIdentity,
        auth: AuthService,
    ) -> HostResult<Self> {
        Ok(Self {
            identity: LanIdentity::load_or_create(namespace)?,
            hello: Hello {
                host_id: identity.host_id,
                instance_epoch: identity.instance_epoch,
            },
            auth,
        })
    }

    pub fn peer(&self) -> LanPeer {
        LanPeer {
            host_id: self.hello.host_id.clone(),
            fingerprint: self.identity.fingerprint().clone(),
        }
    }

    pub(crate) async fn local_origin(
        &self,
        actor: Option<&AuthenticatedActor>,
    ) -> HostResult<Option<LanOrigin>> {
        let Some(actor) = actor else {
            return Ok(None);
        };
        let origin = actor.local_lan_origin()?;
        let auth = self.auth.clone();
        let actor = actor.clone();
        tokio::task::spawn_blocking(move || {
            if auth.snapshot(&actor)?.is_lan_peer() {
                return Err(HostError::new(
                    "PERMISSION_DENIED",
                    "LAN routing requires a local client identity",
                ));
            }
            Ok(Some(origin))
        })
        .await
        .map_err(|_| connection_error())?
    }

    pub fn set_shares(
        &self,
        operator: &AuthenticatedActor,
        peer: LanPeer,
        shares: &[LanShare],
    ) -> HostResult<()> {
        self.check_peer(&peer)?;
        self.auth.set_lan_shares(operator, peer, shares)
    }

    pub fn unpair(&self, operator: &AuthenticatedActor, peer: &LanPeer) -> HostResult<()> {
        self.auth.unpair_lan(operator, peer)
    }

    pub fn admission(&self) -> HostResult<LanAdmission> {
        let mut approved = HashMap::new();
        for peer in self.auth.lan_peers()? {
            self.check_peer(&peer)?;
            if approved.values().any(|id| id == &peer.host_id)
                || approved.insert(peer.fingerprint, peer.host_id).is_some()
            {
                return Err(HostError::new(
                    "LAN_PEER_CONFLICT",
                    "A trusted key or Host ID is already paired",
                ));
            }
        }
        Ok(LanAdmission {
            tls: self.identity.server(approved.keys().cloned().collect())?,
            hello: self.hello.clone(),
            approved,
            auth: self.auth.clone(),
        })
    }

    pub async fn connect(
        &self,
        address: SocketAddr,
        peer_host_id: &Id,
    ) -> HostResult<LanConnection<client::TlsStream<TcpStream>>> {
        let auth = self.auth.clone();
        let peer_host_id = peer_host_id.clone();
        let peer = tokio::task::spawn_blocking(move || {
            auth.lan_peers()?
                .into_iter()
                .find(|peer| peer.host_id == peer_host_id)
                .ok_or_else(super::authentication_error)
        })
        .await
        .map_err(|_| connection_error())??;
        let mut stream = self
            .identity
            .client(peer.fingerprint.clone())?
            .connect(address)
            .await?;
        let hello = timeout(CONNECT_DEADLINE, async {
            send_hello(&mut stream, &self.hello).await?;
            receive_hello(&mut stream, &peer.host_id).await
        })
        .await
        .map_err(|_| connection_error())??;
        Ok(LanConnection {
            peer,
            instance_epoch: hello.instance_epoch,
            stream,
        })
    }

    fn check_peer(&self, peer: &LanPeer) -> HostResult<()> {
        if peer.host_id == self.hello.host_id || &peer.fingerprint == self.identity.fingerprint() {
            return Err(host_mismatch());
        }
        Ok(())
    }
}

impl LanAdmission {
    pub async fn accept(
        &self,
        socket: TcpStream,
    ) -> HostResult<(
        AuthenticatedActor,
        LanConnection<server::TlsStream<TcpStream>>,
    )> {
        let (fingerprint, mut stream) = self.tls.accept(socket).await?;
        let host_id = self.approved.get(&fingerprint).ok_or_else(host_mismatch)?;
        // 只有发起方的 Host ID 与受信公钥对应时，才确认连接。
        let (peer, epoch, actor) = timeout(CONNECT_DEADLINE, async {
            let hello = receive_hello(&mut stream, host_id).await?;
            let peer = LanPeer {
                host_id: hello.host_id,
                fingerprint,
            };
            let authenticated_peer = peer.clone();
            let auth = self.auth.clone();
            let actor =
                tokio::task::spawn_blocking(move || auth.authenticate_lan(&authenticated_peer))
                    .await
                    .map_err(|_| connection_error())??;
            send_hello(&mut stream, &self.hello).await?;
            Ok((peer, hello.instance_epoch, actor))
        })
        .await
        .map_err(|_| connection_error())??;
        Ok((
            actor,
            LanConnection {
                peer,
                instance_epoch: epoch,
                stream,
            },
        ))
    }
}

async fn send_hello(stream: &mut (impl AsyncWrite + Unpin), hello: &Hello) -> HostResult<()> {
    write_json_frame(stream, hello, MAX_HELLO_BYTES)
        .await
        .map_err(|_| connection_error())
}

async fn receive_hello(stream: &mut (impl AsyncRead + Unpin), expected: &Id) -> HostResult<Hello> {
    let hello: Hello = read_json_frame(stream, MAX_HELLO_BYTES)
        .await
        .map_err(|error| match error.code.as_str() {
            "UNAUTHENTICATED" => connection_error(),
            _ => protocol_error(),
        })?
        .ok_or_else(connection_error)?;
    if hello.instance_epoch.get() == 0 {
        return Err(protocol_error());
    }
    if &hello.host_id != expected {
        return Err(host_mismatch());
    }
    Ok(hello)
}

fn host_mismatch() -> HostError {
    HostError::new(
        "LAN_HOST_ID_MISMATCH",
        "The Host identity does not match the pairing",
    )
}
