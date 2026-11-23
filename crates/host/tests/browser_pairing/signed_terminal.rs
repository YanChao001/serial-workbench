//! 在实际 Host 上安装公开 SDK 签名终端，再由真实配对浏览器验收。
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_host::{
    clock::SystemClock,
    device::DeviceService,
    node_runtime::{NodeRuntimeLimits, verify_node_runtime},
};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::AtomicBool,
};
use tokio::{
    io::Lines,
    process::{ChildStdout, Command},
};

const PACKAGE: &str = "swb.reference.terminal";
const FIRST: &str = "paired-terminal-before-close\n";
const SECOND: &str = "paired-terminal-while-closed\n";
const THIRD: &str = "paired-terminal-after-revoke\n";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedReference {
    archive: PathBuf,
    archive_sha256: Digest,
    source_approval: NodeSourceApproveParams,
}

fn required_path(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).unwrap_or_else(|| panic!("Missing {name}")));
    assert!(path.is_absolute(), "{name} must be absolute");
    path
}

async fn mutate(
    connection: &HostClient,
    target: &Target,
    action: &str,
    params: Value,
    revision: u64,
) -> Operation {
    let RpcRequest::Invoke(mut call) = invoke_request(connection, action, target.clone(), params)
    else {
        unreachable!();
    };
    call.expected_revision = Some(revision.into());
    let RpcResult::Operation(accepted) =
        success(connection.request(RpcRequest::Invoke(call)).await.unwrap())
    else {
        panic!("Missing {action} receipt");
    };
    let operation = wait_operation(connection, &accepted.operation.operation_id).await;
    assert_eq!(
        operation.state,
        OperationState::Succeeded,
        "{action}: {operation:?}"
    );
    operation
}

async fn install(
    ordinary: &HostClient,
    operator: &HostClient,
    target: &Target,
    signed: &SignedReference,
) {
    let params = &signed.source_approval;
    mutate(
        operator,
        target,
        "node.sources.approveKey",
        json!(params),
        0,
    )
    .await;
    let registered = invoke(
        operator,
        "file.register",
        target.clone(),
        json!({"path": signed.archive, "purpose": "read_file"}),
    )
    .await;
    let Some(ActionResult::FileMetadata(reference)) = registered.result else {
        panic!("Missing archive registration");
    };
    let installed = mutate(
        ordinary,
        target,
        "node.packages.install",
        json!({
            "archiveRef": reference.file_ref,
            "source": {"kind": "trusted", "source": params.source, "keyId": params.key_id}
        }),
        0,
    )
    .await;
    let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
        panic!("Missing signed package receipt");
    };
    assert_eq!(installed.package.id.as_str(), PACKAGE);
    assert_eq!(installed.package.archive_sha256, signed.archive_sha256);
    let identity = json!({"id": PACKAGE, "archiveSha256": signed.archive_sha256});
    mutate(
        operator,
        target,
        "node.packages.confirmExecutionTrust",
        identity,
        1,
    )
    .await;
    mutate(
        ordinary,
        target,
        "node.packages.setEnabled",
        json!({"id": PACKAGE, "archiveSha256": signed.archive_sha256, "enabled": true}),
        2,
    )
    .await;
}

