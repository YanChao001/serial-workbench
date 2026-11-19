//! 原生插件视图使用独立 Wry renderer，系统窗口只负责生命周期。
mod host;
mod protocol;
#[cfg(test)]
pub(crate) mod test_support;

use crate::host_bridge::DesktopHostBridge;
use host::{ViewHost, ViewStream};
use serial_workbench_core::{HostError, HostResult, Id, U64};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{Arc, LazyLock, atomic::AtomicBool},
};
use tauri::{Manager, WebviewWindow};
use tokio::sync::{Mutex, Semaphore, watch};

static VIEWS_LIMIT: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(4)));
thread_local! {
    static VIEWS: RefCell<BTreeMap<String, NativeView>> = const { RefCell::new(BTreeMap::new()) };
}

struct NativeView {
    _renderer: wry::WebView,
    window: tauri::Window,
    context: Arc<ViewContext>,
    owner: ViewOwner,
}

struct PendingView {
    window: Option<tauri::Window>,
}

impl PendingView {
    fn show(&self) -> HostResult<()> {
        let window = self.window.as_ref().expect("pending window");
        window.show().map_err(|_| unavailable())?;
        #[cfg(feature = "e2e")]
        trace_terminal_view(window.label(), "shown", 0, 0, None);
        Ok(())
    }

    fn commit(mut self) {
        drop(self.window.take());
    }
}

impl Drop for PendingView {
    fn drop(&mut self) {
        if let Some(window) = &self.window {
            let _ = window.destroy();
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct ViewOwner {
    label: String,
    instance: u64,
}

impl ViewOwner {
    fn require_current(
        &self,
        bridge: &DesktopHostBridge,
        window: &WebviewWindow,
    ) -> HostResult<()> {
        if bridge.bind_window(window)? != self.instance {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "View owner document changed",
            ));
        }
        Ok(())
    }
}

struct ViewContext {
    _permit: tokio::sync::OwnedSemaphorePermit,
    host: ViewHost,
    reader: Mutex<Option<ViewStream>>,
    stopped: watch::Sender<bool>,
    assets: Semaphore,
    snapshot_pending: AtomicBool,
    shell_token: String,
    frame_id: String,
    locale: String,
    dark: bool,
}

fn unavailable() -> HostError {
    HostError::new(
        "PLATFORM_UNAVAILABLE",
        "Cannot create isolated plugin renderer",
    )
}

#[cfg(feature = "e2e")]
fn trace_terminal_view(
    label: &str,
    event: &str,
    position: u64,
    rx_bytes: usize,
    digest: Option<&str>,
) {
    if matches!(
        std::env::var("STARTER_E2E_PHASE").as_deref(),
        Ok("terminal-automated")
    ) {
        let digest = digest.unwrap_or("-");
        log::info!(
            "e2e_terminal view={label} event={event} position={position} rx_bytes={rx_bytes} digest={digest}"
        );
    }
}

impl ViewContext {
    fn stop(&self) {
        self.stopped.send_replace(true);
        if let Ok(mut reader) = self.reader.try_lock() {
            reader.take();
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_open_node_view(
    window: WebviewWindow,
    generation: U64,
    operation_id: Id,
    view_id: Id,
    locale: String,
    dark: bool,
    bridge: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<Id> {
    let owner = ViewOwner {
        label: window.label().to_owned(),
        instance: bridge.bind_window(&window)?,
    };
    let permit = VIEWS_LIMIT
        .clone()
        .try_acquire_owned()
        .map_err(|_| HostError::new("HOST_BUSY", "Too many plugin views are open"))?;
    let host = ViewHost::attach(
        bridge.inner().clone(),
        owner.label.clone(),
        generation,
        operation_id,
        view_id,
    )
    .await?;
    let reader = host.open_stream().await?;
    let frame_id = token();
    #[cfg(feature = "e2e")]
    let reader = reader.with_e2e_label(format!("node-view-{frame_id}"));
    let context = Arc::new(ViewContext {
        _permit: permit,
        host,
        reader: Mutex::new(Some(reader)),
        stopped: watch::channel(false).0,
        assets: Semaphore::new(4),
        snapshot_pending: AtomicBool::new(true),
        shell_token: token(),
        frame_id,
        locale: if locale == "zh" { "zh-CN" } else { "en" }.into(),
        dark,
    });
    let label = Id::try_from(format!("node-view-{}", context.frame_id).as_str())?;
    let id = label.clone();
    let app = window.app_handle().clone();
    let handle = app.clone();
    let bridge = bridge.inner().clone();
    let owned_window = window.clone();
    let owned_bridge = bridge.clone();
    let view_owner = owner.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        if !send.is_closed() {
            let result = view_owner
                .require_current(&owned_bridge, &owned_window)
                .and_then(|()| prepare_view(&handle, &id, &view_owner, context));
            let _ = send.send(result);
        }
    })
    .map_err(|_| unavailable())?;
    let view = receive.await.map_err(|_| unavailable())??;

    // Keep the connection current through the show call. Renderer setup has finished.
    let current = bridge
        .lock_current_generation(&owner.label, generation)
        .await?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        if send.is_closed() {
            drop(current);
            return;
        }
        let result = owner
            .require_current(&bridge, &window)
            .and_then(|()| view.show());
        drop(current);
        let _ = send.send(result.map(|()| view));
    })
    .map_err(|_| unavailable())?;
    receive.await.map_err(|_| unavailable())??.commit();
    Ok(label)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_close_node_view(
    window: WebviewWindow,
    id: Id,
    bridge: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<()> {
    let owner = ViewOwner {
        label: window.label().to_owned(),
        instance: bridge.bind_window(&window)?,
    };
    window
        .app_handle()
        .run_on_main_thread(move || close_view(id.as_str(), &owner))
        .map_err(|_| unavailable())
}

fn token() -> String {
    serial_workbench_ipc::identity::random_token()
        .as_str()
        .to_owned()
}

fn close_view(label: &str, owner: &ViewOwner) {
    let window = VIEWS.with_borrow(|views| {
        views
            .get(label)
            .filter(|view| view.owner == *owner)
            .map(|view| view.window.clone())
    });
    if let Some(window) = window {
        let _ = window.close();
    }
}

fn prepare_view(
    app: &tauri::AppHandle,
    id: &Id,
    owner: &ViewOwner,
    context: Arc<ViewContext>,
) -> HostResult<PendingView> {
    let window = tauri::window::WindowBuilder::new(app, id.as_str())
        .visible(false)
        .title(context.host.entry.package_id.as_str())
        .inner_size(780.0, 440.0)
        .build()
        .map_err(|error| {
            log::warn!("Cannot create plugin window: {error}");
            unavailable()
        })?;
    let url = context.shell_url().to_string();
    let shell = context.clone();
    let package = context.clone();
    let renderer = wry::WebViewBuilder::new()
        .with_incognito(true)
        .with_url(url.clone())
        .with_asynchronous_custom_protocol(protocol::SHELL.into(), move |_, request, responder| {
            shell.clone().respond_shell(request, responder)
        })
        .with_asynchronous_custom_protocol(protocol::ASSET.into(), move |_, request, responder| {
            package.clone().respond_asset(request, responder)
        })
        .with_navigation_handler(move |destination| {
            destination == url || (!cfg!(windows) && protocol::is_asset_url(&destination))
        })
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_download_started_handler(|_, _| false);
    #[cfg(target_os = "linux")]
    let renderer = {
        use wry::WebViewBuilderExtUnix;
        window
            .default_vbox()
            .map_err(|_| unavailable())
            .and_then(|container| {
                renderer.build_gtk(&container).map_err(|error| {
                    log::warn!("Cannot build plugin renderer: {error}");
                    unavailable()
                })
            })
    };
    #[cfg(not(target_os = "linux"))]
    let renderer = renderer.build(&window).map_err(|error| {
        log::warn!("Cannot build plugin renderer: {error}");
        unavailable()
    });
    #[cfg(windows)]
    let renderer = renderer.and_then(|renderer| {
        guard_frame_navigation(&renderer)?;
        Ok(renderer)
    });
    let renderer = match renderer {
        Ok(renderer) => renderer,
        Err(error) => {
            context.stop();
            let _ = window.destroy();
            return Err(error);
        }
    };
    let label = id.as_str().to_owned();
    let stop = context.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            stop.stop();
            VIEWS.with_borrow_mut(|views| views.remove(&label));
            #[cfg(feature = "e2e")]
            trace_terminal_view(&label, "closed", 0, 0, None);
        }
    });
    VIEWS.with_borrow_mut(|views| {
        views.insert(
            id.as_str().into(),
            NativeView {
                _renderer: renderer,
                window: window.clone(),
                context,
                owner: owner.clone(),
            },
        )
    });
    Ok(PendingView {
        window: Some(window),
    })
}

