use super::{
    assert_error, host_query, invoke_control,
    parity_clients::{Cli, binary, drain, structured, tool, tool_reply},
    resource_target, success, terminal_product, wait,
};
use crate::host_bridge::{DesktopAttachment, DesktopHostBridge};
use rmcp::{RoleClient, ServiceError, ServiceExt, model::ErrorCode, transport::TokioChildProcess};
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{process::Command, time::timeout};

pub(super) async fn verify(
    bridge: &DesktopHostBridge,
    desktop: &DesktopAttachment,
    profile: &Path,
    session: &Target,
    destination: &Target,
    finalized: &Operation,
    recorded_rx: Vec<RawEvent>,
) {
    let configured =
        ["SWB_TEST_CLI_BIN", "SWB_TEST_MCP_BIN"].map(|name| std::env::var_os(name).is_some());
    if configured == [false, false] {
        eprintln!("terminal_client_parity skipped: CLI and MCP paths were not supplied");
        return;
    }
    assert_eq!(
        configured,
        [true, true],
        "Supply both real product programs"
    );
    let cli = Cli {
        binary: binary("SWB_TEST_CLI_BIN", "serial-workbench-cli"),
        profile: profile.to_path_buf(),
    };
    let mcp = binary("SWB_TEST_MCP_BIN", "serial-workbench-mcp");
    let mut mcp_identity = None;
    for (id, kind) in [
        ("serial-workbench-cli", ClientKind::Cli),
        ("serial-workbench-mcp", ClientKind::Mcp),
    ] {
        let identity = HostClient::connect(ConnectOptions::new(
            profile.to_path_buf(),
            Id::try_from(id).unwrap(),
            kind,
        ))
        .await
        .unwrap();
        invoke_control(
            bridge,
            "main",
            desktop.generation,
            "auth.authorize",
            json!({"clientId": id, "permissions": ["content.read"], "targets": [session, destination]}),
        )
        .await
        .unwrap();
        if kind == ClientKind::Mcp {
            mcp_identity = Some(identity);
        } else {
            identity.close().await.unwrap();
        }
    }
    let mcp_identity = mcp_identity.unwrap();

    let mut command = Command::new(&mcp);
    command.arg("--profile").arg(profile).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let (transport, stderr) = TokioChildProcess::builder(command)
        .stderr(Stdio::piped())
        .spawn()
        .expect("Start actual MCP stdio program");
    let mut stderr = tokio::spawn(drain(stderr.unwrap()));
    let sdk = timeout(Duration::from_secs(10), ().serve(transport))
        .await
        .expect("MCP initialization timed out")
        .unwrap();
    let peer = sdk.peer().clone();
    let session = session.clone();
    let destination = destination.clone();
    let finalized = finalized.clone();
    let Some(ActionResult::CaptureStatus(summary)) = &finalized.result else {
        panic!("Missing completed capture result");
    };
    let capture = summary.capture_ref.clone();
    let product = terminal_product::Product::configured(profile, mcp);
    let bridge = bridge.clone();
    let generation = desktop.generation;
    let desktop_identity = desktop.attachment.clone();
    let assertion_budget = Duration::from_secs(if product.is_some() { 120 } else { 60 });
    let mut assertions = tokio::spawn(async move {
        let stream = json!({
            "sessionId": session.id, "sessionEpoch": session.session_epoch, "startEventSeq": "1",
            "maxEvents": "100", "maxBytes": "262144"
        });
        let tail = json!({"captureRef": capture, "maxRecords": "100", "maxBytes": "262144"});
        let target = resource_target(&capture);
        let QueryResult::StreamRead(cli_stream) =
            query(&cli, "stream.read", &session, &stream).await
        else {
            panic!("Missing CLI Raw result");
        };
        let QueryResult::CaptureTail(cli_capture) =
            query(&cli, "capture.tail", &target, &tail).await
        else {
            panic!("Missing CLI capture result");
        };
        let mcp_stream: StreamReadResult =
            read(&peer, "swb_stream_x2E_read", &session, &stream).await;
        let mcp_capture: CaptureTailResult =
            read(&peer, "swb_capture_x2E_tail", &target, &tail).await;
        assert_eq!(cli_stream, mcp_stream);
        assert_eq!(cli_capture, mcp_capture);
        assert!(!cli_stream.has_more);
        assert!(cli_capture.container_complete && cli_capture.source_continuous);
        assert_eq!(cli_capture.capture_ref, capture);
        let raw_rx: Vec<_> = cli_stream
            .events
            .into_iter()
            .filter(|event| matches!(event.payload, RawPayload::Rx(_)))
            .collect();
        let capture_rx: Vec<_> = cli_capture
            .records
            .into_iter()
            .filter_map(|item| match item {
                ReplayRecord::Inline { record } => match record.entry {
                    CaptureEntry::Event(event) if matches!(event.payload, RawPayload::Rx(_)) => {
                        Some(*event)
                    }
                    _ => None,
                },
                _ => panic!("Expected inline records for the Virtual acceptance sample"),
            })
            .collect();
        assert_eq!(raw_rx, recorded_rx);
        assert_eq!(capture_rx, recorded_rx);

        if let Some(product) = &product {
            let accepted = product
                .authorized(&session, &target, &tail, &finalized, &mcp_capture)
                .await;
            assert_eq!(accepted.actor_id, mcp_identity.attachment().actor_id);
            let complete = wait(&bridge, &desktop_identity, accepted).await;
            assert_eq!(complete.target, session);
            assert_eq!(complete.owner.kind, OwnerKind::Plugin);
            let Some(ActionResult::Reference(reference)) = complete.result else {
                panic!("Missing signed action result");
            };
            assert_eq!(reference.result_ref.kind.as_str(), "plugin_result");
            assert_eq!(reference.result_ref.host_id, session.host_id);
        }

        invoke_control(
            &bridge,
            "main",
            generation,
            "auth.revoke",
            json!({
                "actorId": mcp_identity.attachment().actor_id, "permissions": ["content.read"],
                "targets": [session, destination]
            }),
        )
        .await
        .unwrap();
        if let Some(product) = &product {
            product.revoked(&finalized).await;
        }
        let mcp_raw = mcp_identity.connect_raw().await.unwrap();
        for (name, action, target, params) in [
            ("swb_stream_x2E_read", "stream.read", &session, &stream),
            ("swb_capture_x2E_tail", "capture.tail", &target, &tail),
        ] {
            let Err(ServiceError::McpError(error)) =
                tool_reply(&peer, name, target, params.clone()).await
            else {
                panic!("Revoked tool {name} must be hidden from the MCP catalog");
            };
            assert_eq!(error.code, ErrorCode::METHOD_NOT_FOUND);
            assert!(error.data.is_none());

            let mut request = host_query(mcp_identity.attachment(), action, params.clone());
            request.target = target.clone();
            assert_error(
                mcp_raw.request(RpcRequest::Query(request)).await.unwrap(),
                "PERMISSION_DENIED",
            );
        }
        mcp_raw.close().await.unwrap();
        mcp_identity.close().await.unwrap();
        let QueryResult::StreamRead(after_revoke) =
            query(&cli, "stream.read", &session, &stream).await
        else {
            panic!("CLI retained its independent read grant");
        };
        assert_eq!(after_revoke, mcp_stream);
        assert_eq!(
            query(&cli, "capture.tail", &target, &tail).await,
            QueryResult::CaptureTail(mcp_capture),
        );
        eprintln!(
            "terminal_client_parity desktop_cli_mcp_same_rx=true revoked_stream_and_recording=true"
        );
    });
    let result = timeout(assertion_budget, &mut assertions).await;
    if result.is_err() {
        assertions.abort();
        let _ = assertions.await;
    }
    let stopped = timeout(Duration::from_secs(12), sdk.cancel()).await;
    let errors = timeout(Duration::from_secs(5), &mut stderr).await;
    if errors.is_err() {
        stderr.abort();
        let _ = stderr.await;
    }
    let errors = errors.expect("MCP stderr did not close").unwrap().unwrap();
    stopped.expect("MCP cancellation timed out").unwrap();
    result
        .expect("Terminal client parity timed out")
        .unwrap_or_else(|error| {
            panic!(
                "Terminal client assertion failed: {error}; MCP stderr: {}",
                String::from_utf8_lossy(&errors)
            )
        });
}

async fn query(cli: &Cli, action: &str, target: &Target, params: &Value) -> QueryResult {
    let RpcResult::Query(result) = success(cli.query_reply(action, target, params).await) else {
        panic!("Expected CLI query result for {action}");
    };
    result
}

async fn read<T: serde::de::DeserializeOwned>(
    peer: &rmcp::Peer<RoleClient>,
    name: &str,
    target: &Target,
    params: &Value,
) -> T {
    serde_json::from_value(structured(tool(peer, name, target, params.clone()).await)).unwrap()
}
