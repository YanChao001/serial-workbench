use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serial_workbench_core::*;

use super::{
    db::{Database, counter, save_retention},
    unavailable,
};
use crate::auth::{AuthenticatedActor, add_wall_seconds, hash};

const RETENTION_NS: u64 = 604_800_000_000_000;
pub(super) const MAX_IN_FLIGHT: i64 = 256;

pub(super) fn apply_progress(operation: &mut Operation, progress: Progress) -> HostResult<bool> {
    if progress
        .total
        .is_some_and(|total| progress.completed > total)
        || operation.progress.as_ref().is_some_and(|previous| {
            progress.completed < previous.completed
                || progress.unit != previous.unit
                || progress.total != previous.total
        })
    {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "Operation progress must retain its unit and total and cannot move backwards",
        ));
    }
    if operation.progress.as_ref() == Some(&progress) {
        return Ok(false);
    }
    operation.progress = Some(progress);
    Ok(true)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationSource {
    format_version: String,
    source: Target,
}
fn operation_source_key(id: &Id) -> String {
    format!("operation-source-{id}")
}
pub(super) fn save_operation_source(
    connection: &Connection,
    operation: &Id,
    source: &Target,
) -> HostResult<()> {
    source.validate()?;
    let value = serde_json::to_string(&OperationSource {
        format_version: "0.1".into(),
        source: source.clone(),
    })
    .map_err(|_| unavailable())?;
    connection
        .execute(
            "INSERT INTO documents(id,revision,value_json) VALUES(?1,'1',?2)",
            params![operation_source_key(operation), value],
        )
        .map_err(|_| unavailable())?;
    Ok(())
}
fn decode_operation_source(json: &str) -> HostResult<Target> {
    let document: OperationSource = serde_json::from_str(json).map_err(|_| unavailable())?;
    if document.format_version != "0.1" {
        return Err(HostError::new(
            "UNSUPPORTED_FORMAT",
            "Operation source format is unsupported",
        ));
    }
    document.source.validate()?;
    Ok(document.source)
}

fn find_existing(
    connection: &rusqlite::Connection,
    actor: &AuthenticatedActor,
    context: &Digest,
    request: &RequestId,
    digest: &Digest,
) -> HostResult<Option<Operation>> {
    let previous:Option<(String,String)>=connection.query_row("SELECT digest,operation_json FROM operations WHERE actor_id=?1 AND context_digest=?2 AND request_id=?3",params![actor.id().as_str(),context.as_str(),request.as_str()],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_|unavailable())?;
    previous
        .map(|(stored, json)| {
            if stored != digest.as_str() {
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Request identity is already bound to another intent",
                ));
            }
            decode(&json)
        })
        .transpose()
}

#[derive(Debug)]
pub enum Acceptance {
    New(Operation),
    Existing(Operation),
}

pub struct Settlement {
    pub state: OperationState,
    pub result: Option<ActionResult>,
    pub error: Option<HostError>,
}

/// 调用前由动作 schema 补齐领域默认值；本层归一化信封默认值并排除展示字段。
pub fn canonical_digest(call: &Call) -> HostResult<Digest> {
    Ok(hash(&canonical_input(call)?))
}

fn canonical_input(call: &Call) -> HostResult<Vec<u8>> {
    let value = serde_json::json!({
        "actionId":call.action_id,
        "target":call.target,
        "executionMode":call.execution_mode.unwrap_or_default(),
        "expectedRevision":call.expected_revision,
        "leaseId":call.lease_id,
        "params":call.params,
    });
    let mut bytes = Vec::new();
    write_canonical(&value, &mut bytes)?;
    Ok(bytes)
}

pub(super) fn write_canonical(value: &serde_json::Value, output: &mut Vec<u8>) -> HostResult<()> {
    match value {
        serde_json::Value::Object(object) => {
            output.push(b'{');
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_unstable_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                serde_json::to_writer(&mut *output, key).map_err(|_| unavailable())?;
                output.push(b':');
                write_canonical(value, output)?;
            }
            output.push(b'}');
        }
        serde_json::Value::Array(array) => {
            output.push(b'[');
            for (index, value) in array.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical(value, output)?;
            }
            output.push(b']');
        }
        _ => serde_json::to_writer(output, value).map_err(|_| unavailable())?,
    }
    Ok(())
}

