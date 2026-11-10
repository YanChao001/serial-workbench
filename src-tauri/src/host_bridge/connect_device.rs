//! Explicit local device selection; ordinary requests never grant permissions.
use super::DesktopHostBridge;
use serial_workbench_core::*;
use sha2::Digest as _;

mod stage_trace;
use stage_trace::ConnectTrace;

#[cfg(test)]
mod stage_tests;

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

fn checked_open_result(
    operation: &Operation,
    call: &Call,
    original_operation_id: &Id,
) -> HostResult<Option<OpenResult>> {
    if call.action_id.as_str() != "device.open"
        || call.target.kind.as_str() != "device"
        || call.target.host_id != call.host_id
        || operation.operation_id != *original_operation_id
        || operation.execution_host_id != call.host_id
        || operation.actor_id != call.actor_id
        || operation.request_id != call.request_id
        || operation.action_id != call.action_id
        || operation.target != call.target
    {
        return Err(HostError::new(
            "INTERNAL",
            "Device operation identity changed",
        ));
    }
    match operation.state {
        OperationState::Failed | OperationState::Interrupted | OperationState::Unknown => {
            let mut error = operation.error.clone().unwrap_or_else(|| {
                HostError::new("OPERATION_FAILED", "Device connection did not complete")
            });
            // 只有已核验的真实故障终态可与操作投影去重；保留原 OS 错误和详情。
            error.details.get_or_insert_with(Default::default).insert(
                "operationFailure".into(),
                JsonValue::Object(JsonObject::from([
                    (
                        "executionHostId".into(),
                        JsonValue::String(operation.execution_host_id.to_string()),
                    ),
                    (
                        "operationId".into(),
                        JsonValue::String(operation.operation_id.to_string()),
                    ),
                ])),
            );
            Err(error)
        }
        OperationState::Cancelled => Err(operation.error.clone().unwrap_or_else(|| {
            HostError::new("OPERATION_FAILED", "Device connection was cancelled")
        })),
        OperationState::Succeeded => match (&operation.result, &operation.error) {
            (Some(ActionResult::Opened(opened)), None) => Ok(Some(opened.clone())),
            _ => Err(HostError::new(
                "INTERNAL",
                "Invalid device operation result",
            )),
        },
        OperationState::Queued | OperationState::Running | OperationState::CancelRequested => {
            if operation.error.is_some() || operation.result.is_some() {
                return Err(HostError::new(
                    "INTERNAL",
                    "Invalid pending device operation",
                ));
            }
            Ok(None)
        }
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
        self.connect_device_intent_with_trace(
            window,
            generation,
            device_id,
            params,
            ConnectTrace::new(),
        )
        .await
    }

    async fn connect_device_intent_with_trace(
        &self,
        window: &str,
        generation: U64,
        device_id: Id,
        params: OpenParams,
        mut trace: ConnectTrace,
    ) -> HostResult<SessionSnapshot> {
        let result = self
            .connect_device_intent_stages(window, generation, device_id, params, &mut trace)
            .await;
        trace.finish(&result);
        result
    }

    async fn connect_device_intent_stages(
        &self,
        window: &str,
        generation: U64,
        device_id: Id,
        params: OpenParams,
        trace: &mut ConnectTrace,
    ) -> HostResult<SessionSnapshot> {
        trace.begin("attachment");
        let business = self.attachment_at_generation(window, generation).await?;
        trace.done();
        let device = Target {
            host_id: business.host_id.clone(),
            kind: ResourceKind::try_from("device")?,
            id: device_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        trace.begin("device-grant");
        self.grant_device_intent(
            window,
            generation,
            &business.client_id,
            device.clone(),
            &["metadata.read", "device.modify"],
        )
        .await?;
        trace.done();
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
        trace.begin("open-acceptance");
        let RpcResult::Operation(result) = unpack(
            self.request_at_generation(window, generation, RpcRequest::Invoke(call.clone()))
                .await?,
        )?
        else {
            return Err(HostError::new(
                "INTERNAL",
                "Invalid device operation response",
            ));
        };
        trace.done();
        let mut operation = result.operation;
        let original_operation_id = operation.operation_id.clone();
        let started = std::time::Instant::now();
        trace.begin("open-wait");
        let opened = loop {
            if let Some(opened) = checked_open_result(&operation, &call, &original_operation_id)? {
                break opened;
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
                serde_json::json!({"operationId":original_operation_id,"requestContext":business.request_context}),
            )?;
            trace.poll();
            let RpcResult::Operation(result) = unpack(
                self.read_request_at_generation(window, generation, RpcRequest::OperationGet(q))
                    .await?,
            )?
            else {
                return Err(HostError::new("INTERNAL", "Invalid operation response"));
            };
            operation = result.operation;
        };
        trace.done();
        let session = Target {
            host_id: business.host_id.clone(),
            kind: ResourceKind::try_from("session")?,
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
        };
        trace.begin("session-grant");
        self.grant_device_intent(
            window,
            generation,
            &business.client_id,
            session.clone(),
            &["metadata.read", "content.read", "device.modify"],
        )
        .await?;
        trace.done();
        let q = query(&business, "session.get", session, serde_json::json!({}))?;
        trace.begin("session-get");
        let snapshot = match unpack(
            self.read_request_at_generation(window, generation, RpcRequest::Query(q))
                .await?,
        )? {
            RpcResult::Query(QueryResult::Session(snapshot)) => Ok(snapshot),
            _ => Err(HostError::new("INTERNAL", "Invalid session response")),
        }?;
        trace.done();
        Ok(snapshot)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Call, Operation) {
        let call: Call = serde_json::from_value(serde_json::json!({
            "protocolVersion":"0.1", "hostId":"host", "instanceEpoch":"1", "actorId":"desktop-actor",
            "requestId":"00000000-0000-4000-8000-000000000114", "requestContext":"context",
            "actionId":"device.open", "target":{"hostId":"host","kind":"device","id":"COM14-device"},
            "params":{}, "revealTarget":{"pageId":"workbench"}, "executionMode":"interactive"
        })).unwrap();
        let operation = serde_json::from_value(serde_json::json!({
            "operationId":"open-operation", "executionHostId":"host", "actorId":"desktop-actor",
            "requestId":call.request_id, "admission":{"kind":"request","requestContextDigest":"0".repeat(64)},
            "rootOperationId":"open-operation", "childHighWatermark":"0", "actionId":"device.open",
            "target":call.target, "executionMode":"interactive", "state":"failed", "revision":"2",
            "revealTarget":{"pageId":"workbench"}, "acceptedAt":"2026-11-10T00:00:00Z",
            "settledAt":"2026-11-10T00:00:01Z", "owner":{"kind":"host","id":"host"},
            "error":{"code":"ACCESS_DENIED","message":"Native serial operation failed","retryable":false,
                "details":{"osCode":"5","phase":"open","nativeContext":"fixture-private"}}
        })).unwrap();
        (call, operation)
    }

    #[test]
    fn device_open_failure_identity_preserves_native_error_details() {
        let (call, operation) = fixture();
        for state in [
            OperationState::Failed,
            OperationState::Interrupted,
            OperationState::Unknown,
        ] {
            let mut terminal = operation.clone();
            terminal.state = state;
            let error = checked_open_result(&terminal, &call, &operation.operation_id).unwrap_err();
            let original = operation.error.as_ref().unwrap();
            assert_eq!(error.code, original.code);
            assert_eq!(error.message, original.message);
            assert_eq!(error.retryable, original.retryable);
            let details = error.details.as_ref().unwrap();
            for (key, value) in original.details.as_ref().unwrap().iter() {
                assert_eq!(details.get(key), Some(value));
            }
            assert_eq!(
                serde_json::to_value(details.get("operationFailure").unwrap()).unwrap(),
                serde_json::json!({"executionHostId":"host","operationId":"open-operation"})
            );
        }
    }

    #[test]
    fn device_open_failure_identity_requires_the_original_call_and_complete_target() {
        let (call, operation) = fixture();
        let mut mismatches = vec![operation.clone(); 9];
        mismatches[0].operation_id = Id::try_from("different-operation").unwrap();
        mismatches[1].execution_host_id = Id::try_from("different-host").unwrap();
        mismatches[2].actor_id = Id::try_from("different-actor").unwrap();
        mismatches[3].request_id =
            RequestId::try_from("00000000-0000-4000-8000-000000000115").unwrap();
        mismatches[4].action_id = Id::try_from("session.close").unwrap();
        mismatches[5].target.host_id = Id::try_from("different-host").unwrap();
        mismatches[6].target.id = Id::try_from("different-device").unwrap();
        mismatches[7].target.session_id = Some(Id::try_from("unexpected-session").unwrap());
        mismatches[8].target.session_epoch = Some(2.into());
        for mismatch in mismatches {
            let error = checked_open_result(&mismatch, &call, &operation.operation_id).unwrap_err();
            assert_eq!(error.code, "INTERNAL");
            assert!(error.details.is_none());
        }
        let mut wrong_kind = operation.clone();
        wrong_kind.target.kind = ResourceKind::try_from("host").unwrap();
        assert!(
            checked_open_result(&wrong_kind, &call, &operation.operation_id)
                .unwrap_err()
                .details
                .is_none()
        );
    }

    #[test]
    fn device_open_failure_identity_is_absent_for_rpc_pending_and_cancellation_errors() {
        let (call, operation) = fixture();
        let original = operation.error.clone().unwrap();
        let rpc_error = unpack(RpcReply::Failure {
            ok: False,
            error: original.clone(),
        })
        .unwrap_err();
        assert_eq!(rpc_error, original);
        assert!(
            !rpc_error
                .details
                .as_ref()
                .unwrap()
                .contains_key("operationFailure")
        );
        for state in [
            OperationState::Queued,
            OperationState::Running,
            OperationState::CancelRequested,
            OperationState::Succeeded,
        ] {
            let mut invalid = operation.clone();
            invalid.state = state;
            let error = checked_open_result(&invalid, &call, &operation.operation_id).unwrap_err();
            assert!(error.details.is_none());
        }
        let mut cancelled = operation.clone();
        cancelled.state = OperationState::Cancelled;
        assert_eq!(
            checked_open_result(&cancelled, &call, &operation.operation_id).unwrap_err(),
            original
        );
        let mut pending = operation.clone();
        pending.state = OperationState::Running;
        pending.error = None;
        assert!(
            checked_open_result(&pending, &call, &operation.operation_id)
                .unwrap()
                .is_none()
        );
    }
}
