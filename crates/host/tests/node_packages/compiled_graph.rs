//! 小引用指向大编译子图时，缓存额度覆盖被保留的可达图而非仅引用文本。
use super::*;

pub(super) fn cached_graph_input(contexts: usize, literal_bytes: usize) -> Value {
    let dependencies = (0..contexts)
        .map(|index| {
            (
                format!("p{index}"),
                json!({"if":{"$ref":"#/$defs/common"},"then":{"properties":{"value":{"default":7}}}}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$defs":{"common":{"type":"object","properties":{"unused":{"const":"x".repeat(literal_bytes)}}}},
        "type":"object","properties":{"value":{"type":"integer"}},
        "required":["value"],"additionalProperties":{"type":"boolean"},
        "dependentSchemas":dependencies
    })
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_schema_cache_charges_reachable_compiled_graphs() {
    for (contexts, literal_bytes, oversized) in [(32, 2_048, false), (64, 65_536, true)] {
        let mut action = spec();
        let input = cached_graph_input(contexts, literal_bytes);
        let input_bytes = serde_json::to_vec(&input).unwrap().len();
        action.input_schema = serde_json::from_value(input).unwrap();
        action.output_schema = serde_json::from_value(json!({
            "type":"object","properties":{"calls":{"type":"integer"}},
            "required":["calls"],"additionalProperties":false
        }))
        .unwrap();
        let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',()=>({calls:++calls}));return ()=>{};}").await;
        let mut accepted = 0;
        let mut rejected = None;
        for index in 0..contexts {
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
                panic!("Unexpected compiled-graph response: {reply:?}");
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
        eprintln!(
            "native_public_compiled_graph_cache_before_assert contexts={contexts} literal_bytes={literal_bytes} input_bytes={input_bytes} accepted={accepted} limit_rejected={}",
            rejected.is_some()
        );
        if oversized != rejected.is_some() || accepted == 0 {
            let _profile = fixture.finish().await;
            panic!(
                "Reachable compiled-graph cache boundary mismatch: contexts={contexts} literal_bytes={literal_bytes} accepted={accepted} limit_rejected={}",
                rejected.is_some()
            );
        }
        let mut retry = if let Some(call) = rejected {
            let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
                "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
            })))).await.unwrap();
            assert!(
                matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND"),
                "{lookup:?}"
            );
            call
        } else {
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({}),
            )
        };
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
            "native_public_compiled_graph_cache contexts={contexts} literal_bytes={literal_bytes} input_bytes={input_bytes} accepted={accepted} limit_rejected={oversized} zero_admission={oversized} warm_same_request_retry=true replay_preserved=true handler_calls={}",
            accepted + 1
        );
    }
}
