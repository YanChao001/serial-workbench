use super::{
    client::*,
    evidence::{Case, hash},
    process::{Binaries, Processes, Result, checked},
    scenarios::*,
};
use serde_json::json;
use serial_workbench_client::HostClient;
use serial_workbench_core::*;
use std::path::Path;

pub(super) async fn run(
    t03: &mut Case,
    t08: &mut Case,
    processes: &mut Processes,
    binaries: &Binaries,
    profile: &Path,
) -> Result<()> {
    let index = processes.start_host(&binaries.host, profile, false)?;
    let (user, control) = setup(profile).await?;
    let host_id = user.attachment().host_id.clone();
    let epoch = user.attachment().instance_epoch;
    let session = open(&user, "virtual:echo").await?;
    let destination = register(&control, &processes.log_dir.join("T08-capture")).await?;
    let transient = checked(user.reconnect().await)?;
    let (owner, live) = start_capture(&transient, &session, &destination).await?;
    drop(transient);
    let first = tx(&user, &session, b"after-rust-detach").await?;
    let first_status = capture_written(&user, &live, 0).await?;
    let cli = Cli::new(binaries, profile);
    let cli_snapshot = cli
        .query(processes, "session.get", &session, json!({}))
        .await?;
    let second = tx(&user, &session, b"after-cli-exit").await?;
    let second_status =
        capture_written(&user, &live, first_status.summary.watermarks.written.get()).await?;
    let mcp = Mcp::start(processes, &binaries.mcp, profile).await?;
    let mcp_snapshot = mcp.tool("swb_session_x2E_get", &session, json!({})).await?;
    let mcp_pid = mcp.close(processes).await?;
    let third = tx(&user, &session, b"after-mcp-exit").await?;
    let third_status =
        capture_written(&user, &live, second_status.summary.watermarks.written.get()).await?;
    let running = operation(&user, &owner).await?;
    let continues = running.state == OperationState::Running
        && third_status.owner_operation_id.as_ref() == Some(&owner.operation_id);
    let proof = json!({"formalHostPid":processes.children[index].record.pid,"owner":running,"rustDetached":first_status,"cliExited":second_status,"mcpExited":third_status,"mcpPid":mcp_pid,"cliSnapshot":cli_snapshot,"mcpSnapshot":mcp_snapshot,"writes":[first,second,third]});
    t03.check("client_detach_continues", continues, proof.clone())?;
    t08.check("capture_after_detach", continues, proof)?;
    let finalized = stop_capture(&user, &live).await?;
    let owner_final = settled(&user, &owner, false).await?;
    let verify = action(
        &user,
        "capture.verify",
        &reference_target(&finalized.capture_ref),
        json!({"captureRef":finalized.capture_ref}),
    )
    .await?;
    let Some(ActionResult::CaptureVerification(report)) = &verify.result else {
        return Err("Missing capture verification report".into());
    };
    let independent = checked(serial_workbench_host::capture::verify::verify_directory(
        &processes.log_dir.join("T08-capture"),
    ))?;
    t08.check("finalize_verified",finalized.capture_ref.revision.is_some() && finalized.summary.container_complete && report.container_complete && owner_final.state==OperationState::Succeeded && independent.report.source_fingerprint==report.source_fingerprint && independent.report.verified_prefix==report.verified_prefix,json!({"finalized":finalized,"ownerFinal":owner_final,"verification":report,"independentReadback":independent.report}))?;
    t08.artifact("T08-capture/manifest.json");
    replay(t08, &user, &finalized.capture_ref).await?;
    // Leave a second capture live when the production CLI explicitly stops Host.
    let shutdown_target =
        register(&control, &processes.log_dir.join("T03-shutdown-capture")).await?;
    let (shutdown_owner, shutdown_live) = start_capture(&user, &session, &shutdown_target).await?;
    let original_tx = tx(&user, &session, b"durable-no-replay").await?;
    capture_written(&user, &shutdown_live, 0).await?;
    drop(control);
    drop(user);
    let stop = processes
        .cli(&binaries.cli, profile, &["host".into(), "stop".into()])
        .await?;
    processes.children[index].wait(15).await?;
    let stopped = checked(serial_workbench_host::capture::verify::verify_directory(
        &processes.log_dir.join("T03-shutdown-capture"),
    ))?;
    t03.check("shutdown_settled",processes.children[index].record.exited && stopped.report.container_complete,json!({"productionCliStop":stop,"hostPid":processes.children[index].record.pid,"hostExited":processes.children[index].record.exited,"captureFinalizedOnStop":stopped.report}))?;
    let next = processes.start_host(&binaries.host, profile, false)?;
    let client = connect(profile, "scenario-user", ClientKind::Desktop).await?;
    let prior = operation(&client, &original_tx).await?;
    let capture_owner = operation(&client, &shutdown_owner).await?;
    let snapshot = checked(
        client
            .request(RpcRequest::Query(query(
                &client,
                "session.get",
                &session,
                json!({}),
            )?))
            .await,
    )?;
    let absent = matches!(&snapshot,RpcReply::Failure {error,..} if error.code=="NOT_FOUND");
    t03.check("restart_epoch_no_replay",client.attachment().host_id==host_id && client.attachment().instance_epoch.get()>epoch.get() && prior.result==original_tx.result && capture_owner.state==OperationState::Succeeded && absent,json!({"previousEpoch":epoch,"restartedEpoch":client.attachment().instance_epoch,"sameHostId":host_id,"restartedPid":processes.children[next].record.pid,"originalTx":original_tx,"persistedTx":prior,"settledCaptureOwner":capture_owner,"sessionAfterRestart":snapshot,"oldSessionOwnerAbsent":absent,"businessInvokeAfterRestart":false}))?;
    drop(client);
    processes
        .cli(&binaries.cli, profile, &["host".into(), "stop".into()])
        .await?;
    processes.children[next].wait(15).await?;
    Ok(())
}
async fn replay(case: &mut Case, user: &HostClient, capture: &ObjectRef) -> Result<()> {
    let opened = action(
        user,
        "replay.open",
        &reference_target(capture),
        json!({"captureRef":capture,"mode":"fastest"}),
    )
    .await?;
    let Some(ActionResult::Opened(value)) = opened.result else {
        return Err("Replay open result absent".into());
    };
    let mut target = target(user, "session", value.session_id.as_str());
    target.session_id = Some(value.session_id);
    target.session_epoch = Some(value.session_epoch);
    let raw = checked(user.connect_raw().await)?;
    let params = json!({"sessionId":target.id,"sessionEpoch":target.session_epoch,"maxRecords":"100","maxBytes":"262144"});
    let QueryResult::ReplayRead(first) =
        raw_ask(user, &raw, "replay.read", &target, params.clone()).await?
    else {
        return Err("Replay read result absent".into());
    };
    action(user,"replay.control",&target,json!({"sessionId":target.id,"sessionEpoch":target.session_epoch,"paused":true,"seekRecord":"1"})).await?;
    let QueryResult::ReplayRead(paused) =
        raw_ask(user, &raw, "replay.read", &target, params.clone()).await?
    else {
        return Err("Paused replay result absent".into());
    };
    action(user,"replay.control",&target,json!({"sessionId":target.id,"sessionEpoch":target.session_epoch,"paused":false,"seekRecord":"1"})).await?;
    let QueryResult::ReplayRead(seeked) =
        raw_ask(user, &raw, "replay.read", &target, params).await?
    else {
        return Err("Seeked replay result absent".into());
    };
    let rejected = tx(user, &target, b"must-not-reach-a-device").await;
    let readonly = match rejected {
        Err(_) => true,
        Ok(op) => op.state != OperationState::Succeeded,
    };
    let bytes = |records: &[ReplayRecord]| -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        for record in records {
            if let ReplayRecord::Inline { record } = record
                && let CaptureEntry::Event(event) = &record.entry
            {
                bytes.extend(rx(std::slice::from_ref(event.as_ref()))?);
            }
        }
        Ok(bytes)
    };
    let first_bytes = bytes(&first.records)?;
    let seeked_bytes = bytes(&seeked.records)?;
    case.check("replay_readonly_seek",readonly && paused.records.is_empty() && !first.records.is_empty() && first_bytes==seeked_bytes && first_bytes==b"after-rust-detachafter-cli-exitafter-mcp-exit",json!({"readonlyRejected":readonly,"first":first,"paused":paused,"seeked":seeked,"sourceRxSha256":hash(b"after-rust-detachafter-cli-exitafter-mcp-exit"),"replayRxSha256":hash(&first_bytes)}))?;
    action(user, "replay.close", &target, json!({})).await?;
    Ok(())
}
