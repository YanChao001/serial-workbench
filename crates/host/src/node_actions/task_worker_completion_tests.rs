//! worker的实际退出、候选结果及handler最终确认分别结算。
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_worker_completion_fault_and_late_admission() {
    let markers = support::Profile::isolated("host-node-backend-worker-completion-");
    let events = markers.path().join("worker.events");
    let mode = markers.path().join("worker.mode");
    let release = markers.path().join("worker.release");
    let late = markers.path().join("late.release");
    let node_pid = markers.path().join("node.pid");
    let source = format!(
        r#"import {{appendFileSync,writeFileSync,readFileSync,existsSync}} from 'node:fs';
import {{isMainThread}} from 'node:worker_threads';
const event=s=>appendFileSync({events},s+'\n');
const delay=()=>new Promise(resolve=>setTimeout(resolve,5));
if(!isMainThread){{
  const mode=readFileSync({mode},'utf8');event('entered:'+mode);
  if(mode==='crash')throw new Error('controlled task worker fault');
  while(!existsSync({release}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
}}
export function register(context){{
  writeFileSync({node_pid},String(process.pid));let calls=0;
  context.actions.register('example.terminal.compute',async(call,task)=>{{
    const value=call.params.value,count=++calls;
    if(value===0)return {{value,calls:count}};
    if(value===4){{const child=await task.actions.invokeChild({{actionId:call.actionId,target:call.target,params:{{value:0}}}});event('child:'+child.operationId);}}
    await delay();const worker=context.workers.start('dist/main.mjs');
    void worker.finished.then(ended=>event('finished:'+value+':'+ended.exitCode));
    if(value===1){{
      void (async()=>{{
        while(!existsSync({late}))await delay();
        try{{context.workers.start('dist/main.mjs');event('late-worker:ACCEPTED');}}catch(error){{event('late-worker:'+error.code);}}
        try{{await task.actions.invokeChild({{actionId:call.actionId,target:call.target,params:{{value:0}}}});event('late-child:ACCEPTED');}}catch(error){{event('late-child:'+error.code);}}
        try{{await task.operations.get({{operationId:'00000000-0000-4000-8000-000000000001'}});event('late-read:ACCEPTED');}}catch(error){{event('late-read:'+error.code);}}
      }})();
      event('returned:1');return {{value,calls:count}};
    }}
    if(value===2){{event('returned:2');return {{value,calls:count}};}}
    if(value===3){{while(!readFileSync({events},'utf8').includes('entered:explicit'))await delay();await worker.terminate();return {{value,calls:count}};}}
    const ended=await worker.finished;
    if(value===5)return {{value,calls:count}};
    if(ended.exitCode!==0)throw new Error('worker did not finish');
    return {{value,calls:count}};
  }});return ()=>event('dispose');
}}"#,
        events = serde_json::to_string(&events).unwrap(),
        mode = serde_json::to_string(&mode).unwrap(),
        release = serde_json::to_string(&release).unwrap(),
        late = serde_json::to_string(&late).unwrap(),
        node_pid = serde_json::to_string(&node_pid).unwrap(),
    );
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
    let pid = std::fs::read_to_string(node_pid).unwrap().parse().unwrap();
    let mut node = support::node_owner_exit::ProcessExit::observe(pid);
    let generation = runtime(&fixture, "example.terminal").await.generation;

    std::fs::write(&mode, "early").unwrap();
    let early = start(&fixture, 1).await;
    wait_worker_event(&events, "returned:1", 1).await;
    wait_worker_event(&events, "entered:early", 1).await;
    let pending = operation(
        &fixture.client,
        &fixture.target,
        json!({"operationId":early.operation_id}),
    )
    .await;
    assert_eq!(pending.state, OperationState::Running, "{pending:?}");
    assert!(
        pending.result.is_none(),
        "Early return cannot publish a finished result"
    );
    std::fs::write(&late, b"go").unwrap();
    wait_worker_event(&events, "late-read:", 1).await;
    let late_events = read_events(&events);
    for kind in ["worker", "child", "read"] {
        assert!(
            late_events.contains(&format!("late-{kind}:OPERATION_NOT_RUNNING\n")),
            "{late_events}"
        );
    }
    cancel_worker_task(&fixture, &early).await;
    let cancelled = worker_terminal(&fixture, &early).await.unwrap();
    assert_eq!(cancelled.state, OperationState::Cancelled, "{cancelled:?}");
    assert_eq!(cancelled.child_high_watermark, 0.into());
    assert!(cancelled.result.is_none());
    assert!(read_events(&events).contains("finished:1:1\n"));

    std::fs::write(&mode, "natural").unwrap();
    let natural = start(&fixture, 2).await;
    wait_worker_event(&events, "returned:2", 1).await;
    wait_worker_event(&events, "entered:natural", 1).await;
    assert_eq!(
        operation(
            &fixture.client,
            &fixture.target,
            json!({"operationId":natural.operation_id})
        )
        .await
        .state,
        OperationState::Running
    );
    std::fs::write(&release, b"go").unwrap();
    let natural = fixture.wait(&fixture.client, &natural.operation_id).await;
    assert_eq!(natural.state, OperationState::Succeeded, "{natural:?}");
    assert_eq!(fixture.result(&fixture.client, &natural).await["value"], 2);
    assert!(read_events(&events).contains("finished:2:0\n"));
    std::fs::remove_file(&release).unwrap();

    std::fs::write(&mode, "explicit").unwrap();
    let explicit = start(&fixture, 3).await;
    let explicit = fixture.wait(&fixture.client, &explicit.operation_id).await;
    assert_eq!(explicit.state, OperationState::Succeeded, "{explicit:?}");
    assert_eq!(fixture.result(&fixture.client, &explicit).await["value"], 3);
    assert!(read_events(&events).contains("finished:3:1\n"));

    std::fs::write(&mode, "crash").unwrap();
    let crashed = start(&fixture, 4).await;
    let crashed = fixture.wait(&fixture.client, &crashed.operation_id).await;
    assert_eq!(crashed.state, OperationState::Interrupted, "{crashed:?}");
    assert_eq!(
        crashed.error.as_ref().unwrap().code,
        "NODE_WORKER_INTERRUPTED"
    );
    assert_eq!(crashed.child_high_watermark, 1.into());
    let child = operation(
        &fixture.client,
        &fixture.target,
        json!({"parentOperationId":crashed.operation_id,"childKey":"1"}),
    )
    .await;
    assert_eq!(child.state, OperationState::Succeeded, "{child:?}");
    let child_result = fixture.result(&fixture.client, &child).await;
    assert_eq!(child_result["value"], 0);
    assert!(!node.exited());

    let confirmed = start(&fixture, 5).await;
    let confirmed = fixture.wait(&fixture.client, &confirmed.operation_id).await;
    assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
    assert_eq!(
        fixture.result(&fixture.client, &confirmed).await["value"],
        5
    );
    let probe = start(&fixture, 0).await;
    assert_eq!(
        fixture
            .wait(&fixture.client, &probe.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    assert_eq!(
        runtime(&fixture, "example.terminal").await.generation,
        generation
    );
    assert!(!node.exited());
    let _profile = fixture.finish().await;
    assert!(node.wait());
    eprintln!(
        "task_worker_completion early_cancelled_after_exit=true late_worker_child_read_rejected=true natural_zero_exit_succeeded=true explicit_nonzero_handled=true fault_interrupted_child_result_preserved=true final_handler_confirmation_succeeded=true same_node_generation=true"
    );
}

async fn start(fixture: &node_host_actions::Fixture, value: i32) -> Operation {
    fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":value}),
            ),
        )
        .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_worker_failed_handler_has_a_bounded_native_cleanup() {
    let _reaper = support::node_owner_exit::ParentReaper::install();
    let markers = support::Profile::isolated("host-node-backend-worker-native-cleanup-");
    let events = markers.path().join("worker.events");
    let node_pid = markers.path().join("node.pid");
    let child_pid = markers.path().join("child.pid");
    let child = format!(
        "require('node:fs').writeFileSync({},String(process.pid));setInterval(()=>{{}},1000);",
        serde_json::to_string(&child_pid).unwrap()
    );
    let source = format!(
        r#"import {{appendFileSync,writeFileSync,existsSync}} from 'node:fs';
import {{isMainThread}} from 'node:worker_threads';import {{spawnSync}} from 'node:child_process';
const event=s=>appendFileSync({events},s+'\n');
if(!isMainThread){{event('worker-enter');spawnSync(process.execPath,['-e',{child}],{{windowsHide:true,stdio:'ignore'}});event('native-returned');}}
export function register(context){{
  writeFileSync({node_pid},String(process.pid));let calls=0;
  context.actions.register('example.terminal.compute',async call=>{{
    if(call.params.value===0)return {{value:0,calls:++calls}};
    const worker=context.workers.start('dist/main.mjs');
    void worker.finished.then(()=>event('worker-finished'));
    while(!existsSync({child_pid}))await new Promise(resolve=>setTimeout(resolve,5));
    event('handler-failed');throw new Error('controlled handler failure during native work');
  }});return ()=>event('dispose');
}}"#,
        events = serde_json::to_string(&events).unwrap(),
        child = serde_json::to_string(&child).unwrap(),
        node_pid = serde_json::to_string(&node_pid).unwrap(),
        child_pid = serde_json::to_string(&child_pid).unwrap(),
    );
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
    let mut node = support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(node_pid).unwrap().parse().unwrap(),
    );
    let original = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":1}),
    );
    let accepted = fixture.invoke(&fixture.client, original.clone()).await;
    wait_worker_event(&events, "handler-failed", 1).await;
    let mut child = support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(child_pid).unwrap().parse().unwrap(),
    );
    let probe = start(&fixture, 0).await;
    assert_eq!(
        fixture
            .wait(&fixture.client, &probe.operation_id)
            .await
            .state,
        OperationState::Succeeded
    );
    assert!(
        !read_events(&events).contains("worker-finished"),
        "This fixture must actually hold native cleanup"
    );
    assert!(!node.exited() && !child.exited());
    // 原5秒清理期限后仍需物理回收；此观察预算不改变普通Operation的5秒门槛。
    let actual_exit = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if node.exited() && child.exited() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    let frozen = read_events(&events);
    if actual_exit.is_err() {
        let _profile = fixture.finish().await;
        panic!("Product did not reap native cleanup before fixture shutdown: events={frozen:?}");
    }
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Unknown, "{settled:?}");
    assert_eq!(
        settled.error.as_ref().unwrap().code,
        "NODE_BACKEND_INTERRUPTED"
    );
    assert!(!frozen.contains("worker-finished"));
    assert_eq!(fixture.invoke(&fixture.client, original).await, settled);
    child.reap_adopted_after_observation();
    let _profile = fixture.finish().await;
    eprintln!(
        "task_worker_native_cleanup main_heartbeat_probe_succeeded=true actual_native_wait=true original_stop_budget_seconds=5 product_reaped_node_and_child_before_fixture_shutdown=true unknown_receipt_preserved=true replay_no_effect=true"
    );
}
