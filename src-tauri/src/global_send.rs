use crate::{
    client_state::ShortcutBinding,
    error::{ErrorCode, NativeError, NativeResult},
};
use tauri::{AppHandle, WebviewWindow, ipc::Channel};

#[tauri::command]
#[specta::specta]
pub async fn configure_global_send(
    window: WebviewWindow,
    binding: Option<ShortcutBinding>,
    registration: String,
    on_press: Channel<u32>,
) -> NativeResult<()> {
    #[cfg(desktop)]
    return desktop::configure(window, binding, registration, on_press).await;
    #[cfg(not(desktop))]
    {
        let _ = (window, binding, registration, on_press);
        Err(unavailable())
    }
}

#[tauri::command]
#[specta::specta]
pub fn set_global_send_target(
    window: WebviewWindow,
    registration: String,
    revision: u32,
    enabled: bool,
) {
    #[cfg(desktop)]
    desktop::set_target(window, registration, revision, enabled);
    #[cfg(not(desktop))]
    let _ = (window, registration, revision, enabled);
}

fn unavailable() -> NativeError {
    NativeError::new(
        ErrorCode::PlatformUnavailable,
        "Global send shortcuts are unavailable in this desktop session",
    )
}

pub fn setup(app: &AppHandle) {
    #[cfg(desktop)]
    desktop::setup(app);
    #[cfg(not(desktop))]
    let _ = app;
}

pub fn reset_window(app: &AppHandle, label: &str) {
    #[cfg(desktop)]
    desktop::reset_window(app, label);
    #[cfg(not(desktop))]
    let _ = (app, label);
}

