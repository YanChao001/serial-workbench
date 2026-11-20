//! 独立正式包owner共同占用编译图额度，管理停止后实际释放并恢复启用和调用。
use super::*;

const SOURCE: &[u8] = b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({value:call.params.value+0.25,calls:++calls}));return ()=>{};}";

fn resident_graph(contexts: usize, literal_bytes: usize) -> Value {
    let branches = (0..contexts)
        .map(|index| json!({"$id":format!("?v={index}"),"$ref":"?root#/$defs/common"}))
        .collect::<Vec<_>>();
    json!({
        "$schema":"https://json-schema.org/draft/2020-12/schema",
        "$id":"https://resident-graph.example.invalid/schema?root",
        "$defs":{"common":{"type":"object","properties":{"unused":{"const":"x".repeat(literal_bytes)}}}},
        "allOf":branches,"type":"object","properties":{"value":{"type":"integer"}},
        "required":["value"],"additionalProperties":false
    })
}

async fn set_enabled(fixture: &Fixture, enabled: bool) -> Operation {
    let QueryResult::NodePackages(snapshot) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.list",
            json!({}),
        )
        .await
    else {
        panic!("Expected installed package snapshot");
    };
    fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":enabled}),
            snapshot.revision.get(),
        )
        .await
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_initial_graph_capacity_is_held_until_owners_stop() {
    let contexts = 256;
    let literal_bytes = 49_152;
    let input = resident_graph(contexts, literal_bytes);
    let input_bytes = serde_json::to_vec(&input).unwrap().len();
    let mut action = spec();
    action.input_schema = serde_json::from_value(input).unwrap();
    let mut owners = Vec::new();
    let mut blocked = None;
    for _ in 0..8 {
        let fixture = Fixture::installed_program(action.clone(), SOURCE).await;
        let enabled = set_enabled(&fixture, true).await;
        let QueryResult::NodePackageRuntime(status) = fixture
            .query(
                &fixture.client,
                &fixture.target,
                "node.packages.runtime",
                json!({"id":"example.terminal"}),
            )
            .await
        else {
            panic!("Expected runtime status");
        };
        eprintln!(
            "native_public_initial_graph_owner contexts={contexts} literal_bytes={literal_bytes} input_bytes={input_bytes} active_before={} enable_state={:?} runtime_phase={:?} error={:?}",
            owners.len(),
            enabled.state,
            status.phase,
            enabled.error
        );
        if enabled.state == OperationState::Failed {
            let error = enabled
                .error
                .as_ref()
                .expect("Capacity failure must explain itself");
            assert_eq!(error.code, "HOST_BUSY", "{enabled:?}");
            assert!(error.retryable, "{enabled:?}");
            assert_eq!(status.phase, NodePackageRuntimePhase::Failed, "{status:?}");
            blocked = Some(fixture);
            break;
        }
        assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
        assert_eq!(status.phase, NodePackageRuntimePhase::Active, "{status:?}");
        owners.push(fixture);
    }
    let Some(blocked) = blocked else {
        let mut profiles = Vec::new();
        let admitted = owners.len();
        for owner in owners {
            profiles.push(owner.finish().await);
        }
        panic!(
            "Initial compiled graphs had no shared resident capacity: admitted={admitted} contexts={contexts} literal_bytes={literal_bytes} input_bytes={input_bytes}"
        );
    };
    assert!(
        owners.len() >= 2,
        "Small independent owners must be admitted before global pressure"
    );
    let retry = blocked.call(
        &blocked.client,
        &blocked.target,
        "example.terminal.compute",
        json!({"value":9}),
    );
    let refused = blocked
        .client
        .request(RpcRequest::Invoke(retry.clone()))
        .await
        .unwrap();
    assert!(
        matches!(refused, RpcReply::Failure { .. }),
        "Inactive package admitted a business call: {refused:?}"
    );
    let lookup=blocked.client.request(RpcRequest::Query(blocked.query_call(&blocked.client,&blocked.target,"operation.get",json!({"actorId":retry.actor_id,"requestId":retry.request_id,"requestContext":retry.request_context})))).await.unwrap();
    assert!(
        matches!(&lookup,RpcReply::Failure{error,..} if error.code=="NOT_FOUND"),
        "{lookup:?}"
    );
    let held = owners.len();
    // 释放两份实际owner，为重新启用及随后请求的临时规范化各留出一份工作空间。
    for owner in owners.iter().take(2) {
        let stopped = set_enabled(owner, false).await;
        assert_eq!(stopped.state, OperationState::Succeeded, "{stopped:?}");
    }
    let recovered = set_enabled(&blocked, true).await;
    assert_eq!(recovered.state, OperationState::Succeeded, "{recovered:?}");
    let accepted = blocked.invoke(&blocked.client, retry.clone()).await;
    let settled = blocked.wait(&blocked.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = blocked.result(&blocked.client, &settled).await;
    let replay = blocked.invoke(&blocked.client, retry).await;
    let mut profiles = vec![blocked.finish().await];
    for owner in owners {
        profiles.push(owner.finish().await);
    }
    assert_eq!(observed, json!({"value":9.25,"calls":1}));
    assert_eq!(replay.operation_id, accepted.operation_id);
    eprintln!(
        "native_public_initial_graph_capacity contexts={contexts} literal_bytes={literal_bytes} input_bytes={input_bytes} held_owners={held} retryable_busy=true business_zero_admission=true stopped_owners=2 enabled_after_release=true same_business_request_retry=true replay_preserved=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_generated_graph_cache_shares_capacity_with_resident_owners() {
    let mut heavy = spec();
    heavy.input_schema = serde_json::from_value(resident_graph(256, 49_152)).unwrap();
    let mut owners = Vec::new();
    for _ in 0..5 {
        owners.push(Fixture::program(heavy.clone(), SOURCE).await);
    }
    let mut action = spec();
    let input = super::compiled_graph::cached_graph_input(64, 65_536);
    let input_bytes = serde_json::to_vec(&input).unwrap().len();
    action.input_schema = serde_json::from_value(input).unwrap();
    let fixture = Fixture::program(action, SOURCE).await;
    let mut accepted = 0;
    let mut blocked = None;
    let mut first_call = None;
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
        if let RpcReply::Failure { error, .. } = &reply {
            eprintln!(
                "native_public_global_cache_pressure held_owners=5 input_bytes={input_bytes} accepted={accepted} error={error:?}"
            );
            assert_eq!(
                error.code, "HOST_BUSY",
                "Unexpected local/structural limit before global pressure: {reply:?}"
            );
            assert!(error.retryable, "{reply:?}");
            blocked = Some(call);
            break;
        }
        let RpcReply::Success { result, .. } = reply else {
            unreachable!()
        };
        let RpcResult::Operation(result) = *result else {
            panic!("Expected operation")
        };
        if first_call.is_none() {
            first_call = Some((call.clone(), result.operation.operation_id.clone()));
        }
        let settled = fixture
            .wait(&fixture.client, &result.operation.operation_id)
            .await;
        assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
        accepted += 1;
        assert_eq!(
            fixture.result(&fixture.client, &settled).await,
            json!({"value":9.25,"calls":accepted})
        );
    }
    let Some(retry) = blocked else {
        let mut profiles = vec![fixture.finish().await];
        for owner in owners {
            profiles.push(owner.finish().await);
        }
        panic!("Generated graph caches escaped resident capacity: admitted={accepted}");
    };
    assert!(
        accepted > 0,
        "Small generated graphs must remain usable before global saturation"
    );
    let lookup=fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({"actorId":retry.actor_id,"requestId":retry.request_id,"requestContext":retry.request_context})))).await.unwrap();
    assert!(
        matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND"),
        "{lookup:?}"
    );
    let (first_call, first_operation) = first_call.unwrap();
    let replay_under_pressure = fixture
        .client
        .request(RpcRequest::Invoke(first_call))
        .await
        .unwrap();
    eprintln!(
        "native_public_global_cache_replay_before_assert accepted={accepted} reply={replay_under_pressure:?}"
    );
    let RpcReply::Success { result, .. } = replay_under_pressure else {
        let mut profiles = vec![fixture.finish().await];
        for owner in owners {
            profiles.push(owner.finish().await);
        }
        panic!(
            "Retained normalized request could not replay under graph pressure: {replay_under_pressure:?}"
        );
    };
    let RpcResult::Operation(replayed) = *result else {
        panic!("Expected retained operation")
    };
    assert_eq!(replayed.operation.operation_id, first_operation);
    assert_eq!(
        fixture.result(&fixture.client, &replayed.operation).await,
        json!({"value":9.25,"calls":1})
    );
    let stopped = set_enabled(&owners[0], false).await;
    assert_eq!(stopped.state, OperationState::Succeeded, "{stopped:?}");
    let recovered = fixture.invoke(&fixture.client, retry.clone()).await;
    let settled = fixture.wait(&fixture.client, &recovered.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let replay = fixture.invoke(&fixture.client, retry).await;
    let warm = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":9,"p0":true}),
            ),
        )
        .await;
    let warm = fixture.wait(&fixture.client, &warm.operation_id).await;
    let warm_result = fixture.result(&fixture.client, &warm).await;
    let mut profiles = vec![fixture.finish().await];
    for owner in owners {
        profiles.push(owner.finish().await);
    }
    assert_eq!(replay.operation_id, recovered.operation_id);
    assert_eq!(observed, json!({"value":9.25,"calls":accepted+1}));
    assert_eq!(warm_result, json!({"value":9.25,"calls":accepted+2}));
    eprintln!(
        "native_public_global_cache_capacity held_owners=5 input_bytes={input_bytes} accepted={accepted} retryable_busy=true zero_admission=true stopped_owners=1 same_request_retry=true replay_preserved=true warm_usable=true handler_calls={}",
        accepted + 2
    );
}
