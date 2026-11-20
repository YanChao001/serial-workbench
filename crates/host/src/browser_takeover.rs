//! 配对浏览器提请接管，本机用户确认后交由普通的 Host 动作结算。
use super::*;
use std::time::Duration;
use tokio::time::{Instant, sleep_until};

const CONFIRMATION_WINDOW: Duration = Duration::from_secs(120);

pub(super) struct PendingTakeover {
    pub(super) summary: BrowserTakeoverRequest,
    actor_id: Id,
    browser: ConnectionContext,
    deadline: Instant,
    reply: oneshot::Sender<HostResult<Operation>>,
}

impl Host {
    pub(super) async fn browser_takeover(
        &self,
        connection: ConnectionContext,
        params: BrowserTakeoverParams,
    ) -> HostResult<RpcResult> {
        match params {
            BrowserTakeoverParams::Request { target, actor_id } => self
                .request_browser_takeover(connection, target, actor_id)
                .await
                .map(operation_result),
            BrowserTakeoverParams::Decide {
                takeover_id,
                approve,
            } => {
                self.decide_browser_takeover(connection.actor, takeover_id, approve)
                    .await
            }
        }
    }

    async fn request_browser_takeover(
        &self,
        connection: ConnectionContext,
        target: Target,
        actor_id: Id,
    ) -> HostResult<Operation> {
        let mut listener = connection.browser_stopped.clone().ok_or_else(denied)?;
        target.validate()?;
        if target.kind.as_str() != "session" || target.session_epoch.is_none() {
            return Err(invalid());
        }
        let host = self.clone();
        let browser = connection.clone();
        let grant_target = target.clone();
        let mut grant_changes = self.inner.auth.subscribe_changes();
        let (reply, mut answered) = oneshot::channel();
        let takeover_id = new_id();
        let request_id = takeover_id.clone();
        let deadline = Instant::now() + CONFIRMATION_WINDOW;
        blocking(move || {
            host.require_live_browser(&browser, &target)?;
            let session = host.devices().session(&target)?.snapshot()?;
            if session.state != SessionState::Open {
                return Err(HostError::new(
                    "SESSION_NOT_OPEN",
                    "Serial session is not open",
                ));
            }
            let mut log = host.inner.activities.lock().map_err(|_| busy())?;
            if log.pending_takeover.is_some() {
                return Err(HostError::new(
                    "TAKEOVER_PENDING",
                    "Another takeover awaits local confirmation",
                ));
            }
            let client_id = log
                .records
                .iter()
                .rev()
                .find_map(|(entry, _)| {
                    (entry.actor_id == actor_id)
                        .then_some(entry.mcp_client_id.as_ref())
                        .flatten()
                })
                .cloned()
                .ok_or_else(|| {
                    HostError::new(
                        "NOT_FOUND",
                        "Selected MCP client is no longer in Host activity",
                    )
                })?;
            log.pending_takeover = Some(PendingTakeover {
                summary: BrowserTakeoverRequest {
                    takeover_id: request_id,
                    client_id,
                    device_id: session.device_id,
                    target,
                },
                actor_id,
                browser,
                deadline,
                reply,
            });
            if let Err(error) = host.publish_activity(&log) {
                log.pending_takeover = None;
                return Err(error);
            }
            Ok(())
        })
        .await?;

        let disconnected = async {
            tokio::select! {
                _ = connection.closed() => {},
                _ = listener.wait_for(|stopped| *stopped) => {},
            }
        };
        tokio::pin!(disconnected);
        let access_ended = async {
            let auth = &self.inner.auth;
            loop {
                let service = auth.clone();
                let actor = connection.actor.clone();
                let target = grant_target.clone();
                let checked = blocking(move || {
                    let grants = service.snapshot(&actor)?;
                    grants.require("device.modify", &target)?;
                    Ok(grants.capture_grants())
                })
                .await;
                let stamp = match checked {
                    Ok(stamp) => stamp,
                    Err(error) => break error,
                };
                tokio::select! {
                    _ = auth.wait_grant_expiry(stamp.as_ref()) => {},
                    changed = grant_changes.changed() => {
                        if changed.is_err() { break closed(); }
                    }
                }
            }
        };
        let cancellation = tokio::select! {
            biased;
            result = &mut answered => return result.map_err(|_| missing())?,
            _ = &mut disconnected => {
                self.remove_browser_takeover(takeover_id).await?;
                return Err(closed());
            }
            error = access_ended => error,
            _ = sleep_until(deadline) => expired(),
        };
        if self.remove_browser_takeover(takeover_id).await? {
            return Err(cancellation);
        }
        // 确认已取得请求。过期只约束确认之前的等待，接纳仍由 Host 完成。
        tokio::select! {
            result = answered => result.map_err(|_| missing())?,
            _ = &mut disconnected => Err(closed()),
        }
    }

