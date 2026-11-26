use super::*;
use serial_workbench_host::node_runtime::{NodeRuntimeLimits, verify_node_runtime};
use std::{net::Ipv4Addr, path::PathBuf, process::Stdio, sync::atomic::AtomicBool};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    time::timeout,
};

const PACKAGE: &str = "swb.builtin.tcp";
const PROVIDER: &str = "swb.builtin.tcp.transport";
const PEER_RX: &[u8] = b"rx=1\x082\r\nok\rnext\n!";
const PEER_TX: &[u8] = b"ZB\r\nLINE";
const WAIT: Duration = Duration::from_secs(15);

#[tokio::test]
#[ignore = "Requires built web assets, Chromium and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn paired_browser_maps_signed_tcp_bytes_and_keeps_raw_recording_and_receipts() {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = PathBuf::from(
        std::env::var_os("SWB_TEST_MAPPED_CAPTURE_OUTPUT").expect("Recording evidence directory"),
    );
    std::fs::create_dir_all(&output).unwrap();
    let runtime_root = PathBuf::from(
        std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").expect("Verified fixed Node runtime"),
    );
    let runtime = tokio::task::spawn_blocking(move || {
        verify_node_runtime(
            &runtime_root,
            &NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
    })
    .await
    .unwrap();
    let host = Fixture::with_runtime(true, Some(runtime)).await;
    // Keep the independent Host shutdown path when the browser or a peer assertion fails.
    let joined = std::panic::AssertUnwindSafe(check(&host, &repository, &output));
    use futures_util::FutureExt;
    let result = joined.catch_unwind().await;
    host.finish().await;
    if let Err(failure) = result {
        std::panic::resume_unwind(failure);
    }
}

