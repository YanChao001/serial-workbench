//! Builds an interactive peer only from continuous raw byte evidence.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::*;
use std::collections::HashMap;

const MAX_RECORDS: usize = 4096;
const MAX_BYTES: usize = 512 * 1024;

type Source = (Id, U64, Id, U64);

#[derive(Default)]
struct Turn {
    request: Vec<u8>,
    responses: Vec<ReplayPeerResponse>,
}

#[derive(Default)]
pub(super) struct RecordedPeer {
    preamble: Vec<ReplayPeerResponse>,
    turns: Vec<Turn>,
    turn: usize,
    matched: usize,
}

pub(super) struct PeerMatch<'a> {
    pub responses: &'a [ReplayPeerResponse],
    pub remaining_request_bytes: usize,
    pub completed_turns: usize,
    pub at_end: bool,
}

impl RecordedPeer {
    pub(super) fn from_records(
        records: impl IntoIterator<Item = HostResult<CaptureRecord>>,
    ) -> HostResult<Self> {
        let mut peer = Self::default();
        let mut source: Option<Source> = None;
        let mut sequence = None;
        let mut configuration = None;
        let mut pending = HashMap::new();
        let mut rx_end = None;
        let mut tx_end = None;
        let mut total_bytes = 0;

        for (index, record) in records.into_iter().enumerate() {
            if index >= MAX_RECORDS {
                return Err(limit());
            }
            let record = record?;
            match &record.entry {
                CaptureEntry::Event(event) => {
                    let identity = (
                        event.host_id.clone(),
                        event.instance_epoch,
                        event.session_id.clone(),
                        event.session_epoch,
                    );
                    if source.get_or_insert(identity.clone()) != &identity
                        || *configuration.get_or_insert(event.configuration_revision)
                            != event.configuration_revision
                        || sequence.is_some_and(|last: u64| {
                            last.checked_add(1) != Some(event.event_seq.get())
                        })
                    {
                        return Err(ineligible());
                    }
                    sequence = Some(event.event_seq.get());
                    match &event.payload {
                        RawPayload::TxIntent(intent) => {
                            let bytes = byte_range(
                                &intent.bytes_base64,
                                intent.byte_start,
                                intent.byte_end,
                                &mut tx_end,
                                &mut total_bytes,
                            )?;
                            if pending
                                .insert(intent.operation_id.clone(), intent.clone())
                                .is_some()
                            {
                                return Err(ineligible());
                            }
                            if peer
                                .turns
                                .last()
                                .is_none_or(|turn| !turn.responses.is_empty())
                            {
                                peer.turns.push(Turn::default());
                            }
                            peer.turns
                                .last_mut()
                                .expect("request turn")
                                .request
                                .extend(bytes);
                        }
                        RawPayload::Rx(rx) => {
                            if rx.message.is_some() {
                                return Err(ineligible());
                            }
                            byte_range(
                                &rx.bytes_base64,
                                rx.byte_start,
                                rx.byte_end,
                                &mut rx_end,
                                &mut total_bytes,
                            )?;
                            let response = ReplayPeerResponse {
                                record_ordinal: record.record_ordinal,
                                bytes_base64: rx.bytes_base64.clone(),
                            };
                            if let Some(turn) = peer.turns.last_mut() {
                                turn.responses.push(response);
                            } else {
                                peer.preamble.push(response);
                            }
                        }
                        RawPayload::Tx(receipt) => {
                            if receipt.session_id != event.session_id
                                || receipt.session_epoch != event.session_epoch
                            {
                                return Err(ineligible());
                            }
                            confirm(&mut pending, receipt)?;
                        }
                        RawPayload::Lifecycle(_) => {}
                        RawPayload::ConfigurationBoundary(boundary)
                            if boundary.certainty == Certainty::Confirmed
                                && peer.turns.is_empty() => {}
                        RawPayload::Gap(_)
                        | RawPayload::Control(_)
                        | RawPayload::ConfigurationBoundary(_) => return Err(ineligible()),
                    }
                }
                CaptureEntry::TxSettlement(settled) => {
                    let receipt = &settled.receipt;
                    let receipt_source = (
                        settled.host_id.clone(),
                        settled.instance_epoch,
                        receipt.session_id.clone(),
                        receipt.session_epoch,
                    );
                    if source.as_ref() != Some(&receipt_source) {
                        return Err(ineligible());
                    }
                    confirm(&mut pending, receipt)?;
                }
                CaptureEntry::ReaderGap(_) | CaptureEntry::Redacted(_) => return Err(ineligible()),
            }
        }

        if peer.turns.is_empty() || !pending.is_empty() {
            return Err(ineligible());
        }
        Ok(peer)
    }

