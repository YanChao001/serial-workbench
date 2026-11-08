use serial_workbench_core::*;

const CDTR_IFLOW: libc::tcflag_t = 0x0004_0000;
const CDSR_OFLOW: libc::tcflag_t = 0x0008_0000;
const IOSSIOSPEED: libc::c_ulong = 0x8008_5402;
fn encode_termios(
    mut actual: libc::termios,
    requested: &SerialConfiguration,
) -> BackendResult<libc::termios> {
    if matches!(requested.parity, Parity::Mark | Parity::Space)
        || requested.stop_bits == StopBits::OnePointFive
        || (requested.data_bits == DataBits::Five && requested.stop_bits == StopBits::Two)
    {
        return Err(super::unsupported(
            "Darwin termios cannot represent the requested parity or stop width",
        ));
    }
    actual.c_iflag = if requested.flow_control == FlowControl::XonXoff {
        libc::IXON | libc::IXOFF
    } else {
        0
    };
    actual.c_oflag = 0;
    actual.c_lflag = 0;
    actual.c_cflag &= !(libc::CSIZE
        | libc::PARENB
        | libc::PARODD
        | libc::CSTOPB
        | libc::CRTSCTS
        | libc::CIGNORE
        | libc::MDMBUF
        | CDTR_IFLOW
        | CDSR_OFLOW);
    actual.c_cflag |= libc::CREAD | libc::CLOCAL;
    actual.c_cflag |= match requested.data_bits {
        DataBits::Five => libc::CS5,
        DataBits::Six => libc::CS6,
        DataBits::Seven => libc::CS7,
        DataBits::Eight => libc::CS8,
    };
    actual.c_cflag |= match requested.parity {
        Parity::None => 0,
        Parity::Even => libc::PARENB,
        Parity::Odd => libc::PARENB | libc::PARODD,
        _ => unreachable!(),
    };
    if requested.stop_bits == StopBits::Two {
        actual.c_cflag |= libc::CSTOPB;
    }
    actual.c_cflag |= match requested.flow_control {
        FlowControl::RtsCts => libc::CRTSCTS,
        FlowControl::DsrDtr => CDTR_IFLOW | CDSR_OFLOW,
        _ => 0,
    };
    actual.c_cc[libc::VMIN] = 0;
    actual.c_cc[libc::VTIME] = 0;
    actual.c_cc[libc::VSTART] = 0x11;
    actual.c_cc[libc::VSTOP] = 0x13;
    Ok(actual)
}

pub(super) fn configure(
    fd: i32,
    requested: &SerialConfiguration,
) -> BackendResult<ConfigApplication> {
    let mut value = std::mem::MaybeUninit::<libc::termios>::uninit();
    if unsafe { libc::tcgetattr(fd, value.as_mut_ptr()) } < 0 {
        return Err(super::unix::last_error());
    }
    let mut encoded = encode_termios(unsafe { value.assume_init() }, requested)?;
    let speed: libc::speed_t = requested.baud_rate.get();
    // 先尝试系统 termios 原生速率，再用 IOSSIOSPEED；最终仍只信 tcgetattr 读回。
    if unsafe { libc::cfsetspeed(&mut encoded, speed) } < 0 {
        return Err(super::unix::last_error());
    }
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &encoded) } < 0 {
        if unsafe { libc::cfsetspeed(&mut encoded, libc::B9600) } < 0
            || unsafe { libc::tcsetattr(fd, libc::TCSANOW, &encoded) } < 0
        {
            return Err(super::unix::last_error());
        }
        if unsafe { libc::ioctl(fd, IOSSIOSPEED, &speed) } < 0 {
            return Err(super::unix::last_error());
        }
    }
    let mut value = std::mem::MaybeUninit::<libc::termios>::uninit();
    if unsafe { libc::tcgetattr(fd, value.as_mut_ptr()) } < 0 {
        return Err(super::unix::last_error());
    }
    let actual = unsafe { value.assume_init() };
    let observed = decode_termios(&actual, requested)?;
    super::configuration_receipt(requested, &observed)
}
fn decode_termios(
    actual: &libc::termios,
    requested: &SerialConfiguration,
) -> BackendResult<SerialConfiguration> {
    let mut observed = requested.clone();
    let input = unsafe { libc::cfgetispeed(actual) };
    let output = unsafe { libc::cfgetospeed(actual) };
    if input != output
        || actual.c_cflag & (libc::CIGNORE | libc::MDMBUF) != 0
        || actual.c_cflag & (libc::CREAD | libc::CLOCAL) != libc::CREAD | libc::CLOCAL
        || actual.c_iflag & !(libc::IXON | libc::IXOFF) != 0
        || actual.c_oflag != 0
        || actual.c_lflag != 0
    {
        return Err(super::unsupported(
            "Darwin driver returned asymmetric speed or byte conversion",
        ));
    }
    observed.baud_rate = PositiveU64::try_from(U64::from(output)).map_err(BackendError::from)?;
    observed.data_bits = match actual.c_cflag & libc::CSIZE {
        libc::CS5 => DataBits::Five,
        libc::CS6 => DataBits::Six,
        libc::CS7 => DataBits::Seven,
        libc::CS8 => DataBits::Eight,
        _ => return Err(super::unsupported("Unknown driver data width")),
    };
    observed.parity = if actual.c_cflag & libc::PARENB == 0 {
        Parity::None
    } else if actual.c_cflag & libc::PARODD == 0 {
        Parity::Even
    } else {
        Parity::Odd
    };
    observed.stop_bits = if actual.c_cflag & libc::CSTOPB == 0 {
        StopBits::One
    } else {
        StopBits::Two
    };
    observed.flow_control = match (
        actual.c_cflag & libc::CRTSCTS,
        actual.c_cflag & (CDTR_IFLOW | CDSR_OFLOW),
        actual.c_iflag & (libc::IXON | libc::IXOFF),
    ) {
        (0, 0, 0) => FlowControl::None,
        (libc::CRTSCTS, 0, 0) => FlowControl::RtsCts,
        (0, value, 0) if value == CDTR_IFLOW | CDSR_OFLOW => FlowControl::DsrDtr,
        (0, 0, value) if value == libc::IXON | libc::IXOFF => FlowControl::XonXoff,
        _ => {
            return Err(super::unsupported(
                "Driver returned mixed or one-direction flow control",
            ));
        }
    };
    Ok(observed)
}

