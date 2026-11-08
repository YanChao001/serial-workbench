use super::{
    client::*,
    evidence::{Case, hash},
    process::{Binaries, Processes, Result, checked, drain},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rmcp::{ServiceExt, model::CallToolRequestParams};
use serde_json::{Value, json};
use serial_workbench_client::HostClient;
use serial_workbench_core::*;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

pub(super) struct Mcp {
    service: rmcp::service::RunningService<rmcp::RoleClient, ()>,
    index: usize,
    stderr: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
}
impl Mcp {
    pub async fn start(processes: &mut Processes, binary: &Path, profile: &Path) -> Result<Self> {
        let mut command = Command::new(binary);
        command
            .arg("--profile")
            .arg(profile)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child =
            super::process::Owned::spawn(command, "official MCP stdio server", &processes.log_dir)?;
        let stdin = child.child.stdin.take().ok_or("Missing MCP stdin")?;
        let stdout = child.child.stdout.take().ok_or("Missing MCP stdout")?;
        let stderr = tokio::spawn(drain(
            child.child.stderr.take().ok_or("Missing MCP stderr")?,
        ));
        let index = processes.children.len();
        processes.children.push(child);
        let service = checked(checked(
            tokio::time::timeout(Duration::from_secs(15), ().serve((stdout, stdin))).await,
        )?)?;
        Ok(Self {
            service,
            index,
            stderr,
        })
    }
    pub async fn tool(&self, name: &str, target: &Target, params: Value) -> Result<Value> {
        let result = checked(
            self.service
                .peer()
                .call_tool(
                    CallToolRequestParams::new(name.to_owned()).with_arguments(
                        json!({"target":target,"params":params})
                            .as_object()
                            .ok_or("MCP arguments")?
                            .clone(),
                    ),
                )
                .await,
        )?;
        if result.is_error == Some(true) {
            return Err(format!("MCP {name}: {:?}", result.content));
        }
        result
            .structured_content
            .ok_or_else(|| format!("MCP {name} missing structured result"))
    }
    pub async fn close(self, processes: &mut Processes) -> Result<u32> {
        checked(checked(
            tokio::time::timeout(Duration::from_secs(15), self.service.cancel()).await,
        )?)?;
        let child = &mut processes.children[self.index];
        child.wait(15).await?;
        let mut stderr = self.stderr;
        match tokio::time::timeout(Duration::from_secs(5), &mut stderr).await {
            Ok(bytes) => {
                let _ = checked(checked(bytes)?)?;
            }
            Err(error) => {
                stderr.abort();
                let _ = stderr.await;
                return Err(error.to_string());
            }
        }
        Ok(child.record.pid)
    }
}

pub(super) async fn setup(profile: &Path) -> Result<(HostClient, HostClient)> {
    let user = connect(profile, "scenario-user", ClientKind::Desktop).await?;
    let control = operator(profile, "scenario-user").await?;
    for (name, kind) in [
        ("serial-workbench-cli", ClientKind::Cli),
        ("serial-workbench-mcp", ClientKind::Mcp),
    ] {
        drop(connect(profile, name, kind).await?);
    }
    for name in [
        "scenario-user",
        "serial-workbench-cli",
        "serial-workbench-mcp",
    ] {
        grant(&control, name, vec![host_target(&user)]).await?;
    }
    Ok((user, control))
}

pub(super) async fn read(
    client: &HostClient,
    session: &Target,
    start: u64,
) -> Result<StreamReadResult> {
    let raw = checked(client.connect_raw().await)?;
    match raw_ask(client,&raw,"stream.read",session,json!({"sessionId":session.id,"sessionEpoch":session.session_epoch,"startEventSeq":start.to_string(),"maxEvents":"100","maxBytes":"262144"})).await?{
        QueryResult::StreamRead(result)=>Ok(result),other=>Err(format!("Expected stream.read, got {other:?}"))
    }
}
pub(super) fn rx(events: &[RawEvent]) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    for event in events {
        if let RawPayload::Rx(value) = &event.payload {
            bytes.extend(checked(STANDARD.decode(value.bytes_base64.as_str()))?);
        }
    }
    Ok(bytes)
}
pub(super) async fn tx(client: &HostClient, session: &Target, bytes: &[u8]) -> Result<Operation> {
    let initial = invoke(
        client,
        "session.tx",
        session,
        json!({"bytesBase64":STANDARD.encode(bytes),"writeWaitMs":"1000"}),
    )
    .await?;
    settled(client, &initial, false).await
}

