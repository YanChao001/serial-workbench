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
    let debug_request = |operation_id: &Id, intent| ScriptDebugRequest {
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        client_id: participant.clone(),
        actor_id: actor.id().clone(),
        operation_id: operation_id.clone(),
        intent,
    };
    let wait_for_pause = |operation_id: Id, previous: U64| {
        let (host, operator, debug_request) = (&host, &operator, &debug_request);
        let (store, actor) = (&store, &actor);
        async move {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let current = store.get(actor, &operation_id).unwrap();
                    assert!(
                        !current.state.is_terminal(),
                        "Debugger exited before pause: {:?}",
                        current.error
                    );
                    let reply = host
                        .control_script_debugger(
                            operator,
                            debug_request(&operation_id, ScriptDebugIntent::Inspect),
                        )
                        .await;
                    match reply {
                        Ok((
                            ScriptDebugResponse {
                                script_debug:
                                    ScriptDebugResult::Snapshot {
                                        snapshot:
                                            snapshot @ ScriptDebugSnapshot::Paused { revision, .. },
                                    },
                            },
                            Some(guard),
                        )) if revision > previous => return (snapshot, guard),
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
    let (first, _) = wait_for_pause(debugging.operation_id.clone(), 0.into()).await;
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
        host.control_script_debugger(
            &actor,
            debug_request(&debugging.operation_id, ScriptDebugIntent::Inspect)
        )
        .await
        .err()
        .unwrap()
        .code,
        "PERMISSION_DENIED"
    );
    let other = ScriptDebugRequest {
        client_id: debugger_client.clone(),
        actor_id: debugger_reader.id().clone(),
        ..debug_request(&debugging.operation_id, ScriptDebugIntent::Inspect)
    };
    assert_eq!(
        host.control_script_debugger(&operator, other)
            .await
            .err()
            .unwrap()
            .code,
        "PERMISSION_DENIED"
    );
    let step = debug_request(
        &debugging.operation_id,
        ScriptDebugIntent::Command {
            command: ScriptDebugCommand::StepOver { revision },
        },
    );
    assert_eq!(
        host.control_script_debugger(&operator, step)
            .await
            .unwrap()
            .0
            .script_debug,
        ScriptDebugResult::Accepted
    );
    let (second, _) = wait_for_pause(debugging.operation_id.clone(), revision).await;
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
    let stale = debug_request(
        &debugging.operation_id,
        ScriptDebugIntent::Command {
            command: ScriptDebugCommand::Continue { revision },
        },
    );
    assert_eq!(
        host.control_script_debugger(&operator, stale)
            .await
            .err()
            .unwrap()
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
        host.control_script_debugger(
            &operator,
            debug_request(&debugging.operation_id, ScriptDebugIntent::Inspect)
        )
        .await
        .err()
        .unwrap()
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

    let mut debug_input = input(&debug_source);
    debug_input["debugBreakpoints"] = json!([3]);
    let to_revoke = host
        .invoke_confirmed_script(&operator, confirmed(debug_input))
        .await
        .unwrap();
    let (_, queued_snapshot) = wait_for_pause(to_revoke.operation_id.clone(), 0.into()).await;
    let raw_during_pause = host
        .inner
        .streams
        .read_prepared(
            &debugger_reader,
            StreamReadParams {
                session_id: session.session_id.clone().unwrap(),
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
    assert!(raw_during_pause.events.iter().any(|event| {
        matches!(&event.payload, RawPayload::Rx(receipt) if receipt.bytes_base64.as_str() == "AP8=")
    }));
    assert!(
        host.control_script_debugger(
            &operator,
            debug_request(&to_revoke.operation_id, ScriptDebugIntent::Inspect)
        )
        .await
        .is_ok()
    );

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
    assert!(auth.validate_grants(&queued_snapshot.stamp).is_err());
    let debug_revoked = settle(to_revoke).await;
    assert_ne!(
        debug_revoked.state,
        OperationState::Succeeded,
        "{debug_revoked:?}"
    );
    assert_eq!(
        debug_revoked.worker_observation.unwrap().live_workers.get(),
        0
    );
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
                session_id: session.session_id.clone().unwrap(),
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
        "script_host raw_writes=1 bytes=00ff cancelled_live_workers=0 revoked_live_workers=0 shared_result_denied=true paused_lines=3,4 debug_cancel_live_workers=0 stale_debug_denied=true other_debug_actor_denied=true debug_revoked_live_workers=0 queued_snapshot_denied=true raw_during_pause=true"
    );

    let payload: Vec<u8> = (0..770).map(|index| ((index * 3) % 251) as u8).collect();
    let path = profile.path().join("recorded-sequence-file.bin");
    std::fs::write(&path, &payload).unwrap();
    let source_ref = host
        .inner
        .files
        .register(
            RegisterFileParams {
                path: path.to_str().unwrap().into(),
                purpose: FilePurpose::ReadFile,
            },
            &operator,
        )
        .unwrap();
    let file_target = Target {
        host_id: source_ref.host_id.clone(),
        id: source_ref.id.clone(),
        kind: source_ref.kind.clone(),
        session_id: None,
        session_epoch: None,
    };
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: participant.clone(),
            permissions: vec!["device.modify".into()],
            targets: vec![session.clone()],
            expires_at: None,
        },
    )
    .unwrap();
    let cursor = host.inner.streams.current_cursor(&session).unwrap();
    let start = cursor.position.checked_next().unwrap();
    let definition = json!({
        "version": 2,
        "steps": [
            {"kind": "send", "hex": "FE"},
            {"kind": "file", "input": "payload", "offset": "1", "length": "768",
                "chunkBytes": "256", "bytesPerSecond": "1048576", "interChunkMs": "0",
                "writeWaitMs": "2000"},
            {"kind": "send", "hex": "FD"}
        ],
    })
    .to_string();
    let file_call = || {
        call(
            &actor,
            &session,
            "swb.builtin.automation.sequence",
            json!({
                "definition": definition,
                "startEventSeq": start,
                "fileBindings": [{"input": "payload", "sourceRef": source_ref}],
            }),
        )
    };
    let denied = host.invoke(&actor, file_call()).await.unwrap_err();
    assert_eq!(denied.code, "PERMISSION_DENIED");
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: participant,
            permissions: vec!["content.read".into()],
            targets: vec![file_target],
            expires_at: None,
        },
    )
    .unwrap();
    let done = settle(host.invoke(&actor, file_call()).await.unwrap()).await;
    assert_eq!(done.state, OperationState::Succeeded, "{done:?}");
    let Some(ActionResult::Reference(report)) = done.result else {
        panic!("Expected a sequence report");
    };
    let report = host
        .inner
        .files
        .read(
            FileReadParams {
                file_ref: report.result_ref,
                offset: 0.into(),
                max_bytes: 8192.into(),
            },
            &actor,
        )
        .unwrap();
    let value: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(report.bytes_base64.as_str()).unwrap()).unwrap();
    assert_eq!(value["outcome"], "completed", "{value}");
    assert_eq!(value["completedSteps"], 3);
    let transfer_id = Id::try_from(value["attempts"][1]["operationId"].as_str().unwrap()).unwrap();
    let transfer = store.get(&actor, &transfer_id).unwrap();
    assert_eq!(transfer.action_id.as_str(), "transfer.file");
    assert!(
        matches!(transfer.admission, Admission::Child { parent_operation_id, .. }
        if parent_operation_id == done.operation_id)
    );
    let Some(ActionResult::FileTransfer(receipt)) = transfer.result else {
        panic!("Expected file-transfer result");
    };
    assert_eq!(receipt.accepted, 768.into());
    assert_eq!(receipt.unknown, 0.into());
    let raw = host
        .inner
        .streams
        .read_prepared(
            &readback,
            StreamReadParams {
                session_id: session.session_id.unwrap(),
                session_epoch: session.session_epoch.unwrap(),
                start_event_seq: start,
                max_events: 32.into(),
                max_bytes: 8192.into(),
            },
        )
        .await
        .unwrap()
        .into_parts()
        .0;
    let writes = raw
        .events
        .into_iter()
        .filter_map(|event| match event.payload {
            RawPayload::Tx(receipt) => Some(receipt),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(writes.len(), 5);
    assert_eq!(writes[0].bytes_base64.as_str(), "/g==");
    for (index, write) in writes[1..4].iter().enumerate() {
        assert_eq!(write.operation_id, transfer_id);
        assert_eq!(
            STANDARD.decode(write.bytes_base64.as_str()).unwrap(),
            &payload[(1 + 256 * index)..(1 + 256 * (index + 1))],
        );
    }
    assert_eq!(writes[4].bytes_base64.as_str(), "/Q==");
    println!(
        "sequence_file denied_without_source=true child_receipt=768 raw_order=fe,file256,file256,file256,fd"
    );
}
