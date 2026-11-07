//! 工作区与受限本地深链激活；外部参数不授予文件路径或命令执行能力。

use crate::{
    app_config::INTEGRATION,
    blocking, desktop,
    error::{ErrorCode, NativeError, NativeResult},
    storage,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::BTreeMap,
    io::Read,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU32, Ordering},
    },
};
use tauri::{Emitter, Manager};

const MAX_WORKSPACE_BYTES: usize = 16 * 1024;
const MAX_ACTIVATIONS: usize = 20;

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub id: u32,
    pub source: String,
    pub route: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub routes: BTreeMap<String, String>,
    pub secondary_open: bool,
}
pub struct SystemState {
    path: PathBuf,
    workspace: Mutex<Workspace>,
    activations: Mutex<Vec<Activation>>,
    sequence: AtomicU32,
}
#[derive(Default)]
pub struct ActivationInbox(Mutex<Vec<(Vec<String>, String)>>);

pub fn drain_activations(app: &tauri::AppHandle) {
    let queued = app
        .state::<ActivationInbox>()
        .0
        .lock()
        .map(|mut values| std::mem::take(&mut *values))
        .unwrap_or_default();
    for (args, source) in queued {
        activate(app, args, &source);
    }
}

pub fn allowed_route(route: &str) -> bool {
    matches!(route, "/" | "/settings" | "/diagnostics" | "/recovery")
}

