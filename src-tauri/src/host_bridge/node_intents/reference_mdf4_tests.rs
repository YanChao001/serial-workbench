use super::*;
use serde_json::json;
use tokio::time::timeout;

const PACKAGE: &str = "swb.pro.mdf4";
const ACTION: &str = "swb.pro.mdf4.exportMdf4";
const MCP_TOOL: &str = "swb_swb_x2E_pro_x2E_mdf4_x2E_exportMdf4";

#[tokio::test]
#[ignore = "requires a prepared runtime, a signed MDF4 package, and same-source MCP"]
async fn native_mdf4_saved_bytes_match_the_signed_mcp_export() {
    let package = signed_reference("SWB_TEST_SIGNED_MDF4_RECEIPT");
    let digest = package.archive_sha256.clone();
    with_embedded_host(async move |profile| {
        let bridge = DesktopHostBridge::new(profile.to_owned());
        let desktop = bridge.attach("main").await.unwrap();
        let business = &desktop.attachment;
        install_signed_reference(&bridge, &desktop, package, PACKAGE).await;

        let opened = bridge
            .connect_device_intent(
                "main",
                desktop.generation,
                Id::try_from("virtual:echo").unwrap(),
                OpenParams {
                    transport_params: None,
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
        let snapshot = json!({
            "startTimeNs": "1700000012345678901",
            "channels": [
                {"name":"primary_voltage","type":"float64","unit":"V"},
                {"name":"byte_start","type":"uint64"},
                {"name":"raw_count","type":"int64"}
            ],
            "samples": [
                {"elapsedNs":"0","values":["-1.25","9007199254740993","-9223372036854775808"]},
                {"elapsedNs":"33333333","values":[null,"9007199254740995","-7"]},
                {"elapsedNs":"900000007","values":["3.5","18446744073709551615","9223372036854775807"]}
            ]
        });
        let identity = HostClient::connect(ConnectOptions::new(
            profile.to_path_buf(),
            Id::try_from("serial-workbench-mcp").unwrap(),
            ClientKind::Mcp,
        ))
        .await
        .unwrap();
        let request = host_query(identity.attachment(), ACTION, snapshot.clone());
        let denied = identity
            .request(RpcRequest::Invoke(Call {
                protocol_version: request.protocol_version,
                host_id: request.host_id,
                instance_epoch: request.instance_epoch,
                actor_id: request.actor_id,
                request_id: request.request_id,
                request_context: identity.attachment().request_context.clone(),
                action_id: request.action_id,
                target: session.clone(),
                params: request.params,
                reveal_target: request.reveal_target,
                expected_revision: None,
                lease_id: None,
                execution_mode: Some(ExecutionMode::Independent),
                workspace_startup: None,
            }))
            .await
            .unwrap();
        assert_error(denied, "PERMISSION_DENIED");

        let accepted = invoke(
            &bridge,
            business,
            &session,
            ACTION,
            snapshot.clone(),
            ExecutionMode::Independent,
        )
        .await;
        let desktop_result = wait(&bridge, business, accepted).await;
        assert_mdf4_package(&desktop_result, &digest);
        let path = profile.join("desk-chart.mf4");
        let cancelled = crate::file_commands::save_chart_artifact(
            &bridge,
            "main",
            desktop.generation,
            desktop_result.operation_id.clone(),
            |_| std::future::ready(Ok(None)),
        )
        .await
        .unwrap();
        assert!(!cancelled);
        assert!(!path.exists());

        assert!(
            crate::file_commands::save_chart_artifact(
                &bridge,
                "main",
                desktop.generation,
                desktop_result.operation_id.clone(),
                |_| std::future::ready(Ok(Some(path.clone()))),
            )
            .await
            .unwrap()
        );
        let saved = std::fs::read(path).unwrap();
        assert!(saved.starts_with(b"MDF     4.10    "));
        assert_eq!(&saved[64..68], b"##HD");

        invoke_control(
            &bridge,
            "main",
            desktop.generation,
            "auth.authorize",
            json!({
                "clientId": identity.attachment().client_id,
                "permissions": ["content.read"],
                "targets": [session],
            }),
        )
        .await
        .unwrap();
        identity.close().await.unwrap();
        let sdk = start_reference_mcp(profile).await;
        let reply = timeout(
            Duration::from_secs(10),
            parity_clients::tool_reply(sdk.peer(), MCP_TOOL, &session, snapshot),
        )
        .await
        .expect("MCP MDF4 admission timed out")
        .unwrap();
        let accepted: Operation =
            serde_json::from_value(parity_clients::structured(reply)).unwrap();
        let result = wait(&bridge, business, accepted).await;
        assert_ne!(desktop_result.operation_id, result.operation_id);
        assert_mdf4_package(&result, &digest);
        let Some(ActionResult::Reference(output)) = result.result else {
            panic!("MDF4 operation is missing its file reference");
        };
        let target = resource_target(&output.result_ref);
        let reply = timeout(
            Duration::from_secs(10),
            parity_clients::tool_reply(
                sdk.peer(),
                "swb_file_x2E_read",
                &target,
                json!({"fileRef":output.result_ref,"offset":"0","maxBytes":"65536"}),
            ),
        )
        .await
        .expect("MCP MDF4 file read timed out")
        .unwrap();
        let file: FileReadResult =
            serde_json::from_value(parity_clients::structured(reply)).unwrap();
        assert!(file.at_end);
        assert_eq!(file.file_ref, output.result_ref);
        assert_eq!(file.offset.get(), 0);
        assert_eq!(file.total_bytes.get(), saved.len() as u64);
        let mcp_bytes = STANDARD.decode(file.bytes_base64.as_str()).unwrap();
        assert_eq!(saved, mcp_bytes);
        if let Some(output) = std::env::var_os("SWB_TEST_MDF4_RESULT") {
            std::fs::write(output, &saved).unwrap();
        }
        timeout(Duration::from_secs(12), sdk.cancel())
            .await
            .unwrap()
            .unwrap();
        eprintln!(
            "reference_mdf4 package={} unauthorized_denied=true cancelled_without_file=true distinct_operations=true byte_equal=true bytes={} sha256={}",
            digest.as_str(),
            saved.len(),
            file.fingerprint.as_str(),
        );
    })
    .await;
}

fn assert_mdf4_package(operation: &Operation, digest: &Digest) {
    assert_eq!(operation.action_id.as_str(), ACTION);
    assert_eq!(operation.state, OperationState::Succeeded);
    assert!(operation.dependencies.as_ref().is_some_and(|dependencies| {
        dependencies
            .iter()
            .any(|dependency| dependency.id.as_str() == PACKAGE && &dependency.digest == digest)
    }));
}