impl Database {
    pub(crate) fn shutdown_operations(
        &self,
        tracked: &[Id],
        limit: usize,
    ) -> HostResult<Vec<Operation>> {
        let limit_error = || {
            HostError::new(
                "SHUTDOWN_LIMIT_EXCEEDED",
                "Host shutdown evidence exceeds its bounded operation budget",
            )
        };
        if limit == 0 || limit > 512 || tracked.len() > limit {
            return Err(limit_error());
        }
        let tracked = serde_json::to_string(tracked).map_err(|_| unavailable())?;
        let mut statement = self.connection.prepare("SELECT operation_json FROM operations WHERE operation_id IN (SELECT operation_id FROM operations WHERE terminal=0 UNION SELECT value FROM json_each(?1)) ORDER BY operation_id LIMIT ?2").map_err(|_| unavailable())?;
        let operations = statement
            .query_map(params![tracked, (limit + 1) as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| unavailable())?
            .map(|row| decode(&row.map_err(|_| unavailable())?))
            .collect::<HostResult<Vec<_>>>()?;
        if operations.len() > limit {
            return Err(limit_error());
        }
        Ok(operations)
    }
    fn validate_call(
        &self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
    ) -> HostResult<(crate::auth::HostIdentity, Vec<u8>)> {
        let identity = self.identity()?;
        if actor.id() != &call.actor_id {
            return Err(HostError::new(
                "ACTOR_MISMATCH",
                "Authenticated actor does not match request",
            ));
        }
        if call.host_id != identity.host_id || call.target.host_id != identity.host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Request belongs to another Host",
            ));
        }
        if call.instance_epoch != identity.instance_epoch {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Request belongs to another Host instance",
            ));
        }
        call.target.validate()?;
        let input = canonical_input(call)?;
        if &hash(&input) != digest {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Request digest does not match normalized input",
            ));
        }
        Ok((identity, input))
    }
    pub(crate) fn lookup_call(
        &mut self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
    ) -> HostResult<Option<Operation>> {
        let (identity, _) = self.validate_call(actor, call, digest)?;
        if let Some(task) = actor.task() {
            return self
                .child_request(
                    actor,
                    &task.normalized(call)?,
                    &task.owner_instance,
                    None,
                    None,
                    false,
                )
                .map(|result| {
                    result.map(|result| match result {
                        Acceptance::New(operation) | Acceptance::Existing(operation) => operation,
                    })
                });
        }
        let context =
            self.signer
                .validate(&call.request_context, actor, &identity, self.clock.as_ref())?;
        find_existing(
            &self.connection,
            actor,
            &context.digest,
            &call.request_id,
            digest,
        )?
        .map(|operation| self.get(actor, &operation.operation_id))
        .transpose()
    }
    pub fn accept(
        &mut self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
    ) -> HostResult<Acceptance> {
        self.accept_with_source(actor, call, digest, None)
    }
    pub(crate) fn accept_with_source(
        &mut self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
        source: Option<&Target>,
    ) -> HostResult<Acceptance> {
        self.accept_with_metadata(actor, call, digest, source, None)
    }
    pub(super) fn accept_plugin(
        &mut self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
        plugin: &super::plugin_operations::PluginOperation,
    ) -> HostResult<Acceptance> {
        plugin.validate_call(call)?;
        self.accept_with_metadata(actor, call, digest, None, Some(plugin))
    }
    fn accept_with_metadata(
        &mut self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
        source: Option<&Target>,
        plugin: Option<&super::plugin_operations::PluginOperation>,
    ) -> HostResult<Acceptance> {
        let (identity, input) = self.validate_call(actor, call, digest)?;
        if let Some(task) = actor.task() {
            return self
                .child_request(
                    actor,
                    &task.normalized(call)?,
                    &task.owner_instance,
                    source,
                    plugin,
                    true,
                )?
                .ok_or_else(unavailable);
        }
        let source = source
            .map(|source| {
                source.validate()?;
                if source.host_id != identity.host_id {
                    return Err(HostError::new(
                        "HOST_ID_MISMATCH",
                        "Source belongs to another Host",
                    ));
                }
                serde_json::to_string(&OperationSource {
                    format_version: "0.1".into(),
                    source: source.clone(),
                })
                .map_err(|_| unavailable())
            })
            .transpose()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let context =
            self.signer
                .validate(&call.request_context, actor, &identity, self.clock.as_ref())?;
        if let Some(previous) = find_existing(
            &transaction,
            actor,
            &context.digest,
            &call.request_id,
            digest,
        )? {
            drop(transaction);
            return self
                .get(actor, &previous.operation_id)
                .map(Acceptance::Existing);
        }
        let in_flight: i64 = transaction
            .query_row(
                "SELECT count(*) FROM operations WHERE terminal=0",
                [],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        if in_flight >= MAX_IN_FLIGHT {
            return Err(HostError::new(
                "HOST_BUSY",
                "Host operation capacity is full",
            ));
        }
        let id = Id::try_from(uuid::Uuid::new_v4().to_string().as_str())?;
        let operation = Operation {
            operation_id: id.clone(),
            execution_host_id: identity.host_id.clone(),
            actor_id: actor.id().clone(),
            request_id: call.request_id.clone(),
            admission: Admission::Request {
                request_context_digest: context.digest.clone(),
            },
            root_operation_id: id,
            child_high_watermark: U64::from(0),
            action_id: call.action_id.clone(),
            target: call.target.clone(),
            execution_mode: call.execution_mode.unwrap_or_default(),
            state: OperationState::Queued,
            revision: U64::from(1),
            reveal_target: call.reveal_target.clone(),
            accepted_at: self.clock.wall_time(),
            owner: if let Some(plugin) = plugin {
                plugin.owner()?
            } else {
                Owner {
                    kind: OwnerKind::Host,
                    id: identity.host_id,
                    version: None,
                }
            },
            dependencies: plugin.map(|plugin| plugin.dependencies()).transpose()?,
            started_at: None,
            settled_at: None,
            result_expires_at: None,
            progress: None,
            worker_observation: None,
            result: None,
            client_effect_receipt: None,
            error: None,
        };
        transaction.execute(
            "INSERT INTO operations(operation_id,actor_id,context_digest,request_id,digest,input_json,operation_json,dispatched,terminal) VALUES(?1,?2,?3,?4,?5,?6,?7,0,0)",
            params![operation.operation_id.as_str(), actor.id().as_str(), context.digest.as_str(), call.request_id.as_str(), digest.as_str(),
                std::str::from_utf8(&input).map_err(|_| unavailable())?, encode(&operation)?],
        ).map_err(|_| unavailable())?;
        if let Some(source) = source {
            transaction
                .execute(
                    "INSERT INTO documents(id,revision,value_json) VALUES(?1,'1',?2)",
                    params![operation_source_key(&operation.operation_id), source],
                )
                .map_err(|_| unavailable())?;
        }
        if let Some(plugin) = plugin {
            transaction
                .execute(
                    "INSERT INTO documents(id,revision,value_json) VALUES(?1,'1',?2)",
                    params![
                        super::plugin_operations::key(&operation.operation_id),
                        serde_json::to_string(plugin).map_err(|_| unavailable())?
                    ],
                )
                .map_err(|_| unavailable())?;
        }
        transaction.commit().map_err(|_| unavailable())?;
        Ok(Acceptance::New(operation))
    }

    pub fn mark_dispatch(&mut self, id: &Id) -> HostResult<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let mut operation = load(&transaction, id)?;
        if operation.state != OperationState::Queued {
            return Err(not_running());
        }
        if let Admission::Child {
            parent_operation_id,
            ..
        } = &operation.admission
        {
            let parent = load(&transaction, parent_operation_id)?;
            if parent.state != OperationState::Running
                || !self.live_dispatches.contains(parent_operation_id)
            {
                return Err(not_running());
            }
        }
        operation.state = OperationState::Running;
        operation.revision = operation.revision.checked_next()?;
        operation.started_at = Some(self.clock.wall_time());
        transaction
            .execute(
                "UPDATE operations SET operation_json=?1,dispatched=1 WHERE operation_id=?2",
                params![encode(&operation)?, id.as_str()],
            )
            .map_err(|_| unavailable())?;
        transaction.commit().map_err(|_| unavailable())?;
        self.live_dispatches.insert(id.clone());
        self.task_admissions.insert(id.clone());
        Ok(())
    }

    pub(crate) fn record_progress(&mut self, id: &Id, progress: Progress) -> HostResult<Operation> {
        let identity = self.identity()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let mut operation = load(&transaction, id)?;
        if operation.owner.kind != OwnerKind::Host
            || operation.owner.id != identity.host_id
            || operation.execution_host_id != identity.host_id
        {
            return Err(HostError::new(
                "INVALID_OPERATION_OWNER",
                "Progress belongs to another operation owner",
            ));
        }
        if !matches!(
            operation.state,
            OperationState::Running | OperationState::CancelRequested
        ) {
            return Err(not_running());
        }
        if !apply_progress(&mut operation, progress)? {
            return Ok(operation);
        }
        operation.revision = operation.revision.checked_next()?;
        transaction
            .execute(
                "UPDATE operations SET operation_json=?1 WHERE operation_id=?2",
                params![encode(&operation)?, id.as_str()],
            )
            .map_err(|_| unavailable())?;
        transaction.commit().map_err(|_| unavailable())?;
        Ok(operation)
    }

    pub(crate) fn record_client_receipt_evidence(
        &mut self,
        id: &Id,
        receipt: ClientEffectReceipt,
    ) -> HostResult<Operation> {
        let identity = self.identity()?;
        if receipt.host_id != identity.host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Receipt belongs to another Host",
            ));
        }
        if receipt.instance_epoch != identity.instance_epoch {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Receipt belongs to another Host instance",
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let mut operation = load(&transaction, id)?;
        if operation.owner.kind != OwnerKind::Host
            || operation.owner.id != identity.host_id
            || operation.execution_host_id != identity.host_id
        {
            return Err(HostError::new(
                "INVALID_OPERATION_OWNER",
                "Receipt belongs to another operation owner",
            ));
        }
        let BuiltinAction::Client(capability) = BuiltinAction::find(operation.action_id.as_str())?
        else {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Operation is not a client effect",
            ));
        };
        if operation.target.kind.as_str() != "client"
            || operation.target.id != receipt.client_target_id
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Receipt target does not match the operation",
            ));
        }
        let dispatched: bool = transaction
            .query_row(
                "SELECT dispatched FROM operations WHERE operation_id=?1",
                [id.as_str()],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        if !dispatched {
            return Err(not_running());
        }
        if let ClientEffectOutcome::Succeeded { result } = &receipt.outcome {
            result.validate_for(capability)?;
        }
        if let Some(existing) = &operation.client_effect_receipt {
            return if existing == &receipt {
                Ok(operation)
            } else {
                Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Operation already has a different client effect receipt",
                ))
            };
        }
        operation.client_effect_receipt = Some(receipt);
        operation.revision = operation.revision.checked_next()?;
        transaction
            .execute(
                "UPDATE operations SET operation_json=?1 WHERE operation_id=?2",
                params![encode(&operation)?, id.as_str()],
            )
            .map_err(|_| unavailable())?;
        transaction.commit().map_err(|_| unavailable())?;
        Ok(operation)
    }

    pub fn record_result_evidence(
        &mut self,
        id: &Id,
        result: ActionResult,
    ) -> HostResult<Operation> {
        self.record_result_evidence_with_read(id, result, None)
    }

    pub(crate) fn record_result_evidence_with_read(
        &mut self,
        id: &Id,
        result: ActionResult,
        source_read: Option<U64>,
    ) -> HostResult<Operation> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let operation = record_result_evidence_in(&transaction, id, result)?;
        if let Some(read) = source_read {
            let Some(ActionResult::FileTransfer(transfer)) = operation.result.as_ref() else {
                return Err(HostError::new(
                    "INVALID_ARGUMENT",
                    "Invalid file transfer read evidence",
                ));
            };
            let write_evidence_bytes = transfer
                .accepted
                .get()
                .saturating_add(transfer.unknown.get());
            if operation.action_id.as_str() != "transfer.file"
                || read > transfer.requested
                || read.get() < write_evidence_bytes
            {
                return Err(HostError::new(
                    "INVALID_ARGUMENT",
                    "Invalid file transfer read evidence",
                ));
            }
            let key = super::file_transfer_read_key(id)?;
            let value = serde_json::json!({ "read": read }).to_string();
            transaction.execute(
                "INSERT INTO documents(id,revision,value_json) VALUES(?1,?2,?3)
                 ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json",
                params![key.as_str(), operation.revision.to_string(), value],
            ).map_err(|_| unavailable())?;
        }
        transaction.commit().map_err(|_| unavailable())?;
        Ok(operation)
    }

    pub fn settle(&mut self, id: &Id, outcome: Settlement) -> HostResult<Operation> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let retention_now = self.retention.now(self.clock.as_ref())?;
        let expires = retention_now
            .checked_add(RETENTION_NS)
            .ok_or_else(exhausted)?;
        let wall = self.clock.wall_time();
        let mut operation = load(&transaction, id)?;
        let (children_running, children_unknown) =
            super::child_operations::child_summary(&transaction, id)?;
        if children_running {
            return Err(HostError::new(
                "OPERATION_HAS_CHILDREN",
                "Child operations have not settled",
            ));
        }
        let mut outcome = outcome;
        if children_unknown {
            outcome.state = OperationState::Unknown;
            outcome.error = Some(HostError::new(
                "CHILD_OUTCOME_UNKNOWN",
                "A child effect could not be confirmed",
            ));
        }
        let allowed = match operation.state {
            OperationState::Queued => matches!(
                outcome.state,
                OperationState::Cancelled | OperationState::Interrupted
            ),
            OperationState::Running => matches!(
                outcome.state,
                OperationState::Succeeded
                    | OperationState::Failed
                    | OperationState::Interrupted
                    | OperationState::Unknown
            ),
            OperationState::CancelRequested => outcome.state.is_terminal(),
            _ => false,
        };
        if !allowed {
            return Err(not_running());
        }
        operation.state = outcome.state;
        // 未给出新证据不能清空已经持久的部分回执。
        if outcome.result.is_some() {
            operation.result = outcome.result;
        }
        operation.error = outcome.error;
        finish(&mut operation, wall)?;
        write_terminal(&transaction, &operation, expires)?;
        save_retention(&transaction, retention_now)?;
        transaction.commit().map_err(|_| unavailable())?;
        self.live_dispatches.remove(id);
        self.task_admissions.remove(id);
        Ok(operation)
    }

    /// 启动恢复只结算历史记录，调用方不能据返回列表重新派发。
    pub fn recover(&mut self) -> HostResult<Vec<Operation>> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let retention_now = self.retention.now(self.clock.as_ref())?;
        let expires = retention_now
            .checked_add(RETENTION_NS)
            .ok_or_else(exhausted)?;
        let wall = self.clock.wall_time();
        let rows = {
            let mut statement = transaction
                .prepare("SELECT operation_json,dispatched FROM operations WHERE terminal=0")
                .map_err(|_| unavailable())?;
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
                })
                .map_err(|_| unavailable())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| unavailable())?
        };
        let mut recovered = Vec::with_capacity(rows.len());
        for (json, dispatched) in rows {
            let mut operation = decode(&json)?;
            operation.state = if dispatched {
                OperationState::Unknown
            } else {
                OperationState::Interrupted
            };
            finish(&mut operation, wall.clone())?;
            write_terminal(&transaction, &operation, expires)?;
            recovered.push(operation);
        }
        save_retention(&transaction, retention_now)?;
        transaction.commit().map_err(|_| unavailable())?;
        self.live_dispatches.clear();
        self.task_admissions.clear();
        Ok(recovered)
    }

    pub fn get(&self, actor: &AuthenticatedActor, id: &Id) -> HostResult<Operation> {
        let operation = load(&self.connection, id)?;
        if &operation.actor_id != actor.id() && !actor.is_user_control() {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Operation is not available to this actor",
            ));
        }
        let expires: Option<String> = self
            .connection
            .query_row(
                "SELECT expires_at_retention_ns FROM operations WHERE operation_id=?1",
                [id.as_str()],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        if let Some(expires) = expires
            && self.retention_now()? >= counter(&expires)?.get()
        {
            return Err(HostError::new(
                "NOT_FOUND",
                "Operation result is no longer retained",
            ));
        }
        Ok(operation)
    }
    pub(crate) fn operation_state(&self, id: &Id) -> HostResult<OperationState> {
        load(&self.connection, id).map(|operation| operation.state)
    }
    /// Trusted source resolver supplies this fact before the accepted operation can dispatch.
    pub(crate) fn record_operation_source_authority(
        &mut self,
        id: &Id,
        source: &Target,
    ) -> HostResult<()> {
        source.validate()?;
        let identity = self.identity()?;
        if source.host_id != identity.host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Source belongs to another Host",
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let operation = load(&transaction, id)?;
        if operation.owner.kind != OwnerKind::Host
            || operation.owner.id != identity.host_id
            || operation.execution_host_id != identity.host_id
        {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Operation source requires this Host owner",
            ));
        }
        let key = operation_source_key(id);
        let previous: Option<String> = transaction
            .query_row(
                "SELECT value_json FROM documents WHERE id=?1",
                [&key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unavailable())?;
        if let Some(previous) = previous {
            return if decode_operation_source(&previous)? == *source {
                Ok(())
            } else {
                Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Operation source is already bound",
                ))
            };
        }
        if operation.state != OperationState::Queued {
            return Err(not_running());
        }
        let document = serde_json::to_string(&OperationSource {
            format_version: "0.1".into(),
            source: source.clone(),
        })
        .map_err(|_| unavailable())?;
        transaction
            .execute(
                "INSERT INTO documents(id,revision,value_json) VALUES(?1,'1',?2)",
                params![key, document],
            )
            .map_err(|_| unavailable())?;
        transaction.commit().map_err(|_| unavailable())
    }
    pub(crate) fn operation_source_authority(&self, id: &Id) -> HostResult<Target> {
        let (operation, _) = self.retained_operation(id)?;
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT value_json FROM documents WHERE id=?1",
                [operation_source_key(id)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unavailable())?;
        let source = decode_operation_source(&json.ok_or_else(|| {
            HostError::new(
                "SOURCE_AUTHORITY_UNAVAILABLE",
                "Retained source authority is unavailable",
            )
        })?)?;
        if source.host_id != operation.execution_host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Saved source belongs to another Host",
            ));
        }
        Ok(source)
    }
    pub(crate) fn retained_operation(
        &self,
        id: &Id,
    ) -> HostResult<(Operation, Option<JsonObject>)> {
        let operation = load(&self.connection, id)?;
        let (expires, input): (Option<String>, String) = self
            .connection
            .query_row(
                "SELECT expires_at_retention_ns,input_json FROM operations WHERE operation_id=?1",
                [id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| unavailable())?;
        if let Some(expires) = expires
            && self.retention_now()? >= counter(&expires)?.get()
        {
            return Err(HostError::new(
                "NOT_FOUND",
                "Operation result is no longer retained",
            ));
        }
        // Never return the canonical envelope (lease, revision, or other admission inputs).
        let params = serde_json::from_str::<serde_json::Value>(&input)
            .ok()
            .and_then(|value| value.get("params").cloned())
            .and_then(|value| serde_json::from_value(value).ok());
        Ok((operation, params))
    }
    pub(crate) fn boundary_operations(
        &mut self,
        target: &Target,
        through: &Id,
        owners: Vec<Id>,
    ) -> HostResult<Vec<Id>> {
        let transaction = self.connection.transaction().map_err(|_| unavailable())?;
        let anchor = load(&transaction, through)?;
        if anchor.target != *target {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Boundary operation belongs to another session or epoch",
            ));
        }
        if !queued_action(anchor.action_id.as_str()) {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Boundary requires an application queue operation",
            ));
        }
        let row: i64 = transaction
            .query_row(
                "SELECT rowid FROM operations WHERE operation_id=?1",
                [through.as_str()],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        let owners = serde_json::to_string(&owners).map_err(|_| unavailable())?;
        let mut statement = transaction
            .prepare("SELECT operation_json FROM operations WHERE rowid<=?1 AND (terminal=0 OR operation_id IN (SELECT value FROM json_each(?2))) ORDER BY rowid")
            .map_err(|_| unavailable())?;
        let rows = statement
            .query_map(params![row, owners], |row| row.get::<_, String>(0))
            .map_err(|_| unavailable())?;
        let mut ids = vec![];
        for value in rows {
            let operation = decode(&value.map_err(|_| unavailable())?)?;
            if operation.target == *target && queued_action(operation.action_id.as_str()) {
                ids.push(operation.operation_id);
            }
        }
        Ok(ids)
    }

    pub fn prune(&mut self) -> HostResult<()> {
        let now = self.retention_now()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        // 规范十进制 TEXT 用长度、再按字节序排序，不经过 SQLite signed INTEGER。
        let expired = {
            let mut statement = transaction.prepare(
                "SELECT operation_json FROM operations WHERE terminal=1 AND (length(expires_at_retention_ns)<length(?1) OR (length(expires_at_retention_ns)=length(?1) AND expires_at_retention_ns<=?1 COLLATE BINARY))",
            ).map_err(|_| unavailable())?;
            statement
                .query_map([now.to_string()], |row| row.get::<_, String>(0))
                .map_err(|_| unavailable())?
                .map(|row| decode(&row.map_err(|_| unavailable())?))
                .collect::<HostResult<Vec<_>>>()?
        };
        for operation in expired {
            super::child_operations::retain_child_summary(&transaction, &operation)?;
            super::plugin_operations::prune(&transaction, &operation.operation_id)?;
            if matches!(
                operation.action_id.as_str(),
                "transfer.file" | "transfer.paste"
            ) {
                prune_transfer_receipts(&transaction, &operation.operation_id)?;
            }
            transaction
                .execute(
                    "DELETE FROM documents WHERE id=?1",
                    [operation_source_key(&operation.operation_id)],
                )
                .map_err(|_| unavailable())?;
            transaction
                .execute(
                    "DELETE FROM operations WHERE operation_id=?1",
                    [operation.operation_id.as_str()],
                )
                .map_err(|_| unavailable())?;
        }
        save_retention(&transaction, now)?;
        transaction.commit().map_err(|_| unavailable())
    }

    pub fn get_selected(
        &self,
        actor: &AuthenticatedActor,
        selector: &OperationGetParams,
    ) -> HostResult<Operation> {
        let (id, context) = match selector {
            OperationGetParams::ById {
                operation_id,
                request_context,
            } => (Some(operation_id.clone()), request_context.as_ref()),
            OperationGetParams::ByRequest {
                actor_id,
                request_id,
                request_context,
            } => {
                if actor_id != actor.id() {
                    return Err(HostError::new(
                        "PERMISSION_DENIED",
                        "Operation belongs to another actor",
                    ));
                }
                let digest = hash(request_context.as_str().as_bytes());
                let found: Option<String> = self.connection.query_row("SELECT operation_id FROM operations WHERE actor_id=?1 AND context_digest=?2 AND request_id=?3",params![actor_id.as_str(),digest.as_str(),request_id.as_str()],|row| row.get(0)).optional().map_err(|_| unavailable())?;
                (
                    found.map(|id| Id::try_from(id.as_str())).transpose()?,
                    Some(request_context),
                )
            }
            OperationGetParams::ByChild {
                parent_operation_id,
                child_key,
            } => {
                return self.get_child(actor, parent_operation_id, child_key);
            }
        };
        if let Some(id) = id {
            match self.get(actor, &id) {
                Ok(operation) => return Ok(operation),
                Err(error) if error.code == "NOT_FOUND" => {}
                Err(error) => return Err(error),
            }
        }
        if let Some(context) = context {
            self.signer
                .validate(context, actor, &self.identity()?, self.clock.as_ref())?;
        }
        Err(HostError::new("NOT_FOUND", "Operation was not found"))
    }
    pub fn operation_metadata(&self) -> HostResult<JsonObject> {
        let mut statement = self
            .connection
            .prepare(
                // The history is a summary, not a replay of every retained result.
                // Select only its fields before deserializing: TX bodies, diagnostic
                // reports and other evidence remain in the authoritative operation.
                "SELECT json_patch('{}', json_object(
                    'operationId', json_extract(operation_json,'$.operationId'),
                    'executionHostId', json_extract(operation_json,'$.executionHostId'),
                    'actorId', json_extract(operation_json,'$.actorId'),
                    'actionId', json_extract(operation_json,'$.actionId'),
                    'target', json_extract(operation_json,'$.target'),
                    'executionMode', json_extract(operation_json,'$.executionMode'),
                    'state', json_extract(operation_json,'$.state'),
                    'revision', json_extract(operation_json,'$.revision'),
                    'revealTarget', json_remove(json_extract(operation_json,'$.revealTarget'),'$.resultRef'),
                    'acceptedAt', json_extract(operation_json,'$.acceptedAt'),
                    'startedAt', json_extract(operation_json,'$.startedAt'),
                    'settledAt', json_extract(operation_json,'$.settledAt'),
                    'progress', json_extract(operation_json,'$.progress'),
                    'errorCode', coalesce(json_extract(operation_json,'$.error.code'),
                        CASE WHEN json_extract(operation_json,'$.result.kind')='tx'
                        THEN json_extract(operation_json,'$.result.value.backendError.code') END)
                )) FROM operations ORDER BY terminal ASC,rowid DESC LIMIT 256",
            )
            .map_err(|_| unavailable())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| unavailable())?;
        let mut items = Vec::new();
        for row in rows {
            let summary: OperationSummary = serde_json::from_str(&row.map_err(|_| unavailable())?)
                .map_err(|_| unavailable())?;
            items.push(summary);
        }
        serde_json::from_value(
            serde_json::to_value(OperationsSnapshot { items }).map_err(|_| unavailable())?,
        )
        .map_err(|_| unavailable())
    }

    pub fn request_cancel(&mut self, actor: &AuthenticatedActor, id: &Id) -> HostResult<Operation> {
        self.get(actor, id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let mut statement=transaction.prepare("WITH RECURSIVE selected(id) AS (SELECT ?1 UNION ALL SELECT o.operation_id FROM operations o JOIN selected s ON json_extract(o.operation_json,'$.admission.parentOperationId')=s.id WHERE o.terminal=0 AND json_extract(o.operation_json,'$.admission.kind')='child') SELECT operation_json FROM operations WHERE operation_id IN (SELECT id FROM selected) LIMIT ?2").map_err(|_|unavailable())?;
        let operations = statement
            .query_map(params![id.as_str(), MAX_IN_FLIGHT + 2], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| unavailable())?
            .map(|row| decode(&row.map_err(|_| unavailable())?))
            .collect::<HostResult<Vec<_>>>()?;
        drop(statement);
        if operations.len() > MAX_IN_FLIGHT as usize + 1 {
            return Err(HostError::new(
                "HOST_BUSY",
                "Cancellation evidence exceeds the in-flight budget",
            ));
        }
        let mut closed = Vec::new();
        for mut operation in operations {
            closed.push(operation.operation_id.clone());
            match operation.state {
                OperationState::Queued => {
                    operation.state = OperationState::Cancelled;
                    finish(&mut operation, self.clock.wall_time())?;
                    let now = self.retention.now(self.clock.as_ref())?;
                    write_terminal(
                        &transaction,
                        &operation,
                        now.checked_add(RETENTION_NS).ok_or_else(exhausted)?,
                    )?;
                    save_retention(&transaction, now)?;
                }
                OperationState::Running => {
                    operation.state = OperationState::CancelRequested;
                    operation.revision = operation.revision.checked_next()?;
                    transaction
                        .execute(
                            "UPDATE operations SET operation_json=?1 WHERE operation_id=?2",
                            params![encode(&operation)?, operation.operation_id.as_str()],
                        )
                        .map_err(|_| unavailable())?;
                }
                _ => {}
            }
        }
        let operation = load(&transaction, id)?;
        transaction.commit().map_err(|_| unavailable())?;
        for id in closed {
            self.task_admissions.remove(&id);
        }
        Ok(operation)
    }
}