async fn echo(ordinary: &HostClient, session: &Target, expected: &str) -> Operation {
    let operation = invoke(
        ordinary,
        "session.tx",
        session.clone(),
        json!({"bytesBase64": STANDARD.encode(expected), "writeWaitMs": "1000"}),
    )
    .await;
    assert_eq!(operation.state, OperationState::Succeeded, "{operation:?}");
    let raw = ordinary.connect_raw().await.unwrap();
    timeout(Duration::from_secs(10), async {
        loop {
            let request = RpcRequest::Query(query(
                ordinary.attachment(),
                session.clone(),
                "stream.read",
                json!({
                    "sessionId": session.id, "sessionEpoch": session.session_epoch,
                    "startEventSeq": "1", "maxEvents": "100", "maxBytes": "262144"
                }),
            ));
            let RpcResult::Query(QueryResult::StreamRead(read)) =
                success(raw.request(request).await.unwrap())
            else {
                panic!("Missing Virtual Echo sources");
            };
            let rx: Vec<u8> = read
                .events
                .iter()
                .filter_map(|event| {
                    let RawPayload::Rx(value) = &event.payload else {
                        return None;
                    };
                    assert_eq!(event.host_id, session.host_id);
                    assert_eq!(event.instance_epoch, ordinary.attachment().instance_epoch);
                    assert_eq!(Some(&event.session_id), session.session_id.as_ref());
                    assert_eq!(Some(event.session_epoch), session.session_epoch);
                    Some(STANDARD.decode(value.bytes_base64.as_str()).unwrap())
                })
                .flatten()
                .collect();
            if rx.ends_with(expected.as_bytes()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Independent local reader did not receive the echo");
    operation
}

async fn stage(reader: &mut Lines<BufReader<ChildStdout>>, expected: &str) {
    let line = timeout(Duration::from_secs(75), reader.next_line())
        .await
        .unwrap_or_else(|_| panic!("Timed out waiting for {expected}"))
        .unwrap();
    assert_eq!(line.as_deref(), Some(expected), "Browser stage {expected}");
}

async fn send(stream: &mut tokio::process::ChildStdin, line: &str) {
    stream.write_all(line.as_bytes()).await.unwrap();
    stream.write_all(b"\n").await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires built workbench, Chromium, a verified Node runtime and a signed SDK terminal"]
async fn paired_chromium_opens_and_retires_a_signed_terminal_view() {
    let assets = required_path("SWB_TEST_BROWSER_ASSETS");
    let receipt = required_path("SWB_TEST_SIGNED_TERMINAL_RECEIPT");
    let node = required_path("SWB_TEST_BROWSER_NODE_BIN");
    let output = required_path("SWB_TEST_BROWSER_TERMINAL_OUTPUT");
    std::fs::create_dir(&output).expect("Use a new browser evidence directory");
    let signed: SignedReference = serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
    let runtime_root = required_path("SWB_NODE_RUNTIME_TEST_ROOT");
    let runtime = tokio::task::spawn_blocking(move || {
        verify_node_runtime(
            &runtime_root,
            &NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
    })
    .await
    .unwrap()
    .unwrap();

    let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let profile = directory.path().join("profile");
    let mut server = HostServer::bind(&profile).await.unwrap();
    let auth = server.auth();
    let host = Arc::new(
        Host::with_verified_node_runtime(
            server.store(),
            auth.clone(),
            Arc::new(SystemClock::new().unwrap()),
            DeviceService::virtual_opener(),
            runtime,
        )
        .await
        .unwrap(),
    );
    let (stop, stop_requested) = oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(host, async {
                let _ = stop_requested.await;
            })
            .await
    });

    let id = client("browser-terminal-local");
    let mut options = ConnectOptions::new(profile.clone(), id.clone(), ClientKind::Desktop);
    let ordinary = HostClient::connect(options.clone()).await.unwrap();
    let credential = read_user_control_credential(&profile).unwrap();
    let operator_actor = auth.authenticate_user_control(&id, &credential).unwrap();
    options.user_control_credential = Some(credential);
    let operator = HostClient::connect(options).await.unwrap();
    let host_target = Target {
        host_id: ordinary.attachment().host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: ordinary.attachment().host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &operator_actor,
        AuthorizeParams {
            client_id: id,
            permissions: vec![
                "content.read".into(),
                "device.modify".into(),
                "plugins.manage".into(),
            ],
            targets: vec![host_target.clone()],
            expires_at: None,
        },
    )
    .unwrap();

    install(&ordinary, &operator, &host_target, &signed).await;
    let opened = invoke(
        &ordinary,
        "device.open",
        Target {
            kind: ResourceKind::try_from("device").unwrap(),
            id: client("virtual:echo"),
            ..host_target.clone()
        },
        json!({"configuration": SerialConfiguration::default()}),
    )
    .await;
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("Virtual Echo did not open");
    };
    let session = Target {
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
        ..host_target.clone()
    };
    let first = echo(&ordinary, &session, FIRST).await;

    let RpcResult::BrowserAccess(BrowserAccessResult {
        browser_access:
            BrowserAccessState::Pairing {
                entry,
                mode: BrowserAccessMode::ReadOnly,
            },
    }) = success(
        operator
            .request(RpcRequest::BrowserAccess(BrowserAccessParams::Pair {
                assets_dir: assets.to_str().unwrap().to_owned(),
                mode: BrowserAccessMode::ReadOnly,
            }))
            .await
            .unwrap(),
    )
    else {
        panic!("Expected read-only browser pairing receipt");
    };
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new(node)
        .arg(repository.join("e2e/paired-browser-terminal.mjs"))
        .arg(&output)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut events = BufReader::new(child.stdout.take().unwrap()).lines();
    send(
        &mut input,
        &json!({
            "url": entry.url, "pairingCode": entry.pairing_code,
            "target": session, "instanceEpoch": ordinary.attachment().instance_epoch,
            "archiveSha256": signed.archive_sha256, "first": FIRST, "second": SECOND,
        })
        .to_string(),
    )
    .await;

    stage(&mut events, "VIEW_CLOSED").await;
    let second = echo(&ordinary, &session, SECOND).await;
    send(&mut input, "SECOND_MARKER_WRITTEN").await;
    stage(&mut events, "VIEW_REOPENED").await;
    let revoked = mutate(
        &operator,
        &host_target,
        "node.packages.revokeExecutionTrust",
        json!({"id": PACKAGE, "archiveSha256": signed.archive_sha256}),
        3,
    )
    .await;
    send(&mut input, "EXECUTION_TRUST_REVOKED").await;
    stage(&mut events, "VIEW_RETIRED").await;
    let after = echo(&ordinary, &session, THIRD).await;
    drop(input);
    let browser = timeout(Duration::from_secs(15), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(browser.success(), "{browser}");

    drop(ordinary);
    drop(operator);
    stop.send(()).unwrap();
    timeout(Duration::from_secs(10), serving)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    std::fs::write(
        output.join("host-terminal-receipt.json"),
        serde_json::to_vec_pretty(&json!({
            "packageId": PACKAGE,
            "archiveSha256": signed.archive_sha256,
            "target": session,
            "first": first,
            "second": second,
            "revoked": revoked,
            "after": after,
            "hostExited": true,
        }))
        .unwrap(),
    )
    .unwrap();
}
