use super::*;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

fn descriptor(device: &str, system_name: &str) -> DeviceDescriptor {
    DeviceDescriptor {
        device_id: id(device),
        host_id: id("handoff-test-host"),
        system_name: system_name.into(),
        description: None,
        manufacturer: None,
        driver: None,
        fingerprint: DeviceFingerprint {
            transport: DeviceTransportKind::Serial,
            vid: Some(0x10C4),
            pid: Some(0xEA60),
            serial_number: Some("reference-only".into()),
            topology_path: Some("same-usb-path".into()),
            evidence: IdentityEvidence::SerialNumber,
        },
        capabilities: serial_capabilities(),
    }
}

fn fresh(devices: Vec<DeviceDescriptor>) -> DeviceList {
    DeviceList {
        devices,
        stale: false,
    }
}

#[test]
fn tool_handoff_continuously_reserves_the_native_device_and_requires_exact_return_identity() {
    let prior = descriptor("old-device", "old-port");
    let moved = descriptor("renumbered-device", "new-port");
    let provider = SerialProvider::new(prior.host_id.clone());
    let mut native = provider.claim_native(&prior, None).unwrap();
    let mut handoff = provider.reserve_tool_handoff(&prior).unwrap();
    assert_eq!(
        handoff
            .begin_tool(&fresh(vec![prior.clone()]))
            .unwrap_err()
            .code,
        "DEVICE_BUSY"
    );

    native.confirm_release().unwrap();
    assert_eq!(
        provider.claim_native(&prior, None).err().unwrap().code,
        "DEVICE_BUSY",
    );
    assert_eq!(
        provider.claim_native(&moved, None).err().unwrap().code,
        "DEVICE_BUSY",
    );
    assert_eq!(
        handoff.begin_tool(&fresh(vec![prior.clone()])).unwrap(),
        "old-port"
    );
    let directory = fresh(vec![moved.clone()]);
    assert_eq!(
        handoff.return_device(&directory).unwrap_err().code,
        "DEVICE_BUSY"
    );

    handoff.confirm_tool_exit();
    let mut stale = directory.clone();
    stale.stale = true;
    assert_eq!(
        handoff.return_device(&stale).unwrap_err().code,
        "DISCOVERY_STALE",
    );
    let mut replaced = moved.clone();
    replaced.fingerprint.serial_number = Some("different-device".into());
    assert_eq!(
        handoff
            .return_device(&fresh(vec![replaced]))
            .unwrap_err()
            .code,
        "REQUIRES_REBIND",
    );
    assert_eq!(
        handoff
            .return_device(&fresh(vec![prior, moved.clone()]))
            .unwrap_err()
            .code,
        "REQUIRES_REBIND",
    );

    let selected = handoff.return_device(&directory).unwrap();
    assert_eq!(selected, &moved);
    let mut reopened = provider.claim_native(selected, Some(&handoff.id)).unwrap();
    drop(handoff);
    assert_eq!(
        provider.claim_native(&moved, None).err().unwrap().code,
        "DEVICE_BUSY",
    );
    reopened.confirm_release().unwrap();
    assert!(provider.claim_native(&moved, None).is_ok());
    assert!(provider.require_tool_quiescence().is_ok());
}

#[test]
fn handoff_open_resolves_a_renumbered_device_when_its_old_locator_is_reused() {
    let prior = descriptor("original-device", "COM5");
    let moved = descriptor("scan-id", "COM6");
    let mut replacement = descriptor("replacement-id", "COM5");
    replacement.fingerprint.serial_number = Some("replacement-serial".into());
    let provider = SerialProvider::new(prior.host_id.clone());
    let mut native = provider.claim_native(&prior, None).unwrap();
    let mut handoff = provider.reserve_tool_handoff(&prior).unwrap();
    native.confirm_release().unwrap();
    handoff.begin_tool(&fresh(vec![prior.clone()])).unwrap();
    handoff.confirm_tool_exit();

    let (approved_id, _) = handoff.return_opener(&fresh(vec![prior.clone()])).unwrap();
    let mut latest = find_handoff_identity(&prior, &[replacement.clone(), moved])
        .unwrap()
        .clone();
    latest.device_id.clone_from(&approved_id);
    assert_eq!(latest.device_id, prior.device_id);
    assert_eq!(latest.system_name, "COM6");
    let reopened = provider.claim_native(&latest, Some(&handoff.id)).unwrap();
    drop(handoff);
    assert!(provider.claim_native(&replacement, None).is_ok());
    let mut same_locator = replacement;
    same_locator.system_name = "COM6".into();
    assert_eq!(
        provider
            .claim_native(&same_locator, None)
            .err()
            .unwrap()
            .code,
        "DEVICE_BUSY",
    );
    drop(reopened);
    assert!(provider.claim_native(&same_locator, None).is_ok());
}

#[test]
fn tool_handoff_keeps_the_physical_claim_if_the_tool_owner_is_lost() {
    let device = descriptor("serial-device", "fixture-port");
    let mut alias = descriptor("serial-alias", "renumbered-fixture-port");
    alias.fingerprint.vid = None;
    let mut unrelated = descriptor("other-device", "other-fixture-port");
    unrelated.fingerprint.serial_number = Some("independent".into());
    let provider = SerialProvider::new(device.host_id.clone());
    let mut native = provider.claim_native(&device, None).unwrap();
    let mut handoff = provider.reserve_tool_handoff(&device).unwrap();
    native.confirm_release().unwrap();
    handoff.begin_tool(&fresh(vec![device.clone()])).unwrap();
    drop(handoff);

    assert_eq!(
        provider.claim_native(&alias, None).err().unwrap().code,
        "DEVICE_BUSY",
    );
    assert!(provider.claim_native(&unrelated, None).is_ok());
    assert_eq!(
        provider.require_tool_quiescence().unwrap_err().code,
        "TOOL_EXIT_UNCONFIRMED",
    );
}
