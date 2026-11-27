//! 会话配置包预览只检查输入及当前修订，不创建工作区、授予权限或运行依赖。
use super::*;
use crate::workspace::WorkspaceService;

impl Host {
    pub(super) async fn inspect_workspace_configuration(
        &self,
        actor: &AuthenticatedActor,
        query: Query,
    ) -> HostResult<WorkspaceConfigurationInspection> {
        let params: DocumentImportParams = decode(&query.params)?;
        let target = query.target;
        let auth = self.inner.auth.clone();
        let actor = actor.clone();
        let store = self.inner.store.clone();
        let packages = self.inner.node_packages.clone();
        blocking(move || {
            let stamp = auth.capture_grants(&actor)?;
            auth.require(&actor, "metadata.read", &target)?;
            let configuration = WorkspaceConfiguration::parse(&params.json)?;
            let workspace = WorkspaceService::new(store.clone(), target.id.clone()).snapshot()?;
            if workspace.value.archived {
                return Err(HostError::new("WORKSPACE_DELETED", "Workspace was removed"));
            }
            let read_commands = !configuration.groups.is_empty();
            let command_revision = if read_commands {
                auth.require(&actor, "content.read", &target)?;
                Some(store.command_library_revision(target.id.clone())?)
            } else {
                None
            };

            let package_target = Target {
                host_id: target.host_id.clone(),
                kind: ResourceKind::try_from("host").expect("host"),
                id: target.host_id.clone(),
                session_id: None,
                session_epoch: None,
            };
            let script_statuses = packages.workspace_script_statuses(
                &actor,
                &package_target,
                &configuration.scripts,
            )?;

            let authorization = auth.snapshot(&actor)?;
            if let Some(stamp) = stamp {
                authorization.validate_grants(&stamp)?;
            }
            authorization.require("metadata.read", &target)?;
            if read_commands {
                authorization.require("content.read", &target)?;
            }
            Ok(WorkspaceConfigurationInspection {
                configuration,
                workspace_revision: workspace.revision,
                command_revision,
                script_statuses,
            })
        })
        .await
    }
}
