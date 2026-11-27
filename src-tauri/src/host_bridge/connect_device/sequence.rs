use super::{query, unpack};
use crate::host_bridge::DesktopHostBridge;
use serial_workbench_core::*;

use serial_workbench_host::node_packages::{
    CONNECTION_SEQUENCE_ACTION, CONNECTION_SEQUENCE_PACKAGE,
    is_current_connection_sequence_archive, is_product_connection_sequence,
};

fn host_target(business: &AttachResult) -> HostResult<Target> {
    Ok(Target {
        host_id: business.host_id.clone(),
        kind: ResourceKind::try_from("host")?,
        id: business.host_id.clone(),
        session_id: None,
        session_epoch: None,
    })
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ConnectionSequenceIntent {
    Start {
        device_id: Id,
        configuration: SerialConfiguration,
        definition: JsonObject,
    },
    Adopt {
        operation_id: Id,
        opened_operation_id: Id,
    },
}

#[derive(serde::Serialize, specta::Type)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub(crate) enum ConnectionSequenceIntentResult {
    Accepted(Box<Operation>),
    Session(Box<SessionSnapshot>),
}

fn fresh_session(
    business: &AttachResult,
    root: &Operation,
    child: &Operation,
) -> HostResult<Target> {
    let invalid = || {
        HostError::new(
            "PERMISSION_DENIED",
            "Opening receipt does not belong to this connection sequence",
        )
    };
    if root.execution_host_id != business.host_id
        || root.actor_id != business.actor_id
        || !is_product_connection_sequence(root)
        || root.root_operation_id != root.operation_id
        || !matches!(root.admission, Admission::Request { .. })
        || !root.state.is_terminal()
        || root.target.host_id != business.host_id
        || root.target.kind.as_str() != "device"
        || root.target.session_id.is_some()
        || root.target.session_epoch.is_some()
        || child.execution_host_id != root.execution_host_id
        || child.actor_id != root.actor_id
        || child.target != root.target
        || child.action_id.as_str() != "device.open"
        || child.root_operation_id != root.operation_id
        || !matches!(&child.admission, Admission::Child { parent_operation_id, .. }
            if *parent_operation_id == root.operation_id)
        || child.state != OperationState::Succeeded
    {
        return Err(invalid());
    }
    let Some(ActionResult::Opened(opened)) = &child.result else {
        return Err(invalid());
    };
    if opened.reused {
        return Err(invalid());
    }
    Ok(Target {
        host_id: business.host_id.clone(),
        kind: ResourceKind::try_from("session")?,
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id.clone()),
        session_epoch: Some(opened.session_epoch),
    })
}

