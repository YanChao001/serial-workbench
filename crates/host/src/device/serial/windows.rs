use serial_workbench_core::*;
use std::{
    os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle},
    sync::Arc,
    time::{Duration, Instant},
};
use windows_sys::Win32::Devices::Communication::*;
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::*,
    System::{IO::*, Threading::*},
};

struct PortResource {
    handle: Option<OwnedHandle>,
    claim: super::SerialClaim,
    closed: Arc<PortClosed>,
}
#[derive(Debug, Default)]
struct PortClosed {
    result: std::sync::Mutex<Option<HostResult<()>>>,
}
impl BackendCleanup for PortClosed {
    fn poll(&self) -> Option<HostResult<()>> {
        self.result.lock().ok()?.clone()
    }
}
impl PortResource {
    fn new(handle: OwnedHandle, claim: super::SerialClaim) -> Self {
        Self {
            handle: Some(handle),
            claim,
            closed: Arc::new(PortClosed::default()),
        }
    }
    fn raw(&self) -> HANDLE {
        self.handle
            .as_ref()
            .expect("live port handle")
            .as_raw_handle()
    }
}
impl Drop for PortResource {
    fn drop(&mut self) {
        let Some(handle) = self.handle.take() else {
            return;
        };
        let result = if unsafe { CloseHandle(handle.into_raw_handle()) } == 0 {
            let error = last_error();
            self.claim
                .isolated
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Err(*error.error)
        } else {
            self.claim.confirm_release()
        };
        if let Ok(mut closed) = self.closed.result.lock() {
            *closed = Some(result);
        }
    }
}
struct WindowsPort {
    port: Option<Arc<PortResource>>,
    configuration: SerialConfiguration,
    pending_read_error: Option<BackendError>,
}

