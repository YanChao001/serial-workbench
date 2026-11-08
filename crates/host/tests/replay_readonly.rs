use serial_workbench_core::*;
use serial_workbench_host::capture::{
    format::CaptureSource,
    replay::ReplayReader,
    writer::{CaptureLimits, CaptureWriter},
};
#[test]
fn replay_preserves_partial_unknown_and_seek_resets_reader() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("capture");
    let mut w = CaptureWriter::create(
        &path,
        vec![source("h", 1, "s", 1)],
        CaptureLimits::default(),
    )
    .unwrap();
    let receipt:TxReceipt=serde_json::from_value(serde_json::json!({"operationId":"tx-1","sessionId":"s","sessionEpoch":"1","outcome":"unknown","bytesBase64":"AQIDBAU=","byteStart":"0","byteEnd":"5","acceptedRanges":[{"start":"0","end":"3"}],"unknownRanges":[{"start":"3","end":"5"}],"peerAcknowledged":false})).unwrap();
    w.push(settlement(receipt.clone()), 0).unwrap();
    let mut partial = receipt.clone();
    partial.operation_id = Id::try_from("tx-2").unwrap();
    partial.outcome = TxOutcome::Partial;
    partial.unknown_ranges.clear();
    w.push(settlement(partial.clone()), 1).unwrap();
    w.finish().unwrap();
    let mut replay = ReplayReader::open(&path, ReplayMode::Fastest).unwrap();
    let first = replay.read(10, 0).unwrap();
    let ReplayRecord::Inline { record } = &first.records[0] else {
        panic!("small record remains inline")
    };
    assert_eq!(record.entry, settlement(receipt));
    assert_eq!(first.reader_generation, U64::from(1));
    let ReplayRecord::Inline { record } = &first.records[1] else {
        panic!("small record remains inline")
    };
    assert_eq!(record.entry, settlement(partial));
    replay.seek(1.into(), 0).unwrap();
    let reset = replay.read(10, 0).unwrap();
    assert_eq!(reset.reader_generation, U64::from(2));
    assert_eq!(reset.records, first.records);
    replay.pause(true);
    assert!(replay.read(10, 0).unwrap().records.is_empty());
}

#[test]
fn replay_refuses_a_live_capture_even_at_a_synced_boundary() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("live");
    let _writer = CaptureWriter::create(
        &path,
        vec![source("h", 1, "s", 1)],
        CaptureLimits::default(),
    )
    .unwrap();
    assert_eq!(
        ReplayReader::open(&path, ReplayMode::Fastest)
            .err()
            .unwrap()
            .code,
        "CAPTURE_INCOMPLETE"
    );
}

#[test]
fn replay_detects_changed_content_instead_of_returning_new_bytes() {
    use serial_workbench_host::capture::format::volume_name;
    use sha2::{Digest as _, Sha256};
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("changed");
    let mut writer = CaptureWriter::create(
        &path,
        vec![source("h", 1, "s", 1)],
        CaptureLimits::default(),
    )
    .unwrap();
    let receipt: TxReceipt = serde_json::from_value(serde_json::json!({"operationId":"tx-1","sessionId":"s","sessionEpoch":"1","outcome":"accepted","bytesBase64":"AQID","byteStart":"0","byteEnd":"3","acceptedRanges":[{"start":"0","end":"3"}],"unknownRanges":[],"peerAcknowledged":false})).unwrap();
    writer.push(settlement(receipt), 0).unwrap();
    writer.finish().unwrap();
    let mut replay = ReplayReader::open(&path, ReplayMode::Fastest).unwrap();
    let volume = path.join(volume_name(1));
    let mut bytes = std::fs::read(&volume).unwrap();
    let length = u32::from_le_bytes(bytes[7..11].try_into().unwrap()) as usize;
    let mut body = String::from_utf8(bytes[11..11 + length].to_vec()).unwrap();
    body = body.replace("AQID", "CQID");
    bytes[11..11 + length].copy_from_slice(body.as_bytes());
    let hash: [u8; 32] = Sha256::digest(body.as_bytes()).into();
    bytes[11 + length..].copy_from_slice(&hash);
    std::fs::write(&volume, &bytes).unwrap();
    assert_eq!(replay.read(1, 0).unwrap_err().code, "SOURCE_CHANGED");
}

