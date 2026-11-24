//! 管理动作复用真实任务责任；安装与来源写入分别限流，最终提交串行验权。
use super::{
    NodePackageInstaller, NodePackageLimits, NodePackageSource, NodePackageSources,
    VerifiedNodePackageSource, failure, verify_node_package,
};
use crate::{
    auth::{AuthService, AuthenticatedActor, GrantStamp},
    dispatch::AcceptedCall,
    files::FileService,
    storage::{Settlement, Store},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::{
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use tokio::sync::{Semaphore, watch};

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;

mod activation;
#[path = "recovery.rs"]
mod recovery;

#[derive(Clone)]
pub(crate) struct NodePackageManager {
    store: Store,
    auth: AuthService,
    files: FileService,
    capacity: Arc<Semaphore>,
    control_capacity: Arc<Semaphore>,
    read_capacity: Arc<Semaphore>,
    stop: watch::Sender<bool>,
    source_changes: watch::Sender<U64>,
    package_changes: watch::Sender<U64>,
    active_recovery: watch::Sender<Option<NodePackageId>>,
    work_admission: Arc<Mutex<()>>,
    activation_requests: Arc<Mutex<activation::ActivationQueue>>,
    activation_changes: watch::Sender<()>,
    runtime: super::runtime::PackageRuntime,
    effect_gate: Arc<Mutex<()>>,
}

#[derive(Clone)]
enum NodeMutation {
    Install(NodePackageInstallParams),
    ConfirmExecution(NodePackageIdentityParams),
    RevokeExecution(NodePackageIdentityParams),
    Uninstall(NodePackageIdentityParams),
    SetEnabled(NodePackageSetEnabledParams),
    ApproveSource(NodeSourceApproveParams),
    RevokeSource(NodeSourceRevokeParams),
}
impl NodeMutation {
    fn decode(call: &Call) -> HostResult<Self> {
        let value =
            serde_json::to_value(&call.params).map_err(|_| super::invalid("managementParams"))?;
        match BuiltinAction::find(call.action_id.as_str())? {
            BuiltinAction::NodePackagesInstall => serde_json::from_value(value).map(Self::Install),
            BuiltinAction::NodePackageConfirmExecutionTrust => {
                serde_json::from_value(value).map(Self::ConfirmExecution)
            }
            BuiltinAction::NodePackageRevokeExecutionTrust => {
                serde_json::from_value(value).map(Self::RevokeExecution)
            }
            BuiltinAction::NodePackageUninstall => {
                serde_json::from_value(value).map(Self::Uninstall)
            }
            BuiltinAction::NodePackageSetEnabled => {
                serde_json::from_value(value).map(Self::SetEnabled)
            }
            BuiltinAction::NodeSourceApproveKey => {
                serde_json::from_value(value).map(Self::ApproveSource)
            }
            BuiltinAction::NodeSourceRevokeKey => {
                serde_json::from_value(value).map(Self::RevokeSource)
            }
            _ => return Err(super::invalid("managementAction")),
        }
        .map_err(|_| super::invalid("managementParams"))
    }
}

#[derive(Clone)]
struct ManagementAuthority {
    manager: NodePackageManager,
    actor: AuthenticatedActor,
    call: Call,
    operation_id: Id,
    mutation: NodeMutation,
    stamp: Option<GrantStamp>,
    dispatched: Arc<AtomicBool>,
    verified_source: Arc<Mutex<Option<VerifiedNodePackageSource>>>,
    control_cancel: Arc<AtomicBool>,
    committed: Arc<Mutex<Option<ActionResult>>>,
}
// 按取得顺序的逆序释放：授权提交先结束，再开放管理来源/安装效果。
struct ManagementCommitGuard<'a> {
    _authorization: MutexGuard<'a, ()>,
    _effects: MutexGuard<'a, ()>,
}
impl ManagementAuthority {
    fn check(&self) -> HostResult<()> {
        if *self.manager.stop.borrow() {
            return Err(failure("HOST_CLOSING", "installationStopping"));
        }
        let identity = self.manager.store.identity()?;
        if identity.host_id != self.call.host_id
            || identity.instance_epoch != self.call.instance_epoch
        {
            return Err(failure("EPOCH_MISMATCH", "installationEpoch"));
        }
        if let Some(stamp) = &self.stamp {
            self.manager.auth.validate_grants(stamp)?;
        }
        match &self.mutation {
            NodeMutation::Install(params) => {
                self.manager
                    .authorize(&self.actor, &self.call.target, params)?;
            }
            NodeMutation::SetEnabled(_) | NodeMutation::Uninstall(_) => {
                self.manager
                    .auth
                    .require(&self.actor, "plugins.manage", &self.call.target)?
            }
            _ => {
                self.manager.auth.require_control(&self.actor)?;
                self.manager
                    .auth
                    .require(&self.actor, "auth.manage", &self.call.target)?;
            }
        }
        let source = self
            .verified_source
            .lock()
            .map_err(|_| failure("STORAGE_UNAVAILABLE", "installationSourcePin"))?
            .clone();
        if let Some(source) = source {
            NodePackageSources::new(self.manager.store.clone()).require_current(&source)?;
        }
        match self.manager.store.operation_state(&self.operation_id)? {
            OperationState::Queued | OperationState::Running => Ok(()),
            OperationState::CancelRequested | OperationState::Cancelled => {
                Err(failure("CANCELLED", "installationCancelled"))
            }
            _ => Err(failure("OPERATION_INTERRUPTED", "installationOwnerEnded")),
        }
    }
    fn pin_source(
        &self,
        source: Option<VerifiedNodePackageSource>,
        control: &MutationControl<'_>,
    ) -> HostResult<()> {
        *self
            .verified_source
            .lock()
            .map_err(|_| failure("STORAGE_UNAVAILABLE", "installationSourcePin"))? = source;
        // 通知可能早于证明发布；立即复核，后续唤醒按实际公钥身份停止旧代次。
        self.check()?;
        control.check()
    }
}
struct MutationControl<'a> {
    cancel: &'a AtomicBool,
    expired: &'a AtomicBool,
    deadline: Instant,
}
impl MutationControl<'_> {
    fn check(&self) -> HostResult<()> {
        if self.expired.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            return Err(failure("LIMIT_EXCEEDED", "managementDeadline"));
        }
        if self.cancel.load(Ordering::Acquire) {
            return Err(failure("CANCELLED", "managementCancelled"));
        }
        Ok(())
    }
    fn remaining(&self) -> NodePackageLimits {
        NodePackageLimits {
            timeout: self.deadline.saturating_duration_since(Instant::now()),
            ..NodePackageLimits::default()
        }
    }
}
struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

