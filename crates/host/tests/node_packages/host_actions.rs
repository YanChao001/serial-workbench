//! 正式签名包经实际控制/Raw连接、持久操作与结果引用读取。
use super::*;
use serial_workbench_core::*;
use std::time::Duration;
use support::node_host_actions::{Fixture, spec};
#[path = "child_admission.rs"]
mod child_admission;
#[path = "compiled_graph.rs"]
mod compiled_graph;
#[path = "global_graph.rs"]
mod global_graph;
#[path = "registry_copies.rs"]
mod registry_copies;
#[path = "task_authority.rs"]
mod task_authority;
#[path = "task_context.rs"]
mod task_context;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_cache_bounds_generated_dynamic_scope_inputs() {
    for (anchors, uri_bytes, oversized) in
        [(1, 65_536, false), (1, 131_072, true), (80, 131_072, true)]
    {
        let mut definitions = (0..anchors)
            .map(|index| {
                (
                    format!("a{index}"),
                    json!({"$dynamicAnchor":format!("a{index}"),"type":"object"}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        definitions.insert("options".into(),json!({"$id":"options.json","if":{"type":"object"},"then":{"properties":{"value":{"default":7}}}}));
        let mut action = spec();
        action.input_schema=serde_json::from_value(json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema",
            "$id":format!("https://scope.example.invalid/{}", "x".repeat(uri_bytes)),"$defs":definitions,
            "type":"object","properties":{"trigger":{"type":"boolean"},"value":{"type":"integer"}},
            "required":["value"],"additionalProperties":false,
            "dependentSchemas":{"trigger":{"$ref":"options.json"}}
        })).unwrap();
        action.output_schema=serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},"required":["params","calls"],"additionalProperties":false
        })).unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"trigger":true}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if oversized {
            if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
                let _profile = fixture.finish().await;
                panic!("Oversized dynamic scope inputs were admitted: {reply:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Rejected dynamic scope retained an operation: {lookup:?}");
            }
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Small dynamic scope failed: {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation");
            };
            let settled = fixture
                .wait(&fixture.client, &result.operation.operation_id)
                .await;
            assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
            assert_eq!(
                fixture.result(&fixture.client, &settled).await,
                json!({"params":{"trigger":true,"value":7},"calls":1})
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
        eprintln!(
            "native_public_generated_scope_budget anchors={anchors} uri_bytes={uri_bytes} limit_rejected={oversized} zero_admission={oversized} subsequent_call_usable=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_cache_bounds_retained_bytes_and_reuses_existing_predicates() {
    let dependencies = (0..64)
        .map(|index| {
            (
                format!("p{index}"),
                json!({"if":{"type":"object"},"then":{"properties":{"value":{"default":7}}}}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let mut action = spec();
    action.input_schema = serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$id":format!("https://cache.example.invalid/{}", "x".repeat(131_072)),
        "type":"object","properties":{"value":{"type":"integer"}},
        "required":["value"],"additionalProperties":{"type":"boolean"},"dependentSchemas":dependencies
    })).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{"calls":{"type":"integer"}},"required":["calls"],"additionalProperties":false
    })).unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',()=>({calls:++calls}));return ()=>{};}").await;
    let mut accepted = 0;
    let mut rejected = None;
    for index in 0..64 {
        let call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":9,format!("p{index}"):true}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
            rejected = Some(call);
            break;
        }
        let RpcReply::Success { result, .. } = reply else {
            let _profile = fixture.finish().await;
            panic!("Unexpected predicate-cache response: {reply:?}");
        };
        let RpcResult::Operation(result) = *result else {
            panic!("Expected operation");
        };
        let settled = fixture
            .wait(&fixture.client, &result.operation.operation_id)
            .await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        accepted += 1;
        assert_eq!(
            fixture.result(&fixture.client, &settled).await,
            json!({"calls":accepted})
        );
    }
    let Some(mut retry) = rejected else {
        let _profile = fixture.finish().await;
        panic!(
            "Long predicate keys and compiler inputs exceeded no retained-byte boundary across {accepted} calls"
        );
    };
    if accepted == 0 {
        let _profile = fixture.finish().await;
        panic!("A single bounded predicate was rejected before cache growth");
    }
    let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
        "actorId":retry.actor_id,"requestId":retry.request_id,"requestContext":retry.request_context
    })))).await.unwrap();
    if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
        let _profile = fixture.finish().await;
        panic!("Rejected cache growth retained an operation: {lookup:?}");
    }
    retry.params = serde_json::from_value(json!({"value":9,"p0":true})).unwrap();
    let recovered = fixture.invoke(&fixture.client, retry.clone()).await;
    let settled = fixture.wait(&fixture.client, &recovered.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let replay = fixture.invoke(&fixture.client, retry).await;
    let _profile = fixture.finish().await;
    assert_eq!(replay.operation_id, recovered.operation_id);
    assert_eq!(observed, json!({"calls":accepted+1}));
    eprintln!(
        "native_public_schema_cache_bytes accepted={accepted} uri_bytes=131072 below_entry_count_cap=true limit_rejected=true zero_admission=true cached_same_request_retry=true replay_preserved=true handler_calls={}",
        accepted + 1
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_reject_nonconvergent_conditions_before_admission() {
    let mut action = spec();
    action.input_schema = serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
        "properties":{"n":{"type":"integer"},"m":{"type":"integer"}},
        "if":{"required":["n"]},
        "then":{"properties":{"m":{"default":8}}},
        "else":{"properties":{"n":{"default":7}}},
        "additionalProperties":false
    }))
    .unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"],"additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let mut call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({}),
    );
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(call.clone()))
        .await
        .unwrap();
    if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
        let _profile = fixture.finish().await;
        panic!("Nonconvergent condition defaults were admitted: {reply:?}");
    }
    let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
        "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
    })))).await.unwrap();
    if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
        let _profile = fixture.finish().await;
        panic!("Nonconvergent defaults retained an operation: {lookup:?}");
    }
    call.params = serde_json::from_value(json!({"n":9})).unwrap();
    let accepted = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"params":{"n":9,"m":8},"calls":1})
    );
    let explicit = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"n":9,"m":12}),
            ),
        )
        .await;
    let explicit = fixture.wait(&fixture.client, &explicit.operation_id).await;
    assert_eq!(explicit.state, OperationState::Succeeded, "{explicit:?}");
    let observed = fixture.result(&fixture.client, &explicit).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"params":{"n":9,"m":12},"calls":2}));
    eprintln!(
        "native_public_nonconvergent_defaults limit_rejected=true zero_admission=true same_request_retry=true explicit_values_preserved=true handler_calls=2"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_bound_recursive_container_depth_before_admission() {
    let mut action = spec();
    action.input_schema = serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
        "$defs":{"node":{"type":["object","null"],"default":{},"properties":{"n":{"default":7},"next":{"$ref":"#/$defs/node"}}}},
        "properties":{"value":{"$ref":"#/$defs/node"}},"required":["value"],"additionalProperties":false
    })).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"],"additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let mut call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({}),
    );
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(call.clone()))
        .await
        .unwrap();
    if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
        let _profile = fixture.finish().await;
        panic!("Recursive container defaults were admitted without a finite boundary: {reply:?}");
    }
    let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
        "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
    })))).await.unwrap();
    if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
        let _profile = fixture.finish().await;
        panic!("Unbounded container defaults retained an operation: {lookup:?}");
    }
    call.params = serde_json::from_value(json!({"value":null})).unwrap();
    let accepted = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"params":{"value":null},"calls":1})
    );
    let finite_input = (0..16).fold(Value::Null, |next, _| json!({"next":next}));
    let finite_expected = (0..16).fold(Value::Null, |next, _| json!({"n":7,"next":next}));
    let finite = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":finite_input}),
            ),
        )
        .await;
    let finite = fixture.wait(&fixture.client, &finite.operation_id).await;
    assert_eq!(finite.state, OperationState::Succeeded, "{finite:?}");
    let observed = fixture.result(&fixture.client, &finite).await;
    let _profile = fixture.finish().await;
    assert_eq!(
        observed,
        json!({"params":{"value":finite_expected},"calls":2})
    );
    eprintln!(
        "native_public_recursive_default_depth limit_rejected=true zero_admission=true same_request_retry=true explicit_null_preserved=true finite_chain_depth=16 handler_calls=2"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_reject_oversized_byte_expansion_before_admission() {
    for (fields, oversized) in [(4, false), (17, true)] {
        let properties = (0..fields)
            .map(|index| (format!("p{index}"), json!({"$ref":"#/$defs/blob"})))
            .collect::<serde_json::Map<_, _>>();
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
            "$defs":{"blob":{"type":"string","default":"x".repeat(65_536)}},
            "properties":properties,"additionalProperties":false
        }))
        .unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"lengths":{"type":"array","items":{"type":"integer"}},"calls":{"type":"integer"}},
            "required":["lengths","calls"],"additionalProperties":false
        })).unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({lengths:Object.values(call.params).map(value=>value.length),calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if oversized {
            if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
                let _profile = fixture.finish().await;
                panic!("Oversized default expansion was admitted ({fields} fields): {reply:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Oversized expansion retained an operation: {lookup:?}");
            }
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Bounded 256KiB expansion was rejected: {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            let settled = fixture
                .wait(&fixture.client, &result.operation.operation_id)
                .await;
            assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
            assert_eq!(
                fixture.result(&fixture.client, &settled).await,
                json!({"lengths":[65536,65536,65536,65536],"calls":1})
            );
            call = fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({}),
            );
        }
        let explicit = (0..fields)
            .map(|index| (format!("p{index}"), json!("ok")))
            .collect::<serde_json::Map<_, _>>();
        call.params = serde_json::from_value(json!(explicit)).unwrap();
        let accepted = fixture.invoke(&fixture.client, call).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        assert_eq!(
            observed,
            json!({"lengths":vec![2;fields],"calls":if oversized {1} else {2}})
        );
        eprintln!(
            "native_public_default_byte_expansion fields={fields} source_blob_bytes=65536 limit_rejected={oversized} zero_admission={oversized} same_request_retry={oversized} explicit_preserved=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_reject_invalid_scalars_before_admission() {
    for (name, property, explicit) in [
        (
            "fractional_parameter",
            json!({"type":"number","default":1.5}),
            json!(9),
        ),
        (
            "above_safe_integer",
            json!({"type":"integer","default":9_007_199_254_740_992_i64}),
            json!(9_007_199_254_740_991_i64),
        ),
        (
            "below_safe_integer",
            json!({"type":"integer","default":-9_007_199_254_740_992_i64}),
            json!(-9_007_199_254_740_991_i64),
        ),
        (
            "wrong_type",
            json!({"type":"string","default":true}),
            json!("ok"),
        ),
        (
            "below_minimum",
            json!({"type":"integer","minimum":8,"default":7}),
            json!(9),
        ),
        (
            "invalid_null",
            json!({"type":"boolean","default":null}),
            json!(true),
        ),
    ] {
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "type":"object","properties":{"value":property},"required":["value"],"additionalProperties":false
        })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let expected_schema = action.input_schema.clone();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let details = fixture.query(&fixture.client,&fixture.target,"node.packages.detailsRead",json!({
            "id":"example.terminal","expectedRevision":"3","archiveSha256":fixture.archive,"offset":"0","length":"32768"
        })).await;
        let details: NodePackageDetailsReadResult =
            serde_json::from_value(serde_json::to_value(details).unwrap()["value"].clone())
                .unwrap();
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            details.bytes_base64.as_str(),
        )
        .unwrap();
        assert_eq!(bytes.len() as u64, details.total_bytes.get());
        let stored: NodePackageInstallation = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            stored.manifest.contributes.actions[0].input_schema, expected_schema,
            "{name}: metadata numeric values changed"
        );
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="INVALID_ARGUMENT") {
            let _profile = fixture.finish().await;
            panic!("Invalid scalar default was admitted ({name}): {reply:?}");
        }
        let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
            "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
        })))).await.unwrap();
        if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
            let _profile = fixture.finish().await;
            panic!("Invalid scalar default retained an operation ({name}): {lookup:?}");
        }
        call.params = serde_json::from_value(json!({"value":explicit})).unwrap();
        let accepted = fixture.invoke(&fixture.client, call.clone()).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "{name}: {settled:?}"
        );
        let observed = fixture.result(&fixture.client, &settled).await;
        let replay = fixture.invoke(&fixture.client, call).await;
        assert_eq!(
            replay.operation_id, accepted.operation_id,
            "{name}: numeric schema replay changed operation identity"
        );
        let _profile = fixture.finish().await;
        assert_eq!(
            observed,
            json!({"params":{"value":explicit},"calls":1}),
            "{name}"
        );
        eprintln!(
            "native_public_invalid_scalar_default name={name} invalid_argument=true zero_admission=true same_request_retry=true handler_calls=1"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_include_valid_missing_branch_votes_without_oscillation() {
    for (name, dialect, property, expected, explicit) in [
        (
            "scalar_empty_2020",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":7},{}]}),
            json!({}),
            json!(9),
        ),
        (
            "scalar_empty_7",
            "http://json-schema.org/draft-07/schema#",
            json!({"anyOf":[{"default":7},{}]}),
            json!({}),
            json!(9),
        ),
        (
            "false_branch",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":7},false]}),
            json!({"value":7}),
            json!(9),
        ),
        (
            "nonmatching_branch",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":7},{"type":"string"}]}),
            json!({"value":7}),
            json!(9),
        ),
        (
            "valid_integer_without_default",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":7},{"type":"integer"}]}),
            json!({}),
            json!(9),
        ),
        (
            "identical_literals",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":7},{"default":7}]}),
            json!({"value":7}),
            json!(9),
        ),
        (
            "object_empty",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":{}},{}]}),
            json!({}),
            json!({"n":9}),
        ),
        (
            "object_child_proposal",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":{"n":7}},{"properties":{"n":{"default":7}}}]}),
            json!({}),
            json!({"n":9}),
        ),
        (
            "invalid_default_not_an_instance_pool_entry",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"type":"integer","default":"bad"},{"type":"integer","default":7},{"const":"bad"}]}),
            json!({"value":7}),
            json!(9),
        ),
        (
            "array_empty",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":[1]},{}]}),
            json!({}),
            json!([9]),
        ),
        (
            "explicit_null_vote",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"anyOf":[{"default":7},{}]}),
            json!({}),
            json!(null),
        ),
    ] {
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":dialect,"type":"object","properties":{"value":property},"additionalProperties":false
        })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut results = Vec::new();
        for params in [json!({}), json!({"value":explicit})] {
            let reply = fixture
                .client
                .request(RpcRequest::Invoke(fixture.call(
                    &fixture.client,
                    &fixture.target,
                    "example.terminal.compute",
                    params,
                )))
                .await
                .unwrap();
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Valid missing branch caused default oscillation ({name}): {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            let settled = fixture
                .wait(&fixture.client, &result.operation.operation_id)
                .await;
            assert_eq!(
                settled.state,
                OperationState::Succeeded,
                "{name}: {settled:?}"
            );
            results.push(fixture.result(&fixture.client, &settled).await);
        }
        let _profile = fixture.finish().await;
        assert_eq!(results[0], json!({"params":expected,"calls":1}), "{name}");
        assert_eq!(
            results[1],
            json!({"params":{"value":explicit},"calls":2}),
            "{name}"
        );
        eprintln!(
            "native_public_missing_branch_vote name={name} converged=true valid_empty_vote_preserved=true invalid_branch_excluded=true explicit_preserved=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_keep_unevaluated_proposals_independent_of_references() {
    for (name, dialect, property, conflict) in [
        (
            "reference_conflict",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"$ref":"#/$defs/seed","unevaluatedProperties":{"default":8}}),
            true,
        ),
        (
            "reference_agreement",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"$ref":"#/$defs/seed","unevaluatedProperties":{"default":7}}),
            false,
        ),
        (
            "own_literal",
            "https://json-schema.org/draft/2020-12/schema",
            json!({"type":"object","default":{"n":7},"unevaluatedProperties":{"default":8}}),
            false,
        ),
        (
            "draft7_ignored_sibling",
            "http://json-schema.org/draft-07/schema#",
            json!({"$ref":"#/$defs/seed","unevaluatedProperties":{"default":8}}),
            false,
        ),
    ] {
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":dialect,"type":"object","$defs":{"seed":{"type":"object","default":{"n":7}}},
            "properties":{"obj":property},"required":["obj"],"additionalProperties":false
        }))
        .unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if conflict {
            if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="INVALID_ARGUMENT") {
                let _profile = fixture.finish().await;
                panic!("Unevaluated default was hidden by the referenced proposal: {reply:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Unevaluated conflict retained an operation: {lookup:?}");
            }
        } else {
            let RpcReply::Success { result, .. } = reply else {
                panic!("Expected {name} success: {reply:?}")
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            let settled = fixture
                .wait(&fixture.client, &result.operation.operation_id)
                .await;
            assert_eq!(
                settled.state,
                OperationState::Succeeded,
                "{name}: {settled:?}"
            );
            assert_eq!(
                fixture.result(&fixture.client, &settled).await,
                json!({"params":{"obj":{"n":7}},"calls":1}),
                "{name}"
            );
            call = fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({}),
            );
        }
        call.params = serde_json::from_value(json!({"obj":{"n":9}})).unwrap();
        let accepted = fixture.invoke(&fixture.client, call).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "{name}: {settled:?}"
        );
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        assert_eq!(
            observed,
            json!({"params":{"obj":{"n":9}},"calls":if conflict {1} else {2}}),
            "{name}"
        );
        eprintln!(
            "native_public_unevaluated_proposals name={name} conflict_rejected={conflict} zero_admission={conflict} explicit_preserved=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_require_whole_missing_literal_consensus() {
    for (dialect, same) in [
        ("http://json-schema.org/draft-07/schema#", false),
        ("http://json-schema.org/draft-07/schema#", true),
        ("https://json-schema.org/draft/2020-12/schema", false),
        ("https://json-schema.org/draft/2020-12/schema", true),
    ] {
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":dialect,"type":"object","properties":{"obj":{"type":"object"}},
            "anyOf":[{"properties":{"obj":{"default":{"n":7}}}},{"properties":{"obj":{"default":{"n":if same {7} else {8}}}}}],
            "additionalProperties":false
        })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut results = Vec::new();
        for params in [json!({}), json!({"obj":{"n":9}})] {
            let accepted = fixture
                .invoke(
                    &fixture.client,
                    fixture.call(
                        &fixture.client,
                        &fixture.target,
                        "example.terminal.compute",
                        params,
                    ),
                )
                .await;
            let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
            assert_eq!(
                settled.state,
                OperationState::Succeeded,
                "{dialect} same={same}: {settled:?}"
            );
            results.push(fixture.result(&fixture.client, &settled).await);
        }
        let _profile = fixture.finish().await;
        assert_eq!(
            results[0],
            json!({"params":if same {json!({"obj":{"n":7}})} else {json!({})},"calls":1}),
            "{dialect} same={same}"
        );
        assert_eq!(
            results[1],
            json!({"params":{"obj":{"n":9}},"calls":2}),
            "{dialect} same={same}"
        );
        eprintln!(
            "native_public_whole_literal_consensus dialect={dialect} same_default={same} ambiguous_container_not_invented=true explicit_preserved=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_reject_parallel_applicator_proposal_conflicts() {
    for (name, fragment) in [
        (
            "if",
            json!({"if":{},"then":{"properties":{"n":{"default":8}}}}),
        ),
        (
            "allOf",
            json!({"allOf":[{"properties":{"n":{"default":8}}}]}),
        ),
        (
            "anyOf",
            json!({"anyOf":[{"properties":{"n":{"default":8}}}]}),
        ),
        (
            "oneOf",
            json!({"oneOf":[{"properties":{"n":{"default":8}}}]}),
        ),
        (
            "dependentSchemas",
            json!({"dependentSchemas":{"m":{"properties":{"n":{"default":8}}}}}),
        ),
    ] {
        let mut schema = json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
            "properties":{"n":{"default":7},"m":{"default":10}},"additionalProperties":false
        });
        schema
            .as_object_mut()
            .unwrap()
            .extend(fragment.as_object().unwrap().clone());
        let mut action = spec();
        action.input_schema = serde_json::from_value(schema).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="INVALID_ARGUMENT") {
            let _profile = fixture.finish().await;
            panic!("Parallel {name} default was hidden by an earlier applicator: {reply:?}");
        }
        let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
            "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
        })))).await.unwrap();
        if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
            let _profile = fixture.finish().await;
            panic!("Parallel {name} conflict retained an operation: {lookup:?}");
        }
        call.params = serde_json::from_value(json!({"n":9})).unwrap();
        let accepted = fixture.invoke(&fixture.client, call).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "{name}: {settled:?}"
        );
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        assert_eq!(
            observed,
            json!({"params":{"n":9,"m":10},"calls":1}),
            "{name}"
        );
        eprintln!(
            "native_public_parallel_defaults applicator={name} conflict_rejected=true zero_admission=true same_request_retry=true explicit_preserved=true handler_calls=1"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_reject_conflicts_through_seeded_reference_branches() {
    for (name, definition) in [
        (
            "if",
            json!({"type":"object","if":{},"then":{"properties":{"n":{"type":"integer","default":7}}}}),
        ),
        (
            "anyOf",
            json!({"type":"object","anyOf":[{"properties":{"n":{"type":"integer","default":7}}}]}),
        ),
        (
            "oneOf",
            json!({"type":"object","oneOf":[{"properties":{"n":{"type":"integer","default":7}}}]}),
        ),
        (
            "allOf",
            json!({"type":"object","allOf":[{"properties":{"n":{"type":"integer","default":7}}}]}),
        ),
        (
            "dependentSchemas",
            json!({"type":"object","dependentSchemas":{"m":{"properties":{"n":{"type":"integer","default":7}}}}}),
        ),
    ] {
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
        "$defs":{"object":definition},
        "properties":{"obj":{"$ref":"#/$defs/object","default":{},"properties":{"n":{"type":"integer","default":8},"m":{"type":"integer","default":10}}}},
        "required":["obj"],"additionalProperties":false
    })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="INVALID_ARGUMENT") {
            let _profile = fixture.finish().await;
            panic!("Seeded reference branch concealed a conflicting child default: {reply:?}");
        }
        let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
        "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
    })))).await.unwrap();
        if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
            let _profile = fixture.finish().await;
            panic!("Seeded reference branch conflict retained an operation: {lookup:?}");
        }
        call.params = serde_json::from_value(json!({"obj":{"n":9}})).unwrap();
        let accepted = fixture.invoke(&fixture.client, call).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        assert_eq!(observed, json!({"params":{"obj":{"n":9,"m":10}},"calls":1}));
        eprintln!(
            "native_public_seeded_reference_branch wrapper={name} conflict_rejected=true zero_admission=true same_request_retry=true explicit_preserved=true handler_calls=1"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_merge_seeded_container_candidates_without_losing_origins() {
    for (name, property, definition, conflict, expected, explicit, explicit_expected) in [
        (
            "scalar_reference_condition",
            json!({"$ref":"#/$defs/value","if":{},"then":{"default":8}}),
            json!({"type":"integer","default":7}),
            true,
            json!({}),
            json!({"obj":9}),
            json!({"obj":9}),
        ),
        (
            "array_child_proposals_keep_borrowed_position",
            json!({"$ref":"#/$defs/value","prefixItems":[{}, {"properties":{"n":{"default":7}}}]}),
            json!({"type":"array","default":[5,{}]}),
            false,
            json!({"obj":[5,{"n":7}]}),
            json!({"obj":[null,{}]}),
            json!({"obj":[null,{"n":7}]}),
        ),
        (
            "referenced_object_literal",
            json!({"$ref":"#/$defs/value","properties":{"n":{"default":8}}}),
            json!({"type":"object","default":{"n":7}}),
            true,
            json!({}),
            json!({"obj":{"n":9}}),
            json!({"obj":{"n":9}}),
        ),
        (
            "local_object_literal",
            json!({"$ref":"#/$defs/value","default":{"n":8}}),
            json!({"type":"object","properties":{"n":{"default":7}}}),
            true,
            json!({}),
            json!({"obj":{"n":9}}),
            json!({"obj":{"n":9}}),
        ),
        (
            "referenced_array_literal",
            json!({"$ref":"#/$defs/value","prefixItems":[{"default":7}]}),
            json!({"type":"array","default":[8]}),
            true,
            json!({}),
            json!({"obj":[9]}),
            json!({"obj":[9]}),
        ),
        (
            "own_literal_precedes_own_child_default",
            json!({"type":"object","default":{"n":7},"properties":{"n":{"default":8}}}),
            json!(true),
            false,
            json!({"obj":{"n":7}}),
            json!({"obj":{"n":null}}),
            json!({"obj":{"n":null}}),
        ),
        (
            "compatible_object_children",
            json!({"$ref":"#/$defs/value","default":{},"properties":{"n":{"default":7},"m":{"default":10}}}),
            json!({"type":"object","properties":{"n":{"default":7}}}),
            false,
            json!({"obj":{"n":7,"m":10}}),
            json!({"obj":{"n":null}}),
            json!({"obj":{"n":null,"m":10}}),
        ),
        (
            "compatible_array_literal",
            json!({"$ref":"#/$defs/value","prefixItems":[{"default":7}]}),
            json!({"type":"array","default":[7]}),
            false,
            json!({"obj":[7]}),
            json!({"obj":[null]}),
            json!({"obj":[null]}),
        ),
    ] {
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
            "$defs":{"value":definition},"properties":{"obj":property},
            "required":["obj"],"additionalProperties":false
        }))
        .unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if conflict {
            if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="INVALID_ARGUMENT") {
                let _profile = fixture.finish().await;
                panic!("Conflicting seeded container candidate was admitted ({name}): {reply:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Conflicting seeded candidate retained an operation ({name}): {lookup:?}");
            }
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Compatible seeded container rejected ({name}): {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            let settled = fixture
                .wait(&fixture.client, &result.operation.operation_id)
                .await;
            assert_eq!(
                settled.state,
                OperationState::Succeeded,
                "{name}: {settled:?}"
            );
            assert_eq!(
                fixture.result(&fixture.client, &settled).await,
                json!({"params":expected,"calls":1}),
                "{name}"
            );
            call = fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({}),
            );
        }
        call.params = serde_json::from_value(explicit).unwrap();
        let accepted = fixture.invoke(&fixture.client, call).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "{name}: {settled:?}"
        );
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        assert_eq!(
            observed,
            json!({"params":explicit_expected,"calls":if conflict {1} else {2}}),
            "{name}"
        );
        eprintln!(
            "native_public_seeded_candidate name={name} conflict_rejected={conflict} zero_admission={conflict} explicit_preserved=true"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_reject_conflicts_in_generated_reference_containers() {
    let mut action = spec();
    action.input_schema = serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
        "$defs":{"object":{"type":"object","properties":{"n":{"type":"integer","default":7}}}},
        "properties":{"obj":{"$ref":"#/$defs/object","default":{},"properties":{"n":{"type":"integer","default":8},"m":{"type":"integer","default":10}}}},
        "required":["obj"],"additionalProperties":false
    })).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"],"additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let mut call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({}),
    );
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(call.clone()))
        .await
        .unwrap();
    if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="INVALID_ARGUMENT") {
        let _profile = fixture.finish().await;
        panic!("Generated parent concealed a conflicting referenced child default: {reply:?}");
    }
    let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
        "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
    })))).await.unwrap();
    if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
        let _profile = fixture.finish().await;
        panic!("Generated-container conflict retained an operation: {lookup:?}");
    }
    call.params = serde_json::from_value(json!({"obj":{"n":9}})).unwrap();
    let accepted = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"params":{"obj":{"n":9,"m":10}},"calls":1}));
    eprintln!(
        "native_public_generated_reference_container conflict_rejected=true zero_admission=true same_request_retry=true explicit_preserved=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_replay_saved_schema_after_signed_package_upgrade() {
    use support::node_package::{archive, manifest, payloads, with_metadata};

    let source = b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({value:call.params.value+0.25,calls:++calls}));return ()=>{};}";
    let mut action = spec();
    action.input_schema = serde_json::from_value(json!({
        "type":"object","properties":{"value":{"type":"integer","default":7}},
        "required":["value"],"additionalProperties":false
    }))
    .unwrap();
    let fixture = Fixture::program(action.clone(), source).await;
    let original = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({}),
    );
    let accepted = fixture.invoke(&fixture.client, original.clone()).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let first_result = fixture.result(&fixture.client, &settled).await;

    action.input_schema = serde_json::from_value(json!({
        "type":"object","properties":{"value":{"type":"integer","default":8}},
        "required":["value"],"additionalProperties":false
    }))
    .unwrap();
    let mut metadata = manifest();
    metadata["version"] = json!("2.0.0");
    metadata["permissions"]["hostApi"] =
        json!([{"permissions":action.permissions,"targetKinds":action.target_kinds}]);
    metadata["contributes"]["actions"] = json!([action]);
    let mut files = payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&metadata).unwrap(),
    );
    files.insert("dist/main.mjs".into(), source.to_vec());
    let path = fixture.dir.path().join("signed-actions-upgrade.zip");
    std::fs::write(&path, archive(&with_metadata(files, true))).unwrap();
    let registered = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "file.register",
                json!({"path":path.to_str().unwrap(),"purpose":"read_file"}),
            ),
        )
        .await;
    let registered = fixture.wait(&fixture.user, &registered.operation_id).await;
    let Some(ActionResult::FileMetadata(reference)) = registered.result else {
        panic!("Expected registered upgrade archive: {registered:?}")
    };
    let installed = fixture
        .mutate(
            &fixture.client,
            "node.packages.install",
            json!({"archiveRef":reference.file_ref,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}}),
            3,
        )
        .await;
    assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
    let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
        panic!("Expected installed upgrade: {installed:?}")
    };
    assert_eq!(installed.revision, 4.into());
    assert!(installed.package.enabled && installed.package.execution_approved);
    let upgraded_archive = installed.package.archive_sha256.clone();
    // 相容升级继承原批准并自动登记；重复确认会与该真实恢复争用同一安装名额。
    let mut last = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let QueryResult::NodePackageRuntime(runtime) = fixture
                .query(
                    &fixture.client,
                    &fixture.target,
                    "node.packages.runtime",
                    json!({"id":"example.terminal"}),
                )
                .await
            else {
                panic!("Expected upgraded runtime");
            };
            let active = runtime.phase == NodePackageRuntimePhase::Active
                && runtime.archive_sha256.as_ref() == Some(&upgraded_archive);
            last = Some(runtime);
            if active {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Compatible upgrade did not actually register: {last:?}"));

    let replay = fixture.invoke(&fixture.client, original.clone()).await;
    let mut explicit = original;
    explicit.params = serde_json::from_value(json!({"value":7})).unwrap();
    let equivalent = fixture.invoke(&fixture.client, explicit.clone()).await;
    explicit.params = serde_json::from_value(json!({"value":8})).unwrap();
    let conflict = fixture
        .client
        .request(RpcRequest::Invoke(explicit))
        .await
        .unwrap();
    let replay_result = fixture.result(&fixture.client, &replay).await;
    let fresh = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({}),
            ),
        )
        .await;
    let fresh = fixture.wait(&fixture.client, &fresh.operation_id).await;
    assert_eq!(fresh.state, OperationState::Succeeded, "{fresh:?}");
    let fresh_result = fixture.result(&fixture.client, &fresh).await;
    let old_archive = fixture.archive.clone();
    let _profile = fixture.finish().await;

    assert_eq!(first_result, json!({"value":7.25,"calls":1}));
    assert_eq!(replay_result, first_result);
    assert_eq!(replay, settled);
    assert_eq!(equivalent, settled);
    assert!(
        matches!(&conflict,RpcReply::Failure {error,..} if error.code=="REQUEST_CONFLICT"),
        "{conflict:?}"
    );
    assert_eq!(replay.owner.version.as_deref(), Some("1.0.0"));
    assert_eq!(replay.dependencies.as_ref().unwrap()[0].digest, old_archive);
    assert_ne!(upgraded_archive, old_archive);
    assert_ne!(fresh.operation_id, settled.operation_id);
    assert_eq!(fresh.owner.version.as_deref(), Some("2.0.0"));
    assert_eq!(
        fresh.dependencies.as_ref().unwrap()[0].digest,
        upgraded_archive
    );
    assert_eq!(fresh_result, json!({"value":8.25,"calls":1}));
    eprintln!(
        "native_public_signed_upgrade_defaults old_default=7 new_default=8 saved_schema_replay=true old_owner_and_archive_preserved=true changed_intent_conflicts=true new_owner_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_reject_reference_sibling_property_conflicts() {
    let mut action = spec();
    action.input_schema=serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
        "definitions":{"object":{"type":"object","properties":{"n":{"type":"integer","default":7}},"required":["n"]}},
        "properties":{"obj":{"$ref":"#/definitions/object","properties":{"n":{"type":"integer","default":8},"m":{"type":"integer","default":10}}}},
        "required":["obj"],"additionalProperties":false
    })).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"],"additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let mut call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"obj":{}}),
    );
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(call.clone()))
        .await
        .unwrap();
    if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="INVALID_ARGUMENT") {
        let _profile = fixture.finish().await;
        panic!("Reference-filled property concealed a conflicting sibling default: {reply:?}");
    }
    let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
        "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
    })))).await.unwrap();
    if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
        let _profile = fixture.finish().await;
        panic!("Conflicting property defaults retained an operation: {lookup:?}");
    }
    call.params = serde_json::from_value(json!({"obj":{"n":9}})).unwrap();
    let accepted = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"params":{"obj":{"n":9,"m":10}},"calls":1}));
    eprintln!(
        "native_public_reference_sibling_properties conflict_rejected=true zero_admission=true same_request_retry=true explicit_preserved=true other_default_applied=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_apply_reference_children_after_sibling_container_seed() {
    let mut action = spec();
    action.input_schema=serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",
        "definitions":{"object":{"type":"object","properties":{"n":{"type":"integer","default":7}},"required":["n"]}},
        "properties":{"obj":{"$ref":"#/definitions/object","default":{},"properties":{"m":{"type":"integer","default":8}}}},
        "required":["obj"],"additionalProperties":false
    })).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"],"additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    for (params, expected, calls) in [
        (json!({}), json!({"obj":{"n":7,"m":8}}), 1),
        (json!({"obj":{}}), json!({"obj":{"n":7,"m":8}}), 2),
        (json!({"obj":{"n":9}}), json!({"obj":{"n":9,"m":8}}), 3),
    ] {
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                params,
            )))
            .await
            .unwrap();
        let RpcReply::Success { result, .. } = reply else {
            let _profile = fixture.finish().await;
            panic!("Referenced child defaults did not see the sibling container seed: {reply:?}");
        };
        let RpcResult::Operation(result) = *result else {
            panic!("Expected operation")
        };
        let settled = fixture
            .wait(&fixture.client, &result.operation.operation_id)
            .await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        assert_eq!(
            fixture.result(&fixture.client, &settled).await,
            json!({"params":expected,"calls":calls})
        );
    }
    let _profile = fixture.finish().await;
    eprintln!(
        "native_public_reference_container_defaults missing_seed_completed=true explicit_object_completed=true explicit_value_preserved=true handler_calls=3"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_defaults_merge_reference_and_sibling_seeds() {
    for (dialect, sibling, conflict) in [
        ("https://json-schema.org/draft/2020-12/schema", 8, true),
        ("https://json-schema.org/draft/2020-12/schema", 7, false),
        ("http://json-schema.org/draft-07/schema#", 8, false),
    ] {
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":dialect,"type":"object",
            "definitions":{"number":{"type":"integer","default":7}},
            "properties":{"n":{"$ref":"#/definitions/number","default":sibling}},
            "required":["n"],"additionalProperties":false
        }))
        .unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        let accepted = if conflict {
            if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="INVALID_ARGUMENT") {
                let _profile = fixture.finish().await;
                panic!("Conflicting reference/sibling defaults were admitted: {reply:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Conflicting defaults retained an operation: {lookup:?}");
            }
            call.params = serde_json::from_value(json!({"n":9})).unwrap();
            fixture.invoke(&fixture.client, call).await
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Compatible defaults or Draft7 reference rejected: {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            result.operation
        };
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        assert_eq!(
            observed,
            json!({"params":{"n":if conflict {9} else {7}},"calls":1})
        );
        eprintln!(
            "native_public_reference_sibling_defaults dialect={dialect} sibling_default={sibling} conflict_rejected={conflict} same_request_retry={conflict} handler_calls=1"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_budget_meters_ancestor_uri_key_copies() {
    for uri_bytes in [16, 128 * 1024] {
        let mut action = spec();
        action.input_schema=serde_json::from_value(json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema", "$id":format!("https://schema.invalid/{}","a".repeat(uri_bytes)), "type":"object",
            "$defs":{"B":{"$id":"urn:swb:short","$defs":{"H":{}},"allOf":vec![json!({"$ref":"#/$defs/H"});1000]}},
            "properties":{"costly":{"$ref":"urn:swb:short"}}
        })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"costly":{}}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        let limited = uri_bytes > 16;
        let accepted = if limited {
            if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
                let _profile = fixture.finish().await;
                panic!("Ancestor URI copies escaped the work budget: {reply:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Rejected URI-copy request retained an operation: {lookup:?}");
            }
            call.params = serde_json::from_value(json!({})).unwrap();
            fixture.invoke(&fixture.client, call).await
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Small URI scope rejected: {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            result.operation
        };
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        let expected = if limited {
            json!({})
        } else {
            json!({"costly":{}})
        };
        assert_eq!(observed, json!({"params":expected,"calls":1}));
        eprintln!(
            "native_public_ancestor_uri_budget uri_bytes={uri_bytes} repeated_refs=1000 limit_rejected={limited} zero_admission_checked={limited} same_request_retry={limited} handler_calls=1"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_unsolicited_cancellation_settles_failed_without_replay() {
    let fixture = Fixture::program(
        spec(),
        br#"
        export function register(context) {
          let calls=0;
          context.actions.register('example.terminal.compute',(call,{signal})=>{
            calls++;
            if(call.params.value===7) {
              Object.defineProperty(signal,'aborted',{value:true});
              throw new Error('package stopped without a Host cancellation request');
            }
            return {value:call.params.value+0.25,calls};
          });
          return ()=>{};
        }
    "#,
    )
    .await;
    let call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":7}),
    );
    let accepted = fixture.invoke(&fixture.client, call.clone()).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    if settled.state != OperationState::Failed
        || settled
            .error
            .as_ref()
            .is_none_or(|error| error.code != "NODE_ACTION_FAILED")
        || settled.result.is_some()
    {
        let _profile = fixture.finish().await;
        panic!("Unexpected cancellation was accepted as a Host cancellation: {settled:?}");
    }
    let replay = fixture.invoke(&fixture.client, call).await;
    assert_eq!(replay.operation_id, accepted.operation_id);
    let replay = fixture.wait(&fixture.client, &replay.operation_id).await;
    assert_eq!(replay.state, OperationState::Failed, "{replay:?}");
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":8}),
            ),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"value":8.25,"calls":2}));
    eprintln!(
        "native_public_unsolicited_cancellation failed_without_request=true replay_preserved=true no_result_published=true control_usable=true handler_calls=2"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_budget_counts_first_weak_reference_expansion() {
    for (backedges, heavy, aliases, limited) in [
        (1, 4, false, false),
        (32, 256, false, true),
        (2, 4, true, false),
        (2, 192, true, true),
    ] {
        let mut branches = vec![json!({"$ref":"#/$defs/H"})];
        let mut definitions = serde_json::Map::new();
        definitions.insert(
            "H".into(),
            json!({"allOf":vec![json!({"properties":{"marker":{"type":"boolean"}}});heavy]}),
        );
        for index in 0..backedges {
            branches.push(json!({"$ref":format!("#/$defs/B{index}")}));
            let reference = if aliases {
                if index == 0 { "#a" } else { "#d" }
            } else {
                "#/$defs/A"
            };
            definitions.insert(format!("B{index}"), json!({"$ref":reference}));
        }
        let mut target = json!({"allOf":branches});
        if aliases {
            target["$anchor"] = json!("a");
            target["$dynamicAnchor"] = json!("d");
        }
        definitions.insert("A".into(), target);
        let mut action = spec();
        action.input_schema=serde_json::from_value(json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","$defs":definitions,
            "properties":{"list":{"type":"array","contains":{"$ref":"#/$defs/A"},"unevaluatedItems":{"type":"object","properties":{"n":{"default":7}}}}}
        })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"list":[{}]}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        let accepted = if limited {
            if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
                let _profile = fixture.finish().await;
                panic!("First weak-reference expansion was not budgeted: {reply:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Rejected weak-reference request retained an operation: {lookup:?}");
            }
            call.params = serde_json::from_value(json!({})).unwrap();
            fixture.invoke(&fixture.client, call).await
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Small weak-reference cycle rejected: {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            result.operation
        };
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        let expected = if limited {
            json!({})
        } else {
            json!({"list":[{}]})
        };
        assert_eq!(observed, json!({"params":expected,"calls":1}));
        eprintln!(
            "native_public_weak_reference_budget backedges={backedges} heavy_branches={heavy} aliases={aliases} limit_rejected={limited} zero_admission_checked={limited} same_request_retry={limited} handler_calls=1"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_budget_uses_actual_property_pattern_matcher() {
    for dialect in [
        "http://json-schema.org/draft-07/schema#",
        "https://json-schema.org/draft/2020-12/schema",
    ] {
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":dialect,"type":"object",
            "patternProperties":{"^(a|aa)+(?=X)X$":{"type":"object","properties":{"n":{"default":7}}}}
        }))
        .unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"], "additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let expensive = format!("{}Y", "a".repeat(32));
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({expensive:{}}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
            let _profile = fixture.finish().await;
            panic!("Unfinished property pattern was not rejected: {reply:?}");
        }
        let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
            "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
        })))).await.unwrap();
        if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
            let _profile = fixture.finish().await;
            panic!("Rejected property pattern retained an operation: {lookup:?}");
        }
        call.params = serde_json::from_value(json!({"aaaaX":{}})).unwrap();
        let accepted = fixture.invoke(&fixture.client, call).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let matched = fixture.result(&fixture.client, &settled).await;
        let accepted = fixture
            .invoke(
                &fixture.client,
                fixture.call(
                    &fixture.client,
                    &fixture.target,
                    "example.terminal.compute",
                    json!({"safe":{}}),
                ),
            )
            .await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let unmatched = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        assert_eq!(matched, json!({"params":{"aaaaX":{"n":7}},"calls":1}));
        assert_eq!(unmatched, json!({"params":{"safe":{}} ,"calls":2}));
        eprintln!(
            "native_public_property_pattern_budget dialect={dialect} zero_admission=true same_request_retry=true matching_defaults=true nonmatch_preserved=true handler_calls=2"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_budget_counts_recursive_coverage_work() {
    for chain in [2, 18] {
        let mut definitions = serde_json::Map::new();
        definitions.insert(
            "d0".into(),
            json!({"properties":{"marker":{"type":"boolean"}}}),
        );
        for level in 1..=chain + 5 {
            let target = format!("#/$defs/d{}", level - 1);
            let branches = if level <= chain {
                json!([{"$ref":target}])
            } else {
                json!([{"$ref":target},{"$ref":target}])
            };
            definitions.insert(format!("d{level}"), json!({"allOf":branches}));
        }
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema", "type":"object", "$defs":definitions,
            "properties":{"costly":{"allOf":[{"$ref":format!("#/$defs/d{}",chain+5)}],"unevaluatedProperties":false}}
        })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"], "additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"costly":{"marker":true}}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        let accepted = if chain == 18 {
            if !matches!(&reply,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED") {
                let _profile = fixture.finish().await;
                panic!("Recursive coverage was not budgeted before admission: {reply:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Rejected coverage request retained an operation: {lookup:?}");
            }
            call.params = serde_json::from_value(json!({})).unwrap();
            fixture.invoke(&fixture.client, call).await
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Bounded recursive coverage rejected: {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            result.operation
        };
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        let expected = if chain == 18 {
            json!({})
        } else {
            json!({"costly":{"marker":true}})
        };
        assert_eq!(observed, json!({"params":expected,"calls":1}));
        eprintln!(
            "native_public_recursive_coverage_budget chain={chain} limit_rejected={} zero_admission_checked={} same_request_retry={} handler_calls=1",
            chain == 18,
            chain == 18,
            chain == 18
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_budget_rejects_output_without_replaying_effects() {
    let mut definitions = serde_json::Map::new();
    definitions.insert("d0".into(), json!({"type":"object"}));
    for level in 1..=12 {
        let target = format!("#/$defs/d{}", level - 1);
        definitions.insert(
            format!("d{level}"),
            json!({"allOf":[{"$ref":target},{"$ref":target}]}),
        );
    }
    let mut action = spec();
    action.output_schema=serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema", "type":"object", "$defs":definitions,
        "if":{"properties":{"costly":{"$ref":"#/$defs/d12"}}},
        "then":{"required":["calls"]}, "else":false
    })).unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>{calls++;return call.params.value===7?{costly:{},calls}:{calls};});return ()=>{};}").await;
    let call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":7}),
    );
    let accepted = fixture.invoke(&fixture.client, call.clone()).await;
    let failed = fixture.wait(&fixture.client, &accepted.operation_id).await;
    if failed.state != OperationState::Failed
        || failed
            .error
            .as_ref()
            .is_none_or(|e| e.code != "LIMIT_EXCEEDED")
        || failed.result.is_some()
    {
        let _profile = fixture.finish().await;
        panic!("Output schema bypassed budget or retained an unchecked result: {failed:?}");
    }
    let replay = fixture.invoke(&fixture.client, call).await;
    assert_eq!(replay.operation_id, accepted.operation_id);
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":8}),
            ),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"calls":2}));
    eprintln!(
        "native_public_output_budget failed_result_not_published=true replay_preserved=true control_usable=true handler_calls=2"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_budget_checks_inputs_without_defaults() {
    let mut definitions = serde_json::Map::new();
    definitions.insert("d0".into(), json!({"type":"object"}));
    for level in 1..=12 {
        let target = format!("#/$defs/d{}", level - 1);
        definitions.insert(
            format!("d{level}"),
            json!({"allOf":[{"$ref":target},{"$ref":target}]}),
        );
    }
    let mut action = spec();
    action.input_schema=serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema", "type":"object", "$defs":definitions,
        "if":{"properties":{"costly":{"$ref":"#/$defs/d12"}}},
        "then":{"required":["marker"]}, "else":{"required":["fallback"]}
    })).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"], "additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let mut call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"costly":{},"marker":true}),
    );
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(call.clone()))
        .await
        .unwrap();
    let RpcReply::Failure { error, .. } = reply else {
        let _profile = fixture.finish().await;
        panic!("No-default schema bypassed the budget: {reply:?}");
    };
    if error.code != "LIMIT_EXCEEDED" {
        let _profile = fixture.finish().await;
        panic!("Expected schema budget: {error:?}");
    }
    let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
        "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
    })))).await.unwrap();
    if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
        let _profile = fixture.finish().await;
        panic!("Schema budget rejection retained an operation: {lookup:?}");
    }
    call.params = serde_json::from_value(json!({"marker":true})).unwrap();
    let accepted = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"params":{"marker":true},"calls":1}));
    eprintln!(
        "native_public_schema_budget no_defaults=true zero_admission=true same_request_retry=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_budget_checks_condition_before_validation() {
    for levels in [4, 12] {
        let mut definitions = serde_json::Map::new();
        definitions.insert("d0".into(), json!({"type":"object"}));
        for level in 1..=levels {
            let target = format!("#/$defs/d{}", level - 1);
            definitions.insert(
                format!("d{level}"),
                json!({"allOf":[{"$ref":target},{"$ref":target}]}),
            );
        }
        let mut action = spec();
        action.input_schema=serde_json::from_value(json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema", "type":"object", "$defs":definitions,
            "properties":{"flag":{"type":"boolean"}}, "required":["flag"],
            "if":{"properties":{"costly":{"$ref":format!("#/$defs/d{levels}")}}},
            "then":{"properties":{"flag":{"default":true}}},
            "else":{"properties":{"flag":{"default":false}}}
        })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"], "additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"costly":{}}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if levels == 12 {
            let RpcReply::Failure { error, .. } = &reply else {
                let _profile = fixture.finish().await;
                panic!("Unbounded condition was admitted: {reply:?}");
            };
            if error.code != "LIMIT_EXCEEDED" {
                let _profile = fixture.finish().await;
                panic!("Expected condition budget: {error:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Rejected condition retained an operation: {lookup:?}");
            }
            call.params = serde_json::from_value(json!({})).unwrap();
        }
        let accepted = if levels == 12 {
            fixture.invoke(&fixture.client, call).await
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Bounded condition rejected: {reply:?}");
            };
            let RpcResult::Operation(result) = *result else {
                panic!("Expected operation")
            };
            result.operation
        };
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        let expected = if levels == 12 {
            json!({"flag":true})
        } else {
            json!({"costly":{},"flag":true})
        };
        assert_eq!(observed, json!({"params":expected,"calls":1}));
        eprintln!(
            "native_public_condition_budget reference_depth={levels} limit_rejected={} zero_admission_checked={} same_request_retry={} handler_calls=1",
            levels == 12,
            levels == 12,
            levels == 12
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_budget_rejects_expansion_before_admission() {
    for levels in [4, 12] {
        let mut definitions = serde_json::Map::new();
        definitions.insert("d0".into(), json!({"const":0}));
        for level in 1..=levels {
            let target = format!("#/$defs/d{}", level - 1);
            definitions.insert(
                format!("d{level}"),
                json!({"allOf":[{"$ref":target},{"$ref":target}]}),
            );
        }
        let mut action = spec();
        action.input_schema = serde_json::from_value(json!({
            "$schema":"https://json-schema.org/draft/2020-12/schema", "type":"object", "$defs":definitions,
            "properties":{"list":{"type":"array","contains":{"$ref":format!("#/$defs/d{levels}")}}},
            "unevaluatedProperties":{"type":"object","properties":{"n":{"default":7}},"required":["n"]}
        })).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"], "additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let mut call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"list":[0],"extra":{}}),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call.clone()))
            .await
            .unwrap();
        if levels == 12 {
            let RpcReply::Failure { error, .. } = &reply else {
                let _profile = fixture.finish().await;
                panic!("Expanded evaluation was admitted: {reply:?}");
            };
            if error.code != "LIMIT_EXCEEDED" {
                let _profile = fixture.finish().await;
                panic!("Expected evaluation limit: {error:?}");
            }
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            if !matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND") {
                let _profile = fixture.finish().await;
                panic!("Budget failure retained an operation: {lookup:?}");
            }
            call.params = serde_json::from_value(json!({"extra":{}})).unwrap();
        }
        let accepted = if levels == 12 {
            fixture.invoke(&fixture.client, call).await
        } else {
            let RpcReply::Success { result, .. } = reply else {
                let _profile = fixture.finish().await;
                panic!("Bounded evaluation rejected: {reply:?}");
            };
            let RpcResult::Operation(accepted) = *result else {
                panic!("Expected a persistent action")
            };
            accepted.operation
        };
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        let expected = if levels == 12 {
            json!({"extra":{"n":7}})
        } else {
            json!({"list":[0],"extra":{"n":7}})
        };
        assert_eq!(observed, json!({"params":expected,"calls":1}));
        eprintln!(
            "native_public_default_budget reference_depth={levels} limit_rejected={} zero_admission_checked={} same_request_retry={} handler_calls=1",
            levels == 12,
            levels == 12,
            levels == 12
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_evaluate_bounded_same_instance_recursion() {
    let mut action = spec();
    action.input_schema=serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema", "$ref":"#", "type":"object",
        "properties":{"n":{"type":"integer","default":7}}, "required":["n"], "unevaluatedProperties":{}
    })).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"], "additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({}),
            ),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"params":{"n":7},"calls":1}));
    eprintln!("native_public_default_budget same_instance_cycle_bounded=true handler_calls=1");
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_converge_when_contains_coverage_changes() {
    let mut action = spec();
    action.input_schema = serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema", "type":"object",
        "properties":{"list":{
            "type":"array", "contains":{"properties":{"n":{"const":7}},"required":["n"]},
            "unevaluatedItems":{"properties":{"n":{"default":7}}}
        }}, "required":["list"], "additionalProperties":false
    }))
    .unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"], "additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"list":[{}]}),
    );
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(call))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        let _profile = fixture.finish().await;
        panic!("Contains coverage did not converge: {reply:?}");
    };
    let RpcResult::Operation(accepted) = *result else {
        let _profile = fixture.finish().await;
        panic!("Expected a persistent action");
    };
    let settled = fixture
        .wait(&fixture.client, &accepted.operation.operation_id)
        .await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"params":{"list":[{"n":7}]},"calls":1}));
    eprintln!(
        "native_public_default_contains converged=true contains_after_default=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_keep_unevaluated_reference_scope() {
    let mut action = spec();
    action.input_schema = serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$id":"https://example.invalid/unevaluated/input.json", "type":"object",
        "properties":{"cfg":{"$ref":"options.json"}}, "required":["cfg"], "additionalProperties":false,
        "$defs":{"options":{
            "$id":"options.json", "type":"object",
            "properties":{"entry :/ä":{
                "type":"object", "properties":{"known":{"type":"object"}},
                "unevaluatedProperties":{"$ref":"#/$defs/missing"}
            }},
            "$defs":{"missing":{"properties":{"n":{"default":7}},"additionalProperties":false}}
        }}
    })).unwrap();
    action.output_schema = serde_json::from_value(json!({
        "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
        "required":["params","calls"], "additionalProperties":false
    }))
    .unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"cfg":{"entry :/ä":{"known":{},"extra":{}}}}),
    );
    let reply = fixture
        .client
        .request(RpcRequest::Invoke(call))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        let _profile = fixture.finish().await;
        panic!("Scoped unevaluated defaults rejected: {reply:?}");
    };
    let RpcResult::Operation(accepted) = *result else {
        let _profile = fixture.finish().await;
        panic!("Expected a persistent action");
    };
    let settled = fixture
        .wait(&fixture.client, &accepted.operation.operation_id)
        .await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(
        observed,
        json!({"params":{"cfg":{"entry :/ä":{"known":{},"extra":{"n":7}}}},"calls":1})
    );
    eprintln!(
        "native_public_default_unevaluated_scope optional_default_applied=true nested_id=true escaped_utf8_pointer=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_apply_only_to_unevaluated_values() {
    for modern in [true, false] {
        let missing = json!({
            "type":"object", "properties":{"n":{"type":"integer","default":7}},
            "required":["n"], "additionalProperties":false
        });
        let schema = json!({
            "$schema":if modern {"https://json-schema.org/draft/2020-12/schema"} else {"http://json-schema.org/draft-07/schema#"},
            "type":"object",
            "allOf":[{"properties":{
                "known":{"type":"object"},
                "list":{"type":"array","prefixItems":[{"type":"object"}],"unevaluatedItems":missing.clone()}
            }}],
            "unevaluatedProperties":missing
        });
        let mut action = spec();
        action.input_schema = serde_json::from_value(schema).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object", "properties":{"params":{"type":"object"},"calls":{"type":"integer"}},
            "required":["params","calls"], "additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let input = json!({"known":{},"extra":{},"list":[{},{}]});
        let call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            input.clone(),
        );
        let reply = fixture
            .client
            .request(RpcRequest::Invoke(call))
            .await
            .unwrap();
        let RpcReply::Success { result, .. } = reply else {
            let _profile = fixture.finish().await;
            panic!("Unevaluated defaults rejected: draft2020={modern}: {reply:?}");
        };
        let RpcResult::Operation(accepted) = *result else {
            let _profile = fixture.finish().await;
            panic!("Expected a persistent action");
        };
        let settled = fixture
            .wait(&fixture.client, &accepted.operation.operation_id)
            .await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        let observed = fixture.result(&fixture.client, &settled).await;
        let _profile = fixture.finish().await;
        let expected = if modern {
            json!({"known":{},"extra":{"n":7},"list":[{},{"n":7}]})
        } else {
            input
        };
        assert_eq!(
            observed,
            json!({"params":expected,"calls":1}),
            "draft2020={modern}"
        );
        eprintln!(
            "native_public_default_unevaluated draft2020={modern} all_of_coverage_preserved=true prefix_item_preserved=true handler_calls=1"
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_keep_dynamic_predicate_binding() {
    let mut action = spec();
    let base = json!({
        "$id":"base.json","$dynamicAnchor":"gate","type":"object",
        "properties":{"item":{
            "type":"object","if":{"$dynamicRef":"#gate"},
            "then":{"properties":{"chosen":{"default":"base"}}},
            "else":{"properties":{"chosen":{"default":"outer"}}}
        }}
    });
    action.input_schema=serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://example.invalid/outer.json",
        "$dynamicAnchor":"gate","$ref":"base.json","required":["requiredFlag"],"$defs":{"base":base}
    })).unwrap();
    action.output_schema=serde_json::from_value(json!({"type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},"required":["params","calls"],"additionalProperties":false})).unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"requiredFlag":true,"item":{}}),
            ),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"params":{"requiredFlag":true,"item":{"chosen":"outer"}},"calls":1})
    );
    eprintln!("native_public_dynamic_predicate outer_binding_preserved=true handler_calls=1");
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_validate_predicates_in_their_resource_scope()
{
    for modern in [false, true] {
        let dictionary = if modern { "$defs" } else { "definitions" };
        let mut schema = json!({"$schema":if modern {"https://json-schema.org/draft/2020-12/schema"}else{"http://json-schema.org/draft-07/schema#"},"$id":"https://example.invalid/scopes/input.json","type":"object","properties":{"options":{"$ref":"options.json"}},"required":["options"],"additionalProperties":false});
        let mut options = json!({"$id":"options.json","type":"object","default":{},"properties":{"n":{"type":"integer","default":7},"flag":{"type":"boolean"}},"if":{"$ref":format!("#/{dictionary}/condition")},"then":{"properties":{"flag":{"default":true}}},"else":{"properties":{"flag":{"default":false}}},"required":["n","flag"],"additionalProperties":false});
        options[dictionary] =
            json!({"condition":{"properties":{"n":{"const":7}},"required":["n"]}});
        schema[dictionary] = json!({"condition":{"properties":{"n":{"const":8}},"required":["n"]},"options":options});
        let mut action = spec();
        action.input_schema = serde_json::from_value(schema).unwrap();
        action.output_schema=serde_json::from_value(json!({"type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},"required":["params","calls"],"additionalProperties":false})).unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let accepted = fixture
            .invoke(
                &fixture.client,
                fixture.call(
                    &fixture.client,
                    &fixture.target,
                    "example.terminal.compute",
                    json!({}),
                ),
            )
            .await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "draft2020={modern}: {settled:?}"
        );
        assert_eq!(
            fixture.result(&fixture.client, &settled).await,
            json!({"params":{"options":{"n":7,"flag":true}},"calls":1}),
            "draft2020={modern}"
        );
        eprintln!(
            "native_public_default_predicate_scope draft2020={modern} nested_condition_selected=true"
        );
        fixture.finish().await;
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_seed_referenced_conjunctions() {
    for modern in [false, true] {
        let mut action = spec();
        action.input_schema=serde_json::from_value(json!({
            "$schema":if modern {"https://json-schema.org/draft/2020-12/schema"}else{"http://json-schema.org/draft-07/schema#"},
            "type":"object","properties":{"cfg":{"$ref":"#/x-schemas/cfg"}},"required":["cfg"],"additionalProperties":false,
            "x-schemas":{"cfg":{
                "allOf":[{"type":"object","default":{},"properties":{"value":{"type":"integer","default":7}}}],
                "properties":{"flag":{"type":"boolean"}},
                "if":{"properties":{"value":{"const":7}},"required":["value"]},
                "then":{"properties":{"flag":{"default":true}}},
                "else":{"properties":{"flag":{"default":false}}}
            }}
        })).unwrap();
        action.output_schema=serde_json::from_value(json!({"type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},"required":["params","calls"],"additionalProperties":false})).unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({}),
        );
        let accepted = fixture.invoke(&fixture.client, call.clone()).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "draft2020={modern}: {settled:?}"
        );
        assert_eq!(
            fixture.result(&fixture.client, &settled).await,
            json!({"params":{"cfg":{"value":7,"flag":true}},"calls":1}),
            "draft2020={modern}"
        );
        let mut explicit = call;
        explicit.params = serde_json::from_value(json!({"cfg":{"value":7,"flag":true}})).unwrap();
        assert_eq!(
            fixture.invoke(&fixture.client, explicit).await.operation_id,
            accepted.operation_id
        );
        eprintln!(
            "native_public_default_conjunction draft2020={modern} pointer_target=true missing_container_seeded=true"
        );
        fixture.finish().await;
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_preserve_dynamic_reference_scope() {
    let mut action = spec();
    action.input_schema=serde_json::from_value(json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://example.invalid/strict.json","$dynamicAnchor":"node",
        "$ref":"base.json","properties":{"tag":{"type":"string","default":"outer"}},
        "$defs":{"base":{"$id":"base.json","$dynamicAnchor":"node","type":["object","null"],"properties":{"value":{"type":"integer","default":7},"next":{"$dynamicRef":"#node"}}}}
    })).unwrap();
    action.output_schema=serde_json::from_value(json!({"type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},"required":["params","calls"],"additionalProperties":false})).unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"next":{}}),
            ),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"params":{"value":7,"tag":"outer","next":{"value":7,"tag":"outer"}},"calls":1})
    );
    eprintln!("native_public_default_dynamic_reference outer_scope_retained=true handler_calls=1");
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_follow_scoped_refs_arrays_and_branches() {
    for modern in [false, true] {
        let dictionary = if modern { "$defs" } else { "definitions" };
        let mut input = json!({
            "$schema":if modern {"https://json-schema.org/draft/2020-12/schema"}else{"http://json-schema.org/draft-07/schema#"},
            "$id":"https://example.invalid/parameters/input.json", "type":"object",
            "properties":{
                "value":{"$ref":format!("#/{dictionary}/a~1b")},
                "options":{"$ref":if modern {"options.json#opts"}else{"options.json"}},
                "entries":{"type":"array","default":[{},{}],"items":{"type":"object","properties":{"enabled":{"type":"boolean","default":true}},"additionalProperties":false}},
                "tuple":{},"mode":{"enum":["on","off"]},"note":{"type":["null","string"],"default":"new"},
                "shared":{"type":"integer"},"branchOnly":{"type":"integer"},"conditional":{"type":"string"},"dependent":{"type":"string"},
                "bag":{"type":"object","default":{"k_1":{}},"patternProperties":{"^k_":{"type":"object","properties":{"n":{"type":"integer","default":4}},"additionalProperties":false}},"additionalProperties":false}
            },
            "allOf":[{"properties":{"shared":{"default":5}}},{"properties":{"shared":{"default":5}}}],
            "anyOf":[{"properties":{"branchOnly":{"default":9}}},{"properties":{"branchOnly":{"default":10}}}],
            "if":{"properties":{"mode":{"const":"on"}},"required":["mode"]},
            "then":{"properties":{"conditional":{"default":"enabled"}}},
            "else":{"properties":{"conditional":{"default":"disabled"}}},
            "required":["value","options","entries","tuple","mode","shared","conditional","dependent","bag"],
            "additionalProperties":false
        });
        input[dictionary] = json!({
            "a/b":{"type":"integer","default":7},
            "options":{"$id":"options.json","type":"object","default":{},"properties":{"label":{"type":"string","default":"ready"}},"additionalProperties":false}
        });
        if modern {
            input[dictionary]["options"]["$anchor"] = json!("opts");
        }
        let mut tuple = json!({"type":"array","default":[]});
        tuple[if modern { "prefixItems" } else { "items" }] =
            json!([{"type":"string","default":"a"},{"type":"integer","default":2}]);
        tuple[if modern { "items" } else { "additionalItems" }] = json!(false);
        input["properties"]["tuple"] = tuple;
        input[if modern {
            "dependentSchemas"
        } else {
            "dependencies"
        }] = json!({"options":{"properties":{"mode":{"default":"on"},"dependent":{"default":"present"}}}});
        let mut action = spec();
        action.input_schema = serde_json::from_value(input).unwrap();
        action.output_schema=serde_json::from_value(json!({"type":"object","properties":{"params":{"type":"object"},"calls":{"type":"integer"}},"required":["params","calls"],"additionalProperties":false})).unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({params:call.params,calls:++calls}));return ()=>{};}").await;
        let original = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"note":null}),
        );
        let accepted = fixture.invoke(&fixture.client, original.clone()).await;
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "draft2020={modern}: {settled:?}"
        );
        let expected = json!({"value":7,"options":{"label":"ready"},"entries":[{"enabled":true},{"enabled":true}],"tuple":["a",2],"mode":"on","note":null,"shared":5,"conditional":"enabled","dependent":"present","bag":{"k_1":{"n":4}}});
        assert_eq!(
            fixture.result(&fixture.client, &settled).await,
            json!({"params":expected,"calls":1}),
            "draft2020={modern}"
        );
        let mut explicit = original;
        explicit.params = serde_json::from_value(expected).unwrap();
        assert_eq!(
            fixture.invoke(&fixture.client, explicit).await.operation_id,
            accepted.operation_id
        );
        let next=fixture.invoke(&fixture.client,fixture.call(&fixture.client,&fixture.target,"example.terminal.compute",json!({"note":"saved","mode":"off","value":0,"entries":[{"enabled":false}],"options":{"label":"manual"},"tuple":["b",3],"bag":{"k_2":{"n":9}}}))).await;
        let next = fixture.wait(&fixture.client, &next.operation_id).await;
        assert_eq!(
            fixture.result(&fixture.client, &next).await,
            json!({"params":{"note":"saved","mode":"off","value":0,"entries":[{"enabled":false}],"options":{"label":"manual"},"tuple":["b",3],"bag":{"k_2":{"n":9}},"shared":5,"conditional":"disabled","dependent":"present"},"calls":2}),
            "draft2020={modern}"
        );
        eprintln!(
            "native_public_action_scoped_defaults draft2020={modern} references=true conditional=enabled explicit_null_preserved=true"
        );
        fixture.finish().await;
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_defaults_bind_request_identity_and_survive_disable() {
    let mut action = spec();
    action.input_schema = serde_json::from_value(json!({
        "type":"object","properties":{"value":{"type":"integer","default":7}},
        "required":["value"],"additionalProperties":false
    }))
    .unwrap();
    let fixture = Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({value:call.params.value+0.25,calls:++calls}));return ()=>{};}").await;
    let QueryResult::ActionCheck(check) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "action.check",
            json!({"actionId":"example.terminal.compute","params":{}}),
        )
        .await
    else {
        panic!("Expected defaulted action preflight")
    };
    assert!(check.allowed);
    let original = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({}),
    );
    let accepted = fixture.invoke(&fixture.client, original.clone()).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"value":7.25,"calls":1})
    );
    let mut explicit = original.clone();
    explicit.params = serde_json::from_value(json!({"value":7})).unwrap();
    assert_eq!(
        fixture
            .invoke(&fixture.client, explicit.clone())
            .await
            .operation_id,
        accepted.operation_id
    );
    let disabled = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":false}),
            3,
        )
        .await;
    assert_eq!(disabled.state, OperationState::Succeeded, "{disabled:?}");
    assert_eq!(
        fixture
            .invoke(&fixture.client, explicit.clone())
            .await
            .operation_id,
        accepted.operation_id
    );
    assert_eq!(
        fixture.invoke(&fixture.client, original).await.operation_id,
        accepted.operation_id
    );
    explicit.params = serde_json::from_value(json!({"value":8})).unwrap();
    let RpcReply::Failure { error, .. } = fixture
        .client
        .request(RpcRequest::Invoke(explicit))
        .await
        .unwrap()
    else {
        panic!("A changed defaulted intent must conflict")
    };
    assert_eq!(error.code, "REQUEST_CONFLICT");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"value":7.25,"calls":1})
    );
    eprintln!(
        "native_public_action_defaults operation={} default_value=7 handler_calls=1 replay_after_disable=true",
        accepted.operation_id
    );
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_persists_owner_result_and_request_identity() {
    let fixture = Fixture::new().await;
    let QueryResult::Catalog(catalog) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "catalog.list",
            json!({"pageSize":"100"}),
        )
        .await
    else {
        panic!("Expected catalog")
    };
    assert!(
        catalog
            .items
            .iter()
            .any(|item| item.action_id.as_str() == "example.terminal.compute")
    );
    let QueryResult::ActionCheck(check) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "action.check",
            json!({"actionId":"example.terminal.compute","params":{"value":7}}),
        )
        .await
    else {
        panic!("Expected dynamic action preflight")
    };
    assert!(check.allowed);
    let call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":7}),
    );
    let accepted = fixture.invoke(&fixture.client, call.clone()).await;
    assert_eq!(accepted.owner.kind, OwnerKind::Plugin);
    assert_eq!(accepted.owner.id.as_str(), "example.terminal");
    assert_eq!(accepted.owner.version.as_deref(), Some("1.0.0"));
    assert_eq!(
        accepted.dependencies.as_ref().unwrap()[0].digest,
        fixture.archive
    );
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"value":7.25,"calls":1})
    );
    let replay = fixture.invoke(&fixture.client, call).await;
    assert_eq!(replay.operation_id, accepted.operation_id);
    let next = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":7}),
            ),
        )
        .await;
    let next = fixture.wait(&fixture.client, &next.operation_id).await;
    assert_eq!(
        fixture.result(&fixture.client, &next).await,
        json!({"value":7.25,"calls":2})
    );
    eprintln!(
        "native_public_action_receipt {}",
        json!({"operationId":accepted.operation_id,"owner":"example.terminal","version":"1.0.0","archiveSha256":fixture.archive,"decimalResult":7.25,"deduplicated":true})
    );
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dynamic_action_cancellation_waits_for_handler_cleanup() {
    let fixture = Fixture::program(
        spec(),
        br#"export function register(context) {
          let started=false, finished=false;
          context.actions.register('example.terminal.compute', async (call, task) => {
            if (call.params.value===0) return {value:Number(started),calls:Number(finished)};
            try {
              await new Promise((_,reject) => {
                task.signal.addEventListener('abort',()=>reject(task.signal.reason),{once:true});
                started=true;
              });
            } finally {
              await new Promise(resolve=>setTimeout(resolve,250));
              finished=true;
            }
          });
          return ()=>{};
        }"#,
    )
    .await;
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":7}),
            ),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = fixture
                .invoke(
                    &fixture.client,
                    fixture.call(
                        &fixture.client,
                        &fixture.target,
                        "example.terminal.compute",
                        json!({"value":0}),
                    ),
                )
                .await;
            let status = fixture.wait(&fixture.client, &status.operation_id).await;
            if fixture.result(&fixture.client, &status).await["value"] == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Actual handler did not start");
    let target = Target {
        kind: ResourceKind::try_from("operation").unwrap(),
        id: accepted.operation_id.clone(),
        ..fixture.target.clone()
    };
    let cancellation = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &target,
                "operation.cancel",
                json!({"reason":"user"}),
            ),
        )
        .await;
    let cancellation = fixture
        .wait(&fixture.client, &cancellation.operation_id)
        .await;
    if cancellation.state != OperationState::Succeeded {
        let _profile = fixture.finish().await;
        panic!("Public cancellation failed: {cancellation:?}");
    }
    assert_eq!(
        cancellation.state,
        OperationState::Succeeded,
        "{cancellation:?}"
    );
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Cancelled, "{settled:?}");
    assert_eq!(settled.error.as_ref().unwrap().code, "CANCELLED");
    let status = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":0}),
            ),
        )
        .await;
    let status = fixture.wait(&fixture.client, &status.operation_id).await;
    assert_eq!(
        fixture.result(&fixture.client, &status).await,
        json!({"value":1,"calls":1})
    );
    eprintln!(
        "native_public_action_cancellation operation={} cleanup_completed=true",
        accepted.operation_id
    );
    fixture.finish().await;
}
