//! Window-scoped accounting for WebView deliveries. The bridge module is registered by root.
mod client_effects;
mod connect_device;
pub(crate) mod document_intents;
mod pending_frames;
mod platform_effects;
mod read_requests;
use pending_frames::PendingFrames;
use serial_workbench_core::{HostError, HostResult, Id};
use std::collections::{HashMap, VecDeque};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Deserialize, serde::Serialize, specta::Type,
)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DeliveryStream {
    Data,
    Lifecycle,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct DeliveryKey {
    pub generation: u64,
    pub subscription_id: Id,
    pub stream: DeliveryStream,
}

#[derive(Default)]
struct DeliveryEntries {
    sent: u64,
    acknowledged: u64,
    pending: VecDeque<(usize, bool)>,
    closed: bool,
}

pub(crate) struct DeliveryLedger {
    max_items: usize,
    max_bytes: usize,
    items: usize,
    bytes: usize,
    terminal_inflight: bool,
    entries: HashMap<DeliveryKey, DeliveryEntries>,
}

impl DeliveryLedger {
    fn new(max_items: usize, max_bytes: usize) -> Self {
        Self {
            max_items,
            max_bytes,
            items: 0,
            bytes: 0,
            terminal_inflight: false,
            entries: HashMap::new(),
        }
    }
    fn reserve(&mut self, key: &DeliveryKey, bytes: usize) -> HostResult<u64> {
        if self.items >= self.max_items || bytes > self.max_bytes.saturating_sub(self.bytes) {
            return Err(HostError::new(
                "HOST_BUSY",
                "Window delivery capacity exhausted",
            ));
        }
        let entries = self.entries.entry(key.clone()).or_default();
        if entries.closed {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Delivery stream is closed",
            ));
        }
        let ordinal = entries
            .sent
            .checked_add(1)
            .ok_or_else(|| HostError::new("COUNTER_EXHAUSTED", "Delivery counter exhausted"))?;
        entries.sent = ordinal;
        entries.pending.push_back((bytes, false));
        self.items += 1;
        self.bytes += bytes;
        Ok(ordinal)
    }
    fn acknowledge(&mut self, key: &DeliveryKey, ordinal: u64) -> HostResult<()> {
        let entries = self
            .entries
            .get_mut(key)
            .ok_or_else(|| HostError::new("INVALID_ARGUMENT", "Unknown delivery stream"))?;
        if ordinal > entries.sent {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Delivery acknowledgement is ahead of sent data",
            ));
        }
        while entries.acknowledged < ordinal {
            let (bytes, terminal) = entries
                .pending
                .pop_front()
                .expect("pending delivery accounting");
            entries.acknowledged += 1;
            self.items -= 1;
            self.bytes -= bytes;
            if terminal {
                self.terminal_inflight = false;
            }
        }
        if entries.closed && entries.pending.is_empty() {
            self.entries.remove(key);
        }
        Ok(())
    }
    fn close(&mut self, key: &DeliveryKey) {
        if let Some(entries) = self.entries.get_mut(key) {
            entries.closed = true;
            if entries.pending.is_empty() {
                self.entries.remove(key);
            }
        }
    }
    #[cfg(test)]
    fn pending(&self) -> (usize, usize) {
        (self.items, self.bytes)
    }
    fn reserve_terminal(&mut self, key: &DeliveryKey, bytes: usize) -> HostResult<()> {
        if self.terminal_inflight {
            return Err(HostError::new(
                "HOST_BUSY",
                "Terminal delivery capacity exhausted",
            ));
        }
        let entries = self.entries.entry(key.clone()).or_default();
        entries.sent = entries
            .sent
            .checked_add(1)
            .ok_or_else(|| HostError::new("COUNTER_EXHAUSTED", "Delivery counter exhausted"))?;
        entries.pending.push_back((bytes, true));
        self.items += 1;
        self.bytes += bytes;
        self.terminal_inflight = true;
        Ok(())
    }
}

#[cfg(test)]
#[path = "host_bridge/tests.rs"]
mod tests;

#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopAttachment {
    pub(crate) attachment: serial_workbench_core::AttachResult,
    pub(crate) generation: serial_workbench_core::U64,
}

#[derive(Clone)]
pub(crate) struct DesktopHostBridge {
    profile: std::path::PathBuf,
    inner: std::sync::Arc<tokio::sync::Mutex<BridgeState>>,
    initialization: std::sync::Arc<tokio::sync::Mutex<()>>,
    instances: std::sync::Arc<std::sync::Mutex<WindowInstances>>,
    delivery_limits: (usize, usize),
}

#[derive(Default)]
struct BridgeState {
    next_generation: u64,
    windows: HashMap<String, BridgeWindow>,
    ledgers: HashMap<String, std::sync::Arc<std::sync::Mutex<DeliveryLedger>>>,
}
#[derive(Default)]
struct WindowInstances {
    next: u64,
    active: HashMap<String, u64>,
    identities: HashMap<String, usize>,
    closed: HashMap<String, tokio::sync::watch::Sender<bool>>,
}
impl WindowInstances {
    fn new() -> Self {
        Self::default()
    }
    fn create(&mut self, window: &str) -> u64 {
        self.next = self.next.checked_add(1).expect("window instance counter");
        if let Some(previous) = self.closed.remove(window) {
            previous.send_replace(true);
        }
        let (closed, _) = tokio::sync::watch::channel(false);
        self.closed.insert(window.to_owned(), closed);
        self.active.insert(window.to_owned(), self.next);
        self.identities.remove(window);
        self.next
    }
    fn destroy(&mut self, window: &str, instance: u64) {
        if self.current(window, instance) {
            self.active.remove(window);
            self.identities.remove(window);
            if let Some(closed) = self.closed.remove(window) {
                closed.send_replace(true);
            }
        }
    }
    fn current(&self, window: &str, instance: u64) -> bool {
        self.active.get(window) == Some(&instance)
    }
    fn subscribe_closed(
        &self,
        window: &str,
        instance: u64,
    ) -> Option<tokio::sync::watch::Receiver<bool>> {
        self.current(window, instance)
            .then(|| self.closed.get(window).map(|closed| closed.subscribe()))
            .flatten()
    }
    fn resolve(&self, window: &str, identity: usize) -> Option<u64> {
        if self.identities.get(window).copied() != Some(identity) {
            return None;
        }
        self.active.get(window).copied()
    }
}
struct BridgeWindow {
    instance: u64,
    generation: u64,
    client: std::sync::Arc<serial_workbench_client::HostClient>,
    control: std::sync::Arc<serial_workbench_client::HostClient>,
    raw: std::sync::Arc<tokio::sync::Mutex<Option<std::sync::Arc<RawLink>>>>,
    subscriptions: std::sync::Arc<std::sync::Mutex<Subscriptions>>,
    pump: tokio::task::JoinHandle<()>,
    effects_pump: Option<tokio::task::JoinHandle<()>>,
    effects_registration: Option<serial_workbench_core::ClientRegistration>,
}
struct Subscription {
    query: serial_workbench_core::Query,
    channel: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
}
struct RawLink {
    connection: std::sync::Arc<serial_workbench_client::RawConnection>,
    subscriptions: std::sync::Arc<std::sync::Mutex<RawSubscriptions>>,
    pump: tokio::task::JoinHandle<()>,
}
impl Drop for RawLink {
    fn drop(&mut self) {
        self.pump.abort();
    }
}
struct RawSubscription {
    query: serial_workbench_core::Query,
    channel: tauri::ipc::Channel<serial_workbench_core::RawBatch>,
    lifecycle: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
}
struct RawSubscriptions {
    active: HashMap<Id, RawSubscription>,
    setups: std::sync::Arc<std::sync::Mutex<PendingFrames>>,
    ledger: std::sync::Arc<std::sync::Mutex<DeliveryLedger>>,
    failed: bool,
}
struct Subscriptions {
    active: HashMap<Id, Subscription>,
    setups: std::sync::Arc<std::sync::Mutex<PendingFrames>>,
    ledger: std::sync::Arc<std::sync::Mutex<DeliveryLedger>>,
    failed: bool,
}
impl Drop for BridgeWindow {
    fn drop(&mut self) {
        self.pump.abort();
        if let Some(pump) = &self.effects_pump {
            pump.abort();
        }
    }
}

