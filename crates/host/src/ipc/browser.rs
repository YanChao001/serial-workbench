//! Browser transport for the local Host. A trusted launcher receives the initial ticket.
mod listener;

use super::{
    connection::{ConnectionState, ControlSession, FrameReader, FrameWriter, Sessions},
    protocol::{blocking, busy, error_frame, invalid, storage, unauthenticated},
};
use crate::auth::{AuthService, AuthenticatedActor};
use axum::{
    Router,
    extract::{
        Path as AssetPath, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{
    SinkExt, StreamExt,
    stream::{SplitSink, SplitStream},
};
use serial_workbench_core::*;
use serial_workbench_ipc::{
    frame::{MAX_FRAME_BYTES, encode_frame},
    identity::{credential_verifier, random_token, verify_credential},
};
use std::{
    io::Read,
    net::Ipv4Addr,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::timeout,
};
use tokio_util::task::TaskTracker;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const PAIRING_LIFETIME: Duration = Duration::from_secs(300);
const MAX_ASSET_BYTES: u64 = 8 * 1024 * 1024;

pub(super) struct BrowserListener {
    socket: TcpListener,
    root: PathBuf,
    authority: String,
    pairing: Pairing,
    mode: BrowserAccessMode,
}

pub(super) struct BrowserCommand {
    pub params: BrowserAccessParams,
    pub response: oneshot::Sender<HostResult<BrowserAccessState>>,
}

pub(super) async fn request_access(
    commands: Option<&mpsc::Sender<BrowserCommand>>,
    params: BrowserAccessParams,
) -> HostResult<BrowserAccessState> {
    let commands = commands.ok_or_else(unauthenticated)?;
    let (response, reply) = oneshot::channel();
    commands
        .try_send(BrowserCommand { params, response })
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => busy(),
            mpsc::error::TrySendError::Closed(_) => unavailable(),
        })?;
    reply.await.map_err(|_| unavailable())?
}

pub(super) async fn manage_access(
    params: BrowserAccessParams,
    namespace: &Path,
    connection: &ConnectionState,
    running: &mut Option<BrowserTask>,
) -> HostResult<BrowserAccessState> {
    match params {
        BrowserAccessParams::Status {} => {
            Ok(running
                .as_ref()
                .map_or(BrowserAccessState::Disabled {}, |task| {
                    BrowserAccessState::Enabled {
                        url: task.url.clone(),
                        mode: task.mode,
                    }
                }))
        }
        BrowserAccessParams::Pair { assets_dir, mode } => {
            let path = PathBuf::from(assets_dir);
            let auth = connection.auth.clone();
            let (listener, entry) =
                BrowserListener::bind(&path, namespace, auth.clone(), mode).await?;
            revoke_access(running, &auth).await?;
            let client_id = entry.client_id.clone();
            blocking(move || auth.set_browser_access(&client_id, Some(mode))).await?;
            *running = Some(listener.start(connection.clone()));
            Ok(BrowserAccessState::Pairing { entry, mode })
        }
        BrowserAccessParams::Revoke {} => {
            revoke_access(running, &connection.auth).await?;
            Ok(BrowserAccessState::Disabled {})
        }
    }
}

async fn revoke_access(running: &mut Option<BrowserTask>, auth: &AuthService) -> HostResult<()> {
    let Some(task) = running.take() else {
        return Ok(());
    };
    task.stop_accepting();
    let client_id = task.client_id.clone();
    let auth = auth.clone();
    let retired = blocking(move || auth.set_browser_access(&client_id, None)).await;
    let joined = task.finish().await;
    retired.and(joined)
}

