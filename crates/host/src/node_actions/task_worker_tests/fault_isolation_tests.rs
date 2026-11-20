//! 真实worker崩溃只结算所属任务，兄弟任务、别包与Rust采集继续。
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_worker_fault_preserves_sibling_other_package_and_capture() {
    let markers = support::Profile::isolated("host-node-backend-task-worker-fault-");
    let events = markers.path().join("worker.events");
    let node_pid = markers.path().join("node.pid");
    let fault_gate = markers.path().join("worker.fault");
    let graph_events = markers.path().join("graph.events");
    let source = format!(
        r#"import {{appendFileSync,writeFileSync,readFileSync,existsSync}} from 'node:fs';
import {{isMainThread,threadId}} from 'node:worker_threads';
const event=s=>appendFileSync({events},s+'\n');
if(!isMainThread){{
  event('worker-enter:'+threadId);const pause=new Int32Array(new SharedArrayBuffer(4));
  while(true){{
    if(existsSync({fault_gate})&&readFileSync({fault_gate},'utf8')===String(threadId)){{
      event('worker-crash:'+threadId);throw new Error('controlled isolated task worker fault');
    }}
    Atomics.wait(pause,0,0,10);
  }}
}}
export function register(context){{
  writeFileSync({node_pid},String(process.pid));let calls=0;
  context.actions.register('example.terminal.compute',async(call,task)=>{{
    const value=call.params.value;const count=++calls;
    if(value===0)return {{value,calls:count}};
    const worker=context.workers.start('dist/main.mjs');event('started:'+value);
    const ended=await worker.finished;event('finished:'+value+':'+ended.exitCode);
    task.signal.throwIfAborted();
    if(ended.exitCode!==0)throw new Error('worker failed');
    return {{value,calls:count}};
  }});return ()=>event('dispose');
}}"#,
        events = serde_json::to_string(&events).unwrap(),
        node_pid = serde_json::to_string(&node_pid).unwrap(),
        fault_gate = serde_json::to_string(&fault_gate).unwrap(),
    );
    let fixture = node_host_actions::Fixture::program_with_virtual(
        node_host_actions::spec(),
        source.as_bytes(),
    )
    .await;
    let graph_source = format!(
        "import {{appendFileSync}} from 'node:fs';export function register(context){{let calls=0;context.actions.register('example.graph.compute',call=>{{appendFileSync({},'call\\n');return {{value:call.params.value,calls:++calls}};}});return ()=>{{}};}}",
        serde_json::to_string(&graph_events).unwrap(),
    );
    let mut graph_spec = node_host_actions::spec();
    graph_spec.action_id = id("example.graph.compute");
    install_graph_child(&fixture, graph_spec, graph_source.as_bytes(), &graph_events).await;
    let pid = std::fs::read_to_string(&node_pid).unwrap().parse().unwrap();
    let mut node = support::node_owner_exit::ProcessExit::observe(pid);
    let before = runtime(&fixture, "example.terminal").await;
    let graph_before = runtime(&fixture, "example.graph").await;
    let graph_probe = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.graph.compute",
                json!({"value":0}),
            ),
        )
        .await;
    let graph_probe = fixture
        .wait(&fixture.client, &graph_probe.operation_id)
        .await;
    assert_eq!(
        graph_probe.state,
        OperationState::Succeeded,
        "{graph_probe:?}"
    );
    assert_eq!(
        fixture.result(&fixture.client, &graph_probe).await["calls"],
        1
    );
    let mut capture = capture_tests::CaptureProbe::start(&fixture).await;
    let first_call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":1}),
    );
    let first = fixture.invoke(&fixture.client, first_call.clone()).await;
    wait_worker_event(&events, "worker-enter:", 1).await;
    let first_thread = read_events(&events)
        .lines()
        .find_map(|line| line.strip_prefix("worker-enter:"))
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let second_call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":2}),
    );
    let second = fixture.invoke(&fixture.client, second_call.clone()).await;
    wait_worker_event(&events, "worker-enter:", 2).await;
    for task in [&first, &second] {
        assert_eq!(
            operation(
                &fixture.client,
                &fixture.target,
                json!({"operationId":task.operation_id})
            )
            .await
            .state,
            OperationState::Running
        );
    }
    capture.phase(&fixture, b"worker-before-fault-01").await;

    // gate只选择已进入的首worker；故障来自它自身throw，不能用terminate冒充崩溃。
    std::fs::write(&fault_gate, first_thread.to_string()).unwrap();
    let first_terminal = worker_terminal(&fixture, &first).await;
    let after_fault = read_events(&events);
    let second_observed = operation(
        &fixture.client,
        &fixture.target,
        json!({"operationId":second.operation_id}),
    )
    .await;
    let node_exited = node.exited();
    let fault_code = first_terminal
        .as_ref()
        .and_then(|task| task.error.as_ref())
        .map(|error| error.code.as_str());
    // 先固定产品退出与隔离事实，不能把夹具shutdown补作worker故障处理证据。
    if first_terminal.as_ref().map(|task| task.state) != Some(OperationState::Interrupted)
        || fault_code != Some("NODE_WORKER_INTERRUPTED")
        || !after_fault.contains(&format!("worker-crash:{first_thread}\n"))
        || !after_fault.contains("finished:1:1\n")
        || after_fault.contains("finished:2:")
        || second_observed.state != OperationState::Running
        || node_exited
    {
        let _profile = fixture.finish().await;
        panic!(
            "Task worker fault isolation failed before fixture cleanup: first={first_terminal:?} second={second_observed:?} node_exited={node_exited} events={after_fault:?}"
        );
    }
    let first_terminal = first_terminal.unwrap();
    assert_eq!(after_fault.matches("worker-crash:").count(), 1);
    if let Some(observation) = &first_terminal.worker_observation {
        assert_eq!(observation.live_workers, 0.into());
        assert_eq!(observation.peak_workers, 1.into());
    }
    for action in ["example.terminal.compute", "example.graph.compute"] {
        let accepted = fixture
            .invoke(
                &fixture.client,
                fixture.call(&fixture.client, &fixture.target, action, json!({"value":0})),
            )
            .await;
        let probe = fixture.wait(&fixture.client, &accepted.operation_id).await;
        assert_eq!(probe.state, OperationState::Succeeded, "{probe:?}");
        let value = fixture.result(&fixture.client, &probe).await;
        assert_eq!(value["value"], 0);
        assert_eq!(
            value["calls"],
            if action == "example.graph.compute" {
                2
            } else {
                3
            }
        );
    }
    assert_eq!(
        runtime(&fixture, "example.terminal").await.generation,
        before.generation
    );
    assert_eq!(
        runtime(&fixture, "example.graph").await.generation,
        graph_before.generation
    );
    assert_eq!(std::fs::read_to_string(&node_pid).unwrap(), pid.to_string());
    assert!(!node.exited());
    assert_eq!(
        fixture.invoke(&fixture.client, first_call).await,
        first_terminal
    );
    assert_eq!(read_events(&events).matches("worker-enter:").count(), 2);
    capture.phase(&fixture, b"worker-first-faulted-02").await;
    assert_eq!(
        operation(
            &fixture.client,
            &fixture.target,
            json!({"operationId":second.operation_id}),
        )
        .await
        .state,
        OperationState::Running
    );
    assert!(!read_events(&events).contains("finished:2:"));

    cancel_worker_task(&fixture, &second).await;
    let second_terminal = worker_terminal(&fixture, &second).await.unwrap();
    assert_eq!(
        second_terminal.state,
        OperationState::Cancelled,
        "{second_terminal:?}"
    );
    assert!(read_events(&events).contains("finished:2:1\n"));
    if let Some(observation) = &second_terminal.worker_observation {
        assert_eq!(observation.live_workers, 0.into());
    }
    assert_eq!(
        fixture.invoke(&fixture.client, second_call).await,
        second_terminal
    );
    assert_eq!(read_events(&events).matches("worker-enter:").count(), 2);
    assert!(!node.exited());
    capture.phase(&fixture, b"worker-sibling-stopped-03").await;
    capture.finish(&fixture).await;
    let _profile = fixture.finish().await;
    assert!(
        node.wait(),
        "Normal Host shutdown must reap its actual Node"
    );
    eprintln!(
        "task_worker_fault_isolation actual_throw=true actual_exit_before_interrupted=true sibling_running=true other_package_succeeded=true same_pid_generation=true replay_no_worker=true virtual_capture_verified=true normal_node_exit=true"
    );
}