impl DesktopHostBridge {
    pub(in crate::host_bridge) async fn connection_sequence_intent(
        &self,
        window: &str,
        generation: U64,
        intent: ConnectionSequenceIntent,
    ) -> HostResult<ConnectionSequenceIntentResult> {
        let business = self.attachment_at_generation(window, generation).await?;
        match intent {
            ConnectionSequenceIntent::Start {
                device_id,
                configuration,
                definition,
            } => {
                let device = Target {
                    host_id: business.host_id.clone(),
                    kind: ResourceKind::try_from("device")?,
                    id: device_id,
                    session_id: None,
                    session_epoch: None,
                };
                let request = query(
                    &business,
                    CONNECTION_SEQUENCE_ACTION,
                    device.clone(),
                    serde_json::json!({ "configuration": configuration, "definition": definition }),
                )?;
                let package_id = NodePackageId::try_from(CONNECTION_SEQUENCE_PACKAGE)?;
                let package_query = query(
                    &business,
                    "node.packages.runtime",
                    host_target(&business)?,
                    serde_json::json!({ "id": package_id }),
                )?;
                let RpcResult::Query(QueryResult::NodePackageRuntime(status)) = unpack(
                    self.read_request_at_generation(
                        window,
                        generation,
                        RpcRequest::Query(package_query),
                    )
                    .await?,
                )?
                else {
                    return Err(HostError::new(
                        "INTERNAL",
                        "Invalid connection sequence runtime status",
                    ));
                };
                if status.id != package_id
                    || !status.archive_sha256.as_ref().is_some_and(|digest| {
                        is_current_connection_sequence_archive(&status.id, digest)
                    })
                {
                    return Err(HostError::new(
                        "UNSUPPORTED_CAPABILITY",
                        "Connection sequence requires the current signed product package",
                    ));
                }
                self.grant_device_intent(
                    window,
                    generation,
                    &business.client_id,
                    device,
                    &["metadata.read", "content.read", "device.modify"],
                )
                .await?;
                let call = Call {
                    protocol_version: request.protocol_version,
                    host_id: request.host_id,
                    instance_epoch: request.instance_epoch,
                    actor_id: request.actor_id,
                    request_id: request.request_id,
                    action_id: request.action_id,
                    target: request.target,
                    params: request.params,
                    reveal_target: request.reveal_target,
                    request_context: business.request_context,
                    expected_revision: None,
                    lease_id: None,
                    execution_mode: Some(ExecutionMode::Independent),
                    workspace_startup: None,
                };
                let RpcResult::Operation(result) = unpack(
                    self.request_at_generation(
                        window,
                        generation,
                        RpcRequest::Invoke(call.clone()),
                    )
                    .await?,
                )?
                else {
                    return Err(HostError::new(
                        "INTERNAL",
                        "Invalid connection sequence response",
                    ));
                };
                let operation = result.operation;
                if operation.execution_host_id != call.host_id
                    || operation.actor_id != call.actor_id
                    || operation.request_id != call.request_id
                    || operation.action_id != call.action_id
                    || operation.target != call.target
                    || operation.execution_mode != ExecutionMode::Independent
                    || !is_product_connection_sequence(&operation)
                {
                    return Err(HostError::new(
                        "INTERNAL",
                        "Connection sequence operation identity changed",
                    ));
                }
                Ok(ConnectionSequenceIntentResult::Accepted(Box::new(
                    operation,
                )))
            }
            ConnectionSequenceIntent::Adopt {
                operation_id,
                opened_operation_id,
            } => {
                let root = self
                    .read_sequence_operation(window, generation, &business, operation_id)
                    .await?;
                let child = self
                    .read_sequence_operation(window, generation, &business, opened_operation_id)
                    .await?;
                let session = fresh_session(&business, &root, &child)?;
                self.grant_device_intent(
                    window,
                    generation,
                    &business.client_id,
                    session.clone(),
                    &["metadata.read", "content.read", "device.modify"],
                )
                .await?;
                let request = query(
                    &business,
                    "session.get",
                    session.clone(),
                    serde_json::json!({}),
                )?;
                let RpcResult::Query(QueryResult::Session(snapshot)) = unpack(
                    self.read_request_at_generation(window, generation, RpcRequest::Query(request))
                        .await?,
                )?
                else {
                    return Err(HostError::new("INTERNAL", "Invalid session response"));
                };
                if snapshot.device_id != root.target.id
                    || snapshot.session_id != session.id
                    || Some(snapshot.session_epoch) != session.session_epoch
                {
                    return Err(HostError::new(
                        "INTERNAL",
                        "Opened session identity changed",
                    ));
                }
                Ok(ConnectionSequenceIntentResult::Session(Box::new(snapshot)))
            }
        }
    }

