//! 统一动作接纳与连接适配；持久操作由 Store 持有，执行任务由 Host 持有。
use crate::{
    auth::{AuthService, AuthenticatedActor},
    device::{DeviceService, TransportOpener},
    ipc::{ConnectionContext, HandlerFuture, HandlerReply, RequestHandler},
    registry::Registry,
    state::{ProjectionLimits, ProjectionStore, Subscription},
    storage::{Acceptance, Settlement, Store, canonical_digest},
    stream::{RawOutputLease, RawSubscription, StreamHub, StreamLimits},
    transmission::TransmissionService,
};
use serde::{Serialize, de::DeserializeOwned};
use serial_workbench_core::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::{
    sync::{Semaphore, oneshot},
    task::JoinHandle,
};

#[derive(Clone)]
pub struct Host {
    inner: Arc<HostInner>,
}
struct HostInner {
    store: Store,
    auth: AuthService,
    registry: Arc<Registry>,
    projections: ProjectionStore,
    activities: Mutex<VecDeque<Activity>>,
    jobs: Mutex<Jobs>,
    capacity: Arc<Semaphore>,
    stop_capacity: Arc<Semaphore>,
    subscriptions: Mutex<HashMap<Id, Pump>>,
    operation_projection: tokio::sync::Mutex<()>,
    devices: DeviceService,
    streams: StreamHub,
    sessions: TransmissionService,
    stop_requested: tokio::sync::watch::Sender<bool>,
    catalog_watchers: tokio::sync::Mutex<HashMap<Id, oneshot::Sender<()>>>,
    #[cfg(test)]
    admission_gate: Mutex<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}
