use super::*;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_sdk_reads_child_receipts_with_original_authority() {
    let mut action = spec();
    action.permissions = vec![
        "metadata.read".into(),
        "content.read".into(),
        "workspace.modify".into(),
    ];
    action
        .target_kinds
        .push(ResourceKind::try_from("workspace").unwrap());
    action.input_schema=serde_json::from_value(json!({"type":"object","properties":{"target":{"type":"object"},"value":{"type":"object"}},"required":["target","value"],"additionalProperties":false})).unwrap();
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture=Fixture::program_with_client_permissions(action,br#"
        export function register(context) {
          context.actions.register('example.terminal.compute',async (call,task)=>{
            let malformed;
            try {await task.operations.get({operationId:123});} catch(error){malformed=error.code;}
            const child=await task.actions.invokeChild({actionId:'workspace.save',target:call.params.target,params:{value:call.params.value},expectedRevision:'0'});
            let receipt=await task.operations.get({parentOperationId:child.admission.parentOperationId,childKey:child.admission.childKey});
            while(['queued','running','cancel_requested'].includes(receipt.state)) {
              await new Promise(resolve=>setTimeout(resolve,10));
              receipt=await task.operations.get({operationId:child.operationId});
            }
            return {malformed,childId:child.operationId,queriedId:receipt.operationId,state:receipt.state,
              resultKind:receipt.result.kind,revision:receipt.result.value.document.revision,
              name:receipt.result.value.document.value.name};
          });return ()=>{};
        }
    "#,vec!["plugins.manage".into(),"content.read".into(),"device.modify".into(),"workspace.modify".into()]).await;
    let target = Target {
        kind: ResourceKind::try_from("workspace").unwrap(),
        id: Id::try_from("sdk-receipt-workspace").unwrap(),
        ..fixture.target.clone()
    };
    let QueryResult::Workspace(current) = fixture
        .query(&fixture.client, &target, "workspace.read", json!({}))
        .await
    else {
        panic!("Expected workspace")
    };
    let mut value = current.document.value;
    value.name = "Saved before SDK receipt".into();
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
    let parent = fixture.wait(&fixture.client, &parent.operation_id).await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    assert_eq!(parent.child_high_watermark, 1.into());
    let result = result.unwrap();
    assert_eq!(result["malformed"], "INVALID_ARGUMENT");
    assert_eq!(result["childId"], result["queriedId"]);
    assert_eq!(result["state"], "succeeded");
    assert_eq!(result["resultKind"], "workspace");
    assert_eq!(result["revision"], "1");
    assert_eq!(result["name"], "Saved before SDK receipt");
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_sdk_reuses_an_unconsumed_child_key_after_rejection() {
    let mut action = spec();
    action.permissions = vec!["metadata.read".into(), "content.read".into()];
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture=Fixture::program(action,br#"
        export function register(context) {
          let calls=0;
          context.actions.register('example.terminal.compute',async (call,task)=>{
            if(call.params.value===0) return {calls:++calls};
            let rejected;
            try {await task.actions.invokeChild({actionId:'node.packages.setEnabled',target:call.target,params:{}});}
            catch(error){rejected=error.code;}
            const child=await task.actions.invokeChild({actionId:call.actionId,target:call.target,params:{value:0}});
            return {rejected,child};
          });return ()=>{};
        }
    "#).await;
    let accepted = fixture
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
    let parent = fixture.wait(&fixture.client, &accepted.operation_id).await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let child = if let Some(result) = &result {
        let child: Operation = serde_json::from_value(result["child"].clone()).unwrap();
        let settled = fixture.wait(&fixture.client, &child.operation_id).await;
        Some((
            settled.clone(),
            fixture.result(&fixture.client, &settled).await,
        ))
    } else {
        None
    };
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    assert_eq!(parent.child_high_watermark, 1.into());
    assert_eq!(result.unwrap()["rejected"], "PERMISSION_DENIED");
    let (child, result) = child.unwrap();
    assert!(
        matches!(&child.admission,Admission::Child {parent_operation_id,child_key,..} if parent_operation_id==&parent.operation_id && child_key.get()==1)
    );
    assert_eq!(result, json!({"calls":1}));
    drop(profile);
}
