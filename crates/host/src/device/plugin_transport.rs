use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use serial_workbench_ipc::{
    frame::encode_frame,
    identity::{credential_verifier, random_token, verify_credential},
};
use std::{
    collections::VecDeque,
    io::{self, Read, Write},
    net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME_BYTES: usize = 262_144;
const MAX_HELLO_BYTES: usize = 1024;
const MAX_READ_BYTES: usize = 16 * 1024;
const MAX_WIRE_ID: u64 = 9_007_199_254_740_991;
const MAX_WAIT_MS: u128 = 2_147_483_647;
const HELLO_WAIT: Duration = Duration::from_millis(500);
const READ_REPLY_GRACE: Duration = Duration::from_secs(2);
const CLOSE_WAIT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(1);
const QUEUE_CAPACITY: usize = 6;
const LINE_WAIT_MS: u64 = 1_500;

pub(crate) struct PendingPluginTransport {
    listener: TcpListener,
    address: SocketAddr,
    credential: ContextToken,
    report_rfc2217: bool,
    cleanup: Option<Arc<dyn BackendCleanup>>,
}

impl PendingPluginTransport {
    pub(crate) fn listen() -> HostResult<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| disconnected())?;
        listener.set_nonblocking(true).map_err(|_| disconnected())?;
        let address = listener.local_addr().map_err(|_| disconnected())?;
        Ok(Self {
            listener,
            address,
            credential: random_token(),
            report_rfc2217: false,
            cleanup: None,
        })
    }

    pub(crate) fn address(&self) -> SocketAddr {
        self.address
    }

    pub(crate) fn credential(&self) -> &ContextToken {
        &self.credential
    }

    pub(crate) fn with_rfc2217_diagnostics(mut self, enabled: bool) -> Self {
        self.report_rfc2217 = enabled;
        self
    }

    pub(crate) fn with_cleanup(mut self, cleanup: Arc<dyn BackendCleanup>) -> Self {
        self.cleanup = Some(cleanup);
        self
    }

    pub(crate) fn accept(
        self,
        timeout: Duration,
        authorize: impl FnOnce() -> HostResult<()>,
    ) -> BackendResult<Box<dyn Transport>> {
        let deadline = deadline(timeout)?;
        let verifier = credential_verifier(&self.credential);
        let mut wire = loop {
            if Instant::now() >= deadline {
                return Err(open_timeout().into());
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    let Ok(mut peer) = Wire::new(stream) else {
                        continue;
                    };
                    let hello_deadline = deadline.min(Instant::now() + HELLO_WAIT);
                    if let Ok(Response::Hello { credential }) =
                        peer.receive_until(hello_deadline, MAX_HELLO_BYTES)
                        && verify_credential(&verifier, &credential)
                    {
                        break peer;
                    }
                }
                Err(error) if transient(&error) => {
                    wait_until(deadline);
                }
                Err(_) => return Err(disconnected().into()),
            }
        };
        // 一旦接纳准确凭据，关闭 listener。任何后续结果都归这一连接。
        drop(self.listener);
        authorize()?;
        if Instant::now() >= deadline {
            return Err(open_timeout().into());
        }
        wire.queue(&Request::Start)?;
        match wire.receive_until(deadline, MAX_HELLO_BYTES) {
            Ok(Response::Opened { line_controls }) if wire.output.is_empty() => {
                Ok(Box::new(PluginTransport {
                    lane: Arc::new(Mutex::new(Lane::new(wire))),
                    cleanup: self.cleanup,
                    output_lines: line_controls.unwrap_or_default(),
                }))
            }
            // Provider 明确返回失败，连接未交给 Host。
            Ok(Response::Error {
                id: None,
                negotiation,
            }) if wire.output.is_empty() => {
                let negotiation = if self.report_rfc2217 {
                    negotiation
                } else {
                    None
                };
                Err(plugin_open_failure(negotiation).into())
            }
            outcome => {
                let error = match outcome {
                    Ok(_) => protocol_error(),
                    Err(error) => error,
                };
                Err(uncertain(error, self.cleanup))
            }
        }
    }
}

