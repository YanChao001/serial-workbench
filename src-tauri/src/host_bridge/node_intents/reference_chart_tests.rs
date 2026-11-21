use super::*;
use serde_json::{Value, json};
use tokio::time::timeout;

const SAMPLE: &str = "swb.reference.chart.sample";
const EXPORT_SVG: &str = "swb_swb_x2E_reference_x2E_chart_x2E_exportSvg";

#[tokio::test]
#[ignore = "requires prepared Node, the signed chart receipt and same-source CLI/MCP"]
async fn native_chart_samples_exact_rx_from_the_signed_reference_package() {
    let package = signed_reference("SWB_TEST_SIGNED_CHART_RECEIPT");
    with_embedded_host(async move |profile| {
        let bridge = DesktopHostBridge::new(profile.to_owned());
        let desktop = bridge.attach("main").await.unwrap();
        let business = &desktop.attachment;
        install_signed_reference(&bridge, &desktop, package, "swb.reference.chart").await;

        let opened = bridge.connect_device_intent(
            "main", desktop.generation, Id::try_from("virtual:echo").unwrap(),
            OpenParams { configuration: SerialConfiguration::default(), binding: None },
        ).await.unwrap();
        let session = Target {
            host_id: business.host_id.clone(), kind: ResourceKind::try_from("session").unwrap(),
            id: opened.session_id.clone(), session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
        };
        let sampling = invoke(&bridge, business, &session, SAMPLE,
            json!({"startEventSeq":"1","sampleCount":3}), ExecutionMode::Independent).await;
        use crate::node_view::test_support::TestDerivedView;
        timeout(Duration::from_secs(8), async {
            loop {
                let snapshot = operation_snapshot(&bridge, business, &sampling.operation_id).await;
                if snapshot.state == OperationState::Running { break; }
                assert!(!snapshot.state.is_terminal(), "{snapshot:?}");
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.expect("The chart did not start sampling");
        let mut live_view = TestDerivedView::open(&bridge, desktop.generation, sampling.operation_id.clone()).await;
        assert!(live_view.next().await.unwrap().is_null(), "The view must wait before the first sample exists");
        tx(&bridge, business, &session, b"1").await;
        let _ = wait_reference_rx_end(&bridge, business, &session, 1).await;
        tx(&bridge, business, &session, b".25\r\n-2\n3").await;
        let _ = wait_reference_rx_end(&bridge, business, &session, 10).await;
        let live_samples = timeout(Duration::from_secs(8), async {
            let mut samples = Vec::new();
            while samples.len() < 2 {
                let frame = live_view.next().await.unwrap();
                if frame.is_null() {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    continue;
                }
                let page = derived(success(serde_json::from_value(frame["derived"]["reply"].clone()).unwrap()));
                samples.extend(page.samples);
            }
            samples
        }).await.expect("The view did not receive samples while the last input was withheld");
        assert_eq!(operation_snapshot(&bridge, business, &sampling.operation_id).await.state, OperationState::Running);
        tx(&bridge, business, &session, b".5\n").await;
        let complete = wait(&bridge, business, sampling).await;
        assert!(matches!(complete.result, Some(ActionResult::Reference(_))));
        let tail = live_view.next().await.unwrap();
        assert_eq!(tail["derived"]["previousPosition"], "2");
        let tail = derived(success(serde_json::from_value(tail["derived"]["reply"].clone()).unwrap()));
        drop(live_view);

        let mut reopened = TestDerivedView::open(&bridge, desktop.generation, complete.operation_id.clone()).await;
        let view_page = reopened.next().await.unwrap();
        assert_eq!(view_page["derived"]["previousPosition"], "0");
        assert_eq!(view_page["derived"]["after"], "0");
        let view_samples = derived(success(serde_json::from_value(view_page["derived"]["reply"].clone()).unwrap()));
        assert!(reopened.next().await.unwrap().is_null());

        let params = |after: &str| json!({"operationId":complete.operation_id,"after":after,"maxSamples":"2","maxBytes":"16384"});
        let first_params = params("0");
        let last_params = params("2");
        let first = derived(read_reference_raw(&bridge, business, &session, "stream.derivedRead", first_params.clone()).await);
        let last = derived(read_reference_raw(&bridge, business, &session, "stream.derivedRead", last_params.clone()).await);
        assert_eq!(first.next_position.get(), 2);
        assert!(first.has_more);
        assert_eq!(last.next_position.get(), 3);
        assert!(!last.has_more);
        let samples: Vec<_> = first.samples.iter().chain(&last.samples).collect();
        assert_eq!(view_samples.samples.iter().collect::<Vec<_>>(), samples);
        assert_eq!(live_samples.iter().chain(&tail.samples).collect::<Vec<_>>(), samples);
        assert_eq!(samples.len(), 3);
        for (index, ((sample, value), (start, end))) in samples.iter()
            .zip([json!(1.25), json!(-2), json!(3.5)])
            .zip([(0,6), (6,9), (9,13)]).enumerate()
        {
            assert_eq!(serde_json::to_value(&sample.value).unwrap(), value);
            assert_eq!(sample.position.get(), index as u64 + 1);
            assert_eq!(sample.provenance.parser_id.as_str(), SAMPLE);
            assert_eq!(sample.provenance.parser_version, "0.1.1");
            assert_eq!(sample.provenance.unit.as_deref(), Some("V"));
            assert_eq!(sample.provenance.quality, [DerivedQuality::Complete, DerivedQuality::Transformed]);
            let [source] = &sample.provenance.sources[..] else { panic!("One exact RX source range"); };
            assert_eq!(source.host_id, session.host_id);
            assert_eq!(source.session_id, session.id);
            assert_eq!(Some(source.session_epoch), session.session_epoch);
            assert_eq!(source.direction, Some(Direction::Rx));
            assert_eq!(source.byte_start.map(U64::get), Some(start));
            assert_eq!(source.byte_end.map(U64::get), Some(end));
            if index != 1 { assert!(source.event_end.get() - source.event_start.get() > 1); }
        }

        for (id, kind) in [("serial-workbench-cli", ClientKind::Cli), ("serial-workbench-mcp", ClientKind::Mcp)] {
            let identity = HostClient::connect(ConnectOptions::new(profile.to_path_buf(), Id::try_from(id).unwrap(), kind)).await.unwrap();
            invoke_control(&bridge, "main", desktop.generation, "auth.authorize", json!({"clientId":identity.attachment().client_id,"permissions":["content.read"],"targets":[session]})).await.unwrap();
            identity.close().await.unwrap();
        }
        let cli = parity_clients::Cli { binary: parity_clients::binary("SWB_TEST_CLI_BIN", "serial-workbench-cli"), profile: profile.to_path_buf() };
        assert_eq!(derived(success(cli.query_reply("stream.derivedRead", &session, &first_params).await)), first);
        verify_mcp_pages(profile, &session, [(first_params, &first), (last_params, &last)]).await;
        verify_svg_export(profile, &bridge, business, desktop.generation, &session).await;

        let end = wait_reference_rx_end(&bridge, business, &session, 13).await;
        let overflow = invoke(&bridge, business, &session, SAMPLE,
            json!({"startEventSeq":end.next_event_seq,"sampleCount":1}), ExecutionMode::Independent).await;
        tx(&bridge, business, &session, &[b'9'; 65]).await;
        let rejected = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let snapshot = operation_snapshot(&bridge, business, &overflow.operation_id).await;
                if snapshot.state.is_terminal() { break snapshot; }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.unwrap();
        assert_eq!(rejected.state, OperationState::Failed, "{rejected:?}");
        assert!(rejected.result.is_none());
        assert_eq!(derived(read_reference_raw(&bridge, business, &session, "stream.derivedRead", params("0")).await), first);
        let _ = wait_reference_rx_end(&bridge, business, &session, 78).await;
        let status = list(&bridge, business).await;
        let package = status.packages.first().unwrap();
        apply(&bridge, &desktop, LocalNodeIntent::RevokeExecutionTrust {
            expected_revision: status.revision,
            params: NodePackageIdentityParams { id: package.id.clone(), archive_sha256: package.archive_sha256.clone() },
        }).await;
        assert!(matches!(reopened.next().await, Err(error) if error.code == "UNSUPPORTED_CAPABILITY"));
        eprintln!("reference_chart values=[1.25,-2,3.5] byte_ranges=[[0,6],[6,9],[9,13]] samples_while_running=2 same_view_after_completion=true two_pages=true cli_match=true official_mcp_pages=2 scoped_view_reopened=true viewer_revoked=true overlong_rejected=true raw_bytes=78");
    }).await;
}

async fn verify_svg_export(
    profile: &Path,
    bridge: &DesktopHostBridge,
    business: &AttachResult,
    generation: U64,
    session: &Target,
) {
    let sdk = start_reference_mcp(profile).await;
    let accepted = timeout(
        Duration::from_secs(10),
        parity_clients::tool_reply(
            sdk.peer(),
            EXPORT_SVG,
            session,
            json!({"startEventSeq":"1","sampleCount":3}),
        ),
    )
    .await
    .expect("MCP SVG export admission timed out")
    .unwrap();
    let accepted = serde_json::from_value(parity_clients::structured(accepted)).unwrap();
    let settled = wait(bridge, business, accepted).await;
    let Some(ActionResult::Reference(output)) = settled.result else {
        panic!("SVG export did not settle with a result reference: {settled:?}");
    };
    let target = resource_target(&output.result_ref);
    let params = json!({"fileRef":output.result_ref,"offset":"0","maxBytes":"8192"});
    let RpcResult::Query(QueryResult::FileRead(desktop)) =
        read_reference_raw(bridge, business, &target, "file.read", params.clone()).await
    else {
        panic!("Desktop failed to read the chart result");
    };
    let mcp = timeout(
        Duration::from_secs(10),
        parity_clients::tool_reply(sdk.peer(), "swb_file_x2E_read", &target, params),
    )
    .await
    .expect("MCP SVG read timed out")
    .unwrap();
    let mcp: FileReadResult = serde_json::from_value(parity_clients::structured(mcp)).unwrap();
    timeout(Duration::from_secs(12), sdk.cancel())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(desktop, mcp);
    assert!(desktop.at_end);
    let svg = String::from_utf8(STANDARD.decode(desktop.bytes_base64.as_str()).unwrap()).unwrap();
    assert!(svg.starts_with("<svg "));
    assert!(svg.ends_with("</svg>"));
    assert!(
        svg.contains("points=\"72.00,154.25 344.00,295.64 616.00,56.36\""),
        "{svg}"
    );
    let saved = profile.join("chart.svg");
    assert!(
        crate::file_commands::save_chart_svg(
            bridge,
            "main",
            generation,
            settled.operation_id,
            || std::future::ready(Ok(Some(saved.clone()))),
        )
        .await
        .unwrap()
    );
    assert_eq!(std::fs::read(saved).unwrap(), svg.as_bytes());
    eprintln!(
        "reference_chart_svg actual_mcp_action=true saved_file_matches_mcp=true bytes={}",
        svg.len()
    );
}

async fn verify_mcp_pages(
    profile: &Path,
    session: &Target,
    pages: [(Value, &DerivedReadResult); 2],
) {
    let sdk = start_reference_mcp(profile).await;
    let replies = timeout(Duration::from_secs(10), async {
        let mut replies = Vec::with_capacity(pages.len());
        for (params, expected) in pages {
            let reply = parity_clients::tool_reply(
                sdk.peer(),
                "swb_stream_x2E_derivedRead",
                session,
                params,
            )
            .await;
            replies.push((reply, expected));
        }
        replies
    })
    .await;
    timeout(Duration::from_secs(12), sdk.cancel())
        .await
        .expect("MCP cancellation timed out")
        .unwrap();
    for (reply, expected) in replies.expect("MCP chart pages timed out") {
        let actual: DerivedReadResult =
            serde_json::from_value(parity_clients::structured(reply.unwrap())).unwrap();
        assert_eq!(&actual, expected);
    }
}

fn derived(result: RpcResult) -> DerivedReadResult {
    let RpcResult::Query(QueryResult::StreamDerivedRead(page)) = result else {
        panic!("Missing chart derived page");
    };
    page
}
