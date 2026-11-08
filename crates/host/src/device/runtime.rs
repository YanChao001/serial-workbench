//! One bounded discovery worker; session ownership remains in DeviceService.
use super::{
    DeviceDirectory, TransportOpener, serial::SerialProvider, virtual_backend::VirtualTransport,
};
use crate::{auth::HostIdentity, state::ProjectionStore};
use serial_workbench_core::*;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
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
struct DirectoryState {
    directory: DeviceDirectory,
    anchors: BTreeMap<Id, DeviceDescriptor>,
}
struct RuntimeState {
    identity: HostIdentity,
    provider: Arc<dyn DeviceProvider>,
    projections: ProjectionStore,
    state: Mutex<DirectoryState>,
    stopping: AtomicBool,
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
            projections,
            state: Mutex::new(DirectoryState {
                directory: DeviceDirectory::default(),
                anchors: BTreeMap::new(),
            }),
            stopping: AtomicBool::new(false),
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
                    if let Ok(mut state) = worker_state.state.lock() {
                        let anchors: Vec<_> = state.anchors.values().cloned().collect();
                        if let Some(mut snapshot) =
                            state.directory.apply_with_anchors(result, &anchors)
                        {
                            snapshot
                                .devices
                                .push(virtual_device(&worker_state.identity.host_id));
                            snapshot
                                .devices
                                .sort_by(|a, b| a.device_id.cmp(&b.device_id));
                            if let Ok(value) = object(&snapshot) {
                                let _ = worker_state.projections.commit(
                                    &id("host.devices"),
                                    id("devices.changed"),
                                    value.clone(),
                                    value,
                                );
                            }
                        }
                    }
                    worker_state
                        .changed
                        .send_modify(|version| *version = version.wrapping_add(1));
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
        let state = self.inner.state.lock().map_err(|_| unavailable())?;
        let mut snapshot = state.directory.snapshot().clone();
        snapshot
            .devices
            .push(virtual_device(&self.inner.identity.host_id));
        snapshot
            .devices
            .sort_by(|a, b| a.device_id.cmp(&b.device_id));
        Ok(snapshot)
    }
    pub async fn refresh(&self) -> HostResult<DeviceList> {
        let mut changed = self.inner.changed.subscribe();
        if self.inner.stopping.load(Ordering::SeqCst) {
            return Err(stopped());
        }
        match self.request.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => {}
            Err(mpsc::TrySendError::Disconnected(())) => return Err(stopped()),
        }
        changed.changed().await.map_err(|_| stopped())?;
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
        if !state.anchors.contains_key(&device.device_id) && state.anchors.len() >= 16 {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Reconnect responsibility capacity exhausted",
            ));
        }
        state
            .anchors
            .insert(device.device_id.clone(), device.clone());
        Ok(())
    }
    pub fn unpin(&self, device_id: &Id) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.anchors.remove(device_id);
        }
    }
    pub fn stop(&self) {
        self.inner.stopping.store(true, Ordering::SeqCst);
        self.inner
            .changed
            .send_modify(|version| *version = version.wrapping_add(1));
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
