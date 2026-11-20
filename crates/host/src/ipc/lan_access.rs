use super::{
    lan_route::LanEndpoints,
    protocol::{blocking, busy, unauthenticated},
};
use crate::{
    auth::AuthenticatedActor,
    lan::{LanAdmission, LanEndpoint},
};
use serial_workbench_core::{
    HostError, HostResult, LanAccessParams, LanAccessResult, LanListenerState,
};
use std::{future::pending, io, net::SocketAddr, sync::Arc};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch},
};

pub(super) struct LanCommand {
    pub operator: AuthenticatedActor,
    pub params: LanAccessParams,
    pub reply: oneshot::Sender<HostResult<LanAccessResult>>,
}

pub(super) async fn request_access(
    commands: Option<&mpsc::Sender<LanCommand>>,
    operator: AuthenticatedActor,
    params: LanAccessParams,
) -> HostResult<LanAccessResult> {
    let commands = commands.ok_or_else(unauthenticated)?;
    let (reply, result) = oneshot::channel();
    commands
        .try_send(LanCommand {
            operator,
            params,
            reply,
        })
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => busy(),
            mpsc::error::TrySendError::Closed(_) => unavailable(),
        })?;
    result.await.map_err(|_| unavailable())?
}

struct Listener {
    socket: TcpListener,
    admission: Arc<LanAdmission>,
    requested: SocketAddr,
    address: SocketAddr,
    lifetime: watch::Sender<()>,
}

pub(super) struct LanAccess {
    endpoints: LanEndpoints,
    listener: Option<Listener>,
}

impl LanAccess {
    pub(super) fn new(endpoints: LanEndpoints) -> Self {
        Self {
            endpoints,
            listener: None,
        }
    }

    pub(super) async fn accept(
        &self,
    ) -> io::Result<(TcpStream, Arc<LanAdmission>, watch::Receiver<()>)> {
        let Some(listener) = &self.listener else {
            return pending().await;
        };
        let (stream, _) = listener.socket.accept().await?;
        Ok((
            stream,
            listener.admission.clone(),
            listener.lifetime.subscribe(),
        ))
    }

    pub(super) fn stop(&mut self) {
        self.listener = None;
    }

    pub(super) async fn manage(
        &mut self,
        operator: AuthenticatedActor,
        params: LanAccessParams,
    ) -> HostResult<LanAccessResult> {
        let auth = self.endpoints.auth.clone();
        let local = operator.clone();
        blocking(move || auth.require_control(&local)).await?;
        let endpoint = self.endpoints.get().await?;
        match params {
            LanAccessParams::Status {} => {}
            LanAccessParams::Enable { address } => {
                let requested: SocketAddr = address.parse().map_err(|_| {
                    HostError::new(
                        "INVALID_ARGUMENT",
                        "Enter a numeric IPv4 or IPv6 listen address and port",
                    )
                })?;
                if self
                    .listener
                    .as_ref()
                    .is_none_or(|listener| listener.requested != requested)
                {
                    let socket = TcpListener::bind(requested)
                        .await
                        .map_err(|_| bind_error())?;
                    let address = socket.local_addr().map_err(|_| bind_error())?;
                    let local = endpoint.clone();
                    let admission = blocking(move || local.admission()).await?;
                    self.listener = Some(Listener {
                        socket,
                        requested,
                        address,
                        admission: Arc::new(admission),
                        lifetime: watch::channel(()).0,
                    });
                }
            }
            LanAccessParams::Disable {} => self.stop(),
            LanAccessParams::SetShares { peer, shares } => {
                let local = endpoint.clone();
                blocking(move || local.set_shares(&operator, peer, &shares)).await?;
                self.refresh_admission(endpoint.clone()).await?;
            }
            LanAccessParams::Unpair { peer } => {
                let local = endpoint.clone();
                blocking(move || local.unpair(&operator, &peer)).await?;
                self.refresh_admission(endpoint.clone()).await?;
            }
        }
        let auth = self.endpoints.auth.clone();
        let peers = blocking(move || auth.lan_settings()).await?;
        let listener = self
            .listener
            .as_ref()
            .map_or(LanListenerState::Disabled {}, |value| {
                LanListenerState::Listening {
                    address: value.address.to_string(),
                }
            });
        Ok(LanAccessResult {
            local_peer: endpoint.peer(),
            listener,
            peers,
        })
    }

    async fn refresh_admission(&mut self, endpoint: Arc<LanEndpoint>) -> HostResult<()> {
        if let Some(listener) = &mut self.listener {
            match blocking(move || endpoint.admission()).await {
                Ok(admission) => listener.admission = Arc::new(admission),
                Err(error) => {
                    self.stop();
                    return Err(error);
                }
            }
        }
        Ok(())
    }
}

fn bind_error() -> HostError {
    HostError::new(
        "LAN_BIND_FAILED",
        "Could not listen on the selected LAN address",
    )
}

fn unavailable() -> HostError {
    HostError::new("LAN_UNAVAILABLE", "LAN management is unavailable")
}
