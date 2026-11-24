use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use serial_workbench_client::read_user_control_credential;
use sha2::{Digest as _, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tokio::time::{sleep, timeout};

const CALENDAR: &str = "swb.builtin.automation.calendar";
const CLIENT: &str = "calendar-recovery-operator";

fn target(client: &HostClient, kind: &str, resource: Id) -> Target {
    Target {
        host_id: client.attachment().host_id.clone(),
        kind: ResourceKind::try_from(kind).unwrap(),
        id: resource,
        session_id: None,
        session_epoch: None,
    }
}

fn scoped_query(client: &HostClient, scope: Target, action: &str, params: Value) -> Query {
    Query {
        target: scope,
        params: serde_json::from_value(params).unwrap(),
        ..super::query(client, action)
    }
}

fn checked(reply: RpcReply) -> RpcResult {
    match reply {
        RpcReply::Success { result, .. } => *result,
        RpcReply::Failure { error, .. } => panic!("Host rejected recovery test request: {error:?}"),
    }
}

async fn invoke(client: &HostClient, scope: Target, action: &str, params: Value) -> Operation {
    let query = scoped_query(client, scope, action, params);
    let call = Call {
        protocol_version: query.protocol_version,
        host_id: query.host_id,
        instance_epoch: query.instance_epoch,
        actor_id: query.actor_id,
        request_id: query.request_id,
        action_id: query.action_id,
        target: query.target,
        params: query.params,
        reveal_target: query.reveal_target,
        request_context: client.attachment().request_context.clone(),
        expected_revision: None,
        lease_id: None,
        execution_mode: (action == CALENDAR).then_some(ExecutionMode::Independent),
    };
    let RpcResult::Operation(accepted) =
        checked(client.request(RpcRequest::Invoke(call)).await.unwrap())
    else {
        panic!("Missing operation acceptance");
    };
    accepted.operation
}

async fn operation(client: &HostClient, operation_id: &Id) -> Operation {
    let request = RpcRequest::OperationGet(scoped_query(
        client,
        target(client, "operation", operation_id.clone()),
        "operation.get",
        json!({"operationId": operation_id}),
    ));
    let RpcResult::Operation(receipt) = checked(client.request(request).await.unwrap()) else {
        panic!("Missing stored operation");
    };
    receipt.operation
}

async fn wait_operation(
    client: &HostClient,
    operation_id: &Id,
    ready: impl Fn(&Operation) -> bool,
) -> Operation {
    timeout(Duration::from_secs(12), async {
        loop {
            let current = operation(client, operation_id).await;
            if ready(&current) {
                return current;
            }
            assert!(
                !current.state.is_terminal(),
                "Unexpected task terminal state: {current:?}"
            );
            sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .expect("Operation did not reach its observed state")
}

async fn launch(
    executable: &Path,
    profile: &Path,
    evidence: &Path,
    label: &str,
    host: Option<Id>,
) -> (OwnedChild, HostClient, HostClient) {
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let log = evidence.join(format!("{label}.stderr"));
    let mut child = OwnedChild(
        command
            .arg("--profile")
            .arg(profile)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create_new(&log).unwrap())
            .spawn()
            .expect("Start production Host in its isolated profile"),
    );
    let mut options = ConnectOptions::new(profile.into(), id(CLIENT), ClientKind::Desktop);
    options.expected_host_executable = Some(executable.into());
    options.expected_host_id = host;
    let ordinary = timeout(Duration::from_secs(20), async {
        loop {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Host exited during startup, see {}",
                log.display()
            );
            if let Ok(connected) = HostClient::connect(options.clone()).await {
                return connected;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Host startup timed out, see {}", log.display()));
    options.user_control_credential = Some(read_user_control_credential(profile).unwrap());
    let control = HostClient::connect(options).await.unwrap();
    (child, ordinary, control)
}

async fn exit(child: &mut OwnedChild) -> std::process::ExitStatus {
    timeout(Duration::from_secs(10), async {
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                return status;
            }
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Isolated Host did not exit")
}

async fn automation_runtime(client: &HostClient) -> Digest {
    timeout(Duration::from_secs(22), async {
        loop {
            let query = Query {
                params: serde_json::from_value(json!({"id":"swb.builtin.automation"})).unwrap(),
                ..super::query(client, "node.packages.runtime")
            };
            let RpcResult::Query(QueryResult::NodePackageRuntime(runtime)) =
                checked(client.request(RpcRequest::Query(query)).await.unwrap())
            else {
                panic!("Missing signed automation status");
            };
            match runtime.phase {
                NodePackageRuntimePhase::Active => return runtime.archive_sha256.unwrap(),
                NodePackageRuntimePhase::Failed => panic!("Signed automation failed: {runtime:?}"),
                _ => sleep(Duration::from_millis(40)).await,
            }
        }
    })
    .await
    .expect("Signed automation did not become active")
}

async fn open_echo(client: &HostClient) -> (Target, U64) {
    let accepted = invoke(
        client,
        target(client, "device", id("virtual:echo")),
        "device.open",
        json!({"configuration":SerialConfiguration::default()}),
    )
    .await;
    let opened = wait_operation(client, &accepted.operation_id, |op| op.state.is_terminal()).await;
    assert_eq!(
        opened.state,
        OperationState::Succeeded,
        "{:?}",
        opened.error
    );
    let Some(ActionResult::Opened(session)) = opened.result else {
        panic!("Missing Virtual Echo session");
    };
    (
        Target {
            session_id: Some(session.session_id.clone()),
            session_epoch: Some(session.session_epoch),
            ..target(client, "session", session.session_id)
        },
        session.revision,
    )
}

async fn schedule(
    client: &HostClient,
    session: &Target,
    revision: U64,
    at: chrono::DateTime<Utc>,
    bytes: &[u8],
) -> Operation {
    invoke(
        client,
        session.clone(),
        CALENDAR,
        json!({
            "schedule":{"kind":"once","at":at.to_rfc3339_opts(SecondsFormat::Millis, true)},
            "sessionRevision":revision,
            "bytesBase64":STANDARD.encode(bytes),
        }),
    )
    .await
}

async fn raw_io(client: &HostClient, session: &Target) -> (Vec<u8>, Vec<u8>) {
    let raw = client.connect_raw().await.unwrap();
    let request = RpcRequest::StreamRead(scoped_query(
        client,
        session.clone(),
        "stream.read",
        json!({
            "sessionId":session.id,"sessionEpoch":session.session_epoch,
            "startEventSeq":"1","maxEvents":"100","maxBytes":"262144",
        }),
    ));
    let RpcResult::StreamRead(page) = checked(raw.request(request).await.unwrap()) else {
        panic!("Missing Virtual Echo raw evidence");
    };
    assert!(!page.has_more);
    let mut tx = Vec::new();
    let mut rx = Vec::new();
    for event in page.events {
        match event.payload {
            RawPayload::Tx(bytes) => {
                tx.extend(STANDARD.decode(bytes.bytes_base64.as_str()).unwrap())
            }
            RawPayload::Rx(bytes) => {
                rx.extend(STANDARD.decode(bytes.bytes_base64.as_str()).unwrap())
            }
            _ => {}
        }
    }
    (tx, rx)
}

#[tokio::test]
#[ignore = "Requires a prepared production Host layout and an isolated headless environment"]
async fn signed_calendar_does_not_replay_after_host_process_loss() {
    let executable = PathBuf::from(
        std::env::var_os("SWB_TEST_CALENDAR_HOST_BIN")
            .expect("Absolute production Host executable with verified bundled Node"),
    );
    assert!(executable.is_absolute());
    let executable = executable.canonicalize().unwrap();
    let output = PathBuf::from(
        std::env::var_os("SWB_TEST_CALENDAR_CRASH_OUTPUT").expect("New evidence directory"),
    );
    assert!(output.is_absolute());
    fs::create_dir_all(&output).unwrap();
    let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let (mut first, actor, control) =
        launch(&executable, profile.path(), &output, "before-crash", None).await;
    let identity = actor.attachment().clone();
    let grant = invoke(
        &control,
        target(&control, "host", identity.host_id.clone()),
        "auth.authorize",
        json!({
            "clientId":identity.client_id,
            "permissions":["metadata.read","content.read","device.modify"],
            "targets":[target(&actor, "host", identity.host_id.clone())],
        }),
    )
    .await;
    assert_eq!(
        wait_operation(&control, &grant.operation_id, |op| op.state.is_terminal())
            .await
            .state,
        OperationState::Succeeded
    );
    let bundle = automation_runtime(&actor).await;
    let (session, revision) = open_echo(&actor).await;
    let due = Utc::now() + chrono::Duration::seconds(24);
    let pending = schedule(&actor, &session, revision, due, b"OLD:CAL\n").await;
    let armed = wait_operation(&actor, &pending.operation_id, |op| {
        op.state == OperationState::Running
            && op
                .progress
                .as_ref()
                .is_some_and(|progress| progress.unit == "slots")
    })
    .await;
    assert_eq!(armed.child_high_watermark, 0.into());
    assert_eq!(armed.owner.id.as_str(), "swb.builtin.automation");
    assert_eq!(raw_io(&actor, &session).await, (Vec::new(), Vec::new()));
    assert!(Utc::now() < due);
    first
        .0
        .kill()
        .expect("Terminate only the spawned isolated Host");
    assert!(!exit(&mut first).await.success());
    drop(actor);
    drop(control);

    let (mut restarted, actor, control) = launch(
        &executable,
        profile.path(),
        &output,
        "after-crash",
        Some(identity.host_id.clone()),
    )
    .await;
    let restored = actor.attachment();
    assert_eq!(restored.host_id, identity.host_id);
    assert_eq!(restored.actor_id, identity.actor_id);
    assert_eq!(
        restored.instance_epoch.get(),
        identity.instance_epoch.get() + 1
    );
    let recovered = operation(&actor, &pending.operation_id).await;
    // 已派发的 Node 父任务按协议保留不确定性，串口效果用独立子回执和 Raw 核对。
    assert_eq!(recovered.state, OperationState::Unknown);
    assert!(recovered.settled_at.is_some());
    assert_eq!(recovered.child_high_watermark, 0.into());
    assert_eq!(automation_runtime(&actor).await, bundle);
    let (new_session, new_revision) = open_echo(&actor).await;
    assert!(new_session.session_epoch.unwrap() > session.session_epoch.unwrap());
    assert!(
        Utc::now() < due,
        "Restart and new device must be ready before the old slot"
    );
    let after_window = due + chrono::Duration::seconds(3);
    timeout(Duration::from_secs(35), async {
        while Utc::now() < after_window {
            sleep(Duration::from_millis(120)).await;
        }
    })
    .await
    .expect("Wait past the old schedule and its dispatch window");
    assert_eq!(operation(&actor, &pending.operation_id).await, recovered);
    assert_eq!(raw_io(&actor, &new_session).await, (Vec::new(), Vec::new()));

    let fresh_bytes = b"NEW:CAL\n";
    let fresh = schedule(
        &actor,
        &new_session,
        new_revision,
        Utc::now() + chrono::Duration::seconds(3),
        fresh_bytes,
    )
    .await;
    let settled = wait_operation(&actor, &fresh.operation_id, |op| op.state.is_terminal()).await;
    assert_eq!(
        settled.state,
        OperationState::Succeeded,
        "{:?}",
        settled.error
    );
    assert_eq!(settled.child_high_watermark, 1.into());
    timeout(Duration::from_secs(5), async {
        loop {
            let (tx, rx) = raw_io(&actor, &new_session).await;
            assert!(fresh_bytes.starts_with(&tx) && fresh_bytes.starts_with(&rx));
            if tx == fresh_bytes && rx == fresh_bytes {
                break;
            }
            sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .expect("Fresh signed schedule produced exactly one matched Virtual Echo round trip");
    assert_eq!(operation(&actor, &pending.operation_id).await, recovered);
    invoke(
        &control,
        target(&actor, "host", restored.host_id.clone()),
        "host.shutdown",
        json!({}),
    )
    .await;
    assert!(exit(&mut restarted).await.success());

    let receipt = json!({
        "hostBinarySha256":format!("{:x}", Sha256::digest(fs::read(&executable).unwrap())),
        "hostId":restored.host_id,
        "oldInstanceEpoch":identity.instance_epoch,
        "newInstanceEpoch":restored.instance_epoch,
        "oldSessionEpoch":session.session_epoch,
        "newSessionEpoch":new_session.session_epoch,
        "automationArchiveSha256":bundle,
        "oldOperation":recovered.operation_id,
        "oldState":recovered.state,
        "oldRevision":recovered.revision,
        "oldChildren":recovered.child_high_watermark,
        "oldDue":due.to_rfc3339(),
        "checkedAfterLatenessWindow":after_window.to_rfc3339(),
        "freshOperation":settled.operation_id,
        "freshConfirmedBytes":fresh_bytes.len(),
        "sameActor":true,
    });
    fs::write(
        output.join("receipt.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
}
