//! 仅从录制的 TX 意图和已确认的接纳区间构建发送预览。
use super::format::{SettlementKey, SourceIdentity};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::*;
use std::collections::HashMap;

const MAX_PREVIEW_SPANS: usize = 512;

pub(super) struct AcceptedReplayBytes {
    pub bytes: Vec<u8>,
    pub spans: Vec<ReplayTransmitSpan>,
}

struct Intent {
    source_identity: SourceIdentity,
    source: SourceRange,
    ordinal: U64,
    bytes: Bytes,
    receipt: Option<TxReceipt>,
}

pub(super) fn accepted_bytes(
    records: impl IntoIterator<Item = HostResult<CaptureRecord>>,
    selection: Option<&SourceRange>,
) -> HostResult<AcceptedReplayBytes> {
    if selection.is_some_and(|range| {
        range.event_start.get() == 0
            || range.event_end <= range.event_start
            || range
                .direction
                .is_some_and(|direction| direction != Direction::Tx)
            || match (range.byte_start, range.byte_end) {
                (None, None) => false,
                (Some(start), Some(end)) => start >= end,
                _ => true,
            }
    }) {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "Invalid recorded TX range",
        ));
    }
    let mut intents = Vec::new();
    let mut pending = HashMap::new();
    for record in records {
        let record = record?;
        match &record.entry {
            CaptureEntry::Event(event) => match &event.payload {
                RawPayload::TxIntent(intent) => {
                    if selection.is_some_and(|range| {
                        range.host_id != event.host_id
                            || range.session_id != event.session_id
                            || range.session_epoch != event.session_epoch
                            || event.event_seq < range.event_start
                            || event.event_seq >= range.event_end
                    }) {
                        continue;
                    }
                    let identity = SourceIdentity::entry(&record.entry);
                    let key = SettlementKey::intent(identity.clone(), intent);
                    if pending.insert(key, intents.len()).is_some() {
                        return Err(inconsistent());
                    }
                    intents.push(Intent {
                        source_identity: identity,
                        source: SourceRange {
                            host_id: event.host_id.clone(),
                            session_id: event.session_id.clone(),
                            session_epoch: event.session_epoch,
                            event_start: event.event_seq,
                            event_end: event.event_seq.checked_next()?,
                            byte_start: Some(intent.byte_start),
                            byte_end: Some(intent.byte_end),
                            direction: Some(Direction::Tx),
                        },
                        ordinal: record.record_ordinal,
                        bytes: intent.bytes_base64.clone(),
                        receipt: None,
                    });
                }
                RawPayload::Tx(receipt) => {
                    set_receipt(&record.entry, receipt, &mut pending, &mut intents)
                }
                _ => {}
            },
            CaptureEntry::TxSettlement(settlement) => set_receipt(
                &record.entry,
                &settlement.receipt,
                &mut pending,
                &mut intents,
            ),
            CaptureEntry::ReaderGap(_) => {}
            CaptureEntry::Redacted(_) => return Err(inconsistent()),
        }
    }

    let mut plan = AcceptedReplayBytes {
        bytes: Vec::new(),
        spans: Vec::new(),
    };
    let mut source = None;
    for intent in intents {
        if let Some(receipt) = intent.receipt {
            let bytes = STANDARD
                .decode(intent.bytes.as_str())
                .map_err(|_| inconsistent())?;
            let start = receipt.byte_start.get();
            let end = receipt.byte_end.get();
            if receipt.bytes_base64 != intent.bytes
                || end.checked_sub(start) != Some(bytes.len() as u64)
                || receipt.outcome == TxOutcome::Rejected && !receipt.accepted_ranges.is_empty()
            {
                return Err(inconsistent());
            }
            let mut previous = 0;
            for range in &receipt.accepted_ranges {
                let low = range.start.get();
                let high = range.end.get();
                if low < previous
                    || high <= low
                    || high > bytes.len() as u64
                    || receipt
                        .unknown_ranges
                        .iter()
                        .any(|unknown| unknown.start.get() < high && unknown.end.get() > low)
                {
                    return Err(inconsistent());
                }
                previous = high;

                let start = (start + low).max(
                    selection
                        .and_then(|range| range.byte_start)
                        .map_or(0, U64::get),
                );
                let end = (receipt.byte_start.get() + high).min(
                    selection
                        .and_then(|range| range.byte_end)
                        .map_or(u64::MAX, U64::get),
                );
                if end <= start {
                    continue;
                }
                if source.get_or_insert_with(|| intent.source_identity.clone())
                    != &intent.source_identity
                {
                    return Err(HostError::new(
                        "REPLAY_SOURCE_AMBIGUOUS",
                        "Choose one recorded TX source",
                    ));
                }
                let span = &bytes[(start - receipt.byte_start.get()) as usize
                    ..(end - receipt.byte_start.get()) as usize];
                if plan.spans.len() >= MAX_PREVIEW_SPANS
                    || plan.bytes.len() + span.len() > TX_MAX_BYTES
                {
                    return Err(HostError::new(
                        "REPLAY_TRANSMIT_LIMIT",
                        "Choose a smaller range of recorded TX",
                    ));
                }
                plan.spans.push(ReplayTransmitSpan {
                    record_ordinal: intent.ordinal,
                    source: SourceRange {
                        byte_start: Some(start.into()),
                        byte_end: Some(end.into()),
                        ..intent.source.clone()
                    },
                    output_offset: (plan.bytes.len() as u64).into(),
                });
                plan.bytes.extend_from_slice(span);
            }
        }
    }
    if plan.bytes.is_empty() {
        return Err(HostError::new(
            "REPLAY_TRANSMIT_EMPTY",
            "No confirmed TX bytes were found in the selected range",
        ));
    }
    Ok(plan)
}

fn set_receipt(
    entry: &CaptureEntry,
    receipt: &TxReceipt,
    pending: &mut HashMap<SettlementKey, usize>,
    intents: &mut [Intent],
) {
    let key = SettlementKey::receipt(SourceIdentity::entry(entry), receipt);
    if let Some(index) = pending.remove(&key) {
        intents[index].receipt = Some(receipt.clone());
    }
}

fn inconsistent() -> HostError {
    HostError::new(
        "CAPTURE_CORRUPT",
        "Recorded TX intent and settlement differ",
    )
}

#[cfg(test)]
#[path = "replay_transmit_tests.rs"]
mod tests;
