//! Host-owned settlement, kept under dispatch so private ownership stays private.
use super::{AcceptedCall, Host};
use serial_workbench_core::*;
use std::sync::{Arc, Mutex};
use tokio::{task::JoinHandle, time::Instant};

const BUDGET: std::time::Duration = std::time::Duration::from_secs(5);
const REPORT_RESERVE: std::time::Duration = std::time::Duration::from_millis(250);
// At most 256 owned admissions and 256 additional current nonterminal operations.
const OPERATION_LIMIT: usize = 512;
type OperationSlot = Arc<Mutex<Option<Id>>>;

#[cfg(test)]
#[path = "capture/final_fix_tests.rs"]
mod final_fix_tests;

#[derive(Default)]
pub(super) struct ShutdownCoordinator {
    state: tokio::sync::Mutex<ShutdownState>,
}

#[derive(Default)]
struct ShutdownState {
    slots: Vec<OperationSlot>,
    operation_ids: Vec<Id>,
    operations: Vec<Operation>,
    operation_read: Option<JoinHandle<HostResult<Vec<Operation>>>>,
    capture: Cleanup,
    devices: Cleanup,
    projection: Cleanup,
    checkpoint: Cleanup,
    client_effects: Option<JoinHandle<HostResult<Vec<crate::client_effects::PendingClientEffect>>>>,
}

#[derive(Default)]
struct Cleanup {
    task: Option<JoinHandle<HostResult<()>>>,
    complete: bool,
    failure: Option<HostError>,
}

impl Cleanup {
    async fn wait(&mut self, deadline: Instant) -> bool {
        let Some(task) = self.task.as_mut() else {
            return self.complete;
        };
        let result = match tokio::time::timeout_at(deadline, task).await {
            Ok(result) => result,
            // Keep the running task. Cancellation of a waiter does not cancel work.
            Err(_) => return false,
        };
        self.task.take();
        self.complete = true;
        self.failure = match result {
            Ok(result) => result.err(),
            Err(_) => Some(HostError::new(
                "HOST_BUSY",
                "Host cleanup owner did not complete normally",
            )),
        };
        true
    }
}

impl Host {
    pub async fn quiesce(&self, mode: ShutdownMode) -> HostResult<ShutdownReport> {
        self.quiesce_owned(mode, None, Instant::now() + BUDGET, None)
            .await
    }

    /// The only internal exclusion is the authenticated, persisted install owner.
    pub(crate) async fn quiesce_for_update(
        &self,
        accepted: &AcceptedCall,
    ) -> HostResult<ShutdownReport> {
        let deadline = Instant::now() + BUDGET;
        let store = self.inner.store.clone();
        let actor = accepted.actor.clone();
        let expected = accepted.operation.operation_id.clone();
        let expected_actor = actor.id().clone();
        let operation_id = expected.clone();
        let request_host = accepted.call.host_id.clone();
        let request_epoch = accepted.call.instance_epoch;
        let valid = tokio::time::timeout_at(
            deadline,
            super::blocking(move || {
                let identity = store.identity()?;
                let persisted = store.get(&actor, &operation_id)?;
                Ok(persisted.operation_id == operation_id
                    && persisted.actor_id == expected_actor
                    && persisted.execution_host_id == identity.host_id
                    && request_host == identity.host_id
                    && request_epoch == identity.instance_epoch
                    && persisted.action_id.as_str() == "client.updater.install"
                    && persisted.state == OperationState::Running)
            }),
        )
        .await
        .map_err(|_| incomplete("Install owner validation exceeded the shutdown budget"))??;
        if !valid || accepted.call.action_id.as_str() != "client.updater.install" {
            return Err(HostError::new(
                "INVALID_OPERATION_OWNER",
                "Only the current running Host install owner may exclude itself",
            ));
        }
        self.quiesce_owned(
            ShutdownMode::CancelAndSettle,
            Some(expected),
            deadline,
            Some(accepted),
        )
        .await
    }

