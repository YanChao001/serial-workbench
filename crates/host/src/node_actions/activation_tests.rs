//! 真实Host启动扫描与实际贡献调用分开观察，不把attach成功当作未导入证明。
use super::*;

#[path = "activation_review_tests.rs"]
mod review_tests;

#[path = "activation_close_tests.rs"]
mod close_tests;

#[path = "activation_child_tests.rs"]
mod child_tests;

fn accepted(reply: RpcReply) -> Operation {
    let RpcReply::Success { result, .. } = reply else {
        panic!("Expected accepted action: {reply:?}");
    };
    let RpcResult::Operation(result) = *result else {
        panic!("Expected operation receipt");
    };
    result.operation
}
fn rejected(reply: RpcReply, code: &str) {
    let RpcReply::Failure { error, .. } = reply else {
        panic!("Expected rejected action: {reply:?}");
    };
    assert_eq!(error.code, code, "{error:?}");
}
async fn wait_scan(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Actual startup recovery scan did not finish");
}
async fn business_client(fixture: &node_host_actions::Fixture, grant: bool) -> HostClient {
    let client = HostClient::connect(ConnectOptions::new(
        fixture.dir.path().to_path_buf(),
        id("activation-business"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    if grant {
        let authorized = fixture.invoke(&fixture.user, fixture.call(&fixture.user, &fixture.target, "auth.authorize", json!({"clientId":client.attachment().client_id,"permissions":["content.read"],"targets":[fixture.target]}))).await;
        assert_eq!(
            fixture
                .wait(&fixture.user, &authorized.operation_id)
                .await
                .state,
            OperationState::Succeeded
        );
    }
    client
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_contribution_activation_waits_for_business_after_host_restart() {
    for kind in [ActionKind::Action, ActionKind::Query] {
        let markers = support::Profile::isolated("host-node-backend-activation-");
        let events = markers.path().join("events.txt");
        let scanned = markers.path().join("host.scanned");
        let registration = if kind == ActionKind::Query {
            "queries"
        } else {
            "actions"
        };
        let source = format!(
            "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(context){{event('register');let calls=0;context.{registration}.register('example.terminal.compute',call=>{{event('call');return {{value:call.params.value+0.25,calls:++calls}};}});return ()=>event('dispose');}}",
            serde_json::to_string(&events).unwrap()
        );
        let mut spec = node_host_actions::spec();
        spec.kind = kind;
        let fixture = node_host_actions::Fixture::installed_program_with_activation(
            spec,
            source.as_bytes(),
            vec![id("example.terminal.compute")],
        )
        .await;
        let enabled = fixture
            .mutate(
                &fixture.client,
                "node.packages.setEnabled",
                json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
                2,
            )
            .await;
        assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
        assert_eq!(std::fs::read_to_string(&events).unwrap(), "register\n");
        let target = fixture.target.clone();
        let profile = fixture.finish().await;
        assert_eq!(
            std::fs::read_to_string(&events).unwrap(),
            "register\ndispose\n"
        );
        let mut host = OwnedHost::start_with_scan_marker(
            profile.path(),
            markers.path(),
            "contribution",
            Some(&scanned),
        )
        .await;
        let client = HostClient::connect(ConnectOptions::new(
            profile.path().to_path_buf(),
            id("action-client"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        wait_scan(&scanned).await;
        let after_scan = std::fs::read_to_string(&events).unwrap();
        if after_scan != "register\ndispose\n" {
            host.finish().await;
            panic!(
                "Contribution-only package was imported by Host startup: kind={kind:?} events={after_scan:?}"
            );
        }
        let QueryResult::NodePackageRuntime(status) = query(
            &client,
            &target,
            "node.packages.runtime",
            json!({"id":"example.terminal"}),
        )
        .await
        else {
            panic!("Expected runtime status");
        };
        assert_eq!(status.phase, NodePackageRuntimePhase::Inactive);
        assert_eq!(status.generation, 0.into());
        let check = client.request(RpcRequest::Query(call_query(&call(&client, &target, "action.check", json!({"actionId":"example.terminal.compute","target":target,"params":{"value":10}}))))).await.unwrap();
        assert!(
            matches!(check, RpcReply::Failure { .. }),
            "Dormant preflight cannot pretend a registered handler: {check:?}"
        );
        let QueryResult::Catalog(catalog) =
            query(&client, &target, "catalog.list", json!({"pageSize":"100"})).await
        else {
            panic!("Expected catalog");
        };
        assert!(
            !catalog
                .items
                .iter()
                .any(|spec| spec.action_id.as_str() == "example.terminal.compute")
        );
        assert_eq!(std::fs::read_to_string(&events).unwrap(), after_scan);
        let request = call(
            &client,
            &target,
            "example.terminal.compute",
            json!({"value":10}),
        );
        if kind == ActionKind::Action {
            let accepted = invoke(&client, request.clone()).await;
            let settled = wait(&client, &target, &accepted.operation_id).await;
            assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
            assert_eq!(invoke(&client, request).await, settled);
        } else {
            let QueryResult::Extension(value) = query(
                &client,
                &target,
                "example.terminal.compute",
                json!({"value":10}),
            )
            .await
            else {
                panic!("Expected lazy query output");
            };
            assert_eq!(
                serde_json::to_value(value).unwrap(),
                json!({"value":10.25,"calls":1})
            );
        }
        let QueryResult::NodePackageRuntime(status) = query(
            &client,
            &target,
            "node.packages.runtime",
            json!({"id":"example.terminal"}),
        )
        .await
        else {
            panic!("Expected active runtime");
        };
        assert_eq!(status.phase, NodePackageRuntimePhase::Active);
        host.finish().await;
        assert_eq!(
            std::fs::read_to_string(&events).unwrap(),
            "register\ndispose\nregister\ncall\ndispose\n"
        );
        eprintln!(
            "native_contribution_activation kind={kind:?} startup_scan_completed=true startup_imports=0 check_imports=0 registrations=2 business_calls=1"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_concurrent_activation_preserves_each_caller_and_failure_receipt() {
    for scenario in ["success", "caller-revoked", "registration-failed"] {
        let markers = support::Profile::isolated("host-node-backend-activation-join-");
        let events = markers.path().join("events.txt");
        let source = format!(
            "import {{appendFileSync,readFileSync}} from 'node:fs';const path={};const event=s=>appendFileSync(path,s+'\\n');export function register(context){{event('register');const n=readFileSync(path,'utf8').split('\\n').filter(s=>s==='register').length;if(n===1||{})throw Error('Expected registration failure');let calls=0;context.actions.register('example.terminal.compute',call=>{{event('call');return {{value:call.params.value,calls:++calls}};}});return ()=>event('dispose');}}",
            serde_json::to_string(&events).unwrap(),
            scenario == "registration-failed"
        );
        let fixture = node_host_actions::Fixture::installed_program_with_activation(
            node_host_actions::spec(),
            source.as_bytes(),
            vec![id("example.terminal.compute")],
        )
        .await;
        let caller = business_client(&fixture, true).await;
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
        let mut scanned = fixture
            .host
            .inner
            .node_test_gates
            .recovery_scan_completed
            .arm();
        scanned.entered().await;
        scanned.release();
        assert_eq!(std::fs::read_to_string(&events).unwrap(), "register\n");
        let first = fixture.call(
            &fixture.client,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":10}),
        );
        let second = fixture.call(
            &caller,
            &fixture.target,
            "example.terminal.compute",
            json!({"value":20}),
        );
        let mut restoring = fixture
            .host
            .inner
            .node_test_gates
            .recovery_before_restore
            .arm();
        let mut joining = fixture
            .host
            .inner
            .node_test_gates
            .activation_request_joined
            .arm();
        let first_reply = fixture.client.request(RpcRequest::Invoke(first.clone()));
        let second_reply = async {
            restoring.entered().await;
            let response = caller.request(RpcRequest::Invoke(second.clone()));
            tokio::pin!(response);
            tokio::select! {
                _ = joining.entered() => {},
                result = &mut response => panic!("Second caller did not join actual pending work: {result:?}"),
            }
            if scenario == "caller-revoked" {
                let revoked = fixture.invoke(&fixture.user, fixture.call(&fixture.user, &fixture.target, "auth.revoke", json!({"actorId":caller.attachment().actor_id,"permissions":["content.read"],"targets":[fixture.target]}))).await;
                assert_eq!(
                    fixture
                        .wait(&fixture.user, &revoked.operation_id)
                        .await
                        .state,
                    OperationState::Succeeded
                );
            }
            joining.release();
            restoring.release();
            response.await
        };
        let (first_reply, second_reply) = tokio::join!(first_reply, second_reply);
        if scenario == "registration-failed" {
            rejected(first_reply.unwrap(), "NODE_REGISTRATION_FAILED");
            rejected(second_reply.unwrap(), "NODE_REGISTRATION_FAILED");
            let mut scanned = fixture
                .host
                .inner
                .node_test_gates
                .recovery_scan_completed
                .arm();
            scanned.entered().await;
            scanned.release();
            assert_eq!(
                std::fs::read_to_string(&events).unwrap(),
                "register\nregister\n"
            );
            // 新业务请求才允许再次尝试，失败本身不生成重试资格或业务Operation。
            rejected(
                fixture
                    .client
                    .request(RpcRequest::Invoke(first.clone()))
                    .await
                    .unwrap(),
                "NODE_REGISTRATION_FAILED",
            );
            let missing = fixture.client.request(RpcRequest::Query(fixture.query_call(&fixture.client, &fixture.target, "operation.get", json!({"actorId":first.actor_id,"requestId":first.request_id,"requestContext":first.request_context})))).await.unwrap();
            rejected(missing, "NOT_FOUND");
        } else {
            let first = accepted(first_reply.unwrap());
            let first = fixture.wait(&fixture.client, &first.operation_id).await;
            assert_eq!(first.state, OperationState::Succeeded, "{first:?}");
            if scenario == "caller-revoked" {
                rejected(second_reply.unwrap(), "PERMISSION_DENIED");
            } else {
                let second = accepted(second_reply.unwrap());
                let second = fixture.wait(&caller, &second.operation_id).await;
                assert_eq!(second.state, OperationState::Succeeded, "{second:?}");
                assert_ne!(first.operation_id, second.operation_id);
            }
        }
        let _profile = fixture.finish().await;
        let events = std::fs::read_to_string(&events).unwrap();
        let registrations = events.lines().filter(|line| *line == "register").count();
        let calls = events.lines().filter(|line| *line == "call").count();
        assert_eq!(
            registrations,
            if scenario == "registration-failed" {
                3
            } else {
                2
            }
        );
        assert_eq!(
            calls,
            match scenario {
                "success" => 2,
                "caller-revoked" => 1,
                _ => 0,
            }
        );
        eprintln!(
            "native_activation_join scenario={scenario} actual_join_observed=true registrations={registrations} business_calls={calls}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_lazy_activation_rechecks_origin_and_business_authority() {
    for denied in ["origin", "caller"] {
        let markers = support::Profile::isolated("host-node-backend-activation-denied-");
        let events = markers.path().join("events.txt");
        let scanned = markers.path().join("host.scanned");
        let source = format!(
            "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(context){{event('register');context.actions.register('example.terminal.compute',call=>{{event('call');return {{value:call.params.value,calls:1}};}});return ()=>event('dispose');}}",
            serde_json::to_string(&events).unwrap()
        );
        let fixture = node_host_actions::Fixture::installed_program_with_activation(
            node_host_actions::spec(),
            source.as_bytes(),
            vec![id("example.terminal.compute")],
        )
        .await;
        let caller = business_client(&fixture, denied == "origin").await;
        let enabled = fixture
            .mutate(
                &fixture.client,
                "node.packages.setEnabled",
                json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
                2,
            )
            .await;
        assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
        if denied == "origin" {
            let revoked = fixture.invoke(&fixture.user, fixture.call(&fixture.user, &fixture.target, "auth.revoke", json!({"actorId":fixture.client.attachment().actor_id,"permissions":["plugins.manage"],"targets":[fixture.target]}))).await;
            assert_eq!(
                fixture
                    .wait(&fixture.user, &revoked.operation_id)
                    .await
                    .state,
                OperationState::Succeeded
            );
        }
        let target = fixture.target.clone();
        drop(caller);
        let shutdown = fixture
            .host
            .quiesce(ShutdownMode::CancelAndSettle)
            .await
            .unwrap();
        assert!(shutdown.completed, "{shutdown:?}");
        let before_restart = std::fs::read_to_string(&events).unwrap();
        if denied == "origin" {
            // 原A失效后可直接终止容器，不要求继续执行JS清理；关停责任必须实际完成。
            assert!(matches!(
                before_restart.as_str(),
                "register\n" | "register\ndispose\n"
            ));
        } else {
            assert_eq!(before_restart, "register\ndispose\n");
        }
        let profile = fixture.finish().await;
        let mut host = OwnedHost::start_with_scan_marker(
            profile.path(),
            markers.path(),
            "denied",
            Some(&scanned),
        )
        .await;
        let caller = HostClient::connect(ConnectOptions::new(
            profile.path().to_path_buf(),
            id("activation-business"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        wait_scan(&scanned).await;
        let request = call(
            &caller,
            &target,
            "example.terminal.compute",
            json!({"value":10}),
        );
        rejected(
            caller
                .request(RpcRequest::Invoke(request.clone()))
                .await
                .unwrap(),
            "PERMISSION_DENIED",
        );
        let missing = caller.request(RpcRequest::Query(call_query(&call(&caller, &target, "operation.get", json!({"actorId":request.actor_id,"requestId":request.request_id,"requestContext":request.request_context}))))).await.unwrap();
        rejected(missing, "NOT_FOUND");
        host.finish().await;
        assert_eq!(std::fs::read_to_string(events).unwrap(), before_restart);
        eprintln!("native_activation_denied role={denied} new_imports=0 business_operations=0");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_lazy_activation_requires_trigger_and_actual_registered_handler() {
    for triggered in [false, true] {
        let markers = support::Profile::isolated("host-node-backend-activation-subset-");
        let events = markers.path().join("events.txt");
        let scanned = markers.path().join("host.scanned");
        let source = format!(
            "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(){{event('register');return ()=>event('dispose');}}",
            serde_json::to_string(&events).unwrap()
        );
        let fixture = node_host_actions::Fixture::installed_program_with_activation(
            node_host_actions::spec(),
            source.as_bytes(),
            if triggered {
                vec![id("example.terminal.compute")]
            } else {
                vec![]
            },
        )
        .await;
        let enabled = fixture
            .mutate(
                &fixture.client,
                "node.packages.setEnabled",
                json!({"id":"example.terminal","archiveSha256":fixture.archive,"enabled":true}),
                2,
            )
            .await;
        assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
        let target = fixture.target.clone();
        let profile = fixture.finish().await;
        let mut host = OwnedHost::start_with_scan_marker(
            profile.path(),
            markers.path(),
            "subset",
            Some(&scanned),
        )
        .await;
        let client = HostClient::connect(ConnectOptions::new(
            profile.path().to_path_buf(),
            id("action-client"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        wait_scan(&scanned).await;
        for _ in 0..2 {
            rejected(
                client
                    .request(RpcRequest::Invoke(call(
                        &client,
                        &target,
                        "example.terminal.compute",
                        json!({"value":10}),
                    )))
                    .await
                    .unwrap(),
                "UNSUPPORTED_CAPABILITY",
            );
        }
        host.finish().await;
        let events = std::fs::read_to_string(events).unwrap();
        assert_eq!(
            events.lines().filter(|line| *line == "register").count(),
            if triggered { 2 } else { 1 }
        );
        assert!(!events.contains("call"));
        eprintln!(
            "native_activation_subset trigger={triggered} retries_do_not_reimport=true business_calls=0"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_workspace_startup_pins_revision_package_and_receipt() {
    let fixture = node_host_actions::Fixture::new().await;
    let user = &fixture.client;
    let workspace = Target {
        kind: ResourceKind::try_from("workspace").unwrap(),
        id: id("startup"),
        ..fixture.target.clone()
    };
    for (target, permissions) in [
        (&workspace, vec!["metadata.read", "workspace.modify"]),
        (&fixture.target, vec!["metadata.read"]),
    ] {
        let authorized = fixture.invoke(&fixture.user, fixture.call(
            &fixture.user, &fixture.target, "auth.authorize",
            json!({"clientId":user.attachment().client_id,"permissions":permissions,"targets":[target]}),
        )).await;
        assert_eq!(
            fixture
                .wait(&fixture.user, &authorized.operation_id)
                .await
                .state,
            OperationState::Succeeded
        );
    }
    let reference = WorkspaceScriptReference {
        package_id: NodePackageId::try_from("example.terminal").unwrap(),
        version: NodePackageVersion::try_from("1.0.0").unwrap(),
        archive_sha256: fixture.archive.clone(),
        action_id: id("example.terminal.compute"),
    };
    let configuration = WorkspaceConfiguration {
        format: WORKSPACE_CONFIGURATION_FORMAT.into(),
        version: WORKSPACE_CONFIGURATION_VERSION,
        workspace: WorkspaceDocument {
            name: "Saved bench".into(),
            ..Default::default()
        },
        groups: vec![],
        commands: vec![],
        scripts: vec![reference.clone()],
        credential_refs: vec![],
    };
    let mut import = fixture.call(
        user,
        &workspace,
        "workspace.configuration.import",
        json!({"json":configuration.to_json().unwrap()}),
    );
    import.expected_revision = Some(0.into());
    let imported = fixture.invoke(user, import).await;
    let imported = fixture.wait(user, &imported.operation_id).await;
    assert_eq!(imported.state, OperationState::Succeeded, "{imported:?}");

    let QueryResult::WorkspaceStartupPlan(plan) = fixture
        .query(
            user,
            &workspace,
            "workspace.startupPlan",
            json!({"workspaceRevision":"1"}),
        )
        .await
    else {
        panic!("Expected saved startup plan");
    };
    assert_eq!(plan.scripts[0].reference, reference);
    assert_eq!(plan.scripts[0].status, WorkspaceScriptStatus::Matched);
    assert_eq!(
        plan.scripts[0].target_kinds,
        vec![fixture.target.kind.clone()]
    );

    let launch = |revision| {
        let mut call = fixture.call(
            user,
            &fixture.target,
            reference.action_id.as_str(),
            json!({"value":10}),
        );
        call.workspace_startup = Some(WorkspaceStartupSelection {
            workspace_id: workspace.id.clone(),
            workspace_revision: revision,
            reference: reference.clone(),
        });
        call
    };
    let mut forged = launch(1.into());
    forged
        .workspace_startup
        .as_mut()
        .unwrap()
        .reference
        .archive_sha256 = Digest::try_from("1".repeat(64).as_str()).unwrap();
    rejected(
        user.request(RpcRequest::Invoke(forged)).await.unwrap(),
        "WORKSPACE_DEPENDENCY_UNAVAILABLE",
    );

    {
        let mut boundary = fixture
            .host
            .inner
            .node_test_gates
            .action_before_accept
            .arm();
        let pending = user.request(RpcRequest::Invoke(launch(1.into())));
        tokio::pin!(pending);
        tokio::select! {
            reply = &mut pending => panic!("Expected action to await commit: {reply:?}"),
            () = boundary.entered() => {}
        }
        let mut save = fixture.call(
            user,
            &workspace,
            "workspace.save",
            json!({"value":configuration.workspace}),
        );
        save.expected_revision = Some(1.into());
        let saved = fixture.invoke(user, save).await;
        let saved = fixture.wait(user, &saved.operation_id).await;
        assert_eq!(saved.state, OperationState::Succeeded, "{saved:?}");
        boundary.release();
        rejected(pending.await.unwrap(), "REVISION_CONFLICT");
    }

    let call = launch(2.into());
    let receipt = fixture.invoke(user, call.clone()).await;
    let terminal = fixture.wait(user, &receipt.operation_id).await;
    assert_eq!(terminal.state, OperationState::Succeeded, "{terminal:?}");
    assert_eq!(
        terminal.dependencies.unwrap()[0].digest,
        reference.archive_sha256
    );
    let replay = fixture.invoke(user, call.clone()).await;
    assert_eq!(replay.operation_id, receipt.operation_id);
    let mut changed = call;
    changed
        .workspace_startup
        .as_mut()
        .unwrap()
        .workspace_revision = 1.into();
    rejected(
        user.request(RpcRequest::Invoke(changed)).await.unwrap(),
        "REQUEST_CONFLICT",
    );

    {
        let mut boundary = fixture
            .host
            .inner
            .node_test_gates
            .action_before_accept
            .arm();
        let pending = user.request(RpcRequest::Invoke(launch(2.into())));
        tokio::pin!(pending);
        tokio::select! {
            reply = &mut pending => panic!("Expected action to await grant commit: {reply:?}"),
            () = boundary.entered() => {}
        }
        let revoked = fixture.invoke(&fixture.user, fixture.call(&fixture.user, &fixture.target, "auth.revoke", json!({"actorId":user.attachment().actor_id,"permissions":["workspace.modify"],"targets":[workspace]}))).await;
        assert_eq!(
            fixture
                .wait(&fixture.user, &revoked.operation_id)
                .await
                .state,
            OperationState::Succeeded
        );
        boundary.release();
        rejected(pending.await.unwrap(), "PERMISSION_DENIED");
    }

    use sha2::{Digest as _, Sha256};
    let public_key = ed25519_dalek::SigningKey::from_bytes(&[7; 32])
        .verifying_key()
        .to_bytes();
    let fingerprint = format!("{:x}", Sha256::digest(public_key));
    {
        let mut boundary = fixture
            .host
            .inner
            .node_test_gates
            .action_before_accept
            .arm();
        let pending = user.request(RpcRequest::Invoke(launch(2.into())));
        tokio::pin!(pending);
        tokio::select! {
            reply = &mut pending => panic!("Expected action to await source commit: {reply:?}"),
            () = boundary.entered() => {}
        }
        let revoked = fixture
            .mutate(
                &fixture.user,
                "node.sources.revokeKey",
                json!({"source":"test-source","keyId":"test-key","publicKeySha256":fingerprint}),
                1,
            )
            .await;
        assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
        boundary.release();
        rejected(pending.await.unwrap(), "WORKSPACE_DEPENDENCY_UNAVAILABLE");
    }
    rejected(
        user.request(RpcRequest::Invoke(launch(2.into())))
            .await
            .unwrap(),
        "WORKSPACE_DEPENDENCY_UNAVAILABLE",
    );
    fixture.finish().await;
}
