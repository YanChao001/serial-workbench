use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    collections::LinkedList,
    io::Write,
    ops::Range,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

pub(crate) struct Budget {
    limit: usize,
    used: AtomicUsize,
    peak: AtomicUsize,
}
impl Budget {
    pub(crate) fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            limit,
            used: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        })
    }
    pub(crate) fn take(self: &Arc<Self>, bytes: usize) -> HostResult<Lease> {
        let old = self
            .used
            .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|next| *next <= self.limit)
            })
            .map_err(|_| limit())?;
        self.peak.fetch_max(old + bytes, Ordering::Relaxed);
        Ok(Lease {
            budget: self.clone(),
            bytes,
        })
    }
    pub(crate) fn used(&self) -> usize {
        self.used.load(Ordering::Acquire)
    }
    pub(crate) fn peak(&self) -> usize {
        self.peak.load(Ordering::Acquire)
    }
}
pub(crate) struct Lease {
    budget: Arc<Budget>,
    bytes: usize,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
pub(crate) struct Allocation {
    pub(crate) bytes: Arc<[u8]>,
    _local: Lease,
    _global: Lease,
}
pub(crate) struct SourceEvent {
    pub(crate) seq: u64,
    pub(crate) meta: SourceMeta,
    pub(crate) payload: SourcePayload,
    pub(crate) allocation: Arc<Allocation>,
    pub(crate) cost: usize,
}
pub(crate) enum SourcePayload {
    Rx {
        slice: Range<usize>,
        start: u64,
        end: u64,
        message: Option<MessageFragment>,
    },
    Intent {
        operation: Id,
        start: u64,
        end: u64,
    },
    Receipt {
        operation: Id,
        start: u64,
        end: u64,
        settlement: TxSettlement,
    },
    Boundary(SourceBoundary),
}
pub(crate) struct SourceInner {
    pub(crate) identity: HostIdentity,
    pub(crate) key: StreamKey,
    pub(crate) target: Target,
    pub(crate) scope: Id,
    pub(crate) budget: Arc<Budget>,
    pub(crate) global: Arc<Budget>,
    pub(crate) state: Mutex<SourceState>,
    pub(crate) changed: tokio::sync::Notify,
    pub(crate) _metadata: (Lease, Lease),
}
pub(crate) struct SourceState {
    pub(crate) ring: LinkedList<Arc<SourceEvent>>,
    pub(crate) next: u64,
    rx: u64,
    tx: u64,
    pub(crate) closed: bool,
    pub(crate) readers: Vec<std::sync::Weak<super::reader::ReaderInner>>,
}
impl SourceState {
    pub(crate) fn new() -> Self {
        Self {
            ring: LinkedList::new(),
            next: 1,
            rx: 0,
            tx: 0,
            closed: false,
            readers: vec![],
        }
    }
    fn allocation(
        &mut self,
        source: &SourceInner,
        bytes: Arc<[u8]>,
        cost: usize,
    ) -> HostResult<Arc<Allocation>> {
        if cost > source.budget.limit || cost > source.global.limit {
            return Err(limit());
        }
        loop {
            let reserved = source
                .budget
                .take(cost)
                .and_then(|local| source.global.take(cost).map(|global| (local, global)));
            match reserved {
                Ok((local, global)) => {
                    return Ok(Arc::new(Allocation {
                        bytes,
                        _local: local,
                        _global: global,
                    }));
                }
                Err(error) => {
                    let Some(evicted) = self.ring.pop_front() else {
                        return Err(error);
                    };
                    // Unencoded reader projections can retain the entire backing allocation.
                    // Reclaim their prefix with the reader's policy before retrying the source budget.
                    for reader in self.readers.iter().filter_map(|reader| reader.upgrade()) {
                        reader.reclaim_through(evicted.seq);
                    }
                }
            }
        }
    }
    fn ensure_open(&self) -> HostResult<()> {
        if self.closed {
            Err(HostError::new("EPOCH_MISMATCH", "Raw source is closed"))
        } else {
            Ok(())
        }
    }
    fn publish(&mut self, event: Arc<SourceEvent>) {
        self.readers.retain(|reader| {
            if let Some(reader) = reader.upgrade() {
                reader.offer(event.clone());
                reader.is_open()
            } else {
                false
            }
        });
        self.ring.push_back(event);
        self.next += 1;
    }
}
impl StreamSource {
    pub fn reserve_tx_intent(
        &self,
        meta: SourceMeta,
        bytes: Arc<[u8]>,
    ) -> HostResult<PreparedTxIntent> {
        if bytes.is_empty() || bytes.len() > 16384 {
            return Err(limit());
        }
        let metadata = meta_cost(&meta)?;
        let event_cost = bytes.len().checked_add(metadata + 256).ok_or_else(limit)?;
        // Final settlement capacity is owned before durable operation admission.
        let cost = bytes
            .len()
            .checked_mul(64)
            .and_then(|bytes| bytes.checked_add(16384 + metadata))
            .ok_or_else(limit)?;
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        state.ensure_open()?;
        state.tx.checked_add(bytes.len() as u64).ok_or_else(limit)?;
        state.next.checked_add(1).ok_or_else(limit)?;
        let allocation = state.allocation(&self.0, bytes, cost)?;
        Ok(PreparedTxIntent {
            source: self.0.clone(),
            meta,
            allocation,
            event_cost,
        })
    }
    pub fn commit_tx_intent(
        &self,
        prepared: PreparedTxIntent,
        operation_id: Id,
    ) -> HostResult<TxIntentRef> {
        if !Arc::ptr_eq(&self.0, &prepared.source) {
            return Err(invalid());
        }
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        let end = state
            .tx
            .checked_add(prepared.allocation.bytes.len() as u64)
            .ok_or_else(limit)?;
        state.next.checked_add(1).ok_or_else(limit)?;
        // A reserved, durably accepted intent remains audit evidence after close.
        // Publishing it does not reopen the source or authorize backend work.
        let event = Arc::new(SourceEvent {
            seq: state.next,
            meta: prepared.meta,
            payload: SourcePayload::Intent {
                operation: operation_id,
                start: state.tx,
                end,
            },
            allocation: prepared.allocation,
            cost: prepared.event_cost,
        });
        state.tx = end;
        state.publish(event.clone());
        drop(state);
        self.0.changed.notify_waiters();
        Ok(TxIntentRef {
            source: self.0.clone(),
            event,
            completed: Mutex::new(None),
        })
    }
    pub fn initial_cursor(&self) -> Cursor {
        self.cursor(0)
    }
    pub fn cursor(&self, position: u64) -> Cursor {
        Cursor {
            host_id: self.0.identity.host_id.clone(),
            instance_epoch: self.0.identity.instance_epoch,
            scope_id: self.0.scope.clone(),
            position: position.into(),
        }
    }
    pub fn append_rx(
        &self,
        meta: SourceMeta,
        bytes: Arc<[u8]>,
        message: Option<MessageFragment>,
    ) -> HostResult<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let count = bytes.len().div_ceil(16384);
        let metadata = meta_cost(&meta)?
            .checked_add(message.as_ref().map_or(0, |m| {
                256 + m.message_type.capacity() + m.message_id.as_str().len()
            }))
            .ok_or_else(limit)?;
        let cost = bytes
            .len()
            .checked_add(count.checked_mul(metadata).ok_or_else(limit)?)
            .ok_or_else(limit)?;
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        state.ensure_open()?;
        let end = state.rx.checked_add(bytes.len() as u64).ok_or_else(limit)?;
        state.next.checked_add(count as u64).ok_or_else(limit)?;
        if let Some(message) = &message
            && message
                .fragment_offset
                .get()
                .checked_add(bytes.len() as u64)
                .is_none_or(|end| end > message.message_length.get())
        {
            return Err(invalid());
        }
        let allocation = state.allocation(&self.0, bytes, cost)?;
        for start in (0..allocation.bytes.len()).step_by(16384) {
            let stop = (start + 16384).min(allocation.bytes.len());
            let mut fragment = message.clone();
            if let Some(fragment) = &mut fragment {
                fragment.fragment_offset = (fragment.fragment_offset.get() + start as u64).into();
            }
            let event = Arc::new(SourceEvent {
                seq: state.next,
                meta: meta.clone(),
                payload: SourcePayload::Rx {
                    slice: start..stop,
                    start: state.rx + start as u64,
                    end: state.rx + stop as u64,
                    message: fragment,
                },
                allocation: allocation.clone(),
                cost: metadata + stop - start,
            });
            state.publish(event);
        }
        state.rx = end;
        drop(state);
        self.0.changed.notify_waiters();
        Ok(())
    }
    pub fn append_tx_intent(
        &self,
        meta: SourceMeta,
        operation_id: Id,
        bytes: Arc<[u8]>,
    ) -> HostResult<TxIntentRef> {
        let prepared = self.reserve_tx_intent(meta, bytes)?;
        self.commit_tx_intent(prepared, operation_id)
    }
    pub fn complete_tx(
        &self,
        intent: &TxIntentRef,
        meta: SourceMeta,
        settlement: TxSettlement,
    ) -> HostResult<U64> {
        if !Arc::ptr_eq(&self.0, &intent.source) {
            return Err(invalid());
        }
        validate_settlement(&settlement, intent.event.allocation.bytes.len())?;
        if meta_cost(&meta)? > 8192 {
            return Err(limit());
        }
        let mut completed = intent.completed.lock().map_err(|_| busy())?;
        if let Some(event) = &*completed {
            return match &event.payload {
                SourcePayload::Receipt {
                    settlement: old, ..
                } if old == &settlement => Ok(event.seq.into()),
                _ => Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "TX already has a different receipt",
                )),
            };
        }
        let SourcePayload::Intent {
            operation,
            start,
            end,
        } = &intent.event.payload
        else {
            return Err(invalid());
        };
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        state.next.checked_add(1).ok_or_else(limit)?;
        let cost = intent
            .event
            .cost
            .checked_add((settlement.accepted_ranges.len() + settlement.unknown_ranges.len()) * 64)
            .and_then(|cost| cost.checked_add(8192))
            .ok_or_else(limit)?;
        let event = Arc::new(SourceEvent {
            seq: state.next,
            meta,
            payload: SourcePayload::Receipt {
                operation: operation.clone(),
                start: *start,
                end: *end,
                settlement,
            },
            allocation: intent.event.allocation.clone(),
            cost,
        });
        state.publish(event.clone());
        let seq = event.seq.into();
        *completed = Some(event);
        drop(state);
        self.0.changed.notify_waiters();
        Ok(seq)
    }
    pub fn append_boundary(&self, meta: SourceMeta, boundary: SourceBoundary) -> HostResult<U64> {
        let cost = meta_cost(&meta)?
            .checked_add(
                match &boundary {
                    SourceBoundary::Gap(v) => json_len(v, 65536)?,
                    SourceBoundary::Configuration(v) => json_len(v, 65536)?,
                    SourceBoundary::Lifecycle(v) | SourceBoundary::Control(v) => {
                        json_len(v, 65536)?
                    }
                }
                .checked_mul(16)
                .ok_or_else(limit)?,
            )
            .ok_or_else(limit)?;
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        state.ensure_open()?;
        state.next.checked_add(1).ok_or_else(limit)?;
        let allocation = state.allocation(&self.0, Arc::from([]), cost)?;
        let seq = state.next;
        state.publish(Arc::new(SourceEvent {
            seq,
            meta,
            payload: SourcePayload::Boundary(boundary),
            allocation,
            cost,
        }));
        drop(state);
        self.0.changed.notify_waiters();
        Ok(seq.into())
    }
    pub fn close(&self) -> HostResult<()> {
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        state.closed = true;
        for reader in state
            .readers
            .drain(..)
            .filter_map(|reader| reader.upgrade())
        {
            reader.end(Some(HostError::new(
                "EPOCH_MISMATCH",
                "Raw source epoch ended",
            )));
        }
        self.0.changed.notify_waiters();
        Ok(())
    }
    pub fn fail(&self, error: HostError) -> HostResult<()> {
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        if state.closed {
            return Ok(());
        }
        state.closed = true;
        for reader in state
            .readers
            .drain(..)
            .filter_map(|reader| reader.upgrade())
        {
            reader.end(Some(error.clone()));
        }
        self.0.changed.notify_waiters();
        Ok(())
    }
}
impl TxIntentRef {
    pub fn event_seq(&self) -> U64 {
        self.event.seq.into()
    }
    pub fn byte_range(&self) -> ByteRange {
        match self.event.payload {
            SourcePayload::Intent { start, end, .. } => ByteRange {
                start: start.into(),
                end: end.into(),
            },
            _ => unreachable!(),
        }
    }
    pub fn receipt(&self, settlement: &TxSettlement) -> HostResult<TxReceipt> {
        validate_settlement(settlement, self.event.allocation.bytes.len())?;
        let SourcePayload::Intent {
            operation,
            start,
            end,
        } = &self.event.payload
        else {
            return Err(invalid());
        };
        receipt(
            &self.source,
            operation,
            *start,
            *end,
            &self.event.allocation.bytes,
            settlement,
            true,
        )
    }
}
fn receipt(
    source: &SourceInner,
    operation: &Id,
    start: u64,
    end: u64,
    bytes: &[u8],
    settlement: &TxSettlement,
    encode: bool,
) -> HostResult<TxReceipt> {
    Ok(TxReceipt {
        operation_id: operation.clone(),
        session_id: source.key.session_id.clone(),
        session_epoch: source.key.session_epoch,
        outcome: settlement.outcome,
        bytes_base64: encoded(bytes, encode)?,
        byte_start: start.into(),
        byte_end: end.into(),
        accepted_ranges: settlement.accepted_ranges.clone(),
        unknown_ranges: settlement.unknown_ranges.clone(),
        peer_acknowledged: False,
        backend_error: settlement.backend_error.clone(),
    })
}
impl SourceEvent {
    pub(crate) fn wire(&self, source: &SourceInner) -> HostResult<RawEvent> {
        self.wire_impl(source, true)
    }
    pub(crate) fn wire_without_bytes(&self, source: &SourceInner) -> HostResult<(RawEvent, usize)> {
        let bytes = match &self.payload {
            SourcePayload::Rx { slice, .. } => slice.len(),
            SourcePayload::Intent { .. } | SourcePayload::Receipt { .. } => {
                self.allocation.bytes.len()
            }
            _ => 0,
        };
        Ok((self.wire_impl(source, false)?, bytes.div_ceil(3) * 4))
    }
    fn wire_impl(&self, source: &SourceInner, encode: bool) -> HostResult<RawEvent> {
        let payload = match &self.payload {
            SourcePayload::Rx {
                slice,
                start,
                end,
                message,
            } => RawPayload::Rx(RxPayload {
                bytes_base64: encoded(&self.allocation.bytes[slice.clone()], encode)?,
                byte_start: (*start).into(),
                byte_end: (*end).into(),
                message: message.clone(),
            }),
            SourcePayload::Intent {
                operation,
                start,
                end,
            } => RawPayload::TxIntent(TxIntent {
                operation_id: operation.clone(),
                bytes_base64: encoded(&self.allocation.bytes, encode)?,
                byte_start: (*start).into(),
                byte_end: (*end).into(),
            }),
            SourcePayload::Receipt {
                operation,
                start,
                end,
                settlement,
            } => RawPayload::Tx(Box::new(receipt(
                source,
                operation,
                *start,
                *end,
                &self.allocation.bytes,
                settlement,
                encode,
            )?)),
            SourcePayload::Boundary(boundary) => match boundary {
                SourceBoundary::Gap(v) => RawPayload::Gap(v.clone()),
                SourceBoundary::Configuration(v) => RawPayload::ConfigurationBoundary(v.clone()),
                SourceBoundary::Lifecycle(v) => RawPayload::Lifecycle(v.clone()),
                SourceBoundary::Control(v) => RawPayload::Control(v.clone()),
            },
        };
        Ok(RawEvent {
            host_id: source.identity.host_id.clone(),
            instance_epoch: source.identity.instance_epoch,
            session_id: source.key.session_id.clone(),
            session_epoch: source.key.session_epoch,
            event_seq: self.seq.into(),
            configuration_revision: self.meta.configuration_revision,
            time: self.meta.time.clone(),
            payload,
        })
    }
}
fn encoded(bytes: &[u8], encode: bool) -> HostResult<Bytes> {
    if encode {
        Bytes::try_from(STANDARD.encode(bytes).as_str())
    } else {
        Bytes::try_from("")
    }
}
fn validate_settlement(value: &TxSettlement, length: usize) -> HostResult<()> {
    if value.accepted_ranges.len() + value.unknown_ranges.len() > length {
        return Err(limit());
    }
    let mut ranges: Vec<_> = value
        .accepted_ranges
        .iter()
        .chain(&value.unknown_ranges)
        .collect();
    ranges.sort_by_key(|range| range.start.get());
    let mut end = 0;
    for range in ranges {
        if range.start.get() < end || range.start >= range.end || range.end.get() > length as u64 {
            return Err(invalid());
        }
        end = range.end.get();
    }
    let accepted: u64 = value
        .accepted_ranges
        .iter()
        .map(|r| r.end.get() - r.start.get())
        .sum();
    match value.outcome {
        TxOutcome::Accepted if accepted != length as u64 || !value.unknown_ranges.is_empty() => {
            return Err(invalid());
        }
        TxOutcome::Rejected if accepted != 0 || !value.unknown_ranges.is_empty() => {
            return Err(invalid());
        }
        TxOutcome::Partial
            if accepted == 0 || accepted == length as u64 || !value.unknown_ranges.is_empty() =>
        {
            return Err(invalid());
        }
        TxOutcome::Unknown if value.unknown_ranges.is_empty() => return Err(invalid()),
        _ => {}
    }
    if let Some(error) = &value.backend_error {
        json_len(error, 4096)?;
    }
    Ok(())
}
fn meta_cost(meta: &SourceMeta) -> HostResult<usize> {
    Ok(1024 + json_len(&meta.time, 65536)? * 4)
}
pub(crate) fn json_len(value: &impl Serialize, max: usize) -> HostResult<usize> {
    struct Counter {
        length: usize,
        max: usize,
    }
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() > self.max.saturating_sub(self.length) {
                return Err(std::io::Error::other("raw limit"));
            }
            self.length += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter { length: 0, max };
    serde_json::to_writer(&mut counter, value).map_err(|_| limit())?;
    Ok(counter.length)
}