pub(crate) fn capabilities() -> TransportCapabilities {
    TransportCapabilities {
        semantics: TransportSemantics::Stream,
        configuration: false,
        dtr: false,
        rts: false,
        finite_break: false,
        queue_status: false,
        drain: false,
        purge_rx: false,
        purge_tx: false,
    }
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Request<'a> {
    Start,
    Read {
        id: u64,
        max_bytes: usize,
        wait_ms: u64,
    },
    Write {
        id: u64,
        bytes: &'a str,
        wait_ms: u64,
    },
    SetLine {
        id: u64,
        line: ControlLine,
        value: bool,
        wait_ms: u64,
    },
    Cancel {
        id: u64,
    },
    Close,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Response {
    Hello {
        credential: ContextToken,
    },
    Opened {
        #[serde(rename = "lineControls")]
        line_controls: Option<OutputLines>,
    },
    Line {
        id: u64,
        actual: Option<bool>,
    },
    Read {
        id: u64,
        bytes: String,
        eof: bool,
    },
    Written {
        id: u64,
        accepted: usize,
    },
    Error {
        id: Option<u64>,
        negotiation: Option<serde_json::Value>,
    },
    Closed,
}

#[derive(Default)]
struct FrameReader {
    header: [u8; 4],
    header_read: usize,
    body: Vec<u8>,
    body_read: usize,
}

impl FrameReader {
    fn poll(&mut self, stream: &mut TcpStream, limit: usize) -> HostResult<Option<Response>> {
        if self.header_read < self.header.len() {
            self.header_read += read_some(stream, &mut self.header[self.header_read..])?;
            if self.header_read < self.header.len() {
                return Ok(None);
            }
        }
        if self.body.is_empty() {
            let length = u32::from_be_bytes(self.header) as usize;
            if length == 0 || length > limit {
                return Err(protocol_error());
            }
            self.body.resize(length, 0);
        }
        self.body_read += read_some(stream, &mut self.body[self.body_read..])?;
        if self.body_read < self.body.len() {
            return Ok(None);
        }
        let frame = serde_json::from_slice(&self.body).map_err(|_| protocol_error())?;
        self.header_read = 0;
        self.body.clear();
        self.body_read = 0;
        Ok(Some(frame))
    }
}

struct Outbound {
    bytes: Vec<u8>,
    written: usize,
    operation_id: Option<u64>,
}

struct Wire {
    stream: TcpStream,
    reader: FrameReader,
    output: VecDeque<Outbound>,
}

impl Wire {
    fn new(stream: TcpStream) -> HostResult<Self> {
        stream.set_nonblocking(true).map_err(|_| disconnected())?;
        stream.set_nodelay(true).map_err(|_| disconnected())?;
        Ok(Self {
            stream,
            reader: FrameReader::default(),
            output: VecDeque::new(),
        })
    }

    fn queue(&mut self, request: &Request<'_>) -> HostResult<()> {
        if self.output.len() >= QUEUE_CAPACITY {
            return Err(HostError::new(
                "HOST_BUSY",
                "Plugin transport queue is full",
            ));
        }
        let body = encode_frame(request, MAX_FRAME_BYTES)?;
        let mut bytes = Vec::with_capacity(body.len() + 4);
        bytes.extend_from_slice(&(body.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&body);
        let operation_id = match request {
            Request::Read { id, .. } | Request::Write { id, .. } | Request::SetLine { id, .. } => {
                Some(*id)
            }
            _ => None,
        };
        self.output.push_back(Outbound {
            bytes,
            written: 0,
            operation_id,
        });
        Ok(())
    }

    fn flush(&mut self) -> HostResult<()> {
        while let Some(frame) = self.output.front_mut() {
            match self.stream.write(&frame.bytes[frame.written..]) {
                Ok(0) => return Err(disconnected()),
                Ok(written) => {
                    frame.written += written;
                    if frame.written < frame.bytes.len() {
                        return Ok(());
                    }
                    self.output.pop_front();
                }
                Err(error) if transient(&error) => return Ok(()),
                Err(_) => return Err(disconnected()),
            }
        }
        Ok(())
    }

    fn receive_until(&mut self, deadline: Instant, limit: usize) -> HostResult<Response> {
        loop {
            self.flush()?;
            if let Some(frame) = self.reader.poll(&mut self.stream, limit)? {
                return Ok(frame);
            }
            if !wait_until(deadline) {
                return Err(open_timeout());
            }
        }
    }

    fn is_dispatched(&self, id: u64) -> bool {
        !self
            .output
            .iter()
            .any(|frame| frame.operation_id == Some(id))
    }

    fn abort(&self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

enum LaneState {
    Open,
    Closing,
    Closed,
    Broken(HostError),
}

struct ReadRequest {
    id: u64,
    limit: usize,
    deadline: Instant,
    result: Option<HostResult<VecDeque<u8>>>,
}

struct WriteRequest {
    id: u64,
    // 底层结果返回前保留原载荷及其配额，包含已发出取消但仍可能执行的写入。
    bytes: WritePayload,
    result: Option<BackendWrite>,
    cancel_sent: bool,
}

struct LineRequest {
    id: u64,
    line: ControlLine,
    result: Option<HostResult<ControlResult>>,
    cancel_sent: bool,
}

struct Lane {
    wire: Wire,
    state: LaneState,
    next_id: u64,
    reading: Option<ReadRequest>,
    writing: Option<WriteRequest>,
    controlling: Option<LineRequest>,
}

impl Lane {
    fn new(wire: Wire) -> Self {
        Self {
            wire,
            state: LaneState::Open,
            next_id: 1,
            reading: None,
            writing: None,
            controlling: None,
        }
    }

    fn require_open(&self) -> HostResult<()> {
        match &self.state {
            LaneState::Open => Ok(()),
            LaneState::Broken(error) => Err(error.clone()),
            LaneState::Closing | LaneState::Closed => Err(disconnected()),
        }
    }

    fn next_id(&mut self) -> HostResult<u64> {
        let id = self.next_id;
        if id > MAX_WIRE_ID {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Transport sequence is exhausted",
            ));
        }
        self.next_id += 1;
        Ok(id)
    }

    fn start_read(&mut self, limit: usize, wait: Duration) -> HostResult<()> {
        let id = self.next_id()?;
        let limit = limit.min(MAX_READ_BYTES);
        let wait_ms = wait_ms(wait)?;
        let deadline = deadline(wait + READ_REPLY_GRACE)?;
        self.wire.queue(&Request::Read {
            id,
            max_bytes: limit,
            wait_ms,
        })?;
        self.reading = Some(ReadRequest {
            id,
            limit,
            deadline,
            result: None,
        });
        Ok(())
    }

    fn start_write(&mut self, bytes: WritePayload, wait: Duration) -> HostResult<u64> {
        if self.writing.is_some() {
            return Err(HostError::new(
                "HOST_BUSY",
                "Plugin transport write is pending",
            ));
        }
        if bytes.len() > TX_MAX_BYTES {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Plugin transport write is too large",
            ));
        }
        let id = self.next_id()?;
        self.wire.queue(&Request::Write {
            id,
            bytes: &STANDARD.encode(&bytes[..]),
            wait_ms: wait_ms(wait)?,
        })?;
        self.writing = Some(WriteRequest {
            id,
            bytes,
            result: None,
            cancel_sent: false,
        });
        Ok(id)
    }

    fn break_lane(&mut self, error: HostError) {
        self.wire.abort();
        self.state = LaneState::Broken(error);
    }

    fn drive(&mut self) {
        if matches!(self.state, LaneState::Closed | LaneState::Broken(_)) {
            return;
        }
        if let Err(error) = self.poll_responses() {
            self.break_lane(error);
        }
    }

    fn poll_responses(&mut self) -> HostResult<()> {
        self.wire.flush()?;
        // 一轮最多收取读、写、线路控制和关闭回执。
        for _ in 0..4 {
            let Some(response) = self
                .wire
                .reader
                .poll(&mut self.wire.stream, MAX_FRAME_BYTES)?
            else {
                break;
            };
            self.handle_response(response)?;
            if matches!(self.state, LaneState::Closed) {
                return Ok(());
            }
        }
        if matches!(self.state, LaneState::Open)
            && self
                .reading
                .as_ref()
                .is_some_and(|read| read.result.is_none() && Instant::now() >= read.deadline)
        {
            return Err(HostError::new(
                "BACKEND_DISCONNECTED",
                "Plugin transport did not settle a read",
            ));
        }
        Ok(())
    }

    fn handle_response(&mut self, response: Response) -> HostResult<()> {
        let operation_id = match &response {
            Response::Read { id, .. }
            | Response::Written { id, .. }
            | Response::Line { id, .. }
            | Response::Error {
                id: Some(id),
                negotiation: None,
            } => Some(*id),
            _ => None,
        };
        if operation_id.is_some_and(|id| !self.wire.is_dispatched(id)) {
            return Err(protocol_error());
        }
        match response {
            Response::Read { id, bytes, eof } => {
                let pending = self
                    .reading
                    .as_mut()
                    .filter(|read| read.id == id && read.result.is_none())
                    .ok_or_else(protocol_error)?;
                if bytes.len() > pending.limit.div_ceil(3) * 4 {
                    return Err(protocol_error());
                }
                let bytes = STANDARD.decode(bytes).map_err(|_| protocol_error())?;
                if bytes.len() > pending.limit || (eof && !bytes.is_empty()) {
                    return Err(protocol_error());
                }
                pending.result = Some(if eof {
                    Err(disconnected())
                } else {
                    Ok(bytes.into())
                });
            }
            Response::Written { id, accepted } => {
                let pending = self
                    .writing
                    .as_mut()
                    .filter(|write| write.id == id && write.result.is_none())
                    .ok_or_else(protocol_error)?;
                if accepted > pending.bytes.len() {
                    return Err(protocol_error());
                }
                pending.result = Some(BackendWrite {
                    accepted_ranges: prefix(accepted),
                    unknown_ranges: vec![],
                    error: (accepted < pending.bytes.len()).then(|| {
                        HostError::new("PARTIAL_WRITE", "Plugin transport accepted a partial write")
                    }),
                });
            }
            Response::Line { id, actual } => {
                let pending = self.pending_line(id).ok_or_else(protocol_error)?;
                pending.result = Some(
                    actual
                        .map(|value| ControlResult::Line {
                            line: pending.line,
                            value,
                        })
                        .ok_or_else(line_not_applied),
                );
            }
            Response::Error {
                id: Some(id),
                negotiation: None,
            } => {
                if let Some(read) = self
                    .reading
                    .as_mut()
                    .filter(|read| read.id == id && read.result.is_none())
                {
                    read.result = Some(Err(HostError::new(
                        "BACKEND_DISCONNECTED",
                        "Plugin transport read failed",
                    )));
                } else if let Some(write) = self
                    .writing
                    .as_mut()
                    .filter(|write| write.id == id && write.result.is_none())
                {
                    write.result = Some(unknown_write(write.bytes.len(), close_unknown()));
                } else if let Some(control) = self.pending_line(id) {
                    control.result = Some(Ok(ControlResult::LineUnknown {
                        line: control.line,
                        error: close_unknown(),
                    }));
                } else {
                    return Err(protocol_error());
                }
            }
            Response::Closed => {
                // 已认证的注册 owner 可以主动停用连接。先保留此前到达的 TX 回执。
                self.wire.abort();
                self.state = LaneState::Closed;
            }
            _ => return Err(protocol_error()),
        }
        Ok(())
    }

    fn pending_line(&mut self, id: u64) -> Option<&mut LineRequest> {
        self.controlling
            .as_mut()
            .filter(|pending| pending.id == id && pending.result.is_none())
    }

    fn take_read(&mut self, limit: usize) -> Option<HostResult<ReadBlock>> {
        let result = self.reading.as_mut()?.result.as_mut()?;
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(error) => {
                let error = error.clone();
                self.reading = None;
                return Some(Err(error));
            }
        };
        let count = limit.min(bytes.len());
        let block = bytes.drain(..count).collect::<Vec<_>>();
        if bytes.is_empty() {
            self.reading = None;
        }
        Some(Ok(ReadBlock {
            bytes: block.into(),
            message: None,
        }))
    }

    fn take_write(&mut self, id: u64) -> Option<BackendWrite> {
        let ended = matches!(self.state, LaneState::Closed | LaneState::Broken(_));
        let pending = self.writing.as_mut().filter(|write| write.id == id)?;
        let result = pending
            .result
            .take()
            .or_else(|| ended.then(|| unknown_write(pending.bytes.len(), close_unknown())))?;
        self.writing = None;
        Some(result)
    }

    fn cancel_write(&mut self, id: u64) -> HostResult<()> {
        if let Some(write) = self
            .writing
            .as_mut()
            .filter(|write| write.id == id && !write.cancel_sent)
        {
            self.wire.queue(&Request::Cancel { id })?;
            write.cancel_sent = true;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputLines {
    dtr: bool,
    rts: bool,
}

impl OutputLines {
    fn supports(self, line: ControlLine) -> bool {
        match line {
            ControlLine::Dtr => self.dtr,
            ControlLine::Rts => self.rts,
        }
    }
}

struct PluginTransport {
    lane: Arc<Mutex<Lane>>,
    cleanup: Option<Arc<dyn BackendCleanup>>,
    output_lines: OutputLines,
}

impl Transport for PluginTransport {
    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            dtr: self.output_lines.dtr,
            rts: self.output_lines.rts,
            ..capabilities()
        }
    }

    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        if limit == 0 {
            return Ok(empty_read());
        }
        wait_ms(wait)?;
        let deadline = deadline(wait)?;
        loop {
            {
                let mut lane = self.lane.lock().map_err(|_| disconnected())?;
                lane.drive();
                if let Some(result) = lane.take_read(limit) {
                    return result.map_err(BackendError::from);
                }
                lane.require_open()?;
                if lane.reading.is_none() {
                    lane.start_read(limit, wait)?;
                    lane.drive();
                    if let Some(result) = lane.take_read(limit) {
                        return result.map_err(BackendError::from);
                    }
                    lane.require_open()?;
                }
            }
            if !wait_until(deadline) {
                return Ok(empty_read());
            }
        }
    }

    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        let mut lane = self.lane.lock().map_err(|_| disconnected())?;
        lane.drive();
        lane.require_open()?;
        if cancelled.load(Ordering::SeqCst) || closing.load(Ordering::SeqCst) {
            return Err(
                HostError::new("CANCELLED", "Plugin transport write was not submitted").into(),
            );
        }
        let length = bytes.len();
        let id = lane.start_write(bytes, wait)?;
        lane.drive();
        Ok(Box::new(PluginWrite {
            lane: self.lane.clone(),
            id,
            length,
            cancelled,
            closing,
        }))
    }

    fn configure(&mut self, _: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        Err(unsupported().into())
    }

    fn control(&mut self, _: ControlCommand) -> BackendResult<ControlResult> {
        Err(unsupported().into())
    }

    fn begin_line_control(
        &mut self,
        line: ControlLine,
        value: bool,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> Option<BackendResult<Box<dyn PendingLineControl>>> {
        Some((|| {
            if !self.output_lines.supports(line) {
                return Err(HostError::new(
                    "UNSUPPORTED_CAPABILITY",
                    "Plugin transport cannot set this output line",
                )
                .into());
            }
            if cancelled.load(Ordering::SeqCst) || closing.load(Ordering::SeqCst) {
                return Err(line_not_applied().into());
            }
            let mut lane = self.lane.lock().map_err(|_| disconnected())?;
            lane.drive();
            lane.require_open()?;
            if lane.controlling.is_some() {
                return Err(
                    HostError::new("HOST_BUSY", "Plugin transport output line is pending").into(),
                );
            }
            let id = lane.next_id()?;
            lane.wire.queue(&Request::SetLine {
                id,
                line,
                value,
                wait_ms: LINE_WAIT_MS,
            })?;
            lane.controlling = Some(LineRequest {
                id,
                line,
                result: None,
                cancel_sent: false,
            });
            lane.drive();
            let pending: Box<dyn PendingLineControl> = Box::new(PluginLineControl {
                id,
                line,
                lane: self.lane.clone(),
                deadline: Instant::now() + Duration::from_millis(LINE_WAIT_MS) + READ_REPLY_GRACE,
                cancelled,
                closing,
            });
            Ok(pending)
        })())
    }

    fn begin_drain(&mut self, _: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        Err(unsupported().into())
    }

    fn close(&mut self) -> BackendResult<()> {
        let missed = || uncertain(close_unknown(), self.cleanup.clone());
        let deadline = Instant::now() + CLOSE_WAIT;
        {
            let mut lane = self.lane.lock().map_err(|_| missed())?;
            lane.drive();
            match lane.state {
                LaneState::Closed => return Ok(()),
                LaneState::Broken(_) => return Err(missed()),
                LaneState::Open => {
                    if let Err(error) = lane.wire.queue(&Request::Close) {
                        lane.break_lane(error);
                        return Err(missed());
                    }
                    lane.state = LaneState::Closing;
                }
                LaneState::Closing => {}
            }
        }
        loop {
            {
                let mut lane = self.lane.lock().map_err(|_| missed())?;
                lane.drive();
                match lane.state {
                    LaneState::Closed => return Ok(()),
                    LaneState::Broken(_) => return Err(missed()),
                    _ => {}
                }
                if Instant::now() >= deadline {
                    lane.break_lane(close_unknown());
                    return Err(missed());
                }
            }
            wait_until(deadline);
        }
    }
}

