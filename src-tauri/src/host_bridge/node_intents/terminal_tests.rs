//! 签名终端包、原生管理意图与真实 Host，文件选择用固定测试输入。
#[path = "../../../../crates/host/tests/support/parity_clients.rs"]
mod parity_clients;
#[path = "reference_automation_tests.rs"]
mod reference_automation_tests;
#[path = "reference_chart_tests.rs"]
mod reference_chart_tests;
#[path = "../../../../crates/host/examples/support/terminal_capture.rs"]
mod terminal_capture;
#[path = "terminal_parity.rs"]
mod terminal_parity;
#[path = "terminal_product.rs"]
mod terminal_product;

use super::{DesktopHostBridge, LocalNodeIntent, document_request_id, params};
use crate::{
    file_resource_commands::{
        FileResourceRole, choose_with_picker, invoke_control, resource_target,
    },
    host_bridge::tests::query,
    node_view::test_support::TestView,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rmcp::{RoleClient, ServiceExt, service::RunningService, transport::TokioChildProcess};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    clock::SystemClock,
    device::{DeviceService, TransportOpener},
    ipc::HostServer,
    node_runtime::{NodeRuntimeLimits, verify_node_runtime},
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedReference {
    archive: PathBuf,
    archive_sha256: Digest,
    source_approval: NodeSourceApproveParams,
}

fn host_query(attachment: &AttachResult, action: &str, params: serde_json::Value) -> Query {
    query(
        attachment,
        action,
        params,
        document_request_id().unwrap().as_str(),
    )
}

fn success(reply: RpcReply) -> RpcResult {
    match reply {
        RpcReply::Success { result, .. } => *result,
        RpcReply::Failure { error, .. } => panic!("{error:?}"),
    }
}

async fn apply(
    bridge: &DesktopHostBridge,
    desktop: &super::super::DesktopAttachment,
    intent: LocalNodeIntent,
) -> ActionResult {
    let accepted = bridge
        .apply_node_intent("main", desktop.generation, intent)
        .await
        .unwrap();
    wait(bridge, &desktop.attachment, accepted)
        .await
        .result
        .expect("management receipt")
}

async fn operation_snapshot(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    id: &Id,
) -> Operation {
    let request = host_query(
        attachment,
        "operation.get",
        serde_json::json!({"operationId": id}),
    );
    let RpcResult::Operation(snapshot) = success(
        bridge
            .request("main", RpcRequest::OperationGet(request))
            .await
            .unwrap(),
    ) else {
        panic!("expected operation receipt");
    };
    assert_eq!(&snapshot.operation.operation_id, id);
    snapshot.operation
}

async fn wait(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    accepted: Operation,
) -> Operation {
    let terminal = wait_terminal(bridge, attachment, &accepted.operation_id).await;
    assert_eq!(terminal.state, OperationState::Succeeded, "{terminal:?}");
    terminal
}

async fn wait_terminal(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    id: &Id,
) -> Operation {
    tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            let snapshot = operation_snapshot(bridge, attachment, id).await;
            if snapshot.state.is_terminal() {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("terminal operation timed out")
}

async fn open_view(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    target: &Target,
) -> Operation {
    let accepted = invoke(
        bridge,
        attachment,
        target,
        "swb.reference.terminal.open",
        serde_json::json!({}),
        ExecutionMode::Interactive,
    )
    .await;
    wait(bridge, attachment, accepted).await
}

async fn terminal_catalog_version(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    expected_visible: bool,
) -> U64 {
    let mut input = CatalogListParams {
        page_size: 100.into(),
        page_token: None,
        catalog_version: None,
    };
    let mut visible = false;
    loop {
        let request = host_query(
            attachment,
            "catalog.list",
            serde_json::to_value(&input).unwrap(),
        );
        let RpcResult::Query(QueryResult::Catalog(page)) = success(
            bridge
                .request("main", RpcRequest::Query(request))
                .await
                .unwrap(),
        ) else {
            panic!("missing Desktop catalog page");
        };
        visible |= page
            .items
            .iter()
            .any(|item| item.action_id.as_str() == "swb.reference.terminal.open");
        let Some(next) = page.next_page_token else {
            assert_eq!(visible, expected_visible, "terminal action visibility");
            return page.catalog_version;
        };
        input.page_token = Some(next);
        input.catalog_version = Some(page.catalog_version);
    }
}

async fn invoke(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    target: &Target,
    action: &str,
    value: serde_json::Value,
    mode: ExecutionMode,
) -> Operation {
    let q = host_query(attachment, action, value);
    let call = Call {
        protocol_version: q.protocol_version,
        host_id: q.host_id,
        instance_epoch: q.instance_epoch,
        actor_id: q.actor_id,
        request_id: q.request_id,
        request_context: attachment.request_context.clone(),
        action_id: q.action_id,
        target: target.clone(),
        params: q.params,
        reveal_target: q.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: Some(mode),
    };
    let RpcResult::Operation(receipt) = success(
        bridge
            .request("main", RpcRequest::Invoke(call))
            .await
            .unwrap(),
    ) else {
        panic!("missing receipt for {action}");
    };
    receipt.operation
}

async fn submit_tx(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    session: &Target,
    bytes: &[u8],
) -> TxReceipt {
    let accepted = invoke(
        bridge,
        attachment,
        session,
        "session.tx",
        serde_json::json!({"bytesBase64": STANDARD.encode(bytes), "writeWaitMs": "5000"}),
        ExecutionMode::Interactive,
    )
    .await;
    let Some(ActionResult::Tx(receipt)) = wait(bridge, attachment, accepted).await.result else {
        panic!("Missing Virtual Echo send receipt");
    };
    receipt
}

async fn tx(bridge: &DesktopHostBridge, attachment: &AttachResult, session: &Target, bytes: &[u8]) {
    let receipt = submit_tx(bridge, attachment, session, bytes).await;
    assert_eq!(receipt.outcome, TxOutcome::Accepted, "{receipt:?}");
}

async fn install_signed_reference(
    bridge: &DesktopHostBridge,
    desktop: &super::super::DesktopAttachment,
    package: SignedReference,
    expected_id: &str,
) {
    let ActionResult::NodeSourceChanged(approved) = apply(
        bridge,
        desktop,
        LocalNodeIntent::ApproveSource {
            expected_revision: 0.into(),
            params: package.source_approval,
        },
    )
    .await
    else {
        panic!("Missing source approval");
    };
    let file = choose_with_picker(
        bridge,
        "main",
        desktop.generation,
        FileResourceRole::Source,
        || async { Ok(Some(package.archive)) },
    )
    .await
    .unwrap()
    .unwrap();
    let ActionResult::NodePackageInstalled(installed) = apply(
        bridge,
        desktop,
        LocalNodeIntent::Install {
            expected_revision: 0.into(),
            params: NodePackageInstallParams {
                archive_ref: file.reference,
                source: NodePackageInstallSource::Trusted {
                    source: approved.key.source,
                    key_id: approved.key.key_id,
                },
            },
        },
    )
    .await
    else {
        panic!("Missing signed reference install");
    };
    assert_eq!(installed.package.id.as_str(), expected_id);
    assert!(
        installed.package.source_verified
            && !installed.package.enabled
            && !installed.package.execution_approved
    );
    assert_eq!(installed.package.archive_sha256, package.archive_sha256);
    let identity = NodePackageIdentityParams {
        id: installed.package.id,
        archive_sha256: installed.package.archive_sha256,
    };
    let ActionResult::NodePackageChanged(trusted) = apply(
        bridge,
        desktop,
        LocalNodeIntent::ConfirmExecutionTrust {
            expected_revision: installed.revision,
            params: identity.clone(),
        },
    )
    .await
    else {
        panic!("Missing explicit reference execution trust");
    };
    let ActionResult::NodePackageChanged(enabled) = apply(
        bridge,
        desktop,
        LocalNodeIntent::SetEnabled {
            expected_revision: trusted.revision,
            params: NodePackageSetEnabledParams {
                id: identity.id,
                archive_sha256: identity.archive_sha256,
                enabled: true,
            },
        },
    )
    .await
    else {
        panic!("Missing reference activation");
    };
    assert!(enabled.package.enabled);
}

async fn read_reference_raw(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    session: &Target,
    action: &str,
    params: serde_json::Value,
) -> RpcResult {
    let mut request = host_query(client, action, params);
    request.target = session.clone();
    success(
        bridge
            .raw_request("main", RpcRequest::Query(request))
            .await
            .unwrap(),
    )
}

async fn wait_reference_rx_end(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    session: &Target,
    byte_end: u64,
) -> StreamReadResult {
    wait_reference_source(
        bridge,
        client,
        session,
        |event| matches!(&event.payload, RawPayload::Rx(rx) if rx.byte_end.get() == byte_end),
    )
    .await
}

async fn wait_reference_source(
    bridge: &DesktopHostBridge,
    client: &AttachResult,
    session: &Target,
    seen: impl Fn(&RawEvent) -> bool,
) -> StreamReadResult {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let RpcResult::Query(QueryResult::StreamRead(page)) = read_reference_raw(
                bridge,
                client,
                session,
                "stream.read",
                serde_json::json!({
                    "sessionId": session.id, "sessionEpoch": session.session_epoch,
                    "startEventSeq": "1", "maxEvents": "100", "maxBytes": "65536"
                }),
            )
            .await
            else {
                panic!("Missing reference source page");
            };
            if page.events.iter().any(&seen) {
                break page;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("Expected virtual serial source event did not arrive")
}

async fn start_reference_capture(
    bridge: &DesktopHostBridge,
    desktop: &super::super::DesktopAttachment,
    session: &Target,
    capture_path: &Path,
) -> (Operation, ObjectRef, Target) {
    let attachment = &desktop.attachment;
    let file = choose_with_picker(
        bridge,
        "main",
        desktop.generation,
        FileResourceRole::CaptureTarget,
        || async { Ok(Some(capture_path.to_path_buf())) },
    )
    .await
    .unwrap()
    .unwrap();
    let file_target = resource_target(&file.reference);
    // 文件选择授予写入，验证人员单独批准读取同一输出，才能观察原始结果引用。
    invoke_control(
        bridge,
        "main",
        desktop.generation,
        "auth.authorize",
        serde_json::json!({
            "clientId": attachment.client_id,
            "permissions": ["content.read"],
            "targets": [file_target],
        }),
    )
    .await
    .unwrap();
    let capture = invoke(
        bridge,
        attachment,
        &file_target,
        "capture.start",
        serde_json::json!({
            "sessionRefs": [session], "targetRef": file.reference, "overflowPolicy": "stop"
        }),
        ExecutionMode::Independent,
    )
    .await;
    let live = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let operation = operation_snapshot(bridge, attachment, &capture.operation_id).await;
            assert!(!operation.state.is_terminal(), "{operation:?}");
            if operation.state == OperationState::Running
                && let Some(ActionResult::Reference(published)) = operation.result
            {
                break published.result_ref;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Capture did not publish a live reference");
    (capture, live, file_target)
}

async fn verify_capture_across_readers(
    bridge: &DesktopHostBridge,
    desktop: &super::super::DesktopAttachment,
    profile: &std::path::Path,
    session: &Target,
    opened_view: &Operation,
) -> TestView {
    let attachment = &desktop.attachment;
    let capture_path = profile.join("terminal-continuity.swbcap");
    let (capture, live, file_target) =
        start_reference_capture(bridge, desktop, session, &capture_path).await;

    let mut cursor = host_query(attachment, "stream.cursor", serde_json::json!({}));
    cursor.target = session.clone();
    assert!(matches!(
        success(
            bridge
                .raw_request_at_generation("main", desktop.generation, RpcRequest::Query(cursor))
                .await
                .unwrap()
        ),
        RpcResult::Query(QueryResult::StreamCursor(_))
    ));

    let first = b"terminal-reader-open\n";
    let closed = b"terminal-reader-closed\n";
    let last = b"terminal-reader-reopened\n";
    let mut reader = TestView::open(bridge, desktop.generation, opened_view.clone(), session).await;
    tx(bridge, attachment, session, first).await;
    assert_eq!(reader.receive_through(first).await, first);
    drop(reader);

    tx(bridge, attachment, session, closed).await;
    let reopened = open_view(bridge, attachment, session).await;
    let mut reader = TestView::open(bridge, desktop.generation, reopened, session).await;
    assert_eq!(
        reader.receive_through(closed).await,
        [first.as_slice(), closed].concat()
    );
    tx(bridge, attachment, session, last).await;
    assert_eq!(reader.receive_through(last).await, last);

    let stopped = invoke(
        bridge,
        attachment,
        &resource_target(&live),
        "capture.stop",
        serde_json::json!({"captureRef": live}),
        ExecutionMode::Interactive,
    )
    .await;
    wait(bridge, attachment, stopped).await;
    let capture = wait(bridge, attachment, capture).await;
    let Some(ActionResult::CaptureStatus(finalized)) = &capture.result else {
        panic!("Missing final capture receipt");
    };
    assert_eq!(finalized.summary.state, CaptureState::Complete);
    assert!(finalized.summary.container_complete && finalized.summary.source_continuous);
    let recorded = [first.as_slice(), closed, last].concat();
    let verified = terminal_capture::check(&capture_path, &recorded).unwrap();
    assert!(verified.report.source_continuous);
    assert_eq!(verified.rx[0].session_id, session.id);
    assert_eq!(Some(verified.rx[0].session_epoch), session.session_epoch);
    eprintln!(
        "terminal_native_reader_capture verified=true same_epoch=true rx_bytes={}",
        recorded.len()
    );
    terminal_parity::verify(
        bridge,
        desktop,
        profile,
        session,
        &file_target,
        &capture,
        verified.rx,
    )
    .await;
    reader
}

async fn verify_slow_reader_gap(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    session: &Target,
    reader: &mut TestView,
) {
    // 保持签名视图 reader 暂停，走正常 TX 路径填满它的独立队列。
    // 每笔留出回显余量，区分设备队列满与视图 reader 队列满。
    let block = vec![b'x'; 32 * 1024];
    // 每笔产生 TX 与对应 RX，另留出给已在途的批次。
    let blocks = attachment.limits.max_reader_queue_bytes.get() / (2 * block.len() as u64) + 12;
    for _ in 0..blocks {
        tx(bridge, attachment, session, &block).await;
    }
    let marker = b"terminal-reader-resumed-after-gap\n";
    tx(bridge, attachment, session, marker).await;

    tokio::time::timeout(Duration::from_secs(10), async {
        let mut first_gap = None;
        let mut received = Vec::new();
        loop {
            let Some(frame) = reader.next().await.unwrap() else {
                continue;
            };
            let IpcMessage::RawBatch { batch } = frame.body else {
                panic!("Slow reader stopped before recovering: {frame:?}");
            };
            let mut next_seq = batch.previous_cursor.position.get() + 1;
            for item in batch.items {
                match item {
                    StreamItem::ReaderGap { gap } => {
                        assert_eq!(gap.reason, ReaderGapReason::ReaderOverflow);
                        assert_eq!(&gap.session_id, session.session_id.as_ref().unwrap());
                        assert_eq!(Some(gap.session_epoch), session.session_epoch);
                        assert_eq!(gap.missing_event_range.start.get(), next_seq);
                        next_seq = gap.missing_event_range.end.get();
                        first_gap.get_or_insert(gap.missing_event_range);
                        received.clear();
                    }
                    StreamItem::Source { event } => {
                        assert_eq!(event.event_seq.get(), next_seq);
                        next_seq += 1;
                        if let RawPayload::Rx(rx) = event.payload {
                            received.extend(STANDARD.decode(rx.bytes_base64.as_str()).unwrap());
                        }
                    }
                }
            }
            assert_eq!(batch.cursor.position.get() + 1, next_seq);
            if received.ends_with(marker) {
                let gap = first_gap.expect("A paused terminal reader must report overflow");
                eprintln!(
                    "terminal_native_reader_gap pause_bytes={} missing_events={}..{} resumed=true",
                    blocks * block.len() as u64,
                    gap.start,
                    gap.end
                );
                break;
            }
        }
    })
    .await
    .expect("Terminal reader did not continue to the post-overflow marker");
}

async fn verify_maximum_tx_event(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    session: &Target,
    reader: &mut TestView,
) {
    let bytes = vec![b'y'; TX_MAX_BYTES];
    // Virtual Echo 允许部分写入，合法的 TX intent 仍包含完整请求。
    let submitted = submit_tx(bridge, attachment, session, &bytes).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let Some(frame) = reader.next().await.unwrap() else {
                continue;
            };
            let IpcMessage::RawBatch { batch } = frame.body else {
                panic!("The terminal reader stopped on a valid TX event: {frame:?}");
            };
            for item in batch.items {
                let StreamItem::Source { event } = item else {
                    panic!("Unexpected reader gap during a single TX: {item:?}");
                };
                if let RawPayload::TxIntent(intent) = event.payload
                    && intent.operation_id == submitted.operation_id
                {
                    assert_eq!(
                        STANDARD.decode(intent.bytes_base64.as_str()).unwrap(),
                        bytes
                    );
                    eprintln!(
                        "terminal_native_maximum_tx_event bytes={} preserved=true",
                        bytes.len()
                    );
                    return;
                }
            }
        }
    })
    .await
    .expect("The terminal reader did not deliver the maximum TX intent");
}

fn view_request(
    attachment: &AttachResult,
    opened: &Operation,
    params: serde_json::Value,
) -> RpcRequest {
    let mut q = host_query(attachment, "node.views.assetRead", params);
    q.target.kind = ResourceKind::try_from("operation").unwrap();
    q.target.id = opened.operation_id.clone();
    RpcRequest::Query(q)
}

fn assert_error(reply: RpcReply, expected: &str) {
    match reply {
        RpcReply::Failure { error, .. } => assert_eq!(error.code, expected, "{error:?}"),
        RpcReply::Success { result, .. } => panic!("expected {expected}: {result:?}"),
    }
}

async fn verify_view_access(
    bridge: &DesktopHostBridge,
    desktop: &super::super::DesktopAttachment,
    mcp: &HostClient,
    session: &Target,
    opened: &Operation,
    archive_sha256: &Digest,
) -> NodeViewAssetReadResult {
    let business = &desktop.attachment;
    let params = serde_json::json!({"viewId":"swb.reference.terminal.view", "offset":"0"});
    let request = || view_request(business, opened, params.clone());
    let RpcResult::Query(QueryResult::NodeViewAsset(asset)) =
        success(bridge.request("main", request()).await.unwrap())
    else {
        panic!("missing signed view resource")
    };
    assert_eq!(&asset.archive_sha256, archive_sha256);
    assert_eq!(&asset.target, session);
    assert_eq!(asset.path.as_str(), "ui/index.html");
    assert_eq!(asset.path, asset.entry);
    let expected =
        include_bytes!("../../../../packages/plugin-sdk/examples/reference-terminal/index.html");
    assert_eq!(
        STANDARD.decode(asset.bytes_base64.as_str()).unwrap(),
        expected
    );
    let invalid = [
        (
            "UNSUPPORTED_CAPABILITY",
            serde_json::json!({"viewId":"other", "offset":"0"}),
        ),
        (
            "INVALID_ARGUMENT",
            serde_json::json!({"viewId":"swb.reference.terminal.view", "offset":"0","path":"../blocked"}),
        ),
        (
            "INVALID_ARGUMENT",
            serde_json::json!({"viewId":"swb.reference.terminal.view", "offset":"1"}),
        ),
        (
            "NOT_FOUND",
            serde_json::json!({"viewId":"swb.reference.terminal.view", "offset":"0","path":"unlisted.html"}),
        ),
    ];
    for (code, params) in invalid {
        assert_error(
            bridge
                .request("main", view_request(business, opened, params))
                .await
                .unwrap(),
            code,
        );
    }

    let mcp_request = || view_request(mcp.attachment(), opened, params.clone());
    assert_error(
        mcp.request(mcp_request()).await.unwrap(),
        "PERMISSION_DENIED",
    );
    invoke_control(
        bridge,
        "main",
        desktop.generation,
        "auth.authorize",
        serde_json::to_value(AuthorizeParams {
            client_id: mcp.attachment().client_id.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![session.clone()],
            expires_at: None,
        })
        .unwrap(),
    )
    .await
    .unwrap();
    let RpcResult::Query(QueryResult::NodeViewAsset(granted)) =
        success(mcp.request(mcp_request()).await.unwrap())
    else {
        panic!("missing authorized MCP view resource")
    };
    assert_eq!(granted, asset);
    invoke_control(
        bridge,
        "main",
        desktop.generation,
        "auth.revoke",
        serde_json::to_value(RevokeParams {
            actor_id: mcp.attachment().actor_id.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![session.clone()],
        })
        .unwrap(),
    )
    .await
    .unwrap();
    assert_error(
        mcp.request(mcp_request()).await.unwrap(),
        "PERMISSION_DENIED",
    );
    let RpcResult::Query(QueryResult::NodeViewAsset(still_allowed)) =
        success(bridge.request("main", request()).await.unwrap())
    else {
        panic!("desktop view authority changed with MCP grant")
    };
    assert_eq!(still_allowed, asset);
    *asset
}

async fn list(bridge: &DesktopHostBridge, desktop: &AttachResult) -> NodePackageListResult {
    let request = host_query(desktop, "node.packages.list", serde_json::json!({}));
    let RpcResult::Query(QueryResult::NodePackages(list)) = success(
        bridge
            .request("main", RpcRequest::Query(request))
            .await
            .unwrap(),
    ) else {
        panic!("missing installation snapshot")
    };
    list
}

async fn runtime(
    bridge: &DesktopHostBridge,
    desktop: &AttachResult,
    id: &NodePackageId,
) -> NodePackageRuntimeStatus {
    let request = host_query(
        desktop,
        "node.packages.runtime",
        serde_json::json!({"id": id}),
    );
    let RpcResult::Query(QueryResult::NodePackageRuntime(runtime)) = success(
        bridge
            .request("main", RpcRequest::Query(request))
            .await
            .unwrap(),
    ) else {
        panic!("missing runtime snapshot")
    };
    runtime
}

async fn deny_confirmation(
    client: &HostClient,
    identity: &NodePackageIdentityParams,
    revision: U64,
) {
    let attachment = client.attachment();
    let mut catalog = CatalogListParams {
        page_size: 20.into(),
        page_token: None,
        catalog_version: None,
    };
    loop {
        let request = host_query(
            attachment,
            "catalog.list",
            serde_json::to_value(&catalog).unwrap(),
        );
        let RpcResult::Catalog(page) = success(
            client
                .request(RpcRequest::CatalogList(request))
                .await
                .unwrap(),
        ) else {
            panic!("missing MCP catalog page");
        };
        assert!(
            page.items
                .iter()
                .all(|item| item.action_id.as_str() != "node.packages.confirmExecutionTrust")
        );
        let Some(next) = page.next_page_token else {
            break;
        };
        catalog.page_token = Some(next);
        catalog.catalog_version = Some(page.catalog_version);
    }
    let action = "node.packages.confirmExecutionTrust";
    let request = host_query(attachment, action, serde_json::to_value(identity).unwrap());
    let reply = client
        .request(RpcRequest::Invoke(Call {
            protocol_version: request.protocol_version,
            host_id: request.host_id,
            instance_epoch: request.instance_epoch,
            actor_id: request.actor_id,
            request_id: request.request_id,
            request_context: attachment.request_context.clone(),
            action_id: request.action_id,
            target: request.target,
            params: params(identity).unwrap(),
            reveal_target: request.reveal_target,
            expected_revision: Some(revision),
            lease_id: None,
            execution_mode: Some(ExecutionMode::Interactive),
        }))
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"));
}

#[tokio::test]
#[ignore = "requires prepared native Node and SWB_TEST_SIGNED_TERMINAL_RECEIPT"]
async fn native_reference_terminal_install_enable_and_revoke_through_desktop_bridge() {
    let terminal = signed_reference("SWB_TEST_SIGNED_TERMINAL_RECEIPT");
    with_embedded_host(async move |profile| exercise_terminal(profile, terminal, None).await).await;
}

async fn with_embedded_host(exercise: impl AsyncFnOnce(&Path)) {
    with_embedded_opener(DeviceService::virtual_opener(), exercise).await;
}

async fn with_embedded_opener(opener: TransportOpener, exercise: impl AsyncFnOnce(&Path)) {
    let root = PathBuf::from(
        std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").expect("prepared runtime root"),
    );
    assert!(root.is_absolute());
    let node = verify_node_runtime(
        &root,
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(profile.path()).await.unwrap();
    let host = Host::with_verified_node_runtime(
        server.store(),
        server.auth(),
        Arc::new(SystemClock::new().unwrap()),
        opener,
        node,
    )
    .await
    .unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = stopped.await;
            })
            .await
    });
    exercise(profile.path()).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}

