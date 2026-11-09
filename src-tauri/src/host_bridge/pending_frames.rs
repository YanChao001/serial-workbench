use serial_workbench_core::{HostError, HostResult, RequestId, WireFrame};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

const MAX_ITEMS: usize = 256;
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct RequestFrames {
    frames: Vec<WireFrame>,
    bytes: usize,
}

/// Only an in-flight subscribe request may own frames received before its reply.
/// Retired subscriptions never consume another request's setup budget.
#[derive(Default)]
pub(super) struct PendingFrames {
    requests: HashMap<RequestId, RequestFrames>,
    items: usize,
    bytes: usize,
}

pub(super) struct PendingSetup {
    inbox: Arc<Mutex<PendingFrames>>,
    request_id: RequestId,
}

impl PendingFrames {
    pub(super) fn begin(
        inbox: &Arc<Mutex<Self>>,
        request_id: RequestId,
    ) -> HostResult<PendingSetup> {
        let mut pending = inbox.lock().expect("pending subscription frames");
        if pending.requests.contains_key(&request_id) {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Subscription request is already pending",
            ));
        }
        if pending.requests.len() >= MAX_ITEMS {
            return Err(exhausted());
        }
        pending
            .requests
            .insert(request_id.clone(), RequestFrames::default());
        Ok(PendingSetup {
            inbox: inbox.clone(),
            request_id,
        })
    }

    pub(super) fn push(&mut self, frame: WireFrame) -> HostResult<()> {
        if !self.requests.contains_key(&frame.request_id) {
            return Ok(());
        }
        let bytes = serial_workbench_ipc::frame::encoded_length(
            &frame,
            serial_workbench_ipc::frame::MAX_FRAME_BYTES,
        )?;
        if self.items >= MAX_ITEMS || bytes > MAX_BYTES.saturating_sub(self.bytes) {
            return Err(exhausted());
        }
        let request = self
            .requests
            .get_mut(&frame.request_id)
            .expect("pending request");
        request.bytes += bytes;
        request.frames.push(frame);
        self.items += 1;
        self.bytes += bytes;
        Ok(())
    }

    fn take(&mut self, request_id: &RequestId) -> Vec<WireFrame> {
        let Some(request) = self.requests.remove(request_id) else {
            return Vec::new();
        };
        self.items -= request.frames.len();
        self.bytes -= request.bytes;
        request.frames
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.items
    }
}

impl PendingSetup {
    pub(super) fn take(self) -> Vec<WireFrame> {
        let mut inbox = self.inbox.lock().expect("pending subscription frames");
        let frames = inbox.take(&self.request_id);
        drop(inbox);
        frames
    }
}

impl Drop for PendingSetup {
    fn drop(&mut self) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.take(&self.request_id);
        }
    }
}

fn exhausted() -> HostError {
    HostError::new("HOST_BUSY", "Subscription setup capacity exhausted")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_core::{Id, IpcChannel, IpcMessage};

    fn request(number: u64) -> RequestId {
        RequestId::try_from(format!("00000000-0000-4000-8000-{number:012}").as_str()).unwrap()
    }
    fn frame(request_id: RequestId) -> WireFrame {
        WireFrame {
            request_id,
            channel: IpcChannel::State,
            body: IpcMessage::SubscriptionEnded {
                subscription_id: Id::try_from("subscription").unwrap(),
                error: HostError::new("PERMISSION_DENIED", "Grant changed during setup"),
            },
        }
    }

    #[test]
    fn failed_setup_releases_its_frames_and_ignores_late_frames() {
        let inbox = Arc::new(Mutex::new(PendingFrames::default()));
        let failed = PendingFrames::begin(&inbox, request(1)).unwrap();
        let live = PendingFrames::begin(&inbox, request(2)).unwrap();
        inbox.lock().unwrap().push(frame(request(1))).unwrap();
        inbox.lock().unwrap().push(frame(request(2))).unwrap();
        drop(failed);
        for _ in 0..300 {
            inbox.lock().unwrap().push(frame(request(1))).unwrap();
        }
        assert_eq!(inbox.lock().unwrap().len(), 1);
        assert_eq!(live.take().len(), 1);
        let state = inbox.lock().unwrap();
        assert_eq!((state.requests.len(), state.items, state.bytes), (0, 0, 0));
    }

    #[test]
    fn valid_setup_keeps_the_shared_item_limit_and_returns_capacity_on_drop() {
        let inbox = Arc::new(Mutex::new(PendingFrames::default()));
        let first = PendingFrames::begin(&inbox, request(1)).unwrap();
        let second = PendingFrames::begin(&inbox, request(2)).unwrap();
        for index in 0..MAX_ITEMS {
            inbox
                .lock()
                .unwrap()
                .push(frame(request(1 + index as u64 % 2)))
                .unwrap();
        }
        assert_eq!(
            inbox
                .lock()
                .unwrap()
                .push(frame(request(2)))
                .unwrap_err()
                .code,
            "HOST_BUSY"
        );
        drop(first);
        inbox.lock().unwrap().push(frame(request(2))).unwrap();
        assert_eq!(second.take().len(), MAX_ITEMS / 2 + 1);
        assert_eq!(inbox.lock().unwrap().bytes, 0);
    }

    #[test]
    fn valid_setup_keeps_the_byte_limit_and_returns_capacity_on_completion() {
        let inbox = Arc::new(Mutex::new(PendingFrames::default()));
        let setup = PendingFrames::begin(&inbox, request(1)).unwrap();
        let mut large = frame(request(1));
        let IpcMessage::SubscriptionEnded { error, .. } = &mut large.body else {
            unreachable!()
        };
        error.message = "x".repeat(900_000);
        for _ in 0..4 {
            inbox.lock().unwrap().push(large.clone()).unwrap();
        }
        assert_eq!(
            inbox.lock().unwrap().push(large).unwrap_err().code,
            "HOST_BUSY"
        );
        assert_eq!(setup.take().len(), 4);
        assert_eq!(inbox.lock().unwrap().bytes, 0);
    }
}
