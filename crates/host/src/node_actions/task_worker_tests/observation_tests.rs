//! 真实循环进度与worker原生堆采样通过公共Operation和Host指标交付。
use super::*;
use serial_workbench_core::{HostMetrics, NodeMetrics};

const ITERATIONS: u64 = 4096;
const HEAP_VALUES: u64 = 131_072;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_worker_observation_coalesces_progress_and_retains_memory_after_cancel() {
    let markers = support::Profile::isolated("host-node-backend-worker-observation-");
    let events = markers.path().join("observation.events");
    let node_pid = markers.path().join("node.pid");
    let source = r#"
import {appendFileSync,writeFileSync} from 'node:fs';
import {isMainThread} from 'node:worker_threads';
const ITERATIONS=__ITERATIONS__,HEAP_VALUES=__HEAP_VALUES__;
const event=value=>appendFileSync(__EVENTS__,value+'\n');
if(!isMainThread){
  globalThis.observationHeap=Array.from({length:HEAP_VALUES},(_,index)=>({index,text:'observed-worker-'+index}));
  event('heap-ready:'+globalThis.observationHeap.length);
  setInterval(()=>{
    if(globalThis.observationHeap.length!==HEAP_VALUES)throw new Error('Worker heap was lost');
  },1000);
}
function compute(task,value){
  let completed=0,checksum=0,rejected=0;
  const report=done=>task.progress.report({completed:String(done),total:String(ITERATIONS),unit:'iterations'});
  const invalid=(name,update)=>{
    try{task.progress.report(update);event('invalid-progress:'+value+':'+name+':ACCEPTED');}
    catch(error){rejected++;event('invalid-progress:'+value+':'+name+':'+String(error?.code??'missing'));}
  };
  report(0);
  invalid('null',null);
  invalid('unknown',{completed:'0',total:String(ITERATIONS),unit:'iterations',extra:true});
  invalid('number',{completed:0,total:String(ITERATIONS),unit:'iterations'});
  // completed是实际完成的加法次数；报告洪泛不借心跳或等待次数充当业务工作。
  while(completed<ITERATIONS){completed++;checksum+=completed;report(completed);}
  invalid('backwards',{completed:String(ITERATIONS-1),total:String(ITERATIONS),unit:'iterations'});
  invalid('unit',{completed:String(ITERATIONS),total:String(ITERATIONS),unit:'other'});
  invalid('total',{completed:String(ITERATIONS),total:String(ITERATIONS+1),unit:'iterations'});
  event('computed:'+value+':'+completed+':'+checksum);
  return {checksum,rejected};
}
export function register(context){
  writeFileSync(__NODE_PID__,String(process.pid));let calls=0,lateReport;
  context.actions.register('example.terminal.compute',async(call,task)=>{
    const value=call.params.value,count=++calls;
    if(value===0){
      let lateCode='NOT_CAPTURED';
      if(lateReport){
        try{lateReport({completed:String(ITERATIONS),total:String(ITERATIONS),unit:'iterations'});lateCode='ACCEPTED';}
        catch(error){lateCode=String(error?.code??'missing');}
        event('late-progress:'+lateCode);
      }
      return {value,calls:count,lateCode};
    }
    if(value===2){
      const result=compute(task,value);lateReport=task.progress.report;
      return {value,calls:count,...result};
    }
    await Promise.resolve();
    const worker=context.workers.start('dist/main.mjs');
    const result=compute(task,value);
    const ended=await worker.finished;event('worker-finished:'+ended.exitCode);
    task.signal.throwIfAborted();
    if(ended.exitCode!==0)throw new Error('Observed worker did not finish');
    return {value,calls:count,...result};
  });return ()=>event('dispose');
}
"#
    .replace("__ITERATIONS__", &ITERATIONS.to_string())
    .replace("__HEAP_VALUES__", &HEAP_VALUES.to_string())
    .replace("__EVENTS__", &serde_json::to_string(&events).unwrap())
    .replace("__NODE_PID__", &serde_json::to_string(&node_pid).unwrap());
    let mut spec = node_host_actions::spec();
    spec.output_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "value":{"type":"number"},"calls":{"type":"integer"},
            "checksum":{"type":"integer"},"rejected":{"type":"integer"},
            "lateCode":{"type":"string"}
        },
        "required":["value","calls"],"additionalProperties":false
    }))
    .unwrap();
    let fixture = node_host_actions::Fixture::program_with_virtual(spec, source.as_bytes()).await;
    let pid = std::fs::read_to_string(&node_pid)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    let mut node = support::node_owner_exit::ProcessExit::observe(pid);
    let generation = runtime(&fixture, "example.terminal").await.generation;
    let mut capture = capture_tests::CaptureProbe::start(&fixture).await;
    let original = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":1}),
    );
    let accepted = fixture.invoke(&fixture.client, original.clone()).await;
    wait_worker_event(&events, &format!("heap-ready:{HEAP_VALUES}"), 1).await;
    let checksum = ITERATIONS * (ITERATIONS + 1) / 2;
    wait_worker_event(&events, &format!("computed:1:{ITERATIONS}:{checksum}"), 1).await;
    let running = wait_live_observation(&fixture, &accepted.operation_id).await;
    assert_progress(&running);
    assert_eq!(running.state, OperationState::Running);
    assert!(running.result.is_none());
    assert_coalesced(&accepted, &running);
    let live = running.worker_observation.as_ref().unwrap();
    assert_eq!(live.live_workers, 1.into());
    assert_eq!(live.peak_workers, 1.into());
    let memory = live.last_memory.as_ref().unwrap();
    assert_eq!(memory.measured_workers, 1.into());
    assert!(memory.v8_heap_used_bytes.get() > 0);
    let live_heap_bytes = memory.v8_heap_used_bytes;
    let live_metrics = wait_node_metrics(&fixture, pid, 1).await;
    let live_node = assert_node_metrics(&fixture, &live_metrics, pid, 1);
    assert!(live_node.peak_workers.get() >= 1);
    capture.phase(&fixture, b"observation-live-01").await;

    // 相邻真实任务也洪泛报告；非法更新拒绝后，原有效进度仍能成功结算。
    let short = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":2}),
            ),
        )
        .await;
    let short_settled = fixture.wait(&fixture.client, &short.operation_id).await;
    assert_eq!(
        short_settled.state,
        OperationState::Succeeded,
        "{short_settled:?}"
    );
    assert!(short_settled.error.is_none());
    assert_progress(&short_settled);
    assert_coalesced(&short, &short_settled);
    assert!(short_settled.worker_observation.is_none());
    assert_eq!(
        fixture.result(&fixture.client, &short_settled).await,
        json!({"value":2,"calls":2,"checksum":checksum,"rejected":6})
    );
    let recorded = read_events(&events);
    for value in [1, 2] {
        for invalid in ["null", "unknown", "number", "backwards", "unit", "total"] {
            assert!(
                recorded.contains(&format!(
                    "invalid-progress:{value}:{invalid}:INVALID_ARGUMENT\n"
                )),
                "{recorded}"
            );
        }
    }
    let probe = progress_probe(&fixture, 3).await;
    assert!(probe.progress.is_none());
    assert_eq!(
        operation(
            &fixture.client,
            &fixture.target,
            json!({"operationId":short.operation_id})
        )
        .await,
        short_settled,
        "A captured late report cannot change a terminal Operation"
    );
    assert!(!read_events(&events).contains("worker-finished:"));
    assert!(!node.exited());
    assert_eq!(
        runtime(&fixture, "example.terminal").await.generation,
        generation
    );
    capture.phase(&fixture, b"observation-neighbor-02").await;

    cancel_worker_task(&fixture, &accepted).await;
    let settled = worker_terminal(&fixture, &accepted).await.unwrap();
    assert_eq!(settled.state, OperationState::Cancelled, "{settled:?}");
    assert_progress(&settled);
    assert_coalesced(&accepted, &settled);
    let stopped = settled.worker_observation.as_ref().unwrap();
    assert_eq!(stopped.live_workers, 0.into());
    assert_eq!(stopped.peak_workers, 1.into());
    let retained_memory = stopped.last_memory.as_ref().unwrap().clone();
    assert_eq!(retained_memory.measured_workers, 1.into());
    assert!(retained_memory.v8_heap_used_bytes.get() > 0);
    assert!(read_events(&events).contains("worker-finished:1\n"));
    let stopped_metrics = wait_node_metrics(&fixture, pid, 0).await;
    let stopped_node = assert_node_metrics(&fixture, &stopped_metrics, pid, 0);
    assert!(stopped_node.peak_workers >= live_node.peak_workers);
    progress_probe(&fixture, 4).await;
    assert_eq!(fixture.invoke(&fixture.client, original).await, settled);
    let retained = operation(
        &fixture.client,
        &fixture.target,
        json!({"operationId":accepted.operation_id}),
    )
    .await;
    assert_eq!(retained, settled);
    assert_eq!(
        retained.worker_observation.as_ref().unwrap().last_memory,
        Some(retained_memory)
    );
    assert_eq!(read_events(&events).matches("heap-ready:").count(), 1);
    assert_eq!(
        runtime(&fixture, "example.terminal").await.generation,
        generation
    );
    assert!(!node.exited());
    capture.phase(&fixture, b"observation-cancelled-03").await;
    capture.finish(&fixture).await;
    let _profile = fixture.finish().await;
    assert!(
        node.wait(),
        "Normal Host shutdown must reap the actual observed Node"
    );
    eprintln!(
        "task_worker_observation actual_iterations_per_task={ITERATIONS} reports_coalesced=true invalid_reports_rejected=12 late_report_rejected=true heap_values={HEAP_VALUES} sampled_heap_bytes={} actual_node_pid={pid} node_rss_observed=true cancelled_live_zero=true last_memory_retained=true adjacent_task_succeeded=true same_node_generation=true virtual_capture_verified=true",
        live_heap_bytes.get()
    );
}

