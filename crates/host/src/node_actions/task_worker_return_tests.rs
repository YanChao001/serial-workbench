//! 返回值归一化和JSON getter仍遵守真实任务归属及准入关闭。
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_worker_return_getters_cannot_escape_task_ownership() {
    let markers = support::Profile::isolated("host-node-backend-worker-return-");
    let events = markers.path().join("return.events");
    let node_pid = markers.path().join("node.pid");
    let source = format!(
        r#"import {{appendFileSync,writeFileSync}} from 'node:fs';
import {{isMainThread}} from 'node:worker_threads';
const event=s=>appendFileSync({events},s+'\n');
if(!isMainThread){{event('worker-enter');while(true)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);}}
export function register(context){{
  writeFileSync({node_pid},String(process.pid));let calls=0;
  context.actions.register('example.terminal.compute',(call,task)=>{{
    const value=call.params.value,count=++calls;
    if(value===1)return {{get value(){{
      try{{context.workers.start('dist/main.mjs');event('json-worker:ACCEPTED');}}catch(error){{event('json-worker:'+error.code);}}
      void task.actions.invokeChild({{actionId:call.actionId,target:call.target,params:{{value:3}}}}).then(()=>event('json-child:ACCEPTED'),error=>event('json-child:'+error.code));
      void task.operations.get({{operationId:'00000000-0000-4000-8000-000000000001'}}).then(()=>event('json-read:ACCEPTED'),error=>event('json-read:'+error.code));
      return value;
    }},calls:count}};
    if(value===2){{
      let started=false;return Object.defineProperty({{value,calls:count}},'then',{{get(){{
        if(!started){{started=true;const worker=context.workers.start('dist/main.mjs');event('then-started');void worker.finished.then(ended=>event('then-finished:'+ended.exitCode));}}
        return undefined;
      }}}});
    }}
    return {{value,calls:count}};
  }});return ()=>event('dispose');
}}"#,
        events = serde_json::to_string(&events).unwrap(),
        node_pid = serde_json::to_string(&node_pid).unwrap(),
    );
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
    let mut node = support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(node_pid).unwrap().parse().unwrap(),
    );
    let generation = runtime(&fixture, "example.terminal").await.generation;
    let json_task = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":1}),
            ),
        )
        .await;
    let json_task = fixture.wait(&fixture.client, &json_task.operation_id).await;
    assert_eq!(json_task.state, OperationState::Succeeded, "{json_task:?}");
    assert_eq!(
        fixture.result(&fixture.client, &json_task).await["value"],
        1
    );
    let json_events = read_events(&events);
    let escaped = json_events.contains("json-worker:ACCEPTED");
    if escaped {
        wait_worker_event(&events, "worker-enter", 1).await;
    }
    let initial_workers = read_events(&events).matches("worker-enter").count();
    let original = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":2}),
    );
    let accepted = fixture.invoke(&fixture.client, original.clone()).await;
    wait_worker_event(&events, "then-started", 1).await;
    wait_worker_event(&events, "worker-enter", initial_workers + 1).await;
    let observed = operation(
        &fixture.client,
        &fixture.target,
        json!({"operationId":accepted.operation_id}),
    )
    .await;
    let settled = if observed.state == OperationState::Running {
        cancel_worker_task(&fixture, &accepted).await;
        worker_terminal(&fixture, &accepted).await
    } else {
        Some(observed.clone())
    };
    let frozen = read_events(&events);
    let node_alive = !node.exited();
    let current_generation = runtime(&fixture, "example.terminal").await.generation;
    let probe = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":3}),
            ),
        )
        .await;
    let probe = fixture.wait(&fixture.client, &probe.operation_id).await;
    let replay = fixture.invoke(&fixture.client, original).await;
    let _profile = fixture.finish().await;
    assert!(node.wait());
    assert!(
        !escaped && json_events.contains("json-worker:OPERATION_NOT_RUNNING\n"),
        "JSON getter escaped: {json_events}"
    );
    for kind in ["child", "read"] {
        assert!(
            frozen.contains(&format!("json-{kind}:OPERATION_NOT_RUNNING\n")),
            "{frozen}"
        );
    }
    assert_eq!(json_task.child_high_watermark, 0.into());
    assert_eq!(
        observed.state,
        OperationState::Running,
        "then getter did not retain its worker: {observed:?} events={frozen}"
    );
    let settled = settled.unwrap();
    assert_eq!(settled.state, OperationState::Cancelled, "{settled:?}");
    assert!(frozen.contains("then-finished:1\n"), "{frozen}");
    assert_eq!(frozen.matches("worker-enter").count(), 1);
    assert!(node_alive);
    assert_eq!(current_generation, generation);
    assert_eq!(probe.state, OperationState::Succeeded, "{probe:?}");
    assert_eq!(replay, settled);
    eprintln!(
        "task_worker_return json_getter_worker_child_read_rejected=true sync_then_getter_worker_owned=true actual_exit_before_cancelled=true same_node_generation=true replay_stable=true"
    );
}