    /// Called by the no-argument process teardown entry. A report is not an exit.
    pub(super) async fn finish_shutdown(&self) -> HostResult<()> {
        let report = match self.quiesce(ShutdownMode::CancelAndSettle).await {
            Ok(report) => report,
            Err(cause) => {
                let mut error = incomplete("Host could not establish its settlement barrier");
                error.details = serde_json::from_value(serde_json::json!({"cause":cause}))
                    .ok()
                    .map(Box::new);
                return Err(error);
            }
        };
        if !report.completed {
            let mut error = incomplete("Host has unsettled work or unconfirmed cleanup");
            error.details = serde_json::to_value(&report)
                .ok()
                .and_then(|value| serde_json::from_value(value).ok())
                .map(Box::new);
            return Err(error);
        }
        self.stop_operation_projection().await?;
        self.inner
            .subscriptions
            .lock()
            .map_err(|_| super::busy())?
            .clear();
        self.inner.catalog_watchers.lock().await.clear();
        Ok(())
    }

    async fn quiesce_owned(
        &self,
        mode: ShutdownMode,
        excluded: Option<Id>,
        deadline: Instant,
        update: Option<&AcceptedCall>,
    ) -> HostResult<ShutdownReport> {
        let work_deadline = deadline - REPORT_RESERVE;
        let mut state = tokio::time::timeout_at(deadline, self.inner.shutdown.state.lock())
            .await
            .map_err(|_| incomplete("Another Host settlement barrier is still running"))?;
        self.observe_owned_jobs(&mut state)?;
        let client_pending = self
            .quiesce_client_effects(&mut state, update, deadline)
            .await?;
        self.read_shutdown_operations(&mut state, deadline).await?;
        self.inner
            .sessions
            .request_quiesce(mode == ShutdownMode::CancelAndSettle)?;

        let mut failures = Vec::new();
        let tx_complete = loop {
            let (pending, admissions) = self.inner.sessions.quiesce_pending()?;
            if pending.is_empty() && admissions == 0 {
                break true;
            }
            if Instant::now() >= work_deadline {
                break false;
            }
            tokio::time::sleep_until(
                work_deadline.min(Instant::now() + std::time::Duration::from_millis(5)),
            )
            .await;
        };
        if tx_complete {
            if !state.capture.complete && state.capture.task.is_none() {
                let host = self.clone();
                state.capture.task = Some(tokio::spawn(async move {
                    host.inner.capture_api.shutdown().await
                }));
            }
            if state.capture.wait(work_deadline).await {
                if !state.devices.complete && state.devices.task.is_none() {
                    let devices = self.inner.devices.clone();
                    state.devices.task =
                        Some(tokio::spawn(async move { devices.shutdown().await }));
                }
                state.devices.wait(work_deadline).await;
            }
        }
        let mut jobs_complete = false;
        if tx_complete && state.capture.complete && state.devices.complete {
            loop {
                self.observe_owned_jobs(&mut state)?;
                let (finished, pending) = {
                    let mut jobs = self.inner.jobs.lock().map_err(|_| super::busy())?;
                    let mut finished = Vec::new();
                    let mut pending = false;
                    let mut index = 0;
                    while index < jobs.handles.len() {
                        let job = &jobs.handles[index];
                        let id = job.operation_id.lock().map_err(|_| super::busy())?.clone();
                        if excluded
                            .as_ref()
                            .is_some_and(|excluded| id.as_ref() == Some(excluded))
                        {
                            index += 1;
                        } else if job.handle.is_finished() {
                            finished.push(jobs.handles.swap_remove(index).handle);
                        } else {
                            pending = true;
                            index += 1;
                        }
                    }
                    (finished, pending)
                };
                for handle in finished {
                    if handle.await.is_err() {
                        failures.push(HostError::new("HOST_BUSY", "Host operation owner failed"));
                    }
                }
                if !pending {
                    jobs_complete = true;
                    break;
                }
                if Instant::now() >= work_deadline {
                    break;
                }
                tokio::time::sleep_until(
                    work_deadline.min(Instant::now() + std::time::Duration::from_millis(5)),
                )
                .await;
            }
        }
        let projection_complete = if jobs_complete {
            // Retain a timed-out final publication. A retry first observes it,
            // then publishes the current settled state before stopping the watcher.
            if state.projection.task.is_none() || state.projection.wait(work_deadline).await {
                let host = self.clone();
                state.projection = Cleanup {
                    task: Some(tokio::spawn(async move { host.publish_operations().await })),
                    ..Cleanup::default()
                };
            }
            state.projection.wait(work_deadline).await
        } else {
            false
        };
        self.observe_owned_jobs(&mut state)?;
        if let Err(error) = self.read_shutdown_operations(&mut state, deadline).await {
            failures.push(error);
        }
        // Binding reserves durable owners only for side effects. A retired
        // read-only waiter has no Native side-effect responsibility to retain.
        // A retry obtains a fresh snapshot after actual receipts arrive.
        for pending in client_pending
            .into_iter()
            .filter(|pending| pending.dispatched && pending.operation_id.is_some())
        {
            let mut error = HostError::new(
                "CLIENT_EFFECT_INCOMPLETE",
                "A dispatched client effect was unconfirmed when Host quiescence began",
            );
            error.operation_id = pending.operation_id;
            error.details = serde_json::from_value(serde_json::json!({
                "deliveryId":pending.delivery_id,
                "clientTargetId":pending.client_target_id,
                "generation":pending.generation,
            }))
            .ok()
            .map(Box::new);
            failures.push(error);
        }
        let unsettled_operation_ids = state
            .operations
            .iter()
            .filter(|operation| {
                Some(&operation.operation_id) != excluded.as_ref() && !operation.state.is_terminal()
            })
            .map(|operation| operation.operation_id.clone())
            .collect::<Vec<_>>();
        let mut quarantined_sessions = Vec::new();
        for session in self.inner.devices.sessions()? {
            let snapshot = session.snapshot()?;
            // Historical TX uncertainty stays in the session and receipt. It
            // only blocks process exit while the native resource is unconfirmed.
            // Unsettled physical control lines remain a separate responsibility.
            if snapshot.control_state != ControlState::Clear
                || (snapshot.tx_gate == TxGate::ControlUnknown && !session.cleanup_confirmed()?)
            {
                quarantined_sessions.push(Target {
                    host_id: self.inner.devices.inner.identity.host_id.clone(),
                    kind: ResourceKind::try_from("session")?,
                    id: snapshot.session_id.clone(),
                    session_id: Some(snapshot.session_id),
                    session_epoch: Some(snapshot.session_epoch),
                });
            }
        }
        for cleanup in [&state.capture, &state.devices, &state.projection] {
            if let Some(error) = &cleanup.failure {
                failures.push(error.clone());
            }
        }
        if !tx_complete
            || !state.capture.complete
            || !state.devices.complete
            || !jobs_complete
            || !projection_complete
        {
            failures.push(incomplete(
                "Host settlement budget expired before all owners completed",
            ));
        }
        // An earlier timed-out checkpoint remains owned. Observe it before
        // scheduling this call's fresh checkpoint after the current evidence read.
        if state.checkpoint.task.is_some() && !state.checkpoint.wait(deadline).await {
            failures.push(incomplete("Host checkpoint exceeded the settlement budget"));
        } else {
            let store = self.inner.store.clone();
            state.checkpoint = Cleanup {
                task: Some(tokio::spawn(super::blocking(move || store.checkpoint()))),
                ..Cleanup::default()
            };
            if !state.checkpoint.wait(deadline).await {
                failures.push(incomplete("Host checkpoint exceeded the settlement budget"));
            } else if let Some(error) = &state.checkpoint.failure {
                failures.push(error.clone());
            }
        }
        let mut evidence_refs = Vec::new();
        for operation in &state.operations {
            // Inline receipts remain queryable through their real persisted
            // operation identity even when they have no separate file object.
            if operation.result.is_some() {
                evidence_refs.push(ObjectRef {
                    host_id: operation.execution_host_id.clone(),
                    kind: ResourceKind::try_from("operation")?,
                    id: operation.operation_id.clone(),
                    revision: Some(operation.revision),
                });
            }
            let reference = match &operation.result {
                Some(ActionResult::CaptureStatus(result)) => Some(&result.capture_ref),
                Some(ActionResult::Reference(result)) => Some(&result.result_ref),
                Some(ActionResult::FileMetadata(result)) => Some(&result.file_ref),
                Some(ActionResult::FileTransfer(result)) => Some(&result.receipts_ref),
                _ => None,
            };
            if let Some(reference) = reference
                && !evidence_refs.contains(reference)
            {
                evidence_refs.push(reference.clone());
            }
        }
        Ok(ShutdownReport {
            mode,
            completed: tx_complete
                && state.capture.complete
                && state.devices.complete
                && jobs_complete
                && projection_complete
                && unsettled_operation_ids.is_empty()
                && quarantined_sessions.is_empty()
                && failures.is_empty(),
            excluded_operation_id: excluded,
            unsettled_operation_ids,
            quarantined_sessions,
            evidence_refs,
            failures,
        })
    }

