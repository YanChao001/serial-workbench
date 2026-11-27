use super::*;
use serial_workbench_client::RawConnection;
use serial_workbench_host::capture::{
    format::{CaptureSource, zero_digest},
    writer::{CaptureLimits, CaptureWriter},
};

fn recording(
    path: &std::path::Path,
    mut byte_start: u64,
    chunks: impl IntoIterator<Item = (Bytes, u64)>,
) {
    let precision = TimePrecision {
        source: TimeSource::HostRead,
        resolution_ns: 1.into(),
        sync_method: "none".into(),
        offset_estimate_ns: None,
        offset_error_ns: None,
        rtt_ns: None,
    };
    let source = CaptureSource {
        host_id: id("recorded-host"),
        instance_epoch: 1.into(),
        session_id: id("recorded-session"),
        session_epoch: 1.into(),
        configuration_digest: zero_digest(),
        configuration: SerialConfiguration::default(),
        time_precision: precision.clone(),
    };
    let mut writer =
        CaptureWriter::create(path, vec![source.clone()], CaptureLimits::default()).unwrap();
    let wall_time = Timestamp::try_from("2026-11-25T00:00:00Z").unwrap();
    for (index, (bytes_base64, size)) in chunks.into_iter().enumerate() {
        let sequence = index as u64 + 1;
        let byte_end = byte_start + size;
        writer
            .push(
                CaptureEntry::Event(Box::new(RawEvent {
                    host_id: source.host_id.clone(),
                    instance_epoch: source.instance_epoch,
                    session_id: source.session_id.clone(),
                    session_epoch: source.session_epoch,
                    configuration_revision: 1.into(),
                    event_seq: sequence.into(),
                    time: EventTime {
                        clock_id: source.host_id.clone(),
                        source_mono_ns: sequence.into(),
                        received_wall_time: wall_time.clone(),
                        precision: precision.clone(),
                        source_wall_time: None,
                    },
                    payload: RawPayload::Rx(RxPayload {
                        bytes_base64,
                        byte_start: byte_start.into(),
                        byte_end: byte_end.into(),
                        message: None,
                    }),
                })),
                sequence,
            )
            .unwrap();
        byte_start = byte_end;
    }
    writer.finish().unwrap();
}

async fn search_reply(raw: &RawConnection, request: RpcRequest) -> ReplaySearchResult {
    let RpcResult::Query(QueryResult::ReplaySearch(result)) =
        success(raw.request(request).await.unwrap())
    else {
        panic!("expected typed Raw search result");
    };
    result
}