enum IoBuffer<'a> {
    Read(&'a mut [u8]),
    Write(&'a [u8]),
}

trait CommStateApi {
    fn get(&mut self) -> Result<DCB, u32>;
    fn set(&mut self, state: &DCB) -> Result<(), u32>;
}
trait OverlappedApi {
    fn submit(&mut self, buffer: IoBuffer<'_>, overlapped: &mut OVERLAPPED) -> Result<(), u32>;
    fn completion(&mut self, overlapped: &OVERLAPPED, wait: Option<u32>) -> Result<usize, u32>;
    fn cancel(&mut self, overlapped: &OVERLAPPED) -> Result<(), u32>;
}
fn apply_configuration(
    api: &mut impl CommStateApi,
    configuration: &SerialConfiguration,
) -> BackendResult<SerialConfiguration> {
    let baseline = api.get().map_err(os_error)?;
    api.set(&encode_dcb(baseline, configuration)?)
        .map_err(os_error)?;
    decode_dcb(&api.get().map_err(os_error)?, configuration)
}
fn overlapped_io(
    api: &mut impl OverlappedApi,
    buffer: IoBuffer<'_>,
    wait: Duration,
    signals: Option<&super::WriteSignals>,
    progress: Option<(&Arc<std::sync::Mutex<super::WriteProgress>>, usize)>,
) -> IoCompletion {
    let length = match &buffer {
        IoBuffer::Read(bytes) => bytes.len(),
        IoBuffer::Write(bytes) => bytes.len(),
    };
    let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if event.is_null() {
        return IoCompletion::NotSubmitted(unsafe { GetLastError() });
    }
    let event = unsafe { OwnedHandle::from_raw_handle(event) };
    let mut overlapped = OVERLAPPED {
        hEvent: event.as_raw_handle(),
        ..Default::default()
    };
    if signals.is_some_and(super::WriteSignals::interrupted) {
        return IoCompletion::NotSubmitted(ERROR_OPERATION_ABORTED);
    }
    if let (Some((progress, accepted)), Some(signals)) = (progress, signals)
        && !super::publish_write_submission(progress, signals, accepted + length)
    {
        return IoCompletion::NotSubmitted(ERROR_OPERATION_ABORTED);
    }
    if let Err(error) = api.submit(buffer, &mut overlapped)
        && error != ERROR_IO_PENDING
    {
        return IoCompletion::Unconfirmed(error);
    }
    let deadline = Instant::now() + wait;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let timeout = if signals.is_some() {
            remaining.as_millis().min(5) as u32
        } else {
            remaining.as_millis().min(u128::from(u32::MAX - 1)) as u32
        };
        let completed = match api.completion(&overlapped, Some(timeout)) {
            Ok(count) => Ok(count),
            Err(WAIT_TIMEOUT | ERROR_IO_INCOMPLETE) => {
                if Instant::now() < deadline
                    && !signals.is_some_and(super::WriteSignals::interrupted)
                {
                    continue;
                }
                let _ = api.cancel(&overlapped);
                // 取消请求（含 NOT_FOUND）不证明完成；原生线程保有全部借用存储到 reap 返回。
                api.completion(&overlapped, None)
            }
            Err(error) => Err(error),
        };
        return match completed {
            Ok(count) => {
                if let Some((progress, accepted)) = progress {
                    let mut progress = progress.lock().unwrap_or_else(|e| e.into_inner());
                    progress.accepted = accepted + count;
                    progress.submitted_end = progress.accepted;
                }
                IoCompletion::Completed(count)
            }
            Err(error) => IoCompletion::Unconfirmed(error),
        };
    }
}

struct Win32Api(HANDLE);
impl CommStateApi for Win32Api {
    fn get(&mut self) -> Result<DCB, u32> {
        let mut state = DCB {
            DCBlength: std::mem::size_of::<DCB>() as u32,
            ..Default::default()
        };
        if unsafe { GetCommState(self.0, &mut state) } == 0 {
            Err(unsafe { GetLastError() })
        } else {
            Ok(state)
        }
    }
    fn set(&mut self, state: &DCB) -> Result<(), u32> {
        if unsafe { SetCommState(self.0, state) } == 0 {
            Err(unsafe { GetLastError() })
        } else {
            Ok(())
        }
    }
}
impl OverlappedApi for Win32Api {
    fn submit(&mut self, buffer: IoBuffer<'_>, overlapped: &mut OVERLAPPED) -> Result<(), u32> {
        let result = unsafe {
            match buffer {
                IoBuffer::Read(bytes) => ReadFile(
                    self.0,
                    bytes.as_mut_ptr(),
                    bytes.len() as u32,
                    std::ptr::null_mut(),
                    overlapped,
                ),
                IoBuffer::Write(bytes) => WriteFile(
                    self.0,
                    bytes.as_ptr(),
                    bytes.len() as u32,
                    std::ptr::null_mut(),
                    overlapped,
                ),
            }
        };
        if result == 0 {
            Err(unsafe { GetLastError() })
        } else {
            Ok(())
        }
    }
    fn completion(&mut self, overlapped: &OVERLAPPED, wait: Option<u32>) -> Result<usize, u32> {
        let mut transferred = 0;
        let result = unsafe {
            match wait {
                Some(wait) => GetOverlappedResultEx(self.0, overlapped, &mut transferred, wait, 0),
                None => GetOverlappedResult(self.0, overlapped, &mut transferred, 1),
            }
        };
        if result == 0 {
            Err(unsafe { GetLastError() })
        } else {
            Ok(transferred as usize)
        }
    }
    fn cancel(&mut self, overlapped: &OVERLAPPED) -> Result<(), u32> {
        if unsafe { CancelIoEx(self.0, overlapped) } == 0 {
            Err(unsafe { GetLastError() })
        } else {
            Ok(())
        }
    }
}

pub(super) fn open(
    device: &DeviceDescriptor,
    config: &SerialConfiguration,
    claim: super::SerialClaim,
) -> BackendResult<Box<dyn super::NativePort>> {
    let number = device
        .system_name
        .strip_prefix("COM")
        .filter(|number| !number.is_empty() && number.bytes().all(|v| v.is_ascii_digit()))
        .ok_or_else(|| super::unsupported("The discovered COM locator is invalid"))?;
    let path: Vec<u16> = format!("\\\\.\\COM{number}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    // 独占、不可继承；每项 OVERLAPPED 的存储由原生线程持有到完成。
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    let mut port = WindowsPort {
        port: Some(Arc::new(PortResource::new(
            unsafe { OwnedHandle::from_raw_handle(handle) },
            claim,
        ))),
        configuration: config.clone(),
        pending_read_error: None,
    };
    // 为一次最大手动发送的硬件回环预留驱动队列，吸收编码、落盘及调度期间的突发数据。
    if unsafe {
        SetupComm(
            port.resource()?.raw(),
            TX_MAX_BYTES as u32,
            TX_MAX_BYTES as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    let application = super::NativePort::configure(&mut port, config)?;
    super::require_applied(&application)?;
    Ok(Box::new(port))
}

impl WindowsPort {
    fn resource(&self) -> BackendResult<&Arc<PortResource>> {
        self.port
            .as_ref()
            .ok_or_else(|| HostError::new("BACKEND_DISCONNECTED", "Serial port is closed").into())
    }
    fn status(&self) -> BackendResult<COMSTAT> {
        let mut errors = 0;
        let mut status = COMSTAT::default();
        if unsafe { ClearCommError(self.resource()?.raw(), &mut errors, &mut status) } == 0 {
            return Err(last_error());
        }
        if errors & (CE_RXOVER | CE_OVERRUN) != 0 {
            return Err(HostError::new(
                "BACKEND_RX_OVERFLOW",
                "Serial driver reported receive data loss",
            )
            .into());
        }
        Ok(status)
    }
    fn io(
        port: &Arc<PortResource>,
        buffer: IoBuffer<'_>,
        wait: Duration,
        signals: Option<&super::WriteSignals>,
        progress: Option<(&Arc<std::sync::Mutex<super::WriteProgress>>, usize)>,
    ) -> IoCompletion {
        overlapped_io(&mut Win32Api(port.raw()), buffer, wait, signals, progress)
    }
}

impl super::NativePort for WindowsPort {
    fn capabilities(&self) -> TransportCapabilities {
        super::serial_capabilities()
    }
    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        if let Some(error) = self.pending_read_error.take() {
            return Err(error);
        }
        self.status()?;
        let resource = self.resource()?.clone();
        let (block, error) = read_burst(limit, wait, |bytes, budget| {
            Self::io(&resource, IoBuffer::Read(bytes), budget, None, None)
        })?;
        self.pending_read_error = error;
        Ok(block)
    }
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<std::sync::atomic::AtomicBool>,
        closing: Arc<std::sync::atomic::AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        let resource = self.resource()?.clone();
        let isolated = resource.claim.isolated.clone();
        Ok(super::start_write_job(
            bytes,
            wait,
            cancelled,
            closing,
            isolated,
            move |bytes, deadline, signals, progress| {
                if bytes.is_empty() {
                    return Ok(settle_write(0, 0, IoCompletion::Completed(0)));
                }
                let mut accepted = 0;
                while accepted < bytes.len() {
                    if signals.interrupted() || (accepted > 0 && Instant::now() >= deadline) {
                        return Ok(BackendWrite {
                            accepted_ranges: if accepted == 0 {
                                vec![]
                            } else {
                                vec![super::range(0, accepted)]
                            },
                            unknown_ranges: vec![],
                            error: Some(HostError::new(
                                if signals.interrupted() {
                                    "CANCELLED"
                                } else {
                                    "WRITE_TIMEOUT"
                                },
                                "Serial write wait expired before the next submission",
                            )),
                        });
                    }
                    match Self::io(
                        &resource,
                        IoBuffer::Write(&bytes[accepted..]),
                        deadline.saturating_duration_since(Instant::now()),
                        Some(&signals),
                        Some((&progress, accepted)),
                    ) {
                        IoCompletion::Completed(0) => {
                            return Ok(BackendWrite {
                                accepted_ranges: if accepted == 0 {
                                    vec![]
                                } else {
                                    vec![super::range(0, accepted)]
                                },
                                unknown_ranges: vec![],
                                error: Some(HostError::new(
                                    "WRITE_TIMEOUT",
                                    "Serial write made no progress",
                                )),
                            });
                        }
                        IoCompletion::Completed(count) => accepted += count,
                        result => {
                            return Ok(settle_write(accepted, bytes.len() - accepted, result));
                        }
                    }
                }
                Ok(settle_write(
                    0,
                    bytes.len(),
                    IoCompletion::Completed(accepted),
                ))
            },
        ))
    }
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        let observed = apply_configuration(&mut Win32Api(self.resource()?.raw()), config)?;
        let timeouts = read_timeouts(config.read_wait_ms.get());
        if unsafe { SetCommTimeouts(self.resource()?.raw(), &timeouts) } == 0 {
            return Err(last_error());
        }
        self.configuration = observed.clone();
        super::configuration_receipt(config, &observed)
    }
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        let handle = self.resource()?.raw();
        match command {
            ControlCommand::SetLine { line, value } => {
                super::check_line(&self.configuration, line)?;
                let command = match (line, value) {
                    (ControlLine::Dtr, true) => SETDTR,
                    (ControlLine::Dtr, false) => CLRDTR,
                    (ControlLine::Rts, true) => SETRTS,
                    (ControlLine::Rts, false) => CLRRTS,
                };
                if unsafe { EscapeCommFunction(handle, command) } == 0 {
                    return Err(last_error());
                }
                Ok(ControlResult::Line { line, value })
            }
            ControlCommand::AssertBreak | ControlCommand::ClearBreak => {
                let asserted = matches!(command, ControlCommand::AssertBreak);
                let result = unsafe {
                    if asserted {
                        SetCommBreak(handle)
                    } else {
                        ClearCommBreak(handle)
                    }
                };
                if result == 0 {
                    return Err(last_error());
                }
                Ok(ControlResult::Break { asserted })
            }
            ControlCommand::QueueStatus => Ok(ControlResult::Queue {
                pending_bytes: u64::from(self.status()?.cbOutQue).into(),
            }),
            ControlCommand::ModemStatus => {
                let mut status = 0;
                if unsafe { GetCommModemStatus(handle, &mut status) } == 0 {
                    return Err(last_error());
                }
                Ok(ControlResult::Modem {
                    cts: status & MS_CTS_ON != 0,
                    dsr: status & MS_DSR_ON != 0,
                    ring: status & MS_RING_ON != 0,
                    carrier: status & MS_RLSD_ON != 0,
                })
            }
            ControlCommand::Purge { direction } => {
                let flags = match direction {
                    PurgeDirection::Rx => PURGE_RXCLEAR,
                    PurgeDirection::Tx => PURGE_TXCLEAR,
                    PurgeDirection::Both => PURGE_RXCLEAR | PURGE_TXCLEAR,
                };
                if unsafe { PurgeComm(handle, flags) } == 0 {
                    return Err(last_error());
                }
                Ok(ControlResult::Purged {
                    ranges: vec![],
                    unknown_extent: true,
                })
            }
        }
    }
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        let resource = self.resource()?.clone();
        let isolated = resource.claim.isolated.clone();
        Ok(super::start_drain_job(request, isolated, move || {
            if unsafe { FlushFileBuffers(resource.raw()) } == 0 {
                Err(last_error())
            } else {
                Ok(())
            }
        }))
    }
    fn close(&mut self) -> BackendResult<()> {
        let Some(resource) = self.port.take() else {
            return Ok(());
        };
        let closed = resource.closed.clone();
        resource
            .claim
            .isolated
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // 最后一个 I/O 引用结束后才关闭句柄；凭证本身不保有资源引用。
        drop(resource);
        match closed.poll() {
            Some(Ok(())) => Ok(()),
            result => {
                let mut error =
                    BackendError::from(result.and_then(Result::err).unwrap_or_else(|| {
                        HostError::new("CONTROL_UNKNOWN", "Native I/O still owns the serial handle")
                    }));
                error.cleanup = Some(closed);
                Err(error)
            }
        }
    }
}

