use super::*;
use std::collections::LinkedList;

pub(crate) struct CreditBook {
    initial: Cursor,
    ack: Cursor,
    sent: Cursor,
    grant: u64,
    sent_bytes: u64,
    acknowledged: u64,
    window: u64,
    boundaries: LinkedList<(Cursor, u64)>,
}
impl CreditBook {
    pub(crate) fn new(after: Cursor, window: u64, initial: u64) -> HostResult<Self> {
        if initial > window || window == 0 {
            return Err(invalid());
        }
        Ok(Self {
            initial: after.clone(),
            ack: after.clone(),
            sent: after,
            grant: initial,
            sent_bytes: 0,
            acknowledged: 0,
            window,
            boundaries: LinkedList::new(),
        })
    }
    pub(crate) fn previous(&self) -> Cursor {
        self.sent.clone()
    }
    pub(crate) fn available(&self) -> u64 {
        self.grant - self.sent_bytes
    }
    pub(crate) fn sent(&mut self, cursor: Cursor, bytes: u64) -> HostResult<()> {
        if cursor == self.sent {
            return Ok(());
        }
        if !same_scope(&self.initial, &cursor)
            || cursor.position <= self.sent.position
            || bytes > self.available()
        {
            return Err(invalid());
        }
        self.sent_bytes = self.sent_bytes.checked_add(bytes).ok_or_else(limit)?;
        self.sent = cursor.clone();
        self.boundaries.push_back((cursor, self.sent_bytes));
        Ok(())
    }
    pub(crate) fn grant(&mut self, cursor: &Cursor, total: u64) -> HostResult<StreamCreditResult> {
        if !same_scope(&self.initial, cursor)
            || cursor.position < self.ack.position
            || cursor.position > self.sent.position
            || total < self.grant
        {
            return Err(invalid());
        }
        let acknowledged = if cursor == &self.ack {
            self.acknowledged
        } else if cursor == &self.initial {
            0
        } else {
            self.boundaries
                .iter()
                .find(|(boundary, _)| boundary == cursor)
                .map(|(_, bytes)| *bytes)
                .ok_or_else(invalid)?
        };
        if total < acknowledged || total - acknowledged > self.window {
            return Err(invalid());
        }
        self.ack = cursor.clone();
        self.acknowledged = acknowledged;
        self.grant = total;
        while self
            .boundaries
            .front()
            .is_some_and(|(c, _)| c.position <= cursor.position)
        {
            self.boundaries.pop_front();
        }
        Ok(StreamCreditResult {
            ack_cursor: self.ack.clone(),
            granted_bytes_total: self.grant.into(),
            sent_bytes_total: self.sent_bytes.into(),
            acknowledged_bytes_total: self.acknowledged.into(),
        })
    }
    pub(crate) fn clear(&mut self) {
        self.boundaries.clear();
    }
}
fn same_scope(left: &Cursor, right: &Cursor) -> bool {
    left.host_id == right.host_id
        && left.instance_epoch == right.instance_epoch
        && left.scope_id == right.scope_id
}
