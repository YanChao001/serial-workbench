//! 实验包使用现有领域读权，不从导入文件派生访问权限。
use super::*;

fn missing_dependency() -> HostError {
    HostError::new("NOT_FOUND", "An experiment dependency is not available")
}

fn package_target(host_id: &Id) -> Target {
    Target {
        host_id: host_id.clone(),
        kind: ResourceKind::try_from("host").expect("static kind"),
        id: host_id.clone(),
        session_id: None,
        session_epoch: None,
    }
}

impl Host {
    pub(super) async fn experiment_export(
        &self,
        actor: &AuthenticatedActor,
        mut query: Query,
    ) -> HostResult<ExperimentPackage> {
        let params: ExperimentExportParams = decode(&query.params)?;
        let target = query.target.clone();
        query.action_id = id("workspace.read");
        query.params.clear();
        let (workspace, stamp) = {
            let docs = self.inner.documents.clone();
            let auth = self.inner.auth.clone();
            let actor = actor.clone();
            blocking(move || {
                let stamp = auth.capture_grants(&actor)?;
                let QueryResult::Workspace(value) =
                    docs.query(&actor, &query, BuiltinAction::WorkspaceRead)?
                else {
                    return Err(invalid());
                };
                if value.document.revision != params.workspace_revision {
                    return Err(HostError::new(
                        "REVISION_CONFLICT",
                        "Workspace revision changed",
                    ));
                }
                Ok((value.document.value, stamp))
            })
            .await?
        };
        params.validate(workspace.bindings.len())?;

        let parsers = if params.parsers.is_empty() {
            Vec::new()
        } else {
            let entries = self.experiment_packages(actor, &target.host_id).await?;
            params
                .parsers
                .into_iter()
                .map(|id| {
                    let entry = entries
                        .iter()
                        .find(|entry| entry.id == id)
                        .ok_or_else(missing_dependency)?;
                    let version = entry.version.clone().ok_or_else(missing_dependency)?;
                    Ok(ExperimentParser {
                        id,
                        version,
                        archive_sha256: entry.archive_sha256.clone(),
                    })
                })
                .collect::<HostResult<Vec<_>>>()?
        };

        let mut runs = Vec::with_capacity(params.operations.len());
        for operation_id in params.operations {
            let (operation, _) = self
                .inspect_operation(
                    actor,
                    &target,
                    OperationGetParams::ById {
                        operation_id,
                        request_context: None,
                    },
                    false,
                )
                .await?;
            let settled_at = operation
                .settled_at
                .filter(|_| operation.state.is_terminal())
                .ok_or_else(|| {
                    HostError::new("OPERATION_NOT_SETTLED", "Experiment run is still active")
                })?;
            runs.push(ExperimentRun {
                action_id: operation.action_id,
                state: operation.state,
                settled_at,
            });
        }

        let files = self.inner.files.clone();
        let auth = self.inner.auth.clone();
        let actor = actor.clone();
        blocking(move || {
            let recordings = params
                .recordings
                .iter()
                .map(|reference| experiment_recording(&files, &actor, reference))
                .collect::<HostResult<Vec<_>>>()?;
            let package = ExperimentPackage {
                format_version: EXPERIMENT_VERSION.into(),
                workspace: portable_experiment_workspace(workspace)?,
                parsers,
                recordings,
                firmware: params.firmware,
                runs,
            };
            package.validate()?;
            package.check_size()?;
            if let Some(stamp) = &stamp {
                auth.validate_grants(stamp)?;
            }
            auth.require(&actor, "metadata.read", &target)?;
            Ok(package)
        })
        .await
    }