fn read_timeouts(wait_ms: u64) -> COMMTIMEOUTS {
    COMMTIMEOUTS {
        // 首字节立即交付给读取循环；连续块在总读取预算内合批，2ms 空闲后交付短包。
        ReadIntervalTimeout: u32::MAX,
        ReadTotalTimeoutMultiplier: u32::MAX,
        ReadTotalTimeoutConstant: wait_ms.clamp(1, 2) as u32,
        WriteTotalTimeoutMultiplier: 0,
        WriteTotalTimeoutConstant: 0,
    }
}

fn read_burst(
    limit: usize,
    wait: Duration,
    mut read: impl FnMut(&mut [u8], Duration) -> IoCompletion,
) -> BackendResult<(ReadBlock, Option<BackendError>)> {
    let mut bytes = vec![0; limit.min(16384)];
    let deadline = Instant::now() + wait;
    let mut received = 0;
    let mut error = None;
    while received < bytes.len() {
        let budget =
            deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(100);
        match read(&mut bytes[received..], budget) {
            IoCompletion::Completed(count) => {
                received += count;
                if count == 0 || Instant::now() >= deadline {
                    break;
                }
            }
            IoCompletion::Unconfirmed(code) | IoCompletion::NotSubmitted(code) => {
                let failure = os_error(code);
                if received == 0 {
                    return Err(failure);
                }
                // 已完成的前缀先交付，下一次读取再报告后续错误。
                error = Some(failure);
                break;
            }
        }
    }
    bytes.truncate(received);
    Ok((
        ReadBlock {
            bytes: bytes.into(),
            message: None,
        },
        error,
    ))
}

fn last_error() -> BackendError {
    os_error(unsafe { GetLastError() })
}