impl DesktopHostBridge {
    pub(crate) async fn settings_attachment_for_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
    ) -> HostResult<serial_workbench_core::AttachResult> {
        self.attachment_at_generation(window, generation).await
    }

    pub(crate) fn can_close_window_instance(&self, window: &str, instance: u64) -> bool {
        self.instances
            .lock()
            .expect("window instances")
            .current(window, instance)
    }
    async fn start_effects(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
        executor: std::sync::Arc<dyn platform_effects::PlatformEffectExecutor>,
    ) -> HostResult<serial_workbench_core::ClientRegistration> {
        use serial_workbench_core::*;
        let _initialization = self.initialization.lock().await;
        let (control, instance) = {
            let state = self.inner.lock().await;
            let connected = state
                .windows
                .get(window)
                .filter(|entry| {
                    entry.generation == generation.get()
                        && self
                            .instances
                            .lock()
                            .expect("window instances")
                            .current(window, entry.instance)
                })
                .ok_or_else(|| {
                    HostError::new("EPOCH_MISMATCH", "Window Host connection changed")
                })?;
            if let Some(registration) = &connected.effects_registration {
                return Ok(registration.clone());
            }
            (connected.control.clone(), connected.instance)
        };
        let reply = control
            .request(RpcRequest::ClientRegister(ClientRegisterParams {
                generation,
                capabilities: executor.capabilities(),
            }))
            .await?;
        let registration = match reply {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::ClientRegistration(value) => value,
                _ => return Err(HostError::new("INTERNAL", "Invalid registration response")),
            },
            RpcReply::Failure { error, .. } => return Err(error),
        };
        let mut state = self.inner.lock().await;
        let entry = state
            .windows
            .get_mut(window)
            .filter(|entry| {
                entry.generation == generation.get()
                    && entry.instance == instance
                    && entry.effects_pump.is_none()
                    && self
                        .instances
                        .lock()
                        .expect("window instances")
                        .current(window, instance)
            })
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window Host connection changed"))?;
        let registered = registration.clone();
        let instances = self.instances.clone();
        let label = window.to_owned();
        let pump = tokio::spawn(async move {
            let attachment = control.attachment().clone();
            let mut inbox = self::client_effects::EffectInbox::new(256, 4 * 1024 * 1024);
            while let Ok(Some(frame)) = control.next_event().await {
                let IpcMessage::ClientEffect { request } = frame.body else {
                    continue;
                };
                if !instances
                    .lock()
                    .expect("window instances")
                    .current(&label, instance)
                {
                    break;
                }
                if self::client_effects::validate_delivery(
                    &attachment.host_id,
                    attachment.instance_epoch,
                    &registered,
                    &request,
                )
                .is_err()
                {
                    continue;
                }
                if inbox.push(*request).is_err() {
                    let _ = control.close().await;
                    break;
                }
                let Some(request) = inbox.pop() else { continue };
                let outcome =
                    match executor
                        .execute(request.action.clone())
                        .await
                        .and_then(|result| {
                            result.validate_for(request.action.capability())?;
                            Ok(result)
                        }) {
                        Ok(result) => ClientEffectOutcome::Succeeded { result },
                        Err(error) => ClientEffectOutcome::Failed { error },
                    };
                if !instances
                    .lock()
                    .expect("window instances")
                    .current(&label, instance)
                {
                    break;
                }
                let receipt = ClientEffectReceipt {
                    host_id: request.host_id,
                    instance_epoch: request.instance_epoch,
                    client_target_id: request.client_target_id,
                    generation: request.generation,
                    delivery_id: request.delivery_id,
                    outcome,
                };
                if control
                    .request(RpcRequest::ClientReceipt(ClientReceiptSubmission::Effect(
                        Box::new(receipt),
                    )))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            inbox.close();
        });
        entry.effects_pump = Some(pump);
        entry.effects_registration = Some(registration.clone());
        Ok(registration)
    }
    pub(crate) async fn window_instance_at_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
    ) -> HostResult<u64> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let state = self.inner.lock().await;
        let connected = state
            .windows
            .get(window)
            .filter(|connected| {
                connected.generation == generation.get()
                    && self
                        .instances
                        .lock()
                        .expect("window instances")
                        .current(window, connected.instance)
            })
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window Host connection changed"))?;
        if !self
            .instances
            .lock()
            .expect("window instances")
            .current(window, connected.instance)
        {
            return Err(HostError::new("EPOCH_MISMATCH", "Window instance closed"));
        }
        Ok(connected.instance)
    }
    pub(crate) fn bind_window(&self, window: &tauri::WebviewWindow) -> HostResult<u64> {
        use tauri::Manager;
        crate::commands::require_host_window(window.label())
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let current = window
            .app_handle()
            .get_webview_window(window.label())
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance closed"))?;
        let requested = {
            let table = window.resources_table();
            std::ptr::from_ref(&*table)
        };
        let registered = {
            let table = current.resources_table();
            std::ptr::from_ref(&*table)
        };
        if requested != registered {
            return Err(HostError::new("EPOCH_MISMATCH", "Window instance changed"));
        }
        let instances = self.instances.lock().expect("window instances");
        instances
            .resolve(window.label(), requested as usize)
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance changed"))
    }
    pub(crate) fn register_new_window(&self, window: &tauri::WebviewWindow) -> HostResult<()> {
        use tauri::Manager;
        crate::commands::require_host_window(window.label())
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let label = window.label().to_owned();
        let identity = {
            let table = window.resources_table();
            std::ptr::from_ref(&*table) as usize
        };
        let instance = {
            let mut instances = self.instances.lock().expect("window instances");
            let instance = instances.create(&label);
            instances.identities.insert(label.clone(), identity);
            instance
        };
        self.bind_instance_listener(window, label, instance);
        Ok(())
    }
    fn bind_instance_listener(&self, window: &tauri::WebviewWindow, label: String, instance: u64) {
        use tauri::Manager;
        let bridge = self.clone();
        let app = window.app_handle().clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(tickets) = app.try_state::<crate::media_protocol::MediaTickets>() {
                    tickets.destroy_window(&label, instance);
                }
                bridge
                    .instances
                    .lock()
                    .expect("window instances")
                    .destroy(&label, instance);
                let bridge = bridge.clone();
                let label = label.clone();
                tauri::async_runtime::spawn(async move {
                    let connected = {
                        let mut state = bridge.inner.lock().await;
                        if state
                            .windows
                            .get(&label)
                            .is_some_and(|connected| connected.instance == instance)
                        {
                            state.ledgers.remove(&label);
                            state.windows.remove(&label)
                        } else {
                            None
                        }
                    };
                    if let Some(connected) = connected {
                        let client = connected.client.clone();
                        let control = connected.control.clone();
                        let raw = connected.raw.clone();
                        drop(connected);
                        let _ = client.close().await;
                        let _ = control.close().await;
                        let raw_link = raw.lock().await.take();
                        if let Some(raw) = raw_link {
                            let _ = raw.connection.close().await;
                        }
                    }
                });
            }
        });
    }
    #[cfg(test)]
    fn create_instance_for_test(&self, window: &str) -> u64 {
        self.instances
            .lock()
            .expect("window instances")
            .create(window)
    }
    #[cfg(test)]
    fn destroy_instance_for_test(&self, window: &str, instance: u64) {
        self.instances
            .lock()
            .expect("window instances")
            .destroy(window, instance)
    }
    #[cfg(test)]
    async fn attach_instance_for_test(
        &self,
        window: &str,
        instance: u64,
    ) -> HostResult<DesktopAttachment> {
        self.attach_instance_with(window, instance, async {}).await
    }
    #[cfg(test)]
    async fn attach_instance_with<F: std::future::Future<Output = ()>>(
        &self,
        window: &str,
        instance: u64,
        after_attach: F,
    ) -> HostResult<DesktopAttachment> {
        self.attach_guarded(window, instance, after_attach, async { Ok(()) })
            .await
    }
    #[cfg(test)]
    async fn attach_instance_with_gate_for_test(
        &self,
        window: &str,
        instance: u64,
        entered: std::sync::Arc<tokio::sync::Notify>,
        release: tokio::sync::oneshot::Receiver<()>,
    ) -> HostResult<DesktopAttachment> {
        self.attach_instance_with(window, instance, async move {
            entered.notify_one();
            let _ = release.await;
        })
        .await
    }
    #[cfg(test)]
    async fn disconnect_for_test(&self, window: &str) {
        self.inner.lock().await.windows.remove(window);
    }
    #[cfg(test)]
    async fn pending_for_test(&self, window: &str) -> (usize, usize) {
        let ledger = self.inner.lock().await.ledgers.get(window).cloned();
        ledger
            .map(|ledger| ledger.lock().expect("delivery ledger").pending())
            .unwrap_or_default()
    }
    #[cfg(test)]
    async fn bootstrap_with_test_start<F, Fut>(
        &self,
        window: &str,
        start: F,
    ) -> HostResult<DesktopAttachment>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = HostResult<()>>,
    {
        let instance = self
            .instances
            .lock()
            .expect("window instances")
            .create(window);
        self.attach_guarded(window, instance, async {}, start())
            .await
    }
    #[cfg(test)]
    async fn raw_subscribe(
        &self,
        window: &str,
        query: serial_workbench_core::Query,
        channel: tauri::ipc::Channel<serial_workbench_core::RawBatch>,
        lifecycle: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
    ) -> HostResult<Id> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let instance = self
            .instances
            .lock()
            .expect("window instances")
            .active
            .get(window)
            .copied()
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance closed"))?;
        self.raw_subscribe_for_instance(window, instance, query, channel, lifecycle)
            .await
    }
    async fn raw_subscribe_for_instance(
        &self,
        window: &str,
        instance: u64,
        query: serial_workbench_core::Query,
        channel: tauri::ipc::Channel<serial_workbench_core::RawBatch>,
        lifecycle: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
    ) -> HostResult<Id> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let bridge = self.clone();
        let window = window.to_owned();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let result = bridge
                .raw_subscribe_inner(&window, instance, query, channel, lifecycle)
                .await;
            if let Err(Ok(id)) = send.send(result) {
                let _ = bridge
                    .raw_unsubscribe_for_instance(&window, instance, id)
                    .await;
            }
        });
        receive
            .await
            .map_err(|_| HostError::new("UNAUTHENTICATED", "Raw subscription creation stopped"))?
    }
    #[cfg(test)]
    async fn raw_unsubscribe(&self, window: &str, id: Id) -> HostResult<()> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let instance = self
            .instances
            .lock()
            .expect("window instances")
            .active
            .get(window)
            .copied()
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance closed"))?;
        self.raw_unsubscribe_for_instance(window, instance, id)
            .await
    }
    async fn raw_unsubscribe_for_instance(
        &self,
        window: &str,
        instance: u64,
        id: Id,
    ) -> HostResult<()> {
        use serial_workbench_core::{RpcReply, RpcRequest};
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let (slot, generation) = {
            let state = self.inner.lock().await;
            let connected = state
                .windows
                .get(window)
                .filter(|connected| connected.instance == instance)
                .ok_or_else(|| {
                    HostError::new("EPOCH_MISMATCH", "Window Host connection changed")
                })?;
            (connected.raw.clone(), connected.generation)
        };
        let Some(raw) = slot.lock().await.clone() else {
            return Ok(());
        };
        let subscription = {
            let mut subscriptions = raw.subscriptions.lock().expect("raw subscriptions");
            let item = subscriptions.active.remove(&id);
            subscriptions
                .ledger
                .lock()
                .expect("delivery ledger")
                .close(&DeliveryKey {
                    generation,
                    subscription_id: id.clone(),
                    stream: DeliveryStream::Data,
                });
            item
        };
        let Some(subscription) = subscription else {
            return Ok(());
        };
        match raw
            .connection
            .request(RpcRequest::SubscriptionClose(make_close_query(
                subscription.query,
                &id,
            )))
            .await?
        {
            RpcReply::Success { .. } => Ok(()),
            RpcReply::Failure { error, .. } => Err(error),
        }
    }
    #[cfg(test)]
    async fn raw_request(
        &self,
        window: &str,
        request: serial_workbench_core::RpcRequest,
    ) -> HostResult<serial_workbench_core::RpcReply> {
        let instance = self
            .instances
            .lock()
            .expect("window instances")
            .active
            .get(window)
            .copied()
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance closed"))?;
        self.raw_request_for_instance(window, instance, request)
            .await
    }
    async fn raw_request_for_instance(
        &self,
        window: &str,
        instance: u64,
        request: serial_workbench_core::RpcRequest,
    ) -> HostResult<serial_workbench_core::RpcReply> {
        use serial_workbench_core::RpcRequest;
        if matches!(
            &request,
            RpcRequest::StreamSubscribe(_) | RpcRequest::SubscriptionClose(_)
        ) || matches!(&request, RpcRequest::Query(query) if matches!(query.action_id.as_str(), "stream.subscribe" | "subscription.close"))
        {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Request requires a bridge subscription command",
            ));
        }
        let attachment = self.attachment_for_instance(window, instance).await?;
        self.raw_request_at_generation(window, attachment.generation, request)
            .await
    }
    async fn raw_subscribe_inner(
        &self,
        window: &str,
        instance: u64,
        query: serial_workbench_core::Query,
        channel: tauri::ipc::Channel<serial_workbench_core::RawBatch>,
        lifecycle: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
    ) -> HostResult<Id> {
        use serial_workbench_core::{RpcReply, RpcRequest, RpcResult};
        let attached = self.attachment_for_instance(window, instance).await?;
        let raw = self
            .raw_link_at_generation(window, attached.generation)
            .await?;
        let setup = PendingFrames::begin(
            &raw.subscriptions.lock().expect("raw subscriptions").setups,
            query.request_id.clone(),
        )?;
        let reply = raw
            .connection
            .request(RpcRequest::StreamSubscribe(query.clone()))
            .await?;
        let id = match reply {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Subscription(value) => value.subscription_id,
                _ => {
                    return Err(HostError::new(
                        "INVALID_ARGUMENT",
                        "Invalid raw subscription reply",
                    ));
                }
            },
            RpcReply::Failure { error, .. } => return Err(error),
        };
        let slot = {
            let state = self.inner.lock().await;
            state
                .windows
                .get(window)
                .filter(|connected| {
                    connected.generation == attached.generation.get()
                        && connected.instance == instance
                        && self
                            .instances
                            .lock()
                            .expect("window instances")
                            .current(window, instance)
                })
                .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window Host connection changed"))?
                .raw
                .clone()
        };
        let current_raw = slot
            .lock()
            .await
            .clone()
            .ok_or_else(|| HostError::new("UNAUTHENTICATED", "Raw connection closed"))?;
        if !std::sync::Arc::ptr_eq(&raw, &current_raw) {
            let _ = raw
                .connection
                .request(RpcRequest::SubscriptionClose(make_close_query(query, &id)))
                .await;
            return Err(HostError::new(
                "UNAUTHENTICATED",
                "Raw connection changed during subscription setup",
            ));
        }
        let mut subscriptions = raw.subscriptions.lock().expect("raw subscriptions");
        subscriptions.active.insert(
            id.clone(),
            RawSubscription {
                query,
                channel,
                lifecycle,
            },
        );
        for frame in setup.take() {
            let matches = match &frame.body {
                serial_workbench_core::IpcMessage::RawBatch { batch } => {
                    batch.subscription_id == id
                }
                serial_workbench_core::IpcMessage::SubscriptionEnded {
                    subscription_id, ..
                } => subscription_id == &id,
                _ => false,
            };
            if matches
                && let Some(query) =
                    deliver_raw(&mut subscriptions, attached.generation.get(), frame)
            {
                let connection = raw.connection.clone();
                let id = id.clone();
                tokio::spawn(async move {
                    let _ = connection
                        .request(serial_workbench_core::RpcRequest::SubscriptionClose(
                            make_close_query(query, &id),
                        ))
                        .await;
                });
            }
        }
        if subscriptions.failed {
            let connection = raw.connection.clone();
            tokio::spawn(async move {
                let _ = connection.close().await;
            });
            return Err(HostError::new("UNAUTHENTICATED", "Raw connection closed"));
        }
        Ok(id)
    }
    pub(crate) async fn raw_request_at_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
        request: serial_workbench_core::RpcRequest,
    ) -> HostResult<serial_workbench_core::RpcReply> {
        let raw = self.raw_link_at_generation(window, generation).await?;
        let result = raw.connection.request(request).await;
        let state = self.inner.lock().await;
        if !state.windows.get(window).is_some_and(|connected| {
            connected.generation == generation.get()
                && self
                    .instances
                    .lock()
                    .expect("window instances")
                    .current(window, connected.instance)
        }) {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Window Host connection changed; the request may have completed",
            ));
        }
        result
    }
    async fn raw_link_at_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
    ) -> HostResult<std::sync::Arc<RawLink>> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let (client, raw, ledger) = {
            let state = self.inner.lock().await;
            let connected = state
                .windows
                .get(window)
                .filter(|connected| {
                    connected.generation == generation.get()
                        && self
                            .instances
                            .lock()
                            .expect("window instances")
                            .current(window, connected.instance)
                })
                .ok_or_else(|| {
                    HostError::new("EPOCH_MISMATCH", "Window Host connection changed")
                })?;
            (
                connected.client.clone(),
                connected.raw.clone(),
                state.ledgers.get(window).expect("window ledger").clone(),
            )
        };
        let raw = {
            let mut slot = raw.lock().await;
            if slot.is_none() {
                let connection = std::sync::Arc::new(client.connect_raw().await?);
                let subscriptions = std::sync::Arc::new(std::sync::Mutex::new(RawSubscriptions {
                    active: HashMap::new(),
                    setups: Default::default(),
                    ledger,
                    failed: false,
                }));
                let events = subscriptions.clone();
                let reader = connection.clone();
                let owner_slot = std::sync::Arc::downgrade(&raw);
                let pump = tokio::spawn(async move {
                    while let Ok(Some(frame)) = reader.next_event().await {
                        let id = match &frame.body {
                            serial_workbench_core::IpcMessage::RawBatch { batch } => {
                                batch.subscription_id.clone()
                            }
                            serial_workbench_core::IpcMessage::SubscriptionEnded {
                                subscription_id,
                                ..
                            } => subscription_id.clone(),
                            _ => continue,
                        };
                        let mut events = events.lock().expect("raw subscriptions");
                        if events.active.contains_key(&id) {
                            let close = deliver_raw(&mut events, generation.get(), frame);
                            let failed = events.failed;
                            drop(events);
                            if let Some(query) = close {
                                let connection = reader.clone();
                                tokio::spawn(async move {
                                    let _ = connection
                                        .request(
                                            serial_workbench_core::RpcRequest::SubscriptionClose(
                                                make_close_query(query, &id),
                                            ),
                                        )
                                        .await;
                                });
                            }
                            if failed {
                                break;
                            }
                        } else if events
                            .setups
                            .lock()
                            .expect("pending subscription frames")
                            .push(frame)
                            .is_err()
                        {
                            break;
                        }
                    }
                    {
                        let mut events = events.lock().expect("raw subscriptions");
                        let pending: Vec<_> = events
                            .active
                            .iter()
                            .map(|(id, item)| (id.clone(), item.query.request_id.clone()))
                            .collect();
                        for (id, request_id) in pending {
                            let frame = serial_workbench_core::WireFrame {
                                request_id,
                                channel: serial_workbench_core::IpcChannel::Raw,
                                body: serial_workbench_core::IpcMessage::SubscriptionEnded {
                                    subscription_id: id,
                                    error: HostError::new(
                                        "UNAUTHENTICATED",
                                        "Raw connection closed",
                                    ),
                                },
                            };
                            let _ = deliver_raw(&mut events, generation.get(), frame);
                        }
                    }
                    let _ = reader.close().await;
                    if let Some(owner_slot) = owner_slot.upgrade() {
                        tokio::spawn(async move {
                            let mut slot = owner_slot.lock().await;
                            if slot.as_ref().is_some_and(|link| {
                                std::sync::Arc::ptr_eq(&link.connection, &reader)
                            }) {
                                slot.take();
                            }
                        });
                    }
                });
                *slot = Some(std::sync::Arc::new(RawLink {
                    connection,
                    subscriptions,
                    pump,
                }));
            }
            slot.as_ref().expect("raw connection").clone()
        };
        Ok(raw)
    }
    async fn delivery_ack(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
        subscription_id: Id,
        stream: DeliveryStream,
        ordinal: serial_workbench_core::U64,
    ) -> HostResult<()> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let ledger = self
            .inner
            .lock()
            .await
            .ledgers
            .get(window)
            .cloned()
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window Host connection changed"))?;
        ledger.lock().expect("delivery ledger").acknowledge(
            &DeliveryKey {
                generation: generation.get(),
                subscription_id,
                stream,
            },
            ordinal.get(),
        )
    }
    pub(crate) async fn control_attachment_at_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
    ) -> HostResult<serial_workbench_core::AttachResult> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let state = self.inner.lock().await;
        let connected = state
            .windows
            .get(window)
            .filter(|connected| {
                connected.generation == generation.get()
                    && self
                        .instances
                        .lock()
                        .expect("window instances")
                        .current(window, connected.instance)
            })
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window Host connection changed"))?;
        Ok(connected.control.attachment().clone())
    }
    pub(crate) async fn control_request_at_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
        request: serial_workbench_core::RpcRequest,
    ) -> HostResult<serial_workbench_core::RpcReply> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let client = {
            let state = self.inner.lock().await;
            state
                .windows
                .get(window)
                .filter(|connected| {
                    connected.generation == generation.get()
                        && self
                            .instances
                            .lock()
                            .expect("window instances")
                            .current(window, connected.instance)
                })
                .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window Host connection changed"))?
                .control
                .clone()
        };
        let result = client.request(request).await;
        let state = self.inner.lock().await;
        if !state.windows.get(window).is_some_and(|connected| {
            connected.generation == generation.get()
                && self
                    .instances
                    .lock()
                    .expect("window instances")
                    .current(window, connected.instance)
        }) {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Window Host connection changed; the request may have completed",
            ));
        }
        result
    }
    #[cfg(test)]
    fn new_with_limits(profile: std::path::PathBuf, items: usize, bytes: usize) -> Self {
        let mut bridge = Self::new(profile);
        bridge.delivery_limits = (items, bytes);
        bridge
    }
    pub(crate) async fn attachment_for_instance(
        &self,
        window: &str,
        instance: u64,
    ) -> HostResult<DesktopAttachment> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let state = self.inner.lock().await;
        let connected = state
            .windows
            .get(window)
            .filter(|connected| {
                connected.instance == instance
                    && self
                        .instances
                        .lock()
                        .expect("window instances")
                        .current(window, instance)
            })
            .ok_or_else(|| {
                HostError::new(
                    "EPOCH_MISMATCH",
                    "Window Host connection changed; attach explicitly",
                )
            })?;
        Ok(DesktopAttachment {
            attachment: connected.client.attachment().clone(),
            generation: connected.generation.into(),
        })
    }
    pub(crate) async fn attachment_at_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
    ) -> HostResult<serial_workbench_core::AttachResult> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let state = self.inner.lock().await;
        let connected = state
            .windows
            .get(window)
            .filter(|connected| {
                connected.generation == generation.get()
                    && self
                        .instances
                        .lock()
                        .expect("window instances")
                        .current(window, connected.instance)
            })
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window Host connection changed"))?;
        Ok(connected.client.attachment().clone())
    }
    pub(crate) async fn request_at_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
        request: serial_workbench_core::RpcRequest,
    ) -> HostResult<serial_workbench_core::RpcReply> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let client = {
            let state = self.inner.lock().await;
            state
                .windows
                .get(window)
                .filter(|connected| {
                    connected.generation == generation.get()
                        && self
                            .instances
                            .lock()
                            .expect("window instances")
                            .current(window, connected.instance)
                })
                .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window Host connection changed"))?
                .client
                .clone()
        };
        let result = client.request(request).await;
        let state = self.inner.lock().await;
        if !state.windows.get(window).is_some_and(|connected| {
            connected.generation == generation.get()
                && self
                    .instances
                    .lock()
                    .expect("window instances")
                    .current(window, connected.instance)
        }) {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Window Host connection changed; the request may have completed",
            ));
        }
        result
    }
    #[cfg(test)]
    async fn destroy_window(&self, window: &str, generation: serial_workbench_core::U64) {
        let mut state = self.inner.lock().await;
        if state
            .windows
            .get(window)
            .is_some_and(|connected| connected.generation == generation.get())
        {
            state.windows.remove(window);
        }
    }
    pub(crate) fn new(profile: std::path::PathBuf) -> Self {
        Self {
            profile,
            inner: std::sync::Arc::new(tokio::sync::Mutex::new(BridgeState::default())),
            initialization: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            instances: std::sync::Arc::new(std::sync::Mutex::new(WindowInstances::new())),
            delivery_limits: (256, 4 * 1024 * 1024),
        }
    }
    #[cfg(test)]
    pub(crate) async fn attach(&self, window: &str) -> HostResult<DesktopAttachment> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let instance = {
            let mut instances = self.instances.lock().expect("window instances");
            instances
                .active
                .get(window)
                .copied()
                .unwrap_or_else(|| instances.create(window))
        };
        self.attach_guarded(window, instance, async {}, async { Ok(()) })
            .await
    }
    pub(crate) async fn attach_guarded<
        F: std::future::Future<Output = ()>,
        G: std::future::Future<Output = HostResult<()>>,
    >(
        &self,
        window: &str,
        instance: u64,
        after_attach: F,
        first_start: G,
    ) -> HostResult<DesktopAttachment> {
        let _initialization = self.initialization.lock().await;
        let mut closed = self
            .instances
            .lock()
            .expect("window instances")
            .subscribe_closed(window, instance)
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance closed"))?;
        {
            let mut state = self.inner.lock().await;
            if let Some(connected) = state.windows.get(window) {
                if connected.instance == instance {
                    return Ok(DesktopAttachment {
                        attachment: connected.client.attachment().clone(),
                        generation: connected.generation.into(),
                    });
                }
                state.windows.remove(window);
                state.ledgers.remove(window);
            }
        }
        let connect = async {
            let options = serial_workbench_client::ConnectOptions::new(
                self.profile.clone(),
                Id::try_from("desktop").expect("desktop identity"),
                serial_workbench_core::ClientKind::Desktop,
            );
            let fresh = match std::fs::symlink_metadata(self.profile.join("host-v0")) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Ok(_) => false,
                Err(_) => {
                    return Err(HostError::new(
                        "STORAGE_UNAVAILABLE",
                        "Host profile is unavailable",
                    ));
                }
            };
            let prestarted = if fresh {
                first_start.await?;
                Some(std::sync::Arc::new(
                    serial_workbench_client::HostClient::connect_or_start(options.clone()).await?,
                ))
            } else {
                None
            };
            let credential = serial_workbench_client::read_user_control_credential(&self.profile)?;
            let mut control_options = options.clone();
            control_options.user_control_credential = Some(credential);
            let control = std::sync::Arc::new(
                serial_workbench_client::HostClient::connect_or_start(control_options).await?,
            );
            let client = match prestarted {
                Some(client) => client,
                None => std::sync::Arc::new(
                    serial_workbench_client::HostClient::connect_or_start(options).await?,
                ),
            };
            if control.attachment().host_id != client.attachment().host_id
                || control.attachment().instance_epoch != client.attachment().instance_epoch
            {
                return Err(HostError::new(
                    "EPOCH_MISMATCH",
                    "Host changed while attaching",
                ));
            }
            after_attach.await;
            Ok::<_, HostError>((client, control))
        };
        let (client, control) = tokio::select! {
            result = connect => result?,
            _ = closed.changed() => return Err(HostError::new("EPOCH_MISMATCH", "Window instance closed")),
        };
        let mut state = self.inner.lock().await;
        if !self
            .instances
            .lock()
            .expect("window instances")
            .current(window, instance)
        {
            return Err(HostError::new("EPOCH_MISMATCH", "Window instance closed"));
        }
        state.next_generation = state.next_generation.checked_add(1).ok_or_else(|| {
            HostError::new("COUNTER_EXHAUSTED", "Connection generation exhausted")
        })?;
        let generation = state.next_generation;
        let attachment = DesktopAttachment {
            attachment: client.attachment().clone(),
            generation: generation.into(),
        };
        let ledger = state
            .ledgers
            .entry(window.to_owned())
            .or_insert_with(|| {
                std::sync::Arc::new(std::sync::Mutex::new(DeliveryLedger::new(
                    self.delivery_limits.0,
                    self.delivery_limits.1,
                )))
            })
            .clone();
        let subscriptions = std::sync::Arc::new(std::sync::Mutex::new(Subscriptions {
            active: HashMap::new(),
            setups: Default::default(),
            ledger,
            failed: false,
        }));
        let events = subscriptions.clone();
        let source = client.clone();
        let owner = std::sync::Arc::downgrade(&self.inner);
        let owner_label = window.to_owned();
        let pump = tokio::spawn(async move {
            while let Ok(Some(frame)) = source.next_event().await {
                let id = match &frame.body {
                    serial_workbench_core::IpcMessage::Delta {
                        subscription_id, ..
                    }
                    | serial_workbench_core::IpcMessage::SubscriptionEnded {
                        subscription_id,
                        ..
                    } => subscription_id,
                    _ => continue,
                };
                let id = id.clone();
                let mut subscriptions = events.lock().expect("subscription lock");
                if subscriptions.active.contains_key(&id) {
                    let close = deliver_state(&mut subscriptions, generation, frame);
                    let failed = subscriptions.failed;
                    drop(subscriptions);
                    if let Some(query) = close {
                        let client = source.clone();
                        tokio::spawn(async move {
                            let _ = close_subscription(client, query, id).await;
                        });
                    }
                    if failed {
                        break;
                    }
                } else if subscriptions
                    .setups
                    .lock()
                    .expect("pending subscription frames")
                    .push(frame)
                    .is_err()
                {
                    break;
                }
            }
            {
                let mut subscriptions = events.lock().expect("subscription lock");
                let pending: Vec<_> = subscriptions
                    .active
                    .iter()
                    .map(|(id, item)| (id.clone(), item.query.request_id.clone()))
                    .collect();
                for (id, request_id) in pending {
                    let frame = serial_workbench_core::WireFrame {
                        request_id,
                        channel: serial_workbench_core::IpcChannel::State,
                        body: serial_workbench_core::IpcMessage::SubscriptionEnded {
                            subscription_id: id,
                            error: HostError::new("UNAUTHENTICATED", "Host connection closed"),
                        },
                    };
                    let _ = deliver_state(&mut subscriptions, generation, frame);
                }
            }
            let _ = source.close().await;
            if let Some(owner) = owner.upgrade() {
                tokio::spawn(async move {
                    let mut state = owner.lock().await;
                    if state
                        .windows
                        .get(&owner_label)
                        .is_some_and(|connected| connected.generation == generation)
                    {
                        state.windows.remove(&owner_label);
                    }
                });
            }
        });
        state.windows.insert(
            window.to_owned(),
            BridgeWindow {
                instance,
                generation,
                client,
                control,
                raw: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
                subscriptions,
                pump,
                effects_pump: None,
                effects_registration: None,
            },
        );
        Ok(attachment)
    }
    #[cfg(test)]
    pub(crate) async fn request(
        &self,
        window: &str,
        request: serial_workbench_core::RpcRequest,
    ) -> HostResult<serial_workbench_core::RpcReply> {
        let instance = self
            .instances
            .lock()
            .expect("window instances")
            .active
            .get(window)
            .copied()
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance closed"))?;
        self.request_for_instance(window, instance, request).await
    }
    async fn request_for_instance(
        &self,
        window: &str,
        instance: u64,
        request: serial_workbench_core::RpcRequest,
    ) -> HostResult<serial_workbench_core::RpcReply> {
        let attached = self.attachment_for_instance(window, instance).await?;
        self.request_for_generation(window, attached.generation, request)
            .await
    }
    async fn request_for_generation(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
        request: serial_workbench_core::RpcRequest,
    ) -> HostResult<serial_workbench_core::RpcReply> {
        use serial_workbench_core::RpcRequest;
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        if matches!(
            &request,
            RpcRequest::Attach(_)
                | RpcRequest::ClientRegister(_)
                | RpcRequest::ClientUnregister(_)
                | RpcRequest::ClientReceipt(_)
                | RpcRequest::StateSubscribe(_)
                | RpcRequest::StreamSubscribe(_)
                | RpcRequest::SubscriptionClose(_)
        ) {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Request requires a bridge subscription command",
            ));
        }
        if matches!(&request, RpcRequest::Query(query) if matches!(query.action_id.as_str(), "state.subscribe" | "stream.subscribe" | "subscription.close" | "file.register" | "auth.authorize" | "auth.revoke" | "client.register" | "client.unregister" | "client.receipt"))
            || matches!(&request, RpcRequest::Invoke(call) if matches!(call.action_id.as_str(), "file.register" | "auth.authorize" | "auth.revoke" | "client.register" | "client.unregister" | "client.receipt"))
            || matches!(&request, RpcRequest::InvokeChild(call) if matches!(call.action_id.as_str(), "file.register" | "auth.authorize" | "auth.revoke" | "client.register" | "client.unregister" | "client.receipt"))
        {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Request requires a trusted bridge command",
            ));
        }
        self.request_at_generation(window, generation, request)
            .await
    }
    pub(crate) async fn with_current_generation<T>(
        &self,
        window: &str,
        generation: serial_workbench_core::U64,
        apply: impl FnOnce() -> HostResult<T>,
    ) -> HostResult<T> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let state = self.inner.lock().await;
        if !state.windows.get(window).is_some_and(|connected| {
            connected.generation == generation.get()
                && self
                    .instances
                    .lock()
                    .expect("window instances")
                    .current(window, connected.instance)
        }) {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Window Host connection changed",
            ));
        }
        apply()
    }
    #[cfg(test)]
    async fn subscribe(
        &self,
        window: &str,
        query: serial_workbench_core::Query,
        channel: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
    ) -> HostResult<Id> {
        let instance = self
            .instances
            .lock()
            .expect("window instances")
            .active
            .get(window)
            .copied()
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance closed"))?;
        self.subscribe_for_instance(window, instance, query, channel)
            .await
    }
    async fn subscribe_for_instance(
        &self,
        window: &str,
        instance: u64,
        query: serial_workbench_core::Query,
        channel: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
    ) -> HostResult<Id> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let bridge = self.clone();
        let window = window.to_owned();
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let result = bridge
                .subscribe_inner(&window, instance, query, channel)
                .await;
            if let Err(Ok(id)) = send.send(result) {
                let _ = bridge.unsubscribe_for_instance(&window, instance, id).await;
            }
        });
        receive
            .await
            .map_err(|_| HostError::new("UNAUTHENTICATED", "Subscription creation stopped"))?
    }
    async fn subscribe_inner(
        &self,
        window: &str,
        instance: u64,
        query: serial_workbench_core::Query,
        channel: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
    ) -> HostResult<Id> {
        use serial_workbench_core::{RpcReply, RpcRequest, RpcResult};
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let attached = self.attachment_for_instance(window, instance).await?;
        let (client, subscriptions, generation) = {
            let state = self.inner.lock().await;
            let connected = state
                .windows
                .get(window)
                .filter(|connected| {
                    connected.instance == instance
                        && connected.generation == attached.generation.get()
                })
                .ok_or_else(|| {
                    HostError::new("EPOCH_MISMATCH", "Window Host connection changed")
                })?;
            (
                connected.client.clone(),
                connected.subscriptions.clone(),
                connected.generation,
            )
        };
        let setup = PendingFrames::begin(
            &subscriptions.lock().expect("subscription lock").setups,
            query.request_id.clone(),
        )?;
        let result = client
            .request(RpcRequest::StateSubscribe(query.clone()))
            .await?;
        let id = match result {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Subscription(value) => value.subscription_id,
                _ => {
                    return Err(HostError::new(
                        "INVALID_ARGUMENT",
                        "Invalid subscription reply",
                    ));
                }
            },
            RpcReply::Failure { error, .. } => return Err(error),
        };
        let alive = {
            let state = self.inner.lock().await;
            state.windows.get(window).is_some_and(|connected| {
                connected.instance == instance && connected.generation == generation
            })
        };
        let instance_current = self
            .instances
            .lock()
            .expect("window instances")
            .current(window, instance);
        if !alive || !instance_current {
            let _ = close_subscription(client, query, id).await;
            return Err(HostError::new("EPOCH_MISMATCH", "Window instance closed"));
        }
        let mut subscriptions = subscriptions.lock().expect("subscription lock");
        subscriptions.active.insert(
            id.clone(),
            Subscription {
                query,
                channel: channel.clone(),
            },
        );
        for frame in setup.take() {
            let matches = match &frame.body {
                serial_workbench_core::IpcMessage::Delta {
                    subscription_id, ..
                }
                | serial_workbench_core::IpcMessage::SubscriptionEnded {
                    subscription_id, ..
                } => subscription_id == &id,
                _ => false,
            };
            if matches && let Some(query) = deliver_state(&mut subscriptions, generation, frame) {
                let client = client.clone();
                let id = id.clone();
                tokio::spawn(async move {
                    let _ = close_subscription(client, query, id).await;
                });
            }
        }
        if subscriptions.failed {
            let connection = client.clone();
            tokio::spawn(async move {
                let _ = connection.close().await;
            });
            return Err(HostError::new("UNAUTHENTICATED", "Host connection closed"));
        }
        Ok(id)
    }
    #[cfg(test)]
    async fn unsubscribe(&self, window: &str, id: Id) -> HostResult<()> {
        let instance = self
            .instances
            .lock()
            .expect("window instances")
            .active
            .get(window)
            .copied()
            .ok_or_else(|| HostError::new("EPOCH_MISMATCH", "Window instance closed"))?;
        self.unsubscribe_for_instance(window, instance, id).await
    }
    async fn unsubscribe_for_instance(
        &self,
        window: &str,
        instance: u64,
        id: Id,
    ) -> HostResult<()> {
        crate::commands::require_host_window(window)
            .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot access Host"))?;
        let (client, subscriptions, generation) = {
            let state = self.inner.lock().await;
            let connected = state
                .windows
                .get(window)
                .filter(|connected| connected.instance == instance)
                .ok_or_else(|| HostError::new("UNAUTHENTICATED", "Window disconnected"))?;
            (
                connected.client.clone(),
                connected.subscriptions.clone(),
                connected.generation,
            )
        };
        let subscription = {
            let mut subscriptions = subscriptions.lock().expect("subscription lock");
            let subscription = subscriptions.active.remove(&id);
            subscriptions
                .ledger
                .lock()
                .expect("delivery ledger")
                .close(&DeliveryKey {
                    generation,
                    subscription_id: id.clone(),
                    stream: DeliveryStream::Data,
                });
            subscription
        };
        let Some(subscription) = subscription else {
            return Ok(());
        };
        close_subscription(client, subscription.query, id).await
    }
}

