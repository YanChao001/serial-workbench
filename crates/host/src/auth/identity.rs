use crate::lan::LanOrigin;
use serial_workbench_core::{HostError, HostResult, Id, U64};
use sha2::{Digest as _, Sha256};

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
    mcp_observer_source: bool,
    forwarded: Option<ForwardedActor>,
    task: Option<std::sync::Arc<super::task_scope::TaskAuthority>>,
}

#[derive(Clone, Debug)]
struct ForwardedActor {
    pairing: ActorReference,
    source_client_id: Id,
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
            mcp_observer_source: false,
            forwarded: None,
            task: None,
        }
    }
    /// 只能在配对 Host 认证后接受来源。当前配对代次参与派生，重新配对不会复用主体。
    pub(crate) fn forward_lan(&self, origin: &LanOrigin) -> HostResult<Self> {
        let mut identity = Sha256::new();
        identity.update(b"serial-workbench-lan-actor-v1\0");
        identity.update(self.id.as_str());
        identity.update(b"\0");
        identity.update(origin.actor_id.as_str());
        identity.update(b"\0");
        identity.update(origin.client_id.as_str());
        let mut bytes: [u8; 16] = identity.finalize()[..16].try_into().expect("digest prefix");
        bytes[6] = (bytes[6] & 0x0f) | 0x80;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let actor_id = uuid::Uuid::from_bytes(bytes).to_string();
        let mut actor = Self::from_verified(
            Id::try_from(actor_id.as_str())?,
            Id::try_from(format!("lan:{actor_id}").as_str())?,
            self.grant_revision,
            false,
        );
        actor.mcp_observer_source = origin.mcp;
        actor.forwarded = Some(ForwardedActor {
            pairing: ActorReference {
                actor_id: self.id.clone(),
                client_id: self.client_id.clone(),
            },
            source_client_id: origin.client_id.clone(),
        });
        Ok(actor)
    }

    pub(super) fn grant_owner(&self) -> (&Id, &Id) {
        match &self.forwarded {
            Some(origin) => (&origin.pairing.client_id, &origin.pairing.actor_id),
            None => (&self.client_id, &self.id),
        }
    }
    pub(crate) fn local_lan_origin(&self) -> HostResult<LanOrigin> {
        if self.user_control || self.task.is_some() || self.forwarded.is_some() {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "LAN routing requires a local client identity",
            ));
        }
        Ok(LanOrigin {
            actor_id: self.id.clone(),
            client_id: self.client_id.clone(),
            mcp: self.mcp_observer_source,
        })
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
    /// 附着类型只用于标注活动来源。授权仍以认证身份与当前 grant 为准。
    pub(crate) fn observe_as_mcp(&mut self) {
        self.mcp_observer_source = !self.user_control;
    }
    pub(crate) fn mcp_client_id(&self) -> Option<&Id> {
        (self.mcp_observer_source && self.task.is_none()).then(|| {
            self.forwarded
                .as_ref()
                .map_or(&self.client_id, |origin| &origin.source_client_id)
        })
    }
    pub(crate) fn persistent_reference(&self) -> Option<ActorReference> {
        (!self.user_control && self.task.is_none() && self.forwarded.is_none()).then(|| {
            ActorReference {
                actor_id: self.id.clone(),
                client_id: self.client_id.clone(),
            }
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