type CfRef = *const std::ffi::c_void;
#[link(name = "IOKit", kind = "framework")]
unsafe extern "C" {
    fn IOServiceMatching(name: *const libc::c_char) -> *mut std::ffi::c_void;
    fn IOServiceGetMatchingServices(
        port: u32,
        matching: *mut std::ffi::c_void,
        iterator: *mut u32,
    ) -> i32;
    fn IOIteratorNext(iterator: u32) -> u32;
    fn IOObjectRelease(object: u32) -> i32;
    fn IORegistryEntryCreateCFProperty(
        entry: u32,
        key: CfRef,
        allocator: CfRef,
        options: u32,
    ) -> CfRef;
    fn IORegistryEntrySearchCFProperty(
        entry: u32,
        plane: *const libc::c_char,
        key: CfRef,
        allocator: CfRef,
        options: u32,
    ) -> CfRef;
    fn IORegistryEntryGetPath(
        entry: u32,
        plane: *const libc::c_char,
        path: *mut libc::c_char,
    ) -> i32;
    fn IOObjectGetClass(entry: u32, name: *mut libc::c_char) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(
        allocator: CfRef,
        value: *const libc::c_char,
        encoding: u32,
    ) -> CfRef;
    fn CFStringGetCString(
        value: CfRef,
        buffer: *mut libc::c_char,
        size: isize,
        encoding: u32,
    ) -> bool;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFGetTypeID(value: CfRef) -> usize;
    fn CFNumberGetValue(value: CfRef, kind: isize, output: *mut std::ffi::c_void) -> bool;
    fn CFRelease(value: CfRef);
}
struct CfValue(CfRef);
impl Drop for CfValue {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CFRelease(self.0);
            }
        }
    }
}
struct IoObject(u32);
impl Drop for IoObject {
    fn drop(&mut self) {
        unsafe {
            IOObjectRelease(self.0);
        }
    }
}

fn property(entry: u32, name: &str, parents: bool) -> Option<CfValue> {
    let name = std::ffi::CString::new(name).ok()?;
    let key =
        CfValue(unsafe { CFStringCreateWithCString(std::ptr::null(), name.as_ptr(), 0x0800_0100) });
    if key.0.is_null() {
        return None;
    }
    let value = unsafe {
        if parents {
            IORegistryEntrySearchCFProperty(
                entry,
                c"IOService".as_ptr(),
                key.0,
                std::ptr::null(),
                3,
            )
        } else {
            IORegistryEntryCreateCFProperty(entry, key.0, std::ptr::null(), 0)
        }
    };
    (!value.is_null()).then_some(CfValue(value))
}
fn string_property(entry: u32, name: &str, parents: bool) -> Option<String> {
    let value = property(entry, name, parents)?;
    if unsafe { CFGetTypeID(value.0) != CFStringGetTypeID() } {
        return None;
    }
    let mut buffer = [0 as libc::c_char; 4096];
    if !unsafe {
        CFStringGetCString(
            value.0,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            0x0800_0100,
        )
    } {
        return None;
    }
    unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .ok()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}
