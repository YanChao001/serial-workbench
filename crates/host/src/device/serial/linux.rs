use serial_workbench_core::*;

fn encode_termios2(
    mut actual: libc::termios2,
    requested: &SerialConfiguration,
) -> BackendResult<libc::termios2> {
    if requested.flow_control == FlowControl::DsrDtr
        || requested.stop_bits == StopBits::OnePointFive
        || (requested.data_bits == DataBits::Five && requested.stop_bits == StopBits::Two)
    {
        return Err(super::unsupported(
            "Linux termios cannot represent the requested handshake or stop width",
        ));
    }
    let baud: u32 = requested
        .baud_rate
        .get()
        .try_into()
        .map_err(|_| super::unsupported("Baud rate exceeds the Linux driver representation"))?;
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
        | libc::CMSPAR
        | libc::CSTOPB
        | libc::CRTSCTS
        | libc::CBAUD
        | libc::CIBAUD);
    actual.c_cflag |= libc::CREAD | libc::CLOCAL | libc::BOTHER;
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
        Parity::Mark => libc::PARENB | libc::CMSPAR | libc::PARODD,
        Parity::Space => libc::PARENB | libc::CMSPAR,
    };
    if requested.stop_bits == StopBits::Two {
        actual.c_cflag |= libc::CSTOPB;
    }
    if requested.flow_control == FlowControl::RtsCts {
        actual.c_cflag |= libc::CRTSCTS;
    }
    actual.c_ispeed = baud;
    actual.c_ospeed = baud;
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
    let mut actual = std::mem::MaybeUninit::<libc::termios2>::uninit();
    if unsafe { libc::ioctl(fd, libc::TCGETS2, actual.as_mut_ptr()) } < 0 {
        return Err(super::unix::last_error());
    }
    let encoded = encode_termios2(unsafe { actual.assume_init() }, requested)?;
    if unsafe { libc::ioctl(fd, libc::TCSETS2, &encoded) } < 0 {
        return Err(super::unix::last_error());
    }
    if unsafe { libc::ioctl(fd, libc::TCGETS2, actual.as_mut_ptr()) } < 0 {
        return Err(super::unix::last_error());
    }
    let observed = decode_termios2(&unsafe { actual.assume_init() }, requested)?;
    super::configuration_receipt(requested, &observed)
}

fn decode_termios2(
    actual: &libc::termios2,
    policy: &SerialConfiguration,
) -> BackendResult<SerialConfiguration> {
    let mut observed = policy.clone();
    observed.baud_rate =
        PositiveU64::try_from(U64::from(u64::from(actual.c_ospeed))).map_err(BackendError::from)?;
    if actual.c_ispeed != actual.c_ospeed
        || actual.c_cflag & (libc::CREAD | libc::CLOCAL) != libc::CREAD | libc::CLOCAL
        || actual.c_iflag & !(libc::IXON | libc::IXOFF) != 0
        || actual.c_oflag != 0
        || actual.c_lflag != 0
    {
        return Err(super::unsupported(
            "Driver returned asymmetric speeds or byte conversion",
        ));
    }
    observed.data_bits = match actual.c_cflag & libc::CSIZE {
        libc::CS5 => DataBits::Five,
        libc::CS6 => DataBits::Six,
        libc::CS7 => DataBits::Seven,
        libc::CS8 => DataBits::Eight,
        _ => return Err(super::unsupported("Unknown driver data width")),
    };
    observed.parity = if actual.c_cflag & libc::PARENB == 0 {
        Parity::None
    } else {
        match (
            actual.c_cflag & libc::CMSPAR != 0,
            actual.c_cflag & libc::PARODD != 0,
        ) {
            (true, true) => Parity::Mark,
            (true, false) => Parity::Space,
            (false, true) => Parity::Odd,
            (false, false) => Parity::Even,
        }
    };
    observed.stop_bits = if actual.c_cflag & libc::CSTOPB == 0 {
        StopBits::One
    } else if observed.data_bits == DataBits::Five {
        return Err(super::unsupported("Five-bit stop width cannot be verified"));
    } else {
        StopBits::Two
    };
    observed.flow_control = match (
        actual.c_cflag & libc::CRTSCTS != 0,
        actual.c_iflag & (libc::IXON | libc::IXOFF),
    ) {
        (false, 0) => FlowControl::None,
        (true, 0) => FlowControl::RtsCts,
        (false, value) if value == libc::IXON | libc::IXOFF => FlowControl::XonXoff,
        _ => {
            return Err(super::unsupported(
                "Driver returned mixed or one-direction flow control",
            ));
        }
    };
    Ok(observed)
}