fn deliver_raw(
    subscriptions: &mut RawSubscriptions,
    generation: u64,
    frame: serial_workbench_core::WireFrame,
) -> Option<serial_workbench_core::Query> {
    use serial_workbench_core::IpcMessage;
    let (id, stream) = match &frame.body {
        IpcMessage::RawBatch { batch } => (batch.subscription_id.clone(), DeliveryStream::Data),
        IpcMessage::SubscriptionEnded {
            subscription_id, ..
        } => (subscription_id.clone(), DeliveryStream::Lifecycle),
        _ => return None,
    };
    let subscription = subscriptions.active.get(&id)?;
    let data = subscription.channel.clone();
    let lifecycle = subscription.lifecycle.clone();
    let key = DeliveryKey {
        generation,
        subscription_id: id.clone(),
        stream,
    };
    let size = serial_workbench_ipc::frame::encoded_length(
        &frame,
        serial_workbench_ipc::frame::MAX_FRAME_BYTES,
    )
    .ok();
    let mut ledger = subscriptions.ledger.lock().expect("delivery ledger");
    let accepted = size.is_some_and(|size| {
        if stream == DeliveryStream::Lifecycle {
            ledger
                .reserve(&key, size)
                .or_else(|_| ledger.reserve_terminal(&key, size).map(|_| 0))
                .is_ok()
        } else {
            ledger.reserve(&key, size).is_ok()
        }
    });
    let sent = if accepted {
        match &frame.body {
            IpcMessage::RawBatch { batch } => data.send((**batch).clone()).is_ok(),
            IpcMessage::SubscriptionEnded { .. } => lifecycle.send(frame.clone()).is_ok(),
            _ => false,
        }
    } else {
        false
    };
    if sent {
        if stream == DeliveryStream::Lifecycle {
            ledger.close(&key);
            subscriptions.active.remove(&id);
        }
        return None;
    }
    let subscription = subscriptions.active.remove(&id)?;
    let terminal = if stream == DeliveryStream::Lifecycle {
        frame.clone()
    } else {
        serial_workbench_core::WireFrame {
            request_id: frame.request_id,
            channel: serial_workbench_core::IpcChannel::Raw,
            body: IpcMessage::SubscriptionEnded {
                subscription_id: id.clone(),
                error: HostError::new("CURSOR_EXPIRED", "Raw delivery capacity exhausted"),
            },
        }
    };
    let terminal_key = DeliveryKey {
        generation,
        subscription_id: id,
        stream: DeliveryStream::Lifecycle,
    };
    let size = serial_workbench_ipc::frame::encoded_length(
        &terminal,
        serial_workbench_ipc::frame::MAX_FRAME_BYTES,
    )
    .ok();
    let terminal_sent = size
        .is_some_and(|size| ledger.reserve_terminal(&terminal_key, size).is_ok())
        && lifecycle.send(terminal).is_ok();
    if !terminal_sent {
        subscriptions.failed = true;
    }
    ledger.close(&key);
    ledger.close(&terminal_key);
    Some(subscription.query)
}

