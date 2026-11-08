use serial_workbench_core::*;
use serial_workbench_host::device::{IdentityMatcher, MatchResult};

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
fn fingerprint(serial: Option<&str>, topology: Option<&str>) -> DeviceFingerprint {
    DeviceFingerprint {
        transport: DeviceTransportKind::Serial,
        vid: Some(0x1234),
        pid: Some(0x5678),
        serial_number: serial.map(str::to_owned),
        topology_path: topology.map(str::to_owned),
        evidence: if serial.is_some() {
            IdentityEvidence::SerialNumber
        } else {
            IdentityEvidence::Unreliable
        },
    }
}
fn candidate(
    device_id: &str,
    system_name: &str,
    fingerprint: DeviceFingerprint,
) -> DeviceDescriptor {
    DeviceDescriptor {
        device_id: id(device_id),
        host_id: id("host"),
        system_name: system_name.into(),
        description: None,
        manufacturer: None,
        driver: None,
        fingerprint,
        capabilities: TransportCapabilities {
            semantics: TransportSemantics::Stream,
            configuration: true,
            dtr: false,
            rts: false,
            finite_break: false,
            queue_status: false,
            drain: false,
            purge_rx: false,
            purge_tx: false,
        },
    }
}

#[test]
fn identical_models_without_serial_never_pick_enumeration_order() {
    let saved = fingerprint(None, None);
    let candidates = vec![
        candidate("b", "COM2", saved.clone()),
        candidate("a", "COM1", saved.clone()),
    ];
    assert_eq!(
        IdentityMatcher::match_device(&saved, &candidates),
        MatchResult::RequiresRebind(vec![id("a"), id("b")])
    );
}

#[test]
fn unique_serial_recovers_after_locator_renumbering() {
    let saved = fingerprint(Some("unit-1"), Some("port-1"));
    let candidates = vec![candidate("new", "COM9", saved.clone())];
    assert_eq!(
        IdentityMatcher::match_device(&saved, &candidates),
        MatchResult::Exact(id("new"))
    );
}

#[test]
fn topology_change_requires_explicit_rebind_even_with_serial() {
    let saved = fingerprint(Some("unit-1"), Some("port-1"));
    let candidates = vec![candidate(
        "new",
        "COM9",
        fingerprint(Some("unit-1"), Some("port-2")),
    )];
    assert_eq!(
        IdentityMatcher::match_device(&saved, &candidates),
        MatchResult::RequiresRebind(vec![id("new")])
    );
}

#[test]
fn duplicate_serial_is_ambiguous() {
    let saved = fingerprint(Some("unit-1"), None);
    let candidates = vec![
        candidate("a", "COM1", saved.clone()),
        candidate("b", "COM2", saved.clone()),
    ];
    assert_eq!(
        IdentityMatcher::match_device(&saved, &candidates),
        MatchResult::RequiresRebind(vec![id("a"), id("b")])
    );
}

#[test]
fn unrelated_devices_are_missing() {
    let saved = fingerprint(Some("unit-1"), None);
    let candidates = vec![candidate(
        "other",
        "COM1",
        fingerprint(Some("unit-2"), None),
    )];
    assert_eq!(
        IdentityMatcher::match_device(&saved, &candidates),
        MatchResult::Missing
    );
}

#[test]
fn missing_serial_evidence_does_not_restore_automatically() {
    let saved = fingerprint(Some("unit-1"), Some("port-1"));
    let candidates = vec![candidate("new", "COM9", fingerprint(None, Some("port-1")))];
    assert_eq!(
        IdentityMatcher::match_device(&saved, &candidates),
        MatchResult::RequiresRebind(vec![id("new")])
    );
}

#[test]
fn empty_serial_number_is_not_reliable_unique_evidence() {
    let saved = fingerprint(Some(""), None);
    let candidates = vec![candidate("new", "COM9", saved.clone())];
    assert_eq!(
        IdentityMatcher::match_device(&saved, &candidates),
        MatchResult::RequiresRebind(vec![id("new")])
    );
}

