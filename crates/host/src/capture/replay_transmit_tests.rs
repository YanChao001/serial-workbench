use super::*;
use serde_json::json;

fn tx_record(ordinal: u64, session: &str, receipt: bool) -> CaptureRecord {
    let (kind, payload) = if receipt {
        (
            "tx",
            json!({
                "operationId":"write", "sessionId":session, "sessionEpoch":"1",
                "outcome":"unknown", "bytesBase64":"AQIDBAU=",
                "byteStart":"20", "byteEnd":"25",
                "acceptedRanges":[{"start":"0","end":"3"}],
                "unknownRanges":[{"start":"3","end":"5"}],
                "peerAcknowledged":false
            }),
        )
    } else {
        (
            "tx_intent",
            json!({
                "operationId":"write", "bytesBase64":"AQIDBAU=",
                "byteStart":"20", "byteEnd":"25"
            }),
        )
    };
    let event = serde_json::from_value(json!({
        "hostId":"host", "instanceEpoch":"1", "sessionId":session, "sessionEpoch":"1",
        "eventSeq":(if receipt {"2"} else {"1"}), "configurationRevision":"1",
        "time":{
            "clockId":"clock","sourceMonoNs":"1","receivedWallTime":"2026-11-27T08:00:00Z",
            "precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}
        },
        "kind":kind, "payload":payload
    }))
    .unwrap();
    CaptureRecord {
        record_ordinal: ordinal.into(),
        entry: CaptureEntry::Event(event),
    }
}

fn plan(
    records: Vec<CaptureRecord>,
    selection: Option<&SourceRange>,
) -> HostResult<AcceptedReplayBytes> {
    accepted_bytes(records.into_iter().map(Ok), selection)
}

#[test]
fn replay_transmit_keeps_confirmed_prefix_and_original_locator() {
    let original = vec![
        tx_record(7, "captured", false),
        tx_record(9, "captured", true),
    ];
    let output = plan(original.clone(), None).unwrap();
    assert_eq!(output.bytes, [1, 2, 3]);
    let [span] = output.spans.as_slice() else {
        panic!("one proven interval")
    };
    assert_eq!(span.record_ordinal, 7.into());
    assert_eq!(span.source.byte_start, Some(20.into()));
    assert_eq!(span.source.byte_end, Some(23.into()));
    assert_eq!(span.output_offset, 0.into());

    let selected = SourceRange {
        byte_start: Some(21.into()),
        byte_end: Some(25.into()),
        ..span.source.clone()
    };
    let clipped = plan(original, Some(&selected)).unwrap();
    assert_eq!(clipped.bytes, [2, 3]);
    assert_eq!(clipped.spans[0].source.byte_start, Some(21.into()));
    assert_eq!(clipped.spans[0].source.byte_end, Some(23.into()));
}

#[test]
fn replay_transmit_demands_a_single_source_and_never_copies_unsettled_intents() {
    let first = vec![tx_record(1, "first", false), tx_record(2, "first", true)];
    let mut multiple = first.clone();
    multiple.extend([tx_record(3, "second", false), tx_record(4, "second", true)]);
    assert_eq!(
        plan(multiple.clone(), None).err().unwrap().code,
        "REPLAY_SOURCE_AMBIGUOUS"
    );
    let range = &plan(first, None).unwrap().spans[0].source;
    assert_eq!(plan(multiple, Some(range)).unwrap().bytes, [1, 2, 3]);

    let single = vec![tx_record(1, "first", false)];
    assert_eq!(
        plan(single, None).err().unwrap().code,
        "REPLAY_TRANSMIT_EMPTY"
    );
}

#[test]
fn replay_transmit_rejects_conflicting_known_and_unknown_ranges() {
    let first = tx_record(1, "captured", false);
    let mut second = tx_record(2, "captured", true);
    let CaptureEntry::Event(event) = &mut second.entry else {
        panic!("expected event")
    };
    let RawPayload::Tx(receipt) = &mut event.payload else {
        panic!("expected settlement")
    };
    receipt.unknown_ranges[0].start = 2.into();
    assert_eq!(
        plan(vec![first, second], None).err().unwrap().code,
        "CAPTURE_CORRUPT"
    );
}
