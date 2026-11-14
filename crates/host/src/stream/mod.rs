//! 原始源序号与独立 reader 的唯一拥有者；wire 编码只发生消费边界。
use crate::auth::{AuthService, AuthenticatedActor, HostIdentity};
use serial_workbench_core::*;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
mod credit;
mod reader;
mod ring;
pub use reader::{PreparedRawBatch, RawSubscription};
pub(crate) use ring::Lease as RawMemoryLease;
use ring::{Budget, SourceEvent, SourceInner, SourceState};

#[derive(Clone)]
pub struct StreamHub {
    inner: Arc<HubInner>,
}
struct HubInner {
    identity: HostIdentity,
    auth: AuthService,
    limits: StreamLimits,
    sources: Mutex<HashMap<Id, Arc<SourceInner>>>,
    source_budget: Arc<Budget>,
    reader_budget: Arc<Budget>,
    readers: Mutex<HashMap<Id, std::sync::Weak<reader::ReaderInner>>>,
}
#[derive(Clone)]
pub struct StreamSource(Arc<SourceInner>);
pub struct PreparedTxIntent {
    source: Arc<SourceInner>,
    meta: SourceMeta,
    allocation: Arc<ring::Allocation>,
    event_cost: usize,
}
pub struct TxIntentRef {
    source: Arc<SourceInner>,
    event: Arc<SourceEvent>,
    completed: Mutex<Option<Arc<SourceEvent>>>,
}
impl TxIntentRef {
    pub(crate) fn write_payload(&self) -> WritePayload {
        WritePayload::retained(
            self.event.allocation.bytes.clone(),
            self.event.allocation.clone(),
        )
    }
}
#[derive(Clone)]
pub struct SourceMeta {
    pub configuration_revision: U64,
    pub time: EventTime,
}
pub struct StreamKey {
    pub session_id: Id,
    pub session_epoch: U64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct TxSettlement {
    pub outcome: TxOutcome,
    pub accepted_ranges: Vec<ByteRange>,
    pub unknown_ranges: Vec<ByteRange>,
    pub backend_error: Option<HostError>,
}
pub enum SourceBoundary {
    Gap(SourceGap),
    Configuration(ConfigurationBoundary),
    Lifecycle(JsonObject),
    Control(JsonObject),
}
#[derive(Clone, Copy)]
pub struct StreamLimits {
    pub source_bytes: usize,
    pub total_source_bytes: usize,
    pub reader_bytes: usize,
    pub total_reader_bytes: usize,
    pub max_readers: usize,
    pub batch_bytes: usize,
}
impl Default for StreamLimits {
    fn default() -> Self {
        Self {
            source_bytes: 16 * 1024 * 1024,
            total_source_bytes: 128 * 1024 * 1024,
            reader_bytes: 4 * 1024 * 1024,
            total_reader_bytes: 128 * 1024 * 1024,
            max_readers: 64,
            batch_bytes: 256 * 1024,
        }
    }
}
impl StreamHub {
    /// 录制从当前已提交前缀之后订阅；寻址必须包含精确会话代次。
    pub(crate) fn current_cursor(&self, target: &Target) -> HostResult<Cursor> {
        target.validate()?;
        if target.host_id != self.inner.identity.host_id || target.kind.as_str() != "session" {
            return Err(invalid());
        }
        let sources = self.inner.sources.lock().map_err(|_| busy())?;
        let source = sources
            .values()
            .find(|source| source.target == *target)
            .ok_or_else(|| {
                HostError::new("EPOCH_MISMATCH", "Raw session epoch is not available")
            })?;
        let state = source.state.lock().map_err(|_| busy())?;
        if state.closed {
            return Err(HostError::new(
                "BACKEND_DISCONNECTED",
                "Raw source is closed",
            ));
        }
        Ok(Cursor {
            host_id: self.inner.identity.host_id.clone(),
            instance_epoch: self.inner.identity.instance_epoch,
            scope_id: source.scope.clone(),
            position: state.next.saturating_sub(1).into(),
        })
    }
    pub fn new(identity: HostIdentity, auth: AuthService, limits: StreamLimits) -> Self {
        Self {
            inner: Arc::new(HubInner {
                identity,
                auth,
                limits,
                sources: Mutex::new(HashMap::new()),
                source_budget: Budget::new(limits.total_source_bytes),
                reader_budget: Budget::new(limits.total_reader_bytes),
                readers: Mutex::new(HashMap::new()),
            }),
        }
    }
    pub fn register_source(&self, key: StreamKey, target: Target) -> HostResult<StreamSource> {
        if target.host_id != self.inner.identity.host_id
            || target.kind.as_str() != "session"
            || target.id != key.session_id
            || target.session_id.as_ref() != Some(&key.session_id)
            || target.session_epoch != Some(key.session_epoch)
        {
            return Err(invalid());
        }
        let scope = Id::try_from(format!("raw:{}:{}", key.session_id, key.session_epoch).as_str())?;
        let mut sources = self.inner.sources.lock().map_err(|_| busy())?;
        sources.retain(|_, source| {
            !source
                .state
                .lock()
                .map(|state| state.closed)
                .unwrap_or(false)
        });
        if sources.values().any(|source| {
            source.key.session_id == key.session_id
                && !source
                    .state
                    .lock()
                    .map(|state| state.closed)
                    .unwrap_or(false)
        }) {
            return Err(HostError::new(
                "REQUEST_CONFLICT",
                "Session already has a raw source",
            ));
        }
        if sources.len() >= 16 {
            return Err(limit());
        }
        let budget = Budget::new(self.inner.limits.source_bytes);
        let metadata = (budget.take(4096)?, self.inner.source_budget.take(4096)?);
        let source = Arc::new(SourceInner {
            _metadata: metadata,
            identity: self.inner.identity.clone(),
            key,
            target,
            scope: scope.clone(),
            budget,
            global: self.inner.source_budget.clone(),
            state: Mutex::new(SourceState::new()),
            changed: tokio::sync::Notify::new(),
        });
        sources.insert(scope, source.clone());
        Ok(StreamSource(source))
    }
    async fn read(
        &self,
        actor: &AuthenticatedActor,
        params: StreamReadParams,
        output_bytes: usize,
    ) -> HostResult<StreamReadResult> {
        if params.start_event_seq.get() == 0
            || params.max_events.get() == 0
            || params.max_events.get() > 100
            || params.max_bytes.get() == 0
            || params.max_bytes.get() > self.inner.limits.batch_bytes as u64
        {
            return Err(invalid());
        }
        let source = self
            .inner
            .sources
            .lock()
            .map_err(|_| busy())?
            .values()
            .find(|s| {
                s.key.session_id == params.session_id && s.key.session_epoch == params.session_epoch
            })
            .cloned()
            .ok_or_else(|| {
                HostError::new("EPOCH_MISMATCH", "Raw session epoch is not available")
            })?;
        let auth = self.inner.auth.clone();
        let actor = actor.clone();
        let target = source.target.clone();
        let stamp = tokio::task::spawn_blocking(move || {
            let authorization = auth.snapshot(&actor)?;
            let stamp = authorization.capture_grants();
            authorization.require("content.read", &target)?;
            Ok::<_, HostError>(stamp)
        })
        .await
        .map_err(|_| busy())??;
        let (events, source_next) = {
            let state = source.state.lock().map_err(|_| busy())?;
            let oldest = state.ring.front().map_or(state.next, |event| event.seq);
            if params.start_event_seq.get() < oldest {
                return Err(expired(&source, oldest));
            }
            if params.start_event_seq.get() > state.next {
                return Err(invalid());
            }
            let events = state
                .ring
                .iter()
                .filter(|e| e.seq >= params.start_event_seq.get())
                .take(params.max_events.get() as usize)
                .cloned()
                .collect::<Vec<_>>();
            (events, state.next)
        };
        // 编码和计量不占用接收源锁；候选引用继续持有源环的真实预算。
        let mut result = StreamReadResult {
            events: vec![],
            next_event_seq: params.start_event_seq,
            has_more: params.start_event_seq.get() < source_next,
        };
        let mut content_bytes = 0usize;
        for event in events {
            let candidate_bytes = event
                .cost
                .checked_mul(4)
                .and_then(|bytes| bytes.checked_add(8192))
                .ok_or_else(limit)?;
            if output_bytes
                .checked_add(candidate_bytes)
                .is_none_or(|bytes| bytes > self.inner.limits.reader_bytes)
            {
                if result.events.is_empty() {
                    return Err(limit());
                }
                break;
            }
            let _candidate = self.inner.reader_budget.take(candidate_bytes)?;
            let wire = event.wire(&source)?;
            let wire_bytes = match ring::json_len(&wire, params.max_bytes.get() as usize) {
                Ok(bytes) => bytes,
                Err(_) if result.events.is_empty() => return Err(limit()),
                Err(_) => break,
            };
            let header = StreamReadResult {
                events: vec![],
                next_event_seq: (event.seq + 1).into(),
                has_more: event.seq + 1 < source_next,
            };
            let next_content_bytes = content_bytes
                .checked_add(wire_bytes)
                .and_then(|bytes| bytes.checked_add(usize::from(!result.events.is_empty())))
                .ok_or_else(limit)?;
            let fits = ring::json_len(&header, params.max_bytes.get() as usize)
                .ok()
                .and_then(|bytes| bytes.checked_add(next_content_bytes))
                .is_some_and(|bytes| bytes <= params.max_bytes.get() as usize);
            if !fits {
                if result.events.is_empty() {
                    return Err(limit());
                }
                break;
            }
            content_bytes = next_content_bytes;
            result.next_event_seq = header.next_event_seq;
            result.has_more = header.has_more;
            result.events.push(wire);
        }
        if let Some(stamp) = stamp {
            let auth = self.inner.auth.clone();
            tokio::task::spawn_blocking(move || auth.validate_grants(&stamp))
                .await
                .map_err(|_| busy())??;
        }
        Ok(result)
    }
    pub fn memory_usage(&self) -> StreamMemory {
        StreamMemory {
            source_limit: self.inner.limits.total_source_bytes,
            reader_limit: self.inner.limits.total_reader_bytes,
            source_bytes: self.inner.source_budget.used(),
            source_peak: self.inner.source_budget.peak(),
            reader_bytes: self.inner.reader_budget.used(),
            reader_peak: self.inner.reader_budget.peak(),
        }
    }
}
#[derive(Debug)]
pub struct StreamMemory {
    pub source_limit: usize,
    pub reader_limit: usize,
    pub source_bytes: usize,
    pub source_peak: usize,
    pub reader_bytes: usize,
    pub reader_peak: usize,
}
pub struct RawOutputLease {
    _lease: ring::Lease,
}
pub struct PreparedStreamRead {
    result: StreamReadResult,
    lease: RawOutputLease,
}
impl PreparedStreamRead {
    pub fn into_parts(self) -> (StreamReadResult, RawOutputLease) {
        (self.result, self.lease)
    }
}
impl StreamHub {
    pub async fn read_prepared(
        &self,
        actor: &AuthenticatedActor,
        params: StreamReadParams,
    ) -> HostResult<PreparedStreamRead> {
        if params.max_bytes.get() == 0
            || params.max_bytes.get() > self.inner.limits.batch_bytes as u64
        {
            return Err(invalid());
        }
        // 同一租约覆盖 DTO、一次边界候选与 writer 的有界编码暂存。
        let bytes = (params.max_bytes.get() as usize)
            .checked_mul(6)
            .and_then(|v| v.checked_add(16384))
            .ok_or_else(limit)?;
        if bytes > self.inner.limits.reader_bytes {
            return Err(limit());
        }
        let lease = RawOutputLease {
            _lease: self.inner.reader_budget.take(bytes)?,
        };
        let result = self.read(actor, params, bytes).await?;
        Ok(PreparedStreamRead { result, lease })
    }
}
fn expired(source: &SourceInner, oldest: u64) -> HostError {
    let cursor = Cursor {
        host_id: source.identity.host_id.clone(),
        instance_epoch: source.identity.instance_epoch,
        scope_id: source.scope.clone(),
        position: oldest.saturating_sub(1).into(),
    };
    let mut error = HostError::new("CURSOR_EXPIRED", "Raw history is no longer retained");
    error.details = serde_json::from_value(
        serde_json::json!({"scopeId":source.scope,"oldestCursor":cursor,"snapshotRequired":true}),
    )
    .ok()
    .map(Box::new);
    error
}
fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid raw stream request")
}
fn limit() -> HostError {
    HostError::new("LIMIT_EXCEEDED", "Raw stream byte budget exhausted")
}
fn busy() -> HostError {
    HostError::new("HOST_BUSY", "Raw stream state is unavailable")
}

#[cfg(test)]
mod capture_cursor_tests {
    use crate::test_support::Harness;
    use serial_workbench_core::U64;
    #[tokio::test]
    async fn capture_cursor_tracks_committed_events_and_rejects_old_epoch() {
        let h = Harness::new().await;
        let target = h.open("cursor-capture").await;
        let before = h.host.streams().current_cursor(&target).unwrap();
        h.send(&target).await;
        let after = h.host.streams().current_cursor(&target).unwrap();
        assert_eq!(after.position.get(), before.position.get() + 2);
        let mut old = target;
        old.session_epoch = Some(U64::from(0));
        assert_eq!(
            h.host.streams().current_cursor(&old).unwrap_err().code,
            "EPOCH_MISMATCH"
        );
    }
}
