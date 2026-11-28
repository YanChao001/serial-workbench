//! 派生调用保留原身份，只在现有授权链叠加父任务与插件范围。
use serial_workbench_core::*;
use std::{fmt, sync::Arc};

pub(crate) struct TaskAuthority {
    pub admission: Option<ChildCall>,
    pub owner_instance: Id,
    pub execution_mode: ExecutionMode,
    pub scope: Target,
    pub opened_session: Option<Target>,
    pub bound_transfer_source: Option<Target>,
    pub host_api: Vec<NodeHostApiScope>,
    pub inherited: Option<Arc<TaskAuthority>>,
    pub admission_queued: Arc<std::sync::atomic::AtomicBool>,
    pub check: Arc<dyn Fn() -> HostResult<()> + Send + Sync>,
}
impl fmt::Debug for TaskAuthority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TaskAuthority")
            .field(
                "parent",
                &self
                    .admission
                    .as_ref()
                    .map(|call| &call.parent_operation_id),
            )
            .field(
                "child_key",
                &self.admission.as_ref().map(|call| call.child_key),
            )
            .finish_non_exhaustive()
    }
}
impl TaskAuthority {
    pub(crate) fn child(&self) -> HostResult<&ChildCall> {
        self.admission.as_ref().ok_or_else(|| {
            HostError::new(
                "PERMISSION_DENIED",
                "Task read context cannot admit an action",
            )
        })
    }
    pub(super) fn require(&self, permission: &str, target: &Target) -> HostResult<()> {
        (self.check)()?;
        if let Some(parent) = &self.inherited {
            parent.require(permission, target)?;
        }
        // A signed sequence can delegate an already authorized file only to its
        // specific file-transfer child. Queries and other child actions have no such source.
        if permission == "content.read" && self.bound_transfer_source.as_ref() == Some(target) {
            return Ok(());
        }
        self.check_target_scope(target)?;
        if !self.host_api.iter().any(|scope| {
            scope.permissions.iter().any(|value| value == permission)
                && scope.target_kinds.contains(&target.kind)
        }) {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Child exceeds its task scope",
            ));
        }
        Ok(())
    }
    pub(crate) fn check_target(&self, target: &Target) -> HostResult<()> {
        // 空权限贡献仍受全部父资源范围约束，不能借内层Host范围扩大外层范围。
        (self.check)()?;
        if let Some(parent) = &self.inherited {
            parent.check_target(target)?;
        }
        self.check_target_scope(target)
    }
    fn check_target_scope(&self, target: &Target) -> HostResult<()> {
        if self.scope.host_id != target.host_id
            || (self.scope.kind.as_str() != "host"
                && self.scope != *target
                && self.opened_session.as_ref() != Some(target))
        {
            Err(HostError::new(
                "PERMISSION_DENIED",
                "Child exceeds its task scope",
            ))
        } else {
            Ok(())
        }
    }
    pub(super) fn opened_device(&self, target: &Target) -> Option<&Target> {
        (self.opened_session.as_ref() == Some(target)).then_some(&self.scope)
    }

    pub(crate) fn normalized(&self, call: &Call) -> HostResult<ChildCall> {
        let source = self.child()?;
        if call.actor_id != source.actor_id
            || call.host_id != source.host_id
            || call.instance_epoch != source.instance_epoch
            || call.action_id != source.action_id
            || call.target != source.target
            || call.expected_revision != source.expected_revision
            || call.lease_id != source.lease_id
            || call.execution_mode != Some(self.execution_mode)
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Child invocation identity changed",
            ));
        }
        let mut normalized = source.clone();
        normalized.params = call.params.clone();
        normalized.reveal_target = call.reveal_target.clone();
        Ok(normalized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn target(kind: &str, name: &str) -> Target {
        Target {
            host_id: Id::try_from("scope-host").unwrap(),
            kind: ResourceKind::try_from(kind).unwrap(),
            id: Id::try_from(name).unwrap(),
            session_id: None,
            session_epoch: None,
        }
    }
    fn authority(
        scope: Target,
        inherited: Option<Arc<TaskAuthority>>,
        alive: Arc<AtomicBool>,
    ) -> Arc<TaskAuthority> {
        Arc::new(TaskAuthority {
            admission: None,
            owner_instance: Id::try_from("owner").unwrap(),
            execution_mode: ExecutionMode::Independent,
            scope,
            opened_session: None,
            bound_transfer_source: None,
            host_api: Vec::new(),
            inherited,
            admission_queued: Arc::default(),
            check: Arc::new(move || {
                if alive.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(HostError::new(
                        "OPERATION_NOT_RUNNING",
                        "Parent has stopped",
                    ))
                }
            }),
        })
    }
    #[test]
    fn device_task_can_use_only_its_confirmed_opened_epoch() {
        let device = target("device", "startup-device");
        let mut opened = target("session", "startup-session");
        opened.session_id = Some(opened.id.clone());
        opened.session_epoch = Some(2.into());
        let mut authority = authority(device.clone(), None, Arc::new(AtomicBool::new(true)));
        assert_eq!(
            authority.check_target(&opened).unwrap_err().code,
            "PERMISSION_DENIED"
        );
        Arc::get_mut(&mut authority).unwrap().opened_session = Some(opened.clone());
        authority.check_target(&device).unwrap();
        authority.check_target(&opened).unwrap();
        assert_eq!(
            authority
                .require("metadata.read", &opened)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        let mut next = opened;
        next.session_epoch = Some(3.into());
        assert_eq!(
            authority.check_target(&next).unwrap_err().code,
            "PERMISSION_DENIED"
        );
        assert_eq!(
            authority
                .check_target(&target("device", "other-device"))
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
    }

    #[test]
    fn empty_permission_target_check_preserves_ancestor_scope_and_currentness() {
        let workspace_a = target("workspace", "a");
        let workspace_b = target("workspace", "b");
        let ancestor_alive = Arc::new(AtomicBool::new(true));
        let ancestor = authority(workspace_a.clone(), None, ancestor_alive.clone());
        let inner = authority(
            target("host", "scope-host"),
            Some(ancestor),
            Arc::new(AtomicBool::new(true)),
        );
        inner.check_target(&workspace_a).unwrap();
        assert_eq!(
            inner.check_target(&workspace_b).unwrap_err().code,
            "PERMISSION_DENIED"
        );
        let foreign = Target {
            host_id: Id::try_from("other-host").unwrap(),
            ..workspace_a.clone()
        };
        assert_eq!(
            inner.check_target(&foreign).unwrap_err().code,
            "PERMISSION_DENIED"
        );
        // 目标检查不授予API权限，即使目标在范围内也不能读取未声明的元数据。
        assert_eq!(
            inner
                .require("metadata.read", &workspace_a)
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        ancestor_alive.store(false, Ordering::Release);
        assert_eq!(
            inner.check_target(&workspace_a).unwrap_err().code,
            "OPERATION_NOT_RUNNING"
        );
    }
}
