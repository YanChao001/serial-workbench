use super::credit::CreditBook;
use super::ring::{Lease, SourcePayload, json_len};
use super::*;
use crate::auth::GrantStamp;
use std::{collections::LinkedList, sync::Weak};

#[derive(Clone)]
pub struct RawSubscription(pub(crate) Arc<ReaderInner>);
pub struct PreparedRawBatch {
    frame: WireFrame,
    bytes: usize,
    _lease: Lease,
    reservation: Arc<ReaderReservation>,
    pub(crate) stamp: Option<GrantStamp>,
    liveness: tokio::sync::watch::Receiver<bool>,
    reader: Weak<ReaderInner>,
}
struct ReaderReservation {
    _metadata: Lease,
    _global: Lease,
    budget: Arc<Budget>,
}
pub(crate) struct ReaderInner {
    id: Id,
    request_id: RequestId,
    source: Arc<SourceInner>,
    actor: AuthenticatedActor,
    auth: AuthService,
    stamp: Option<GrantStamp>,
    policy: OverflowPolicy,
    queue_limit: usize,
    batch_limit: usize,
    budget: Arc<Budget>,
    state: Mutex<ReaderState>,
    notify: tokio::sync::Notify,
    ended: Arc<tokio::sync::Notify>,
}
struct ReaderState {
    queue: LinkedList<Queued>,
    logical: usize,
    pending: Option<Arc<PreparedRawBatch>>,
    queued: bool,
    replay: LinkedList<Arc<PreparedRawBatch>>,
    credit: CreditBook,
    closed: bool,
    error: Option<HostError>,
    reservation: Option<Arc<ReaderReservation>>,
    liveness: tokio::sync::watch::Sender<bool>,
}
struct Queued {
    item: Item,
    cost: usize,
    _lease: Lease,
}
enum Item {
    Source(Arc<SourceEvent>),
    Gap(ReaderGap),
}
impl PreparedRawBatch {
    pub(crate) fn mark_written(self: &Arc<Self>) -> HostResult<()> {
        let Some(reader) = self.reader.upgrade() else {
            return Ok(());
        };
        let mut state = reader.state.lock().map_err(|_| busy())?;
        // A replay may finish after the first copy was acknowledged and released.
        if !state.closed && state.credit.previous().position < self.batch().cursor.position {
            commit_sent(&mut state, self)?;
        }
        drop(state);
        reader.notify.notify_waiters();
        Ok(())
    }
    pub(crate) fn delivery_liveness(&self) -> tokio::sync::watch::Receiver<bool> {
        self.liveness.clone()
    }
    pub fn batch(&self) -> &RawBatch {
        match &self.frame.body {
            IpcMessage::RawBatch { batch } => batch,
            _ => unreachable!(),
        }
    }
    pub(crate) fn frame(&self) -> &WireFrame {
        &self.frame
    }
    pub(crate) fn queue_lease(&self) -> HostResult<RawMemoryLease> {
        self.reservation.budget.take(1024)
    }
    pub(crate) fn encoding_lease(&self) -> HostResult<RawMemoryLease> {
        let bytes = serial_workbench_ipc::frame::encoded_length(&self.frame, 1024 * 1024)?;
        self.reservation.budget.take(
            bytes
                .checked_mul(2)
                .and_then(|v| v.checked_add(256))
                .ok_or_else(limit)?,
        )
    }
}
impl ReaderState {
    fn discard_front(&mut self, source: &SourceInner, missing: &mut Option<ReaderGap>) -> bool {
        let Some(old) = self.queue.pop_front() else {
            return false;
        };
        self.logical -= old.cost;
        let gap = match old.item {
            Item::Gap(gap) => gap,
            Item::Source(old) => gap_for(source, &old),
        };
        merge_gap(missing, gap);
        true
    }
    fn prepend_gap(&mut self, budget: &Arc<Budget>, gap: ReaderGap) -> HostResult<()> {
        let lease = budget.take(1024)?;
        self.logical += 1024;
        self.queue.push_front(Queued {
            item: Item::Gap(gap),
            cost: 1024,
            _lease: lease,
        });
        Ok(())
    }
    fn end(&mut self, error: Option<HostError>) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.liveness.send_replace(false);
        self.error = error;
        self.queue.clear();
        self.logical = 0;
        self.pending = None;
        self.queued = false;
        self.replay.clear();
        self.credit.clear();
        self.reservation = None;
    }
}
impl ReaderInner {
    pub(crate) fn reclaim_through(&self, seq: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed
            || !state
                .queue
                .iter()
                .any(|queued| matches!(&queued.item, Item::Source(event) if event.seq <= seq))
        {
            return;
        }
        if self.policy != OverflowPolicy::DropWithGap {
            state.end(Some(overflow()));
        } else {
            let mut missing = None;
            while state
                .queue
                .front()
                .is_some_and(|queued| match &queued.item {
                    Item::Source(event) => event.seq <= seq,
                    Item::Gap(_) => true,
                })
            {
                state.discard_front(&self.source, &mut missing);
            }
            if let Some(gap) = missing
                && state.prepend_gap(&self.budget, gap).is_err()
            {
                state.end(Some(overflow()));
            }
        }
        let ended = state.closed;
        drop(state);
        self.notify.notify_waiters();
        if ended {
            self.ended.notify_waiters();
        }
    }
    pub(crate) fn is_open(&self) -> bool {
        self.state
            .lock()
            .map(|state| !state.closed)
            .unwrap_or(false)
    }
    pub(crate) fn offer(&self, event: Arc<SourceEvent>) {
        if let Ok(mut state) = self.state.lock() {
            if state.closed {
                return;
            }
            let cost = event.cost;
            let mut missing: Option<ReaderGap> = None;
            while state
                .logical
                .saturating_add(cost)
                .saturating_add(if missing.is_some() { 1024 } else { 0 })
                > self.queue_limit
            {
                if self.policy != OverflowPolicy::DropWithGap {
                    state.end(Some(overflow()));
                    self.notify.notify_waiters();
                    self.ended.notify_waiters();
                    return;
                }
                if !state.discard_front(&self.source, &mut missing) {
                    state.end(Some(overflow()));
                    self.notify.notify_waiters();
                    self.ended.notify_waiters();
                    return;
                }
            }
            if let Some(gap) = missing
                && state.prepend_gap(&self.budget, gap).is_err()
            {
                state.end(Some(overflow()));
                self.notify.notify_waiters();
                self.ended.notify_waiters();
                return;
            }
            match self.budget.take(1024) {
                Ok(lease) => {
                    state.logical += cost;
                    state.queue.push_back(Queued {
                        item: Item::Source(event),
                        cost,
                        _lease: lease,
                    })
                }
                Err(_) => {
                    state.end(Some(overflow()));
                    self.ended.notify_waiters();
                }
            }
        }
        self.notify.notify_waiters();
    }
    pub(crate) fn end(&self, error: Option<HostError>) {
        if let Ok(mut state) = self.state.lock() {
            state.end(error)
        }
        self.notify.notify_waiters();
        self.ended.notify_waiters();
    }
    async fn authorize(&self) -> HostResult<()> {
        let auth = self.auth.clone();
        let actor = self.actor.clone();
        let target = self.source.target.clone();
        let stamp = self.stamp.clone();
        let result = tokio::task::spawn_blocking(move || {
            if let Some(stamp) = stamp {
                auth.validate_grants(&stamp)?;
            }
            auth.require(&actor, "content.read", &target)
        })
        .await
        .map_err(|_| busy())?;
        if let Err(error) = &result {
            self.end(Some(error.clone()));
        }
        result
    }
}
impl RawSubscription {
    pub fn id(&self) -> &Id {
        &self.0.id
    }
    pub fn target(&self) -> &Target {
        &self.0.source.target
    }
    pub fn close(&self) {
        self.0.end(None);
    }
    pub async fn try_next(&self) -> HostResult<Option<Arc<PreparedRawBatch>>> {
        self.0.authorize().await?;
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        if let Some(error) = &state.error {
            return Err(error.clone());
        }
        if state.closed {
            return Ok(None);
        }
        if let Some(batch) = &state.pending {
            return Ok((!state.queued).then(|| batch.clone()));
        }
        if state.credit.available() == 0 {
            return Ok(None);
        }
        let Some(front) = state.queue.front() else {
            return Ok(None);
        };
        let reserve = front
            .cost
            .checked_mul(4)
            .and_then(|v| v.checked_add(8192))
            .ok_or_else(limit)?;
        let lease = match self.0.budget.take(reserve) {
            Ok(lease) => lease,
            Err(error) => {
                state.end(Some(error.clone()));
                self.0.ended.notify_waiters();
                return Err(error);
            }
        };
        let (item, position, payload_length) = match &front.item {
            Item::Source(event) => {
                let (wire, length) = event.wire_without_bytes(&self.0.source)?;
                (
                    StreamItem::Source {
                        event: Box::new(wire),
                    },
                    event.seq,
                    length,
                )
            }
            Item::Gap(gap) => (
                StreamItem::ReaderGap { gap: gap.clone() },
                gap.missing_event_range.end.get() - 1,
                0,
            ),
        };
        let batch = RawBatch {
            subscription_id: self.0.id.clone(),
            cursor: Cursor {
                position: position.into(),
                ..state.credit.previous()
            },
            previous_cursor: state.credit.previous(),
            items: vec![item],
        };
        let length = match json_len(&batch, self.0.batch_limit) {
            Ok(length) => length,
            Err(error) => {
                state.end(Some(error.clone()));
                self.0.ended.notify_waiters();
                return Err(error);
            }
        }
        .checked_add(payload_length)
        .ok_or_else(limit)?;
        if length > self.0.batch_limit || length > self.0.queue_limit {
            let error = limit();
            state.end(Some(error.clone()));
            self.0.ended.notify_waiters();
            return Err(error);
        }
        if length as u64 > state.credit.available() {
            return Ok(None);
        }
        let mut batch = batch;
        if let Item::Source(event) = &front.item {
            batch.items[0] = StreamItem::Source {
                event: Box::new(event.wire(&self.0.source)?),
            };
        }
        let frame = WireFrame {
            request_id: self.0.request_id.clone(),
            channel: IpcChannel::Raw,
            body: IpcMessage::RawBatch {
                batch: Box::new(batch),
            },
        };
        let prepared = Arc::new(PreparedRawBatch {
            frame,
            bytes: length,
            _lease: lease,
            reservation: state.reservation.as_ref().ok_or_else(busy)?.clone(),
            stamp: self.0.stamp.clone(),
            liveness: state.liveness.subscribe(),
            reader: Arc::downgrade(&self.0),
        });
        let popped = state.queue.pop_front().ok_or_else(busy)?;
        state.logical -= popped.cost;
        state.pending = Some(prepared.clone());
        Ok(Some(prepared))
    }
    pub async fn next(&self) -> HostResult<Option<Arc<PreparedRawBatch>>> {
        loop {
            let notified = self.0.notify.notified();
            if let Some(batch) = self.try_next().await? {
                return Ok(Some(batch));
            }
            if self.0.state.lock().map_err(|_| busy())?.closed {
                return Ok(None);
            }
            notified.await;
        }
    }
    pub fn mark_sent(&self, batch: &Arc<PreparedRawBatch>) -> HostResult<()> {
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        commit_sent(&mut state, batch)?;
        drop(state);
        self.0.notify.notify_waiters();
        Ok(())
    }
    pub fn replay(&self, cursor: &Cursor) -> HostResult<Arc<PreparedRawBatch>> {
        self.0
            .state
            .lock()
            .map_err(|_| busy())?
            .replay
            .iter()
            .find(|batch| &batch.batch().cursor == cursor)
            .cloned()
            .ok_or_else(invalid)
    }
    pub fn deliver(
        &self,
        context: &crate::ipc::ConnectionContext,
        batch: &Arc<PreparedRawBatch>,
    ) -> HostResult<()> {
        let mut state = self.0.state.lock().map_err(|_| busy())?;
        if state.closed {
            return Err(state.error.clone().unwrap_or_else(invalid));
        }
        let replay = state.replay.iter().any(|sent| Arc::ptr_eq(sent, batch));
        if !state
            .pending
            .as_ref()
            .is_some_and(|pending| Arc::ptr_eq(pending, batch))
            && !replay
        {
            return Err(invalid());
        }
        if !replay && state.queued {
            return Ok(());
        }
        context.emit_raw(batch.clone(), self.target().clone())?;
        if !replay {
            state.queued = true;
        }
        Ok(())
    }
}
fn commit_sent(state: &mut ReaderState, batch: &Arc<PreparedRawBatch>) -> HostResult<()> {
    if state.closed {
        return Err(state.error.clone().unwrap_or_else(invalid));
    }
    if state.replay.iter().any(|sent| Arc::ptr_eq(sent, batch)) {
        return Ok(());
    }
    if !state
        .pending
        .as_ref()
        .is_some_and(|pending| Arc::ptr_eq(pending, batch))
    {
        return Err(invalid());
    }
    state
        .credit
        .sent(batch.batch().cursor.clone(), batch.bytes as u64)?;
    state.replay.push_back(batch.clone());
    state.pending = None;
    state.queued = false;
    Ok(())
}
impl StreamHub {
    pub async fn subscribe(
        &self,
        actor: &AuthenticatedActor,
        params: StreamSubscribeParams,
    ) -> HostResult<RawSubscription> {
        let queue = usize::try_from(params.queue_bytes.get()).map_err(|_| invalid())?;
        if queue == 0
            || queue > self.inner.limits.reader_bytes
            || params.initial_credit_bytes.get() > queue as u64
        {
            return Err(invalid());
        }
        if params.overflow_policy == OverflowPolicy::FlowControl {
            return Err(HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "Backend flow control requires explicit support and permission",
            ));
        }
        let source = self
            .inner
            .sources
            .lock()
            .map_err(|_| busy())?
            .get(&params.scope_id)
            .cloned()
            .ok_or_else(invalid)?;
        if params.after.host_id != source.identity.host_id
            || params.after.instance_epoch != source.identity.instance_epoch
            || params.after.scope_id != source.scope
        {
            return Err(invalid());
        }
        let changes = self.inner.auth.subscribe_changes();
        let auth = self.inner.auth.clone();
        let check_actor = actor.clone();
        let target = source.target.clone();
        let stamp = tokio::task::spawn_blocking(move || {
            let stamp = auth.capture_grants(&check_actor)?;
            auth.require(&check_actor, "content.read", &target)?;
            if let Some(stamp) = &stamp {
                auth.validate_grants(stamp)?;
            }
            Ok::<_, HostError>(stamp)
        })
        .await
        .map_err(|_| busy())??;
        let mut readers = self.inner.readers.lock().map_err(|_| busy())?;
        readers.retain(|_, reader| {
            reader.upgrade().is_some_and(|reader| {
                reader
                    .state
                    .lock()
                    .map(|state| !state.closed)
                    .unwrap_or(false)
            })
        });
        if readers.len() >= self.inner.limits.max_readers {
            return Err(limit());
        }
        let global = self.inner.reader_budget.take(queue)?;
        let budget = Budget::new(queue);
        let reservation = Arc::new(ReaderReservation {
            _metadata: budget.take(4096)?,
            _global: global,
            budget: budget.clone(),
        });
        let id = Id::try_from(uuid::Uuid::new_v4().to_string().as_str())?;
        let reader = Arc::new(ReaderInner {
            id: id.clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
            source: source.clone(),
            actor: actor.clone(),
            auth: self.inner.auth.clone(),
            stamp,
            policy: params.overflow_policy,
            queue_limit: queue,
            batch_limit: self.inner.limits.batch_bytes,
            budget,
            state: Mutex::new(ReaderState {
                queue: LinkedList::new(),
                logical: 0,
                pending: None,
                queued: false,
                replay: LinkedList::new(),
                credit: CreditBook::new(
                    params.after.clone(),
                    queue as u64,
                    params.initial_credit_bytes.get(),
                )?,
                closed: false,
                error: None,
                reservation: Some(reservation),
                liveness: tokio::sync::watch::channel(true).0,
            }),
            notify: tokio::sync::Notify::new(),
            ended: Arc::new(tokio::sync::Notify::new()),
        });
        let mut state = source.state.lock().map_err(|_| busy())?;
        if state.closed {
            return Err(HostError::new("EPOCH_MISMATCH", "Raw source is closed"));
        }
        let oldest = state.ring.front().map_or(state.next, |event| event.seq);
        let start = params
            .after
            .position
            .get()
            .checked_add(1)
            .ok_or_else(invalid)?;
        if start < oldest {
            return Err(expired(&source, oldest));
        }
        if start > state.next {
            return Err(invalid());
        }
        for event in state.ring.iter().filter(|event| event.seq >= start) {
            reader.offer(event.clone());
        }
        state
            .readers
            .retain(|reader| reader.upgrade().is_some_and(|reader| reader.is_open()));
        state.readers.push(Arc::downgrade(&reader));
        readers.insert(id, Arc::downgrade(&reader));
        drop(state);
        drop(readers);
        monitor(Arc::downgrade(&reader), changes);
        Ok(RawSubscription(reader))
    }
    pub async fn credit(
        &self,
        actor: &AuthenticatedActor,
        params: StreamCreditParams,
    ) -> HostResult<StreamCreditResult> {
        let reader = self
            .inner
            .readers
            .lock()
            .map_err(|_| busy())?
            .get(&params.subscription_id)
            .and_then(Weak::upgrade)
            .ok_or_else(invalid)?;
        if actor.id() != reader.actor.id() || actor.client_id() != reader.actor.client_id() {
            return Err(HostError::new(
                "PERMISSION_DENIED",
                "Reader belongs to another actor",
            ));
        }
        reader.authorize().await?;
        let mut state = reader.state.lock().map_err(|_| busy())?;
        if state.closed {
            return Err(state.error.clone().unwrap_or_else(invalid));
        }
        let result = state
            .credit
            .grant(&params.ack_cursor, params.granted_bytes_total.get())?;
        while state
            .replay
            .front()
            .is_some_and(|batch| batch.batch().cursor.position <= params.ack_cursor.position)
        {
            state.replay.pop_front();
        }
        drop(state);
        reader.notify.notify_waiters();
        Ok(result)
    }
}
fn monitor(reader: Weak<ReaderInner>, mut changes: tokio::sync::watch::Receiver<U64>) {
    tokio::spawn(async move {
        loop {
            let Some(current) = reader.upgrade() else {
                return;
            };
            if current.state.lock().map(|s| s.closed).unwrap_or(true) {
                return;
            }
            let auth = current.auth.clone();
            let stamp = current.stamp.clone();
            let ended = current.ended.clone();
            let closed = ended.notified();
            drop(current);
            tokio::select! {
                value=changes.changed()=>{if value.is_err(){return}},
                _=closed=>{return},
                _=auth.wait_grant_expiry(stamp.as_ref())=>{},
            }
            let Some(current) = reader.upgrade() else {
                return;
            };
            if current.authorize().await.is_err() {
                return;
            }
        }
    });
}
impl Drop for ReaderInner {
    fn drop(&mut self) {
        if let Ok(state) = self.state.get_mut() {
            state.liveness.send_replace(false);
        }
        self.ended.notify_waiters();
    }
}
fn gap_for(source: &SourceInner, event: &SourceEvent) -> ReaderGap {
    let range = match &event.payload {
        SourcePayload::Rx { start, end, .. } => Some(DirectionalRange {
            direction: Direction::Rx,
            start: (*start).into(),
            end: (*end).into(),
        }),
        SourcePayload::Intent { start, end, .. } => Some(DirectionalRange {
            direction: Direction::Tx,
            start: (*start).into(),
            end: (*end).into(),
        }),
        _ => None,
    };
    ReaderGap {
        host_id: source.identity.host_id.clone(),
        instance_epoch: source.identity.instance_epoch,
        session_id: source.key.session_id.clone(),
        session_epoch: source.key.session_epoch,
        reason: ReaderGapReason::ReaderOverflow,
        missing_event_range: ByteRange {
            start: event.seq.into(),
            end: (event.seq + 1).into(),
        },
        missing_byte_ranges: Some(range.into_iter().collect()),
    }
}
fn merge_gap(current: &mut Option<ReaderGap>, next: ReaderGap) {
    if let Some(gap) = current {
        gap.missing_event_range.end = next.missing_event_range.end;
        match (&mut gap.missing_byte_ranges, next.missing_byte_ranges) {
            (Some(ranges), Some(next)) => {
                for range in next {
                    if let Some(old) = ranges
                        .iter_mut()
                        .find(|old| old.direction == range.direction)
                    {
                        old.end = range.end;
                    } else {
                        ranges.push(range)
                    }
                }
            }
            _ => gap.missing_byte_ranges = None,
        }
    } else {
        *current = Some(next)
    }
}
fn overflow() -> HostError {
    HostError::new("READER_OVERFLOW", "Raw reader exceeded its queue budget")
}