#[test]
fn discovery_failure_retains_devices_and_recovery_clears_stale() {
    use serial_workbench_host::device::DeviceDirectory;
    let mut directory = DeviceDirectory::default();
    let device = candidate("provider-1", "COM1", fingerprint(Some("unit-1"), None));
    let first = directory.apply(Ok(vec![device.clone()])).unwrap();
    assert!(!first.stale);
    assert_eq!(first.devices.len(), 1);
    let stale = directory
        .apply(Err(HostError::new(
            "ENUMERATION_FAILED",
            "enumeration failed",
        )))
        .unwrap();
    assert!(stale.stale);
    assert_eq!(stale.devices, first.devices);
    assert!(
        directory
            .apply(Err(HostError::new(
                "ENUMERATION_FAILED",
                "enumeration failed"
            )))
            .is_none()
    );
    let recovered = directory.apply(Ok(vec![device])).unwrap();
    assert!(!recovered.stale);
    assert_eq!(recovered.devices, first.devices);
}

#[test]
fn discovery_ignores_enumeration_order_and_transient_provider_ids() {
    use serial_workbench_host::device::DeviceDirectory;
    let mut directory = DeviceDirectory::default();
    let first = candidate("first", "COM1", fingerprint(Some("unit-1"), None));
    let second = candidate("second", "COM2", fingerprint(Some("unit-2"), None));
    let snapshot = directory
        .apply(Ok(vec![first.clone(), second.clone()]))
        .unwrap();
    let mut new_first = first;
    new_first.device_id = id("different-1");
    let mut new_second = second;
    new_second.device_id = id("different-2");
    assert!(directory.apply(Ok(vec![new_second, new_first])).is_none());
    assert_eq!(directory.snapshot(), &snapshot);
}

#[test]
fn loss_of_model_evidence_requires_rebind() {
    let saved = fingerprint(Some("unit-1"), None);
    let mut found = saved.clone();
    found.vid = None;
    let candidates = vec![candidate("new", "COM9", found)];
    assert_eq!(
        IdentityMatcher::match_device(&saved, &candidates),
        MatchResult::RequiresRebind(vec![id("new")])
    );
}

#[test]
fn recent_connections_are_host_global_and_concurrent_writes_preserve_entries() {
    use serial_workbench_host::{device::RecentConnections, storage::Store};
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path()).unwrap();
    let store2 = store.clone();
    let make = |device: &str, serial: &str| RecentConnection {
        device_id: id(device),
        fingerprint: fingerprint(Some(serial), None),
        configuration: SerialConfiguration::default(),
        opened_at: Timestamp::try_from("2026-11-08T00:00:00Z").unwrap(),
    };
    let a = make("a", "unit-a");
    let b = make("b", "unit-b");
    let worker = std::thread::spawn(move || RecentConnections::new(store2).record(b).unwrap());
    RecentConnections::new(store.clone()).record(a).unwrap();
    worker.join().unwrap();
    let list = RecentConnections::new(store).list().unwrap();
    let mut ids: Vec<_> = list
        .entries
        .iter()
        .map(|entry| entry.device_id.clone())
        .collect();
    ids.sort();
    assert_eq!(ids, vec![id("a"), id("b")]);
}