fn assert_progress(operation: &Operation) {
    let progress = operation.progress.as_ref().unwrap();
    assert_eq!(progress.completed, ITERATIONS.into());
    assert_eq!(progress.total, Some(ITERATIONS.into()));
    assert_eq!(progress.unit, "iterations");
}

fn assert_coalesced(accepted: &Operation, current: &Operation) {
    let revisions = current
        .revision
        .get()
        .checked_sub(accepted.revision.get())
        .unwrap();
    // 宽松地排除一报告一持久提交；不把观察吞吐量当作新的生产预算。
    assert!(
        revisions < ITERATIONS / 2,
        "Progress reports were not coalesced: {current:?}"
    );
}

async fn wait_live_observation(fixture: &node_host_actions::Fixture, id: &Id) -> Operation {
    let mut last = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let current =
                operation(&fixture.client, &fixture.target, json!({"operationId":id})).await;
            assert!(
                !current.state.is_terminal(),
                "Task ended before live sampling: {current:?}"
            );
            let progress_ready = current.progress.as_ref().is_some_and(|progress| {
                progress.completed.get() == ITERATIONS
                    && progress.total == Some(ITERATIONS.into())
                    && progress.unit == "iterations"
            });
            let memory_ready = current.worker_observation.as_ref().is_some_and(|workers| {
                workers.live_workers.get() == 1
                    && workers.peak_workers.get() == 1
                    && workers.last_memory.as_ref().is_some_and(|sample| {
                        sample.measured_workers.get() == 1 && sample.v8_heap_used_bytes.get() > 0
                    })
            });
            if current.state == OperationState::Running && progress_ready && memory_ready {
                return current;
            }
            last = Some(current);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!("Public worker progress/memory did not arrive within five seconds: {last:?}")
    })
}

