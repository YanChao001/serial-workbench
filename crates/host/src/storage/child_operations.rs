//! 子键与父水位在同一持久事务提交；执行/资源权限由可信Host调度器另行复核。
use super::{
    Acceptance, Store,
    db::{Database, counter},
    operations,
    plugin_operations::PluginOperation,
    unavailable,
};
use crate::auth::{AuthenticatedActor, HostIdentity, hash};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serial_workbench_core::*;

fn stopped() -> HostError {
    HostError::new("OPERATION_NOT_RUNNING", "Parent execution is not running")
}
fn expired() -> HostError {
    HostError::new("RESULT_EXPIRED", "Child identity is no longer retained")
}
fn summary_key(id: &Id) -> String {
    format!("operation-children-{id}")
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildSummary {
    format_version: String,
    unknown: bool,
}
fn retained_summary(
    connection: &Connection,
    parent: &Id,
) -> HostResult<Option<(U64, ChildSummary)>> {
    let retained: Option<(String, String)> = connection
        .query_row(
            "SELECT revision,value_json FROM documents WHERE id=?1",
            [summary_key(parent)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| unavailable())?;
    retained
        .map(|(revision, raw)| {
            let value: ChildSummary = serde_json::from_str(&raw).map_err(|_| unavailable())?;
            if value.format_version != "0.1" {
                return Err(HostError::new(
                    "UNSUPPORTED_FORMAT",
                    "Child summary format is unsupported",
                ));
            }
            Ok((counter(&revision)?, value))
        })
        .transpose()
}
pub(super) fn child_summary(connection: &Connection, parent: &Id) -> HostResult<(bool, bool)> {
    let (running,unknown):(bool,bool)=connection.query_row("SELECT EXISTS(SELECT 1 FROM operations WHERE terminal=0 AND json_extract(operation_json,'$.admission.kind')='child' AND json_extract(operation_json,'$.admission.parentOperationId')=?1), EXISTS(SELECT 1 FROM operations WHERE json_extract(operation_json,'$.admission.kind')='child' AND json_extract(operation_json,'$.admission.parentOperationId')=?1 AND json_extract(operation_json,'$.state')='unknown')",[parent.as_str()],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|unavailable())?;
    let retained = retained_summary(connection, parent)?.is_some_and(|(_, value)| value.unknown);
    Ok((running, unknown || retained))
}
pub(super) fn retain_child_summary(
    connection: &Connection,
    operation: &Operation,
) -> HostResult<()> {
    let own_summary = retained_summary(connection, &operation.operation_id)?;
    if (operation.state == OperationState::Unknown
        || own_summary.is_some_and(|(_, value)| value.unknown))
        && let Admission::Child {
            parent_operation_id,
            ..
        } = &operation.admission
    {
        let previous = retained_summary(connection, parent_operation_id)?;
        if !previous.as_ref().is_some_and(|(_, value)| value.unknown) {
            let revision = previous
                .map_or(U64::from(0), |(revision, _)| revision)
                .checked_next()?;
            let summary = serde_json::to_string(&ChildSummary {
                format_version: "0.1".into(),
                unknown: true,
            })
            .map_err(|_| unavailable())?;
            connection.execute("INSERT INTO documents(id,revision,value_json) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM operations WHERE operation_id=?4) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json",params![summary_key(parent_operation_id),revision.to_string(),summary,parent_operation_id.as_str()]).map_err(|_|unavailable())?;
        }
    }
    connection
        .execute(
            "DELETE FROM documents WHERE id=?1",
            [summary_key(&operation.operation_id)],
        )
        .map_err(|_| unavailable())?;
    Ok(())
}

pub(super) fn owner_instance(
    connection: &Connection,
    identity: &HostIdentity,
    parent: &Operation,
    instance: &Id,
) -> HostResult<()> {
    if parent.execution_host_id != identity.host_id {
        return Err(stopped());
    }
    match parent.owner.kind {
        OwnerKind::Host
            if parent.owner.id == identity.host_id && instance == &parent.operation_id =>
        {
            Ok(())
        }
        OwnerKind::Plugin => {
            let raw: String = connection
                .query_row(
                    "SELECT value_json FROM documents WHERE id=?1",
                    [super::plugin_operations::key(&parent.operation_id)],
                    |row| row.get(0),
                )
                .map_err(|_| unavailable())?;
            let plugin: PluginOperation = serde_json::from_str(&raw).map_err(|_| unavailable())?;
            plugin.validate_operation(parent)?;
            if plugin.instance_id == *instance {
                Ok(())
            } else {
                Err(HostError::new(
                    "PERMISSION_DENIED",
                    "Task owner instance does not match",
                ))
            }
        }
        _ => Err(HostError::new(
            "PERMISSION_DENIED",
            "Task owner instance does not match",
        )),
    }
}

impl Store {
    pub(crate) fn close_task_admission(&self, parent: &Id) -> HostResult<()> {
        let (reply, ack) = std::sync::mpsc::sync_channel(1);
        // 真实执行owner最多8个；关闭在同一有界writer队列等待位置及确认，不能因忙而丢弃。
        self.writer
            .sender
            .send(super::WriterMessage::CloseTask {
                parent: parent.clone(),
                reply,
            })
            .map_err(|_| unavailable())?;
        ack.recv().map_err(|_| unavailable())
    }
    pub(crate) fn child_summary(&self, parent: &Id) -> HostResult<(bool, bool)> {
        let parent = parent.clone();
        self.request(move |database| child_summary(&database.connection, &parent))
    }
    /// 签发所需验证先完成；只有真实Running提交成功后才交付执行凭据。
    pub fn dispatch_task(&self, parent: &Id, owner_instance: &Id) -> HostResult<ContextToken> {
        let (parent, instance) = (parent.clone(), owner_instance.clone());
        let token = self.request(move |database| database.dispatch_task(&parent, &instance))?;
        self.publish_operation_change();
        Ok(token)
    }
    /// 仅供真实派发owner使用；不得将此入口暴露为按parentOperationId领取凭据的RPC。
    pub fn issue_task_context(&self, parent: &Id, owner_instance: &Id) -> HostResult<ContextToken> {
        let (parent, owner_instance) = (parent.clone(), owner_instance.clone());
        self.request(move |database| database.issue_task_context(&parent, &owner_instance))
    }
    /// 可信调度器已规范化params、检查当前调用者/插件/资源授权；本层只提交身份和证据。
    pub fn accept_child(
        &self,
        actor: &AuthenticatedActor,
        call: &ChildCall,
        owner_instance: &Id,
    ) -> HostResult<Acceptance> {
        let (actor, call, owner_instance) = (actor.clone(), call.clone(), owner_instance.clone());
        let result =
            self.request(move |database| database.accept_child(&actor, &call, &owner_instance))?;
        if matches!(result, Acceptance::New(_)) {
            self.publish_operation_change();
        }
        Ok(result)
    }
}

impl Database {
    fn dispatch_task(&mut self, parent: &Id, instance: &Id) -> HostResult<ContextToken> {
        let identity = self.identity()?;
        let operation = operations::load(&self.connection, parent)?;
        if operation.state != OperationState::Queued {
            return Err(stopped());
        }
        owner_instance(&self.connection, &identity, &operation, instance)?;
        let token = self
            .signer
            .issue_task(&operation, identity.instance_epoch.get(), instance)?;
        self.mark_dispatch(parent)?;
        Ok(token)
    }
    fn issue_task_context(&self, parent: &Id, instance: &Id) -> HostResult<ContextToken> {
        let identity = self.identity()?;
        let parent = operations::load(&self.connection, parent)?;
        if parent.state != OperationState::Running
            || !self.task_admissions.contains(&parent.operation_id)
        {
            return Err(stopped());
        }
        owner_instance(&self.connection, &identity, &parent, instance)?;
        self.signer
            .issue_task(&parent, identity.instance_epoch.get(), instance)
    }
    fn accept_child(
        &mut self,
        actor: &AuthenticatedActor,
        call: &ChildCall,
        instance: &Id,
    ) -> HostResult<Acceptance> {
        self.child_request(actor, call, instance, None, None, true)?
            .ok_or_else(unavailable)
    }
    pub(super) fn child_request(
        &mut self,
        actor: &AuthenticatedActor,
        call: &ChildCall,
        instance: &Id,
        source: Option<&Target>,
        plugin: Option<&PluginOperation>,
        create: bool,
    ) -> HostResult<Option<Acceptance>> {
        let identity = self.identity()?;
        if let Some(source) = source {
            source.validate()?;
            if source.host_id != identity.host_id {
                return Err(HostError::new(
                    "HOST_ID_MISMATCH",
                    "Child source belongs to another Host",
                ));
            }
        }
        if call.actor_id != *actor.id() {
            return Err(HostError::new(
                "ACTOR_MISMATCH",
                "Authenticated actor does not match child",
            ));
        }
        if call.host_id != identity.host_id || call.target.host_id != identity.host_id {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Child belongs to another Host",
            ));
        }
        if call.instance_epoch != identity.instance_epoch {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Child belongs to another Host instance",
            ));
        }
        call.target.validate()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let mut parent = operations::load(&transaction, &call.parent_operation_id)?;
        if parent.actor_id != *actor.id() {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Parent belongs to another actor",
            ));
        }
        if parent.state != OperationState::Running
            || !self.task_admissions.contains(&parent.operation_id)
        {
            return Err(stopped());
        }
        owner_instance(&transaction, &identity, &parent, instance)?;
        let context = self.signer.validate_task(
            &call.task_context,
            &parent,
            identity.instance_epoch.get(),
            instance,
        )?;
        let value = serde_json::json!({"actorId":call.actor_id,"owner":parent.owner,"actionId":call.action_id,"target":call.target,"executionMode":parent.execution_mode,"expectedRevision":call.expected_revision,"leaseId":call.lease_id,"params":call.params});
        let mut input = Vec::new();
        operations::write_canonical(&value, &mut input)?;
        let digest = hash(&input);
        let previous: Option<(String,String,Option<String>)> = transaction.query_row("SELECT digest,operation_json,expires_at_retention_ns FROM operations WHERE json_extract(operation_json,'$.admission.kind')='child' AND json_extract(operation_json,'$.admission.parentOperationId')=?1 AND json_extract(operation_json,'$.admission.childKey')=?2",params![parent.operation_id.as_str(),call.child_key.get().to_string()],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(|_| unavailable())?;
        if let Some((stored, json, expires)) = previous {
            if let Some(expires) = expires
                && self.retention.now(self.clock.as_ref())? >= counter(&expires)?.get()
            {
                return Err(expired());
            }
            if stored != digest.as_str() {
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Child identity is bound to another intent",
                ));
            }
            let previous = operations::decode(&json)?;
            return Ok(Some(Acceptance::Existing(previous)));
        }
        if call.child_key.get() <= parent.child_high_watermark.get() {
            return Err(expired());
        }
        if call.child_key.get() != parent.child_high_watermark.checked_next()?.get() {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Child key must immediately follow the parent watermark",
            ));
        }
        if !create {
            return Ok(None);
        }
        let in_flight: i64 = transaction
            .query_row(
                "SELECT count(*) FROM operations WHERE terminal=0",
                [],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        if in_flight >= operations::MAX_IN_FLIGHT {
            return Err(HostError::new(
                "HOST_BUSY",
                "Host operation capacity is full",
            ));
        }
        let id = Id::try_from(uuid::Uuid::new_v4().to_string().as_str())?;
        let request_id = RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())?;
        let child = Operation {
            operation_id: id,
            execution_host_id: identity.host_id.clone(),
            actor_id: actor.id().clone(),
            request_id,
            admission: Admission::Child {
                task_context_digest: context.clone(),
                parent_operation_id: parent.operation_id.clone(),
                child_key: call.child_key,
            },
            root_operation_id: parent.root_operation_id.clone(),
            child_high_watermark: 0.into(),
            action_id: call.action_id.clone(),
            target: call.target.clone(),
            execution_mode: parent.execution_mode,
            state: OperationState::Queued,
            revision: 1.into(),
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
        parent.child_high_watermark = call.child_key.get().into();
        parent.revision = parent.revision.checked_next()?;
        transaction.execute("INSERT INTO operations(operation_id,actor_id,context_digest,request_id,digest,input_json,operation_json,dispatched,terminal) VALUES(?1,?2,?3,?4,?5,?6,?7,0,0)",params![child.operation_id.as_str(),actor.id().as_str(),context.as_str(),child.request_id.as_str(),digest.as_str(),std::str::from_utf8(&input).map_err(|_|unavailable())?,operations::encode(&child)?]).map_err(|_| unavailable())?;
        transaction
            .execute(
                "UPDATE operations SET operation_json=?1 WHERE operation_id=?2",
                params![operations::encode(&parent)?, parent.operation_id.as_str()],
            )
            .map_err(|_| unavailable())?;
        if let Some(source) = source {
            operations::save_operation_source(&transaction, &child.operation_id, source)?;
        }
        if let Some(plugin) = plugin {
            transaction
                .execute(
                    "INSERT INTO documents(id,revision,value_json) VALUES(?1,'1',?2)",
                    params![
                        super::plugin_operations::key(&child.operation_id),
                        serde_json::to_string(plugin).map_err(|_| unavailable())?
                    ],
                )
                .map_err(|_| unavailable())?;
        }
        transaction.commit().map_err(|_| unavailable())?;
        Ok(Some(Acceptance::New(child)))
    }
    pub(super) fn get_child(
        &self,
        actor: &AuthenticatedActor,
        parent: &Id,
        key: &PositiveU64,
    ) -> HostResult<Operation> {
        let parent = self.get(actor, parent)?;
        let id: Option<String> = self.connection.query_row("SELECT operation_id FROM operations WHERE json_extract(operation_json,'$.admission.kind')='child' AND json_extract(operation_json,'$.admission.parentOperationId')=?1 AND json_extract(operation_json,'$.admission.childKey')=?2",params![parent.operation_id.as_str(),key.get().to_string()],|row|row.get(0)).optional().map_err(|_| unavailable())?;
        if let Some(id) = id {
            match self.get(actor, &Id::try_from(id.as_str())?) {
                Ok(operation) => return Ok(operation),
                Err(error) if error.code == "NOT_FOUND" => {}
                Err(error) => return Err(error),
            }
        }
        if key.get() <= parent.child_high_watermark.get() {
            Err(expired())
        } else {
            Err(HostError::new("NOT_FOUND", "Child operation was not found"))
        }
    }
}
