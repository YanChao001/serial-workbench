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
            // 命令库修订属于工作区元数据，预览中出现的命令正文来自用户提供的文件。
            let command_revision = if configuration.groups.is_empty() {
                None
            } else {
                Some(store.command_library_revision(target.id.clone())?)
            };

            let package_target = configuration_package_target(&target.host_id);
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
            Ok(WorkspaceConfigurationInspection {
                configuration,
                workspace_revision: workspace.revision,
                command_revision,
                script_statuses,
            })
        })
        .await
    }

    pub(super) async fn workspace_startup_plan(
        &self,
        actor: &AuthenticatedActor,
        query: Query,
    ) -> HostResult<WorkspaceStartupPlan> {
        let WorkspaceStartupPlanParams { workspace_revision } = decode(&query.params)?;
        let target = query.target;
        let scope = crate::documents::DocumentService::reference(&target)?;
        let auth = self.inner.auth.clone();
        let actor = actor.clone();
        let service = WorkspaceService::new(self.inner.store.clone(), target.id.clone());
        let packages = self.inner.node_packages.clone();

        blocking(move || {
            let stamp = auth.capture_grants(&actor)?;
            auth.require(&actor, "metadata.read", &target)?;
            current_workspace(&service, workspace_revision)?;
            let (_, references) = service.configuration_references()?;
            let statuses = packages.workspace_script_availability(
                &actor,
                &configuration_package_target(&target.host_id),
                &references.scripts,
            )?;
            current_workspace(&service, workspace_revision)?;
            let authorization = auth.snapshot(&actor)?;
            if let Some(stamp) = stamp {
                authorization.validate_grants(&stamp)?;
            }
            authorization.require("metadata.read", &target)?;
            let scripts = references
                .scripts
                .into_iter()
                .zip(statuses)
                .map(
                    |(reference, (status, target_kinds))| WorkspaceStartupScript {
                        reference,
                        status,
                        target_kinds,
                    },
                )
                .collect();
            Ok(WorkspaceStartupPlan {
                scope,
                workspace_revision,
                scripts,
            })
        })
        .await
    }

    pub(super) fn check_workspace_startup(
        &self,
        actor: &AuthenticatedActor,
        call: &Call,
    ) -> HostResult<()> {
        let Some(selection) = &call.workspace_startup else {
            return Ok(());
        };
        if actor.task().is_some() || selection.reference.action_id != call.action_id {
            return Err(invalid());
        }
        let target = Target {
            host_id: call.host_id.clone(),
            kind: ResourceKind::try_from("workspace")?,
            id: selection.workspace_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        self.inner.auth.require(actor, "metadata.read", &target)?;
        let service = WorkspaceService::new(self.inner.store.clone(), target.id);
        current_workspace(&service, selection.workspace_revision)?;
        let (_, references) = service.configuration_references()?;
        if !references.scripts.contains(&selection.reference)
            || self.inner.node_packages.workspace_script_statuses(
                actor,
                &configuration_package_target(&call.host_id),
                std::slice::from_ref(&selection.reference),
            )? != [WorkspaceScriptStatus::Matched]
        {
            return Err(startup_dependency_unavailable());
        }
        current_workspace(&service, selection.workspace_revision)?;
        Ok(())
    }

    pub(super) async fn export_workspace_configuration(
        &self,
        actor: &AuthenticatedActor,
        query: Query,
    ) -> HostResult<DocumentJsonResult> {
        let params: WorkspaceConfigurationExportParams = decode(&query.params)?;
        params.validate()?;
        let target = query.target;
        let auth = self.inner.auth.clone();
        let actor = actor.clone();
        let store = self.inner.store.clone();
        let packages = self.inner.node_packages.clone();
        blocking(move || {
            let stamp = auth.capture_grants(&actor)?;
            auth.require(&actor, "metadata.read", &target)?;
            let service = WorkspaceService::new(store.clone(), target.id.clone());
            let snapshot = current_workspace(&service, params.workspace_revision)?;
            let (_, references) = service.configuration_references()?;
            let scripts = if let Some(scripts) = params.scripts {
                let package_target = configuration_package_target(&target.host_id);
                let status =
                    packages.workspace_script_statuses(&actor, &package_target, &scripts)?;
                if status
                    .iter()
                    .any(|entry| *entry != WorkspaceScriptStatus::Matched)
                {
                    return Err(HostError::new(
                        "WORKSPACE_DEPENDENCY_UNAVAILABLE",
                        "A selected workspace script is not available",
                    ));
                }
                scripts
            } else {
                references.scripts
            };
            let includes_commands = params.command_revision.is_some();
            let (groups, commands) = match params.command_revision {
                Some(revision) => {
                    auth.require(&actor, "content.read", &target)?;
                    store.configuration_commands(target.id.clone(), revision, params.command_ids)?
                }
                None => (Vec::new(), Vec::new()),
            };
            let mut workspace = snapshot.value;
            workspace.captures.clear();
            let configuration = WorkspaceConfiguration {
                format: WORKSPACE_CONFIGURATION_FORMAT.into(),
                version: WORKSPACE_CONFIGURATION_VERSION,
                workspace,
                groups,
                commands,
                scripts,
                credential_refs: references.credentials,
            };
            let json = configuration.to_json()?;
            // 配置引用与工作区同事务写入，确保导出没有跨修订混用。
            current_workspace(&service, params.workspace_revision)?;
            let authorization = auth.snapshot(&actor)?;
            if let Some(stamp) = stamp {
                authorization.validate_grants(&stamp)?;
            }
            authorization.require("metadata.read", &target)?;
            if includes_commands {
                authorization.require("content.read", &target)?;
            }
            Ok(DocumentJsonResult { json })
        })
        .await
    }
}

pub(super) fn startup_dependency_unavailable() -> HostError {
    HostError::new(
        "WORKSPACE_DEPENDENCY_UNAVAILABLE",
        "The selected workspace script is no longer available",
    )
}

fn configuration_package_target(host_id: &Id) -> Target {
    Target {
        host_id: host_id.clone(),
        kind: ResourceKind::try_from("host").expect("host"),
        id: host_id.clone(),
        session_id: None,
        session_epoch: None,
    }
}

fn current_workspace(service: &WorkspaceService, expected: U64) -> HostResult<WorkspaceSnapshot> {
    let snapshot = service.snapshot()?;
    if snapshot.value.archived {
        return Err(HostError::new("WORKSPACE_DELETED", "Workspace was removed"));
    }
    if snapshot.revision != expected {
        return Err(HostError::new(
            "REVISION_CONFLICT",
            "Workspace revision changed",
        ));
    }
    Ok(snapshot)
}
