//! Explicit local device selection; ordinary requests never grant permissions.
use super::DesktopHostBridge;
use serial_workbench_core::*;
use sha2::Digest as _;

fn request_id() -> HostResult<RequestId> {
    let token = serial_workbench_ipc::identity::random_token();
    let hash = format!("{:x}", sha2::Sha256::digest(token.as_str().as_bytes()));
    RequestId::try_from(
        format!(
            "{}-{}-{}-{}-{}",
            &hash[..8],
            &hash[8..12],
            &hash[12..16],
            &hash[16..20],
            &hash[20..32]
        )
        .as_str(),
    )
}

fn query(
    attachment: &AttachResult,
    action: &str,
    target: Target,
    params: serde_json::Value,
) -> HostResult<Query> {
    Ok(Query {
        protocol_version: attachment.protocol_version,
        host_id: attachment.host_id.clone(),
        instance_epoch: attachment.instance_epoch,
        actor_id: attachment.actor_id.clone(),
        request_id: request_id()?,
        action_id: Id::try_from(action)?,
        target,
        params: serde_json::from_value(params)
            .map_err(|_| HostError::new("INVALID_ARGUMENT", "Invalid device parameters"))?,
        reveal_target: RevealTarget {
            page_id: Id::try_from("workbench")?,
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    })
}

fn unpack(reply: RpcReply) -> HostResult<RpcResult> {
    match reply {
        RpcReply::Success { result, .. } => Ok(*result),
        RpcReply::Failure { error, .. } => Err(error),
    }
}

impl DesktopHostBridge {
    pub(super) async fn connect_device_intent(
        &self,
        window: &str,
        generation: U64,
        device_id: Id,
        params: OpenParams,
    ) -> HostResult<SessionSnapshot> {
        let business = self.attachment_at_generation(window, generation).await?;
        let device = Target {
            host_id: business.host_id.clone(),
            kind: ResourceKind::try_from("device")?,
            id: device_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        self.grant_device_intent(
            window,
            generation,
            &business.client_id,
            device.clone(),
            &["metadata.read", "device.modify"],
        )
        .await?;
        let q = query(
            &business,
            "device.open",
            device,
            serde_json::to_value(params)
                .map_err(|_| HostError::new("INVALID_ARGUMENT", "Invalid device parameters"))?,
        )?;
        let call = Call {
            protocol_version: q.protocol_version,
            host_id: q.host_id,
            instance_epoch: q.instance_epoch,
            actor_id: q.actor_id,
            request_id: q.request_id,
            request_context: business.request_context.clone(),
            action_id: q.action_id,
            target: q.target,
            params: q.params,
            reveal_target: q.reveal_target,
            expected_revision: None,
            lease_id: None,
            execution_mode: Some(ExecutionMode::Interactive),
        };
        let RpcResult::Operation(result) = unpack(
            self.request_at_generation(window, generation, RpcRequest::Invoke(call))
                .await?,
        )?
        else {
            return Err(HostError::new(
                "INTERNAL",
                "Invalid device operation response",
            ));
        };
        let mut operation = result.operation;
        let started = std::time::Instant::now();
        let opened = loop {
            if let Some(error) = operation.error {
                return Err(error);
            }
            if let Some(result) = operation.result {
                match result {
                    ActionResult::Opened(opened)
                        if operation.state == OperationState::Succeeded =>
                    {
                        break opened;
                    }
                    _ => {
                        return Err(HostError::new(
                            "INTERNAL",
                            "Invalid device operation result",
                        ));
                    }
                }
            }
            if !matches!(
                operation.state,
                OperationState::Queued | OperationState::Running | OperationState::CancelRequested
            ) {
                return Err(HostError::new(
                    "OPERATION_FAILED",
                    "Device connection did not complete",
                ));
            }
            if started.elapsed() > std::time::Duration::from_secs(30) {
                return Err(HostError::new(
                    "TIMEOUT",
                    "Device connection remains pending",
                ));
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let target = Target {
                host_id: business.host_id.clone(),
                kind: ResourceKind::try_from("host")?,
                id: business.host_id.clone(),
                session_id: None,
                session_epoch: None,
            };
            let q = query(
                &business,
                "operation.get",
                target,
                serde_json::json!({"operationId":operation.operation_id,"requestContext":business.request_context}),
            )?;
            let RpcResult::Operation(result) = unpack(
                self.request_at_generation(window, generation, RpcRequest::OperationGet(q))
                    .await?,
            )?
            else {
                return Err(HostError::new("INTERNAL", "Invalid operation response"));
            };
            operation = result.operation;
        };
        let session = Target {
            host_id: business.host_id.clone(),
            kind: ResourceKind::try_from("session")?,
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
        };
        self.grant_device_intent(
            window,
            generation,
            &business.client_id,
            session.clone(),
            &["metadata.read", "content.read", "device.modify"],
        )
        .await?;
        let q = query(&business, "session.get", session, serde_json::json!({}))?;
        match unpack(
            self.request_at_generation(window, generation, RpcRequest::Query(q))
                .await?,
        )? {
            RpcResult::Query(QueryResult::Session(snapshot)) => Ok(snapshot),
            _ => Err(HostError::new("INTERNAL", "Invalid session response")),
        }
    }

    async fn grant_device_intent(
        &self,
        window: &str,
        generation: U64,
        client_id: &Id,
        target: Target,
        permissions: &[&str],
    ) -> HostResult<()> {
        let params = AuthorizeParams {
            client_id: client_id.clone(),
            permissions: permissions.iter().map(|p| (*p).into()).collect(),
            targets: vec![target],
            expires_at: None,
        };
        let result = crate::file_resource_commands::invoke_control(
            self,
            window,
            generation,
            "auth.authorize",
            serde_json::to_value(params)
                .map_err(|_| HostError::new("INVALID_ARGUMENT", "Invalid authorization"))?,
        )
        .await?;
        if matches!(result, ActionResult::AuthorizationChanged(_)) {
            Ok(())
        } else {
            Err(HostError::new("INTERNAL", "Invalid authorization response"))
        }
    }
}