    pub(super) async fn experiment_inspect(
        &self,
        actor: &AuthenticatedActor,
        query: Query,
    ) -> HostResult<ExperimentInspection> {
        let params: DocumentImportParams = decode(&query.params)?;
        let target = query.target;
        let (experiment, stamp) = {
            let auth = self.inner.auth.clone();
            let actor = actor.clone();
            blocking(move || {
                let stamp = auth.capture_grants(&actor)?;
                let package = ExperimentPackage::parse(&params.json)?;
                package.check_size()?;
                Ok((package, stamp))
            })
            .await?
        };
        let parser_status = if experiment.parsers.is_empty() {
            Vec::new()
        } else {
            match self.experiment_packages(actor, &target.host_id).await {
                Ok(entries) => experiment
                    .parsers
                    .iter()
                    .map(|required| parser_status(required, &entries))
                    .collect(),
                Err(error) if error.code == "PERMISSION_DENIED" => {
                    vec![ExperimentDependency::Unavailable; experiment.parsers.len()]
                }
                Err(error) => return Err(error),
            }
        };

        let auth = self.inner.auth.clone();
        let files = self.inner.files.clone();
        let actor = actor.clone();
        blocking(move || {
            let recording_status = experiment
                .recordings
                .iter()
                .map(|required| {
                    if required.reference.host_id != target.host_id {
                        return Ok(ExperimentDependency::OtherHost);
                    }
                    Ok(
                        match experiment_recording(&files, &actor, &required.reference) {
                            Ok(actual) if &actual == required => ExperimentDependency::Matched,
                            Ok(_) => ExperimentDependency::Changed,
                            Err(error) if error.code == "NOT_FOUND" => {
                                ExperimentDependency::Missing
                            }
                            Err(error) if error.code == "PERMISSION_DENIED" => {
                                ExperimentDependency::Unavailable
                            }
                            Err(error)
                                if matches!(
                                    error.code.as_str(),
                                    "SOURCE_CHANGED" | "REVISION_CONFLICT"
                                ) =>
                            {
                                ExperimentDependency::Changed
                            }
                            Err(error) => return Err(error),
                        },
                    )
                })
                .collect::<HostResult<Vec<_>>>()?;
            if let Some(stamp) = &stamp {
                auth.validate_grants(stamp)?;
            }
            auth.require(&actor, "metadata.read", &target)?;
            Ok(ExperimentInspection {
                experiment,
                parser_status,
                recording_status,
            })
        })
        .await
    }

    async fn experiment_packages(
        &self,
        actor: &AuthenticatedActor,
        host_id: &Id,
    ) -> HostResult<Vec<NodePackageSummary>> {
        let target = package_target(host_id);
        let manager = self.inner.node_packages.clone();
        let actor = actor.clone();
        blocking(move || {
            let mut params = NodePackageListParams {
                page_size: 50.into(),
                after: None,
                expected_revision: None,
            };
            let mut entries = Vec::new();
            loop {
                let result = manager.list(&actor, &target, params)?;
                entries.extend(result.packages);
                let Some(after) = result.next_after else {
                    return Ok(entries);
                };
                params = NodePackageListParams {
                    page_size: 50.into(),
                    after: Some(after),
                    expected_revision: Some(result.revision),
                };
            }
        })
        .await
    }
}

fn parser_status(
    required: &ExperimentParser,
    entries: &[NodePackageSummary],
) -> ExperimentDependency {
    let Some(entry) = entries.iter().find(|entry| entry.id == required.id) else {
        return ExperimentDependency::Missing;
    };
    if entry.version.as_deref() != Some(required.version.as_str())
        || entry.archive_sha256 != required.archive_sha256
    {
        return ExperimentDependency::Changed;
    }
    if entry.enabled && entry.execution_approved {
        ExperimentDependency::Matched
    } else {
        ExperimentDependency::Unavailable
    }
}

fn experiment_recording(
    files: &crate::files::FileService,
    actor: &AuthenticatedActor,
    reference: &ObjectRef,
) -> HostResult<ExperimentRecording> {
    let metadata = files.recording_metadata(reference, actor)?;
    Ok(ExperimentRecording {
        reference: metadata.file_ref,
        fingerprint: metadata.fingerprint,
    })
}