    async fn read_sequence_operation(
        &self,
        window: &str,
        generation: U64,
        business: &AttachResult,
        operation_id: Id,
    ) -> HostResult<Operation> {
        let request = query(
            business,
            "operation.get",
            host_target(business)?,
            serde_json::json!({ "operationId": operation_id, "requestContext": business.request_context }),
        )?;
        let RpcResult::Operation(result) = unpack(
            self.read_request_at_generation(window, generation, RpcRequest::OperationGet(request))
                .await?,
        )?
        else {
            return Err(HostError::new("INTERNAL", "Invalid operation response"));
        };
        if result.operation.operation_id != operation_id {
            return Err(HostError::new("INTERNAL", "Operation identity changed"));
        }
        Ok(result.operation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adoption_requires_the_owners_successful_fresh_direct_open() {
        let descriptor: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../crates/host/resources/node-packages/automation.json"
        ))
        .unwrap();
        let business: AttachResult = serde_json::from_value(serde_json::json!({
            "hostId":"host", "instanceEpoch":"1", "protocolVersion":"1.0", "catalogVersion":"1",
            "actorId":"window", "clientId":"desktop", "requestContext":"context",
            "requestContextAcceptUntil":"2040-01-01T00:00:00Z",
            "limits":{"maxRequestBytes":"1024","maxPageItems":"32","maxBatchBytes":"1024",
                "maxReaderQueueBytes":"1024","resultRetentionMs":"604800000","maxLeaseTtlMs":"30000"}
        }))
        .unwrap();
        let root: Operation = serde_json::from_value(serde_json::json!({
            "operationId":"root", "rootOperationId":"root", "executionHostId":"host", "actorId":"window",
            "requestId":"00000000-0000-4000-8000-000000000114",
            "admission":{"kind":"request","requestContextDigest":"0".repeat(64)},
            "childHighWatermark":"1", "actionId":CONNECTION_SEQUENCE_ACTION, "target":{"hostId":"host","kind":"device","id":"port"},
            "dependencies":[{"id":CONNECTION_SEQUENCE_PACKAGE,"version":descriptor["version"],"digest":descriptor["archiveSha256"]}],
            "executionMode":"independent", "state":"cancelled", "revision":"2",
            "revealTarget":{"pageId":"workbench"}, "acceptedAt":"2026-11-10T00:00:00Z",
            "settledAt":"2026-11-10T00:00:01Z", "owner":{"kind":"plugin","id":CONNECTION_SEQUENCE_PACKAGE}
        })).unwrap();
        let child: Operation = serde_json::from_value(serde_json::json!({
            "operationId":"opened", "rootOperationId":"root", "executionHostId":"host", "actorId":"window",
            "requestId":"00000000-0000-4000-8000-000000000115",
            "admission":{"kind":"child","taskContextDigest":"0".repeat(64),"parentOperationId":"root","childKey":"1"},
            "childHighWatermark":"0", "actionId":"device.open", "target":root.target,
            "executionMode":"independent", "state":"succeeded", "revision":"2",
            "revealTarget":{"pageId":"workbench"}, "acceptedAt":"2026-11-10T00:00:00Z",
            "settledAt":"2026-11-10T00:00:01Z", "owner":{"kind":"host","id":"host"},
            "result":{"kind":"opened","value":{"sessionId":"session","sessionEpoch":"4","revision":"1","reused":false}}
        })).unwrap();
        let selected = fresh_session(&business, &root, &child).unwrap();
        assert_eq!(selected.id.as_str(), "session");
        assert_eq!(selected.session_epoch, Some(4.into()));

        let mut unsigned = root.clone();
        unsigned.dependencies.as_mut().unwrap()[0].digest =
            Digest::try_from("0".repeat(64).as_str()).unwrap();
        assert!(fresh_session(&business, &unsigned, &child).is_err());
        let mut other_window = business.clone();
        other_window.actor_id = Id::try_from("other-window").unwrap();
        assert!(fresh_session(&other_window, &root, &child).is_err());
        let mut active = root.clone();
        active.state = OperationState::Running;
        assert!(fresh_session(&business, &active, &child).is_err());
        let mut foreign = child.clone();
        foreign.target.id = Id::try_from("another-port").unwrap();
        assert!(fresh_session(&business, &root, &foreign).is_err());
        let mut unlinked = child.clone();
        unlinked.admission = root.admission.clone();
        assert!(fresh_session(&business, &root, &unlinked).is_err());
        let mut reused = child;
        let Some(ActionResult::Opened(opened)) = &mut reused.result else {
            unreachable!()
        };
        opened.reused = true;
        assert!(fresh_session(&business, &root, &reused).is_err());
    }
}
