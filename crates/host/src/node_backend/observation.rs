//! 每个实际任务只保留一份累计观测；提交在锁外进行，旧回执不能清掉更新的样本。
use super::error;
use serde::{Deserialize, Deserializer, Serialize};
use serial_workbench_core::{HostResult, Progress, WorkerObservation};
use serial_workbench_ipc::frame::{MAX_FRAME_BYTES, encoded_length};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RawObservation {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub progress: Option<Progress>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_present"
    )]
    pub worker_observation: Option<WorkerObservation>,
}

pub(super) fn deserialize_present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

pub(crate) type ObservationSink = Arc<dyn Fn(&RawObservation) -> HostResult<()> + Send + Sync>;

#[derive(Debug, Default)]
struct State {
    latest: RawObservation,
    generation: u64,
    pending: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ObservationSlot(Arc<Mutex<State>>);

#[derive(Debug, Clone)]
pub(crate) struct ObservationSnapshot {
    origin: Weak<Mutex<State>>,
    generation: u64,
    value: RawObservation,
}

impl ObservationSnapshot {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    pub(crate) fn value(&self) -> &RawObservation {
        &self.value
    }
}

impl ObservationSlot {
    fn state(&self) -> HostResult<MutexGuard<'_, State>> {
        self.0.lock().map_err(|_| {
            let mut cause = error("HOST_BUSY", "backendObservationLock");
            cause.retryable = true;
            cause
        })
    }

    pub(crate) fn update(&self, update: &RawObservation) -> HostResult<()> {
        if update.progress.is_none() && update.worker_observation.is_none() {
            return Ok(());
        }
        encoded_length(update, MAX_FRAME_BYTES)?;
        let mut state = self.state()?;
        let merged = merge(&state.latest, update)?;
        if merged == state.latest {
            return Ok(());
        }
        // 复用原帧的计数器，不为合并后的正文先分配序列化缓冲区。
        encoded_length(&merged, MAX_FRAME_BYTES)?;
        let generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| error("COUNTER_EXHAUSTED", "backendObservationGeneration"))?;
        state.latest = merged;
        state.generation = generation;
        state.pending = true;
        Ok(())
    }

    /// 不移走样本；sink失败或等待者结束时，实际提交方仍可取得最新值。
    pub(crate) fn peek(&self) -> HostResult<Option<ObservationSnapshot>> {
        let state = self.state()?;
        Ok(state.pending.then(|| ObservationSnapshot {
            origin: Arc::downgrade(&self.0),
            generation: state.generation,
            value: state.latest.clone(),
        }))
    }

    /// 仅确认同一slot的这一代；保留累计值用于检查下次更新，None从不表示清空。
    pub(crate) fn ack(&self, snapshot: &ObservationSnapshot) -> HostResult<()> {
        if !Weak::ptr_eq(&snapshot.origin, &Arc::downgrade(&self.0)) {
            return Err(error("INVALID_ARGUMENT", "backendObservationSnapshotOwner"));
        }
        let mut state = self.state()?;
        if state.generation == snapshot.generation() {
            state.pending = false;
        }
        Ok(())
    }
}

