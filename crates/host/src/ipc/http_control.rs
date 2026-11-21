//! 供本机外部程序使用的 Host HTTP 控制入口。

use super::{
    connection::{ConnectionState, FrameReader, FrameWriter, Sessions},
    loopback::{LoopbackListener, LoopbackPeer, listener_actor, only_header, wait_for_stop},
    protocol::{blocking, busy, failure, unauthenticated},
};
use crate::{
    auth::{AuthService, AuthenticatedActor},
    registry::requires_events,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
    routing::post,
};
use serial_workbench_core::{
    ContextToken, HostError, HostResult, HttpControlEntry, HttpControlRequest, IpcChannel,
    IpcMessage, RequestChannel, RpcReply, RpcRequest, WireFrame,
};
use serial_workbench_ipc::{
    frame::{MAX_FRAME_BYTES, encode_frame},
    identity::{credential_verifier, random_token, verify_credential},
};
use std::{future::pending, net::Ipv4Addr, path::Path, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_util::task::TaskTracker;

const RPC_PATH: &str = "/api/rpc";
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct HttpControlListener {
    listener: TcpListener,
    authority: String,
    actor: AuthenticatedActor,
    verifier: ContextToken,
}

impl HttpControlListener {
    pub(super) async fn bind(
        namespace: &Path,
        auth: AuthService,
    ) -> HostResult<(Self, HttpControlEntry)> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| unavailable())?;
        let authority = listener
            .local_addr()
            .map_err(|_| unavailable())?
            .to_string();
        let namespace = namespace.to_path_buf();
        let actor = blocking(move || listener_actor(&namespace, "http", &auth)).await?;
        let credential = random_token();
        let entry = HttpControlEntry {
            url: format!("http://{authority}{RPC_PATH}"),
            client_id: actor.client_id().clone(),
            credential: credential.clone(),
        };
        let listener = Self {
            listener,
            authority,
            actor,
            verifier: credential_verifier(&credential),
        };
        Ok((listener, entry))
    }

    pub(super) fn start(self, mut connection: ConnectionState) -> HttpControlTask {
        connection.sessions = Sessions::default();
        let (stop, stopped) = watch::channel(false);
        let tasks = TaskTracker::new();
        let state = HttpControlState {
            authority: self.authority,
            actor: self.actor,
            verifier: self.verifier,
            connection,
            stopped: stopped.clone(),
            tasks: tasks.clone(),
        };
        let router = Router::new()
            .route(RPC_PATH, post(handle_rpc))
            .with_state(state);
        let listener = LoopbackListener::new(self.listener, stopped.clone())
            .with_connection_timeout(CONNECTION_TIMEOUT);
        let task = tokio::spawn(async move {
            let result = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<LoopbackPeer>(),
            )
            .with_graceful_shutdown(wait_for_stop(stopped))
            .await;
            tasks.close();
            tasks.wait().await;
            result.map_err(|_| unavailable())
        });
        HttpControlTask { stop, task }
    }
}

pub(super) struct HttpControlTask {
    stop: watch::Sender<bool>,
    task: JoinHandle<HostResult<()>>,
}

impl HttpControlTask {
    pub(super) fn stop_accepting(&self) {
        self.stop.send_replace(true);
    }

    pub(super) async fn finish(self) -> HostResult<()> {
        self.stop_accepting();
        self.task.await.map_err(|_| unavailable())?
    }
}

#[derive(Clone)]
struct HttpControlState {
    authority: String,
    actor: AuthenticatedActor,
    verifier: ContextToken,
    connection: ConnectionState,
    stopped: watch::Receiver<bool>,
    tasks: TaskTracker,
}