fn deliver_state(
    subscriptions: &mut Subscriptions,
    generation: u64,
    frame: serial_workbench_core::WireFrame,
) -> Option<serial_workbench_core::Query> {
    use serial_workbench_core::IpcMessage;
    let id = match &frame.body {
        IpcMessage::Delta {
            subscription_id, ..
        }
        | IpcMessage::SubscriptionEnded {
            subscription_id, ..
        } => subscription_id.clone(),
        _ => return None,
    };
    let channel = subscriptions.active.get(&id)?.channel.clone();
    let key = DeliveryKey {
        generation,
        subscription_id: id.clone(),
        stream: DeliveryStream::Data,
    };
    let size = serial_workbench_ipc::frame::encoded_length(
        &frame,
        serial_workbench_ipc::frame::MAX_FRAME_BYTES,
    )
    .ok();
    let is_terminal = matches!(frame.body, IpcMessage::SubscriptionEnded { .. });
    let accepted = size.is_some_and(|size| {
        let mut ledger = subscriptions.ledger.lock().expect("delivery ledger");
        if is_terminal {
            // 正常终态也消耗普通预算；唯一应急槽只用于普通容量真正耗尽。
            ledger
                .reserve(&key, size)
                .or_else(|_| ledger.reserve_terminal(&key, size).map(|_| 0))
                .is_ok()
        } else {
            ledger.reserve(&key, size).is_ok()
        }
    });
    if accepted && channel.send(frame.clone()).is_ok() {
        if matches!(frame.body, IpcMessage::SubscriptionEnded { .. }) {
            subscriptions
                .ledger
                .lock()
                .expect("delivery ledger")
                .close(&key);
            subscriptions.active.remove(&id);
        }
        return None;
    }
    let subscription = subscriptions.active.remove(&id)?;
    let terminal = if is_terminal {
        frame.clone()
    } else {
        serial_workbench_core::WireFrame {
            request_id: frame.request_id,
            channel: serial_workbench_core::IpcChannel::State,
            body: IpcMessage::SubscriptionEnded {
                subscription_id: id,
                error: HostError::new("CURSOR_EXPIRED", "Subscription delivery capacity exhausted"),
            },
        }
    };
    let terminal_size = serial_workbench_ipc::frame::encoded_length(
        &terminal,
        serial_workbench_ipc::frame::MAX_FRAME_BYTES,
    )
    .ok();
    let mut ledger = subscriptions.ledger.lock().expect("delivery ledger");
    let terminal_sent = terminal_size
        .is_some_and(|size| ledger.reserve_terminal(&key, size).is_ok())
        && channel.send(terminal).is_ok();
    if !terminal_sent {
        subscriptions.failed = true;
    }
    ledger.close(&key);
    Some(subscription.query)
}

