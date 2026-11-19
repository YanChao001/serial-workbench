//! 本机插件管理只接受已声明的业务意图。
use super::{DesktopHostBridge, document_intents::document_request_id};
use serial_workbench_core::*;

#[cfg(test)]
mod terminal_tests;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum LocalNodeIntent {
    Install {
        expected_revision: U64,
        params: NodePackageInstallParams,
    },
    SetEnabled {
        expected_revision: U64,
        params: NodePackageSetEnabledParams,
    },
    Uninstall {
        expected_revision: U64,
        params: NodePackageIdentityParams,
    },
    ConfirmExecutionTrust {
        expected_revision: U64,
        params: NodePackageIdentityParams,
    },
    RevokeExecutionTrust {
        expected_revision: U64,
        params: NodePackageIdentityParams,
    },
    ApproveSource {
        expected_revision: U64,
        params: NodeSourceApproveParams,
    },
    RevokeSource {
        expected_revision: U64,
        params: NodeSourceRevokeParams,
    },
}

fn params(value: impl serde::Serialize) -> HostResult<JsonObject> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|_| HostError::new("INVALID_ARGUMENT", "Invalid local plugin parameters"))
}

impl DesktopHostBridge {
    async fn apply_node_intent(
        &self,
        window: &str,
        generation: U64,
        intent: LocalNodeIntent,
    ) -> HostResult<Operation> {
        use BuiltinAction::*;
        let (action, revision, params) = match intent {
            LocalNodeIntent::Install {
                expected_revision,
                params: value,
            } => (NodePackagesInstall, expected_revision, params(value)?),
            LocalNodeIntent::SetEnabled {
                expected_revision,
                params: value,
            } => (NodePackageSetEnabled, expected_revision, params(value)?),
            LocalNodeIntent::Uninstall {
                expected_revision,
                params: value,
            } => (NodePackageUninstall, expected_revision, params(value)?),
            LocalNodeIntent::ConfirmExecutionTrust {
                expected_revision,
                params: value,
            } => (
                NodePackageConfirmExecutionTrust,
                expected_revision,
                params(value)?,
            ),
            LocalNodeIntent::RevokeExecutionTrust {
                expected_revision,
                params: value,
            } => (
                NodePackageRevokeExecutionTrust,
                expected_revision,
                params(value)?,
            ),
            LocalNodeIntent::ApproveSource {
                expected_revision,
                params: value,
            } => (NodeSourceApproveKey, expected_revision, params(value)?),
            LocalNodeIntent::RevokeSource {
                expected_revision,
                params: value,
            } => (NodeSourceRevokeKey, expected_revision, params(value)?),
        };
        let is_control = matches!(
            action,
            NodePackageConfirmExecutionTrust
                | NodePackageRevokeExecutionTrust
                | NodeSourceApproveKey
                | NodeSourceRevokeKey
        );
        let attachment = if is_control {
            self.control_attachment_at_generation(window, generation)
                .await?
        } else {
            self.attachment_at_generation(window, generation).await?
        };
        let spec = action.spec();
        let call = Call {
            protocol_version: attachment.protocol_version,
            host_id: attachment.host_id.clone(),
            instance_epoch: attachment.instance_epoch,
            actor_id: attachment.actor_id,
            request_id: document_request_id()?,
            request_context: attachment.request_context,
            action_id: spec.action_id.clone(),
            target: Target {
                host_id: attachment.host_id.clone(),
                kind: ResourceKind::try_from("host")?,
                id: attachment.host_id,
                session_id: None,
                session_epoch: None,
            },
            params,
            reveal_target: spec.reveal_target.clone(),
            expected_revision: Some(revision),
            lease_id: None,
            execution_mode: Some(ExecutionMode::Interactive),
        };
        if !is_control {
            return self
                .invoke_local_business(
                    window,
                    generation,
                    attachment.client_id,
                    "plugins.manage",
                    call,
                )
                .await;
        }
        match self
            .control_request_at_generation(window, generation, RpcRequest::Invoke(call))
            .await?
        {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Operation(result) => Ok(result.operation),
                _ => Err(HostError::new(
                    "INTERNAL",
                    "Invalid plugin operation response",
                )),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_apply_node_intent(
    window: tauri::WebviewWindow,
    generation: U64,
    intent: LocalNodeIntent,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<Operation> {
    state.bind_window(&window)?;
    state
        .apply_node_intent(window.label(), generation, intent)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use sha2::{Digest as _, Sha256};
    use std::{sync::Arc, time::Duration};

    #[tokio::test]
    async fn local_source_review_uses_control_while_business_identity_can_only_read_the_receipt() {
        let directory = tempfile::tempdir().unwrap();
        let mut server = HostServer::bind(directory.path()).await.unwrap();
        let host = Arc::new(Host::new(server.store(), server.auth()).await.unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(host, async {
                    let _ = stopped.await;
                })
                .await
        });
        let bridge = DesktopHostBridge::new(directory.path().to_owned());
        let attached = bridge.attach("main").await.unwrap();
        let control = bridge
            .control_attachment_at_generation("main", attached.generation)
            .await
            .unwrap();
        assert_ne!(attached.attachment.actor_id, control.actor_id);

        // RFC 8032, test vector 1.
        let public_key = [
            0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64,
            0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68,
            0xf7, 0x07, 0x51, 0x1a,
        ];
        let source = NodeSourceApproveParams {
            source: Id::try_from("terminal-source").unwrap(),
            key_id: Id::try_from("terminal-key").unwrap(),
            public_key,
            public_key_sha256: Digest::try_from(
                format!("{:x}", Sha256::digest(public_key)).as_str(),
            )
            .unwrap(),
        };
        let attachment = &attached.attachment;
        let target = Target {
            host_id: attachment.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: attachment.host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        let spec = BuiltinAction::NodeSourceApproveKey.spec();
        let denied = bridge
            .request(
                "main",
                RpcRequest::Invoke(Call {
                    protocol_version: attachment.protocol_version,
                    host_id: attachment.host_id.clone(),
                    instance_epoch: attachment.instance_epoch,
                    actor_id: attachment.actor_id.clone(),
                    request_id: document_request_id().unwrap(),
                    request_context: attachment.request_context.clone(),
                    action_id: spec.action_id.clone(),
                    target,
                    params: params(&source).unwrap(),
                    reveal_target: spec.reveal_target.clone(),
                    expected_revision: Some(0.into()),
                    lease_id: None,
                    execution_mode: Some(ExecutionMode::Interactive),
                }),
            )
            .await
            .unwrap();
        assert!(
            matches!(denied, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED")
        );

        let generation = attached.generation;
        let accepted = bridge
            .apply_node_intent(
                "main",
                generation,
                LocalNodeIntent::ApproveSource {
                    expected_revision: 0.into(),
                    params: source.clone(),
                },
            )
            .await
            .unwrap();
        assert_eq!(accepted.actor_id, control.actor_id);

        let completed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let request = super::super::tests::query(
                    attachment,
                    "operation.get",
                    serde_json::json!({"operationId": accepted.operation_id}),
                    document_request_id().unwrap().as_str(),
                );
                let reply = bridge
                    .request("main", RpcRequest::OperationGet(request))
                    .await
                    .unwrap();
                let RpcReply::Success { result, .. } = reply else {
                    panic!("{reply:?}")
                };
                let RpcResult::Operation(result) = *result else {
                    panic!("{result:?}")
                };
                if !matches!(
                    result.operation.state,
                    OperationState::Queued | OperationState::Running
                ) {
                    break result.operation;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(completed.state, OperationState::Succeeded, "{completed:?}");
        let Some(ActionResult::NodeSourceChanged(result)) = completed.result else {
            panic!("{completed:?}")
        };
        assert_eq!(result.revision, 1.into());
        assert_eq!(result.key.public_key_sha256, source.public_key_sha256);
        assert!(result.key.approved);
        drop(bridge);
        stop.send(()).unwrap();
        running.await.unwrap().unwrap();
    }
}
