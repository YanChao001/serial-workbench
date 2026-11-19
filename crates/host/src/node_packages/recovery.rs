//! 恢复只重新登记当前可执行贡献；不读取旧业务Call，也不重新派发历史Operation。
use super::*;
use crate::node_packages::{
    InstalledNodePackage, NodePackageSnapshot,
    runtime::{ExecutionLease, LeaseRequest},
};
use std::{collections::BTreeMap, sync::Weak, time::Duration};

const RETRY_TICK: Duration = Duration::from_millis(250);
const HEALTHY_RESET: Duration = Duration::from_secs(30);
const MAX_ATTEMPTS: u8 = 3;

struct RecoveryWork {
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
    changed: watch::Sender<Option<NodePackageId>>,
    admission: Arc<Mutex<()>>,
}
impl Drop for RecoveryWork {
    fn drop(&mut self) {
        // 先归还真实工作名额，再唤醒合并等待者。
        let _admission = self
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        drop(self.permit.take());
        self.changed.send_replace(None);
    }
}

struct Attempt {
    tries: u8,
    next: Instant,
    healthy_since: Option<Instant>,
    blocked: bool,
}
impl Default for Attempt {
    fn default() -> Self {
        Self {
            tries: 0,
            next: Instant::now(),
            healthy_since: None,
            blocked: false,
        }
    }
}
#[derive(Default)]
struct RecoveryState {
    snapshot: Option<NodePackageSnapshot>,
    attempts: BTreeMap<String, Attempt>,
    retry_snapshot: bool,
    snapshot_failures: u8,
    #[cfg(test)]
    inspected_failure: bool,
}
impl NodePackageManager {
    pub(crate) fn start_recovery(manager: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let weak = Arc::downgrade(manager);
        let mut packages = manager.package_changes.subscribe();
        let mut sources = manager.source_changes.subscribe();
        let mut grants = manager.auth.subscribe_changes();
        let mut runtime = manager.runtime.subscribe();
        let mut activation = manager.activation_changes.subscribe();
        let mut stop = manager.stop.subscribe();
        tokio::spawn(async move {
            let mut state = RecoveryState::default();
            loop {
                let Some(manager) = Weak::upgrade(&weak) else {
                    break;
                };
                if manager.runtime.stop_signal().load(Ordering::Acquire) {
                    break;
                }
                // 实际工作持有manager及安装名额；闲置等待仅持Weak，不形成Host/任务环。
                let result = tokio::task::spawn_blocking(move || {
                    if let Err(error) = manager.recover_round(&mut state) {
                        eprintln!("node_recovery_failed code={}", error.code);
                        state.retry_snapshot =
                            error.code == "HOST_BUSY" && state.snapshot.is_none();
                        if state.retry_snapshot {
                            state.snapshot_failures =
                                state.snapshot_failures.saturating_add(1).min(3);
                        }
                        #[cfg(test)]
                        if error.code == "HOST_BUSY" && state.snapshot.is_none() {
                            manager.runtime.recovery_snapshot_busy();
                        }
                    }
                    #[cfg(test)]
                    if state.inspected_failure {
                        manager.runtime.recovery_failed_scan();
                    }
                    state
                })
                .await;
                state = match result {
                    Ok(state) => state,
                    Err(_) => break,
                };
                let enabled = state.snapshot.as_ref().is_some_and(|snapshot| {
                    snapshot.packages.iter().any(|package| package.enabled)
                });
                let delay = if state.retry_snapshot {
                    Duration::from_millis(250_u64 << state.snapshot_failures)
                } else {
                    RETRY_TICK
                };
                tokio::select! {
                    _ = tokio::time::sleep(delay), if enabled || state.retry_snapshot => {},
                    result = packages.changed() => {
                        if result.is_err() {break;}
                        state = RecoveryState::default();
                    },
                    result = sources.changed() => {
                        if result.is_err() {break;}
                        state.attempts.clear();
                    },
                    result = grants.changed() => {
                        if result.is_err() {break;}
                        state.attempts.clear();
                    },
                    result = runtime.changed() => {if result.is_err() {break;}},
                    result = activation.changed() => {
                        if result.is_err() {break;}
                        state.snapshot = None;
                    },
                    _ = stop.changed() => {break;},
                }
            }
            if let Some(manager) = Weak::upgrade(&weak) {
                manager.close_activation_requests(failure(
                    "NODE_BACKEND_INTERRUPTED",
                    "activationSupervisorEnded",
                ));
            }
        })
    }

