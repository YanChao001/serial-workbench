//! Window-bound Host media tickets and bounded range delivery.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::{HostError, HostResult, ObjectRef, QueryResult, U64};
use sha2::Digest as _;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{
    Manager,
    http::{Response, StatusCode},
};

#[derive(Clone)]
struct MediaTicket {
    window: String,
    instance: u64,
    generation: U64,
    reference: ObjectRef,
    mime: String,
    length: U64,
}
#[derive(Default)]
pub(crate) struct MediaTickets(
    Mutex<HashMap<String, MediaTicket>>,
    Arc<Mutex<ResponseUsage>>,
);
#[derive(Default)]
struct ResponseUsage {
    slots: usize,
    bytes: u64,
    validating_image: bool,
}
struct MediaResponsePermit {
    usage: Arc<Mutex<ResponseUsage>>,
    bytes: u64,
    validating_image: bool,
}
impl Drop for MediaResponsePermit {
    fn drop(&mut self) {
        if let Ok(mut usage) = self.usage.lock() {
            usage.slots -= 1;
            usage.bytes -= self.bytes;
            if self.validating_image {
                usage.validating_image = false;
            }
        }
    }
}
impl MediaTickets {
    fn reserve(&self, bytes: u64, validating_image: bool) -> HostResult<MediaResponsePermit> {
        let mut usage = self.1.lock().map_err(|_| unavailable())?;
        if usage.slots >= 8
            || bytes > 64 * 1024 * 1024 - usage.bytes
            || (validating_image && usage.validating_image)
        {
            return Err(HostError::new(
                "HOST_BUSY",
                "Media response budget exhausted",
            ));
        }
        usage.slots += 1;
        usage.bytes += bytes;
        usage.validating_image |= validating_image;
        Ok(MediaResponsePermit {
            usage: self.1.clone(),
            bytes,
            validating_image,
        })
    }
    fn begin_response(
        &self,
        id: &str,
        window: &str,
        range: Option<&str>,
        head: bool,
    ) -> HostResult<MediaResponsePermit> {
        let ticket = self.lookup(id, window)?;
        let (start, end) = response_range(&ticket, range)?;
        self.reserve(if head { 0 } else { end - start + 1 }, false)
    }
    fn issue(&self, ticket: MediaTicket) -> HostResult<String> {
        let mut entries = self.0.lock().map_err(|_| unavailable())?;
        entries.retain(|_, entry| {
            entry.window != ticket.window || entry.generation == ticket.generation
        });
        if entries.len() >= 64 {
            return Err(HostError::new(
                "HOST_BUSY",
                "Media ticket capacity exhausted",
            ));
        }
        let token = serial_workbench_ipc::identity::random_token();
        let id = format!("{:x}", sha2::Sha256::digest(token.as_str().as_bytes()));
        entries.insert(id.clone(), ticket);
        Ok(id)
    }
    fn lookup(&self, id: &str, window: &str) -> HostResult<MediaTicket> {
        self.0
            .lock()
            .map_err(|_| unavailable())?
            .get(id)
            .filter(|entry| entry.window == window)
            .cloned()
            .ok_or_else(unavailable)
    }
    pub(crate) fn destroy_window(&self, window: &str, instance: u64) {
        if let Ok(mut entries) = self.0.lock() {
            entries.retain(|_, entry| entry.window != window || entry.instance != instance);
        }
    }
    fn release(&self, id: &str, window: &str, generation: U64) {
        if let Ok(mut entries) = self.0.lock()
            && entries
                .get(id)
                .is_some_and(|entry| entry.window == window && entry.generation == generation)
        {
            entries.remove(id);
        }
    }
}
fn unavailable() -> HostError {
    HostError::new("NOT_FOUND", "Media ticket unavailable")
}
fn byte_range(range: Option<&str>, length: u64) -> Option<(u64, u64)> {
    if length == 0 {
        return None;
    }
    let (start, end) = match range {
        None => (0, length - 1),
        Some(range) => {
            let (first, last) = range.strip_prefix("bytes=")?.split_once('-')?;
            if first.is_empty() {
                let suffix = last.parse::<u64>().ok()?;
                if suffix == 0 {
                    return None;
                }
                (length.saturating_sub(suffix), length - 1)
            } else {
                let start = first.parse::<u64>().ok()?;
                let end = if last.is_empty() {
                    length - 1
                } else {
                    last.parse::<u64>().ok()?.min(length - 1)
                };
                (start, end)
            }
        }
    };
    if start >= length || end < start {
        return None;
    }
    Some((start, end.min(start.saturating_add(65535))))
}

