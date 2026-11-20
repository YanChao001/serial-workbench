use super::{CONNECT_DEADLINE, LanEndpoint, LanPeer, connection_error, protocol_error};
use crate::auth::AuthenticatedActor;
use serial_workbench_client::{ControlConnection, RawConnection};
use serial_workbench_core::{
    BuiltinAction, ClientKind, ContextToken, HostError, HostResult, Id, Query, QueryResult,
    RequestId, ResourceKind, RpcReply, RpcRequest, RpcResult, StateScopesResult, Target,
};
use std::net::SocketAddr;
use tokio::{net::TcpStream, time::timeout};
use tokio_rustls::client::TlsStream;

pub struct LanHostClient {
    local_peer: LanPeer,
    address: SocketAddr,
    control: ControlConnection<TlsStream<TcpStream>>,
    raw_token: ContextToken,
    source: Option<AuthenticatedActor>,
}

impl LanEndpoint {
    pub async fn connect_host(
        &self,
        address: SocketAddr,
        peer_host_id: &Id,
    ) -> HostResult<LanHostClient> {
        self.connect_with_source(address, peer_host_id, None).await
    }

    /// 由 A 的路由入口传入已认证并获准使用该路由的本机客户端。
    pub async fn connect_client(
        &self,
        address: SocketAddr,
        peer_host_id: &Id,
        source: &AuthenticatedActor,
    ) -> HostResult<LanHostClient> {
        self.connect_with_source(address, peer_host_id, Some(source))
            .await
    }

    async fn connect_with_source(
        &self,
        address: SocketAddr,
        peer_host_id: &Id,
        source: Option<&AuthenticatedActor>,
    ) -> HostResult<LanHostClient> {
        let origin = self.local_origin(source).await?;
        let mut remote = self.connect(address, peer_host_id).await?;
        let (client_id, raw_token) = remote.open_control(origin).await?;
        let control = timeout(
            CONNECT_DEADLINE,
            ControlConnection::attach_authenticated(
                remote.stream,
                ClientKind::Peer,
                client_id,
                &remote.peer.host_id,
                remote.instance_epoch,
            ),
        )
        .await
        .map_err(|_| connection_error())??;
        Ok(LanHostClient {
            local_peer: self.peer(),
            address,
            control,
            raw_token,
            source: source.cloned(),
        })
    }
}

impl LanHostClient {
    pub fn control(&self) -> &ControlConnection<TlsStream<TcpStream>> {
        &self.control
    }

    pub async fn visible_scopes(&self) -> HostResult<StateScopesResult> {
        let attached = self.control.attachment();
        let spec = BuiltinAction::StateScopes.spec();
        let request_id = RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())?;
        let reply = self
            .control
            .request(RpcRequest::Query(Query {
                protocol_version: attached.protocol_version,
                host_id: attached.host_id.clone(),
                instance_epoch: attached.instance_epoch,
                actor_id: attached.actor_id.clone(),
                request_id,
                action_id: spec.action_id.clone(),
                target: Target {
                    host_id: attached.host_id.clone(),
                    kind: ResourceKind::try_from("host")?,
                    id: attached.host_id.clone(),
                    session_id: None,
                    session_epoch: None,
                },
                params: Default::default(),
                reveal_target: spec.reveal_target.clone(),
            }))
            .await?;
        match reply {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Query(QueryResult::Scopes(visible)) => Ok(visible),
                _ => Err(protocol_error()),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }

    pub async fn connect_raw(
        &self,
        endpoint: &LanEndpoint,
    ) -> HostResult<RawConnection<TlsStream<TcpStream>>> {
        self.require_same_profile(endpoint)?;
        let origin = endpoint.local_origin(self.source.as_ref()).await?;
        let attached = self.control.attachment();
        let mut remote = endpoint.connect(self.address, &attached.host_id).await?;
        if remote.instance_epoch != attached.instance_epoch {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "The remote Host restarted before Raw attached",
            ));
        }
        remote.open_raw(self.raw_token.clone(), origin).await?;
        Ok(RawConnection::from_authenticated_stream(remote.stream))
    }

    pub async fn reconnect(&self, endpoint: &LanEndpoint) -> HostResult<Self> {
        self.require_same_profile(endpoint)?;
        let reconnected = endpoint
            .connect_with_source(
                self.address,
                &self.control.attachment().host_id,
                self.source.as_ref(),
            )
            .await?;
        if reconnected.control.attachment().actor_id != self.control.attachment().actor_id {
            return Err(HostError::new(
                "ACTOR_MISMATCH",
                "The paired actor changed while reconnecting",
            ));
        }
        Ok(reconnected)
    }

    fn require_same_profile(&self, endpoint: &LanEndpoint) -> HostResult<()> {
        if endpoint.peer() != self.local_peer {
            return Err(HostError::new(
                "LAN_HOST_ID_MISMATCH",
                "The local Host does not own this LAN connection",
            ));
        }
        Ok(())
    }
}
