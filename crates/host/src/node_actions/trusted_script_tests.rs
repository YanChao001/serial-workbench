use super::*;
use crate::{
    ipc::HostServer,
    node_runtime::{NodeRuntimeLimits, verify_node_runtime},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};

#[tokio::test]
#[ignore = "Needs a verified native Node distribution in SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_signed_user_script_is_bound_to_operator_source_and_session() {
    let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT").unwrap();
    let runtime = verify_node_runtime(
        Path::new(&root),
        &NodeRuntimeLimits::default(),
        &AtomicBool::new(false),
    )
    .unwrap();
    let profile = crate::test_support::Profile::isolated("host-trusted-script-");
    let server = HostServer::bind(profile.path()).await.unwrap();
    let credential = serial_workbench_client::read_user_control_credential(profile.path()).unwrap();
    let auth = server.auth();
    let local_client = Id::try_from("script-operator").unwrap();
    let operator = auth
        .authenticate_user_control(&local_client, &credential)
        .unwrap();
    let participant = Id::try_from("script-participant").unwrap();
    let registration = auth.authenticate(&participant, None).unwrap();
    let actor = registration.actor;
    let store = server.store();
    let identity = store.identity().unwrap();
    let host = Host::initialize(
        store.clone(),
        auth.clone(),
        Arc::new(crate::clock::SystemClock::new().unwrap()),
        DeviceSource::Opener(crate::device::DeviceService::virtual_opener()),
        Some(StartupConfigSnapshot {
            profile_reference: StartupProfileReference::HostProfile,
            profile_source: StartupConfigSource::Argument,
            log_level: StartupLogLevel::Info,
            log_level_source: StartupConfigSource::Default,
        }),
        Some(runtime),
    )
    .await
    .unwrap();

    let package = NodePackageId::try_from("swb.builtin.automation").unwrap();
    let catalog = &host.inner.registry.runtime;
    let mut changes = catalog.subscribe();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let status = catalog.status(&package).unwrap();
            assert_ne!(status.phase, NodePackageRuntimePhase::Failed, "{status:?}");
            if status.phase == NodePackageRuntimePhase::Active {
                break;
            }
            changes.changed().await.unwrap();
        }
    })
    .await
    .unwrap();

    let device = Target {
        host_id: identity.host_id.clone(),
        kind: ResourceKind::try_from("device").unwrap(),
        id: Id::try_from("virtual:echo").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    let call = |caller: &AuthenticatedActor,
                target: &Target,
                action: &str,
                params: serde_json::Value| Call {
        protocol_version: ProtocolVersion::V1_0,
        host_id: identity.host_id.clone(),
        instance_epoch: identity.instance_epoch,
        actor_id: caller.id().clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        request_context: store.issue_context(caller).unwrap().token,
        action_id: Id::try_from(action).unwrap(),
        target: target.clone(),
        params: serde_json::from_value(params).unwrap(),
        reveal_target: RevealTarget {
            page_id: Id::try_from("workbench").unwrap(),
            panel_id: None,
            session_id: None,
            workspace_id: None,
            result_ref: None,
        },
        expected_revision: None,
        lease_id: None,
        execution_mode: Some(ExecutionMode::Independent),
        workspace_startup: None,
    };
    let settle = |operation: Operation| {
        let store = store.clone();
        let observer = actor.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let current = store.get(&observer, &operation.operation_id).unwrap();
                    if current.state.is_terminal() {
                        return current;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap()
        }
    };
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: participant.clone(),
            permissions: vec!["device.modify".into()],
            targets: vec![device.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let opened = host
        .invoke(
            &actor,
            call(
                &actor,
                &device,
                "device.open",
                json!({"configuration": SerialConfiguration::default()}),
            ),
        )
        .await
        .unwrap();
    let opened = settle(opened).await;
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("Expected Virtual Echo, got {opened:?}");
    };
    let session = Target {
        host_id: identity.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
    };
    let snapshot = host
        .inner
        .devices
        .session(&session)
        .unwrap()
        .snapshot()
        .unwrap();
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: participant.clone(),
            permissions: ["metadata.read", "content.read", "device.modify"]
                .into_iter()
                .map(Into::into)
                .collect(),
            targets: vec![session.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let actor = auth
        .authenticate(&participant, registration.issued_credential.as_ref())
        .unwrap()
        .actor;
    let confirmed = |params| ConfirmedScriptInvocation {
        client_id: participant.clone(),
        call: Box::new(call(&actor, &session, TRUSTED_SCRIPT_ACTION, params)),
    };
    let input = |source: &str| {
        let digest =
            Sha256::digest([b"serial-workbench-script-v1\0ts\0", source.as_bytes()].concat());
        json!({
            "language": "ts",
            "source": source,
            "sourceSha256": format!("{digest:x}"),
            "sessionRevision": snapshot.revision,
            "configurationRevision": snapshot.configuration_revision,
        })
    };
    const SOURCE: &str = r#"
        export default async function run({serial, delay, log}: {serial: {send(bytes: Uint8Array): Promise<unknown>; read(cursor: string): Promise<{events: Array<{kind: string; payload: {bytesBase64: string}}>}>}; delay(ms: number): Promise<void>; log(text: string): void}) {
          const receipt = await serial.send(new Uint8Array([0, 255]));
          for (let attempt = 0; attempt < 25; attempt++) {
            const page = await serial.read("1");
            const rx = page.events.find((event: {kind: string}) => event.kind === "rx");
            if (rx) {
              log("echo");
              return { tx: receipt, rx: rx.payload.bytesBase64 };
            }
            await delay(10);
          }
          throw new Error("Expected Virtual Echo RX");
        }
    "#;
    assert_eq!(
        host.invoke(
            &actor,
            call(&actor, &session, TRUSTED_SCRIPT_ACTION, input(SOURCE))
        )
        .await
        .unwrap_err()
        .code,
        "PERMISSION_DENIED"
    );
    let mut changed = input(SOURCE);
    changed["source"] = json!("export default () => null;");
    assert_eq!(
        host.invoke_confirmed_script(&operator, confirmed(changed))
            .await
            .unwrap_err()
            .code,
        "SCRIPT_SOURCE_CHANGED"
    );
    let mut stale = input(SOURCE);
    stale["configurationRevision"] = json!("999");
    assert_eq!(
        host.invoke_confirmed_script(&operator, confirmed(stale))
            .await
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );

    let request = confirmed(input(SOURCE));
    let operation = host
        .invoke_confirmed_script(&operator, request.clone())
        .await
        .unwrap();
    let completed = settle(operation).await;
    let (_, persisted) = store.retained_operation(&completed.operation_id).unwrap();
    let persisted = persisted.unwrap();
    assert!(!persisted.contains_key("source"));
    assert!(persisted.contains_key("sourceSha256"));
    let replay = host
        .invoke_confirmed_script(&operator, request)
        .await
        .unwrap();
    assert_eq!(replay.operation_id, completed.operation_id);
    assert_eq!(completed.state, OperationState::Succeeded, "{completed:?}");
    let worker = completed.worker_observation.as_ref().unwrap();
    assert_eq!(worker.peak_workers.get(), 1);
    assert_eq!(worker.live_workers.get(), 0);
    let Some(ActionResult::Reference(output)) = completed.result else {
        panic!("Expected the signed script result");
    };
    let file = host
        .inner
        .files
        .read(
            FileReadParams {
                file_ref: output.result_ref.clone(),
                offset: 0.into(),
                max_bytes: 8192.into(),
            },
            &actor,
        )
        .unwrap();
    assert!(file.at_end);
    let output_ref = output.result_ref;
    let output: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(file.bytes_base64.as_str()).unwrap()).unwrap();
    assert_eq!(output["kind"], "completed");
    assert_eq!(output["logs"], json!(["echo"]));
    assert_eq!(output["value"]["rx"], "AP8=");
    assert_eq!(output["value"]["tx"]["bytesBase64"], "AP8=");
    assert_eq!(output["value"]["tx"]["outcome"], "accepted");
    let debugger_client = Id::try_from("script-debug-readback").unwrap();
    let debugger_reader = auth.authenticate(&debugger_client, None).unwrap().actor;
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: debugger_client.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![session.clone()],
            expires_at: None,
        },
    )
    .unwrap();

    let debug_source = [
        "export default async ({ serial }: { serial: { send(value: Uint8Array): Promise<unknown> } }) => {",
        "  const count: number = 14;",
        "  const next = count + 2;",
        "  await serial.send(new Uint8Array([next]));",
        "};",
    ].join("\n");
    let mut debug_input = input(&debug_source);
    debug_input["debugBreakpoints"] = json!([3]);
    let debugging = host
        .invoke_confirmed_script(&operator, confirmed(debug_input))
        .await
        .unwrap();
    let debug_request = |intent| ScriptDebugRequest {
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        client_id: participant.clone(),
        actor_id: actor.id().clone(),
        operation_id: debugging.operation_id.clone(),
        intent,
    };
    let wait_for_pause = |previous: U64| {
        let (host, operator, debug_request) = (&host, &operator, &debug_request);
        let (store, actor, operation_id) = (&store, &actor, &debugging.operation_id);
        async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let current = store.get(actor, operation_id).unwrap();
                    assert!(
                        !current.state.is_terminal(),
                        "Debugger exited before pause: {:?}",
                        current.error
                    );
                    let reply = host
                        .control_script_debugger(
                            operator,
                            debug_request(ScriptDebugIntent::Inspect),
                        )
                        .await;
                    match reply {
                        Ok(ScriptDebugResponse {
                            script_debug:
                                ScriptDebugResult::Snapshot {
                                    snapshot:
                                        snapshot @ ScriptDebugSnapshot::Paused { revision, .. },
                                },
                        }) if revision > previous => return snapshot,
                        Err(error) if error.code != "SCRIPT_DEBUG_UNAVAILABLE" => {
                            panic!("{error:?}")
                        }
                        _ => tokio::time::sleep(Duration::from_millis(10)).await,
                    }
                }
            })
            .await
            .unwrap()
        }
    };
    let first = wait_for_pause(0.into()).await;
    let ScriptDebugSnapshot::Paused {
        revision,
        frames,
        variables,
        ..
    } = first
    else {
        unreachable!()
    };
    assert_eq!(frames[0].line, 3);
    assert!(
        variables
            .iter()
            .any(|variable| variable.name == "count" && variable.preview == "14")
    );
    assert_eq!(
        host.control_script_debugger(&actor, debug_request(ScriptDebugIntent::Inspect))
            .await
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let other = ScriptDebugRequest {
        client_id: debugger_client.clone(),
        actor_id: debugger_reader.id().clone(),
        ..debug_request(ScriptDebugIntent::Inspect)
    };
    assert_eq!(
        host.control_script_debugger(&operator, other)
            .await
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let step = debug_request(ScriptDebugIntent::Command {
        command: ScriptDebugCommand::StepOver { revision },
    });
    assert_eq!(
        host.control_script_debugger(&operator, step)
            .await
            .unwrap()
            .script_debug,
        ScriptDebugResult::Accepted
    );
    let second = wait_for_pause(revision).await;
    let ScriptDebugSnapshot::Paused {
        frames, variables, ..
    } = second
    else {
        unreachable!()
    };
    assert_eq!(frames[0].line, 4);
    assert!(
        variables
            .iter()
            .any(|variable| variable.name == "next" && variable.preview == "16")
    );
    let stale = debug_request(ScriptDebugIntent::Command {
        command: ScriptDebugCommand::Continue { revision },
    });
    assert_eq!(
        host.control_script_debugger(&operator, stale)
            .await
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    let debug_target = Target {
        kind: ResourceKind::try_from("operation").unwrap(),
        id: debugging.operation_id.clone(),
        host_id: session.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let cancelled = host
        .invoke(
            &actor,
            call(
                &actor,
                &debug_target,
                "operation.cancel",
                json!({"reason":"user"}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(settle(cancelled).await.state, OperationState::Succeeded);
    let debug_receipt = settle(debugging.clone()).await;
    assert_eq!(debug_receipt.state, OperationState::Cancelled);
    assert_eq!(
        debug_receipt.worker_observation.unwrap().live_workers.get(),
        0
    );
    assert_eq!(
        host.control_script_debugger(&operator, debug_request(ScriptDebugIntent::Inspect))
            .await
            .unwrap_err()
            .code,
        "SCRIPT_DEBUG_UNAVAILABLE"
    );

    let wait_for_worker = |operation: Operation| {
        let store = store.clone();
        let actor = actor.clone();
        async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let current = store.get(&actor, &operation.operation_id).unwrap();
                    assert!(!current.state.is_terminal(), "{current:?}");
                    if current
                        .worker_observation
                        .as_ref()
                        .is_some_and(|worker| worker.live_workers.get() == 1)
                    {
                        return current;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap()
        }
    };
    const DELAYED: &str = r#"
        export default async ({ serial, delay }) => {
          await delay(30000);
          await serial.send(new Uint8Array([0xbe]));
        };
    "#;
    let delayed = host
        .invoke_confirmed_script(&operator, confirmed(input(DELAYED)))
        .await
        .unwrap();
    let running = wait_for_worker(delayed).await;
    let target = Target {
        kind: ResourceKind::try_from("operation").unwrap(),
        id: running.operation_id.clone(),
        host_id: session.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let cancel = host
        .invoke(
            &actor,
            call(
                &actor,
                &target,
                "operation.cancel",
                json!({"reason":"user"}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(settle(cancel).await.state, OperationState::Succeeded);
    let stopped = settle(running).await;
    assert_eq!(stopped.state, OperationState::Cancelled, "{stopped:?}");
    assert_eq!(stopped.worker_observation.unwrap().live_workers.get(), 0);

    let delayed = host
        .invoke_confirmed_script(&operator, confirmed(input(DELAYED)))
        .await
        .unwrap();
    let running = wait_for_worker(delayed).await;
    auth.revoke(
        &operator,
        RevokeParams {
            actor_id: actor.id().clone(),
            permissions: vec!["device.modify".into()],
            targets: vec![session.clone()],
        },
    )
    .unwrap();
    let revoked = settle(running).await;
    assert_ne!(revoked.state, OperationState::Succeeded, "{revoked:?}");
    assert_eq!(revoked.worker_observation.unwrap().live_workers.get(), 0);
    assert_eq!(
        host.invoke_confirmed_script(&operator, confirmed(input(DELAYED)))
            .await
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );

    let readback_client = Id::try_from("script-readback").unwrap();
    let readback = auth.authenticate(&readback_client, None).unwrap().actor;
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: readback_client,
            permissions: vec!["content.read".into()],
            targets: vec![session.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    assert_eq!(
        host.inner
            .files
            .read(
                FileReadParams {
                    file_ref: output_ref,
                    offset: 0.into(),
                    max_bytes: 8192.into(),
                },
                &readback
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let raw = host
        .inner
        .streams
        .read_prepared(
            &readback,
            StreamReadParams {
                session_id: session.session_id.unwrap(),
                session_epoch: session.session_epoch.unwrap(),
                start_event_seq: 1.into(),
                max_events: 32.into(),
                max_bytes: 8192.into(),
            },
        )
        .await
        .unwrap()
        .into_parts()
        .0;
    let writes: Vec<_> = raw
        .events
        .into_iter()
        .filter_map(|event| match event.payload {
            RawPayload::Tx(receipt) => Some(receipt),
            _ => None,
        })
        .collect();
    assert_eq!(writes.len(), 1, "Denied scripts must create no TX");
    assert_eq!(writes[0].bytes_base64.as_str(), "AP8=");
    assert_eq!(
        json!(writes[0].operation_id),
        output["value"]["tx"]["operationId"]
    );
    println!(
        "script_host raw_writes=1 bytes=00ff cancelled_live_workers=0 revoked_live_workers=0 shared_result_denied=true paused_lines=3,4 debug_cancel_live_workers=0 stale_debug_denied=true other_debug_actor_denied=true"
    );
}
