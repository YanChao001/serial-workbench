//! 插件接纳依据与不可变结果共同保留；读取权限由所属Host/FileService复核。
use super::{Acceptance, Store, db::Database, operations, unavailable};
use crate::auth::AuthenticatedActor;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginOperation {
    pub format_version: String,
    pub package: NodePackageId,
    pub version: NodePackageVersion,
    pub archive_sha256: Digest,
    pub instance_id: Id,
    pub host_api: Vec<NodeHostApiScope>,
    pub spec: ActionSpec,
}
impl PluginOperation {
    pub(super) fn owner(&self) -> HostResult<Owner> {
        Ok(Owner {
            kind: OwnerKind::Plugin,
            id: Id::try_from(self.package.as_str())?,
            version: Some(self.version.as_str().to_owned()),
        })
    }
    pub(super) fn dependencies(&self) -> HostResult<Vec<Dependency>> {
        Ok(vec![Dependency {
            id: Id::try_from(self.package.as_str())?,
            version: self.version.as_str().to_owned(),
            digest: self.archive_sha256.clone(),
        }])
    }
    pub(super) fn validate_call(&self, call: &Call) -> HostResult<()> {
        self.format()?;
        if self.spec.kind != ActionKind::Action
            || self.spec.execution_location != ExecutionLocation::ResourceHost
            || self.spec.action_id != call.action_id
            || !self.spec.target_kinds.contains(&call.target.kind)
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Plugin admission does not match the action",
            ));
        }
        self.owner()?;
        Ok(())
    }
    fn format(&self) -> HostResult<()> {
        if self.format_version != "0.1" {
            return Err(HostError::new(
                "UNSUPPORTED_FORMAT",
                "Plugin operation format is unsupported",
            ));
        }
        Ok(())
    }
    pub(crate) fn validate_operation(&self, operation: &Operation) -> HostResult<()> {
        self.format()?;
        if operation.owner != self.owner()?
            || operation.action_id != self.spec.action_id
            || operation.dependencies.as_ref() != Some(&self.dependencies()?)
            || !self.spec.target_kinds.contains(&operation.target.kind)
        {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Retained plugin authority does not match the operation",
            ));
        }
        Ok(())
    }
}
pub(super) fn key(id: &Id) -> String {
    format!("plugin-operation-{id}")
}
fn result_key(id: &Id) -> String {
    format!("plugin-operation-result-{id}")
}
pub(crate) fn result_operation(reference: &ObjectRef) -> HostResult<Option<Id>> {
    Ok((reference.kind.as_str() == "plugin_result").then(|| reference.id.clone()))
}
fn result_reference(host_id: &Id, id: &Id) -> HostResult<ObjectRef> {
    Ok(ObjectRef {
        host_id: host_id.clone(),
        kind: ResourceKind::try_from("plugin_result")?,
        id: id.clone(),
        revision: Some(1.into()),
    })
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginResult {
    format_version: String,
    operation_id: Id,
    pub bytes_base64: Bytes,
    pub length: U64,
    pub fingerprint: Digest,
}
impl PluginResult {
    fn decode(raw: &str, id: &Id) -> HostResult<Self> {
        let result: Self = serde_json::from_str(raw).map_err(|_| unavailable())?;
        if result.format_version != "0.1" {
            return Err(HostError::new(
                "UNSUPPORTED_FORMAT",
                "Plugin result format is unsupported",
            ));
        }
        if &result.operation_id != id
            || result.length.get() > serial_workbench_ipc::frame::MAX_FRAME_BYTES as u64
        {
            return Err(HostError::new(
                "REFERENCE_CHANGED",
                "Plugin result identity changed",
            ));
        }
        Ok(result)
    }
}
impl Store {
    pub(crate) fn accept_plugin(
        &self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
        plugin: &PluginOperation,
        startup_revisions: Option<[(Id, U64); 2]>,
    ) -> HostResult<Acceptance> {
        let (actor, call, digest, plugin) =
            (actor.clone(), call.clone(), digest.clone(), plugin.clone());
        let result = self.request(move |database| {
            database.accept_plugin(&actor, &call, &digest, &plugin, startup_revisions)
        })?;
        if matches!(result, Acceptance::New(_)) {
            self.publish_operation_change();
        }
        Ok(result)
    }
    pub(crate) fn plugin_operation(&self, id: &Id) -> HostResult<PluginOperation> {
        let id = id.clone();
        self.request(move |database| database.plugin_operation(&id))
    }
    pub(crate) fn plugin_result(&self, id: &Id) -> HostResult<PluginResult> {
        let id = id.clone();
        self.request(move |database| database.plugin_result(&id))
    }
    pub(crate) fn record_plugin_result(&self, id: &Id, bytes: &[u8]) -> HostResult<ActionResult> {
        if bytes.len() > serial_workbench_ipc::frame::MAX_FRAME_BYTES {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Plugin result exceeds the control budget",
            ));
        }
        let document = PluginResult {
            format_version: "0.1".into(),
            operation_id: id.clone(),
            bytes_base64: Bytes::try_from(STANDARD.encode(bytes).as_str())?,
            length: (bytes.len() as u64).into(),
            fingerprint: Digest::try_from(format!("{:x}", Sha256::digest(bytes)).as_str())?,
        };
        let id = id.clone();
        let result = self.request(move |database| database.record_plugin_result(&id, document))?;
        self.publish_operation_change();
        Ok(result)
    }

    /// 真实执行owner提交事实；身份来自Host绑定，不接受插件选择Operation或代次。
    pub(crate) fn record_plugin_observation(
        &self,
        id: &Id,
        instance: &Id,
        epoch: U64,
        progress: Option<Progress>,
        workers: Option<WorkerObservation>,
    ) -> HostResult<Operation> {
        let (id, instance) = (id.clone(), instance.clone());
        let operation = self.request(move |database| {
            database.record_plugin_observation(&id, &instance, epoch, progress, workers)
        })?;
        // 仅内容观察更新；不能使监督线程因采样洪泛反复读取同一执行状态。
        self.operation_changes.send_replace(());
        Ok(operation)
    }
}
impl Database {
    fn record_plugin_observation(
        &mut self,
        id: &Id,
        instance: &Id,
        epoch: U64,
        progress: Option<Progress>,
        workers: Option<WorkerObservation>,
    ) -> HostResult<Operation> {
        let identity = self.identity()?;
        if epoch != identity.instance_epoch {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Observation belongs to another Host instance",
            ));
        }
        if !self.live_dispatches.contains(id) {
            return Err(HostError::new(
                "OPERATION_NOT_RUNNING",
                "Observation owner is not executing",
            ));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let mut operation = operations::load(&transaction, id)?;
        if operation.owner.kind != OwnerKind::Plugin {
            return Err(HostError::new(
                "INVALID_OPERATION_OWNER",
                "Observation belongs to another operation owner",
            ));
        }
        super::child_operations::owner_instance(&transaction, &identity, &operation, instance)?;
        if !matches!(
            operation.state,
            OperationState::Running | OperationState::CancelRequested
        ) {
            return Err(HostError::new(
                "OPERATION_NOT_RUNNING",
                "Observation owner has finished",
            ));
        }
        let mut changed = false;
        if let Some(progress) = progress {
            changed |= operations::apply_progress(&mut operation, progress)?;
        }
        if let Some(mut workers) = workers {
            if workers.live_workers > workers.peak_workers
                || workers
                    .last_memory
                    .as_ref()
                    .is_some_and(|memory| memory.measured_workers > workers.peak_workers)
                || operation
                    .worker_observation
                    .as_ref()
                    .is_some_and(|previous| workers.peak_workers < previous.peak_workers)
            {
                return Err(HostError::new(
                    "INVALID_ARGUMENT",
                    "Worker observation counters do not match their lifecycle",
                ));
            }
            if workers.last_memory.is_none() {
                workers.last_memory = operation
                    .worker_observation
                    .as_ref()
                    .and_then(|previous| previous.last_memory.clone());
            }
            if operation.worker_observation.as_ref() != Some(&workers) {
                operation.worker_observation = Some(workers);
                changed = true;
            }
        }
        if !changed {
            return Ok(operation);
        }
        operation.revision = operation.revision.checked_next()?;
        // 沿用文档提交的控制封套余量，不能把自体可放入私有帧的观察写成不可读取的Operation。
        // 同时留给最终时间、结果引用、稳定错误及公开RPC封套；拒绝观察不改变领域回执。
        serial_workbench_ipc::frame::encoded_length(
            &operation,
            serial_workbench_ipc::frame::MAX_FRAME_BYTES - 16 * 1024,
        )?;
        transaction
            .execute(
                "UPDATE operations SET operation_json=?1 WHERE operation_id=?2",
                params![operations::encode(&operation)?, id.as_str()],
            )
            .map_err(|_| unavailable())?;
        transaction.commit().map_err(|_| unavailable())?;
        Ok(operation)
    }

    pub(super) fn plugin_operation(&self, id: &Id) -> HostResult<PluginOperation> {
        let (operation, _) = self.retained_operation(id)?;
        let raw: String = self
            .connection
            .query_row(
                "SELECT value_json FROM documents WHERE id=?1",
                [key(id)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unavailable())?
            .ok_or_else(|| {
                HostError::new(
                    "PERMISSION_DENIED",
                    "Retained plugin authority is unavailable",
                )
            })?;
        let plugin: PluginOperation = serde_json::from_str(&raw).map_err(|_| unavailable())?;
        plugin.validate_operation(&operation)?;
        Ok(plugin)
    }
    fn plugin_result(&self, id: &Id) -> HostResult<PluginResult> {
        self.plugin_operation(id)?;
        let (operation, _) = self.retained_operation(id)?;
        let expected = ActionResult::Reference(ResultReference {
            result_ref: result_reference(&operation.execution_host_id, id)?,
        });
        if operation.result.as_ref() != Some(&expected) {
            return Err(HostError::new(
                "NOT_FOUND",
                "Plugin result is not committed",
            ));
        }
        let raw: String = self
            .connection
            .query_row(
                "SELECT value_json FROM documents WHERE id=?1",
                [result_key(id)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unavailable())?
            .ok_or_else(|| HostError::new("NOT_FOUND", "Plugin result was not found"))?;
        PluginResult::decode(&raw, id)
    }
    fn record_plugin_result(
        &mut self,
        id: &Id,
        document: PluginResult,
    ) -> HostResult<ActionResult> {
        self.plugin_operation(id)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let mut operation = operations::load(&transaction, id)?;
        if !matches!(
            operation.state,
            OperationState::Running | OperationState::CancelRequested
        ) {
            return Err(HostError::new(
                "OPERATION_NOT_RUNNING",
                "Operation is not running",
            ));
        }
        let result = ActionResult::Reference(ResultReference {
            result_ref: result_reference(&operation.execution_host_id, id)?,
        });
        if let Some(raw) = transaction
            .query_row(
                "SELECT value_json FROM documents WHERE id=?1",
                [result_key(id)],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| unavailable())?
        {
            let existing = PluginResult::decode(&raw, id)?;
            if existing.bytes_base64 != document.bytes_base64
                || existing.fingerprint != document.fingerprint
                || operation.result.as_ref() != Some(&result)
            {
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Plugin result is immutable",
                ));
            }
            return Ok(result);
        }
        if operation.result.is_some() {
            return Err(HostError::new(
                "REQUEST_CONFLICT",
                "Operation already has different result evidence",
            ));
        }
        transaction
            .execute(
                "INSERT INTO documents(id,revision,value_json) VALUES(?1,'1',?2)",
                params![
                    result_key(id),
                    serde_json::to_string(&document).map_err(|_| unavailable())?
                ],
            )
            .map_err(|_| unavailable())?;
        operation.result = Some(result.clone());
        operation.revision = operation.revision.checked_next()?;
        transaction
            .execute(
                "UPDATE operations SET operation_json=?1 WHERE operation_id=?2",
                params![
                    serde_json::to_string(&operation).map_err(|_| unavailable())?,
                    id.as_str()
                ],
            )
            .map_err(|_| unavailable())?;
        transaction.commit().map_err(|_| unavailable())?;
        Ok(result)
    }
}
pub(super) fn prune(connection: &Connection, id: &Id) -> HostResult<()> {
    for key in [key(id), result_key(id)] {
        connection
            .execute("DELETE FROM documents WHERE id=?1", [key])
            .map_err(|_| unavailable())?;
    }
    Ok(())
}