impl Drop for PluginTransport {
    fn drop(&mut self) {
        if let Ok(mut lane) = self.lane.lock()
            && matches!(lane.state, LaneState::Open | LaneState::Closing)
        {
            lane.break_lane(disconnected());
        }
    }
}

struct PluginWrite {
    lane: Arc<Mutex<Lane>>,
    id: u64,
    length: usize,
    cancelled: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
}

impl PendingWrite for PluginWrite {
    fn poll(&mut self) -> Option<BackendResult<BackendWrite>> {
        let Ok(mut lane) = self.lane.lock() else {
            return Some(Ok(unknown_write(self.length, close_unknown())));
        };
        lane.drive();
        if let Some(result) = lane.take_write(self.id) {
            return Some(Ok(result));
        }
        if self.cancelled.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst) {
            if let Err(error) = lane.cancel_write(self.id) {
                lane.break_lane(error);
            }
            lane.drive();
        }
        lane.take_write(self.id).map(Ok)
    }
}

fn read_some(stream: &mut TcpStream, output: &mut [u8]) -> HostResult<usize> {
    match stream.read(output) {
        Ok(0) => Err(disconnected()),
        Ok(read) => Ok(read),
        Err(error) if transient(&error) => Ok(0),
        Err(_) => Err(disconnected()),
    }
}

