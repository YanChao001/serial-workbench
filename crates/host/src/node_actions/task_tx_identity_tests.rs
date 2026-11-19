//! H12/H13：真实签名父任务的SDK重试与Host子键校验均按实际TX次数核对。
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const TX_IDENTITY_SOURCE: &[u8] = r#"
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
export function register(context) {
  let calls=0;
  context.actions.register('example.terminal.compute',async (call,task)=>{
    const count=++calls;
    appendFileSync(call.params.events,call.params.mode+'\n');
    if(call.params.mode==='host') {
      writeFileSync(call.params.ready,JSON.stringify({calls:count,pid:process.pid}));
      while(!existsSync(call.params.release)) {
        task.signal.throwIfAborted();
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      return {calls:count};
    }
    // 同一SDK父先等待可信测试验证乱序键；恢复后SDK仍从key=1开始。
    writeFileSync(call.params.started,JSON.stringify({calls:count,pid:process.pid}));
    while(!existsSync(call.params.release)) {
      task.signal.throwIfAborted();
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    const send=bytesBase64=>task.actions.invokeChild({
      actionId:'session.tx',target:call.params.target,params:{bytesBase64,writeWaitMs:'100'}
    });
    const completed=async operation=>{
      let receipt=await task.operations.get({operationId:operation.operationId});
      while(['queued','running','cancel_requested'].includes(receipt.state)) {
        await new Promise(resolve=>setTimeout(resolve,5));
        receipt=await task.operations.get({operationId:operation.operationId});
      }
      if(receipt.state!=='succeeded') throw new Error('Actual child TX did not complete');
    };
    let first,failed,changed;
    try {first=await send('AQ==');}
    catch(error) {
      failed=error.code;
      // 未确认接纳只能重试相同intent；这是SDK拒绝，不冒称Host接到异参。
      try {await send('Ag==');} catch(error) {changed=error.code;}
      first=await send('AQ==');
    }
    await completed(first);
    const second=await send('Ag==');
    await completed(second);
    const third=await send('Aw==');
    await completed(third);
    writeFileSync(call.params.ready,JSON.stringify({first,second,third,failed,changed,calls:count,pid:process.pid}));
    return {calls:count};
  });
  return ()=>{};
}
"#.as_bytes();

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_h12_h13_child_tx_retries_and_ordering_preserve_actual_effect_counts() {
    let mut action = spec();
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
    let fixture = TaskHost::new_with_spec(TX_IDENTITY_SOURCE, action).await;
    let sdk_target = fixture.h.open("h12-sdk").await;
    let host_target = fixture.h.open("h13-host").await;
    let events = fixture.h.dir.path().join("tx-identity.events");
    let sdk_started = fixture.h.dir.path().join("tx-sdk-started.json");
    let sdk_ready = fixture.h.dir.path().join("tx-sdk-ready.json");
    let sdk_release = fixture.h.dir.path().join("tx-sdk-release");
    let host_ready = fixture.h.dir.path().join("tx-host-ready.json");
    let host_release = fixture.h.dir.path().join("tx-host-release");
    let _release_sdk_on_failure = ReleaseTxParent(sdk_release.clone());
    let _release_on_failure = ReleaseTxParent(host_release.clone());

    // 场景一：同一SDK父先拒键2，再丢键1的接纳回执并同参重试，最后接纳2/3。
    let mut sdk_call = fixture.h.call(&fixture.target, "example.terminal.compute", json!({
        "mode":"sdk","target":sdk_target,"started":sdk_started.to_str().unwrap(),
        "ready":sdk_ready.to_str().unwrap(),"release":sdk_release.to_str().unwrap(),"events":events.to_str().unwrap()
    }));
    sdk_call.execution_mode = Some(ExecutionMode::Independent);
    let sdk_parent = fixture.h.invoke(sdk_call.clone()).await;
    let sdk_started_marker = tx_marker(&sdk_started).await;
    assert_eq!(sdk_started_marker["calls"], 1);
    let pid = u32::try_from(sdk_started_marker["pid"].as_u64().unwrap()).unwrap();
    let mut node = support::node_owner_exit::ProcessExit::observe(pid);
    assert!(!node.exited());
    let sdk_running = tx_operation(&fixture, json!({"operationId":sdk_parent.operation_id})).await;
    assert_eq!(sdk_running.state, OperationState::Running);
    assert_eq!(sdk_running.child_high_watermark, 0.into());
    assert_eq!(fixture.h.write_count(), 0);
    let store = fixture.h.host.inner.store.clone();
    let operation = sdk_parent.operation_id.clone();
    let sdk_context = tokio::task::spawn_blocking(move || {
        // 只为刚才实际派发的同一owner签发凭据，不改Store的派发或结算事实。
        let owner = store.plugin_operation(&operation).unwrap();
        store
            .issue_task_context(&operation, &owner.instance_id)
            .unwrap()
    })
    .await
    .unwrap();
    let sdk_second_before_first =
        tx_child_call(&sdk_call, &sdk_parent, &sdk_context, &sdk_target, 2, "Ag==");
    let sdk_out_of_order = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, sdk_second_before_first)
        .await;
    assert!(
        matches!(sdk_out_of_order, Err(ref error) if error.code == "INVALID_ARGUMENT"),
        "{sdk_out_of_order:?}"
    );
    let sdk_after_invalid =
        tx_operation(&fixture, json!({"operationId":sdk_parent.operation_id})).await;
    assert_eq!(sdk_after_invalid.state, OperationState::Running);
    assert_eq!(sdk_after_invalid.child_high_watermark, 0.into());
    assert_eq!(sdk_after_invalid.revision, sdk_running.revision);
    assert_eq!(
        fixture.h.write_count(),
        0,
        "H13 key=2 must not send before the same parent's key=1"
    );
    let sdk_missing_second = fixture
        .h
        .host
        .query(
            &fixture.h.actor,
            call_query(&fixture.h.call(
                &fixture.target,
                "operation.get",
                json!({"parentOperationId":sdk_parent.operation_id,"childKey":"2"}),
            )),
        )
        .await;
    assert!(
        matches!(sdk_missing_second, Err(ref error) if error.code == "NOT_FOUND"),
        "{sdk_missing_second:?}"
    );
    // 乱序拒绝已观察完毕后才arm；既有门只丢真实接纳回执，不替换接纳/派发/TX。
    fixture
        .h
        .host
        .inner
        .node_test_gates
        .fail_child_receipt_once
        .store(true, std::sync::atomic::Ordering::Release);
    std::fs::write(&sdk_release, b"release").unwrap();
    let sdk_marker = tx_marker(&sdk_ready).await;
    assert_eq!(sdk_marker["pid"], sdk_started_marker["pid"]);
    let sdk_parent = fixture.h.wait(&sdk_parent.operation_id).await;
    let sdk_admissions: [Operation; 3] = ["first", "second", "third"]
        .map(|key| serde_json::from_value(sdk_marker[key].clone()).unwrap());
    let mut sdk_children = Vec::new();
    for (index, admission) in sdk_admissions.iter().enumerate() {
        let child = fixture.h.wait(&admission.operation_id).await;
        let by_key = tx_operation(
            &fixture,
            json!({"parentOperationId":sdk_parent.operation_id,"childKey":(index + 1).to_string()}),
        )
        .await;
        assert_eq!(by_key, child);
        sdk_children.push(child);
    }
    assert_eq!(sdk_marker["failed"], "HOST_BUSY");
    assert_eq!(sdk_marker["changed"], "REQUEST_CONFLICT");
    assert_eq!(sdk_marker["calls"], 1);
    assert_eq!(
        sdk_parent.state,
        OperationState::Succeeded,
        "{sdk_parent:?}"
    );
    assert_eq!(sdk_parent.child_high_watermark, 3.into());
    assert_eq!(
        fixture.h.write_count(),
        3,
        "SDK same-intent retry must not repeat the accepted TX"
    );
    assert!(
        !fixture
            .h
            .host
            .inner
            .node_test_gates
            .fail_child_receipt_once
            .load(std::sync::atomic::Ordering::Acquire)
    );
    for (index, (child, payload)) in sdk_children
        .iter()
        .zip(["AQ==", "Ag==", "Aw=="])
        .enumerate()
    {
        assert_tx_child(&sdk_parent, child, &sdk_target, (index + 1) as u64, payload);
    }
    assert_distinct_tx_children(&sdk_children);
    assert_eq!(fixture.h.invoke(sdk_call).await, sdk_parent);
    assert_eq!(fixture.h.write_count(), 3);
    assert_eq!(std::fs::read_to_string(&events).unwrap(), "sdk\n");
    assert!(!node.exited());

    // 场景二：独立真实Running父任务，由可信Rust测试提交完整ChildCall；SDK不新增显式key入口。
    let mut host_call = fixture.h.call(
        &fixture.target,
        "example.terminal.compute",
        json!({
            "mode":"host","target":host_target,"ready":host_ready.to_str().unwrap(),
            "release":host_release.to_str().unwrap(),"events":events.to_str().unwrap()
        }),
    );
    host_call.execution_mode = Some(ExecutionMode::Independent);
    let host_parent = fixture.h.invoke(host_call.clone()).await;
    let host_marker = tx_marker(&host_ready).await;
    assert_eq!(host_marker["pid"], sdk_marker["pid"]);
    assert_eq!(host_marker["calls"], 2);
    let running = tx_operation(&fixture, json!({"operationId":host_parent.operation_id})).await;
    assert_eq!(running.state, OperationState::Running);
    assert_eq!(running.child_high_watermark, 0.into());
    let store = fixture.h.host.inner.store.clone();
    let operation = host_parent.operation_id.clone();
    let context = tokio::task::spawn_blocking(move || {
        // 不伪造Running或结算；凭据只能绑定刚才实际派发的插件owner和live admission。
        let owner = store.plugin_operation(&operation).unwrap();
        store
            .issue_task_context(&operation, &owner.instance_id)
            .unwrap()
    })
    .await
    .unwrap();
    let first_call = tx_child_call(&host_call, &host_parent, &context, &host_target, 1, "AQ==");
    let second_call = tx_child_call(&host_call, &host_parent, &context, &host_target, 2, "Ag==");
    let third_call = tx_child_call(&host_call, &host_parent, &context, &host_target, 3, "Aw==");
    let out_of_order = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, second_call.clone())
        .await;
    assert!(
        matches!(out_of_order, Err(ref error) if error.code == "INVALID_ARGUMENT"),
        "{out_of_order:?}"
    );
    let after_invalid =
        tx_operation(&fixture, json!({"operationId":host_parent.operation_id})).await;
    assert_eq!(after_invalid.child_high_watermark, 0.into());
    assert_eq!(after_invalid.revision, running.revision);
    assert_eq!(
        fixture.h.write_count(),
        3,
        "Out-of-order child must not reach actual TX"
    );

    let first = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, first_call)
        .await
        .unwrap();
    let first = fixture.h.wait(&first.operation_id).await;
    let second = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, second_call.clone())
        .await
        .unwrap();
    let second = fixture.h.wait(&second.operation_id).await;
    let at_two = tx_operation(&fixture, json!({"operationId":host_parent.operation_id})).await;
    assert_eq!(at_two.state, OperationState::Running);
    assert_eq!(at_two.child_high_watermark, 2.into());
    let same = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, second_call.clone())
        .await
        .unwrap();
    assert_eq!(same, second);
    let mut changed = second_call;
    changed.params =
        serde_json::from_value(json!({"bytesBase64":"BA==","writeWaitMs":"100"})).unwrap();
    let conflict = fixture.h.host.invoke_child(&fixture.h.actor, changed).await;
    assert!(
        matches!(conflict, Err(ref error) if error.code == "REQUEST_CONFLICT"),
        "{conflict:?}"
    );
    let still_two = tx_operation(&fixture, json!({"operationId":host_parent.operation_id})).await;
    assert_eq!(still_two.child_high_watermark, 2.into());
    assert_eq!(still_two.revision, at_two.revision);
    assert_eq!(
        fixture.h.write_count(),
        5,
        "Same/conflicting old child keys must not send again"
    );
    assert_eq!(fixture.h.invoke(host_call.clone()).await, still_two);
    assert_eq!(fixture.h.write_count(), 5);
    let third = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, third_call)
        .await
        .unwrap();
    let third = fixture.h.wait(&third.operation_id).await;
    let host_children = vec![first, second, third];
    std::fs::write(&host_release, b"release").unwrap();
    let host_parent = fixture.h.wait(&host_parent.operation_id).await;
    assert_eq!(
        host_parent.state,
        OperationState::Succeeded,
        "{host_parent:?}"
    );
    assert_eq!(host_parent.child_high_watermark, 3.into());
    for (index, (child, payload)) in host_children
        .iter()
        .zip(["AQ==", "Ag==", "Aw=="])
        .enumerate()
    {
        assert_tx_child(
            &host_parent,
            child,
            &host_target,
            (index + 1) as u64,
            payload,
        );
        assert_eq!(tx_operation(&fixture, json!({"parentOperationId":host_parent.operation_id,"childKey":(index + 1).to_string()})).await, *child);
    }
    assert_distinct_tx_children(&host_children);
    assert_ne!(host_parent.operation_id, sdk_parent.operation_id);
    assert_eq!(fixture.h.invoke(host_call).await, host_parent);
    assert_eq!(fixture.h.write_count(), 6);
    assert_eq!(std::fs::read_to_string(&events).unwrap(), "sdk\nhost\n");
    assert!(
        !node.exited(),
        "Both parent scenarios must use the actual live shared Node"
    );
    fixture.h.host.shutdown().await.unwrap();
    assert!(
        node.wait(),
        "Host shutdown must actually reap the signed handler owner"
    );
    let writes = fixture.h.probe.writes.lock().unwrap().clone();
    assert_eq!(writes.len(), 6);
    for ((device, bytes, wait), (expected_device, byte)) in writes.iter().zip([
        ("h12-sdk", 1_u8),
        ("h12-sdk", 2),
        ("h12-sdk", 3),
        ("h13-host", 1),
        ("h13-host", 2),
        ("h13-host", 3),
    ]) {
        assert_eq!(device, expected_device);
        assert_eq!(bytes, &vec![byte]);
        assert_eq!(*wait, Duration::from_millis(100));
    }
    assert_eq!(std::fs::read_to_string(&events).unwrap(), "sdk\nhost\n");
    eprintln!(
        "native_task_tx_identity h13_same_parent=true sdk_out_of_order_before_ack_loss=true sdk_out_of_order_zero_effect=true sdk_ack_lost_after_admission=true sdk_same_intent_retry=true sdk_changed_intent_conflict=true sdk_actual_tx=3 host_out_of_order_zero_effect=true host_same_key_same_operation=true host_changed_key_conflict=true host_actual_tx=3 distinct_parents=true parent_replay_no_effect=true actual_total_tx=6 node_reaped=true"
    );
}

