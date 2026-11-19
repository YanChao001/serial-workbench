use super::*;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_child_commits_a_rust_workspace_action_with_cas() {
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
          context.actions.register('example.terminal.compute',async (call,task)=>({child:await task.actions.invokeChild({
            actionId:'workspace.save',target:call.params.target,params:{value:call.params.value},expectedRevision:'0'
          })}));return ()=>{};
        }
    "#,vec!["plugins.manage".into(),"content.read".into(),"device.modify".into(),"workspace.modify".into()]).await;
    let target = Target {
        kind: ResourceKind::try_from("workspace").unwrap(),
        id: Id::try_from("child-workspace").unwrap(),
        ..fixture.target.clone()
    };
    let QueryResult::Workspace(current) = fixture
        .query(&fixture.client, &target, "workspace.read", json!({}))
        .await
    else {
        panic!("Expected workspace")
    };
    assert_eq!(current.document.revision, 0.into());
    let mut value = current.document.value;
    value.name = "Saved by plugin child".into();
    let call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"target":target,"value":value}),
    );
    let parent = fixture.invoke(&fixture.client, call.clone()).await;
    let parent = fixture.wait(&fixture.client, &parent.operation_id).await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let child = if let Some(result) = &result {
        let accepted: Operation = serde_json::from_value(result["child"].clone()).unwrap();
        Some(fixture.wait(&fixture.client, &accepted.operation_id).await)
    } else {
        None
    };
    let replay = fixture.invoke(&fixture.client, call).await;
    let QueryResult::Workspace(saved) = fixture
        .query(&fixture.client, &target, "workspace.read", json!({}))
        .await
    else {
        panic!("Expected workspace")
    };
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    let child = child.unwrap();
    assert_eq!(child.state, OperationState::Succeeded, "{child:?}");
    assert_eq!(child.owner.kind, OwnerKind::Host);
    assert_eq!(child.actor_id, parent.actor_id);
    assert_eq!(child.root_operation_id, parent.operation_id);
    assert_eq!(saved.document.revision, 1.into());
    assert_eq!(saved.document.value.name, "Saved by plugin child");
    assert_eq!(replay.operation_id, parent.operation_id);
    assert_eq!(parent.child_high_watermark, 1.into());
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_child_preserves_operator_metadata_without_control_delegation() {
    let mut action = spec();
    action.permissions = vec!["metadata.read".into()];
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture=Fixture::program(action,br#"
        export function register(context) {
          context.actions.register('example.terminal.compute',async (call,task)=>{
            if(call.params.value===0) return {value:0.25};
            const child=await task.actions.invokeChild({actionId:call.actionId,target:call.target,params:{value:0}});
            let controlRejected;
            try {await task.actions.invokeChild({actionId:'file.register',target:call.target,params:{path:'unused',purpose:'read_file'}});}
            catch(error){controlRejected=error.code;}
            return {child,controlRejected};
          });return ()=>{};
        }
    "#).await;
    let accepted = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":9}),
            ),
        )
        .await;
    let parent = fixture.wait(&fixture.client, &accepted.operation_id).await;
    let observed = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    let observed = observed.unwrap();
    assert_eq!(observed["controlRejected"], "PERMISSION_DENIED");
    let child: Operation = serde_json::from_value(observed["child"].clone()).unwrap();
    assert_eq!(child.actor_id, parent.actor_id);
    assert_eq!(child.root_operation_id, parent.operation_id);
    assert_eq!(parent.child_high_watermark, 1.into());
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_child_cancellation_waits_for_cleanup_and_closes_late_admission()
{
    let mut action = spec();
    action.permissions = vec!["metadata.read".into(), "content.read".into()];
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = Fixture::program(
        action,
        br#"
        export function register(context) {
          let started=0,finished=0,late;
          context.actions.register('example.terminal.compute',async (call,task)=>{
            if(call.params.value===0) {
              started++;
              try {
                await new Promise(resolve=>{
                  if(task.signal.aborted) resolve();
                  else task.signal.addEventListener('abort',resolve,{once:true});
                });
                task.signal.throwIfAborted();
              } finally {finished++;}
            }
            if(call.params.value===-1) {
              let lateCode;
              try {await late({actionId:call.actionId,target:call.target,params:{value:0}});}
              catch(error){lateCode=error.code;}
              return {started,finished,lateCode};
            }
            late=task.actions.invokeChild;
            return {child:await late({actionId:call.actionId,target:call.target,params:{value:0}})};
          });return ()=>{};
        }
    "#,
    )
    .await;
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
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let probe = fixture
                .invoke(
                    &fixture.client,
                    fixture.call(
                        &fixture.client,
                        &fixture.target,
                        "example.terminal.compute",
                        json!({"value":-1}),
                    ),
                )
                .await;
            let probe = fixture.wait(&fixture.client, &probe.operation_id).await;
            let result = fixture.result(&fixture.client, &probe).await;
            if result["started"] == 1 {
                assert_eq!(result["lateCode"], "OPERATION_NOT_RUNNING");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Child handler did not start");
    let QueryResult::Operation(pending) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "operation.get",
            json!({"operationId":parent.operation_id}),
        )
        .await
    else {
        panic!("Expected parent")
    };
    assert_eq!(pending.operation.state, OperationState::Running);
    let QueryResult::Operation(child) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "operation.get",
            json!({"parentOperationId":parent.operation_id,"childKey":"1"}),
        )
        .await
    else {
        panic!("Expected child")
    };
    let target = Target {
        kind: ResourceKind::try_from("operation").unwrap(),
        id: parent.operation_id.clone(),
        ..fixture.target.clone()
    };
    let cancel = fixture
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
    let cancel = fixture.wait(&fixture.client, &cancel.operation_id).await;
    let parent = fixture.wait(&fixture.client, &parent.operation_id).await;
    let child = fixture
        .wait(&fixture.client, &child.operation.operation_id)
        .await;
    let probe = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":-1}),
            ),
        )
        .await;
    let probe = fixture.wait(&fixture.client, &probe.operation_id).await;
    let result = fixture.result(&fixture.client, &probe).await;
    let profile = fixture.finish().await;
    assert_eq!(cancel.state, OperationState::Succeeded);
    assert_eq!(child.state, OperationState::Cancelled, "{child:?}");
    assert!(parent.state.is_terminal());
    assert!(parent.settled_at >= child.settled_at);
    assert_eq!(parent.child_high_watermark, 1.into());
    assert_eq!(
        result,
        json!({"started":1,"finished":1,"lateCode":"OPERATION_NOT_RUNNING"})
    );
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_child_sdk_bounds_queued_count_and_bytes_before_admission() {
    let mut action = spec();
    action.permissions = vec!["metadata.read".into(), "content.read".into()];
    action.input_schema=serde_json::from_value(json!({"type":"object","properties":{"value":{"type":"integer"},"padding":{"type":"string"}},"required":["value"],"additionalProperties":false})).unwrap();
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture=Fixture::program(action,br#"
        export function register(context) {
          context.actions.register('example.terminal.compute',async (call,task)=>{
            if(call.params.value===0) return {length:call.params.padding?.length??0};
            const submit=params=>task.actions.invokeChild({actionId:call.actionId,target:call.target,params});
            const count=await Promise.allSettled(Array.from({length:16},()=>submit({value:0})));
            const bytes=await Promise.allSettled(Array.from({length:3},()=>submit({value:0,padding:'x'.repeat(700000)})));
            const summarize=items=>({accepted:items.filter(i=>i.status==='fulfilled').length,errors:items.filter(i=>i.status==='rejected').map(i=>i.reason.code)});
            return {count:summarize(count),bytes:summarize(bytes)};
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
    // 两轮排队压力合计接纳10个子动作；独立总等待预算不改变普通单动作五秒门槛。
    let parent = fixture
        .wait_with_budget(
            &fixture.client,
            &accepted.operation_id,
            Duration::from_secs(15),
        )
        .await;
    let observed = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    assert_eq!(parent.child_high_watermark, 10.into());
    assert_eq!(
        observed,
        Some(
            json!({"count":{"accepted":8,"errors":vec!["HOST_BUSY";8]},"bytes":{"accepted":2,"errors":["HOST_BUSY"]}})
        )
    );
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_child_routes_through_signed_owner_and_retains_lineage() {
    let mut action = spec();
    action.permissions = vec!["metadata.read".into(), "content.read".into()];
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = Fixture::program(
        action,
        br#"
        export function register(context) {
          let calls = 0;
          context.actions.register('example.terminal.compute', async (call, task) => {
            calls++;
            if (call.params.value === 0) return {value:0.25,calls,requestId:call.requestId};
            const child = await task.actions.invokeChild({
              actionId:call.actionId,target:call.target,params:{value:0}
            });
            let scopeRejected;
            try {await task.actions.invokeChild({actionId:'node.packages.setEnabled',target:call.target,params:{}});}
            catch(error){scopeRejected=error.code;}
            return {child,scopeRejected};
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
        json!({"value":9}),
    );
    let parent = fixture.invoke(&fixture.client, call.clone()).await;
    let parent = fixture.wait(&fixture.client, &parent.operation_id).await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let child = if let Some(value) = &result {
        let accepted: Operation = serde_json::from_value(value["child"].clone()).unwrap();
        let child = fixture.wait(&fixture.client, &accepted.operation_id).await;
        let child_result = fixture.result(&fixture.client, &child).await;
        Some((child, child_result))
    } else {
        None
    };
    let replay = fixture.invoke(&fixture.client, call).await;
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    assert_eq!(parent.child_high_watermark, 1.into());
    assert_eq!(result.unwrap()["scopeRejected"], "PERMISSION_DENIED");
    assert_eq!(replay.operation_id, parent.operation_id);
    let (child, result) = child.unwrap();
    assert_eq!(child.state, OperationState::Succeeded, "{child:?}");
    assert_eq!(child.actor_id, parent.actor_id);
    assert_eq!(child.root_operation_id, parent.operation_id);
    assert_eq!(child.execution_mode, parent.execution_mode);
    assert_ne!(child.operation_id, parent.operation_id);
    assert_ne!(child.request_id, parent.request_id);
    assert!(
        matches!(&child.admission, Admission::Child {parent_operation_id,child_key,..}
        if parent_operation_id==&parent.operation_id && child_key.get()==1)
    );
    assert_eq!(child.owner, parent.owner);
    assert_eq!(child.dependencies, parent.dependencies);
    assert_eq!(
        result,
        json!({"value":0.25,"calls":2,"requestId":child.request_id})
    );
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_context_metadata_preserves_a_near_limit_public_call() {
    let mut action = spec();
    action.input_schema=serde_json::from_value(json!({"type":"object","properties":{"padding":{"type":"string"}},"required":["padding"],"additionalProperties":false})).unwrap();
    action.output_schema=serde_json::from_value(json!({"type":"object","properties":{"length":{"type":"integer"},"calls":{"type":"integer"}},"required":["length","calls"],"additionalProperties":false})).unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',call=>({length:call.params.padding.length,calls:++calls}));return ()=>{};}").await;
    let mut call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"padding":""}),
    );
    let maximum = serial_workbench_ipc::frame::MAX_FRAME_BYTES;
    let padding = maximum - 160 - serde_json::to_vec(&call).unwrap().len();
    call.params = serde_json::from_value(json!({"padding":"x".repeat(padding)})).unwrap();
    let call_bytes = serde_json::to_vec(&call).unwrap().len();
    let frame = WireFrame {
        request_id: call.request_id.clone(),
        channel: IpcChannel::Control,
        body: IpcMessage::Request {
            request: Box::new(RpcRequest::Invoke(call.clone())),
        },
    };
    let public_bytes = serial_workbench_ipc::frame::encoded_length(&frame, maximum).unwrap();
    assert!(public_bytes > maximum - 32);
    eprintln!(
        "native_public_task_context_frame call_bytes={call_bytes} public_bytes={public_bytes} padding_bytes={padding} public_limit={maximum}"
    );
    let accepted = fixture.invoke(&fixture.client, call).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    let result = if settled.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &settled).await)
    } else {
        None
    };
    let profile = fixture.finish().await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(result, Some(json!({"length":padding,"calls":1})));
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_dispatches_private_task_context_to_signed_action_owner() {
    let mut action = spec();
    action.output_schema = serde_json::from_value(json!({
        "type":"object","properties":{
            "value":{"type":"number"},"calls":{"type":"integer"},
            "hasTaskContext":{"type":"boolean"},"rawCallHasTaskContext":{"type":"boolean"}
        },"required":["value","calls","hasTaskContext","rawCallHasTaskContext"],"additionalProperties":false
    })).unwrap();
    let fixture=Fixture::program(action,b"export function register(context) {let calls=0;context.actions.register('example.terminal.compute',(call,task)=>({value:call.params.value+0.25,calls:++calls,hasTaskContext:typeof task.taskContext==='string'&&task.taskContext.length>0,rawCallHasTaskContext:Object.hasOwn(call,'taskContext')}));return ()=>{};}").await;
    let call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":9}),
    );
    let accepted = fixture.invoke(&fixture.client, call.clone()).await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    let result = fixture.result(&fixture.client, &settled).await;
    let replay = fixture.invoke(&fixture.client, call).await;
    let profile = fixture.finish().await;
    assert_eq!(replay.operation_id, accepted.operation_id);
    assert!(
        !serde_json::to_string(&settled)
            .unwrap()
            .contains("taskContext")
    );
    assert_eq!(
        result,
        json!({"value":9.25,"calls":1,"hasTaskContext":true,"rawCallHasTaskContext":false})
    );
    drop(profile);
}