#[test]
fn reconnect_backoff_revalidates_gate_and_obeys_cancellation() {
    use serial_workbench_host::device::{
        ReconnectDecision, ReconnectGate, ReconnectResponsibility,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    struct FakeClock(AtomicU64);
    impl Clock for FakeClock {
        fn mono_ns(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2026-11-08T00:00:00Z").unwrap()
        }
    }
    let clock = Arc::new(FakeClock(AtomicU64::new(0)));
    let mut binding = DeviceBinding {
        binding_id: id("binding"),
        host_id: id("host"),
        device_id: id("device"),
        fingerprint: fingerprint(Some("unit"), None),
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy::default(),
    };
    binding.reconnect.enabled = true;
    let mut responsibility =
        ReconnectResponsibility::new(id("actor"), binding, U64::from(1), clock.clone()).unwrap();
    let mut gate = ReconnectGate {
        authorized: true,
        identity_exact: true,
        configuration_settled: true,
        epoch_current: true,
        closed: false,
        cancelled: false,
    };
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Wait);
    clock.0.store(500_000_000, Ordering::SeqCst);
    gate.configuration_settled = false;
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Wait);
    gate.configuration_settled = true;
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Attempt);
    responsibility.attempt_failed();
    clock.0.store(1_499_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Wait);
    clock.0.store(1_500_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Attempt);
    gate.cancelled = true;
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Stopped);
    gate.cancelled = false;
    clock.0.store(60_000_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Stopped);
}

#[test]
fn directory_keeps_opaque_id_when_unique_serial_is_renumbered() {
    use serial_workbench_host::device::DeviceDirectory;
    let mut directory = DeviceDirectory::default();
    let original = candidate("first", "COM1", fingerprint(Some("unit-1"), Some("port-1")));
    let old = directory.apply(Ok(vec![original.clone()])).unwrap();
    let mut renamed = original;
    renamed.device_id = id("provider-new");
    renamed.system_name = "COM9".into();
    let current = directory.apply(Ok(vec![renamed])).unwrap();
    assert_eq!(current.devices[0].device_id, old.devices[0].device_id);
    assert_eq!(current.devices[0].system_name, "COM9");
}

#[test]
fn recent_retains_only_newest_hundred_with_stable_ties() {
    use serial_workbench_host::{device::RecentConnections, storage::Store};
    let dir = tempfile::tempdir().unwrap();
    let recent = RecentConnections::new(Store::open(dir.path()).unwrap());
    for n in (0..101).rev() {
        recent
            .record(RecentConnection {
                device_id: id(&format!("unit-{n:03}")),
                fingerprint: fingerprint(Some("serial"), None),
                configuration: SerialConfiguration::default(),
                opened_at: Timestamp::try_from("2026-11-08T00:00:00Z").unwrap(),
            })
            .unwrap();
    }
    let list = recent.list().unwrap();
    assert_eq!(list.entries.len(), 100);
    assert_eq!(list.entries.first().unwrap().device_id, id("unit-000"));
    assert_eq!(list.entries.last().unwrap().device_id, id("unit-099"));
}

#[test]
fn recent_future_document_is_preserved_and_rejected() {
    use serial_workbench_host::{device::RecentConnections, storage::Store};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let key = id("host:recent-devices");
    let document: JsonObject =
        serde_json::from_value(serde_json::json!({"formatVersion":"99.0","entries":[]})).unwrap();
    let original = store
        .compare_and_swap_document(&key, U64::from(0), document)
        .unwrap();
    let recent = RecentConnections::new(store.clone());
    let entry = RecentConnection {
        device_id: id("unit"),
        fingerprint: fingerprint(Some("serial"), None),
        configuration: SerialConfiguration::default(),
        opened_at: Timestamp::try_from("2026-11-08T00:00:00Z").unwrap(),
    };
    assert!(recent.record(entry).is_err());
    assert_eq!(store.read_document(&key).unwrap().unwrap(), original);
}