async fn check(host: &Fixture, repository: &std::path::Path, output: &std::path::Path) {
    let settings = serial_workbench_host::settings::SettingsService::new(host.store.clone());
    let current = settings.read().unwrap();
    settings
        .save(
            current.revision,
            SharedSettings {
                language: Language::En,
                ..current.value
            },
        )
        .unwrap();
    let assets = repository
        .join("dist-web")
        .canonicalize()
        .expect("Build browser assets");
    let tcp = timeout(Duration::from_secs(30), async {
        loop {
            let request = host.query(
                &host.control,
                "node.packages.runtime",
                host.host(),
                json!({"id":PACKAGE}),
            );
            let RpcResult::Query(QueryResult::NodePackageRuntime(runtime)) = success(
                host.control
                    .request(RpcRequest::Query(request))
                    .await
                    .unwrap(),
            ) else {
                panic!("Expected signed runtime state");
            };
            assert_ne!(
                runtime.phase,
                NodePackageRuntimePhase::Failed,
                "{runtime:?}"
            );
            if runtime.phase == NodePackageRuntimePhase::Active {
                let distribution: Value =
                    serde_json::from_str(include_str!("../../resources/node-packages/tcp.json"))
                        .unwrap();
                assert_eq!(
                    runtime.archive_sha256.as_ref().unwrap().as_str(),
                    distribution["archiveSha256"].as_str().unwrap()
                );
                let request = host.query(&host.user, "device.refresh", host.host(), json!({}));
                let RpcResult::Query(QueryResult::Devices(directory)) =
                    success(host.user.request(RpcRequest::Query(request)).await.unwrap())
                else {
                    panic!("Expected signed device directory");
                };
                if let Some(device) = directory.devices.into_iter().find(|device| {
                    device.system_name == PROVIDER && device.driver.as_deref() == Some(PACKAGE)
                }) {
                    break device;
                }
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("Signed TCP runtime must publish a usable device");
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let RpcResult::BrowserAccess(BrowserAccessResult {
        browser_access: BrowserAccessState::Pairing { entry, .. },
    }) = success(
        host.control
            .request(RpcRequest::BrowserAccess(BrowserAccessParams::Pair {
                assets_dir: assets.to_str().unwrap().into(),
                mode: BrowserAccessMode::Operate,
            }))
            .await
            .unwrap(),
    )
    else {
        panic!("Expected real Host pairing");
    };
    for (target, permissions) in [
        (host.host(), vec!["metadata.read", "content.read"]),
        (
            host.target("device", tcp.device_id.as_str()),
            vec!["device.modify"],
        ),
    ] {
        host.auth
            .authorize(
                &host.operator,
                AuthorizeParams {
                    client_id: entry.client_id.clone(),
                    permissions: permissions.into_iter().map(str::to_string).collect(),
                    targets: vec![target],
                    expires_at: None,
                },
            )
            .unwrap();
    }
    let mut browser = tokio::process::Command::new("node")
        .arg(repository.join("e2e/paired-browser-character-remap.mjs"))
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let descriptor = json!({"url":entry.url,"pairingCode":entry.pairing_code,
        "systemName":tcp.system_name,"port":listener.local_addr().unwrap().port()});
    let mut browser_input = browser.stdin.take().unwrap();
    browser_input
        .write_all(format!("{descriptor}\n").as_bytes())
        .await
        .unwrap();
    let mut browser_progress = BufReader::new(browser.stdout.take().unwrap()).lines();
    let connected = timeout(Duration::from_secs(35), browser_progress.next_line())
        .await
        .expect("Chromium connection timed out")
        .unwrap();
    assert_eq!(connected.as_deref(), Some("tcp-connected"));
    let (mut peer, _) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
    let request = host.query(&host.user, "state.scopes", host.host(), json!({}));
    let RpcResult::Query(QueryResult::Scopes(scopes)) =
        success(host.user.request(RpcRequest::Query(request)).await.unwrap())
    else {
        panic!("Expected current Host state scopes");
    };
    let sessions = scopes
        .scopes
        .into_iter()
        .filter_map(|scope| {
            (scope.target.kind.as_str() == "session"
                && scope.scope_id.as_str() == format!("session:{}", scope.target.id.as_str()))
            .then_some(scope.target)
        })
        .collect::<Vec<_>>();
    let [session] = sessions.as_slice() else {
        panic!("Expected one TCP session: {sessions:?}");
    };
    let query = host.query(&host.user, "session.get", session.clone(), json!({}));
    let RpcResult::Query(QueryResult::Session(snapshot)) =
        success(host.user.request(RpcRequest::Query(query)).await.unwrap())
    else {
        panic!("Expected the real browser-opened session");
    };
    assert_eq!(snapshot.device_id, tcp.device_id);
    host.auth
        .authorize(
            &host.operator,
            AuthorizeParams {
                client_id: entry.client_id.clone(),
                permissions: vec![
                    "metadata.read".into(),
                    "content.read".into(),
                    "device.modify".into(),
                ],
                targets: vec![session.clone()],
                expires_at: None,
            },
        )
        .unwrap();
    let destination = host.register("mapping-original-and-final.swb").await;
    let (owner, live) = host.start(&host.user, session, &destination).await;
    browser_input.write_all(b"recording-ready\n").await.unwrap();
    drop(browser_input);
    let stage = timeout(Duration::from_secs(35), browser_progress.next_line())
        .await
        .expect("Chromium RX preparation timed out")
        .unwrap();
    assert_eq!(stage.as_deref(), Some("mapped-receive-ready"));
    assert!(
        matches!(peer.try_read(&mut [0]), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
    timeout(WAIT, peer.write_all(PEER_RX))
        .await
        .unwrap()
        .unwrap();
    let mut wire = [0; PEER_TX.len()];
    timeout(WAIT, peer.read_exact(&mut wire))
        .await
        .expect("Browser TX did not reach peer")
        .unwrap();
    assert_eq!(wire, PEER_TX);
    let status = timeout(Duration::from_secs(50), browser.wait())
        .await
        .expect("Browser receipt check timed out")
        .unwrap();
    assert!(status.success(), "Browser remap workflow: {status}");
    assert!(
        matches!(peer.try_read(&mut [0]), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );

    let raw = host.user.connect_raw().await.unwrap();
    let query = host.query(
        &host.user,
        "stream.read",
        session.clone(),
        json!({
            "sessionId":session.session_id, "sessionEpoch":session.session_epoch,
            "startEventSeq":"1", "maxEvents":"100", "maxBytes":"65536",
        }),
    );
    let RpcResult::Query(QueryResult::StreamRead(page)) =
        success(raw.request(RpcRequest::Query(query)).await.unwrap())
    else {
        panic!("Expected independent Raw page");
    };
    let (mut rx, mut rx_events) = (Vec::new(), Vec::new());
    let mut tx_events = Vec::new();
    for event in &page.events {
        match &event.payload {
            RawPayload::Rx(payload) => {
                rx.extend(STANDARD.decode(payload.bytes_base64.as_str()).unwrap());
                rx_events.push(event.clone());
            }
            RawPayload::Tx(_) => tx_events.push(event.clone()),
            _ => {}
        }
    }
    assert_eq!(rx, PEER_RX);
    let [tx_event] = tx_events.as_slice() else {
        panic!("Expected a single TX event");
    };
    let RawPayload::Tx(emitted) = &tx_event.payload else {
        unreachable!()
    };
    assert_eq!(
        STANDARD.decode(emitted.bytes_base64.as_str()).unwrap(),
        PEER_TX
    );
    assert_eq!(emitted.outcome, TxOutcome::Accepted);
    assert_eq!(
        emitted.accepted_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: (PEER_TX.len() as u64).into()
        }]
    );
    assert!(emitted.unknown_ranges.is_empty());

    let query = host.query(
        &host.user,
        "operation.input",
        host.host(),
        json!({"operationId":emitted.operation_id}),
    );
    let RpcResult::Query(QueryResult::OperationInput(OperationInput::Tx(source))) =
        success(raw.request(RpcRequest::Query(query)).await.unwrap())
    else {
        panic!("Expected recorded request input");
    };
    assert_eq!(source.bytes_base64, emitted.bytes_base64);
    let original = source.source_text.expect("Text draft was retained");
    assert_eq!(
        STANDARD.decode(original.utf8_base64.as_str()).unwrap(),
        b"ab\nline"
    );
    assert_eq!(original.encoding, TextEncoding::Utf8);
    assert_eq!(original.mapping.newline, CharacterRemapNewline::Crlf);
    assert_eq!(original.mapping.letter_case, CharacterRemapCase::Upper);
    let [rule] = original.mapping.replacements.as_slice() else {
        panic!("Expected one explicit rule")
    };
    assert_eq!((&*rule.source, &*rule.replacement), ("a", "z"));
    let [transform] = source.transforms.as_deref().unwrap() else {
        panic!("Single transform expected")
    };
    assert_eq!(transform.id.as_str(), CHARACTER_REMAP_TRANSFORM_ID);

    // Wait for the RX fragments and settled TX to reach the writer before sealing.
    host.wait_written(&live, (rx_events.len() + 1) as u64).await;
    let capture = host.stop_capture(&owner, &live).await;
    assert_eq!(capture.summary.state, CaptureState::Complete);
    let fixed = capture.capture_ref;
    let verified = host
        .action(
            &host.user,
            "capture.verify",
            host.reference_target(&fixed),
            json!({"captureRef":fixed}),
        )
        .await;
    let Some(ActionResult::CaptureVerification(verification)) = verified.result else {
        panic!("Capture verification failed: {:?}", verified.error);
    };
    assert!(verification.container_complete);
    let replay = host
        .action(
            &host.user,
            "replay.open",
            host.reference_target(&fixed),
            json!({"captureRef":fixed,"mode":"fastest"}),
        )
        .await;
    let Some(ActionResult::Opened(replayed)) = replay.result else {
        panic!("Replay did not open: {:?}", replay.error);
    };
    let target = Target {
        session_id: Some(replayed.session_id.clone()),
        session_epoch: Some(replayed.session_epoch),
        ..host.target("session", replayed.session_id.as_str())
    };
    let query = host.query(
        &host.user,
        "replay.read",
        target,
        json!({
            "sessionId":replayed.session_id,"sessionEpoch":replayed.session_epoch,
            "maxRecords":"100","maxBytes":"262144",
        }),
    );
    let RpcResult::Query(QueryResult::ReplayRead(page)) =
        success(raw.request(RpcRequest::Query(query)).await.unwrap())
    else {
        panic!("Expected verified replay data");
    };
    assert!(page.at_end);
    assert_eq!(page.mode, CaptureMode::Raw);
    let records = page
        .records
        .into_iter()
        .map(|row| {
            let ReplayRecord::Inline { record } = row else {
                panic!("Small record must be inline");
            };
            record.entry
        })
        .collect::<Vec<_>>();
    let recorded_bytes = serde_json::to_string(&records).unwrap();
    assert!(!recorded_bytes.contains(original.utf8_base64.as_str()));
    assert!(!recorded_bytes.contains(transform.configuration_digest.as_str()));
    let recorded_rx = records
        .iter()
        .filter_map(|record| match record {
            CaptureEntry::Event(event) if matches!(event.payload, RawPayload::Rx(_)) => {
                Some((**event).clone())
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(recorded_rx, rx_events);
    let mut recorded_tx = Vec::new();
    for record in records {
        match record {
            CaptureEntry::Event(event) if matches!(event.payload, RawPayload::Tx(_)) => {
                recorded_tx.push(*event)
            }
            CaptureEntry::ReaderGap(gap) => panic!("Unexpected recording gap: {gap:?}"),
            _ => {}
        }
    }
    assert_eq!(recorded_tx, tx_events);
    std::fs::write(
        output.join("host-receipt.json"),
        serde_json::to_vec_pretty(&json!({
            "transport":"signed TCP, independent loopback peer",
            "rawReceive":STANDARD.encode(PEER_RX),
            "peerAndRawTransmit":STANDARD.encode(wire),
            "txOutcome":emitted.outcome,
            "acceptedRanges":emitted.accepted_ranges,
            "original":original.utf8_base64,
            "transformDigest":transform.configuration_digest,
            "recordedRxEvents":recorded_rx.len(),
            "recordedTxEvents":recorded_tx.len(),
            "recordedTxOutcome":emitted.outcome,
            "completeContainer":verification.container_complete,
        }))
        .unwrap(),
    )
    .unwrap();
    raw.close().await.unwrap();
}
