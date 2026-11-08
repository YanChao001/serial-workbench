use super::process::{Binaries, Processes, Result, checked};
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient, RawConnection};
use serial_workbench_core::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

pub(super) fn id(value: &str) -> Id {
    Id::try_from(value).expect("harness-generated valid ID")
}
pub(super) fn request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).expect("UUID requestId")
}
pub(super) fn target(client: &HostClient, kind: &str, value: &str) -> Target {
    Target {
        host_id: client.attachment().host_id.clone(),
        kind: ResourceKind::try_from(kind).expect("builtin kind"),
        id: id(value),
        session_id: None,
        session_epoch: None,
    }
}
pub(super) fn host_target(client: &HostClient) -> Target {
    target(client, "host", client.attachment().host_id.as_str())
}
pub(super) fn reference_target(reference: &ObjectRef) -> Target {
    Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    }
}
pub(super) fn query(
    client: &HostClient,
    action: &str,
    target: &Target,
    params: Value,
) -> Result<Query> {
    let a = client.attachment();
    let mut reveal = checked(BuiltinAction::find(action))?.spec().reveal_target;
    reveal.session_id = target.session_id.clone();
    Ok(Query {
        protocol_version: a.protocol_version,
        host_id: a.host_id.clone(),
        instance_epoch: a.instance_epoch,
        actor_id: a.actor_id.clone(),
        request_id: request_id(),
        action_id: id(action),
        target: target.clone(),
        params: checked(serde_json::from_value(params))?,
        reveal_target: reveal,
    })
}
pub(super) fn call(
    client: &HostClient,
    action: &str,
    target: &Target,
    params: Value,
) -> Result<Call> {
    let q = query(client, action, target, params)?;
    Ok(Call {
        protocol_version: q.protocol_version,
        host_id: q.host_id,
        instance_epoch: q.instance_epoch,
        actor_id: q.actor_id,
        request_id: q.request_id,
        request_context: client.attachment().request_context.clone(),
        action_id: q.action_id,
        target: q.target,
        params: q.params,
        reveal_target: q.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: (action == "capture.start").then_some(ExecutionMode::Independent),
    })
}
pub(super) fn success(reply: RpcReply) -> Result<RpcResult> {
    match reply {
        RpcReply::Success { result, .. } => Ok(*result),
        RpcReply::Failure { error, .. } => Err(format!("{}: {}", error.code, error.message)),
    }
}
pub(super) async fn ask(
    client: &HostClient,
    action: &str,
    target: &Target,
    params: Value,
) -> Result<QueryResult> {
    let reply = checked(
        client
            .request(RpcRequest::Query(query(client, action, target, params)?))
            .await,
    )?;
    match success(reply)? {
        RpcResult::Query(value) => Ok(value),
        other => Err(format!("Expected QueryResult for {action}, got {other:?}")),
    }
}
pub(super) async fn raw_ask(
    client: &HostClient,
    raw: &RawConnection,
    action: &str,
    target: &Target,
    params: Value,
) -> Result<QueryResult> {
    match success(checked(
        raw.request(RpcRequest::Query(query(client, action, target, params)?))
            .await,
    )?)? {
        RpcResult::Query(value) => Ok(value),
        other => Err(format!(
            "Expected raw QueryResult for {action}, got {other:?}"
        )),
    }
}
pub(super) async fn invoke(
    client: &HostClient,
    action: &str,
    target: &Target,
    params: Value,
) -> Result<Operation> {
    match success(checked(
        client
            .request(RpcRequest::Invoke(call(client, action, target, params)?))
            .await,
    )?)? {
        RpcResult::Operation(value) => Ok(value.operation),
        other => Err(format!(
            "Expected accepted Operation for {action}, got {other:?}"
        )),
    }
}
pub(super) async fn operation(client: &HostClient, operation: &Operation) -> Result<Operation> {
    match ask(
        client,
        "operation.get",
        &target(client, "operation", operation.operation_id.as_str()),
        json!({"operationId":operation.operation_id}),
    )
    .await?
    {
        QueryResult::Operation(result) => Ok(result.operation),
        other => Err(format!("Expected Operation, got {other:?}")),
    }
}
pub(super) async fn settled(
    client: &HostClient,
    initial: &Operation,
    live: bool,
) -> Result<Operation> {
    checked(
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let current = operation(client, initial).await?;
                if (live && current.result.is_some())
                    || !matches!(
                        current.state,
                        OperationState::Queued
                            | OperationState::Running
                            | OperationState::CancelRequested
                    )
                {
                    return Ok(current);
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await,
    )?
}
pub(super) async fn action(
    client: &HostClient,
    action: &str,
    target: &Target,
    params: Value,
) -> Result<Operation> {
    let accepted = invoke(client, action, target, params).await?;
    let done = settled(client, &accepted, false).await?;
    if done.state != OperationState::Succeeded {
        return Err(format!("{action} failed: {:?}", done.error));
    }
    Ok(done)
}
pub(super) async fn open(client: &HostClient, device: &str) -> Result<Target> {
    let done = action(
        client,
        "device.open",
        &target(client, "device", device),
        json!({"configuration":SerialConfiguration::default()}),
    )
    .await?;
    let Some(ActionResult::Opened(opened)) = done.result else {
        return Err("device.open returned no Opened result".into());
    };
    let mut session = target(client, "session", opened.session_id.as_str());
    session.session_id = Some(opened.session_id);
    session.session_epoch = Some(opened.session_epoch);
    Ok(session)
}
pub(super) async fn connect(profile: &Path, name: &str, kind: ClientKind) -> Result<HostClient> {
    checked(
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match HostClient::connect(ConnectOptions::new(profile.into(), id(name), kind)).await
                {
                    Ok(client) => return client,
                    Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
                }
            }
        })
        .await,
    )
}
pub(super) async fn operator(profile: &Path, name: &str) -> Result<HostClient> {
    let credential = checked(serial_workbench_client::read_user_control_credential(
        profile,
    ))?;
    let mut options = ConnectOptions::new(profile.into(), id(name), ClientKind::Desktop);
    options.user_control_credential = Some(credential);
    checked(HostClient::connect(options).await)
}
pub(super) async fn grant(operator: &HostClient, name: &str, targets: Vec<Target>) -> Result<()> {
    action(operator,"auth.authorize",&host_target(operator),json!({"clientId":name,"permissions":["metadata.read","content.read","device.modify","workspace.modify"],"targets":targets})).await?;
    Ok(())
}