async fn start_reference_mcp(profile: &Path) -> RunningService<RoleClient, ()> {
    let mut command = tokio::process::Command::new(parity_clients::binary(
        "SWB_TEST_MCP_BIN",
        "serial-workbench-mcp",
    ));
    command.arg("--profile").arg(profile).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let transport = TokioChildProcess::new(command).expect("Start actual MCP stdio program");
    tokio::time::timeout(Duration::from_secs(10), ().serve(transport))
        .await
        .expect("MCP initialization timed out")
        .unwrap()
}

fn signed_reference(variable: &str) -> SignedReference {
    let receipt = std::env::var_os(variable).unwrap_or_else(|| panic!("Missing {variable}"));
    let package: SignedReference =
        serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
    assert!(package.archive.is_absolute());
    package
}

#[tokio::test]
#[ignore = "requires SWB_TEST_TERMINAL_HOST_BIN with its prepared runtime and matching CLI/MCP"]
async fn native_reference_terminal_uses_installed_runtime_through_formal_host() {
    use parity_clients::{Cli, binary};
    use std::{fs, process::Stdio};
    use tokio::{process::Command, time::timeout};

    let terminal = signed_reference("SWB_TEST_SIGNED_TERMINAL_RECEIPT");
    let binary_path = PathBuf::from(
        std::env::var_os("SWB_TEST_TERMINAL_HOST_BIN").expect("formal Host executable"),
    );
    assert!(binary_path.is_absolute() && binary_path.is_file());
    let cli_path = binary("SWB_TEST_CLI_BIN", "serial-workbench-cli");
    assert!(
        std::env::var_os("SWB_TEST_CLI_BIN").is_some()
            && std::env::var_os("SWB_TEST_MCP_BIN").is_some(),
        "Provide both same-source client binaries"
    );
    let dir = tempfile::Builder::new()
        .prefix("swb-formal-terminal-")
        .tempdir_in(std::env::temp_dir().canonicalize().unwrap())
        .unwrap();
    let profile = dir.path().join("profile");
    let cwd = dir.path().join("unrelated-working-directory");
    fs::create_dir(&cwd).unwrap();
    let log = fs::File::create(dir.path().join("host.stderr.log")).unwrap();
    let mut command = Command::new(&binary_path);
    command
        .current_dir(&cwd)
        .arg("--profile")
        .arg(&profile)
        .env_remove("PATH")
        .env_remove("SWB_NODE_RUNTIME_TEST_ROOT")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().expect("Spawn actual product Host");
    let host_pid = child.id().unwrap();
    let ready_profile = profile.clone();
    let verified = tokio::spawn(async move {
        let mut options = ConnectOptions::new(
            ready_profile.clone(),
            Id::try_from("terminal-formal-probe").unwrap(),
            ClientKind::Cli,
        );
        options.expected_host_executable = Some(binary_path);
        let available = timeout(Duration::from_secs(15), async {
            loop {
                if let Ok(client) = HostClient::connect(options.clone()).await {
                    break client;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("Formal Host did not become ready");
        available.close().await.unwrap();
        exercise_terminal(&ready_profile, terminal, Some(host_pid)).await;
    })
    .await;
    // 断言失败仍先结算自有 Host，再保留本轮独立 profile 与日志。
    let stopped = tokio::spawn({
        let profile = profile.clone();
        async move {
            Cli {
                binary: cli_path,
                profile,
            }
            .json(&["host", "stop", "--json"])
            .await
        }
    })
    .await;
    let exit = timeout(Duration::from_secs(15), child.wait()).await;
    let clean_exit = exit
        .as_ref()
        .is_ok_and(|result| result.as_ref().is_ok_and(|status| status.success()));
    if !clean_exit && child.id().is_some() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    if verified.is_err() || stopped.is_err() || !clean_exit {
        let evidence = dir.keep();
        panic!(
            "Formal terminal verification or cleanup failed, evidence at {}: verified={verified:?}, stopped={stopped:?}, exit={exit:?}",
            evidence.display()
        );
    }
    eprintln!("terminal_formal_host exited=true pid={host_pid} path_node_fallback=false");
}

async fn exercise_terminal(
    profile: &Path,
    terminal: SignedReference,
    expected_host_pid: Option<u32>,
) {
    let (notify, mut changes) = tokio::sync::watch::channel(None);
    let bridge = DesktopHostBridge::new(profile.to_owned()).with_catalog_notifier(
        move |window, generation, version| {
            assert_eq!(window, "main");
            notify.send_replace(Some((generation, version)));
        },
    );
    let attached = bridge.attach("main").await.unwrap();
    let business = &attached.attachment;
    let wait_notice = async |changes: &mut tokio::sync::watch::Receiver<Option<(U64, U64)>>,
                             version| {
        let notice = tokio::time::timeout(
            Duration::from_secs(5),
            changes.wait_for(|value| *value == Some((attached.generation, version))),
        )
        .await
        .expect("Desktop did not receive the matching catalog notice");
        assert!(notice.is_ok(), "Desktop catalog notifier closed");
    };
    let mcp = HostClient::connect(ConnectOptions::new(
        profile.to_owned(),
        Id::try_from("terminal-ordinary-mcp").unwrap(),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    let ActionResult::NodeSourceChanged(approved) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::ApproveSource {
            expected_revision: 0.into(),
            params: terminal.source_approval,
        },
    )
    .await
    else {
        panic!("missing source approval receipt");
    };
    assert!(approved.key.approved);

    let file = choose_with_picker(
        &bridge,
        "main",
        attached.generation,
        FileResourceRole::Source,
        || async { Ok(Some(terminal.archive)) },
    )
    .await
    .unwrap()
    .unwrap();
    let before = list(&bridge, business).await;
    assert!(before.packages.is_empty());
    let ActionResult::NodePackageInstalled(installed) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::Install {
            expected_revision: before.revision,
            params: NodePackageInstallParams {
                archive_ref: file.reference,
                source: NodePackageInstallSource::Trusted {
                    source: approved.key.source.clone(),
                    key_id: approved.key.key_id.clone(),
                },
            },
        },
    )
    .await
    else {
        panic!("missing signed install receipt")
    };
    assert_eq!(installed.package.id.as_str(), "swb.reference.terminal");
    assert_eq!(
        installed.package.display_name.as_deref(),
        Some("Serial Monitor")
    );
    assert_eq!(installed.package.version.as_deref(), Some("0.1.1"));
    assert_eq!(installed.package.archive_sha256, terminal.archive_sha256);
    assert!(installed.package.source_verified);
    assert!(!installed.package.enabled && !installed.package.execution_approved);

    let identity = NodePackageIdentityParams {
        id: installed.package.id.clone(),
        archive_sha256: installed.package.archive_sha256.clone(),
    };
    let snapshot = list(&bridge, business).await;
    assert_eq!(
        snapshot.packages.as_slice(),
        std::slice::from_ref(&installed.package)
    );
    deny_confirmation(&mcp, &identity, snapshot.revision).await;
    assert_eq!(list(&bridge, business).await, snapshot);

    let ActionResult::NodePackageChanged(trusted) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::ConfirmExecutionTrust {
            expected_revision: installed.revision,
            params: identity.clone(),
        },
    )
    .await
    else {
        panic!("missing trust receipt")
    };
    assert!(trusted.package.execution_approved && !trusted.package.enabled);
    assert_eq!(
        runtime(&bridge, business, &identity.id).await.phase,
        NodePackageRuntimePhase::Inactive
    );
    let before_enable_catalog = terminal_catalog_version(&bridge, business, false).await;

    let ActionResult::NodePackageChanged(enabled) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::SetEnabled {
            expected_revision: trusted.revision,
            params: NodePackageSetEnabledParams {
                id: identity.id.clone(),
                archive_sha256: identity.archive_sha256.clone(),
                enabled: true,
            },
        },
    )
    .await
    else {
        panic!("missing enable receipt")
    };
    let active = runtime(&bridge, business, &identity.id).await;
    assert_eq!(active.phase, NodePackageRuntimePhase::Active);
    assert_eq!(
        active.archive_sha256.as_ref(),
        Some(&identity.archive_sha256)
    );
    assert!(active.generation.get() > 0);
    if let Some(host_pid) = expected_host_pid {
        verify_formal_runtime(&bridge, business, host_pid).await;
    }

    let opened = bridge
        .connect_device_intent(
            "main",
            attached.generation,
            Id::try_from("virtual:echo").unwrap(),
            OpenParams {
                configuration: SerialConfiguration::default(),
                binding: None,
            },
        )
        .await
        .unwrap();
    let session = Target {
        host_id: business.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
    };
    let enabled_catalog = terminal_catalog_version(&bridge, business, true).await;
    assert!(enabled_catalog > before_enable_catalog);
    wait_notice(&mut changes, enabled_catalog).await;
    let view = open_view(&bridge, business, &session).await;
    let first = verify_view_access(
        &bridge,
        &attached,
        &mcp,
        &session,
        &view,
        &identity.archive_sha256,
    )
    .await;
    let mut renderer_reader =
        verify_capture_across_readers(&bridge, &attached, profile, &session, &view).await;
    if expected_host_pid.is_none() {
        verify_slow_reader_gap(&bridge, business, &session, &mut renderer_reader).await;
        verify_maximum_tx_event(&bridge, business, &session, &mut renderer_reader).await;
    }
    let view_params = serde_json::json!({"viewId":"swb.reference.terminal.view", "offset":"0"});

    let ActionResult::NodePackageChanged(revoked) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::RevokeExecutionTrust {
            expected_revision: enabled.revision,
            params: identity.clone(),
        },
    )
    .await
    else {
        panic!("missing revocation receipt")
    };
    assert!(!revoked.package.enabled && !revoked.package.execution_approved);
    assert!(matches!(
        renderer_reader.next().await,
        Err(error) if error.code == "UNSUPPORTED_CAPABILITY"
    ));
    drop(renderer_reader);
    assert_eq!(
        runtime(&bridge, business, &identity.id).await.phase,
        NodePackageRuntimePhase::Inactive
    );
    let revoked_catalog = terminal_catalog_version(&bridge, business, false).await;
    assert!(revoked_catalog > enabled_catalog);
    wait_notice(&mut changes, revoked_catalog).await;
    let old_view = || view_request(business, &view, view_params.clone());
    assert_error(
        bridge.request("main", old_view()).await.unwrap(),
        "UNSUPPORTED_CAPABILITY",
    );
    let ActionResult::NodePackageChanged(retrusted) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::ConfirmExecutionTrust {
            expected_revision: revoked.revision,
            params: identity.clone(),
        },
    )
    .await
    else {
        panic!("missing new trust receipt")
    };
    let ActionResult::NodePackageChanged(reactivated) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::SetEnabled {
            expected_revision: retrusted.revision,
            params: NodePackageSetEnabledParams {
                id: identity.id.clone(),
                archive_sha256: identity.archive_sha256.clone(),
                enabled: true,
            },
        },
    )
    .await
    else {
        panic!("missing reactivation receipt");
    };
    let reactivated_catalog = terminal_catalog_version(&bridge, business, true).await;
    assert!(reactivated_catalog > revoked_catalog);
    wait_notice(&mut changes, reactivated_catalog).await;
    eprintln!(
        "terminal_catalog_notifications enabled=true revoked=true reactivated=true same_attachment=true"
    );
    assert_error(
        bridge.request("main", old_view()).await.unwrap(),
        "CATALOG_CHANGED",
    );
    let reopened = open_view(&bridge, business, &session).await;
    let RpcResult::Query(QueryResult::NodeViewAsset(latest)) = success(
        bridge
            .request(
                "main",
                view_request(business, &reopened, view_params.clone()),
            )
            .await
            .unwrap(),
    ) else {
        panic!("missing view after reactivation");
    };
    assert_ne!(latest.activation_id, first.activation_id);
    assert_eq!(latest.bytes_base64, first.bytes_base64);

    let ActionResult::NodePackageChanged(disabled) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::SetEnabled {
            expected_revision: reactivated.revision,
            params: NodePackageSetEnabledParams {
                id: identity.id.clone(),
                archive_sha256: identity.archive_sha256.clone(),
                enabled: false,
            },
        },
    )
    .await
    else {
        panic!("missing disable receipt");
    };
    assert!(!disabled.package.enabled && disabled.package.execution_approved);
    assert_eq!(
        runtime(&bridge, business, &identity.id).await.phase,
        NodePackageRuntimePhase::Inactive
    );
    assert_error(
        bridge
            .request("main", view_request(business, &reopened, view_params))
            .await
            .unwrap(),
        "UNSUPPORTED_CAPABILITY",
    );
    let NodePackageSourceKey {
        source,
        key_id,
        public_key_sha256,
        ..
    } = approved.key;
    let ActionResult::NodeSourceChanged(revoked_source) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::RevokeSource {
            expected_revision: approved.revision,
            params: NodeSourceRevokeParams {
                source,
                key_id,
                public_key_sha256: public_key_sha256.clone(),
            },
        },
    )
    .await
    else {
        panic!("missing source revocation receipt");
    };
    assert!(!revoked_source.key.approved);
    assert_eq!(revoked_source.key.public_key_sha256, public_key_sha256);
    let ActionResult::NodePackageUninstalled(removed) = apply(
        &bridge,
        &attached,
        LocalNodeIntent::Uninstall {
            expected_revision: disabled.revision,
            params: identity.clone(),
        },
    )
    .await
    else {
        panic!("missing uninstall receipt");
    };
    assert_eq!(removed.id, identity.id);
    assert_eq!(removed.archive_sha256, identity.archive_sha256);
    assert!(list(&bridge, business).await.packages.is_empty());
    eprintln!("terminal_management disabled=true source_revoked=true uninstalled=true");

    mcp.close().await.unwrap();
    drop(bridge);
}

async fn verify_formal_runtime(
    bridge: &DesktopHostBridge,
    attachment: &AttachResult,
    host_pid: u32,
) {
    let node = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let request = host_query(attachment, "host.metrics", serde_json::json!({}));
            let RpcResult::Query(QueryResult::HostMetrics(metrics)) = success(
                bridge
                    .request("main", RpcRequest::Query(request))
                    .await
                    .unwrap(),
            ) else {
                panic!("Expected actual Host metrics");
            };
            assert_eq!(metrics.process_id.get(), u64::from(host_pid));
            if let Some(node) = metrics.node {
                break node;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("Formal Host did not report a verified Node owner");
    assert!(node.process_id.get() != 0 && node.process_id.get() != u64::from(host_pid));
    eprintln!(
        "terminal_formal_node pid={} host_pid={host_pid}",
        node.process_id
    );
}
