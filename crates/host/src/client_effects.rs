//! Bounded, connection-scoped owner for fixed client platform effects.
use crate::{
    auth::{AuthService, AuthenticatedActor, GrantStamp, hash},
    ipc::ConnectionContext,
    settings::SettingsService,
    storage::Store,
};
use serial_workbench_core::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

pub const MAX_CLIENT_TARGETS: usize = 16;
pub const MAX_PENDING_EFFECTS_PER_TARGET: usize = 16;
pub const MAX_PENDING_EFFECT_BYTES_PER_TARGET: usize = 1024 * 1024;

/// Unpublished capacity: dropping it before binding returns both the item and
/// encoded-byte reservation. No frame can be dispatched before a real binding.
pub struct PreparedClientEffect {
    owner: ClientEffects,
    target_id: Id,
    delivery_id: Id,
    completion: Option<oneshot::Receiver<HostResult<ClientEffectOutcome>>>,
    armed: bool,
}
impl PreparedClientEffect {
    pub fn bind(
        mut self,
        operation: Option<&Operation>,
    ) -> HostResult<(ClientEffectDispatch, ClientEffectWaiter)> {
        let (mut request, authority) = {
            let state = self.owner.inner.lock().map_err(|_| busy())?;
            let pending = state
                .targets
                .get(&self.target_id)
                .and_then(|entry| entry.pending.get(&self.delivery_id))
                .ok_or_else(invalid)?;
            (pending.request.clone(), pending.authority.clone())
        };
        if request.action.capability().is_query() {
            if operation.is_some() {
                return Err(invalid());
            }
        } else {
            let supplied = operation.ok_or_else(invalid)?;
            let actual = self
                .owner
                .store
                .get(&authority.actor, &supplied.operation_id)?;
            if actual.state != OperationState::Queued {
                return Err(HostError::new(
                    "OPERATION_NOT_RUNNING",
                    "Client effect admission is no longer queued",
                ));
            }
            if actual.execution_host_id != request.host_id
                || actual.actor_id != *authority.actor.id()
                || actual.target != authority.target
                || actual.action_id.as_str() != authority.capability.action_id()
                || actual.request_id != request.request_id
                || actual.operation_id != supplied.operation_id
            {
                return Err(denied());
            }
            // Store creates canonical lowercase UUIDs. prepare already included
            // exactly this field's full encoded length, before durable admission.
            if actual.operation_id.as_str().len() != 36
                || uuid::Uuid::parse_str(actual.operation_id.as_str())
                    .ok()
                    .is_none_or(|id| id.to_string() != actual.operation_id.as_str())
            {
                return Err(invalid());
            }
            request.operation_id = Some(actual.operation_id);
        }
        self.owner
            .require_action(&authority.actor, &authority.target, &request.action)?;
        if let Some(stamp) = &authority.stamp {
            self.owner.auth.validate_grants(stamp)?;
        }
        let bytes = encoded_request_bytes(&request)?;
        let mut state = self.owner.inner.lock().map_err(|_| busy())?;
        if state.closing {
            return Err(busy());
        }
        require_live(&state, &authority.target, authority.capability)?;
        let entry = state.targets.get_mut(&self.target_id).ok_or_else(invalid)?;
        let pending = entry
            .pending
            .get_mut(&self.delivery_id)
            .ok_or_else(invalid)?;
        if pending.bound || bytes > pending.bytes {
            return Err(HostError::new(
                "INTERNAL",
                "Prepared client effect byte contract changed",
            ));
        }
        let completion = self.completion.take().ok_or_else(invalid)?;
        entry.pending_bytes -= pending.bytes - bytes;
        pending.bytes = bytes;
        pending.request = request.clone();
        pending.bound = true;
        self.armed = false;
        Ok((
            ClientEffectDispatch {
                request,
                destination: entry.context.clone(),
                authority,
                owner: self.owner.clone(),
            },
            ClientEffectWaiter {
                delivery_id: self.delivery_id.clone(),
                completion,
            },
        ))
    }
}
impl Drop for PreparedClientEffect {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        if let Ok(mut state) = self.owner.inner.lock()
            && let Some(entry) = state.targets.get_mut(&self.target_id)
        {
            let unbound = entry
                .pending
                .get(&self.delivery_id)
                .is_some_and(|pending| !pending.bound && !pending.dispatched);
            if unbound && let Some(pending) = entry.pending.remove(&self.delivery_id) {
                entry.pending_bytes -= pending.bytes;
            }
        }
    }
}

