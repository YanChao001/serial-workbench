use serial_workbench_core::*;
use serial_workbench_host::capture::{
    format::CaptureSource,
    recovery::recover_directory,
    replay::ReplayReader,
    verify::verify_directory,
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
    let json_start = 19;
    let json_end = json_start + length;
    let body = std::str::from_utf8(&bytes[json_start..json_end])
        .unwrap()
        .replace("AQID", "CQID");
    assert_ne!(body.as_bytes(), &bytes[json_start..json_end]);
    bytes[json_start..json_end].copy_from_slice(body.as_bytes());
    let hash = Sha256::digest(&bytes[11..json_end]);
    bytes[json_end..].copy_from_slice(&hash);
    std::fs::write(&volume, &bytes).unwrap();
    assert_eq!(replay.read(1, 0).unwrap_err().code, "SOURCE_CHANGED");
}

#[test]
fn mixed_clocks_use_the_recorded_timeline_across_append_and_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("mixed-clocks");
    let sources = vec![source("h", 1, "s", 1), source("peer", 1, "s", 1)];
    let mut writer =
        CaptureWriter::create(&path, sources.clone(), CaptureLimits::default()).unwrap();
    writer.push(timed_rx("h", 0, 999_000), 4000).unwrap();
    writer.push(timed_rx("peer", 0, 1), 4100).unwrap();
    writer.finish().unwrap();

    let mut writer = CaptureWriter::append(&path, sources, CaptureLimits::default()).unwrap();
    writer.push(timed_rx("h", 1, 999_100), 7).unwrap();
    writer.push(timed_rx("peer", 1, 2), 157).unwrap();
    writer.finish().unwrap();

    let recovered = path.with_file_name("recovered");
    recover_directory(&path, &recovered, &verify_directory(&path).unwrap().report).unwrap();
    for source in [&path, &recovered] {
        let mut reader = ReplayReader::open(source, ReplayMode::OriginalTiming).unwrap();
        let first = reader.read(10, 9000).unwrap();
        let [ReplayRecord::Inline { record }] = first.records.as_slice() else {
            panic!("exactly one initial record");
        };
        assert_eq!(record.entry, timed_rx("h", 0, 999_000));
        assert!(reader.read(10, 9099).unwrap().records.is_empty());
        assert_eq!(reader.read(10, 9100).unwrap().records.len(), 2);
        assert!(reader.read(10, 9249).unwrap().records.is_empty());
        let end = reader.read(10, 9250).unwrap();
        assert_eq!(end.records.len(), 1);
        assert!(end.at_end);
    }
}

#[test]
fn replay_rate_changes_rebase_while_running_and_paused() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("timing");
    write_timed_capture(&path, &[100, 200]);

    let mut reader = ReplayReader::open(&path, ReplayMode::OriginalTiming).unwrap();
    let first = reader.read(10, 1000).unwrap();
    assert_eq!(first.records.len(), 1);
    assert!(first.playback.is_none());
    reader
        .set_rate(ReplayRate::Timed { speed_percent: 200 }, 1020)
        .unwrap();
    reader.pause_at(true, 1030);
    reader
        .set_rate(ReplayRate::Timed { speed_percent: 400 }, 9000)
        .unwrap();
    assert!(reader.read(10, 9000).unwrap().records.is_empty());
    reader.pause_at(false, 9050);
    assert!(reader.read(10, 9064).unwrap().records.is_empty());
    assert_eq!(reader.read(10, 9065).unwrap().records.len(), 1);

    reader.seek(1.into(), 10000).unwrap();
    let restarted = reader.read(10, 10000).unwrap();
    assert_eq!(restarted.reader_generation, U64::from(2));
    assert_eq!(restarted.records, first.records);
    assert!(reader.read(10, 10024).unwrap().records.is_empty());
    assert_eq!(reader.read(10, 10025).unwrap().records.len(), 1);
}

