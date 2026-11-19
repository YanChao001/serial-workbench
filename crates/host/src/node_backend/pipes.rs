use super::{QUEUE, TICK, derived, error, raw};
use serial_workbench_core::HostResult;
use serial_workbench_ipc::frame::MAX_FRAME_BYTES;
use std::{
    io::{self, Read, Write},
    process::Child,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
};

pub(super) struct Pipes {
    pub(super) send: SyncSender<Vec<u8>>,
    pub(super) receive: Receiver<Vec<u8>>,
    pub(super) raw_send: SyncSender<raw::Write>,
    pub(super) raw_receive: Receiver<Vec<u8>>,
    pub(super) derived_send: SyncSender<Vec<u8>>,
    pub(super) derived_receive: Receiver<Vec<u8>>,
    stopped: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    stderr: Arc<Mutex<Vec<u8>>>,
    threads: Vec<JoinHandle<()>>,
}
impl Pipes {
    pub(super) fn empty() -> Self {
        let (send, _) = mpsc::sync_channel(QUEUE);
        let (_, receive) = mpsc::sync_channel(QUEUE);
        let (raw_send, _) = mpsc::sync_channel(raw::SLOTS);
        let (_, raw_receive) = mpsc::sync_channel(raw::SLOTS);
        let (derived_send, _) = mpsc::sync_channel(derived::SLOTS);
        let (_, derived_receive) = mpsc::sync_channel(derived::SLOTS);
        Self {
            send,
            receive,
            raw_send,
            raw_receive,
            derived_send,
            derived_receive,
            stopped: Arc::new(AtomicBool::new(false)),
            failed: Arc::new(AtomicBool::new(false)),
            stderr: Arc::new(Mutex::new(Vec::new())),
            threads: Vec::new(),
        }
    }
    pub(super) fn start(&mut self, child: &mut Child) -> HostResult<()> {
        let (send, input) = mpsc::sync_channel::<Vec<u8>>(QUEUE);
        let (output, receive) = mpsc::sync_channel(QUEUE);
        let (raw_send, raw_input) = mpsc::sync_channel::<raw::Write>(raw::SLOTS);
        let (raw_output, raw_receive) = mpsc::sync_channel(raw::SLOTS);
        let (derived_send, derived_input) = mpsc::sync_channel::<Vec<u8>>(derived::SLOTS);
        let (derived_output, derived_receive) = mpsc::sync_channel(derived::SLOTS);
        self.send = send;
        self.receive = receive;
        self.raw_send = raw_send;
        self.raw_receive = raw_receive;
        self.derived_send = derived_send;
        self.derived_receive = derived_receive;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        nonblocking(&stdin)?;
        nonblocking(&stdout)?;
        nonblocking(&stderr)?;
        let stopped = self.stopped.clone();
        let failed = self.failed.clone();
        self.spawn("node-backend-write", move || {
            let mut prefer_derived = false;
            while !stopped.load(Ordering::Acquire) {
                let result = if let Ok(bytes) = input.try_recv() {
                    write_frame(&mut stdin, &bytes, 0, &stopped)
                } else if let Some(bytes) = prefer_derived
                    .then(|| derived_input.try_recv().ok())
                    .flatten()
                {
                    prefer_derived = false;
                    write_frame(&mut stdin, &bytes, derived::FLAG, &stopped)
                } else if let Ok(raw) = raw_input.try_recv() {
                    prefer_derived = true;
                    // raw 持有输出租约直到整帧写完或失败。
                    raw.body()
                        .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))
                        .and_then(|bytes| write_frame(&mut stdin, &bytes, raw::FLAG, &stopped))
                } else if let Ok(bytes) = derived_input.try_recv() {
                    prefer_derived = false;
                    write_frame(&mut stdin, &bytes, derived::FLAG, &stopped)
                } else {
                    match input.recv_timeout(TICK) {
                        Ok(bytes) => write_frame(&mut stdin, &bytes, 0, &stopped),
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                };
                if result.is_err() {
                    failed.store(true, Ordering::Release);
                    break;
                }
            }
        })?;
        let stopped = self.stopped.clone();
        let failed = self.failed.clone();
        self.spawn("node-backend-read", move || {
            loop {
                let result = (|| {
                    let mut header = [0; 4];
                    read_exact(&mut stdout, &mut header, &stopped)?;
                    let tagged = u32::from_le_bytes(header);
                    let flags = raw::FLAG | derived::FLAG;
                    let size = (tagged & !flags) as usize;
                    let (limit, queue) = match tagged & flags {
                        0 => (MAX_FRAME_BYTES, &output),
                        raw::FLAG => (raw::MAX_REQUEST_BYTES, &raw_output),
                        derived::FLAG => (derived::MAX_REQUEST_BYTES, &derived_output),
                        _ => return Err(io::ErrorKind::InvalidData.into()),
                    };
                    if size == 0 || size > limit {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    let mut bytes = vec![0; size];
                    read_exact(&mut stdout, &mut bytes, &stopped)?;
                    queue
                        .try_send(bytes)
                        .map_err(|_| io::Error::from(io::ErrorKind::WouldBlock))
                })();
                if result.is_err() {
                    failed.store(true, Ordering::Release);
                    break;
                }
            }
        })?;
        let stopped = self.stopped.clone();
        let failed = self.failed.clone();
        let diagnostics = self.stderr.clone();
        self.spawn("node-backend-stderr", move || {
            let mut buffer = [0; 8192];
            let mut received = 0usize;
            while !stopped.load(Ordering::Acquire) {
                match stderr.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        received = received.saturating_add(count);
                        if let Ok(mut bytes) = diagnostics.lock() {
                            let keep = count.min((64usize * 1024).saturating_sub(bytes.len()));
                            bytes.extend_from_slice(&buffer[..keep]);
                        }
                        if received > 4 * 1024 * 1024 {
                            failed.store(true, Ordering::Release);
                            break;
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(TICK),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => {
                        failed.store(true, Ordering::Release);
                        break;
                    }
                }
            }
        })?;
        Ok(())
    }
    fn spawn(&mut self, name: &str, task: impl FnOnce() + Send + 'static) -> HostResult<()> {
        let handle = thread::Builder::new()
            .name(name.into())
            .spawn(task)
            .map_err(|_| error("HOST_BUSY", "backendPipeThread"))?;
        self.threads.push(handle);
        Ok(())
    }
    pub(super) fn failed(&self) -> bool {
        self.failed.load(Ordering::Acquire)
    }
    pub(super) fn stderr(&self) -> Vec<u8> {
        self.stderr
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }
    pub(super) fn stop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        for handle in self.threads.drain(..) {
            let _ = handle.join();
        }
    }
}
fn write_frame(
    pipe: &mut impl Write,
    bytes: &[u8],
    flag: u32,
    stopped: &AtomicBool,
) -> io::Result<()> {
    write_all(pipe, &((bytes.len() as u32) | flag).to_le_bytes(), stopped)?;
    write_all(pipe, bytes, stopped)
}
// Unix 的脱离进程组后代不能使管道回收永久卡住；轮询只作用于这些私有管道。
#[cfg(unix)]
fn nonblocking(pipe: &impl std::os::fd::AsRawFd) -> HostResult<()> {
    let fd = pipe.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(error("NODE_RUNTIME_START_FAILED", "backendPipeMode"));
    }
    Ok(())
}
#[cfg(windows)]
fn nonblocking<T>(_pipe: &T) -> HostResult<()> {
    Ok(())
}
fn read_exact(pipe: &mut impl Read, mut bytes: &mut [u8], stopped: &AtomicBool) -> io::Result<()> {
    while !bytes.is_empty() {
        if stopped.load(Ordering::Acquire) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        match pipe.read(bytes) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(count) => bytes = &mut bytes[count..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(TICK),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
fn write_all(pipe: &mut impl Write, mut bytes: &[u8], stopped: &AtomicBool) -> io::Result<()> {
    while !bytes.is_empty() {
        if stopped.load(Ordering::Acquire) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        match pipe.write(bytes) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => thread::sleep(TICK),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