fn merge(previous: &RawObservation, update: &RawObservation) -> HostResult<RawObservation> {
    if let Some(next) = &update.progress
        && (next.total.is_some_and(|total| next.completed > total)
            || previous.progress.as_ref().is_some_and(|before| {
                next.completed < before.completed
                    || next.unit != before.unit
                    || next.total != before.total
            }))
    {
        return Err(error("INVALID_ARGUMENT", "backendObservationProgress"));
    }
    if let Some(next) = &update.worker_observation
        && (next.live_workers > next.peak_workers
            || next
                .last_memory
                .as_ref()
                .is_some_and(|memory| memory.measured_workers > next.peak_workers)
            || previous
                .worker_observation
                .as_ref()
                .is_some_and(|before| next.peak_workers < before.peak_workers))
    {
        return Err(error("INVALID_ARGUMENT", "backendObservationWorkers"));
    }
    let worker_observation = match &update.worker_observation {
        Some(next) => {
            let mut next = next.clone();
            if next.last_memory.is_none() {
                next.last_memory = previous
                    .worker_observation
                    .as_ref()
                    .and_then(|before| before.last_memory.clone());
            }
            Some(next)
        }
        None => previous.worker_observation.clone(),
    };
    Ok(RawObservation {
        progress: update
            .progress
            .clone()
            .or_else(|| previous.progress.clone()),
        worker_observation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_core::{HostError, Timestamp, WorkerMemorySample};
    use std::sync::mpsc;

    fn progress(completed: u64) -> RawObservation {
        RawObservation {
            progress: Some(Progress {
                completed: completed.into(),
                total: Some(100.into()),
                unit: "records".into(),
            }),
            ..RawObservation::default()
        }
    }

    fn workers(live: u64, peak: u64, memory: Option<WorkerMemorySample>) -> RawObservation {
        RawObservation {
            worker_observation: Some(WorkerObservation {
                live_workers: live.into(),
                peak_workers: peak.into(),
                last_memory: memory,
            }),
            ..RawObservation::default()
        }
    }

    fn memory(time: &str, measured: u64, bytes: u64) -> WorkerMemorySample {
        WorkerMemorySample {
            sampled_at: Timestamp::try_from(time).unwrap(),
            measured_workers: measured.into(),
            v8_heap_used_bytes: bytes.into(),
        }
    }

    #[test]
    fn a_write_ack_cannot_erase_a_concurrent_newer_observation() {
        let slot = ObservationSlot::default();
        slot.update(&progress(3)).unwrap();
        let (started, writing) = mpsc::sync_channel(1);
        let (resume, resumed) = mpsc::sync_channel(1);
        let writer_slot = slot.clone();
        let writer = std::thread::spawn(move || {
            let snapshot = writer_slot.peek().unwrap().unwrap();
            started.send(snapshot.generation()).unwrap();
            resumed.recv().unwrap();
            writer_slot.ack(&snapshot).unwrap();
        });
        let first_generation = writing.recv().unwrap();
        slot.update(&progress(8)).unwrap();
        resume.send(()).unwrap();
        writer.join().unwrap();
        let latest = slot.peek().unwrap().unwrap();
        assert!(latest.generation() > first_generation);
        assert_eq!(latest.value().progress, progress(8).progress);
        slot.ack(&latest).unwrap();
        assert!(slot.peek().unwrap().is_none());
        slot.update(&progress(8)).unwrap();
        assert!(slot.peek().unwrap().is_none());
        assert_eq!(
            slot.update(&progress(7)).unwrap_err().code,
            "INVALID_ARGUMENT"
        );
    }

    #[test]
    fn a_failed_sink_keeps_the_sample_and_partial_updates_keep_other_fields() {
        let slot = ObservationSlot::default();
        slot.update(&progress(4)).unwrap();
        let first_memory = memory("2026-11-18T00:00:00Z", 2, 500);
        slot.update(&workers(2, 2, Some(first_memory))).unwrap();
        let snapshot = slot.peek().unwrap().unwrap();
        let failing_sink: ObservationSink =
            Arc::new(|_| Err(HostError::new("HOST_BUSY", "Controlled sink failure")));
        assert_eq!(
            failing_sink(snapshot.value()).unwrap_err().code,
            "HOST_BUSY"
        );
        assert_eq!(
            slot.peek().unwrap().unwrap().generation(),
            snapshot.generation()
        );
        assert_eq!(slot.peek().unwrap().unwrap().value(), snapshot.value());

        let last_memory = memory("2026-11-18T00:00:01Z", 1, 70);
        slot.update(&workers(1, 2, Some(last_memory.clone())))
            .unwrap();
        slot.update(&workers(0, 2, None)).unwrap();
        slot.update(&RawObservation::default()).unwrap();
        slot.ack(&snapshot).unwrap();
        let latest = slot.peek().unwrap().unwrap();
        assert_eq!(latest.value().progress, progress(4).progress);
        let observed = latest.value().worker_observation.as_ref().unwrap();
        assert_eq!(observed.live_workers.get(), 0);
        assert_eq!(observed.peak_workers.get(), 2);
        assert_eq!(observed.last_memory, Some(last_memory));
    }

    #[test]
    fn invalid_partial_updates_leave_all_pending_evidence_unchanged() {
        let slot = ObservationSlot::default();
        slot.update(&progress(9)).unwrap();
        slot.update(&workers(2, 2, None)).unwrap();
        let before = slot.peek().unwrap().unwrap();
        let mut changed_unit = progress(10);
        changed_unit.progress.as_mut().unwrap().unit = "bytes".into();
        let mut changed_total = progress(10);
        changed_total.progress.as_mut().unwrap().total = None;
        let mut mixed_regression = progress(8);
        mixed_regression.worker_observation = workers(3, 3, None).worker_observation;
        for invalid in [
            changed_unit,
            changed_total,
            progress(101),
            mixed_regression,
            workers(3, 2, None),
            workers(1, 1, None),
            workers(1, 2, Some(memory("2026-11-18T00:00:02Z", 3, 100))),
        ] {
            assert_eq!(slot.update(&invalid).unwrap_err().code, "INVALID_ARGUMENT");
            let after = slot.peek().unwrap().unwrap();
            assert_eq!(after.generation(), before.generation());
            assert_eq!(after.value(), before.value());
        }
    }

    #[test]
    fn acknowledgements_are_bound_to_the_slot_and_counter_exhaustion_is_atomic() {
        let slot = ObservationSlot::default();
        let other = ObservationSlot::default();
        slot.update(&progress(1)).unwrap();
        other.update(&progress(1)).unwrap();
        let foreign = other.peek().unwrap().unwrap();
        assert_eq!(slot.ack(&foreign).unwrap_err().code, "INVALID_ARGUMENT");
        {
            let mut state = slot.0.lock().unwrap();
            state.generation = u64::MAX;
        }
        let before = slot.peek().unwrap().unwrap();
        assert_eq!(
            slot.update(&progress(2)).unwrap_err().code,
            "COUNTER_EXHAUSTED"
        );
        let after = slot.peek().unwrap().unwrap();
        assert_eq!(after.generation(), u64::MAX);
        assert_eq!(after.value(), before.value());
        slot.ack(&after).unwrap();
        assert!(slot.peek().unwrap().is_none());
        slot.update(&progress(1)).unwrap();
        assert!(slot.peek().unwrap().is_none());
    }

    #[test]
    fn an_oversized_sample_does_not_replace_pending_evidence() {
        let slot = ObservationSlot::default();
        slot.update(&workers(1, 1, None)).unwrap();
        let before = slot.peek().unwrap().unwrap();
        let mut oversized = progress(2);
        oversized.progress.as_mut().unwrap().unit = "\n".repeat(MAX_FRAME_BYTES);
        assert!(slot.update(&oversized).is_err());
        let after = slot.peek().unwrap().unwrap();
        assert_eq!(after.generation(), before.generation());
        assert_eq!(after.value(), before.value());
    }

    #[test]
    fn combining_valid_partial_samples_cannot_exceed_the_original_frame_budget() {
        let slot = ObservationSlot::default();
        let mut full = progress(1);
        full.progress.as_mut().unwrap().unit.clear();
        let overhead = encoded_length(&full, MAX_FRAME_BYTES).unwrap();
        full.progress.as_mut().unwrap().unit = "x".repeat(MAX_FRAME_BYTES - overhead);
        assert_eq!(
            encoded_length(&full, MAX_FRAME_BYTES).unwrap(),
            MAX_FRAME_BYTES
        );
        slot.update(&full).unwrap();
        let before = slot.peek().unwrap().unwrap();
        assert!(slot.update(&workers(1, 1, None)).is_err());
        let after = slot.peek().unwrap().unwrap();
        assert_eq!(after.generation(), before.generation());
        assert_eq!(after.value(), before.value());
    }

    #[test]
    fn raw_observations_reject_unknown_fields_and_explicit_null() {
        for raw in [
            r#"{"progress":null}"#,
            r#"{"workerObservation":null}"#,
            r#"{"extra":1}"#,
            r#"{"progress":{"completed":1,"unit":"records"}}"#,
            r#"{"progress":{"completed":"1","unit":"records","extra":true}}"#,
        ] {
            assert!(
                serde_json::from_str::<RawObservation>(raw).is_err(),
                "{raw}"
            );
        }
        assert_eq!(
            serde_json::from_str::<RawObservation>("{}").unwrap(),
            RawObservation::default()
        );
    }
}
