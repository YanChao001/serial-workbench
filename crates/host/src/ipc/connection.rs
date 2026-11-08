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
                        }
                    }
                    let result = if reply.frame.channel == IpcChannel::Raw {
                        tokio::select! {
                            result = tokio::time::timeout(Duration::from_secs(5), write_frame(&mut writer, &reply.frame, MAX_FRAME_BYTES)) => result.map_err(|_| busy())?,
                            _ = wait_raw_revocation(auth.clone(), reply.stamp.clone(), changes) => return Err(unauthenticated()),
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
            tokio::select! {
                biased;
                _ = wait_raw_revocation(auth.clone(), dispatch.authority.stamp.clone(), changes) => return Err(unauthenticated()),
                result = tokio::time::timeout(Duration::from_secs(5), write_frame(&mut writer, frame, MAX_FRAME_BYTES)) => result.map_err(|_| busy())??,
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
                check.require(&check_actor, &permission, &target)?;
                if let Some(stamp) = stamp {
                    check.validate_grants(&stamp)?;
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
        let encoding = match &event.frame {
            EventFrame::Raw { batch, .. } => Some(batch.encoding_lease()?),
            EventFrame::State(_) | EventFrame::Client { .. } => None,
        };
        if event.grant.is_some() {
            let revoked = wait_raw_revocation(auth.clone(), event.stamp.clone(), changes);
            tokio::select! {
                biased;
                _=wait_delivery_end(event.delivery_liveness.clone())=>return Err(HostError::new("EPOCH_MISMATCH","Subscription delivery ended")),
                _=revoked=>return Err(unauthenticated()),
                result=tokio::time::timeout(Duration::from_secs(5),write_frame(&mut writer,frame,MAX_FRAME_BYTES))=>result.map_err(|_|busy())??,
            }
        } else {
            tokio::time::timeout(
                Duration::from_secs(5),
                write_frame(&mut writer, frame, MAX_FRAME_BYTES),
            )
            .await
            .map_err(|_| busy())??;
        }
        drop(encoding);
        if let EventFrame::Raw { batch, .. } = &event.frame {
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
            let auth = AuthService::new(store, secret.clone());
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
