use serial_workbench_core::{IpcChannel, IpcMessage, WireFrame};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};

const MAX_ITEMS: usize = 256;
const MAX_BYTES: usize = 4 * 1024 * 1024;

struct Event {
    frame: WireFrame,
    _budget: OwnedSemaphorePermit,
}
#[derive(Default)]
struct Pending {
    frames: VecDeque<Event>,
    closed: bool,
}
pub(super) enum PushError {
    Bytes,
    Slots,
    Closed,
}

pub(super) struct EventQueue {
    pending: Mutex<Pending>,
    budget: Arc<Semaphore>,
    changed: watch::Sender<()>,
}
impl EventQueue {
    pub(super) fn new() -> Self {
        Self {
            pending: Mutex::new(Pending::default()),
            budget: Arc::new(Semaphore::new(MAX_BYTES)),
            changed: watch::channel(()).0,
        }
    }
    pub(super) fn push(&self, frame: WireFrame, size: usize) -> Result<(), PushError> {
        let mut pending = self.pending.lock().expect("event queue");
        if pending.closed {
            return Err(PushError::Closed);
        }
        if pending.frames.len() >= MAX_ITEMS || self.budget.available_permits() < size {
            // 只在压力下移除同一订阅尚未交付的旧增量，最新帧仍排在实际到达位置。
            // 保留 Host 的 previous_cursor，使读者发现缺口后重新取快照，不能伪造连续游标。
            pending
                .frames
                .retain(|event| !same_state_stream(&event.frame, &frame));
        }
        if pending.frames.len() >= MAX_ITEMS {
            return Err(PushError::Slots);
        }
        let permit = self
            .budget
            .clone()
            .try_acquire_many_owned(size as u32)
            .map_err(|_| PushError::Bytes)?;
        pending.frames.push_back(Event {
            frame,
            _budget: permit,
        });
        drop(pending);
        self.changed.send_replace(());
        Ok(())
    }
    pub(super) async fn next(&self) -> Option<WireFrame> {
        let mut changed = self.changed.subscribe();
        loop {
            {
                let mut pending = self.pending.lock().expect("event queue");
                if pending.closed {
                    return None;
                }
                if let Some(Event {
                    frame,
                    _budget: permit,
                }) = pending.frames.pop_front()
                {
                    drop(permit);
                    return Some(frame);
                }
            }
            if changed.changed().await.is_err() {
                return None;
            }
        }
    }
    pub(super) fn close(&self) {
        let mut pending = self.pending.lock().expect("event queue");
        pending.closed = true;
        pending.frames.clear();
        drop(pending);
        self.changed.send_replace(());
    }
}

