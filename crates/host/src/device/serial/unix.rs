use serial_workbench_core::*;
use std::{
    ffi::CString,
    os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd},
    sync::{Arc, OnceLock},
    thread::JoinHandle,
    time::{Duration, Instant},
};

fn os_error(errno: i32) -> BackendError {
    let code = match errno {
        libc::EIO | libc::ENODEV | libc::ENXIO | libc::EBADF => "BACKEND_DISCONNECTED",
        libc::EACCES | libc::EPERM => "ACCESS_DENIED",
        libc::EBUSY => "DEVICE_BUSY",
        libc::EINVAL | libc::ENOTTY | libc::ENOSYS => "UNSUPPORTED_CAPABILITY",
        libc::EINTR => "CANCELLED",
        _ => "BACKEND_IO",
    };
    super::native_error(code, errno as u64)
}
pub(super) fn last_error() -> BackendError {
    os_error(
        std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::EIO),
    )
}

struct PortResource {
    fd: OwnedFd,
    claim: super::SerialClaim,
}
struct UnixPort {
    port: Option<Arc<PortResource>>,
    configuration: SerialConfiguration,
}
pub(super) fn open(
    device: &DeviceDescriptor,
    config: &SerialConfiguration,
    claim: super::SerialClaim,
) -> BackendResult<Box<dyn super::NativePort>> {
    let path = CString::new(device.system_name.as_bytes())
        .map_err(|_| super::unsupported("Invalid discovered serial locator"))?;
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDWR | libc::O_NOCTTY | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(last_error());
    }
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } < 0 {
        return Err(last_error());
    }
    if unsafe { stat.assume_init() }.st_mode & libc::S_IFMT != libc::S_IFCHR {
        return Err(super::unsupported(
            "Discovered locator is not a character device",
        ));
    }
    if unsafe { libc::ioctl(fd, libc::TIOCEXCL as _) } < 0 {
        return Err(last_error());
    }
    let mut port = UnixPort {
        port: Some(Arc::new(PortResource { fd: owned, claim })),
        configuration: config.clone(),
    };
    let application = super::NativePort::configure(&mut port, config)?;
    super::require_applied(&application)?;
    Ok(Box::new(port))
}
impl UnixPort {
    fn resource(&self) -> BackendResult<&Arc<PortResource>> {
        self.port
            .as_ref()
            .ok_or_else(|| HostError::new("BACKEND_DISCONNECTED", "Serial port is closed").into())
    }
    fn fd(&self) -> BackendResult<i32> {
        Ok(self.resource()?.fd.as_raw_fd())
    }
}
fn ready(fd: i32, event: i16, wait: Duration) -> BackendResult<bool> {
    let deadline = Instant::now() + wait;
    loop {
        let mut poll = libc::pollfd {
            fd,
            events: event,
            revents: 0,
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        let millis = remaining.as_millis().min(i32::MAX as u128) as i32;
        let result = unsafe { libc::poll(&mut poll, 1, millis) };
        if result < 0 {
            let errno = std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO);
            if errno == libc::EINTR && Instant::now() < deadline {
                continue;
            }
            return Err(os_error(errno));
        }
        if result == 0 {
            return Ok(false);
        }
        if poll.revents & event != 0 {
            return Ok(true);
        }
        if poll.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(os_error(libc::EIO));
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
    }
}
impl super::NativePort for UnixPort {
    fn capabilities(&self) -> TransportCapabilities {
        super::serial_capabilities()
    }
    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        let fd = self.fd()?;
        if limit == 0 || !ready(fd, libc::POLLIN, wait)? {
            return Ok(ReadBlock {
                bytes: Arc::from([]),
                message: None,
            });
        }
        let mut bytes = vec![0u8; limit.min(16384)];
        let count = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
        if count < 0 {
            let errno = std::io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or(libc::EIO);
            if matches!(errno, libc::EAGAIN | libc::EINTR) {
                return Ok(ReadBlock {
                    bytes: Arc::from([]),
                    message: None,
                });
            }
            return Err(os_error(errno));
        }
        if count == 0 {
            return Err(os_error(libc::EIO));
        }
        bytes.truncate(count as usize);
        Ok(ReadBlock {
            bytes: bytes.into(),
            message: None,
        })
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
                prepare_cancel_signal();
                let fd = resource.fd.as_raw_fd();
                Ok(write_remaining(
                    &bytes,
                    deadline,
                    &signals,
                    &progress,
                    |bytes| {
                        let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
                        // 立即读取 write 的 errno，避免后续互斥锁或 poll 调用覆盖。
                        if count < 0 {
                            Err(std::io::Error::last_os_error()
                                .raw_os_error()
                                .unwrap_or(libc::EIO))
                        } else {
                            Ok(count as usize)
                        }
                    },
                    |wait| ready(fd, libc::POLLOUT, wait),
                ))
            },
        ))
    }
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        #[cfg(target_os = "linux")]
        let application = super::linux::configure(self.fd()?, config)?;
        #[cfg(target_os = "macos")]
        let application = super::macos::configure(self.fd()?, config)?;
        self.configuration = serde_json::from_value(
            serde_json::to_value(&application.readback)
                .map_err(|_| super::unsupported("Invalid configuration readback"))?,
        )
        .map_err(|_| super::unsupported("Invalid configuration readback"))?;
        Ok(application)
    }
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        let fd = self.fd()?;
        match command {
            ControlCommand::SetLine { line, value } => {
                super::check_line(&self.configuration, line)?;
                let bits = match line {
                    ControlLine::Dtr => libc::TIOCM_DTR,
                    ControlLine::Rts => libc::TIOCM_RTS,
                };
                let command = if value {
                    libc::TIOCMBIS
                } else {
                    libc::TIOCMBIC
                };
                if unsafe { libc::ioctl(fd, command as _, &bits) } < 0 {
                    return Err(last_error());
                }
                let mut actual = 0;
                if unsafe { libc::ioctl(fd, libc::TIOCMGET as _, &mut actual) } < 0 {
                    return Err(last_error());
                }
                Ok(ControlResult::Line {
                    line,
                    value: actual & bits != 0,
                })
            }
            ControlCommand::AssertBreak | ControlCommand::ClearBreak => {
                let asserted = matches!(command, ControlCommand::AssertBreak);
                let request = if asserted {
                    libc::TIOCSBRK
                } else {
                    libc::TIOCCBRK
                };
                if unsafe { libc::ioctl(fd, request as _) } < 0 {
                    return Err(last_error());
                }
                Ok(ControlResult::Break { asserted })
            }
            ControlCommand::QueueStatus => {
                let mut count: libc::c_int = 0;
                if unsafe { libc::ioctl(fd, libc::TIOCOUTQ as _, &mut count) } < 0 {
                    return Err(last_error());
                }
                Ok(ControlResult::Queue {
                    pending_bytes: u64::try_from(count)
                        .map_err(|_| super::unsupported("Driver returned a negative queue count"))?
                        .into(),
                })
            }
            ControlCommand::ModemStatus => {
                let mut bits = 0;
                if unsafe { libc::ioctl(fd, libc::TIOCMGET as _, &mut bits) } < 0 {
                    return Err(last_error());
                }
                Ok(ControlResult::Modem {
                    cts: bits & libc::TIOCM_CTS != 0,
                    dsr: bits & libc::TIOCM_DSR != 0,
                    ring: bits & libc::TIOCM_RI != 0,
                    carrier: bits & libc::TIOCM_CD != 0,
                })
            }
            ControlCommand::Purge { direction } => {
                let queue = match direction {
                    PurgeDirection::Rx => libc::TCIFLUSH,
                    PurgeDirection::Tx => libc::TCOFLUSH,
                    PurgeDirection::Both => libc::TCIOFLUSH,
                };
                if unsafe { libc::tcflush(fd, queue) } < 0 {
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
            prepare_cancel_signal();
            if unsafe { libc::tcdrain(resource.fd.as_raw_fd()) } < 0 {
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
        match Arc::try_unwrap(resource) {
            Ok(resource) => {
                // close 失败也不重试 fd；编号可能已经被系统重用。
                if unsafe { libc::close(resource.fd.into_raw_fd()) } < 0 {
                    resource
                        .claim
                        .isolated
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    Err(last_error())
                } else {
                    Ok(())
                }
            }
            Err(resource) => {
                resource
                    .claim
                    .isolated
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                Err(HostError::new(
                    "CONTROL_UNKNOWN",
                    "A native drain still owns the serial descriptor",
                )
                .into())
            }
        }
    }
}
fn write_remaining(
    bytes: &[u8],
    deadline: Instant,
    signals: &super::WriteSignals,
    progress: &Arc<std::sync::Mutex<super::WriteProgress>>,
    mut submit: impl FnMut(&[u8]) -> Result<usize, i32>,
    mut wait_ready: impl FnMut(Duration) -> BackendResult<bool>,
) -> BackendWrite {
    let mut accepted = 0;
    while accepted < bytes.len() {
        if accepted > 0 && Instant::now() >= deadline {
            return write_receipt(
                accepted,
                Some(HostError::new("WRITE_TIMEOUT", "Serial write wait expired")),
            );
        }
        if !super::publish_write_submission(progress, signals, bytes.len()) {
            return write_receipt(
                accepted,
                Some(HostError::new(
                    "CANCELLED",
                    "Remaining serial bytes were not submitted",
                )),
            );
        }
        let errno = match submit(&bytes[accepted..]) {
            Ok(written) if written > 0 => {
                accepted += written;
                let mut progress = progress.lock().unwrap_or_else(|e| e.into_inner());
                progress.accepted = accepted;
                progress.submitted_end = accepted;
                continue;
            }
            Ok(_) => libc::EAGAIN,
            Err(errno) => errno,
        };
        progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .submitted_end = accepted;
        if !matches!(errno, libc::EAGAIN | libc::EINTR) {
            return write_receipt(accepted, Some(*os_error(errno).error));
        }
        if Instant::now() >= deadline {
            return write_receipt(
                accepted,
                Some(HostError::new("WRITE_TIMEOUT", "Serial write wait expired")),
            );
        }
        if let Err(error) = wait_ready(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(5)),
        ) {
            return write_receipt(accepted, Some(*error.error));
        }
    }
    write_receipt(accepted, None)
}

fn write_receipt(accepted: usize, error: Option<HostError>) -> BackendWrite {
    BackendWrite {
        accepted_ranges: if accepted == 0 {
            vec![]
        } else {
            vec![super::range(0, accepted)]
        },
        unknown_ranges: vec![],
        error,
    }
}

static CANCEL_SIGNAL: OnceLock<bool> = OnceLock::new();
extern "C" fn interrupt_handler(_: libc::c_int) {}
fn prepare_cancel_signal() {
    let installed = *CANCEL_SIGNAL.get_or_init(|| unsafe {
        let mut previous = std::mem::MaybeUninit::<libc::sigaction>::uninit();
        if libc::sigaction(libc::SIGUSR2, std::ptr::null(), previous.as_mut_ptr()) < 0
            || previous.assume_init().sa_sigaction != libc::SIG_DFL
        {
            return false;
        }
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = interrupt_handler as *const () as usize;
        libc::sigemptyset(&mut action.sa_mask);
        action.sa_flags = 0;
        libc::sigaction(libc::SIGUSR2, &action, std::ptr::null_mut()) == 0
    });
    if installed {
        unsafe {
            let mut set = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGUSR2);
            libc::pthread_sigmask(libc::SIG_UNBLOCK, &set, std::ptr::null_mut());
        }
    }
}
pub(super) fn interrupt_thread(join: &JoinHandle<()>) {
    use std::os::unix::thread::JoinHandleExt;
    // 发送方持有结果锁；worker 发布结果前不会退出，pthread_t 不会失效。
    if CANCEL_SIGNAL.get() == Some(&true) {
        unsafe {
            libc::pthread_kill(join.as_pthread_t(), libc::SIGUSR2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn signals() -> super::super::WriteSignals {
        super::super::WriteSignals {
            cancelled: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            closing: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            abandoned: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            isolated: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }
    #[test]
    fn deadline_after_a_short_write_keeps_the_prefix_and_never_submits_the_tail() {
        let mut calls = 0;
        let result = write_remaining(
            &[1, 2, 3],
            Instant::now(),
            &signals(),
            &Arc::new(std::sync::Mutex::new(super::super::WriteProgress::default())),
            |_| {
                calls += 1;
                Ok(1)
            },
            |_| panic!("positive short writes do not poll"),
        );
        assert_eq!(calls, 1);
        assert_eq!(result.accepted_ranges, [super::super::range(0, 1)]);
        assert!(result.unknown_ranges.is_empty());
        assert_eq!(result.error.unwrap().code, "WRITE_TIMEOUT");
    }
    #[test]
    fn io_failure_after_a_short_write_preserves_the_known_prefix() {
        for errno in [libc::EIO, libc::ENODEV] {
            let mut calls = 0;
            let result = write_remaining(
                &[1, 2, 3],
                Instant::now() + Duration::from_secs(1),
                &signals(),
                &Arc::new(std::sync::Mutex::new(super::super::WriteProgress::default())),
                |_| {
                    calls += 1;
                    if calls == 1 { Ok(1) } else { Err(errno) }
                },
                |_| panic!("disconnection does not poll"),
            );
            assert_eq!(result.accepted_ranges, [super::super::range(0, 1)]);
            assert!(result.unknown_ranges.is_empty());
            assert_eq!(result.error.unwrap().code, "BACKEND_DISCONNECTED");
        }
    }
    #[test]
    fn eio_and_enodev_are_disconnects_without_fabricated_write_acceptance() {
        for errno in [libc::EIO, libc::ENODEV] {
            let error = os_error(errno);
            assert_eq!(error.error.code, "BACKEND_DISCONNECTED");
            assert!(error.accepted_ranges.is_empty());
            assert!(error.unknown_ranges.is_empty());
        }
    }
}
