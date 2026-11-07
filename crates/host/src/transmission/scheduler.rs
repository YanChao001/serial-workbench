use serial_workbench_core::*;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, atomic::AtomicBool},
};
use tokio::sync::Notify;

pub(super) struct Entry {
    pub id: Id,
    pub actor: Id,
    pub lease: Option<Id>,
    pub bytes: usize,
}
#[derive(Default)]
pub(super) struct Queue {
    pub entries: VecDeque<Entry>,
    pub active: Option<Entry>,
    pub bytes: usize,
    last_actor: Option<Id>,
}
#[derive(Default)]
pub(super) struct Runtime {
    reservations: Mutex<(usize, usize)>,
    pub queue: Mutex<Queue>,
    pub changed: Notify,
    pub lease: Arc<Mutex<Option<Lease>>>,
    pub lease_transition: tokio::sync::Mutex<()>,
    pub closing: AtomicBool,
}
pub(super) struct QueueReservation {
    runtime: Arc<Runtime>,
    bytes: usize,
}
impl Runtime {
    pub fn reserve(self: &Arc<Self>, bytes: usize) -> HostResult<QueueReservation> {
        let mut current = self
            .reservations
            .lock()
            .map_err(|_| HostError::new("HOST_BUSY", "Queue is unavailable"))?;
        if current.0 >= 128 || current.1.saturating_add(bytes) > 4 * 1024 * 1024 {
            return Err(HostError::new("HOST_BUSY", "Session TX queue is full"));
        }
        current.0 += 1;
        current.1 += bytes;
        Ok(QueueReservation {
            runtime: self.clone(),
            bytes,
        })
    }
}
impl Drop for QueueReservation {
    fn drop(&mut self) {
        if let Ok(mut current) = self.runtime.reservations.lock() {
            current.0 -= 1;
            current.1 -= self.bytes;
        }
        self.runtime.changed.notify_waiters();
    }
}
impl Queue {
    pub fn enqueue(&mut self, entry: Entry) -> HostResult<()> {
        if self.entries.len() + usize::from(self.active.is_some()) >= 128
            || self.bytes.saturating_add(entry.bytes) > 4 * 1024 * 1024
        {
            return Err(HostError::new("HOST_BUSY", "Session TX queue is full"));
        }
        self.bytes += entry.bytes;
        self.entries.push_back(entry);
        Ok(())
    }
    pub fn take(&mut self, id: &Id, lease: Option<&Lease>) -> bool {
        if self.active.is_some() {
            return false;
        }
        let eligible = |entry: &&Entry| {
            lease.is_none_or(|lease| {
                lease.state == LeaseState::Active
                    && entry.lease.as_ref() == Some(&lease.lease_id)
                    && entry.actor == lease.actor_id
            })
        };
        let next = self
            .entries
            .iter()
            .filter(eligible)
            .find(|entry| Some(&entry.actor) != self.last_actor.as_ref())
            .or_else(|| self.entries.iter().find(eligible))
            .map(|entry| entry.id.clone());
        if next.as_ref() != Some(id) {
            return false;
        }
        let position = self
            .entries
            .iter()
            .position(|entry| &entry.id == id)
            .expect("selected entry");
        let entry = self.entries.remove(position).expect("queued entry");
        self.last_actor = Some(entry.actor.clone());
        self.active = Some(entry);
        true
    }
    pub fn remove(&mut self, id: &Id) {
        if let Some(position) = self.entries.iter().position(|entry| &entry.id == id) {
            let entry = self.entries.remove(position).expect("queued entry");
            self.bytes -= entry.bytes;
        }
    }
    pub fn finish(&mut self, id: &Id) {
        if self.active.as_ref().is_some_and(|v| &v.id == id) {
            self.bytes -= self.active.take().expect("active entry").bytes;
        } else {
            self.remove(id);
        }
    }
}
pub(super) struct Turn {
    pub runtime: Arc<Runtime>,
    pub id: Id,
}
impl Drop for Turn {
    fn drop(&mut self) {
        if let Ok(mut queue) = self.runtime.queue.lock() {
            queue.finish(&self.id);
        }
        self.runtime.changed.notify_waiters();
    }
}