struct Pairing {
    actor: AuthenticatedActor,
    ticket: Option<(ContextToken, Instant)>,
    reconnect_verifier: Option<ContextToken>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct BrowserIdentity {
    id: uuid::Uuid,
    credential: ContextToken,
}

fn load_browser_actor(namespace: &Path, auth: &AuthService) -> HostResult<AuthenticatedActor> {
    let path = namespace.join("browser-identity.secret");
    let identity = match serial_workbench_ipc::read_secret(&path)? {
        Some(saved) => serde_json::from_slice(&saved).map_err(|_| unauthenticated())?,
        None => {
            let identity = BrowserIdentity {
                id: uuid::Uuid::new_v4(),
                credential: random_token(),
            };
            // Save first so a failed registration can retry the same private identity.
            let encoded = serde_json::to_vec(&identity).map_err(|_| storage())?;
            serial_workbench_ipc::write_secret_new(&path, &encoded)?;
            identity
        }
    };
    let client_id = Id::try_from(format!("browser-{}", identity.id).as_str())?;
    auth.authenticate_browser_identity(&client_id, &identity.credential)
}

impl Pairing {
    fn pair(
        &mut self,
        client_id: &Id,
        pairing_code: &ContextToken,
        reconnect_credential: &ContextToken,
    ) -> HostResult<AuthenticatedActor> {
        if self.actor.client_id() != client_id || reconnect_credential.as_str().len() != 43 {
            return Err(unauthenticated());
        }
        let ticket_valid = self.ticket.as_ref().is_some_and(|(verifier, deadline)| {
            Instant::now() < *deadline
                && verify_credential(verifier, pairing_code)
                && !verify_credential(verifier, reconnect_credential)
        });
        if !ticket_valid {
            return Err(unauthenticated());
        }
        self.ticket = None;
        self.reconnect_verifier = Some(credential_verifier(reconnect_credential));
        Ok(self.actor.clone())
    }

    fn reconnect(
        &self,
        client_id: &Id,
        credential: &ContextToken,
    ) -> HostResult<AuthenticatedActor> {
        if self.actor.client_id() == client_id
            && self
                .reconnect_verifier
                .as_ref()
                .is_some_and(|verifier| verify_credential(verifier, credential))
        {
            Ok(self.actor.clone())
        } else {
            Err(unauthenticated())
        }
    }
}

impl BrowserListener {
    pub(super) async fn bind(
        root: &Path,
        namespace: &Path,
        auth: AuthService,
        mode: BrowserAccessMode,
    ) -> HostResult<(Self, BrowserEntry)> {
        if !root.is_absolute() {
            return Err(invalid_assets());
        }
        let root = root.to_path_buf();
        let root = blocking(move || {
            let root = root.canonicalize().map_err(|_| invalid_assets())?;
            if !root.is_dir() || !root.join("index.html").is_file() {
                return Err(invalid_assets());
            }
            Ok(root)
        })
        .await?;
        let socket = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| unavailable())?;
        let authority = socket.local_addr().map_err(|_| unavailable())?.to_string();
        let code = random_token();
        let namespace = namespace.to_path_buf();
        let actor = blocking(move || load_browser_actor(&namespace, &auth)).await?;
        let entry = BrowserEntry {
            url: format!("http://{authority}"),
            pairing_code: code.clone(),
            client_id: actor.client_id().clone(),
        };
        Ok((
            Self {
                socket,
                root,
                authority,
                mode,
                pairing: Pairing {
                    actor,
                    ticket: Some((
                        credential_verifier(&code),
                        Instant::now() + PAIRING_LIFETIME,
                    )),
                    reconnect_verifier: None,
                },
            },
            entry,
        ))
    }

    pub(super) fn start(self, mut connection: ConnectionState) -> BrowserTask {
        // A local Raw attach token is insufficient on the browser listener, and vice versa.
        connection.sessions = Sessions::default();
        let (stop, stopped) = watch::channel(false);
        let tracker = TaskTracker::new();
        let url = format!("http://{}", self.authority);
        let client_id = self.pairing.actor.client_id().clone();
        let state = BrowserState {
            origin: url.clone(),
            client_id: client_id.clone(),
            authority: self.authority,
            root: self.root,
            pairing: Arc::new(Mutex::new(self.pairing)),
            connection,
            upgrade_tasks: tracker.clone(),
            stopped: stopped.clone(),
        };
        let router = Router::new()
            .route("/api/ws", get(upgrade))
            .route("/", get(asset))
            .route("/{*path}", get(asset))
            .with_state(state);
        let task = tokio::spawn(async move {
            let listener = listener::BrowserTcpListener::new(self.socket, stopped.clone());
            let result = axum::serve(listener, router)
                .with_graceful_shutdown(wait_for_stop(stopped))
                .await;
            tracker.close();
            tracker.wait().await;
            result.map_err(|_| unavailable())
        });
        BrowserTask {
            stop,
            task,
            url,
            client_id,
            mode: self.mode,
        }
    }
}