fn transient(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

fn deadline(wait: Duration) -> HostResult<Instant> {
    Instant::now().checked_add(wait).ok_or_else(wait_limit)
}

fn wait_ms(wait: Duration) -> HostResult<u64> {
    let milliseconds = wait.as_millis();
    if milliseconds > MAX_WAIT_MS {
        Err(wait_limit())
    } else {
        Ok(milliseconds as u64)
    }
}

fn wait_until(deadline: Instant) -> bool {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return false;
    }
    thread::sleep(remaining.min(POLL_INTERVAL));
    true
}

fn empty_read() -> ReadBlock {
    ReadBlock {
        bytes: Arc::from([]),
        message: None,
    }
}

fn prefix(length: usize) -> Vec<ByteRange> {
    if length == 0 {
        vec![]
    } else {
        vec![ByteRange {
            start: 0.into(),
            end: (length as u64).into(),
        }]
    }
}

fn unknown_write(length: usize, error: HostError) -> BackendWrite {
    BackendWrite {
        accepted_ranges: vec![],
        unknown_ranges: prefix(length),
        error: Some(error),
    }
}

fn uncertain(error: HostError, cleanup: Option<Arc<dyn BackendCleanup>>) -> BackendError {
    BackendError {
        error: Box::new(error),
        accepted_ranges: vec![],
        unknown_ranges: vec![],
        cleanup,
    }
}

