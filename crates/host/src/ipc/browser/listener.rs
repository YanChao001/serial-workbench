//! Browser connections are owned through TCP shutdown, including partial HTTP requests.
use axum::serve::Listener;
use std::{
    future::Future,
    io,
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore, watch},
};

pub(super) struct BrowserTcpListener {
    listener: TcpListener,
    permits: Arc<Semaphore>,
    stopped: watch::Receiver<bool>,
}

impl BrowserTcpListener {
    pub(super) fn new(listener: TcpListener, stopped: watch::Receiver<bool>) -> Self {
        Self {
            listener,
            permits: Arc::new(Semaphore::new(32)),
            stopped,
        }
    }
}

impl Listener for BrowserTcpListener {
    type Io = BrowserTcpStream;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .expect("listener budget stays open");
        let (stream, address) = Listener::accept(&mut self.listener).await;
        let stopped = Box::pin(super::wait_for_stop(self.stopped.clone()));
        (
            BrowserTcpStream {
                stream,
                stopped,
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

pub(super) struct BrowserTcpStream {
    stream: TcpStream,
    stopped: Pin<Box<dyn Future<Output = ()> + Send>>,
    closed: bool,
    _permit: OwnedSemaphorePermit,
}

impl BrowserTcpStream {
    fn check_open(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.closed || self.stopped.as_mut().poll(cx).is_ready() {
            self.closed = true;
            Err(io::ErrorKind::ConnectionAborted.into())
        } else {
            Ok(())
        }
    }
}

impl AsyncRead for BrowserTcpStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.check_open(cx)?;
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}

impl AsyncWrite for BrowserTcpStream {
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
