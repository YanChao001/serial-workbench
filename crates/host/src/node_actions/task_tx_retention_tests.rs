//! H14/H15的真实TX局部组合；逻辑保留时钟不代表实际24小时或七天运行。
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::OptionalExtension;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const AFTER_TX_RETENTION_MS: u64 = 604_800_001;
const H15_WATERMARK: u64 = 100;
const RETENTION_SOURCE: &[u8] = r#"
import {appendFileSync,writeFileSync,existsSync} from 'node:fs';
export function register(context) {
  let calls=0;
  context.actions.register('example.terminal.compute',async(call,task)=>{
    const count=++calls;appendFileSync(call.params.events,'start\n');
    writeFileSync(call.params.nodePid,String(process.pid));
    const child=await task.actions.invokeChild({actionId:'session.tx',target:call.params.target,
      params:{bytesBase64:'AQIDBA==',writeWaitMs:'100'}});
    let receipt=await task.operations.get({operationId:child.operationId});
    while(['queued','running','cancel_requested'].includes(receipt.state)) {
      await new Promise(resolve=>setTimeout(resolve,5));
      receipt=await task.operations.get({operationId:child.operationId});
    }
    if(receipt.state!=='succeeded')throw new Error('Initial actual TX did not succeed');
    task.signal.addEventListener('abort',()=>writeFileSync(call.params.cancelObserved,'true'),{once:true});
    writeFileSync(call.params.ready,JSON.stringify({receipt,calls:count}));
    // 保留真实执行owner供可信Rust重试旧键；撤权后也只等测试释放，不再发SDK动作。
    while(!existsSync(call.params.release))await new Promise(resolve=>setTimeout(resolve,5));
    appendFileSync(call.params.events,'released\n');
    task.signal.throwIfAborted();return {calls:count};
  });return ()=>{};
}
"#
.as_bytes();

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_tx_child_prune_and_current_revocation_preserve_live_parent_boundary() {
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
    let fixture = TaskHost::new_with_spec(RETENTION_SOURCE, action).await;
    let session = fixture.h.open("tx-retention-live-parent").await;
    let ready_path = fixture.h.dir.path().join("tx-retention-ready.json");
    let cancel_observed_path = fixture
        .h
        .dir
        .path()
        .join("tx-retention-cancel-observed.json");
    let release_path = fixture.h.dir.path().join("tx-retention-release");
    let events_path = fixture.h.dir.path().join("tx-retention.events");
    let node_pid_path = fixture.h.dir.path().join("tx-retention-node.pid");
    let _release_on_failure = ReleaseParent(release_path.clone());
    fixture
        .h
        .probe
        .steps
        .lock()
        .unwrap()
        .extend((0..=H15_WATERMARK).map(|_| support::WriteStep {
            accepted: 4,
            unknown: false,
            gate: None,
            advance_ms: 0,
        }));
    let mut root_call = fixture.h.call(&fixture.target, "example.terminal.compute", json!({
        "target":session,"ready":ready_path.to_str().unwrap(),"release":release_path.to_str().unwrap(),
        "cancelObserved":cancel_observed_path.to_str().unwrap(),
        "events":events_path.to_str().unwrap(),"nodePid":node_pid_path.to_str().unwrap()
    }));
    root_call.execution_mode = Some(ExecutionMode::Independent);
    let accepted_parent = fixture.h.invoke(root_call.clone()).await;
    let ready = retention_marker(&ready_path).await;
    let first: Operation = serde_json::from_value(ready["receipt"].clone()).unwrap();
    let mut node = support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(&node_pid_path)
            .unwrap()
            .parse()
            .unwrap(),
    );
    let parent_before = retention_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    let raw_first = retained_tx_row(&fixture, &first.operation_id).await;
    // 只给此真实Running owner签发已有的内部凭据，不新增RPC或伪造派发/结算。
    let store = fixture.h.store.clone();
    let parent_id = accepted_parent.operation_id.clone();
    let task_context = tokio::task::spawn_blocking(move || {
        let plugin = store.plugin_operation(&parent_id).unwrap();
        store
            .issue_task_context(&parent_id, &plugin.instance_id)
            .unwrap()
    })
    .await
    .unwrap();
    let identity = fixture.h.store.identity().unwrap();
    let old_child: ChildCall = serde_json::from_value(json!({
        "protocolVersion":"1.0","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,
        "actorId":fixture.h.actor.id(),"taskContext":task_context,
        "parentOperationId":accepted_parent.operation_id,"childKey":"1",
        "actionId":"session.tx","target":session,
        "params":{"bytesBase64":"AQIDBA==","writeWaitMs":"100"},"revealTarget":first.reveal_target
    }))
    .unwrap();
    let first_replay = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, old_child.clone())
        .await
        .unwrap();
    // 每个键均经真实Host接纳、真实begin_write与终态回执；不写Store水位或settle。
    let mut retained_children = vec![first.clone()];
    for key in 2..=H15_WATERMARK {
        let payload = retained_payload(key);
        let call = retention_child_call(&old_child, key, &payload);
        let child = fixture
            .h
            .host
            .invoke_child(&fixture.h.actor, call)
            .await
            .unwrap();
        let child = fixture.h.wait(&child.operation_id).await;
        assert_eq!(
            child.state,
            OperationState::Succeeded,
            "Actual TX key={key}: {child:?}"
        );
        assert_eq!(support::receipt(&child).outcome, TxOutcome::Accepted);
        assert_eq!(
            support::receipt(&child).bytes_base64.as_str(),
            STANDARD.encode(&payload)
        );
        retained_children.push(child);
    }
    let parent_at_h15 = retention_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    let old_rows_before = retained_child_rows(&fixture, &accepted_parent.operation_id).await;
    let writes_before_prune = fixture.h.write_count();
    fixture.h.clock.advance_ms(AFTER_TX_RETENTION_MS);
    let store = fixture.h.store.clone();
    tokio::task::spawn_blocking(move || store.prune())
        .await
        .unwrap()
        .unwrap();
    let pruned_first = retained_tx_row(&fixture, &first.operation_id).await;
    let old_rows_after = retained_child_rows(&fixture, &accepted_parent.operation_id).await;
    let root_replay = fixture
        .h
        .host
        .invoke(&fixture.h.actor, root_call.clone())
        .await;
    let mut new_root_from_old_context = root_call;
    new_root_from_old_context.request_id =
        RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap();
    let expired_root_context = fixture
        .h
        .host
        .invoke(&fixture.h.actor, new_root_from_old_context)
        .await;
    let same_old = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, old_child.clone())
        .await;
    let mut changed_old = old_child.clone();
    changed_old.params =
        serde_json::from_value(json!({"bytesBase64":"CQoLDA==","writeWaitMs":"100"})).unwrap();
    let different_old = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, changed_old)
        .await;
    let old_query = retention_query(
        &fixture,
        json!({"parentOperationId":accepted_parent.operation_id,"childKey":"1"}),
    )
    .await;
    let parent_after_old = retention_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    let writes_after_old = fixture.h.write_count();
    let after_prune_key = H15_WATERMARK + 1;
    let after_prune_payload = [5, 6, 7, 8];
    let after_prune_call = retention_child_call(&old_child, after_prune_key, &after_prune_payload);
    let after_prune = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, after_prune_call.clone())
        .await
        .unwrap();
    let after_prune = fixture.h.wait(&after_prune.operation_id).await;
    let after_prune_replay = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, after_prune_call.clone())
        .await
        .unwrap();
    let parent_after_prune = retention_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    let rows_after_new_key = retained_child_rows(&fixture, &accepted_parent.operation_id).await;
    let node_alive_before_revoke = !node.exited();
    let writes_after_prune_key = fixture.h.write_count();
    assert_eq!(parent_at_h15.state, OperationState::Running);
    assert_eq!(parent_at_h15.child_high_watermark, H15_WATERMARK.into());
    assert_eq!(old_rows_before, H15_WATERMARK);
    assert_eq!(
        old_rows_after, 0,
        "Actual prune must remove all 100 old child rows"
    );
    assert_eq!(
        parent_after_prune.child_high_watermark,
        after_prune_key.into()
    );
    assert!(fixture.h.probe.steps.lock().unwrap().is_empty());

    // H14：另一个actor真实持有当前session的写入turn，P的下一子项只能排队。
    let blocker_actor = fixture.h.new_actor("tx-retention-blocker");
    let gate = Arc::new(support::Gate::default());
    let _release_writer_on_failure = ReleaseRetainedWrite(gate.clone());
    let blocker_payload = [0xb0, 0xc1, 0xd2, 0xe3];
    fixture
        .h
        .probe
        .steps
        .lock()
        .unwrap()
        .push_back(support::WriteStep {
            accepted: 4,
            unknown: false,
            gate: Some(gate.clone()),
            advance_ms: 0,
        });
    let mut blocker_call = fixture.h.call_as(
        &blocker_actor,
        &session,
        "session.tx",
        json!({
            "bytesBase64":STANDARD.encode(blocker_payload),"writeWaitMs":"100"
        }),
    );
    blocker_call.execution_mode = Some(ExecutionMode::Independent);
    let blocker = fixture
        .h
        .host
        .invoke(&blocker_actor, blocker_call)
        .await
        .unwrap();
    gate.entered().await;
    let queued_key = after_prune_key + 1;
    let queued_payload = [0xa2, 0xb2, 0xc2, 0xd2];
    let queued_call = retention_child_call(&old_child, queued_key, &queued_payload);
    let queued = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, queued_call)
        .await
        .unwrap();
    let queued_before =
        retention_operation(&fixture, json!({"operationId":queued.operation_id})).await;
    let blocker_before =
        retention_operation(&fixture, json!({"operationId":blocker.operation_id})).await;
    let parent_queued = retention_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    let writes_while_queued = fixture.h.write_count();
    assert_eq!(
        queued_before.state,
        OperationState::Queued,
        "The actual blocker must keep P's child undispatched: {queued_before:?}"
    );
    assert!(queued_before.started_at.is_none());
    assert_eq!(blocker_before.state, OperationState::Running);
    assert_eq!(parent_queued.child_high_watermark, queued_key.into());
    assert!(!gate.is_released());
    assert_eq!(
        writes_while_queued,
        usize::try_from(after_prune_key + 1).unwrap()
    );
    let operator = fixture
        .h
        .auth
        .authenticate_user_control(
            &id("tx-retention-operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    // 新控制Call只撤P在该session的修改权，B的独立授权不变。
    let revoke_call = fixture.h.call_as(
        &operator,
        &fixture.target,
        "auth.revoke",
        json!({
            "actorId":fixture.h.actor.id(),"permissions":["device.modify"],"targets":[session]
        }),
    );
    let revoked = fixture.h.host.invoke(&operator, revoke_call).await.unwrap();
    let revoked = fixture.h.wait_as(&operator, &revoked.operation_id).await;
    let denied_key = queued_key + 1;
    let denied_payload = [0xa3, 0xb3, 0xc3, 0xd3];
    let denied_call = retention_child_call(&old_child, denied_key, &denied_payload);
    // 真实Host边界拒绝103，不把SDK本地AbortError当作当前撤权证据。
    let denied = fixture
        .h
        .host
        .invoke_child(&fixture.h.actor, denied_call)
        .await;
    let parent_after_denial = retention_operation(
        &fixture,
        json!({"operationId":accepted_parent.operation_id}),
    )
    .await;
    let denied_query = retention_query(
        &fixture,
        json!({"parentOperationId":accepted_parent.operation_id,"childKey":denied_key.to_string()}),
    )
    .await;
    let blocker_while_revoked =
        retention_operation(&fixture, json!({"operationId":blocker.operation_id})).await;
    let session_modify = fixture
        .h
        .auth
        .require(&fixture.h.actor, "device.modify", &session);
    let host_modify = fixture
        .h
        .auth
        .require(&fixture.h.actor, "device.modify", &fixture.target);
    let session_content = fixture
        .h
        .auth
        .require(&fixture.h.actor, "content.read", &session);
    let blocker_modify = fixture
        .h
        .auth
        .require(&blocker_actor, "device.modify", &session);
    let writes_after_denial = fixture.h.write_count();
    let gate_was_held = !gate.is_released();
    // 撤权回执确认规则提交。等真实 Node 收到取消后，再让父任务从处理器返回。
    assert_eq!(retention_marker(&cancel_observed_path).await, json!(true));
    gate.release();
    std::fs::write(&release_path, b"release").unwrap();
    let blocker = fixture
        .h
        .wait_as(&blocker_actor, &blocker.operation_id)
        .await;
    let queued_done = fixture.h.wait(&queued.operation_id).await;
    let parent = fixture.h.wait(&accepted_parent.operation_id).await;
    let after_prune_after_revoke = retention_operation(
        &fixture,
        json!({
            "parentOperationId":parent.operation_id,"childKey":after_prune_key.to_string()
        }),
    )
    .await;
    let queued_by_key = retention_operation(
        &fixture,
        json!({
            "parentOperationId":parent.operation_id,"childKey":queued_key.to_string()
        }),
    )
    .await;
    let first_after_revoke = retention_query(
        &fixture,
        json!({"parentOperationId":parent.operation_id,"childKey":"1"}),
    )
    .await;
    let rows_at_end = retained_child_rows(&fixture, &accepted_parent.operation_id).await;
    let events = std::fs::read_to_string(&events_path).unwrap();
    fixture.h.host.shutdown().await.unwrap();
    assert!(
        node.wait(),
        "Normal Host shutdown must actually reap its Node"
    );
    let writes = fixture.h.probe.writes.lock().unwrap().clone();

    assert_eq!(ready["calls"], 1);
    assert_eq!(parent_before.state, OperationState::Running);
    assert_eq!(parent_before.child_high_watermark, 1.into());
    assert_eq!(first_replay, first);
    assert_eq!(
        serde_json::from_str::<Operation>(raw_first.as_deref().unwrap()).unwrap(),
        first
    );
    assert!(pruned_first.is_none());
    assert!(
        matches!(root_replay, Err(ref error) if error.code=="RESULT_EXPIRED"),
        "{root_replay:?}"
    );
    assert!(
        matches!(expired_root_context, Err(ref error) if error.code=="RESULT_EXPIRED"),
        "{expired_root_context:?}"
    );
    assert!(
        matches!(same_old, Err(ref error) if error.code=="RESULT_EXPIRED"),
        "{same_old:?}"
    );
    assert!(
        matches!(different_old, Err(ref error) if error.code=="RESULT_EXPIRED"),
        "{different_old:?}"
    );
    assert!(
        matches!(old_query, Err(ref error) if error.code=="RESULT_EXPIRED"),
        "{old_query:?}"
    );
    assert_eq!(writes_before_prune, usize::try_from(H15_WATERMARK).unwrap());
    assert_eq!(writes_after_old, writes_before_prune);
    assert_eq!(parent_after_old.state, OperationState::Running);
    assert_eq!(parent_after_old.child_high_watermark, H15_WATERMARK.into());
    assert_eq!(rows_after_new_key, 1);
    assert_eq!(parent_after_prune.state, OperationState::Running);
    assert!(node_alive_before_revoke);
    assert_eq!(
        writes_after_prune_key,
        usize::try_from(after_prune_key).unwrap()
    );
    for (index, child) in retained_children.iter().enumerate() {
        let key = u64::try_from(index + 1).unwrap();
        assert_retained_tx(&parent, child, &session, key, &retained_payload(key));
        assert_ne!(after_prune.operation_id, child.operation_id);
        assert_ne!(after_prune.request_id, child.request_id);
        for previous in &retained_children[..index] {
            assert_ne!(child.operation_id, previous.operation_id);
            assert_ne!(child.request_id, previous.request_id);
        }
    }
    assert_retained_tx(
        &parent,
        &after_prune,
        &session,
        after_prune_key,
        &after_prune_payload,
    );
    assert_eq!(after_prune_replay, after_prune);
    assert_eq!(after_prune_after_revoke, after_prune);
    assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
    assert!(
        matches!(denied, Err(ref error) if error.code=="PERMISSION_DENIED"),
        "Host itself must reject103: {denied:?}"
    );
    assert_eq!(parent_after_denial.child_high_watermark, queued_key.into());
    assert!(
        matches!(denied_query, Err(ref error) if error.code=="NOT_FOUND"),
        "{denied_query:?}"
    );
    assert!(matches!(session_modify, Err(ref error) if error.code=="PERMISSION_DENIED"));
    assert!(host_modify.is_ok());
    assert!(session_content.is_ok());
    assert!(
        blocker_modify.is_ok(),
        "P's narrow revocation must leave the independent blocker authorized"
    );
    assert_eq!(blocker_while_revoked.state, OperationState::Running);
    assert!(gate_was_held);
    assert_eq!(writes_after_denial, writes_while_queued);
    assert_eq!(blocker.state, OperationState::Succeeded, "{blocker:?}");
    assert_eq!(support::receipt(&blocker).outcome, TxOutcome::Accepted);
    assert_eq!(
        support::receipt(&blocker).bytes_base64.as_str(),
        STANDARD.encode(blocker_payload)
    );
    assert!(
        matches!(
            queued_done.state,
            OperationState::Cancelled | OperationState::Failed | OperationState::Interrupted
        ),
        "{queued_done:?}"
    );
    assert!(
        queued_done.started_at.is_none(),
        "Queued child102 must never become dispatched"
    );
    let rejected = support::receipt(&queued_done);
    assert_eq!(rejected.outcome, TxOutcome::Rejected);
    assert_eq!(
        rejected.bytes_base64.as_str(),
        STANDARD.encode(queued_payload)
    );
    assert!(rejected.accepted_ranges.is_empty() && rejected.unknown_ranges.is_empty());
    assert!(matches!(
        rejected
            .backend_error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("CANCELLED" | "PERMISSION_DENIED")
    ));
    assert_eq!(queued_by_key, queued_done);
    assert!(
        matches!(&queued_done.admission, Admission::Child {parent_operation_id,child_key,..}
        if parent_operation_id==&parent.operation_id && child_key.get()==queued_key)
    );
    assert_eq!(queued_done.root_operation_id, parent.operation_id);
    assert_eq!(parent.state, OperationState::Interrupted, "{parent:?}");
    assert_eq!(parent.error.as_ref().unwrap().code, "PERMISSION_DENIED");
    assert!(parent.result.is_none());
    assert_eq!(parent.child_high_watermark, queued_key.into());
    assert_eq!(
        rows_at_end, 2,
        "Only newly accepted keys101/102 remain, not 100 permanent child tombstones"
    );
    assert!(
        matches!(first_after_revoke, Err(ref error) if error.code=="RESULT_EXPIRED"),
        "{first_after_revoke:?}"
    );
    assert_eq!(writes.len(), usize::try_from(after_prune_key + 1).unwrap());
    for (index, (_, bytes, wait)) in writes
        .iter()
        .take(usize::try_from(H15_WATERMARK).unwrap())
        .enumerate()
    {
        assert_eq!(bytes, &retained_payload(u64::try_from(index + 1).unwrap()));
        assert_eq!(*wait, Duration::from_millis(100));
    }
    assert!(
        writes
            .iter()
            .all(|(device, _, wait)| device == "tx-retention-live-parent"
                && *wait == Duration::from_millis(100))
    );
    assert_eq!(
        writes[usize::try_from(H15_WATERMARK).unwrap()].1.as_slice(),
        after_prune_payload.as_slice()
    );
    assert_eq!(
        writes.last().unwrap().1.as_slice(),
        blocker_payload.as_slice()
    );
    assert!(!writes.iter().any(
        |(_, bytes, _)| bytes.as_slice() == queued_payload.as_slice()
            || bytes.as_slice() == denied_payload.as_slice()
    ));
    assert_eq!(events, "start\nreleased\n");
    assert_eq!(std::fs::read_to_string(&events_path).unwrap(), events);
    eprintln!(
        "native_task_tx_retention logical_advance_ms={AFTER_TX_RETENTION_MS} actual_initial_tx=100 watermark_before_prune=100 actual_old_rows_pruned=100 old_same_and_changed=RESULT_EXPIRED old_root_context=RESULT_EXPIRED actual_key101=true key102_queued_before_revoke=true key102_terminal={:?} key102_not_dispatched=true key103_host_denied=true independent_blocker=Succeeded actual_writes=102 child_watermark=102 retained_child_rows=2 parent_abort_observed=true parent=Interrupted no_real_long_soak_claim=true",
        queued_done.state
    );
}
fn retained_payload(key: u64) -> Vec<u8> {
    if key == 1 {
        vec![1, 2, 3, 4]
    } else {
        vec![u8::try_from(key).unwrap(), 0x52, 0x54, 0x4e]
    }
}

fn retention_child_call(template: &ChildCall, key: u64, payload: &[u8]) -> ChildCall {
    let mut call = template.clone();
    call.child_key = serde_json::from_value(json!(key.to_string())).unwrap();
    call.params = serde_json::from_value(json!({
        "bytesBase64":STANDARD.encode(payload),"writeWaitMs":"100"
    }))
    .unwrap();
    call
}

fn assert_retained_tx(
    parent: &Operation,
    child: &Operation,
    session: &Target,
    key: u64,
    payload: &[u8],
) {
    assert_eq!(
        child.state,
        OperationState::Succeeded,
        "key={key} child={child:?}"
    );
    assert_eq!(child.action_id.as_str(), "session.tx");
    assert_eq!(child.root_operation_id, parent.operation_id);
    assert_eq!(child.actor_id, parent.actor_id);
    assert_eq!(child.execution_mode, ExecutionMode::Independent);
    assert_eq!(&child.target, session);
    assert_ne!(child.operation_id, parent.operation_id);
    assert_ne!(child.request_id, parent.request_id);
    assert!(
        matches!(&child.admission, Admission::Child {parent_operation_id,child_key,..}
        if parent_operation_id==&parent.operation_id && child_key.get()==key)
    );
    let receipt = support::receipt(child);
    assert_eq!(receipt.operation_id, child.operation_id);
    assert_eq!(receipt.session_id, session.id);
    assert_eq!(Some(receipt.session_epoch), session.session_epoch);
    assert_eq!(receipt.outcome, TxOutcome::Accepted);
    assert_eq!(receipt.bytes_base64.as_str(), STANDARD.encode(payload));
    assert_eq!(
        receipt.accepted_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: u64::try_from(payload.len()).unwrap().into()
        }]
    );
    assert!(receipt.unknown_ranges.is_empty());
    assert!(receipt.backend_error.is_none());
}