pub(super) fn enumerate(host_id: &Id) -> HostResult<Vec<DeviceDescriptor>> {
    use windows_sys::Win32::Devices::{DeviceAndDriverInstallation::*, Properties::*};
    use windows_sys::Win32::System::Registry::*;
    struct DeviceSet(HDEVINFO);
    impl Drop for DeviceSet {
        fn drop(&mut self) {
            unsafe {
                SetupDiDestroyDeviceInfoList(self.0);
            }
        }
    }
    struct RegistryKey(HKEY);
    impl Drop for RegistryKey {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }
    let set = unsafe {
        SetupDiGetClassDevsW(
            &GUID_DEVCLASS_PORTS,
            std::ptr::null(),
            std::ptr::null_mut(),
            DIGCF_PRESENT,
        )
    };
    if set == -1 {
        return Err(*last_error().error);
    }
    let set = DeviceSet(set);
    let mut devices = Vec::new();
    for index in 0..4096 {
        let mut info = SP_DEVINFO_DATA {
            cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32,
            ..Default::default()
        };
        if unsafe { SetupDiEnumDeviceInfo(set.0, index, &mut info) } == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_NO_MORE_ITEMS {
                return Ok(devices);
            }
            return Err(*os_error(error).error);
        }
        let key = unsafe {
            SetupDiOpenDevRegKey(
                set.0,
                &info,
                DICS_FLAG_GLOBAL,
                0,
                DIREG_DEV,
                KEY_QUERY_VALUE,
            )
        };
        if key as isize == -1 {
            continue;
        }
        let key = RegistryKey(key);
        let value_name: Vec<u16> = "PortName".encode_utf16().chain(Some(0)).collect();
        let mut buffer = vec![0u16; 256];
        let mut bytes = (buffer.len() * 2) as u32;
        let mut kind = 0;
        if unsafe {
            RegQueryValueExW(
                key.0,
                value_name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            )
        } != ERROR_SUCCESS
            || kind != REG_SZ
            || bytes as usize > buffer.len() * 2
            || !bytes.is_multiple_of(2)
        {
            continue;
        }
        let Some(system_name) = decode_wide(&buffer[..bytes as usize / 2]) else {
            continue;
        };
        if !system_name
            .strip_prefix("COM")
            .is_some_and(|number| !number.is_empty() && number.bytes().all(|v| v.is_ascii_digit()))
        {
            continue;
        }
        let description = registry_property(set.0, &info, SPDRP_FRIENDLYNAME)
            .or_else(|| registry_property(set.0, &info, SPDRP_DEVICEDESC));
        let manufacturer = registry_property(set.0, &info, SPDRP_MFG);
        let hardware = registry_property(set.0, &info, SPDRP_HARDWAREID);
        let vid = hardware.as_deref().and_then(|id| usb_hex(id, "VID_"));
        let pid = hardware.as_deref().and_then(|id| usb_hex(id, "PID_"));
        let topology_path = registry_property(set.0, &info, SPDRP_LOCATION_PATHS)
            .or_else(|| registry_property(set.0, &info, SPDRP_LOCATION_INFORMATION));
        let serial_number = usb_serial(info.DevInst);
        let driver = device_property(set.0, &info, &DEVPKEY_Device_DriverVersion).map(|version| {
            device_property(set.0, &info, &DEVPKEY_Device_DriverProvider).map_or_else(
                || version.clone(),
                |provider| format!("{provider} {version}"),
            )
        });
        let evidence = if serial_number.is_some() {
            IdentityEvidence::SerialNumber
        } else if topology_path.is_some() {
            IdentityEvidence::Topology
        } else {
            IdentityEvidence::Unreliable
        };
        devices.push(DeviceDescriptor {
            device_id: Id::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
            host_id: host_id.clone(),
            system_name,
            description,
            manufacturer,
            driver,
            fingerprint: DeviceFingerprint {
                transport: DeviceTransportKind::Serial,
                vid,
                pid,
                serial_number,
                topology_path,
                evidence,
            },
            capabilities: super::serial_capabilities(),
        });
    }
    Err(HostError::new(
        "LIMIT_EXCEEDED",
        "OS serial enumeration exceeds its bounded capacity",
    ))
}

fn decode_wide(value: &[u16]) -> Option<String> {
    let count = value
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(value.len());
    String::from_utf16(&value[..count])
        .ok()
        .filter(|value| !value.is_empty())
}
fn registry_property(
    set: isize,
    info: &windows_sys::Win32::Devices::DeviceAndDriverInstallation::SP_DEVINFO_DATA,
    property: u32,
) -> Option<String> {
    use windows_sys::Win32::{
        Devices::DeviceAndDriverInstallation::SetupDiGetDeviceRegistryPropertyW,
        System::Registry::{REG_MULTI_SZ, REG_SZ},
    };
    let mut value = vec![0u16; 8192];
    let mut kind = 0;
    let mut bytes = 0;
    if unsafe {
        SetupDiGetDeviceRegistryPropertyW(
            set,
            info,
            property,
            &mut kind,
            value.as_mut_ptr().cast(),
            (value.len() * 2) as u32,
            &mut bytes,
        )
    } == 0
        || !matches!(kind, REG_SZ | REG_MULTI_SZ)
        || bytes as usize > value.len() * 2
        || bytes % 2 != 0
    {
        return None;
    }
    decode_wide(&value[..bytes as usize / 2])
}
fn device_property(
    set: isize,
    info: &windows_sys::Win32::Devices::DeviceAndDriverInstallation::SP_DEVINFO_DATA,
    property: &DEVPROPKEY,
) -> Option<String> {
    use windows_sys::Win32::Devices::{
        DeviceAndDriverInstallation::SetupDiGetDevicePropertyW, Properties::DEVPROP_TYPE_STRING,
    };
    let mut value = vec![0u16; 8192];
    let mut kind = 0;
    let mut bytes = 0;
    if unsafe {
        SetupDiGetDevicePropertyW(
            set,
            info,
            property,
            &mut kind,
            value.as_mut_ptr().cast(),
            (value.len() * 2) as u32,
            &mut bytes,
            0,
        )
    } == 0
        || kind != DEVPROP_TYPE_STRING
        || bytes as usize > value.len() * 2
        || bytes % 2 != 0
    {
        return None;
    }
    decode_wide(&value[..bytes as usize / 2])
}
fn usb_hex(value: &str, marker: &str) -> Option<u16> {
    let start = value.find(marker)? + marker.len();
    u16::from_str_radix(value.get(start..start + 4)?, 16).ok()
}
fn usb_serial(mut node: u32) -> Option<String> {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::*;
    for _ in 0..16 {
        let mut identifier = [0u16; 256];
        if unsafe { CM_Get_Device_IDW(node, identifier.as_mut_ptr(), identifier.len() as u32, 0) }
            != CR_SUCCESS
        {
            return None;
        }
        let id = decode_wide(&identifier)?;
        if id.starts_with("USB\\VID_") && !id.contains("&MI_") {
            let mut caps = 0u32;
            let mut kind = 0;
            let mut length = 4u32;
            if unsafe {
                CM_Get_DevNode_Registry_PropertyW(
                    node,
                    CM_DRP_CAPABILITIES,
                    &mut kind,
                    (&mut caps as *mut u32).cast(),
                    &mut length,
                    0,
                )
            } == CR_SUCCESS
                && length == 4
                && caps & CM_DEVCAP_UNIQUEID != 0
            {
                return id
                    .rsplit('\\')
                    .next()
                    .filter(|serial| !serial.is_empty())
                    .map(str::to_owned);
            }
            return None;
        }
        let mut parent = 0;
        if unsafe { CM_Get_Parent(&mut parent, node, 0) } != CR_SUCCESS {
            return None;
        }
        node = parent;
    }
    None
}