    async fn remove_browser_takeover(&self, id: Id) -> HostResult<bool> {
        let host = self.clone();
        blocking(move || {
            let mut log = host.inner.activities.lock().map_err(|_| busy())?;
            if !log
                .pending_takeover
                .as_ref()
                .is_some_and(|request| request.summary.takeover_id == id)
            {
                return Ok(false);
            }
            log.pending_takeover.take();
            host.publish_activity(&log)?;
            Ok(true)
        })
        .await
    }

    async fn decide_browser_takeover(
        &self,
        operator: AuthenticatedActor,
        id: Id,
        approve: bool,
    ) -> HostResult<RpcResult> {
        let host = self.clone();
        let actor = operator.clone();
        let pending = blocking(move || {
            host.inner.auth.require_control(&actor)?;
            let mut log = host.inner.activities.lock().map_err(|_| busy())?;
            if !log
                .pending_takeover
                .as_ref()
                .is_some_and(|request| request.summary.takeover_id == id)
            {
                return Err(missing());
            }
            let pending = log.pending_takeover.take().expect("matched request");
            host.publish_activity(&log)?;
            Ok(pending)
        })
        .await?;
        if !approve {
            let _ = pending.reply.send(Err(HostError::new(
                "TAKEOVER_DECLINED",
                "Local user declined takeover",
            )));
            return Ok(RpcResult::Closed(ClosedResult { closed: True }));
        }
        let result = self.accept_browser_takeover(&operator, &pending).await;
        let _ = pending.reply.send(result.clone());
        result.map(operation_result)
    }

    async fn accept_browser_takeover(
        &self,
        operator: &AuthenticatedActor,
        pending: &PendingTakeover,
    ) -> HostResult<Operation> {
        let host = self.clone();
        let actor = operator.clone();
        let target = pending.summary.target.clone();
        let browser = pending.browser.clone();
        let actor_id = pending.actor_id.clone();
        let deadline = pending.deadline;
        let call = blocking(move || {
            if Instant::now() >= deadline {
                return Err(expired());
            }
            host.require_live_browser(&browser, &target)?;
            let store = &host.inner.store;
            let identity = store.identity()?;
            let context = store.issue_context(&actor)?;
            let spec = BuiltinAction::SessionTakeover.spec();
            Ok(Call {
                protocol_version: ProtocolVersion::V0_1,
                host_id: identity.host_id,
                instance_epoch: identity.instance_epoch,
                actor_id: actor.id().clone(),
                request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
                request_context: context.token,
                action_id: spec.action_id.clone(),
                target,
                params: object(serde_json::json!(TakeoverParams {
                    actor_id,
                    reason: TakeoverReason::User
                }))?,
                reveal_target: spec.reveal_target.clone(),
                expected_revision: None,
                lease_id: None,
                execution_mode: Some(ExecutionMode::Interactive),
            })
        })
        .await?;
        self.invoke(operator, call).await
    }

    fn require_live_browser(
        &self,
        connection: &ConnectionContext,
        target: &Target,
    ) -> HostResult<()> {
        let listener = connection.browser_stopped.as_ref().ok_or_else(denied)?;
        if *listener.borrow() || connection.is_closed() {
            return Err(closed());
        }
        self.inner
            .auth
            .require(&connection.actor, "device.modify", target)
    }
}

fn operation_result(operation: Operation) -> RpcResult {
    RpcResult::Operation(Box::new(OperationResult { operation }))
}
fn denied() -> HostError {
    HostError::new(
        "PERMISSION_DENIED",
        "Browser takeover requires a paired browser",
    )
}
fn closed() -> HostError {
    HostError::new("CLIENT_CLOSED", "Browser requesting takeover disconnected")
}
fn expired() -> HostError {
    HostError::new("TAKEOVER_EXPIRED", "Local takeover confirmation expired")
}
fn missing() -> HostError {
    HostError::new(
        "NOT_FOUND",
        "Browser takeover is no longer awaiting confirmation",
    )
}