async fn handle_rpc(
    State(state): State<HttpControlState>,
    ConnectInfo(peer): ConnectInfo<LoopbackPeer>,
    request: Request,
) -> Response {
    if *state.stopped.borrow() {
        return reject(StatusCode::SERVICE_UNAVAILABLE, unavailable());
    }
    if !only_header(request.headers(), header::HOST)
        .is_some_and(|value| value == state.authority.as_str())
        || request.headers().contains_key(header::ORIGIN)
        || request.uri().query().is_some()
    {
        return reject(StatusCode::FORBIDDEN, denied());
    }
    if !authenticate(request.headers(), &state.verifier) {
        return reject(StatusCode::UNAUTHORIZED, unauthenticated());
    }
    if !only_header(request.headers(), header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
    {
        return reject(StatusCode::UNSUPPORTED_MEDIA_TYPE, invalid());
    }
    let bytes = match timeout(BODY_TIMEOUT, to_bytes(request.into_body(), MAX_FRAME_BYTES)).await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => {
            return reject(
                StatusCode::PAYLOAD_TOO_LARGE,
                HostError::new(
                    "LIMIT_EXCEEDED",
                    "Cannot read HTTP request within its byte limit",
                ),
            );
        }
        Err(_) => return reject(StatusCode::REQUEST_TIMEOUT, invalid()),
    };
    let HttpControlRequest {
        request_id,
        request,
    } = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(_) => return reject(StatusCode::BAD_REQUEST, invalid()),
    };
    let channel = match request_channel(&request) {
        Ok(channel) => channel,
        Err(error) => return reject(StatusCode::OK, error),
    };
    if *state.stopped.borrow() || peer.closed.is_cancelled() {
        return reject(StatusCode::SERVICE_UNAVAILABLE, unavailable());
    }

    let (session, token) = match state.connection.open_control(state.actor, false) {
        Ok(session) => session,
        Err(error) => return reject(StatusCode::SERVICE_UNAVAILABLE, error),
    };
    let reader = HttpReader(Some(WireFrame {
        request_id,
        channel,
        body: IpcMessage::Request { request },
    }));
    let (reply, receive) = oneshot::channel();
    let writer = HttpWriter {
        reply: Some(reply),
        peer: peer.clone(),
        started: false,
    };
    let disconnect = async move {
        tokio::select! {
            _ = peer.closed.cancelled() => {},
            _ = wait_for_stop(state.stopped) => {},
        }
    };
    // 即使 HTTP 调用者停止等待，现有请求循环仍负责完成已开始的接纳。
    state.tasks.spawn(state.connection.serve_frames(
        reader,
        writer,
        (session, Some(token), channel),
        disconnect,
        None,
        None,
    ));
    match receive.await {
        Ok(reply) => response(StatusCode::OK, reply),
        Err(_) => reject(StatusCode::SERVICE_UNAVAILABLE, unavailable()),
    }
}

fn authenticate(headers: &HeaderMap, verifier: &ContextToken) -> bool {
    only_header(headers, header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let (scheme, token) = value.split_once(' ')?;
            scheme
                .eq_ignore_ascii_case("Bearer")
                .then_some(token.trim_start_matches(' '))
        })
        .filter(|value| value.len() == 43)
        .and_then(|value| ContextToken::try_from(value).ok())
        .is_some_and(|credential| verify_credential(verifier, &credential))
}

fn request_channel(request: &RpcRequest) -> HostResult<IpcChannel> {
    match request {
        RpcRequest::Query(query) if requires_events(query.action_id.as_str()) => {
            return Err(denied());
        }
        RpcRequest::Attach(_)
        | RpcRequest::CatalogList(_)
        | RpcRequest::Query(_)
        | RpcRequest::Invoke(_)
        | RpcRequest::OperationGet(_)
        | RpcRequest::OperationCancel(_)
        | RpcRequest::StateSnapshot(_)
        | RpcRequest::ObjectRead(_)
        | RpcRequest::StreamRead(_) => {}
        _ => return Err(denied()),
    }
    Ok(match request.required_channel()? {
        RequestChannel::Raw => IpcChannel::Raw,
        RequestChannel::Control | RequestChannel::Either => IpcChannel::Control,
    })
}

struct HttpReader(Option<WireFrame>);

impl FrameReader for HttpReader {
    async fn read_wire(&mut self) -> HostResult<Option<WireFrame>> {
        match self.0.take() {
            Some(request) => Ok(Some(request)),
            None => pending().await,
        }
    }
}

struct HttpWriter {
    reply: Option<oneshot::Sender<Vec<u8>>>,
    peer: LoopbackPeer,
    started: bool,
}

impl FrameWriter for HttpWriter {
    fn supports_events(&self) -> bool {
        false
    }

    async fn write_wire(&mut self, frame: &WireFrame, started: &mut bool) -> HostResult<()> {
        let bytes = match &frame.body {
            IpcMessage::Reply { reply } => encode_frame(reply, MAX_FRAME_BYTES)?,
            IpcMessage::Error { error } => encode_frame(&failure(error.clone()), MAX_FRAME_BYTES)?,
            _ => return Err(invalid()),
        };
        self.reply
            .take()
            .ok_or_else(busy)?
            .send(bytes)
            .map_err(|_| unavailable())?;
        self.started = true;
        *started = true;
        // 保留原始回包的权限监视和预算，直到 HTTP 套接字写完并关闭。
        self.peer.closed.cancelled().await;
        Ok(())
    }
}

impl Drop for HttpWriter {
    fn drop(&mut self) {
        if self.started && !self.peer.closed.is_cancelled() {
            self.peer.aborted.cancel();
        }
    }
}

fn response(status: StatusCode, bytes: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));
    if status == StatusCode::UNAUTHORIZED {
        headers.insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
    }
    response
}

fn reject(status: StatusCode, error: HostError) -> Response {
    let reply: RpcReply = failure(error);
    let Ok(bytes) = serde_json::to_vec(&reply) else {
        return response(StatusCode::INTERNAL_SERVER_ERROR, Vec::new());
    };
    response(status, bytes)
}

fn denied() -> HostError {
    HostError::new(
        "PERMISSION_DENIED",
        "Request is not allowed on the HTTP control endpoint",
    )
}

fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid HTTP control request")
}

fn unavailable() -> HostError {
    HostError::new("HOST_UNAVAILABLE", "HTTP control endpoint is unavailable")
}