fn number_property(entry: u32, name: &str) -> Option<u16> {
    let value = property(entry, name, true)?;
    if unsafe { CFGetTypeID(value.0) != CFNumberGetTypeID() } {
        return None;
    }
    let mut number: i64 = 0;
    if !unsafe { CFNumberGetValue(value.0, 4, (&mut number as *mut i64).cast()) } {
        return None;
    }
    number.try_into().ok()
}
pub(super) fn enumerate(host_id: &Id) -> HostResult<Vec<DeviceDescriptor>> {
    let matching = unsafe { IOServiceMatching(c"IOSerialBSDClient".as_ptr()) };
    if matching.is_null() {
        return Err(HostError::new(
            "BACKEND_ENUMERATION",
            "IOKit serial matching could not be created",
        ));
    }
    let mut iterator = 0;
    // IOKit 消费匹配字典的引用，迭代器与每项 service 分别释放。
    if unsafe { IOServiceGetMatchingServices(0, matching, &mut iterator) } != 0 {
        return Err(HostError::new(
            "BACKEND_ENUMERATION",
            "IOKit serial enumeration failed",
        ));
    }
    let iterator = IoObject(iterator);
    let mut devices = Vec::new();
    for _ in 0..4096 {
        let service = unsafe { IOIteratorNext(iterator.0) };
        if service == 0 {
            return Ok(devices);
        }
        let service = IoObject(service);
        let Some(system_name) = string_property(service.0, "IOCalloutDevice", false) else {
            continue;
        };
        let mut path = [0 as libc::c_char; 512];
        let topology_path = if unsafe {
            IORegistryEntryGetPath(service.0, c"IOService".as_ptr(), path.as_mut_ptr())
        } == 0
        {
            unsafe { std::ffi::CStr::from_ptr(path.as_ptr()) }
                .to_str()
                .ok()
                .map(str::to_owned)
        } else {
            None
        };
        let serial_number = string_property(service.0, "USB Serial Number", true);
        let description = string_property(service.0, "USB Product Name", true);
        let manufacturer = string_property(service.0, "USB Vendor Name", true);
        let mut class = [0 as libc::c_char; 128];
        let driver = if unsafe { IOObjectGetClass(service.0, class.as_mut_ptr()) } == 0 {
            unsafe { std::ffi::CStr::from_ptr(class.as_ptr()) }
                .to_str()
                .ok()
                .map(str::to_owned)
        } else {
            None
        };
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
                vid: number_property(service.0, "idVendor"),
                pid: number_property(service.0, "idProduct"),
                serial_number,
                topology_path,
                evidence,
            },
            capabilities: super::serial_capabilities(),
        });
    }
    Err(HostError::new(
        "LIMIT_EXCEEDED",
        "OS serial enumeration exceeds its capacity",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn darwin_clears_inherited_ignore_and_carrier_output_flow() {
        let mut baseline: libc::termios = unsafe { std::mem::zeroed() };
        baseline.c_cflag = libc::CIGNORE | libc::MDMBUF;
        let encoded = encode_termios(baseline, &SerialConfiguration::default()).unwrap();
        assert_eq!(encoded.c_cflag & (libc::CIGNORE | libc::MDMBUF), 0);
        assert_eq!(
            encoded.c_cflag & (libc::CREAD | libc::CLOCAL),
            libc::CREAD | libc::CLOCAL
        );
    }
    #[test]
    fn darwin_readback_rejects_receive_disable_and_carrier_output_flow() {
        let config = SerialConfiguration::default();
        let mut actual = encode_termios(unsafe { std::mem::zeroed() }, &config).unwrap();
        actual.c_ispeed = config.baud_rate.get();
        actual.c_ospeed = config.baud_rate.get();
        assert!(decode_termios(&actual, &config).is_ok());
        for (set, clear) in [
            (libc::CIGNORE, 0),
            (libc::MDMBUF, 0),
            (0, libc::CREAD),
            (0, libc::CLOCAL),
        ] {
            let mut changed = actual;
            changed.c_cflag = (changed.c_cflag | set) & !clear;
            assert_eq!(
                decode_termios(&changed, &config).err().unwrap().error.code,
                "UNSUPPORTED_CAPABILITY"
            );
        }
    }
    #[test]
    fn darwin_encodes_both_dsr_dtr_flow_directions() {
        let config = SerialConfiguration {
            flow_control: FlowControl::DsrDtr,
            ..Default::default()
        };
        let baseline = unsafe { std::mem::zeroed() };
        let encoded = encode_termios(baseline, &config).unwrap();
        assert_eq!(encoded.c_cflag & 0xc0000, 0xc0000);
    }

    #[test]
    fn darwin_rejects_mark_space_and_half_stop_without_approximations() {
        for config in [
            SerialConfiguration {
                parity: Parity::Mark,
                ..Default::default()
            },
            SerialConfiguration {
                parity: Parity::Space,
                ..Default::default()
            },
            SerialConfiguration {
                data_bits: DataBits::Five,
                stop_bits: StopBits::OnePointFive,
                ..Default::default()
            },
        ] {
            let baseline = unsafe { std::mem::zeroed() };
            assert_eq!(
                encode_termios(baseline, &config).err().unwrap().error.code,
                "UNSUPPORTED_CAPABILITY"
            );
        }
    }
}