pub(super) fn interrupt_thread(join: &std::thread::JoinHandle<()>) {
    use std::os::windows::io::AsRawHandle;
    // JoinHandle 保有线程内核对象；只请求中断，不释放设备或推断完成。
    unsafe {
        windows_sys::Win32::System::IO::CancelSynchronousIo(join.as_raw_handle());
    }
}

fn encode_dcb(mut baseline: DCB, config: &SerialConfiguration) -> BackendResult<DCB> {
    if matches!(
        (config.data_bits, config.stop_bits),
        (DataBits::Five, StopBits::Two)
            | (
                DataBits::Six | DataBits::Seven | DataBits::Eight,
                StopBits::OnePointFive
            )
    ) {
        return Err(super::unsupported(
            "The data width and stop width combination is unavailable",
        ));
    }
    baseline.DCBlength = std::mem::size_of::<DCB>() as u32;
    baseline.BaudRate = config
        .baud_rate
        .get()
        .try_into()
        .map_err(|_| super::unsupported("Baud rate exceeds the driver representation"))?;
    baseline.ByteSize = match config.data_bits {
        DataBits::Five => 5,
        DataBits::Six => 6,
        DataBits::Seven => 7,
        DataBits::Eight => 8,
    };
    baseline.Parity = match config.parity {
        Parity::None => NOPARITY,
        Parity::Odd => ODDPARITY,
        Parity::Even => EVENPARITY,
        Parity::Mark => MARKPARITY,
        Parity::Space => SPACEPARITY,
    };
    baseline.StopBits = match config.stop_bits {
        StopBits::One => ONESTOPBIT,
        StopBits::OnePointFive => ONE5STOPBITS,
        StopBits::Two => TWOSTOPBITS,
    };
    // 清除驱动遗留的数据转换与旧流控；保留协议保留位，普通模式启用 DTR/RTS。
    baseline._bitfield = (baseline._bitfield & !0x7fff)
        | 1
        | (u32::from(config.parity != Parity::None) << 1)
        | (1 << 4)
        | (1 << 12);
    match config.flow_control {
        FlowControl::None => {}
        FlowControl::RtsCts => {
            baseline._bitfield = (baseline._bitfield & !(3 << 12)) | (2 << 12) | (1 << 2)
        }
        FlowControl::DsrDtr => {
            baseline._bitfield = (baseline._bitfield & !(3 << 4)) | (2 << 4) | (1 << 3)
        }
        FlowControl::XonXoff => {
            baseline._bitfield |= (1 << 8) | (1 << 9);
            baseline.XonChar = 0x11;
            baseline.XoffChar = 0x13;
        }
    }
    Ok(baseline)
}

fn decode_dcb(actual: &DCB, policy: &SerialConfiguration) -> BackendResult<SerialConfiguration> {
    let bits = actual._bitfield;
    if bits & 1 == 0 || bits & ((1 << 6) | (1 << 10) | (1 << 11) | (1 << 14)) != 0 {
        return Err(super::unsupported(
            "Driver enabled byte conversion or receive filtering",
        ));
    }
    let flow_control = match (
        bits & (1 << 2) != 0,
        bits & (1 << 3) != 0,
        (bits >> 4) & 3,
        (bits >> 12) & 3,
        (bits >> 8) & 3,
    ) {
        (false, false, 0 | 1, 0 | 1, 0) => FlowControl::None,
        (true, false, 0 | 1, 2, 0) => FlowControl::RtsCts,
        (false, true, 2, 0 | 1, 0) => FlowControl::DsrDtr,
        (false, false, 0 | 1, 0 | 1, 3) => FlowControl::XonXoff,
        _ => {
            return Err(super::unsupported(
                "Driver returned an unsupported flow-control combination",
            ));
        }
    };
    Ok(SerialConfiguration {
        baud_rate: PositiveU64::try_from(U64::from(u64::from(actual.BaudRate)))
            .map_err(BackendError::from)?,
        data_bits: match actual.ByteSize {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            _ => {
                return Err(super::unsupported(
                    "Driver returned an unsupported data width",
                ));
            }
        },
        parity: match actual.Parity {
            NOPARITY => Parity::None,
            ODDPARITY => Parity::Odd,
            EVENPARITY => Parity::Even,
            MARKPARITY => Parity::Mark,
            SPACEPARITY => Parity::Space,
            _ => return Err(super::unsupported("Driver returned an unsupported parity")),
        },
        stop_bits: match actual.StopBits {
            ONESTOPBIT => StopBits::One,
            ONE5STOPBITS => StopBits::OnePointFive,
            TWOSTOPBITS => StopBits::Two,
            _ => {
                return Err(super::unsupported(
                    "Driver returned an unsupported stop width",
                ));
            }
        },
        flow_control,
        read_wait_ms: policy.read_wait_ms,
        write_wait_ms: policy.write_wait_ms,
        reconnect_backoff_ms: policy.reconnect_backoff_ms,
    })
}

enum IoCompletion {
    Completed(usize),
    Unconfirmed(u32),
    NotSubmitted(u32),
}

