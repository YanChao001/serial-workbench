use crate::connection::{disconnected, new_request_id};
use serde::Serialize;
use serial_workbench_core::*;
use serial_workbench_ipc::{
    LocalStream,
    frame::{MAX_FRAME_BYTES, read_frame, write_frame},
};
use sha2::{Digest as _, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::WriteHalf,
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, watch},
    task::JoinHandle,
};

type Pending = Arc<StdMutex<HashMap<RequestId, PendingRequest>>>;
struct PendingRequest {
    reply: watch::Sender<Option<HostResult<RpcReply>>>,
    identity: Arc<()>,
    fingerprint: [u8; 32],
    shareable: bool,
    waiters: usize,
    diagnostic: RequestDiagnostic,
    started: Instant,
}

fn request_fingerprint(request: &RpcRequest) -> HostResult<[u8; 32]> {
    struct BoundedDigest {
        hash: Sha256,
        remaining: usize,
    }
    impl std::io::Write for BoundedDigest {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.remaining {
                return Err(std::io::Error::other("request limit"));
            }
            self.remaining -= bytes.len();
            self.hash.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = BoundedDigest {
        hash: Sha256::new(),
        remaining: MAX_FRAME_BYTES,
    };
    serde_json::to_writer(&mut writer, request)
        .map_err(|_| HostError::new("LIMIT_EXCEEDED", "IPC request exceeds the byte limit"))?;
    Ok(writer.hash.finalize().into())
}

#[derive(Clone, Copy, Serialize)]
struct RequestDiagnostic {
    method: &'static str,
    action: &'static str,
}
impl RequestDiagnostic {
    fn of(request: &RpcRequest) -> Self {
        let (method, action) = match request {
            RpcRequest::Attach(_) => ("host.attach", None),
            RpcRequest::Invoke(call) => ("action.invoke", Some(&call.action_id)),
            RpcRequest::InvokeChild(call) => ("action.invokeChild", Some(&call.action_id)),
            RpcRequest::Query(query) => ("action.query", Some(&query.action_id)),
            RpcRequest::CatalogList(query) => ("catalog.list", Some(&query.action_id)),
            RpcRequest::OperationGet(query) => ("operation.get", Some(&query.action_id)),
            RpcRequest::OperationCancel(call) => ("operation.cancel", Some(&call.action_id)),
            RpcRequest::StateSnapshot(query) => ("state.snapshot", Some(&query.action_id)),
            RpcRequest::StateSubscribe(query) => ("state.subscribe", Some(&query.action_id)),
            RpcRequest::SubscriptionClose(query) => ("subscription.close", Some(&query.action_id)),
            RpcRequest::ObjectRead(query) => ("object.read", Some(&query.action_id)),
            RpcRequest::StreamRead(query) => ("stream.read", Some(&query.action_id)),
            RpcRequest::StreamSubscribe(query) => ("stream.subscribe", Some(&query.action_id)),
            RpcRequest::StreamCredit(query) => ("stream.credit", Some(&query.action_id)),
            RpcRequest::ClientRegister(_) => ("client.register", None),
            RpcRequest::ClientUnregister(_) => ("client.unregister", None),
            RpcRequest::ClientReceipt(_) => ("client.receipt", None),
        };
        Self {
            method,
            // 只输出 Core 固定目录名称，不回显未知动作或请求正文。
            action: action
                .and_then(|id| BuiltinAction::find(id.as_str()).ok())
                .map_or("other", BuiltinAction::action_id),
        }
    }
}

#[derive(Serialize)]
struct ConflictDiagnostic {
    connection: Option<u64>,
    channel: &'static str,
    request_digest: String,
    first: RequestDiagnostic,
    second: RequestDiagnostic,
    inflight_ms: u64,
}
impl ConflictDiagnostic {
    fn new(
        connection: Option<u64>,
        channel: IpcChannel,
        request_id: &RequestId,
        first: &PendingRequest,
        second: RequestDiagnostic,
    ) -> Self {
        let digest = Sha256::digest(request_id.as_str().as_bytes());
        Self {
            connection,
            channel: match channel {
                IpcChannel::Control => "control",
                IpcChannel::Raw => "raw",
                IpcChannel::State => "state",
            },
            request_digest: format!("{:x}", digest)[..16].to_owned(),
            first: first.diagnostic,
            second,
            inflight_ms: first
                .started
                .elapsed()
                .as_millis()
                .try_into()
                .unwrap_or(u64::MAX),
        }
    }
}

struct ConflictWarnings {
    since: Instant,
    emitted: u8,
}
impl ConflictWarnings {
    fn admit(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.since) >= Duration::from_secs(60) {
            self.since = now;
            self.emitted = 0;
        }
        if self.emitted >= 20 {
            return false;
        }
        self.emitted += 1;
        true
    }
}
fn warn_conflict(diagnostic: &ConflictDiagnostic) {
    if !log::log_enabled!(target: "serial_workbench_client", log::Level::Warn) {
        return;
    }
    // 全进程限制条数；不为诊断增加请求重试、任务或无界日志队列。
    static WARNINGS: StdMutex<Option<ConflictWarnings>> = StdMutex::new(None);
    let admitted = WARNINGS.lock().is_ok_and(|mut warnings| {
        let now = Instant::now();
        warnings
            .get_or_insert(ConflictWarnings {
                since: now,
                emitted: 0,
            })
            .admit(now)
    });
    if admitted && let Ok(value) = serde_json::to_string(diagnostic) {
        log::warn!(target: "serial_workbench_client", "RPC_REQUEST_CONFLICT {value}");
    }
}