fn same_state_stream(older: &WireFrame, newer: &WireFrame) -> bool {
    if older.channel != IpcChannel::State
        || newer.channel != IpcChannel::State
        || older.request_id != newer.request_id
    {
        return false;
    }
    match (&older.body, &newer.body) {
        (
            IpcMessage::Delta {
                subscription_id: a,
                delta: before,
            },
            IpcMessage::Delta {
                subscription_id: b,
                delta: after,
            },
        ) => {
            a == b
                && before.cursor.host_id == after.cursor.host_id
                && before.cursor.instance_epoch == after.cursor.instance_epoch
                && before.cursor.scope_id == after.cursor.scope_id
                && before.cursor.position <= after.cursor.position
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_core::*;

    fn delta(position: u64) -> WireFrame {
        let cursor = |position: u64| Cursor {
            host_id: Id::try_from("host").unwrap(),
            instance_epoch: 1.into(),
            scope_id: Id::try_from("settings.shared").unwrap(),
            position: position.into(),
        };
        WireFrame {
            request_id: RequestId::try_from("00000000-0000-4000-8000-000000000001").unwrap(),
            channel: IpcChannel::State,
            body: IpcMessage::Delta {
                subscription_id: Id::try_from("reader").unwrap(),
                delta: Box::new(Delta {
                    cursor: cursor(position),
                    previous_cursor: cursor(position - 1),
                    revision: position.into(),
                    event_type: Id::try_from("settings.changed").unwrap(),
                    payload: JsonObject::new(),
                }),
            },
        }
    }
    fn push(queue: &EventQueue, frame: WireFrame) {
        let size = serial_workbench_ipc::frame::encoded_length(
            &frame,
            serial_workbench_ipc::frame::MAX_FRAME_BYTES,
        )
        .unwrap();
        assert!(queue.push(frame, size).is_ok());
    }
    #[tokio::test]
    async fn slot_pressure_keeps_other_events_in_order_and_preserves_the_latest_delta() {
        let queue = EventQueue::new();
        for position in 1..=254 {
            push(&queue, delta(position));
        }
        let terminal = WireFrame {
            body: IpcMessage::SubscriptionEnded {
                subscription_id: Id::try_from("other-reader").unwrap(),
                error: HostError::new("PERMISSION_DENIED", "revoked"),
            },
            ..delta(1)
        };
        push(&queue, terminal.clone());
        let catalog = WireFrame {
            channel: IpcChannel::Control,
            body: IpcMessage::CatalogChanged {
                catalog_version: 2.into(),
                visibility_token: Digest::try_from("a".repeat(64).as_str()).unwrap(),
            },
            ..delta(1)
        };
        push(&queue, catalog.clone());
        push(&queue, delta(255));
        assert_eq!(queue.next().await, Some(terminal));
        assert_eq!(queue.next().await, Some(catalog));
        assert_eq!(queue.next().await, Some(delta(255)));
        assert_eq!(queue.budget.available_permits(), MAX_BYTES);
    }
    #[test]
    fn pressure_does_not_merge_other_identities() {
        for variant in 0..5 {
            let queue = EventQueue::new();
            for position in 1..=MAX_ITEMS as u64 {
                push(&queue, delta(position));
            }
            let mut incoming = delta(257);
            if let IpcMessage::Delta {
                subscription_id,
                delta,
            } = &mut incoming.body
            {
                match variant {
                    0 => *subscription_id = Id::try_from("other-reader").unwrap(),
                    1 => {
                        incoming.request_id =
                            RequestId::try_from("00000000-0000-4000-8000-000000000002").unwrap()
                    }
                    2 => delta.cursor.host_id = Id::try_from("other-host").unwrap(),
                    3 => delta.cursor.instance_epoch = 2.into(),
                    _ => delta.cursor.scope_id = Id::try_from("other-scope").unwrap(),
                }
            }
            let size = serial_workbench_ipc::frame::encoded_length(
                &incoming,
                serial_workbench_ipc::frame::MAX_FRAME_BYTES,
            )
            .unwrap();
            assert!(matches!(queue.push(incoming, size), Err(PushError::Slots)));
            assert_eq!(queue.pending.lock().unwrap().frames.len(), MAX_ITEMS);
            queue.close();
            assert_eq!(queue.budget.available_permits(), MAX_BYTES);
        }
    }

    #[test]
    fn an_older_duplicate_never_displaces_a_newer_queued_cursor() {
        let queue = EventQueue::new();
        for position in 1..=MAX_ITEMS as u64 {
            push(&queue, delta(position));
        }
        push(&queue, delta(1));
        let pending = queue.pending.lock().unwrap();
        assert!(
            pending
                .frames
                .iter()
                .any(|event| event.frame == delta(MAX_ITEMS as u64))
        );
        assert_eq!(pending.frames.len(), MAX_ITEMS);
    }
    #[tokio::test]
    async fn close_wakes_an_empty_waiter_and_rejects_late_delivery() {
        let queue = EventQueue::new();
        let waiting = queue.next();
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), waiting.as_mut())
                .await
                .is_err()
        );
        queue.close();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
                .await
                .unwrap()
                .is_none()
        );
        assert!(matches!(queue.push(delta(1), 100), Err(PushError::Closed)));
    }
}
