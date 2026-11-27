mod support;
use serial_workbench_core::*;
use serial_workbench_host::capture::{
    format::CaptureSource,
    verify::verify_directory,
    writer::{CaptureLimits, CaptureWriter},
};
use std::fs;

fn source() -> CaptureSource {
    CaptureSource {
        host_id: Id::try_from("h").unwrap(),
        instance_epoch: 1.into(),
        session_id: Id::try_from("s").unwrap(),
        session_epoch: 1.into(),
        configuration_digest: Digest::try_from(
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .unwrap(),
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
fn entry(n: u64) -> CaptureEntry {
    CaptureEntry::Event(Box::new(serde_json::from_value(serde_json::json!({"hostId":"h","instanceEpoch":"1","sessionId":"s","sessionEpoch":"1","eventSeq":n.to_string(),"configurationRevision":"1","time":{"clockId":"c","sourceMonoNs":n.to_string(),"receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},"kind":"rx","payload":{"bytesBase64":"AQID","byteStart":((n-1)*3).to_string(),"byteEnd":(n*3).to_string()}})).unwrap()))
}
#[test]
fn indexed_checkpoints_extend_the_same_file_and_recover_only_the_manifest_prefix() {
    use std::io::Write;

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let path = root.join("capture");
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    let index = path.join("index-000001.swbi");
    let original = serial_workbench_host::capture::format::open_read(&index).unwrap();
    assert_eq!(original.metadata().unwrap().len(), 7);

    writer.push(entry(1), 1_000_000_000).unwrap();
    let first = fs::read(&index).unwrap();
    assert_eq!(first.len(), 19);
    assert_eq!(&first[..7], b"SWBI01\n");
    assert_eq!(original.metadata().unwrap().len(), 19);

    writer.push(entry(2), 2_000_000_000).unwrap();
    let second = fs::read(&index).unwrap();
    assert_eq!(second.len(), 31);
    assert_eq!(&second[..first.len()], first.as_slice());
    assert_eq!(original.metadata().unwrap().len(), 31);
    assert_eq!(writer.summary().watermarks.synced.get(), 2);

    writer.push(entry(3), 2_000_000_001).unwrap();
    assert_eq!(writer.summary().watermarks.written.get(), 3);
    assert_eq!(writer.summary().watermarks.synced.get(), 2);
    drop(original);
    drop(writer);

    // Simulate a torn next index entry with the previous atomic manifest still in place.
    let mut file = fs::OpenOptions::new().append(true).open(&index).unwrap();
    file.write_all(b"torn").unwrap();
    file.sync_all().unwrap();
    drop(file);

    let scan = verify_directory(&path).unwrap();
    assert!(!scan.report.container_complete);
    assert!(scan.report.recoverable);
    assert_eq!(scan.report.verified_prefix.get(), 2);
    let incomplete_index = fs::read(&index).unwrap();
    let recovered = root.join("recovered");
    let summary = serial_workbench_host::capture::recovery::recover_directory(
        &path,
        &recovered,
        &scan.report,
    )
    .unwrap();
    assert_eq!(summary.state, CaptureState::Incomplete);
    assert_eq!(summary.watermarks.verified.get(), 2);
    assert_eq!(fs::read(&index).unwrap(), incomplete_index);
    assert!(
        verify_directory(&recovered)
            .unwrap()
            .report
            .container_complete
    );
}

#[test]
fn indexed_orphan_volume_reports_a_verified_prefix_and_can_resume_on_recovered_copy() {
    use serial_workbench_host::capture::{format::fingerprint, recovery::recover_directory};

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    for with_index in [false, true] {
        let path = root.join(format!("capture-{with_index}"));
        let mut writer =
            CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
        writer.push(entry(1), 1).unwrap();
        writer.finish().unwrap();

        fs::write(path.join("volume-000002.swbr"), b"SWBR04\n").unwrap();
        if with_index {
            fs::write(path.join("index-000002.swbi"), b"SWBI01\n").unwrap();
        }
        let scan = verify_directory(&path).unwrap();
        assert!(!scan.report.container_complete);
        assert!(scan.report.recoverable);
        assert_eq!(scan.report.verified_prefix.get(), 1);
        assert_eq!(
            CaptureWriter::append(&path, vec![source()], CaptureLimits::default())
                .err()
                .unwrap()
                .code,
            "CAPTURE_INCOMPLETE"
        );
        let recovered = root.join(format!("recovered-{with_index}"));
        recover_directory(&path, &recovered, &scan.report).unwrap();
        assert_eq!(fingerprint(&path).unwrap(), scan.report.source_fingerprint);

        let mut writer =
            CaptureWriter::append(&recovered, vec![source()], CaptureLimits::default()).unwrap();
        writer.push(entry(2), 2).unwrap();
        assert_eq!(writer.finish().unwrap().watermarks.verified.get(), 2);
    }
}

#[test]
fn indexed_empty_volume_rejects_end_before_start() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().canonicalize().unwrap().join("capture");
    CaptureWriter::create(&path, vec![source()], CaptureLimits::default())
        .unwrap()
        .finish()
        .unwrap();
    let manifest = path.join("manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    value["volumes"][0]["recordEnd"] = serde_json::json!("0");
    fs::write(manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(!verify_directory(&path).unwrap().report.container_complete);
}

#[test]
fn indexed_append_leaves_the_previous_volume_and_index_byte_exact() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("capture");
    let limits = CaptureLimits::default();
    let mut writer = CaptureWriter::create(&path, vec![source()], limits.clone()).unwrap();
    writer.push(entry(1), 1).unwrap();
    writer.finish().unwrap();

    let volume = fs::read(path.join("volume-000001.swbr")).unwrap();
    let index = fs::read(path.join("index-000001.swbi")).unwrap();
    let mut writer = CaptureWriter::append(&path, vec![source()], limits).unwrap();
    writer.push(entry(2), 2).unwrap();
    let result = writer.finish().unwrap();

    assert_eq!(result.watermarks.verified.get(), 2);
    assert!(path.join("index-000002.swbi").exists());
    assert_eq!(fs::read(path.join("volume-000001.swbr")).unwrap(), volume);
    assert_eq!(fs::read(path.join("index-000001.swbi")).unwrap(), index);
}

#[tokio::test]
#[ignore = "Writes and verifies one million native capture records"]
async fn native_indexed_recording_replays_the_millionth_record() {
    use serial_workbench_host::{capture::replay::ReplayService, files::FileService};
    use std::time::Instant;

    const RECORDS: u64 = 1_000_000;
    let h = support::Harness::new().await;
    let path = h.dir.path().canonicalize().unwrap().join("million");
    let started = Instant::now();
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    let CaptureEntry::Event(mut event) = entry(1) else {
        unreachable!()
    };
    for ordinal in 1..=RECORDS {
        event.event_seq = ordinal.into();
        event.time.source_mono_ns = ordinal.into();
        let RawPayload::Rx(payload) = &mut event.payload else {
            unreachable!()
        };
        payload.byte_start = ((ordinal - 1) * 3).into();
        payload.byte_end = (ordinal * 3).into();
        writer
            .push(CaptureEntry::Event(event.clone()), ordinal)
            .unwrap();
    }
    let write_ms = started.elapsed().as_millis();
    let started = Instant::now();
    let summary = writer.finish().unwrap();
    let finish_ms = started.elapsed().as_millis();
    assert_eq!(summary.state, CaptureState::Complete);
    assert_eq!(summary.watermarks.verified.get(), RECORDS);

    let identity = h.store.identity().unwrap();
    let user = h
        .auth
        .authenticate_user_control(
            &support::id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let files = FileService::new(h.store.clone(), h.auth.clone(), identity.clone());
    let registered = Instant::now();
    let capture_ref = files
        .register(
            RegisterFileParams {
                path: path.to_string_lossy().into_owned(),
                purpose: FilePurpose::CaptureSource,
            },
            &user,
        )
        .unwrap();
    let register_ms = registered.elapsed().as_millis();
    let replay = ReplayService::new(files, identity, h.clock.clone());
    let started = Instant::now();
    let opened = replay
        .open(
            ReplayOpenParams {
                capture_ref,
                mode: ReplayMode::Fastest,
            },
            &h.actor,
        )
        .await
        .unwrap();
    let open_ms = started.elapsed().as_millis();
    let read = |archive, max_records: u64| ReplayReadParams {
        session_id: opened.session_id.clone(),
        session_epoch: opened.session_epoch,
        max_records: max_records.into(),
        max_bytes: 65536.into(),
        single_step: None,
        inspect_playback: None,
        report_playback: None,
        archive,
    };
    let started = Instant::now();
    let page = replay
        .read(
            read(
                Some(ReplayArchiveRange::From {
                    record: RECORDS.into(),
                }),
                100,
            ),
            &h.actor,
        )
        .await
        .unwrap();
    let last_page_us = started.elapsed().as_micros();
    assert!(page.at_end);
    assert_eq!(page.archive_total_records, Some(RECORDS.into()));
    assert_eq!(page.next_record, (RECORDS + 1).into());
    let [ReplayRecord::Inline { record }] = page.records.as_slice() else {
        panic!("the last record must fit in an inline replay page")
    };
    let CaptureEntry::Event(event) = &record.entry else {
        panic!("expected RX")
    };
    let RawPayload::Rx(payload) = &event.payload else {
        panic!("expected RX")
    };
    assert_eq!(record.record_ordinal.get(), RECORDS);
    assert_eq!(event.event_seq.get(), RECORDS);
    assert_eq!(payload.byte_start.get(), (RECORDS - 1) * 3);
    assert_eq!(payload.byte_end.get(), RECORDS * 3);
    assert_eq!(payload.bytes_base64.as_str(), "AQID");
    let started = Instant::now();
    let previous = replay
        .read(
            read(
                Some(ReplayArchiveRange::Before {
                    record: RECORDS.into(),
                }),
                100,
            ),
            &h.actor,
        )
        .await
        .unwrap();
    let previous_page_us = started.elapsed().as_micros();
    assert_eq!(previous.records.len(), 100);
    assert_eq!(previous.next_record, RECORDS.into());
    assert!(!previous.at_end);
    assert!(matches!(
        previous.records.as_slice(),
        [ReplayRecord::Inline { record: first }, .., ReplayRecord::Inline { record: last }]
            if first.record_ordinal.get() == RECORDS - 100 && last.record_ordinal.get() == RECORDS - 1
    ));
    let inspected = replay
        .read(
            ReplayReadParams {
                inspect_playback: Some(true),
                ..read(None, 1)
            },
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(inspected.next_record.get(), 1);
    assert_eq!(inspected.reader_generation, page.reader_generation);
    assert_eq!(h.write_count(), 0);

    let indexes: Vec<_> = fs::read_dir(&path)
        .unwrap()
        .map(|entry| entry.unwrap())
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "swbi"))
        .map(|entry| entry.metadata().unwrap().len())
        .collect();
    assert!(indexes.len() > 1);
    assert_eq!(
        indexes.iter().sum::<u64>(),
        RECORDS * 12 + indexes.len() as u64 * 7
    );
    println!(
        "{}",
        serde_json::json!({
            "records": RECORDS, "volumes": indexes.len(), "indexBytes": indexes.iter().sum::<u64>(),
            "writeMs": write_ms, "finishMs": finish_ms, "registerMs": register_ms, "openMs": open_ms,
            "lastPageUs": last_page_us, "previousPageUs": previous_page_us,
        })
    );
}

#[test]
fn stop_requires_index_and_independent_readback() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("capture");
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    writer.push(entry(1), 0).unwrap();
    writer.push(entry(2), 1).unwrap();
    let summary = writer.finish().unwrap();
    assert_eq!(summary.state, CaptureState::Complete);
    assert_eq!(summary.watermarks.verified, U64::from(2));
    let scan = verify_directory(&path).unwrap();
    assert_eq!(scan.report.verified_prefix, U64::from(2));
    assert!(scan.report.container_complete);
    fs::remove_file(path.join("index-000001.swbi")).unwrap();
    let scan = verify_directory(&path).unwrap();
    assert!(!scan.report.container_complete);
    assert_eq!(scan.report.verified_prefix, U64::from(0));
}
#[test]
fn records_rotate_whole_and_corruption_stops_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("capture");
    let limits = CaptureLimits {
        volume_bytes: 800,
        ..CaptureLimits::default()
    };
    let mut writer = CaptureWriter::create(&path, vec![source()], limits).unwrap();
    for n in 1..=4 {
        writer.push(entry(n), n).unwrap();
    }
    writer.finish().unwrap();
    let second = path.join("volume-000002.swbr");
    let mut data = fs::read(&second).unwrap();
    data[20] ^= 1;
    fs::write(second, data).unwrap();
    let scan = verify_directory(&path).unwrap();
    assert_eq!(scan.report.verified_prefix, U64::from(1));
    assert!(!scan.report.container_complete);
}
#[cfg(windows)]
#[test]
fn stop_verifies_complete_capture_while_a_shared_manifest_reader_remains_open() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("capture");
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    writer.push(entry(1), 0).unwrap();
    let mut reader =
        serial_workbench_host::capture::format::open_read(&path.join("manifest.json")).unwrap();
    let summary = writer.finish().unwrap();
    assert_eq!(summary.state, CaptureState::Complete);
    assert_eq!(summary.watermarks.verified, U64::from(1));
    let scan = verify_directory(&path).unwrap();
    assert!(scan.report.container_complete);
    assert_eq!(scan.report.verified_prefix, U64::from(1));
    let mut old = String::new();
    std::io::Read::read_to_string(&mut reader, &mut old).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&old).unwrap()["state"],
        "recording"
    );
}
#[test]
fn capacity_failure_preserves_written_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("capture");
    let limits = CaptureLimits {
        capacity_bytes: 4096,
        ..CaptureLimits::default()
    };
    let mut writer = CaptureWriter::create(&path, vec![source()], limits).unwrap();
    let mut accepted = 0;
    for ordinal in 1..20 {
        match writer.push(entry(ordinal), ordinal) {
            Ok(()) => accepted += 1,
            Err(error) => {
                assert_eq!(error.code, "CAPTURE_IO_FAILED");
                break;
            }
        }
    }
    assert!(accepted > 0 && accepted < 19);
    assert_eq!(writer.summary().state, CaptureState::Failed);
    assert_eq!(writer.summary().watermarks.written, U64::from(accepted));
}
#[test]
fn future_format_is_read_only_and_append_checks_configuration() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("future");
    CaptureWriter::create(&path, vec![source()], CaptureLimits::default())
        .unwrap()
        .finish()
        .unwrap();
    let mut other = source();
    other.session_epoch = 2.into();
    assert_eq!(
        CaptureWriter::append(&path, vec![other], CaptureLimits::default())
            .err()
            .unwrap()
            .code,
        "CONFIGURATION_CONFLICT"
    );
    let p = path.join("manifest.json");
    let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
    manifest["formatVersion"] = "9.0".into();
    let before = serde_json::to_vec(&manifest).unwrap();
    fs::write(&p, &before).unwrap();
    assert_eq!(verify_directory(&path).err().unwrap().code, "FUTURE_FORMAT");
    assert_eq!(fs::read(&p).unwrap(), before);
}
#[test]
fn append_starts_new_volume_without_rewriting_prior_volume() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("capture");
    let mut w = CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    w.push(entry(1), 0).unwrap();
    w.finish().unwrap();
    let before = fs::read(path.join("volume-000001.swbr")).unwrap();
    let mut w = CaptureWriter::append(&path, vec![source()], CaptureLimits::default()).unwrap();
    w.push(entry(2), 1).unwrap();
    w.finish().unwrap();
    assert_eq!(fs::read(path.join("volume-000001.swbr")).unwrap(), before);
    assert!(path.join("volume-000002.swbr").exists());
    assert_eq!(
        verify_directory(&path).unwrap().report.verified_prefix,
        U64::from(2)
    );
}

#[test]
fn declared_source_gap_is_structurally_complete_but_not_continuous() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("gap");
    let mut w = CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    let CaptureEntry::Event(mut event) = entry(1) else {
        unreachable!()
    };
    event.payload = RawPayload::Gap(SourceGap {
        reason: SourceGapReason::SourceUnknown,
        known_extent: false,
        missing_event_range: None,
        missing_byte_range: None,
        direction: None,
    });
    w.push(CaptureEntry::Event(event), 0).unwrap();
    let summary = w.finish().unwrap();
    assert_eq!(summary.state, CaptureState::Complete);
    assert!(summary.container_complete);
    assert!(!summary.source_continuous);
}
#[test]
fn duplicate_tx_settlement_cannot_silently_replace_evidence() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("tx");
    let mut w = CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    let receipt:TxReceipt=serde_json::from_value(serde_json::json!({"operationId":"o","sessionId":"s","sessionEpoch":"1","outcome":"accepted","bytesBase64":"AQ==","byteStart":"0","byteEnd":"1","acceptedRanges":[{"start":"0","end":"1"}],"unknownRanges":[],"peerAcknowledged":false})).unwrap();
    let settlement = CaptureTxSettlement {
        host_id: source().host_id,
        instance_epoch: 1.into(),
        receipt,
    };
    w.push(CaptureEntry::TxSettlement(Box::new(settlement.clone())), 0)
        .unwrap();
    assert_eq!(
        w.push(CaptureEntry::TxSettlement(Box::new(settlement)), 0)
            .unwrap_err()
            .code,
        "CAPTURE_CORRUPT"
    );
}
#[test]
fn replacement_archives_exact_original_and_requires_expected_fingerprint() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("capture");
    let mut w = CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    w.push(entry(1), 0).unwrap();
    w.finish().unwrap();
    let before = fs::read(path.join("volume-000001.swbr")).unwrap();
    let verified = verify_directory(&path).unwrap();
    let wrong =
        Digest::try_from("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
            .unwrap();
    assert_eq!(
        CaptureWriter::replace(&path, vec![source()], CaptureLimits::default(), &wrong)
            .err()
            .unwrap()
            .code,
        "SOURCE_CHANGED"
    );
    let mut replacement = CaptureWriter::replace(
        &path,
        vec![source()],
        CaptureLimits::default(),
        &verified.report.source_fingerprint,
    )
    .unwrap();
    replacement.push(entry(2), 1).unwrap();
    replacement.finish().unwrap();
    let archives: Vec<_> = fs::read_dir(d.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().contains("archive"))
        .collect();
    assert_eq!(archives.len(), 1);
    assert_eq!(
        fs::read(archives[0].join("volume-000001.swbr")).unwrap(),
        before
    );
    assert_ne!(fs::read(path.join("volume-000001.swbr")).unwrap(), before);
}
#[tokio::test]
async fn service_records_real_tx_stream_and_finishes_after_stop() {
    use serial_workbench_host::{
        capture::{CaptureRuntime, CaptureService},
        files::FileService,
    };
    let h = support::Harness::new().await;
    let target = h.open("capture-device").await;
    let user = h
        .auth
        .authenticate_user_control(
            h.actor.client_id(),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    h.auth
        .authorize(
            &user,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["workspace.modify".into()],
                targets: vec![Target {
                    host_id: h.host_id.clone(),
                    kind: ResourceKind::try_from("host").unwrap(),
                    id: h.host_id.clone(),
                    session_id: None,
                    session_epoch: None,
                }],
                expires_at: None,
            },
        )
        .unwrap();
    let identity = h.store.identity().unwrap();
    let files = FileService::new(h.store.clone(), h.auth.clone(), identity.clone());
    let reference = files
        .register(
            RegisterFileParams {
                path: h
                    .dir
                    .path()
                    .join("live-capture")
                    .to_string_lossy()
                    .into_owned(),
                purpose: FilePurpose::CaptureTarget,
            },
            &user,
        )
        .unwrap();
    let service = CaptureService::new(CaptureRuntime {
        store: h.store.clone(),
        auth: h.auth.clone(),
        identity: identity.clone(),
        files: files.clone(),
        streams: h.host.streams().clone(),
        devices: h.host.devices().clone(),
        clock: h.clock.clone(),
    });
    let mut call = h.call(&target, "capture.start", serde_json::json!({}));
    call.execution_mode = Some(ExecutionMode::Independent);
    let digest = serial_workbench_host::storage::canonical_digest(&call).unwrap();
    let serial_workbench_host::storage::Acceptance::New(owner) =
        h.store.accept(&h.actor, &call, &digest).unwrap()
    else {
        panic!("new capture owner")
    };
    h.store.mark_dispatch(&owner.operation_id).unwrap();
    let owner = h.store.get(&h.actor, &owner.operation_id).unwrap();
    let capture = service
        .start(
            CaptureStartParams {
                session_refs: vec![target.clone()],
                target_ref: reference,
                mode: CaptureMode::Raw,
                redaction_rules: None,
                overflow_policy: OverflowPolicy::Stop,
                write_mode: CaptureWriteMode::CreateNew,
                expected_fingerprint: None,
                storage_limits: None,
            },
            &owner,
            &h.actor,
        )
        .await
        .unwrap();
    h.send(&target).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if service
                .status(&capture, &h.actor)
                .await
                .unwrap()
                .watermarks
                .written
                >= U64::from(2)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let summary = service.stop(&capture, &h.actor).await.unwrap();
    assert_eq!(summary.state, CaptureState::Complete);
    assert_eq!(summary.watermarks.verified, U64::from(2));
    assert!(summary.container_complete);
    let writes = h.write_count();
    let replay = serial_workbench_host::capture::replay::ReplayService::new(
        files,
        identity,
        h.clock.clone(),
    );
    let opened = replay
        .open(
            ReplayOpenParams {
                capture_ref: capture,
                mode: ReplayMode::Fastest,
            },
            &h.actor,
        )
        .await
        .unwrap();
    let records = replay
        .read(
            ReplayReadParams {
                session_id: opened.session_id.clone(),
                session_epoch: opened.session_epoch,
                max_records: 10.into(),
                max_bytes: 65536.into(),
                single_step: None,
                inspect_playback: None,
                report_playback: None,
                archive: None,
            },
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(records.records.len(), 2);
    assert!(
        serde_json::to_value(&records)
            .unwrap()
            .get("playback")
            .is_none()
    );
    let replay_target = Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id.clone()),
        session_epoch: Some(opened.session_epoch),
    };
    let snapshot = replay.snapshot(&replay_target, &h.actor).await.unwrap();
    assert!(snapshot.read_only);
    assert!(!snapshot.capabilities.configuration);
    let reset = replay
        .control(
            ReplayControlParams {
                session_id: opened.session_id.clone(),
                session_epoch: opened.session_epoch,
                paused: true,
                seek_record: Some(1.into()),
                playback: None,
            },
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(reset.reader_generation, U64::from(2));
    let read = ReplayReadParams {
        session_id: opened.session_id.clone(),
        session_epoch: opened.session_epoch,
        max_records: 10.into(),
        max_bytes: 65536.into(),
        single_step: None,
        inspect_playback: None,
        report_playback: None,
        archive: None,
    };
    assert!(
        replay
            .read(read.clone(), &h.actor)
            .await
            .unwrap()
            .records
            .is_empty()
    );
    let browse = |archive, max_records: u64| ReplayReadParams {
        archive: Some(archive),
        max_records: max_records.into(),
        ..read.clone()
    };
    let tail = replay
        .read(
            browse(ReplayArchiveRange::From { record: 2.into() }, 1),
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(tail.records, records.records[1..2]);
    assert_eq!(tail.reader_generation, reset.reader_generation);
    assert_eq!(tail.next_record, U64::from(3));
    assert!(tail.at_end);
    assert_eq!(tail.archive_total_records, Some(2.into()));
    assert!(tail.playback.is_none());
    let previous = replay
        .read(
            browse(ReplayArchiveRange::Before { record: 2.into() }, 1),
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(previous.records, records.records[0..1]);
    assert_eq!(previous.next_record, U64::from(2));
    assert!(!previous.at_end);
    let backwards = replay
        .read(
            browse(ReplayArchiveRange::Before { record: 3.into() }, 2),
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(backwards.records, records.records);
    assert!(backwards.at_end);
    let beyond_end = replay
        .read(
            browse(ReplayArchiveRange::From { record: 4.into() }, 1),
            &h.actor,
        )
        .await
        .unwrap_err();
    assert_eq!(beyond_end.code, "INVALID_ARGUMENT");
    let conflicting = ReplayReadParams {
        inspect_playback: Some(true),
        ..browse(ReplayArchiveRange::From { record: 1.into() }, 1)
    };
    assert_eq!(
        replay.read(conflicting, &h.actor).await.unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    let unchanged = replay
        .read(
            ReplayReadParams {
                inspect_playback: Some(true),
                ..read.clone()
            },
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(unchanged.next_record, reset.next_record);
    assert_eq!(unchanged.reader_generation, reset.reader_generation);
    assert!(unchanged.playback.unwrap().paused);

    let stale = ReplayReadParams {
        session_epoch: 0.into(),
        ..browse(ReplayArchiveRange::From { record: 1.into() }, 2)
    };
    assert_eq!(
        replay.read(stale, &h.actor).await.unwrap_err().code,
        "EPOCH_MISMATCH"
    );
    replay
        .control(
            ReplayControlParams {
                session_id: opened.session_id,
                session_epoch: opened.session_epoch,
                paused: false,
                seek_record: None,
                playback: None,
            },
            &h.actor,
        )
        .await
        .unwrap();
    assert_eq!(
        replay.read(read.clone(), &h.actor).await.unwrap().records,
        records.records
    );
    assert_eq!(
        replay.close(&replay_target, &h.actor).await.unwrap().state,
        SessionState::Closed
    );
    assert_eq!(
        replay.read(read, &h.actor).await.unwrap_err().code,
        "BACKEND_DISCONNECTED"
    );
    assert_eq!(h.write_count(), writes);
}

#[test]
fn text_export_marks_replacement_and_preserves_original_locator() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("text-source");
    let text = d.path().canonicalize().unwrap().join("export.jsonl");
    let mut w = CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    let CaptureEntry::Event(mut event) = entry(1) else {
        unreachable!()
    };
    let RawPayload::Rx(ref mut rx) = event.payload else {
        unreachable!()
    };
    rx.bytes_base64 = Bytes::try_from("/w==").unwrap();
    rx.byte_end = 1.into();
    w.push(CaptureEntry::Event(event), 0).unwrap();
    w.finish().unwrap();
    serial_workbench_host::capture::text_export::export_text(&path, &text).unwrap();
    let row: serde_json::Value = serde_json::from_slice(&fs::read(text).unwrap()).unwrap();
    assert_eq!(row["text"], "�");
    assert_eq!(row["hadReplacement"], true);
    assert_eq!(row["byteStart"], "0");
    assert_eq!(row["recordOffset"], "7");
    assert_eq!(row["volume"], "1");
    assert_eq!(row["direction"], "rx");
}

#[test]
fn manifest_commit_failure_never_advances_synced_or_verified() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("manifest-fault");
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    fs::remove_file(path.join("manifest.json")).unwrap();
    fs::create_dir(path.join("manifest.json")).unwrap();
    assert_eq!(
        writer.push(entry(1), 1_000_000_000).unwrap_err().code,
        "CAPTURE_IO_FAILED"
    );
    let summary = writer.summary();
    assert_eq!(summary.state, CaptureState::Failed);
    assert_eq!(summary.watermarks.written, U64::from(1));
    assert_eq!(summary.watermarks.synced, U64::from(0));
    assert_eq!(summary.watermarks.verified, U64::from(0));
}

#[tokio::test]
async fn capture_resource_is_distinct_from_location_and_finalized_ref_is_fixed() {
    use serial_workbench_host::{
        capture::{CaptureRuntime, CaptureService},
        files::FileService,
        storage::{Acceptance, canonical_digest},
    };
    let h = support::Harness::new().await;
    let session = h.open("resource-ref").await;
    let user = h
        .auth
        .authenticate_user_control(
            h.actor.client_id(),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let identity = h.store.identity().unwrap();
    let files = FileService::new(h.store.clone(), h.auth.clone(), identity.clone());
    let location = files
        .register(
            RegisterFileParams {
                path: h
                    .dir
                    .path()
                    .canonicalize()
                    .unwrap()
                    .join("resource")
                    .to_string_lossy()
                    .into_owned(),
                purpose: FilePurpose::CaptureTarget,
            },
            &user,
        )
        .unwrap();
    h.auth
        .authorize(
            &user,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["workspace.modify".into()],
                targets: vec![Target {
                    host_id: location.host_id.clone(),
                    kind: location.kind.clone(),
                    id: location.id.clone(),
                    session_id: None,
                    session_epoch: None,
                }],
                expires_at: None,
            },
        )
        .unwrap();
    let service = CaptureService::new(CaptureRuntime {
        store: h.store.clone(),
        auth: h.auth.clone(),
        identity,
        files: files.clone(),
        streams: h.host.streams().clone(),
        devices: h.host.devices().clone(),
        clock: h.clock.clone(),
    });
    let mut call = h.call(&session, "capture.start", serde_json::json!({}));
    call.execution_mode = Some(ExecutionMode::Independent);
    let Acceptance::New(owner) = h
        .store
        .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!("new")
    };
    h.store.mark_dispatch(&owner.operation_id).unwrap();
    let owner = h.store.get(&h.actor, &owner.operation_id).unwrap();
    let capture = service
        .start(
            CaptureStartParams {
                session_refs: vec![session],
                target_ref: location.clone(),
                mode: CaptureMode::Raw,
                redaction_rules: None,
                overflow_policy: OverflowPolicy::Stop,
                write_mode: CaptureWriteMode::CreateNew,
                expected_fingerprint: None,
                storage_limits: None,
            },
            &owner,
            &h.actor,
        )
        .await
        .unwrap();
    let summary = service.stop(&capture, &h.actor).await.unwrap();
    assert_ne!(capture.id, location.id);
    assert_eq!(capture.id, summary.capture_id);
    assert_eq!(capture.kind.as_str(), "capture");
    assert_eq!(location.kind.as_str(), "file");
    assert!(capture.revision.is_none());
    assert!(
        files
            .metadata(&capture, &h.actor)
            .unwrap()
            .file_ref
            .revision
            .is_some()
    );
    h.auth
        .revoke(
            &user,
            RevokeParams {
                actor_id: h.actor.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![Target {
                    host_id: location.host_id.clone(),
                    kind: location.kind.clone(),
                    id: location.id.clone(),
                    session_id: None,
                    session_epoch: None,
                }],
            },
        )
        .unwrap();
    assert_eq!(
        service.verify(&capture, &h.actor).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    assert!(files.metadata(&capture, &h.actor).is_ok());
}

#[tokio::test]
async fn capture_accounts_for_reader_reservations_before_any_record_is_queued() {
    use serial_workbench_host::{
        capture::{CaptureRuntime, CaptureService},
        files::FileService,
        storage::{Acceptance, canonical_digest},
    };
    let h = support::Harness::new().await;
    let session = h.open("reserved-reader").await;
    let user = h
        .auth
        .authenticate_user_control(
            h.actor.client_id(),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let identity = h.store.identity().unwrap();
    let files = FileService::new(h.store.clone(), h.auth.clone(), identity.clone());
    let location = files
        .register(
            RegisterFileParams {
                path: h
                    .dir
                    .path()
                    .canonicalize()
                    .unwrap()
                    .join("reserved")
                    .to_string_lossy()
                    .into_owned(),
                purpose: FilePurpose::CaptureTarget,
            },
            &user,
        )
        .unwrap();
    h.auth
        .authorize(
            &user,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["workspace.modify".into()],
                targets: vec![Target {
                    host_id: location.host_id.clone(),
                    kind: location.kind.clone(),
                    id: location.id.clone(),
                    session_id: None,
                    session_epoch: None,
                }],
                expires_at: None,
            },
        )
        .unwrap();
    let service = CaptureService::new(CaptureRuntime {
        store: h.store.clone(),
        auth: h.auth.clone(),
        identity,
        files,
        streams: h.host.streams().clone(),
        devices: h.host.devices().clone(),
        clock: h.clock.clone(),
    });
    let mut call = h.call(&session, "capture.start", serde_json::json!({}));
    call.execution_mode = Some(ExecutionMode::Independent);
    let Acceptance::New(owner) = h
        .store
        .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!("new capture")
    };
    h.store.mark_dispatch(&owner.operation_id).unwrap();
    let owner = h.store.get(&h.actor, &owner.operation_id).unwrap();
    let reference = service
        .start(
            CaptureStartParams {
                session_refs: vec![session],
                target_ref: location,
                mode: CaptureMode::Raw,
                redaction_rules: None,
                overflow_policy: OverflowPolicy::Stop,
                write_mode: CaptureWriteMode::CreateNew,
                expected_fingerprint: None,
                storage_limits: None,
            },
            &owner,
            &h.actor,
        )
        .await
        .unwrap();
    let usage = service.memory_usage();
    service.stop(&reference, &h.actor).await.unwrap();
    assert!(
        usage.queued_bytes >= 4 * 1024 * 1024,
        "upstream reader reservation must consume capture budget"
    );
    assert!(usage.queued_bytes <= 16 * 1024 * 1024);
    assert_eq!(service.memory_usage().queued_bytes, 0);
}

#[derive(Default)]
struct CaptureGate {
    entered: std::sync::atomic::AtomicBool,
    released: std::sync::Mutex<bool>,
    wake: std::sync::Condvar,
}
impl CaptureGate {
    fn hold(&self) {
        self.entered
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut released = self.released.lock().unwrap();
        while !*released {
            released = self.wake.wait(released).unwrap();
        }
    }
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.wake.notify_all();
    }
}
struct FaultVolume {
    file: std::fs::File,
    fail_sync_when_armed: bool,
    remaining: Option<usize>,
    gate: Option<std::sync::Arc<CaptureGate>>,
    armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl std::io::Write for FaultVolume {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.armed.load(std::sync::atomic::Ordering::SeqCst)
            && let Some(gate) = &self.gate
        {
            gate.hold();
        }
        if let Some(left) = &mut self.remaining {
            if *left == 0 {
                return Err(std::io::Error::from_raw_os_error(if cfg!(windows) {
                    112
                } else {
                    28
                }));
            }
            let n = std::io::Write::write(&mut self.file, &bytes[..bytes.len().min(*left)])?;
            *left -= n;
            Ok(n)
        } else {
            std::io::Write::write(&mut self.file, bytes)
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        std::io::Write::flush(&mut self.file)
    }
}
impl serial_workbench_host::capture::writer::CaptureVolume for FaultVolume {
    fn sync_all(&mut self) -> std::io::Result<()> {
        if self.fail_sync_when_armed && self.armed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(std::io::Error::other("injected final sync failure"));
        }
        self.file.sync_all()
    }
    fn length(&self) -> std::io::Result<u64> {
        Ok(self.file.metadata()?.len())
    }
}
fn fault_opener(
    remaining: Option<usize>,
    gate: Option<std::sync::Arc<CaptureGate>>,
    armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> serial_workbench_host::capture::writer::VolumeOpener {
    std::sync::Arc::new(move |file| {
        Ok(Box::new(FaultVolume {
            file,
            fail_sync_when_armed: false,
            remaining,
            gate: gate.clone(),
            armed: armed.clone(),
        }))
    })
}
#[test]
fn actual_partial_volume_write_failure_preserves_the_uncommitted_tail() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap().join("partial-disk");
    let opener = fault_opener(
        Some(19),
        None,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    );
    let mut writer =
        CaptureWriter::create_with_storage(&path, vec![source()], CaptureLimits::default(), opener)
            .unwrap();
    let result = writer.push(entry(1), 0);
    assert_eq!(result.unwrap_err().code, "CAPTURE_IO_FAILED");
    assert_eq!(writer.summary().state, CaptureState::Failed);
    assert_eq!(writer.summary().watermarks.written, U64::from(0));
    assert_eq!(
        fs::metadata(path.join("volume-000001.swbr")).unwrap().len(),
        19
    );
    drop(writer);
    let scan = verify_directory(&path).unwrap();
    assert!(!scan.report.container_complete);
    assert_eq!(scan.report.verified_prefix, U64::from(0));
}
struct FaultCapture {
    h: support::Harness,
    streams: serial_workbench_host::stream::StreamHub,
    source: serial_workbench_host::stream::StreamSource,
    fast: serial_workbench_host::stream::RawSubscription,
    service: serial_workbench_host::capture::CaptureService,
    reference: ObjectRef,
    owner_operation_id: Id,
    credit: u64,
}
impl FaultCapture {
    async fn new(opener: serial_workbench_host::capture::writer::VolumeOpener) -> Self {
        use serial_workbench_host::{
            capture::{CaptureRuntime, CaptureService},
            files::FileService,
            storage::{Acceptance, canonical_digest},
            stream::{StreamHub, StreamKey, StreamLimits},
        };
        let h = support::Harness::new().await;
        let session = h.open("capture-io-fault").await;
        let identity = h.store.identity().unwrap();
        let streams = StreamHub::new(identity.clone(), h.auth.clone(), StreamLimits::default());
        let source = streams
            .register_source(
                StreamKey {
                    session_id: session.id.clone(),
                    session_epoch: session.session_epoch.unwrap(),
                },
                session.clone(),
            )
            .unwrap();
        let user = h
            .auth
            .authenticate_user_control(
                h.actor.client_id(),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let files = FileService::new(h.store.clone(), h.auth.clone(), identity.clone());
        let location = files
            .register(
                RegisterFileParams {
                    path: h
                        .dir
                        .path()
                        .canonicalize()
                        .unwrap()
                        .join("io-fault")
                        .to_string_lossy()
                        .into_owned(),
                    purpose: FilePurpose::CaptureTarget,
                },
                &user,
            )
            .unwrap();
        h.auth
            .authorize(
                &user,
                AuthorizeParams {
                    client_id: h.actor.client_id().clone(),
                    permissions: vec!["workspace.modify".into()],
                    targets: vec![Target {
                        host_id: location.host_id.clone(),
                        kind: location.kind.clone(),
                        id: location.id.clone(),
                        session_id: None,
                        session_epoch: None,
                    }],
                    expires_at: None,
                },
            )
            .unwrap();
        let initial = source.initial_cursor();
        let fast = streams
            .subscribe(
                &h.actor,
                StreamSubscribeParams {
                    scope_id: initial.scope_id.clone(),
                    after: initial,
                    queue_bytes: (4 * 1024 * 1024).into(),
                    initial_credit_bytes: (4 * 1024 * 1024).into(),
                    overflow_policy: OverflowPolicy::Stop,
                },
            )
            .await
            .unwrap();
        let service = CaptureService::with_storage(
            CaptureRuntime {
                store: h.store.clone(),
                auth: h.auth.clone(),
                identity,
                files,
                streams: streams.clone(),
                devices: h.host.devices().clone(),
                clock: h.clock.clone(),
            },
            CaptureLimits::default(),
            opener,
        );
        let mut call = h.call(&session, "capture.start", serde_json::json!({}));
        call.execution_mode = Some(ExecutionMode::Independent);
        let Acceptance::New(owner) = h
            .store
            .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
            .unwrap()
        else {
            panic!("new capture")
        };
        h.store.mark_dispatch(&owner.operation_id).unwrap();
        let owner = h.store.get(&h.actor, &owner.operation_id).unwrap();
        let reference = service
            .start(
                CaptureStartParams {
                    session_refs: vec![session],
                    target_ref: location,
                    mode: CaptureMode::Raw,
                    redaction_rules: None,
                    overflow_policy: OverflowPolicy::Stop,
                    write_mode: CaptureWriteMode::CreateNew,
                    expected_fingerprint: None,
                    storage_limits: None,
                },
                &owner,
                &h.actor,
            )
            .await
            .unwrap();
        Self {
            h,
            streams,
            source,
            fast,
            service,
            reference,
            owner_operation_id: owner.operation_id,
            credit: 4 * 1024 * 1024,
        }
    }
    async fn emit(&mut self, ordinal: u64) {
        let CaptureEntry::Event(event) = entry(ordinal) else {
            unreachable!()
        };
        self.source
            .append_rx(
                serial_workbench_host::stream::SourceMeta {
                    configuration_revision: 1.into(),
                    time: event.time,
                },
                std::sync::Arc::from(vec![(ordinal % 255) as u8; 16384]),
                None,
            )
            .unwrap();
        let batch = tokio::time::timeout(std::time::Duration::from_secs(5), self.fast.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let StreamItem::Source { event } = batch.batch().items.last().unwrap() else {
            panic!("fast reader lost RX")
        };
        assert_eq!(event.event_seq, U64::from(ordinal));
        assert!(matches!(event.payload, RawPayload::Rx(_)));
        self.fast.mark_sent(&batch).unwrap();
        self.credit += serde_json::to_vec(batch.batch()).unwrap().len() as u64;
        self.streams
            .credit(
                &self.h.actor,
                StreamCreditParams {
                    subscription_id: self.fast.id().clone(),
                    ack_cursor: batch.batch().cursor.clone(),
                    granted_bytes_total: self.credit.into(),
                },
            )
            .await
            .unwrap();
    }
}
#[tokio::test]
async fn slow_capture_overflow_does_not_block_rx_or_the_fast_reader() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let gate = Arc::new(CaptureGate::default());
    struct Release(Arc<CaptureGate>);
    impl Drop for Release {
        fn drop(&mut self) {
            self.0.release();
        }
    }
    let _release = Release(gate.clone());
    let armed = Arc::new(AtomicBool::new(false));
    let mut f = FaultCapture::new(fault_opener(None, Some(gate.clone()), armed.clone())).await;
    armed.store(true, Ordering::SeqCst);
    f.emit(1).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if gate.entered.load(Ordering::SeqCst)
                || f.service
                    .status(&f.reference, &f.h.actor)
                    .await
                    .unwrap()
                    .watermarks
                    .written
                    .get()
                    > 0
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    if !gate.entered.load(Ordering::SeqCst) {
        f.service.stop(&f.reference, &f.h.actor).await.unwrap();
        panic!("capture must use the injected real-file writer");
    }
    for ordinal in 2..=400 {
        f.emit(ordinal).await;
    }
    assert!(f.service.memory_usage().peak_queued_bytes <= 16 * 1024 * 1024);
    gate.release();
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        f.service.wait(&f.reference),
    )
    .await
    .unwrap();
    assert!(outcome.is_err());
    assert_eq!(
        f.service
            .status(&f.reference, &f.h.actor)
            .await
            .unwrap()
            .state,
        CaptureState::Failed
    );
    assert_eq!(f.service.memory_usage().queued_bytes, 0);
    f.emit(401).await;
    f.fast.close();
}

fn chunk_receipt(start: u64) -> TxReceipt {
    serde_json::from_value(serde_json::json!({"operationId":"file-owner","sessionId":"s","sessionEpoch":"1","outcome":"accepted","bytesBase64":"AQ==","byteStart":start.to_string(),"byteEnd":(start+1).to_string(),"acceptedRanges":[{"start":start.to_string(),"end":(start+1).to_string()}],"unknownRanges":[],"peerAcknowledged":false})).unwrap()
}
fn chunk_entry(sequence: u64, start: u64, settled: bool) -> CaptureEntry {
    let CaptureEntry::Event(mut event) = entry(sequence) else {
        unreachable!()
    };
    event.payload = if settled {
        RawPayload::Tx(Box::new(chunk_receipt(start)))
    } else {
        RawPayload::TxIntent(TxIntent {
            operation_id: Id::try_from("file-owner").unwrap(),
            bytes_base64: Bytes::try_from("AQ==").unwrap(),
            byte_start: start.into(),
            byte_end: (start + 1).into(),
        })
    };
    CaptureEntry::Event(event)
}
#[test]
fn one_transfer_owner_settles_multiple_chunks_without_losing_pending_spans() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("chunks");
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    writer.push(chunk_entry(1, 0, false), 0).unwrap();
    writer.push(chunk_entry(2, 1, false), 1).unwrap();
    writer.push(chunk_entry(3, 0, true), 2).unwrap();
    writer.finish().unwrap();
    assert_eq!(
        verify_directory(&path).unwrap().report.unsettled_operations,
        vec![Id::try_from("file-owner").unwrap()]
    );
    let mut writer =
        CaptureWriter::append(&path, vec![source()], CaptureLimits::default()).unwrap();
    writer.push(chunk_entry(4, 1, true), 3).unwrap();
    writer.finish().unwrap();
    let report = verify_directory(&path).unwrap().report;
    assert!(report.container_complete);
    assert!(report.unsettled_operations.is_empty());
}
#[test]
fn publish_does_not_replace_an_existing_regular_file() {
    let d = tempfile::tempdir().unwrap();
    let parent = d.path().canonicalize().unwrap();
    let source = parent.join("candidate.txt");
    let target = parent.join("existing.txt");
    fs::write(&source, b"candidate").unwrap();
    fs::write(&target, b"original").unwrap();
    assert_eq!(
        serial_workbench_host::capture::format::rename_no_replace(&source, &target)
            .unwrap_err()
            .code,
        "TARGET_EXISTS"
    );
    assert_eq!(fs::read(source).unwrap(), b"candidate");
    assert_eq!(fs::read(target).unwrap(), b"original");
}
#[test]
fn standalone_settlement_requires_an_explicit_declared_source() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("wrong-instance");
    let receipt = chunk_receipt(0);
    let old = serde_json::json!({"kind":"tx_settlement","value":receipt});
    assert!(
        serde_json::from_value::<CaptureEntry>(old).is_err(),
        "old WIP settlement has no source identity"
    );
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    let wrong = CaptureEntry::TxSettlement(Box::new(CaptureTxSettlement {
        host_id: source().host_id,
        instance_epoch: 2.into(),
        receipt,
    }));
    assert_eq!(writer.push(wrong, 0).unwrap_err().code, "CAPTURE_CORRUPT");
}
#[test]
fn independent_verification_checks_declared_source_instance() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("source-instance");
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    writer.push(entry(1), 0).unwrap();
    writer.finish().unwrap();
    let manifest = path.join("manifest.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    value["streams"][0]["instanceEpoch"] = "2".into();
    fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    let scan = verify_directory(&path).unwrap();
    assert!(!scan.report.container_complete);
    assert_eq!(scan.report.verified_prefix, U64::from(0));
}
#[test]
fn distinct_hosts_can_settle_the_same_owner_and_span() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("two-hosts");
    let mut remote = source();
    remote.host_id = Id::try_from("remote").unwrap();
    let mut writer = CaptureWriter::create(
        &path,
        vec![source(), remote.clone()],
        CaptureLimits::default(),
    )
    .unwrap();
    for host in [source().host_id, remote.host_id] {
        writer
            .push(
                CaptureEntry::TxSettlement(Box::new(CaptureTxSettlement {
                    host_id: host,
                    instance_epoch: 1.into(),
                    receipt: chunk_receipt(0),
                })),
                0,
            )
            .unwrap();
    }
    writer.finish().unwrap();
    assert!(verify_directory(&path).unwrap().report.container_complete);
}
#[test]
fn live_capture_cannot_be_opened_for_append_at_a_synced_boundary() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().canonicalize().unwrap().join("live-append");
    let writer = CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    assert!(verify_directory(&path).unwrap().report.container_complete);
    let attempt = CaptureWriter::append(&path, vec![source()], CaptureLimits::default());
    assert_eq!(
        attempt
            .err()
            .expect("a live capture cannot acquire a second writer")
            .code,
        "CAPTURE_INCOMPLETE"
    );
    assert!(!path.join("volume-000002.swbr").exists());
    writer.finish().unwrap();
}
#[tokio::test]
async fn aliased_creation_locations_cannot_start_a_second_live_writer() {
    use serial_workbench_host::{
        capture::{CaptureRuntime, CaptureService},
        files::FileService,
        storage::{Acceptance, canonical_digest},
    };
    let h = support::Harness::new().await;
    let session = h.open("capture-alias").await;
    let user = h
        .auth
        .authenticate_user_control(
            h.actor.client_id(),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let identity = h.store.identity().unwrap();
    let files = FileService::new(h.store.clone(), h.auth.clone(), identity.clone());
    let path = h.dir.path().canonicalize().unwrap().join("aliased-capture");
    let location = files
        .register(
            RegisterFileParams {
                path: path.to_string_lossy().into_owned(),
                purpose: FilePurpose::CaptureTarget,
            },
            &user,
        )
        .unwrap();
    let alias = files
        .register(
            RegisterFileParams {
                path: path.to_string_lossy().into_owned(),
                purpose: FilePurpose::CaptureTarget,
            },
            &user,
        )
        .unwrap();
    assert_ne!(location.id, alias.id);
    h.auth
        .authorize(
            &user,
            AuthorizeParams {
                client_id: h.actor.client_id().clone(),
                permissions: vec!["workspace.modify".into()],
                targets: vec![Target {
                    host_id: h.host_id.clone(),
                    kind: ResourceKind::try_from("host").unwrap(),
                    id: h.host_id.clone(),
                    session_id: None,
                    session_epoch: None,
                }],
                expires_at: None,
            },
        )
        .unwrap();
    let service = CaptureService::new(CaptureRuntime {
        store: h.store.clone(),
        auth: h.auth.clone(),
        identity,
        files,
        streams: h.host.streams().clone(),
        devices: h.host.devices().clone(),
        clock: h.clock.clone(),
    });
    let owner = |tag: &str| {
        let mut call = h.call(&session, "capture.start", serde_json::json!({"test":tag}));
        call.execution_mode = Some(ExecutionMode::Independent);
        let Acceptance::New(operation) = h
            .store
            .accept(&h.actor, &call, &canonical_digest(&call).unwrap())
            .unwrap()
        else {
            panic!("new owner")
        };
        h.store.mark_dispatch(&operation.operation_id).unwrap();
        h.store.get(&h.actor, &operation.operation_id).unwrap()
    };
    let first = service
        .start(
            CaptureStartParams {
                session_refs: vec![session.clone()],
                target_ref: location,
                mode: CaptureMode::Raw,
                redaction_rules: None,
                overflow_policy: OverflowPolicy::Stop,
                write_mode: CaptureWriteMode::CreateNew,
                expected_fingerprint: None,
                storage_limits: None,
            },
            &owner("first"),
            &h.actor,
        )
        .await
        .unwrap();
    let evidence_names = ["manifest.json", "index-000001.swbi", "volume-000001.swbr"];
    let before: Vec<_> = evidence_names
        .iter()
        .map(|name| fs::read(path.join(name)).unwrap())
        .collect();
    let attempt = service
        .start(
            CaptureStartParams {
                session_refs: vec![session.clone()],
                target_ref: alias,
                mode: CaptureMode::Raw,
                redaction_rules: None,
                overflow_policy: OverflowPolicy::Stop,
                write_mode: CaptureWriteMode::Append,
                expected_fingerprint: None,
                storage_limits: None,
            },
            &owner("second"),
            &h.actor,
        )
        .await;
    let unchanged = evidence_names
        .iter()
        .zip(&before)
        .all(|(name, bytes)| fs::read(path.join(name)).is_ok_and(|after| &after == bytes));
    let no_second_volume = !path.join("volume-000002.swbr").exists();
    // Stop the valid capture before ending its source epoch. If the buggy second
    // writer was admitted, source close still releases any lost active-map owner.
    let first_outcome = if attempt.is_err() {
        Some(service.stop(&first, &h.actor).await)
    } else {
        None
    };
    h.action(&session, "session.close", serde_json::json!({}))
        .await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), service.shutdown())
        .await
        .unwrap();
    assert!(
        unchanged && no_second_volume,
        "rejected alias append must not alter the live container"
    );
    assert_eq!(
        attempt
            .expect_err("aliased location must not acquire a live writer")
            .code,
        "CAPTURE_INCOMPLETE"
    );
    assert!(!path.join("volume-000002.swbr").exists());
    let summary = first_outcome
        .expect("first owner must remain reachable")
        .expect("first capture must still complete independently");
    assert_eq!(summary.state, CaptureState::Complete);
    assert!(summary.container_complete);
    assert_eq!(service.wait(&first).await.unwrap(), summary);
}
#[tokio::test]
async fn capture_owner_and_fixed_result_survive_service_registry_recreation() {
    use serial_workbench_host::{
        capture::{CaptureRuntime, CaptureService},
        files::FileService,
    };
    let f = FaultCapture::new(fault_opener(
        None,
        None,
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
    ))
    .await;
    f.service.stop(&f.reference, &f.h.actor).await.unwrap();
    f.fast.close();
    let owner = f.service.owner_operation(&f.reference, &f.h.actor).await;
    let final_ref = f.service.final_reference(&f.reference, &f.h.actor).await;
    assert_eq!(owner.unwrap(), Some(f.owner_operation_id.clone()));
    let final_ref = final_ref.unwrap();
    assert_eq!(final_ref.id, f.reference.id);
    assert_eq!(final_ref.revision, Some(1.into()));
    let identity = f.h.store.identity().unwrap();
    let files = FileService::new(f.h.store.clone(), f.h.auth.clone(), identity.clone());
    assert_eq!(
        files.metadata(&f.reference, &f.h.actor).unwrap().file_ref,
        final_ref
    );
    let user =
        f.h.auth
            .authenticate_user_control(
                f.h.actor.client_id(),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
    let imported = files
        .register(
            RegisterFileParams {
                path: f
                    .h
                    .dir
                    .path()
                    .canonicalize()
                    .unwrap()
                    .join("io-fault")
                    .to_string_lossy()
                    .into_owned(),
                purpose: FilePurpose::CaptureSource,
            },
            &user,
        )
        .unwrap();
    let recreated = CaptureService::new(CaptureRuntime {
        store: f.h.store.clone(),
        auth: f.h.auth.clone(),
        identity,
        files,
        streams: f.streams.clone(),
        devices: f.h.host.devices().clone(),
        clock: f.h.clock.clone(),
    });
    assert_eq!(
        recreated
            .owner_operation(&f.reference, &f.h.actor)
            .await
            .unwrap(),
        Some(f.owner_operation_id)
    );
    assert_eq!(
        recreated
            .final_reference(&f.reference, &f.h.actor)
            .await
            .unwrap(),
        final_ref
    );
    assert_eq!(
        recreated
            .owner_operation(&imported, &f.h.actor)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn finalize_only_sync_failure_publishes_failed_status_and_preserves_evidence() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let armed = Arc::new(AtomicBool::new(false));
    let flag = armed.clone();
    let opener: serial_workbench_host::capture::writer::VolumeOpener = Arc::new(move |file| {
        Ok(Box::new(FaultVolume {
            file,
            remaining: None,
            gate: None,
            armed: flag.clone(),
            fail_sync_when_armed: true,
        }))
    });
    let f = FaultCapture::new(opener).await;
    let path = f.h.dir.path().canonicalize().unwrap().join("io-fault");
    let before = std::fs::read(path.join("volume-000001.swbr")).unwrap();
    armed.store(true, Ordering::SeqCst);
    let error = f.service.stop(&f.reference, &f.h.actor).await.unwrap_err();
    let status = f.service.status(&f.reference, &f.h.actor).await.unwrap();
    let waited = f.service.wait(&f.reference).await.unwrap_err();
    assert_eq!(error.code, "CAPTURE_IO_FAILED");
    assert_eq!(waited.code, error.code);
    assert_eq!(
        std::fs::read(path.join("volume-000001.swbr")).unwrap(),
        before
    );
    assert!(!status.container_complete);
    assert_eq!(status.state, CaptureState::Failed);
}

#[tokio::test]
async fn verification_leases_are_reclaimed_without_exhausting_normal_queries() {
    use std::sync::{Arc, atomic::AtomicBool};
    let f = FaultCapture::new(fault_opener(None, None, Arc::new(AtomicBool::new(false)))).await;
    f.service.stop(&f.reference, &f.h.actor).await.unwrap();
    let first = f.service.verify(&f.reference, &f.h.actor).await.unwrap();
    for _ in 0..20 {
        let report = f.service.verify(&f.reference, &f.h.actor).await.unwrap();
        assert!(report.container_complete);
        assert_eq!(report.source_fingerprint, first.source_fingerprint);
    }
    let old = f
        .service
        .recover_prefix(
            RecoverPrefixParams {
                verification_id: first.verification_id,
                source_fingerprint: first.source_fingerprint,
                target_ref: f.reference.clone(),
            },
            &f.h.actor,
        )
        .await;
    assert_eq!(
        old.unwrap_err().code,
        "NOT_FOUND",
        "old bounded verification lease must expire"
    );
}

#[cfg(unix)]
#[test]
fn replacing_a_normal_parent_directory_cannot_redirect_capture_checkpoints() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().canonicalize().unwrap();
    let parent = root.join("authorized");
    std::fs::create_dir(&parent).unwrap();
    let path = parent.join("capture");
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    std::fs::rename(&parent, root.join("original")).unwrap();
    std::fs::create_dir(&parent).unwrap();
    std::fs::create_dir(&path).unwrap();
    let result = writer.push(entry(1), 2_000_000_000);
    assert_eq!(
        std::fs::read_dir(&path).unwrap().count(),
        0,
        "all writes must stay under the previously held parent capability"
    );
    if result.is_ok() {
        let _ = writer.finish();
    }
}

#[tokio::test]
async fn recovery_history_source_lookup_uses_the_actual_lease_parent_without_consuming_it() {
    use serial_workbench_host::files::FileService;
    use std::sync::{Arc, atomic::AtomicBool};
    let f = FaultCapture::new(fault_opener(None, None, Arc::new(AtomicBool::new(false)))).await;
    f.service.stop(&f.reference, &f.h.actor).await.unwrap();
    let report = f.service.verify(&f.reference, &f.h.actor).await.unwrap();
    let files = FileService::new(
        f.h.store.clone(),
        f.h.auth.clone(),
        f.h.store.identity().unwrap(),
    );
    let expected = files
        .authorization_target(&f.reference, &f.h.actor, "content.read")
        .unwrap();
    let mut unrelated_destination = f.reference.clone();
    unrelated_destination.id = Id::try_from("not-the-source-parent").unwrap();
    let params = RecoverPrefixParams {
        verification_id: report.verification_id,
        source_fingerprint: report.source_fingerprint,
        target_ref: unrelated_destination,
    };
    for _ in 0..2 {
        assert_eq!(
            f.service
                .recovery_authorization_target(&params, &f.h.actor, "content.read")
                .unwrap(),
            expected
        );
    }
    let mut forged = params.clone();
    forged.source_fingerprint =
        Digest::try_from("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
            .unwrap();
    assert_eq!(
        f.service
            .recovery_authorization_target(&forged, &f.h.actor, "content.read")
            .unwrap_err()
            .code,
        "SOURCE_CHANGED"
    );
    let user =
        f.h.auth
            .authenticate_user_control(
                f.h.actor.client_id(),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
    f.h.auth
        .revoke(
            &user,
            RevokeParams {
                actor_id: f.h.actor.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![expected.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        f.service
            .recovery_authorization_target(&params, &f.h.actor, "content.read")
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    f.h.auth
        .authorize(
            &user,
            AuthorizeParams {
                client_id: f.h.actor.client_id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![expected],
                expires_at: None,
            },
        )
        .unwrap();
    for _ in 0..16 {
        f.service.verify(&f.reference, &f.h.actor).await.unwrap();
    }
    assert_eq!(
        f.service
            .recovery_authorization_target(&params, &f.h.actor, "content.read")
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
}