#[tokio::test]
async fn raw_replay_search_pages_keep_connection_and_source_authority() {
    let f = Fixture::new().await;
    let path = f.dir.path().join("replay-search.swbc");
    let bytes = Bytes::try_from(STANDARD.encode([0x41; 70]).as_str()).unwrap();
    recording(&path, 10, [(bytes, 70)]);
    std::fs::rename(
        path.join("index-000001.swbi"),
        f.dir.path().join("original-index.swbi"),
    )
    .unwrap();
    let imported = f
        .action(
            &f.control,
            "file.register",
            f.host(),
            json!({"path":path.to_str().unwrap(),"purpose":"capture_source"}),
        )
        .await;
    let Some(ActionResult::FileMetadata(imported_file)) = imported.result else {
        panic!("registered recording expected: {:?}", imported.error);
    };
    let source = imported_file.file_ref;
    let opened = f
        .action(
            &f.user,
            "replay.open",
            f.reference_target(&source),
            json!({"captureRef":source,"mode":"fastest"}),
        )
        .await;
    let Some(ActionResult::Opened(opened_session)) = opened.result else {
        panic!("replay expected: {:?}", opened.error);
    };
    let mut target = f.target("session", opened_session.session_id.as_str());
    target.session_id = Some(opened_session.session_id.clone());
    target.session_epoch = Some(opened_session.session_epoch);
    let command = |client, command| {
        RpcRequest::Query(f.query(
            client,
            "replay.search",
            target.clone(),
            json!({
                "sessionId":target.id, "sessionEpoch":target.session_epoch, "command":command
            }),
        ))
    };
    let search_id = "a6b21411-cf47-472c-98d4-79482bd9d433";
    let start = json!({"kind":"start","searchId":search_id,"bytesBase64":"QQ==","direction":"rx"});
    let next = json!({"kind":"next","searchId":search_id,"page":"2"});
    let stop = json!({"kind":"stop","searchId":search_id});

    let raw = f.user.connect_raw().await.unwrap();
    assert_eq!(
        failure(
            f.user
                .request(command(&f.user, start.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED",
    );
    let first = search_reply(&raw, command(&f.user, start.clone())).await;
    let ReplaySearchResult::Page { page, result, .. } = &first else {
        panic!("expected first page");
    };
    assert_eq!(page.get(), 1);
    assert_eq!(result.hits.len(), 64);
    assert_eq!(result.hits[0].byte_start.get(), 10);
    assert_eq!(result.hits[63].byte_end.get(), 74);
    assert!(!result.complete);
    assert_eq!(
        search_reply(&raw, command(&f.user, start.clone())).await,
        first
    );
    let conflicting_start = json!({"kind":"start","searchId":search_id,"bytesBase64":"Qg=="});
    assert_eq!(
        failure(
            raw.request(command(&f.user, conflicting_start))
                .await
                .unwrap()
        )
        .code,
        "REQUEST_CONFLICT",
    );

    let independent = f.user.reconnect().await.unwrap();
    let independent_raw = independent.connect_raw().await.unwrap();
    assert_eq!(
        failure(
            independent_raw
                .request(command(&independent, next.clone()))
                .await
                .unwrap()
        )
        .code,
        "NOT_FOUND",
    );
    assert!(matches!(
        search_reply(&independent_raw, command(&independent, stop.clone())).await,
        ReplaySearchResult::Stopped { stopped: false, .. }
    ));
    let observer_raw = f.observer.connect_raw().await.unwrap();
    assert_eq!(
        failure(
            observer_raw
                .request(command(&f.observer, start.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED",
    );
    f.grant("content.read", f.reference_target(&source));
    assert_eq!(
        search_reply(&observer_raw, command(&f.observer, start.clone())).await,
        first
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.reference_target(&source)],
            },
        )
        .unwrap();
    f.grant("content.read", f.reference_target(&source));
    assert_eq!(
        failure(
            observer_raw
                .request(command(&f.observer, next.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED",
    );
    let replacement_id = "551ab229-f9d8-4719-a6ec-2865bce7afd9";
    let mut replacement = start.clone();
    replacement["searchId"] = json!(replacement_id);
    assert!(matches!(
        search_reply(&observer_raw, command(&f.observer, replacement)).await,
        ReplaySearchResult::Page { search_id, page, .. }
            if search_id.as_str() == replacement_id && page.get() == 1
    ));
    assert!(matches!(
        search_reply(&observer_raw, command(&f.observer, stop.clone())).await,
        ReplaySearchResult::Stopped { stopped: false, .. }
    ));
    assert_eq!(
        failure(
            raw.request(command(
                &f.user,
                json!({"kind":"next","searchId":search_id,"page":"3"})
            ))
            .await
            .unwrap()
        )
        .code,
        "INVALID_ARGUMENT",
    );
    let second = search_reply(&raw, command(&f.user, next.clone())).await;
    let ReplaySearchResult::Page { page, result, .. } = &second else {
        panic!("expected continuation page");
    };
    assert_eq!(page.get(), 2);
    assert_eq!(result.hits.len(), 6);
    assert_eq!(result.hits[0].byte_start.get(), 74);
    assert_eq!(result.hits[5].byte_end.get(), 80);
    assert!(result.complete);
    assert_eq!(
        search_reply(&raw, command(&f.user, next.clone())).await,
        second
    );

    for stopped in [true, false] {
        assert!(matches!(
            search_reply(&raw, command(&f.user, stop.clone())).await,
            ReplaySearchResult::Stopped { stopped: actual, .. } if stopped == actual
        ));
    }
    assert_eq!(
        failure(raw.request(command(&f.user, next.clone())).await.unwrap()).code,
        "NOT_FOUND",
    );

    let read = RpcRequest::Query(f.query(
        &f.user,
        "replay.read",
        target.clone(),
        json!({
            "sessionId":opened_session.session_id,
            "sessionEpoch":opened_session.session_epoch,
            "maxRecords":"1","maxBytes":"65536","inspectPlayback":true,
        }),
    ));
    let RpcResult::Query(QueryResult::ReplayRead(playback)) =
        success(raw.request(read).await.unwrap())
    else {
        panic!("playback position expected");
    };
    assert_eq!(playback.next_record.get(), 1);

    assert_eq!(
        search_reply(&raw, command(&f.user, start.clone())).await,
        first
    );
    raw.close().await.unwrap();
    let reopened = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match f.user.connect_raw().await {
                Ok(raw) => break raw,
                Err(error) if error.code == "UNAUTHENTICATED" => {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => panic!("raw reconnect failed: {error:?}"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        failure(
            reopened
                .request(command(&f.user, next.clone()))
                .await
                .unwrap()
        )
        .code,
        "NOT_FOUND",
    );
    assert_eq!(
        search_reply(&reopened, command(&f.user, start)).await,
        first
    );
    let closed = f
        .action(&f.user, "replay.close", target.clone(), json!({}))
        .await;
    assert_eq!(closed.state, OperationState::Succeeded);
    assert_eq!(
        failure(reopened.request(command(&f.user, next)).await.unwrap()).code,
        "BACKEND_DISCONNECTED",
    );

    f.finish().await;
}

#[tokio::test]
#[ignore = "Requires SWB_TEST_LARGE_CAPTURE_DIR with at least 2 GiB of free space"]
async fn raw_replay_search_near_default_capture_capacity() {
    const CHUNK_BYTES: usize = 64 * 1024;
    const NEEDLE: &[u8] = b"SWB capacity marker";
    let parent = std::env::var_os("SWB_TEST_LARGE_CAPTURE_DIR")
        .expect("select an existing temporary parent for the large recording");
    let directory = tempfile::tempdir_in(parent).unwrap();
    let path = directory
        .path()
        .canonicalize()
        .unwrap()
        .join("near-capacity.swbc");
    let capacity = CaptureLimits::default().capacity_bytes;
    let filler = STANDARD.encode(vec![0; CHUNK_BYTES]);
    let filler_count = (capacity * 93 / 100 / filler.len() as u64) as usize;
    let needle = STANDARD.encode(NEEDLE);
    let payloads = std::iter::repeat_n(
        (
            Bytes::try_from(filler.as_str()).unwrap(),
            CHUNK_BYTES as u64,
        ),
        filler_count,
    )
    .chain([(
        Bytes::try_from(needle.as_str()).unwrap(),
        NEEDLE.len() as u64,
    )]);
    recording(&path, 0, payloads);
    let record_count = filler_count as u64 + 1;
    let size: u64 = std::fs::read_dir(&path)
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum();
    assert!((capacity * 92 / 100..=capacity).contains(&size));
    let sidecar = path.join("index-000001.swbi");
    std::fs::rename(&sidecar, directory.path().join("original-index.swbi")).unwrap();

    let f = Fixture::new().await;
    let timeout = Duration::from_secs(300);
    let register_started = std::time::Instant::now();
    let accepted = f
        .invoke(
            &f.control,
            "file.register",
            f.host(),
            json!({"path":path.to_str().unwrap(),"purpose":"capture_source"}),
        )
        .await;
    let registered = f.wait_with_timeout(&accepted, false, timeout).await;
    let register_ms = register_started.elapsed().as_millis();
    let Some(ActionResult::FileMetadata(metadata)) = registered.result else {
        panic!("recording registration failed: {:?}", registered.error);
    };

    let open_started = std::time::Instant::now();
    let accepted = f
        .invoke(
            &f.user,
            "replay.open",
            f.reference_target(&metadata.file_ref),
            json!({"captureRef":metadata.file_ref,"mode":"fastest"}),
        )
        .await;
    let opened = f.wait_with_timeout(&accepted, false, timeout).await;
    let open_ms = open_started.elapsed().as_millis();
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("replay open failed: {:?}", opened.error);
    };
    let mut target = f.target("session", opened.session_id.as_str());
    target.session_id = Some(opened.session_id.clone());
    target.session_epoch = Some(opened.session_epoch);
    let raw = f.user.connect_raw().await.unwrap();
    let command = |command| {
        RpcRequest::Query(f.query(
            &f.user,
            "replay.search",
            target.clone(),
            json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"command":command}),
        ))
    };
    let start = |search_id| {
        command(json!({"kind":"start","searchId":search_id,"bytesBase64":needle,"direction":"rx"}))
    };
    let first_id = uuid::Uuid::new_v4().to_string();
    let first = search_reply(&raw, start(&first_id)).await;
    let ReplaySearchResult::Page { result, .. } = first else {
        panic!("first search page expected");
    };
    assert!((1..64).contains(&result.scanned_records.get()));
    assert!(!result.complete && result.hits.is_empty());
    assert!(matches!(
        search_reply(&raw, command(json!({"kind":"stop","searchId":first_id}))).await,
        ReplaySearchResult::Stopped { stopped: true, .. }
    ));
    let retired = command(json!({"kind":"next","searchId":first_id,"page":"2"}));
    assert_eq!(
        failure(raw.request(retired).await.unwrap()).code,
        "NOT_FOUND"
    );

    let search_started = std::time::Instant::now();
    let search_id = uuid::Uuid::new_v4().to_string();
    let mut request = start(&search_id);
    let mut last_record = 0;
    let (hit, pages) = loop {
        let ReplaySearchResult::Page { page, result, .. } = search_reply(&raw, request).await
        else {
            panic!("continued search page expected");
        };
        let scanned = result.scanned_records.get();
        assert_eq!(result.total_records.get(), record_count);
        assert!(scanned > last_record && scanned - last_record < 64);
        if result.complete {
            assert_eq!(scanned, record_count);
            let [hit] = result.hits.try_into().expect("one final search hit");
            break (hit, page.get());
        }
        assert!(result.hits.is_empty());
        last_record = scanned;
        request = command(json!({
            "kind":"next","searchId":search_id,"page":(page.get() + 1).to_string()
        }));
    };
    let search_ms = search_started.elapsed().as_millis();
    assert_eq!(hit.first_record.get(), record_count);
    assert_eq!(hit.last_record.get(), record_count);
    assert_eq!(
        hit.byte_start.get(),
        filler_count as u64 * CHUNK_BYTES as u64
    );
    assert_eq!(
        hit.byte_end.get() - hit.byte_start.get(),
        NEEDLE.len() as u64
    );

    let position = f.action(
        &f.user,
        "replay.control",
        target.clone(),
        json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"seekRecord":hit.first_record,"paused":true}),
    ).await;
    let Some(ActionResult::ReplayPosition(position)) = position.result else {
        panic!("replay seek failed: {:?}", position.error);
    };
    let read = RpcRequest::Query(f.query(
        &f.user,
        "replay.read",
        target,
        json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"maxRecords":"1","maxBytes":"4096","singleStep":true,"reportPlayback":true}),
    ));
    let RpcResult::Query(QueryResult::ReplayRead(read)) = success(raw.request(read).await.unwrap())
    else {
        panic!("stepped replay result expected");
    };
    assert_eq!(read.reader_generation, position.reader_generation);
    assert!(read.at_end && read.playback.unwrap().paused);
    let [ReplayRecord::Inline { record }] = read.records.as_slice() else {
        panic!("the original target record must fit the bounded reply");
    };
    assert_eq!(record.record_ordinal, hit.first_record);
    let CaptureEntry::Event(event) = &record.entry else {
        panic!("expected the original capture event");
    };
    let RawPayload::Rx(rx) = &event.payload else {
        panic!("expected the marker in RX");
    };
    assert_eq!(rx.byte_start, hit.byte_start);
    assert_eq!(rx.byte_end, hit.byte_end);
    assert_eq!(STANDARD.decode(rx.bytes_base64.as_str()).unwrap(), NEEDLE);
    assert!(!sidecar.try_exists().unwrap());
    eprintln!(
        "replay_capacity bytes={size} records={record_count} pages={pages} register_ms={register_ms} open_ms={open_ms} search_ms={search_ms}"
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "Requires SWB_TEST_CLI_BIN pointing to the same build's CLI executable"]
async fn cli_batch_replay_search_uses_one_raw_connection_without_leaking_its_cursor() {
    let cli = std::env::var_os("SWB_TEST_CLI_BIN").expect("set the CLI executable");
    let f = Fixture::new().await;
    let path = f.dir.path().join("batch-replay.swbc");
    let bytes = Bytes::try_from(STANDARD.encode([0x41; 70]).as_str()).unwrap();
    recording(&path, 10, [(bytes, 70)]);
    let registered = f
        .action(
            &f.control,
            "file.register",
            f.host(),
            json!({"path":path.to_str().unwrap(),"purpose":"capture_source"}),
        )
        .await;
    let Some(ActionResult::FileMetadata(file)) = registered.result else {
        panic!("expected registered recording: {:?}", registered.error);
    };
    let client_id = id("serial-workbench-cli");
    let client = HostClient::connect(ConnectOptions::new(
        f.dir.path().into(),
        client_id.clone(),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    f.auth
        .authorize(
            &f.operator,
            AuthorizeParams {
                client_id,
                permissions: vec!["content.read".into()],
                targets: vec![f.reference_target(&file.file_ref)],
                expires_at: None,
            },
        )
        .unwrap();
    let opened = f
        .action(
            &client,
            "replay.open",
            f.reference_target(&file.file_ref),
            json!({"captureRef":file.file_ref,"mode":"fastest"}),
        )
        .await;
    let Some(ActionResult::Opened(open)) = opened.result else {
        panic!("expected replay session: {:?}", opened.error);
    };
    let mut target = f.target("session", open.session_id.as_str());
    target.session_id = Some(open.session_id.clone());
    target.session_epoch = Some(open.session_epoch);
    let replay_query = |command| {
        json!({
            "kind":"query", "actionId":"replay.search", "target":target,
            "params":{"sessionId":open.session_id,"sessionEpoch":open.session_epoch,"command":command},
        })
    };
    let search_id = uuid::Uuid::new_v4().to_string();
    let first = replay_query(
        json!({"kind":"start","searchId":search_id,"direction":"rx","bytesBase64":"QQ=="}),
    );
    let next = replay_query(json!({"kind":"next","searchId":search_id,"page":"2"}));
    let device_list =
        json!({"kind":"query","actionId":"device.list","target":{"kind":"host"},"params":{}});
    let batch_file = f.dir.path().join("replay-batch.json");
    let run = |steps: Vec<Value>| {
        std::fs::write(
            &batch_file,
            serde_json::to_vec(&json!({"schemaVersion":1,"steps":steps})).unwrap(),
        )
        .unwrap();
        let mut command = tokio::process::Command::new(&cli);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
            .args([
                "run",
                "--mode",
                "attach",
                "--timeout-ms",
                "10000",
                "--batch-json",
            ])
            .arg(&batch_file)
            .arg("--profile")
            .arg(f.dir.path())
            .kill_on_drop(true);
        async move {
            tokio::time::timeout(Duration::from_secs(15), command.output())
                .await
                .unwrap()
                .unwrap()
        }
    };

    let output = run(vec![first, device_list, next.clone()]).await;
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        output.status.success(),
        "CLI report error: {}",
        report["error"]
    );
    assert_eq!(report["steps"][1]["result"]["kind"], "devices");
    let page = |index: usize| &report["steps"][index]["result"]["value"];
    assert_eq!(page(0)["page"], "1");
    assert_eq!(page(0)["result"]["hits"].as_array().unwrap().len(), 64);
    assert_eq!(page(0)["result"]["hits"][0]["byteStart"], "10");
    assert_eq!(page(2)["page"], "2");
    assert_eq!(page(2)["result"]["hits"].as_array().unwrap().len(), 6);
    assert_eq!(page(2)["result"]["hits"][5]["byteEnd"], "80");
    assert_eq!(page(2)["result"]["complete"], true);

    let output = run(vec![next]).await;
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["error"]["code"], "NOT_FOUND");
    drop(client);
    f.finish().await;
}
