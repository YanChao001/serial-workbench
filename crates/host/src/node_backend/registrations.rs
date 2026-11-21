//! 共享已登记处理器的不可变定义；锁内不运行授权或schema工作。
use super::{Authority, definitions, error};
use crate::node_packages::ui_assets::VerifiedUiAssets;
use serial_workbench_core::{
    ActionKind, Digest, HostResult, Id, NodeHostApiScope, NodePackageId, NodePackageVersion,
    NodePackageView, NodeThemeEntry,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

pub(super) struct Registrations {
    packages: Mutex<BTreeMap<String, Package>>,
    changed: tokio::sync::watch::Sender<()>,
}
struct Package {
    authorize: Authority,
    definitions: definitions::Definitions,
    execution: Arc<PackageExecution>,
}
pub(super) struct PackageExecution {
    pub id: NodePackageId,
    pub version: NodePackageVersion,
    pub archive_sha256: Digest,
    pub instance_id: Id,
    pub host_api: Vec<NodeHostApiScope>,
    pub views: Vec<NodePackageView>,
    pub themes: Vec<(Id, NodeThemeEntry)>,
    pub ui_assets: Option<Arc<VerifiedUiAssets>>,
}
pub(super) struct RegisteredDefinition {
    pub authorize: Authority,
    pub definition: Arc<definitions::Definition>,
    pub execution: Arc<PackageExecution>,
}
impl Registrations {
    pub(super) fn new(changed: tokio::sync::watch::Sender<()>) -> Self {
        Self {
            packages: Mutex::new(BTreeMap::new()),
            changed,
        }
    }
    pub(super) fn contains(&self, id: &NodePackageId) -> HostResult<bool> {
        Ok(self
            .packages
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendRegistrations"))?
            .contains_key(id.as_str()))
    }
    pub(super) fn insert(
        &self,
        execution: Arc<PackageExecution>,
        authorize: Authority,
        definitions: definitions::Definitions,
    ) -> HostResult<()> {
        let mut packages = self
            .packages
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendRegistrations"))?;
        if packages.contains_key(execution.id.as_str()) {
            return Err(error("REVISION_CONFLICT", "backendAlreadyActive"));
        }
        packages.insert(
            execution.id.as_str().to_owned(),
            Package {
                authorize,
                definitions,
                execution,
            },
        );
        drop(packages);
        self.changed.send_replace(());
        Ok(())
    }
    pub(super) fn remove(&self, id: &NodePackageId) -> HostResult<()> {
        self.packages
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendRegistrations"))?
            .remove(id.as_str());
        self.changed.send_replace(());
        Ok(())
    }
    pub(super) fn authorizations(&self) -> HostResult<Vec<Authority>> {
        Ok(self
            .packages
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendRegistrations"))?
            .values()
            .map(|package| package.authorize.clone())
            .collect())
    }
    pub(super) fn query(
        &self,
        package: &NodePackageId,
        action: &str,
    ) -> HostResult<Arc<definitions::Definition>> {
        self.registration(package, action, ActionKind::Query)
            .map(|entry| entry.definition)
    }
    pub(super) fn action(
        &self,
        package: &NodePackageId,
        action: &str,
    ) -> HostResult<Arc<definitions::Definition>> {
        self.registration(package, action, ActionKind::Action)
            .map(|entry| entry.definition)
    }
    pub(super) fn registration(
        &self,
        package: &NodePackageId,
        action: &str,
        kind: ActionKind,
    ) -> HostResult<RegisteredDefinition> {
        let (inactive, mismatch) = match kind {
            ActionKind::Query => ("backendQueryPackageInactive", "backendQueryKind"),
            ActionKind::Action => ("backendActionPackageInactive", "backendActionKind"),
        };
        let packages = self
            .packages
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendRegistrations"))?;
        let package = packages
            .get(package.as_str())
            .ok_or_else(|| error("UNSUPPORTED_CAPABILITY", inactive))?;
        let definition = package.definitions.get(action)?;
        if definition.is_transport() || definition.spec().kind != kind {
            return Err(error("INVALID_ARGUMENT", mismatch));
        }
        Ok(RegisteredDefinition {
            authorize: package.authorize.clone(),
            definition,
            execution: package.execution.clone(),
        })
    }
    pub(super) fn validate_action(
        &self,
        package: &NodePackageId,
        expected: &Arc<definitions::Definition>,
    ) -> HostResult<()> {
        if !Arc::ptr_eq(
            &self.action(package, expected.spec().action_id.as_str())?,
            expected,
        ) {
            return Err(error("CATALOG_CHANGED", "backendActionRegistrationChanged"));
        }
        Ok(())
    }
    pub(super) fn validate_query(
        &self,
        package: &NodePackageId,
        action: &str,
        expected: &Arc<definitions::Definition>,
    ) -> HostResult<()> {
        if !Arc::ptr_eq(&self.query(package, action)?, expected) {
            return Err(error("CATALOG_CHANGED", "backendQueryRegistrationChanged"));
        }
        Ok(())
    }
    pub(super) fn definitions(&self, id: &NodePackageId) -> HostResult<Vec<RegisteredDefinition>> {
        let packages = self
            .packages
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendRegistrations"))?;
        let package = packages
            .get(id.as_str())
            .ok_or_else(|| error("UNSUPPORTED_CAPABILITY", "backendQueryPackageInactive"))?;
        let authorize = package.authorize.clone();
        let definitions = package
            .definitions
            .definitions()
            .into_iter()
            .map(|definition| RegisteredDefinition {
                authorize: package.authorize.clone(),
                definition,
                execution: package.execution.clone(),
            })
            .collect();
        drop(packages);
        // 空登记也是合法子集；在锁外复核原A，不能用处理器数量代替执行授权。
        authorize()?;
        Ok(definitions)
    }
    pub(super) fn validate_transport(
        &self,
        package: &NodePackageId,
        expected: &Arc<definitions::Definition>,
    ) -> HostResult<()> {
        let packages = self
            .packages
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendRegistrations"))?;
        let package = packages
            .get(package.as_str())
            .ok_or_else(|| error("CATALOG_CHANGED", "backendTransportInactive"))?;
        let actual = package
            .definitions
            .get(expected.spec().action_id.as_str())?;
        if !actual.is_transport() || !Arc::ptr_eq(&actual, expected) {
            return Err(error(
                "CATALOG_CHANGED",
                "backendTransportRegistrationChanged",
            ));
        }
        Ok(())
    }

    pub(super) fn transports(&self) -> HostResult<Vec<RegisteredDefinition>> {
        let packages = self
            .packages
            .lock()
            .map_err(|_| error("HOST_BUSY", "backendRegistrations"))?;
        let entries = packages
            .values()
            .flat_map(|package| {
                package
                    .definitions
                    .definitions()
                    .into_iter()
                    .filter(|definition| definition.is_transport())
                    .map(|definition| RegisteredDefinition {
                        authorize: package.authorize.clone(),
                        definition,
                        execution: package.execution.clone(),
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        Ok(entries)
    }

    pub(super) fn clear(&self) {
        self.packages
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        self.changed.send_replace(());
    }
}