#[test]
fn reconnect_revocation_close_and_disabled_policy_end_responsibility() {
    use serial_workbench_host::device::{
        ReconnectDecision, ReconnectGate, ReconnectResponsibility,
    };
    use std::sync::Arc;
    struct Now;
    impl Clock for Now {
        fn mono_ns(&self) -> u64 {
            10_000_000_000
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2026-11-08T00:00:00Z").unwrap()
        }
    }
    let mut binding = DeviceBinding {
        binding_id: id("binding"),
        host_id: id("host"),
        device_id: id("device"),
        fingerprint: fingerprint(Some("unit"), None),
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy::default(),
    };
    let mut gate = ReconnectGate {
        authorized: true,
        identity_exact: true,
        configuration_settled: true,
        epoch_current: true,
        closed: false,
        cancelled: false,
    };
    let mut disabled =
        ReconnectResponsibility::new(id("actor"), binding.clone(), U64::from(1), Arc::new(Now))
            .unwrap();
    assert_eq!(disabled.poll(gate), ReconnectDecision::Stopped);
    binding.reconnect.enabled = true;
    let mut revoked =
        ReconnectResponsibility::new(id("actor"), binding.clone(), U64::from(1), Arc::new(Now))
            .unwrap();
    gate.authorized = false;
    assert_eq!(revoked.poll(gate), ReconnectDecision::Stopped);
    gate.authorized = true;
    assert_eq!(revoked.poll(gate), ReconnectDecision::Stopped);
    let mut closed =
        ReconnectResponsibility::new(id("actor"), binding, U64::from(1), Arc::new(Now)).unwrap();
    gate.closed = true;
    assert_eq!(closed.poll(gate), ReconnectDecision::Stopped);
    gate.closed = false;
    assert_eq!(closed.poll(gate), ReconnectDecision::Stopped);
}

#[test]
fn reconnect_caps_delay_and_stops_after_ten_attempts() {
    use serial_workbench_host::device::{
        ReconnectDecision, ReconnectGate, ReconnectResponsibility,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    struct FakeClock(AtomicU64);
    impl Clock for FakeClock {
        fn mono_ns(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2026-11-08T00:00:00Z").unwrap()
        }
    }
    let clock = Arc::new(FakeClock(AtomicU64::new(0)));
    let mut binding = DeviceBinding {
        binding_id: id("binding"),
        host_id: id("host"),
        device_id: id("device"),
        fingerprint: fingerprint(Some("unit"), None),
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy::default(),
    };
    binding.reconnect.enabled = true;
    let mut responsibility =
        ReconnectResponsibility::new(id("actor"), binding, U64::from(1), clock.clone()).unwrap();
    let gate = ReconnectGate {
        authorized: true,
        identity_exact: true,
        configuration_settled: true,
        epoch_current: true,
        closed: false,
        cancelled: false,
    };
    let mut elapsed_ms = 0;
    for delay in [
        500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000,
    ] {
        elapsed_ms += delay;
        clock
            .0
            .store((elapsed_ms - 1) * 1_000_000, Ordering::SeqCst);
        assert_eq!(responsibility.poll(gate), ReconnectDecision::Wait);
        clock.0.store(elapsed_ms * 1_000_000, Ordering::SeqCst);
        assert_eq!(responsibility.poll(gate), ReconnectDecision::Attempt);
        responsibility.attempt_failed();
    }
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Stopped);
}

#[test]
fn recent_unknown_fields_are_preserved_and_rejected() {
    use serial_workbench_host::{device::RecentConnections, storage::Store};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let key = id("host:recent-devices");
    let document: JsonObject = serde_json::from_value(
        serde_json::json!({"formatVersion":"0.1","entries":[],"futureField":true}),
    )
    .unwrap();
    let original = store
        .compare_and_swap_document(&key, U64::from(0), document)
        .unwrap();
    let recent = RecentConnections::new(store.clone());
    let entry = RecentConnection {
        device_id: id("unit"),
        fingerprint: fingerprint(Some("serial"), None),
        configuration: SerialConfiguration::default(),
        opened_at: Timestamp::try_from("2026-11-08T00:00:00Z").unwrap(),
    };
    assert!(recent.record(entry).is_err());
    assert_eq!(store.read_document(&key).unwrap().unwrap(), original);
}