fn next_connection_id() -> Option<u64> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    // 诊断序号耗尽不改变业务请求的接纳或错误语义。
    NEXT.try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        value.checked_add(1)
    })
    .ok()
}
fn channel_label(channel: IpcChannel) -> &'static str {
    match channel {
        IpcChannel::Control => "control",
        IpcChannel::State => "state",
        IpcChannel::Raw => "raw",
    }
}
fn diagnostic_error_code(error: &HostError) -> &str {
    let code = error.code.as_str();
    if !code.is_empty()
        && code.len() <= 64
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        code
    } else {
        "UNKNOWN"
    }
}
struct Event {
    frame: WireFrame,
    _budget: OwnedSemaphorePermit,
}
pub(crate) struct RpcConnection {
    writer: Mutex<Option<WriteHalf<LocalStream>>>,
    pending: Pending,
    healthy: Arc<AtomicBool>,
    events: Mutex<mpsc::Receiver<Event>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    closed: watch::Sender<bool>,
    channel: IpcChannel,
    diagnostic_id: Option<u64>,
}
impl RpcConnection {
    pub async fn close(&self) -> HostResult<()> {
        self.healthy.store(false, Ordering::Release);
        self.closed.send_replace(true);
        for (_, pending) in self.pending.lock().map_err(|_| disconnected())?.drain() {
            pending.reply.send_replace(Some(Err(disconnected())));
        }
        // Keep the handle in its slot until joined. A cancelled close waiter must
        // not detach ownership or make a concurrent close report completion early.
        let mut reader = self.reader.lock().await;
        if let Some(task) = reader.as_mut() {
            task.abort();
            let _ = task.await;
        }
        reader.take();
        drop(reader);
        // Dropping both split halves closes the named pipe as well as Unix
        // sockets, including when a late worker still holds Arc<HostClient>.
        self.writer.lock().await.take();
        let mut events = self.events.lock().await;
        events.close();
        while events.try_recv().is_ok() {}
        Ok(())
    }
    pub fn new(stream: LocalStream, channel: IpcChannel) -> Self {
        let (mut read, write) = tokio::io::split(stream);
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let healthy = Arc::new(AtomicBool::new(true));
        let (closed, _) = watch::channel(false);
        let (events_tx, events_rx) = mpsc::channel(256);
        let reader_pending = pending.clone();
        let reader_healthy = healthy.clone();
        let reader_closed = closed.clone();
        let diagnostic_id = next_connection_id();
        let reader = tokio::spawn(async move {
            let budget = Arc::new(Semaphore::new(4 * 1024 * 1024));
            // 每条停止记录只含连接内序号、固定类别和受限错误码。
            let warn_stop = |reason: &str, message: &str, incoming: &str, code: &str| {
                log::warn!(target: "serial_workbench_client",
                    "RPC_READER_STOP connection={diagnostic_id:?} channel={} reason={reason} message={message} incoming={incoming} code={code}",
                    channel_label(channel),
                );
            };
            loop {
                let frame = match read_frame(&mut read, MAX_FRAME_BYTES).await {
                    Ok(Some(frame)) => frame,
                    Ok(None) => {
                        // EOF 也发生于正常 Host 关停，默认日志不能污染 CLI 成功输出。
                        log::debug!(target: "serial_workbench_client",
                            "RPC_READER_STOP connection={diagnostic_id:?} channel={} reason=eof message=- incoming=- code=-",
                            channel_label(channel),
                        );
                        break;
                    }
                    Err(error) => {
                        warn_stop("read_error", "-", "-", diagnostic_error_code(&error));
                        break;
                    }
                };
                let message = match &frame.body {
                    IpcMessage::Reply { .. } => "reply",
                    IpcMessage::Error { .. } => "error",
                    IpcMessage::Delta { .. } => "delta",
                    IpcMessage::CatalogChanged { .. } => "catalog_changed",
                    IpcMessage::ClientEffect { .. } => "client_effect",
                    IpcMessage::RawBatch { .. } => "raw_batch",
                    IpcMessage::SubscriptionEnded { .. } => "subscription_ended",
                    _ => "other",
                };
                let incoming = channel_label(frame.channel);
                match frame.body {
                    IpcMessage::Reply { reply } if frame.channel == channel => {
                        if let Some(sender) = reader_pending
                            .lock()
                            .expect("pending mutex")
                            .remove(&frame.request_id)
                        {
                            sender.reply.send_replace(Some(Ok(*reply)));
                        }
                        continue;
                    }
                    IpcMessage::Error { ref error } => {
                        if let Some(sender) = reader_pending
                            .lock()
                            .expect("pending mutex")
                            .remove(&frame.request_id)
                        {
                            sender.reply.send_replace(Some(Err(error.clone())));
                            continue;
                        }
                    }
                    IpcMessage::Delta { .. }
                        if channel == IpcChannel::Control && frame.channel == IpcChannel::State => {
                    }
                    IpcMessage::CatalogChanged { .. }
                        if channel == IpcChannel::Control
                            && frame.channel == IpcChannel::Control => {}
                    IpcMessage::ClientEffect { .. }
                        if channel == IpcChannel::Control
                            && frame.channel == IpcChannel::Control => {}
                    IpcMessage::RawBatch { .. }
                        if channel == IpcChannel::Raw && frame.channel == IpcChannel::Raw => {}
                    IpcMessage::SubscriptionEnded { .. }
                        if (channel == IpcChannel::Control
                            && frame.channel == IpcChannel::State)
                            || (channel == IpcChannel::Raw && frame.channel == IpcChannel::Raw) => {
                    }
                    _ => {
                        warn_stop("unexpected_message", message, incoming, "-");
                        break;
                    }
                }
                let Ok(size) = serial_workbench_ipc::frame::encoded_length(&frame, MAX_FRAME_BYTES)
                else {
                    warn_stop("event_encoding_failed", message, incoming, "-");
                    break;
                };
                let Ok(permit) = budget.clone().try_acquire_many_owned(size as u32) else {
                    warn_stop("event_bytes_exhausted", message, incoming, "-");
                    break;
                };
                match events_tx.try_send(Event {
                    frame,
                    _budget: permit,
                }) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        warn_stop("event_slots_exhausted", message, incoming, "-");
                        break;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        warn_stop("event_receiver_closed", message, incoming, "-");
                        break;
                    }
                }
            }
            reader_healthy.store(false, Ordering::Release);
            reader_closed.send_replace(true);
            for (_, pending) in reader_pending.lock().expect("pending mutex").drain() {
                pending.reply.send_replace(Some(Err(disconnected())));
            }
        });
        Self {
            writer: Mutex::new(Some(write)),
            pending,
            healthy,
            events: Mutex::new(events_rx),
            reader: Mutex::new(Some(reader)),
            closed,
            channel,
            diagnostic_id,
        }
    }
    pub async fn request(&self, request: RpcRequest) -> HostResult<RpcReply> {
        let required = request.required_channel()?;
        if (self.channel == IpcChannel::Control && required == RequestChannel::Raw)
            || (self.channel == IpcChannel::Raw && required == RequestChannel::Control)
        {
            return Ok(RpcReply::Failure {
                ok: False,
                error: HostError::new(
                    "PERMISSION_DENIED",
                    "Request requires a different physical connection",
                ),
            });
        }
        if !self.healthy.load(Ordering::Acquire) {
            return Err(disconnected());
        }
        let request_id = request_id(&request);
        let diagnostic = RequestDiagnostic::of(&request);
        let fingerprint = request_fingerprint(&request)?;
        // 只合并同一物理连接上完全相同的在途查询；业务调用和流控制不重放。
        let shareable = matches!(&request, RpcRequest::Query(_) | RpcRequest::OperationGet(_));
        let admitted = {
            let mut pending = self.pending.lock().map_err(|_| disconnected())?;
            if !self.healthy.load(Ordering::Acquire) {
                return Err(disconnected());
            }
            if pending.values().map(|entry| entry.waiters).sum::<usize>() >= 256 {
                return Err(HostError::new(
                    "HOST_BUSY",
                    "Client request capacity exhausted",
                ));
            }
            if let Some(first) = pending.get_mut(&request_id) {
                if shareable && first.shareable && first.fingerprint == fingerprint {
                    first.waiters += 1;
                    Ok((first.reply.subscribe(), first.identity.clone(), false))
                } else {
                    Err(ConflictDiagnostic::new(
                        self.diagnostic_id,
                        self.channel,
                        &request_id,
                        first,
                        diagnostic,
                    ))
                }
            } else {
                let (send, receive) = watch::channel(None);
                let identity = Arc::new(());
                pending.insert(
                    request_id.clone(),
                    PendingRequest {
                        reply: send,
                        identity: identity.clone(),
                        fingerprint,
                        shareable,
                        waiters: 1,
                        diagnostic,
                        started: Instant::now(),
                    },
                );
                Ok((receive, identity, true))
            }
        };
        let (mut receive, identity, must_write) = match admitted {
            Ok(value) => value,
            Err(conflict) => {
                // 日志在 pending 锁外输出，原请求仍由原 future/guard 持有。
                warn_conflict(&conflict);
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "This request is already pending on the connection",
                ));
            }
        };
        let mut pending_guard = PendingGuard {
            pending: self.pending.clone(),
            request_id: request_id.clone(),
            identity,
            must_write,
        };
        if must_write {
            let frame = WireFrame {
                request_id,
                channel: self.channel,
                body: IpcMessage::Request {
                    request: Box::new(request),
                },
            };
            {
                let mut closed = self.closed.subscribe();
                let mut writer = self.writer.lock().await;
                if !self.healthy.load(Ordering::Acquire) {
                    return Err(disconnected());
                }
                let writer = writer.as_mut().ok_or_else(disconnected)?;
                let mut write_guard = WriteGuard {
                    healthy: &self.healthy,
                    complete: false,
                    diagnostic_id: self.diagnostic_id,
                    channel: channel_label(self.channel),
                };
                tokio::select! {
                    biased;
                    _ = closed.wait_for(|closed| *closed) => return Err(disconnected()),
                    result = tokio::time::timeout(Duration::from_secs(5), write_frame(writer, &frame, MAX_FRAME_BYTES)) => {
                        result.map_err(|_| disconnected())??;
                    }
                }
                write_guard.complete = true;
            }
            pending_guard.must_write = false;
        }
        let reply = receive
            .wait_for(|reply| reply.is_some())
            .await
            .map_err(|_| disconnected())?;
        reply.as_ref().expect("completed reply").clone()
    }
    pub async fn next_event(&self) -> HostResult<Option<WireFrame>> {
        if !self.healthy.load(Ordering::Acquire) {
            return Err(disconnected());
        }
        let mut closed = self.closed.subscribe();
        let event = tokio::select! {
            biased;
            _ = closed.wait_for(|closed| *closed) => return Err(disconnected()),
            event = async { self.events.lock().await.recv().await } => event,
        };
        match event {
            Some(event) => Ok(Some(event.frame)),
            None if self.healthy.load(Ordering::Acquire) => Ok(None),
            None => Err(disconnected()),
        }
    }
}
impl Drop for RpcConnection {
    fn drop(&mut self) {
        self.healthy.store(false, Ordering::Release);
        self.closed.send_replace(true);
        if let Some(reader) = self.reader.get_mut().take() {
            reader.abort();
        }
    }
}
struct PendingGuard {
    pending: Pending,
    request_id: RequestId,
    identity: Arc<()>,
    must_write: bool,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            // 其他等待者继续拥有已写入的请求；旧 guard 不能移除同 ID 的新请求。
            let remove = pending.get_mut(&self.request_id).is_some_and(|entry| {
                if !Arc::ptr_eq(&entry.identity, &self.identity) {
                    return false;
                }
                entry.waiters -= 1;
                self.must_write || entry.waiters == 0
            });
            if remove {
                pending.remove(&self.request_id);
            }
        }
    }
}
struct WriteGuard<'a> {
    healthy: &'a AtomicBool,
    complete: bool,
    diagnostic_id: Option<u64>,
    channel: &'static str,
}
impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if !self.complete {
            log::warn!(target: "serial_workbench_client",
                "RPC_WRITE_INTERRUPTED connection={:?} channel={}",
                self.diagnostic_id,
                self.channel,
            );
            self.healthy.store(false, Ordering::Release);
        }
    }
}
fn request_id(request: &RpcRequest) -> RequestId {
    match request {
        RpcRequest::Attach(_)
        | RpcRequest::InvokeChild(_)
        | RpcRequest::ClientRegister(_)
        | RpcRequest::ClientUnregister(_)
        | RpcRequest::ClientReceipt(_) => new_request_id(),
        RpcRequest::Invoke(call) | RpcRequest::OperationCancel(call) => call.request_id.clone(),
        RpcRequest::Query(q)
        | RpcRequest::CatalogList(q)
        | RpcRequest::OperationGet(q)
        | RpcRequest::StateSnapshot(q)
        | RpcRequest::StateSubscribe(q)
        | RpcRequest::SubscriptionClose(q)
        | RpcRequest::ObjectRead(q)
        | RpcRequest::StreamRead(q)
        | RpcRequest::StreamSubscribe(q)
        | RpcRequest::StreamCredit(q) => q.request_id.clone(),
    }
}

#[cfg(test)]
mod tests;
