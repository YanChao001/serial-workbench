//! 正式签名包经公共Host验证生成registry的URI工作量、复制预算及拒绝后的恢复。
use super::*;
use support::node_host_actions::registry_copy_input;
async fn program(input: Value) -> Fixture {
    let mut action = spec();
    action.input_schema = serde_json::from_value(input).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"],"additionalProperties":false
    }))
    .unwrap();
    Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await
}

async fn assert_default_work_boundary(input: Value, oversized: bool) {
    let fixture = program(input).await;
    let params = json!({"trigger":true});
    let mut call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        params.clone(),
    );
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(call.clone()))
        .await
        .unwrap();
    if oversized {
        if let RpcReply::Failure { error, .. } = &reply {
            eprintln!("native_public_schema_work_rejection error={error:?}");
        }
        if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
            let _profile = fixture.finish().await;
            panic!("Schema work exceeded no shared budget: {reply:?}");
        }
        let lookup = fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
            "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
        })))).await.unwrap();
        if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
            let _profile = fixture.finish().await;
            panic!("Rejected schema work retained an operation: {lookup:?}");
        }
    } else {
        let RpcReply::Success { result, .. } = reply else {
            let _profile = fixture.finish().await;
            panic!("Bounded schema work was rejected: {reply:?}");
        };
        let RpcResult::Operation(result) = *result else {
            panic!("Expected operation");
        };
        let settled = fixture
            .wait(&fixture.client, &result.operation.operation_id)
            .await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let mut expected = params;
        expected["value"] = json!(7);
        assert_eq!(
            fixture.result(&fixture.client, &settled).await,
            json!({"params":expected,"calls":1})
        );
        call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
    }
    call.params = serde_json::from_value(json!({"value":9})).unwrap();
    let recovered = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &recovered.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(
        observed,
        json!({"params":{"value":9},"calls":if oversized {1} else {2}})
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_generated_graph_uses_fresh_registry_uri_budget() {
    for (children, directory_bytes, oversized) in [(4, 1_024, false), (128, 32_768, true)] {
        let properties = (0..children)
            .map(|index| {
                (
                    format!("u{index}"),
                    json!({"$id":format!("?c{index}"),"type":"integer"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let input = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("https://graph.example.invalid/{}/root.json", "x".repeat(directory_bytes)),
            "$dynamicAnchor":"root",
            "$defs":{"options":{"$id":"options.json",
                "if":{"type":"object","properties":properties},
                "then":{"properties":{"value":{"default":7}}}
            }},
            "type":"object","properties":{"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":true,
            "dependentSchemas":{"trigger":{"$ref":"options.json"}}
        });
        let input_bytes = serde_json::to_vec(&input).unwrap().len();
        eprintln!(
            "native_public_generated_graph_uri_before_assert children={children} directory_bytes={directory_bytes} input_bytes={input_bytes} expected_limit={oversized}"
        );
        assert_default_work_boundary(input, oversized).await;
        eprintln!(
            "native_public_generated_graph_uri children={children} directory_bytes={directory_bytes} input_bytes={input_bytes} limit_rejected={oversized} zero_admission={oversized} subsequent_call_usable=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_generated_registry_uri_index_work_is_cumulative() {
    for (anchors, oversized) in [(1, false), (8, true)] {
        let uri_bytes = if oversized { 131_072 } else { 65_536 };
        let mut input = registry_copy_input(0, uri_bytes, 1);
        let definitions = input["$defs"].as_object_mut().unwrap();
        definitions.remove("anchor");
        for index in 0..anchors {
            definitions.insert(
                format!("a{index}"),
                json!({"$dynamicAnchor":format!("a{index}"),"type":"object"}),
            );
        }
        let input_bytes = serde_json::to_vec(&input).unwrap().len();
        assert_default_work_boundary(input, oversized).await;
        eprintln!(
            "native_public_generated_uri_index conditions=1 anchors={anchors} uri_bytes={uri_bytes} input_bytes={input_bytes} limit_rejected={oversized} zero_admission={oversized} subsequent_call_usable=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_lookup_budget_rejects_long_root_before_admission() {
    let mut input = registry_copy_input(0, 131_072, 1);
    let definitions = input["$defs"].as_object_mut().unwrap();
    definitions.remove("anchor");
    definitions.insert("a0".into(), json!({"$dynamicAnchor":"a0","type":"object"}));
    let input_bytes = serde_json::to_vec(&input).unwrap().len();
    assert_default_work_boundary(input, true).await;
    eprintln!(
        "native_public_lookup_long_root anchors=1 uri_bytes=131072 input_bytes={input_bytes} limit_rejected=true zero_admission=true subsequent_call_usable=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_registry_copies_preserve_bundled_meta_resources() {
    for own_meta in [false, true] {
        let mut input = registry_copy_input(4, 4_096, 1);
        input["$defs"]["meta_ref"] = json!({"$ref":"https://json-schema.org/draft/2020-12/schema"});
        if own_meta {
            input["$defs"]["meta_definition"] = json!({
                "$id":"https://json-schema.org/draft/2020-12/schema",
                "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"
            });
        }
        let fixture = program(input).await;
        let call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"trigger":true}),
        );
        let accepted = fixture.invoke(&fixture.client, call).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        assert_eq!(
            observed,
            json!({"params":{"trigger":true,"value":7},"calls":1})
        );
        eprintln!(
            "native_public_registry_copy_bundled_meta own_meta={own_meta} unused_meta_reference=true default_applied=true handler_calls=1"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_registry_copies_count_each_cold_predicate() {
    for (resources, uri_bytes, oversized) in [(4, 4_096, false), (64, 131_072, true)] {
        let input = registry_copy_input(resources, uri_bytes, 1);
        let input_bytes = serde_json::to_vec(&input).unwrap().len();
        assert_default_work_boundary(input, oversized).await;
        eprintln!(
            "native_public_registry_copies resources={resources} dynamic_anchors=1 uri_bytes={uri_bytes} input_bytes={input_bytes} limit_rejected={oversized} zero_admission={oversized} subsequent_call_usable=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_registry_copies_release_capacity_before_cached_validators() {
    let fixture = program(registry_copy_input(96, 32_768, 24)).await;
    let mut first = None;
    for index in 0..24 {
        let call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({format!("p{index}"):true}),
        );
        if index == 0 {
            first = Some(call.clone());
        }
        let accepted = fixture.invoke(&fixture.client, call).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        assert_eq!(
            fixture.result(&fixture.client, &settled).await,
            json!({"params":{format!("p{index}"):true,"value":7},"calls":index+1})
        );
    }
    let replay = fixture.invoke(&fixture.client, first.unwrap()).await;
    let settled = fixture.wait(&fixture.client, &replay.operation_id).await;
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"params":{"p0":true,"value":7},"calls":1})
    );
    let warm = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"p0":true}),
            ),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &warm.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"params":{"p0":true,"value":7},"calls":25}));
    eprintln!(
        "native_public_registry_copy_lifetime resources=96 uri_bytes=32768 cold_conditions=24 replay_preserved=true warm_condition_usable=true handler_calls=25"
    );
}