fn prune_transfer_receipts(connection: &Connection, operation_id: &Id) -> HostResult<()> {
    let manifest = format!("transfer-receipts-{operation_id}");
    let prefix = format!("{manifest}-");
    // '-' 的下一个 ASCII 字符是 '.'，范围只覆盖此 operation 的 chunk 前缀。
    let upper = format!("{manifest}.");
    let read = super::file_transfer_read_key(operation_id)?;
    let candidates = {
        let mut statement = connection.prepare(
            "SELECT id FROM documents WHERE id IN (?1,?4) OR (id>=?2 COLLATE BINARY AND id<?3 COLLATE BINARY)",
        ).map_err(|_| unavailable())?;
        statement
            .query_map(params![manifest, prefix, upper, read.as_str()], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|_| unavailable())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| unavailable())?
    };
    for key in candidates {
        let owned = key == manifest
            || key == read.as_str()
            || key.strip_prefix(&prefix).is_some_and(|ordinal| {
                ordinal
                    .parse::<u64>()
                    .is_ok_and(|value| value.to_string() == ordinal)
            });
        if owned {
            connection
                .execute("DELETE FROM documents WHERE id=?1", [key])
                .map_err(|_| unavailable())?;
        }
    }
    Ok(())
}

fn queued_action(action: &str) -> bool {
    matches!(
        action,
        "session.tx"
            | "session.configure"
            | "session.control"
            | "session.break"
            | "session.setReadOnly"
            | "tx.drain"
    )
}
fn finish(operation: &mut Operation, wall: Timestamp) -> HostResult<()> {
    operation.revision = operation.revision.checked_next()?;
    operation.result_expires_at = Some(add_wall_seconds(&wall, 604_800)?);
    operation.settled_at = Some(wall);
    Ok(())
}
fn write_terminal(connection: &Connection, operation: &Operation, expires: u64) -> HostResult<()> {
    connection.execute("UPDATE operations SET operation_json=?1,terminal=1,expires_at_retention_ns=?2 WHERE operation_id=?3", params![encode(operation)?, expires.to_string(), operation.operation_id.as_str()]).map_err(|_| unavailable())?;
    Ok(())
}
pub(super) fn load(connection: &Connection, id: &Id) -> HostResult<Operation> {
    let json: Option<String> = connection
        .query_row(
            "SELECT operation_json FROM operations WHERE operation_id=?1",
            [id.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| unavailable())?;
    decode(&json.ok_or_else(|| HostError::new("NOT_FOUND", "Operation was not found"))?)
}
pub(super) fn encode(operation: &Operation) -> HostResult<String> {
    serde_json::to_string(operation).map_err(|_| unavailable())
}
pub(super) fn decode(json: &str) -> HostResult<Operation> {
    serde_json::from_str(json).map_err(|_| unavailable())
}
fn not_running() -> HostError {
    HostError::new(
        "OPERATION_NOT_RUNNING",
        "Operation transition is not allowed",
    )
}
fn exhausted() -> HostError {
    HostError::new("COUNTER_EXHAUSTED", "Retention clock exhausted")
}

pub(super) fn record_result_evidence_in(
    connection: &rusqlite::Connection,
    id: &Id,
    result: ActionResult,
) -> HostResult<Operation> {
    let mut operation = load(connection, id)?;
    if !matches!(
        operation.state,
        OperationState::Running | OperationState::CancelRequested
    ) {
        return Err(not_running());
    }
    operation.revision = operation.revision.checked_next()?;
    if let ActionResult::FileTransfer(transfer) = &result {
        operation.progress = Some(Progress {
            completed: transfer.accepted,
            unit: "bytes".into(),
            total: Some(transfer.requested),
        });
    }
    operation.result = Some(result);
    connection
        .execute(
            "UPDATE operations SET operation_json=?1 WHERE operation_id=?2",
            params![encode(&operation)?, id.as_str()],
        )
        .map_err(|_| unavailable())?;
    Ok(operation)
}
