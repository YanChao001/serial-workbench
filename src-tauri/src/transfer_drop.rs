use crate::{
    file_resource_commands::{FileResourceRole, SelectedFileResource, choose_with_picker},
    host_bridge::DesktopHostBridge,
};
use serial_workbench_core::{HostError, HostResult, U64};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{DragDropEvent, Emitter, EventTarget, Manager, Webview, WebviewEvent};

const LIFETIME: Duration = Duration::from_secs(15);

#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferDrop {
    ticket: U64,
    generation: U64,
    x: f64,
    y: f64,
}

struct PendingDrop {
    ticket: U64,
    instance: u64,
    generation: Option<U64>,
    path: PathBuf,
    received: Instant,
}

#[derive(Default)]
struct Drops {
    last_ticket: u64,
    windows: HashMap<String, PendingDrop>,
}

impl Drops {
    fn note(&mut self, label: &str, instance: u64, paths: &[PathBuf]) -> Option<U64> {
        self.windows.remove(label);
        let [path] = paths else { return None };
        self.last_ticket = self.last_ticket.checked_add(1)?;
        let ticket = self.last_ticket.into();
        self.windows.insert(
            label.into(),
            PendingDrop {
                ticket,
                instance,
                generation: None,
                path: path.clone(),
                received: Instant::now(),
            },
        );
        Some(ticket)
    }

    fn announce(&mut self, label: &str, ticket: U64, generation: U64) -> bool {
        let Some(entry) = self.windows.get_mut(label) else {
            return false;
        };
        if entry.ticket != ticket || entry.received.elapsed() >= LIFETIME {
            return false;
        }
        entry.generation = Some(generation);
        true
    }

    fn take(
        &mut self,
        label: &str,
        instance: u64,
        generation: U64,
        ticket: U64,
    ) -> Option<PathBuf> {
        let entry = self.windows.get(label)?;
        if entry.instance != instance
            || entry.ticket != ticket
            || entry.generation != Some(generation)
            || entry.received.elapsed() >= LIFETIME
        {
            return None;
        }
        self.windows.remove(label).map(|entry| entry.path)
    }
}

#[derive(Default)]
pub(crate) struct TransferDrops(Mutex<Drops>);

pub(crate) fn on_drop(webview: &Webview, event: &WebviewEvent) {
    let WebviewEvent::DragDrop(DragDropEvent::Drop {
        paths, position, ..
    }) = event
    else {
        return;
    };
    let app = webview.app_handle().clone();
    let label = webview.label().to_owned();
    let Some(window) = app.get_webview_window(&label) else {
        return;
    };
    let bridge = app.state::<DesktopHostBridge>().inner().clone();
    let Ok(instance) = bridge.bind_window(&window) else {
        return;
    };
    let drops = app.state::<TransferDrops>();
    let ticket = drops
        .0
        .lock()
        .expect("transfer drops")
        .note(&label, instance, paths);
    let Some(ticket) = ticket else { return };
    let (x, y) = (position.x, position.y);
    tauri::async_runtime::spawn(async move {
        let Ok(attachment) = bridge.attachment_for_instance(&label, instance).await else {
            return;
        };
        let generation = attachment.generation;
        let current = app
            .state::<TransferDrops>()
            .0
            .lock()
            .expect("transfer drops")
            .announce(&label, ticket, generation);
        if current {
            let _ = app.emit_to(
                EventTarget::webview_window(label),
                "app://transfer-file-drop",
                TransferDrop {
                    ticket,
                    generation,
                    x,
                    y,
                },
            );
        }
    });
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn claim_transfer_drop(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    generation: U64,
    ticket: U64,
) -> HostResult<Option<SelectedFileResource>> {
    let bridge = app.state::<DesktopHostBridge>().inner().clone();
    let instance = bridge.bind_window(&window)?;
    let label = window.label();
    let path = app
        .state::<TransferDrops>()
        .0
        .lock()
        .expect("transfer drops")
        .take(label, instance, generation, ticket)
        .ok_or_else(|| HostError::new("NOT_FOUND", "The dropped file is no longer available"))?;
    choose_with_picker(
        &bridge,
        label,
        generation,
        FileResourceRole::Source,
        || async { Ok(Some(path)) },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_is_owned_by_its_native_window_document_and_host_generation() {
        let mut drops = Drops::default();
        let source = PathBuf::from("source.bin");
        let ticket = drops
            .note("main", 1, std::slice::from_ref(&source))
            .unwrap();
        assert!(drops.take("main", 1, 2.into(), ticket).is_none());
        assert!(drops.announce("main", ticket, 2.into()));
        assert!(drops.take("secondary", 1, 2.into(), ticket).is_none());
        assert!(drops.take("main", 2, 2.into(), ticket).is_none());
        assert!(drops.take("main", 1, 3.into(), ticket).is_none());
        assert_eq!(drops.take("main", 1, 2.into(), ticket), Some(source));
        assert!(drops.take("main", 1, 2.into(), ticket).is_none());
    }

    #[test]
    fn new_drop_invalidates_previous_paths_and_expired_or_multiple_paths_are_unavailable() {
        let mut drops = Drops::default();
        let source = PathBuf::from("source.bin");
        let older = drops
            .note("main", 1, std::slice::from_ref(&source))
            .unwrap();
        let newer = drops
            .note("main", 1, std::slice::from_ref(&source))
            .unwrap();
        assert!(!drops.announce("main", older, 2.into()));
        assert!(drops.announce("main", newer, 2.into()));
        drops.windows.get_mut("main").unwrap().received -= LIFETIME;
        assert!(drops.take("main", 1, 2.into(), newer).is_none());
        assert!(
            drops
                .note("main", 1, &[source, PathBuf::from("other.bin")])
                .is_none()
        );
        assert!(!drops.windows.contains_key("main"));
    }
}
