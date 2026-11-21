//! 回环套接字由 Host 持有至关停，包含尚未读完的 HTTP 请求。
use super::protocol::{storage, unauthenticated};
use crate::auth::{AuthService, AuthenticatedActor};
use axum::{
    extract::connect_info::Connected,
    http::{HeaderMap, header::HeaderName},
    serve::{IncomingStream, Listener},
};
use serial_workbench_core::{ContextToken, HostResult, Id};
use serial_workbench_ipc::identity::random_token;
use std::{
    future::Future,
    io,
    net::SocketAddr,
    path::Path,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore, watch},
    time::{Sleep, sleep},
};

use tokio_util::sync::{CancellationToken, DropGuard, WaitForCancellationFutureOwned};

pub(super) struct LoopbackListener {
    listener: TcpListener,
    permits: Arc<Semaphore>,
    stopped: watch::Receiver<bool>,
    connection_timeout: Option<Duration>,
}

impl LoopbackListener {
    pub(super) fn new(listener: TcpListener, stopped: watch::Receiver<bool>) -> Self {
        Self {
            listener,
            permits: Arc::new(Semaphore::new(32)),
            stopped,
            connection_timeout: None,
        }
    }

    pub(super) fn with_connection_timeout(mut self, timeout: Duration) -> Self {
        self.connection_timeout = Some(timeout);
        self
    }
}

impl Listener for LoopbackListener {
    type Io = LoopbackStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .expect("listener budget stays open");
        let (stream, address) = Listener::accept(&mut self.listener).await;
        let stopped = Box::pin(wait_for_stop(self.stopped.clone()));
        let peer = LoopbackPeer::default();
        (
            LoopbackStream {
                aborted: Box::pin(peer.aborted.clone().cancelled_owned()),
                _on_close: peer.closed.clone().drop_guard(),
                peer,
                stream,
                stopped,
                deadline: self
                    .connection_timeout
                    .map(|duration| Box::pin(sleep(duration))),
                closed: false,
                _permit: permit,
            },
            address,
        )
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }
}

pub(super) struct LoopbackStream {
    peer: LoopbackPeer,
    aborted: Pin<Box<WaitForCancellationFutureOwned>>,
    _on_close: DropGuard,
    stream: TcpStream,
    stopped: Pin<Box<dyn Future<Output = ()> + Send>>,
    deadline: Option<Pin<Box<Sleep>>>,
    closed: bool,
    _permit: OwnedSemaphorePermit,
}

impl LoopbackStream {
    fn check_open(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.closed
            || self.aborted.as_mut().poll(cx).is_ready()
            || self.stopped.as_mut().poll(cx).is_ready()
            || self
                .deadline
                .as_mut()
                .is_some_and(|deadline| deadline.as_mut().poll(cx).is_ready())
        {
            self.closed = true;
            Err(io::ErrorKind::ConnectionAborted.into())
        } else {
            Ok(())
        }
    }
}

impl AsyncRead for LoopbackStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check_open(cx)?;
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}

impl AsyncWrite for LoopbackStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check_open(cx)?;
        Pin::new(&mut self.stream).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check_open(cx)?;
        Pin::new(&mut self.stream).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}

pub(super) async fn wait_for_stop(mut stopped: watch::Receiver<bool>) {
    let _ = stopped.wait_for(|value| *value).await;
}

pub(super) fn only_header(
    headers: &HeaderMap,
    name: HeaderName,
) -> Option<&axum::http::HeaderValue> {
    let values = headers.get_all(name);
    let mut entries = values.iter();
    let first = entries.next()?;
    entries.next().is_none().then_some(first)
}

#[derive(Clone, Default)]
pub(super) struct LoopbackPeer {
    pub(super) closed: CancellationToken,
    pub(super) aborted: CancellationToken,
}

impl Connected<IncomingStream<'_, LoopbackListener>> for LoopbackPeer {
    fn connect_info(stream: IncomingStream<'_, LoopbackListener>) -> Self {
        stream.io().peer.clone()
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ListenerIdentity {
    id: uuid::Uuid,
    credential: ContextToken,
}

pub(super) fn listener_actor(
    namespace: &Path,
    label: &str,
    auth: &AuthService,
) -> HostResult<AuthenticatedActor> {
    let path = namespace.join(format!("{label}-identity.secret"));
    let identity = match serial_workbench_ipc::read_secret(&path)? {
        Some(saved) => serde_json::from_slice(&saved).map_err(|_| unauthenticated())?,
        None => {
            let identity = ListenerIdentity {
                id: uuid::Uuid::new_v4(),
                credential: random_token(),
            };
            // 先保存私有身份，注册失败时可重试原身份。
            let encoded = serde_json::to_vec(&identity).map_err(|_| storage())?;
            serial_workbench_ipc::write_secret_new(&path, &encoded)?;
            identity
        }
    };
    let client_id = Id::try_from(format!("{label}-{}", identity.id).as_str())?;
    auth.ensure_listener_identity(&client_id, &identity.credential)
}
