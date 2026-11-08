//! 真 PTY 与独立子进程覆盖字节、purge、断连；不把即时 drain 记为阻塞取消证据。
#![cfg(unix)]
use serial_workbench_core::*;
use serial_workbench_host::device::serial::SerialProvider;
use sha2::{Digest as _, Sha256};
use std::{
    io::{BufRead, Read, Write},
    os::fd::{FromRawFd, OwnedFd},
    process::{Command, Stdio},
    sync::{Arc, atomic::AtomicBool},
    time::{Duration, Instant},
};

fn payload() -> Vec<u8> {
    (0..65536).map(|index| ((index * 31) % 256) as u8).collect()
}
fn request(cancelled: bool) -> DrainRequest {
    DrainRequest {
        wait: Duration::from_secs(1),
        cancelled: Arc::new(AtomicBool::new(cancelled)),
        closing: Arc::new(AtomicBool::new(false)),
    }
}

#[test]
fn pty_peer_process() {
    let Ok(fd) = std::env::var("SERIAL_TEST_MASTER_FD") else {
        return;
    };
    let fd: i32 = fd.parse().unwrap();
    let mut master = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut received = vec![0; 65536];
    master.read_exact(&mut received).unwrap();
    assert_eq!(received, payload());
    for chunk in received.chunks(113) {
        master.write_all(chunk).unwrap();
    }
    let mut command = [0];
    std::io::stdin().read_exact(&mut command).unwrap();
    assert_eq!(command, [b'p']);
    master.write_all(b"discard-before-next-read").unwrap();
    println!("purge-ready");
    std::io::stdout().flush().unwrap();
    std::io::stdin().read_exact(&mut command).unwrap();
    assert_eq!(command, [b'x']);
}

#[test]
fn pty_roundtrip_preserves_arbitrary_chunks_between_processes() {
    let mut master = -1;
    let mut slave = -1;
    let mut name = [0 as libc::c_char; 256];
    assert_eq!(
        unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                name.as_mut_ptr(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        },
        0
    );
    let slave_owner = unsafe { OwnedFd::from_raw_fd(slave) };
    assert_eq!(
        unsafe { libc::fcntl(slave, libc::F_SETFD, libc::FD_CLOEXEC) },
        0
    );
    assert_eq!(unsafe { libc::fcntl(master, libc::F_SETFD, 0) }, 0);
    let locator = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) }
        .to_str()
        .unwrap()
        .to_owned();
    let host_id = Id::try_from("pty-test-host").unwrap();
    let provider = SerialProvider::new(host_id.clone());
    let device = DeviceDescriptor {
        device_id: Id::try_from("pty-fixture").unwrap(),
        host_id,
        system_name: locator,
        description: None,
        manufacturer: None,
        driver: None,
        fingerprint: DeviceFingerprint {
            transport: DeviceTransportKind::Pty,
            vid: None,
            pid: None,
            serial_number: None,
            topology_path: None,
            evidence: IdentityEvidence::Unreliable,
        },
        capabilities: serial_workbench_host::device::virtual_backend::VirtualTransport::new(
            SerialConfiguration::default(),
        )
        .capabilities(),
    };
    let mut port = provider
        .open(&device, &SerialConfiguration::default())
        .unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "pty_peer_process", "--nocapture"])
        .env("SERIAL_TEST_MASTER_FD", master.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    unsafe {
        libc::close(master);
    }
    let expected = payload();
    for chunk in expected.chunks(257) {
        let mut writing = port
            .begin_write(
                WritePayload::owned(Arc::from(chunk)),
                Duration::from_secs(2),
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        let write_deadline = Instant::now() + Duration::from_secs(3);
        let result = loop {
            if let Some(result) = writing.poll() {
                break result.unwrap();
            }
            assert!(Instant::now() < write_deadline);
            std::thread::yield_now();
        };
        assert_eq!(
            result.accepted_ranges,
            [ByteRange {
                start: 0.into(),
                end: (chunk.len() as u64).into()
            }]
        );
        assert!(result.unknown_ranges.is_empty());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut received = Vec::new();
    while received.len() < expected.len() {
        assert!(Instant::now() < deadline, "PTY receive deadline exceeded");
        received.extend_from_slice(&port.read(179, Duration::from_millis(20)).unwrap().bytes);
    }
    assert_eq!(Sha256::digest(&received), Sha256::digest(&expected));
    assert_eq!(
        port.begin_drain(request(true)).err().unwrap().error.code,
        "CANCELLED"
    );
    let mut drain = port.begin_drain(request(false)).unwrap();
    let result = loop {
        if let Some(result) = drain.poll() {
            break result.unwrap();
        }
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    };
    assert!(matches!(
        result,
        ControlResult::Drained {
            status: ControlStatus::Confirmed,
            ..
        }
    ));
    child.stdin.as_mut().unwrap().write_all(b"p").unwrap();
    let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        assert_ne!(output.read_line(&mut line).unwrap(), 0);
        if line.contains("purge-ready") {
            break;
        }
        line.clear();
    }
    // 子进程 write 返回只表示 master 接纳；确认 marker 已进入 slave 队列再 purge。
    let purge_deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let mut available: libc::c_int = 0;
        assert_eq!(
            unsafe { libc::ioctl(slave, libc::FIONREAD, &mut available) },
            0
        );
        if available as usize == b"discard-before-next-read".len() {
            break;
        }
        assert!(
            Instant::now() < purge_deadline,
            "PTY marker did not reach RX queue"
        );
        std::thread::yield_now();
    }
    port.control(ControlCommand::Purge {
        direction: PurgeDirection::Rx,
    })
    .unwrap();
    assert!(
        port.read(128, Duration::from_millis(20))
            .unwrap()
            .bytes
            .is_empty()
    );
    drop(slave_owner);
    child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(
        port.read(1, Duration::from_millis(20))
            .unwrap_err()
            .error
            .code,
        "BACKEND_DISCONNECTED"
    );
    port.close().unwrap();
}
