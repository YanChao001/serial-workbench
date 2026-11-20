//! 运行阶段与真实处理器绑定共同发布；持久目录版本先提交，再交换可见快照。
use crate::{auth::hash, node_backend::RegisteredHandler, storage::Store};
use serial_workbench_core::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::watch;

pub(crate) struct RuntimeCatalog {
    store: Store,
    state: Mutex<State>,
    publication: Mutex<()>,
    stopping: Arc<AtomicBool>,
    changed: watch::Sender<()>,
}
struct State {
    version: U64,
    packages: BTreeMap<String, Package>,
}
#[derive(Clone)]
struct Package {
    status: NodePackageRuntimeStatus,
    handlers: BTreeMap<String, Arc<RegisteredHandler>>,
}
impl RuntimeCatalog {
    pub(super) fn new(store: Store) -> HostResult<Self> {
        let version = store.synchronize_catalog(&hash(
            &serde_json::to_vec(builtin_catalog()).map_err(|_| failed())?,
        ))?;
        Ok(Self {
            store,
            state: Mutex::new(State {
                version,
                packages: BTreeMap::new(),
            }),
            publication: Mutex::new(()),
            stopping: Arc::new(AtomicBool::new(false)),
            changed: watch::channel(()).0,
        })
    }
    pub(crate) fn notifications(&self) -> watch::Sender<()> {
        self.changed.clone()
    }
    pub(crate) fn subscribe(&self) -> watch::Receiver<()> {
        self.changed.subscribe()
    }
    pub(crate) fn stop_signal(&self) -> Arc<AtomicBool> {
        self.stopping.clone()
    }
    pub(crate) fn publish(
        &self,
        status: NodePackageRuntimeStatus,
        handlers: Vec<RegisteredHandler>,
    ) -> HostResult<()> {
        if !handlers.is_empty() && status.phase != NodePackageRuntimePhase::Active {
            return Err(failed());
        }
        let mut bindings = BTreeMap::new();
        for query in handlers {
            if query.package() != &status.id
                || query.spec().execution_location != ExecutionLocation::ResourceHost
            {
                return Err(failed());
            }
            bindings.insert(query.spec().action_id.as_str().to_owned(), Arc::new(query));
        }
        let publication = self.publication.lock().map_err(|_| failed())?;
        // 与执行租约读取同一单向停止信号，拦住已因停止失败的迟到登记；退出事实另经transition归位。
        if self.stopping.load(Ordering::Acquire) {
            return Err(HostError::new("HOST_CLOSING", "Host is closing"));
        }
        let mut next = self.state.lock().map_err(|_| failed())?.packages.clone();
        next.insert(
            status.id.as_str().to_owned(),
            Package {
                status,
                handlers: bindings,
            },
        );
        self.commit(next)?;
        drop(publication);
        self.changed.send_replace(());
        Ok(())
    }
    pub(crate) fn transition(
        &self,
        id: Option<&NodePackageId>,
        phase: NodePackageRuntimePhase,
        error: Option<HostError>,
    ) -> HostResult<()> {
        let publication = self.publication.lock().map_err(|_| failed())?;
        let mut next = self.state.lock().map_err(|_| failed())?.packages.clone();
        for (key, package) in &mut next {
            if id.map_or_else(
                || {
                    matches!(
                        package.status.phase,
                        NodePackageRuntimePhase::Starting
                            | NodePackageRuntimePhase::Active
                            | NodePackageRuntimePhase::Stopping
                    )
                },
                |id| id.as_str() == key,
            ) {
                package.status.phase = phase;
                package.status.error = error.clone();
                if phase != NodePackageRuntimePhase::Active {
                    package.handlers.clear();
                }
            }
        }
        self.commit(next)?;
        drop(publication);
        self.changed.send_replace(());
        Ok(())
    }
    pub(crate) fn status(&self, id: &NodePackageId) -> HostResult<NodePackageRuntimeStatus> {
        Ok(self
            .state
            .lock()
            .map_err(|_| failed())?
            .packages
            .get(id.as_str())
            .map(|package| package.status.clone())
            .unwrap_or(NodePackageRuntimeStatus {
                id: id.clone(),
                phase: NodePackageRuntimePhase::Inactive,
                generation: 0.into(),
                archive_sha256: None,
                error: None,
            }))
    }
    // 调用方持发布名额；计算、持久提交和旧定义释放均不占短时快照锁。
    fn commit(&self, packages: BTreeMap<String, Package>) -> HostResult<()> {
        let mut ids: BTreeSet<&str> = builtin_catalog()
            .iter()
            .map(|spec| spec.action_id.as_str())
            .collect();
        let mut handlers = Vec::new();
        let mut owners = Vec::new();
        for package in packages.values() {
            for query in package.handlers.values() {
                if !ids.insert(query.spec().action_id.as_str()) {
                    return Err(failed());
                }
                handlers.push(query.spec());
            }
            if !package.handlers.is_empty() {
                owners.push((
                    &package.status.id,
                    package.status.generation,
                    &package.status.archive_sha256,
                ));
            }
        }
        handlers.sort_by(|left, right| left.action_id.as_str().cmp(right.action_id.as_str()));
        let bytes = if handlers.is_empty() {
            serde_json::to_vec(builtin_catalog())
        } else {
            serde_json::to_vec(&(builtin_catalog(), handlers, owners))
        }
        .map_err(|_| failed())?;
        let version = self.store.synchronize_catalog(&hash(&bytes))?;
        let mut state = self.state.lock().map_err(|_| failed())?;
        let previous = std::mem::replace(&mut *state, State { version, packages });
        drop(state);
        drop(previous);
        Ok(())
    }
    pub(crate) fn snapshot(&self) -> HostResult<(U64, Vec<Arc<RegisteredHandler>>)> {
        for _ in 0..3 {
            let (version, packages) = {
                let state = self.state.lock().map_err(|_| failed())?;
                (state.version, state.packages.clone())
            };
            // 执行授权可能访问存储；绝不能在目录锁内运行。
            let stale: Vec<_> = packages
                .iter()
                .filter_map(|(id, package)| {
                    package
                        .handlers
                        .values()
                        .next()
                        .and_then(|query| query.current().err())
                        .map(|error| (id.clone(), error))
                })
                .collect();
            if stale.is_empty() {
                self.validate_version(version)?;
                return Ok((
                    version,
                    packages
                        .into_values()
                        .flat_map(|package| package.handlers.into_values())
                        .collect(),
                ));
            }
            let publication = self.publication.lock().map_err(|_| failed())?;
            let mut next = {
                let state = self.state.lock().map_err(|_| failed())?;
                if state.version != version {
                    continue;
                }
                state.packages.clone()
            };
            for (id, error) in stale {
                if let Some(package) = next.get_mut(&id) {
                    package.handlers.clear();
                    package.status.phase = NodePackageRuntimePhase::Failed;
                    package.status.error = Some(error);
                }
            }
            self.commit(next)?;
            drop(publication);
            self.changed.send_replace(());
        }
        Err(super::changed())
    }
    pub(crate) fn resolve(&self, action: &Id) -> HostResult<Arc<RegisteredHandler>> {
        self.snapshot()?
            .1
            .into_iter()
            .find(|query| query.spec().action_id == *action)
            .ok_or_else(|| {
                HostError::new("UNSUPPORTED_CAPABILITY", "Contribution is not registered")
            })
    }
    pub(crate) fn validate_binding(&self, expected: &Arc<RegisteredHandler>) -> HostResult<()> {
        let state = self.state.lock().map_err(|_| failed())?;
        let current = state
            .packages
            .get(expected.package().as_str())
            .filter(|package| package.status.phase == NodePackageRuntimePhase::Active)
            .and_then(|package| package.handlers.get(expected.spec().action_id.as_str()));
        if !current.is_some_and(|current| Arc::ptr_eq(current, expected)) {
            return Err(super::changed());
        }
        Ok(())
    }
    pub(super) fn validate_version(&self, version: U64) -> HostResult<()> {
        if self.state.lock().map_err(|_| failed())?.version != version {
            return Err(super::changed());
        }
        Ok(())
    }
}
fn failed() -> HostError {
    HostError::new(
        "NODE_REGISTRATION_FAILED",
        "Runtime catalog could not be published",
    )
}