    fn observe_owned_jobs(&self, state: &mut ShutdownState) -> HostResult<()> {
        let mut jobs = self.inner.jobs.lock().map_err(|_| super::busy())?;
        jobs.closing = true;
        for job in &jobs.handles {
            if !state
                .slots
                .iter()
                .any(|slot| Arc::ptr_eq(slot, &job.operation_id))
            {
                if state.slots.len() == OPERATION_LIMIT {
                    return Err(limit());
                }
                state.slots.push(job.operation_id.clone());
            }
        }
        for slot in &state.slots {
            if let Some(id) = slot.lock().map_err(|_| super::busy())?.as_ref()
                && !state.operation_ids.contains(id)
            {
                if state.operation_ids.len() == OPERATION_LIMIT {
                    return Err(limit());
                }
                state.operation_ids.push(id.clone());
            }
        }
        Ok(())
    }

    async fn read_shutdown_operations(
        &self,
        state: &mut ShutdownState,
        deadline: Instant,
    ) -> HostResult<()> {
        // Finish a read retained by an earlier waiter before requesting a fresh
        // snapshot. Both reads remain bounded by this call's single deadline.
        if let Some(task) = state.operation_read.as_mut() {
            let result = tokio::time::timeout_at(deadline, task).await.map_err(|_| {
                incomplete("Reading retained operation evidence exceeded the shutdown budget")
            })?;
            state.operation_read.take();
            remember_operations(state, result.map_err(|_| super::busy())??)?;
        }
        let store = self.inner.store.clone();
        let ids = state.operation_ids.clone();
        state.operation_read = Some(tokio::spawn(super::blocking(move || {
            store.shutdown_operations(&ids, OPERATION_LIMIT)
        })));
        let Some(task) = state.operation_read.as_mut() else {
            return Err(super::busy());
        };
        let result = tokio::time::timeout_at(deadline, task).await.map_err(|_| {
            incomplete("Reading retained operation evidence exceeded the shutdown budget")
        })?;
        state.operation_read.take();
        let operations = result.map_err(|_| super::busy())??;
        remember_operations(state, operations)
    }

