use super::ConnectionContext;
use crate::{
    auth::{AuthenticatedActor, HostIdentity},
    storage::Store,
};
use serial_workbench_core::*;
use serial_workbench_ipc::frame::MAX_FRAME_BYTES;

pub(super) async fn attach(
    store: &Store,
    identity: &HostIdentity,
    actor: &AuthenticatedActor,
    params: AttachParams,
) -> HostResult<AttachResult> {
    if params.client_id != *actor.client_id() {
        return Err(HostError::new(
            "ACTOR_MISMATCH",
            "Attached client identity does not match authentication",
        ));
    }
    if params
        .expected_host_id
        .as_ref()
        .is_some_and(|id| id != &identity.host_id)
    {
        return Err(host_mismatch());
    }
    if !params
        .supported_protocol_versions
        .iter()
        .any(|v| v == "0.1")
    {
        return Err(HostError::new(
            "PROTOCOL_UNSUPPORTED",
            "Host protocol 0.1 is required",
        ));
    }
    let store = store.clone();
    let current_actor = actor.clone();
    let (context, current_identity) =
        blocking(move || Ok((store.issue_context(&current_actor)?, store.identity()?))).await?;
    Ok(AttachResult {
        host_id: identity.host_id.clone(),
        instance_epoch: identity.instance_epoch,
        protocol_version: ProtocolVersion::V0_1,
        catalog_version: current_identity.catalog_version,
        actor_id: actor.id().clone(),
        client_id: actor.client_id().clone(),
        request_context: context.token,
        request_context_accept_until: context.accept_until,
        limits: Limits {
            max_request_bytes: (MAX_FRAME_BYTES as u64).into(),
            max_page_items: 100.into(),
            max_batch_bytes: 262144.into(),
            max_reader_queue_bytes: 4194304.into(),
            result_retention_ms: RetentionMs::try_from(U64::from(604800000))
                .expect("minimum retention"),
            max_lease_ttl_ms: DurationMs::try_from(U64::from(30000)).expect("lease TTL"),
        },
    })
}
pub(super) fn validate_request(
    context: &ConnectionContext,
    identity: &HostIdentity,
    outer_id: &RequestId,
    request: &RpcRequest,
) -> HostResult<()> {
    let required = request.required_channel()?;
    if context.channel == IpcChannel::Control && required == RequestChannel::Raw {
        return Err(HostError::new(
            "PERMISSION_DENIED",
            "Stream requests require an attached raw connection",
        ));
    }
    if context.channel == IpcChannel::Raw && required == RequestChannel::Control {
        return Err(HostError::new(
            "PERMISSION_DENIED",
            "Raw connections cannot execute control requests",
        ));
    }
    let (actor, host, epoch, target, inner_id) = match request {
        RpcRequest::Attach(_) => return Ok(()),
        RpcRequest::Invoke(call) | RpcRequest::OperationCancel(call) => (
            &call.actor_id,
            &call.host_id,
            call.instance_epoch,
            &call.target,
            Some(&call.request_id),
        ),
        RpcRequest::InvokeChild(call) => (
            &call.actor_id,
            &call.host_id,
            call.instance_epoch,
            &call.target,
            None,
        ),
        RpcRequest::Query(query)
        | RpcRequest::CatalogList(query)
        | RpcRequest::OperationGet(query)
        | RpcRequest::StateSnapshot(query)
        | RpcRequest::StateSubscribe(query)
        | RpcRequest::SubscriptionClose(query)
        | RpcRequest::ObjectRead(query)
        | RpcRequest::StreamRead(query)
        | RpcRequest::StreamSubscribe(query)
        | RpcRequest::StreamCredit(query) => (
            &query.actor_id,
            &query.host_id,
            query.instance_epoch,
            &query.target,
            Some(&query.request_id),
        ),
    };
    if actor != context.actor.id() {
        return Err(HostError::new(
            "ACTOR_MISMATCH",
            "Actor does not match the authenticated connection",
        ));
    }
    if host != &identity.host_id || target.host_id != identity.host_id {
        return Err(host_mismatch());
    }
    if epoch != identity.instance_epoch {
        return Err(HostError::new(
            "EPOCH_MISMATCH",
            "Host instance has changed",
        ));
    }
    if inner_id.is_some_and(|id| id != outer_id) {
        return Err(invalid());
    }
    target.validate()
}
pub(super) fn is_urgent(request: &RpcRequest) -> bool {
    let action = match request {
        RpcRequest::Invoke(call) | RpcRequest::OperationCancel(call) => call.action_id.as_str(),
        RpcRequest::Query(query) | RpcRequest::SubscriptionClose(query) => query.action_id.as_str(),
        _ => return false,
    };
    crate::limits::is_stop(action)
}
pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> HostResult<T> + Send + 'static,
) -> HostResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| storage())?
}
pub(super) fn new_id() -> Id {
    Id::try_from(uuid::Uuid::new_v4().to_string().as_str()).expect("UUID Id")
}
pub(super) fn new_request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).expect("UUID request Id")
}
pub(super) fn error_frame(
    request_id: RequestId,
    channel: IpcChannel,
    error: HostError,
) -> WireFrame {
    WireFrame {
        request_id,
        channel,
        body: IpcMessage::Error { error },
    }
}
pub(super) fn failure(error: HostError) -> RpcReply {
    RpcReply::Failure { ok: False, error }
}
pub(super) fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid local protocol message")
}
pub(super) fn storage() -> HostError {
    HostError::new("STORAGE_UNAVAILABLE", "Host state is unavailable")
}
pub(super) fn busy() -> HostError {
    HostError::new("HOST_BUSY", "Host connection capacity is exhausted")
}
pub(super) fn unauthenticated() -> HostError {
    HostError::new("UNAUTHENTICATED", "Local authentication is required")
}
pub(super) fn host_mismatch() -> HostError {
    HostError::new(
        "HOST_ID_MISMATCH",
        "Host identity does not match the trusted profile",
    )
}