pub(super) struct BrowserTask {
    stop: watch::Sender<bool>,
    task: JoinHandle<HostResult<()>>,
    url: String,
    client_id: Id,
    mode: BrowserAccessMode,
}
impl BrowserTask {
    pub(super) fn stop_accepting(&self) {
        self.stop.send_replace(true);
    }

    pub(super) async fn finish(self) -> HostResult<()> {
        self.stop_accepting();
        self.task.await.map_err(|_| unavailable())?
    }
}

#[derive(Clone)]
struct BrowserState {
    origin: String,
    client_id: Id,
    authority: String,
    root: PathBuf,
    pairing: Arc<Mutex<Pairing>>,
    connection: ConnectionState,
    upgrade_tasks: TaskTracker,
    stopped: watch::Receiver<bool>,
}

async fn wait_for_stop(mut stopped: watch::Receiver<bool>) {
    let _ = stopped.wait_for(|value| *value).await;
}

fn has_header(headers: &HeaderMap, name: header::HeaderName, expected: &str) -> bool {
    let values = headers.get_all(name);
    let mut entries = values.iter();
    entries.next().is_some_and(|value| value == expected) && entries.next().is_none()
}

async fn upgrade(
    State(state): State<BrowserState>,
    headers: HeaderMap,
    socket: WebSocketUpgrade,
) -> Response {
    if !has_header(&headers, header::HOST, &state.authority)
        || !has_header(&headers, header::ORIGIN, &state.origin)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if *state.stopped.borrow() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let task = state.upgrade_tasks.token();
    socket
        .max_frame_size(MAX_FRAME_BYTES)
        .max_message_size(MAX_FRAME_BYTES)
        .max_write_buffer_size(2 * MAX_FRAME_BYTES)
        .on_upgrade(move |socket| async move {
            let _task = task;
            let _ = serve_socket(socket, state).await;
        })
}

async fn serve_socket(mut socket: WebSocket, state: BrowserState) -> HostResult<()> {
    let stopped = state.stopped.clone();
    let frame = tokio::select! {
        biased;
        _ = wait_for_stop(stopped.clone()) => return Ok(()),
        frame = timeout(HANDSHAKE_TIMEOUT, read_websocket(&mut socket)) => {
            frame.map_err(|_| unauthenticated())??.ok_or_else(unauthenticated)?
        }
    };
    let connection = state.connection;
    let channel = frame.channel;
    let authenticated = (|| {
        let actor = match frame.body {
            IpcMessage::BrowserPair {
                client_id,
                pairing_code,
                reconnect_credential,
            } if channel == IpcChannel::Control => state
                .pairing
                .lock()
                .map_err(|_| storage())?
                .pair(&client_id, &pairing_code, &reconnect_credential)?,
            IpcMessage::Authenticate {
                client_id,
                credential: Some(credential),
            } if channel == IpcChannel::Control => state
                .pairing
                .lock()
                .map_err(|_| storage())?
                .reconnect(&client_id, &credential)?,
            IpcMessage::RawAttach { token } if channel == IpcChannel::Raw => {
                return Ok((
                    connection.attach_raw(&token)?,
                    None,
                    IpcMessage::RawAttached {},
                ));
            }
            _ => return Err(unauthenticated()),
        };
        let (session, token) = connection.open_control(actor)?;
        let message = IpcMessage::Authenticated {
            credential: None,
            raw_attach_token: token.clone(),
        };
        Ok((session, Some(token), message))
    })();
    let (session, token, message): (Arc<ControlSession>, _, _) = match authenticated {
        Ok(attached) => attached,
        Err(error) => {
            let reply = error_frame(frame.request_id, channel, error.clone());
            let _ = timeout(
                HANDSHAKE_TIMEOUT,
                send_websocket(&mut socket, &reply, &mut false),
            )
            .await;
            return Err(error);
        }
    };
    if *stopped.borrow() {
        connection.abandon_handshake(&session, token.as_ref());
        return Ok(());
    }
    let reply = WireFrame {
        request_id: frame.request_id,
        channel,
        body: message,
    };
    let sent = timeout(
        HANDSHAKE_TIMEOUT,
        send_websocket(&mut socket, &reply, &mut false),
    )
    .await
    .map_err(|_| busy())
    .and_then(|result| result);
    if let Err(error) = sent {
        connection.abandon_handshake(&session, token.as_ref());
        return Err(error);
    }
    let (writer, reader) = socket.split();
    connection
        .serve_frames(
            WebReader(reader),
            WebWriter(writer),
            (session, token, channel),
            wait_for_stop(stopped.clone()),
            None,
            Some(stopped),
        )
        .await
}