async fn wait_node_metrics(
    fixture: &node_host_actions::Fixture,
    pid: u32,
    live: u64,
) -> HostMetrics {
    let mut last = None;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let QueryResult::HostMetrics(metrics) = fixture
                .query(&fixture.client, &fixture.target, "host.metrics", json!({}))
                .await
            else {
                panic!("Expected public Host metrics");
            };
            if metrics.node.as_ref().is_some_and(|node| {
                node.process_id.get() == u64::from(pid)
                    && node.live_workers.get() == live
                    && node.rss_bytes.is_some_and(|rss| rss.get() > 0)
            }) {
                return metrics;
            }
            last = Some(metrics);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!("Actual Node metrics did not converge within five seconds: {last:?}")
    })
}

fn assert_node_metrics<'a>(
    fixture: &node_host_actions::Fixture,
    metrics: &'a HostMetrics,
    pid: u32,
    live: u64,
) -> &'a NodeMetrics {
    assert_eq!(metrics.host_id, fixture.target.host_id);
    assert_eq!(
        metrics.instance_epoch,
        fixture.client.attachment().instance_epoch
    );
    assert_eq!(metrics.process_id.get(), u64::from(std::process::id()));
    let node = metrics.node.as_ref().unwrap();
    assert_eq!(node.process_id.get(), u64::from(pid));
    assert_ne!(node.process_id, metrics.process_id);
    assert_eq!(node.live_workers.get(), live);
    assert!(node.rss_bytes.unwrap().get() > 0);
    node
}

async fn progress_probe(fixture: &node_host_actions::Fixture, calls: u64) -> Operation {
    let accepted = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &fixture.target,
                "example.terminal.compute",
                json!({"value":0}),
            ),
        )
        .await;
    let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert!(settled.error.is_none());
    assert_eq!(
        fixture.result(&fixture.client, &settled).await,
        json!({"value":0,"calls":calls,"lateCode":"OPERATION_NOT_RUNNING"})
    );
    settled
}
