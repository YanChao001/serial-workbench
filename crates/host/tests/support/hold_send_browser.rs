use super::*;
use std::{path::PathBuf, process::Stdio};
use tokio::{io::AsyncWriteExt, time::timeout};

#[tokio::test]
#[ignore = "Requires built web assets and headless Chromium"]
async fn paired_browser_held_send_settles_two_writes_and_stops_on_release() {
    let host = Fixture::new().await;
    use futures_util::FutureExt;
    let result = std::panic::AssertUnwindSafe(check(&host))
        .catch_unwind()
        .await;
    host.finish().await;
    if let Err(failure) = result {
        std::panic::resume_unwind(failure);
    }
}

async fn check(host: &Fixture) {
    const WAIT: Duration = Duration::from_secs(10);
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = PathBuf::from(
        std::env::var_os("SWB_TEST_HOLD_SEND_OUTPUT").expect("Hold-send evidence directory"),
    );
    std::fs::create_dir_all(&output).unwrap();
    let assets = repository
        .join("dist-web")
        .canonicalize()
        .expect("Build browser assets");
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
    let session = host.open().await;

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
            session.clone(),
            vec!["metadata.read", "content.read", "device.modify"],
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
        .arg(repository.join("e2e/paired-browser-hold-send.mjs"))
        .arg(&output)
        .stdin(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let descriptor = json!({"url":entry.url, "pairingCode":entry.pairing_code});
    browser
        .stdin
        .take()
        .unwrap()
        .write_all(format!("{descriptor}\n").as_bytes())
        .await
        .unwrap();
    let status = timeout(Duration::from_secs(60), browser.wait())
        .await
        .expect("Hold-send Chromium timeout")
        .unwrap();
    assert!(status.success(), "Paired hold-send Chromium: {status}");

    let raw = host.user.connect_raw().await.unwrap();
    let request = RpcRequest::Query(host.query(
        &host.user,
        "stream.read",
        session.clone(),
        json!({
            "sessionId":session.session_id, "sessionEpoch":session.session_epoch,
            "startEventSeq":"1", "maxEvents":"40", "maxBytes":"65536",
        }),
    ));
    let (transmitted, received) = timeout(WAIT, async {
        loop {
            let RpcResult::Query(QueryResult::StreamRead(page)) =
                success(raw.request(request.clone()).await.unwrap())
            else {
                panic!("Expected independent Raw evidence");
            };
            let mut tx = Vec::new();
            let mut rx = Vec::new();
            for event in page.events {
                match event.payload {
                    RawPayload::Tx(receipt) => tx.push(*receipt),
                    RawPayload::Rx(payload) => {
                        rx.extend(STANDARD.decode(payload.bytes_base64.as_str()).unwrap())
                    }
                    _ => {}
                }
            }
            if tx.len() >= 2 && rx.len() >= 4 {
                break (tx, rx);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Held writes must settle and echo");
    assert_eq!(transmitted.len(), 2);
    assert_eq!(received, b"ATAT");
    let browser: Value =
        serde_json::from_slice(&std::fs::read(output.join("browser-receipt.json")).unwrap())
            .unwrap();
    for (index, receipt) in transmitted.iter().enumerate() {
        assert_eq!(receipt.outcome, TxOutcome::Accepted);
        assert_eq!(receipt.bytes_base64.as_str(), "QVQ=");
        assert_eq!(receipt.byte_start.get(), index as u64 * 2);
        assert_eq!(receipt.byte_end.get(), index as u64 * 2 + 2);
        assert_eq!(
            receipt.accepted_ranges,
            vec![ByteRange {
                start: 0.into(),
                end: 2.into()
            }]
        );
        assert!(receipt.unknown_ranges.is_empty());
        let query = host.query(
            &host.user,
            "operation.get",
            host.host(),
            json!({"operationId":receipt.operation_id}),
        );
        let RpcResult::Operation(result) = success(
            host.user
                .request(RpcRequest::OperationGet(query))
                .await
                .unwrap(),
        ) else {
            panic!("Expected held operation");
        };
        assert_eq!(
            result.operation.request_id.as_str(),
            browser["requests"][index]["requestId"]
        );
        assert_eq!(result.operation.target, session);
        assert_eq!(result.operation.state, OperationState::Succeeded);
    }
    raw.close().await.unwrap();
    std::fs::write(output.join("host-receipt.json"), serde_json::to_vec_pretty(&json!({
        "heldWrites": 2, "echo": STANDARD.encode(received), "operationIds": transmitted.iter().map(|receipt| &receipt.operation_id).collect::<Vec<_>>(),
        "rawTxRanges": [[0,2],[2,4]], "sameBrowserRequests": true,
    })).unwrap()).unwrap();
}
