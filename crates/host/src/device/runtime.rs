//! One bounded discovery worker; session ownership remains in DeviceService.
use super::{
    DeviceDirectory, TransportOpener,
    serial::{SerialHandoff, SerialProvider},
    virtual_backend::VirtualTransport,
};
use crate::{auth::HostIdentity, node_backend::RegisteredTransport, state::ProjectionStore};
use serial_workbench_core::*;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

pub trait DeviceProvider: Send + Sync + 'static {
    fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>>;
    fn open(
        &self,
        device: &DeviceDescriptor,
        configuration: &SerialConfiguration,
    ) -> BackendResult<Box<dyn Transport>>;
    fn require_tool_quiescence(&self) -> HostResult<()> {
        Ok(())
    }
    fn reserve_tool_handoff(&self, _: &DeviceDescriptor) -> HostResult<SerialHandoff> {
        Err(HostError::new(
            "DEVICE_UNSUPPORTED",
            "The selected provider does not support external serial ownership",
        ))
    }
}
impl DeviceProvider for SerialProvider {
    fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>> {
        SerialProvider::enumerate(self)
    }
    fn open(
        &self,
        device: &DeviceDescriptor,
        configuration: &SerialConfiguration,
    ) -> BackendResult<Box<dyn Transport>> {
        SerialProvider::open(self, device, configuration)
    }
    fn require_tool_quiescence(&self) -> HostResult<()> {
        SerialProvider::require_tool_quiescence(self)
    }
    fn reserve_tool_handoff(&self, device: &DeviceDescriptor) -> HostResult<SerialHandoff> {
        SerialProvider::reserve_tool_handoff(self, device)
    }
}
struct EmptyProvider;
impl DeviceProvider for EmptyProvider {
    fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>> {
        Ok(vec![])
    }
    fn open(
        &self,
        _: &DeviceDescriptor,
        _: &SerialConfiguration,
    ) -> BackendResult<Box<dyn Transport>> {
        Err(missing().into())
    }
}
type PluginCatalog = Arc<dyn Fn() -> HostResult<Vec<RegisteredTransport>> + Send + Sync>;