pub(super) async fn parity(
    case: &mut Case,
    processes: &mut Processes,
    binaries: &Binaries,
    profile: &Path,
    user: &HostClient,
) -> Result<()> {
    let session = open(user, "harness:partial").await?;
    let cli = Cli::new(binaries, profile);
    let mcp = Mcp::start(processes, &binaries.mcp, profile).await?;
    let direct = ask(user, "session.get", &session, json!({})).await?;
    let from_cli = cli
        .query(processes, "session.get", &session, json!({}))
        .await?;
    let from_mcp: SessionSnapshot = checked(serde_json::from_value(
        mcp.tool("swb_session_x2E_get", &session, json!({})).await?,
    ))?;
    let QueryResult::Session(snapshot) = &direct else {
        return Err("No direct session snapshot".into());
    };
    case.check("three_clients_same_session",direct==from_cli && *snapshot==from_mcp,json!({"session":session,"rust":snapshot,"cli":from_cli,"officialMcp":from_mcp,"mcpPid":processes.children[mcp.index].record.pid}))?;
    let write = tx(user, &session, b"abcdef").await?;
    let direct = checked(
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let events = read(user, &session, 1).await?;
                if rx(&events.events)? == b"ab" && events.events.iter().any(|event| matches!(&event.payload,RawPayload::Tx(value) if value.operation_id==write.operation_id)) {
                    return Ok::<_, String>(events);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await,
    )??;
    let params = json!({"sessionId":session.id,"sessionEpoch":session.session_epoch,"startEventSeq":"1","maxEvents":"100","maxBytes":"262144"});
    let QueryResult::StreamRead(cli_read) = cli
        .query(processes, "stream.read", &session, params.clone())
        .await?
    else {
        return Err("CLI stream read result".into());
    };
    let mcp_read: StreamReadResult = checked(serde_json::from_value(
        mcp.tool("swb_stream_x2E_read", &session, params).await?,
    ))?;
    let Some(ActionResult::Tx(receipt)) = &write.result else {
        return Err(format!("Partial write missing receipt: {write:?}"));
    };
    case.check("rx_tx_hash",direct==cli_read && direct==mcp_read && rx(&direct.events)?==b"ab" && STANDARD.decode(receipt.bytes_base64.as_str()).ok().as_deref()==Some(b"abcdef"),json!({"txBytes":6,"txSha256":hash(b"abcdef"),"knownAcceptedBytes":2,"rxSha256":hash(&rx(&direct.events)?),"receipt":receipt,"events":direct,"cliEvents":cli_read,"mcpEvents":mcp_read}))?;
    // Observe again without issuing a second business write. The backend probe
    // independently records every actual begin_write call.
    let later = read(user, &session, 1).await?;
    let probe: Value = checked(serde_json::from_slice(&checked(std::fs::read(
        processes.log_dir.join("partial-probe.json"),
    ))?))?;
    let tx_count=later.events.iter().filter(|e|matches!(&e.payload,RawPayload::Tx(value) if value.operation_id==write.operation_id)).count();
    case.check(
        "partial_unknown_no_replay",
        receipt.accepted_ranges
            == vec![ByteRange {
                start: 0.into(),
                end: 2.into(),
            }]
            && receipt.unknown_ranges
                == vec![ByteRange {
                    start: 2.into(),
                    end: 4.into(),
                }]
            && tx_count == 1
            && probe["writes"]
                .as_array()
                .is_some_and(|writes| writes.len() == 1)
            && rx(&later.events)? == b"ab",
        json!({"operation":write,"backend":probe,"laterEvents":later,"receiptCount":tx_count}),
    )?;
    mcp.close(processes).await?;
    action(user, "session.close", &session, json!({})).await?;
    Ok(())
}

pub(super) async fn controls(case: &mut Case, user: &HostClient) -> Result<()> {
    let listed = ask(user, "device.list", &host_target(user), json!({})).await?;
    let QueryResult::Devices(devices) = &listed else {
        return Err("device.list result".into());
    };
    let virtual_device = devices
        .devices
        .iter()
        .find(|d| d.device_id.as_str() == "virtual:echo")
        .ok_or("Virtual capabilities absent")?;
    case.check(
        "capabilities",
        virtual_device.capabilities.configuration
            && virtual_device.capabilities.finite_break
            && virtual_device.capabilities.queue_status,
        json!({"deviceList":listed}),
    )?;
    let session = open(user, "harness:control").await?;
    let config = SerialConfiguration {
        baud_rate: PositiveU64::try_from(U64::from(19200)).expect("positive baud"),
        ..SerialConfiguration::default()
    };
    let partial = configure(user, &session, &config).await?;
    let Some(ActionResult::Configuration(receipt)) = &partial.result else {
        return Err("Missing config receipt".into());
    };
    let reconfigured = configure(user, &session, &config).await?;
    let Some(ActionResult::Configuration(applied)) = &reconfigured.result else {
        return Err("Missing reconfigure receipt".into());
    };
    // Distinct accepted operations queue through the real single session owner.
    let a = invoke(
        user,
        "session.tx",
        &session,
        json!({"bytesBase64":"AQID","writeWaitMs":"1000"}),
    )
    .await?;
    let b = invoke(
        user,
        "session.tx",
        &session,
        json!({"bytesBase64":"BAUG","writeWaitMs":"1000"}),
    )
    .await?;
    let a = settled(user, &a, false).await?;
    let b = settled(user, &b, false).await?;
    case.check(
        "partial_configuration",
        receipt
            .fields
            .iter()
            .any(|f| f.status != FieldStatus::Applied)
            && applied
                .fields
                .iter()
                .all(|f| f.status == FieldStatus::Applied)
            && a.state == OperationState::Succeeded
            && b.state == OperationState::Succeeded,
        json!({"partial":partial,"explicitReconfigure":reconfigured,"queuedWrites":[a,b]}),
    )?;
    let pending = invoke(user, "session.break", &session, json!({"durationMs":"10"})).await?;
    let broken = settled(user, &pending, false).await?;
    let snapshot = ask(user, "session.get", &session, json!({})).await?;
    let QueryResult::Session(state) = &snapshot else {
        return Err("session.get after BREAK".into());
    };
    let denied = invoke(
        user,
        "session.tx",
        &session,
        json!({"bytesBase64":"CQ==","writeWaitMs":"1000"}),
    )
    .await;
    let denied = match denied {
        Ok(op) => Some(settled(user, &op, false).await?),
        Err(_) => None,
    };
    case.check(
        "break_cleanup_isolation",
        state.control_state == ControlState::Unknown
            && state.tx_gate == TxGate::ControlUnknown
            && denied
                .as_ref()
                .is_none_or(|op| op.state != OperationState::Succeeded),
        json!({"breakOperation":broken,"isolatedSnapshot":snapshot,"attemptedTx":denied}),
    )
}

async fn configure(
    user: &HostClient,
    session: &Target,
    configuration: &SerialConfiguration,
) -> Result<Operation> {
    let QueryResult::Session(snapshot) = ask(user, "session.get", session, json!({})).await? else {
        return Err("Configuration requires the current session revision".into());
    };
    let mut request = call(
        user,
        "session.configure",
        session,
        json!({"requested":configuration}),
    )?;
    request.expected_revision = Some(snapshot.revision);
    let RpcResult::Operation(accepted) =
        success(checked(user.request(RpcRequest::Invoke(request)).await)?)?
    else {
        return Err("Configuration did not return an accepted operation".into());
    };
    let done = settled(user, &accepted.operation, false).await?;
    if done.state != OperationState::Succeeded {
        return Err(format!("session.configure failed: {:?}", done.error));
    }
    Ok(done)
}

pub(super) async fn register(control: &HostClient, path: &Path) -> Result<ObjectRef> {
    let op = action(
        control,
        "file.register",
        &host_target(control),
        json!({"path":text_path(path)?,"purpose":"capture_target"}),
    )
    .await?;
    match op.result {
        Some(ActionResult::FileMetadata(value)) => Ok(value.file_ref),
        _ => Err("file.register missing FileMetadata".into()),
    }
}
pub(super) async fn start_capture(
    user: &HostClient,
    session: &Target,
    destination: &ObjectRef,
) -> Result<(Operation, ObjectRef)> {
    let owner = invoke(
        user,
        "capture.start",
        &reference_target(destination),
        json!({"sessionRefs":[session],"targetRef":destination,"overflowPolicy":"stop"}),
    )
    .await?;
    let live = settled(user, &owner, true).await?;
    match live.result {
        Some(ActionResult::Reference(value)) if live.state == OperationState::Running => {
            Ok((owner, value.result_ref))
        }
        _ => Err(format!(
            "capture.start did not produce live independent owner: {live:?}"
        )),
    }
}
pub(super) async fn capture_status(
    user: &HostClient,
    reference: &ObjectRef,
) -> Result<CaptureStatusResult> {
    match ask(
        user,
        "capture.status",
        &reference_target(reference),
        json!({"captureRef":reference}),
    )
    .await?
    {
        QueryResult::CaptureStatus(status) => Ok(status),
        other => Err(format!("capture.status returned {other:?}")),
    }
}
pub(super) async fn capture_written(
    user: &HostClient,
    reference: &ObjectRef,
    after: u64,
) -> Result<CaptureStatusResult> {
    checked(
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let status = capture_status(user, reference).await?;
                if status.summary.watermarks.written.get() > after {
                    return Ok::<_, String>(status);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await,
    )?
}
pub(super) async fn stop_capture(
    user: &HostClient,
    reference: &ObjectRef,
) -> Result<CaptureStatusResult> {
    let done = action(
        user,
        "capture.stop",
        &reference_target(reference),
        json!({"captureRef":reference}),
    )
    .await?;
    match done.result {
        Some(ActionResult::CaptureStatus(status)) => Ok(status),
        _ => Err("capture.stop missing final CaptureStatus".into()),
    }
}