#[derive(Clone)]
pub struct ClientEffectDispatch {
    pub request: ClientEffectRequest,
    pub destination: ConnectionContext,
    pub authority: ClientEffectAuthority,
    owner: ClientEffects,
}
impl ClientEffectDispatch {
    /// Used by the actual transport writer, immediately before any output.
    pub fn authorize(&self) -> HostResult<()> {
        self.owner.authorize_dispatch(self)
    }
    /// Only the transport's encode/enqueue/pre-write rejection paths may call
    /// this; a partial write or lost connection is not evidence of non-delivery.
    pub fn reject_undelivered(&self, error: HostError) -> HostResult<()> {
        self.owner
            .reject_undelivered(&self.request.delivery_id, error)
    }
}
#[derive(Clone)]
pub struct ClientEffectAuthority {
    pub actor: AuthenticatedActor,
    pub target: Target,
    pub capability: ClientCapability,
    pub(crate) stamp: Option<GrantStamp>,
}

/// Failed includes a platform failure or proven non-delivery. An outer error
/// means no final outcome was obtained; a dispatched side effect settles unknown.
pub struct ClientEffectWaiter {
    pub delivery_id: Id,
    completion: oneshot::Receiver<HostResult<ClientEffectOutcome>>,
}
impl ClientEffectWaiter {
    pub async fn wait(self) -> HostResult<ClientEffectOutcome> {
        self.completion.await.map_err(|_| disconnected())?
    }
}
#[derive(Debug, Clone)]
pub struct PendingClientEffect {
    pub delivery_id: Id,
    pub client_target_id: Id,
    pub generation: U64,
    pub operation_id: Option<Id>,
    pub dispatched: bool,
}

