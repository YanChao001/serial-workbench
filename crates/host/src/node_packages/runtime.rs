//! 产品运行 owner 与启用意图分离；缓存随所属服务通知失效，时限每次检查。
use super::{NodePackageInstaller, NodePackageSources, VerifiedNodeInstallation, failure};
use crate::{
    auth::{AuthService, AuthenticatedActor, AuthorizationSnapshot},
    node_backend::{NodeBackend, NodeBackendLimits},
    node_runtime::{
        NodeRuntimeLimits, VerifiedNodeRuntime, installed_node_resource_root, verify_node_runtime,
    },
    storage::Store,
};
use serial_workbench_core::*;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

#[derive(Clone)]
pub(super) struct PackageRuntime {
    owner: Arc<Mutex<Owner>>,
    pending_registrations: Arc<Mutex<std::collections::BTreeMap<String, Digest>>>,
    catalog: Arc<crate::registry::RuntimeCatalog>,
    stopping: Arc<AtomicBool>,
    metrics: Arc<Mutex<Option<crate::node_backend::NodeMetricsCache>>>,
    #[cfg(test)]
    gates: crate::node_test_gates::NodeTestGates,
}
struct Owner {
    pending: Option<VerifiedNodeRuntime>,
    root: Option<PathBuf>,
    backend: Option<NodeBackend>,
    generation: U64,
    active: BTreeSet<String>,
    recoverable: BTreeSet<String>,
    pending_exit: Option<ExitProjection>,
    unconfirmed_exit: Option<HostError>,
}
struct ExitProjection {
    error: Option<HostError>,
}
impl PackageRuntime {
    pub(super) fn new(
        catalog: Arc<crate::registry::RuntimeCatalog>,
        #[cfg(test)] gates: crate::node_test_gates::NodeTestGates,
    ) -> Self {
        let stopping = catalog.stop_signal();
        Self {
            owner: Arc::new(Mutex::new(Owner {
                pending: None,
                root: None,
                backend: None,
                generation: 0.into(),
                active: BTreeSet::new(),
                recoverable: BTreeSet::new(),
                pending_exit: None,
                unconfirmed_exit: None,
            })),
            pending_registrations: Arc::default(),
            catalog,
            stopping,
            metrics: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            gates,
        }
    }
    pub(super) fn provide(&self, runtime: VerifiedNodeRuntime) -> HostResult<()> {
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| failure("HOST_BUSY", "nodeOwner"))?;
        owner.root = Some(runtime.resource_root().to_path_buf());
        owner.pending = Some(runtime);
        Ok(())
    }
    pub(super) fn stop_signal(&self) -> Arc<AtomicBool> {
        self.stopping.clone()
    }
    pub(super) fn metrics(&self) -> Option<NodeMetrics> {
        // 只取独立观察指针，不等待register/dispose所持的长生命周期owner锁。
        let metrics = self.metrics.lock().ok()?.clone()?;
        metrics.snapshot()
    }
    pub(super) fn subscribe(&self) -> watch::Receiver<()> {
        self.catalog.subscribe()
    }
    pub(super) fn committed_upgrade(&self, package: &super::InstalledNodePackage) {
        let mut pending = self
            .pending_registrations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if package.enabled && package.activation_authority.is_some() {
            // CAS事实先于通知；仅记录所提交归档，不等待或执行Node工作。
            pending.insert(
                package.manifest.id.as_str().into(),
                package.archive_sha256.clone(),
            );
        } else {
            pending.remove(package.manifest.id.as_str());
        }
    }
    pub(super) fn clear_pending_registration(&self, id: &NodePackageId) {
        self.pending_registrations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id.as_str());
    }
    pub(super) fn can_recover(&self, package: &super::InstalledNodePackage) -> bool {
        self.owner.try_lock().is_ok_and(|owner| {
            owner.unconfirmed_exit.is_none()
                && (owner.recoverable.contains(package.manifest.id.as_str())
                    || self
                        .pending_registrations
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .get(package.manifest.id.as_str())
                        == Some(&package.archive_sha256))
        })
    }
    #[cfg(test)]
    pub(super) fn recovery_failed_scan(&self) {
        self.gates.recovery_failed_scan.arrive();
    }
    #[cfg(test)]
    pub(super) fn recovery_snapshot_busy(&self) {
        self.gates.recovery_snapshot_busy.arrive();
    }
    #[cfg(test)]
    pub(super) fn recovery_before_release(&self) {
        self.gates.recovery_before_release.arrive();
    }
    #[cfg(test)]
    pub(super) fn recovery_before_restore(&self) {
        self.gates.recovery_before_restore.arrive();
    }
    #[cfg(test)]
    pub(super) fn recovery_before_scan(&self) {
        assert!(
            !self
                .gates
                .fail_recovery_worker_once
                .swap(false, Ordering::AcqRel),
            "Native injected recovery worker panic"
        );
        self.gates.recovery_before_scan.arrive();
    }
    #[cfg(test)]
    pub(super) fn recovery_scan_completed(&self) {
        self.gates.recovery_scan_completed.arrive();
    }
    #[cfg(test)]
    pub(super) fn activation_request_joined(&self) {
        self.gates.activation_request_joined.arrive();
    }
    #[cfg(test)]
    pub(super) fn activation_before_enqueue(&self) {
        self.gates.activation_before_enqueue.arrive();
    }
    #[cfg(test)]
    pub(super) fn activation_request_enqueued(&self) {
        self.gates.activation_request_enqueued.arrive();
    }
    #[cfg(test)]
    pub(super) fn upgrade_before_commit(&self) {
        self.gates.upgrade_before_commit.arrive();
    }
    #[cfg(test)]
    pub(super) fn disable_before_commit(&self) {
        self.gates.disable_before_commit.arrive();
    }
    #[cfg(test)]
    pub(super) fn disable_after_commit(&self) {
        self.gates.disable_after_commit.arrive();
    }
    #[cfg(test)]
    pub(super) async fn waiting_for_recovery(&self) -> HostResult<()> {
        let gate = self.gates.waiting_for_recovery.clone();
        tokio::task::spawn_blocking(move || gate.arrive())
            .await
            .map_err(|_| failure("HOST_BUSY", "recoveryWaiterGate"))
    }
    pub(super) fn recovery_failed(
        &self,
        package: &super::InstalledNodePackage,
        error: HostError,
    ) -> HostResult<()> {
        let old = self.catalog.status(&package.manifest.id)?;
        #[cfg(test)]
        self.gates.recovery_failure_publish.arrive();
        if old.phase != NodePackageRuntimePhase::Active
            && (old.phase != NodePackageRuntimePhase::Failed
                || old.error.as_ref() != Some(&error)
                || old.archive_sha256.as_ref() != Some(&package.archive_sha256))
        {
            self.put(
                &package.manifest.id,
                Some(package.archive_sha256.clone()),
                old.generation,
                NodePackageRuntimePhase::Failed,
                Some(error),
            )?;
        }
        Ok(())
    }
    pub(super) fn request_quiesce(&self) {
        self.stopping.store(true, Ordering::Release);
        #[cfg(test)]
        self.gates.quiesce_signalled.arrive();
        let _ = self
            .catalog
            .transition(None, NodePackageRuntimePhase::Stopping, None);
    }
    fn lock<'a>(&'a self, check: &dyn Fn() -> HostResult<()>) -> HostResult<MutexGuard<'a, Owner>> {
        loop {
            check()?;
            match self.owner.try_lock() {
                Ok(owner) => {
                    if let Some(error) = &owner.unconfirmed_exit {
                        return Err(error.clone());
                    }
                    return Ok(owner);
                }
                Err(TryLockError::Poisoned(_)) => return Err(failure("HOST_BUSY", "nodeOwner")),
                Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
    }
    fn put(
        &self,
        id: &NodePackageId,
        archive: Option<Digest>,
        generation: U64,
        phase: NodePackageRuntimePhase,
        error: Option<HostError>,
    ) -> HostResult<()> {
        self.catalog.publish(
            NodePackageRuntimeStatus {
                id: id.clone(),
                phase,
                generation,
                archive_sha256: archive,
                error,
            },
            Vec::new(),
        )
    }
    fn ended(&self, owner: &mut Owner, error: Option<HostError>) -> HostResult<()> {
        let error = owner.unconfirmed_exit.clone().or(error);
        if error.is_some() {
            owner.recoverable.extend(owner.active.iter().cloned());
        }
        owner.active.clear();
        // 物理事实先归位；目录暂时不可提交时保留一项元数据，不重复回收进程。
        owner.pending_exit = Some(ExitProjection { error });
        self.publish_exit(owner)
    }
    fn publish_exit(&self, owner: &mut Owner) -> HostResult<()> {
        let Some(pending) = &owner.pending_exit else {
            return Ok(());
        };
        let error = pending.error.clone();
        let published = self.catalog.transition(
            None,
            if error.is_some() {
                NodePackageRuntimePhase::Failed
            } else {
                NodePackageRuntimePhase::Inactive
            },
            error,
        );
        #[cfg(test)]
        if let Err(error) = &published {
            eprintln!("native_node_exit_publish_failed code={}", error.code);
            self.gates.exit_publish_failed.arrive();
        }
        published?;
        owner.pending_exit = None;
        Ok(())
    }
    fn observe_exit(
        &self,
        owner: &mut Owner,
        report: &crate::node_backend::NodeBackendExit,
    ) -> HostResult<()> {
        if !report.reaped {
            let error = owner
                .unconfirmed_exit
                .get_or_insert_with(|| failure("NODE_OWNER_EXIT_UNCONFIRMED", "nodeOwnerNotReaped"))
                .clone();
            let _ = self.ended(owner, Some(error.clone()));
            return Err(error);
        }
        self.ended(owner, report.error.clone())
    }
    fn reconcile(&self, owner: &mut Owner) -> HostResult<()> {
        if let Some(error) = &owner.unconfirmed_exit {
            let error = error.clone();
            let _ = self.publish_exit(owner);
            return Err(error);
        }
        // 新代次准入前先提交旧代次终态，不能让晚投影覆盖后来启动的owner。
        self.publish_exit(owner)?;
        if owner.backend.as_ref().is_some_and(NodeBackend::is_finished) {
            let report = owner.backend.take().expect("finished backend").shutdown();
            self.observe_exit(owner, &report)?;
        }
        Ok(())
    }
    pub(super) fn status(&self, id: &NodePackageId) -> HostResult<NodePackageRuntimeStatus> {
        match self.owner.try_lock() {
            Ok(mut owner) => self.reconcile(&mut owner)?,
            Err(TryLockError::WouldBlock) => {}
            Err(TryLockError::Poisoned(_)) => return Err(failure("HOST_BUSY", "nodeOwner")),
        }
        self.catalog.status(id)
    }
    pub(super) fn has_active_owner(&self, id: &NodePackageId) -> HostResult<bool> {
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| failure("HOST_BUSY", "nodeOwner"))?;
        self.reconcile(&mut owner)?;
        // 同一安装名额尚未归还；目录可能是失败投影，必须读取实际owner集合。
        Ok(owner.active.contains(id.as_str()))
    }
    pub(super) fn holds_installation(
        &self,
        package: &super::InstalledNodePackage,
        check: &dyn Fn() -> HostResult<()>,
    ) -> HostResult<bool> {
        let mut owner = self.lock(check)?;
        self.reconcile(&mut owner)?;
        owner.backend.as_ref().map_or(Ok(false), |backend| {
            backend.holds_installation_object(package.object_id())
        })
    }
    pub(super) fn prepare_uninstall(
        &self,
        package: &super::InstalledNodePackage,
        check: &dyn Fn() -> HostResult<()>,
    ) -> HostResult<()> {
        let mut owner = self.lock(check)?;
        self.reconcile(&mut owner)?;
        let held = owner
            .backend
            .as_ref()
            .map(|backend| backend.holds_installation_object(package.object_id()))
            .transpose()?
            .unwrap_or(false);
        if owner
            .active
            .iter()
            .any(|id| id != package.manifest.id.as_str())
            && held
        {
            return Err(failure("HOST_BUSY", "installationCodeStillLoaded"));
        }
        Ok(())
    }
    pub(super) fn activate(
        &self,
        proof: VerifiedNodeInstallation,
        lease: ExecutionLease,
        deadline: Instant,
        cancel: &AtomicBool,
        check: &dyn Fn() -> HostResult<()>,
    ) -> HostResult<()> {
        lease.begin_initial(deadline)?;
        let id = proof.package().manifest.id.clone();
        let archive = proof.package().archive_sha256.clone();
        let mut owner = self.lock(check)?;
        self.reconcile(&mut owner)?;
        if owner.active.contains(id.as_str()) {
            return Ok(());
        }
        if owner.backend.is_none() {
            owner.generation = owner.generation.checked_next()?;
        }
        let generation = owner.generation;
        self.put(
            &id,
            Some(archive.clone()),
            generation,
            NodePackageRuntimePhase::Starting,
            None,
        )?;
        let result = (|| {
            check()?;
            if owner.backend.is_none() {
                let runtime = if let Some(runtime) = owner.pending.take() {
                    runtime
                } else {
                    let root = if let Some(root) = &owner.root {
                        root.clone()
                    } else {
                        installed_node_resource_root()?
                    };
                    owner.root = Some(root.clone());
                    verify_node_runtime(
                        &root,
                        &NodeRuntimeLimits {
                            verification_timeout: deadline
                                .saturating_duration_since(Instant::now()),
                            ..NodeRuntimeLimits::default()
                        },
                        cancel,
                    )?
                };
                check()?;
                owner.backend = Some(NodeBackend::start_notifying(
                    runtime,
                    NodeBackendLimits::default(),
                    self.stopping.clone(),
                    self.catalog.notifications(),
                    #[cfg(test)]
                    self.gates.clone(),
                )?);
                *self
                    .metrics
                    .lock()
                    .map_err(|_| failure("HOST_BUSY", "nodeMetrics"))? =
                    owner.backend.as_ref().map(NodeBackend::metrics_reader);
            }
            check()?;
            let ongoing = lease.clone();
            let completed = lease.clone();
            let registered = owner
                .backend
                .as_ref()
                .expect("ready backend")
                .activate_with_completion(
                    proof,
                    move || ongoing.check(),
                    move || completed.finish_initial(),
                );
            lease.finish_initial();
            registered?;
            let queries = owner
                .backend
                .as_ref()
                .expect("registered backend")
                .registered_handlers(&id)?;
            if let Err(error) = self.catalog.publish(
                NodePackageRuntimeStatus {
                    id: id.clone(),
                    archive_sha256: Some(archive.clone()),
                    generation,
                    phase: NodePackageRuntimePhase::Active,
                    error: None,
                },
                queries,
            ) {
                // 目录提交失败时不能留下未发布且仍能执行的登记。
                let report = owner.backend.take().expect("registered backend").shutdown();
                self.observe_exit(&mut owner, &report)?;
                return Err(error);
            }
            owner.active.insert(id.as_str().into());
            owner.recoverable.remove(id.as_str());
            self.clear_pending_registration(&id);
            Ok(())
        })();
        if let Err(error) = &result {
            if error.code == "NODE_OWNER_EXIT_UNCONFIRMED" {
                owner.unconfirmed_exit = Some(error.clone());
                self.ended(&mut owner, Some(error.clone()))?;
            }
            self.reconcile(&mut owner)?;
            if owner.active.is_empty()
                && let Some(backend) = owner.backend.take()
            {
                let report = backend.shutdown();
                self.observe_exit(&mut owner, &report)?;
            }
            self.put(
                &id,
                Some(archive),
                generation,
                NodePackageRuntimePhase::Failed,
                Some(error.clone()),
            )?;
        }
        result
    }
    pub(super) fn deactivate(
        &self,
        id: &NodePackageId,
        lease: ExecutionLease,
        check: &dyn Fn() -> HostResult<()>,
    ) -> HostResult<()> {
        let mut owner = self.lock(check)?;
        self.reconcile(&mut owner)?;
        owner.recoverable.remove(id.as_str());
        // 停止只是提交前准备；失败的升级/停用不能消耗已提交版本的登记意图。
        if owner.active.contains(id.as_str()) {
            self.catalog
                .transition(Some(id), NodePackageRuntimePhase::Stopping, None)?;
            #[cfg(test)]
            self.gates.before_dispose.arrive();
            let ongoing = lease.clone();
            #[cfg(test)]
            let delivery = if self
                .gates
                .fail_dispose_request_once
                .swap(false, Ordering::AcqRel)
            {
                // 单次模拟控制请求在接纳前投递失败；不伪造实际dispose或退出。
                Err(failure("HOST_BUSY", "backendControlQueue"))
            } else {
                Ok(())
            };
            #[cfg(not(test))]
            let delivery: HostResult<()> = Ok(());
            let result = delivery.and_then(|()| {
                owner
                    .backend
                    .as_ref()
                    .expect("active backend")
                    .dispose(id.clone(), move || ongoing.check())
            });
            lease.finish_initial();
            if let Err(error) = result {
                self.reconcile(&mut owner)?;
                if let Some(backend) = &owner.backend {
                    let restored = (|| {
                        // 发送前失败不消费原登记；仅恢复仍存活且原A仍有效的真实子集。
                        let handlers = backend.registered_handlers(id)?;
                        let mut status = self.catalog.status(id)?;
                        status.phase = NodePackageRuntimePhase::Active;
                        status.error = None;
                        #[cfg(test)]
                        self.gates.before_dispose_restore.arrive();
                        self.catalog.publish(status, handlers)
                    })();
                    if let Err(restore_error) = restored {
                        #[cfg(test)]
                        {
                            eprintln!(
                                "native_node_dispose_restore_failed code={}",
                                restore_error.code
                            );
                            self.gates.dispose_restore_failed.arrive();
                        }
                        // 证明读取或发布失败也须真实清理，瞬时Store错误不能遗留永久Stopping。
                        let mut report =
                            owner.backend.take().expect("registered backend").shutdown();
                        report.error.get_or_insert(restore_error);
                        let cleanup = self.observe_exit(&mut owner, &report);
                        if owner.unconfirmed_exit.is_some() {
                            cleanup?;
                        }
                    }
                }
                return Err(error);
            }
            owner.active.remove(id.as_str());
        }
        if owner.active.is_empty()
            && let Some(backend) = owner.backend.take()
        {
            let report = backend.shutdown();
            self.observe_exit(&mut owner, &report)?;
            if let Some(error) = report.error {
                return Err(error);
            }
        }
        self.catalog
            .transition(Some(id), NodePackageRuntimePhase::Inactive, None)
    }
    pub(super) async fn shutdown(&self) -> HostResult<()> {
        self.request_quiesce();
        let runtime = self.clone();
        tokio::task::spawn_blocking(move || {
            // 清理责任不能因管理状态中毒而丢失，仍取回实际子进程并等待。
            let mut owner = runtime
                .owner
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some(backend) = owner.backend.take() {
                let mut report = backend.shutdown();
                report.error = report
                    .error
                    .filter(|error| !["CANCELLED", "HOST_CLOSING"].contains(&error.code.as_str()));
                // 已确认退出的运行失败保留在状态中，不再冒充当前清理失败。
                runtime.observe_exit(&mut owner, &report)?;
            }
            owner.pending.take();
            if let Some(error) = &owner.unconfirmed_exit {
                return Err(error.clone());
            }
            runtime.publish_exit(&mut owner)
        })
        .await
        .map_err(|_| failure("NODE_BACKEND_INTERRUPTED", "nodeShutdownOwner"))?
    }
}