    fn recover_round(&self, state: &mut RecoveryState) -> HostResult<()> {
        #[cfg(test)]
        self.runtime.recovery_before_scan();
        #[cfg(test)]
        {
            state.inspected_failure = false;
        }
        let stopping = self.runtime.stop_signal();
        if stopping.load(Ordering::Acquire) {
            return Ok(());
        }
        if state.snapshot.is_none() {
            state.snapshot = Some(NodePackageInstaller::read_snapshot(&self.store)?);
            state.retry_snapshot = false;
            state.snapshot_failures = 0;
        }
        let epoch = self.store.identity()?.instance_epoch;
        let snapshot = state.snapshot.as_ref().expect("loaded snapshot");
        if self.reconcile_activation_requests(snapshot) {
            state.snapshot = None;
            return Ok(());
        }
        for package in snapshot.packages.iter().filter(|package| package.enabled) {
            if stopping.load(Ordering::Acquire) {
                break;
            }
            let attempt = state
                .attempts
                .entry(package.manifest.id.as_str().into())
                .or_default();
            let status = self.runtime.status(&package.manifest.id)?;
            let requested = self.activation_request(package);
            #[cfg(test)]
            {
                state.inspected_failure |= status.phase == NodePackageRuntimePhase::Failed;
            }
            match status.phase {
                NodePackageRuntimePhase::Active => {
                    if status.archive_sha256.as_ref() == Some(&package.archive_sha256) {
                        self.finish_activation_request(package, requested.as_ref(), Ok(()));
                    }
                    if attempt
                        .healthy_since
                        .get_or_insert_with(Instant::now)
                        .elapsed()
                        >= HEALTHY_RESET
                    {
                        attempt.tries = 0;
                        attempt.blocked = false;
                    }
                    continue;
                }
                NodePackageRuntimePhase::Starting | NodePackageRuntimePhase::Stopping => continue,
                _ => {}
            }
            // 当次人工失败/取消不重试；旧实例意图、丢失的Active或已提交相容升级才可登记。
            let previous_instance = package
                .activation_authority
                .as_ref()
                .is_some_and(|authority| authority.instance_epoch < epoch)
                && package
                    .manifest
                    .activation
                    .iter()
                    .any(|id| id.as_str() == "startup");
            if requested.is_none() && !previous_instance && !self.runtime.can_recover(package) {
                continue;
            }
            attempt.healthy_since = None;
            if requested.is_none()
                && (attempt.blocked
                    || attempt.tries >= MAX_ATTEMPTS
                    || Instant::now() < attempt.next)
            {
                continue;
            }
            let work = {
                let _admission = self
                    .work_admission
                    .lock()
                    .map_err(|_| failure("HOST_BUSY", "managementAdmission"))?;
                let Ok(permit) = self.capacity.clone().try_acquire_owned() else {
                    continue;
                };
                let work = RecoveryWork {
                    permit: Some(permit),
                    changed: self.active_recovery.clone(),
                    admission: self.work_admission.clone(),
                };
                self.active_recovery
                    .send_replace(Some(package.manifest.id.clone()));
                work
            };
            #[cfg(test)]
            self.runtime.recovery_before_restore();
            let deadline = requested.as_ref().map_or_else(
                || Instant::now() + NodePackageLimits::default().timeout,
                |request| request.deadline,
            );
            let result = self.restore_package(package, snapshot.revision, &stopping, deadline);
            #[cfg(test)]
            if result.is_ok() {
                self.runtime.recovery_before_release();
            }
            attempt.tries = attempt.tries.saturating_add(1).min(MAX_ATTEMPTS);
            attempt.next = Instant::now() + Duration::from_millis(250_u64 << attempt.tries);
            if let Err(error) = &result {
                if error.code == "REVISION_CONFLICT" {
                    self.finish_activation_request(package, requested.as_ref(), result.clone());
                    state.snapshot = None;
                    return Ok(());
                }
                attempt.blocked = ![
                    "NODE_BACKEND_INTERRUPTED",
                    "NODE_REGISTRATION_FAILED",
                    "LIMIT_EXCEEDED",
                    "HOST_BUSY",
                ]
                .contains(&error.code.as_str());
                if let Err(publication) = self.runtime.recovery_failed(package, error.clone()) {
                    self.finish_activation_request(package, requested.as_ref(), result.clone());
                    return Err(publication);
                }
            }
            self.finish_activation_request(package, requested.as_ref(), result);
            drop(work);
        }
        #[cfg(test)]
        self.runtime.recovery_scan_completed();
        Ok(())
    }

