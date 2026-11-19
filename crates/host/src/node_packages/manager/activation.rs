//! 业务只等待登记结果；实际register仍由Host监督器拥有，不借业务调用者替换激活主体。
use super::*;
use crate::node_packages::{InstalledNodePackage, NodePackageSnapshot};

#[derive(Default)]
pub(super) struct ActivationQueue {
    requests: std::collections::BTreeMap<String, Arc<ContributionActivation>>,
    closed: Option<HostError>,
}

pub(super) struct ContributionActivation {
    pub(super) archive: Digest,
    pub(super) revision: U64,
    pub(super) deadline: Instant,
    result: watch::Sender<Option<HostResult<()>>>,
}
impl ContributionActivation {
    fn complete(&self, result: HostResult<()>) {
        self.result.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(result);
            true
        });
    }
}

impl NodePackageManager {
    #[cfg(test)]
    pub(crate) fn activation_request_count_for_test(&self) -> usize {
        self.activation_requests.lock().unwrap().requests.len()
    }
    pub(crate) async fn activate_contribution(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        kind: ActionKind,
        budget: Arc<tokio::sync::OwnedSemaphorePermit>,
    ) -> HostResult<()> {
        let deadline = Instant::now() + NodePackageLimits::default().timeout;
        let manager = self.clone();
        let caller = actor.clone();
        let request = query.clone();
        let preparation_budget = budget.clone();
        let (activation, stamp, permissions) = tokio::task::spawn_blocking(move || {
            let _budget = preparation_budget;
            manager.request_contribution(&caller, &request, kind, deadline)
        })
        .await
        .map_err(|_| failure("HOST_BUSY", "activationPreparation"))??;
        let mut result = activation.result.subscribe();
        let mut grants = self.auth.subscribe_changes();
        let mut stopping = self.stop.subscribe();
        let timer = tokio::time::sleep_until(deadline.min(activation.deadline).into());
        tokio::pin!(timer);
        loop {
            let manager = self.clone();
            let caller = actor.clone();
            let target = query.target.clone();
            let permissions = permissions.clone();
            let check_stamp = stamp.clone();
            let checking_budget = budget.clone();
            tokio::task::spawn_blocking(move || {
                let _budget = checking_budget;
                manager.check_activation_caller(
                    &caller,
                    &target,
                    kind,
                    &permissions,
                    check_stamp.as_ref(),
                )
            })
            .await
            .map_err(|_| failure("HOST_BUSY", "activationWaiter"))??;
            // 先读粘性终态再等待通知，快速完成和迟到订阅也不丢回执。
            if let Some(outcome) = result.borrow_and_update().clone() {
                return outcome;
            }
            tokio::select! {
                changed = result.changed() => {if changed.is_err() {return Err(failure("NODE_BACKEND_INTERRUPTED", "activationOwnerEnded"));}},
                _ = grants.changed() => {},
                _ = stopping.changed() => {},
                _ = self.auth.wait_grant_expiry(stamp.as_ref()) => {},
                _ = &mut timer => {return Err(failure("LIMIT_EXCEEDED", "activationDeadline"));},
            }
        }
    }

    fn check_activation_caller(
        &self,
        actor: &AuthenticatedActor,
        target: &Target,
        kind: ActionKind,
        permissions: &[String],
        stamp: Option<&GrantStamp>,
    ) -> HostResult<()> {
        if self.runtime.stop_signal().load(Ordering::Acquire) {
            return Err(failure("HOST_CLOSING", "activationStopping"));
        }
        // 内部按需登记不向业务调用者索取额外权限，但等待仍受原父任务约束。
        actor.check_task_target(target)?;
        if let Some(stamp) = stamp {
            self.auth.validate_grants(stamp)?;
        }
        if kind == ActionKind::Query {
            self.auth.require(actor, "metadata.read", target)?;
        }
        for permission in permissions {
            self.auth.require(actor, permission, target)?;
        }
        Ok(())
    }

