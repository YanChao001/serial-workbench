use super::{SourceBoundary, StreamHub, busy, expired, ring::SourcePayload};
use serial_workbench_core::{
    DerivedPublishParams, DerivedQuality, Direction, HostError, HostResult, Target,
};

impl StreamHub {
    pub(crate) fn verify_derived_sources(
        &self,
        target: &Target,
        params: &DerivedPublishParams,
    ) -> HostResult<()> {
        let source = self
            .inner
            .sources
            .lock()
            .map_err(|_| busy())?
            .values()
            .find(|source| source.target == *target)
            .cloned()
            .ok_or_else(|| {
                HostError::new("EPOCH_MISMATCH", "Derived source epoch is unavailable")
            })?;
        let state = source.state.lock().map_err(|_| busy())?;
        if state.closed {
            return Err(HostError::new("EPOCH_MISMATCH", "Derived source is closed"));
        }
        let oldest = state.ring.front().map_or(state.next, |event| event.seq);
        let complete = params.quality.contains(&DerivedQuality::Complete);
        for range in &params.sources {
            if range.host_id != target.host_id
                || range.session_id != target.id
                || Some(range.session_epoch) != target.session_epoch
            {
                return Err(invalid());
            }
            let start = range.event_start.get();
            let end = range.event_end.get();
            if start < oldest {
                return Err(expired(&source, oldest));
            }
            if end > state.next {
                return Err(invalid());
            }
            // 实时解析通常使用源尾部，从留存范围较近的一端查找。
            let count = (end - start) as usize;
            let candidates = if start - oldest <= state.next - end {
                state
                    .ring
                    .iter()
                    .skip((start - oldest) as usize)
                    .take(count)
                    .collect::<Vec<_>>()
            } else {
                state
                    .ring
                    .iter()
                    .rev()
                    .skip((state.next - end) as usize)
                    .take(count)
                    .collect()
            };
            let mut offsets = Vec::with_capacity(candidates.len());
            for event in candidates {
                let part = match (&event.payload, range.direction) {
                    (SourcePayload::Rx { start, end, .. }, Some(Direction::Rx))
                    | (SourcePayload::Intent { start, end, .. }, Some(Direction::Tx))
                    | (SourcePayload::Receipt { start, end, .. }, Some(Direction::Tx)) => {
                        Some((*start, *end))
                    }
                    (SourcePayload::Boundary(SourceBoundary::Gap(_)), _) if complete => {
                        return Err(invalid());
                    }
                    _ => None,
                };
                if let Some(part) = part {
                    offsets.push(part);
                }
            }
            if range.direction.is_some() && offsets.is_empty() {
                return Err(invalid());
            }
            if let (Some(start), Some(end)) = (range.byte_start, range.byte_end) {
                // TX 结算的事件顺序可晚于后一意图，覆盖以方向上的字节位置为准。
                offsets.sort_unstable();
                let mut covered = start.get();
                for (start, end) in offsets {
                    if start <= covered {
                        covered = covered.max(end);
                    }
                }
                if covered < end.get() {
                    return Err(invalid());
                }
            }
        }
        Ok(())
    }
}

fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Derived provenance exceeds the available source range",
    )
}
