use super::*;
use crate::{
    auth::AuthService,
    device::sessions::ReservedToolPort,
    node_packages::{
        NodePackageInstaller, NodePackageLimits, NodePackageSources, VerifiedExternalTool,
        VerifiedNodePackageSource,
    },
    storage::Store,
};
use std::time::Instant;

#[derive(Clone)]
struct ToolAuthority {
    store: Store,
    auth: AuthService,
    actor: AuthenticatedActor,
    target: Target,
    instance_epoch: U64,
    params: ToolHandoffParams,
}

impl ToolAuthority {
    fn require_current(
        &self,
        expected_source: Option<&VerifiedNodePackageSource>,
        at_launch: bool,
    ) -> HostResult<VerifiedNodePackageSource> {
        self.auth.require_control(&self.actor)?;
        self.auth
            .require(&self.actor, "auth.manage", &self.target)?;
        let identity = self.store.identity()?;
        if identity.host_id != self.target.host_id || identity.instance_epoch != self.instance_epoch
        {
            return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
        }
        let snapshot = NodePackageInstaller::read_snapshot(&self.store)?;
        if at_launch && snapshot.revision != self.params.expected_install_revision {
            return Err(HostError::new(
                "REVISION_CONFLICT",
                "The approved tool installation changed before launch",
            ));
        }
        let package = snapshot
            .packages
            .into_iter()
            .find(|package| package.manifest.id == self.params.package_id)
            .filter(|package| {
                package.enabled && package.archive_sha256 == self.params.archive_sha256
            })
            .ok_or_else(tool_permission_denied)?;
        let approved = package.execution_trust.as_ref().is_some_and(|trust| {
            trust.archive_sha256 == package.archive_sha256
                && trust.permissions == package.manifest.permissions
                && trust.verified_source == package.verified_source
                && trust
                    .permissions
                    .external_tools
                    .contains(&self.params.tool_id)
        });
        let source = package
            .verified_source
            .filter(|source| approved && expected_source.is_none_or(|expected| expected == source))
            .ok_or_else(tool_permission_denied)?;
        NodePackageSources::new(self.store.clone()).require_current(&source)?;
        Ok(source)
    }
}

struct PreparedTool {
    authority: ToolAuthority,
    tool: VerifiedExternalTool,
    source: VerifiedNodePackageSource,
    handoff: ReservedToolPort,
    deadline: Instant,
}

impl TransmissionService {
    async fn prepare_tool(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
    ) -> HostResult<PreparedTool> {
        let params: ToolHandoffParams = decode(&accepted.call.params)?;
        let deadline = Instant::now()
            .checked_add(Duration::from_millis(params.timeout_ms.get()))
            .ok_or_else(invalid)?;
        let authority = ToolAuthority {
            store: self.devices.inner.store.clone(),
            auth: self.devices.inner.auth.clone(),
            actor: accepted.actor.clone(),
            target: accepted.call.target.clone(),
            instance_epoch: accepted.call.instance_epoch,
            params,
        };
        let grant = authority.clone();
        let cancel = token.cancelled.clone();
        let (tool, source) = blocking(move || {
            let source = grant.require_current(None, true)?;
            let installer = NodePackageInstaller::new(grant.store.clone(), grant.store.profile())?;
            let mut limits = NodePackageLimits::default();
            limits.timeout = limits
                .timeout
                .min(deadline.saturating_duration_since(Instant::now()));
            let tool = installer.verify_external_tool(
                &grant.params.package_id,
                grant.params.expected_install_revision,
                &grant.params.archive_sha256,
                &grant.params.tool_id,
                &limits,
                &cancel,
            )?;
            if !tool.path().is_absolute() {
                return Err(HostError::new(
                    "INTEGRITY_FAILED",
                    "The verified tool is outside the resolved installation context",
                ));
            }
            Ok((tool, source))
        })
        .await?;
        let handoff = self
            .devices
            .reserve_native_tool(&accepted.actor, &accepted.call.target)
            .await?;
        tool.check_locator(handoff.initial_locator())?;
        if Instant::now() >= deadline {
            return Err(tool_deadline());
        }
        Ok(PreparedTool {
            authority,
            tool,
            source,
            handoff,
            deadline,
        })
    }

    fn acquire_handoff_gate(&self, token: &ControlToken, runtime: &Runtime) -> HostResult<()> {
        // 关闭门禁和新接纳共享 token 锁，门禁可见后不会接纳新的常规设备动作。
        let _tokens = self.tokens.lock().map_err(|_| invalid())?;
        if token.cancelled.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        runtime
            .closing
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| HostError::new("HOST_BUSY", "Session is already closing"))?;
        token.holds_tool_gate.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn release_handoff_gate(token: &ControlToken, runtime: &Runtime) {
        token.holds_tool_gate.store(false, Ordering::SeqCst);
        Self::release_close_gate(runtime);
    }