fn tx_child_call(
    parent_call: &Call,
    parent: &Operation,
    context: &ContextToken,
    target: &Target,
    key: u64,
    payload: &str,
) -> ChildCall {
    serde_json::from_value(json!({
        "protocolVersion":parent_call.protocol_version,"hostId":parent_call.host_id,
        "instanceEpoch":parent_call.instance_epoch,"actorId":parent_call.actor_id,
        "taskContext":context,"parentOperationId":parent.operation_id,"childKey":key.to_string(),
        "actionId":"session.tx","target":target,"params":{"bytesBase64":payload,"writeWaitMs":"100"},
        "revealTarget":parent_call.reveal_target
    })).unwrap()
}

async fn tx_operation(fixture: &TaskHost, selector: Value) -> Operation {
    let QueryResult::Operation(result) = fixture
        .query(&fixture.target, "operation.get", selector)
        .await
    else {
        panic!("Expected public TX parent/child operation");
    };
    result.operation
}

fn assert_tx_child(
    parent: &Operation,
    child: &Operation,
    target: &Target,
    key: u64,
    payload: &str,
) {
    assert_eq!(child.state, OperationState::Succeeded, "{child:?}");
    assert_eq!(child.action_id.as_str(), "session.tx");
    assert_eq!(&child.target, target);
    assert_eq!(child.actor_id, parent.actor_id);
    assert_eq!(child.root_operation_id, parent.operation_id);
    assert_eq!(child.execution_mode, ExecutionMode::Independent);
    assert_ne!(child.operation_id, parent.operation_id);
    assert_ne!(child.request_id, parent.request_id);
    assert!(
        matches!(&child.admission, Admission::Child {parent_operation_id, child_key, ..} if parent_operation_id == &parent.operation_id && child_key.get() == key)
    );
    let receipt = support::receipt(child);
    assert_eq!(receipt.outcome, TxOutcome::Accepted);
    assert_eq!(receipt.bytes_base64.as_str(), payload);
    assert_eq!(
        receipt.accepted_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: 1.into()
        }]
    );
    assert!(receipt.unknown_ranges.is_empty());
    assert_eq!(receipt.operation_id, child.operation_id);
    assert_eq!(receipt.session_id, target.id);
    assert_eq!(Some(receipt.session_epoch), target.session_epoch);
}

fn assert_distinct_tx_children(children: &[Operation]) {
    for (index, child) in children.iter().enumerate() {
        for previous in &children[..index] {
            assert_ne!(child.operation_id, previous.operation_id);
            assert_ne!(child.request_id, previous.request_id);
        }
    }
}

struct ReleaseTxParent(PathBuf);
impl Drop for ReleaseTxParent {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, b"release");
    }
}

async fn tx_marker(path: &Path) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(bytes) = std::fs::read(path)
                && let Ok(value) = serde_json::from_slice(&bytes)
            {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "Actual signed TX handler did not publish marker within five seconds: {}",
            path.display()
        )
    })
}