pub(super) fn enumerate(host_id: &Id) -> HostResult<Vec<DeviceDescriptor>> {
    let directory = std::fs::read_dir("/sys/class/tty")
        .map_err(|_| HostError::new("BACKEND_ENUMERATION", "System serial enumeration failed"))?;
    let mut devices = Vec::new();
    for entry in directory {
        let entry = entry.map_err(|_| {
            HostError::new(
                "BACKEND_ENUMERATION",
                "System serial enumeration changed during read",
            )
        })?;
        let Ok(path) = entry.path().join("device").canonicalize() else {
            continue;
        };
        let device_node = std::path::Path::new("/dev").join(entry.file_name());
        if !device_node.exists() {
            continue;
        }
        let mut vid = None;
        let mut pid = None;
        let mut serial_number = None;
        let mut manufacturer = None;
        let mut description = None;
        let mut driver = None;
        for ancestor in path.ancestors().take(16) {
            if driver.is_none() {
                driver = std::fs::read_link(ancestor.join("driver"))
                    .ok()
                    .and_then(|link| {
                        link.file_name()
                            .map(|value| value.to_string_lossy().into_owned())
                    });
            }
            if let (Some(vendor), Some(product)) = (
                property(ancestor, "idVendor"),
                property(ancestor, "idProduct"),
            ) {
                vid = u16::from_str_radix(&vendor, 16).ok();
                pid = u16::from_str_radix(&product, 16).ok();
                serial_number = property(ancestor, "serial");
                manufacturer = property(ancestor, "manufacturer");
                description = property(ancestor, "product");
                break;
            }
        }
        let evidence = if serial_number.is_some() {
            IdentityEvidence::SerialNumber
        } else {
            IdentityEvidence::Topology
        };
        devices.push(DeviceDescriptor {
            device_id: Id::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
            host_id: host_id.clone(),
            system_name: device_node.to_string_lossy().into_owned(),
            description,
            manufacturer,
            driver,
            fingerprint: DeviceFingerprint {
                transport: DeviceTransportKind::Serial,
                vid,
                pid,
                serial_number,
                topology_path: Some(path.to_string_lossy().into_owned()),
                evidence,
            },
            capabilities: super::serial_capabilities(),
        });
        if devices.len() > 4096 {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "OS serial enumeration exceeds its capacity",
            ));
        }
    }
    Ok(devices)
}
fn property(path: &std::path::Path, name: &str) -> Option<String> {
    std::fs::read_to_string(path.join(name))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readback_does_not_confirm_disabled_receive_or_carrier_gating() {
        let config = SerialConfiguration::default();
        let actual = encode_termios2(unsafe { std::mem::zeroed() }, &config).unwrap();
        assert!(decode_termios2(&actual, &config).is_ok());
        for flag in [libc::CREAD, libc::CLOCAL] {
            let mut changed = actual;
            changed.c_cflag &= !flag;
            assert_eq!(
                decode_termios2(&changed, &config).err().unwrap().error.code,
                "UNSUPPORTED_CAPABILITY"
            );
        }
    }
    #[test]
    fn arbitrary_baud_and_mark_space_are_encoded_without_truncation() {
        for (parity, odd) in [(Parity::Mark, true), (Parity::Space, false)] {
            let config = SerialConfiguration {
                baud_rate: PositiveU64::try_from(U64::from(123457)).unwrap(),
                parity,
                ..Default::default()
            };
            // termios2 的全零结构是有效的编码基线，没有有效 fd 或内核引用。
            let baseline = unsafe { std::mem::zeroed() };
            let encoded = encode_termios2(baseline, &config).unwrap();
            assert_eq!(encoded.c_ospeed, 123457);
            assert_eq!(encoded.c_ispeed, 123457);
            assert_eq!(encoded.c_cflag & libc::CBAUD, libc::BOTHER);
            assert_ne!(encoded.c_cflag & libc::CMSPAR, 0);
            assert_ne!(encoded.c_cflag & libc::PARENB, 0);
            assert_eq!(encoded.c_cflag & libc::PARODD != 0, odd);
        }
    }

    #[test]
    fn linux_rejects_unrepresentable_handshake_and_half_stop() {
        for config in [
            SerialConfiguration {
                flow_control: FlowControl::DsrDtr,
                ..Default::default()
            },
            SerialConfiguration {
                data_bits: DataBits::Five,
                stop_bits: StopBits::OnePointFive,
                ..Default::default()
            },
            SerialConfiguration {
                data_bits: DataBits::Five,
                stop_bits: StopBits::Two,
                ..Default::default()
            },
        ] {
            let baseline = unsafe { std::mem::zeroed() };
            assert_eq!(
                encode_termios2(baseline, &config).err().unwrap().error.code,
                "UNSUPPORTED_CAPABILITY"
            );
        }
    }
}