#[derive(Clone)]
pub struct ClientEffects {
    store: Store,
    auth: AuthService,
    inner: Arc<Mutex<EffectsState>>,
}
#[derive(Default)]
struct EffectsState {
    closing: bool,
    excluded_update: Option<Id>,
    targets: HashMap<Id, RegisteredClient>,
}
struct RegisteredClient {
    registration: ClientRegistration,
    context: ConnectionContext,
    live: bool,
    pending: HashMap<Id, PendingDelivery>,
    pending_bytes: usize,
    completed: VecDeque<(Id, Digest)>,
    settings_application: Option<ClientSettingsObservation>,
}
struct PendingDelivery {
    request: ClientEffectRequest,
    authority: ClientEffectAuthority,
    bytes: usize,
    dispatched: bool,
    bound: bool,
    committing: Option<Digest>,
    completion: Option<oneshot::Sender<HostResult<ClientEffectOutcome>>>,
}
impl PendingDelivery {
    fn snapshot(&self) -> PendingClientEffect {
        PendingClientEffect {
            delivery_id: self.request.delivery_id.clone(),
            client_target_id: self.request.client_target_id.clone(),
            generation: self.request.generation,
            operation_id: self.request.operation_id.clone(),
            dispatched: self.dispatched,
        }
    }
}
impl ClientEffects {
    pub fn new(store: Store, auth: AuthService) -> Self {
        Self {
            store,
            auth,
            inner: Arc::new(Mutex::new(EffectsState::default())),
        }
    }
    pub fn prepare(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        request_id: RequestId,
        action: ClientEffectAction,
    ) -> HostResult<PreparedClientEffect> {
        self.require_action(actor, target, &action)?;
        let identity = self.store.identity()?;
        let capability = action.capability();
        let authority = ClientEffectAuthority {
            actor: actor.clone(),
            target: target.clone(),
            capability,
            stamp: self.auth.capture_grants(actor)?,
        };
        let mut state = self.inner.lock().map_err(|_| busy())?;
        if state.closing {
            return Err(busy());
        }
        require_live(&state, target, capability)?;
        let entry = state
            .targets
            .get_mut(&target.id)
            .ok_or_else(|| required(capability))?;
        let request = ClientEffectRequest {
            host_id: identity.host_id,
            instance_epoch: identity.instance_epoch,
            client_target_id: target.id.clone(),
            generation: entry.registration.generation,
            delivery_id: new_id(),
            request_id,
            operation_id: None,
            action,
        };
        let mut budget_request = request.clone();
        if !capability.is_query() {
            budget_request.operation_id =
                Some(Id::try_from("00000000-0000-0000-0000-000000000000").expect("UUID budget id"));
        }
        let bytes = encoded_request_bytes(&budget_request).map_err(|_| busy())?;
        if entry.pending.len() >= MAX_PENDING_EFFECTS_PER_TARGET
            || bytes > MAX_PENDING_EFFECT_BYTES_PER_TARGET.saturating_sub(entry.pending_bytes)
        {
            return Err(busy());
        }
        let (send, completion) = oneshot::channel();
        entry.pending_bytes += bytes;
        entry.pending.insert(
            request.delivery_id.clone(),
            PendingDelivery {
                request: request.clone(),
                authority,
                bytes,
                dispatched: false,
                bound: false,
                committing: None,
                completion: Some(send),
            },
        );
        Ok(PreparedClientEffect {
            owner: self.clone(),
            target_id: target.id.clone(),
            delivery_id: request.delivery_id,
            completion: Some(completion),
            armed: true,
        })
    }
    pub fn register(
        &self,
        context: &ConnectionContext,
        mut params: ClientRegisterParams,
    ) -> HostResult<ClientRegistration> {
        let identity = self.require_operator(context)?;
        if params.generation.get() == 0
            || params.capabilities.is_empty()
            || params.capabilities.len() > ClientCapability::ALL.len()
        {
            return Err(invalid());
        }
        params
            .capabilities
            .sort_by_key(|capability| capability.action_id());
        if params
            .capabilities
            .windows(2)
            .any(|pair| pair[0] == pair[1])
        {
            return Err(invalid());
        }
        let mut state = self.inner.lock().map_err(|_| busy())?;
        if state.closing {
            return Err(busy());
        }
        let previous = state
            .targets
            .values()
            .filter(|entry| entry.context.connection_id == context.connection_id)
            .max_by_key(|entry| entry.registration.generation);
        if let Some(previous) = previous {
            if params.generation < previous.registration.generation {
                return Err(epoch());
            }
            if params.generation == previous.registration.generation {
                if !previous.live {
                    return Err(epoch());
                }
                if previous.registration.capabilities != params.capabilities {
                    return Err(conflict());
                }
                return Ok(previous.registration.clone());
            }
        }
        // A new generation retires this connection's old receiver. Already
        // dispatched reservations remain, including when the connection died.
        for entry in state
            .targets
            .values_mut()
            .filter(|entry| entry.context.connection_id == context.connection_id)
        {
            retire(entry, disconnected());
        }
        state.targets.retain(|_, entry| {
            !(entry.pending.is_empty()
                && !entry.live
                && (entry.context.connection_id == context.connection_id
                    || entry.context.is_closed()))
        });
        if state.targets.len() >= MAX_CLIENT_TARGETS {
            return Err(busy());
        }
        let target_id = new_id();
        let registration = ClientRegistration {
            target: Target {
                host_id: identity.host_id,
                kind: ResourceKind::try_from("client")?,
                id: target_id.clone(),
                session_id: None,
                session_epoch: None,
            },
            generation: params.generation,
            capabilities: params.capabilities,
        };
        state.targets.insert(
            target_id,
            RegisteredClient {
                registration: registration.clone(),
                context: context.clone(),
                live: true,
                pending: HashMap::new(),
                pending_bytes: 0,
                completed: VecDeque::new(),
                settings_application: None,
            },
        );
        Ok(registration)
    }
    pub fn unregister(
        &self,
        context: &ConnectionContext,
        params: ClientUnregisterParams,
    ) -> HostResult<ClosedResult> {
        self.require_operator(context)?;
        let mut state = self.inner.lock().map_err(|_| busy())?;
        if let Some(entry) = state.targets.get_mut(&params.client_target_id) {
            require_registration(entry, context, params.generation)?;
            retire(entry, disconnected());
        }
        Ok(ClosedResult { closed: True })
    }
    pub fn list(&self, actor: &AuthenticatedActor) -> HostResult<ClientListResult> {
        let state = self.inner.lock().map_err(|_| busy())?;
        let mut clients = Vec::new();
        for entry in state
            .targets
            .values()
            .filter(|entry| entry.live && !entry.context.is_closed())
        {
            if self
                .auth
                .require(actor, "metadata.read", &entry.registration.target)
                .is_err()
            {
                continue;
            }
            let mut registration = entry.registration.clone();
            let target = registration.target.clone();
            registration.capabilities.retain(|capability| {
                capability
                    .permissions()
                    .iter()
                    .all(|permission| self.auth.require(actor, permission, &target).is_ok())
            });
            clients.push(ClientListItem {
                registration,
                settings_application: entry.settings_application.clone(),
            });
        }
        clients.sort_by(|left, right| {
            left.registration
                .target
                .id
                .as_str()
                .cmp(right.registration.target.id.as_str())
        });
        Ok(ClientListResult { clients })
    }
    pub fn preflight(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        action: &ClientEffectAction,
    ) -> HostResult<()> {
        self.require_action(actor, target, action)?;
        let state = self.inner.lock().map_err(|_| busy())?;
        if state.closing {
            return Err(busy());
        }
        require_live(&state, target, action.capability())?;
        Ok(())
    }
    /// Immediate binding for queries and direct component callers. Business
    /// dispatch uses prepare before Store.accept and binds only its New result.
    pub fn reserve(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        request_id: RequestId,
        operation_id: Option<Id>,
        action: ClientEffectAction,
    ) -> HostResult<(ClientEffectDispatch, ClientEffectWaiter)> {
        if action.capability().is_query() == operation_id.is_some() {
            return Err(invalid());
        }
        let prepared = self.prepare(actor, target, request_id, action)?;
        let operation = operation_id
            .map(|id| self.store.get(actor, &id))
            .transpose()?;
        prepared.bind(operation.as_ref())
    }
    pub fn authorize_dispatch(&self, dispatch: &ClientEffectDispatch) -> HostResult<()> {
        let identity = self.store.identity()?;
        if dispatch.request.host_id != identity.host_id
            || dispatch.request.instance_epoch != identity.instance_epoch
        {
            return Err(epoch());
        }
        self.require_action(
            &dispatch.authority.actor,
            &dispatch.authority.target,
            &dispatch.request.action,
        )?;
        if let Some(stamp) = &dispatch.authority.stamp {
            self.auth.validate_grants(stamp)?;
        }
        let state = self.inner.lock().map_err(|_| busy())?;
        if state.closing && !is_excluded(&state, dispatch.request.operation_id.as_ref()) {
            return Err(busy());
        }
        let entry = require_live(
            &state,
            &dispatch.authority.target,
            dispatch.authority.capability,
        )?;
        if entry.context.connection_id != dispatch.destination.connection_id
            || entry.registration.generation != dispatch.request.generation
        {
            return Err(denied());
        }
        let pending = entry
            .pending
            .get(&dispatch.request.delivery_id)
            .ok_or_else(invalid)?;
        if !pending.bound
            || pending.request != dispatch.request
            || pending.authority.actor.id() != dispatch.authority.actor.id()
            || pending.authority.capability != dispatch.authority.capability
        {
            return Err(denied());
        }
        Ok(())
    }
    pub fn mark_dispatched(&self, delivery_id: &Id) -> HostResult<()> {
        let mut state = self.inner.lock().map_err(|_| busy())?;
        let closing = state.closing;
        let excluded = state.excluded_update.clone();
        for entry in state.targets.values_mut() {
            if let Some(pending) = entry.pending.get_mut(delivery_id) {
                if !pending.bound {
                    return Err(invalid());
                }
                if closing && (excluded.is_none() || pending.request.operation_id != excluded) {
                    return Err(busy());
                }
                if !entry.live || entry.context.is_closed() {
                    return Err(disconnected());
                }
                self.require_action(
                    &pending.authority.actor,
                    &pending.authority.target,
                    &pending.request.action,
                )?;
                if let Some(stamp) = &pending.authority.stamp {
                    self.auth.validate_grants(stamp)?;
                }
                pending.dispatched = true;
                return Ok(());
            }
        }
        Err(invalid())
    }
    /// The transport owner calls this only with proof that no write began. It
    /// may release an already marked record when queue insertion or pre-write
    /// authorization failed. Partial output, disconnect and timeout are not proof.
    pub fn reject_undelivered(&self, delivery_id: &Id, error: HostError) -> HostResult<()> {
        let mut state = self.inner.lock().map_err(|_| busy())?;
        for entry in state.targets.values_mut() {
            if let Some(mut pending) = entry.pending.remove(delivery_id) {
                entry.pending_bytes -= pending.bytes;
                if let Some(send) = pending.completion.take() {
                    let _ = send.send(Ok(ClientEffectOutcome::Failed { error }));
                }
                return Ok(());
            }
        }
        Ok(())
    }
    pub fn receipt(
        &self,
        context: &ConnectionContext,
        submission: ClientReceiptSubmission,
    ) -> HostResult<ClientEffectAcknowledged> {
        let identity = self.require_operator(context)?;
        let mut receipt = match submission {
            ClientReceiptSubmission::SettingsObserved(observation) => {
                let revision = SettingsService::new(self.store.clone()).read()?.revision;
                let mut state = self.inner.lock().map_err(|_| busy())?;
                let entry = state
                    .targets
                    .get_mut(&observation.client_target_id)
                    .ok_or_else(denied)?;
                require_registration(entry, context, observation.generation)?;
                if !entry.live {
                    return Err(denied());
                }
                self.observe(entry, &identity, revision, observation)?;
                return Ok(ClientEffectAcknowledged { accepted: True });
            }
            ClientReceiptSubmission::Effect(receipt) => *receipt,
        };
        if receipt.host_id != identity.host_id || receipt.instance_epoch != identity.instance_epoch
        {
            return Err(epoch());
        }
        // Persist only stable normalized failures, never arbitrary native
        // exception messages, paths, details, or caller-supplied operation IDs.
        if let ClientEffectOutcome::Failed { error } = &mut receipt.outcome {
            if error.code.is_empty()
                || error.code.len() > 128
                || !error
                    .code
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            {
                return Err(invalid());
            }
            *error = HostError::new(error.code.clone(), "Client platform effect failed");
        }
        let encoded = serde_json::to_vec(&receipt).map_err(|_| invalid())?;
        if encoded.len() > MAX_PENDING_EFFECT_BYTES_PER_TARGET {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Client effect result exceeds the byte limit",
            ));
        }
        let digest = hash(&encoded);
        let observation = match &receipt.outcome {
            ClientEffectOutcome::Succeeded {
                result: ClientEffectResult::SettingsApplied(applied),
            } => {
                if applied.host_id != identity.host_id
                    || applied.instance_epoch != identity.instance_epoch
                {
                    return Err(epoch());
                }
                if applied.revision > SettingsService::new(self.store.clone()).read()?.revision {
                    return Err(revision_conflict());
                }
                Some(ClientSettingsObservation {
                    client_target_id: receipt.client_target_id.clone(),
                    generation: receipt.generation,
                    receipt: applied.clone(),
                })
            }
            _ => None,
        };
        let operation_id = {
            let mut state = self.inner.lock().map_err(|_| busy())?;
            let entry = state
                .targets
                .get_mut(&receipt.client_target_id)
                .ok_or_else(denied)?;
            require_registration(entry, context, receipt.generation)?;
            if let Some((_, previous)) = entry
                .completed
                .iter()
                .find(|(id, _)| id == &receipt.delivery_id)
            {
                return if previous == &digest {
                    Ok(ClientEffectAcknowledged { accepted: True })
                } else {
                    Err(conflict())
                };
            }
            let pending = entry
                .pending
                .get_mut(&receipt.delivery_id)
                .ok_or_else(invalid)?;
            if !pending.bound || !pending.dispatched {
                return Err(invalid());
            }
            if let ClientEffectOutcome::Succeeded { result } = &receipt.outcome {
                result.validate_for(pending.request.action.capability())?;
            }
            if let Some(committing) = &pending.committing {
                return if committing == &digest {
                    Err(busy())
                } else {
                    Err(conflict())
                };
            }
            pending.committing = Some(digest.clone());
            pending.request.operation_id.clone()
        };
        // The whole effects mutex is released across SQLite I/O. The committing
        // marker prevents another receipt from completing this slot in parallel.
        let persisted = operation_id.as_ref().map_or(Ok(()), |id| {
            self.store
                .record_client_receipt_evidence(id, &receipt)
                .map(|_| ())
        });
        let mut state = self.inner.lock().map_err(|_| busy())?;
        let Some(entry) = state.targets.get_mut(&receipt.client_target_id) else {
            // True Destroyed may have released the retired target during I/O.
            // Its ID is never reused, so no new receiver is touched here.
            return persisted.map(|()| ClientEffectAcknowledged { accepted: True });
        };
        let Some(pending) = entry.pending.get_mut(&receipt.delivery_id) else {
            return persisted.map(|()| ClientEffectAcknowledged { accepted: True });
        };
        if pending.committing.as_ref() != Some(&digest) {
            return Err(conflict());
        }
        if let Err(error) = persisted {
            pending.committing = None;
            return Err(error);
        }
        if entry.live
            && let Some(observation) = observation
        {
            let newer = entry
                .settings_application
                .as_ref()
                .is_none_or(|previous| previous.receipt.revision < observation.receipt.revision);
            // A valid older business receipt still settles its operation;
            // it must not replace a newer per-window application observation.
            if newer {
                entry.settings_application = Some(observation);
            }
        }
        let mut pending = entry
            .pending
            .remove(&receipt.delivery_id)
            .ok_or_else(invalid)?;
        entry.pending_bytes -= pending.bytes;
        if let Some(send) = pending.completion.take() {
            let _ = send.send(Ok(receipt.outcome));
        }
        if entry.completed.len() == MAX_PENDING_EFFECTS_PER_TARGET {
            entry.completed.pop_front();
        }
        entry.completed.push_back((receipt.delivery_id, digest));
        Ok(ClientEffectAcknowledged { accepted: True })
    }
    pub fn disconnected(&self, connection_id: &Id) -> HostResult<Vec<PendingClientEffect>> {
        let mut state = self.inner.lock().map_err(|_| busy())?;
        let mut pending = Vec::new();
        for entry in state
            .targets
            .values_mut()
            .filter(|entry| &entry.context.connection_id == connection_id)
        {
            pending.extend(entry.pending.values().map(PendingDelivery::snapshot));
            retire(entry, disconnected());
        }
        state.targets.retain(|_, entry| {
            &entry.context.connection_id != connection_id || !entry.pending.is_empty()
        });
        Ok(pending)
    }
    /// A timed-out delivery retires its receiver; it does not free dispatched
    /// reservations or authorize another delivery under that target.
    pub fn timeout(&self, delivery_id: &Id) -> HostResult<()> {
        let mut state = self.inner.lock().map_err(|_| busy())?;
        if let Some(entry) = state
            .targets
            .values_mut()
            .find(|entry| entry.pending.contains_key(delivery_id))
        {
            retire(
                entry,
                HostError::new("TIMEOUT", "Client effect receipt was not received"),
            );
        }
        Ok(())
    }
    /// Trusted internal destruction callback only; ordinary RPC has no route to
    /// it. Cross-connection native proof is integrated separately, never inferred
    /// from unregister, receiver timeout, or close_requested.
    pub fn destroyed(&self, target_id: &Id, generation: U64) -> HostResult<()> {
        let mut state = self.inner.lock().map_err(|_| busy())?;
        if let Some(entry) = state.targets.get(target_id)
            && entry.registration.generation != generation
        {
            return Err(denied());
        }
        if let Some(mut entry) = state.targets.remove(target_id) {
            for (_, mut pending) in entry.pending.drain() {
                if let Some(send) = pending.completion.take() {
                    let _ = send.send(Err(disconnected()));
                }
            }
        }
        Ok(())
    }
    pub fn quiesce(&self) -> HostResult<Vec<PendingClientEffect>> {
        let mut state = self.inner.lock().map_err(|_| busy())?;
        state.closing = true;
        state.excluded_update = None;
        let pending = state
            .targets
            .values()
            .flat_map(|entry| entry.pending.values().map(PendingDelivery::snapshot))
            .collect();
        for entry in state.targets.values_mut() {
            retire(entry, disconnected());
        }
        Ok(pending)
    }
    /// Internal installation barrier. The public shutdown path never accepts an
    /// exclusion. The accepted update must already have a durable Running intent.
    pub(crate) fn quiesce_for_update(
        &self,
        accepted: &crate::dispatch::AcceptedCall,
    ) -> HostResult<Vec<PendingClientEffect>> {
        let identity = self.store.identity()?;
        let operation = self
            .store
            .get(&accepted.actor, &accepted.operation.operation_id)?;
        if operation.execution_host_id != identity.host_id
            || operation.action_id.as_str() != "client.updater.install"
            || operation.state != OperationState::Running
            || operation.actor_id != *accepted.actor.id()
            || operation.target != accepted.call.target
        {
            return Err(denied());
        }
        let mut state = self.inner.lock().map_err(|_| busy())?;
        let exists = state.targets.values().any(|entry| {
            entry.live
                && entry.pending.values().any(|pending| {
                    pending.request.operation_id.as_ref() == Some(&operation.operation_id)
                        && pending.request.action.capability() == ClientCapability::UpdaterInstall
                })
        });
        if !exists {
            return Err(invalid());
        }
        if state.closing && state.excluded_update.as_ref() != Some(&operation.operation_id) {
            return Err(busy());
        }
        state.closing = true;
        state.excluded_update = Some(operation.operation_id.clone());
        let pending = state
            .targets
            .values()
            .flat_map(|entry| entry.pending.values())
            .filter(|pending| {
                pending.request.operation_id.as_ref() != Some(&operation.operation_id)
            })
            .map(PendingDelivery::snapshot)
            .collect();
        for entry in state.targets.values_mut() {
            retire_except(entry, disconnected(), Some(&operation.operation_id));
        }
        Ok(pending)
    }
    fn require_operator(
        &self,
        context: &ConnectionContext,
    ) -> HostResult<crate::auth::HostIdentity> {
        if context.channel != IpcChannel::Control
            || !context.actor.is_user_control()
            || context.is_closed()
        {
            return Err(denied());
        }
        let identity = self.store.identity()?;
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host")?,
            id: identity.host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        self.auth.require(&context.actor, "auth.manage", &target)?;
        Ok(identity)
    }
    fn require_action(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        action: &ClientEffectAction,
    ) -> HostResult<()> {
        action.validate()?;
        target.validate()?;
        if target.kind.as_str() != "client"
            || target.session_id.is_some()
            || target.session_epoch.is_some()
        {
            return Err(invalid());
        }
        for permission in action.capability().permissions() {
            self.auth.require(actor, permission, target)?;
        }
        Ok(())
    }
    fn observe(
        &self,
        entry: &mut RegisteredClient,
        identity: &crate::auth::HostIdentity,
        current_revision: U64,
        observation: ClientSettingsObservation,
    ) -> HostResult<()> {
        if observation.receipt.host_id != identity.host_id
            || observation.receipt.instance_epoch != identity.instance_epoch
        {
            return Err(epoch());
        }
        if observation.receipt.revision > current_revision {
            return Err(revision_conflict());
        }
        if let Some(previous) = &entry.settings_application {
            if observation.receipt.revision < previous.receipt.revision {
                return Err(revision_conflict());
            }
            if observation.receipt.revision == previous.receipt.revision {
                return if observation == *previous {
                    Ok(())
                } else {
                    Err(conflict())
                };
            }
        }
        entry.settings_application = Some(observation);
        Ok(())
    }
}