struct DirectoryState {
    directory: DeviceDirectory,
    anchors: BTreeMap<Id, (DeviceDescriptor, usize)>,
    plugins: Vec<RegisteredTransport>,
    plugins_stale: bool,
    published: DeviceList,
}
impl DirectoryState {
    fn snapshot(&self, host_id: &Id) -> DeviceList {
        let mut snapshot = self.directory.snapshot().clone();
        snapshot.stale |= self.plugins_stale;
        snapshot.devices.push(virtual_device(host_id));
        snapshot.devices.extend(
            self.plugins
                .iter()
                .filter(|plugin| plugin.owner_accepting())
                .map(|plugin| plugin.descriptor(host_id)),
        );
        snapshot
            .devices
            .sort_by(|a, b| a.device_id.cmp(&b.device_id));
        snapshot
    }
}
struct RuntimeState {
    identity: HostIdentity,
    provider: Arc<dyn DeviceProvider>,
    plugin_catalog: Mutex<Option<PluginCatalog>>,
    projections: ProjectionStore,
    state: Mutex<DirectoryState>,
    stopping: AtomicBool,
    started: AtomicU64,
    changed: tokio::sync::watch::Sender<u64>,
}
pub struct DeviceRuntime {
    inner: Arc<RuntimeState>,
    request: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl DeviceRuntime {
    pub fn native(identity: HostIdentity, projections: ProjectionStore) -> HostResult<Arc<Self>> {
        let provider = Arc::new(SerialProvider::new(identity.host_id.clone()));
        Self::new(identity, provider, projections)
    }
    pub fn virtual_only(
        identity: HostIdentity,
        projections: ProjectionStore,
    ) -> HostResult<Arc<Self>> {
        Self::new(identity, Arc::new(EmptyProvider), projections)
    }
    pub fn new(
        identity: HostIdentity,
        provider: Arc<dyn DeviceProvider>,
        projections: ProjectionStore,
    ) -> HostResult<Arc<Self>> {
        let snapshot = DeviceList {
            devices: vec![virtual_device(&identity.host_id)],
            stale: false,
        };
        projections.register_scope(
            id("host.devices"),
            Target {
                host_id: identity.host_id.clone(),
                id: identity.host_id.clone(),
                kind: ResourceKind::try_from("host")?,
                session_id: None,
                session_epoch: None,
            },
            "metadata.read".into(),
            object(&snapshot)?,
        )?;
        let (request, requests) = mpsc::sync_channel(1);
        let inner = Arc::new(RuntimeState {
            identity,
            provider,
            plugin_catalog: Mutex::new(None),
            projections,
            state: Mutex::new(DirectoryState {
                directory: DeviceDirectory::default(),
                anchors: BTreeMap::new(),
                plugins: Vec::new(),
                plugins_stale: false,
                published: snapshot,
            }),
            stopping: AtomicBool::new(false),
            started: AtomicU64::new(0),
            changed: tokio::sync::watch::channel(0).0,
        });
        let worker_state = inner.clone();
        let worker = thread::Builder::new()
            .name("device-discovery".into())
            .spawn(move || {
                loop {
                    if worker_state.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    let scan = worker_state.started.fetch_add(1, Ordering::AcqRel) + 1;
                    let result = worker_state.provider.enumerate().and_then(|devices| {
                        if devices.iter().any(|device| {
                            device.host_id != worker_state.identity.host_id
                                || !matches!(
                                    device.fingerprint.transport,
                                    DeviceTransportKind::Serial | DeviceTransportKind::Pty
                                )
                        }) {
                            return Err(HostError::new(
                                "INVALID_DEVICE",
                                "Provider returned an invalid device identity",
                            ));
                        }
                        Ok(devices)
                    });
                    if worker_state.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                    let plugins = worker_state
                        .plugin_catalog
                        .lock()
                        .map_err(|_| unavailable())
                        .map(|catalog| catalog.clone())
                        .and_then(|catalog| {
                            catalog.map_or_else(|| Ok(Vec::new()), |catalog| catalog())
                        });
                    if let Ok(mut state) = worker_state.state.lock() {
                        let anchors: Vec<_> = state
                            .anchors
                            .values()
                            .map(|(device, _)| device.clone())
                            .collect();
                        let _ = state.directory.apply_with_anchors(result, &anchors);
                        // 竞争中的目录不能证明新鲜度。已结束 owner 仍可随原子状态立即移除。
                        state.plugins_stale = plugins.is_err();
                        if let Ok(plugins) = plugins {
                            state.plugins = plugins;
                        }
                        state.plugins.retain(RegisteredTransport::owner_accepting);
                        let snapshot = state.snapshot(&worker_state.identity.host_id);
                        if snapshot != state.published
                            && let Ok(value) = object(&snapshot)
                            && worker_state
                                .projections
                                .commit(
                                    &id("host.devices"),
                                    id("devices.changed"),
                                    value.clone(),
                                    value,
                                )
                                .is_ok()
                        {
                            state.published = snapshot;
                        }
                    }
                    worker_state.changed.send_replace(scan);
                    match requests.recv_timeout(Duration::from_millis(500)) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .map_err(|_| unavailable())?;
        Ok(Arc::new(Self {
            inner,
            request,
            worker: Mutex::new(Some(worker)),
        }))
    }
    pub fn list(&self) -> HostResult<DeviceList> {
        self.list_with_native_stale().map(|(list, _)| list)
    }
    pub(super) fn list_with_native_stale(&self) -> HostResult<(DeviceList, bool)> {
        let state = self.inner.state.lock().map_err(|_| unavailable())?;
        Ok((
            state.snapshot(&self.inner.identity.host_id),
            state.directory.snapshot().stale,
        ))
    }
    pub(crate) fn attach_plugin_catalog(
        &self,
        catalog: impl Fn() -> HostResult<Vec<RegisteredTransport>> + Send + Sync + 'static,
    ) -> HostResult<()> {
        let mut slot = self
            .inner
            .plugin_catalog
            .lock()
            .map_err(|_| unavailable())?;
        if slot.is_some() {
            return Err(HostError::new(
                "REVISION_CONFLICT",
                "Plugin transport catalog already attached",
            ));
        }
        *slot = Some(Arc::new(catalog));
        Ok(())
    }
    pub(crate) fn plugin_transport(
        &self,
        device_id: &Id,
    ) -> HostResult<Option<RegisteredTransport>> {
        let state = self.inner.state.lock().map_err(|_| unavailable())?;
        Ok(state
            .plugins
            .iter()
            .find(|plugin| plugin.owner_accepting() && &plugin.device_id() == device_id)
            .cloned())
    }
    pub async fn refresh(&self) -> HostResult<DeviceList> {
        let mut changed = self.inner.changed.subscribe();
        if self.inner.stopping.load(Ordering::SeqCst) {
            return Err(stopped());
        }
        // An in-flight scan may already have collected the old OS snapshot.
        let started = self.inner.started.load(Ordering::Acquire);
        match self.request.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => {}
            Err(mpsc::TrySendError::Disconnected(())) => return Err(stopped()),
        }
        changed
            .wait_for(|complete| *complete > started || self.inner.stopping.load(Ordering::SeqCst))
            .await
            .map_err(|_| stopped())?;
        if self.inner.stopping.load(Ordering::SeqCst) {
            return Err(stopped());
        }
        self.list()
    }
    pub fn descriptor(&self, device_id: &Id) -> HostResult<DeviceDescriptor> {
        let snapshot = self.list()?;
        snapshot
            .devices
            .into_iter()
            .find(|device| &device.device_id == device_id)
            .ok_or_else(missing)
    }
    pub(super) fn reserve_tool_handoff(&self, device: &Id) -> HostResult<SerialHandoff> {
        let (directory, native_stale) = self.list_with_native_stale()?;
        if native_stale {
            return Err(HostError::new(
                "DISCOVERY_STALE",
                "Fresh device discovery is required",
            ));
        }
        let descriptor = directory
            .devices
            .iter()
            .find(|item| &item.device_id == device)
            .ok_or_else(missing)?;
        let handoff = self.inner.provider.reserve_tool_handoff(descriptor)?;
        self.pin(descriptor)?;
        Ok(handoff)
    }

    pub fn opener(self: &Arc<Self>) -> TransportOpener {
        let runtime = self.clone();
        Arc::new(move |device_id, config| {
            if runtime.inner.stopping.load(Ordering::SeqCst) {
                return Err(stopped().into());
            }
            let descriptor = runtime.descriptor(device_id)?;
            if descriptor.fingerprint.transport == DeviceTransportKind::Virtual {
                return Ok(Box::new(VirtualTransport::new(config.clone())));
            }
            runtime.inner.provider.open(&descriptor, config)
        })
    }
    pub fn pin(&self, device: &DeviceDescriptor) -> HostResult<()> {
        let mut state = self.inner.state.lock().map_err(|_| unavailable())?;
        if !state.directory.snapshot().devices.contains(device) {
            return Err(missing());
        }
        if let Some((existing, owners)) = state.anchors.get_mut(&device.device_id) {
            if existing.fingerprint != device.fingerprint {
                return Err(HostError::new(
                    "REQUIRES_REBIND",
                    "A different device identity is still retained",
                ));
            }
            *owners = owners.checked_add(1).ok_or_else(unavailable)?;
            return Ok(());
        }
        if state.anchors.len() >= 16 {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Device identity retention capacity exhausted",
            ));
        }
        state
            .anchors
            .insert(device.device_id.clone(), (device.clone(), 1));
        Ok(())
    }
    pub fn unpin(&self, device_id: &Id) {
        if let Ok(mut state) = self.inner.state.lock()
            && let Some((_, owners)) = state.anchors.get_mut(device_id)
        {
            *owners -= 1;
            if *owners == 0 {
                state.anchors.remove(device_id);
            }
        }
    }

    pub(super) fn require_tool_quiescence(&self) -> HostResult<()> {
        self.inner.provider.require_tool_quiescence()
    }
    pub fn stop(&self) {
        self.inner.stopping.store(true, Ordering::SeqCst);
        self.inner.changed.send_modify(|_| {});
        let _ = self.request.try_send(());
    }
}
impl Drop for DeviceRuntime {
    fn drop(&mut self) {
        self.stop();
        if let Ok(worker) = self.worker.get_mut()
            && let Some(worker) = worker.take()
            && worker.is_finished()
        {
            let _ = worker.join();
        }
    }
}
fn virtual_device(host: &Id) -> DeviceDescriptor {
    DeviceDescriptor {
        device_id: id("virtual:echo"),
        host_id: host.clone(),
        system_name: "virtual:echo".into(),
        description: Some("Virtual echo".into()),
        manufacturer: None,
        driver: None,
        fingerprint: DeviceFingerprint {
            transport: DeviceTransportKind::Virtual,
            vid: None,
            pid: None,
            serial_number: None,
            topology_path: None,
            evidence: IdentityEvidence::Unreliable,
        },
        capabilities: VirtualTransport::new(SerialConfiguration::default()).capabilities(),
    }
}
fn id(value: &str) -> Id {
    Id::try_from(value).expect("static ID")
}
fn object(value: &impl serde::Serialize) -> HostResult<JsonObject> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|_| unavailable())
}
fn missing() -> HostError {
    HostError::new(
        "DEVICE_NOT_FOUND",
        "Device is absent from the Host directory",
    )
}
fn unavailable() -> HostError {
    HostError::new("HOST_BUSY", "Device directory is unavailable")
}
fn stopped() -> HostError {
    HostError::new("HOST_CLOSING", "Device discovery has stopped")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{state::ProjectionLimits, test_support::Harness};

    #[tokio::test]
    async fn busy_plugin_catalog_marks_discovery_stale_until_the_next_success() {
        let harness = Harness::new().await;
        let identity = harness.store.identity().unwrap();
        let projections = ProjectionStore::new(
            identity.clone(),
            harness.auth.clone(),
            ProjectionLimits::default(),
        );
        let runtime = DeviceRuntime::virtual_only(identity, projections).unwrap();
        let initial = runtime.refresh().await.unwrap();
        assert!(!initial.stale);

        let busy = Arc::new(AtomicBool::new(true));
        let catalog = busy.clone();
        runtime
            .attach_plugin_catalog(move || {
                if catalog.load(Ordering::Acquire) {
                    Err(unavailable())
                } else {
                    Ok(Vec::new())
                }
            })
            .unwrap();
        let stale = runtime.refresh().await.unwrap();
        assert!(stale.stale);
        assert!(!runtime.list_with_native_stale().unwrap().1);
        assert_eq!(stale.devices, initial.devices);

        busy.store(false, Ordering::Release);
        assert_eq!(runtime.refresh().await.unwrap(), initial);
        runtime.stop();
        harness.host.shutdown().await.unwrap();
    }
}
