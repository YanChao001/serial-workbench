//! 插件结果按原任务资源的当前权限读取，公开Raw、Operation与私有SDK保持一致。
use super::*;
use crate::test_support::{self as support, node_host_actions};
use serial_workbench_client::HostClient;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn native_node_plugin_result_three_read_paths_recheck_its_source_resource() {
    let markers = support::Profile::isolated("host-node-backend-plugin-result-authority-");
    let parent_events = markers.path().join("parent.events");
    let child_events = markers.path().join("child.events");
    let child_pid = markers.path().join("node.pid");
    let parent_source = format!(
        "import {{appendFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');export function register(context){{event('register');context.actions.register('example.terminal.compute',async(call,task)=>{{event('call');try{{const receipt=await task.operations.get({{operationId:call.params.operationId}});event('read:OK');return {{code:'OK',receipt}};}}catch(error){{const code=String(error?.code??'missing');event('read:'+code);return {{code}};}}}});return ()=>event('dispose');}}",
        serde_json::to_string(&parent_events).unwrap()
    );
    let mut parent_spec = node_host_actions::spec();
    // P入口只需Host元数据；私有读取能力通过真实签名升级及确认单独声明。
    parent_spec.permissions = vec!["metadata.read".into()];
    parent_spec.target_kinds = vec![ResourceKind::try_from("host").unwrap()];
    parent_spec.input_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{"operationId":{"type":"string"}},
        "required":["operationId"],"additionalProperties":false
    }))
    .unwrap();
    parent_spec.output_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{"code":{"type":"string"},"receipt":{"type":"object"}},
        "required":["code"],"additionalProperties":false
    }))
    .unwrap();
    let fixture =
        node_host_actions::Fixture::program(parent_spec.clone(), parent_source.as_bytes()).await;
    let producer_actor = fixture.client.attachment().actor_id.clone();
    let workspace = Target {
        kind: ResourceKind::try_from("workspace").unwrap(),
        id: id("plugin-result-source-workspace-b"),
        ..fixture.target.clone()
    };
    let child_source = format!(
        "import {{appendFileSync,writeFileSync}} from 'node:fs';const event=s=>appendFileSync({},s+'\\n');event('import');export function register(context){{event('register');writeFileSync({},String(process.pid));let calls=0;context.actions.register('example.graph.compute',call=>{{event('call');return {{value:call.params.value+1,calls:++calls,actorId:call.actorId,targetId:call.target.id,body:'workspace-b-result-body'}};}});return ()=>event('dispose');}}",
        serde_json::to_string(&child_events).unwrap(),
        serde_json::to_string(&child_pid).unwrap()
    );
    let mut child_spec = node_host_actions::spec();
    child_spec.action_id = id("example.graph.compute");
    child_spec.permissions = vec!["content.read".into()];
    child_spec.target_kinds = vec![ResourceKind::try_from("workspace").unwrap()];
    child_spec.output_schema = serde_json::from_value(json!({
        "type":"object",
        "properties":{
            "value":{"type":"number"},"calls":{"type":"integer"},
            "actorId":{"type":"string"},"targetId":{"type":"string"},
            "body":{"type":"string"}
        },
        "required":["value","calls","actorId","targetId","body"],
        "additionalProperties":false
    }))
    .unwrap();
    let child_archive =
        install_graph_child(&fixture, child_spec, child_source.as_bytes(), &child_events).await;
    let mut node = support::node_owner_exit::ProcessExit::observe(
        std::fs::read_to_string(&child_pid)
            .unwrap()
            .parse()
            .unwrap(),
    );

    // Q已启用且包revision为6；通过公开升级另行扩大P的Host API声明。
    let mut metadata = manifest();
    metadata["version"] = json!("2.0.0");
    metadata["permissions"]["hostApi"] = json!([
        {"permissions":["metadata.read"],"targetKinds":["host"]},
        {"permissions":["metadata.read","content.read"],"targetKinds":["workspace"]}
    ]);
    metadata["contributes"]["actions"] = json!([parent_spec]);
    let mut files = payloads();
    files.insert(
        "manifest.json".into(),
        serde_json::to_vec(&metadata).unwrap(),
    );
    files.insert("dist/main.mjs".into(), parent_source.into_bytes());
    let parent_archive_path = fixture.dir.path().join("signed-result-reader-p2.zip");
    std::fs::write(&parent_archive_path, archive(&with_metadata(files, true))).unwrap();
    let registered = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "file.register",
                json!({"path":parent_archive_path.to_str().unwrap(),"purpose":"read_file"}),
            ),
        )
        .await;
    let registered = fixture.wait(&fixture.user, &registered.operation_id).await;
    assert_eq!(
        registered.state,
        OperationState::Succeeded,
        "{registered:?}"
    );
    let Some(ActionResult::FileMetadata(registered)) = registered.result else {
        panic!("Expected the selected signed P upgrade");
    };
    let upgraded = fixture
        .mutate(
            &fixture.client,
            "node.packages.install",
            json!({"archiveRef":registered.file_ref,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}}),
            6,
        )
        .await;
    assert_eq!(upgraded.state, OperationState::Succeeded, "{upgraded:?}");
    let Some(ActionResult::NodePackageInstalled(upgraded)) = upgraded.result else {
        panic!("Expected the actual P upgrade receipt");
    };
    assert_eq!(upgraded.revision, 7.into());
    assert_eq!(upgraded.package.id.as_str(), "example.terminal");
    assert!(upgraded.package.source_verified);
    assert!(!upgraded.package.enabled && !upgraded.package.execution_approved);
    let parent_archive = upgraded.package.archive_sha256.clone();
    let confirmed = fixture
        .mutate(
            &fixture.user,
            "node.packages.confirmExecutionTrust",
            json!({"id":"example.terminal","archiveSha256":parent_archive}),
            7,
        )
        .await;
    assert_eq!(confirmed.state, OperationState::Succeeded, "{confirmed:?}");
    let enabled = fixture
        .mutate(
            &fixture.client,
            "node.packages.setEnabled",
            json!({"id":"example.terminal","archiveSha256":parent_archive,"enabled":true}),
            8,
        )
        .await;
    assert_eq!(enabled.state, OperationState::Succeeded, "{enabled:?}");
    let Some(ActionResult::NodePackageChanged(enabled)) = enabled.result else {
        panic!("Expected P's actual enable receipt");
    };
    assert_eq!(enabled.revision, 9.into());
    assert!(enabled.package.enabled && enabled.package.execution_approved);

    // A生成Q的保留结果，独立B既非创建者，也不承担Q的原登记资格。
    let producer_call = fixture.call(
        &fixture.client,
        &workspace,
        "example.graph.compute",
        json!({"value":41}),
    );
    let accepted = fixture.invoke(&fixture.client, producer_call.clone()).await;
    let producer = fixture.wait(&fixture.client, &accepted.operation_id).await;
    assert_eq!(producer.state, OperationState::Succeeded, "{producer:?}");
    let Some(ActionResult::Reference(result)) = &producer.result else {
        panic!("Expected Q's immutable plugin_result reference");
    };
    let reference = result.result_ref.clone();
    assert_eq!(reference.kind.as_str(), "plugin_result");
    let business = business_client(&fixture, true).await;
    let business_actor = business.attachment().actor_id.clone();
    assert_ne!(business_actor, producer_actor);
    let expected = json!({
        "value":42,"calls":1,"actorId":producer_actor,
        "targetId":workspace.id,"body":"workspace-b-result-body"
    });
    let before_raw = plugin_result_raw_reply(&business, &reference).await;
    let before_public = operation(
        &business,
        &fixture.target,
        json!({"operationId":producer.operation_id}),
    )
    .await;
    let (before_parent, before_private) =
        plugin_result_private_read(&fixture, &business, &producer.operation_id).await;

    // 只撤原结果资源的content.read，保留Host授权、P入口与Q登记资格。
    // 撤权提交后新发P任务，避免旧父grant失效代替实际结果资源验权。
    let revoked = fixture
        .invoke(
            &fixture.user,
            fixture.call(
                &fixture.user,
                &fixture.target,
                "auth.revoke",
                json!({"actorId":business_actor,"permissions":["content.read"],"targets":[workspace]}),
            ),
        )
        .await;
    let revoked = fixture.wait(&fixture.user, &revoked.operation_id).await;
    assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
    let reference_target = Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let metadata_after = fixture
        .query(
            &business,
            &reference_target,
            "file.metadata",
            json!({"fileRef":reference}),
        )
        .await;
    let after_raw = plugin_result_raw_reply(&business, &reference).await;
    let after_public = business
        .request(RpcRequest::Query(fixture.query_call(
            &business,
            &fixture.target,
            "operation.get",
            json!({"operationId":producer.operation_id}),
        )))
        .await
        .unwrap();
    let (after_parent, after_private) =
        plugin_result_private_read(&fixture, &business, &producer.operation_id).await;
    let original_public = operation(
        &fixture.client,
        &fixture.target,
        json!({"operationId":producer.operation_id}),
    )
    .await;
    let original_raw = plugin_result_raw_reply(&fixture.client, &reference).await;
    let producer_replay = fixture.invoke(&fixture.client, producer_call).await;
    let observed = std::fs::read_to_string(&child_events).unwrap();
    let parent_observed = std::fs::read_to_string(&parent_events).unwrap();
    let node_alive_before_shutdown = !node.exited();
    let _profile = fixture.finish().await;

    assert_eq!(plugin_result_bytes(before_raw), expected);
    assert_eq!(before_public, producer);
    assert_eq!(
        before_parent.state,
        OperationState::Succeeded,
        "{before_parent:?}"
    );
    assert_eq!(before_parent.actor_id, business_actor);
    assert_eq!(before_parent.child_high_watermark, 0.into());
    assert_eq!(before_parent.owner.version.as_deref(), Some("2.0.0"));
    let before_private = before_private.expect("P must deliver its authorized SDK read");
    assert_eq!(before_private["code"], "OK");
    assert_eq!(
        before_private["receipt"]["operationId"],
        json!(producer.operation_id)
    );
    assert_eq!(before_private["receipt"]["actorId"], json!(producer_actor));
    assert_eq!(before_private["receipt"]["target"], json!(workspace));
    assert_eq!(
        before_private["receipt"]["result"]["value"]["resultRef"],
        json!(reference)
    );
    let QueryResult::FileMetadata(metadata_after) = metadata_after else {
        panic!("Narrow content revocation must preserve Q result metadata");
    };
    assert_eq!(metadata_after.file_ref, reference);
    rejected(after_raw, "PERMISSION_DENIED");
    rejected(after_public, "PERMISSION_DENIED");
    assert_ne!(after_parent.operation_id, before_parent.operation_id);
    assert_ne!(after_parent.request_id, before_parent.request_id);
    assert_eq!(
        after_parent.state,
        OperationState::Succeeded,
        "{after_parent:?}"
    );
    assert!(
        after_parent.error.is_none(),
        "P itself must remain authorized"
    );
    assert_eq!(after_parent.actor_id, business_actor);
    assert_eq!(after_parent.target, before_parent.target);
    assert_eq!(after_parent.child_high_watermark, 0.into());
    assert_eq!(after_private, Some(json!({"code":"PERMISSION_DENIED"})));
    assert_eq!(original_public, producer);
    assert_eq!(producer_replay, producer);
    assert_eq!(plugin_result_bytes(original_raw), expected);
    assert_eq!(producer.actor_id, producer_actor);
    assert_eq!(producer.target, workspace);
    assert_eq!(producer.owner.id.as_str(), "example.graph");
    assert!(
        producer
            .dependencies
            .as_ref()
            .unwrap()
            .iter()
            .any(|dependency| {
                dependency.id.as_str() == "example.graph" && dependency.digest == child_archive
            })
    );
    assert_eq!(observed, "import\nregister\ncall\n");
    assert_eq!(
        std::fs::read_to_string(child_events).unwrap(),
        format!("{observed}dispose\n")
    );
    assert_eq!(
        parent_observed,
        "register\ndispose\nregister\ncall\nread:OK\ncall\nread:PERMISSION_DENIED\n"
    );
    assert_eq!(
        std::fs::read_to_string(parent_events).unwrap(),
        format!("{parent_observed}dispose\n")
    );
    assert!(node_alive_before_shutdown && node.exited());
    eprintln!(
        "native_plugin_result_authority three_reads_before=true three_denied_after=true fresh_parent_succeeded=true metadata_retained=true original_actor_read=true producer_calls=1 replay_unchanged=true actual_node_exit=true"
    );
}

async fn plugin_result_raw_reply(client: &HostClient, reference: &ObjectRef) -> RpcReply {
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
    raw.request(RpcRequest::Query(call_query(&request)))
        .await
        .unwrap()
}

fn plugin_result_bytes(reply: RpcReply) -> Value {
    let RpcReply::Success { result, .. } = reply else {
        panic!("Expected authorized plugin result bytes: {reply:?}");
    };
    let RpcResult::Query(QueryResult::FileRead(read)) = *result else {
        panic!("Expected raw FileRead result");
    };
    assert!(read.at_end);
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        read.bytes_base64.as_str(),
    )
    .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn plugin_result_private_read(
    fixture: &node_host_actions::Fixture,
    client: &HostClient,
    operation_id: &Id,
) -> (Operation, Option<Value>) {
    let accepted = fixture
        .invoke(
            client,
            fixture.call(
                client,
                &fixture.target,
                "example.terminal.compute",
                json!({"operationId":operation_id}),
            ),
        )
        .await;
    let parent = fixture.wait(client, &accepted.operation_id).await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(client, &parent).await)
    } else {
        None
    };
    (parent, result)
}