#[test]
fn fingerprint_omits_unknown_fields_and_rejects_explicit_null() {
    let fp = fingerprint(None, None);
    let value = serde_json::to_value(&fp).unwrap();
    assert!(value.get("serialNumber").is_none());
    assert!(value.get("topologyPath").is_none());
    let mut malformed = value;
    malformed["serialNumber"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<DeviceFingerprint>(malformed).is_err());
}

#[test]
fn reconnect_rejects_max_delay_shorter_than_initial_when_enabled() {
    use serial_workbench_host::device::ReconnectResponsibility;
    use std::sync::Arc;
    struct Now;
    impl Clock for Now {
        fn mono_ns(&self) -> u64 {
            0
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2026-11-08T00:00:00Z").unwrap()
        }
    }
    let mut binding = DeviceBinding {
        binding_id: id("binding"),
        host_id: id("host"),
        device_id: id("device"),
        fingerprint: fingerprint(Some("unit"), None),
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy::default(),
    };
    binding.reconnect.enabled = true;
    binding.reconnect.max_delay_ms = DurationMs::try_from(U64::from(100)).unwrap();
    assert_eq!(binding.validate().unwrap_err().code, "INVALID_ARGUMENT");
    assert!(
        ReconnectResponsibility::new(id("actor"), binding, U64::from(1), Arc::new(Now)).is_err()
    );
}

#[test]
fn reconnect_waits_for_failed_attempt_to_settle_before_starting_next_backoff() {
    use serial_workbench_host::device::{
        ReconnectDecision, ReconnectGate, ReconnectResponsibility,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    struct FakeClock(AtomicU64);
    impl Clock for FakeClock {
        fn mono_ns(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2026-11-08T00:00:00Z").unwrap()
        }
    }
    let clock = Arc::new(FakeClock(AtomicU64::new(0)));
    let mut binding = DeviceBinding {
        binding_id: id("binding"),
        host_id: id("host"),
        device_id: id("device"),
        fingerprint: fingerprint(Some("unit"), None),
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy::default(),
    };
    binding.reconnect.enabled = true;
    let mut responsibility =
        ReconnectResponsibility::new(id("actor"), binding, U64::from(1), clock.clone()).unwrap();
    let gate = ReconnectGate {
        authorized: true,
        identity_exact: true,
        configuration_settled: true,
        epoch_current: true,
        closed: false,
        cancelled: false,
    };
    clock.0.store(500_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Attempt);
    clock.0.store(5_500_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Wait);
    responsibility.attempt_failed();
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Wait);
    clock.0.store(6_499_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Wait);
    clock.0.store(6_500_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Attempt);
}

#[test]
fn reconnect_in_flight_still_observes_revocation() {
    use serial_workbench_host::device::{
        ReconnectDecision, ReconnectGate, ReconnectResponsibility,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };
    struct FakeClock(AtomicU64);
    impl Clock for FakeClock {
        fn mono_ns(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
        fn wall_time(&self) -> Timestamp {
            Timestamp::try_from("2026-11-08T00:00:00Z").unwrap()
        }
    }
    let clock = Arc::new(FakeClock(AtomicU64::new(0)));
    let mut binding = DeviceBinding {
        binding_id: id("binding"),
        host_id: id("host"),
        device_id: id("device"),
        fingerprint: fingerprint(Some("unit"), None),
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy::default(),
    };
    binding.reconnect.enabled = true;
    let mut responsibility =
        ReconnectResponsibility::new(id("actor"), binding, U64::from(1), clock.clone()).unwrap();
    let mut gate = ReconnectGate {
        authorized: true,
        identity_exact: true,
        configuration_settled: true,
        epoch_current: true,
        closed: false,
        cancelled: false,
    };
    clock.0.store(500_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Attempt);
    gate.authorized = false;
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Stopped);
    responsibility.attempt_failed();
    gate.authorized = true;
    clock.0.store(100_000_000_000, Ordering::SeqCst);
    assert_eq!(responsibility.poll(gate), ReconnectDecision::Stopped);
}