    async fn quiesce_client_effects(
        &self,
        state: &mut ShutdownState,
        update: Option<&AcceptedCall>,
        deadline: Instant,
    ) -> HostResult<Vec<crate::client_effects::PendingClientEffect>> {
        if let Some(task) = state.client_effects.as_mut() {
            let result = tokio::time::timeout_at(deadline, task)
                .await
                .map_err(|_| incomplete("Client effect settlement exceeded the shutdown budget"))?;
            state.client_effects.take();
            result.map_err(|_| super::busy())??;
        }
        let clients = self.inner.client_effects.clone();
        let update = update.map(|accepted| AcceptedCall {
            actor: accepted.actor.clone(),
            call: accepted.call.clone(),
            operation: accepted.operation.clone(),
        });
        state.client_effects = Some(tokio::spawn(super::blocking(move || match update {
            Some(accepted) => clients.quiesce_for_update(&accepted),
            None => clients.quiesce(),
        })));
        let Some(task) = state.client_effects.as_mut() else {
            return Err(super::busy());
        };
        let result = tokio::time::timeout_at(deadline, task)
            .await
            .map_err(|_| incomplete("Client effect settlement exceeded the shutdown budget"))?;
        state.client_effects.take();
        result.map_err(|_| super::busy())?
    }
}

fn remember_operations(state: &mut ShutdownState, operations: Vec<Operation>) -> HostResult<()> {
    for operation in &operations {
        if !state.operation_ids.contains(&operation.operation_id) {
            if state.operation_ids.len() == OPERATION_LIMIT {
                return Err(limit());
            }
            state.operation_ids.push(operation.operation_id.clone());
        }
    }
    state.operations = operations;
    Ok(())
}

fn incomplete(message: &str) -> HostError {
    let mut error = HostError::new("SHUTDOWN_INCOMPLETE", message);
    error.retryable = true;
    error
}

fn limit() -> HostError {
    HostError::new(
        "SHUTDOWN_LIMIT_EXCEEDED",
        "Host shutdown evidence exceeds its bounded operation budget",
    )
}
