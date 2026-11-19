use super::*;
use crate::test_support::{
    self as support,
    node_host_actions::{Fixture, spec},
};
use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RevocationOrder {
    Before,
    During,
    After,
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_workspace_child_orders_commit_and_revocation() {
    for order in [
        RevocationOrder::Before,
        RevocationOrder::During,
        RevocationOrder::After,
    ] {
        let revoke_before_commit = order == RevocationOrder::Before;
        let mut action = spec();
        action.permissions = vec![
            "metadata.read".into(),
            "content.read".into(),
            "workspace.modify".into(),
        ];
        action
            .target_kinds
            .push(ResourceKind::try_from("workspace").unwrap());
        action.input_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
        action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
        let fixture=Fixture::program_with_client_permissions(action,br#"
        export function register(context) {
          context.actions.register('example.terminal.compute',async (call,task)=>({child:await task.actions.invokeChild({
            actionId:'workspace.save',target:call.params.target,params:{value:call.params.value},expectedRevision:'0'
          })}));return ()=>{};
        }
    "#,vec!["plugins.manage".into(),"content.read".into(),"workspace.modify".into()]).await;
        let target = Target {
            kind: ResourceKind::try_from("workspace").unwrap(),
            id: id("revoked-at-commit"),
            ..fixture.target.clone()
        };
        let QueryResult::Workspace(initial) = fixture
            .query(&fixture.client, &target, "workspace.read", json!({}))
            .await
        else {
            panic!("Expected workspace")
        };
        let original = initial.document.value;
        let mut value = original.clone();
        value.name = "Must not persist after revocation".into();
        let expected_saved = value.clone();
        let mut committing = match order {
            RevocationOrder::Before => fixture.host.inner.documents.before_commit.arm(),
            RevocationOrder::During => fixture.host.inner.auth.commit_ready.arm(),
            RevocationOrder::After => fixture.host.inner.documents.after_commit.arm(),
        };
        let parent = fixture
            .invoke(
                &fixture.client,
                fixture.call(
                    &fixture.client,
                    &fixture.target,
                    "example.terminal.compute",
                    json!({"target":target,"value":value}),
                ),
            )
            .await;
        committing.entered().await;
        let mut waiting = (order == RevocationOrder::During)
            .then(|| fixture.host.inner.auth.revocation_waiting.arm());
        let revoked = fixture
            .invoke(
                &fixture.user,
                fixture.call(
                    &fixture.user,
                    &fixture.target,
                    "auth.revoke",
                    json!({
                        "actorId":fixture.client.attachment().actor_id,
                        "permissions":["workspace.modify"],"targets":[target]
                    }),
                ),
            )
            .await;
        let mut observed_wait = false;
        let early_revoked = if let Some(waiting) = waiting.as_mut() {
            tokio::select! {
                () = waiting.entered() => {observed_wait = true; None},
                result = fixture.wait(&fixture.user, &revoked.operation_id) => Some(result),
            }
        } else {
            Some(fixture.wait(&fixture.user, &revoked.operation_id).await)
        };
        committing.release();
        if let Some(waiting) = waiting.as_mut() {
            waiting.release();
        }
        let revoked = match early_revoked {
            Some(result) => result,
            None => fixture.wait(&fixture.user, &revoked.operation_id).await,
        };
        assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
        let parent = fixture.wait(&fixture.client, &parent.operation_id).await;
        let QueryResult::Operation(child) = fixture
            .query(
                &fixture.client,
                &fixture.target,
                "operation.get",
                json!({"parentOperationId":parent.operation_id,"childKey":"1"}),
            )
            .await
        else {
            panic!("Expected child operation")
        };
        let QueryResult::Workspace(saved) = fixture
            .query(&fixture.client, &target, "workspace.read", json!({}))
            .await
        else {
            panic!("Expected workspace")
        };
        let profile = fixture.finish().await;
        if order == RevocationOrder::During {
            assert!(
                observed_wait,
                "Revocation completed while the authorized commit was paused: revision={} child={:?}",
                saved.document.revision, child.operation.state
            );
        }
        assert_eq!(parent.child_high_watermark, 1.into());
        if revoke_before_commit {
            assert_eq!(
                saved.document.revision,
                0.into(),
                "A revoked child persisted: {:?}",
                saved.document
            );
            assert_eq!(saved.document.value, original);
            assert_eq!(
                child.operation.state,
                OperationState::Failed,
                "{:?}",
                child.operation
            );
            assert!(child.operation.result.is_none());
            assert_eq!(
                child.operation.error.as_ref().unwrap().code,
                "PERMISSION_DENIED"
            );
        } else {
            assert_eq!(saved.document.revision, 1.into());
            assert_eq!(saved.document.value, expected_saved);
            assert_eq!(
                child.operation.state,
                OperationState::Succeeded,
                "{:?}",
                child.operation
            );
            assert!(child.operation.error.is_none());
            let Some(ActionResult::Workspace(receipt)) = &child.operation.result else {
                panic!("Expected persisted receipt")
            };
            assert_eq!(receipt.document, saved.document);
        }
        eprintln!(
            "native_task_commit_order order={order:?} revoke_before_commit={revoke_before_commit} revision={} child={:?} waited={observed_wait}",
            saved.document.revision, child.operation.state
        );
        drop(profile);
    }
}

#[tokio::test]
async fn settings_commit_orders_revocation_and_preserves_saved_receipt() {
    for order in [
        RevocationOrder::Before,
        RevocationOrder::During,
        RevocationOrder::After,
    ] {
        let revoke_before_commit = order == RevocationOrder::Before;
        let h = support::Harness::new().await;
        let operator = h
            .auth
            .authenticate_user_control(
                &id("settings-commit-operator"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let target = Target {
            host_id: h.host_id.clone(),
            kind: ResourceKind::try_from("settings").unwrap(),
            id: id("shared"),
            session_id: None,
            session_epoch: None,
        };
        h.auth
            .authorize(
                &operator,
                AuthorizeParams {
                    client_id: h.actor.client_id().clone(),
                    permissions: vec!["settings.modify".into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        let mut committing = match order {
            RevocationOrder::Before => h.host.inner.documents.before_commit.arm(),
            RevocationOrder::During => h.auth.commit_ready.arm(),
            RevocationOrder::After => h.host.inner.documents.after_commit.arm(),
        };
        let value = SharedSettings::default();
        let mut call = h.call(&target, "settings.save", json!({"value":value}));
        call.expected_revision = Some(0.into());
        let saving = h.invoke(call).await;
        committing.entered().await;
        let mut waiting =
            (order == RevocationOrder::During).then(|| h.auth.revocation_waiting.arm());
        let host_target = Target {
            host_id: h.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: h.host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let revoked = h
            .host
            .invoke(
                &operator,
                h.call_as(
                    &operator,
                    &host_target,
                    "auth.revoke",
                    json!({
                        "actorId":h.actor.id(),"permissions":["settings.modify"],"targets":[target]
                    }),
                ),
            )
            .await
            .unwrap();
        let mut observed_wait = false;
        let early_revoked = if let Some(waiting) = waiting.as_mut() {
            tokio::select! {
                () = waiting.entered() => {observed_wait = true; None},
                result = h.wait_as(&operator, &revoked.operation_id) => Some(result),
            }
        } else {
            Some(h.wait_as(&operator, &revoked.operation_id).await)
        };
        committing.release();
        if let Some(waiting) = waiting.as_mut() {
            waiting.release();
        }
        let revoked = match early_revoked {
            Some(result) => result,
            None => h.wait_as(&operator, &revoked.operation_id).await,
        };
        assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
        let settled = h.wait(&saving.operation_id).await;
        let QueryResult::Settings(saved) = h
            .host
            .query(
                &h.actor,
                call_query(&h.call(&target, "settings.read", json!({}))),
            )
            .await
            .unwrap()
        else {
            panic!("Expected settings")
        };
        h.host.shutdown().await.unwrap();
        if order == RevocationOrder::During {
            assert!(
                observed_wait,
                "Revocation completed while the authorized commit was paused: revision={} state={:?}",
                saved.document.revision, settled.state
            );
        }
        if revoke_before_commit {
            assert_eq!(saved.document.revision, 0.into());
            assert_eq!(settled.state, OperationState::Failed, "{settled:?}");
            assert_eq!(settled.error.as_ref().unwrap().code, "PERMISSION_DENIED");
            assert!(settled.result.is_none());
        } else {
            assert_eq!(saved.document.revision, 1.into());
            assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
            let Some(ActionResult::Settings(receipt)) = &settled.result else {
                panic!("Expected saved receipt")
            };
            assert_eq!(receipt.document, saved.document);
        }
        assert_eq!(saved.document.value, value);
        eprintln!(
            "settings_commit_order order={order:?} revoke_before_commit={revoke_before_commit} revision={} state={:?} waited={observed_wait}",
            saved.document.revision, settled.state
        );
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_operation_read_rechecks_revocation_and_stopping_before_delivery() {
    for disable in [false, true] {
        let mut action = spec();
        action.permissions = vec![
            "metadata.read".into(),
            "content.read".into(),
            "workspace.modify".into(),
        ];
        action
            .target_kinds
            .push(ResourceKind::try_from("workspace").unwrap());
        action.input_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
        action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
        let fixture = Fixture::program_with_client_permissions(
            action,
            br#"
            import {writeFileSync} from 'node:fs';
            export function register(context) {
              context.actions.register('example.terminal.compute',async (call,task)=>{
                try {
                  const receipt=await task.operations.get({operationId:call.params.operationId});
                  writeFileSync(call.params.marker,'delivered:'+receipt.operationId);
                  return {receipt};
                } catch(error) {
                  writeFileSync(call.params.marker,'denied:'+error.code);
                  throw error;
                }
              });return ()=>{};
            }
        "#,
            vec![
                "plugins.manage".into(),
                "content.read".into(),
                "workspace.modify".into(),
            ],
        )
        .await;
        let workspace = Target {
            kind: ResourceKind::try_from("workspace").unwrap(),
            id: id("late-read-workspace"),
            ..fixture.target.clone()
        };
        let QueryResult::Workspace(current) = fixture
            .query(&fixture.client, &workspace, "workspace.read", json!({}))
            .await
        else {
            panic!("Expected workspace")
        };
        let mut value = current.document.value;
        value.name = "Read only while current authority permits".into();
        let mut save = fixture.call(
            &fixture.client,
            &workspace,
            "workspace.save",
            json!({"value":value}),
        );
        save.expected_revision = Some(0.into());
        let saved = fixture.invoke(&fixture.client, save).await;
        let saved = fixture.wait(&fixture.client, &saved.operation_id).await;
        assert_eq!(saved.state, OperationState::Succeeded, "{saved:?}");
        let baseline_marker = fixture.dir.path().join("baseline-read.txt");
        let baseline = fixture.invoke(&fixture.client,fixture.call(
            &fixture.client,&fixture.target,"example.terminal.compute",
            json!({"operationId":saved.operation_id,"marker":baseline_marker.to_str().unwrap()})
        )).await;
        let baseline = fixture.wait(&fixture.client, &baseline.operation_id).await;
        assert_eq!(baseline.state, OperationState::Succeeded, "{baseline:?}");
        assert_eq!(
            std::fs::read_to_string(&baseline_marker).unwrap(),
            format!("delivered:{}", saved.operation_id)
        );
        let marker = fixture.dir.path().join("late-read.txt");
        let mut ready = fixture
            .host
            .inner
            .node_test_gates
            .task_operation_read_ready
            .arm();
        let parent = fixture
            .invoke(
                &fixture.client,
                fixture.call(
                    &fixture.client,
                    &fixture.target,
                    "example.terminal.compute",
                    json!({"operationId":saved.operation_id,"marker":marker.to_str().unwrap()}),
                ),
            )
            .await;
        ready.entered().await;
        let mut disposing = None;
        let mut disabled = None;
        if disable {
            let mut gate = fixture.host.inner.node_test_gates.before_dispose.arm();
            let mut call = fixture.call(
                &fixture.client,
                &fixture.target,
                "node.packages.setEnabled",
                json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":false}),
            );
            call.expected_revision = Some(3.into());
            disabled = Some(fixture.invoke(&fixture.client, call).await);
            gate.entered().await;
            disposing = Some(gate);
        } else {
            let revoked = fixture
                .invoke(
                    &fixture.user,
                    fixture.call(
                        &fixture.user,
                        &fixture.target,
                        "auth.revoke",
                        json!({
                            "actorId":fixture.client.attachment().actor_id,
                            "permissions":["metadata.read"],"targets":[workspace]
                        }),
                    ),
                )
                .await;
            let revoked = fixture.wait(&fixture.user, &revoked.operation_id).await;
            assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
        }
        ready.release();
        let parent = fixture.wait(&fixture.client, &parent.operation_id).await;
        if let Some(gate) = disposing.as_mut() {
            gate.release();
        }
        if let Some(disabled) = disabled {
            let disabled = fixture.wait(&fixture.client, &disabled.operation_id).await;
            assert_eq!(disabled.state, OperationState::Succeeded, "{disabled:?}");
        }
        let observed = std::fs::read_to_string(&marker);
        let profile = fixture.finish().await;
        assert_eq!(parent.state, OperationState::Interrupted, "{parent:?}");
        assert_eq!(parent.child_high_watermark, 0.into());
        let observed = observed.unwrap();
        let expected = if disable {
            "CATALOG_CHANGED"
        } else {
            "PERMISSION_DENIED"
        };
        assert_eq!(observed, format!("denied:{expected}"), "disable={disable}");
        assert_eq!(parent.error.as_ref().unwrap().code, expected);
        eprintln!(
            "native_task_read_late_delivery disable={disable} observed={observed} parent={:?} error={:?}",
            parent.state,
            parent.error.as_ref().map(|error| &error.code)
        );
        drop(profile);
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_sdk_unconfirmed_admission_retries_the_same_child_without_reexecution() {
    let mut action = spec();
    action.permissions = vec!["metadata.read".into(), "content.read".into()];
    action.input_schema=serde_json::from_value(json!({"type":"object","properties":{"value":{"type":"integer","default":0}},"required":["value"],"additionalProperties":false})).unwrap();
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture=Fixture::program(action,br#"
        export function register(context) {
          let effects=0;
          context.actions.register('example.terminal.compute',async (call,task)=>{
            if(call.params.value===0) return {effects:++effects};
            const child=params=>task.actions.invokeChild({actionId:call.actionId,target:call.target,params});
            let first,failed,changed;
            try {first=await child({});}
            catch(error) {
              failed=error.code;
              try {await child({value:0});} catch(error) {changed=error.code;}
              first=await child({});
            }
            const second=await child({value:0});
            return {first,second,failed,changed};
          });return ()=>{};
        }
    "#).await;
    fixture
        .host
        .inner
        .node_test_gates
        .fail_child_receipt_once
        .store(true, std::sync::atomic::Ordering::Release);
    let parent = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":9}),
            ),
        )
        .await;
    let parent = fixture.wait(&fixture.client, &parent.operation_id).await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let children = if let Some(result) = &result {
        let first: Operation = serde_json::from_value(result["first"].clone()).unwrap();
        let second: Operation = serde_json::from_value(result["second"].clone()).unwrap();
        let first = fixture.wait(&fixture.client, &first.operation_id).await;
        let second = fixture.wait(&fixture.client, &second.operation_id).await;
        let first_result = fixture.result(&fixture.client, &first).await;
        let second_result = fixture.result(&fixture.client, &second).await;
        Some((first, second, first_result, second_result))
    } else {
        None
    };
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    assert_eq!(parent.child_high_watermark, 2.into());
    let result = result.unwrap();
    assert_eq!(result["failed"], "HOST_BUSY");
    assert_eq!(result["changed"], "REQUEST_CONFLICT");
    let (first, second, first_result, second_result) = children.unwrap();
    assert_ne!(first.operation_id, second.operation_id);
    assert!(matches!(first.admission,Admission::Child {child_key,..} if child_key.get()==1));
    assert!(matches!(second.admission,Admission::Child {child_key,..} if child_key.get()==2));
    assert_eq!(first_result, json!({"effects":1}));
    assert_eq!(second_result, json!({"effects":2}));
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_registry_copy_pressure_rejects_before_admission_and_recovers() {
    let mut action = spec();
    action.input_schema = serde_json::from_value(support::node_host_actions::registry_copy_input(
        64, 131_072, 1,
    ))
    .unwrap();
    let fixture = Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({value:call.params.value+0.25,calls:++calls}));return ()=>{};}").await;
    let mut gates = Vec::new();
    let mut workers = Vec::new();
    for _ in 0..7 {
        let connection = fixture.client.reconnect().await.unwrap();
        let call = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"trigger":true}),
        );
        let mut gate = crate::node_test_gates::registry_copy_compiler_ready().arm();
        workers.push(tokio::spawn(async move {
            connection.request(RpcRequest::Invoke(call)).await
        }));
        gate.entered().await;
        gates.push(gate);
    }
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
    for gate in &mut gates {
        gate.release();
    }
    for worker in workers {
        let held = worker.await.unwrap().unwrap();
        assert!(
            matches!(&held,RpcReply::Failure {error,..} if error.code=="LIMIT_EXCEEDED"),
            "{held:?}"
        );
    }
    let RpcReply::Failure { error, .. } = reply else {
        let _profile = fixture.finish().await;
        panic!("Expected global registry copy pressure: {reply:?}");
    };
    assert_eq!(error.code, "HOST_BUSY");
    assert!(error.retryable, "{error:?}");
    assert!(
        matches!(error.details.as_ref().and_then(|value| value.get("reason")),Some(serial_workbench_core::JsonValue::String(reason)) if reason=="backendSchemaRegistryCopyCapacity"),
        "{error:?}"
    );
    let lookup = fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client,&fixture.target,"operation.get",json!({
        "actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context
    })))).await.unwrap();
    assert!(
        matches!(&lookup,RpcReply::Failure {error,..} if error.code=="NOT_FOUND"),
        "{lookup:?}"
    );
    call.params = serde_json::from_value(json!({"value":9})).unwrap();
    let recovered = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &recovered.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let observed = fixture.result(&fixture.client, &settled).await;
    let _profile = fixture.finish().await;
    assert_eq!(observed, json!({"value":9.25,"calls":1}));
    eprintln!(
        "native_public_registry_copy_pressure held_builds=7 copy_capacity_busy=true retryable=true zero_admission=true resumed_limits_preserved=true subsequent_call_usable=true handler_calls=1"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_action_prepare_race_replays_saved_schema_after_disable() {
    let mut action = spec();
    action.input_schema=serde_json::from_value(json!({"type":"object","properties":{"value":{"type":"integer","default":7}},"required":["value"],"additionalProperties":false})).unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({value:call.params.value+0.25,calls:++calls}));return ()=>{};}").await;
    let connection = fixture.client.reconnect().await.unwrap();
    let call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({}),
    );
    let mut gate = fixture
        .host
        .inner
        .node_test_gates
        .action_lookup_missing
        .arm();
    let first = {
        let call = call.clone();
        tokio::spawn(async move { connection.request(RpcRequest::Invoke(call)).await })
    };
    gate.entered().await;
    let accepted = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"value":7.25,"calls":1})
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
    gate.release();
    let reply = first.await.unwrap().unwrap();
    let _profile = fixture.finish().await;
    let RpcReply::Success { result, .. } = reply else {
        panic!("Prepared retry did not recover the saved operation: {reply:?}")
    };
    let RpcResult::Operation(result) = *result else {
        panic!("Expected persistent operation")
    };
    assert_eq!(result.operation.operation_id, accepted.operation_id);
    eprintln!(
        "native_public_action_prepare_race saved_schema_replayed=true handler_calls=1 disabled=true"
    );
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_concurrent_action_replay_requires_current_result_read_permission() {
    let mut action = spec();
    action.permissions = vec!["device.modify".into()];
    let fixture = Fixture::program(action, b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({value:call.params.value+0.25,calls:++calls}));return ()=>{};}").await;
    let limited = Arc::new(
        HostClient::connect(ConnectOptions::new(
            fixture.dir.path().to_path_buf(),
            support::id("action-limited"),
            ClientKind::Cli,
        ))
        .await
        .unwrap(),
    );
    let grant = fixture.invoke(&fixture.user,fixture.call(
        &fixture.user,&fixture.target,"auth.authorize",
        json!({"clientId":limited.attachment().client_id,"permissions":["device.modify"],"targets":[fixture.target]}),
    )).await;
    let grant = fixture.wait(&fixture.user, &grant.operation_id).await;
    assert_eq!(grant.state, OperationState::Succeeded, "{grant:?}");
    let call = fixture.call(
        &limited,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":7}),
    );
    let replay_connection = limited.reconnect().await.unwrap();
    let mut gate = fixture
        .host
        .inner
        .node_test_gates
        .action_before_accept
        .arm();
    let first = {
        let client = limited.clone();
        let call = call.clone();
        tokio::spawn(async move { client.request(RpcRequest::Invoke(call)).await })
    };
    gate.entered().await;
    let second = fixture.invoke(&replay_connection, call).await;
    let settled = fixture.wait(&fixture.client, &second.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"value":7.25,"calls":1})
    );
    gate.release();
    let reply = first.await.unwrap().unwrap();
    let _profile = fixture.finish().await;
    let RpcReply::Failure { error, .. } = reply else {
        panic!("Concurrent replay exposed an unreadable result: {reply:?}")
    };
    assert_eq!(error.code, "PERMISSION_DENIED");
    assert!(error.details.is_none());
    eprintln!("native_public_action_concurrent_replay result_read_denied=true handler_calls=1");
}
