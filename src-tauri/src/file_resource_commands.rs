//! Trusted file selection; operating-system paths never cross the WebView boundary.
use serial_workbench_core::*;
use sha2::Digest as _;
use std::{
    fs::File,
    io::{Cursor, Read},
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FileResourceRole {
    Source,
    Media,
    CaptureTarget,
    CaptureSource,
}

/// 仅供系统选择器展示，不代表设备、路径或文件访问权限。
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureNameHint {
    pub device_name: String,
    pub baud_rate: PositiveU64,
}

fn capture_name(
    hint: Option<&CaptureNameHint>,
    now: std::time::SystemTime,
    sequence: u64,
) -> String {
    let timestamp: chrono::DateTime<chrono::Utc> = now.into();
    let mut hash = sha2::Sha256::new();
    hash.update(
        now.duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    hash.update(std::process::id().to_le_bytes());
    hash.update(sequence.to_le_bytes());
    let id = format!("{:x}", hash.finalize());
    let context = hint.map_or_else(
        || "capture".into(),
        |hint| {
            let mut device = String::new();
            // 标签只成为有界文件名片段；既不解析路径，也不参与文件授权。
            for character in hint.device_name.chars().take(256) {
                let safe = if character.is_control()
                    || character.is_whitespace()
                    || ". /\\:*?\"<>|".contains(character)
                {
                    '_'
                } else {
                    character
                };
                if device.len() + safe.len_utf8() > 48 {
                    break;
                }
                device.push(safe);
            }
            let device = device.trim_matches('_');
            let device = if device.is_empty() { "device" } else { device };
            format!("{device}_{}", hint.baud_rate.get())
        },
    );
    format!(
        "{}_{context}_{}.swb",
        timestamp.format("%Y%m%dT%H%M%SZ"),
        &id[..12]
    )
}

static CAPTURE_NAME_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectedFileResource {
    pub reference: serial_workbench_core::ObjectRef,
    pub name: String,
    pub mime: String,
    pub length: serial_workbench_core::U64,
}

fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid selected resource")
}
fn require_window(window: &str) -> HostResult<()> {
    crate::commands::require_host_window(window)
        .map_err(|_| HostError::new("PERMISSION_DENIED", "Window cannot select resources"))
}
fn select_path(
    window: &str,
    picker: impl FnOnce() -> HostResult<Option<PathBuf>>,
) -> HostResult<Option<PathBuf>> {
    require_window(window)?;
    picker()
}
pub(crate) fn media_type(header: &[u8], length: u64) -> HostResult<&'static str> {
    if length == 0 {
        return Err(invalid());
    }
    if header.len() >= 12 && header.get(4..8) == Some(b"ftyp") {
        let size = u32::from_be_bytes(header[..4].try_into().map_err(|_| invalid())?);
        if size >= 12 && u64::from(size) <= length {
            return Ok("video/mp4");
        }
    }
    if header.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) && header.windows(4).any(|v| v == b"webm") {
        return Ok("video/webm");
    }
    match image::guess_format(header).map_err(|_| invalid())? {
        image::ImageFormat::Png => Ok("image/png"),
        image::ImageFormat::Jpeg => Ok("image/jpeg"),
        image::ImageFormat::WebP => Ok("image/webp"),
        _ => Err(invalid()),
    }
}
fn inspect_media(path: &Path) -> HostResult<(&'static str, u64, Digest)> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    let file = File::open(path).map_err(|_| invalid())?;
    let length = file.metadata().map_err(|_| invalid())?.len();
    inspect_media_reader(file, length)
}