fn settle_write(accepted: usize, submitted: usize, result: IoCompletion) -> BackendWrite {
    let (accepted, unknown_ranges, error) = match result {
        IoCompletion::Completed(count) => (accepted + count, vec![], None),
        IoCompletion::NotSubmitted(code) => (accepted, vec![], Some(*os_error(code).error)),
        IoCompletion::Unconfirmed(code) => (
            accepted,
            if submitted == 0 {
                vec![]
            } else {
                vec![super::range(accepted, accepted + submitted)]
            },
            Some(*os_error(code).error),
        ),
    };
    BackendWrite {
        accepted_ranges: if accepted == 0 {
            vec![]
        } else {
            vec![super::range(0, accepted)]
        },
        unknown_ranges,
        error,
    }
}

fn os_error(code: u32) -> BackendError {
    let stable = match code {
        2 | 3 | 6 | 31 | 1167 => "BACKEND_DISCONNECTED",
        5 => "ACCESS_DENIED",
        32 => "DEVICE_BUSY",
        87 => "UNSUPPORTED_CAPABILITY",
        995 => "CANCELLED",
        1460 => "WRITE_TIMEOUT",
        _ => "BACKEND_IO",
    };
    super::native_error(stable, u64::from(code))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receive_burst_collects_fragments_and_retains_a_completed_prefix_before_failure() {
        let mut calls = 0;
        let (block, error) = read_burst(16, Duration::from_secs(1), |bytes, _| {
            calls += 1;
            match calls {
                1 => {
                    bytes[..2].copy_from_slice(&[1, 2]);
                    IoCompletion::Completed(2)
                }
                2 => {
                    bytes[..3].copy_from_slice(&[3, 4, 5]);
                    IoCompletion::Completed(3)
                }
                _ => IoCompletion::Unconfirmed(ERROR_ACCESS_DENIED),
            }
        })
        .unwrap();
        assert_eq!(&*block.bytes, &[1, 2, 3, 4, 5]);
        assert!(error.is_some());
        assert_eq!(calls, 3);
        let (block, error) =
            read_burst(0, Duration::ZERO, |_, _| panic!("zero limit submitted I/O")).unwrap();
        assert!(block.bytes.is_empty());
        assert!(error.is_none());
    }

    #[test]
    fn continuous_reads_have_a_short_finite_first_byte_wait() {
        for (requested, actual) in [(0, 1), (1, 1), (5, 2), (20, 2), (500, 2)] {
            let timeouts = read_timeouts(requested);
            assert_eq!(timeouts.ReadIntervalTimeout, u32::MAX);
            assert_eq!(timeouts.ReadTotalTimeoutMultiplier, u32::MAX);
            assert_eq!(timeouts.ReadTotalTimeoutConstant, actual);
        }
    }
    type TestClaims = Arc<std::sync::Mutex<std::collections::HashMap<Id, Vec<String>>>>;

    fn isolated_event_port() -> (WindowsPort, TestClaims) {
        let id = Id::try_from("isolated-event-port").unwrap();
        let claims = Arc::new(std::sync::Mutex::new(std::collections::HashMap::from([(
            id.clone(),
            vec!["locator:test-event".to_owned()],
        )])));
        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        assert!(!handle.is_null());
        let resource = Arc::new(PortResource::new(
            unsafe { OwnedHandle::from_raw_handle(handle) },
            super::super::SerialClaim {
                id,
                claims: claims.clone(),
                isolated: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                released: false,
            },
        ));
        (
            WindowsPort {
                port: Some(resource),
                configuration: SerialConfiguration::default(),
                pending_read_error: None,
            },
            claims,
        )
    }

    #[test]
    fn isolated_serial_handle_releases_claim_on_confirmed_close() {
        let (mut port, claims) = isolated_event_port();
        super::super::NativePort::close(&mut port).unwrap();
        assert!(claims.lock().unwrap().is_empty());
    }

    #[test]
    fn isolated_serial_handle_keeps_claim_until_held_io_reference_is_released() {
        let (mut port, claims) = isolated_event_port();
        let held_io = port.resource().unwrap().clone();
        let closing = super::super::NativePort::close(&mut port).unwrap_err();
        assert_eq!(closing.error.code, "CONTROL_UNKNOWN");
        assert_eq!(claims.lock().unwrap().len(), 1);
        let completion = closing
            .cleanup
            .expect("deferred close must retain actual completion");
        assert!(completion.poll().is_none());
        drop(held_io);
        assert_eq!(completion.poll(), Some(Ok(())));
        assert!(claims.lock().unwrap().is_empty());
    }

    struct States {
        reads: std::collections::VecDeque<Result<DCB, u32>>,
        written: Vec<DCB>,
        calls: Vec<&'static str>,
    }
    impl CommStateApi for States {
        fn get(&mut self) -> Result<DCB, u32> {
            self.calls.push("get");
            self.reads.pop_front().unwrap()
        }
        fn set(&mut self, state: &DCB) -> Result<(), u32> {
            self.calls.push("set");
            self.written.push(*state);
            Ok(())
        }
    }
    #[test]
    fn driver_calls_preserve_all_data_parity_stop_and_handshake_choices() {
        for (data_bits, width, stop_bits, stop) in [
            (DataBits::Five, 5, StopBits::OnePointFive, ONE5STOPBITS),
            (DataBits::Six, 6, StopBits::Two, TWOSTOPBITS),
            (DataBits::Seven, 7, StopBits::Two, TWOSTOPBITS),
            (DataBits::Eight, 8, StopBits::One, ONESTOPBIT),
        ] {
            for (parity, wire) in [
                (Parity::None, NOPARITY),
                (Parity::Even, EVENPARITY),
                (Parity::Odd, ODDPARITY),
                (Parity::Mark, MARKPARITY),
                (Parity::Space, SPACEPARITY),
            ] {
                for (flow_control, flags) in [
                    (FlowControl::None, 0x1011),
                    (FlowControl::RtsCts, 0x2015),
                    (FlowControl::DsrDtr, 0x1029),
                    (FlowControl::XonXoff, 0x1311),
                ] {
                    let requested = SerialConfiguration {
                        data_bits,
                        parity,
                        stop_bits,
                        flow_control,
                        ..Default::default()
                    };
                    let expected_flags = flags | if parity == Parity::None { 0 } else { 2 };
                    let observed = DCB {
                        BaudRate: requested.baud_rate.get() as u32,
                        ByteSize: width,
                        Parity: wire,
                        StopBits: stop,
                        _bitfield: expected_flags,
                        XonChar: 0x11,
                        XoffChar: 0x13,
                        ..Default::default()
                    };
                    let mut api = States {
                        reads: [Ok(DCB::default()), Ok(observed)].into(),
                        written: vec![],
                        calls: vec![],
                    };
                    let actual = apply_configuration(&mut api, &requested).unwrap();
                    assert_eq!(api.calls, ["get", "set", "get"]);
                    assert_eq!(api.written[0].ByteSize, width);
                    assert_eq!(api.written[0].Parity, wire);
                    assert_eq!(api.written[0].StopBits, stop);
                    assert_eq!(api.written[0]._bitfield, expected_flags);
                    assert_eq!(actual.data_bits, data_bits);
                    assert_eq!(actual.parity, parity);
                    assert_eq!(actual.stop_bits, stop_bits);
                    assert_eq!(actual.flow_control, flow_control);
                }
            }
        }
    }
    #[test]
    fn configuration_calls_get_set_get_and_reports_the_second_driver_value() {
        let requested = SerialConfiguration::default();
        let observed = DCB {
            BaudRate: 115200,
            ByteSize: 7,
            Parity: SPACEPARITY,
            StopBits: TWOSTOPBITS,
            _bitfield: 0x303,
            ..Default::default()
        };
        let mut api = States {
            reads: [Ok(DCB::default()), Ok(observed)].into(),
            written: vec![],
            calls: vec![],
        };
        let actual = apply_configuration(&mut api, &requested).unwrap();
        assert_eq!(api.calls, ["get", "set", "get"]);
        assert_eq!(api.written[0].BaudRate, requested.baud_rate.get() as u32);
        assert_eq!(api.written[0].ByteSize, 8);
        assert_eq!(api.written[0].DCBlength, std::mem::size_of::<DCB>() as u32);
        assert_eq!(actual.baud_rate.get(), 115200);
        assert_eq!(actual.data_bits, DataBits::Seven);
        assert_eq!(actual.parity, Parity::Space);
        assert_eq!(actual.stop_bits, StopBits::Two);
    }
    #[test]
    fn failed_driver_readback_cannot_be_replaced_with_the_requested_configuration() {
        let mut api = States {
            reads: [Ok(DCB::default()), Err(ERROR_ACCESS_DENIED)].into(),
            written: vec![],
            calls: vec![],
        };
        assert_eq!(
            apply_configuration(&mut api, &SerialConfiguration::default())
                .unwrap_err()
                .error
                .code,
            "ACCESS_DENIED"
        );
        assert_eq!(api.calls, ["get", "set", "get"]);
    }

    struct OverlappedCalls {
        completions: std::collections::VecDeque<Result<usize, u32>>,
        cancellation: Result<(), u32>,
        cancel_on_submit: Arc<std::sync::atomic::AtomicBool>,
        submitted: Vec<u8>,
        address: Option<usize>,
        calls: Vec<&'static str>,
    }
    impl OverlappedApi for OverlappedCalls {
        fn submit(&mut self, buffer: IoBuffer<'_>, overlapped: &mut OVERLAPPED) -> Result<(), u32> {
            self.calls.push("submit");
            self.address = Some(overlapped as *const OVERLAPPED as usize);
            assert!(!overlapped.hEvent.is_null());
            self.submitted = match buffer {
                IoBuffer::Write(bytes) => bytes.to_vec(),
                IoBuffer::Read(_) => panic!("write fixture"),
            };
            self.cancel_on_submit
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Err(ERROR_IO_PENDING)
        }
        fn completion(&mut self, overlapped: &OVERLAPPED, wait: Option<u32>) -> Result<usize, u32> {
            assert_eq!(self.address, Some(overlapped as *const OVERLAPPED as usize));
            assert!(!overlapped.hEvent.is_null());
            self.calls
                .push(if wait.is_some() { "wait" } else { "reap" });
            self.completions.pop_front().unwrap()
        }
        fn cancel(&mut self, overlapped: &OVERLAPPED) -> Result<(), u32> {
            assert_eq!(self.address, Some(overlapped as *const OVERLAPPED as usize));
            self.calls.push("cancel");
            self.cancellation
        }
    }
    fn signals(cancelled: Arc<std::sync::atomic::AtomicBool>) -> super::super::WriteSignals {
        super::super::WriteSignals {
            cancelled,
            closing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            abandoned: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            isolated: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
    #[test]
    fn overlapped_cancel_not_found_still_reaps_a_successful_short_completion() {
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut api = OverlappedCalls {
            completions: [Err(WAIT_TIMEOUT), Ok(3)].into(),
            cancellation: Err(ERROR_NOT_FOUND),
            cancel_on_submit: cancelled.clone(),
            submitted: vec![],
            address: None,
            calls: vec![],
        };
        let progress = Arc::new(std::sync::Mutex::new(super::super::WriteProgress {
            accepted: 4,
            submitted_end: 4,
        }));
        let result = overlapped_io(
            &mut api,
            IoBuffer::Write(&[1, 2, 3, 4, 5, 6]),
            Duration::from_secs(1),
            Some(&signals(cancelled)),
            Some((&progress, 4)),
        );
        assert_eq!(api.calls, ["submit", "wait", "cancel", "reap"]);
        assert_eq!(api.submitted, [1, 2, 3, 4, 5, 6]);
        let receipt = settle_write(4, 6, result);
        assert_eq!(receipt.accepted_ranges, [super::super::range(0, 7)]);
        assert!(receipt.unknown_ranges.is_empty());
        assert_eq!(progress.lock().unwrap().accepted, 7);
    }
    #[test]
    fn overlapped_cancel_reaps_abort_and_preserves_only_the_submitted_unknown_extent() {
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut api = OverlappedCalls {
            completions: [Err(WAIT_TIMEOUT), Err(ERROR_OPERATION_ABORTED)].into(),
            cancellation: Ok(()),
            cancel_on_submit: cancelled.clone(),
            submitted: vec![],
            address: None,
            calls: vec![],
        };
        let progress = Arc::new(std::sync::Mutex::new(super::super::WriteProgress {
            accepted: 4,
            submitted_end: 4,
        }));
        let result = overlapped_io(
            &mut api,
            IoBuffer::Write(&[1, 2, 3]),
            Duration::from_secs(1),
            Some(&signals(cancelled)),
            Some((&progress, 4)),
        );
        assert_eq!(api.calls, ["submit", "wait", "cancel", "reap"]);
        let receipt = settle_write(4, 3, result);
        assert_eq!(receipt.accepted_ranges, [super::super::range(0, 4)]);
        assert_eq!(receipt.unknown_ranges, [super::super::range(4, 7)]);
    }
    #[test]
    fn cancelled_before_submit_never_calls_the_overlapped_driver() {
        let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut api = OverlappedCalls {
            completions: [].into(),
            cancellation: Ok(()),
            cancel_on_submit: cancelled.clone(),
            submitted: vec![],
            address: None,
            calls: vec![],
        };
        let result = overlapped_io(
            &mut api,
            IoBuffer::Write(&[1, 2, 3]),
            Duration::from_secs(1),
            Some(&signals(cancelled)),
            None,
        );
        assert!(api.calls.is_empty());
        let receipt = settle_write(0, 3, result);
        assert!(receipt.accepted_ranges.is_empty());
        assert!(receipt.unknown_ranges.is_empty());
        assert_eq!(receipt.error.unwrap().code, "CANCELLED");
    }

    #[test]
    fn cancelled_overlapped_write_preserves_prior_prefix_and_only_marks_pending_extent_unknown() {
        let result = settle_write(4, 6, IoCompletion::Unconfirmed(995));
        assert_eq!(
            result.accepted_ranges,
            vec![ByteRange {
                start: 0.into(),
                end: 4.into()
            }]
        );
        assert_eq!(
            result.unknown_ranges,
            vec![ByteRange {
                start: 4.into(),
                end: 10.into()
            }]
        );
        assert!(result.error.is_some());
    }

    #[test]
    fn completion_winning_cancel_race_keeps_actual_short_count_known() {
        let result = settle_write(4, 6, IoCompletion::Completed(3));
        assert_eq!(
            result.accepted_ranges,
            vec![ByteRange {
                start: 0.into(),
                end: 7.into()
            }]
        );
        assert!(result.unknown_ranges.is_empty());
    }

    #[test]
    fn dcb_encodes_every_data_width_and_parity_without_data_conversion() {
        for (bits, expected) in [
            (DataBits::Five, 5),
            (DataBits::Six, 6),
            (DataBits::Seven, 7),
            (DataBits::Eight, 8),
        ] {
            for (parity, wire) in [
                (Parity::None, 0),
                (Parity::Odd, 1),
                (Parity::Even, 2),
                (Parity::Mark, 3),
                (Parity::Space, 4),
            ] {
                let config = SerialConfiguration {
                    data_bits: bits,
                    parity,
                    ..Default::default()
                };
                let dcb = encode_dcb(
                    DCB {
                        _bitfield: u32::MAX,
                        ..Default::default()
                    },
                    &config,
                )
                .unwrap();
                assert_eq!(dcb.ByteSize, expected);
                assert_eq!(dcb.Parity, wire);
                assert_eq!(dcb._bitfield & 1, 1);
                // 禁止丢 NUL、替换错误字符、DSR 丢 RX 与出错自动停传。
                assert_eq!(
                    dcb._bitfield & ((1 << 6) | (1 << 10) | (1 << 11) | (1 << 14)),
                    0
                );
                assert_eq!((dcb._bitfield >> 1) & 1, u32::from(parity != Parity::None));
            }
        }
    }

    #[test]
    fn dcb_reserves_dtr_for_real_dsr_handshake_and_encodes_stop_widths() {
        let mut config = SerialConfiguration {
            data_bits: DataBits::Five,
            stop_bits: StopBits::OnePointFive,
            flow_control: FlowControl::DsrDtr,
            ..Default::default()
        };
        let dcb = encode_dcb(DCB::default(), &config).unwrap();
        assert_eq!(dcb.StopBits, 1);
        assert_eq!(dcb._bitfield & 0x3c, 0x28);
        assert_eq!(dcb._bitfield & 0x40, 0);
        config.data_bits = DataBits::Eight;
        assert_eq!(
            encode_dcb(DCB::default(), &config)
                .err()
                .unwrap()
                .error
                .code,
            "UNSUPPORTED_CAPABILITY"
        );
        config.stop_bits = StopBits::Two;
        assert_eq!(encode_dcb(DCB::default(), &config).unwrap().StopBits, 2);
        config.data_bits = DataBits::Five;
        assert_eq!(
            encode_dcb(DCB::default(), &config)
                .err()
                .unwrap()
                .error
                .code,
            "UNSUPPORTED_CAPABILITY"
        );
    }

    #[test]
    fn dcb_rejects_baud_overflow_instead_of_truncation() {
        let config = SerialConfiguration {
            baud_rate: PositiveU64::try_from(U64::from(u64::from(u32::MAX) + 1)).unwrap(),
            ..Default::default()
        };
        assert_eq!(
            encode_dcb(DCB::default(), &config)
                .err()
                .unwrap()
                .error
                .code,
            "UNSUPPORTED_CAPABILITY"
        );
    }

    #[test]
    fn driver_readback_is_decoded_without_copying_requested_hardware_fields() {
        let requested = SerialConfiguration::default();
        let observed = DCB {
            BaudRate: 115200,
            ByteSize: 7,
            Parity: 4,
            StopBits: 2,
            _bitfield: 0x303,
            ..Default::default()
        };
        let actual = decode_dcb(&observed, &requested).unwrap();
        assert_eq!(actual.baud_rate.get(), 115200);
        assert_eq!(actual.data_bits, DataBits::Seven);
        assert_eq!(actual.parity, Parity::Space);
        assert_eq!(actual.stop_bits, StopBits::Two);
        assert_eq!(actual.flow_control, FlowControl::XonXoff);
        // 单向 XON 不是请求的完整双向 XON/XOFF，不能读回成成功。
        assert!(
            decode_dcb(
                &DCB {
                    _bitfield: 0x203,
                    ..observed
                },
                &requested
            )
            .is_err()
        );
    }
}