    pub(super) async fn tool_handoff(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Session,
        runtime: &Runtime,
    ) -> HostResult<Completion> {
        let mut prepared = self.prepare_tool(accepted, token).await?;
        self.acquire_handoff_gate(token, runtime)?;
        if let Err(error) = self.dispatch(accepted, token, session).await {
            Self::release_handoff_gate(token, runtime);
            return Err(error);
        }

        // 一旦发布 Closing，必须等待 owner 真实结算，工具期限不能丢弃关停动作。
        if let Err(error) = self.close_owner(accepted, session).await {
            let still_open = session
                .snapshot()
                .is_ok_and(|snapshot| snapshot.state == SessionState::Open);
            if still_open {
                Self::release_handoff_gate(token, runtime);
            }
            let unknown = !still_open && !session.cleanup_confirmed().unwrap_or(false);
            return Ok(tool_completion(None, None, unknown, Some(error)));
        }
        let stop = if token.cancelled.load(Ordering::SeqCst) {
            Some(cancelled())
        } else if Instant::now() >= prepared.deadline {
            Some(tool_deadline())
        } else {
            None
        };
        if let Some(error) = stop {
            return Ok(self
                .finish_tool_handoff(accepted, &prepared.handoff, None, Some(error))
                .await);
        }
        let locator = match self
            .devices
            .begin_native_tool(
                &accepted.actor,
                &accepted.call.target,
                &mut prepared.handoff,
            )
            .await
        {
            Ok(locator) => locator,
            Err(error) => return Ok(tool_completion(None, None, false, Some(error))),
        };

        let authority = prepared.authority.clone();
        let source = prepared.source.clone();
        let operation_id = accepted.operation.operation_id.clone();
        let cancel = token.cancelled.clone();
        let work = blocking(move || {
            // 该执行者同时持有实际设备预约与已验证的文件，取消等待不放弃持有责任。
            let result = prepared
                .authority
                .require_current(Some(&prepared.source), true)
                .and_then(|_| {
                    eprintln!(
                        "external_tool_dispatch operation={} tool={} bytes={} sha256={}",
                        operation_id.as_str(),
                        prepared.authority.params.tool_id.as_str(),
                        prepared.tool.size().get(),
                        prepared.tool.sha256().as_str(),
                    );
                    prepared.tool.run(&locator, prepared.deadline, &cancel)
                });
            if !result
                .as_ref()
                .is_err_and(|error| error.code == "TOOL_EXIT_UNCONFIRMED")
            {
                prepared.handoff.confirm_tool_exit();
            }
            Ok((prepared.handoff, result))
        });
        tokio::pin!(work);
        let mut checks = tokio::time::interval(Duration::from_millis(250));
        checks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut authorization_error = None;
        let outcome = loop {
            tokio::select! {
                result = &mut work => break result,
                _ = checks.tick(), if authorization_error.is_none()
                    && !token.cancelled.load(Ordering::SeqCst) => {
                    let authority = authority.clone();
                    let source = source.clone();
                    if let Err(error) = blocking(move || authority.require_current(Some(&source), false)).await {
                        authorization_error = Some(error);
                        token.cancel();
                    }
                }
            }
        };
        let (handoff, outcome) = match outcome {
            Ok(outcome) => outcome,
            Err(error) => return Ok(tool_completion(None, None, true, Some(error))),
        };
        let (code, error) = match outcome {
            Ok(0) => (Some(0), None),
            Ok(code) => (
                Some(code),
                Some(HostError::new(
                    "TOOL_FAILED",
                    "The external tool returned a nonzero exit code",
                )),
            ),
            Err(error) if error.code == "TOOL_EXIT_UNCONFIRMED" => {
                return Ok(tool_completion(None, None, true, Some(error)));
            }
            Err(error) if error.code == "CANCELLED" => {
                (None, Some(authorization_error.unwrap_or(error)))
            }
            Err(error) => (None, Some(error)),
        };
        Ok(self
            .finish_tool_handoff(accepted, &handoff, code, error)
            .await)
    }

    async fn finish_tool_handoff(
        &self,
        accepted: &AcceptedCall,
        handoff: &ReservedToolPort,
        code: Option<u32>,
        mut error: Option<HostError>,
    ) -> Completion {
        let reopened = if self.quiescing.load(Ordering::SeqCst) {
            Err(HostError::new(
                "HOST_CLOSING",
                "Host shutdown is in progress",
            ))
        } else {
            // 工具取消已终结。恢复原持有者仍由当前权限和 Host 的实际关停门禁约束。
            self.devices
                .return_native_tool(
                    &accepted.actor,
                    &accepted.call.target,
                    handoff,
                    self.quiescing.clone(),
                )
                .await
        };
        let reopened = match reopened {
            Ok(opened) => Some(opened),
            Err(failure) => {
                error.get_or_insert(failure);
                None
            }
        };
        tool_completion(code, reopened, false, error)
    }
}

fn tool_completion(
    exit_code: Option<u32>,
    reopened: Option<OpenResult>,
    ownership_unconfirmed: bool,
    error: Option<HostError>,
) -> Completion {
    let state = if ownership_unconfirmed {
        OperationState::Unknown
    } else if let Some(error) = &error {
        if error.code == "CANCELLED" {
            OperationState::Cancelled
        } else {
            OperationState::Failed
        }
    } else {
        OperationState::Succeeded
    };
    Completion {
        state,
        result: ActionResult::ToolHandoff(ToolHandoffResult {
            exit_code,
            reopened,
            ownership_unconfirmed,
        }),
        error,
    }
}

fn tool_permission_denied() -> HostError {
    HostError::new(
        "PERMISSION_DENIED",
        "The external tool no longer has current execution trust",
    )
}

fn tool_deadline() -> HostError {
    HostError::new(
        "LIMIT_EXCEEDED",
        "The external tool handoff reached its deadline",
    )
}