#[test]
fn original_timing_pause_and_seek_use_a_fresh_playback_anchor() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("timing");
    let mut writer = CaptureWriter::create(
        &path,
        vec![source("h", 1, "s", 1)],
        CaptureLimits::default(),
    )
    .unwrap();
    for (sequence, source_ns) in [(1, 100), (2, 200)] {
        let event: RawEvent = serde_json::from_value(serde_json::json!({"hostId":"h","instanceEpoch":"1","sessionId":"s","sessionEpoch":"1","eventSeq":sequence.to_string(),"configurationRevision":"1","time":{"clockId":"c","sourceMonoNs":source_ns.to_string(),"receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},"kind":"rx","payload":{"bytesBase64":"AQ==","byteStart":(sequence-1).to_string(),"byteEnd":sequence.to_string()}})).unwrap();
        writer
            .push(CaptureEntry::Event(Box::new(event)), source_ns)
            .unwrap();
    }
    writer.finish().unwrap();
    let mut reader = ReplayReader::open(&path, ReplayMode::OriginalTiming).unwrap();
    assert_eq!(reader.read(10, 1000).unwrap().records.len(), 1);
    reader.pause_at(true, 1050);
    assert!(reader.read(10, 9000).unwrap().records.is_empty());
    reader.pause_at(false, 9050);
    assert!(reader.read(10, 9099).unwrap().records.is_empty());
    assert_eq!(reader.read(10, 9100).unwrap().records.len(), 1);
    reader.seek(1.into(), 10000).unwrap();
    let restarted = reader.read(10, 10000).unwrap();
    assert_eq!(restarted.reader_generation, U64::from(2));
    assert_eq!(restarted.records.len(), 1);
    assert_eq!(reader.read(10, 10100).unwrap().records.len(), 1);
}

mod support;
#[tokio::test]
async fn maximum_record_replays_through_bounded_refs_without_changing_original_json() {
    use base64::Engine as _;
    use serial_workbench_host::{
        capture::{format::MAX_RECORD, replay::ReplayService},
        files::FileService,
    };
    use sha2::{Digest as _, Sha256};
    let h = support::Harness::new().await;
    let path = h.dir.path().canonicalize().unwrap().join("maximum-record");
    let event = serde_json::json!({"hostId":"original-host","instanceEpoch":"7","sessionId":"original-session","sessionEpoch":"9","eventSeq":"42","configurationRevision":"3","time":{"clockId":"original-clock","sourceMonoNs":"123","receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},"kind":"lifecycle","payload":{"note":""}});
    let mut value = serde_json::json!({"recordOrdinal":"1","entry":{"kind":"event","value":event}});
    let blank: CaptureRecord = serde_json::from_value(value.clone()).unwrap();
    let overhead = serde_json::to_vec(&blank).unwrap().len();
    value["entry"]["value"]["payload"]["note"] = "X".repeat(MAX_RECORD - overhead).into();
    let expected: CaptureRecord = serde_json::from_value(value).unwrap();
    let original_json = serde_json::to_vec(&expected).unwrap();
    assert_eq!(original_json.len(), MAX_RECORD);
    let hash = format!("{:x}", Sha256::digest(&original_json));
    let mut writer = CaptureWriter::create(
        &path,
        vec![source("original-host", 7, "original-session", 9)],
        CaptureLimits::default(),
    )
    .unwrap();
    writer.push(expected.entry.clone(), 0).unwrap();
    writer.finish().unwrap();
    let identity = h.store.identity().unwrap();
    let user = h
        .auth
        .authenticate_user_control(
            &support::id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let files = FileService::new(h.store.clone(), h.auth.clone(), identity.clone());
    let source_ref = files
        .register(
            RegisterFileParams {
                path: path.to_string_lossy().into_owned(),
                purpose: FilePurpose::CaptureSource,
            },
            &user,
        )
        .unwrap();
    let replay = ReplayService::new(files.clone(), identity, h.clock.clone());
    let opened = replay
        .open(
            ReplayOpenParams {
                capture_ref: source_ref.clone(),
                mode: ReplayMode::Fastest,
            },
            &h.actor,
        )
        .await
        .unwrap();
    let batch = replay
        .read(
            ReplayReadParams {
                session_id: opened.session_id,
                session_epoch: opened.session_epoch,
                max_records: 1.into(),
                max_bytes: (256 * 1024).into(),
            },
            &h.actor,
        )
        .await
        .unwrap();
    assert!(serde_json::to_vec(&batch).unwrap().len() <= 256 * 1024);
    let ReplayRecord::Reference {
        record_ref,
        record_ordinal,
        json_bytes,
        json_sha256,
    } = &batch.records[0]
    else {
        panic!("maximum record requires a bounded reference")
    };
    assert_eq!(*record_ordinal, U64::from(1));
    assert_eq!(json_bytes.get(), MAX_RECORD as u64);
    assert_eq!(json_sha256.as_str(), hash);
    assert_eq!(record_ref.kind.as_str(), "capture_record");
    let mut output = Vec::new();
    for _ in 0..16 {
        let chunk = files
            .read(
                FileReadParams {
                    file_ref: record_ref.clone(),
                    offset: (output.len() as u64).into(),
                    max_bytes: 65536.into(),
                },
                &h.actor,
            )
            .unwrap();
        assert_eq!(chunk.offset.get(), output.len() as u64);
        assert_eq!(chunk.fingerprint, *json_sha256);
        assert!(serde_json::to_vec(&chunk).unwrap().len() < 100_000);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(chunk.bytes_base64.as_str())
            .unwrap();
        assert!(bytes.len() <= 65536);
        output.extend_from_slice(&bytes);
        assert_eq!(chunk.next_offset.get(), output.len() as u64);
        assert_eq!(chunk.at_end, output.len() == MAX_RECORD);
    }
    assert_eq!(output, original_json);
    assert_eq!(
        serde_json::from_slice::<CaptureRecord>(&output).unwrap(),
        expected
    );
    let other = h
        .auth
        .authenticate(&support::id("other-reader"), None)
        .unwrap()
        .actor;
    let read = FileReadParams {
        file_ref: record_ref.clone(),
        offset: 0.into(),
        max_bytes: 1.into(),
    };
    assert_eq!(
        files.read(read.clone(), &other).unwrap_err().code,
        "PERMISSION_DENIED"
    );
    h.auth
        .authorize(
            &user,
            AuthorizeParams {
                client_id: other.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![Target {
                    host_id: source_ref.host_id,
                    kind: source_ref.kind,
                    id: source_ref.id,
                    session_id: None,
                    session_epoch: None,
                }],
                expires_at: None,
            },
        )
        .unwrap();
    assert!(files.read(read, &other).is_ok());
    assert_eq!(h.write_count(), 0);
}

fn source(host: &str, instance: u64, session: &str, epoch: u64) -> CaptureSource {
    CaptureSource {
        host_id: Id::try_from(host).unwrap(),
        instance_epoch: instance.into(),
        session_id: Id::try_from(session).unwrap(),
        session_epoch: epoch.into(),
        configuration_digest: serial_workbench_host::capture::format::zero_digest(),
        configuration: SerialConfiguration::default(),
        time_precision: TimePrecision {
            source: TimeSource::HostRead,
            resolution_ns: 1.into(),
            sync_method: "none".into(),
            offset_estimate_ns: None,
            offset_error_ns: None,
            rtt_ns: None,
        },
    }
}
fn settlement(receipt: TxReceipt) -> CaptureEntry {
    CaptureEntry::TxSettlement(Box::new(CaptureTxSettlement {
        host_id: Id::try_from("h").unwrap(),
        instance_epoch: 1.into(),
        receipt,
    }))
}
