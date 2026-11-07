use super::{
    InstanceGuard,
    connection::{ConnectionState, Sessions},
    protocol::*,
};
use crate::{
    auth::{AuthService, AuthenticatedActor, GrantStamp, HostIdentity},
    storage::Store,
};
use serial_workbench_core::*;
use serial_workbench_ipc::{
    self as local, DiscoveryRecord, LocalListener,
    frame::{MAX_FRAME_BYTES, write_frame},
    identity::{IdentityPin, random_token},
};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::JoinSet;

pub struct HandlerReply {
    pub wire_reply: RpcReply,
    pub raw_output_lease: Option<crate::stream::RawOutputLease>,
}
impl From<RpcReply> for HandlerReply {
    fn from(wire_reply: RpcReply) -> Self {
        Self {
            wire_reply,
            raw_output_lease: None,
        }
    }
}
pub type HandlerFuture = Pin<Box<dyn Future<Output = HostResult<HandlerReply>> + Send>>;
#[derive(Clone)]
pub struct ConnectionContext {
    pub connection_id: Id,
    pub actor: AuthenticatedActor,
    pub channel: IpcChannel,
    pub(super) events: mpsc::Sender<AuthorizedEvent>,
    pub(super) event_budget: Arc<Semaphore>,
    pub(super) subscriptions: Arc<Mutex<HashSet<Id>>>,
    pub(super) failed: Arc<tokio::sync::Notify>,
    pub(super) catalog_changed: tokio::sync::watch::Sender<Option<WireFrame>>,
}
pub(super) struct AuthorizedEvent {
    pub frame: EventFrame,
    pub grant: Option<(String, Target)>,
    pub _budget: OwnedSemaphorePermit,
    pub subscriptions: Arc<Mutex<HashSet<Id>>>,
    pub stamp: Option<GrantStamp>,
    pub delivery_liveness: Option<tokio::sync::watch::Receiver<bool>>,
}
pub(super) enum EventFrame {
    State(WireFrame),
    Raw {
        _slot: crate::stream::RawMemoryLease,
        batch: Arc<crate::stream::PreparedRawBatch>,
    },
}
impl EventFrame {
    pub fn frame(&self) -> &WireFrame {
        match self {
            Self::State(frame) => frame,
            Self::Raw { batch, .. } => batch.frame(),
        }
    }
}
impl ConnectionContext {
    pub(crate) fn emit_catalog_changed(
        &self,
        catalog_version: U64,
        visibility_token: Digest,
    ) -> HostResult<()> {
        if self.channel != IpcChannel::Control || self.is_closed() {
            return Err(invalid());
        }
        self.catalog_changed.send_replace(Some(WireFrame {
            request_id: new_request_id(),
            channel: IpcChannel::Control,
            body: IpcMessage::CatalogChanged {
                catalog_version,
                visibility_token,
            },
        }));
        Ok(())
    }
    pub fn is_closed(&self) -> bool {
        self.events.is_closed()
    }
    pub async fn closed(&self) {
        self.events.closed().await;
    }
    pub fn register_subscription(&self, id: Id) -> HostResult<()> {
        if self.is_closed() {
            return Err(busy());
        }
        let mut subscriptions = self.subscriptions.lock().map_err(|_| busy())?;
        if subscriptions.len() >= 64 {
            return Err(busy());
        }
        subscriptions.insert(id);
        Ok(())
    }
    pub(crate) fn close_subscription(&self, id: &Id) {
        if let Ok(mut subscriptions) = self.subscriptions.lock() {
            subscriptions.remove(id);
        }
    }
    /// 终止只携带此连接已登记订阅的固定错误，不借此发送未授权正文。
    pub(crate) fn end_subscription(&self, request_id: RequestId, id: &Id, code: &str) {
        let known = self
            .subscriptions
            .lock()
            .map(|mut entries| entries.remove(id))
            .unwrap_or(false);
        if !known {
            return;
        }
        let error = match code {
            "PERMISSION_DENIED" => {
                HostError::new("PERMISSION_DENIED", "Subscription authorization ended")
            }
            "READER_OVERFLOW" => {
                HostError::new("READER_OVERFLOW", "Raw reader exceeded its queue budget")
            }
            "LIMIT_EXCEEDED" => {
                HostError::new("LIMIT_EXCEEDED", "Raw batch exceeded its byte budget")
            }
            "EPOCH_MISMATCH" => HostError::new("EPOCH_MISMATCH", "Subscription source epoch ended"),
            "BACKEND_DISCONNECTED" => {
                HostError::new("BACKEND_DISCONNECTED", "Stream backend disconnected")
            }
            _ => HostError::new(
                "CURSOR_EXPIRED",
                "Subscription ended; request a new snapshot",
            ),
        };
        let frame = WireFrame {
            request_id,
            channel: if self.channel == IpcChannel::Raw {
                IpcChannel::Raw
            } else {
                IpcChannel::State
            },
            body: IpcMessage::SubscriptionEnded {
                subscription_id: id.clone(),
                error,
            },
        };
        let result = (|| {
            let size = local::frame::encoded_length(&frame, MAX_FRAME_BYTES)?;
            let budget = self
                .event_budget
                .clone()
                .try_acquire_many_owned(size as u32)
                .map_err(|_| busy())?;
            self.events
                .try_send(AuthorizedEvent {
                    frame: EventFrame::State(frame),
                    grant: None,
                    _budget: budget,
                    subscriptions: self.subscriptions.clone(),
                    stamp: None,
                    delivery_liveness: None,
                })
                .map_err(|_| busy())
        })();
        if result.is_err() {
            self.failed.notify_one();
        }
    }
    /// 入队不意味着已投递；writer 在实际输出前重新校验当前授权。
    pub fn emit(&self, frame: WireFrame, permission: &str, target: Target) -> HostResult<()> {
        self.emit_with_stamp(frame, permission, target, None, None)
    }
    pub(crate) fn emit_with_stamp(
        &self,
        frame: WireFrame,
        permission: &str,
        target: Target,
        stamp: Option<GrantStamp>,
        delivery_liveness: Option<tokio::sync::watch::Receiver<bool>>,
    ) -> HostResult<()> {
        if matches!(frame.body, IpcMessage::RawBatch { .. }) {
            return Err(invalid());
        }
        if !matches!(
            (&frame.body, self.channel, frame.channel),
            (
                IpcMessage::Delta { .. },
                IpcChannel::Control,
                IpcChannel::State
            )
        ) {
            return Err(invalid());
        }
        let size = local::frame::encoded_length(&frame, MAX_FRAME_BYTES)?;
        let budget = self
            .event_budget
            .clone()
            .try_acquire_many_owned(size as u32)
            .map_err(|_| busy())?;
        self.events
            .try_send(AuthorizedEvent {
                frame: EventFrame::State(frame),
                grant: Some((permission.into(), target)),
                _budget: budget,
                subscriptions: self.subscriptions.clone(),
                stamp,
                delivery_liveness,
            })
            .map_err(|_| busy())
    }
    pub(crate) fn emit_raw(
        &self,
        batch: Arc<crate::stream::PreparedRawBatch>,
        target: Target,
    ) -> HostResult<()> {
        if self.channel != IpcChannel::Raw
            || !self
                .subscriptions
                .lock()
                .map_err(|_| busy())?
                .contains(&batch.batch().subscription_id)
        {
            return Err(invalid());
        }
        // 正文与其原始授权代次随 Arc 传递，排队槽位单独计费。
        let budget = self
            .event_budget
            .clone()
            .try_acquire_many_owned(1024)
            .map_err(|_| busy())?;
        let stamp = batch.stamp.clone();
        let delivery_liveness = Some(batch.delivery_liveness());
        let slot = batch.queue_lease()?;
        self.events
            .try_send(AuthorizedEvent {
                frame: EventFrame::Raw { _slot: slot, batch },
                grant: Some(("content.read".into(), target)),
                _budget: budget,
                subscriptions: self.subscriptions.clone(),
                stamp,
                delivery_liveness,
            })
            .map_err(|_| busy())
    }
}
pub trait RequestHandler: Send + Sync + 'static {
    /// Future 负责查询或持久接纳；已接纳业务的执行生命周期归 Host 服务所有。
    fn handle(&self, connection: ConnectionContext, request: RpcRequest) -> HandlerFuture;
    fn disconnected(&self, _connection: &ConnectionContext) {}
    fn stop_requested(&self) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(std::future::pending())
    }
    fn shutdown(&self) -> Pin<Box<dyn Future<Output = HostResult<()>> + Send>> {
        Box::pin(async { Ok(()) })
    }
}
pub struct HostServer {
    #[cfg(test)]
    pub(crate) accept_error: Option<HostError>,
    listener: LocalListener,
    store: Store,
    identity: HostIdentity,
    pin: IdentityPin,
    control: ContextToken,
    auth: AuthService,
    sessions: Sessions,
    normal: Arc<Semaphore>,
    urgent: Arc<Semaphore>,
    // Rust 按声明顺序释放字段，锁必须在其他运行态资源之后释放。
    _guard: InstanceGuard,
}
impl HostServer {
    pub async fn bind(profile: &Path) -> HostResult<Self> {
        let profile = profile.to_path_buf();
        let (guard, store, identity, pin, control) = blocking(move || {
            let guard = InstanceGuard::acquire(&profile)?;
            let existing_database = guard.namespace().join("state.sqlite3").exists();
            let pin_path = guard.namespace().join("identity.secret");
            let saved_pin: Option<IdentityPin> = local::read_secret(&pin_path)?
                .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| unauthenticated()))
                .transpose()?;
            if let Some(pin) = &saved_pin {
                pin.verify_profile(guard.profile())?;
            } else if existing_database {
                return Err(unauthenticated());
            }
            let store = Store::open(guard.profile())?;
            let identity = store.begin_instance()?;
            let pin: IdentityPin = match saved_pin {
                Some(pin) => pin,
                None => {
                    let pin = IdentityPin::new(identity.host_id.clone(), guard.profile())?;
                    local::write_secret_new(
                        &pin_path,
                        &serde_json::to_vec(&pin).map_err(|_| storage())?,
                    )?;
                    pin
                }
            };
            if pin.host_id != identity.host_id {
                return Err(host_mismatch());
            }
            let control_path = guard.namespace().join("user-control.secret");
            let control = match local::read_secret(&control_path)? {
                Some(bytes) => ContextToken::try_from(
                    std::str::from_utf8(&bytes).map_err(|_| unauthenticated())?,
                )?,
                None => {
                    let secret = random_token();
                    local::write_secret_new(&control_path, secret.as_str().as_bytes())?;
                    secret
                }
            };
            store.recover()?;
            Ok((guard, store, identity, pin, control))
        })
        .await?;
        let runtime = runtime_directory(guard.namespace(), &identity.host_id)?;
        let runtime_for_prepare = runtime.clone();
        blocking(move || local::prepare_private_directory(&runtime_for_prepare)).await?;
        repair_old_endpoint(guard.namespace(), &runtime, &identity.host_id)?;
        let listener = LocalListener::bind(&runtime, &uuid::Uuid::new_v4().to_string())?;
        let discovery = DiscoveryRecord {
            host_id: identity.host_id.clone(),
            instance_epoch: identity.instance_epoch,
            endpoint: listener.endpoint().into(),
            pid: std::process::id(),
            protocol_version: ProtocolVersion::V0_1,
        };
        let path = guard.namespace().join("discovery.json");
        blocking(move || discovery.write(&path)).await?;
        let auth = AuthService::new(store.clone(), control.clone());
        Ok(Self {
            #[cfg(test)]
            accept_error: None,
            _guard: guard,
            listener,
            store,
            identity,
            pin,
            control,
            auth,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            normal: Arc::new(Semaphore::new(crate::limits::NORMAL_OPERATIONS)),
            urgent: Arc::new(Semaphore::new(crate::limits::STOP_OPERATIONS)),
        })
    }
    pub fn auth(&self) -> AuthService {
        self.auth.clone()
    }
    pub fn store(&self) -> Store {
        self.store.clone()
    }
    pub fn identity(&self) -> &HostIdentity {
        &self.identity
    }
    pub fn write_bootstrap_capability(&self) -> HostResult<()> {
        local::write_bootstrap_capability(self.control.as_str().as_bytes())
    }
    pub async fn serve_until<F: Future<Output = ()>>(
        &mut self,
        handler: Arc<dyn RequestHandler>,
        shutdown: F,
    ) -> HostResult<()> {
        tokio::pin!(shutdown);
        let stop_requested = handler.stop_requested();
        tokio::pin!(stop_requested);
        let connections = Arc::new(Semaphore::new(128));
        let mut tasks = JoinSet::new();
        let mut failure = None;
        loop {
            tokio::select! {
                _ = &mut shutdown => break,
                _ = &mut stop_requested => break,
                Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
                stream = async {
                    #[cfg(test)]
                    if let Some(error) = self.accept_error.take() { return Err(error); }
                    self.listener.accept().await
                } => {
                    let mut stream = match stream {
                        Ok(stream) => stream,
                        Err(error) => { failure = Some(error); break; }
                    };
                    let Ok(permit) = connections.clone().try_acquire_owned() else {
                        let frame = error_frame(new_request_id(), IpcChannel::Control, busy());
                        let _ = tokio::time::timeout(Duration::from_millis(100), write_frame(&mut stream, &frame, MAX_FRAME_BYTES)).await;
                        continue;
                    };
                    let state = ConnectionState { store: self.store.clone(), auth: self.auth.clone(), identity: self.identity.clone(), pin: self.pin.clone(), sessions: self.sessions.clone(), normal: self.normal.clone(), urgent: self.urgent.clone(), handler: handler.clone() };
                    tasks.spawn(async move { let _permit = permit; let _ = state.serve(stream).await; });
                }
            }
        }
        tasks.shutdown().await;
        // listener 与关闭错误都必须经过完整屏障，实例锁不能先于已归属任务释放。
        let shutdown_result = handler.shutdown().await;
        let store = self.store.clone();
        let checkpoint_result = blocking(move || store.checkpoint()).await;
        for (stage, result) in [
            ("shutdown", shutdown_result),
            ("checkpoint", checkpoint_result),
        ] {
            if let Err(error) = result {
                if failure.is_some() {
                    // 保留最早失败原因；次要清理错误只记录稳定 code。
                    eprintln!("Host cleanup {stage} failed: {}", error.code);
                } else {
                    failure = Some(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
}
impl Drop for HostServer {
    fn drop(&mut self) {
        // guard 在 Drop 返回后才释放；仅移除本实例的确切 socket。
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(self.listener.endpoint());
        }
    }
}
fn runtime_directory(namespace: &Path, host: &Id) -> HostResult<PathBuf> {
    #[cfg(unix)]
    {
        if namespace.as_os_str().as_encoded_bytes().len() + 48 > 103 {
            use sha2::Digest as _;
            let digest = format!(
                "{:x}",
                sha2::Sha256::digest(format!("{}:{}", namespace.display(), host).as_bytes())
            );
            return Ok(Path::new("/tmp")
                .canonicalize()
                .map_err(|_| storage())?
                .join(format!("swb-{}", &digest[..24])));
        }
    }
    let _ = host;
    Ok(namespace.to_path_buf())
}
fn repair_old_endpoint(namespace: &Path, runtime: &Path, host: &Id) -> HostResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if let Ok(old) = DiscoveryRecord::read(&namespace.join("discovery.json")) {
            let endpoint = Path::new(&old.endpoint);
            if &old.host_id == host
                && endpoint.parent() == Some(runtime)
                && std::fs::symlink_metadata(endpoint).is_ok_and(|m| m.file_type().is_socket())
            {
                std::fs::remove_file(endpoint).map_err(|_| storage())?;
            }
        }
    }
    let _ = (namespace, runtime, host);
    Ok(())
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FailingShutdown {
        count: Arc<AtomicUsize>,
        profile: PathBuf,
    }
    impl RequestHandler for FailingShutdown {
        fn handle(&self, _: ConnectionContext, _: RpcRequest) -> HandlerFuture {
            Box::pin(async { Err(HostError::new("UNSUPPORTED_CAPABILITY", "No test handler")) })
        }
        fn shutdown(&self) -> Pin<Box<dyn Future<Output = HostResult<()>> + Send>> {
            assert!(local::profile_has_running_host(&self.profile).unwrap());
            self.count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async {
                Err(HostError::new(
                    "TEST_SHUTDOWN_ERROR",
                    "Injected shutdown failure",
                ))
            })
        }
    }

    #[tokio::test]
    async fn cleanup_error_does_not_skip_checkpoint_or_replace_accept_error() {
        for accept_error in [false, true] {
            let directory =
                tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
            let mut server = HostServer::bind(directory.path()).await.unwrap();
            let database =
                rusqlite::Connection::open(directory.path().join("host-v0/state.sqlite3")).unwrap();
            database.execute_batch("CREATE TABLE cleanup_audit (stage TEXT NOT NULL); CREATE TRIGGER observe_checkpoint AFTER UPDATE OF retention_clock_ns ON host_identity BEGIN INSERT INTO cleanup_audit VALUES('checkpoint'); END;").unwrap();
            if accept_error {
                server.accept_error = Some(HostError::new(
                    "TEST_ACCEPT_ERROR",
                    "Injected listener failure",
                ));
            }
            let shutdown_count = Arc::new(AtomicUsize::new(0));
            let result = server
                .serve_until(
                    Arc::new(FailingShutdown {
                        count: shutdown_count.clone(),
                        profile: directory.path().into(),
                    }),
                    async {
                        if accept_error {
                            std::future::pending::<()>().await;
                        }
                    },
                )
                .await;
            let checkpoints: i64 = database
                .query_row("SELECT count(*) FROM cleanup_audit", [], |row| row.get(0))
                .unwrap();
            assert_eq!(
                checkpoints, 1,
                "checkpoint must still commit after a shutdown failure"
            );
            assert_eq!(shutdown_count.load(Ordering::SeqCst), 1);
            assert_eq!(
                result.unwrap_err().code,
                if accept_error {
                    "TEST_ACCEPT_ERROR"
                } else {
                    "TEST_SHUTDOWN_ERROR"
                }
            );
            assert!(local::profile_has_running_host(directory.path()).unwrap());
            drop(server);
            assert!(!local::profile_has_running_host(directory.path()).unwrap());
        }
    }
}