#[cfg(windows)]
fn guard_frame_navigation(renderer: &wry::WebView) -> HostResult<()> {
    use webview2_com::{NavigationStartingEventHandler, take_pwstr};
    use windows_core::PWSTR;
    use wry::WebViewExtWindows;

    let handler = NavigationStartingEventHandler::create(Box::new(|_, args| {
        if let Some(args) = args {
            let mut uri = PWSTR::null();
            // WebView2 在 UI 线程回调并分配 Uri，take_pwstr 释放其 COM 缓冲区。
            unsafe {
                args.Uri(&mut uri)?;
                args.SetCancel(!protocol::is_asset_url(&take_pwstr(uri)))?;
            }
        }
        Ok(())
    }));
    // WebView2 持有处理器，销毁这个独立 renderer 时一并释放。
    unsafe {
        renderer
            .webview()
            .add_FrameNavigationStarting(&handler, &mut 0)
    }
    .map_err(|error| {
        log::warn!("Cannot guard plugin frame navigation: {error}");
        unavailable()
    })
}

pub(crate) fn close_owned_views(owner: &str, instance: Option<u64>) {
    let windows = VIEWS.with_borrow(|views| {
        views
            .values()
            .filter(|view| {
                view.owner.label == owner && instance.is_none_or(|id| id == view.owner.instance)
            })
            .map(|view| {
                view.context.stop();
                view.window.clone()
            })
            .collect::<Vec<_>>()
    });
    for window in windows {
        let _ = window.destroy();
    }
}