    fn restore_package(
        &self,
        package: &InstalledNodePackage,
        revision: U64,
        stopping: &Arc<AtomicBool>,
        deadline: Instant,
    ) -> HostResult<()> {
        let origin = package
            .activation_authority
            .as_ref()
            .ok_or_else(|| failure("PERMISSION_DENIED", "activationActorRequired"))?;
        let actor = self.auth.restore_actor(&origin.actor)?;
        let identity = self.store.identity()?;
        if origin.instance_epoch > identity.instance_epoch {
            return Err(failure("EPOCH_MISMATCH", "activationAuthorityEpoch"));
        }
        let target = Target {
            host_id: identity.host_id.clone(),
            kind: ResourceKind::try_from("host")?,
            id: identity.host_id,
            session_id: None,
            session_epoch: None,
        };
        let limits = NodePackageLimits::default();
        let check = || {
            if stopping.load(Ordering::Acquire) {
                return Err(failure("HOST_CLOSING", "nodeRecoveryStopping"));
            }
            if Instant::now() >= deadline {
                return Err(failure("LIMIT_EXCEEDED", "nodeRecoveryDeadline"));
            }
            if self.store.identity()?.instance_epoch != identity.instance_epoch {
                return Err(failure("EPOCH_MISMATCH", "nodeRecoveryEpoch"));
            }
            self.auth.require(&actor, "plugins.manage", &target)
        };
        check()?;
        self.recover_installations(
            &NodePackageLimits {
                timeout: deadline.saturating_duration_since(Instant::now()),
                ..NodePackageLimits::default()
            },
            stopping,
        )?;
        let current = NodePackageInstaller::read_snapshot(&self.store)?;
        if current.revision != revision
            || current
                .packages
                .iter()
                .find(|p| p.manifest.id == package.manifest.id)
                != Some(package)
        {
            return Err(failure("REVISION_CONFLICT", "recoveryInstallationChanged"));
        }
        check()?;
        if package.manifest.runtime_ref != bundled_node_runtime_release().id {
            return Err(failure("NODE_RUNTIME_INCOMPATIBLE", "packageRuntime"));
        }
        let lease = ExecutionLease::new(LeaseRequest {
            store: self.store.clone(),
            auth: self.auth.clone(),
            actor: actor.clone(),
            target: target.clone(),
            id: package.manifest.id.clone(),
            archive: package.archive_sha256.clone(),
            cleanup: false,
            stopping: stopping.clone(),
            initial: None,
            packages: self.package_changes.subscribe(),
            sources: self.source_changes.subscribe(),
        })?;
        let installer = NodePackageInstaller::new(self.store.clone(), self.store.profile())?;
        let proof = installer.verify_installed(
            &package.manifest.id,
            revision,
            &package.archive_sha256,
            &NodePackageLimits {
                timeout: deadline.saturating_duration_since(Instant::now()),
                ..limits
            },
            stopping,
        )?;
        check()?;
        self.runtime
            .activate(proof, lease, deadline, stopping, &check)
    }
}