    pub(super) fn preamble(&self) -> &[ReplayPeerResponse] {
        &self.preamble
    }

    pub(super) fn initial_request_bytes(&self) -> usize {
        self.turns.first().map_or(0, |turn| turn.request.len())
    }

    pub(super) fn submit(&mut self, input: &[u8]) -> HostResult<PeerMatch<'_>> {
        if input.is_empty() {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "A recorded peer input must contain bytes",
            ));
        }
        let turn = self.turns.get(self.turn).ok_or_else(|| {
            HostError::new(
                "REPLAY_PEER_COMPLETE",
                "The recorded peer has reached the end",
            )
        })?;
        let remaining = &turn.request[self.matched..];
        if !remaining.starts_with(input) {
            let prefix = remaining
                .iter()
                .zip(input)
                .take_while(|(a, b)| a == b)
                .count();
            let mut error = HostError::new(
                "REPLAY_PEER_MISMATCH",
                "Input does not match the recorded request",
            );
            error.details = serde_json::from_value(serde_json::json!({
                "turn": self.turn + 1,
                "matchedBytes": self.matched,
                "mismatchOffset": self.matched + prefix
            }))
            .ok();
            return Err(error);
        }
        if input.len() < remaining.len() {
            self.matched += input.len();
            return Ok(PeerMatch {
                responses: &[],
                remaining_request_bytes: remaining.len() - input.len(),
                completed_turns: self.turn,
                at_end: false,
            });
        }
        self.turn += 1;
        self.matched = 0;
        Ok(PeerMatch {
            responses: &turn.responses,
            remaining_request_bytes: self
                .turns
                .get(self.turn)
                .map_or(0, |next| next.request.len()),
            completed_turns: self.turn,
            at_end: self.turn == self.turns.len(),
        })
    }
}

fn byte_range(
    encoded: &Bytes,
    start: U64,
    end: U64,
    previous: &mut Option<U64>,
    total: &mut usize,
) -> HostResult<Vec<u8>> {
    let bytes = STANDARD
        .decode(encoded.as_str())
        .map_err(|_| ineligible())?;
    if bytes.is_empty()
        || end.get().checked_sub(start.get()) != Some(bytes.len() as u64)
        || previous.is_some_and(|last| start != last)
    {
        return Err(ineligible());
    }
    *total = total
        .checked_add(bytes.len())
        .filter(|count| *count <= MAX_BYTES)
        .ok_or_else(limit)?;
    *previous = Some(end);
    Ok(bytes)
}

fn confirm(pending: &mut HashMap<Id, TxIntent>, receipt: &TxReceipt) -> HostResult<()> {
    let intent = pending
        .remove(&receipt.operation_id)
        .ok_or_else(ineligible)?;
    let full_end = receipt
        .accepted_ranges
        .iter()
        .try_fold(U64::from(0), |end, range| {
            (range.start == end && range.end > range.start).then_some(range.end)
        });
    if receipt.outcome != TxOutcome::Accepted
        || !receipt.unknown_ranges.is_empty()
        || receipt.backend_error.is_some()
        || receipt.bytes_base64 != intent.bytes_base64
        || receipt.byte_start != intent.byte_start
        || receipt.byte_end != intent.byte_end
        || full_end.map(U64::get) != intent.byte_end.get().checked_sub(intent.byte_start.get())
    {
        return Err(ineligible());
    }
    Ok(())
}

fn ineligible() -> HostError {
    HostError::new(
        "REPLAY_PEER_INELIGIBLE",
        "Interactive replay requires a continuous raw capture with confirmed writes from one session",
    )
}

fn limit() -> HostError {
    HostError::new(
        "LIMIT_EXCEEDED",
        "Recorded peer source exceeds the matching budget",
    )
}

#[cfg(test)]
#[path = "recorded_peer_tests.rs"]
mod tests;
