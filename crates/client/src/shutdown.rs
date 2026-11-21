use crate::HostClient;
use serial_workbench_core::*;
use std::time::Duration;

impl HostClient {
    /// Delivers one shutdown request. Lost replies can leave admission unconfirmed.
    /// The caller must separately confirm that the old Host has stopped.
    pub async fn request_shutdown(
        &self,
        request_id: Option<RequestId>,
    ) -> HostResult<Option<Operation>> {
        let attachment = self.attachment();
        let action = BuiltinAction::HostShutdown.spec();
        let request = RpcRequest::Invoke(Call {
            protocol_version: attachment.protocol_version,
            host_id: attachment.host_id.clone(),
            instance_epoch: attachment.instance_epoch,
            actor_id: attachment.actor_id.clone(),
            request_id: request_id.unwrap_or_else(crate::connection::new_request_id),
            request_context: attachment.request_context.clone(),
            action_id: action.action_id.clone(),
            target: Target {
                host_id: attachment.host_id.clone(),
                kind: ResourceKind::try_from("host").expect("host kind"),
                id: attachment.host_id.clone(),
                session_id: None,
                session_epoch: None,
            },
            params: JsonObject::new(),
            expected_revision: None,
            lease_id: None,
            reveal_target: action.reveal_target.clone(),
            execution_mode: None,
        });
        match tokio::time::timeout(Duration::from_secs(10), self.request(request)).await {
            Ok(Ok(RpcReply::Success { result, .. })) => match *result {
                RpcResult::Operation(result) => Ok(Some(result.operation)),
                _ => Err(HostError::new(
                    "INVALID_ARGUMENT",
                    "Host returned an invalid shutdown response",
                )),
            },
            Ok(Ok(RpcReply::Failure { error, .. })) => Err(error),
            Ok(Err(error)) if error.code == "UNAUTHENTICATED" => Ok(None),
            Ok(Err(error)) => Err(error),
            Err(_) => Ok(None),
        }
    }
}
