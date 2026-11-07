mod args;
mod output;

use args::{Command, InvokeOptions};
use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
use serial_workbench_core::*;
use std::{path::Path, process::ExitCode, time::Duration};

#[tokio::main]
async fn main() -> ExitCode {
    let result = match args::parse(std::env::args_os().skip(1)) {
        Ok(None) => {
            println!("{}", args::HELP);
            return ExitCode::SUCCESS;
        }
        Ok(Some(arguments)) => run(arguments).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(value) => match output::json(&value) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("{error}");
                ExitCode::from(output::exit_code(&error))
            }
        },
        Err(error) => {
            eprintln!("{error}");
            let code = output::exit_code(&error);
            let _ = output::json(&RpcReply::Failure { ok: False, error });
            ExitCode::from(code)
        }
    }
}

async fn run(arguments: args::Args) -> HostResult<serde_json::Value> {
    let mut options = ConnectOptions::new(
        arguments.profile.clone(),
        id("serial-workbench-cli"),
        ClientKind::Cli,
    );
    let client = HostClient::connect_or_start(options.clone()).await?;
    let client = if matches!(
        arguments.command,
        Command::UserControl { .. } | Command::HostStop { .. }
    ) {
        drop(client);
        // 只有显式本地用户入口读取该凭据，clientKind 本身不授予权限。
        options.user_control_credential = Some(read_user_control_credential(&arguments.profile)?);
        HostClient::connect(options).await?
    } else {
        client
    };
    let reply = match arguments.command {
        Command::Context { out } => {
            save_context(&out, client.attachment())?;
            return serde_json::to_value(client.attachment())
                .map_err(|_| HostError::new("OUTPUT_UNAVAILABLE", "Cannot encode Host context"));
        }
        Command::Catalog => {
            client
                .request(RpcRequest::CatalogList(query(
                    &client,
                    id("catalog.list"),
                    host_target(&client),
                    args::object(CatalogListParams {
                        page_size: 100.into(),
                        page_token: None,
                        catalog_version: None,
                    })?,
                )))
                .await?
        }
        Command::Query {
            action_id,
            target,
            params,
        } => {
            send(
                &client,
                RpcRequest::Query(query(&client, action_id, target, params)),
            )
            .await?
        }
        Command::Invoke {
            action_id,
            target,
            params,
            context,
            options,
        } => {
            validate_context(&client, &context, false)?;
            let mut call = call(&client, action_id, target, params, options);
            call.request_context = context.request_context;
            send(&client, RpcRequest::Invoke(call)).await?
        }
        Command::OperationGet(operation_id) => {
            client
                .request(RpcRequest::OperationGet(query(
                    &client,
                    id("operation.get"),
                    operation_target(&client, operation_id.clone()),
                    args::object(OperationGetParams::ById {
                        operation_id,
                        request_context: None,
                    })?,
                )))
                .await?
        }
        Command::OperationGetByRequest {
            request_id,
            context,
        } => {
            validate_context(&client, &context, true)?;
            client
                .request(RpcRequest::OperationGet(query(
                    &client,
                    id("operation.get"),
                    host_target(&client),
                    args::object(OperationGetParams::ByRequest {
                        actor_id: context.actor_id,
                        request_id,
                        request_context: context.request_context,
                    })?,
                )))
                .await?
        }
        Command::OperationCancel {
            id: operation_id,
            request_id,
        } => {
            client
                .request(RpcRequest::OperationCancel(call(
                    &client,
                    id("operation.cancel"),
                    operation_target(&client, operation_id),
                    args::object(OperationCancelParams {
                        reason: CancelReason::User,
                    })?,
                    InvokeOptions::new(request_id),
                )))
                .await?
        }
        Command::UserControl {
            action,
            params,
            request_id,
        } => {
            client
                .request(RpcRequest::Invoke(call(
                    &client,
                    id(action.action_id()),
                    host_target(&client),
                    params,
                    InvokeOptions::new(request_id),
                )))
                .await?
        }
        Command::HostStop { request_id } => {
            return stop_host(&client, &arguments.profile, request_id).await;
        }
    };
    encode_reply(reply)
}
async fn send(client: &HostClient, request: RpcRequest) -> HostResult<RpcReply> {
    match request.required_channel()? {
        RequestChannel::Raw => client.connect_raw().await?.request(request).await,
        RequestChannel::Control | RequestChannel::Either => client.request(request).await,
    }
}
fn query(client: &HostClient, action_id: Id, target: Target, params: JsonObject) -> Query {
    let attached = client.attachment();
    Query {
        protocol_version: attached.protocol_version,
        host_id: attached.host_id.clone(),
        instance_epoch: attached.instance_epoch,
        actor_id: attached.actor_id.clone(),
        request_id: args::new_request_id(),
        reveal_target: reveal(&action_id, &target),
        action_id,
        target,
        params,
    }
}
fn call(
    client: &HostClient,
    action_id: Id,
    target: Target,
    params: JsonObject,
    options: InvokeOptions,
) -> Call {
    let query = query(client, action_id, target, params);
    Call {
        protocol_version: query.protocol_version,
        host_id: query.host_id,
        instance_epoch: query.instance_epoch,
        actor_id: query.actor_id,
        request_id: options.request_id,
        request_context: client.attachment().request_context.clone(),
        action_id: query.action_id,
        target: query.target,
        params: query.params,
        reveal_target: query.reveal_target,
        expected_revision: options.expected_revision,
        lease_id: options.lease_id,
        execution_mode: options.execution_mode,
    }
}
fn reveal(action_id: &Id, target: &Target) -> RevealTarget {
    let mut reveal = BuiltinAction::find(action_id.as_str())
        .map(|action| action.spec().reveal_target)
        .unwrap_or_else(|_| RevealTarget {
            page_id: id("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        });
    reveal.session_id = target.session_id.clone();
    reveal
}
fn host_target(client: &HostClient) -> Target {
    Target {
        host_id: client.attachment().host_id.clone(),
        kind: ResourceKind::try_from("host").expect("host kind"),
        id: client.attachment().host_id.clone(),
        session_id: None,
        session_epoch: None,
    }
}
fn operation_target(client: &HostClient, operation_id: Id) -> Target {
    Target {
        kind: ResourceKind::try_from("operation").expect("operation kind"),
        id: operation_id,
        ..host_target(client)
    }
}
fn encode_reply(reply: RpcReply) -> HostResult<serde_json::Value> {
    if let RpcReply::Failure { error, .. } = reply {
        return Err(error);
    }
    serde_json::to_value(reply)
        .map_err(|_| HostError::new("OUTPUT_UNAVAILABLE", "Cannot encode Host response"))
}
fn id(value: &str) -> Id {
    Id::try_from(value).expect("builtin Id")
}

async fn stop_host(
    client: &HostClient,
    profile: &Path,
    request_id: RequestId,
) -> HostResult<serde_json::Value> {
    let host_id = client.attachment().host_id.clone();
    let instance_epoch = client.attachment().instance_epoch;
    let request = RpcRequest::Invoke(call(
        client,
        id("host.shutdown"),
        host_target(client),
        args::object(EmptyParams {})?,
        InvokeOptions::new(request_id),
    ));
    // 停机可能关闭回包连接；只发送一次，随后验证原实例的生命周期。
    let operation =
        match tokio::time::timeout(Duration::from_secs(10), client.request(request)).await {
            Ok(Ok(RpcReply::Success { result, .. })) => match *result {
                RpcResult::Operation(result) => Some(result.operation),
                _ => {
                    return Err(HostError::new(
                        "INVALID_ARGUMENT",
                        "Host returned an invalid shutdown response",
                    ));
                }
            },
            Ok(Ok(RpcReply::Failure { error, .. })) => return Err(error),
            Ok(Err(error)) if error.code == "UNAUTHENTICATED" => None,
            Ok(Err(error)) => return Err(error),
            Err(_) => None,
        };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let running = serial_workbench_ipc::profile_has_running_host(profile)?;
        let replaced = running
            && tokio::time::timeout_at(
                deadline,
                authenticated_replacement(client, &host_id, instance_epoch),
            )
            .await
            .unwrap_or(false);
        if !running || replaced {
            let mut stopped =
                serde_json::json!({"hostId":host_id,"instanceEpoch":instance_epoch,"stopped":true});
            if let Some(operation) = operation {
                stopped["operation"] = serde_json::to_value(operation).map_err(|_| {
                    HostError::new("OUTPUT_UNAVAILABLE", "Cannot encode shutdown Operation")
                })?;
            }
            return Ok(stopped);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(HostError::new(
                "HOST_STOP_TIMEOUT",
                "The attached Host instance has not stopped",
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn authenticated_replacement(client: &HostClient, host_id: &Id, instance_epoch: U64) -> bool {
    client.reconnect().await.is_ok_and(|replacement| {
        let attached = replacement.attachment();
        &attached.host_id == host_id && attached.instance_epoch > instance_epoch
    })
}

fn validate_context(client: &HostClient, saved: &AttachResult, historical: bool) -> HostResult<()> {
    let current = client.attachment();
    if saved.host_id != current.host_id {
        return Err(HostError::new(
            "HOST_ID_MISMATCH",
            "Request context belongs to another Host",
        ));
    }
    if saved.actor_id != current.actor_id || saved.client_id != current.client_id {
        return Err(HostError::new(
            "ACTOR_MISMATCH",
            "Request context belongs to another client or actor",
        ));
    }
    if saved.protocol_version != current.protocol_version {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "Request context uses a different protocol",
        ));
    }
    if !historical && saved.instance_epoch != current.instance_epoch {
        return Err(HostError::new(
            "EPOCH_MISMATCH",
            "Request context belongs to another Host instance",
        ));
    }
    Ok(())
}
fn save_context(path: &Path, attachment: &AttachResult) -> HostResult<()> {
    use std::io::Write;
    let unavailable = || {
        HostError::new(
            "STORAGE_UNAVAILABLE",
            "Cannot create context file; the destination must be a new file",
        )
    };
    let bytes = serde_json::to_vec(attachment).map_err(|_| unavailable())?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| unavailable())?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::sync::Arc;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn host_stop_authenticates_real_replacement_while_new_instance_lock_is_live() {
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let directory = tempfile::tempdir_in(temp).unwrap();
        let mut original = HostServer::bind(directory.path()).await.unwrap();
        let host_id = original.identity().host_id.clone();
        let old_epoch = original.identity().instance_epoch;
        let host = Host::new(original.store(), original.auth()).await.unwrap();
        let (stop, stopped) = oneshot::channel();
        let running = tokio::spawn(async move {
            original
                .serve_until(Arc::new(host), async {
                    let _ = stopped.await;
                })
                .await
        });
        let mut options = ConnectOptions::new(
            directory.path().into(),
            id("stop-replacement-probe"),
            ClientKind::Cli,
        );
        options.user_control_credential =
            Some(read_user_control_credential(directory.path()).unwrap());
        let client = HostClient::connect(options).await.unwrap();
        let same_instance = tokio::time::timeout(
            Duration::from_secs(10),
            authenticated_replacement(&client, &host_id, old_epoch),
        )
        .await;
        let _ = stop.send(());
        tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        let mut replacement = HostServer::bind(directory.path()).await.unwrap();
        let new_epoch = replacement.identity().instance_epoch;
        let replacement_host_id = replacement.identity().host_id.clone();
        let host = Host::new(replacement.store(), replacement.auth())
            .await
            .unwrap();
        let (stop, stopped) = oneshot::channel();
        let running = tokio::spawn(async move {
            replacement
                .serve_until(Arc::new(host), async {
                    let _ = stopped.await;
                })
                .await
        });
        // 新实例在认证探测前已持有 OS 锁，明确覆盖非“锁空闲”的成功分支。
        let lock_before = serial_workbench_ipc::profile_has_running_host(directory.path());
        let authenticated = tokio::time::timeout(
            Duration::from_secs(10),
            authenticated_replacement(&client, &host_id, old_epoch),
        )
        .await;
        let lock_after = serial_workbench_ipc::profile_has_running_host(directory.path());
        let _ = stop.send(());
        tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .unwrap()
            .unwrap()
            .unwrap();

        assert!(!same_instance.unwrap());
        assert_eq!(replacement_host_id, host_id);
        assert!(new_epoch > old_epoch);
        assert!(lock_before.unwrap());
        assert!(lock_after.unwrap());
        assert!(authenticated.unwrap());
    }
}