#[derive(Clone)]
pub(super) struct ExecutionLease(Arc<Lease>);
struct Lease {
    store: Store,
    auth: AuthService,
    actor: AuthenticatedActor,
    target: Target,
    id: NodePackageId,
    archive: Digest,
    cleanup: bool,
    stopping: Arc<AtomicBool>,
    initial: Mutex<Option<InitialActivation>>,
    cached: Mutex<Cached>,
}
#[derive(Clone, Default)]
struct InitialActivation {
    operation: Option<(Id, Arc<AtomicBool>)>,
    deadline: Option<Instant>,
}
impl InitialActivation {
    fn check_deadline(&self) -> HostResult<()> {
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(failure("LIMIT_EXCEEDED", "nodeActivationDeadline"));
        }
        Ok(())
    }
}
struct Cached {
    authorization: AuthorizationSnapshot,
    grants: watch::Receiver<U64>,
    packages: watch::Receiver<U64>,
    sources: watch::Receiver<U64>,
    first: bool,
}
pub(super) struct LeaseRequest {
    pub store: Store,
    pub auth: AuthService,
    pub actor: AuthenticatedActor,
    pub target: Target,
    pub id: NodePackageId,
    pub archive: Digest,
    pub cleanup: bool,
    pub stopping: Arc<AtomicBool>,
    pub initial: Option<(Id, Arc<AtomicBool>)>,
    pub packages: watch::Receiver<U64>,
    pub sources: watch::Receiver<U64>,
}
impl ExecutionLease {
    pub(super) fn new(request: LeaseRequest) -> HostResult<Self> {
        let cached = Cached {
            authorization: request.auth.snapshot(&request.actor)?,
            grants: request.auth.subscribe_changes(),
            packages: request.packages,
            sources: request.sources,
            first: true,
        };
        Ok(Self(Arc::new(Lease {
            store: request.store,
            auth: request.auth,
            actor: request.actor,
            target: request.target,
            id: request.id,
            archive: request.archive,
            cleanup: request.cleanup,
            stopping: request.stopping,
            initial: Mutex::new(Some(InitialActivation {
                operation: request.initial,
                deadline: None,
            })),
            cached: Mutex::new(cached),
        })))
    }
    fn finish_initial(&self) {
        // 只结束已完成的初始阶段；poison也不能静默遗留期限而杀掉已登记owner。
        self.0
            .initial
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
    fn begin_initial(&self, deadline: Instant) -> HostResult<()> {
        self.0
            .initial
            .lock()
            .map_err(|_| failure("HOST_BUSY", "nodeLease"))?
            .get_or_insert_with(InitialActivation::default)
            .deadline = Some(deadline);
        Ok(())
    }
    fn check(&self) -> HostResult<()> {
        let lease = &self.0;
        if lease.stopping.load(Ordering::Acquire) {
            return Err(failure("HOST_CLOSING", "nodeRuntimeStopping"));
        }
        let initial = lease
            .initial
            .lock()
            .map_err(|_| failure("HOST_BUSY", "nodeLease"))?
            .clone();
        if let Some(initial) = &initial {
            initial.check_deadline()?;
        }
        if let Some((operation, cancel)) = initial
            .as_ref()
            .and_then(|initial| initial.operation.as_ref())
        {
            if cancel.load(Ordering::Acquire) {
                return Err(failure("CANCELLED", "nodeActivationCancelled"));
            }
            match lease.store.operation_state(operation)? {
                OperationState::Queued | OperationState::Running => {}
                OperationState::CancelRequested | OperationState::Cancelled => {
                    return Err(failure("CANCELLED", "nodeActivationCancelled"));
                }
                _ => return Err(failure("OPERATION_INTERRUPTED", "nodeActivationOwnerEnded")),
            }
        }
        let mut cached = lease
            .cached
            .lock()
            .map_err(|_| failure("HOST_BUSY", "nodeLease"))?;
        let changed = cached.first
            || cached.grants.has_changed().unwrap_or(true)
            || cached.packages.has_changed().unwrap_or(true)
            || cached.sources.has_changed().unwrap_or(true);
        if changed {
            // 多个实际调用方共用lease；失败必须保持失效，不能替owner消费一次撤权后恢复放行。
            cached.first = true;
            // 先登记观察代次，再重载；重载期间的新变化留给下次检查，不能吞掉通知。
            cached.grants.borrow_and_update();
            cached.packages.borrow_and_update();
            cached.sources.borrow_and_update();
            cached.authorization = lease.auth.snapshot(&lease.actor)?;
            if !lease.cleanup {
                let package = NodePackageInstaller::read_snapshot(&lease.store)?
                    .packages
                    .into_iter()
                    .find(|package| package.manifest.id == lease.id)
                    .ok_or_else(|| failure("OPERATION_INTERRUPTED", "nodePackageRemoved"))?;
                if !package.enabled
                    || package.archive_sha256 != lease.archive
                    || !package.execution_trust.as_ref().is_some_and(|trust| {
                        trust.archive_sha256 == package.archive_sha256
                            && trust.permissions == package.manifest.permissions
                            && trust.verified_source == package.verified_source
                    })
                {
                    return Err(failure("PERMISSION_DENIED", "nodeExecutionTrustChanged"));
                }
                if let Some(source) = &package.verified_source {
                    NodePackageSources::new(lease.store.clone()).require_current(source)?;
                }
            }
            cached.first = false;
        }
        let permission = if lease.cleanup && lease.actor.is_user_control() {
            // 人工撤执行确认只授予清理；不能把控制身份当成激活或后台运行主体。
            lease.auth.require_control(&lease.actor)?;
            "auth.manage"
        } else {
            "plugins.manage"
        };
        cached.authorization.require(permission, &lease.target)?;
        drop(cached);
        if let Some(initial) = lease
            .initial
            .lock()
            .map_err(|_| failure("HOST_BUSY", "nodeLease"))?
            .as_ref()
        {
            initial.check_deadline()?;
        }
        Ok(())
    }
}