fn require_registration(
    entry: &RegisteredClient,
    context: &ConnectionContext,
    generation: U64,
) -> HostResult<()> {
    if entry.context.connection_id != context.connection_id
        || entry.registration.generation != generation
    {
        Err(denied())
    } else {
        Ok(())
    }
}
fn require_live<'a>(
    state: &'a EffectsState,
    target: &Target,
    capability: ClientCapability,
) -> HostResult<&'a RegisteredClient> {
    state
        .targets
        .get(&target.id)
        .filter(|entry| {
            entry.live
                && !entry.context.is_closed()
                && entry.registration.target == *target
                && entry.registration.capabilities.contains(&capability)
        })
        .ok_or_else(|| required(capability))
}
fn retire(entry: &mut RegisteredClient, error: HostError) {
    retire_except(entry, error, None);
}
fn retire_except(entry: &mut RegisteredClient, error: HostError, keep: Option<&Id>) {
    let keep_target = keep.is_some_and(|operation_id| {
        entry
            .pending
            .values()
            .any(|pending| pending.request.operation_id.as_ref() == Some(operation_id))
    });
    entry.live &= keep_target;
    if !entry.live {
        entry.settings_application = None;
    }
    let mut released_bytes = 0;
    entry.pending.retain(|_, pending| {
        if keep.is_some() && pending.request.operation_id.as_ref() == keep {
            return true;
        }
        if let Some(send) = pending.completion.take() {
            let _ = send.send(Err(error.clone()));
        }
        if !pending.dispatched {
            released_bytes += pending.bytes;
        }
        pending.dispatched
    });
    entry.pending_bytes -= released_bytes;
}
fn is_excluded(state: &EffectsState, operation_id: Option<&Id>) -> bool {
    operation_id.is_some() && operation_id == state.excluded_update.as_ref()
}
fn encoded_request_bytes(request: &ClientEffectRequest) -> HostResult<usize> {
    let frame = WireFrame {
        request_id: request.request_id.clone(),
        channel: IpcChannel::Control,
        body: IpcMessage::ClientEffect {
            request: Box::new(request.clone()),
        },
    };
    serial_workbench_ipc::frame::encoded_length(&frame, MAX_PENDING_EFFECT_BYTES_PER_TARGET)
}
fn required(capability: ClientCapability) -> HostError {
    let mut error = HostError::new(
        "CLIENT_REQUIRED",
        "A live client with the required capability is needed",
    );
    error.details = Some(Box::new(
        serde_json::from_value(serde_json::json!({
            "requiredCapabilities": [capability.action_id()],
        }))
        .expect("fixed client capability details"),
    ));
    error
}
fn new_id() -> Id {
    Id::try_from(uuid::Uuid::new_v4().to_string().as_str()).expect("UUID id")
}
fn busy() -> HostError {
    HostError::new("HOST_BUSY", "Client effect capacity is unavailable")
}
fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Invalid client effect request or receipt",
    )
}
fn denied() -> HostError {
    HostError::new(
        "PERMISSION_DENIED",
        "Client effect receiver identity does not match",
    )
}
fn disconnected() -> HostError {
    HostError::new(
        "BACKEND_DISCONNECTED",
        "Client effect receiver ended without a receipt",
    )
}
fn conflict() -> HostError {
    HostError::new(
        "REQUEST_CONFLICT",
        "Client effect identity is already bound to another value",
    )
}
fn epoch() -> HostError {
    HostError::new(
        "EPOCH_MISMATCH",
        "Client effect generation or Host epoch changed",
    )
}
fn revision_conflict() -> HostError {
    HostError::new(
        "REVISION_CONFLICT",
        "Client settings observation revision does not match",
    )
}
