//! 评审反例使用真实IPC、安装CAS、队列名额及生产30秒期限。
use super::*;

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_activation_review_session_privacy_precedes_existence() {
    let mut spec = node_host_actions::spec();
    spec.kind = ActionKind::Query;
    spec.target_kinds = vec![ResourceKind::try_from("session").unwrap()];
    let fixture = node_host_actions::Fixture::program(spec, b"export function register(c){c.queries.register('example.terminal.compute',q=>({value:q.params.value,calls:1}));return ()=>{};}").await;
    let caller = business_client(&fixture, false).await;
    let target = Target {
        host_id: fixture.target.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: id("private-missing-session"),
        session_id: Some(id("private-missing-session")),
        session_epoch: Some(1.into()),
    };
    let reply = caller
        .request(RpcRequest::Query(fixture.query_call(
            &caller,
            &target,
            "example.terminal.compute",
            json!({"value":10}),
        )))
        .await
        .unwrap();
    let _profile = fixture.finish().await;
    if let RpcReply::Failure { error, .. } = &reply {
        eprintln!("native_activation_session_privacy observed={}", error.code);
    }
    rejected(reply, "PERMISSION_DENIED");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_activation_review_stale_enqueue_cannot_replace_new_archive() {
    let markers = support::Profile::isolated("host-node-backend-activation-stale-");
    let events = markers.path().join("events.txt");
    let source = format!(
        "import {{appendFileSync}} from 'node:fs';export function register(){{appendFileSync({},'register-1\\n');throw Error('First registration fails');}}",
        serde_json::to_string(&events).unwrap()
    );
    let fixture = node_host_actions::Fixture::installed_program_with_activation(
        node_host_actions::spec(),
        source.as_bytes(),
        vec![id("example.terminal.compute")],
    )
    .await;
    let failed = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
            2,
        )
        .await;
    assert_eq!(failed.state, OperationState::Failed);
    let mut scan = fixture
        .host
        .inner
        .node_test_gates
        .recovery_before_scan
        .arm();
    scan.entered().await;
    let mut old_enqueue = fixture
        .host
        .inner
        .node_test_gates
        .activation_before_enqueue
        .arm();
    let mut new_enqueued = fixture
        .host
        .inner
        .node_test_gates
        .activation_request_enqueued
        .arm();
    let old_call = fixture.call(
        &fixture.client,
        &fixture.target,
        "example.terminal.compute",
        json!({"value":10}),
    );
    let (old_done, old_finished) = tokio::sync::oneshot::channel();
    let old_reply = async {
        let result = fixture
            .client
            .request(RpcRequest::Invoke(old_call))
            .await
            .unwrap();
        let _ = old_done.send(());
        result
    };
    let fresh_reply = async {
        old_enqueue.entered().await;
        let upgrade = super::super::super::upgrade_tests::upgrade_request(
            &fixture,
            &fixture.client,
            &events,
            false,
            2,
            3,
            vec![id("example.terminal.compute")],
        )
        .await;
        let installed = fixture.invoke(&fixture.client, upgrade).await;
        assert_eq!(
            fixture
                .wait(&fixture.client, &installed.operation_id)
                .await
                .state,
            OperationState::Succeeded
        );
        let fresh = fixture.client.request(RpcRequest::Invoke(fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":20}),
        )));
        tokio::pin!(fresh);
        tokio::select! {
            _ = new_enqueued.entered() => {},
            result = &mut fresh => panic!("New request did not enqueue while scan paused: {result:?}"),
        }
        new_enqueued.release();
        old_enqueue.release();
        // 修正后旧读者直接拒绝；反例中先被错误终结的是新归档请求。
        let reply = tokio::select! {
            _ = old_finished => {scan.release();fresh.await.unwrap()},
            reply = &mut fresh => {scan.release();reply.unwrap()},
        };
        reply
    };
    let (old_reply, fresh_reply) = tokio::join!(old_reply, fresh_reply);
    rejected(old_reply, "REVISION_CONFLICT");
    if let RpcReply::Failure { error, .. } = &fresh_reply {
        let code = error.code.clone();
        let _profile = fixture.finish().await;
        panic!("Old enqueue rejected the newer archive request: code={code}");
    }
    let fresh = accepted(fresh_reply);
    let settled = fixture.wait(&fixture.client, &fresh.operation_id).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    assert_eq!(settled.owner.version.as_deref(), Some("1.1.0"));
    let _profile = fixture.finish().await;
    let events = std::fs::read_to_string(events).unwrap();
    assert_eq!(
        events.lines().filter(|line| *line == "register-2").count(),
        1
    );
    assert_eq!(events.lines().filter(|line| *line == "call-2").count(), 1);
    eprintln!(
        "native_activation_stale_enqueue old=revision_conflict fresh=succeeded fresh_registrations=1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_activation_review_total_deadline_bounds_register_and_then_clears() {
    for expires in [true, false] {
        let markers = support::Profile::isolated("host-node-backend-activation-deadline-");
        let events = markers.path().join("events.txt");
        let entered = markers.path().join("registered.pid");
        let source = format!(
            "import {{appendFileSync,readFileSync,writeFileSync}} from 'node:fs';const path={};const event=s=>appendFileSync(path,s+'\\n');export async function register(c){{event('register');if(readFileSync(path,'utf8').split('\\n').filter(s=>s==='register').length===1)throw Error('Initial registration fails');writeFileSync({},String(process.pid));await new Promise(r=>setTimeout(r,{}));let calls=0;c.actions.register('example.terminal.compute',q=>{{event('call');return {{value:q.params.value,calls:++calls}};}});return ()=>event('dispose');}}",
            serde_json::to_string(&events).unwrap(),
            serde_json::to_string(&entered).unwrap(),
            if expires { 4500 } else { 0 }
        );
        let fixture = node_host_actions::Fixture::installed_program_with_activation(
            node_host_actions::spec(),
            source.as_bytes(),
            vec![id("example.terminal.compute")],
        )
        .await;
        let failed = fixture
            .mutate(
                &fixture.client,
                "node.packages.setEnabled",
                json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
                2,
            )
            .await;
        assert_eq!(failed.state, OperationState::Failed);
        let slot = fixture
            .host
            .inner
            .node_packages
            .hold_installation_for_test();
        let mut enqueued = fixture
            .host
            .inner
            .node_test_gates
            .activation_request_enqueued
            .arm();
        let started = std::time::Instant::now();
        let response = fixture.client.request(RpcRequest::Invoke(fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":10}),
        )));
        let observe = async {
            enqueued.entered().await;
            enqueued.release();
            tokio::time::sleep(Duration::from_secs(26)).await;
            drop(slot);
            tokio::time::timeout(Duration::from_secs(4), async {
                while !entered.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("Register must actually enter JavaScript before the total deadline");
            support::node_owner_exit::ProcessExit::observe(
                std::fs::read_to_string(&entered).unwrap().parse().unwrap(),
            )
        };
        let (response, mut native) = tokio::join!(response, observe);
        let response = response.unwrap();
        let mut completed = fixture
            .host
            .inner
            .node_test_gates
            .recovery_scan_completed
            .arm();
        completed.entered().await;
        completed.release();
        let QueryResult::NodePackageRuntime(before) = fixture
            .query(
                &fixture.client,
                &fixture.target,
                "node.packages.runtime",
                json!({"id":"example.terminal"}),
            )
            .await
        else {
            panic!("Expected runtime status");
        };
        if expires {
            rejected(response, "LIMIT_EXCEEDED");
            let exited = native.exited();
            let _profile = fixture.finish().await;
            eprintln!(
                "native_activation_total_deadline elapsed_ms={} phase={:?} owner_exited_before_cleanup={exited}",
                started.elapsed().as_millis(),
                before.phase
            );
            assert_ne!(
                before.phase,
                NodePackageRuntimePhase::Active,
                "Register published Active after the original total deadline"
            );
            assert_eq!(before.phase, NodePackageRuntimePhase::Failed);
            assert!(exited, "Deadline completion must wait actual owner exit");
            assert!(!std::fs::read_to_string(&events).unwrap().contains("call"));
        } else {
            let accepted = accepted(response);
            assert_eq!(
                fixture
                    .wait(&fixture.client, &accepted.operation_id)
                    .await
                    .state,
                OperationState::Succeeded
            );
            tokio::time::sleep(Duration::from_secs(5)).await;
            let probe = fixture
                .invoke(
                    &fixture.client,
                    fixture.call(
                        &fixture.client,
                        &fixture.target,
                        "example.terminal.compute",
                        json!({"value":20}),
                    ),
                )
                .await;
            assert_eq!(
                fixture
                    .wait(&fixture.client, &probe.operation_id)
                    .await
                    .state,
                OperationState::Succeeded
            );
            let QueryResult::NodePackageRuntime(after) = fixture
                .query(
                    &fixture.client,
                    &fixture.target,
                    "node.packages.runtime",
                    json!({"id":"example.terminal"}),
                )
                .await
            else {
                panic!("Expected active runtime");
            };
            assert_eq!(after.generation, before.generation);
            assert!(
                !native.exited(),
                "Completed registration must clear its temporary deadline"
            );
            let _profile = fixture.finish().await;
            assert!(native.exited());
            assert_eq!(
                std::fs::read_to_string(&events)
                    .unwrap()
                    .lines()
                    .filter(|line| *line == "register")
                    .count(),
                2
            );
            eprintln!(
                "native_activation_total_deadline cleared_after_registration=true owner_generation_preserved=true"
            );
        }
    }
}
