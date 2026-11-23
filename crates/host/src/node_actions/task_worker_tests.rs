//! 真实Operation持有worker，取消后以实际exit核对任务隔离。
use super::*;
use crate::test_support::{self as support, node_host_actions};

#[path = "task_worker_completion_tests.rs"]
mod completion_tests;

#[path = "task_worker_capture_tests.rs"]
mod capture_tests;

#[path = "task_worker_return_tests.rs"]
mod return_tests;

#[path = "task_worker_tests/observation_tests.rs"]
mod observation_tests;

#[path = "task_worker_tests/fault_isolation_tests.rs"]
mod fault_isolation_tests;

#[path = "task_worker_tests/node_restart_tests.rs"]
mod node_restart_tests;

#[path = "task_worker_tests/resource_limit_tests.rs"]
mod resource_limit_tests;

#[path = "task_worker_tests/raw_lane_tests.rs"]
mod raw_lane_tests;

#[path = "task_worker_tests/derived_lane_tests.rs"]
mod derived_lane_tests;

#[path = "task_worker_tests/session_hook_tests.rs"]
mod session_hook_tests;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_worker_cancel_preserves_sibling_and_other_package() {
    let markers = support::Profile::isolated("host-node-backend-task-worker-");
    let events = markers.path().join("worker.events");
    let node_pid = markers.path().join("node.pid");
    let graph_events = markers.path().join("graph.events");
    let source = format!(
        r#"import {{appendFileSync,writeFileSync}} from 'node:fs';
import {{isMainThread,threadId}} from 'node:worker_threads';
const event=s=>appendFileSync({events},s+'\n');
if(!isMainThread){{event('worker-enter:'+threadId);while(true){{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);}}}}
export function register(context){{
  writeFileSync({node_pid},String(process.pid));let calls=0;
  context.actions.register('example.terminal.compute',async(call,task)=>{{
    const value=call.params.value;const count=++calls;
    if(value===0)return {{value,calls:count}};
    await Promise.resolve();
    const worker=context.workers.start('dist/main.mjs');event('started:'+value);
    const ended=await worker.finished;event('finished:'+value+':'+ended.exitCode);
    task.signal.throwIfAborted();
    if(ended.exitCode!==0)throw new Error('worker failed');
    return {{value,calls:count}};
  }});return ()=>event('dispose');
}}"#,
        events = serde_json::to_string(&events).unwrap(),
        node_pid = serde_json::to_string(&node_pid).unwrap(),
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
    let second_call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":2}),
    );
    let second = fixture.invoke(&fixture.client, second_call.clone()).await;
    wait_worker_event(&events, "worker-enter:", 2).await;
    assert_eq!(
        operation(
            &fixture.client,
            &fixture.target,
            json!({"operationId":first.operation_id})
        )
        .await
        .state,
        OperationState::Running
    );
    assert_eq!(
        operation(
            &fixture.client,
            &fixture.target,
            json!({"operationId":second.operation_id})
        )
        .await
        .state,
        OperationState::Running
    );
    capture.phase(&fixture, b"worker-before-cancel-01").await;

    cancel_worker_task(&fixture, &first).await;
    let first_terminal = worker_terminal(&fixture, &first).await;
    let after_cancel = read_events(&events);
    let second_observed = operation(
        &fixture.client,
        &fixture.target,
        json!({"operationId":second.operation_id}),
    )
    .await;
    let node_exited = node.exited();
    // 失败时先冻结产品实际观察，再正常退出夹具，不能把shutdown的清理补作取消证据。
    if first_terminal.as_ref().map(|op| op.state) != Some(OperationState::Cancelled)
        || !after_cancel.contains("finished:1:1\n")
        || second_observed.state != OperationState::Running
        || node_exited
    {
        let _profile = fixture.finish().await;
        panic!(
            "Task worker isolation failed before fixture cleanup: first={first_terminal:?} second={second_observed:?} node_exited={node_exited} events={after_cancel:?}"
        );
    }
    let first_terminal = first_terminal.unwrap();
    assert!(!after_cancel.contains("finished:2:"));
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
    capture.phase(&fixture, b"worker-first-stopped-02").await;

    cancel_worker_task(&fixture, &second).await;
    let second_terminal = worker_terminal(&fixture, &second).await.unwrap();
    assert_eq!(
        second_terminal.state,
        OperationState::Cancelled,
        "{second_terminal:?}"
    );
    assert!(read_events(&events).contains("finished:2:1\n"));
    assert_eq!(
        fixture.invoke(&fixture.client, second_call).await,
        second_terminal
    );
    assert!(!node.exited());
    capture.phase(&fixture, b"worker-both-stopped-03").await;
    capture.finish(&fixture).await;
    let _profile = fixture.finish().await;
    assert!(
        node.wait(),
        "Normal Host shutdown must reap its actual Node"
    );
    eprintln!(
        "task_worker_cancel native_workers=2 actual_exit_before_cancelled=true sibling_running=true other_package_succeeded=true same_pid_generation=true replay_no_worker=true normal_node_exit=true"
    );
}

async fn runtime(fixture: &node_host_actions::Fixture, package: &str) -> NodePackageRuntimeStatus {
    let QueryResult::NodePackageRuntime(value) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "node.packages.runtime",
            json!({"id":package}),
        )
        .await
    else {
        panic!("Expected actual package runtime");
    };
    value
}

fn read_events(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

async fn wait_worker_event(path: &std::path::Path, prefix: &str, count: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if read_events(path)
                .lines()
                .filter(|line| line.starts_with(prefix))
                .count()
                >= count
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "Worker event did not arrive: prefix={prefix} events={:?}",
            read_events(path)
        )
    });
}

async fn cancel_worker_task(fixture: &node_host_actions::Fixture, task: &Operation) {
    let target = Target {
        kind: ResourceKind::try_from("operation").unwrap(),
        id: task.operation_id.clone(),
        ..fixture.target.clone()
    };
    let accepted = fixture
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
    let cancelled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(cancelled.state, OperationState::Succeeded, "{cancelled:?}");
}

async fn worker_terminal(
    fixture: &node_host_actions::Fixture,
    task: &Operation,
) -> Option<Operation> {
    let mut last = None;
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = operation(
                &fixture.client,
                &fixture.target,
                json!({"operationId":task.operation_id}),
            )
            .await;
            let terminal = value.state.is_terminal();
            last = Some(value);
            if terminal {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    if result.is_err() {
        eprintln!("task_worker_observation original_budget_seconds=5 last={last:?}");
        return None;
    }
    last
}