#[test]
fn replay_breakpoint_is_reader_local_and_rearms_after_seek() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("breakpoint");
    write_timed_capture(&path, &[100, 200, 300]);

    let mut stopped = ReplayReader::open(&path, ReplayMode::OriginalTiming).unwrap();
    let mut independent = ReplayReader::open(&path, ReplayMode::OriginalTiming).unwrap();
    stopped.set_breakpoint(Some(2.into())).unwrap();
    assert_eq!(stopped.read(10, 1000).unwrap().records.len(), 1);
    assert_eq!(independent.read(10, 1000).unwrap().records.len(), 1);
    assert!(stopped.read(10, 1099).unwrap().records.is_empty());

    let hit = stopped.read(10, 1100).unwrap();
    assert!(hit.records.is_empty());
    assert_eq!(hit.next_record, U64::from(2));
    let unaffected = independent.read(10, 1100).unwrap();
    assert_eq!(unaffected.records.len(), 1);
    assert_eq!(unaffected.next_record, U64::from(3));

    let stepped = stopped.step(5000).unwrap();
    assert_eq!(stepped.records, unaffected.records);
    assert_eq!(stepped.next_record, U64::from(3));
    let playback = stepped.playback.expect("step reports playback");
    assert!(playback.paused);
    assert_eq!(playback.breakpoint_record, Some(U64::from(2)));
    assert!(stopped.read(10, 6000).unwrap().records.is_empty());

    stopped.seek(2.into(), 10000).unwrap();
    stopped.pause_at(false, 10000);
    let hit_again = stopped.read(10, 10000).unwrap();
    assert_eq!(hit_again.reader_generation, U64::from(2));
    assert!(hit_again.records.is_empty());
    assert_eq!(hit_again.next_record, U64::from(2));
    stopped.pause_at(false, 11000);
    let resumed = stopped.read(10, 11000).unwrap();
    assert_eq!(resumed.records, unaffected.records);
    assert_eq!(resumed.next_record, U64::from(3));

    stopped.seek(1.into(), 12000).unwrap();
    assert_eq!(stopped.read(10, 12000).unwrap().records.len(), 1);
    assert!(stopped.read(10, 20000).unwrap().records.is_empty());
    stopped.pause_at(false, 30000);
    assert_eq!(stopped.read(10, 30000).unwrap().records, unaffected.records);
    assert!(stopped.read(10, 30099).unwrap().records.is_empty());
    assert!(stopped.read(10, 30100).unwrap().at_end);
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
        vec![
            source("original-host", 7, "original-session", 9),
            source("peer-host", 1, "other-session", 1),
        ],
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
    replay
        .control(
            ReplayControlParams {
                session_id: opened.session_id.clone(),
                session_epoch: opened.session_epoch,
                paused: true,
                seek_record: None,
                playback: None,
            },
            &h.actor,
        )
        .await
        .unwrap();
    let control = replay
        .control(
            ReplayControlParams {
                session_id: opened.session_id.clone(),
                session_epoch: opened.session_epoch,
                paused: false,
                seek_record: None,
                playback: Some(ReplayPlaybackControl::SetRate {
                    rate: ReplayRate::Timed { speed_percent: 200 },
                }),
            },
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(ActionResult::ReplayPosition(control.clone())).unwrap(),
        serde_json::json!({
            "kind": "replay_position",
            "value": {
                "records": [],
                "readerGeneration": "1",
                "nextRecord": "1",
                "atEnd": false
            }
        })
    );
    let step = ReplayReadParams {
        session_id: opened.session_id,
        session_epoch: opened.session_epoch,
        max_records: 10.into(),
        max_bytes: (256 * 1024).into(),
        single_step: Some(true),
        inspect_playback: None,
        report_playback: Some(true),
        archive: None,
    };
    let conflicting_modes = ReplayReadParams {
        inspect_playback: Some(true),
        ..step.clone()
    };
    assert_eq!(
        replay
            .read(conflicting_modes, &h.actor)
            .await
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
    let inspected = replay
        .read(
            ReplayReadParams {
                single_step: None,
                inspect_playback: Some(true),
                report_playback: None,
                ..step.clone()
            },
            &h.actor,
        )
        .await
        .unwrap();
    assert!(inspected.records.is_empty());
    assert_eq!(inspected.next_record, control.next_record);
    assert_eq!(inspected.reader_generation, control.reader_generation);
    assert!(!inspected.at_end);
    let playback = inspected.playback.unwrap();
    assert!(playback.paused);
    assert_eq!(playback.rate, ReplayRate::Timed { speed_percent: 200 });
    let tiny = ReplayReadParams {
        max_bytes: 1.into(),
        ..step.clone()
    };
    assert_eq!(
        replay.read(tiny, &h.actor).await.unwrap_err().code,
        "LIMIT_EXCEEDED"
    );
    let archive = ReplayReadParams {
        max_bytes: 65536.into(),
        single_step: None,
        report_playback: None,
        archive: Some(ReplayArchiveRange::Before { record: 2.into() }),
        ..step.clone()
    };
    let batch = replay.read(archive, &h.actor).await.unwrap();
    assert!(serde_json::to_vec(&batch).unwrap().len() <= 65536);
    assert_eq!(batch.archive_total_records, Some(1.into()));
    assert_eq!(batch.reader_generation, inspected.reader_generation);
    assert!(batch.playback.is_none());

    let stepped = replay.read(step, &h.actor).await.unwrap();
    assert_eq!(stepped.records.len(), 1);
    assert!(stepped.at_end);
    assert!(stepped.playback.as_ref().is_some_and(|state| state.paused));
    assert_eq!(batch.records.len(), 1);
    assert!(batch.at_end);
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

fn write_timed_capture(path: &std::path::Path, times: &[u64]) {
    let mut writer =
        CaptureWriter::create(path, vec![source("h", 1, "s", 1)], CaptureLimits::default())
            .unwrap();
    for (offset, source_ns) in times.iter().copied().enumerate() {
        writer
            .push(timed_rx("h", offset, source_ns), source_ns)
            .unwrap();
    }
    writer.finish().unwrap();
}

fn timed_rx(host: &str, offset: usize, source_ns: u64) -> CaptureEntry {
    let event: RawEvent = serde_json::from_value(serde_json::json!({
        "hostId": host,
        "instanceEpoch": "1",
        "sessionId": "s",
        "sessionEpoch": "1",
        "eventSeq": (offset + 1).to_string(),
        "configurationRevision": "1",
        "time": {
            "clockId": "c",
            "sourceMonoNs": source_ns.to_string(),
            "receivedWallTime": "2026-11-07T00:00:00Z",
            "precision": {
                "source": "host_read",
                "resolutionNs": "1",
                "syncMethod": "none"
            }
        },
        "kind": "rx",
        "payload": {
            "bytesBase64": "AQ==",
            "byteStart": offset.to_string(),
            "byteEnd": (offset + 1).to_string()
        }
    }))
    .unwrap();
    CaptureEntry::Event(Box::new(event))
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