    fn request_contribution(
        &self,
        actor: &AuthenticatedActor,
        query: &Query,
        kind: ActionKind,
        deadline: Instant,
    ) -> HostResult<(Arc<ContributionActivation>, Option<GrantStamp>, Vec<String>)> {
        let snapshot = NodePackageInstaller::read_snapshot(&self.store)?;
        let package = snapshot
            .packages
            .iter()
            .find(|package| {
                package.manifest.activation.contains(&query.action_id)
                    && package
                        .manifest
                        .contributes
                        .actions
                        .iter()
                        .chain(&package.manifest.contributes.queries)
                        .any(|spec| spec.action_id == query.action_id)
            })
            .ok_or_else(|| failure("UNSUPPORTED_CAPABILITY", "contributionNotRegistered"))?;
        let spec = package
            .manifest
            .contributes
            .actions
            .iter()
            .chain(&package.manifest.contributes.queries)
            .find(|spec| spec.action_id == query.action_id)
            .expect("selected contribution");
        if spec.kind != kind || !spec.target_kinds.contains(&query.target.kind) {
            return Err(super::super::invalid("contributionTarget"));
        }
        if kind == ActionKind::Query
            && (query.reveal_target.page_id != spec.reveal_target.page_id
                || query.reveal_target.panel_id != spec.reveal_target.panel_id)
        {
            return Err(super::super::invalid("contributionReveal"));
        }
        let stamp = self.auth.capture_grants(actor)?;
        self.check_activation_caller(
            actor,
            &query.target,
            kind,
            &spec.permissions,
            stamp.as_ref(),
        )?;
        crate::node_backend::normalize_saved_parameters(spec, &query.params)?;
        self.check_activation_caller(
            actor,
            &query.target,
            kind,
            &spec.permissions,
            stamp.as_ref(),
        )?;
        if Instant::now() >= deadline {
            return Err(failure("LIMIT_EXCEEDED", "activationDeadline"));
        }
        if !package.enabled
            || package.activation_authority.is_none()
            || !package.execution_trust.as_ref().is_some_and(|trust| {
                trust.archive_sha256 == package.archive_sha256
                    && trust.permissions == package.manifest.permissions
                    && trust.verified_source == package.verified_source
            })
        {
            return Err(failure("PERMISSION_DENIED", "contributionExecutionTrust"));
        }
        let status = self.runtime.status(&package.manifest.id)?;
        if status.phase == NodePackageRuntimePhase::Active
            && status.archive_sha256.as_ref() == Some(&package.archive_sha256)
        {
            // register可选择声明子集；已经Active却未选择的贡献不能反复导入。
            return Err(failure(
                "UNSUPPORTED_CAPABILITY",
                "contributionNotRegistered",
            ));
        }
        #[cfg(test)]
        self.runtime.activation_before_enqueue();
        let mut pending = self
            .activation_requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let key = package.manifest.id.as_str();
        // 关闭与入队使用同一把锁；预核跨过关停或监督器退出也不能重新开放准入。
        if let Some(error) = &pending.closed {
            return Err(error.clone());
        }
        if let Some(current) = pending
            .requests
            .get(key)
            .filter(|current| current.archive == package.archive_sha256)
            .cloned()
        {
            drop(pending);
            #[cfg(test)]
            self.runtime.activation_request_joined();
            return Ok((current, stamp, spec.permissions.clone()));
        }
        if pending
            .requests
            .get(key)
            .is_some_and(|current| current.revision >= snapshot.revision)
        {
            return Err(failure("REVISION_CONFLICT", "activationArchiveChanged"));
        }
        if !pending.requests.contains_key(key)
            && pending.requests.len() >= crate::limits::NORMAL_OPERATIONS.saturating_add(2)
        {
            return Err(failure("HOST_BUSY", "activationQueueCapacity"));
        }
        let activation = Arc::new(ContributionActivation {
            archive: package.archive_sha256.clone(),
            revision: snapshot.revision,
            deadline,
            result: watch::channel(None).0,
        });
        let previous = pending.requests.insert(key.into(), activation.clone());
        drop(pending);
        if let Some(old) = previous {
            old.complete(Err(failure(
                "REVISION_CONFLICT",
                "activationArchiveChanged",
            )));
        }
        #[cfg(test)]
        self.runtime.activation_request_enqueued();
        self.activation_changes.send_replace(());
        Ok((activation, stamp, spec.permissions.clone()))
    }

    pub(super) fn activation_request(
        &self,
        package: &InstalledNodePackage,
    ) -> Option<Arc<ContributionActivation>> {
        self.activation_requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .requests
            .get(package.manifest.id.as_str())
            .filter(|request| request.archive == package.archive_sha256)
            .cloned()
    }
    pub(super) fn finish_activation_request(
        &self,
        package: &InstalledNodePackage,
        expected: Option<&Arc<ContributionActivation>>,
        result: HostResult<()>,
    ) {
        let mut requests = self
            .activation_requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(current) = requests
            .requests
            .get(package.manifest.id.as_str())
            .filter(|current| {
                current.archive == package.archive_sha256
                    && expected.is_none_or(|expected| Arc::ptr_eq(current, expected))
            })
        else {
            return;
        };
        let current = current.clone();
        requests.requests.remove(package.manifest.id.as_str());
        drop(requests);
        current.complete(result);
    }
    pub(super) fn reconcile_activation_requests(&self, snapshot: &NodePackageSnapshot) -> bool {
        let mut requests = self
            .activation_requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut refresh = false;
        requests.requests.retain(|id, request| {
            let error = if Instant::now() >= request.deadline {
                Some(failure("LIMIT_EXCEEDED", "activationDeadline"))
            } else if request.revision > snapshot.revision {
                refresh = true;
                None
            } else if !snapshot.packages.iter().any(|package| {
                package.manifest.id.as_str() == id
                    && package.enabled
                    && package.archive_sha256 == request.archive
            }) {
                Some(failure("REVISION_CONFLICT", "activationArchiveChanged"))
            } else {
                None
            };
            if let Some(error) = error {
                request.complete(Err(error));
                false
            } else {
                true
            }
        });
        refresh
    }
    pub(super) fn close_activation_requests(&self, error: HostError) {
        let (requests, error) = {
            let mut queue = self
                .activation_requests
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let error = queue.closed.get_or_insert(error).clone();
            (std::mem::take(&mut queue.requests), error)
        };
        for request in requests.into_values() {
            request.complete(Err(error.clone()));
        }
    }
}
