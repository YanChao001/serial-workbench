//! Read-only Native requests retain their original window and connection generation.
use super::DesktopHostBridge;
use serial_workbench_core::{HostError, HostResult, Query, RpcReply, RpcRequest, U64};

fn readonly_query(request: &mut RpcRequest) -> HostResult<&mut Query> {
    match request {
        RpcRequest::Query(query)
            if matches!(query.action_id.as_str(), "settings.read" | "session.get") =>
        {
            Ok(query)
        }
        RpcRequest::OperationGet(query) if query.action_id.as_str() == "operation.get" => Ok(query),
        _ => Err(HostError::new(
            "INVALID_ARGUMENT",
            "This Native request cannot be repeated as a read",
        )),
    }
}

impl DesktopHostBridge {
    pub(crate) async fn read_request_at_generation(
        &self,
        window: &str,
        generation: U64,
        mut request: RpcRequest,
    ) -> HostResult<RpcReply> {
        readonly_query(&mut request)?;
        let mut remaining = 3;
        loop {
            let reply = self
                .request_at_generation(window, generation, request.clone())
                .await?;
            remaining -= 1;
            if remaining > 0
                && matches!(&reply, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
            {
                readonly_query(&mut request)?.request_id =
                    crate::platform_settings::next_effects_request_id()?;
                continue;
            }
            return Ok(reply);
        }
    }
}

#[cfg(test)]
mod tests;
