//! 真实父插件通过私有SDK按需激活另一休眠插件，保留调用者、父子归属及重放事实。
use super::*;
use crate::test_support::node_package::{archive, manifest, payloads, with_metadata};

#[path = "plugin_result_authority_tests.rs"]
mod plugin_result_authority_tests;

#[path = "task_worker_tests.rs"]
mod task_worker_tests;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_child_activates_a_dormant_other_package_after_host_restart() {
    let markers = support::Profile::isolated("host-node-backend-lazy-child-");
    let parent_events = markers.path().join("parent.events");
    let child_events = markers.path().join("child.events");
    let scanned = markers.path().join("host.scanned");
    let parent_source = format!(
        "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');event('import');export function register(context){{event('register');let calls=0;context.actions.register('example.terminal.compute',async(call,task)=>{{event('call');let child;try{{child=await task.actions.invokeChild({{actionId:'example.graph.compute',target:call.target,params:{{value:call.params.value}}}});}}catch(error){{event('child-error:'+String(error?.code??'missing'));throw error;}}return {{childOperationId:child.operationId,calls:++calls}};}});return ()=>event('dispose');}}",
        serde_json::to_string(&parent_events).unwrap()
    );
    let mut parent_spec = node_host_actions::spec();
    parent_spec.output_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "childOperationId":{"type":"string"},
            "calls":{"type":"integer"}
        },
        "required":["childOperationId","calls"],
        "additionalProperties":false
    }))
    .unwrap();
    // P沿现有startup夹具安装、确认和启用；Q随后走相同公开管理入口。
    let fixture = node_host_actions::Fixture::program(parent_spec, parent_source.as_bytes()).await;
    let parent_archive = fixture.archive.clone();
    let activation_actor = fixture.client.attachment().actor_id.clone();
    let previous_epoch = fixture.client.attachment().instance_epoch;
    let child_version = "1.2.0";
    let child_source = format!(
        "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');event('import');export function register(context){{event('register');let calls=0;context.actions.register('example.graph.compute',call=>{{event('call');return {{value:call.params.value+1,calls:++calls,actorId:call.actorId}};}});return ()=>event('dispose');}}",
        serde_json::to_string(&child_events).unwrap()
    );
    let mut child_spec = node_host_actions::spec();
    child_spec.action_id = id("example.graph.compute");
    child_spec.output_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "value":{"type":"number"},
            "calls":{"type":"integer"},
            "actorId":{"type":"string"}
        },
        "required":["value","calls","actorId"],
        "additionalProperties":false
    }))
    .unwrap();
    let child_archive =
        install_graph_child(&fixture, child_spec, child_source.as_bytes(), &child_events).await;
    assert_eq!(
        std::fs::read_to_string(&child_events).unwrap(),
        "import\nregister\n"
    );
    // 业务caller只有content.read；登记恢复仍须复用原激活actor。
    let business = business_client(&fixture, true).await;
    let business_actor = business.attachment().actor_id.clone();
    assert_ne!(business_actor, activation_actor);
    drop(business);
    let target = fixture.target.clone();
    let profile = fixture.finish().await;
    assert_eq!(
        std::fs::read_to_string(&parent_events).unwrap(),
        "import\nregister\ndispose\n"
    );
    assert_eq!(
        std::fs::read_to_string(&child_events).unwrap(),
        "import\nregister\ndispose\n"
    );
    let mut host = OwnedHost::start_with_scan_marker(
        profile.path(),
        markers.path(),
        "lazy-child",
        Some(&scanned),
    )
    .await;
    let client = HostClient::connect(ConnectOptions::new(
        profile.path().to_path_buf(),
        id("activation-business"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    assert!(client.attachment().instance_epoch > previous_epoch);
    assert_eq!(client.attachment().actor_id, business_actor);
    wait_scan(&scanned).await;
    assert_eq!(
        std::fs::read_to_string(&parent_events).unwrap(),
        "import\nregister\ndispose\nimport\nregister\n"
    );
    let dormant_events = std::fs::read_to_string(&child_events).unwrap();
    assert_eq!(dormant_events, "import\nregister\ndispose\n");
    let QueryResult::NodePackageRuntime(dormant) = query(
        &client,
        &target,
        "node.packages.runtime",
        json!({"id":"example.graph"}),
    )
    .await
    else {
        panic!("Expected dormant Q runtime");
    };
    assert_eq!(dormant.phase, NodePackageRuntimePhase::Inactive);
    assert_eq!(dormant.generation, 0.into());
    let QueryResult::Catalog(catalog) =
        query(&client, &target, "catalog.list", json!({"pageSize":"100"})).await
    else {
        panic!("Expected actual contribution catalog");
    };
    assert!(
        catalog
            .items
            .iter()
            .any(|item| item.action_id.as_str() == "example.terminal.compute")
    );
    assert!(
        !catalog
            .items
            .iter()
            .any(|item| item.action_id.as_str() == "example.graph.compute")
    );
    assert_eq!(
        std::fs::read_to_string(&child_events).unwrap(),
        dormant_events
    );
    let parent_call = call(
        &client,
        &target,
        "example.terminal.compute",
        json!({"value":41}),
    );
    let accepted_parent = invoke(&client, parent_call.clone()).await;
    let parent = wait(&client, &target, &accepted_parent.operation_id).await;
    if parent.state != OperationState::Succeeded {
        host.finish().await;
        panic!("Real P handler did not finish its lazy Q child: {parent:?}");
    }
    let child = operation(
        &client,
        &target,
        json!({"parentOperationId":parent.operation_id,"childKey":"1"}),
    )
    .await;
    assert_eq!(child.state, OperationState::Succeeded, "{child:?}");
    assert_ne!(child.operation_id, parent.operation_id);
    assert_ne!(child.request_id, parent.request_id);
    assert!(matches!(&parent.admission, Admission::Request { .. }));
    assert_eq!(parent.root_operation_id, parent.operation_id);
    assert_eq!(parent.child_high_watermark, 1.into());
    assert_eq!(child.root_operation_id, parent.operation_id);
    assert_eq!(parent.actor_id, business_actor);
    assert_eq!(child.actor_id, business_actor);
    assert_eq!(child.target, target);
    assert_eq!(child.execution_mode, parent.execution_mode);
    let Admission::Child {
        parent_operation_id,
        child_key,
        ..
    } = &child.admission
    else {
        panic!("Q must be accepted as P's real child");
    };
    assert_eq!(parent_operation_id, &parent.operation_id);
    assert_eq!(child_key.get(), 1);
    assert_eq!(parent.owner.kind, OwnerKind::Plugin);
    assert_eq!(parent.owner.id.as_str(), "example.terminal");
    assert_eq!(parent.owner.version.as_deref(), Some("1.0.0"));
    assert_eq!(child.owner.kind, OwnerKind::Plugin);
    assert_eq!(child.owner.id.as_str(), "example.graph");
    assert_eq!(child.owner.version.as_deref(), Some(child_version));
    let dependency = child
        .dependencies
        .as_ref()
        .unwrap()
        .iter()
        .find(|value| value.id.as_str() == "example.graph")
        .expect("Child must retain Q's actual archive dependency");
    assert_eq!(dependency.version, child_version);
    assert_eq!(dependency.digest, child_archive);
    let parent_dependency = parent
        .dependencies
        .as_ref()
        .unwrap()
        .iter()
        .find(|value| value.id.as_str() == "example.terminal")
        .expect("Parent must retain P's actual archive dependency");
    assert_eq!(parent_dependency.digest, parent_archive);
    // 通过原调用者的公共raw入口读取两份实际结果，不直接访问子Host的Store。
    let mut results = Vec::new();
    for operation in [&parent, &child] {
        let Some(ActionResult::Reference(result)) = &operation.result else {
            panic!("Expected actual plugin result: {operation:?}");
        };
        let reference = &result.result_ref;
        let result_target = Target {
            host_id: reference.host_id.clone(),
            kind: reference.kind.clone(),
            id: reference.id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let raw = client.connect_raw().await.unwrap();
        let request = call(
            &client,
            &result_target,
            "file.read",
            json!({"fileRef":reference,"offset":"0","maxBytes":"65536"}),
        );
        let reply = raw
            .request(RpcRequest::Query(call_query(&request)))
            .await
            .unwrap();
        let RpcReply::Success { result, .. } = reply else {
            panic!("Original caller must read its plugin result: {reply:?}");
        };
        let RpcResult::Query(QueryResult::FileRead(read)) = *result else {
            panic!("Expected result bytes");
        };
        assert!(read.at_end);
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            read.bytes_base64.as_str(),
        )
        .unwrap();
        results.push(serde_json::from_slice::<Value>(&bytes).unwrap());
    }
    assert_eq!(
        results[0],
        json!({"childOperationId":child.operation_id,"calls":1})
    );
    assert_eq!(
        results[1],
        json!({"value":42,"calls":1,"actorId":business_actor})
    );
    let QueryResult::NodePackageRuntime(active_child) = query(
        &client,
        &target,
        "node.packages.runtime",
        json!({"id":"example.graph"}),
    )
    .await
    else {
        panic!("Expected actual active Q registration");
    };
    assert_eq!(active_child.phase, NodePackageRuntimePhase::Active);
    assert!(active_child.generation.get() > 0);
    assert_eq!(active_child.archive_sha256.as_ref(), Some(&child_archive));
    let parent_after_call = std::fs::read_to_string(&parent_events).unwrap();
    let child_after_call = std::fs::read_to_string(&child_events).unwrap();
    assert_eq!(
        parent_after_call,
        "import\nregister\ndispose\nimport\nregister\ncall\n"
    );
    assert_eq!(
        child_after_call,
        "import\nregister\ndispose\nimport\nregister\ncall\n"
    );
    let replay = invoke(&client, parent_call).await;
    assert_eq!(replay, parent);
    assert_eq!(
        operation(
            &client,
            &target,
            json!({"parentOperationId":parent.operation_id,"childKey":"1"})
        )
        .await,
        child
    );
    assert_eq!(
        std::fs::read_to_string(&parent_events).unwrap(),
        parent_after_call
    );
    assert_eq!(
        std::fs::read_to_string(&child_events).unwrap(),
        child_after_call
    );
    host.finish().await;
    assert_eq!(
        std::fs::read_to_string(parent_events).unwrap(),
        format!("{parent_after_call}dispose\n")
    );
    assert_eq!(
        std::fs::read_to_string(child_events).unwrap(),
        format!("{child_after_call}dispose\n")
    );
    eprintln!(
        "native_lazy_child real_host_restart=true startup_q_imports=0 sdk_cross_package=true q_registers_this_host=1 parent_calls=1 child_calls=1 child_key=1 owner_version_archive_verified=true replay_no_effect=true"
    );
}

async fn install_graph_child(
    fixture: &node_host_actions::Fixture,
    child_spec: ActionSpec,
    source: &[u8],
    child_events: &std::path::Path,
) -> Digest {
    assert_eq!(child_spec.action_id.as_str(), "example.graph.compute");
    let child_version = "1.2.0";
    let mut metadata = manifest();
    metadata["id"] = json!("example.graph");
    metadata["version"] = json!(child_version);
    metadata["displayName"] = json!("按需子插件");
    metadata["activation"] = json!(["example.graph.compute"]);
    metadata["permissions"]["hostApi"] = if child_spec.permissions.is_empty() {
        json!([])
    } else {
        json!([{
            "permissions":child_spec.permissions.clone(),
            "targetKinds":child_spec.target_kinds.clone()
        }])
    };
    metadata["contributes"]["actions"] = json!([child_spec]);
    let mut files = payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&metadata).unwrap(),
    );
    files.insert("dist/main.mjs".into(), source.to_vec());
    let archive_path = fixture.dir.path().join("signed-lazy-child.zip");
    std::fs::write(&archive_path, archive(&with_metadata(files, true))).unwrap();
    let registered = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "file.register",
                json!({"path":archive_path.to_str().unwrap(),"purpose":"read_file"}),
            ),
        )
        .await;
    let registered = fixture.wait(&fixture.user, &registered.operation_id).await;
    assert_eq!(
        registered.state,
        OperationState::Succeeded,
        "{registered:?}"
    );
    let Some(ActionResult::FileMetadata(reference)) = registered.result else {
        panic!("Expected registered signed Q archive");
    };
    let installed = fixture
        .mutate(
            &fixture.client,
            "node.packages.install",
            json!({
                "archiveRef":reference.file_ref,
                "source":{"kind":"trusted","source":"test-source","keyId":"test-key"}
            }),
            3,
        )
        .await;
    assert_eq!(installed.state, OperationState::Succeeded, "{installed:?}");
    let Some(ActionResult::NodePackageInstalled(installed)) = installed.result else {
        panic!("Expected actual signed Q installation");
    };
    assert_eq!(installed.revision, 4.into());
    assert_eq!(installed.package.id.as_str(), "example.graph");
    assert!(installed.package.source_verified);
    let child_archive = installed.package.archive_sha256.clone();
    let confirmed = fixture
        .mutate(
            &fixture.user,
            "node.packages.confirmExecutionTrust",
            json!({"id":"example.graph","archiveSha256":child_archive}),
            4,
        )
        .await;
    assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
    assert!(
        !child_events.exists(),
        "Install and trust confirmation cannot import Q"
    );
    let enabled = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":"example.graph","archiveSha256":child_archive,"enabled":true}),
            5,
        )
        .await;
    assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
    let Some(ActionResult::NodePackageChanged(enabled)) = enabled.result else {
        panic!("Expected committed Q enable intent");
    };
    assert_eq!(enabled.revision, 6.into());
    assert!(enabled.package.enabled && enabled.package.execution_approved);
    child_archive
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_empty_permission_child_respects_parent_workspace_active_and_dormant() {
    let markers = support::Profile::isolated("host-node-backend-empty-child-scope-");
    let parent_events = markers.path().join("parent.events");
    let child_events = markers.path().join("child.events");
    let scanned = markers.path().join("host.scanned");
    let parent_source = format!(
        "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');event('import');export function register(context){{event('register');let calls=0;context.actions.register('example.terminal.compute',async(call,task)=>{{event('call:'+call.params.childTarget.id);const n=++calls;try{{const child=await task.actions.invokeChild({{actionId:'example.graph.compute',target:call.params.childTarget,params:{{value:call.params.value}}}});event('child-accepted');return {{code:'ACCEPTED',childOperationId:child.operationId,actorId:call.actorId,calls:n}};}}catch(error){{const code=String(error?.code??'missing');event('child-error:'+code);return {{code,actorId:call.actorId,calls:n}};}}}});return ()=>event('dispose');}}",
        serde_json::to_string(&parent_events).unwrap()
    );
    let workspace_kind = ResourceKind::try_from("workspace").unwrap();
    let mut parent_spec = node_host_actions::spec();
    parent_spec.permissions = vec!["content.read".into()];
    parent_spec.target_kinds = vec![workspace_kind.clone()];
    parent_spec.input_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{"value":{"type":"integer"},"childTarget":{"type":"object"}},
        "required":["value","childTarget"],"additionalProperties":false
    }))
    .unwrap();
    parent_spec.output_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "code":{"type":"string"},"childOperationId":{"type":"string"},
            "actorId":{"type":"string"},"calls":{"type":"integer"}
        },
        "required":["code","actorId","calls"],"additionalProperties":false
    }))
    .unwrap();
    let fixture = node_host_actions::Fixture::program(parent_spec, parent_source.as_bytes()).await;
    let activation_actor = fixture.client.attachment().actor_id.clone();
    let previous_epoch = fixture.client.attachment().instance_epoch;
    let child_source = format!(
        "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');event('import');export function register(context){{event('register');let calls=0;context.actions.register('example.graph.compute',call=>{{event('call:'+call.target.id);return {{value:call.params.value+1,calls:++calls,actorId:call.actorId,targetId:call.target.id}};}});return ()=>event('dispose');}}",
        serde_json::to_string(&child_events).unwrap()
    );
    let mut child_spec = node_host_actions::spec();
    child_spec.action_id = id("example.graph.compute");
    child_spec.permissions.clear();
    child_spec.target_kinds = vec![workspace_kind.clone()];
    child_spec.output_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "value":{"type":"number"},"calls":{"type":"integer"},
            "actorId":{"type":"string"},"targetId":{"type":"string"}
        },
        "required":["value","calls","actorId","targetId"],"additionalProperties":false
    }))
    .unwrap();
    let child_archive =
        install_graph_child(&fixture, child_spec, child_source.as_bytes(), &child_events).await;
    assert_eq!(
        std::fs::read_to_string(&child_events).unwrap(),
        "import\nregister\n"
    );
    let workspace_a = Target {
        kind: workspace_kind.clone(),
        id: id("empty-scope-a"),
        ..fixture.target.clone()
    };
    let workspace_b = Target {
        kind: workspace_kind,
        id: id("empty-scope-b"),
        ..fixture.target.clone()
    };
    let business = business_client(&fixture, true).await;
    let business_actor = business.attachment().actor_id.clone();
    assert_ne!(business_actor, activation_actor);
    // B确实可读两工作区；拒绝必须来自父scope，而非业务caller缺权限。
    for target in [&workspace_a, &workspace_b] {
        assert!(matches!(
            fixture
                .query(&business, target, "workspace.read", json!({}))
                .await,
            QueryResult::Workspace(_)
        ));
    }
    let QueryResult::NodePackageRuntime(active) = fixture
        .query(
            &business,
            &fixture.target,
            "node.packages.runtime",
            json!({"id":"example.graph"}),
        )
        .await
    else {
        panic!("Expected active Q");
    };
    assert_eq!(active.phase, NodePackageRuntimePhase::Active);
    let active_call = fixture.call(
        &business,
        &workspace_a,
        "example.terminal.compute",
        json!({"value":9,"childTarget":workspace_b}),
    );
    let accepted_parent = fixture.invoke(&business, active_call).await;
    let active_parent = fixture.wait(&business, &accepted_parent.operation_id).await;
    let active_result = if active_parent.state == OperationState::Succeeded {
        fixture.result(&business, &active_parent).await
    } else {
        Value::Null
    };
    let active_child = business
        .request(RpcRequest::Query(fixture.query_call(
            &business,
            &fixture.target,
            "operation.get",
            json!({"parentOperationId":active_parent.operation_id,"childKey":"1"}),
        )))
        .await
        .unwrap();
    let active_no_child = matches!(
        &active_child, RpcReply::Failure { error, .. } if error.code == "NOT_FOUND"
    );
    let active_events = std::fs::read_to_string(&child_events).unwrap();
    let active_denied = active_parent.state == OperationState::Succeeded
        && active_parent.child_high_watermark.get() == 0
        && active_result == json!({"code":"PERMISSION_DENIED","actorId":business_actor,"calls":1})
        && active_no_child
        && active_events == "import\nregister\n";
    if !active_denied {
        // 旧实现只会在此Active边界RED；先清理，不继续把Dormant记为已复现。
        drop(business);
        let _profile = fixture.finish().await;
        panic!(
            "Active empty-permission child crossed parent workspace: parent={active_parent:?} result={active_result:?} child={active_child:?} q_events={active_events:?}"
        );
    }
    assert_eq!(active_parent.target, workspace_a);
    assert_eq!(active_parent.actor_id, business_actor);
    assert_eq!(active_parent.root_operation_id, active_parent.operation_id);
    let host_target = fixture.target.clone();
    drop(business);
    let profile = fixture.finish().await;
    let dormant_events = std::fs::read_to_string(&child_events).unwrap();
    assert_eq!(dormant_events, "import\nregister\ndispose\n");
    let mut host = OwnedHost::start_with_scan_marker(
        profile.path(),
        markers.path(),
        "empty-child-scope",
        Some(&scanned),
    )
    .await;
    let client = HostClient::connect(ConnectOptions::new(
        profile.path().to_path_buf(),
        id("activation-business"),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    assert!(client.attachment().instance_epoch > previous_epoch);
    assert_eq!(client.attachment().actor_id, business_actor);
    wait_scan(&scanned).await;
    let QueryResult::NodePackageRuntime(dormant) = query(
        &client,
        &host_target,
        "node.packages.runtime",
        json!({"id":"example.graph"}),
    )
    .await
    else {
        panic!("Expected dormant Q");
    };
    assert_eq!(dormant.phase, NodePackageRuntimePhase::Inactive);
    assert_eq!(dormant.generation, 0.into());
    assert_eq!(
        std::fs::read_to_string(&child_events).unwrap(),
        dormant_events
    );
    let denied_call = call(
        &client,
        &workspace_a,
        "example.terminal.compute",
        json!({"value":9,"childTarget":workspace_b}),
    );
    let accepted_parent = invoke(&client, denied_call.clone()).await;
    let denied_parent = wait(&client, &host_target, &accepted_parent.operation_id).await;
    let denied_result = if denied_parent.state == OperationState::Succeeded {
        graph_scope_result(&client, &denied_parent).await
    } else {
        Value::Null
    };
    let denied_lookup = call(
        &client,
        &host_target,
        "operation.get",
        json!({"parentOperationId":denied_parent.operation_id,"childKey":"1"}),
    );
    let denied_child = client
        .request(RpcRequest::Query(call_query(&denied_lookup)))
        .await
        .unwrap();
    let dormant_no_child = matches!(
        &denied_child, RpcReply::Failure { error, .. } if error.code == "NOT_FOUND"
    );
    let after_denied = std::fs::read_to_string(&child_events).unwrap();
    let dormant_denied = denied_parent.state == OperationState::Succeeded
        && denied_parent.child_high_watermark.get() == 0
        && denied_result == json!({"code":"PERMISSION_DENIED","actorId":business_actor,"calls":1})
        && dormant_no_child
        && after_denied == dormant_events;
    if !dormant_denied {
        host.finish().await;
        panic!(
            "Dormant empty-permission child escaped parent scope: parent={denied_parent:?} result={denied_result:?} child={denied_child:?} q_events={after_denied:?}"
        );
    }
    assert_eq!(denied_parent.target, workspace_a);
    assert_eq!(denied_parent.actor_id, business_actor);
    assert_eq!(denied_parent.root_operation_id, denied_parent.operation_id);
    let correct_call = call(
        &client,
        &workspace_a,
        "example.terminal.compute",
        json!({"value":9,"childTarget":workspace_a}),
    );
    let accepted_parent = invoke(&client, correct_call.clone()).await;
    let parent = wait(&client, &host_target, &accepted_parent.operation_id).await;
    if parent.state != OperationState::Succeeded {
        host.finish().await;
        panic!("Same-workspace child was blanket-denied: {parent:?}");
    }
    let child = operation(
        &client,
        &host_target,
        json!({"parentOperationId":parent.operation_id,"childKey":"1"}),
    )
    .await;
    let parent_result = graph_scope_result(&client, &parent).await;
    let child_result = graph_scope_result(&client, &child).await;
    assert_eq!(child.state, OperationState::Succeeded, "{child:?}");
    assert_eq!(parent.target, workspace_a);
    assert_eq!(child.target, workspace_a);
    assert_eq!(parent.actor_id, business_actor);
    assert_eq!(child.actor_id, business_actor);
    assert_ne!(child.operation_id, parent.operation_id);
    assert_eq!(parent.root_operation_id, parent.operation_id);
    assert_eq!(child.root_operation_id, parent.operation_id);
    assert_eq!(parent.child_high_watermark, 1.into());
    assert_eq!(child.owner.kind, OwnerKind::Plugin);
    assert_eq!(child.owner.id.as_str(), "example.graph");
    assert_eq!(child.owner.version.as_deref(), Some("1.2.0"));
    let Admission::Child {
        parent_operation_id,
        child_key,
        ..
    } = &child.admission
    else {
        panic!("Expected same-scope Q child admission");
    };
    assert_eq!(parent_operation_id, &parent.operation_id);
    assert_eq!(child_key.get(), 1);
    let dependency = child
        .dependencies
        .as_ref()
        .unwrap()
        .iter()
        .find(|value| value.id.as_str() == "example.graph")
        .expect("Q archive identity must be retained");
    assert_eq!(dependency.version, "1.2.0");
    assert_eq!(dependency.digest, child_archive);
    assert_eq!(
        parent_result,
        json!({
            "code":"ACCEPTED","childOperationId":child.operation_id,
            "actorId":business_actor,"calls":2
        })
    );
    assert_eq!(
        child_result,
        json!({
            "value":10,"calls":1,"actorId":business_actor,"targetId":workspace_a.id
        })
    );
    let after_success = std::fs::read_to_string(&child_events).unwrap();
    assert_eq!(
        after_success,
        "import\nregister\ndispose\nimport\nregister\ncall:empty-scope-a\n"
    );
    assert_eq!(invoke(&client, denied_call).await, denied_parent);
    assert_eq!(invoke(&client, correct_call).await, parent);
    assert_eq!(
        std::fs::read_to_string(&child_events).unwrap(),
        after_success
    );
    host.finish().await;
    assert_eq!(
        std::fs::read_to_string(child_events).unwrap(),
        format!("{after_success}dispose\n")
    );
    eprintln!(
        "native_empty_child_scope active_denied=true dormant_denied_before_import=true parent_success_hwm0=true same_workspace_succeeded=true q_calls=1 original_caller_preserved=true"
    );
}

async fn graph_scope_result(client: &HostClient, operation: &Operation) -> Value {
    let Some(ActionResult::Reference(result)) = &operation.result else {
        panic!("Expected actual parent/child result: {operation:?}");
    };
    let reference = &result.result_ref;
    let target = Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let request = call(
        client,
        &target,
        "file.read",
        json!({"fileRef":reference,"offset":"0","maxBytes":"65536"}),
    );
    let raw = client.connect_raw().await.unwrap();
    let reply = raw
        .request(RpcRequest::Query(call_query(&request)))
        .await
        .unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("Expected public result read: {reply:?}");
    };
    let RpcResult::Query(QueryResult::FileRead(read)) = *result else {
        panic!("Expected public result bytes");
    };
    assert!(read.at_end);
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        read.bytes_base64.as_str(),
    )
    .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
