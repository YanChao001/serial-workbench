//! 真实停止与实际worker panic之后，预核/新请求不能重开已关闭准入。
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_activation_close_quiesce_cannot_reinsert_prepared_request() {
    let fixture = dormant_failed_registration().await;
    let mut enqueue = fixture
        .host
        .inner
        .node_test_gates
        .activation_before_enqueue
        .arm();
    let mut signalled = fixture.host.inner.node_test_gates.quiesce_signalled.arm();
    let reply = {
        let request = fixture.client.request(RpcRequest::Invoke(fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":10}),
        )));
        tokio::pin!(request);
        tokio::select! {
            () = enqueue.entered() => {}
            _ = &mut request => panic!("The request must reach the activation admission gate"),
        }
        let manager = fixture.host.inner.node_packages.clone();
        let closing = tokio::task::spawn_blocking(move || manager.request_quiesce(true));
        signalled.entered().await;
        enqueue.release();
        let observed = tokio::time::timeout(Duration::from_secs(4), request).await;
        signalled.release();
        closing.await.unwrap();
        observed
    };
    wait_supervisor(&fixture).await;
    rejected(
        reply
            .expect("Admission must close before runtime quiesce completes")
            .unwrap(),
        "HOST_CLOSING",
    );
    let remaining = fixture
        .host
        .inner
        .node_packages
        .activation_request_count_for_test();
    let _profile = fixture.finish().await;
    eprintln!("native_activation_close kind=quiesce remaining_requests={remaining}");
    assert_eq!(
        remaining, 0,
        "A prechecked request reinserted after real quiesce"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_activation_close_supervisor_failure_keeps_future_admission_closed() {
    let fixture = dormant_failed_registration().await;
    fixture
        .host
        .inner
        .node_test_gates
        .fail_recovery_worker_once
        .store(true, std::sync::atomic::Ordering::Release);
    wait_supervisor(&fixture).await;
    let mut replies = Vec::new();
    for _ in 0..2 {
        replies.push(
            tokio::time::timeout(
                Duration::from_secs(5),
                fixture.client.request(RpcRequest::Invoke(fixture.call(
                    &fixture.client,
                    &fixture.target,
                    "example.terminal.compute",
                    json!({"value":10}),
                ))),
            )
            .await,
        );
    }
    let remaining = fixture
        .host
        .inner
        .node_packages
        .activation_request_count_for_test();
    let timeouts = replies.iter().filter(|reply| reply.is_err()).count();
    let _profile = fixture.finish().await;
    eprintln!(
        "native_activation_close kind=supervisor_failed actual_owned_job_finished=true remaining_requests={remaining} observation_timeouts={timeouts}"
    );
    assert_eq!(remaining, 0, "A dead supervisor retained future requests");
    for reply in replies {
        rejected(
            reply
                .expect("Future admission should fail within original five seconds")
                .unwrap(),
            "NODE_BACKEND_INTERRUPTED",
        );
    }
}

async fn wait_supervisor(fixture: &node_host_actions::Fixture) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let finished = {
                let jobs = fixture.host.inner.jobs.lock().unwrap();
                let supervisors = jobs
                    .handles
                    .iter()
                    .filter(|job| job.operation_id.lock().unwrap().is_none())
                    .collect::<Vec<_>>();
                assert_eq!(
                    supervisors.len(),
                    1,
                    "Fixture must identify its actual owned supervisor handle"
                );
                supervisors[0].handle.is_finished()
            };
            if finished {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Actual owned supervisor did not finish");
}

async fn dormant_failed_registration() -> node_host_actions::Fixture {
    let fixture = node_host_actions::Fixture::installed_program_with_activation(
        node_host_actions::spec(),
        b"export function register(){throw Error('Initial registration fails');}",
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
    assert_eq!(failed.state, OperationState::Failed, "{failed:?}");
    assert_eq!(
        failed.error.as_ref().unwrap().code,
        "NODE_REGISTRATION_FAILED"
    );
    fixture
}
