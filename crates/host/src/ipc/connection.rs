use super::{
    protocol::*,
    server::{AuthorizedEvent, ConnectionContext, RequestHandler},
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
        } else {
            self.session.raw_attached.store(false, Ordering::Release);
        }
        self.handler.disconnected(&self.context);
    }
}
struct PendingReply {
    frame: WireFrame,
    _permit: Option<OwnedSemaphorePermit>,
    stamp: Option<GrantStamp>,
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
        let context = ConnectionContext {
            connection_id: session.connection_id.clone(),
            actor: session.actor.clone(),
            channel,
            events: events_tx,
            event_budget: Arc::new(Semaphore::new(4 * 1024 * 1024)),
            subscriptions: Arc::new(Mutex::new(std::collections::HashSet::new())),
            failed: Arc::new(tokio::sync::Notify::new()),
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
                    Err(error) => failure(error),
                    Ok(()) => match *request {
                        RpcRequest::Attach(params) => {
                            match attach(&store, &identity, &context.actor, params).await {
                                Ok(result) => RpcReply::Success {
                                    ok: True,
                                    result: Box::new(RpcResult::Attach(result)),
                                },
                                Err(error) => failure(error),
                            }
                        }
                        request => handler
                            .handle(context, request)
                            .await
                            .unwrap_or_else(failure),
                    },
                };
                let _ = sender
                    .send(PendingReply {
                        frame: WireFrame {
                            request_id,
                            channel,
                            body: IpcMessage::Reply {
                                reply: Box::new(reply),
                            },
                        },
                        _permit: Some(permit),
                        stamp,
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
    auth: AuthService,
    actor: AuthenticatedActor,
) -> HostResult<()> {
    loop {
        let event = tokio::select! {
            biased;
            reply = replies.recv() => match reply {
                Some(mut reply) => {
                    if let Some(stamp) = reply.stamp.take() {
                        let check = auth.clone();
                        if let Err(error) = blocking(move || check.validate_grants(&stamp)).await {
                            reply.frame.body = IpcMessage::Reply { reply: Box::new(failure(error)) };
                        }
                    }
                    let result = tokio::time::timeout(Duration::from_secs(5), write_frame(&mut writer, &reply.frame, MAX_FRAME_BYTES)).await.map_err(|_| busy())?;
                    if let Err(error) = result {
                        if error.code != "LIMIT_EXCEEDED" { return Err(error); }
                        let rejected = error_frame(reply.frame.request_id.clone(), reply.frame.channel, error);
                        tokio::time::timeout(Duration::from_secs(5), write_frame(&mut writer, &rejected, MAX_FRAME_BYTES)).await.map_err(|_| busy())??;
                    }
                    continue;
                },
                None => break,
            },
            event = events.recv() => match event { Some(event) => event, None => break },
        };
        let check = auth.clone();
        let actor = actor.clone();
        if let IpcMessage::Delta {
            ref subscription_id,
            ..
        } = event.frame.body
            && !event
                .subscriptions
                .lock()
                .map_err(|_| busy())?
                .contains(subscription_id)
        {
            continue;
        }
        let frame = if let Some((permission, target)) = event.grant {
            let stamp = event.stamp;
            match blocking(move || {
                check.require(&actor, &permission, &target)?;
                if let Some(stamp) = stamp {
                    check.validate_grants(&stamp)?;
                }
                Ok(())
            })
            .await
            {
                Ok(()) => event.frame,
                Err(error) => match event.frame.body {
                    IpcMessage::Delta {
                        subscription_id, ..
                    } => {
                        event
                            .subscriptions
                            .lock()
                            .map_err(|_| busy())?
                            .remove(&subscription_id);
                        WireFrame {
                            request_id: event.frame.request_id,
                            channel: event.frame.channel,
                            body: IpcMessage::SubscriptionEnded {
                                subscription_id,
                                error: HostError::new(
                                    "PERMISSION_DENIED",
                                    "Subscription authorization ended",
                                ),
                            },
                        }
                    }
                    _ => error_frame(event.frame.request_id.clone(), event.frame.channel, error),
                },
            }
        } else {
            event.frame
        };
        tokio::time::timeout(
            Duration::from_secs(5),
            write_frame(&mut writer, &frame, MAX_FRAME_BYTES),
        )
        .await
        .map_err(|_| busy())??;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(value: &str) -> Id {
        Id::try_from(value).unwrap()
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
        let writing = tokio::spawn(output_writer(output, replies_rx, events_rx, auth, actor));
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
