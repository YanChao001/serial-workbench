//! 派生留存独立于源环和 Raw reader。慢读者只影响自己的页游标。
use crate::stream::{Budget, RawOutputLease};
use serial_workbench_core::*;
use serial_workbench_ipc::frame::encoded_length;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

const MAX_SERIES: usize = 32;
const MAX_SAMPLES: usize = 64;
const SERIES_MEMORY: usize = 1024 * 1024;
const READ_MEMORY: usize = 8 * 1024 * 1024;

pub(crate) struct DerivedHub {
    retention: Mutex<Retention>,
    readers: Arc<Budget>,
}

#[derive(Default)]
struct Retention {
    series: VecDeque<Series>,
    peak: usize,
}

impl Retention {
    fn used(&self) -> usize {
        self.series.iter().map(|stream| stream.bytes).sum()
    }
}

struct Series {
    operation_id: Id,
    target: Target,
    next: U64,
    samples: VecDeque<Entry>,
    bytes: usize,
    retired: bool,
}

struct Entry {
    sample: DerivedSample,
    encoded: usize,
    memory: usize,
}

impl DerivedHub {
    pub(crate) fn new() -> Self {
        Self {
            retention: Mutex::default(),
            readers: Budget::new(READ_MEMORY),
        }
    }

    pub(crate) fn memory_usage(&self) -> HostResult<DerivedMemoryMetrics> {
        let retained = {
            let retention = self.retention.lock().map_err(|_| busy())?;
            crate::metrics::budget(retention.used(), retention.peak, MAX_SERIES * SERIES_MEMORY)
        };
        Ok(DerivedMemoryMetrics {
            retained,
            reader: self.readers.metrics(),
        })
    }

    pub(crate) fn publish(
        &self,
        operation_id: Id,
        target: Target,
        provenance: DerivedProvenance,
        value: QueryValue,
    ) -> HostResult<DerivedPublishResult> {
        let mut retention = self.retention.lock().map_err(|_| busy())?;
        let series = &mut retention.series;
        let index = series
            .iter()
            .position(|stream| stream.operation_id == operation_id);
        let position = match index {
            Some(index) if series[index].target != target => return Err(invalid()),
            Some(index) if series[index].retired => {
                return Err(HostError::new(
                    "OPERATION_NOT_RUNNING",
                    "Derived publisher is retired",
                ));
            }
            Some(index) => series[index].next,
            None => 1.into(),
        };
        let next = position.checked_next()?;
        let sample = DerivedSample {
            position,
            provenance,
            value,
        };
        let encoded = encoded_length(&sample, DERIVED_PAGE_MAX_BYTES - 1024)?;
        // 给 JSON 节点、字符串和队列项保留实际内存余量。
        let memory = encoded.saturating_mul(24).saturating_add(1024);
        if memory > SERIES_MEMORY {
            return Err(limit());
        }
        let stream = if let Some(index) = index {
            &mut series[index]
        } else {
            if series.len() == MAX_SERIES {
                let retired = series
                    .iter()
                    .position(|stream| stream.retired)
                    .ok_or_else(busy)?;
                series.remove(retired);
            }
            series.push_back(Series {
                operation_id: operation_id.clone(),
                target,
                next: position,
                samples: VecDeque::new(),
                bytes: 0,
                retired: false,
            });
            series.back_mut().expect("inserted series")
        };
        while stream.samples.len() == MAX_SAMPLES || stream.bytes + memory > SERIES_MEMORY {
            stream.bytes -= stream
                .samples
                .pop_front()
                .expect("evictable derived sample")
                .memory;
        }
        stream.samples.push_back(Entry {
            sample,
            encoded,
            memory,
        });
        stream.next = next;
        stream.bytes += memory;
        retention.peak = retention.peak.max(retention.used());
        Ok(DerivedPublishResult {
            operation_id,
            position,
        })
    }

    pub(crate) fn retire(&self, operation_id: &Id) {
        let mut retention = self
            .retention
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(stream) = retention
            .series
            .iter_mut()
            .find(|stream| &stream.operation_id == operation_id)
        {
            stream.retired = true;
        }
    }

    pub(crate) fn read(
        &self,
        target: &Target,
        instance_epoch: U64,
        params: DerivedReadParams,
    ) -> HostResult<(DerivedReadResult, RawOutputLease)> {
        params.validate()?;
        let bytes = params.max_bytes.get() as usize;
        let lease = RawOutputLease::reserve(&self.readers, bytes * 24 + 4096)?;
        let retention = self.retention.lock().map_err(|_| busy())?;
        let Some(stream) = retention
            .series
            .iter()
            .find(|stream| stream.operation_id == params.operation_id && stream.target == *target)
        else {
            return Err(if params.after.get() == 0 {
                HostError::new("NOT_FOUND", "Derived stream is unavailable")
            } else {
                HostError::new("CURSOR_EXPIRED", "Derived stream has left retention")
            });
        };
        let oldest = stream
            .samples
            .front()
            .expect("published series")
            .sample
            .position;
        if params.after.get() < oldest.get() - 1 {
            let mut error = HostError::new("CURSOR_EXPIRED", "Derived cursor is outside retention");
            error.details = Some(Box::new(
                serde_json::from_value(serde_json::json!({
                    "oldestPosition": oldest
                }))
                .expect("derived cursor details"),
            ));
            return Err(error);
        }
        if params.after >= stream.next {
            return Err(invalid());
        }
        let mut result = DerivedReadResult {
            operation_id: params.operation_id,
            instance_epoch,
            samples: vec![],
            next_position: params.after,
            has_more: params.after.get() + 1 < stream.next.get(),
        };
        if encoded_length(&result, bytes).is_err() {
            return Err(limit());
        }
        let mut sample_bytes = 0;
        for entry in stream
            .samples
            .iter()
            .filter(|entry| entry.sample.position > params.after)
            .take(params.max_samples.get() as usize)
        {
            let position = entry.sample.position;
            let has_more = position.get() + 1 < stream.next.get();
            let envelope = DerivedReadResult {
                operation_id: result.operation_id.clone(),
                instance_epoch,
                samples: vec![],
                next_position: position,
                has_more,
            };
            let next_bytes = sample_bytes + entry.encoded + usize::from(!result.samples.is_empty());
            let fits =
                encoded_length(&envelope, bytes).is_ok_and(|size| size + next_bytes <= bytes);
            if !fits {
                if result.samples.is_empty() {
                    return Err(limit());
                }
                break;
            }
            result.next_position = position;
            result.has_more = has_more;
            result.samples.push(entry.sample.clone());
            sample_bytes = next_bytes;
        }
        Ok((result, lease))
    }
}

fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Derived cursor or source does not match its stream",
    )
}
fn busy() -> HostError {
    HostError::new("HOST_BUSY", "Derived stream capacity is busy")
}
fn limit() -> HostError {
    HostError::new("LIMIT_EXCEEDED", "Derived sample exceeds its budget")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        Target {
            host_id: Id::try_from("host").unwrap(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: Id::try_from("session").unwrap(),
            session_id: Some(Id::try_from("session").unwrap()),
            session_epoch: Some(1.into()),
        }
    }

    fn publish(hub: &DerivedHub, target: &Target, operation: &Id, payload: String) {
        let provenance = DerivedProvenance {
            sources: vec![SourceRange {
                host_id: target.host_id.clone(),
                session_id: target.id.clone(),
                session_epoch: 1.into(),
                event_start: 1.into(),
                event_end: 2.into(),
                byte_start: None,
                byte_end: None,
                direction: None,
            }],
            parser_id: Id::try_from("example.test").unwrap(),
            parser_version: "1.0.0".into(),
            configuration_digest: Digest::try_from("0".repeat(64).as_str()).unwrap(),
            quality: vec![DerivedQuality::Complete],
            unit: None,
        };
        hub.publish(
            operation.clone(),
            target.clone(),
            provenance,
            QueryValue::String(payload),
        )
        .unwrap();
    }

    #[test]
    fn derived_retention_peak_survives_sample_and_retired_series_eviction() {
        let hub = DerivedHub::new();
        let target = target();
        let operation = Id::try_from("first").unwrap();
        assert_eq!(hub.memory_usage().unwrap().retained.used_bytes.get(), 0);
        publish(&hub, &target, &operation, "x".repeat(4096));
        for _ in 1..MAX_SAMPLES {
            publish(&hub, &target, &operation, "x".into());
        }
        let full = hub.memory_usage().unwrap().retained;
        assert_eq!(full.used_bytes, full.peak_bytes);
        publish(&hub, &target, &operation, "x".into());
        let evicted = hub.memory_usage().unwrap().retained;
        assert!(evicted.used_bytes < full.used_bytes);
        assert_eq!(evicted.peak_bytes, full.peak_bytes);
        hub.retire(&operation);
        assert_eq!(hub.memory_usage().unwrap().retained, evicted);
        for index in 1..MAX_SERIES {
            let id = Id::try_from(format!("job-{index}").as_str()).unwrap();
            publish(&hub, &target, &id, "x".into());
        }
        let before_replacement = hub.memory_usage().unwrap().retained;
        let replacement = Id::try_from("replacement").unwrap();
        publish(&hub, &target, &replacement, "x".into());
        let replaced = hub.memory_usage().unwrap().retained;
        assert!(replaced.used_bytes < before_replacement.used_bytes);
        assert_eq!(replaced.peak_bytes, before_replacement.peak_bytes);
        assert_eq!(
            replaced.limit_bytes.get(),
            (MAX_SERIES * SERIES_MEMORY) as u64
        );
    }

    #[test]
    fn derived_reader_peak_tracks_owned_replies_until_their_leases_drop() {
        let hub = DerivedHub::new();
        let target = target();
        let operation = Id::try_from("operation").unwrap();
        publish(&hub, &target, &operation, "x".into());
        let params = DerivedReadParams {
            operation_id: operation,
            after: 0.into(),
            max_samples: 1.into(),
            max_bytes: (DERIVED_PAGE_MAX_BYTES as u64).into(),
        };
        let reservation = DERIVED_PAGE_MAX_BYTES * 24 + 4096;
        let mut pending = (0..READ_MEMORY / reservation)
            .map(|_| hub.read(&target, 1.into(), params.clone()).unwrap().1)
            .collect::<Vec<_>>();
        let full = hub.memory_usage().unwrap().reader;
        assert_eq!(full.used_bytes.get(), (pending.len() * reservation) as u64);
        assert_eq!(full.peak_bytes, full.used_bytes);
        let rejected = hub
            .read(&target, 1.into(), params.clone())
            .err()
            .expect("reader budget full");
        assert_eq!(rejected.code, "LIMIT_EXCEEDED");
        drop(pending.pop());
        pending.push(hub.read(&target, 1.into(), params).unwrap().1);
        drop(pending);
        let drained = hub.memory_usage().unwrap().reader;
        assert_eq!(drained.used_bytes.get(), 0);
        assert_eq!(drained.peak_bytes, full.peak_bytes);
    }
}