impl SystemState {
    pub fn open(path: PathBuf) -> Self {
        let mut workspace: Workspace = std::fs::File::open(&path)
            .and_then(|file| {
                let mut bytes = Vec::new();
                file.take(MAX_WORKSPACE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .ok()
            .filter(|bytes| bytes.len() <= MAX_WORKSPACE_BYTES)
            .and_then(|v| serde_json::from_slice(&v).ok())
            .unwrap_or_default();
        workspace.routes.retain(|label, route| {
            matches!(label.as_str(), "main" | "secondary") && allowed_route(route)
        });
        Self {
            path,
            workspace: Mutex::new(workspace),
            activations: Mutex::new(Vec::new()),
            sequence: AtomicU32::new(0),
        }
    }

    fn next_activation_id(&self) -> Option<u32> {
        self.sequence
            .try_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .ok()
            .map(|value| value + 1)
    }

    fn record_activation(&self, activation: Activation) -> NativeResult<()> {
        let mut activations = self
            .activations
            .lock()
            .map_err(|_| NativeError::new(ErrorCode::Internal, "Activation history unavailable"))?;
        let index = activations.partition_point(|value| value.id < activation.id);
        activations.insert(index, activation);
        if activations.len() > MAX_ACTIVATIONS {
            activations.remove(0);
        }
        Ok(())
    }

    pub fn set_route(&self, label: &str, route: &str) -> NativeResult<()> {
        if !matches!(label, "main" | "secondary") || !allowed_route(route) {
            return Err(NativeError::new(
                ErrorCode::InvalidArgument,
                "Unsupported workspace route",
            ));
        }
        let mut workspace = self
            .workspace
            .lock()
            .map_err(|_| NativeError::new(ErrorCode::Internal, "Workspace unavailable"))?;
        let mut next = workspace.clone();
        next.routes.insert(label.into(), route.into());
        if label == "secondary" {
            next.secondary_open = true;
        }
        storage::atomic_write(
            &self.path,
            &serde_json::to_vec(&next)
                .map_err(|_| NativeError::new(ErrorCode::Internal, "Cannot encode workspace"))?,
        )?;
        *workspace = next;
        Ok(())
    }
    pub fn secondary_closed(&self) {
        if let Ok(mut workspace) = self.workspace.lock() {
            let mut next = workspace.clone();
            next.secondary_open = false;
            if let Ok(bytes) = serde_json::to_vec(&next) {
                match storage::atomic_write(&self.path, &bytes) {
                    Ok(()) => *workspace = next,
                    Err(error) => log::warn!("Cannot persist the closed workspace window: {error}"),
                }
            }
        }
    }
}

pub(crate) fn deep_link_route(argument: &str) -> Option<String> {
    let url = url::Url::parse(argument).ok()?;
    if url.scheme() != INTEGRATION.deep_link_scheme
        || url.host_str() != Some("open")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !matches!(url.path(), "" | "/")
        || url.fragment().is_some()
    {
        return None;
    }
    url.query_pairs()
        .find(|(key, value)| key == "route" && allowed_route(value))
        .map(|(_, value)| value.into_owned())
}

fn activation_route(args: Vec<String>) -> Option<String> {
    args.into_iter()
        .take(32)
        .filter(|argument| argument.len() <= 4096)
        .filter_map(|argument| deep_link_route(&argument))
        .next_back()
}

pub fn activate(app: &tauri::AppHandle, args: Vec<String>, source: &str) {
    let Some(state) = app.try_state::<SystemState>() else {
        if let Some(inbox) = app.try_state::<ActivationInbox>()
            && let Ok(mut queued) = inbox.0.lock()
            && queued.len() < MAX_ACTIVATIONS
        {
            queued.push((
                args.into_iter()
                    .take(32)
                    .map(|argument| argument.chars().take(4096).collect())
                    .collect(),
                source.into(),
            ));
        }
        return;
    };
    let Some(route) = activation_route(args) else {
        return;
    };
    let Some(id) = state.next_activation_id() else {
        log::warn!("Activation sequence is exhausted");
        return;
    };
    let activation = Activation {
        id,
        source: source.into(),
        route: Some(route),
    };
    if let Err(error) = state.record_activation(activation.clone()) {
        log::warn!("Cannot retain activation result: {error}");
    }
    let _ = app.emit_to("main", "app://activation", activation);
    desktop::request_show_main(app);
}

#[tauri::command]
#[specta::specta]
pub fn activation_snapshot(state: tauri::State<'_, SystemState>) -> NativeResult<Vec<Activation>> {
    state
        .activations
        .lock()
        .map(|v| v.clone())
        .map_err(|_| NativeError::new(ErrorCode::Internal, "Activation history unavailable"))
}
#[tauri::command]
#[specta::specta]
pub fn get_workspace(state: tauri::State<'_, SystemState>) -> NativeResult<Workspace> {
    state
        .workspace
        .lock()
        .map(|v| v.clone())
        .map_err(|_| NativeError::new(ErrorCode::Internal, "Workspace unavailable"))
}
#[tauri::command]
#[specta::specta]
pub async fn save_workspace_route(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    route: String,
) -> NativeResult<()> {
    let label = window.label().to_owned();
    blocking::run(move || app.state::<SystemState>().set_route(&label, &route)).await
}
#[tauri::command]
#[specta::specta]
pub async fn restore_workspace(app: tauri::AppHandle) -> NativeResult<()> {
    blocking::run(move || {
        let workspace = get_workspace(app.state())?;
        if workspace.secondary_open {
            desktop::open_secondary(&app)?;
        }
        for (label, route) in workspace.routes {
            let _ = app.emit_to(label, "app://workspace-route", route);
        }
        Ok(())
    })
    .await
}
#[tauri::command]
#[specta::specta]
pub fn activate_main(app: tauri::AppHandle) -> NativeResult<()> {
    desktop::request_show_main(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_accepts_only_current_local_routes_and_never_opens_file_arguments() {
        let scheme = &INTEGRATION.deep_link_scheme;
        assert_eq!(
            activation_route(vec![format!("{scheme}://open?route=/settings")]),
            Some("/settings".into())
        );
        for argument in [
            "selected.swbench",
            "file:///tmp/selected.swbench",
            "/tmp/selected.swbench",
            "https://example.com/",
            "--demo-worker",
        ] {
            assert!(activation_route(vec![argument.into()]).is_none());
        }
        for route in [
            "/database",
            "/workbench",
            "/network",
            "/components",
            "/updates",
            "/unknown-window/example/open",
        ] {
            assert!(!allowed_route(route));
            assert!(deep_link_route(&format!("{scheme}://open?route={route}")).is_none());
        }
    }

    #[test]
    fn activation_history_orders_by_receipt_and_keeps_only_twenty_results() {
        let directory = tempfile::tempdir().unwrap();
        let state = SystemState::open(directory.path().join("workspace.json"));
        let ids = (0..22)
            .map(|_| state.next_activation_id().unwrap())
            .collect::<Vec<_>>();
        for id in ids.into_iter().rev() {
            state
                .record_activation(Activation {
                    id,
                    source: "deep-link".into(),
                    route: Some("/settings".into()),
                })
                .unwrap();
        }
        let snapshot = state.activations.lock().unwrap();
        assert_eq!(snapshot.len(), MAX_ACTIVATIONS);
        assert_eq!(
            snapshot.iter().map(|value| value.id).collect::<Vec<_>>(),
            (3..=22).collect::<Vec<_>>()
        );
    }

    #[test]
    fn workspace_restores_only_known_labels_and_routes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        let state = SystemState::open(path.clone());
        state.set_route("secondary", "/").unwrap();
        assert!(state.set_route("main", "https://external.example").is_err());
        let reopened = SystemState::open(path);
        assert_eq!(reopened.workspace.lock().unwrap().routes["secondary"], "/");
        assert!(reopened.workspace.lock().unwrap().secondary_open);
    }

    #[test]
    fn failed_workspace_save_preserves_the_committed_snapshot_and_can_retry() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        let state = SystemState::open(path.clone());
        state.set_route("main", "/settings").unwrap();
        let committed = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        assert!(state.set_route("secondary", "/").is_err());
        {
            let workspace = state.workspace.lock().unwrap();
            assert_eq!(workspace.routes.len(), 1);
            assert_eq!(workspace.routes["main"], "/settings");
            assert!(!workspace.secondary_open);
        }

        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, committed).unwrap();
        state.set_route("secondary", "/").unwrap();
        let reopened = SystemState::open(path.clone());
        assert!(reopened.workspace.lock().unwrap().secondary_open);
        assert_eq!(reopened.workspace.lock().unwrap().routes["secondary"], "/");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        reopened.secondary_closed();
        assert!(reopened.workspace.lock().unwrap().secondary_open);
        std::fs::remove_dir(&path).unwrap();
        reopened.secondary_closed();
        assert!(!reopened.workspace.lock().unwrap().secondary_open);
        assert!(
            !SystemState::open(path)
                .workspace
                .lock()
                .unwrap()
                .secondary_open
        );
    }

    #[test]
    fn oversized_workspace_falls_back_without_replacing_the_original() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.json");
        let contents = serde_json::to_vec(&serde_json::json!({
            "routes": {"main": "/settings"},
            "secondaryOpen": true,
            "padding": "x".repeat(MAX_WORKSPACE_BYTES),
        }))
        .unwrap();
        std::fs::write(&path, &contents).unwrap();
        let state = SystemState::open(path.clone());
        let workspace = state.workspace.lock().unwrap();
        assert!(workspace.routes.is_empty());
        assert!(!workspace.secondary_open);
        assert_eq!(std::fs::read(path).unwrap(), contents);
    }

    #[test]
    fn branded_deep_links_only_accept_the_local_open_endpoint_and_known_routes() {
        let scheme = &INTEGRATION.deep_link_scheme;
        assert_eq!(
            deep_link_route(&format!("{scheme}://open?route=%2Fsettings")),
            Some("/settings".into()),
        );
        for value in [
            format!("{scheme}://open?route=https%3A%2F%2Fexample.com"),
            format!("{scheme}://open?route=/unknown"),
            format!("{scheme}://other?route=/settings"),
            format!("{scheme}://user:secret@open?route=/settings"),
            format!("{scheme}://open:1234?route=/settings"),
            format!("{scheme}://open/another?route=/settings"),
            format!("{scheme}://open?route=/settings#fragment"),
            "https://open?route=/settings".into(),
            "relative-document.json".into(),
        ] {
            assert!(deep_link_route(&value).is_none(), "accepted {value}");
        }
    }
}