impl NodePackageManager {
    pub(crate) fn registered_transports(
        &self,
    ) -> HostResult<Vec<crate::node_backend::RegisteredTransport>> {
        self.runtime.registered_transports()
    }

    pub(crate) fn recover_installations(
        &self,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<()> {
        NodePackageInstaller::new(self.store.clone(), self.store.profile())?
            .recover_uninstalls(limits, cancel)
    }

    pub(crate) fn provision_bundled_packages(
        &self,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<()> {
        let installer = NodePackageInstaller::new(self.store.clone(), self.store.profile())?;
        let mut first_error = None;
        for bundle in super::product::packages() {
            if let Err(error) = installer.provision_bundled_package(bundle, limits, cancel) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    #[cfg(test)]
    pub(crate) fn hold_installation_for_test(&self) -> tokio::sync::OwnedSemaphorePermit {
        self.capacity
            .clone()
            .try_acquire_owned()
            .expect("Native installation slot is occupied")
    }
    pub(crate) fn new(
        store: Store,
        auth: AuthService,
        files: FileService,
        catalog: Arc<crate::registry::RuntimeCatalog>,
        #[cfg(test)] gates: crate::node_test_gates::NodeTestGates,
    ) -> Self {
        Self {
            store,
            auth,
            files,
            capacity: Arc::new(Semaphore::new(1)),
            control_capacity: Arc::new(Semaphore::new(1)),
            read_capacity: Arc::new(Semaphore::new(2)),
            stop: watch::channel(false).0,
            source_changes: watch::channel(0.into()).0,
            package_changes: watch::channel(0.into()).0,
            active_recovery: watch::channel(None).0,
            work_admission: Arc::new(Mutex::new(())),
            activation_requests: Arc::default(),
            activation_changes: watch::channel(()).0,
            runtime: super::runtime::PackageRuntime::new(
                catalog,
                #[cfg(test)]
                gates,
            ),
            effect_gate: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) fn request_quiesce(&self, cancel: bool) {
        self.runtime.request_quiesce();
        self.close_activation_requests(failure("HOST_CLOSING", "activationStopping"));
        if cancel {
            self.stop.send_replace(true);
        }
    }
    pub(crate) fn provide_runtime(
        &self,
        node: crate::node_runtime::VerifiedNodeRuntime,
    ) -> HostResult<()> {
        self.runtime.provide(node)
    }
    pub(crate) async fn shutdown_runtime(&self) -> HostResult<()> {
        self.runtime.shutdown().await
    }
    pub(crate) fn runtime_status(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: NodePackageRuntimeParams,
    ) -> HostResult<NodePackageRuntimeStatus> {
        self.auth.require(actor, "metadata.read", target)?;
        let stamp = self.auth.capture_grants(actor)?;
        let _permit = self
            .read_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure("HOST_BUSY", "packageReadCapacity"))?;
        if !NodePackageInstaller::read_snapshot(&self.store)?
            .packages
            .iter()
            .any(|package| package.manifest.id == params.id)
        {
            return Err(failure("NOT_FOUND", "packageNotInstalled"));
        }
        let status = self.runtime.status(&params.id)?;
        if let Some(stamp) = stamp {
            self.auth.validate_grants(&stamp)?;
        }
        self.auth.require(actor, "metadata.read", target)?;
        Ok(status)
    }
    pub(crate) fn metrics(&self) -> Option<NodeMetrics> {
        self.runtime.metrics()
    }

    pub(crate) fn list(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: NodePackageListParams,
    ) -> HostResult<NodePackageListResult> {
        self.auth.require(actor, "metadata.read", target)?;
        let stamp = self.auth.capture_grants(actor)?;
        if params.page_size.get() == 0
            || params.page_size.get() > 100
            || (params.after.is_some() && params.expected_revision.is_none())
        {
            return Err(super::invalid("packagePage"));
        }
        // 名额由实际读取/序列化持有，取消异步等待不会提前放回。
        let _permit = self
            .read_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure("HOST_BUSY", "packageReadCapacity"))?;
        let snapshot = NodePackageInstaller::read_snapshot(&self.store)?;
        if params
            .expected_revision
            .is_some_and(|revision| revision != snapshot.revision)
        {
            return Err(failure("REVISION_CONFLICT", "packageSnapshotChanged"));
        }
        let start = match params.after {
            Some(after) => {
                snapshot
                    .packages
                    .iter()
                    .position(|package| package.manifest.id == after)
                    .ok_or_else(|| super::invalid("packagePageCursor"))?
                    + 1
            }
            None => 0,
        };
        let total = snapshot.packages.len();
        let packages: Vec<NodePackageSummary> = snapshot
            .packages
            .into_iter()
            .skip(start)
            .take(params.page_size.get() as usize)
            .map(Into::into)
            .collect();
        let next_after = (start + packages.len() < total)
            .then(|| packages.last().expect("nonempty package page").id.clone());
        if let Some(stamp) = stamp {
            self.auth.validate_grants(&stamp)?;
        }
        self.auth.require(actor, "metadata.read", target)?;
        Ok(NodePackageListResult {
            revision: snapshot.revision,
            packages,
            next_after,
        })
    }

    pub(crate) fn details_read(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: NodePackageDetailsReadParams,
    ) -> HostResult<NodePackageDetailsReadResult> {
        self.auth.require(actor, "metadata.read", target)?;
        let stamp = self.auth.capture_grants(actor)?;
        if params.length.get() == 0 || params.length.get() > 32768 {
            return Err(super::invalid("packageDetailLength"));
        }
        let _permit = self
            .read_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure("HOST_BUSY", "packageReadCapacity"))?;
        let snapshot = NodePackageInstaller::read_snapshot(&self.store)?;
        if snapshot.revision != params.expected_revision {
            return Err(failure("REVISION_CONFLICT", "packageSnapshotChanged"));
        }
        let package = snapshot
            .packages
            .into_iter()
            .find(|package| package.manifest.id == params.id)
            .ok_or_else(|| failure("NOT_FOUND", "packageNotInstalled"))?;
        if package.archive_sha256 != params.archive_sha256 {
            return Err(failure("INTEGRITY_FAILED", "installationArchiveChanged"));
        }
        let bytes = serde_json::to_vec(&NodePackageInstallation::from(package))
            .map_err(|_| super::invalid("packageDetails"))?;
        if params.offset.get() > bytes.len() as u64 {
            return Err(super::invalid("packageDetailOffset"));
        }
        let start = params.offset.get() as usize;
        let end = (start + params.length.get() as usize).min(bytes.len());
        let result = NodePackageDetailsReadResult {
            revision: snapshot.revision,
            id: params.id,
            archive_sha256: params.archive_sha256,
            json_sha256: Digest::try_from(format!("{:x}", Sha256::digest(&bytes)).as_str())?,
            offset: params.offset,
            total_bytes: (bytes.len() as u64).into(),
            bytes_base64: Bytes::try_from(STANDARD.encode(&bytes[start..end]).as_str())?,
        };
        if let Some(stamp) = stamp {
            self.auth.validate_grants(&stamp)?;
        }
        self.auth.require(actor, "metadata.read", target)?;
        Ok(result)
    }

    /// 原请求读取回执只复核当前权限，不重新要求安装输入或来源仍可执行。
    pub(crate) fn authorize_inspection(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: &NodePackageInstallParams,
    ) -> HostResult<()> {
        self.auth.require(actor, "plugins.manage", target)?;
        self.files
            .require_inspection_reference(&params.archive_ref, actor, "content.read")
    }

    pub(crate) fn authorize(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: &NodePackageInstallParams,
    ) -> HostResult<()> {
        self.authorize_inspection(actor, target, params)?;
        if self.files.read_file_length(&params.archive_ref, actor)?
            > NodePackageLimits::default().max_archive_bytes
        {
            return Err(failure("LIMIT_EXCEEDED", "archiveBytes"));
        }
        if let NodePackageInstallSource::Trusted { source, key_id } = &params.source {
            let snapshot = NodePackageSources::new(self.store.clone()).snapshot()?;
            if !snapshot
                .keys
                .iter()
                .any(|k| k.approved && &k.source == source && &k.key_id == key_id)
            {
                return Err(failure("PERMISSION_DENIED", "sourceKeyNotApproved"));
            }
        }
        Ok(())
    }

    pub(crate) fn sources_list(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        params: NodeSourceListParams,
    ) -> HostResult<NodeSourceListResult> {
        self.auth.require(actor, "metadata.read", target)?;
        let stamp = self.auth.capture_grants(actor)?;
        if params.page_size.get() == 0
            || params.page_size.get() > 100
            || (params.offset.get() != 0 && params.expected_revision.is_none())
        {
            return Err(super::invalid("sourcePage"));
        }
        let _permit = self
            .read_capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| failure("HOST_BUSY", "packageReadCapacity"))?;
        let snapshot = NodePackageSources::new(self.store.clone()).snapshot()?;
        if params
            .expected_revision
            .is_some_and(|revision| revision != snapshot.revision)
        {
            return Err(failure("REVISION_CONFLICT", "sourceTrustRevision"));
        }
        let start =
            usize::try_from(params.offset.get()).map_err(|_| super::invalid("sourcePageOffset"))?;
        let total = snapshot.keys.len();
        if start > total {
            return Err(super::invalid("sourcePageOffset"));
        }
        let keys: Vec<_> = snapshot
            .keys
            .into_iter()
            .skip(start)
            .take(params.page_size.get() as usize)
            .collect();
        let next = start + keys.len();
        if let Some(stamp) = stamp {
            self.auth.validate_grants(&stamp)?;
        }
        self.auth.require(actor, "metadata.read", target)?;
        Ok(NodeSourceListResult {
            revision: snapshot.revision,
            keys,
            next_offset: (next < total).then_some((next as u64).into()),
        })
    }

    pub(crate) async fn execute(
        &self,
        accepted: &AcceptedCall,
        stamp: Option<GrantStamp>,
    ) -> HostResult<Settlement> {
        let mutation = NodeMutation::decode(&accepted.call)?;
        let capacity = if matches!(
            mutation,
            NodeMutation::Install(_)
                | NodeMutation::ConfirmExecution(_)
                | NodeMutation::RevokeExecution(_)
                | NodeMutation::Uninstall(_)
                | NodeMutation::SetEnabled(_)
        ) {
            &self.capacity
        } else {
            &self.control_capacity
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let authority = ManagementAuthority {
            manager: self.clone(),
            actor: accepted.actor.clone(),
            call: accepted.call.clone(),
            operation_id: accepted.operation.operation_id.clone(),
            mutation,
            stamp,
            dispatched: Arc::new(AtomicBool::new(false)),
            verified_source: Arc::new(Mutex::new(None)),
            control_cancel: cancel.clone(),
            committed: Arc::new(Mutex::new(None)),
        };
        let expired = Arc::new(AtomicBool::new(false));
        let _cancel_on_drop = CancelOnDrop(cancel.clone());
        let mut operations = self.store.subscribe_operation_changes();
        let mut grants = self.auth.subscribe_changes();
        let mut stop = self.stop.subscribe();
        let mut source_changes = self.source_changes.subscribe();
        let budget = NodePackageLimits::default().timeout;
        let deadline = Instant::now() + budget;
        let timer = tokio::time::sleep(budget);
        tokio::pin!(timer);
        let mut recovery = self.active_recovery.subscribe();
        let permit = loop {
            let current = authority.clone();
            tokio::task::spawn_blocking(move || current.check())
                .await
                .map_err(|_| failure("HOST_BUSY", "managementWaiter"))??;
            let (permit, recovering) = {
                let _admission = self
                    .work_admission
                    .lock()
                    .map_err(|_| failure("HOST_BUSY", "managementAdmission"))?;
                (
                    capacity.clone().try_acquire_owned().ok(),
                    recovery.borrow_and_update().clone(),
                )
            };
            if let Some(permit) = permit {
                break permit;
            }
            let waits_for_recovery = match (&authority.mutation, recovering) {
                (NodeMutation::Install(_), Some(_)) => true,
                (NodeMutation::SetEnabled(params), Some(id)) => params.enabled && params.id == id,
                _ => false,
            };
            if !waits_for_recovery {
                return Err(failure("HOST_BUSY", "installationCapacity"));
            }
            #[cfg(test)]
            self.runtime.waiting_for_recovery().await?;
            // 后台恢复归还名额后才继续。等待沿用原预算，不接管恢复生命周期。
            tokio::select! {
                _ = recovery.changed() => {},
                _ = operations.changed() => {},
                _ = grants.changed() => {},
                _ = stop.changed() => {},
                _ = source_changes.changed() => {},
                _ = self.auth.wait_grant_expiry(authority.stamp.as_ref()) => {},
                _ = &mut timer => {return Err(failure("LIMIT_EXCEEDED","installationDeadline"));},
            }
        };
        let work_authority = authority.clone();
        let work_cancel = cancel.clone();
        let work_expired = expired.clone();
        let mut work = tokio::task::spawn_blocking(move || {
            // 取消等待或异步 owner 结束都不提前释放实际工作持有的名额。
            let _permit = permit;
            let result = work_authority.manager.run_mutation(
                &work_authority,
                &work_cancel,
                &work_expired,
                deadline,
            );
            // 所有阶段统一保留停止原因；撤权/关停不能伪装成需要 CancelRequested 的用户取消。
            result.map_err(|error| {
                if error.code != "CANCELLED" {
                    return error;
                }
                if work_expired.load(Ordering::Acquire) {
                    return failure("LIMIT_EXCEEDED", "installationDeadline");
                }
                work_authority
                    .check()
                    .err()
                    .unwrap_or_else(|| failure("OPERATION_INTERRUPTED", "installationWaiterEnded"))
            })
        });
        let result = loop {
            tokio::select! {
                result = &mut work => break result,
                _ = &mut timer => {
                    expired.store(true, Ordering::Release);
                    cancel.store(true, Ordering::Release);
                    break work.await;
                }
                _ = operations.changed() => {},
                _ = grants.changed() => {},
                _ = stop.changed() => {},
                _ = source_changes.changed() => {},
                _ = self.auth.wait_grant_expiry(authority.stamp.as_ref()) => {},
            }
            let current = authority.clone();
            let allowed = tokio::task::spawn_blocking(move || current.check()).await;
            if !matches!(allowed, Ok(Ok(()))) {
                cancel.store(true, Ordering::Release);
                break work.await;
            }
        };
        Ok(match result {
            Ok(Ok(result)) => Settlement {
                state: OperationState::Succeeded,
                result: Some(result),
                error: None,
            },
            Ok(Err(error)) => Settlement {
                state: match error.code.as_str() {
                    "NODE_OWNER_EXIT_UNCONFIRMED" | "NODE_PACKAGE_OPERATION_UNKNOWN" => {
                        OperationState::Unknown
                    }
                    "CANCELLED" => OperationState::Cancelled,
                    _ if !authority.dispatched.load(Ordering::Acquire) => {
                        OperationState::Interrupted
                    }
                    "PERMISSION_DENIED"
                    | "EPOCH_MISMATCH"
                    | "HOST_CLOSING"
                    | "NODE_BACKEND_INTERRUPTED"
                    | "OPERATION_INTERRUPTED" => OperationState::Interrupted,
                    _ => OperationState::Failed,
                },
                result: authority
                    .committed
                    .lock()
                    .ok()
                    .and_then(|receipt| receipt.clone()),
                error: Some(error),
            },
            Err(_) => Settlement {
                state: if authority.dispatched.load(Ordering::Acquire) {
                    OperationState::Unknown
                } else {
                    OperationState::Interrupted
                },
                result: authority
                    .committed
                    .lock()
                    .ok()
                    .and_then(|receipt| receipt.clone()),
                error: Some(failure(
                    "NODE_PACKAGE_OPERATION_UNKNOWN",
                    "installationOwnerFailed",
                )),
            },
        })
    }

    fn run_mutation(
        &self,
        authority: &ManagementAuthority,
        cancel: &AtomicBool,
        expired: &AtomicBool,
        deadline: Instant,
    ) -> HostResult<ActionResult> {
        let control = MutationControl {
            cancel,
            expired,
            deadline,
        };
        authority.check()?;
        control.check()?;
        if !matches!(
            authority.mutation,
            NodeMutation::ApproveSource(_) | NodeMutation::RevokeSource(_)
        ) {
            self.recover_installations(&control.remaining(), cancel)?;
            authority.check()?;
            control.check()?;
        }
        self.store
            .mark_dispatch(&authority.operation_id)
            .map_err(|error| authority.check().err().unwrap_or(error))?;
        // 单向记录真实登记事实；尚未开始的过期/异常不能结算为 Queued 不接受的终态。
        authority.dispatched.store(true, Ordering::Release);
        match &authority.mutation {
            NodeMutation::Install(params) => self
                .install(authority, params, &control)
                .map(|result| ActionResult::NodePackageInstalled(Box::new(result))),
            NodeMutation::ConfirmExecution(params) => self
                .confirm_execution_trust(authority, params, &control)
                .map(|result| ActionResult::NodePackageChanged(Box::new(result))),
            NodeMutation::SetEnabled(params) => self
                .set_execution_state(authority, params, &control)
                .map(|result| ActionResult::NodePackageChanged(Box::new(result))),
            NodeMutation::RevokeExecution(params) => self
                .set_execution_state(
                    authority,
                    &NodePackageSetEnabledParams {
                        id: params.id.clone(),
                        archive_sha256: params.archive_sha256.clone(),
                        enabled: false,
                    },
                    &control,
                )
                .map(|result| ActionResult::NodePackageChanged(Box::new(result))),
            NodeMutation::Uninstall(params) => self
                .uninstall(authority, params, &control)
                .map(|result| ActionResult::NodePackageUninstalled(Box::new(result))),
            _ => self
                .change_source(authority, &control)
                .map(|result| ActionResult::NodeSourceChanged(Box::new(result))),
        }
    }

    fn commit_guard<'a>(
        &'a self,
        authority: &ManagementAuthority,
        control: &MutationControl<'_>,
    ) -> HostResult<ManagementCommitGuard<'a>> {
        loop {
            control.check()?;
            authority.check()?;
            match self.effect_gate.try_lock() {
                Ok(guard) => {
                    control.check()?;
                    authority.check()?;
                    if let Some(authorization) = self.auth.try_commit_authorized(|| {
                        control.check()?;
                        authority.check()?;
                        Ok(())
                    })? {
                        return Ok(ManagementCommitGuard {
                            _authorization: authorization,
                            _effects: guard,
                        });
                    }
                    // 不占管理门等待其他文档提交，重试仍消耗原控制预算。
                    drop(guard);
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(TryLockError::Poisoned(_)) => {
                    return Err(failure("STORAGE_UNAVAILABLE", "managementCommitGate"));
                }
                Err(TryLockError::WouldBlock) => {
                    std::thread::sleep(std::time::Duration::from_millis(1))
                }
            }
        }
    }

    fn change_source(
        &self,
        authority: &ManagementAuthority,
        control: &MutationControl<'_>,
    ) -> HostResult<NodeSourceChangeResult> {
        let sources = NodePackageSources::new(self.store.clone());
        let expected = authority
            .call
            .expected_revision
            .ok_or_else(|| super::invalid("expectedRevisionRequired"))?;
        let check = || self.commit_guard(authority, control);
        let (snapshot, key) = match &authority.mutation {
            NodeMutation::ApproveSource(params) => {
                if format!("{:x}", Sha256::digest(params.public_key))
                    != params.public_key_sha256.as_str()
                {
                    return Err(failure("INTEGRITY_FAILED", "sourceKeyFingerprint"));
                }
                let key = NodePackageSourceKey {
                    source: params.source.clone(),
                    key_id: params.key_id.clone(),
                    public_key: params.public_key,
                    public_key_sha256: params.public_key_sha256.clone(),
                    approved: true,
                };
                let snapshot = sources.approve_key_authorized(
                    params.source.clone(),
                    params.key_id.clone(),
                    params.public_key,
                    expected,
                    check,
                )?;
                (snapshot, key)
            }
            NodeMutation::RevokeSource(params) => {
                let before = sources.snapshot()?;
                if before.revision != expected {
                    return Err(failure("REVISION_CONFLICT", "sourceTrustRevision"));
                }
                let mut key = before
                    .keys
                    .into_iter()
                    .find(|key| {
                        key.source == params.source && key.key_id == params.key_id && key.approved
                    })
                    .ok_or_else(|| failure("NOT_FOUND", "sourceKeyNotApproved"))?;
                if key.public_key_sha256 != params.public_key_sha256 {
                    return Err(failure("INTEGRITY_FAILED", "sourceKeyChanged"));
                }
                key.approved = false;
                let snapshot = sources.revoke_key_authorized(
                    &params.source,
                    &params.key_id,
                    expected,
                    check,
                )?;
                (snapshot, key)
            }
            _ => return Err(super::invalid("sourceMutation")),
        };
        // 已提交认可变化即唤醒安装 owner；安装最终效果也持有同一门锁核对当前来源。
        self.source_changes.send_replace(snapshot.revision);
        Ok(NodeSourceChangeResult {
            revision: snapshot.revision,
            key,
        })
    }

    fn install(
        &self,
        authority: &ManagementAuthority,
        params: &NodePackageInstallParams,
        control: &MutationControl<'_>,
    ) -> HostResult<NodePackageChangeResult> {
        let limits = NodePackageLimits::default();
        let mut file =
            self.files
                .open_fixed_checked(&params.archive_ref, &authority.actor, || control.check())?;
        control.check()?;
        if file.len() > limits.max_archive_bytes {
            return Err(failure("LIMIT_EXCEEDED", "archiveBytes"));
        }
        let mut bytes = Vec::with_capacity(
            usize::try_from(file.len()).map_err(|_| super::limit("archiveBytes"))?,
        );
        while (bytes.len() as u64) < file.len() {
            control.check()?;
            let length = (file.len() - bytes.len() as u64)
                .min(crate::files::FixedFile::MAX_CHUNK_BYTES as u64)
                as usize;
            bytes.extend(file.read_chunk(bytes.len() as u64, length)?);
        }
        control.check()?;
        let sources = NodePackageSources::new(self.store.clone());
        let package = match &params.source {
            NodePackageInstallSource::Local => verify_node_package(
                bytes,
                NodePackageSource::Local,
                &control.remaining(),
                control.cancel,
            ),
            NodePackageInstallSource::Trusted { source, key_id } => {
                sources.verify(bytes, source, key_id, &control.remaining(), control.cancel)
            }
        }?;
        authority.pin_source(package.verified_source().cloned(), control)?;
        let package_id = package.manifest().id.clone();
        let installer = NodePackageInstaller::new(self.store.clone(), self.store.profile())?;
        let mut last_progress: Option<Instant> = None;
        let mut actual_progress = None;
        let outcome = installer.install_authorized(
            package,
            authority
                .call
                .expected_revision
                .ok_or_else(|| super::invalid("expectedRevisionRequired"))?,
            &control.remaining(),
            control.cancel,
            super::install::InstallLifecycle {
                authorize: || self.commit_guard(authority, control),
                before_commit: || self.settle_before_upgrade(authority, control, &package_id),
                product_marker: None,
                product_upgrade: None,
            },
            |completed, total| {
                let progress = Progress {
                    completed: completed.into(),
                    total: Some(total.into()),
                    unit: "files".into(),
                };
                // 文件已真实同步；先保存事实，再判断还能否继续工作/交付。
                actual_progress = Some(progress.clone());
                control.check()?;
                if completed == 0
                    || completed == total
                    || last_progress
                        .is_none_or(|last| last.elapsed() >= std::time::Duration::from_millis(50))
                {
                    authority.check()?;
                    self.store
                        .record_progress(&authority.operation_id, &progress)?;
                    last_progress = Some(Instant::now());
                }
                Ok(())
            },
        );
        if outcome.is_err()
            && let Some(progress) = actual_progress
        {
            // 撤权/取消不抹去已完成事实；外部读取仍按当前授权过滤。
            // 保存失败必须显式失败，不能拿旧进度证明提前停工。
            self.store
                .record_progress(&authority.operation_id, &progress)?;
        }
        let receipt = outcome?;
        self.runtime.committed_upgrade(&receipt.package);
        self.package_changes.send_replace(receipt.revision);
        // CAS 已提交时保留成功与实际收据，不被晚到取消改写成未安装。
        Ok(NodePackageChangeResult {
            revision: receipt.revision,
            package: receipt.package.into(),
        })
    }

    fn settle_before_upgrade(
        &self,
        authority: &ManagementAuthority,
        control: &MutationControl<'_>,
        id: &NodePackageId,
    ) -> HostResult<()> {
        control.check()?;
        authority.check()?;
        let snapshot = NodePackageInstaller::read_snapshot(&self.store)?;
        if Some(snapshot.revision) != authority.call.expected_revision {
            return Err(failure("REVISION_CONFLICT", "installationRevision"));
        }
        if let Some(package) = snapshot
            .packages
            .into_iter()
            .find(|package| &package.manifest.id == id)
        {
            let params = NodePackageSetEnabledParams {
                id: id.clone(),
                archive_sha256: package.archive_sha256,
                enabled: false,
            };
            let check = || {
                control.check()?;
                authority.check()
            };
            self.runtime
                .deactivate(id, self.execution_lease(authority, &params, true)?, &check)?;
            #[cfg(test)]
            self.runtime.upgrade_before_commit();
        }
        Ok(())
    }

    fn confirm_execution_trust(
        &self,
        authority: &ManagementAuthority,
        params: &NodePackageIdentityParams,
        control: &MutationControl<'_>,
    ) -> HostResult<NodePackageChangeResult> {
        let expected = authority
            .call
            .expected_revision
            .ok_or_else(|| super::invalid("expectedRevisionRequired"))?;
        let snapshot = NodePackageInstaller::read_snapshot(&self.store)?;
        if snapshot.revision != expected {
            return Err(failure("REVISION_CONFLICT", "installationRevision"));
        }
        let selected = snapshot
            .packages
            .into_iter()
            .find(|package| package.manifest.id == params.id)
            .ok_or_else(|| failure("NOT_FOUND", "packageNotInstalled"))?;
        if selected.archive_sha256 != params.archive_sha256 {
            return Err(failure("INTEGRITY_FAILED", "installationArchiveChanged"));
        }
        authority.pin_source(selected.verified_source, control)?;
        let installer = NodePackageInstaller::new(self.store.clone(), self.store.profile())?;
        let proof = installer.verify_installed(
            &params.id,
            expected,
            &params.archive_sha256,
            &control.remaining(),
            control.cancel,
        )?;
        let mut confirmed = proof.package().clone();
        confirmed.execution_trust = Some(NodeExecutionTrust {
            archive_sha256: confirmed.archive_sha256.clone(),
            permissions: confirmed.manifest.permissions.clone(),
            verified_source: confirmed.verified_source.clone(),
        });
        let committed = installer.confirm_execution_trust_authorized(
            &params.id,
            expected,
            &params.archive_sha256,
            || self.commit_guard(authority, control),
        )?;
        self.package_changes.send_replace(committed.revision);
        // Windows 的实际内容证明保持到CAS完成；确认本身不导入代码或启动Node。
        drop(proof);
        Ok(NodePackageChangeResult {
            revision: committed.revision,
            package: confirmed.into(),
        })
    }

    fn execution_lease(
        &self,
        authority: &ManagementAuthority,
        params: &NodePackageSetEnabledParams,
        cleanup: bool,
    ) -> HostResult<super::runtime::ExecutionLease> {
        super::runtime::ExecutionLease::new(super::runtime::LeaseRequest {
            store: self.store.clone(),
            auth: self.auth.clone(),
            authority: super::runtime::LeaseAuthority::User {
                actor: Box::new(authority.actor.clone()),
                target: authority.call.target.clone(),
                cleanup,
            },
            id: params.id.clone(),
            archive: params.archive_sha256.clone(),
            stopping: self.runtime.stop_signal(),
            initial: Some((
                authority.operation_id.clone(),
                authority.control_cancel.clone(),
            )),
            packages: self.package_changes.subscribe(),
            sources: self.source_changes.subscribe(),
        })
    }
    fn set_execution_state(
        &self,
        authority: &ManagementAuthority,
        params: &NodePackageSetEnabledParams,
        control: &MutationControl<'_>,
    ) -> HostResult<NodePackageChangeResult> {
        let expected = authority
            .call
            .expected_revision
            .ok_or_else(|| super::invalid("expectedRevisionRequired"))?;
        let snapshot = NodePackageInstaller::read_snapshot(&self.store)?;
        if snapshot.revision != expected {
            return Err(failure("REVISION_CONFLICT", "installationRevision"));
        }
        let selected = snapshot
            .packages
            .into_iter()
            .find(|package| package.manifest.id == params.id)
            .ok_or_else(|| failure("NOT_FOUND", "packageNotInstalled"))?;
        if selected.archive_sha256 != params.archive_sha256 {
            return Err(failure("INTEGRITY_FAILED", "installationArchiveChanged"));
        }
        let installer = NodePackageInstaller::new(self.store.clone(), self.store.profile())?;
        let proof = if params.enabled {
            if selected.manifest.runtime_ref != bundled_node_runtime_release().id {
                return Err(failure("NODE_RUNTIME_INCOMPATIBLE", "packageRuntime"));
            }
            authority.pin_source(selected.verified_source.clone(), control)?;
            Some(installer.verify_installed(
                &params.id,
                expected,
                &params.archive_sha256,
                &control.remaining(),
                control.cancel,
            )?)
        } else {
            None
        };
        let check = || {
            control.check()?;
            authority.check()
        };
        let stop_error = if !params.enabled {
            self.runtime
                .deactivate(
                    &params.id,
                    self.execution_lease(authority, params, true)?,
                    &check,
                )
                .err()
        } else {
            None
        };
        // 未确认退出不能被稍后的取消/撤权覆盖，也不能提交已经安全停用的假事实。
        if let Some(error) = &stop_error
            && (error.code == "NODE_OWNER_EXIT_UNCONFIRMED"
                || self.runtime.has_active_owner(&params.id)?)
        {
            // 发送前失败可恢复真实Active；不能把仍运行的owner提交成已安全停用/撤信任。
            return Err(error.clone());
        }
        #[cfg(test)]
        if !params.enabled {
            self.runtime.disable_before_commit();
        }
        let committed = if matches!(authority.mutation, NodeMutation::RevokeExecution(_)) {
            // 撤执行确认同样先承担实际停止责任；当前来源失效不能阻止撤销旧确认。
            installer.revoke_execution_trust_authorized(
                &params.id,
                expected,
                &params.archive_sha256,
                || self.commit_guard(authority, control),
            )?
        } else {
            installer.set_enabled_authorized(
                &params.id,
                params.enabled,
                expected,
                &params.archive_sha256,
                authority.actor.persistent_reference().map(|actor| {
                    super::install::ActivationAuthority {
                        actor,
                        instance_epoch: authority.call.instance_epoch,
                    }
                }),
                || self.commit_guard(authority, control),
            )?
        };
        #[cfg(test)]
        if !params.enabled {
            self.runtime.disable_after_commit();
        }
        // 已提交的人工意图取代旧升级提示；启用失败仍须显式重试，不新建自动登记资格。
        self.runtime.clear_pending_registration(&params.id);
        let package = committed
            .packages
            .iter()
            .find(|package| package.manifest.id == params.id)
            .ok_or_else(|| failure("STORAGE_UNAVAILABLE", "committedPackage"))?;
        let result = NodePackageChangeResult {
            revision: committed.revision,
            package: package.clone().into(),
        };
        *authority
            .committed
            .lock()
            .map_err(|_| failure("STORAGE_UNAVAILABLE", "managementReceipt"))? =
            Some(ActionResult::NodePackageChanged(Box::new(result.clone())));
        self.package_changes.send_replace(committed.revision);
        if let Some(error) = stop_error {
            return Err(error);
        }
        if let Some(proof) = proof {
            let proof = proof.bind_enabled(package, committed.revision)?;
            self.runtime.activate(
                proof,
                self.execution_lease(authority, params, false)?,
                control.deadline,
                control.cancel,
                &check,
            )?;
        }
        Ok(result)
    }

    fn uninstall(
        &self,
        authority: &ManagementAuthority,
        params: &NodePackageIdentityParams,
        control: &MutationControl<'_>,
    ) -> HostResult<NodePackageUninstallResult> {
        let expected = authority
            .call
            .expected_revision
            .ok_or_else(|| super::invalid("expectedRevisionRequired"))?;
        let snapshot = NodePackageInstaller::read_snapshot(&self.store)?;
        if snapshot.revision != expected {
            return Err(failure("REVISION_CONFLICT", "installationRevision"));
        }
        let selected = snapshot
            .packages
            .into_iter()
            .find(|package| package.manifest.id == params.id)
            .ok_or_else(|| failure("NOT_FOUND", "packageNotInstalled"))?;
        if selected.archive_sha256 != params.archive_sha256 {
            return Err(failure("INTEGRITY_FAILED", "installationArchiveChanged"));
        }
        let check = || {
            control.check()?;
            authority.check()
        };
        self.runtime.prepare_uninstall(&selected, &check)?;
        let stop = NodePackageSetEnabledParams {
            id: params.id.clone(),
            archive_sha256: params.archive_sha256.clone(),
            enabled: false,
        };
        let stop_error = self
            .runtime
            .deactivate(
                &params.id,
                self.execution_lease(authority, &stop, true)?,
                &check,
            )
            .err();
        if let Some(error) = &stop_error
            && (error.code == "NODE_OWNER_EXIT_UNCONFIRMED"
                || self.runtime.has_active_owner(&params.id)?)
        {
            return Err(error.clone());
        }
        // JS模块缓存仍可能引用已经dispose的对象；精确证明未释放时不动文件或CAS。
        if self.runtime.holds_installation(&selected, &check)? {
            return Err(failure("HOST_BUSY", "installationCodeStillLoaded"));
        }
        check()?;
        let installer = NodePackageInstaller::new(self.store.clone(), self.store.profile())?;
        let result = installer.uninstall_authorized(
            params,
            expected,
            &control.remaining(),
            control.cancel,
            || self.commit_guard(authority, control),
            |result| {
                *authority
                    .committed
                    .lock()
                    .map_err(|_| failure("STORAGE_UNAVAILABLE", "managementReceipt"))? = Some(
                    ActionResult::NodePackageUninstalled(Box::new(result.clone())),
                );
                self.runtime.clear_pending_registration(&params.id);
                self.package_changes.send_replace(result.revision);
                Ok(())
            },
        )?;
        if let Some(error) = stop_error {
            return Err(error);
        }
        Ok(result)
    }
}