struct WebReader(SplitStream<WebSocket>);
struct WebWriter(SplitSink<WebSocket, Message>);
impl FrameReader for WebReader {
    async fn read_wire(&mut self) -> HostResult<Option<WireFrame>> {
        read_websocket(&mut self.0).await
    }
}
async fn read_websocket(
    socket: &mut (impl futures_util::Stream<Item = Result<Message, axum::Error>> + Unpin),
) -> HostResult<Option<WireFrame>> {
    while let Some(message) = socket.next().await {
        match message.map_err(|_| unavailable())? {
            Message::Text(text) => {
                return serde_json::from_str(text.as_str())
                    .map(Some)
                    .map_err(|_| invalid());
            }
            Message::Close(_) => return Ok(None),
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Binary(_) => return Err(invalid()),
        }
    }
    Ok(None)
}
impl FrameWriter for WebWriter {
    async fn write_wire(&mut self, frame: &WireFrame, started: &mut bool) -> HostResult<()> {
        send_websocket(&mut self.0, frame, started).await
    }
}
async fn send_websocket(
    socket: &mut (impl futures_util::Sink<Message, Error = axum::Error> + Unpin),
    frame: &WireFrame,
    started: &mut bool,
) -> HostResult<()> {
    let bytes = encode_frame(frame, MAX_FRAME_BYTES)?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    // The WebSocket sink can begin buffering before an await. Treat cancellation as uncertain.
    *started = true;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| unavailable())
}

async fn asset(
    State(state): State<BrowserState>,
    headers: HeaderMap,
    path: Option<AssetPath<String>>,
) -> Response {
    if !has_header(&headers, header::HOST, &state.authority) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = path.as_ref().map_or("index.html", |AssetPath(path)| path);
    if !matches!(path, "index.html" | "LICENSE" | "NOTICE")
        && !path.starts_with("assets/")
        && !path.starts_with("licenses/")
        && !path.starts_with("third-party/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if path.contains(['\\', ':'])
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let is_entry = path == "index.html";
    let root = state.root;
    let path = root.join(path);
    let media = content_type(&path);
    let file = blocking(move || {
        let path = path.canonicalize().map_err(|_| invalid_assets())?;
        if !path.starts_with(&root) || !path.is_file() {
            return Err(invalid_assets());
        }
        let file = std::fs::File::open(path).map_err(|_| invalid_assets())?;
        let mut bytes = Vec::new();
        file.take(MAX_ASSET_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid_assets())?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(invalid_assets());
        }
        Ok(bytes)
    })
    .await;
    let Ok(bytes) = file else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let bytes = if is_entry {
        let Ok(text) = String::from_utf8(bytes) else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        let markup = format!(
            "<meta name=\"serial-workbench-host\" content=\"browser\"><meta name=\"serial-workbench-browser-id\" content=\"{}\"></head>",
            state.client_id.as_str(),
        );
        text.replacen("</head>", &markup, 1).into_bytes()
    } else {
        bytes
    };
    let mut response = ([(header::CONTENT_TYPE, media)], bytes).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    let policy = format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' ws://{}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
        state.authority,
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_str(&policy).expect("loopback authority"),
    );
    response
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "woff2" => "font/woff2",
        "mp4" => "video/mp4",
        "txt" | "LICENSE" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn unavailable() -> HostError {
    HostError::new("HOST_UNAVAILABLE", "The browser connection is unavailable")
}

fn invalid_assets() -> HostError {
    HostError::new(
        "BROWSER_ASSETS_UNAVAILABLE",
        "The browser workbench assets are unavailable",
    )
}