fn inspect_media_reader(
    mut file: impl Read,
    length: u64,
) -> HostResult<(&'static str, u64, Digest)> {
    if length == 0 || length > 128 * 1024 * 1024 {
        return Err(HostError::new(
            "LIMIT_EXCEEDED",
            "Media size exceeds the supported limit",
        ));
    }
    let mut header = vec![0; length.min(4096) as usize];
    file.read_exact(&mut header)
        .map_err(|_| HostError::new("SOURCE_CHANGED", "Media changed during inspection"))?;
    let mime = media_type(&header, length)?;
    let mut image_bytes = if mime.starts_with("image/") {
        if length > 64 * 1024 * 1024 {
            return Err(HostError::new("LIMIT_EXCEEDED", "Image exceeds 64 MiB"));
        }
        let mut bytes = Vec::with_capacity(length as usize);
        bytes.extend_from_slice(&header);
        Some(bytes)
    } else {
        None
    };
    let mut hash = sha2::Sha256::new();
    hash.update(&header);
    let mut total = header.len() as u64;
    let mut bytes = [0; 65536];
    loop {
        let n = file.read(&mut bytes).map_err(|_| invalid())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > length {
            return Err(HostError::new(
                "SOURCE_CHANGED",
                "Media changed during inspection",
            ));
        }
        hash.update(&bytes[..n]);
        if let Some(image) = &mut image_bytes {
            image.extend_from_slice(&bytes[..n]);
        }
    }
    if total != length {
        return Err(HostError::new(
            "SOURCE_CHANGED",
            "Media changed during inspection",
        ));
    }
    // The decoder and digest consume the same snapshot; never reread a mutable source
    // between validation and hashing. Videos retain only their bounded probe prefix.
    if let Some(image) = image_bytes {
        validate_image_bytes(&image)?;
    }
    Ok((
        mime,
        length,
        Digest::try_from(format!("{:x}", hash.finalize()).as_str())?,
    ))
}

pub(crate) fn validate_image_bytes(bytes: &[u8]) -> HostResult<()> {
    if bytes.len() > 64 * 1024 * 1024
        || !media_type(bytes, bytes.len() as u64)?.starts_with("image/")
    {
        return Err(invalid());
    }
    let format = image::guess_format(bytes).map_err(|_| invalid())?;
    let (width, height) = image::ImageReader::with_format(Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| invalid())?;
    if width == 0
        || height == 0
        || width > 32768
        || height > 32768
        || u64::from(width) * u64::from(height) > 100_000_000
    {
        return Err(invalid());
    }
    let mut decoder = image::ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    limits.max_alloc = Some(100_000_000 * 16);
    decoder.limits(limits);
    decoder.decode().map_err(|_| invalid())?;
    Ok(())
}

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
pub(crate) fn resource_target(reference: &ObjectRef) -> Target {
    Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    }
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
        params: serde_json::from_value(params).map_err(|_| invalid())?,
        reveal_target: RevealTarget {
            page_id: Id::try_from("settings")?,
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    })
}
fn reply(reply: RpcReply) -> HostResult<RpcResult> {
    match reply {
        RpcReply::Success { result, .. } => Ok(*result),
        RpcReply::Failure { error, .. } => Err(error),
    }
}
pub(crate) async fn query_resource(
    bridge: &crate::host_bridge::DesktopHostBridge,
    window: &str,
    generation: U64,
    reference: &ObjectRef,
    action: &str,
    params: serde_json::Value,
) -> HostResult<QueryResult> {
    let attachment = bridge.attachment_at_generation(window, generation).await?;
    let request = query(&attachment, action, resource_target(reference), params)?;
    let request = RpcRequest::Query(request);
    let response = if request.required_channel()? == RequestChannel::Raw {
        bridge
            .raw_request_at_generation(window, generation, request)
            .await?
    } else {
        bridge
            .request_at_generation(window, generation, request)
            .await?
    };
    match reply(response)? {
        RpcResult::Query(value) => Ok(value),
        _ => Err(invalid()),
    }
}
async fn register(
    bridge: &crate::host_bridge::DesktopHostBridge,
    window: &str,
    generation: U64,
    path: &Path,
    role: FileResourceRole,
) -> HostResult<FileMetadata> {
    let purpose = match role {
        FileResourceRole::CaptureTarget => FilePurpose::CaptureTarget,
        FileResourceRole::CaptureSource => FilePurpose::CaptureSource,
        FileResourceRole::Source | FileResourceRole::Media => FilePurpose::ReadFile,
    };
    let params = RegisterFileParams {
        path: path.to_str().ok_or_else(invalid)?.into(),
        purpose,
    };
    match invoke_control(
        bridge,
        window,
        generation,
        "file.register",
        serde_json::to_value(params).map_err(|_| invalid())?,
    )
    .await?
    {
        ActionResult::FileMetadata(metadata) => Ok(metadata),
        _ => Err(invalid()),
    }
}

