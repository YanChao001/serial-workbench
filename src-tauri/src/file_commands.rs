//! 用户主动导出文本；保存路径只由原生对话框授权。
use crate::{
    blocking,
    error::{ErrorCode, NativeError, NativeResult},
    file_access,
    file_resource_commands::{query, query_resource, reply},
    host_bridge::DesktopHostBridge,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::{
    ActionResult, HostError, HostResult, Id, NODE_CSV_RESULT_MAX_BYTES, NODE_PNG_RESULT_MAX_BYTES,
    OperationState, PNG_SIGNATURE, QueryResult, ResourceKind, RpcRequest, RpcResult, Target, U64,
};
use std::{future::Future, path::PathBuf};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Copy)]
pub(crate) enum ChartArtifact {
    Svg,
    Csv,
    Png,
}

impl ChartArtifact {
    fn extension(self) -> &'static str {
        match self {
            Self::Svg => "svg",
            Self::Csv => "csv",
            Self::Png => "png",
        }
    }

    fn max_bytes(self) -> u64 {
        match self {
            Self::Svg => 24 * 1024,
            Self::Csv => NODE_CSV_RESULT_MAX_BYTES as u64,
            Self::Png => NODE_PNG_RESULT_MAX_BYTES as u64,
        }
    }

    fn valid_contents(self, bytes: &[u8]) -> bool {
        match self {
            Self::Svg => bytes.starts_with(b"<svg "),
            Self::Png => bytes.starts_with(PNG_SIGNATURE),
            Self::Csv => {
                bytes.starts_with(b"sample_index,value_v,") && std::str::from_utf8(bytes).is_ok()
            }
        }
    }
}

fn chart_artifact(action: &str) -> Option<(&str, ChartArtifact)> {
    let (package, action) = action.rsplit_once('.')?;
    if !matches!(package, "swb.reference.chart" | "swb.builtin.chart") {
        return None;
    }
    let artifact = match action {
        "exportSvg" => ChartArtifact::Svg,
        "exportCsv" => ChartArtifact::Csv,
        "exportPng" => ChartArtifact::Png,
        _ => return None,
    };
    Some((package, artifact))
}

fn chart_save_error() -> HostError {
    HostError::new("INVALID_ARGUMENT", "The chart result could not be saved")
}

fn chart_storage_error(_: NativeError) -> HostError {
    HostError::new("STORAGE_IO", "Could not save the chart file")
}

// 保持现有 IPC 命令名。输出格式由已结算的签名动作决定。
#[tauri::command]
#[specta::specta]
pub(crate) async fn host_save_chart_svg(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopHostBridge>,
    generation: U64,
    operation_id: Id,
) -> HostResult<bool> {
    state.bind_window(&window)?;
    let label = window.label().to_owned();
    save_chart_artifact(&state, &label, generation, operation_id, |artifact| {
        blocking::run(move || {
            let extension = artifact.extension();
            #[cfg(feature = "e2e")]
            if std::env::var("STARTER_E2E_PHASE").as_deref() == Ok("chart-automated")
                && std::env::var("SWB_E2E_WINDOWS_NATIVE_PICKERS").as_deref() != Ok("1")
                && let Some(directory) = std::env::var_os("STARTER_E2E_CHART_DIR")
            {
                return Ok(Some(
                    PathBuf::from(directory).join(format!("exported-chart.{extension}")),
                ));
            }
            app.dialog()
                .file()
                .set_parent(&window)
                .add_filter(extension.to_ascii_uppercase(), &[extension])
                .set_file_name(format!("chart.{extension}"))
                .blocking_save_file()
                .map(|path| {
                    path.into_path().map_err(|_| {
                        NativeError::new(ErrorCode::InvalidArgument, "Invalid save destination")
                    })
                })
                .transpose()
        })
    })
    .await
}

pub(crate) async fn save_chart_artifact<F>(
    bridge: &DesktopHostBridge,
    window: &str,
    generation: U64,
    operation_id: Id,
    pick: impl FnOnce(ChartArtifact) -> F,
) -> HostResult<bool>
where
    F: Future<Output = NativeResult<Option<PathBuf>>>,
{
    let attachment = bridge.attachment_at_generation(window, generation).await?;
    let request = query(
        &attachment,
        "operation.get",
        Target {
            host_id: attachment.host_id.clone(),
            kind: ResourceKind::try_from("operation")?,
            id: operation_id.clone(),
            session_id: None,
            session_epoch: None,
        },
        serde_json::json!({"operationId": operation_id}),
    )?;
    let RpcResult::Operation(result) = reply(
        bridge
            .request_at_generation(window, generation, RpcRequest::OperationGet(request))
            .await?,
    )?
    else {
        return Err(chart_save_error());
    };
    let operation = result.operation;
    let Some(ActionResult::Reference(output)) = operation.result else {
        return Err(chart_save_error());
    };
    let reference = output.result_ref;
    let Some((package, artifact)) = chart_artifact(operation.action_id.as_str()) else {
        return Err(chart_save_error());
    };
    if operation.state != OperationState::Succeeded
        || !operation
            .dependencies
            .is_some_and(|dependencies| dependencies.iter().any(|item| item.id.as_str() == package))
        || reference.kind.as_str() != "plugin_result"
    {
        return Err(chart_save_error());
    }
    let Some(path) = pick(artifact).await.map_err(chart_storage_error)? else {
        return Ok(false);
    };
    let max_bytes = artifact.max_bytes();
    // 对话框返回后，按当前窗口代次与来源授权读取文件。
    let QueryResult::FileRead(page) = query_resource(
        bridge,
        window,
        generation,
        &reference,
        "file.read",
        serde_json::json!({
            "fileRef": reference, "offset": "0", "maxBytes": max_bytes.to_string()
        }),
    )
    .await?
    else {
        return Err(chart_save_error());
    };
    let bytes = STANDARD
        .decode(page.bytes_base64.as_str())
        .map_err(|_| chart_save_error())?;
    if page.file_ref != reference
        || !page.at_end
        || page.offset.get() != 0
        || page.total_bytes.get() != bytes.len() as u64
        || page.total_bytes.get() > max_bytes
        || !artifact.valid_contents(&bytes)
    {
        return Err(chart_save_error());
    }
    blocking::run(move || file_access::atomic_save(&path, &bytes))
        .await
        .map_err(chart_storage_error)?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub async fn save_text_export(
    app: tauri::AppHandle,
    name: String,
    content: String,
) -> NativeResult<Option<String>> {
    validate_export_name(&name)?;
    blocking::run(move || file_access::save_text_content(&app, &name, &content, 8 * 1024 * 1024))
        .await
}

pub(crate) fn validate_export_name(name: &str) -> NativeResult<()> {
    if name.len() > 100
        || name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || ![".csv", ".tsv", ".json", ".txt", ".md"]
            .iter()
            .any(|extension| name.ends_with(extension))
    {
        return Err(NativeError::new(
            ErrorCode::InvalidArgument,
            "Use a plain CSV, JSON or text export name",
        ));
    }
    Ok(())
}