struct PluginLineControl {
    id: u64,
    line: ControlLine,
    lane: Arc<Mutex<Lane>>,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
}

impl PendingLineControl for PluginLineControl {
    fn poll(&mut self) -> Option<BackendResult<ControlResult>> {
        let unknown = || ControlResult::LineUnknown {
            line: self.line,
            error: close_unknown(),
        };
        let Ok(mut lane) = self.lane.lock() else {
            return Some(Ok(unknown()));
        };
        lane.drive();
        let ended = matches!(lane.state, LaneState::Closed | LaneState::Broken(_));
        let Some(pending) = lane
            .controlling
            .as_mut()
            .filter(|pending| pending.id == self.id)
        else {
            return Some(Ok(unknown()));
        };
        if let Some(result) = pending.result.take() {
            lane.controlling = None;
            return Some(result.map_err(BackendError::from));
        }
        if ended {
            lane.controlling = None;
            return Some(Ok(unknown()));
        }
        if Instant::now() >= self.deadline {
            lane.break_lane(close_unknown());
            lane.controlling = None;
            return Some(Ok(unknown()));
        }
        if !pending.cancel_sent
            && (self.cancelled.load(Ordering::SeqCst) || self.closing.load(Ordering::SeqCst))
        {
            pending.cancel_sent = true;
            if let Err(error) = lane.wire.queue(&Request::Cancel { id: self.id }) {
                lane.break_lane(error);
                lane.controlling = None;
                return Some(Ok(unknown()));
            }
            lane.drive();
        }
        None
    }
}

