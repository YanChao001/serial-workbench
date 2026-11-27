use super::*;
use serde_json::{Value, json};

fn event(sequence: u64, kind: &str, payload: Value) -> CaptureRecord {
    CaptureRecord {
        record_ordinal: sequence.into(),
        entry: CaptureEntry::Event(
            serde_json::from_value(json!({
                "hostId": "host", "instanceEpoch": "1",
                "sessionId": "captured", "sessionEpoch": "3",
                "eventSeq": sequence.to_string(), "configurationRevision": "1",
                "time": {
                    "clockId": "clock", "sourceMonoNs": sequence.to_string(),
                    "receivedWallTime": "2026-11-27T08:00:00Z",
                    "precision": {"source": "host_read", "resolutionNs": "1", "syncMethod": "none"}
                },
                "kind": kind, "payload": payload
            }))
            .unwrap(),
        ),
    }
}

fn receive(sequence: u64, offset: u64, value: u8) -> CaptureRecord {
    event(
        sequence,
        "rx",
        json!({
            "bytesBase64": STANDARD.encode([value]),
            "byteStart": offset.to_string(), "byteEnd": (offset + 1).to_string()
        }),
    )
}

fn intent(sequence: u64, operation: &str, offset: u64, bytes: &[u8]) -> CaptureRecord {
    event(
        sequence,
        "tx_intent",
        json!({
            "operationId": operation, "bytesBase64": STANDARD.encode(bytes),
            "byteStart": offset.to_string(), "byteEnd": (offset + bytes.len() as u64).to_string()
        }),
    )
}

fn receipt(sequence: u64, operation: &str, offset: u64, bytes: &[u8]) -> CaptureRecord {
    event(
        sequence,
        "tx",
        json!({
            "operationId": operation, "sessionId": "captured", "sessionEpoch": "3",
            "outcome": "accepted", "bytesBase64": STANDARD.encode(bytes),
            "byteStart": offset.to_string(), "byteEnd": (offset + bytes.len() as u64).to_string(),
            "acceptedRanges": [{"start": "0", "end": bytes.len().to_string()}],
            "unknownRanges": [], "peerAcknowledged": false
        }),
    )
}

fn transcript() -> Vec<CaptureRecord> {
    vec![
        receive(1, 700, 0xA0),
        intent(2, "first", 44, &[0x01, 0x02]),
        receive(3, 701, 0xA1),
        receipt(4, "first", 44, &[0x01, 0x02]),
        receive(5, 702, 0xA2),
        intent(6, "second", 46, &[0x03]),
        receipt(7, "second", 46, &[0x03]),
        receive(8, 703, 0xA3),
    ]
}

fn create(records: Vec<CaptureRecord>) -> HostResult<RecordedPeer> {
    RecordedPeer::from_records(records.into_iter().map(Ok))
}

#[test]
fn recorded_peer_waits_for_complete_fragmented_requests_and_keeps_response_order() {
    let mut peer = create(transcript()).unwrap();
    assert_eq!(peer.preamble()[0].record_ordinal, 1.into());
    let part = peer.submit(&[0x01]).unwrap();
    assert_eq!(part.remaining_request_bytes, 1);
    assert_eq!(part.completed_turns, 0);
    assert!(part.responses.is_empty() && !part.at_end);

    let first = peer.submit(&[0x02]).unwrap();
    let ordinals = first
        .responses
        .iter()
        .map(|record| record.record_ordinal.get())
        .collect::<Vec<_>>();
    assert_eq!(ordinals, [3, 5]);
    assert_eq!(first.completed_turns, 1);
    assert_eq!(first.remaining_request_bytes, 1);
    assert!(!first.at_end);

    let second = peer.submit(&[0x03]).unwrap();
    assert_eq!(second.responses[0].record_ordinal, 8.into());
    assert_eq!(second.completed_turns, 2);
    assert!(second.at_end);
    assert_eq!(
        peer.submit(&[0x03]).err().unwrap().code,
        "REPLAY_PEER_COMPLETE"
    );
}

#[test]
fn recorded_peer_rejects_an_entire_mismatched_submission_before_advancing() {
    let mut peer = create(transcript()).unwrap();
    let mismatch = peer.submit(&[0x01, 0x00]).err().unwrap();
    assert_eq!(mismatch.code, "REPLAY_PEER_MISMATCH");
    assert_eq!(
        serde_json::to_value(mismatch.details.unwrap()).unwrap(),
        json!({
            "turn": 1, "matchedBytes": 0, "mismatchOffset": 1
        })
    );
    assert_eq!(
        peer.submit(&[0x01, 0x02, 0x03]).err().unwrap().code,
        "REPLAY_PEER_MISMATCH"
    );
    let first = peer.submit(&[0x01, 0x02]).unwrap();
    assert_eq!(first.completed_turns, 1);
}

#[test]
fn recorded_peer_rejects_unknown_writes_different_sources_and_discontinuous_bytes() {
    for variant in ["unknown", "unsettled", "changed_epoch", "missing_bytes"] {
        let mut records = transcript();
        match variant {
            "unknown" => {
                let CaptureEntry::Event(event) = &mut records[3].entry else {
                    panic!("expected event");
                };
                let RawPayload::Tx(receipt) = &mut event.payload else {
                    panic!("expected receipt");
                };
                receipt.outcome = TxOutcome::Unknown;
            }
            "unsettled" => {
                records.truncate(3);
            }
            "changed_epoch" => {
                let CaptureEntry::Event(event) = &mut records[4].entry else {
                    panic!("expected event");
                };
                event.session_epoch = 7.into();
            }
            "missing_bytes" => {
                records[4] = receive(5, 999, 0xA2);
            }
            _ => unreachable!(),
        }
        assert_eq!(
            create(records).err().unwrap().code,
            "REPLAY_PEER_INELIGIBLE",
            "{variant}"
        );
    }
}