struct ReleaseRetainedWrite(Arc<support::Gate>);
impl Drop for ReleaseRetainedWrite {
    fn drop(&mut self) {
        self.0.release();
    }
}

struct ReleaseParent(PathBuf);
impl Drop for ReleaseParent {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.0, b"release");
    }
}

async fn retention_marker(path: &Path) -> Value {
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
            "Actual retention handler did not reach its file gate: path={} last={last_error:?}",
            path.display()
        )
    })
}

async fn retention_query(fixture: &TaskHost, selector: Value) -> HostResult<QueryResult> {
    fixture
        .h
        .host
        .query(
            &fixture.h.actor,
            call_query(&fixture.h.call(&fixture.target, "operation.get", selector)),
        )
        .await
}

async fn retention_operation(fixture: &TaskHost, selector: Value) -> Operation {
    let QueryResult::Operation(result) = retention_query(fixture, selector).await.unwrap() else {
        panic!("Expected public retention operation");
    };
    result.operation
}

async fn retained_tx_row(fixture: &TaskHost, operation: &Id) -> Option<String> {
    let database = fixture.h.dir.path().join("host-v0/state.sqlite3");
    let operation = operation.clone();
    tokio::task::spawn_blocking(move || {
        // 只读物理行以区分过期与删除，不绕过Store修改操作或保留期。
        let reader = rusqlite::Connection::open_with_flags(
            database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        reader.busy_timeout(Duration::from_secs(5)).unwrap();
        reader
            .query_row(
                "SELECT operation_json FROM operations WHERE operation_id=?1",
                [operation.as_str()],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    })
    .await
    .unwrap()
}

async fn retained_child_rows(fixture: &TaskHost, parent: &Id) -> u64 {
    let database = fixture.h.dir.path().join("host-v0/state.sqlite3");
    let parent = parent.clone();
    tokio::task::spawn_blocking(move || {
        // 只读实际operations行数，不能用过期查询或手改水位代替真实prune。
        let reader = rusqlite::Connection::open_with_flags(
            database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ).unwrap();
        reader.busy_timeout(Duration::from_secs(5)).unwrap();
        let count: i64 = reader.query_row(
            "SELECT count(*) FROM operations WHERE json_extract(operation_json,'$.admission.kind')='child' AND json_extract(operation_json,'$.admission.parentOperationId')=?1",
            [parent.as_str()], |row| row.get(0),
        ).unwrap();
        u64::try_from(count).expect("A row count cannot be negative")
    }).await.unwrap()
}
