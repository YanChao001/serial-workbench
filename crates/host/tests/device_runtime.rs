use serial_workbench_core::*;
use serial_workbench_host::{
    device::{DeviceProvider, DeviceRuntime, virtual_backend::VirtualTransport},
    state::{ProjectionLimits, ProjectionStore},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
mod support;
use support::{Gate, id};

struct Provider {
    devices: Mutex<HostResult<Vec<DeviceDescriptor>>>,
    opens: Mutex<Vec<DeviceDescriptor>>,
    gate: Mutex<Option<Arc<Gate>>>,
    active: AtomicUsize,
    overlap: AtomicBool,
}
impl DeviceProvider for Provider {
    fn enumerate(&self) -> HostResult<Vec<DeviceDescriptor>> {
        if self.active.fetch_add(1, Ordering::SeqCst) != 0 {
            self.overlap.store(true, Ordering::SeqCst);
        }
        let gate = self.gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.hold();
        }
        let result = self.devices.lock().unwrap().clone();
        self.active.fetch_sub(1, Ordering::SeqCst);
        result
    }
    fn open(
        &self,
        device: &DeviceDescriptor,
        config: &SerialConfiguration,
    ) -> BackendResult<Box<dyn Transport>> {
        self.opens.lock().unwrap().push(device.clone());
        Ok(Box::new(VirtualTransport::new(config.clone())))
    }
}
fn provider(host: &Id) -> Arc<Provider> {
    Arc::new(Provider {
        devices: Mutex::new(Ok(vec![DeviceDescriptor {
            device_id: id("provider-temporary-id"),
            host_id: host.clone(),
            system_name: "COM42".into(),
            description: None,
            manufacturer: None,
            driver: None,
            fingerprint: DeviceFingerprint {
                transport: DeviceTransportKind::Serial,
                vid: Some(1),
                pid: Some(2),
                serial_number: Some("unit-a".into()),
                topology_path: Some("socket-a".into()),
                evidence: IdentityEvidence::SerialNumber,
            },
            capabilities: VirtualTransport::new(SerialConfiguration::default()).capabilities(),
        }])),
        opens: Mutex::new(vec![]),
        gate: Mutex::new(None),
        active: AtomicUsize::new(0),
        overlap: AtomicBool::new(false),
    })
}
fn runtime(h: &support::Harness, p: Arc<Provider>) -> (Arc<DeviceRuntime>, ProjectionStore) {
    let identity = h.store.identity().unwrap();
    let projections = ProjectionStore::new(
        identity.clone(),
        h.auth.clone(),
        ProjectionLimits::default(),
    );
    (
        DeviceRuntime::new(identity, p, projections.clone()).unwrap(),
        projections,
    )
}
#[tokio::test]
async fn directory_composes_serial_virtual_and_only_publishes_real_differences() {
    let h = support::Harness::new().await;
    let p = provider(&h.host_id);
    let (runtime, projections) = runtime(&h, p.clone());
    let first = runtime.refresh().await.unwrap();
    assert_eq!(first.devices.len(), 2);
    assert!(
        first
            .devices
            .iter()
            .any(|d| d.device_id == id("virtual:echo"))
    );
    let serial = first
        .devices
        .iter()
        .find(|d| d.system_name == "COM42")
        .unwrap();
    assert_ne!(serial.device_id, id("COM42"));
    assert_ne!(serial.device_id, id("provider-temporary-id"));
    let revision = projections
        .snapshot(&h.actor, &id("host.devices"))
        .await
        .unwrap()
        .revision;
    assert_eq!(runtime.refresh().await.unwrap(), first);
    assert_eq!(
        projections
            .snapshot(&h.actor, &id("host.devices"))
            .await
            .unwrap()
            .revision,
        revision
    );
    *p.devices.lock().unwrap() = Err(HostError::new("ENUMERATION_FAILED", "injected"));
    let failed = runtime.refresh().await.unwrap();
    assert!(failed.stale);
    assert_eq!(failed.devices, first.devices);
    let stale_revision = projections
        .snapshot(&h.actor, &id("host.devices"))
        .await
        .unwrap()
        .revision;
    runtime.refresh().await.unwrap();
    assert_eq!(
        projections
            .snapshot(&h.actor, &id("host.devices"))
            .await
            .unwrap()
            .revision,
        stale_revision
    );
    runtime.stop();
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn opaque_id_resolves_trusted_locator_and_renumbering_preserves_identity() {
    let h = support::Harness::new().await;
    let p = provider(&h.host_id);
    let (runtime, _) = runtime(&h, p.clone());
    let first = runtime.refresh().await.unwrap();
    let serial = first
        .devices
        .iter()
        .find(|d| d.system_name == "COM42")
        .unwrap();
    let open = runtime.opener();
    assert!(open(&id("COM42"), &SerialConfiguration::default()).is_err());
    p.devices.lock().unwrap().as_mut().unwrap()[0].system_name = "COM43".into();
    runtime.refresh().await.unwrap();
    let mut transport = open(&serial.device_id, &SerialConfiguration::default()).unwrap();
    assert_eq!(p.opens.lock().unwrap()[0].system_name, "COM43");
    transport.close().unwrap();
    runtime.stop();
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn blocked_enumeration_is_single_flight_and_stop_does_not_wait_for_provider() {
    let h = support::Harness::new().await;
    let p = provider(&h.host_id);
    let gate = Arc::new(Gate::default());
    *p.gate.lock().unwrap() = Some(gate.clone());
    let (runtime, _) = runtime(&h, p.clone());
    gate.entered().await;
    let mut refreshes = vec![];
    for _ in 0..20 {
        let runtime = runtime.clone();
        refreshes.push(tokio::spawn(async move { runtime.refresh().await }));
    }
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert!(!p.overlap.load(Ordering::SeqCst));
    let start = Instant::now();
    runtime.stop();
    assert!(start.elapsed() < Duration::from_millis(100));
    for refresh in refreshes {
        assert!(
            tokio::time::timeout(Duration::from_secs(1), refresh)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
    gate.release();
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn only_active_responsibility_retains_opaque_identity_across_disappearance() {
    let h = support::Harness::new().await;
    let p = provider(&h.host_id);
    let (runtime, _) = runtime(&h, p.clone());
    let first = runtime.refresh().await.unwrap();
    let serial = first
        .devices
        .iter()
        .find(|d| d.system_name == "COM42")
        .unwrap()
        .clone();
    runtime.pin(&serial).unwrap();
    *p.devices.lock().unwrap() = Ok(vec![]);
    runtime.refresh().await.unwrap();
    let mut returned = serial.clone();
    returned.device_id = id("replacement-provider-id");
    returned.system_name = "COM43".into();
    *p.devices.lock().unwrap() = Ok(vec![returned.clone()]);
    let restored = runtime.refresh().await.unwrap();
    assert!(
        restored
            .devices
            .iter()
            .any(|d| d.device_id == serial.device_id && d.system_name == "COM43")
    );
    runtime.unpin(&serial.device_id);
    *p.devices.lock().unwrap() = Ok(vec![]);
    runtime.refresh().await.unwrap();
    *p.devices.lock().unwrap() = Ok(vec![returned]);
    let fresh = runtime.refresh().await.unwrap();
    assert!(
        !fresh
            .devices
            .iter()
            .any(|d| d.device_id == serial.device_id)
    );
    runtime.stop();
    h.host.shutdown().await.unwrap();
}

async fn attach(
    h: &support::Harness,
    enabled: bool,
) -> (
    Arc<DeviceRuntime>,
    Arc<Provider>,
    Target,
    Arc<Mutex<DeviceBinding>>,
) {
    let p = provider(&h.host_id);
    let (runtime, _) = runtime(h, p.clone());
    let list = runtime.refresh().await.unwrap();
    let device = list
        .devices
        .iter()
        .find(|d| d.fingerprint.transport == DeviceTransportKind::Serial)
        .unwrap();
    let target = h.device(device.device_id.as_str());
    let binding = Arc::new(Mutex::new(DeviceBinding {
        binding_id: id("probe"),
        host_id: h.host_id.clone(),
        device_id: device.device_id.clone(),
        fingerprint: device.fingerprint.clone(),
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy {
            enabled,
            ..ReconnectPolicy::default()
        },
    }));
    let saved = binding.clone();
    h.host
        .devices()
        .attach_runtime(
            runtime.clone(),
            Arc::new(move |_, reference| {
                assert_eq!(reference.workspace_id, id("bench"));
                assert_eq!(reference.binding_id, id("probe"));
                Ok(saved.lock().unwrap().clone())
            }),
        )
        .unwrap();
    (runtime, p, target, binding)
}
fn bound_params() -> OpenParams {
    OpenParams {
        configuration: SerialConfiguration::default(),
        binding: Some(DeviceBindingReference {
            workspace_id: id("bench"),
            binding_id: id("probe"),
        }),
    }
}
fn session_target(h: &support::Harness, opened: &OpenResult) -> Target {
    Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id.clone()),
        session_epoch: Some(opened.session_epoch),
    }
}
async fn await_reconnect_state(
    h: &support::Harness,
    device: &Target,
    target: &Target,
    expected: &str,
) {
    // Native open is earlier than owner installation. Wait for the existing session CAS
    // to retain the new epoch/status before making an epoch-sensitive authorized query.
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let document = h
                .store
                .read_document(&id(&format!("device:{}", device.id)))
                .unwrap()
                .unwrap();
            let snapshot: SessionSnapshot =
                serde_json::from_value(serde_json::to_value(document.value).unwrap()).unwrap();
            let value = serde_json::to_value(&snapshot).unwrap();
            if snapshot.session_epoch == target.session_epoch.unwrap()
                && value["reconnect"]["state"] == expected
            {
                let live = h.host.devices().snapshot(target).await.unwrap();
                assert_eq!(live.session_epoch, snapshot.session_epoch);
                loop {
                    let published = h
                        .host
                        .projections()
                        .snapshot(&h.actor, &id(&format!("session:{}", target.id)))
                        .await
                        .unwrap();
                    let published: SessionSnapshot =
                        serde_json::from_value(serde_json::to_value(published.state).unwrap())
                            .unwrap();
                    assert_eq!(published.session_epoch, snapshot.session_epoch);
                    if serde_json::to_value(published).unwrap()["reconnect"]["state"] == expected {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn authorized_open_keeps_success_when_recent_document_is_unwritable_and_two_actors_share_owner()
 {
    let h = support::Harness::new().await;
    let (_, _, target, _) = attach(&h, false).await;
    h.store
        .compare_and_swap_document(
            &id("host:recent-devices"),
            0.into(),
            serde_json::from_value(serde_json::json!({"formatVersion":"9.0","entries":[]}))
                .unwrap(),
        )
        .unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let first = h
        .host
        .devices()
        .open_authorized(&h.actor, &target, bound_params(), cancelled.clone())
        .await
        .unwrap();
    assert_eq!(
        first.recent_error.as_ref().unwrap().code,
        "INVALID_DOCUMENT"
    );
    let second_actor = h.new_actor("second");
    let second = h
        .host
        .devices()
        .open_authorized(&second_actor, &target, bound_params(), cancelled)
        .await
        .unwrap();
    assert!(second.reused);
    assert_eq!(first.session_id, second.session_id);
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    assert_eq!(
        h.host
            .devices()
            .snapshot(&session_target(&h, &first))
            .await
            .unwrap()
            .state,
        SessionState::Open
    );
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn cancelled_open_and_changed_binding_configuration_never_reach_owner() {
    let h = support::Harness::new().await;
    let (_, _, target, binding) = attach(&h, true).await;
    let cancelled = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &target,
            bound_params(),
            Arc::new(AtomicBool::new(true)),
        )
        .await
        .unwrap_err();
    assert_eq!(cancelled.code, "CANCELLED");
    binding.lock().unwrap().configuration.parity = Parity::Even;
    let changed = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &target,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();
    assert_eq!(changed.code, "CONFIGURATION_CONFLICT");
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 0);
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn reconnect_after_settled_disconnect_uses_same_session_new_epoch_and_does_not_replay_tx() {
    let h = support::Harness::new().await;
    let (_, _, device, _) = attach(&h, true).await;
    let first = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let old = session_target(&h, &first);
    await_reconnect_state(&h, &device, &old, "idle").await;
    let sent = h.send(&old).await;
    assert_eq!(support::receipt(&sent).outcome, TxOutcome::Accepted);
    h.probe.read_fails.store(true, Ordering::SeqCst);
    support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
    h.probe.read_fails.store(false, Ordering::SeqCst);
    await_reconnect_state(&h, &device, &old, "waiting").await;
    h.clock.advance_ms(499);
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    h.clock.advance_ms(1);
    support::until(|| h.probe.opens.load(Ordering::SeqCst) == 2).await;
    let new = Target {
        session_epoch: Some(first.session_epoch.checked_next().unwrap()),
        ..old.clone()
    };
    await_reconnect_state(&h, &device, &new, "idle").await;
    assert_eq!(h.write_count(), 1);
    let stale = h
        .host
        .invoke(
            &h.actor,
            h.call(
                &old,
                "session.tx",
                serde_json::json!({"bytesBase64":"AQ==","writeWaitMs":"100"}),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(stale.code, "EPOCH_MISMATCH");
    assert_eq!(h.write_count(), 1);
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn explicit_close_cancels_registered_reconnect_responsibility() {
    let h = support::Harness::new().await;
    let (_, _, device, _) = attach(&h, true).await;
    let opened = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let target = session_target(&h, &opened);
    let closed = h
        .action(&target, "session.close", serde_json::json!({}))
        .await;
    assert_eq!(closed.state, OperationState::Succeeded);
    h.clock.advance_ms(100000);
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn actual_revocation_stops_responsibility_and_restored_permission_does_not_revive_it() {
    let h = support::Harness::new().await;
    let (_, _, device, _) = attach(&h, true).await;
    let opened = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let target = session_target(&h, &opened);
    let operator = h
        .auth
        .authenticate_user_control(
            &id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    h.auth
        .revoke(
            &operator,
            RevokeParams {
                actor_id: h.actor.id().clone(),
                permissions: vec!["device.modify".into()],
                targets: vec![device.clone()],
            },
        )
        .unwrap();
    await_reconnect_state(&h, &device, &target, "stopped").await;
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["device.modify".into()],
                targets: vec![device],
                expires_at: None,
            },
        )
        .unwrap();
    h.probe.read_fails.store(true, Ordering::SeqCst);
    support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
    h.probe.read_fails.store(false, Ordering::SeqCst);
    h.clock.advance_ms(100000);
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    h.host.shutdown().await.unwrap();
}
#[tokio::test]
async fn binding_change_and_cancel_each_stop_future_reconnects() {
    for cause in ["binding", "cancel"] {
        let h = support::Harness::new().await;
        let (_, _, device, binding) = attach(&h, true).await;
        let cancelled = Arc::new(AtomicBool::new(false));
        let opened = h
            .host
            .devices()
            .open_authorized(&h.actor, &device, bound_params(), cancelled.clone())
            .await
            .unwrap();
        let target = session_target(&h, &opened);
        match cause {
            "binding" => binding.lock().unwrap().reconnect.enabled = false,
            "cancel" => cancelled.store(true, Ordering::SeqCst),
            _ => unreachable!(),
        }
        await_reconnect_state(&h, &device, &target, "stopped").await;
        h.probe.read_fails.store(true, Ordering::SeqCst);
        support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
        h.probe.read_fails.store(false, Ordering::SeqCst);
        h.clock.advance_ms(100000);
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1, "cause: {cause}");
        h.host.shutdown().await.unwrap();
    }
}
#[tokio::test]
async fn topology_change_is_observable_requires_rebind_and_never_opens() {
    let h = support::Harness::new().await;
    let (runtime, p, device, _) = attach(&h, true).await;
    let opened = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let target = session_target(&h, &opened);
    p.devices.lock().unwrap().as_mut().unwrap()[0]
        .fingerprint
        .topology_path = Some("different-socket".into());
    runtime.refresh().await.unwrap();
    h.probe.read_fails.store(true, Ordering::SeqCst);
    support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
    h.probe.read_fails.store(false, Ordering::SeqCst);
    h.clock.advance_ms(100000);
    await_reconnect_state(&h, &device, &target, "requires_rebind").await;
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn host_restart_advances_epoch_and_does_not_restore_old_reconnect_responsibility() {
    let h = support::Harness::new().await;
    let (_, _, device, _) = attach(&h, true).await;
    h.host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let previous = h.store.identity().unwrap();
    h.host.shutdown().await.unwrap();
    let store =
        serial_workbench_host::storage::Store::open_with_clock(h.dir.path(), h.clock.clone())
            .unwrap();
    let next = store.begin_instance().unwrap();
    assert!(next.instance_epoch > previous.instance_epoch);
    let auth = serial_workbench_host::auth::AuthService::with_clock(
        store.clone(),
        ContextToken::try_from("next-control").unwrap(),
        h.clock.clone(),
    );
    let opens = Arc::new(AtomicUsize::new(0));
    let count = opens.clone();
    let host = serial_workbench_host::Host::with_runtime(
        store,
        auth,
        h.clock.clone(),
        Arc::new(move |_, config| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(VirtualTransport::new(config.clone())))
        }),
    )
    .await
    .unwrap();
    h.clock.advance_ms(100000);
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(opens.load(Ordering::SeqCst), 0);
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn settled_rx_failure_with_old_queued_tx_reconnects_without_replaying_queue() {
    let h = support::Harness::new().await;
    let (_, _, device, _) = attach(&h, true).await;
    let opened = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let target = session_target(&h, &opened);
    let gate = Arc::new(Gate::default());
    h.probe.steps.lock().unwrap().push_back(support::WriteStep {
        accepted: 5,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 0,
    });
    let first = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"AQIDBAU=","writeWaitMs":"1000"}),
        ))
        .await;
    gate.entered().await;
    let queued = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"BgcICQo=","writeWaitMs":"1000"}),
        ))
        .await;
    h.probe.read_fails.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(1), async {
        while h.host.devices().snapshot(&target).await.unwrap().state != SessionState::Disconnected
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    gate.release();
    let settled = h.wait(&first.operation_id).await;
    assert_eq!(support::receipt(&settled).outcome, TxOutcome::Accepted);
    let rejected = h.wait(&queued.operation_id).await;
    assert_eq!(support::receipt(&rejected).outcome, TxOutcome::Rejected);
    support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
    h.probe.read_fails.store(false, Ordering::SeqCst);
    await_reconnect_state(&h, &device, &target, "waiting").await;
    h.clock.advance_ms(500);
    let next = Target {
        session_epoch: Some(opened.session_epoch.checked_next().unwrap()),
        ..target.clone()
    };
    await_reconnect_state(&h, &device, &next, "idle").await;
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 2);
    assert_eq!(h.write_count(), 1);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn stale_discovery_cannot_authorize_open_from_a_retained_locator() {
    let h = support::Harness::new().await;
    let (runtime, p, device, _) = attach(&h, false).await;
    *p.devices.lock().unwrap() = Err(HostError::new("ENUMERATION_FAILED", "injected"));
    assert!(runtime.refresh().await.unwrap().stale);
    let error = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "DISCOVERY_STALE");
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 0);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn unsettled_configuration_survives_disconnect_and_never_reopens() {
    let h = support::Harness::new().await;
    let (_, _, device, _) = attach(&h, true).await;
    let opened = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let target = session_target(&h, &opened);
    h.probe.partial_configuration.store(true, Ordering::SeqCst);
    let mut call = h.call(&target, "session.configure", serde_json::json!({"requested": SerialConfiguration { parity: Parity::Even, ..Default::default() }}));
    call.expected_revision = Some(h.host.devices().snapshot(&target).await.unwrap().revision);
    let operation = h.invoke(call).await;
    let completed = h.wait(&operation.operation_id).await;
    assert!(
        matches!(completed.result, Some(ActionResult::Configuration(ref receipt)) if receipt.tx_gate == TxGate::ConfigurationPending)
    );
    h.probe.read_fails.store(true, Ordering::SeqCst);
    support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
    h.probe.read_fails.store(false, Ordering::SeqCst);
    assert_eq!(
        h.host.devices().snapshot(&target).await.unwrap().tx_gate,
        TxGate::ConfigurationPending
    );
    h.clock.advance_ms(100000);
    await_reconnect_state(&h, &device, &target, "stopped").await;
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn rapid_revoke_and_reauthorize_cannot_revive_the_original_responsibility() {
    let h = support::Harness::new().await;
    let (_, _, device, _) = attach(&h, true).await;
    let opened = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let target = session_target(&h, &opened);
    let operator = h
        .auth
        .authenticate_user_control(
            &id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    // No await between these changes: watch may coalesce them into a single wake.
    h.auth
        .revoke(
            &operator,
            RevokeParams {
                actor_id: h.actor.id().clone(),
                permissions: vec!["device.modify".into()],
                targets: vec![device.clone()],
            },
        )
        .unwrap();
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["device.modify".into()],
                targets: vec![device.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    assert!(h.auth.require(&h.actor, "device.modify", &device).is_ok());
    await_reconnect_state(&h, &device, &target, "stopped").await;
    h.probe.read_fails.store(true, Ordering::SeqCst);
    support::until(|| h.probe.closes.load(Ordering::SeqCst) == 1).await;
    h.probe.read_fails.store(false, Ordering::SeqCst);
    h.clock.advance_ms(100000);
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn successful_explicit_reuse_updates_recent_and_retains_failure_diagnostic_without_reopening()
{
    let h = support::Harness::new().await;
    let (_, _, device, _) = attach(&h, false).await;
    let first = h
        .host
        .devices()
        .open_authorized(
            &h.actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    let recent_before = h.host.devices().recent().unwrap();
    let actor = h.new_actor("second-recent-actor");
    let reused = h
        .host
        .devices()
        .open_authorized(
            &actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    assert!(reused.reused);
    assert_eq!(first.session_id, reused.session_id);
    let recent_after = h.host.devices().recent().unwrap();
    assert!(
        recent_after.revision > recent_before.revision,
        "a newly accepted explicit open must refresh global recent even when the owner is reused"
    );
    assert_eq!(recent_after.entries.len(), 1);
    let malformed =
        serde_json::from_value(serde_json::json!({"formatVersion":"9.0","entries":[]})).unwrap();
    h.store
        .compare_and_swap_document(&id("host:recent-devices"), recent_after.revision, malformed)
        .unwrap();
    let result = h
        .host
        .devices()
        .open_authorized(
            &actor,
            &device,
            bound_params(),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
    assert!(result.reused);
    assert_eq!(result.recent_error.unwrap().code, "INVALID_DOCUMENT");
    assert_eq!(h.probe.opens.load(Ordering::SeqCst), 1);
    assert_eq!(
        h.host
            .devices()
            .snapshot(&session_target(&h, &first))
            .await
            .unwrap()
            .state,
        SessionState::Open
    );
    h.host.shutdown().await.unwrap();
}