struct Jobs {
    closing: bool,
    handles: Vec<JoinHandle<()>>,
}
struct Pump {
    connection_id: Id,
    channel: IpcChannel,
    target: Target,
    stop: oneshot::Sender<()>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    activity_id: Id,
    actor_id: Id,
    request_id: RequestId,
    action_id: Id,
    target: Target,
    reveal_target: RevealTarget,
    observations: U64,
}
pub(crate) struct AcceptedCall {
    pub actor: AuthenticatedActor,
    pub call: Call,
    pub operation: Operation,
}
struct QueryOutput {
    result: QueryResult,
    raw_output_lease: Option<RawOutputLease>,
}
impl Host {
    pub async fn new(store: Store, auth: AuthService) -> HostResult<Self> {
        Self::with_runtime(
            store,
            auth,
            Arc::new(crate::clock::SystemClock::new()?),
            DeviceService::virtual_opener(),
        )
        .await
    }
    pub async fn with_runtime(
        store: Store,
        auth: AuthService,
        clock: Arc<dyn Clock>,
        opener: TransportOpener,
    ) -> HostResult<Self> {
        let registry_store = store.clone();
        let registry_auth = auth.clone();
        let registry =
            Arc::new(blocking(move || Registry::new(registry_store, registry_auth)).await?);
        let identity_store = store.clone();
        let identity = blocking(move || identity_store.identity()).await?;
        let streams = StreamHub::new(identity.clone(), auth.clone(), StreamLimits::default());
        let projections =
            ProjectionStore::new(identity.clone(), auth.clone(), ProjectionLimits::default());
        let devices = DeviceService::new(
            store.clone(),
            auth.clone(),
            identity.clone(),
            streams.clone(),
            clock,
            opener,
            projections.clone(),
        );
        let sessions = TransmissionService::new(devices.clone());
        let target = Target {
            host_id: identity.host_id.clone(),
            id: identity.host_id,
            kind: ResourceKind::try_from("host")?,
            session_id: None,
            session_epoch: None,
        };
        for scope in ["host.activity", "host.operations", "host.devices"] {
            projections.register_scope(
                id(scope),
                target.clone(),
                "metadata.read".into(),
                object(serde_json::json!({"items":[]}))?,
            )?;
        }
        let host = Self {
            inner: Arc::new(HostInner {
                store,
                auth,
                registry,
                projections,
                activities: Mutex::new(VecDeque::new()),
                jobs: Mutex::new(Jobs {
                    closing: false,
                    handles: Vec::new(),
                }),
                capacity: Arc::new(Semaphore::new(crate::limits::NORMAL_OPERATIONS)),
                stop_capacity: Arc::new(Semaphore::new(crate::limits::STOP_OPERATIONS)),
                subscriptions: Mutex::new(HashMap::new()),
                operation_projection: tokio::sync::Mutex::new(()),
                devices,
                streams,
                sessions,
                stop_requested: tokio::sync::watch::channel(false).0,
                catalog_watchers: tokio::sync::Mutex::new(HashMap::new()),
                #[cfg(test)]
                admission_gate: Mutex::new(None),
            }),
        };
        host.publish_operations().await?;
        Ok(host)
    }
    pub fn projections(&self) -> &ProjectionStore {
        &self.inner.projections
    }
    pub fn devices(&self) -> &DeviceService {
        &self.inner.devices
    }
    pub fn streams(&self) -> &StreamHub {
        &self.inner.streams
    }
    pub fn activity_count(&self) -> usize {
        self.inner.activities.lock().expect("activity mutex").len()
    }
    async fn validate(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        kind: ActionKind,
    ) -> HostResult<BuiltinAction> {
        if &query.actor_id != actor.id() {
            return Err(HostError::new(
                "ACTOR_MISMATCH",
                "Actor does not match authentication",
            ));
        }
        query.target.validate()?;
        let store = self.inner.store.clone();
        let auth = self.inner.auth.clone();
        let actor = actor.clone();
        let query = query.clone();
        blocking(move || {
            let identity = store.identity()?;
            if query.host_id != identity.host_id || query.target.host_id != identity.host_id {
                return Err(HostError::new(
                    "HOST_ID_MISMATCH",
                    "Target belongs to another Host",
                ));
            }
            if query.instance_epoch != identity.instance_epoch {
                return Err(HostError::new(
                    "EPOCH_MISMATCH",
                    "Host instance has changed",
                ));
            }
            let action = BuiltinAction::find(query.action_id.as_str())?;
            let spec = action.spec();
            if spec.kind != kind || !spec.target_kinds.contains(&query.target.kind) {
                return Err(invalid());
            }
            for permission in &spec.permissions {
                auth.require(&actor, permission, &query.target)?;
            }
            Ok(action)
        })
        .await
    }
    fn activity(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        action: BuiltinAction,
    ) -> HostResult<()> {
        let mut activities = self.inner.activities.lock().map_err(|_| busy())?;
        if let Some(existing) = activities
            .iter_mut()
            .find(|entry| entry.actor_id == *actor.id() && entry.request_id == query.request_id)
        {
            if existing.action_id != query.action_id || existing.target != query.target {
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Query identity already refers to another activity",
                ));
            }
            existing.observations = existing.observations.checked_next()?;
        } else {
            if activities.len() == 1024 {
                activities.pop_front();
            }
            activities.push_back(Activity {
                activity_id: new_id(),
                actor_id: actor.id().clone(),
                request_id: query.request_id.clone(),
                action_id: query.action_id.clone(),
                target: query.target.clone(),
                reveal_target: action.spec().reveal_target,
                observations: 1.into(),
            });
        }
        // 这里只发布活动元数据，params、正文、令牌及错误详情不进入共享投影。
        let state = object(serde_json::json!({"items":&*activities}))?;
        self.inner.projections.commit(
            &id("host.activity"),
            id("activity.changed"),
            state.clone(),
            state,
        )?;
        Ok(())
    }
    pub async fn query(&self, actor: &AuthenticatedActor, query: Query) -> HostResult<QueryResult> {
        self.query_connected(actor, query, None)
            .await
            .map(|output| output.result)
    }
    async fn query_connected(
        &self,
        actor: &AuthenticatedActor,
        query: Query,
        connection: Option<ConnectionContext>,
    ) -> HostResult<QueryOutput> {
        let action = self.validate(actor, &query, ActionKind::Query).await?;
        self.activity(actor, &query, action)?;
        let result = match action {
            BuiltinAction::StreamRead => {
                let _context = connection.ok_or_else(|| {
                    HostError::new(
                        "CLIENT_REQUIRED",
                        "Raw reads require a connection that retains the output budget",
                    )
                })?;
                let params: StreamReadParams = decode(&query.params)?;
                if params.session_id != query.target.id
                    || Some(params.session_epoch) != query.target.session_epoch
                {
                    return Err(invalid());
                }
                let (result, lease) = self
                    .inner
                    .streams
                    .read_prepared(actor, params)
                    .await?
                    .into_parts();
                return Ok(QueryOutput {
                    result: QueryResult::StreamRead(result),
                    raw_output_lease: Some(lease),
                });
            }
            BuiltinAction::StreamSubscribe => {
                let params: StreamSubscribeParams = decode(&query.params)?;
                if params.scope_id.as_str()
                    != format!(
                        "raw:{}:{}",
                        query.target.id,
                        query.target.session_epoch.ok_or_else(invalid)?
                    )
                {
                    return Err(invalid());
                }
                let context = connection.ok_or_else(|| {
                    HostError::new("CLIENT_REQUIRED", "Raw subscription requires a connection")
                })?;
                let subscription = self.inner.streams.subscribe(actor, params).await?;
                if subscription.target() != &query.target {
                    subscription.close();
                    return Err(invalid());
                }
                let subscription_id = subscription.id().clone();
                self.start_raw_pump(context, query.request_id, subscription)?;
                Ok(QueryResult::StreamSubscribe(StreamSubscribeResult {
                    subscription_id,
                }))
            }
            BuiltinAction::StreamCredit => {
                let params: StreamCreditParams = decode(&query.params)?;
                let context = connection.ok_or_else(|| {
                    HostError::new("CLIENT_REQUIRED", "Raw credit requires its connection")
                })?;
                {
                    let pumps = self.inner.subscriptions.lock().map_err(|_| busy())?;
                    let pump = pumps
                        .get(&params.subscription_id)
                        .ok_or_else(|| HostError::new("NOT_FOUND", "Subscription is not active"))?;
                    if pump.connection_id != context.connection_id
                        || pump.channel != context.channel
                        || pump.target != query.target
                    {
                        return Err(HostError::new(
                            "PERMISSION_DENIED",
                            "Subscription belongs to another connection or target",
                        ));
                    }
                }
                Ok(QueryResult::StreamCredit(
                    self.inner.streams.credit(actor, params).await?,
                ))
            }
            BuiltinAction::DeviceList => {
                let _: EmptyParams = decode(&query.params)?;
                Ok(QueryResult::Devices(DeviceList {
                    devices: vec![DeviceDescriptor {
                        device_id: id("virtual:echo"),
                        name: "Virtual echo".into(),
                    }],
                }))
            }
            BuiltinAction::SessionGet => {
                let _: EmptyParams = decode(&query.params)?;
                Ok(QueryResult::Session(
                    self.inner.devices.snapshot(&query.target).await?,
                ))
            }
            BuiltinAction::TxQueueStatus => {
                let _: EmptyParams = decode(&query.params)?;
                Ok(QueryResult::Queue(
                    self.inner.sessions.queue_status(&query.target).await?,
                ))
            }
            BuiltinAction::CatalogList => {
                let params = decode(&query.params)?;
                if let Some(context) = connection {
                    self.ensure_catalog_watch(context).await?;
                }
                let registry = self.inner.registry.clone();
                let actor = actor.clone();
                Ok(QueryResult::Catalog(
                    blocking(move || registry.list(&actor, params)).await?,
                ))
            }
            BuiltinAction::OperationGet => {
                let selector: OperationGetParams = decode(&query.params)?;
                let store = self.inner.store.clone();
                let auth = self.inner.auth.clone();
                let actor = actor.clone();
                let target = query.target;
                let operation = blocking(move || {
                    let mut operation = store.get_selected(&actor, &selector)?;
                    if target.kind.as_str() == "operation" && target.id != operation.operation_id {
                        return Err(invalid());
                    }
                    auth.require(&actor, "metadata.read", &operation.target)?;
                    if matches!(
                        operation.result,
                        Some(ActionResult::Tx(_) | ActionResult::Reference(_))
                    ) {
                        auth.require(&actor, "content.read", &operation.target)?;
                    }
                    if let Some(error) = operation.error.as_mut() {
                        error.details = None;
                    }
                    Ok(operation)
                })
                .await?;
                Ok(QueryResult::Operation(Box::new(OperationResult {
                    operation,
                })))
            }
            BuiltinAction::StateSnapshot => {
                let params: StateSnapshotParams = decode(&query.params)?;
                validate_scope(&params.scope_id, &query.target)?;
                Ok(QueryResult::Snapshot(
                    self.inner
                        .projections
                        .snapshot(actor, &params.scope_id)
                        .await?,
                ))
            }
            BuiltinAction::StateSubscribe => {
                let params: StateSubscribeParams = decode(&query.params)?;
                validate_scope(&params.scope_id, &query.target)?;
                let context = connection.ok_or_else(|| {
                    HostError::new(
                        "CLIENT_REQUIRED",
                        "State subscription requires a connection",
                    )
                })?;
                let subscription = self
                    .inner
                    .projections
                    .subscribe(actor, &params.scope_id, &params.after)
                    .await?;
                let subscription_id = subscription.id().clone();
                self.start_pump(context, query.request_id, subscription)?;
                Ok(QueryResult::Subscription(SubscriptionResult {
                    subscription_id,
                }))
            }
            BuiltinAction::SubscriptionClose => {
                let params: SubscriptionCloseParams = decode(&query.params)?;
                let context = connection.ok_or_else(|| {
                    HostError::new(
                        "CLIENT_REQUIRED",
                        "Closing a subscription requires its connection",
                    )
                })?;
                let mut pumps = self.inner.subscriptions.lock().map_err(|_| busy())?;
                if let Some(pump) = pumps.get(&params.subscription_id)
                    && (pump.connection_id != context.connection_id
                        || pump.channel != context.channel
                        || pump.target != query.target)
                {
                    return Err(HostError::new(
                        "PERMISSION_DENIED",
                        "Subscription belongs to another connection",
                    ));
                }
                if let Some(pump) = pumps.remove(&params.subscription_id) {
                    context.close_subscription(&params.subscription_id);
                    let _ = pump.stop.send(());
                }
                Ok(QueryResult::Closed(ClosedResult { closed: True }))
            }
            _ => Err(invalid()),
        };
        result.map(|result| QueryOutput {
            result,
            raw_output_lease: None,
        })
    }
    fn start_pump(
        &self,
        context: ConnectionContext,
        request_id: RequestId,
        mut subscription: Subscription,
    ) -> HostResult<()> {
        let subscription_id = subscription.id().clone();
        context.register_subscription(subscription_id.clone())?;
        let (stop, mut stopped) = oneshot::channel();
        self.inner.subscriptions.lock().map_err(|_| busy())?.insert(
            subscription_id.clone(),
            Pump {
                connection_id: context.connection_id.clone(),
                channel: context.channel,
                target: subscription.target().clone(),
                stop,
            },
        );
        let host = self.clone();
        tokio::spawn(async move {
            loop {
                if context.is_closed() {
                    break;
                }
                let next = tokio::select! { _=&mut stopped=>break, _=context.closed()=>break, next=subscription.next()=>next };
                match next {
                    Ok(Some(delta)) => {
                        let frame = WireFrame {
                            request_id: request_id.clone(),
                            channel: IpcChannel::State,
                            body: IpcMessage::Delta {
                                subscription_id: subscription_id.clone(),
                                delta: Box::new(delta),
                            },
                        };
                        if let Err(error) = context.emit_with_stamp(
                            frame,
                            subscription.permission(),
                            subscription.target().clone(),
                            subscription.grant_stamp(),
                            Some(subscription.delivery_liveness()),
                        ) {
                            context.end_subscription(
                                request_id.clone(),
                                &subscription_id,
                                &error.code,
                            );
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        context.end_subscription(request_id.clone(), &subscription_id, &error.code);
                        break;
                    }
                }
            }
            subscription.close();
            context.close_subscription(&subscription_id);
            if let Ok(mut pumps) = host.inner.subscriptions.lock() {
                pumps.remove(&subscription_id);
            }
        });
        Ok(())
    }
    fn start_raw_pump(
        &self,
        context: ConnectionContext,
        request_id: RequestId,
        subscription: RawSubscription,
    ) -> HostResult<()> {
        let subscription_id = subscription.id().clone();
        if context.is_closed() {
            subscription.close();
            return Err(HostError::new("CLIENT_CLOSED", "Connection is closed"));
        }
        if let Err(error) = context.register_subscription(subscription_id.clone()) {
            subscription.close();
            return Err(error);
        }
        let (stop, mut stopped) = oneshot::channel();
        self.inner.subscriptions.lock().map_err(|_| busy())?.insert(
            subscription_id.clone(),
            Pump {
                connection_id: context.connection_id.clone(),
                channel: context.channel,
                target: subscription.target().clone(),
                stop,
            },
        );
        let host = self.clone();
        tokio::spawn(async move {
            loop {
                if context.is_closed() {
                    break;
                }
                let next = tokio::select! {_=&mut stopped=>break,_=context.closed()=>break,next=subscription.next()=>next};
                match next {
                    Ok(Some(batch)) => {
                        if let Err(error) = subscription.deliver(&context, &batch) {
                            context.end_subscription(
                                request_id.clone(),
                                &subscription_id,
                                &error.code,
                            );
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        context.end_subscription(request_id.clone(), &subscription_id, &error.code);
                        break;
                    }
                }
            }
            subscription.close();
            context.close_subscription(&subscription_id);
            if let Ok(mut pumps) = host.inner.subscriptions.lock() {
                pumps.remove(&subscription_id);
            }
        });
        Ok(())
    }
    async fn catalog_visibility(
        &self,
        actor: &AuthenticatedActor,
    ) -> HostResult<crate::registry::CatalogVisibility> {
        loop {
            let registry = self.inner.registry.clone();
            let actor = actor.clone();
            match blocking(move || registry.visibility(&actor)).await {
                Err(error) if error.code == "CATALOG_CHANGED" => continue,
                result => return result,
            }
        }
    }
    async fn ensure_catalog_watch(&self, context: ConnectionContext) -> HostResult<()> {
        if context.channel != IpcChannel::Control || context.is_closed() {
            return Err(HostError::new(
                "CLIENT_CLOSED",
                "Catalog requires a live control connection",
            ));
        }
        let mut watchers = self.inner.catalog_watchers.lock().await;
        if watchers.contains_key(&context.connection_id) {
            return Ok(());
        }
        let mut changes = self.inner.auth.subscribe_changes();
        changes.borrow_and_update();
        let mut current = self.catalog_visibility(&context.actor).await?;
        if context.is_closed() {
            return Err(HostError::new("CLIENT_CLOSED", "Connection is closed"));
        }
        let (stop, mut stopped) = oneshot::channel();
        watchers.insert(context.connection_id.clone(), stop);
        let host = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = context.closed() => break,
                    result = changes.changed() => if result.is_err() { break; },
                    _ = host.inner.auth.wait_grant_expiry(current.stamp.as_ref()) => {},
                }
                let next = match host.catalog_visibility(&context.actor).await {
                    Ok(next) => next,
                    Err(_) => break,
                };
                if (next.version != current.version || next.token != current.token)
                    && context
                        .emit_catalog_changed(next.version, next.token.clone())
                        .is_err()
                {
                    break;
                }
                current = next;
            }
            host.inner
                .catalog_watchers
                .lock()
                .await
                .remove(&context.connection_id);
        });
        Ok(())
    }
    pub async fn invoke(
        &self,
        actor: &AuthenticatedActor,
        mut call: Call,
    ) -> HostResult<Operation> {
        let query = call_query(&call);
        let action = self.validate(actor, &query, ActionKind::Action).await?;
        call.params = match action {
            BuiltinAction::HostShutdown => normalize::<EmptyParams>(&call.params)?,
            BuiltinAction::Authorize => normalize::<AuthorizeParams>(&call.params)?,
            BuiltinAction::Revoke => normalize::<RevokeParams>(&call.params)?,
            BuiltinAction::OperationCancel => {
                let params: OperationCancelParams = decode(&call.params)?;
                if params.reason != CancelReason::User && !actor.is_user_control() {
                    return Err(HostError::new(
                        "PERMISSION_DENIED",
                        "Cancellation reason requires user control",
                    ));
                }
                normalize::<OperationCancelParams>(&call.params)?
            }
            action if action.is_device_action() => crate::transmission::normalize(action, &call)?,
            _ => return Err(invalid()),
        };
        call.reveal_target = action.spec().reveal_target;
        let lookup_store = self.inner.store.clone();
        let lookup_actor = actor.clone();
        let lookup_call = call.clone();
        if let Some(existing) = blocking(move || {
            lookup_store.lookup_call(
                &lookup_actor,
                &lookup_call,
                &canonical_digest(&lookup_call)?,
            )
        })
        .await?
        {
            return Ok(existing);
        }
        let capacity = if crate::limits::is_stop(call.action_id.as_str()) {
            &self.inner.stop_capacity
        } else {
            &self.inner.capacity
        };
        let permit = capacity.clone().try_acquire_owned().map_err(|_| busy())?;
        let (send, receive) = oneshot::channel();
        let host = self.clone();
        let actor = actor.clone();
        let admission = action
            .is_device_action()
            .then(|| self.inner.sessions.admission());
        let preparation = if action.is_device_action() {
            Some(self.inner.sessions.prepare(&call)?)
        } else {
            None
        };
        {
            let mut jobs = self.inner.jobs.lock().map_err(|_| busy())?;
            if jobs.closing {
                return Err(busy());
            }
            jobs.handles.retain(|handle| !handle.is_finished());
            jobs.handles.push(tokio::spawn(async move {
                let mut admission = admission;
                #[cfg(test)]
                {
                    let gate = host.inner.admission_gate.lock().expect("test gate").take();
                    if let Some((entered, release)) = gate {
                        let _ = entered.send(());
                        let _ = release.await;
                    }
                }
                let _permit = permit;
                let store = host.inner.store.clone();
                let accept_actor = actor.clone();
                let accept_call = call.clone();
                let accept_auth = host.inner.auth.clone();
                let acceptance = blocking(move || {
                    let stamp = accept_auth.capture_grants(&accept_actor)?;
                    store
                        .accept(
                            &accept_actor,
                            &accept_call,
                            &canonical_digest(&accept_call)?,
                        )
                        .map(|acceptance| (acceptance, stamp))
                })
                .await;
                match acceptance {
                    Err(error) => {
                        let _ = send.send(Err(error));
                    }
                    Ok((Acceptance::Existing(operation), _)) => {
                        let _ = send.send(Ok(operation));
                    }
                    Ok((Acceptance::New(operation), stamp)) => {
                        if action.is_device_action() {
                            if let Err(error) =
                                host.inner
                                    .sessions
                                    .track(&operation, stamp, call.lease_id.clone())
                            {
                                let _ = host
                                    .inner
                                    .sessions
                                    .reject_untracked(&operation, error.clone())
                                    .await;
                                let _ = send.send(Err(error));
                                return;
                            }
                            drop(admission.take());
                            let _ = send.send(Ok(operation.clone()));
                            let _ = host
                                .inner
                                .sessions
                                .execute(
                                    AcceptedCall {
                                        actor,
                                        call,
                                        operation,
                                    },
                                    preparation.expect("device preparation"),
                                )
                                .await;
                            let _ = host.publish_operations().await;
                            return;
                        }
                        let _ = send.send(Ok(operation.clone()));
                        let _ = host.publish_operations().await;
                        host.execute_short(
                            action,
                            AcceptedCall {
                                actor,
                                call,
                                operation,
                            },
                        )
                        .await;
                    }
                }
            }));
        }
        receive.await.map_err(|_| busy())?
    }
    async fn execute_short(&self, action: BuiltinAction, accepted: AcceptedCall) {
        if action == BuiltinAction::OperationCancel {
            let result = self.cancel_operation(&accepted).await;
            let store = self.inner.store.clone();
            let id = accepted.operation.operation_id;
            let _ = blocking(move || {
                store.settle(
                    &id,
                    match result {
                        Ok(operation) => Settlement {
                            state: OperationState::Succeeded,
                            result: Some(ActionResult::CancellationRequested(CancellationResult {
                                operation_id: operation.operation_id,
                                state: operation.state,
                            })),
                            error: None,
                        },
                        Err(error) => Settlement {
                            state: OperationState::Failed,
                            result: None,
                            error: Some(error),
                        },
                    },
                )
            })
            .await;
            let _ = self.publish_operations().await;
            return;
        }
        let store = self.inner.store.clone();
        let auth = self.inner.auth.clone();
        let operation_id = accepted.operation.operation_id.clone();
        let result = blocking(move || {
            let check = (|| {
                for permission in &action.spec().permissions {
                    auth.require(&accepted.actor, permission, &accepted.call.target)?;
                }
                if store.identity()?.instance_epoch != accepted.call.instance_epoch {
                    return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
                }
                Ok(())
            })();
            if let Err(error) = check {
                return store.settle(
                    &operation_id,
                    Settlement {
                        state: OperationState::Interrupted,
                        result: None,
                        error: Some(error),
                    },
                );
            }
            store.mark_dispatch(&operation_id)?;
            let result = (|| match action {
                BuiltinAction::HostShutdown => {
                    Ok(ActionResult::ShutdownRequested(ShutdownRequested {
                        instance_epoch: accepted.call.instance_epoch,
                    }))
                }
                BuiltinAction::Authorize => auth
                    .authorize(&accepted.actor, decode(&accepted.call.params)?)
                    .map(|grant_revision| {
                        ActionResult::AuthorizationChanged(AuthorizationResult { grant_revision })
                    }),
                BuiltinAction::Revoke => auth
                    .revoke(&accepted.actor, decode(&accepted.call.params)?)
                    .map(|grant_revision| {
                        ActionResult::AuthorizationChanged(AuthorizationResult { grant_revision })
                    }),
                BuiltinAction::OperationCancel => store
                    .request_cancel(&accepted.actor, &accepted.call.target.id)
                    .map(|operation| {
                        ActionResult::CancellationRequested(CancellationResult {
                            operation_id: operation.operation_id,
                            state: operation.state,
                        })
                    }),
                _ => Err(invalid()),
            })();
            match result {
                Ok(result) => store.settle(
                    &operation_id,
                    Settlement {
                        state: OperationState::Succeeded,
                        result: Some(result),
                        error: None,
                    },
                ),
                Err(error) => store.settle(
                    &operation_id,
                    Settlement {
                        state: OperationState::Failed,
                        result: None,
                        error: Some(error),
                    },
                ),
            }
        })
        .await;
        let stop = action == BuiltinAction::HostShutdown
            && matches!(&result, Ok(operation) if operation.state == OperationState::Succeeded
                && matches!(operation.result, Some(ActionResult::ShutdownRequested(_))));
        if result.is_ok() {
            let _ = self.publish_operations().await;
        }
        if stop {
            if let Ok(mut jobs) = self.inner.jobs.lock() {
                jobs.closing = true;
            }
            self.inner.stop_requested.send_replace(true);
        }
    }
    async fn cancel_operation(&self, accepted: &AcceptedCall) -> HostResult<Operation> {
        let store = self.inner.store.clone();
        let id = accepted.operation.operation_id.clone();
        blocking(move || store.mark_dispatch(&id)).await?;
        self.inner
            .sessions
            .cancel(&accepted.actor, &accepted.call.target.id)
            .await
    }
    async fn publish_operations(&self) -> HostResult<()> {
        let _projection = self.inner.operation_projection.lock().await;
        let store = self.inner.store.clone();
        let state = blocking(move || store.operation_metadata()).await?;
        self.inner.projections.commit(
            &id("host.operations"),
            id("operations.changed"),
            state.clone(),
            state,
        )?;
        Ok(())
    }
    pub async fn shutdown(&self) -> HostResult<()> {
        let handles = {
            let mut jobs = self.inner.jobs.lock().map_err(|_| busy())?;
            jobs.closing = true;
            std::mem::take(&mut jobs.handles)
        };
        self.inner.sessions.request_shutdown();
        let mut failure = None;
        for handle in handles {
            if handle.await.is_err() {
                failure.get_or_insert_with(busy);
            }
        }
        if let Err(error) = self.inner.devices.shutdown().await {
            failure.get_or_insert(error);
        }
        self.inner.subscriptions.lock().map_err(|_| busy())?.clear();
        self.inner.catalog_watchers.lock().await.clear();
        let store = self.inner.store.clone();
        if let Err(error) = blocking(move || store.checkpoint()).await {
            failure.get_or_insert(error);
        }
        failure.map_or(Ok(()), Err)
    }
}
impl RequestHandler for Host {
    fn stop_requested(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let mut stopped = self.inner.stop_requested.subscribe();
        Box::pin(async move {
            while !*stopped.borrow_and_update() {
                if stopped.changed().await.is_err() {
                    break;
                }
            }
        })
    }
    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<()>> + Send>> {
        let host = self.clone();
        Box::pin(async move { Host::shutdown(&host).await })
    }
    fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
        let host = self.clone();
        Box::pin(async move {
            let required = request.required_channel()?;
            if (context.channel == IpcChannel::Control && required == RequestChannel::Raw)
                || (context.channel == IpcChannel::Raw && required == RequestChannel::Control)
            {
                return Err(HostError::new(
                    "PERMISSION_DENIED",
                    "Request requires a different physical connection",
                ));
            }
            let generic = matches!(request, RpcRequest::Query(_));
            let actor = context.actor.clone();
            let mut raw_output_lease = None;
            let result = match request {
                RpcRequest::Invoke(call) | RpcRequest::OperationCancel(call) => {
                    RpcResult::Operation(Box::new(OperationResult {
                        operation: host.invoke(&actor, call).await?,
                    }))
                }
                RpcRequest::Query(q)
                | RpcRequest::CatalogList(q)
                | RpcRequest::OperationGet(q)
                | RpcRequest::StateSnapshot(q)
                | RpcRequest::StateSubscribe(q)
                | RpcRequest::SubscriptionClose(q)
                | RpcRequest::ObjectRead(q)
                | RpcRequest::StreamRead(q)
                | RpcRequest::StreamSubscribe(q)
                | RpcRequest::StreamCredit(q) => {
                    let output = host.query_connected(&actor, q, Some(context)).await?;
                    raw_output_lease = output.raw_output_lease;
                    let result = output.result;
                    if generic {
                        RpcResult::Query(result)
                    } else {
                        match result {
                            QueryResult::Catalog(value) => RpcResult::Catalog(value),
                            QueryResult::Operation(value) => RpcResult::Operation(value),
                            QueryResult::Snapshot(value) => RpcResult::Snapshot(value),
                            QueryResult::Subscription(value) => RpcResult::Subscription(value),
                            QueryResult::Closed(value) => RpcResult::Closed(value),
                            QueryResult::StreamRead(value) => RpcResult::StreamRead(value),
                            QueryResult::StreamSubscribe(value) => {
                                RpcResult::Subscription(SubscriptionResult {
                                    subscription_id: value.subscription_id,
                                })
                            }
                            QueryResult::StreamCredit(value) => RpcResult::StreamCredit(value),
                            other => RpcResult::Query(other),
                        }
                    }
                }
                _ => {
                    return Err(HostError::new(
                        "UNSUPPORTED_CAPABILITY",
                        "Action handler is not registered",
                    ));
                }
            };
            Ok(HandlerReply {
                wire_reply: RpcReply::Success {
                    ok: True,
                    result: Box::new(result),
                },
                raw_output_lease,
            })
        })
    }
    fn disconnected(&self, context: &ConnectionContext) {
        if let Ok(mut pumps) = self.inner.subscriptions.lock() {
            pumps.retain(|_, pump| {
                pump.connection_id != context.connection_id
                    || (context.channel == IpcChannel::Raw && pump.channel != IpcChannel::Raw)
            });
        }
    }
}
fn call_query(call: &Call) -> Query {
    Query {
        protocol_version: call.protocol_version,
        host_id: call.host_id.clone(),
        instance_epoch: call.instance_epoch,
        actor_id: call.actor_id.clone(),
        request_id: call.request_id.clone(),
        action_id: call.action_id.clone(),
        target: call.target.clone(),
        params: call.params.clone(),
        reveal_target: call.reveal_target.clone(),
    }
}
fn validate_scope(scope: &Id, target: &Target) -> HostResult<()> {
    let valid = match scope.as_str() {
        "host.activity" | "host.operations" | "host.devices" => target.kind.as_str() == "host",
        other => other.split_once(':').is_some_and(|(kind, id)| {
            ["workspace", "session"].contains(&kind)
                && target.kind.as_str() == kind
                && target.id.as_str() == id
        }),
    };
    if valid { Ok(()) } else { Err(invalid()) }
}
fn decode<T: DeserializeOwned>(params: &JsonObject) -> HostResult<T> {
    serde_json::from_value(serde_json::to_value(params).map_err(|_| invalid())?)
        .map_err(|_| invalid())
}
fn normalize<T: DeserializeOwned + Serialize>(params: &JsonObject) -> HostResult<JsonObject> {
    object(serde_json::to_value(decode::<T>(params)?).map_err(|_| invalid())?)
}
fn object(value: serde_json::Value) -> HostResult<JsonObject> {
    serde_json::from_value(value).map_err(|_| invalid())
}
fn id(value: &str) -> Id {
    Id::try_from(value).expect("static Id")
}
fn new_id() -> Id {
    id(&uuid::Uuid::new_v4().to_string())
}
fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Action parameters or target are invalid",
    )
}
fn busy() -> HostError {
    HostError::new("HOST_BUSY", "Host request capacity is exhausted")
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> HostResult<T> + Send + 'static,
) -> HostResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| HostError::new("STORAGE_UNAVAILABLE", "Host worker is unavailable"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{HostServer, InstanceGuard};
    #[tokio::test]
    async fn saturated_normal_operations_preserve_cancel_close_release_and_shutdown() {
        use crate::test_support as support;
        for stop in ["operation.cancel", "session.close", "lease.release"] {
            let h = support::Harness::new().await;
            let mut targets = vec![];
            let mut leases = vec![];
            for name in ["capacity-a", "capacity-b"] {
                let target = h.open(name).await;
                let op = h
                    .invoke(h.call(
                        &target,
                        "lease.acquire",
                        serde_json::json!({"kind":"exclusive","ttlMs":"30000"}),
                    ))
                    .await;
                support::until(|| {
                    h.store
                        .get(&h.actor, &op.operation_id)
                        .unwrap()
                        .result
                        .is_some()
                })
                .await;
                let Some(ActionResult::Lease(lease)) =
                    h.store.get(&h.actor, &op.operation_id).unwrap().result
                else {
                    panic!()
                };
                targets.push(target);
                leases.push(lease);
            }
            let mut queued = vec![];
            for index in 0..222 {
                queued.push(
                    h.invoke(h.call(
                        &targets[index % 2],
                        "session.tx",
                        serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
                    ))
                    .await,
                );
            }
            let ordinary = h
                .host
                .invoke(
                    &h.actor,
                    h.call(
                        &targets[0],
                        "session.tx",
                        serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
                    ),
                )
                .await;
            let (target, params) = match stop {
                "operation.cancel" => (
                    Target {
                        host_id: h.host_id.clone(),
                        kind: ResourceKind::try_from("operation").unwrap(),
                        id: queued[0].operation_id.clone(),
                        session_id: None,
                        session_epoch: None,
                    },
                    serde_json::json!({"reason":"user"}),
                ),
                "lease.release" => (
                    targets[0].clone(),
                    serde_json::json!({"leaseId":leases[0].lease_id}),
                ),
                _ => (targets[0].clone(), serde_json::json!({})),
            };
            let stopping = h.host.invoke(&h.actor, h.call(&target, stop, params)).await;
            tokio::time::timeout(std::time::Duration::from_secs(60), h.host.shutdown())
                .await
                .unwrap()
                .unwrap();
            assert!(
                matches!(ordinary,Err(ref error) if error.code=="HOST_BUSY"),
                "ordinary accepted while all normal slots occupied: {stop}"
            );
            assert!(
                stopping.is_ok(),
                "stop admission failed: {stop}: {stopping:?}"
            );
            assert!(h.probe.closes.load(std::sync::atomic::Ordering::SeqCst) >= 2);
        }
    }
    #[tokio::test]
    async fn cancelled_waiter_does_not_release_instance_lock_before_owned_admission_settles() {
        owned_admission_shutdown(false, false).await;
    }
    #[tokio::test]
    async fn listener_error_does_not_release_instance_lock_before_owned_admission_settles() {
        owned_admission_shutdown(true, false).await;
    }
    #[tokio::test]
    async fn shutdown_action_waits_for_owned_jobs_before_releasing_instance_lock() {
        owned_admission_shutdown(false, true).await;
    }
    #[tokio::test]
    async fn shutdown_rejects_ordinary_actor_and_settlement_failure_never_signals_stop() {
        let h = crate::test_support::Harness::new().await;
        let target = Target {
            host_id: h.host_id.clone(),
            id: h.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let call = h.call(&target, "host.shutdown", serde_json::json!({}));
        assert!(
            matches!(h.host.invoke(&h.actor, call.clone()).await, Err(error) if error.code == "PERMISSION_DENIED")
        );
        let actor = h
            .auth
            .authenticate_user_control(
                &id("operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let connection =
            rusqlite::Connection::open(h.dir.path().join("host-v0/state.sqlite3")).unwrap();
        connection.execute_batch("CREATE TRIGGER reject_shutdown_terminal BEFORE UPDATE ON operations WHEN NEW.terminal=1 BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;").unwrap();
        let mut call = call;
        call.actor_id = actor.id().clone();
        call.request_context = h.store.issue_context(&actor).unwrap().token;
        let accepted = h.host.invoke(&actor, call).await.unwrap();
        crate::test_support::until(|| {
            h.host
                .inner
                .jobs
                .lock()
                .unwrap()
                .handles
                .iter()
                .all(JoinHandle::is_finished)
        })
        .await;
        assert_eq!(
            h.store.get(&actor, &accepted.operation_id).unwrap().state,
            OperationState::Running
        );
        assert!(!*h.host.inner.stop_requested.borrow());
        h.host.shutdown().await.unwrap();
    }
    async fn owned_admission_shutdown(listener_error: bool, action_shutdown: bool) {
        let dir =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        if listener_error {
            server.accept_error = Some(HostError::new(
                "TEST_ACCEPT_ERROR",
                "Injected listener failure",
            ));
        }
        let store = server.store();
        let auth = server.auth();
        let secret =
            serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
                .unwrap()
                .unwrap();
        let secret = ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap();
        let actor = auth
            .authenticate_user_control(&id("operator"), &secret)
            .unwrap();
        auth.authenticate(&id("recipient"), None).unwrap();
        let identity = store.identity().unwrap();
        let target = Target {
            host_id: identity.host_id.clone(),
            id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let call=Call {protocol_version:ProtocolVersion::V0_1,host_id:identity.host_id,instance_epoch:identity.instance_epoch,actor_id:actor.id().clone(),request_id:RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),request_context:store.issue_context(&actor).unwrap().token,action_id:id("auth.authorize"),target:target.clone(),params:object(serde_json::json!({"clientId":"recipient","permissions":["content.read"],"targets":[target]})).unwrap(),reveal_target:BuiltinAction::Authorize.spec().reveal_target,expected_revision:None,lease_id:None,execution_mode:None};
        let selector = OperationGetParams::ByRequest {
            actor_id: actor.id().clone(),
            request_id: call.request_id.clone(),
            request_context: call.request_context.clone(),
        };
        let mut shutdown_call = call.clone();
        shutdown_call.action_id = id("host.shutdown");
        shutdown_call.params = JsonObject::new();
        shutdown_call.request_id =
            RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
        let host = Host::new(store.clone(), auth).await.unwrap();
        let (entered, wait_entered) = oneshot::channel();
        let (release, held) = oneshot::channel();
        *host.inner.admission_gate.lock().unwrap() = Some((entered, held));
        let invoke_host = host.clone();
        let invoke_actor = actor.clone();
        let waiter = tokio::spawn(async move { invoke_host.invoke(&invoke_actor, call).await });
        wait_entered.await.unwrap();
        waiter.abort();
        let _ = waiter.await;
        let (stop, done) = oneshot::channel();
        let service = host.clone();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(service), async {
                    let _ = done.await;
                })
                .await
        });
        let shutdown_operation = if action_shutdown {
            Some(host.invoke(&actor, shutdown_call).await.unwrap())
        } else {
            None
        };
        if !listener_error && !action_shutdown {
            stop.send(()).unwrap();
        }
        // 关闭标记是确定性的同步证据；不是依赖睡眠推测已开始关闭。
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if host.inner.jobs.lock().unwrap().closing || running.is_finished() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!running.is_finished());
        assert!(matches!(InstanceGuard::acquire(dir.path()),Err(error) if error.code=="HOST_BUSY"));
        release.send(()).unwrap();
        let result = running.await.unwrap();
        if listener_error {
            assert!(
                matches!(result, Err(error) if error.code == "TEST_ACCEPT_ERROR" && error.message == "Injected listener failure")
            );
        } else {
            result.unwrap();
        }
        assert_eq!(
            store.get_selected(&actor, &selector).unwrap().state,
            OperationState::Succeeded
        );
        if let Some(operation) = shutdown_operation {
            let operation = store.get(&actor, &operation.operation_id).unwrap();
            assert_eq!(operation.state, OperationState::Succeeded);
            assert!(matches!(
                operation.result,
                Some(ActionResult::ShutdownRequested(_))
            ));
        }
        assert!(InstanceGuard::acquire(dir.path()).is_ok());
    }
}