async fn close_subscription(
    client: std::sync::Arc<serial_workbench_client::HostClient>,
    query: serial_workbench_core::Query,
    id: Id,
) -> HostResult<()> {
    use serial_workbench_core::{RpcReply, RpcRequest};
    match client
        .request(RpcRequest::SubscriptionClose(make_close_query(query, &id)))
        .await?
    {
        RpcReply::Success { .. } => Ok(()),
        RpcReply::Failure { error, .. } => Err(error),
    }
}
fn make_close_query(
    mut query: serial_workbench_core::Query,
    id: &Id,
) -> serial_workbench_core::Query {
    use serial_workbench_core::RequestId;
    query.action_id = Id::try_from("subscription.close").expect("action ID");
    use sha2::Digest;
    let token = serial_workbench_ipc::identity::random_token();
    let hex = format!("{:x}", sha2::Sha256::digest(token.as_str().as_bytes()));
    let value = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    );
    query.request_id = RequestId::try_from(value.as_str()).expect("request ID");
    query.params =
        serde_json::from_value(serde_json::json!({ "subscriptionId": id })).expect("close params");
    query
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_connect_device(
    window: tauri::WebviewWindow,
    generation: serial_workbench_core::U64,
    device_id: Id,
    params: serial_workbench_core::OpenParams,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<serial_workbench_core::SessionSnapshot> {
    state.bind_window(&window)?;
    state
        .connect_device_intent(window.label(), generation, device_id, params)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_attachment(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<DesktopAttachment> {
    use platform_effects::PlatformEffectExecutor;
    use tauri::Manager;
    let instance = state.bind_window(&window)?;
    let attachment = state
        .attach_guarded(window.label(), instance, async {}, async { Ok(()) })
        .await?;
    let executor = std::sync::Arc::new(platform_effects::PlatformEffects::new(
        window.app_handle().clone(),
        window.clone(),
        attachment.generation,
    ));
    if !executor.capabilities().is_empty() {
        state
            .start_effects(window.label(), attachment.generation, executor)
            .await?;
    }
    Ok(attachment)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_request(
    window: tauri::WebviewWindow,
    request: serial_workbench_core::RpcRequest,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<serial_workbench_core::RpcReply> {
    let instance = state.bind_window(&window)?;
    state
        .request_for_instance(window.label(), instance, request)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_subscribe(
    window: tauri::WebviewWindow,
    request: serial_workbench_core::Query,
    channel: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<Id> {
    let instance = state.bind_window(&window)?;
    state
        .subscribe_for_instance(window.label(), instance, request, channel)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_unsubscribe(
    window: tauri::WebviewWindow,
    subscription_id: Id,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<()> {
    let instance = state.bind_window(&window)?;
    state
        .unsubscribe_for_instance(window.label(), instance, subscription_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_raw_request(
    window: tauri::WebviewWindow,
    request: serial_workbench_core::RpcRequest,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<serial_workbench_core::RpcReply> {
    let instance = state.bind_window(&window)?;
    state
        .raw_request_for_instance(window.label(), instance, request)
        .await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn host_raw_subscribe(
    window: tauri::WebviewWindow,
    request: serial_workbench_core::Query,
    channel: tauri::ipc::Channel<serial_workbench_core::RawBatch>,
    lifecycle: tauri::ipc::Channel<serial_workbench_core::WireFrame>,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<Id> {
    let instance = state.bind_window(&window)?;
    state
        .raw_subscribe_for_instance(window.label(), instance, request, channel, lifecycle)
        .await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn host_raw_unsubscribe(
    window: tauri::WebviewWindow,
    subscription_id: Id,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<()> {
    let instance = state.bind_window(&window)?;
    state
        .raw_unsubscribe_for_instance(window.label(), instance, subscription_id)
        .await
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn host_delivery_ack(
    window: tauri::WebviewWindow,
    generation: serial_workbench_core::U64,
    subscription_id: Id,
    stream: DeliveryStream,
    ordinal: serial_workbench_core::U64,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<()> {
    state.bind_window(&window)?;
    state
        .delivery_ack(window.label(), generation, subscription_id, stream, ordinal)
        .await
}