#[cfg(test)]
async fn read_response(
    bridge: &crate::host_bridge::DesktopHostBridge,
    tickets: &MediaTickets,
    window: &str,
    id: &str,
    range: Option<&str>,
) -> HostResult<tauri::http::Response<Vec<u8>>> {
    let permit = tickets.begin_response(id, window, range, false)?;
    read_response_inner(bridge, tickets, window, id, range, false, &permit).await
}

fn response_range(ticket: &MediaTicket, range: Option<&str>) -> HostResult<(u64, u64)> {
    let length = ticket.length.get();
    if range.is_none() && ticket.mime.starts_with("image/") {
        if length == 0 || length > 64 * 1024 * 1024 {
            return Err(invalid());
        }
        Ok((0, length - 1))
    } else {
        byte_range(range, length).ok_or_else(invalid)
    }
}

fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid media response")
}
fn response_builder(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header("Vary", "Origin")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Accept-Ranges, Content-Length",
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
}
async fn read_response_inner(
    bridge: &crate::host_bridge::DesktopHostBridge,
    tickets: &MediaTickets,
    window: &str,
    id: &str,
    range: Option<&str>,
    head: bool,
    _permit: &MediaResponsePermit,
) -> HostResult<Response<Vec<u8>>> {
    let ticket = tickets.lookup(id, window)?;
    bridge
        .attachment_at_generation(window, ticket.generation)
        .await?;
    let length = ticket.length.get();
    let (start, end) = response_range(&ticket, range)?;
    let expected = end - start + 1;
    let mut bytes = Vec::with_capacity(if head { 0 } else { expected as usize });
    let mut offset = start;
    let mut fingerprint = None;
    loop {
        let max_bytes = if head {
            1
        } else {
            (end - offset + 1).min(65536)
        };
        let value=crate::file_resource_commands::query_resource(bridge,window,ticket.generation,&ticket.reference,"file.read",serde_json::json!({"fileRef":ticket.reference,"offset":offset.to_string(),"maxBytes":max_bytes.to_string()})).await?;
        let QueryResult::FileRead(result) = value else {
            return Err(invalid());
        };
        let chunk = STANDARD
            .decode(result.bytes_base64.as_str())
            .map_err(|_| invalid())?;
        if result.file_ref != ticket.reference
            || result.offset.get() != offset
            || result.total_bytes != ticket.length
            || chunk.len() as u64 != max_bytes
            || result.next_offset.get() != offset + max_bytes
            || result.at_end != (offset + max_bytes == length)
            || fingerprint
                .as_ref()
                .is_some_and(|value| *value != result.fingerprint)
        {
            return Err(invalid());
        }
        fingerprint = Some(result.fingerprint);
        tickets.lookup(id, window)?;
        if head {
            break;
        }
        bytes.extend_from_slice(&chunk);
        offset += max_bytes;
        if offset > end {
            break;
        }
    }
    let partial = range.is_some() || start != 0 || end + 1 != length;
    let mut response = response_builder(if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    })
    .header("Content-Type", &ticket.mime)
    .header("Accept-Ranges", "bytes")
    .header("Content-Length", expected.to_string());
    if partial {
        response = response.header("Content-Range", format!("bytes {start}-{end}/{length}"));
    }
    response.body(bytes).map_err(|_| invalid())
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MediaResolution {
    pub ticket: String,
    pub url: String,
    pub name: String,
    pub mime: String,
}

#[tauri::command]
#[specta::specta]
pub async fn media_resolve(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    reference: ObjectRef,
    generation: U64,
) -> HostResult<MediaResolution> {
    let bridge = app.state::<crate::host_bridge::DesktopHostBridge>();
    bridge.bind_window(&window)?;
    let tickets = app.state::<MediaTickets>();
    resolve_resource(&bridge, &tickets, window.label(), reference, generation).await
}

