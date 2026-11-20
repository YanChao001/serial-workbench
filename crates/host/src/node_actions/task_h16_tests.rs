//! H16：实际Unknown子TX与在途回执共同约束父取消及公开重放。
use super::*;
use std::{path::Path, sync::Arc, time::Duration};

const H16_SOURCE: &[u8] = br#"
import {appendFileSync,writeFileSync,existsSync} from 'node:fs';
export function register(context) {
  let calls=0;
  context.actions.register('example.terminal.compute',async (call,task)=>{
    const count=++calls;
    appendFileSync(call.params.events,'start\n');
    writeFileSync(call.params.nodePid,String(process.pid));
    const stopped=new Promise(resolve=>{
      if(task.signal.aborted) resolve();
      else task.signal.addEventListener('abort',resolve,{once:true});
    });
    const send=(target,bytesBase64)=>task.actions.invokeChild({
      actionId:'session.tx',target,params:{bytesBase64,writeWaitMs:'100'}
    });
    const first=await send(call.params.firstTarget,'AQIDBA==');
    let firstReceipt=await task.operations.get({operationId:first.operationId});
    while(['queued','running','cancel_requested'].includes(firstReceipt.state)) {
      await new Promise(resolve=>setTimeout(resolve,5));
      firstReceipt=await task.operations.get({operationId:first.operationId});
    }
    if(firstReceipt.state!=='unknown') throw new Error('First actual TX must be unknown');
    const second=await send(call.params.secondTarget,'BQYHCA==');
    writeFileSync(call.params.ready,JSON.stringify({first,firstReceipt,second,calls:count}));
    await stopped;
    let rejected=false,sameAbortReason=false,errorName,errorCode,third;
    try {third=await send(call.params.secondTarget,'CQoLDA==');}
    catch(error) {
      rejected=true;sameAbortReason=error===task.signal.reason;
      errorName=error.name;errorCode=error.code;
    }
    writeFileSync(call.params.cancelled,JSON.stringify({
      aborted:task.signal.aborted,rejected,sameAbortReason,errorName,errorCode,third,calls:count
    }));
    while(!existsSync(call.params.handlerRelease))await new Promise(resolve=>setTimeout(resolve,5));
    return {calls:count};
  });
  return ()=>{};
}
"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_h16_parent_cancel_waits_for_actual_tx_and_preserves_unknown() {
    let mut action = spec();
    // 私有operation.get仍须声明原session的metadata/content读取能力。
    action.permissions = vec![
        "metadata.read".into(),
        "content.read".into(),
        "device.modify".into(),
    ];
    action.target_kinds = vec![
        ResourceKind::try_from("host").unwrap(),
        ResourceKind::try_from("session").unwrap(),
    ];
    action.input_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = TaskHost::new_with_spec(H16_SOURCE, action).await;
    let first_target = fixture.h.open("h16-unknown").await;
    let second_target = fixture.h.open("h16-in-flight").await;
    let gate = Arc::new(support::Gate::default());
    let _release_on_failure = ReleaseWriteReceipt(gate.clone());
    fixture.h.probe.steps.lock().unwrap().extend([
        support::WriteStep {
            accepted: 2,
            unknown: true,
            gate: None,
            advance_ms: 0,
        },
        support::WriteStep {
            accepted: 4,
            unknown: false,
            gate: Some(gate.clone()),
            advance_ms: 0,
        },
    ]);
    let ready_path = fixture.h.dir.path().join("h16-ready.json");
    let cancelled_path = fixture.h.dir.path().join("h16-cancelled.json");
    let handler_release_path = fixture.h.dir.path().join("h16-handler-release");
    let _release_handler_on_failure = ReleaseH16Handler(handler_release_path.clone());
    let events_path = fixture.h.dir.path().join("h16.events");
    let node_pid_path = fixture.h.dir.path().join("h16-node.pid");
    let mut call = fixture.h.call(
        &fixture.target,
        "example.terminal.compute",
        json!({
            "firstTarget":first_target,"secondTarget":second_target,
            "ready":ready_path.to_str().unwrap(),"cancelled":cancelled_path.to_str().unwrap(),
            "events":events_path.to_str().unwrap(),"nodePid":node_pid_path.to_str().unwrap(),
            "handlerRelease":handler_release_path.to_str().unwrap()
        }),
    );
    call.execution_mode = Some(ExecutionMode::Independent);
    let accepted_parent = fixture.h.invoke(call.clone()).await;
    gate.entered().await;
    let ready = read_h16_marker(&ready_path).await;
    let first_admission: Operation = serde_json::from_value(ready["first"].clone()).unwrap();
    let first_sdk_receipt: Operation =
        serde_json::from_value(ready["firstReceipt"].clone()).unwrap();
    let second_admission: Operation = serde_json::from_value(ready["second"].clone()).unwrap();
    let mut node = support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(&node_pid_path)
            .unwrap()
            .parse()
            .unwrap(),
    );
    let first_before = h16_operation(
        &fixture,
        json!({"operationId":first_admission.operation_id}),
    )
    .await;
    let second_before = h16_operation(
        &fixture,
        json!({"operationId":second_admission.operation_id}),
    )
    .await;
    let parent_before = h16_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    // 取消前只给实际Running/live owner签发已有内部凭据，不能在停止后补造上下文。
    let store = fixture.h.store.clone();
    let parent_id = accepted_parent.operation_id.clone();
    let (task_context, identity) = tokio::task::spawn_blocking(move || {
        assert_eq!(
            store.operation_state(&parent_id).unwrap(),
            OperationState::Running
        );
        let plugin = store.plugin_operation(&parent_id).unwrap();
        let context = store
            .issue_task_context(&parent_id, &plugin.instance_id)
            .unwrap();
        (context, store.identity().unwrap())
    })
    .await
    .unwrap();
    let third_call: ChildCall = serde_json::from_value(json!({
        "protocolVersion":"0.1","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,
        "actorId":fixture.h.actor.id(),"taskContext":task_context,
        "parentOperationId":accepted_parent.operation_id,"childKey":"3",
        "actionId":"session.tx","target":second_target,
        "params":{"bytesBase64":"CQoLDA==","writeWaitMs":"100"},
        "revealTarget":second_before.reveal_target
    }))
    .unwrap();
    let writes_before_cancel = fixture.h.write_count();
    let cancelled = fixture.h.cancel(&accepted_parent).await;
    let cancelled_marker = read_h16_marker(&cancelled_path).await;
    let parent_waiting = h16_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    let second_waiting = h16_operation(
        &fixture,
        json!({"operationId":second_admission.operation_id}),
    )
    .await;
    let first_waiting = h16_operation(
        &fixture,
        json!({"parentOperationId":accepted_parent.operation_id,"childKey":"1"}),
    )
    .await;
    // SDK的AbortError之外，实际进入Host接纳边界；第三键本身是连续且合法的请求。
    assert!(!handler_release_path.exists());
    let writes_before_host_third = fixture.h.write_count();
    let host_third_denied = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, third_call)
        .await;
    let parent_after_host_third = h16_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    let writes_after_host_third = fixture.h.write_count();
    let missing_third = fixture
        .h
        .host
        .query(
            &fixture.h.actor,
            call_query(&fixture.h.call(
                &fixture.target,
                "operation.get",
                json!({"parentOperationId":accepted_parent.operation_id,"childKey":"3"}),
            )),
        )
        .await;
    let gate_was_held = !gate.is_released();
    let writes_while_cancelled = fixture.h.write_count();
    // 先完成存活owner上的拒绝观察，再允许handler结束；失败时同一文件门由RAII释放。
    std::fs::write(&handler_release_path, b"release").unwrap();
    // 释放实际PendingWrite的唯一回执；取消本身不能代替它或补造Unknown。
    gate.release();
    let parent = fixture.h.wait(&accepted_parent.operation_id).await;
    let second = fixture.h.wait(&second_admission.operation_id).await;
    let first = h16_operation(
        &fixture,
        json!({"parentOperationId":parent.operation_id,"childKey":"1"}),
    )
    .await;
    let second_by_child = h16_operation(
        &fixture,
        json!({"parentOperationId":parent.operation_id,"childKey":"2"}),
    )
    .await;
    let replay = fixture.h.invoke(call.clone()).await;
    let parent_by_request = h16_operation(
        &fixture,
        json!({"actorId":call.actor_id,"requestId":call.request_id,"requestContext":call.request_context}),
    )
    .await;
    let first_again = h16_operation(&fixture, json!({"operationId":first.operation_id})).await;
    let second_again = h16_operation(&fixture, json!({"operationId":second.operation_id})).await;
    let unconsumed_steps = fixture.h.probe.steps.lock().unwrap().len();
    let events = std::fs::read_to_string(&events_path).unwrap();
    fixture.h.host.shutdown().await.unwrap();
    let writes = fixture.h.probe.writes.lock().unwrap().clone();
    assert!(
        node.wait(),
        "Normal Host shutdown must actually reap the shared Node"
    );

    assert_eq!(ready["calls"], 1);
    assert_eq!(
        first_before.state,
        OperationState::Unknown,
        "{first_before:?}"
    );
    assert_eq!(first_before, first_sdk_receipt);
    assert_eq!(first_waiting, first_before);
    assert_eq!(first, first_before);
    assert_eq!(first.target, first_target);
    let unknown = support::receipt(&first);
    assert_eq!(unknown.outcome, TxOutcome::Unknown);
    assert_eq!(unknown.bytes_base64.as_str(), "AQIDBA==");
    assert_eq!(
        unknown.accepted_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: 2.into()
        }]
    );
    assert_eq!(
        unknown.unknown_ranges,
        vec![ByteRange {
            start: 2.into(),
            end: 4.into()
        }]
    );
    assert_eq!(unknown.operation_id, first.operation_id);
    assert_eq!(unknown.session_id, first_target.id);
    assert_eq!(Some(unknown.session_epoch), first_target.session_epoch);
    assert_eq!(parent_before.state, OperationState::Running);
    assert_eq!(parent_before.child_high_watermark, 2.into());
    assert_eq!(second_before.state, OperationState::Running);
    assert_eq!(cancelled.state, OperationState::Succeeded, "{cancelled:?}");
    assert_eq!(cancelled_marker["aborted"], true);
    assert_eq!(cancelled_marker["rejected"], true);
    // AbortError来自SDK收到的取消信号，不冒称Host返回PERMISSION_DENIED。
    assert_eq!(cancelled_marker["sameAbortReason"], true);
    assert_eq!(cancelled_marker["errorName"], "AbortError");
    assert_eq!(cancelled_marker["calls"], 1);
    assert!(cancelled_marker.get("third").is_none());
    assert_eq!(
        parent_waiting.state,
        OperationState::CancelRequested,
        "{parent_waiting:?}"
    );
    assert_eq!(parent_waiting.child_high_watermark, 2.into());
    assert!(
        matches!(host_third_denied, Err(ref error) if error.code=="OPERATION_NOT_RUNNING"),
        "The actual Host boundary must reject the third key after parent cancellation: {host_third_denied:?}"
    );
    assert_eq!(
        parent_after_host_third.state,
        OperationState::CancelRequested,
        "{parent_after_host_third:?}"
    );
    assert_eq!(parent_after_host_third.child_high_watermark, 2.into());
    assert_eq!(writes_before_host_third, 2);
    assert_eq!(writes_after_host_third, writes_before_host_third);
    assert!(
        !second_waiting.state.is_terminal(),
        "Held actual write settled before its receipt: {second_waiting:?}"
    );
    assert!(
        matches!(missing_third, Err(ref error) if error.code=="NOT_FOUND"),
        "{missing_third:?}"
    );
    assert!(gate_was_held);
    assert_eq!(writes_before_cancel, 2);
    assert_eq!(writes_while_cancelled, 2);
    assert_eq!(parent.state, OperationState::Unknown, "{parent:?}");
    assert_eq!(parent.error.as_ref().unwrap().code, "CHILD_OUTCOME_UNKNOWN");
    assert_eq!(parent.child_high_watermark, 2.into());
    assert_eq!(parent.execution_mode, ExecutionMode::Independent);
    assert_eq!(parent.root_operation_id, parent.operation_id);
    assert!(matches!(parent.admission, Admission::Request { .. }));
    assert_eq!(second.state, OperationState::Succeeded, "{second:?}");
    assert_eq!(second.target, second_target);
    let completed = support::receipt(&second);
    assert_eq!(completed.outcome, TxOutcome::Accepted);
    assert_eq!(completed.bytes_base64.as_str(), "BQYHCA==");
    assert_eq!(
        completed.accepted_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: 4.into()
        }]
    );
    assert!(completed.unknown_ranges.is_empty());
    assert_eq!(completed.operation_id, second.operation_id);
    assert_eq!(completed.session_id, second_target.id);
    assert_eq!(Some(completed.session_epoch), second_target.session_epoch);
    assert_ne!(first.operation_id, second.operation_id);
    assert_ne!(first.request_id, second.request_id);
    for (child, key) in [(&first, 1), (&second, 2)] {
        assert_eq!(child.actor_id, parent.actor_id);
        assert_eq!(child.root_operation_id, parent.operation_id);
        assert_eq!(child.execution_mode, ExecutionMode::Independent);
        assert_ne!(child.operation_id, parent.operation_id);
        assert_ne!(child.request_id, parent.request_id);
        assert!(
            matches!(&child.admission, Admission::Child {parent_operation_id,child_key,..}
            if parent_operation_id==&parent.operation_id && child_key.get()==key)
        );
    }
    assert_eq!(parent_by_request, parent);
    assert_eq!(replay, parent);
    assert_eq!(first_again, first);
    assert_eq!(second_by_child, second);
    assert_eq!(second_again, second);
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].0, "h16-unknown");
    assert_eq!(writes[0].1, vec![1, 2, 3, 4]);
    assert_eq!(writes[1].0, "h16-in-flight");
    assert_eq!(writes[1].1, vec![5, 6, 7, 8]);
    assert!(
        writes
            .iter()
            .all(|(_, _, wait)| *wait == Duration::from_millis(100))
    );
    assert_eq!(unconsumed_steps, 0);
    assert_eq!(events, "start\n");
    assert_eq!(std::fs::read_to_string(&events_path).unwrap(), events);
    eprintln!(
        "native_task_h16 actual_unknown_tx=true actual_in_flight_receipt_held=true cancelled_sdk_next_key=AbortError actual_host_third_rejected=OPERATION_NOT_RUNNING no_third_operation=true child_watermark=2 parent_waited_for_receipt=true parent=Unknown second=Succeeded actual_writes=2 replay_unchanged=true"
    );
}

struct ReleaseWriteReceipt(Arc<support::Gate>);
impl Drop for ReleaseWriteReceipt {
    fn drop(&mut self) {
        self.0.release();
    }
}

struct ReleaseH16Handler(std::path::PathBuf);
impl Drop for ReleaseH16Handler {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, b"release");
    }
}

async fn read_h16_marker(path: &Path) -> Value {
    let mut last_error = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match std::fs::read(path) {
                Ok(bytes) => match serde_json::from_slice(&bytes) {
                    Ok(value) => return value,
                    Err(error) => last_error = Some(error.to_string()),
                },
                Err(error) => last_error = Some(error.to_string()),
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "Actual H16 handler marker did not arrive: path={} last={last_error:?}",
            path.display()
        )
    })
}

async fn h16_operation(fixture: &TaskHost, selector: Value) -> Operation {
    let QueryResult::Operation(result) = fixture
        .query(&fixture.target, "operation.get", selector)
        .await
    else {
        panic!("Expected public H16 operation");
    };
    result.operation
}
