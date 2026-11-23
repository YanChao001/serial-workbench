//! 真实V8超额后以八个同时存活的worker核对包容量归还，不把非零退出冒充OOM。
use super::*;

struct ReleaseWorkersOnDrop<'a>(&'a std::path::Path);

impl Drop for ReleaseWorkersOnDrop<'_> {
    fn drop(&mut self) {
        let _ = std::fs::File::create_new(self.0);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_task_worker_v8_limit_releases_capacity_after_actual_exit() {
    let markers = support::Profile::isolated("host-node-backend-worker-v8-limit-");
    let events = markers.path().join("worker.events");
    let node_pid = markers.path().join("node.pid");
    let mode = markers.path().join("worker.mode");
    let release = markers.path().join("worker.release");
    let source = format!(
        r#"import {{appendFileSync,writeFileSync,readFileSync,existsSync}} from 'node:fs';
import {{isMainThread,threadId}} from 'node:worker_threads';
const event=s=>appendFileSync({events},s+'\n');
if(!isMainThread){{
  const mode=readFileSync({mode},'utf8');event('entered:'+mode+':'+threadId);
  if(mode==='oom'){{
    globalThis.retained=[];
    for(let batch=0;batch<4096;batch++)globalThis.retained.push(new Array(8192).fill(batch));
    event('allocation-returned');
  }}else{{
    const pause=new Int32Array(new SharedArrayBuffer(4));
    while(!existsSync({release}))Atomics.wait(pause,0,0,10);
    event('natural-return:'+threadId);
  }}
}}
export function register(context){{
  writeFileSync({node_pid},String(process.pid));let calls=0;
  const observeWorker=worker=>{{
    event('limits:'+JSON.stringify(worker.resourceLimits));
    worker.once('error',error=>event('native-error:'+error.code));
    worker.once('exit',exitCode=>event('native-exit:'+exitCode));
  }};
  process.on('worker',observeWorker);
  context.actions.register('example.terminal.compute',async(call,task)=>{{
    const value=call.params.value,count=++calls;event('call:'+value);
    if(value===0)return {{value,calls:count}};
    if(value===1){{
      writeFileSync({mode},'oom');const worker=context.workers.start('dist/main.mjs');
      const ended=await worker.finished;event('sdk-finished:oom:'+ended.exitCode);
      task.signal.throwIfAborted();
      if(ended.exitCode!==0)throw new Error('worker did not finish');
      return {{value,calls:count}};
    }}
    writeFileSync({mode},'capacity');const workers=[];
    for(let index=0;index<8;index++)workers.push(context.workers.start('dist/main.mjs'));
    try{{workers.push(context.workers.start('dist/main.mjs'));event('overflow:accepted');}}
    catch{{event('overflow:rejected');}}
    const ended=await Promise.all(workers.map(worker=>worker.finished));
    for(const result of ended){{
      event('sdk-finished:capacity:'+result.exitCode);
      if(result.exitCode!==0)throw new Error('capacity worker did not finish naturally');
    }}
    task.signal.throwIfAborted();return {{value,calls:count}};
  }});return ()=>{{process.off('worker',observeWorker);event('dispose');}};
}}"#,
        events = serde_json::to_string(&events).unwrap(),
        node_pid = serde_json::to_string(&node_pid).unwrap(),
        mode = serde_json::to_string(&mode).unwrap(),
        release = serde_json::to_string(&release).unwrap(),
    );
    let fixture =
        node_host_actions::Fixture::program(node_host_actions::spec(), source.as_bytes()).await;
    let pid: u32 = std::fs::read_to_string(&node_pid).unwrap().parse().unwrap();
    let mut node = support::node_owner_exit::ProcessExit::observe(pid);
    let before = runtime(&fixture, "example.terminal").await;
    let original = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":1}),
    );
    let accepted = fixture.invoke(&fixture.client, original.clone()).await;
    let exhausted = worker_terminal(&fixture, &accepted)
        .await
        .expect("The actual V8-limited worker did not settle within five seconds");
    let after_oom = read_events(&events);
    assert_eq!(
        exhausted.state,
        OperationState::Interrupted,
        "{exhausted:?} events={after_oom:?}"
    );
    assert_eq!(
        exhausted.error.as_ref().unwrap().code,
        "NODE_WORKER_INTERRUPTED"
    );
    assert!(exhausted.result.is_none());
    assert_eq!(after_oom.matches("entered:oom:").count(), 1);
    assert_eq!(
        after_oom
            .lines()
            .filter(|line| *line == "native-error:ERR_WORKER_OUT_OF_MEMORY")
            .count(),
        1,
        "The native error must prove a memory limit, rather than an unrelated worker fault: {after_oom}"
    );
    assert!(after_oom.contains("native-exit:1\n"), "{after_oom}");
    assert!(after_oom.contains("sdk-finished:oom:1\n"), "{after_oom}");
    assert!(!after_oom.contains("allocation-returned"), "{after_oom}");
    let limits: serde_json::Value = serde_json::from_str(
        after_oom
            .lines()
            .find_map(|line| line.strip_prefix("limits:"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(limits["maxOldGenerationSizeMb"], 64);
    assert_eq!(limits["maxYoungGenerationSizeMb"], 8);
    assert_eq!(limits["stackSizeMb"], 4);
    if let Some(observation) = &exhausted.worker_observation {
        assert_eq!(observation.live_workers, 0.into());
        assert_eq!(observation.peak_workers, 1.into());
    }
    assert!(!node.exited());
    assert_eq!(std::fs::read_to_string(&node_pid).unwrap(), pid.to_string());
    assert_eq!(
        runtime(&fixture, "example.terminal").await.generation,
        before.generation
    );

    let capacity_call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":2}),
    );
    let _release_workers = ReleaseWorkersOnDrop(&release);
    let capacity = fixture.invoke(&fixture.client, capacity_call.clone()).await;
    wait_worker_event(&events, "overflow:rejected", 1).await;
    wait_worker_event(&events, "entered:capacity:", 8).await;
    // Node emits the parent worker event on a separate next tick.
    wait_worker_event(&events, "limits:", 9).await;
    let held = read_events(&events);
    // 同时持有全部八席才能发现超额worker退出后仍泄漏一个名额的情况。
    assert_eq!(held.matches("entered:capacity:").count(), 8);
    assert_eq!(held.matches("limits:").count(), 9);
    assert_eq!(held.matches("overflow:rejected").count(), 1);
    assert!(!held.contains("overflow:accepted"), "{held}");
    assert!(!held.contains("natural-return:"), "{held}");
    assert_eq!(
        operation(
            &fixture.client,
            &fixture.target,
            json!({"operationId":capacity.operation_id}),
        )
        .await
        .state,
        OperationState::Running
    );
    assert!(!node.exited());
    // 文件只释放本测试的自然完成条件，不调用terminate或改产品停止期限。
    std::fs::write(&release, b"release").unwrap();
    let capacity = fixture.wait(&fixture.client, &capacity.operation_id).await;
    assert_eq!(capacity.state, OperationState::Succeeded, "{capacity:?}");
    assert_eq!(
        fixture.result(&fixture.client, &capacity).await,
        json!({"value":2,"calls":2})
    );
    let after_capacity = read_events(&events);
    assert_eq!(after_capacity.matches("natural-return:").count(), 8);
    assert_eq!(after_capacity.matches("sdk-finished:capacity:0").count(), 8);
    assert_eq!(after_capacity.matches("native-exit:0").count(), 8);
    if let Some(observation) = &capacity.worker_observation {
        assert_eq!(observation.live_workers, 0.into());
        assert_eq!(observation.peak_workers, 8.into());
    }
    assert_eq!(fixture.invoke(&fixture.client, original).await, exhausted);
    assert_eq!(
        fixture.invoke(&fixture.client, capacity_call).await,
        capacity
    );
    assert_eq!(read_events(&events), after_capacity);
    let probe = fixture
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
    let probe = fixture.wait(&fixture.client, &probe.operation_id).await;
    assert_eq!(probe.state, OperationState::Succeeded, "{probe:?}");
    assert_eq!(
        fixture.result(&fixture.client, &probe).await,
        json!({"value":0,"calls":3})
    );
    assert_eq!(
        runtime(&fixture, "example.terminal").await.generation,
        before.generation
    );
    assert_eq!(std::fs::read_to_string(&node_pid).unwrap(), pid.to_string());
    assert!(!node.exited());
    let _profile = fixture.finish().await;
    assert!(
        node.wait(),
        "Normal Host shutdown must reap its actual Node"
    );
    let final_events = read_events(&events);
    assert_eq!(final_events.matches("entered:oom:").count(), 1);
    assert_eq!(final_events.matches("entered:capacity:").count(), 8);
    assert_eq!(final_events.matches("call:1\n").count(), 1);
    assert_eq!(final_events.matches("call:2\n").count(), 1);
    assert_eq!(final_events.matches("call:0\n").count(), 1);
    eprintln!(
        "task_worker_v8_limit native_oom_error=true actual_exit_before_interrupted=true original_limits_64_8_4=true capacity_eight_restored=true ninth_rejected=true eight_natural_exits=true same_pid_generation=true replay_no_allocation=true fresh_business_succeeded=true normal_node_exit=true"
    );
}