async fn resolve_resource(
    bridge: &crate::host_bridge::DesktopHostBridge,
    tickets: &MediaTickets,
    window: &str,
    reference: ObjectRef,
    generation: U64,
) -> HostResult<MediaResolution> {
    if reference.kind.as_str() != "file" || reference.revision.is_none() {
        return Err(invalid());
    }
    let metadata = crate::file_resource_commands::query_resource(
        bridge,
        window,
        generation,
        &reference,
        "file.metadata",
        serde_json::json!({"fileRef":reference}),
    )
    .await?;
    let QueryResult::FileMetadata(metadata) = metadata else {
        return Err(invalid());
    };
    if metadata.purpose != serial_workbench_core::FilePurpose::ReadFile
        || metadata.file_ref != reference
    {
        return Err(invalid());
    }
    let first = crate::file_resource_commands::query_resource(
        bridge,
        window,
        generation,
        &reference,
        "file.read",
        serde_json::json!({"fileRef":reference,"offset":"0","maxBytes":"4096"}),
    )
    .await?;
    let QueryResult::FileRead(first) = first else {
        return Err(invalid());
    };
    if first.file_ref != reference
        || first.total_bytes != metadata.length
        || first.fingerprint != metadata.fingerprint
        || first.offset.get() != 0
    {
        return Err(invalid());
    }
    let bytes = STANDARD
        .decode(first.bytes_base64.as_str())
        .map_err(|_| invalid())?;
    if bytes.len() as u64 != metadata.length.get().min(4096)
        || first.next_offset.get() != bytes.len() as u64
        || first.at_end != (bytes.len() as u64 == metadata.length.get())
    {
        return Err(invalid());
    }
    let mime = crate::file_resource_commands::media_type(&bytes, metadata.length.get())?;
    let limit = if mime.starts_with("image/") {
        64 * 1024 * 1024
    } else {
        128 * 1024 * 1024
    };
    if metadata.length.get() > limit {
        return Err(HostError::new(
            "LIMIT_EXCEEDED",
            "Media size exceeds the supported limit",
        ));
    }
    if mime.starts_with("image/") {
        // Source/CLI registrations have no media attestation. Validate the exact fixed
        // Host content before issuing a media ticket, regardless of its original chooser.
        let permit = tickets.reserve(metadata.length.get(), true)?;
        let mut image = Vec::with_capacity(metadata.length.get() as usize);
        image.extend_from_slice(&bytes);
        drop(bytes);
        while (image.len() as u64) < metadata.length.get() {
            let offset = image.len() as u64;
            let max_bytes = (metadata.length.get() - offset).min(65536);
            let chunk = crate::file_resource_commands::query_resource(
                bridge, window, generation, &reference, "file.read",
                serde_json::json!({"fileRef":reference,"offset":offset.to_string(),"maxBytes":max_bytes.to_string()}),
            ).await?;
            let QueryResult::FileRead(chunk) = chunk else {
                return Err(invalid());
            };
            let data = STANDARD
                .decode(chunk.bytes_base64.as_str())
                .map_err(|_| invalid())?;
            if chunk.file_ref != reference
                || chunk.total_bytes != metadata.length
                || chunk.fingerprint != metadata.fingerprint
                || chunk.offset.get() != offset
                || data.len() as u64 != max_bytes
                || chunk.next_offset.get() != offset + max_bytes
                || chunk.at_end != (offset + max_bytes == metadata.length.get())
            {
                return Err(invalid());
            }
            image.extend_from_slice(&data);
        }
        if format!("{:x}", sha2::Sha256::digest(&image)) != metadata.fingerprint.as_str() {
            return Err(HostError::new(
                "SOURCE_CHANGED",
                "Media content changed during validation",
            ));
        }
        tauri::async_runtime::spawn_blocking(move || {
            let result = crate::file_resource_commands::validate_image_bytes(&image);
            drop(image);
            // A canceled waiter cannot free a running decoder's memory reservation.
            drop(permit);
            result
        })
        .await
        .map_err(|_| invalid())??;
    }
    let name = reference.id.as_str().to_owned();
    let instance = bridge
        .window_instance_at_generation(window, generation)
        .await?;
    let ticket = bridge
        .with_current_generation(window, generation, || {
            tickets.issue(MediaTicket {
                window: window.into(),
                instance,
                generation,
                reference,
                mime: mime.into(),
                length: metadata.length,
            })
        })
        .await?;
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let url = format!("http://swb-media.localhost/{ticket}");
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let url = format!("swb-media://localhost/{ticket}");
    Ok(MediaResolution {
        ticket,
        url,
        name,
        mime: mime.into(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn media_release(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    ticket: String,
    generation: U64,
) -> HostResult<()> {
    let bridge = app.state::<crate::host_bridge::DesktopHostBridge>();
    bridge.bind_window(&window)?;
    bridge
        .with_current_generation(window.label(), generation, || {
            app.state::<MediaTickets>()
                .release(&ticket, window.label(), generation);
            Ok(())
        })
        .await
}

fn allowed_origin(origin: &str, development: Option<&str>) -> bool {
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) || development == Some(origin)
}
pub(crate) fn register_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol("swb-media", |context, request, responder| {
        let app = context.app_handle().clone();
        let window = context.webview_label().to_owned();
        let origin = request.headers().get("origin").cloned();
        let development = if cfg!(debug_assertions) {
            app.config()
                .build
                .dev_url
                .as_ref()
                .map(|url| url.origin().ascii_serialization())
        } else {
            None
        };
        if crate::commands::require_host_window(&window).is_err()
            || origin.as_ref().is_some_and(|origin| {
                origin.to_str().map_or(true, |origin| {
                    !allowed_origin(origin, development.as_deref())
                })
            })
        {
            responder.respond(
                response_builder(StatusCode::FORBIDDEN)
                    .body(Vec::<u8>::new())
                    .expect("static media response"),
            );
            return;
        }
        if !matches!(request.method().as_str(), "GET" | "HEAD") {
            responder.respond(
                response_builder(StatusCode::METHOD_NOT_ALLOWED)
                    .body(Vec::<u8>::new())
                    .expect("static media response"),
            );
            return;
        }
        let id = request.uri().path().trim_start_matches('/').to_owned();
        if id.len() != 64
            || !id.bytes().all(|b| b.is_ascii_hexdigit())
            || request.uri().query().is_some()
        {
            responder.respond(
                response_builder(StatusCode::NOT_FOUND)
                    .body(Vec::<u8>::new())
                    .expect("static media response"),
            );
            return;
        }
        let range = match request
            .headers()
            .get("range")
            .map(|value| value.to_str())
            .transpose()
        {
            Ok(range) => range.map(str::to_owned),
            Err(_) => {
                responder.respond(
                    response_builder(StatusCode::RANGE_NOT_SATISFIABLE)
                        .body(Vec::<u8>::new())
                        .expect("static media response"),
                );
                return;
            }
        };
        let head = request.method() == "HEAD";
        // Never queue work or allocate its body until both budgets have been reserved.
        let permit =
            match app
                .state::<MediaTickets>()
                .begin_response(&id, &window, range.as_deref(), head)
            {
                Ok(permit) => permit,
                Err(error) => {
                    let status = match error.code.as_str() {
                        "HOST_BUSY" => StatusCode::SERVICE_UNAVAILABLE,
                        "INVALID_ARGUMENT" => StatusCode::RANGE_NOT_SATISFIABLE,
                        _ => StatusCode::NOT_FOUND,
                    };
                    responder.respond(
                        response_builder(status)
                            .body(Vec::<u8>::new())
                            .expect("static media response"),
                    );
                    return;
                }
            };
        tauri::async_runtime::spawn(async move {
            let bridge = app.state::<crate::host_bridge::DesktopHostBridge>();
            let tickets = app.state::<MediaTickets>();
            let generation = match tickets.lookup(&id, &window) {
                Ok(ticket) => ticket.generation,
                Err(_) => {
                    responder.respond(
                        response_builder(StatusCode::NOT_FOUND)
                            .body(Vec::<u8>::new())
                            .expect("static media response"),
                    );
                    return;
                }
            };
            let response = read_response_inner(
                &bridge,
                &tickets,
                &window,
                &id,
                range.as_deref(),
                head,
                &permit,
            )
            .await;
            let mut response = response.unwrap_or_else(|error| {
                response_builder(if error.code == "INVALID_ARGUMENT" {
                    StatusCode::RANGE_NOT_SATISFIABLE
                } else {
                    StatusCode::NOT_FOUND
                })
                .body(vec![])
                .expect("static media response")
            });
            if let Some(origin) = origin {
                response
                    .headers_mut()
                    .insert(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            }
            // Serialize publication against both detach and explicit release, including late reads.
            let mut responder = Some(responder);
            let sent = bridge
                .with_current_generation(&window, generation, || {
                    let entries = tickets.0.lock().map_err(|_| unavailable())?;
                    if !entries.get(&id).is_some_and(|ticket| {
                        ticket.window == window && ticket.generation == generation
                    }) {
                        return Err(unavailable());
                    }
                    responder
                        .take()
                        .expect("one media responder")
                        .respond(response);
                    Ok(())
                })
                .await;
            if sent.is_err()
                && let Some(responder) = responder
            {
                responder.respond(
                    response_builder(StatusCode::NOT_FOUND)
                        .body(Vec::<u8>::new())
                        .expect("static media response"),
                );
            }
            // The Native response has been handed off (or dropped); it no longer owns a body.
            drop(permit);
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn source_registered_images_require_full_validation_before_ticket_issue() {
        use crate::file_resource_commands::{FileResourceRole, choose_with_picker};
        use serial_workbench_host::{Host, ipc::HostServer};
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
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
        let bridge = crate::host_bridge::DesktopHostBridge::new(dir.path().into());
        let attachment = bridge.attach("main").await.unwrap();
        let controller = auth
            .authenticate_user_control(
                &attachment.attachment.client_id,
                &serial_workbench_client::read_user_control_credential(dir.path()).unwrap(),
            )
            .unwrap();
        let good = dir.path().join("good.png");
        image::DynamicImage::new_rgba8(1, 1)
            .save_with_format(&good, image::ImageFormat::Png)
            .unwrap();
        let broken = dir.path().join("truncated.png");
        std::fs::write(&broken, b"\x89PNG\r\n\x1a\n").unwrap();
        let oversized = dir.path().join("wide.png");
        image::DynamicImage::new_rgba8(32769, 1)
            .save_with_format(&oversized, image::ImageFormat::Png)
            .unwrap();
        let tickets = MediaTickets::default();
        let mut outcomes = Vec::new();
        for path in [&good, &broken, &oversized] {
            // Source is a legitimate ReadFile registration, without Media chooser validation.
            let selected = choose_with_picker(
                &bridge,
                "main",
                attachment.generation,
                FileResourceRole::Source,
                || async { Ok(Some(path.clone())) },
            )
            .await
            .unwrap()
            .unwrap();
            auth.authorize(
                &controller,
                serial_workbench_core::AuthorizeParams {
                    client_id: attachment.attachment.client_id.clone(),
                    permissions: vec!["content.read".into()],
                    targets: vec![crate::file_resource_commands::resource_target(
                        &selected.reference,
                    )],
                    expires_at: None,
                },
            )
            .unwrap();
            outcomes.push(
                resolve_resource(
                    &bridge,
                    &tickets,
                    "main",
                    selected.reference,
                    attachment.generation,
                )
                .await
                .map(|result| result.ticket),
            );
        }
        drop(bridge);
        stop.send(()).unwrap();
        running.await.unwrap().unwrap();
        assert!(outcomes[0].is_ok(), "valid Source image must resolve");
        assert!(
            outcomes[1].is_err(),
            "truncated Source image obtained a ticket"
        );
        assert!(
            outcomes[2].is_err(),
            "oversized Source image obtained a ticket"
        );
        assert_eq!(tickets.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn repeated_ticket_responses_reserve_bytes_and_slots_until_work_drops() {
        let tickets = MediaTickets::default();
        let mut large = ticket("main", 1);
        large.mime = "image/png".into();
        large.length = (64u64 * 1024 * 1024).into();
        let id = tickets.issue(large.clone()).unwrap();
        // Admission is synchronous and precedes any task or response allocation.
        let in_flight = tickets.begin_response(&id, "main", None, false).unwrap();
        assert!(
            matches!(tickets.begin_response(&id, "main", None, false), Err(error) if error.code == "HOST_BUSY")
        );
        tickets.release(&id, "main", 1.into());
        let next = tickets.issue(large.clone()).unwrap();
        assert!(
            matches!(tickets.begin_response(&next, "main", None, false), Err(error) if error.code == "HOST_BUSY")
        );
        tickets.destroy_window("main", 1);
        let next = tickets.issue(large).unwrap();
        assert!(
            matches!(tickets.begin_response(&next, "main", None, false), Err(error) if error.code == "HOST_BUSY")
        );
        // An aborted task retains its reservation until the task is actually dropped.
        let (started, ready) = tokio::sync::oneshot::channel();
        let work = tokio::spawn(async move {
            let _held_until_exit = in_flight;
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        work.abort();
        assert!(work.await.unwrap_err().is_cancelled());
        drop(tickets.begin_response(&next, "main", None, false).unwrap());
        // Small responses consume slots even when their byte total is below the limit.
        let mut slots = Vec::new();
        for _ in 0..8 {
            slots.push(
                tickets
                    .begin_response(&next, "main", Some("bytes=0-0"), false)
                    .unwrap(),
            );
        }
        assert!(
            matches!(tickets.begin_response(&next, "main", Some("bytes=0-0"), false), Err(error) if error.code == "HOST_BUSY")
        );
        drop(slots.pop());
        assert!(
            tickets
                .begin_response(&next, "main", Some("bytes=0-0"), false)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn reading_old_ticket_never_reattaches_a_destroyed_window() {
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("absent-profile");
        let bridge = crate::host_bridge::DesktopHostBridge::new(absent.clone());
        let tickets = MediaTickets::default();
        let id = tickets.issue(ticket("main", 1)).unwrap();
        let error = read_response(&bridge, &tickets, "main", &id, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, "EPOCH_MISMATCH");
        assert!(!absent.exists());
    }
    #[tokio::test]
    async fn response_reads_real_host_bytes_and_rejects_changed_source_and_old_generation() {
        use crate::file_resource_commands::{FileResourceRole, choose_with_picker};
        use serial_workbench_host::{Host, ipc::HostServer};
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let mut server = HostServer::bind(dir.path()).await.unwrap();
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
        let bridge = crate::host_bridge::DesktopHostBridge::new(dir.path().into());
        let attachment = bridge.attach("main").await.unwrap();
        let path = dir.path().join("video.mp4");
        let mut bytes = vec![0u8; 200_000];
        bytes[..20].copy_from_slice(&[
            0, 0, 0, 20, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', 0, 0, 0, 0, b'm', b'p',
            b'4', b'2',
        ]);
        for (i, byte) in bytes.iter_mut().enumerate().skip(20) {
            *byte = (i % 251) as u8;
        }
        std::fs::write(&path, &bytes).unwrap();
        let chosen = choose_with_picker(
            &bridge,
            "main",
            attachment.generation,
            FileResourceRole::Media,
            || async { Ok(Some(path.clone())) },
        )
        .await
        .unwrap()
        .unwrap();
        // This fixture models a previously explicit grant, not an implicit Ref capability.
        let controller = auth
            .authenticate_user_control(
                &attachment.attachment.client_id,
                &serial_workbench_client::read_user_control_credential(dir.path()).unwrap(),
            )
            .unwrap();
        let target = crate::file_resource_commands::resource_target(&chosen.reference);
        let grant = serial_workbench_core::AuthorizeParams {
            client_id: attachment.attachment.client_id.clone(),
            permissions: vec!["content.read".into()],
            targets: vec![target.clone()],
            expires_at: None,
        };
        auth.authorize(&controller, grant.clone()).unwrap();
        let tickets = MediaTickets::default();
        let media = resolve_resource(
            &bridge,
            &tickets,
            "main",
            chosen.reference,
            attachment.generation,
        )
        .await
        .unwrap();
        assert_eq!(media.mime, "video/mp4");
        assert!(
            !media
                .url
                .contains(attachment.attachment.request_context.as_str())
        );
        assert!(!media.url.contains(dir.path().to_str().unwrap()));
        let id = media.ticket;
        let response =
            read_response(&bridge, &tickets, "main", &id, Some("bytes=1024-100000")).await;
        // Always shut down this in-process fixture even when asserting the RED response.
        if let Ok(response) = &response {
            assert_eq!(response.status(), 206);
            assert_eq!(response.body(), &bytes[1024..1024 + 65536]);
        }
        auth.revoke(
            &controller,
            serial_workbench_core::RevokeParams {
                actor_id: attachment.attachment.actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![target],
            },
        )
        .unwrap();
        let revoked = read_response(&bridge, &tickets, "main", &id, None).await;
        auth.authorize(&controller, grant).unwrap();
        std::fs::write(&path, b"changed").unwrap();
        let changed = read_response(&bridge, &tickets, "main", &id, None).await;
        tickets.destroy_window(
            "main",
            bridge
                .window_instance_at_generation("main", attachment.generation)
                .await
                .unwrap(),
        );
        let destroyed = read_response(&bridge, &tickets, "main", &id, None).await;
        drop(bridge);
        stop.send(()).unwrap();
        running.await.unwrap().unwrap();
        assert!(response.is_ok(), "{response:?}");
        assert_eq!(revoked.unwrap_err().code, "PERMISSION_DENIED");
        assert_eq!(changed.unwrap_err().code, "SOURCE_CHANGED");
        assert_eq!(destroyed.unwrap_err().code, "NOT_FOUND");
    }
    fn ticket(window: &str, generation: u64) -> MediaTicket {
        MediaTicket {
            window: window.into(),
            instance: generation,
            generation: generation.into(),
            reference: serde_json::from_value(
                serde_json::json!({"hostId":"host","kind":"file","id":"file","revision":"1"}),
            )
            .unwrap(),
            mime: "video/mp4".into(),
            length: 100.into(),
        }
    }
    #[test]
    fn tickets_are_bound_to_window_and_generation_and_release_is_idempotent() {
        let tickets = MediaTickets::default();
        let id = tickets.issue(ticket("main", 1)).unwrap();
        assert!(tickets.lookup(&id, "secondary").is_err());
        tickets.release(&id, "main", 2.into());
        assert!(tickets.lookup(&id, "main").is_ok());
        tickets.release(&id, "main", 1.into());
        tickets.release(&id, "main", 1.into());
        assert!(tickets.lookup(&id, "main").is_err());
    }
    #[test]
    fn new_generation_and_destroy_invalidate_old_tickets() {
        let tickets = MediaTickets::default();
        let old = tickets.issue(ticket("main", 1)).unwrap();
        let current = tickets.issue(ticket("main", 2)).unwrap();
        assert!(tickets.lookup(&old, "main").is_err());
        tickets.destroy_window("main", 2);
        assert!(tickets.lookup(&current, "main").is_err());
    }
    #[test]
    fn late_destroy_of_old_window_preserves_new_instance_tickets() {
        let tickets = MediaTickets::default();
        tickets.issue(ticket("main", 1)).unwrap();
        let current = tickets.issue(ticket("main", 2)).unwrap();
        tickets.destroy_window("main", 1);
        assert!(tickets.lookup(&current, "main").is_ok());
        tickets.destroy_window("main", 2);
        assert!(tickets.lookup(&current, "main").is_err());
    }
    #[test]
    fn range_is_bounded_and_suffix_is_supported() {
        assert_eq!(byte_range(None, 1_000_000), Some((0, 65535)));
        assert_eq!(byte_range(Some("bytes=10-"), 100), Some((10, 99)));
        assert_eq!(byte_range(Some("bytes=-5"), 100), Some((95, 99)));
        assert_eq!(
            byte_range(Some("bytes=0-999999"), 1_000_000),
            Some((0, 65535))
        );
    }
    #[test]
    fn invalid_ranges_never_read() {
        for value in [
            "bytes=100-",
            "bytes=2-1",
            "bytes=-0",
            "bytes=0-1,3-4",
            "bytes=18446744073709551616-",
        ] {
            assert_eq!(byte_range(Some(value), 100), None);
        }
        assert_eq!(byte_range(None, 0), None);
    }
}
