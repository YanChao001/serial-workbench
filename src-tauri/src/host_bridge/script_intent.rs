//! 本机窗口确认源码后，以该窗口的业务身份执行脚本。
use super::DesktopHostBridge;
use serde_json::json;
use serial_workbench_core::*;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LocalScriptIntent {
    request_id: RequestId,
    target: Target,
    language: String,
    source: String,
    source_sha256: Digest,
    session_revision: U64,
    configuration_revision: U64,
}

impl DesktopHostBridge {
    async fn run_confirmed_script(
        &self,
        window: &str,
        generation: U64,
        intent: LocalScriptIntent,
    ) -> HostResult<Operation> {
        let attachment = self.attachment_at_generation(window, generation).await?;
        intent.target.validate()?;
        if intent.target.kind.as_str() != "session" || intent.target.host_id != attachment.host_id {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Choose an active session from this local Host",
            ));
        }
        let target = intent.target;
        let call = Call {
            protocol_version: attachment.protocol_version,
            host_id: attachment.host_id,
            instance_epoch: attachment.instance_epoch,
            actor_id: attachment.actor_id,
            request_context: attachment.request_context,
            request_id: intent.request_id,
            action_id: Id::try_from("swb.builtin.automation.script")?,
            reveal_target: RevealTarget {
                page_id: Id::try_from("workbench")?,
                panel_id: Some(Id::try_from("trustedScript")?),
                session_id: target.session_id.clone(),
                workspace_id: None,
                result_ref: None,
            },
            target,
            params: serde_json::from_value(json!({
                "language": intent.language,
                "source": intent.source,
                "sourceSha256": intent.source_sha256,
                "sessionRevision": intent.session_revision,
                "configurationRevision": intent.configuration_revision,
            }))
            .map_err(|_| {
                HostError::new("INVALID_ARGUMENT", "Invalid confirmed script parameters")
            })?,
            expected_revision: None,
            lease_id: None,
            execution_mode: Some(ExecutionMode::Independent),
            workspace_startup: None,
        };
        let request = RpcRequest::RunConfirmedScript(ConfirmedScriptInvocation {
            client_id: attachment.client_id,
            call: Box::new(call),
        });
        match self
            .control_request_at_generation(window, generation, request)
            .await?
        {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Operation(result) => Ok(result.operation),
                _ => Err(HostError::new(
                    "INTERNAL",
                    "Invalid script operation response",
                )),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_run_confirmed_script(
    window: tauri::WebviewWindow,
    generation: U64,
    intent: LocalScriptIntent,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<Operation> {
    state.bind_window(&window)?;
    state
        .run_confirmed_script(window.label(), generation, intent)
        .await
}
