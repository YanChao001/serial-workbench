use super::{
    protocol::*,
    server::{AuthorizedEvent, ConnectionContext, EventFrame, RequestHandler},
};
use crate::{
    auth::{AuthService, AuthenticatedActor, GrantStamp, HostIdentity},
    storage::Store,
};
use serial_workbench_core::*;
use serial_workbench_ipc::{
    self as local, LocalStream,
    frame::{MAX_FRAME_BYTES, read_frame, write_frame},
    identity::{IdentityPin, random_token},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, watch},
    task::JoinSet,
};

pub(super) struct ControlSession {
    connection_id: Id,
    actor: AuthenticatedActor,
    alive: watch::Sender<bool>,
    raw_attached: AtomicBool,
}
pub(super) type Sessions = Arc<Mutex<HashMap<ContextToken, Weak<ControlSession>>>>;
struct ConnectionGuard {
    context: ConnectionContext,
    session: Arc<ControlSession>,
    token: Option<ContextToken>,
    sessions: Sessions,
    handler: Arc<dyn RequestHandler>,
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        if let Some(token) = &self.token {
            self.session.alive.send_replace(false);
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.remove(token);
            }
        }
        self.handler.disconnected(&self.context);
        if self.token.is_none() {
            self.session.raw_attached.store(false, Ordering::Release);
        }
    }
}
struct PendingReply {
    frame: WireFrame,
    _permit: Option<OwnedSemaphorePermit>,
    stamp: Option<GrantStamp>,
    _raw_output_lease: Option<crate::stream::RawOutputLease>,
}
pub(super) struct ConnectionState {
    pub store: Store,
    pub auth: AuthService,
    pub identity: HostIdentity,
    pub pin: IdentityPin,
    pub sessions: Sessions,
    pub normal: Arc<Semaphore>,
    pub urgent: Arc<Semaphore>,
    pub handler: Arc<dyn RequestHandler>,
}
impl ConnectionState {
    pub async fn serve(self, mut stream: LocalStream) -> HostResult<()> {
        let (session, token, channel) =
            tokio::time::timeout(Duration::from_secs(5), self.handshake(&mut stream))
                .await
                .map_err(|_| unauthenticated())??;
        let (replies_tx, replies_rx) = mpsc::channel(256);
        let (events_tx, events_rx) = mpsc::channel(256);
        let (catalog_changed, catalog_rx) = watch::channel(None);
        let context = ConnectionContext {
            connection_id: session.connection_id.clone(),
            actor: session.actor.clone(),
            channel,
            events: events_tx,
            event_budget: Arc::new(Semaphore::new(4 * 1024 * 1024)),
            subscriptions: Arc::new(Mutex::new(std::collections::HashSet::new())),
            failed: Arc::new(tokio::sync::Notify::new()),
            catalog_changed,
        };
        let guard = ConnectionGuard {
            context: context.clone(),
            session: session.clone(),
            token,
            sessions: self.sessions.clone(),
            handler: self.handler.clone(),
        };
        let mut alive = session.alive.subscribe();
        // 关闭可能早于 subscribe；不能只等待下一次 watch 变化。
        if channel == IpcChannel::Raw && !*alive.borrow() {
            return Err(unauthenticated());
        }
        let (mut read, write) = tokio::io::split(stream);
        let mut writer_future = Box::pin(output_writer(
            write,
            replies_rx,
            events_rx,
            catalog_rx,
            self.auth.clone(),
            context.actor.clone(),
        ));
        let mut requests = JoinSet::new();
        loop {
            while requests.try_join_next().is_some() {}
            let incoming = tokio::select! {
                _ = &mut writer_future => break,
                _ = context.failed.notified() => break,
                _ = alive.changed(), if channel == IpcChannel::Raw => break,
                incoming = read_frame(&mut read, MAX_FRAME_BYTES) => incoming,
            };
            let frame = match incoming {
                Ok(Some(frame)) => frame,
                _ => break,
            };
            if channel == IpcChannel::Raw && !*alive.borrow() {
                break;
            }
            if frame.channel != channel {
                break;
            }
            let IpcMessage::Request { request } = frame.body else {
                break;
            };
            let urgent = is_urgent(&request) && channel == IpcChannel::Control;
            let permits = if urgent { &self.urgent } else { &self.normal };
            let permit = match permits.clone().try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => {
                    if replies_tx
                        .try_send(PendingReply {
                            frame: error_frame(frame.request_id, channel, busy()),
                            _permit: None,
                            stamp: None,
                            _raw_output_lease: None,
                        })
                        .is_err()
                    {
                        break;
                    }
                    continue;
                }
            };
            let context = context.clone();
            let store = self.store.clone();
            let identity = self.identity.clone();
            let handler = self.handler.clone();
            let auth = self.auth.clone();
            let sender = replies_tx.clone();
            let request_id = frame.request_id;
            requests.spawn(async move {
                let check_actor = context.actor.clone();
                let captured = blocking(move || auth.capture_grants(&check_actor)).await;
                let (stamp, authorization_error) = match captured {
                    Ok(stamp) => (stamp, None),
                    Err(error) => (None, Some(error)),
                };
                let validation = authorization_error.map_or_else(
                    || validate_request(&context, &identity, &request_id, &request),
                    Err,
                );
                let reply = match validation {
                    Err(error) => failure(error).into(),
                    Ok(()) => match *request {
                        RpcRequest::Attach(params) => {
                            match attach(&store, &identity, &context.actor, params).await {
                                Ok(result) => RpcReply::Success {
                                    ok: True,
                                    result: Box::new(RpcResult::Attach(result)),
                                }
                                .into(),
                                Err(error) => failure(error).into(),
                            }
                        }
                        request => handler
                            .handle(context, request)
                            .await
                            .unwrap_or_else(|error| failure(error).into()),
                    },
                };
                let _ = sender
                    .send(PendingReply {
                        frame: WireFrame {
                            request_id,
                            channel,
                            body: IpcMessage::Reply {
                                reply: Box::new(reply.wire_reply),
                            },
                        },
                        _permit: Some(permit),
                        stamp,
                        _raw_output_lease: reply.raw_output_lease,
                    })
                    .await;
            });
        }
        // token 与资源立即失效，handler 接纳过程可完成；执行队列不属于连接。
        drop(guard);
        drop(replies_tx);
        // 接纳结果没有接收者时释放发送等待，避免把断开的 reader 续活。
        drop(writer_future);
        while requests.join_next().await.is_some() {}
        Ok(())
    }
    async fn handshake(
        &self,
        stream: &mut LocalStream,
    ) -> HostResult<(Arc<ControlSession>, Option<ContextToken>, IpcChannel)> {
        let first = read_frame(stream, MAX_FRAME_BYTES)
            .await?
            .ok_or_else(unauthenticated)?;
        local::verify_peer(stream)?;
        let channel = first.channel;
        let first_id = first.request_id.clone();
        let result = async {
            if !matches!(channel, IpcChannel::Control | IpcChannel::Raw) {
                return Err(invalid());
            }
            let IpcMessage::ClientHello {
                supported_protocol_versions,
                client_nonce,
                expected_host_id,
            } = first.body
            else {
                return Err(invalid());
            };
            if !supported_protocol_versions.iter().any(|v| v == "0.1") {
                return Err(HostError::new(
                    "PROTOCOL_UNSUPPORTED",
                    "Host protocol 0.1 is required",
                ));
            }
            if expected_host_id.is_some_and(|id| id != self.identity.host_id) {
                return Err(host_mismatch());
            }
            let server_nonce = random_token();
            let proof =
                self.pin
                    .proof(self.identity.instance_epoch, &client_nonce, &server_nonce)?;
            write_frame(
                stream,
                &WireFrame {
                    request_id: first.request_id,
                    channel,
                    body: IpcMessage::HostHello {
                        protocol_version: ProtocolVersion::V0_1,
                        host_id: self.identity.host_id.clone(),
                        instance_epoch: self.identity.instance_epoch,
                        server_nonce,
                        proof,
                    },
                },
                MAX_FRAME_BYTES,
            )
            .await?;
            let next = read_frame(stream, MAX_FRAME_BYTES)
                .await?
                .ok_or_else(unauthenticated)?;
            if next.channel != channel {
                return Err(invalid());
            }
            if channel == IpcChannel::Raw {
                let IpcMessage::RawAttach { token } = next.body else {
                    return Err(unauthenticated());
                };
                let session = self
                    .sessions
                    .lock()
                    .map_err(|_| storage())?
                    .get(&token)
                    .and_then(Weak::upgrade)
                    .ok_or_else(unauthenticated)?;
                if !*session.alive.borrow() || session.raw_attached.swap(true, Ordering::AcqRel) {
                    return Err(unauthenticated());
                }
                if let Err(error) = write_frame(
                    stream,
                    &WireFrame {
                        request_id: next.request_id,
                        channel,
                        body: IpcMessage::RawAttached {},
                    },
                    MAX_FRAME_BYTES,
                )
                .await
                {
                    session.raw_attached.store(false, Ordering::Release);
                    return Err(error);
                }
                return Ok((session, None, channel));
            }
            let auth = self.auth.clone();
            let authentication = match next.body {
                IpcMessage::Authenticate {
                    client_id,
                    credential,
                } => blocking(move || auth.authenticate(&client_id, credential.as_ref())).await?,
                IpcMessage::AuthenticateUserControl {
                    client_id,
                    credential,
                } => {
                    blocking(move || {
                        auth.authenticate_user_control(&client_id, &credential)
                            .map(|actor| crate::auth::Authentication {
                                actor,
                                issued_credential: None,
                            })
                    })
                    .await?
                }
                _ => return Err(unauthenticated()),
            };
            let (alive, _) = watch::channel(true);
            let session = Arc::new(ControlSession {
                connection_id: new_id(),
                actor: authentication.actor,
                alive,
                raw_attached: AtomicBool::new(false),
            });
            let token = random_token();
            self.sessions
                .lock()
                .map_err(|_| storage())?
                .insert(token.clone(), Arc::downgrade(&session));
            if let Err(error) = write_frame(
                stream,
                &WireFrame {
                    request_id: next.request_id,
                    channel,
                    body: IpcMessage::Authenticated {
                        credential: authentication.issued_credential,
                        raw_attach_token: token.clone(),
                    },
                },
                MAX_FRAME_BYTES,
            )
            .await
            {
                self.sessions.lock().map_err(|_| storage())?.remove(&token);
                return Err(error);
            }
            Ok((session, Some(token), channel))
        }
        .await;
        if let Err(error) = &result {
            let _ = write_frame(
                stream,
                &error_frame(first_id, channel, error.clone()),
                MAX_FRAME_BYTES,
            )
            .await;
        }
        result
    }
}
struct WriteProgress<'a, W> {
    writer: &'a mut W,
    started: bool,
}
impl<W: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for WriteProgress<'_, W> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        bytes: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        let result = std::pin::Pin::new(&mut *this.writer).poll_write(cx, bytes);
        if matches!(result, std::task::Poll::Ready(Ok(written)) if written > 0) {
            this.started = true;
        }
        result
    }
    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut *self.get_mut().writer).poll_flush(cx)
    }
    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut *self.get_mut().writer).poll_shutdown(cx)
    }
}
enum GuardedWrite {
    Written,
    NotWritten(HostError),
}
async fn write_guarded_frame<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &WireFrame,
    invalidated: impl std::future::Future<Output = HostError> + Send,
) -> HostResult<GuardedWrite> {
    let mut progress = WriteProgress {
        writer,
        started: false,
    };
    let interrupted = {
        tokio::select! {
            biased;
            error = invalidated => Some(error),
            result = tokio::time::timeout(Duration::from_secs(5), write_frame(&mut progress, frame, MAX_FRAME_BYTES)) => {
                result.map_err(|_| busy())??;
                None
            },
        }
    };
    match interrupted {
        Some(error) if progress.started => Err(error),
        Some(error) => Ok(GuardedWrite::NotWritten(error)),
        None => Ok(GuardedWrite::Written),
    }
}
async fn output_writer<W: tokio::io::AsyncWrite + Unpin>(
    mut writer: W,
    mut replies: mpsc::Receiver<PendingReply>,
    mut events: mpsc::Receiver<AuthorizedEvent>,
    mut catalog_changed: watch::Receiver<Option<WireFrame>>,
    auth: AuthService,
    actor: AuthenticatedActor,
) -> HostResult<()> {
    loop {
        let event = tokio::select! {
            biased;
            reply = replies.recv() => match reply {
                Some(mut reply) => {
                    let changes = auth.subscribe_changes();
                    if let Some(stamp) = reply.stamp.clone() {
                        let check = auth.clone();
                        if let Err(error) = blocking(move || check.validate_grants(&stamp)).await {
                            reply.frame.body = IpcMessage::Reply { reply: Box::new(failure(error)) };
                            reply._raw_output_lease = None;
                            reply.stamp = None;
                        }
                    }
                    let result = if reply.frame.channel == IpcChannel::Raw {
                        let invalidated = async {
                            wait_raw_revocation(auth.clone(), reply.stamp.clone(), changes).await;
                            HostError::new("PERMISSION_DENIED", "Reply authorization ended")
                        };
                        match write_guarded_frame(&mut writer, &reply.frame, invalidated).await {
                            Ok(GuardedWrite::Written) => Ok(()),
                            Ok(GuardedWrite::NotWritten(error)) => {
                                reply.frame.body = IpcMessage::Reply { reply: Box::new(failure(error)) };
                                reply._raw_output_lease = None;
                                tokio::time::timeout(Duration::from_secs(5), write_frame(&mut writer, &reply.frame, MAX_FRAME_BYTES)).await.map_err(|_| busy())?
                            },
                            Err(error) => Err(error),
                        }
                    } else {
                        tokio::time::timeout(Duration::from_secs(5), write_frame(&mut writer, &reply.frame, MAX_FRAME_BYTES)).await.map_err(|_| busy())?
                    };
                    if let Err(error) = result {
                        if error.code != "LIMIT_EXCEEDED" { return Err(error); }
                        let rejected = error_frame(reply.frame.request_id.clone(), reply.frame.channel, error);
                        tokio::time::timeout(Duration::from_secs(5), write_frame(&mut writer, &rejected, MAX_FRAME_BYTES)).await.map_err(|_| busy())??;
                    }
                    continue;
                },
                None => break,
            },
            changed = catalog_changed.changed() => {
                if changed.is_err() { break; }
                let latest = catalog_changed.borrow_and_update().clone();
                if let Some(frame) = latest {
                    tokio::time::timeout(Duration::from_secs(5), write_frame(&mut writer, &frame, MAX_FRAME_BYTES)).await.map_err(|_| busy())??;
                }
                continue;
            },
            event = events.recv() => match event { Some(event) => event, None => break },
        };
        let frame = event.frame.frame();
        if let EventFrame::Client { dispatch, .. } = &event.frame {
            // The operator receives the event, but the business actor's current
            // authority and the registered receiver generation authorize it.
            let changes = auth.subscribe_changes();
            let check = dispatch.clone();
            if let Err(error) = blocking(move || check.authorize()).await {
                let rejected = dispatch.clone();
                blocking(move || rejected.reject_undelivered(error)).await?;
                continue;
            }
            let invalidated = async {
                wait_raw_revocation(auth.clone(), dispatch.authority.stamp.clone(), changes).await;
                HostError::new("PERMISSION_DENIED", "Client effect authorization ended")
            };
            if let GuardedWrite::NotWritten(error) =
                write_guarded_frame(&mut writer, frame, invalidated).await?
            {
                let rejected = dispatch.clone();
                blocking(move || rejected.reject_undelivered(error)).await?;
            }
            // Once writing begins, failure or disconnect is uncertain. The
            // receiver's ledger retains capacity until a receipt or destruction.
            continue;
        }
        let subscription = match &frame.body {
            IpcMessage::Delta {
                subscription_id, ..
            } => Some(subscription_id.clone()),
            IpcMessage::RawBatch { batch } => Some(batch.subscription_id.clone()),
            _ => None,
        };
        if let Some(id) = &subscription
            && !event.subscriptions.lock().map_err(|_| busy())?.contains(id)
        {
            continue;
        }
        // 先订阅 watch 再复核，覆盖检查和开始写入之间的授权变化。
        let changes = auth.subscribe_changes();
        if let Some((permission, target)) = &event.grant {
            let check = auth.clone();
            let check_actor = actor.clone();
            let permission = permission.clone();
            let target = target.clone();
            let stamp = event.stamp.clone();
            if blocking(move || {
                let authorization = check.snapshot(&check_actor)?;
                authorization.require(&permission, &target)?;
                if let Some(stamp) = stamp {
                    authorization.validate_grants(&stamp)?;
                }
                Ok(())
            })
            .await
            .is_err()
            {
                let Some(subscription_id) = subscription else {
                    return Err(unauthenticated());
                };
                event
                    .subscriptions
                    .lock()
                    .map_err(|_| busy())?
                    .remove(&subscription_id);
                let ended = WireFrame {
                    request_id: frame.request_id.clone(),
                    channel: frame.channel,
                    body: IpcMessage::SubscriptionEnded {
                        subscription_id,
                        error: HostError::new(
                            "PERMISSION_DENIED",
                            "Subscription authorization ended",
                        ),
                    },
                };
                drop(event);
                tokio::time::timeout(
                    Duration::from_secs(5),
                    write_frame(&mut writer, &ended, MAX_FRAME_BYTES),
                )
                .await
                .map_err(|_| busy())??;
                continue;
            }
        }
        if event
            .delivery_liveness
            .as_ref()
            .is_some_and(|guard| !*guard.borrow())
        {
            continue;
        }
        if event.grant.is_some() {
            let invalidated = async {
                tokio::select! {
                    biased;
                    _ = wait_delivery_end(event.delivery_liveness.clone()) => HostError::new("EPOCH_MISMATCH", "Subscription delivery ended"),
                    _ = wait_raw_revocation(auth.clone(), event.stamp.clone(), changes) => HostError::new("PERMISSION_DENIED", "Subscription authorization ended"),
                }
            };
            if let GuardedWrite::NotWritten(_) =
                write_guarded_frame(&mut writer, frame, invalidated).await?
            {
                continue;
            }
        } else {
            tokio::time::timeout(
                Duration::from_secs(5),
                write_frame(&mut writer, frame, MAX_FRAME_BYTES),
            )
            .await
            .map_err(|_| busy())??;
        }
        if let EventFrame::Raw { delivery, batch } = event.frame {
            // 实际写出已结束；先归还临时预算，再由 mark_written 唤醒待发送者。
            drop(delivery);
            batch.mark_written()?;
        }
    }
    Ok(())
}
async fn wait_delivery_end(guard: Option<watch::Receiver<bool>>) {
    let Some(mut guard) = guard else {
        std::future::pending::<()>().await;
        return;
    };
    loop {
        if !*guard.borrow() || guard.changed().await.is_err() {
            return;
        }
    }
}
async fn wait_raw_revocation(
    auth: AuthService,
    stamp: Option<GrantStamp>,
    mut changes: watch::Receiver<U64>,
) {
    loop {
        tokio::select! {
            result=changes.changed()=>{if result.is_err(){return}},
            _=auth.wait_grant_expiry(stamp.as_ref())=>{},
        }
        if let Some(stamp) = stamp.clone() {
            let auth = auth.clone();
            if blocking(move || auth.validate_grants(&stamp))
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(value: &str) -> Id {
        Id::try_from(value).unwrap()
    }
    struct RawTest {
        _dir: tempfile::TempDir,
        store: Store,
        hub: crate::stream::StreamHub,
        source: crate::stream::StreamSource,
        auth: AuthService,
        actor: AuthenticatedActor,
        operator: AuthenticatedActor,
        target: Target,
        context: ConnectionContext,
        replies: mpsc::Sender<PendingReply>,
        replies_rx: Option<mpsc::Receiver<PendingReply>>,
        events_rx: Option<mpsc::Receiver<AuthorizedEvent>>,
    }
    impl RawTest {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let store = Store::open(dir.path()).unwrap();
            let identity = store.begin_instance().unwrap();
            let secret = ContextToken::try_from("raw-control").unwrap();
            let auth = AuthService::new(store.clone(), secret.clone());
            let actor = auth.authenticate(&id("raw-reader"), None).unwrap().actor;
            let operator = auth
                .authenticate_user_control(&id("raw-operator"), &secret)
                .unwrap();
            let target = Target {
                host_id: identity.host_id.clone(),
                kind: ResourceKind::try_from("session").unwrap(),
                id: id("raw-session"),
                session_id: Some(id("raw-session")),
                session_epoch: Some(1.into()),
            };
            auth.authorize(
                &operator,
                AuthorizeParams {
                    client_id: actor.client_id().clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
            let hub = crate::stream::StreamHub::new(
                identity,
                auth.clone(),
                crate::stream::StreamLimits::default(),
            );
            let source = hub
                .register_source(
                    crate::stream::StreamKey {
                        session_id: id("raw-session"),
                        session_epoch: 1.into(),
                    },
                    target.clone(),
                )
                .unwrap();
            let time:EventTime=serde_json::from_value(serde_json::json!({"clockId":"clock","sourceMonoNs":"0","receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"host"}})).unwrap();
            source
                .append_rx(
                    crate::stream::SourceMeta {
                        configuration_revision: 1.into(),
                        time,
                    },
                    Arc::from(vec![81u8; 16384]),
                    None,
                )
                .unwrap();
            let (events, events_rx) = mpsc::channel(16);
            let (replies, replies_rx) = mpsc::channel(16);
            let context = ConnectionContext {
                connection_id: id("raw-connection"),
                actor: actor.clone(),
                channel: IpcChannel::Raw,
                events,
                event_budget: Arc::new(Semaphore::new(4 * 1024 * 1024)),
                subscriptions: Arc::new(Mutex::new(std::collections::HashSet::new())),
                failed: Arc::new(tokio::sync::Notify::new()),
                catalog_changed: watch::channel(None).0,
            };
            Self {
                _dir: dir,
                store,
                hub,
                source,
                auth,
                actor,
                operator,
                target,
                context,
                replies,
                replies_rx: Some(replies_rx),
                events_rx: Some(events_rx),
            }
        }
        fn revoke(&self) {
            self.auth
                .revoke(
                    &self.operator,
                    RevokeParams {
                        actor_id: self.actor.id().clone(),
                        permissions: vec!["content.read".into()],
                        targets: vec![self.target.clone()],
                    },
                )
                .unwrap();
        }
        fn writer(
            &mut self,
            capacity: usize,
        ) -> (
            tokio::task::JoinHandle<HostResult<()>>,
            tokio::io::DuplexStream,
        ) {
            let (output, reader) = tokio::io::duplex(capacity);
            (
                tokio::spawn(output_writer(
                    output,
                    self.replies_rx.take().unwrap(),
                    self.events_rx.take().unwrap(),
                    self.context.catalog_changed.subscribe(),
                    self.auth.clone(),
                    self.actor.clone(),
                )),
                reader,
            )
        }
    }
    #[tokio::test]
    async fn client_effect_phases_share_permissions_but_recheck_before_delivery() {
        let mut f = RawTest::new();
        f.context.actor = f.operator.clone();
        f.context.channel = IpcChannel::Control;
        let effects = crate::client_effects::ClientEffects::new(f.store.clone(), f.auth.clone());
        let registration = effects
            .register(
                &f.context,
                ClientRegisterParams {
                    generation: 1.into(),
                    capabilities: vec![ClientCapability::DiagnosticsRead],
                },
            )
            .unwrap();
        f.auth
            .authorize(
                &f.operator,
                AuthorizeParams {
                    client_id: f.actor.client_id().clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![registration.target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        let before = f.auth.document_reads();
        let prepared = effects
            .prepare(
                &f.actor,
                &registration.target,
                new_request_id(),
                ClientEffectAction::DiagnosticsRead {},
            )
            .unwrap();
        assert_eq!(f.auth.document_reads() - before, 1);
        let before = f.auth.document_reads();
        let (dispatch, _waiter) = prepared.bind(None).unwrap();
        assert_eq!(f.auth.document_reads() - before, 1);
        let before = f.auth.document_reads();
        dispatch.authorize().unwrap();
        assert_eq!(f.auth.document_reads() - before, 1);
        let before = f.auth.document_reads();
        effects
            .mark_dispatched(&dispatch.request.delivery_id)
            .unwrap();
        assert_eq!(f.auth.document_reads() - before, 1);
        let before = f.auth.document_reads();
        assert_eq!(effects.list(&f.actor).unwrap().clients.len(), 1);
        assert_eq!(f.auth.document_reads() - before, 1);
        f.auth
            .revoke(
                &f.operator,
                RevokeParams {
                    actor_id: f.actor.id().clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![registration.target],
                },
            )
            .unwrap();
        assert_eq!(dispatch.authorize().unwrap_err().code, "PERMISSION_DENIED");
    }
    #[tokio::test]
    async fn raw_preparation_and_final_writer_use_separate_single_read_phases() {
        let mut f = RawTest::new();
        let after = f.source.initial_cursor();
        let before = f.auth.document_reads();
        let sub = f
            .hub
            .subscribe(
                &f.actor,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after,
                    queue_bytes: (4 * 1024 * 1024).into(),
                    initial_credit_bytes: (4 * 1024 * 1024).into(),
                    overflow_policy: OverflowPolicy::DropWithGap,
                },
            )
            .await
            .unwrap();
        assert_eq!(f.auth.document_reads() - before, 1);
        let before = f.auth.document_reads();
        let batch = sub.try_next().await.unwrap().unwrap();
        assert_eq!(f.auth.document_reads() - before, 1);
        f.context.register_subscription(sub.id().clone()).unwrap();
        sub.deliver(&f.context, &batch).unwrap();
        let before = f.auth.document_reads();
        let (writing, mut input) = f.writer(65536);
        let delivered = tokio::time::timeout(
            Duration::from_secs(3),
            read_frame(&mut input, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(matches!(delivered.body, IpcMessage::RawBatch { .. }));
        assert_eq!(f.auth.document_reads() - before, 1);
        sub.close();
        drop(f.replies);
        drop(f.context);
        tokio::time::timeout(Duration::from_secs(3), writing)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn zero_byte_grant_revocation_preserves_the_control_connection() {
        zero_byte_invalidation(false).await;
    }
    #[tokio::test]
    async fn zero_byte_epoch_end_preserves_the_control_connection() {
        zero_byte_invalidation(true).await;
    }
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::AsyncWrite;
    struct InvalidateBeforeWrite {
        output: tokio::io::DuplexStream,
        invalidate: Option<Box<dyn FnOnce() + Send>>,
        entered: Arc<tokio::sync::Notify>,
        blocked_header: Option<Vec<u8>>,
    }
    impl AsyncWrite for InvalidateBeforeWrite {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if let Some(invalidate) = self.invalidate.take() {
                assert_eq!(bytes.len(), 4, "No frame byte may precede the invalidation");
                self.blocked_header = Some(bytes.to_vec());
                invalidate();
                self.entered.notify_one();
            }
            if self.blocked_header.as_deref() == Some(bytes) {
                return Poll::Pending;
            }
            Pin::new(&mut self.output).poll_write(cx, bytes)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.output).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.output).poll_shutdown(cx)
        }
    }
    async fn zero_byte_invalidation(epoch: bool) {
        let mut f = RawTest::new();
        f.context.channel = IpcChannel::Control;
        let subscription = id("old-subscription");
        f.context
            .register_subscription(subscription.clone())
            .unwrap();
        let previous = f.source.initial_cursor();
        let mut cursor = previous.clone();
        cursor.position = 1.into();
        let (valid, guard) = watch::channel(true);
        f.context
            .emit_with_stamp(
                WireFrame {
                    request_id: new_request_id(),
                    channel: IpcChannel::State,
                    body: IpcMessage::Delta {
                        subscription_id: subscription,
                        delta: Box::new(Delta {
                            cursor,
                            previous_cursor: previous,
                            revision: 1.into(),
                            event_type: id("private.changed"),
                            payload: serde_json::from_value(
                                serde_json::json!({"secret":"must-not-be-written"}),
                            )
                            .unwrap(),
                        }),
                    },
                },
                "content.read",
                f.target.clone(),
                f.auth.capture_grants(&f.actor).unwrap(),
                Some(guard),
            )
            .unwrap();
        let auth = f.auth.clone();
        let actor = f.actor.clone();
        let operator = f.operator.clone();
        let target = f.target.clone();
        let invalidate: Box<dyn FnOnce() + Send> = if epoch {
            Box::new(move || {
                valid.send_replace(false);
            })
        } else {
            Box::new(move || {
                auth.revoke(
                    &operator,
                    RevokeParams {
                        actor_id: actor.id().clone(),
                        permissions: vec!["content.read".into()],
                        targets: vec![target],
                    },
                )
                .unwrap();
            })
        };
        let entered = Arc::new(tokio::sync::Notify::new());
        let (output, mut input) = tokio::io::duplex(65536);
        let writing = tokio::spawn(output_writer(
            InvalidateBeforeWrite {
                output,
                invalidate: Some(invalidate),
                entered: entered.clone(),
                blocked_header: None,
            },
            f.replies_rx.take().unwrap(),
            f.events_rx.take().unwrap(),
            f.context.catalog_changed.subscribe(),
            f.auth.clone(),
            f.actor.clone(),
        ));
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        let marker = id("unrelated-subscription");
        let marker_registration = f.context.register_subscription(marker.clone());
        f.context
            .end_subscription(new_request_id(), &marker, "EPOCH_MISMATCH");
        let observed = tokio::time::timeout(
            Duration::from_secs(3),
            read_frame(&mut input, MAX_FRAME_BYTES),
        )
        .await;
        drop(f.replies);
        let outcome = tokio::time::timeout(Duration::from_secs(3), writing).await;
        assert!(
            marker_registration.is_ok(),
            "An unwritten stale frame closed the control connection: {marker_registration:?}"
        );
        assert!(
            matches!(observed, Ok(Ok(Some(WireFrame { body: IpcMessage::SubscriptionEnded { ref subscription_id, .. }, .. }))) if subscription_id == &marker),
            "An unwritten stale frame interrupted the control stream: {observed:?}"
        );
        assert!(
            matches!(outcome, Ok(Ok(Ok(())))),
            "The writer did not remain usable: {outcome:?}"
        );
    }
    #[tokio::test]
    async fn zero_byte_client_effect_rejection_settles_failed_without_a_receipt() {
        let mut f = RawTest::new();
        f.context.channel = IpcChannel::Control;
        let store = f.store.clone();
        let host = crate::Host::new(store.clone(), f.auth.clone())
            .await
            .unwrap();
        let mut receiver = f.context.clone();
        receiver.actor = f.operator.clone();
        let reply = host
            .handle(
                receiver.clone(),
                RpcRequest::ClientRegister(ClientRegisterParams {
                    generation: 1.into(),
                    capabilities: vec![ClientCapability::ClipboardWriteText],
                }),
            )
            .await
            .unwrap();
        let RpcReply::Success { result, .. } = reply.wire_reply else {
            panic!("receiver registration failed")
        };
        let RpcResult::ClientRegistration(registration) = *result else {
            panic!("expected registration")
        };
        f.auth
            .authorize(
                &f.operator,
                AuthorizeParams {
                    client_id: f.actor.client_id().clone(),
                    permissions: vec!["client.clipboard.write".into()],
                    targets: vec![registration.target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        let identity = store.identity().unwrap();
        let operation = host
            .invoke(
                &f.actor,
                Call {
                    protocol_version: ProtocolVersion::V0_1,
                    host_id: identity.host_id.clone(),
                    instance_epoch: identity.instance_epoch,
                    actor_id: f.actor.id().clone(),
                    request_id: new_request_id(),
                    request_context: store.issue_context(&f.actor).unwrap().token,
                    action_id: id("client.clipboard.writeText"),
                    target: registration.target.clone(),
                    params: serde_json::from_value(
                        serde_json::json!({"text":"must-not-reach-the-platform"}),
                    )
                    .unwrap(),
                    reveal_target: RevealTarget {
                        page_id: id("settings"),
                        workspace_id: None,
                        session_id: None,
                        panel_id: None,
                        result_ref: None,
                    },
                    expected_revision: None,
                    lease_id: None,
                    execution_mode: Some(ExecutionMode::Interactive),
                },
            )
            .await
            .unwrap();
        let auth = f.auth.clone();
        let actor = f.actor.clone();
        let operator = f.operator.clone();
        let target = registration.target;
        let entered = Arc::new(tokio::sync::Notify::new());
        let (output, mut input) = tokio::io::duplex(65536);
        let writing = tokio::spawn(output_writer(
            InvalidateBeforeWrite {
                output,
                entered: entered.clone(),
                blocked_header: None,
                invalidate: Some(Box::new(move || {
                    auth.revoke(
                        &operator,
                        RevokeParams {
                            actor_id: actor.id().clone(),
                            permissions: vec!["client.clipboard.write".into()],
                            targets: vec![target],
                        },
                    )
                    .unwrap();
                })),
            },
            f.replies_rx.take().unwrap(),
            f.events_rx.take().unwrap(),
            f.context.catalog_changed.subscribe(),
            f.auth.clone(),
            f.operator.clone(),
        ));
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        let marker = id("still-connected");
        receiver.register_subscription(marker.clone()).unwrap();
        receiver.end_subscription(new_request_id(), &marker, "EPOCH_MISMATCH");
        let observed = tokio::time::timeout(
            Duration::from_secs(3),
            read_frame(&mut input, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let settled = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let QueryResult::Operation(result) = host
                    .query(
                        &f.operator,
                        Query {
                            protocol_version: ProtocolVersion::V0_1,
                            host_id: identity.host_id.clone(),
                            instance_epoch: identity.instance_epoch,
                            actor_id: f.operator.id().clone(),
                            request_id: new_request_id(),
                            action_id: id("operation.get"),
                            target: Target {
                                host_id: identity.host_id.clone(),
                                kind: ResourceKind::try_from("host").unwrap(),
                                id: identity.host_id.clone(),
                                session_id: None,
                                session_epoch: None,
                            },
                            params: serde_json::from_value(
                                serde_json::json!({"operationId":operation.operation_id}),
                            )
                            .unwrap(),
                            reveal_target: RevealTarget {
                                page_id: id("settings"),
                                workspace_id: None,
                                session_id: None,
                                panel_id: None,
                                result_ref: None,
                            },
                        },
                    )
                    .await
                    .unwrap()
                else {
                    panic!("expected operation")
                };
                if !matches!(
                    result.operation.state,
                    OperationState::Queued
                        | OperationState::Running
                        | OperationState::CancelRequested
                ) {
                    break result.operation;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        drop(f.replies);
        writing.await.unwrap().unwrap();
        host.shutdown().await.unwrap();
        assert!(
            matches!(observed.body, IpcMessage::SubscriptionEnded { subscription_id, .. } if subscription_id == marker)
        );
        assert_eq!(
            settled.state,
            OperationState::Failed,
            "Proven zero output cannot have an unknown platform effect"
        );
        assert_eq!(settled.error.unwrap().code, "PERMISSION_DENIED");
        assert!(
            settled.client_effect_receipt.is_none(),
            "Host rejection must not fabricate a platform receipt"
        );
    }

    #[tokio::test]
    async fn state_epoch_rebind_invalidates_queued_and_started_frames_under_unchanged_host_grant() {
        state_epoch_writer(false).await;
    }
    #[tokio::test]
    async fn state_epoch_rebind_interrupts_partial_frame_under_unchanged_host_grant() {
        state_epoch_writer(true).await;
    }
    async fn state_epoch_writer(started: bool) {
        use crate::state::{ProjectionLimits, ProjectionStore};
        use tokio::io::AsyncReadExt;
        {
            let mut f = RawTest::new();
            f.context.channel = IpcChannel::Control;
            let cursor = f.source.initial_cursor();
            let host_target = Target {
                host_id: cursor.host_id.clone(),
                kind: ResourceKind::try_from("host").unwrap(),
                id: cursor.host_id.clone(),
                session_id: None,
                session_epoch: None,
            };
            f.auth
                .authorize(
                    &f.operator,
                    AuthorizeParams {
                        client_id: f.actor.client_id().clone(),
                        permissions: vec!["content.read".into()],
                        targets: vec![host_target],
                        expires_at: None,
                    },
                )
                .unwrap();
            let projections = ProjectionStore::new(
                HostIdentity {
                    host_id: cursor.host_id,
                    instance_epoch: cursor.instance_epoch,
                    catalog_version: 1.into(),
                },
                f.auth.clone(),
                ProjectionLimits::default(),
            );
            let scope = id("session:raw-session");
            projections
                .register_scope(
                    scope.clone(),
                    f.target.clone(),
                    "content.read".into(),
                    JsonObject::new(),
                )
                .unwrap();
            let snapshot = projections.snapshot(&f.actor, &scope).await.unwrap();
            let mut subscription = projections
                .subscribe(&f.actor, &scope, &snapshot.cursor)
                .await
                .unwrap();
            let guard = subscription.delivery_liveness();
            f.context
                .register_subscription(subscription.id().clone())
                .unwrap();
            let payload: JsonObject =
                serde_json::from_value(serde_json::json!({"secret":"old-epoch"})).unwrap();
            projections
                .commit(&scope, id("session.changed"), payload.clone(), payload)
                .unwrap();
            f.context
                .emit_with_stamp(
                    WireFrame {
                        request_id: new_request_id(),
                        channel: IpcChannel::State,
                        body: IpcMessage::Delta {
                            subscription_id: subscription.id().clone(),
                            delta: Box::new(subscription.next().await.unwrap().unwrap()),
                        },
                    },
                    "content.read",
                    f.target.clone(),
                    subscription.grant_stamp(),
                    Some(guard),
                )
                .unwrap();
            let mut running = if started { Some(f.writer(1)) } else { None };
            if let Some((_, input)) = &mut running {
                input.read_u8().await.unwrap();
            }
            let mut reopened = f.target.clone();
            reopened.session_epoch = Some(2.into());
            projections
                .commit_for_target(
                    &scope,
                    reopened.clone(),
                    id("session.opened"),
                    JsonObject::new(),
                    JsonObject::new(),
                )
                .unwrap();
            f.auth.require(&f.actor, "content.read", &reopened).unwrap();
            let fresh_snapshot = projections.snapshot(&f.actor, &scope).await.unwrap();
            let mut fresh = projections
                .subscribe(&f.actor, &scope, &fresh_snapshot.cursor)
                .await
                .unwrap();
            projections
                .commit(
                    &scope,
                    id("session.changed"),
                    JsonObject::new(),
                    JsonObject::new(),
                )
                .unwrap();
            assert_eq!(fresh.next().await.unwrap().unwrap().revision.get(), 3);
            if let Some((mut writing, _)) = running {
                let result = tokio::time::timeout(Duration::from_secs(2), &mut writing).await;
                if result.is_err() {
                    writing.abort();
                }
                assert!(
                    result
                        .expect("old epoch must interrupt a partial frame")
                        .unwrap()
                        .is_err()
                );
            } else {
                // A registered termination marker makes the next observable frame unambiguous.
                let marker = id("marker");
                f.context.register_subscription(marker.clone()).unwrap();
                f.context
                    .end_subscription(new_request_id(), &marker, "EPOCH_MISMATCH");
                let (writing, mut input) = f.writer(65536);
                let frame = read_frame(&mut input, MAX_FRAME_BYTES)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    matches!(frame.body,IpcMessage::SubscriptionEnded {error,..} if error.code=="EPOCH_MISMATCH")
                );
                drop(f.replies);
                writing.await.unwrap().unwrap();
            }
        }
    }
    #[tokio::test]
    async fn raw_queued_batch_keeps_original_grant_and_shared_budget_until_drop() {
        let mut f = RawTest::new();
        let after = f.source.initial_cursor();
        let sub = f
            .hub
            .subscribe(
                &f.actor,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after,
                    queue_bytes: (4 * 1024 * 1024).into(),
                    initial_credit_bytes: (4 * 1024 * 1024).into(),
                    overflow_policy: OverflowPolicy::DropWithGap,
                },
            )
            .await
            .unwrap();
        f.context.register_subscription(sub.id().clone()).unwrap();
        let batch = sub.try_next().await.unwrap().unwrap();
        sub.deliver(&f.context, &batch).unwrap();
        drop(batch);
        f.revoke();
        f.auth
            .authorize(
                &f.operator,
                AuthorizeParams {
                    client_id: f.actor.client_id().clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![f.target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        sub.close();
        drop(sub);
        assert!(f.hub.memory_usage().reader_bytes > 0);
        let (writing, mut input) = f.writer(65536);
        let frame = tokio::time::timeout(
            Duration::from_secs(2),
            read_frame(&mut input, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(
            matches!(frame.body,IpcMessage::SubscriptionEnded {error,..} if error.code=="PERMISSION_DENIED")
        );
        drop(f.replies);
        writing.await.unwrap().unwrap();
        assert_eq!(f.hub.memory_usage().reader_bytes, 0);
    }
    #[tokio::test]
    async fn raw_prepared_batch_remains_writable_when_source_fills_reader_memory() {
        let mut f = RawTest::new();
        let after = f.source.initial_cursor();
        let sub = f
            .hub
            .subscribe(
                &f.actor,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after,
                    queue_bytes: 1048576.into(),
                    initial_credit_bytes: 1048576.into(),
                    overflow_policy: OverflowPolicy::DropWithGap,
                },
            )
            .await
            .unwrap();
        f.context.register_subscription(sub.id().clone()).unwrap();
        let time: EventTime = serde_json::from_value(serde_json::json!({
            "clockId":"clock", "sourceMonoNs":"0", "receivedWallTime":"2026-11-07T00:00:00Z",
            "precision":{"source":"host_read", "resolutionNs":"1", "syncMethod":"host"},
        }))
        .unwrap();
        let meta = crate::stream::SourceMeta {
            configuration_revision: 1.into(),
            time,
        };
        let (writing, mut input) = f.writer(65536);
        // 已写出而未 ACK 的批次保有其真实内存，先用正式 writer 建立该压力。
        for _ in 0..32 {
            let previous = sub.try_next().await.unwrap().unwrap();
            sub.deliver(&f.context, &previous).unwrap();
            tokio::time::timeout(
                Duration::from_secs(3),
                read_frame(&mut input, MAX_FRAME_BYTES),
            )
            .await
            .unwrap()
            .unwrap()
            .unwrap();
            f.source
                .append_rx(meta.clone(), Arc::from([42u8; 16]), None)
                .unwrap();
        }
        let batch = sub.try_next().await.unwrap().unwrap();
        sub.deliver(&f.context, &batch).unwrap();
        // 当前线程不让出执行权，固定入队后、writer 再次运行前源继续填充的时序。
        for _ in 0..2048 {
            f.source
                .append_rx(meta.clone(), Arc::from([42u8; 16]), None)
                .unwrap();
        }
        let frame = tokio::time::timeout(
            Duration::from_secs(3),
            read_frame(&mut input, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap()
        .expect("A prepared batch must survive later reader queue pressure");
        assert!(
            matches!(&frame.body, IpcMessage::RawBatch { batch: delivered } if delivered.cursor == batch.batch().cursor)
        );
        f.hub
            .credit(
                &f.actor,
                StreamCreditParams {
                    subscription_id: sub.id().clone(),
                    ack_cursor: batch.batch().cursor.clone(),
                    granted_bytes_total: 1048576.into(),
                },
            )
            .await
            .unwrap();
        assert!(f.hub.memory_usage().reader_peak <= 1048576);
        sub.close();
        drop(batch);
        drop(f.replies);
        writing.await.unwrap().unwrap();
        assert_eq!(f.hub.memory_usage().reader_bytes, 0);
    }
    #[tokio::test]
    async fn raw_cannot_bypass_shared_budget_via_plain_emit() {
        let f = RawTest::new();
        let after = f.source.initial_cursor();
        let sub = f
            .hub
            .subscribe(
                &f.actor,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after,
                    queue_bytes: (4 * 1024 * 1024).into(),
                    initial_credit_bytes: (4 * 1024 * 1024).into(),
                    overflow_policy: OverflowPolicy::DropWithGap,
                },
            )
            .await
            .unwrap();
        f.context.register_subscription(sub.id().clone()).unwrap();
        let batch = sub.try_next().await.unwrap().unwrap();
        assert!(
            f.context
                .emit(batch.frame().clone(), "content.read", f.target.clone())
                .is_err()
        );
    }
    #[tokio::test]
    async fn raw_ack_rejects_a_batch_queued_but_not_completely_written() {
        let mut f = RawTest::new();
        let after = f.source.initial_cursor();
        let sub = f
            .hub
            .subscribe(
                &f.actor,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after,
                    queue_bytes: (4 * 1024 * 1024).into(),
                    initial_credit_bytes: (4 * 1024 * 1024).into(),
                    overflow_policy: OverflowPolicy::DropWithGap,
                },
            )
            .await
            .unwrap();
        f.context.register_subscription(sub.id().clone()).unwrap();
        let batch = sub.try_next().await.unwrap().unwrap();
        sub.deliver(&f.context, &batch).unwrap();
        let params = StreamCreditParams {
            subscription_id: sub.id().clone(),
            ack_cursor: batch.batch().cursor.clone(),
            granted_bytes_total: (4 * 1024 * 1024).into(),
        };
        assert_eq!(
            f.hub
                .credit(&f.actor, params.clone())
                .await
                .expect_err("Queued bytes are not a sent batch boundary")
                .code,
            "INVALID_ARGUMENT"
        );
        let (writing, mut input) = f.writer(65536);
        let frame = read_frame(&mut input, MAX_FRAME_BYTES)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(frame.body, IpcMessage::RawBatch { .. }));
        let credited = f.hub.credit(&f.actor, params).await.unwrap();
        assert_eq!(
            credited.acknowledged_bytes_total.get(),
            serde_json::to_vec(batch.batch()).unwrap().len() as u64
        );
        sub.close();
        drop(batch);
        drop(f.replies);
        writing.await.unwrap().unwrap();
        assert_eq!(f.hub.memory_usage().reader_bytes, 0);
    }
    #[tokio::test]
    async fn raw_reattach_is_not_admitted_until_old_subscription_cleanup_finishes() {
        struct DuringCleanup(Arc<ControlSession>);
        impl RequestHandler for DuringCleanup {
            fn handle(
                &self,
                _: ConnectionContext,
                _: RpcRequest,
            ) -> super::super::server::HandlerFuture {
                Box::pin(async { Err(invalid()) })
            }
            fn disconnected(&self, _: &ConnectionContext) {
                // This is the same admission operation used by the real raw handshake.
                assert!(
                    self.0.raw_attached.swap(true, Ordering::AcqRel),
                    "A replacement raw connection entered before old reader cleanup"
                );
            }
        }
        let f = RawTest::new();
        let session = Arc::new(ControlSession {
            connection_id: f.context.connection_id.clone(),
            actor: f.actor.clone(),
            alive: watch::channel(true).0,
            raw_attached: AtomicBool::new(true),
        });
        drop(ConnectionGuard {
            context: f.context,
            session: session.clone(),
            token: None,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            handler: Arc::new(DuringCleanup(session.clone())),
        });
        assert!(
            !session.raw_attached.load(Ordering::Acquire),
            "The next raw attachment must be allowed after cleanup"
        );
    }
    #[tokio::test]
    async fn file_read_reply_stops_writing_sensitive_bytes_after_revocation() {
        use tokio::io::AsyncReadExt;
        let mut f = RawTest::new();
        f.replies
            .send(PendingReply {
                frame: WireFrame {
                    request_id: new_request_id(),
                    channel: IpcChannel::Raw,
                    body: IpcMessage::Reply {
                        reply: Box::new(RpcReply::Success {
                            ok: True,
                            result: Box::new(RpcResult::Query(QueryResult::FileRead(
                                FileReadResult {
                                    file_ref: ObjectRef {
                                        host_id: f.target.host_id.clone(),
                                        kind: ResourceKind::try_from("file").unwrap(),
                                        id: id("private-source"),
                                        revision: None,
                                    },
                                    offset: 0.into(),
                                    next_offset: 18.into(),
                                    total_bytes: 18.into(),
                                    bytes_base64: Bytes::try_from("ZmlsZS1hcGktcGxhaW50ZXh0")
                                        .unwrap(),
                                    fingerprint: Digest::try_from("a".repeat(64).as_str()).unwrap(),
                                    at_end: true,
                                },
                            ))),
                        }),
                    },
                },
                _permit: None,
                stamp: f.auth.capture_grants(&f.actor).unwrap(),
                _raw_output_lease: None,
            })
            .await
            .unwrap();
        let (mut writing, mut input) = f.writer(1);
        input.read_u8().await.unwrap();
        f.revoke();
        let result = tokio::time::timeout(Duration::from_secs(2), &mut writing).await;
        if result.is_err() {
            writing.abort();
        }
        assert!(
            result
                .expect("revocation must interrupt sensitive raw reply")
                .unwrap()
                .is_err()
        );
        let mut remaining = Vec::new();
        input.read_to_end(&mut remaining).await.unwrap();
        assert!(
            !remaining
                .windows(b"ZmlsZS1hcGktcGxhaW50ZXh0".len())
                .any(|bytes| bytes == b"ZmlsZS1hcGktcGxhaW50ZXh0")
        );
    }
    #[tokio::test]
    async fn slow_raw_control_reply_does_not_retain_revoked_queued_plaintext() {
        use tokio::io::AsyncReadExt;
        let mut f = RawTest::new();
        let after = f.source.initial_cursor();
        let sub = f
            .hub
            .subscribe(
                &f.actor,
                StreamSubscribeParams {
                    scope_id: after.scope_id.clone(),
                    after,
                    queue_bytes: (4 * 1024 * 1024).into(),
                    initial_credit_bytes: (4 * 1024 * 1024).into(),
                    overflow_policy: OverflowPolicy::DropWithGap,
                },
            )
            .await
            .unwrap();
        f.context.register_subscription(sub.id().clone()).unwrap();
        let batch = sub.try_next().await.unwrap().unwrap();
        sub.deliver(&f.context, &batch).unwrap();
        drop(batch);
        f.replies
            .send(PendingReply {
                frame: WireFrame {
                    request_id: new_request_id(),
                    channel: IpcChannel::Raw,
                    body: IpcMessage::Reply {
                        reply: Box::new(RpcReply::Success {
                            ok: True,
                            result: Box::new(RpcResult::Closed(ClosedResult { closed: True })),
                        }),
                    },
                },
                _permit: None,
                stamp: f.auth.capture_grants(&f.actor).unwrap(),
                _raw_output_lease: None,
            })
            .await
            .unwrap();
        let (mut writing, mut input) = f.writer(1);
        input.read_u8().await.unwrap();
        f.revoke();
        sub.close();
        let result = tokio::time::timeout(Duration::from_secs(2), &mut writing).await;
        if result.is_err() {
            writing.abort();
        }
        assert!(
            result
                .expect("Raw reply must not delay queued revocation cleanup")
                .unwrap()
                .is_err()
        );
        assert_eq!(f.hub.memory_usage().reader_bytes, 0);
    }
    #[tokio::test]
    async fn slow_raw_pull_writer_releases_reply_lease_on_revocation() {
        use tokio::io::AsyncReadExt;
        let mut f = RawTest::new();
        let prepared = f
            .hub
            .read_prepared(
                &f.actor,
                StreamReadParams {
                    session_id: id("raw-session"),
                    session_epoch: 1.into(),
                    start_event_seq: 1.into(),
                    max_events: 100.into(),
                    max_bytes: (256 * 1024).into(),
                },
            )
            .await
            .unwrap();
        let (result, lease) = prepared.into_parts();
        f.replies
            .send(PendingReply {
                frame: WireFrame {
                    request_id: RequestId::try_from("11111111-1111-4111-8111-111111111111")
                        .unwrap(),
                    channel: IpcChannel::Raw,
                    body: IpcMessage::Reply {
                        reply: Box::new(RpcReply::Success {
                            ok: True,
                            result: Box::new(RpcResult::StreamRead(result)),
                        }),
                    },
                },
                _permit: None,
                stamp: f.auth.capture_grants(&f.actor).unwrap(),
                _raw_output_lease: Some(lease),
            })
            .await
            .unwrap();
        let (writing, mut input) = f.writer(1);
        input.read_u8().await.unwrap();
        assert!(f.hub.memory_usage().reader_bytes > 0);
        f.revoke();
        assert!(
            tokio::time::timeout(Duration::from_secs(2), writing)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_eq!(f.hub.memory_usage().reader_bytes, 0);
    }
    #[tokio::test]
    async fn queued_delta_cannot_revive_after_revoke_and_reauthorize_before_writer_runs() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let identity = store.begin_instance().unwrap();
        let secret = ContextToken::try_from("test-control").unwrap();
        let auth = AuthService::new(store, secret.clone());
        let actor = auth.authenticate(&id("reader"), None).unwrap().actor;
        let operator = auth
            .authenticate_user_control(&id("operator"), &secret)
            .unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let grant = AuthorizeParams {
            client_id: actor.client_id().clone(),
            permissions: vec!["content.read".into()],
            targets: vec![target.clone()],
            expires_at: None,
        };
        auth.authorize(&operator, grant.clone()).unwrap();
        let original_stamp = auth.capture_grants(&actor).unwrap();
        let (events, events_rx) = mpsc::channel(4);
        let (replies, replies_rx) = mpsc::channel(4);
        let context = ConnectionContext {
            connection_id: id("connection"),
            actor: actor.clone(),
            channel: IpcChannel::Control,
            events,
            event_budget: Arc::new(Semaphore::new(4 * 1024 * 1024)),
            subscriptions: Arc::new(Mutex::new(std::collections::HashSet::new())),
            failed: Arc::new(tokio::sync::Notify::new()),
            catalog_changed: watch::channel(None).0,
        };
        context.register_subscription(id("subscription")).unwrap();
        let cursor = Cursor {
            host_id: identity.host_id,
            instance_epoch: identity.instance_epoch,
            scope_id: id("host.devices"),
            position: 1.into(),
        };
        let mut previous = cursor.clone();
        previous.position = 0.into();
        let payload =
            serde_json::from_value(serde_json::json!({"secret":"must-not-revive"})).unwrap();
        context
            .emit_with_stamp(
                WireFrame {
                    request_id: new_request_id(),
                    channel: IpcChannel::State,
                    body: IpcMessage::Delta {
                        subscription_id: id("subscription"),
                        delta: Box::new(Delta {
                            cursor,
                            previous_cursor: previous,
                            revision: 1.into(),
                            event_type: id("private.changed"),
                            payload,
                        }),
                    },
                },
                "content.read",
                target.clone(),
                original_stamp,
                None,
            )
            .unwrap();
        // 在writer真正开始前完成两次持久权限提交，排队正文只持旧代次。
        auth.revoke(
            &operator,
            RevokeParams {
                actor_id: actor.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
        auth.authorize(&operator, grant).unwrap();
        auth.require(&actor, "content.read", &target).unwrap();
        let (output, mut reader) = tokio::io::duplex(65536);
        let writing = tokio::spawn(output_writer(
            output,
            replies_rx,
            events_rx,
            context.catalog_changed.subscribe(),
            auth,
            actor,
        ));
        let frame = tokio::time::timeout(
            Duration::from_secs(3),
            read_frame(&mut reader, MAX_FRAME_BYTES),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        assert!(
            matches!(frame.body,IpcMessage::SubscriptionEnded {subscription_id,error} if subscription_id==id("subscription") && error.code=="PERMISSION_DENIED" && error.details.is_none())
        );
        drop(replies);
        writing.await.unwrap().unwrap();
    }
}