pub(super) struct Cli {
    pub binary: PathBuf,
    pub profile: PathBuf,
}
impl Cli {
    pub fn new(binaries: &Binaries, profile: &Path) -> Self {
        Self {
            binary: binaries.cli.clone(),
            profile: profile.into(),
        }
    }
    pub async fn query(
        &self,
        processes: &mut Processes,
        action: &str,
        target: &Target,
        params: Value,
    ) -> Result<QueryResult> {
        let target_path = write_private(&self.profile, "query-target", target)?;
        let params_path = write_private(&self.profile, "query-params", &params)?;
        let value = processes
            .cli(
                &self.binary,
                &self.profile,
                &[
                    "query".into(),
                    action.into(),
                    "--target-json".into(),
                    text_path(&target_path)?,
                    "--params-json".into(),
                    text_path(&params_path)?,
                ],
            )
            .await?;
        match success(checked(serde_json::from_value(value))?)? {
            RpcResult::Query(value) => Ok(value),
            other => Err(format!("CLI expected QueryResult, got {other:?}")),
        }
    }
}
pub(super) fn text_path(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "Scenario paths must be UTF-8".into())
}
pub(super) fn write_private(
    profile: &Path,
    prefix: &str,
    value: &impl serde::Serialize,
) -> Result<PathBuf> {
    let path = profile.join(format!("{prefix}-{}.json", uuid::Uuid::new_v4()));
    checked(std::fs::write(&path, checked(serde_json::to_vec(value))?))?;
    Ok(path)
}