pub(crate) async fn invoke_control(
    bridge: &crate::host_bridge::DesktopHostBridge,
    window: &str,
    generation: U64,
    action: &str,
    params: serde_json::Value,
) -> HostResult<ActionResult> {
    let attachment = bridge
        .control_attachment_at_generation(window, generation)
        .await?;
    let target = Target {
        host_id: attachment.host_id.clone(),
        kind: ResourceKind::try_from("host")?,
        id: attachment.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let request = query(&attachment, action, target.clone(), params)?;
    let call = Call {
        protocol_version: request.protocol_version,
        host_id: request.host_id,
        instance_epoch: request.instance_epoch,
        actor_id: request.actor_id,
        request_id: request.request_id,
        request_context: attachment.request_context.clone(),
        action_id: request.action_id,
        target: request.target,
        params: request.params,
        reveal_target: request.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: Some(ExecutionMode::Interactive),
    };
    let RpcResult::Operation(result) = reply(
        bridge
            .control_request_at_generation(window, generation, RpcRequest::Invoke(call))
            .await?,
    )?
    else {
        return Err(invalid());
    };
    let mut operation = result.operation;
    let started = std::time::Instant::now();
    loop {
        if let Some(result) = operation.result {
            return Ok(result);
        }
        if let Some(error) = operation.error {
            return Err(error);
        }
        if !matches!(
            operation.state,
            OperationState::Queued | OperationState::Running | OperationState::CancelRequested
        ) {
            return Err(HostError::new(
                "OPERATION_FAILED",
                "File selection operation did not complete",
            ));
        }
        if started.elapsed() > std::time::Duration::from_secs(30) {
            return Err(HostError::new(
                "TIMEOUT",
                "File selection operation is still pending; its operation remains recorded",
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let request = query(
            &attachment,
            "operation.get",
            target.clone(),
            serde_json::json!({"operationId":operation.operation_id,"requestContext":attachment.request_context}),
        )?;
        let RpcResult::Operation(result) = reply(
            bridge
                .control_request_at_generation(
                    window,
                    generation,
                    RpcRequest::OperationGet(request),
                )
                .await?,
        )?
        else {
            return Err(invalid());
        };
        operation = result.operation;
    }
}

pub(crate) async fn choose_with_picker<F, P>(
    bridge: &crate::host_bridge::DesktopHostBridge,
    window: &str,
    generation: U64,
    role: FileResourceRole,
    picker: F,
) -> HostResult<Option<SelectedFileResource>>
where
    F: FnOnce() -> P,
    P: std::future::Future<Output = HostResult<Option<PathBuf>>>,
{
    require_window(window)?;
    bridge.attachment_at_generation(window, generation).await?;
    let Some(path) = picker().await? else {
        return Ok(None);
    };
    let media = if matches!(role, FileResourceRole::Media) {
        let source = path.clone();
        Some(
            tauri::async_runtime::spawn_blocking(move || inspect_media(&source))
                .await
                .map_err(|_| invalid())??,
        )
    } else {
        None
    };
    let metadata = register(bridge, window, generation, &path, role).await?;
    if media.as_ref().is_some_and(|(_, length, digest)| {
        *length != metadata.length.get() || *digest != metadata.fingerprint
    }) {
        return Err(HostError::new(
            "SOURCE_CHANGED",
            "Media changed between inspection and registration",
        ));
    }
    let name: String = path
        .file_name()
        .ok_or_else(invalid)?
        .to_string_lossy()
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect();
    // The successful native picker is the explicit user-control gesture. Grant only
    // its newly registered Ref to this generation's authenticated business client.
    let business = bridge.attachment_at_generation(window, generation).await?;
    let permission = if matches!(role, FileResourceRole::CaptureTarget) {
        "workspace.modify"
    } else {
        "content.read"
    };
    let authorization = AuthorizeParams {
        client_id: business.client_id,
        permissions: vec![permission.into()],
        targets: vec![resource_target(&metadata.file_ref)],
        expires_at: None,
    };
    if !matches!(
        invoke_control(
            bridge,
            window,
            generation,
            "auth.authorize",
            serde_json::to_value(authorization).map_err(|_| invalid())?,
        )
        .await?,
        ActionResult::AuthorizationChanged(_)
    ) {
        return Err(invalid());
    }
    Ok(Some(SelectedFileResource {
        reference: metadata.file_ref,
        name: if name.trim().is_empty() {
            "Media".into()
        } else {
            name
        },
        mime: media.map_or("application/octet-stream", |m| m.0).into(),
        length: metadata.length,
    }))
}

#[tauri::command]
#[specta::specta]
pub async fn choose_file_resource(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    role: FileResourceRole,
    generation: U64,
    capture_name_hint: Option<CaptureNameHint>,
) -> HostResult<Option<SelectedFileResource>> {
    let bridge = app
        .state::<crate::host_bridge::DesktopHostBridge>()
        .inner()
        .clone();
    bridge.bind_window(&window)?;
    let label = window.label().to_owned();
    choose_with_picker(&bridge, &label, generation, role, || async move {
        tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            select_path(window.label(), || {
                let dialog = app.dialog().file().set_parent(&window);
                let selected = match role {
                    FileResourceRole::Source => dialog.blocking_pick_file(),
                    FileResourceRole::Media => dialog
                        .add_filter(
                            "PNG / JPEG / WebP / MP4 / WebM",
                            &["png", "jpg", "jpeg", "webp", "mp4", "webm"],
                        )
                        .blocking_pick_file(),
                    FileResourceRole::CaptureTarget => dialog
                        .set_file_name(capture_name(
                            capture_name_hint.as_ref(),
                            std::time::SystemTime::now(),
                            CAPTURE_NAME_SEQUENCE
                                .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                        ))
                        .blocking_save_file(),
                    FileResourceRole::CaptureSource => dialog.blocking_pick_folder(),
                };
                selected
                    .map(|path| path.into_path().map_err(|_| invalid()))
                    .transpose()
            })
        })
        .await
        .map_err(|_| invalid())?
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Seek;

    fn capture_time() -> std::time::SystemTime {
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_793_991_784)
    }

    #[test]
    fn capture_name_uses_utc_device_baud_and_short_id() {
        let hint = CaptureNameHint {
            device_name: "COM7".into(),
            baud_rate: PositiveU64::try_from(U64::from(115200)).unwrap(),
        };
        let name = capture_name(Some(&hint), capture_time(), 1);
        let suffix = name.strip_prefix("20261106T190304Z_COM7_115200_").unwrap();
        let id = suffix.strip_suffix(".swb").unwrap();
        assert_eq!(id.len(), 12);
        assert!(id.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn capture_name_sanitizes_and_bounds_device_basename() {
        let hint = CaptureNameHint {
            device_name: format!("../\\\0COM:7*?\"<>|{}", "设备".repeat(100)),
            baud_rate: PositiveU64::try_from(U64::from(9600)).unwrap(),
        };
        let name = capture_name(Some(&hint), capture_time(), 1);
        assert!(name.starts_with("20261106T190304Z_"));
        assert!(name.len() <= 100);
        assert!(
            !name
                .chars()
                .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        );
        assert!(!name.contains(".."));
        assert!(name.contains("_9600_"));
        assert!(name.ends_with(".swb"));
    }

    #[test]
    fn capture_name_repeated_suggestions_are_distinct_without_fabricating_context() {
        let first = capture_name(None, capture_time(), 1);
        let second = capture_name(None, capture_time(), 2);
        assert!(first.starts_with("20261106T190304Z_capture_"));
        assert_ne!(first, second);
        assert!(first.ends_with(".swb"));
    }

    async fn open_selected_capture(
        bridge: &crate::host_bridge::DesktopHostBridge,
        generation: U64,
        reference: &ObjectRef,
    ) -> HostResult<OpenResult> {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let attachment = bridge.attachment_at_generation("main", generation).await?;
            let target = resource_target(reference);
            let request = query(
                &attachment,
                "replay.open",
                target,
                serde_json::json!({"captureRef":reference,"mode":"fastest"}),
            )?;
            let call = Call {
                protocol_version: request.protocol_version,
                host_id: request.host_id,
                instance_epoch: request.instance_epoch,
                actor_id: request.actor_id,
                request_id: request.request_id,
                request_context: attachment.request_context.clone(),
                action_id: request.action_id,
                target: request.target,
                params: request.params,
                reveal_target: request.reveal_target,
                expected_revision: None,
                lease_id: None,
                execution_mode: Some(ExecutionMode::Interactive),
            };
            let mut response = reply(
                bridge
                    .request_at_generation("main", generation, RpcRequest::Invoke(call))
                    .await?,
            )?;
            loop {
                let RpcResult::Operation(result) = response else {
                    return Err(invalid());
                };
                if let Some(error) = result.operation.error {
                    return Err(error);
                }
                if let Some(ActionResult::Opened(opened)) = result.operation.result {
                    return Ok(opened);
                }
                if !matches!(
                    result.operation.state,
                    OperationState::Queued | OperationState::Running
                ) {
                    return Err(invalid());
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                let operation_id = result.operation.operation_id;
                let operation_target = Target {
                    host_id: attachment.host_id.clone(),
                    kind: ResourceKind::try_from("operation")?,
                    id: operation_id.clone(),
                    session_id: None,
                    session_epoch: None,
                };
                let request = query(
                    &attachment,
                    "operation.get",
                    operation_target,
                    serde_json::to_value(OperationGetParams::ById {
                        operation_id,
                        request_context: None,
                    })
                    .map_err(|_| invalid())?,
                )?;
                response = reply(
                    bridge
                        .request_at_generation(
                            "main",
                            generation,
                            RpcRequest::OperationGet(request),
                        )
                        .await?,
                )?;
            }
        })
        .await
        .map_err(|_| HostError::new("TIMEOUT", "Replay fixture did not settle"))?
    }

    #[tokio::test]
    async fn capture_source_selection_registers_real_directory_and_replay_observes_revocation() {
        use serial_workbench_host::{
            Host,
            capture::writer::{CaptureLimits, CaptureWriter},
            ipc::HostServer,
        };
        use std::sync::Arc;
        let directory = tempfile::tempdir().unwrap();
        let mut server = HostServer::bind(directory.path()).await.unwrap();
        let auth = server.auth();
        let host = Host::new(server.store(), auth.clone()).await.unwrap();
        let (stop, done) = tokio::sync::oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        let bridge = crate::host_bridge::DesktopHostBridge::new(directory.path().into());
        let attachment = bridge.attach("main").await.unwrap();
        let valid = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("finished-capture");
        CaptureWriter::create(&valid, vec![], CaptureLimits::default())
            .unwrap()
            .finish()
            .unwrap();
        let ordinary_file = directory.path().join("ordinary.bin");
        std::fs::write(&ordinary_file, b"ordinary file").unwrap();
        let bad_directory = directory.path().join("not-a-capture");
        std::fs::create_dir(&bad_directory).unwrap();
        let before = auth.current_revision().unwrap();
        let cancelled = choose_with_picker(
            &bridge,
            "main",
            attachment.generation,
            FileResourceRole::CaptureSource,
            || async { Ok(None) },
        )
        .await;
        let file_rejected = choose_with_picker(
            &bridge,
            "main",
            attachment.generation,
            FileResourceRole::CaptureSource,
            || async { Ok(Some(ordinary_file)) },
        )
        .await
        .is_err();
        let directory_rejected = choose_with_picker(
            &bridge,
            "main",
            attachment.generation,
            FileResourceRole::CaptureSource,
            || async { Ok(Some(bad_directory)) },
        )
        .await
        .is_err();
        let unchanged = auth.current_revision().unwrap() == before;
        let selected = choose_with_picker(
            &bridge,
            "main",
            attachment.generation,
            FileResourceRole::CaptureSource,
            || async { Ok(Some(valid)) },
        )
        .await;
        let mut replay = None;
        let mut metadata = None;
        let mut revoked = None;
        let mut no_regrant = false;
        if let Ok(Some(selected)) = &selected {
            metadata = Some(
                query_resource(
                    &bridge,
                    "main",
                    attachment.generation,
                    &selected.reference,
                    "file.metadata",
                    serde_json::json!({"fileRef":selected.reference}),
                )
                .await,
            );
            replay = Some(
                open_selected_capture(&bridge, attachment.generation, &selected.reference).await,
            );
            let controller = auth
                .authenticate_user_control(
                    &attachment.attachment.client_id,
                    &serial_workbench_client::read_user_control_credential(directory.path())
                        .unwrap(),
                )
                .unwrap();
            auth.revoke(
                &controller,
                RevokeParams {
                    actor_id: attachment.attachment.actor_id.clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![resource_target(&selected.reference)],
                },
            )
            .unwrap();
            let after_revoke = auth.current_revision().unwrap();
            revoked = Some(
                open_selected_capture(&bridge, attachment.generation, &selected.reference).await,
            );
            no_regrant = auth.current_revision().unwrap() == after_revoke;
        }
        drop(bridge);
        stop.send(()).unwrap();
        running.await.unwrap().unwrap();
        assert!(cancelled.unwrap().is_none());
        assert!(file_rejected && directory_rejected);
        assert!(
            unchanged,
            "cancel/invalid selection must not grant permissions"
        );
        let selected = selected.unwrap().unwrap();
        assert!(selected.reference.revision.is_some());
        let public = serde_json::to_string(&selected).unwrap();
        assert!(!public.contains(directory.path().to_str().unwrap()));
        assert!(
            matches!(metadata.unwrap().unwrap(), QueryResult::FileMetadata(value) if value.purpose == FilePurpose::CaptureSource)
        );
        let replay = replay.unwrap();
        assert!(
            replay.is_ok(),
            "real capture directory must open in replay: {replay:?}"
        );
        assert_eq!(revoked.unwrap().unwrap_err().code, "PERMISSION_DENIED");
        assert!(no_regrant);
    }

    #[test]
    fn image_validation_and_fingerprint_use_the_same_immutable_bytes() {
        struct ChangedAfterDecode {
            source: std::io::Cursor<Vec<u8>>,
            rewinds: usize,
        }
        impl Read for ChangedAfterDecode {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.source.read(bytes)
            }
        }
        impl Seek for ChangedAfterDecode {
            fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
                if matches!(position, std::io::SeekFrom::Start(0)) {
                    self.rewinds += 1;
                    if self.rewinds == 3 {
                        let last = self.source.get_ref().len() - 1;
                        self.source.get_mut()[last] ^= 1;
                    }
                }
                self.source.seek(position)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("image.png");
        image::RgbaImage::new(2, 3)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        let bytes = std::fs::read(path).unwrap();
        let expected = format!("{:x}", sha2::Sha256::digest(&bytes));
        let checked = inspect_media_reader(
            ChangedAfterDecode {
                source: std::io::Cursor::new(bytes.clone()),
                rewinds: 0,
            },
            bytes.len() as u64,
        )
        .unwrap();
        assert_eq!(checked.0, "image/png");
        assert_eq!(checked.2.as_str(), expected);
    }
    #[tokio::test]
    async fn explicit_selection_grants_only_selected_ref_and_never_regrants_on_read() {
        use serial_workbench_host::{Host, ipc::HostServer};
        use std::sync::Arc;
        let directory = tempfile::tempdir().unwrap();
        let mut server = HostServer::bind(directory.path()).await.unwrap();
        let auth = server.auth();
        let host = Host::new(server.store(), auth.clone()).await.unwrap();
        let (stop, done) = tokio::sync::oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        let bridge = crate::host_bridge::DesktopHostBridge::new(directory.path().into());
        let attachment = bridge.attach("main").await.unwrap();
        // Authenticate the real persisted business identity, without forging an actor.
        #[derive(serde::Deserialize)]
        struct Credential {
            credential: ContextToken,
        }
        let credential_path = directory.path().join("host-v0/clients").join(format!(
            "{:x}.secret",
            sha2::Sha256::digest(attachment.attachment.client_id.as_str().as_bytes())
        ));
        let saved: Credential = serde_json::from_slice(
            &serial_workbench_ipc::read_secret(&credential_path)
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        let actor = auth
            .authenticate(&attachment.attachment.client_id, Some(&saved.credential))
            .unwrap()
            .actor;
        let controller = auth
            .authenticate_user_control(
                &attachment.attachment.client_id,
                &serial_workbench_client::read_user_control_credential(directory.path()).unwrap(),
            )
            .unwrap();
        let path = directory.path().join("chosen.png");
        image::RgbaImage::new(2, 3)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        let unrelated = register(
            &bridge,
            "main",
            attachment.generation,
            &path,
            FileResourceRole::Source,
        )
        .await
        .unwrap();
        let before = auth.current_revision().unwrap();
        let cancelled = choose_with_picker(
            &bridge,
            "main",
            attachment.generation,
            FileResourceRole::Media,
            || async { Ok(None) },
        )
        .await;
        let invalid_path = directory.path().join("invalid.png");
        std::fs::write(&invalid_path, b"not an image").unwrap();
        let invalid_selection = choose_with_picker(
            &bridge,
            "main",
            attachment.generation,
            FileResourceRole::Media,
            || async { Ok(Some(invalid_path)) },
        )
        .await;
        let unchanged_without_selection = auth.current_revision().unwrap() == before;
        let mut selected_permissions = Vec::new();
        let mut first = None;
        for role in [
            FileResourceRole::Source,
            FileResourceRole::Media,
            FileResourceRole::CaptureTarget,
        ] {
            let chosen_path = if matches!(role, FileResourceRole::CaptureTarget) {
                directory.path().join("capture.swb")
            } else {
                path.clone()
            };
            let selected =
                choose_with_picker(&bridge, "main", attachment.generation, role, || async {
                    Ok(Some(chosen_path))
                })
                .await
                .unwrap()
                .unwrap();
            let target = resource_target(&selected.reference);
            let read = auth.require(&actor, "content.read", &target).is_ok();
            let write = auth.require(&actor, "workspace.modify", &target).is_ok();
            selected_permissions.push((read, write));
            if first.is_none() {
                first = Some(selected.reference);
            }
        }
        let first = first.unwrap();
        let original_read = query_resource(
            &bridge,
            "main",
            attachment.generation,
            &first,
            "file.read",
            serde_json::json!({"fileRef":first,"offset":"0","maxBytes":"64"}),
        )
        .await;
        let unrelated_denied = auth
            .require(
                &actor,
                "content.read",
                &resource_target(&unrelated.file_ref),
            )
            .is_err()
            && auth
                .require(
                    &actor,
                    "workspace.modify",
                    &resource_target(&unrelated.file_ref),
                )
                .is_err();
        auth.revoke(
            &controller,
            RevokeParams {
                actor_id: actor.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![resource_target(&first)],
            },
        )
        .unwrap();
        let revoked_revision = auth.current_revision().unwrap();
        let revoked_read = query_resource(
            &bridge,
            "main",
            attachment.generation,
            &first,
            "file.read",
            serde_json::json!({"fileRef":first,"offset":"0","maxBytes":"64"}),
        )
        .await;
        let not_regranted = auth.current_revision().unwrap() == revoked_revision;
        drop(bridge);
        stop.send(()).unwrap();
        running.await.unwrap().unwrap();
        assert!(cancelled.unwrap().is_none());
        assert!(invalid_selection.is_err());
        assert!(unchanged_without_selection);
        assert_eq!(
            selected_permissions,
            vec![(true, false), (true, false), (false, true)]
        );
        assert!(
            original_read.is_ok(),
            "selected Source must be readable by its business actor"
        );
        assert!(unrelated_denied);
        assert_eq!(revoked_read.unwrap_err().code, "PERMISSION_DENIED");
        assert!(not_regranted);
    }

    #[tokio::test]
    async fn trusted_chooser_registers_through_real_host_without_publishing_path() {
        use serial_workbench_host::{Host, ipc::HostServer};
        use std::sync::Arc;
        let directory = tempfile::tempdir().unwrap();
        let mut server = HostServer::bind(directory.path()).await.unwrap();
        let host = Host::new(server.store(), server.auth()).await.unwrap();
        let (stop, done) = tokio::sync::oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        let bridge = crate::host_bridge::DesktopHostBridge::new(directory.path().into());
        let attachment = bridge.attach("main").await.unwrap();
        let path = directory.path().join("private-selected.bin");
        image::RgbaImage::new(2, 3)
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        let selected = choose_with_picker(
            &bridge,
            "main",
            attachment.generation,
            FileResourceRole::Media,
            || async { Ok(Some(path.clone())) },
        )
        .await;
        drop(bridge);
        stop.send(()).unwrap();
        running.await.unwrap().unwrap();
        let selected = selected.unwrap().unwrap();
        assert_eq!(selected.mime, "image/png");
        assert_eq!(selected.name, "private-selected.bin");
        assert_eq!(selected.reference.revision, Some(1.into()));
        let public = serde_json::to_string(&selected).unwrap();
        assert!(!public.contains(directory.path().to_str().unwrap()));
        assert!(!public.contains("requestContext"));
    }
    #[test]
    fn selected_real_file_is_fixed_and_other_actor_needs_current_grant() {
        use serial_workbench_core::*;
        use serial_workbench_host::{auth::AuthService, files::FileService, storage::Store};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private-source.bin");
        std::fs::write(&path, b"original").unwrap();
        let store = Store::open(&dir.path().join("profile")).unwrap();
        let identity = store.begin_instance().unwrap();
        let secret = ContextToken::try_from("test-control").unwrap();
        let auth = AuthService::new(store.clone(), secret.clone());
        let operator = auth
            .authenticate_user_control(&Id::try_from("desktop").unwrap(), &secret)
            .unwrap();
        let reader = auth
            .authenticate(&Id::try_from("reader").unwrap(), None)
            .unwrap()
            .actor;
        let files = FileService::new(store, auth.clone(), identity);
        let chosen = select_path("main", || Ok(Some(path.clone())))
            .unwrap()
            .unwrap();
        let reference = files
            .register(
                RegisterFileParams {
                    path: chosen.to_str().unwrap().into(),
                    purpose: FilePurpose::ReadFile,
                },
                &operator,
            )
            .unwrap();
        assert_eq!(reference.revision, Some(1.into()));
        let read = || FileReadParams {
            file_ref: reference.clone(),
            offset: 0.into(),
            max_bytes: 65536.into(),
        };
        assert!(files.read(read(), &reader).is_err());
        let grant = auth
            .authorize(
                &operator,
                AuthorizeParams {
                    client_id: reader.client_id().clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![Target {
                        host_id: reference.host_id.clone(),
                        kind: reference.kind.clone(),
                        id: reference.id.clone(),
                        session_id: None,
                        session_epoch: None,
                    }],
                    expires_at: None,
                },
            )
            .unwrap();
        assert_eq!(
            files.read(read(), &reader).unwrap().total_bytes,
            U64::from(8)
        );
        let public =
            serde_json::to_string(&files.metadata(&reference, &operator).unwrap()).unwrap();
        assert!(!public.contains("private-source"));
        assert!(!public.contains("path"));
        let _ = grant;
        std::fs::write(path, b"modified").unwrap();
        assert_eq!(
            files.read(read(), &reader).unwrap_err().code,
            "SOURCE_CHANGED"
        );
        auth.revoke(
            &operator,
            RevokeParams {
                actor_id: reader.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![Target {
                    host_id: reference.host_id.clone(),
                    kind: reference.kind.clone(),
                    id: reference.id.clone(),
                    session_id: None,
                    session_epoch: None,
                }],
            },
        )
        .unwrap();
        assert!(files.read(read(), &reader).is_err());
    }
    #[test]
    fn unavailable_window_never_opens_picker() {
        let mut calls = 0;
        let result = select_path("diagnostics-recovery", || {
            calls += 1;
            Ok(None)
        });
        assert!(result.is_err());
        assert_eq!(calls, 0);
    }
    #[test]
    fn cancelled_selection_returns_no_path() {
        assert!(select_path("main", || Ok(None)).unwrap().is_none());
    }
    #[test]
    fn media_uses_content_not_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("renamed.bin");
        let png = image::RgbaImage::new(2, 3);
        png.save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        assert_eq!(inspect_media(&path).unwrap().0, "image/png");
        std::fs::write(&path, b"not an image").unwrap();
        assert!(inspect_media(&path).is_err());
    }
    #[test]
    fn media_rejects_truncated_image_and_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake.png");
        std::fs::write(&path, b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(inspect_media(&path).is_err());
        assert!(inspect_media(dir.path()).is_err());
    }
    #[test]
    fn mp4_and_webm_use_actual_container_headers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("renamed.txt");
        std::fs::write(
            &path,
            [
                0, 0, 0, 20, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 0, b'm',
                b'p', b'4', b'2',
            ],
        )
        .unwrap();
        assert_eq!(inspect_media(&path).unwrap().0, "video/mp4");
        std::fs::write(&path, b"\x1a\x45\xdf\xa3\x87\x42\x82\x84webm").unwrap();
        assert_eq!(inspect_media(&path).unwrap().0, "video/webm");
    }
}
