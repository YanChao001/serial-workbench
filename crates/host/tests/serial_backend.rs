//! 原生提供器入口的集成测试；平台映射与 syscall 替身测试在对应模块。
#[test]
fn serial_provider_returns_only_discovered_devices() {
    let provider = serial_workbench_host::device::serial::SerialProvider::new(
        serial_workbench_core::Id::try_from("test-host").unwrap(),
    );
    let devices = provider.enumerate().expect("OS device enumeration");
    for device in &devices {
        assert!(!device.system_name.is_empty());
        assert_eq!(device.host_id.as_str(), "test-host");
        assert_eq!(
            device.fingerprint.transport,
            serial_workbench_core::DeviceTransportKind::Serial
        );
    }
    let identities: std::collections::HashSet<_> = devices
        .iter()
        .map(|device| device.device_id.clone())
        .collect();
    assert_eq!(identities.len(), devices.len());
}