#[cfg(desktop)]
mod desktop {
    use super::*;
    use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState, hotkey::HotKey};
    use std::{cell::OnceCell, sync::Mutex};
    use tauri::Manager;

    thread_local! {
        // 注册、注销和销毁都归运行桌面事件循环的线程。
        static NATIVE: OnceCell<GlobalHotKeyManager> = const { OnceCell::new() };
    }

    #[derive(Default)]
    struct Dispatch {
        documents: [u64; 2],
        active: Option<Registration>,
    }

    struct Registration {
        owner: usize,
        document: u64,
        id: String,
        key: HotKey,
        on_press: Channel<u32>,
        revision: u32,
        enabled: bool,
        pressed: bool,
    }

    const WINDOWS: [&str; 2] = ["main", "secondary"];

    fn window_index(label: &str) -> Option<usize> {
        WINDOWS.iter().position(|candidate| *candidate == label)
    }

    pub fn setup(app: &AppHandle) {
        app.manage(Mutex::new(Dispatch::default()));
        // Wayland 使用会话级 portal，XWayland 中成功注册也不能证明系统级可达。
        #[cfg(target_os = "linux")]
        if std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session == "wayland")
        {
            return;
        }
        match GlobalHotKeyManager::new() {
            Ok(native) => {
                NATIVE.with(|manager| {
                    let _ = manager.set(native);
                });
                let handle = app.clone();
                GlobalHotKeyEvent::set_event_handler(Some(move |event| {
                    handle_event(&handle, event)
                }));
            }
            Err(error) => log::warn!("Global send shortcuts unavailable: {error}"),
        }
    }

    pub async fn configure(
        window: WebviewWindow,
        binding: Option<ShortcutBinding>,
        id: String,
        on_press: Channel<u32>,
    ) -> NativeResult<()> {
        let owner = window_index(window.label()).ok_or_else(unavailable)?;
        crate::error::bounded_text(&id, 64, "Global send registration")?;
        let key = binding.as_ref().map(parse_key).transpose()?;
        let app = window.app_handle().clone();
        let document = app.state::<Mutex<Dispatch>>().lock().unwrap().documents[owner];
        let (resolve, result) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let outcome = NATIVE.with(|manager| {
                    configure_on_main(
                        manager.get().ok_or_else(unavailable)?,
                        &app,
                        owner,
                        document,
                        key,
                        id,
                        on_press,
                    )
                });
                let _ = resolve.send(outcome);
            })
            .map_err(|error| {
                NativeError::operation(
                    ErrorCode::WindowError,
                    "Cannot update global send shortcut",
                    error,
                )
            })?;
        result.await.map_err(|_| unavailable())?
    }

    fn configure_on_main(
        native: &GlobalHotKeyManager,
        app: &AppHandle,
        owner: usize,
        document: u64,
        key: Option<HotKey>,
        id: String,
        on_press: Channel<u32>,
    ) -> NativeResult<()> {
        let state = app.state::<Mutex<Dispatch>>();
        let previous = {
            let dispatch = state.lock().unwrap();
            if dispatch.documents[owner] != document {
                return Err(NativeError::new(
                    ErrorCode::UserCancelled,
                    "Window was reloaded",
                ));
            }
            match &dispatch.active {
                Some(active) if active.owner != owner => {
                    return Err(NativeError::new(
                        ErrorCode::Conflict,
                        "Another workbench window owns the global send shortcut",
                    ));
                }
                active => active.as_ref().map(|active| active.key),
            }
        };
        // 先试新键位。系统拒绝时原生键位和前端显示仍指向旧注册。
        if let Some(key) = key.filter(|key| Some(*key) != previous) {
            native.register(key).map_err(|error| {
                let code = if matches!(error, global_hotkey::Error::AlreadyRegistered(_)) {
                    ErrorCode::Conflict
                } else {
                    ErrorCode::WindowError
                };
                NativeError::operation(code, "Cannot register global send shortcut", error)
            })?;
        }
        if let Some(old) = previous.filter(|old| Some(*old) != key)
            && let Err(error) = native.unregister(old)
        {
            if let Some(key) = key
                && let Err(rollback) = native.unregister(key)
            {
                log::warn!("Cannot release the rejected global send shortcut: {rollback}");
            }
            return Err(NativeError::operation(
                ErrorCode::WindowError,
                "Cannot release global send shortcut",
                error,
            ));
        }
        state.lock().unwrap().active = key.map(|key| Registration {
            owner,
            document,
            id,
            key,
            on_press,
            revision: 0,
            enabled: false,
            pressed: false,
        });
        Ok(())
    }

    fn parse_key(binding: &ShortcutBinding) -> NativeResult<HotKey> {
        let invalid =
            || NativeError::new(ErrorCode::InvalidArgument, "Invalid global send shortcut");
        if !binding.is_valid()
            || (binding.key == "Enter" && binding.primary && !binding.alt && !binding.shift)
        {
            return Err(invalid());
        }
        let key = format!(
            "{}{}{}{}",
            if binding.primary {
                "CommandOrControl+"
            } else {
                ""
            },
            if binding.alt { "Alt+" } else { "" },
            if binding.shift { "Shift+" } else { "" },
            binding.key,
        );
        key.parse().map_err(|_| invalid())
    }

    pub fn set_target(window: WebviewWindow, id: String, revision: u32, enabled: bool) {
        let Some(owner) = window_index(window.label()) else {
            return;
        };
        let state = window.state::<Mutex<Dispatch>>();
        let mut dispatch = state.lock().unwrap();
        let document = dispatch.documents[owner];
        if let Some(active) = &mut dispatch.active
            && active.owner == owner
            && active.document == document
            && active.id == id
            && active.revision < revision
        {
            active.revision = revision;
            active.enabled = enabled;
        }
    }

    fn handle_event(app: &AppHandle, event: GlobalHotKeyEvent) {
        let (owner, revision, id) = {
            let state = app.state::<Mutex<Dispatch>>();
            let mut dispatch = state.lock().unwrap();
            let documents = dispatch.documents;
            let Some(active) = dispatch.active.as_mut() else {
                return;
            };
            if active.key.id() != event.id || active.document != documents[active.owner] {
                return;
            }
            let pressed = event.state == HotKeyState::Pressed;
            // Windows 已用 MOD_NOREPEAT 过滤长按，释放通知可能晚于下一次物理按键。
            let first_press = pressed && (cfg!(windows) || !active.pressed);
            active.pressed = pressed;
            if !first_press || !active.enabled {
                return;
            }
            (active.owner, active.revision, active.id.clone())
        };
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let label = WINDOWS[owner];
            if !handle
                .get_window(label)
                .is_some_and(|window| window.is_visible().unwrap_or(false))
                || handle
                    .windows()
                    .values()
                    .any(|window| window.label() != label && window.is_focused().unwrap_or(false))
            {
                return;
            }
            let state = handle.state::<Mutex<Dispatch>>();
            let dispatch = state.lock().unwrap();
            if let Some(active) = &dispatch.active
                && active.id == id
                && active.owner == owner
                && active.document == dispatch.documents[owner]
                && active.revision == revision
                && active.enabled
            {
                let _ = active.on_press.send(revision);
            }
        });
    }

    pub fn reset_window(app: &AppHandle, label: &str) {
        let Some(owner) = window_index(label) else {
            return;
        };
        let Some(state) = app.try_state::<Mutex<Dispatch>>() else {
            return;
        };
        let removed = {
            let mut dispatch = state.lock().unwrap();
            dispatch.documents[owner] += 1;
            if dispatch
                .active
                .as_ref()
                .is_some_and(|active| active.owner == owner)
            {
                dispatch.active.take()
            } else {
                None
            }
        };
        let Some(removed) = removed else { return };
        let _ = app.run_on_main_thread(move || {
            NATIVE.with(|manager| {
                if let Some(native) = manager.get()
                    && let Err(error) = native.unregister(removed.key)
                {
                    log::warn!("Cannot release the global send shortcut: {error}");
                }
            });
        });
    }
}
