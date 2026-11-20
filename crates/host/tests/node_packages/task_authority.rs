use super::*;
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::Digest;
use serial_workbench_host::capture::{
    format::CaptureSource,
    writer::{CaptureLimits, CaptureWriter},
};

async fn host_action(
    fixture: &Fixture,
    client: &HostClient,
    action: &str,
    params: serde_json::Value,
) -> Operation {
    let accepted = fixture
        .invoke(
            client,
            fixture.call(client, &fixture.target, action, params),
        )
        .await;
    fixture.wait(client, &accepted.operation_id).await
}

async fn register_reference(
    fixture: &Fixture,
    control: &HostClient,
    name: &str,
    purpose: &str,
) -> ObjectRef {
    let registered = host_action(
        fixture,
        control,
        "file.register",
        json!({"path":fixture.dir.path().join(name).to_str().unwrap(),"purpose":purpose}),
    )
    .await;
    let Some(ActionResult::FileMetadata(metadata)) = registered.result else {
        panic!("Expected registered reference: {registered:?}")
    };
    metadata.file_ref
}

fn reference_target(reference: &ObjectRef) -> Target {
    Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    }
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_plugin_scope_rejects_an_undeclared_archive_reference() {
    let mut action = spec();
    action.permissions = vec![
        "metadata.read".into(),
        "content.read".into(),
        "plugins.manage".into(),
    ];
    action.input_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = Fixture::program(action,br#"
        export function register(context) {
          context.actions.register('example.terminal.compute',async (call,task)=>{
            if(call.params.leaf) return {alive:true};
            let installDenied;
            try {
              await task.actions.invokeChild({actionId:'node.packages.install',target:call.target,
                params:call.params.install,revealTarget:call.params.installReveal,expectedRevision:'3'});
            } catch(error){installDenied=error.code;}
            const child=await task.actions.invokeChild({actionId:call.actionId,target:call.target,params:{leaf:true}});
            return {installDenied,child};
          });return ()=>{};
        }
    "#).await;
    let archive =
        register_reference(&fixture, &fixture.user, "signed-actions.zip", "read_file").await;
    let install = json!({"archiveRef":archive,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}});
    let QueryResult::ActionCheck(check) = fixture
        .query(
            &fixture.client,
            &fixture.target,
            "action.check",
            json!({"actionId":"node.packages.install","params":install}),
        )
        .await
    else {
        panic!("Expected preflight")
    };
    assert!(
        check.allowed,
        "The original caller must be permitted to read this archive"
    );
    let parent = host_action(&fixture,&fixture.client,"example.terminal.compute",json!({
        "install":install,"installReveal":BuiltinAction::NodePackagesInstall.spec().reveal_target
    })).await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let child = if let Some(result) = &result {
        let accepted: Operation = serde_json::from_value(result["child"].clone()).unwrap();
        let settled = fixture.wait(&fixture.client, &accepted.operation_id).await;
        let result = fixture.result(&fixture.client, &settled).await;
        Some((settled, result))
    } else {
        None
    };
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    assert_eq!(parent.child_high_watermark, 1.into());
    assert_eq!(result.unwrap()["installDenied"], "PERMISSION_DENIED");
    let (child, result) = child.unwrap();
    assert_eq!(child.state, OperationState::Succeeded);
    assert_eq!(child.owner.kind, OwnerKind::Plugin);
    assert_eq!(result, json!({"alive":true}));
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_child_export_checks_both_source_and_destination_grants() {
    let mut action = spec();
    action.permissions = vec![
        "metadata.read".into(),
        "content.read".into(),
        "workspace.modify".into(),
    ];
    action
        .target_kinds
        .push(ResourceKind::try_from("file").unwrap());
    action.input_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = Fixture::program_with_client_permissions(action, br#"
        export function register(context) {
          context.actions.register('example.terminal.compute',async (call,task)=>{
            const exportTo=(captureRef,targetRef)=>task.actions.invokeChild({
              actionId:'capture.export',target:{hostId:captureRef.hostId,kind:captureRef.kind,id:captureRef.id},
              params:{captureRef,targetRef},revealTarget:{pageId:'workbench',panelId:'capture'}});
            let sourceDenied,destinationDenied;
            try {await exportTo(call.params.deniedSource,call.params.allowedTarget);}
            catch(error){sourceDenied=error.code;}
            try {await exportTo(call.params.allowedSource,call.params.deniedTarget);}
            catch(error){destinationDenied=error.code;}
            const child=await exportTo(call.params.allowedSource,call.params.allowedTarget);
            let receipt=await task.operations.get({operationId:child.operationId});
            while(['queued','running','cancel_requested'].includes(receipt.state)) {
              await new Promise(resolve=>setTimeout(resolve,10));
              receipt=await task.operations.get({operationId:child.operationId});
            }
            return {sourceDenied,destinationDenied,receipt};
          });return ()=>{};
        }
    "#,vec!["plugins.manage".into(),"content.read".into(),"workspace.modify".into()]).await;
    // 文件选择绑定业务clientId；本地控制身份负责选择，不委托给插件。
    let secret =
        serial_workbench_ipc::read_secret(&fixture.dir.path().join("host-v0/user-control.secret"))
            .unwrap()
            .unwrap();
    let mut options = ConnectOptions::new(
        fixture.dir.path().to_path_buf(),
        fixture.client.attachment().client_id.clone(),
        ClientKind::Desktop,
    );
    options.user_control_credential =
        Some(ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap());
    let control = HostClient::connect(options).await.unwrap();
    for name in ["allowed-source", "denied-source"] {
        let source = CaptureSource {
            host_id: fixture.target.host_id.clone(),
            instance_epoch: fixture.user.attachment().instance_epoch,
            session_id: Id::try_from("source-session").unwrap(),
            session_epoch: 1.into(),
            configuration_digest: Digest::try_from("0".repeat(64).as_str()).unwrap(),
            configuration: SerialConfiguration::default(),
            time_precision: TimePrecision {
                source: TimeSource::HostRead,
                resolution_ns: 1.into(),
                sync_method: "none".into(),
                offset_estimate_ns: None,
                offset_error_ns: None,
                rtt_ns: None,
            },
        };
        let mut writer = CaptureWriter::create(
            &fixture.dir.path().join(name),
            vec![source],
            CaptureLimits::default(),
        )
        .unwrap();
        let event = serde_json::from_value(json!({
            "hostId":fixture.target.host_id,"instanceEpoch":fixture.user.attachment().instance_epoch,
            "sessionId":"source-session","sessionEpoch":"1","eventSeq":"1","configurationRevision":"1",
            "time":{"clockId":"fixture-clock","sourceMonoNs":"1","receivedWallTime":"2026-11-17T00:00:00Z",
              "precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},
            "kind":"rx","payload":{"bytesBase64":"QQ==","byteStart":"0","byteEnd":"1"}
        })).unwrap();
        writer
            .push(CaptureEntry::Event(Box::new(event)), 0)
            .unwrap();
        assert_eq!(writer.finish().unwrap().state, CaptureState::Complete);
    }
    let allowed_source =
        register_reference(&fixture, &control, "allowed-source", "capture_source").await;
    let denied_source =
        register_reference(&fixture, &control, "denied-source", "capture_source").await;
    let allowed_target =
        register_reference(&fixture, &control, "allowed-export.jsonl", "capture_target").await;
    let denied_target =
        register_reference(&fixture, &control, "denied-export.jsonl", "capture_target").await;
    for (permission, target) in [
        ("content.read", reference_target(&denied_source)),
        ("workspace.modify", reference_target(&denied_target)),
    ] {
        let revoked = host_action(&fixture, &fixture.user, "auth.revoke", json!({
            "actorId":fixture.client.attachment().actor_id,"permissions":[permission],"targets":[target]
        })).await;
        assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
    }
    let parent = host_action(
        &fixture,
        &fixture.client,
        "example.terminal.compute",
        json!({
            "allowedSource":allowed_source,"deniedSource":denied_source,
            "allowedTarget":allowed_target,"deniedTarget":denied_target
        }),
    )
    .await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let exported = std::fs::read_to_string(fixture.dir.path().join("allowed-export.jsonl"));
    let denied_exists = fixture.dir.path().join("denied-export.jsonl").exists();
    drop(control);
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    assert_eq!(parent.child_high_watermark, 1.into());
    let result = result.unwrap();
    assert_eq!(result["sourceDenied"], "PERMISSION_DENIED");
    assert_eq!(result["destinationDenied"], "PERMISSION_DENIED");
    assert_eq!(result["receipt"]["state"], "succeeded");
    assert_eq!(result["receipt"]["result"]["kind"], "reference");
    assert!(!denied_exists);
    let text: String = exported
        .unwrap()
        .lines()
        .filter_map(|line| {
            let row: serde_json::Value = serde_json::from_str(line).unwrap();
            row["text"].as_str().map(str::to_owned)
        })
        .collect();
    assert_eq!(text, "A");
    drop(profile);
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT pointing to a prepared native distribution"]
async fn verified_backend_host_task_scope_rejects_other_workspace_effects_and_receipts() {
    let mut action = spec();
    action.permissions = vec![
        "metadata.read".into(),
        "content.read".into(),
        "workspace.modify".into(),
    ];
    action.target_kinds = vec![ResourceKind::try_from("workspace").unwrap()];
    action.input_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    action.output_schema = serde_json::from_value(json!({"type":"object"})).unwrap();
    let fixture = Fixture::program_with_client_permissions(
        action,
        br#"
        export function register(context) {
          context.actions.register('example.terminal.compute',async (call,task)=>{
            let readDenied,writeDenied;
            try {await task.operations.get({operationId:call.params.otherOperation});}
            catch(error){readDenied=error.code;}
            try {await task.actions.invokeChild({actionId:'workspace.save',target:call.params.other,
              params:{value:call.params.value},expectedRevision:'1'});}
            catch(error){writeDenied=error.code;}
            const child=await task.actions.invokeChild({actionId:'workspace.save',target:call.target,
              params:{value:call.params.value},expectedRevision:'0'});
            let receipt=await task.operations.get({operationId:child.operationId});
            while(['queued','running','cancel_requested'].includes(receipt.state)) {
              await new Promise(resolve=>setTimeout(resolve,10));
              receipt=await task.operations.get({operationId:child.operationId});
            }
            return {readDenied,writeDenied,receipt};
          });return ()=>{};
        }
        "#,
        vec![
            "plugins.manage".into(),
            "content.read".into(),
            "workspace.modify".into(),
        ],
    )
    .await;
    let workspace = |id: &str| Target {
        kind: ResourceKind::try_from("workspace").unwrap(),
        id: Id::try_from(id).unwrap(),
        ..fixture.target.clone()
    };
    let own = workspace("parent-workspace");
    let other = workspace("other-workspace");
    let QueryResult::Workspace(initial) = fixture
        .query(&fixture.client, &own, "workspace.read", json!({}))
        .await
    else {
        panic!("Expected workspace")
    };
    let mut value = initial.document.value;
    value.name = "Other workspace stays here".into();
    let mut other_call = fixture.call(
        &fixture.client,
        &other,
        "workspace.save",
        json!({"value":value}),
    );
    other_call.expected_revision = Some(0.into());
    let other_saved = fixture.invoke(&fixture.client, other_call).await;
    let other_saved = fixture
        .wait(&fixture.client, &other_saved.operation_id)
        .await;
    assert_eq!(other_saved.state, OperationState::Succeeded);
    value.name = "Saved only in parent workspace".into();
    let parent = fixture
        .invoke(
            &fixture.client,
            fixture.call(
                &fixture.client,
                &own,
                "example.terminal.compute",
                json!({"other":other,"otherOperation":other_saved.operation_id,"value":value}),
            ),
        )
        .await;
    let parent = fixture.wait(&fixture.client, &parent.operation_id).await;
    let result = if parent.state == OperationState::Succeeded {
        Some(fixture.result(&fixture.client, &parent).await)
    } else {
        None
    };
    let QueryResult::Workspace(saved_own) = fixture
        .query(&fixture.client, &own, "workspace.read", json!({}))
        .await
    else {
        panic!("Expected workspace")
    };
    let QueryResult::Workspace(saved_other) = fixture
        .query(&fixture.client, &other, "workspace.read", json!({}))
        .await
    else {
        panic!("Expected workspace")
    };
    let profile = fixture.finish().await;
    assert_eq!(parent.state, OperationState::Succeeded, "{parent:?}");
    assert_eq!(parent.child_high_watermark, 1.into());
    let result = result.unwrap();
    assert_eq!(result["readDenied"], "PERMISSION_DENIED");
    assert_eq!(result["writeDenied"], "PERMISSION_DENIED");
    assert_eq!(result["receipt"]["state"], "succeeded");
    assert_eq!(saved_own.document.revision, 1.into());
    assert_eq!(
        saved_own.document.value.name,
        "Saved only in parent workspace"
    );
    assert_eq!(saved_other.document.revision, 1.into());
    assert_eq!(
        saved_other.document.value.name,
        "Other workspace stays here"
    );
    drop(profile);
}