fn line_not_applied() -> HostError {
    HostError::new(
        "CONTROL_NOT_APPLIED",
        "Plugin transport did not submit the line command",
    )
}

fn disconnected() -> HostError {
    HostError::new("BACKEND_DISCONNECTED", "Plugin transport connection ended")
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Rfc2217Field {
    Options,
    Binary,
    ComPort,
    BaudRate,
    DataBits,
    Parity,
    StopBits,
    FlowControl,
    Dtr,
    Rts,
}

impl Rfc2217Field {
    fn value(self, hex: Option<&str>) -> Option<u32> {
        let width = match self {
            Self::Options => return None,
            Self::Binary | Self::ComPort => 4,
            Self::BaudRate => 8,
            _ => 2,
        };
        let hex = hex.filter(|value| value.len() == width)?;
        if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        u32::from_str_radix(hex, 16).ok()
    }

    fn accepts_request(self, value: u32) -> bool {
        match self {
            Self::BaudRate => value > 0,
            Self::DataBits => (5..=8).contains(&value),
            Self::Parity => (1..=5).contains(&value),
            Self::StopBits | Self::FlowControl => (1..=3).contains(&value),
            Self::Dtr => matches!(value, 8 | 9),
            Self::Rts => matches!(value, 11 | 12),
            Self::Options | Self::Binary | Self::ComPort => false,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Rfc2217Reason {
    Refused,
    DifferentValue,
    InvalidReply,
    Timeout,
    Disconnected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rfc2217OpenFailure {
    reason: Rfc2217Reason,
    field: Rfc2217Field,
    requested_hex: Option<String>,
    reply_hex: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Rfc2217Protocol {
    Rfc2217,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Rfc2217OpenDetail {
    protocol: Rfc2217Protocol,
    reason: Rfc2217Reason,
    field: Rfc2217Field,
    #[serde(skip_serializing_if = "Option::is_none")]
    requested_value: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reported_value: Option<u32>,
}

impl Rfc2217OpenDetail {
    fn valid(&self) -> bool {
        let requested = self.requested_value;
        let reported = self.reported_value;
        let field = self.field;
        if !requested.is_none_or(|value| field.accepts_request(value)) {
            return false;
        }
        match self.reason {
            Rfc2217Reason::Refused => {
                requested.is_none()
                    && matches!(
                        (field, reported),
                        (Rfc2217Field::Binary, Some(0xfc00 | 0xfe00))
                            | (Rfc2217Field::ComPort, Some(0xfe2c))
                    )
            }
            Rfc2217Reason::Timeout | Rfc2217Reason::Disconnected => reported.is_none(),
            Rfc2217Reason::InvalidReply => requested.is_some() && reported.is_none(),
            Rfc2217Reason::DifferentValue => {
                requested.is_some()
                    && reported.is_some_and(|value| {
                        Some(value) != requested
                            && (matches!(field, Rfc2217Field::BaudRate)
                                || value <= u32::from(u8::MAX))
                    })
            }
        }
    }
}

// 公开操作回执继续裁剪私有诊断，只保留这个固定形状的可操作线路证据。
pub(crate) fn is_public_rfc2217_open_detail(details: &JsonObject) -> bool {
    serde_json::to_value(details)
        .and_then(serde_json::from_value::<Rfc2217OpenDetail>)
        .is_ok_and(|details| details.valid())
}

fn plugin_open_failure(negotiation: Option<serde_json::Value>) -> HostError {
    let mut error = HostError::new(
        "PLUGIN_TRANSPORT_OPEN_FAILED",
        "Plugin transport could not open the connection",
    );
    let Some(failure) =
        negotiation.and_then(|value| serde_json::from_value::<Rfc2217OpenFailure>(value).ok())
    else {
        return error;
    };
    let field = failure.field;
    let requested = field.value(failure.requested_hex.as_deref());
    let reported = field.value(failure.reply_hex.as_deref());
    let reply = Rfc2217OpenDetail {
        protocol: Rfc2217Protocol::Rfc2217,
        reason: match failure.reason {
            Rfc2217Reason::DifferentValue if reported.is_none() => Rfc2217Reason::InvalidReply,
            Rfc2217Reason::InvalidReply => return error,
            reason => reason,
        },
        field,
        requested_value: requested,
        reported_value: reported,
    };
    if reply.valid() {
        error.retryable = matches!(
            reply.reason,
            Rfc2217Reason::Timeout | Rfc2217Reason::Disconnected
        );
        error.details = serde_json::to_value(reply)
            .and_then(serde_json::from_value)
            .ok()
            .map(Box::new);
    }
    error
}

fn open_timeout() -> HostError {
    HostError::new("BACKEND_DISCONNECTED", "Plugin transport open wait expired")
}

fn close_unknown() -> HostError {
    HostError::new(
        "CONTROL_UNKNOWN",
        "Plugin transport settlement is unconfirmed",
    )
}

fn protocol_error() -> HostError {
    HostError::new("BACKEND_DISCONNECTED", "Invalid plugin transport frame")
}

fn unsupported() -> HostError {
    HostError::new(
        "UNSUPPORTED_CAPABILITY",
        "Plugin transport only supports byte streams",
    )
}

fn wait_limit() -> HostError {
    HostError::new("LIMIT_EXCEEDED", "Plugin transport wait exceeds its range")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const TEST_WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn rfc2217_open_failure_keeps_only_verified_field_and_bounded_values() {
        let mismatch = plugin_open_failure(Some(json!({
            "reason": "different_value", "field": "baudRate",
            "requestedHex": "0001c200", "replyHex": "00002580",
        })));
        assert_eq!(mismatch.code, "PLUGIN_TRANSPORT_OPEN_FAILED");
        let known = mismatch.details.as_deref().unwrap();
        assert!(is_public_rfc2217_open_detail(known));
        let mut with_private = known.clone();
        with_private.insert(
            "privateDiagnostic".into(),
            JsonValue::String("secret".into()),
        );
        assert!(!is_public_rfc2217_open_detail(&with_private));
        assert_eq!(
            serde_json::to_value(mismatch.details).unwrap(),
            json!({"protocol":"rfc2217","reason":"different_value","field":"baudRate","requestedValue":115200,"reportedValue":9600})
        );

        let malformed = plugin_open_failure(Some(json!({
            "reason": "different_value", "field": "stopBits",
            "requestedHex": "01", "replyHex": "0001020304",
        })));
        assert_eq!(
            serde_json::to_value(malformed.details).unwrap(),
            json!({"protocol":"rfc2217","reason":"invalid_reply","field":"stopBits","requestedValue":1})
        );

        let refused = plugin_open_failure(Some(json!({
            "reason": "refused", "field": "binary", "replyHex": "fe00",
        })));
        assert_eq!(
            serde_json::to_value(refused.details).unwrap(),
            json!({"protocol":"rfc2217","reason":"refused","field":"binary","reportedValue":0xfe00})
        );

        for payload in [
            json!({"reason":"different_value","field":"host","requestedHex":"01","replyHex":"02"}),
            json!({"reason":"different_value","field":"parity","requestedHex":"01","replyHex":"01"}),
            json!({"reason":"refused","field":"comPort","replyHex":"fd2c"}),
            json!({"reason":"timeout","field":"options","message":"private endpoint"}),
        ] {
            let generic = plugin_open_failure(Some(payload));
            assert_eq!(generic.code, "PLUGIN_TRANSPORT_OPEN_FAILED");
            assert!(generic.details.is_none());
        }
    }

    fn peer(address: SocketAddr) -> TcpStream {
        let peer = TcpStream::connect(address).unwrap();
        peer.set_read_timeout(Some(TEST_WAIT)).unwrap();
        peer.set_write_timeout(Some(TEST_WAIT)).unwrap();
        peer
    }

    fn send(peer: &mut TcpStream, frame: Value) {
        let body = encode_frame(&frame, MAX_FRAME_BYTES).unwrap();
        peer.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        peer.write_all(&body).unwrap();
    }

    fn receive(peer: &mut TcpStream) -> Value {
        let mut header = [0; 4];
        peer.read_exact(&mut header).unwrap();
        let length = u32::from_be_bytes(header) as usize;
        assert!((1..=MAX_FRAME_BYTES).contains(&length));
        let mut body = vec![0; length];
        peer.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn open_peer(address: SocketAddr, credential: &ContextToken) -> TcpStream {
        let mut peer = self::peer(address);
        send(&mut peer, json!({"kind":"hello","credential":credential}));
        assert_eq!(receive(&mut peer), json!({"kind":"start"}));
        send(&mut peer, json!({"kind":"opened"}));
        peer
    }

    fn assert_peer_closed(peer: &mut TcpStream) {
        match peer.read(&mut [0]) {
            Ok(0) => {}
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
            other => panic!("expected closed lane without another frame: {other:?}"),
        }
    }

    fn submit(transport: &mut dyn Transport, cancelled: Arc<AtomicBool>) -> Box<dyn PendingWrite> {
        transport
            .begin_write(
                WritePayload::owned(Arc::from(&[0_u8, 255, 10][..])),
                TEST_WAIT,
                cancelled,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap()
    }

    fn settle(write: &mut dyn PendingWrite) -> BackendWrite {
        let deadline = Instant::now() + TEST_WAIT;
        loop {
            if let Some(result) = write.poll() {
                return result.unwrap();
            }
            assert!(wait_until(deadline), "plugin write did not settle");
        }
    }

    #[test]
    fn authenticated_socket_preserves_binary_data_and_partial_prefix() {
        let offer = PendingPluginTransport::listen().unwrap();
        let address = offer.address();
        let credential = offer.credential().clone();
        let server = thread::spawn(move || {
            let mut denied = peer(address);
            send(
                &mut denied,
                json!({"kind":"hello","credential":random_token()}),
            );
            assert_peer_closed(&mut denied);
            let mut peer = open_peer(address, &credential);
            let write = receive(&mut peer);
            assert_eq!(write["kind"], "write");
            assert_eq!(
                STANDARD.decode(write["bytes"].as_str().unwrap()).unwrap(),
                [0, 255, 10]
            );
            send(
                &mut peer,
                json!({"kind":"written","id":write["id"],"accepted":2}),
            );
            let read = receive(&mut peer);
            assert_eq!(read["kind"], "read");
            assert_eq!(read["maxBytes"], 16);
            assert!(read["id"].as_u64().unwrap() > write["id"].as_u64().unwrap());
            send(
                &mut peer,
                json!({"kind":"read","id":read["id"],"bytes":"AP8=","eof":false}),
            );
            assert_eq!(receive(&mut peer), json!({"kind":"close"}));
            send(&mut peer, json!({"kind":"closed"}));
        });

        let mut transport = offer.accept(TEST_WAIT, || Ok(())).unwrap();
        let result = settle(submit(transport.as_mut(), Arc::new(AtomicBool::new(false))).as_mut());
        assert_eq!(result.accepted_ranges, prefix(2));
        assert!(result.unknown_ranges.is_empty());
        assert_eq!(result.error.unwrap().code, "PARTIAL_WRITE");
        assert_eq!(&*transport.read(16, TEST_WAIT).unwrap().bytes, &[0, 255]);
        transport.close().unwrap();
        server.join().unwrap();
    }

    #[test]
    fn revocation_while_waiting_for_hello_prevents_start() {
        let offer = PendingPluginTransport::listen().unwrap();
        let address = offer.address();
        let credential = offer.credential().clone();
        let allowed = Arc::new(AtomicBool::new(true));
        let revoke = allowed.clone();
        let server = thread::spawn(move || {
            let mut denied = peer(address);
            send(
                &mut denied,
                json!({"kind":"hello","credential":random_token()}),
            );
            assert_peer_closed(&mut denied);
            revoke.store(false, Ordering::Release);
            let mut peer = peer(address);
            send(&mut peer, json!({"kind":"hello","credential":credential}));
            assert_peer_closed(&mut peer);
        });

        let result = offer.accept(TEST_WAIT, || {
            if allowed.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(HostError::new(
                    "PERMISSION_DENIED",
                    "Permission was revoked",
                ))
            }
        });
        server.join().unwrap();
        let Err(error) = result else {
            panic!("revoked transport opened");
        };
        assert_eq!(error.error.code, "PERMISSION_DENIED");
        assert!(error.cleanup.is_none());
    }

    #[derive(Debug, Default)]
    struct ExitProof(AtomicBool);
    impl BackendCleanup for ExitProof {
        fn poll(&self) -> Option<HostResult<()>> {
            self.0.load(Ordering::SeqCst).then_some(Ok(()))
        }
    }

    #[test]
    fn cancellation_and_socket_loss_keep_unknown_write_and_cleanup_owner() {
        let actual_exit = Arc::new(ExitProof::default());
        let offer = PendingPluginTransport::listen()
            .unwrap()
            .with_cleanup(actual_exit.clone());
        let address = offer.address();
        let credential = offer.credential().clone();
        let server = thread::spawn(move || {
            let mut peer = open_peer(address, &credential);
            let write = receive(&mut peer);
            assert_eq!(write["kind"], "write");
            assert_eq!(
                receive(&mut peer),
                json!({"kind":"cancel","id":write["id"]})
            );
        });

        let mut transport = offer.accept(TEST_WAIT, || Ok(())).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut write = submit(transport.as_mut(), cancelled.clone());
        cancelled.store(true, Ordering::SeqCst);
        let result = settle(write.as_mut());
        assert!(result.accepted_ranges.is_empty());
        assert_eq!(result.unknown_ranges, prefix(3));
        assert_eq!(result.error.unwrap().code, "CONTROL_UNKNOWN");

        let error = transport.close().unwrap_err();
        assert_eq!(error.error.code, "CONTROL_UNKNOWN");
        let retained = error.cleanup.unwrap();
        assert!(retained.poll().is_none());
        server.join().unwrap();
        actual_exit.0.store(true, Ordering::SeqCst);
        assert_eq!(retained.poll(), Some(Ok(())));
    }
}
