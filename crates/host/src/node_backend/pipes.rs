use super::{QUEUE, TICK, derived, error, raw};
use serial_workbench_core::HostResult;
use serial_workbench_ipc::frame::MAX_FRAME_BYTES;
use std::{
    io::{self, Read, Write},
    process::Child,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    },
    thread::{self, JoinHandle},
};

pub(super) struct Pipes {
    pub(super) send: WakingSender<Vec<u8>>,
    pub(super) receive: Receiver<Vec<u8>>,
    pub(super) raw_send: WakingSender<raw::Write>,
    pub(super) raw_receive: Receiver<Vec<u8>>,
    pub(super) derived_send: WakingSender<Vec<u8>>,
    pub(super) derived_receive: Receiver<Vec<u8>>,
    stopped: Arc<AtomicBool>,
    failed: Arc<AtomicBool>,
    stderr: Arc<Mutex<Vec<u8>>>,
    threads: Vec<JoinHandle<()>>,
}

pub(super) struct WakingSender<T> {
    queue: SyncSender<T>,
    receiver: Option<thread::Thread>,
}

impl<T> Clone for WakingSender<T> {
    fn clone(&self) -> Self {
        Self {
            queue: self.queue.clone(),
            receiver: self.receiver.clone(),
        }
    }
}

impl<T> From<SyncSender<T>> for WakingSender<T> {
    fn from(queue: SyncSender<T>) -> Self {
        Self {
            queue,
            receiver: None,
        }
    }
}

impl<T> WakingSender<T> {
    pub(super) fn set_receiver(&mut self, receiver: thread::Thread) {
        self.receiver = Some(receiver);
    }

    pub(super) fn try_send(&self, frame: T) -> Result<(), TrySendError<T>> {
        self.queue.try_send(frame)?;
        self.wake();
        Ok(())
    }

    pub(super) fn wake(&self) {
        if let Some(receiver) = &self.receiver {
            receiver.unpark();
        }
    }
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
            send: send.into(),
            receive,
            raw_send: raw_send.into(),
            raw_receive,
            derived_send: derived_send.into(),
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
        self.send = send.into();
        self.receive = receive;
        self.raw_send = raw_send.into();
        self.raw_receive = raw_receive;
        self.derived_send = derived_send.into();
        self.derived_receive = derived_receive;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        nonblocking(&stdin)?;
        nonblocking(&stdout)?;
        nonblocking(&stderr)?;
        let stopped = self.stopped.clone();
        let failed = self.failed.clone();
        let writer = self.spawn("node-backend-write", move || {
            let mut prefer_derived = false;
            while !stopped.load(Ordering::Acquire) {
                let control = input.try_recv();
                let result = if let Ok(bytes) = control {
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
                    if matches!(control, Err(TryRecvError::Disconnected)) {
                        break;
                    }
                    // 三条发送队列共用同一唤醒令牌，排队后即可重新按优先级选帧。
                    thread::park_timeout(TICK);
                    continue;
                };
                if result.is_err() {
                    failed.store(true, Ordering::Release);
                    break;
                }
            }
        })?;
        self.send.set_receiver(writer.clone());
        self.raw_send.set_receiver(writer.clone());
        self.derived_send.set_receiver(writer);
        let stopped = self.stopped.clone();
        let failed = self.failed.clone();
        let owner = thread::current();
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
                    owner.unpark();
                    break;
                }
                owner.unpark();
            }
        })?;
        let stopped = self.stopped.clone();
        let failed = self.failed.clone();
        let diagnostics = self.stderr.clone();
        self.spawn("node-backend-stderr", move || {
            let mut buffer = [0; 8192];
            let mut received = 0usize;
            // Unix 的非阻塞管道在关停后仍可读到已写入的诊断，读空后直接退出。
            while cfg!(unix) || !stopped.load(Ordering::Acquire) {
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
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        if stopped.load(Ordering::Acquire) {
                            break;
                        }
                        thread::sleep(TICK);
                    }
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
    fn spawn(
        &mut self,
        name: &str,
        task: impl FnOnce() + Send + 'static,
    ) -> HostResult<thread::Thread> {
        let handle = thread::Builder::new()
            .name(name.into())
            .spawn(task)
            .map_err(|_| error("HOST_BUSY", "backendPipeThread"))?;
        let thread = handle.thread().clone();
        self.threads.push(handle);
        Ok(thread)
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
        self.send.wake();
        for handle in self.threads.drain(..) {
            let _ = handle.join();
        }
    }
}
fn write_frame(
    pipe: &mut (impl Write + PipeReadiness),
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

enum PipeEvent {
    Readable,
    Writable,
}

trait PipeReadiness {
    fn wait_ready(&self, event: PipeEvent) -> io::Result<()>;
}

#[cfg(unix)]
impl<T: std::os::fd::AsRawFd> PipeReadiness for T {
    fn wait_ready(&self, event: PipeEvent) -> io::Result<()> {
        let mut descriptor = libc::pollfd {
            fd: self.as_raw_fd(),
            events: match event {
                PipeEvent::Readable => libc::POLLIN,
                PipeEvent::Writable => libc::POLLOUT,
            },
            revents: 0,
        };
        // 资源就绪立即继续，空闲时仍在原间隔内重新检查关停。
        if unsafe { libc::poll(&mut descriptor, 1, TICK.as_millis() as libc::c_int) } < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
impl<T> PipeReadiness for T {
    fn wait_ready(&self, _event: PipeEvent) -> io::Result<()> {
        thread::sleep(TICK);
        Ok(())
    }
}

fn read_exact(
    pipe: &mut (impl Read + PipeReadiness),
    mut bytes: &mut [u8],
    stopped: &AtomicBool,
) -> io::Result<()> {
    while !bytes.is_empty() {
        if stopped.load(Ordering::Acquire) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        match pipe.read(bytes) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(count) => bytes = &mut bytes[count..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                pipe.wait_ready(PipeEvent::Readable)?;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
fn write_all(
    pipe: &mut (impl Write + PipeReadiness),
    mut bytes: &[u8],
    stopped: &AtomicBool,
) -> io::Result<()> {
    while !bytes.is_empty() {
        if stopped.load(Ordering::Acquire) {
            return Err(io::ErrorKind::Interrupted.into());
        }
        match pipe.write(bytes) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => bytes = &bytes[count..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                pipe.wait_ready(PipeEvent::Writable)?;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
