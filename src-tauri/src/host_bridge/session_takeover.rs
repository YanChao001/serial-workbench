//! 将窗口中明确发起的串口接管转给本机用户控制连接。
use super::{DesktopHostBridge, local_request_id};
use serial_workbench_core::*;

impl DesktopHostBridge {
    async fn takeover_session(
        &self,
        window: &str,
        generation: U64,
        target: Target,
        actor_id: Id,
    ) -> HostResult<Operation> {
        let attachment = self
            .control_attachment_at_generation(window, generation)
            .await?;
        let call = takeover_call(attachment, target, actor_id)?;
        match self
            .control_request_at_generation(window, generation, RpcRequest::Invoke(call))
            .await?
        {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Operation(result) => Ok(result.operation),
                _ => Err(HostError::new("INTERNAL", "Invalid takeover response")),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }

    async fn decide_browser_takeover(
        &self,
        window: &str,
        generation: U64,
        takeover_id: Id,
        approve: bool,
    ) -> HostResult<()> {
        let request = RpcRequest::BrowserTakeover(BrowserTakeoverParams::Decide {
            takeover_id,
            approve,
        });
        match self
            .control_request_at_generation(window, generation, request)
            .await?
        {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Operation(_) if approve => Ok(()),
                RpcResult::Closed(_) if !approve => Ok(()),
                _ => Err(HostError::new(
                    "INTERNAL",
                    "Invalid browser takeover response",
                )),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }
}

fn takeover_call(attachment: AttachResult, target: Target, actor_id: Id) -> HostResult<Call> {
    target.validate()?;
    if target.host_id != attachment.host_id {
        return Err(HostError::new(
            "HOST_ID_MISMATCH",
            "Session belongs to a different Host",
        ));
    }
    if target.kind.as_str() != "session" || target.session_epoch.is_none() {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "Takeover requires a specific serial session",
        ));
    }
    let spec = BuiltinAction::SessionTakeover.spec();
    let params = serde_json::to_value(TakeoverParams {
        actor_id,
        reason: TakeoverReason::User,
    })
    .and_then(serde_json::from_value)
    .map_err(|_| HostError::new("INTERNAL", "Invalid takeover parameters"))?;
    Ok(Call {
        protocol_version: attachment.protocol_version,
        host_id: attachment.host_id,
        instance_epoch: attachment.instance_epoch,
        actor_id: attachment.actor_id,
        request_id: local_request_id()?,
        request_context: attachment.request_context,
        action_id: spec.action_id.clone(),
        reveal_target: spec.reveal_target.clone(),
        target,
        params,
        expected_revision: None,
        lease_id: None,
        execution_mode: Some(ExecutionMode::Interactive),
    })
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_takeover_session(
    window: tauri::WebviewWindow,
    generation: U64,
    target: Target,
    actor_id: Id,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<Operation> {
    state.bind_window(&window)?;
    state
        .takeover_session(window.label(), generation, target, actor_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_decide_browser_takeover(
    window: tauri::WebviewWindow,
    generation: U64,
    takeover_id: Id,
    approve: bool,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<()> {
    state.bind_window(&window)?;
    state
        .decide_browser_takeover(window.label(), generation, takeover_id, approve)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_bridge::tests::query;
    use serial_workbench_client::{ConnectOptions, HostClient};
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};

    async fn can_send(client: &HostClient, target: &Target) -> bool {
        let mut query = query(
            client.attachment(),
            "action.check",
            serde_json::json!({
                "actionId": "session.tx", "params": { "bytesBase64": "WA==", "writeWaitMs": "1000" }
            }),
            "b010515e-e27c-4ece-8690-b8b664ad3212",
        );
        query.target = target.clone();
        let reply = client.request(RpcRequest::Query(query)).await.unwrap();
        let RpcReply::Success { result, .. } = reply else {
            panic!("{reply:?}");
        };
        let RpcResult::Query(QueryResult::ActionCheck(checked)) = *result else {
            panic!("{result:?}");
        };
        checked.allowed
    }

    #[tokio::test]
    async fn desktop_takeover_revokes_the_selected_actor_and_keeps_the_session() {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let profile = directory.path();
        let mut server = HostServer::bind(profile).await.unwrap();
        let auth = server.auth();
        let operator = auth
            .authenticate_user_control(
                &Id::try_from("test-operator").unwrap(),
                &serial_workbench_client::read_user_control_credential(profile).unwrap(),
            )
            .unwrap();
        let host = Host::new(server.store(), auth.clone()).await.unwrap();
        let (stop, done) = tokio::sync::oneshot::channel();
        let handler = host.clone();
        let serve = tokio::spawn(async move {
            server
                .serve_until(Arc::new(handler), async {
                    let _ = done.await;
                })
                .await
        });
        let bridge = DesktopHostBridge::new(profile.to_path_buf());
        let desktop = bridge.attach("main").await.unwrap();
        let generation = desktop.generation;
        let opened = bridge
            .connect_device_intent(
                "main",
                generation,
                Id::try_from("virtual:echo").unwrap(),
                OpenParams {
                    configuration: SerialConfiguration::default(),
                    binding: None,
                },
            )
            .await
            .unwrap();
        let target = Target {
            host_id: desktop.attachment.host_id.clone(),
            id: opened.session_id.clone(),
            kind: ResourceKind::try_from("session").unwrap(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
        };
        let mut mcp = Vec::new();
        for name in ["bench-primary", "bench-secondary"] {
            let client_id = Id::try_from(name).unwrap();
            let client = HostClient::connect(ConnectOptions::new(
                profile.to_path_buf(),
                client_id.clone(),
                ClientKind::Mcp,
            ))
            .await
            .unwrap();
            auth.authorize(
                &operator,
                AuthorizeParams {
                    client_id,
                    permissions: vec!["device.modify".into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
            assert!(can_send(&client, &target).await);
            mcp.push(client);
        }
        let actor = mcp[0].attachment().actor_id.clone();
        let ordinary =
            takeover_call(mcp[1].attachment().clone(), target.clone(), actor.clone()).unwrap();
        let denied = mcp[1].request(RpcRequest::Invoke(ordinary)).await.unwrap();
        assert!(
            matches!(denied, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
        );
        let stale = bridge
            .takeover_session(
                "main",
                generation.checked_next().unwrap(),
                target.clone(),
                actor.clone(),
            )
            .await
            .unwrap_err();
        assert_eq!(stale.code, "EPOCH_MISMATCH");
        let accepted = bridge
            .takeover_session("main", generation, target.clone(), actor)
            .await
            .unwrap();
        assert_eq!(accepted.actor_id, *operator.id());
        let settled = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let mut read = query(
                    &desktop.attachment,
                    "operation.get",
                    serde_json::json!({"operationId": accepted.operation_id}),
                    "b010515e-e27c-4ece-8690-b8b664ad3213",
                );
                read.request_id = local_request_id().unwrap();
                let reply = bridge
                    .request_for_generation("main", generation, RpcRequest::OperationGet(read))
                    .await
                    .unwrap();
                let RpcReply::Success { result, .. } = reply else {
                    panic!("{reply:?}");
                };
                let RpcResult::Operation(result) = *result else {
                    panic!("{result:?}");
                };
                if result.operation.state.is_terminal() {
                    break result.operation;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(settled.state, OperationState::Succeeded);
        assert!(matches!(settled.result, Some(ActionResult::Takeover(_))));
        assert!(!can_send(&mcp[0], &target).await);
        assert!(can_send(&mcp[1], &target).await);
        let still_open = host.devices().snapshot(&target).await.unwrap();
        assert_eq!(still_open.state, SessionState::Open);
        assert_eq!(still_open.session_epoch, opened.session_epoch);
        assert_eq!(bridge.attach("main").await.unwrap().generation, generation);
        drop(mcp);
        drop(bridge);
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(8), serve)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
