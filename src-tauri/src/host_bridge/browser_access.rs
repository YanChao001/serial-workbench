use super::DesktopHostBridge;
use serial_workbench_core::*;
use std::path::PathBuf;
use tauri::{Manager, path::BaseDirectory};

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum LocalBrowserAccess {
    Status {},
    Pair { mode: BrowserAccessMode },
    Revoke {},
}

impl DesktopHostBridge {
    pub(super) async fn apply_browser_access(
        &self,
        window: &str,
        generation: U64,
        params: BrowserAccessParams,
    ) -> HostResult<BrowserAccessState> {
        match self
            .control_request_at_generation(window, generation, RpcRequest::BrowserAccess(params))
            .await?
        {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::BrowserAccess(result) => Ok(result.browser_access),
                _ => Err(HostError::new(
                    "INTERNAL",
                    "Invalid browser access response",
                )),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_browser_access(
    window: tauri::WebviewWindow,
    generation: U64,
    intent: LocalBrowserAccess,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<BrowserAccessState> {
    state.bind_window(&window)?;
    let params = match intent {
        LocalBrowserAccess::Status {} => BrowserAccessParams::Status {},
        LocalBrowserAccess::Pair { mode } => {
            let assets = if tauri::is_dev() {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
            } else {
                window
                    .path()
                    .resolve("browser-workbench", BaseDirectory::Resource)
                    .map_err(|_| missing_assets())?
            };
            let assets_dir = assets
                .into_os_string()
                .into_string()
                .map_err(|_| missing_assets())?;
            BrowserAccessParams::Pair { assets_dir, mode }
        }
        LocalBrowserAccess::Revoke {} => BrowserAccessParams::Revoke {},
    };
    state
        .apply_browser_access(window.label(), generation, params)
        .await
}

fn missing_assets() -> HostError {
    HostError::new(
        "BROWSER_ASSETS_UNAVAILABLE",
        "Browser workbench assets are unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};

    #[tokio::test]
    async fn browser_access_uses_the_current_privileged_desktop_connection() {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let profile = directory.path().join("profile");
        let assets = directory.path().join("workbench");
        std::fs::create_dir(&assets).unwrap();
        std::fs::write(assets.join("index.html"), "<html><head></head></html>").unwrap();
        let mut server = HostServer::bind(&profile).await.unwrap();
        let host = Arc::new(Host::new(server.store(), server.auth()).await.unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let serve = tokio::spawn(async move {
            server
                .serve_until(host, async {
                    let _ = stopped.await;
                })
                .await
        });
        let bridge = DesktopHostBridge::new(profile);
        let attached = bridge.attach("main").await.unwrap();
        let generation = attached.generation;
        let status = BrowserAccessParams::Status {};
        let denied = bridge
            .request_for_generation(
                "main",
                generation,
                RpcRequest::BrowserAccess(status.clone()),
            )
            .await
            .unwrap_err();
        assert_eq!(denied.code, "PERMISSION_DENIED");
        let stale = bridge
            .apply_browser_access("main", generation.checked_next().unwrap(), status)
            .await
            .unwrap_err();
        assert_eq!(stale.code, "EPOCH_MISMATCH");
        let mode = BrowserAccessMode::Operate;
        let paired = bridge
            .apply_browser_access(
                "main",
                generation,
                BrowserAccessParams::Pair {
                    assets_dir: assets.into_os_string().into_string().unwrap(),
                    mode,
                },
            )
            .await
            .unwrap();
        let BrowserAccessState::Pairing {
            entry,
            mode: confirmed,
        } = paired
        else {
            panic!("Desktop did not receive a pairing entry");
        };
        assert_eq!(confirmed, mode);
        assert_eq!(
            bridge
                .apply_browser_access("main", generation, BrowserAccessParams::Status {})
                .await
                .unwrap(),
            BrowserAccessState::Enabled {
                url: entry.url,
                mode
            }
        );
        assert_eq!(
            bridge
                .apply_browser_access("main", generation, BrowserAccessParams::Revoke {})
                .await
                .unwrap(),
            BrowserAccessState::Disabled {}
        );
        assert_eq!(bridge.attach("main").await.unwrap().generation, generation);
        drop(bridge);
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(8), serve)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
