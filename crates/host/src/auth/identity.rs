use serial_workbench_core::{Id, U64};

/// 可信Host持久启用意图引用身份，不保存凭据，也不携带任务委托或人工控制权。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ActorReference {
    pub(super) actor_id: Id,
    pub(super) client_id: Id,
}

#[derive(Clone, Debug)]
pub struct AuthenticatedActor {
    id: Id,
    client_id: Id,
    grant_revision: U64,
    user_control: bool,
    task: Option<std::sync::Arc<super::task_scope::TaskAuthority>>,
}
impl AuthenticatedActor {
    pub(super) fn from_verified(
        id: Id,
        client_id: Id,
        grant_revision: U64,
        user_control: bool,
    ) -> Self {
        Self {
            id,
            client_id,
            grant_revision,
            user_control,
            task: None,
        }
    }
    pub fn id(&self) -> &Id {
        &self.id
    }
    pub fn client_id(&self) -> &Id {
        &self.client_id
    }
    pub fn grant_revision(&self) -> U64 {
        self.grant_revision
    }
    pub fn is_user_control(&self) -> bool {
        self.user_control && self.task.is_none()
    }
    pub(crate) fn persistent_reference(&self) -> Option<ActorReference> {
        (!self.user_control && self.task.is_none()).then(|| ActorReference {
            actor_id: self.id.clone(),
            client_id: self.client_id.clone(),
        })
    }
    pub(super) fn has_user_control_identity(&self) -> bool {
        self.user_control
    }
    pub(crate) fn task(&self) -> Option<&std::sync::Arc<super::task_scope::TaskAuthority>> {
        self.task.as_ref()
    }
    pub(crate) fn with_task(&self, task: super::task_scope::TaskAuthority) -> Self {
        let mut actor = self.clone();
        actor.task = Some(std::sync::Arc::new(task));
        actor
    }
    pub(crate) fn check_task(&self) -> serial_workbench_core::HostResult<()> {
        self.task.as_ref().map_or(Ok(()), |task| (task.check)())
    }
    pub(crate) fn check_task_target(
        &self,
        target: &serial_workbench_core::Target,
    ) -> serial_workbench_core::HostResult<()> {
        self.task
            .as_ref()
            .map_or(Ok(()), |task| task.check_target(target))
    }
    pub(crate) fn mark_admission_queued(&self) {
        if let Some(task) = &self.task {
            task.admission_queued
                .store(true, std::sync::atomic::Ordering::Release);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostIdentity {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub catalog_version: U64,
}
