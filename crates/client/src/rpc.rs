use crate::connection::{disconnected, new_request_id};
use serial_workbench_core::*;
use serial_workbench_ipc::{
    LocalStream,
    frame::{MAX_FRAME_BYTES, read_frame, write_frame},
};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::WriteHalf,
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
    task::JoinHandle,
};

type Pending = Arc<StdMutex<HashMap<RequestId, oneshot::Sender<HostResult<RpcReply>>>>>;
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
}
impl RpcConnection {
    pub async fn close(&self) -> HostResult<()> {
        self.healthy.store(false, Ordering::Release);
        self.closed.send_replace(true);
        for (_, sender) in self.pending.lock().map_err(|_| disconnected())?.drain() {
            let _ = sender.send(Err(disconnected()));
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
        let reader = tokio::spawn(async move {
            let budget = Arc::new(Semaphore::new(4 * 1024 * 1024));
            loop {
                let frame = match read_frame(&mut read, MAX_FRAME_BYTES).await {
                    Ok(Some(frame)) => frame,
                    _ => break,
                };
                match frame.body {
                    IpcMessage::Reply { reply } if frame.channel == channel => {
                        if let Some(sender) = reader_pending
                            .lock()
                            .expect("pending mutex")
                            .remove(&frame.request_id)
                        {
                            let _ = sender.send(Ok(*reply));
                        }
                        continue;
                    }
                    IpcMessage::Error { ref error } => {
                        if let Some(sender) = reader_pending
                            .lock()
                            .expect("pending mutex")
                            .remove(&frame.request_id)
                        {
                            let _ = sender.send(Err(error.clone()));
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
                    _ => break,
                }
                let Ok(size) = serial_workbench_ipc::frame::encoded_length(&frame, MAX_FRAME_BYTES)
                else {
                    break;
                };
                let Ok(permit) = budget.clone().try_acquire_many_owned(size as u32) else {
                    break;
                };
                if events_tx
                    .try_send(Event {
                        frame,
                        _budget: permit,
                    })
                    .is_err()
                {
                    break;
                }
            }
            reader_healthy.store(false, Ordering::Release);
            reader_closed.send_replace(true);
            for (_, sender) in reader_pending.lock().expect("pending mutex").drain() {
                let _ = sender.send(Err(disconnected()));
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
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|_| disconnected())?;
            if !self.healthy.load(Ordering::Acquire) {
                return Err(disconnected());
            }
            if pending.len() >= 256 {
                return Err(HostError::new(
                    "HOST_BUSY",
                    "Client request capacity exhausted",
                ));
            }
            if pending.contains_key(&request_id) {
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "This request is already pending on the connection",
                ));
            }
            pending.insert(request_id.clone(), send);
        }
        let _pending_guard = PendingGuard {
            pending: self.pending.clone(),
            request_id: request_id.clone(),
        };
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
        receive.await.map_err(|_| disconnected())?
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
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.request_id);
        }
    }
}
struct WriteGuard<'a> {
    healthy: &'a AtomicBool,
    complete: bool,
}
impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if !self.complete {
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
