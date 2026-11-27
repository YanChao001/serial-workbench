use crate::{
    client_state::ShortcutBinding,
    error::{ErrorCode, NativeError, NativeResult},
};
use tauri::{AppHandle, WebviewWindow, ipc::Channel};

#[cfg(target_os = "linux")]
mod portal;

#[derive(serde::Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GlobalSendEvent {
    Press {
        revision: u32,
    },
    // 保持各构建目标生成相同的 IPC 契约，绑定变化只来自 Wayland 门户。
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Binding {
        trigger: Option<String>,
    },
}

#[derive(Default, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSendBinding {
    trigger: Option<String>,
    can_configure: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn configure_global_send(
    window: WebviewWindow,
    binding: Option<ShortcutBinding>,
    registration: String,
    description: String,
    events: Channel<GlobalSendEvent>,
) -> NativeResult<GlobalSendBinding> {
    #[cfg(desktop)]
    return desktop::configure(window, binding, registration, description, events).await;
    #[cfg(not(desktop))]
    {
        let _ = (window, binding, registration, description, events);
        Err(unavailable())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn open_global_send_settings(
    window: WebviewWindow,
    registration: String,
) -> NativeResult<()> {
    #[cfg(all(desktop, target_os = "linux"))]
    return desktop::open_portal_settings(window, registration).await;
    #[cfg(not(all(desktop, target_os = "linux")))]
    {
        let _ = (window, registration);
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
    #[cfg(target_os = "linux")]
    use tokio::sync::oneshot;

    thread_local! {
        // 注册、注销和销毁都归运行桌面事件循环的线程。
        static NATIVE: OnceCell<GlobalHotKeyManager> = const { OnceCell::new() };
    }

    #[derive(Default)]
    struct Dispatch {
        documents: [u64; 2],
        active: Option<Registration>,
        #[cfg(target_os = "linux")]
        pending_portal: Option<PendingPortal>,
    }

    #[cfg(target_os = "linux")]
    struct PendingPortal {
        owner: usize,
        id: String,
        cancel: Option<oneshot::Sender<()>>,
    }

    enum Backend {
        Native(HotKey),
        #[cfg(target_os = "linux")]
        Portal(PortalRegistration),
    }

    impl Backend {
        fn native_key(&self) -> Option<HotKey> {
            match self {
                Self::Native(key) => Some(*key),
                #[cfg(target_os = "linux")]
                Self::Portal(_) => None,
            }
        }
    }

    #[cfg(target_os = "linux")]
    struct PortalRegistration {
        stop: oneshot::Sender<()>,
        disconnected: oneshot::Receiver<()>,
        settings: Option<super::portal::Settings>,
    }

    struct Registration {
        owner: usize,
        document: u64,
        id: String,
        backend: Backend,
        events: Channel<GlobalSendEvent>,
        revision: u32,
        bound: bool,
        enabled: bool,
        pressed: bool,
    }

    const WINDOWS: [&str; 2] = ["main", "secondary"];

    fn window_index(label: &str) -> Option<usize> {
        WINDOWS.iter().position(|candidate| *candidate == label)
    }

    #[cfg(target_os = "linux")]
    fn uses_portal() -> bool {
        std::env::var_os("WAYLAND_DISPLAY").is_some_and(|display| !display.is_empty())
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|session| session == "wayland")
    }

    pub fn setup(app: &AppHandle) {
        app.manage(Mutex::new(Dispatch::default()));
        // Wayland 使用会话级 portal，XWayland 中成功注册也不能证明系统级可达。
        #[cfg(target_os = "linux")]
        if uses_portal() {
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
        description: String,
        events: Channel<GlobalSendEvent>,
    ) -> NativeResult<GlobalSendBinding> {
        let owner = window_index(window.label()).ok_or_else(unavailable)?;
        crate::error::bounded_text(&id, 64, "Global send registration")?;
        crate::error::bounded_text(&description, 192, "Global send description")?;
        let key = binding.as_ref().map(parse_key).transpose()?;
        let app = window.app_handle().clone();
        let document = app.state::<Mutex<Dispatch>>().lock().unwrap().documents[owner];
        #[cfg(target_os = "linux")]
        if uses_portal() {
            return configure_portal(app, owner, document, id, binding, description, events).await;
        }
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
                        events,
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
        result
            .await
            .map_err(|_| unavailable())?
            .map(|()| GlobalSendBinding::default())
    }

    fn configure_on_main(
        native: &GlobalHotKeyManager,
        app: &AppHandle,
        owner: usize,
        document: u64,
        key: Option<HotKey>,
        id: String,
        events: Channel<GlobalSendEvent>,
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
                active => active
                    .as_ref()
                    .and_then(|active| active.backend.native_key()),
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
            backend: Backend::Native(key),
            events,
            revision: 0,
            bound: true,
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
            active.enabled = enabled && active.bound;
            #[cfg(feature = "e2e")]
            log::debug!(
                "E2E global send target: window={} revision={revision} enabled={}",
                window.label(),
                active.enabled
            );
        }
    }

    fn handle_event(app: &AppHandle, event: GlobalHotKeyEvent) {
        dispatch_press(app, event.state == HotKeyState::Pressed, |active| {
            active
                .backend
                .native_key()
                .is_some_and(|key| key.id() == event.id)
        });
    }

    fn dispatch_press(app: &AppHandle, pressed: bool, matches: impl FnOnce(&Registration) -> bool) {
        let (owner, revision, id) = {
            let state = app.state::<Mutex<Dispatch>>();
            let mut dispatch = state.lock().unwrap();
            #[cfg(target_os = "linux")]
            let updating = dispatch.pending_portal.is_some();
            #[cfg(not(target_os = "linux"))]
            let updating = false;
            let documents = dispatch.documents;
            let Some(active) = dispatch.active.as_mut() else {
                return;
            };
            if !matches(active) || active.document != documents[active.owner] {
                return;
            }
            // Windows 已用 MOD_NOREPEAT 过滤长按，释放通知可能晚于下一次物理按键。
            let first_press = pressed && (cfg!(windows) || !active.pressed);
            active.pressed = pressed;
            #[cfg(feature = "e2e")]
            log::debug!(
                "E2E global send input: window={} pressed={pressed} first={first_press} revision={} enabled={}",
                WINDOWS[active.owner],
                active.revision,
                active.enabled
            );
            if !first_press || !active.enabled || updating {
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
            #[cfg(target_os = "linux")]
            if dispatch.pending_portal.is_some() {
                return;
            }
            if let Some(active) = &dispatch.active
                && active.id == id
                && active.owner == owner
                && active.document == dispatch.documents[owner]
                && active.revision == revision
                && active.enabled
            {
                let _ = active.events.send(GlobalSendEvent::Press { revision });
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
            #[cfg(target_os = "linux")]
            if let Some(pending) = dispatch
                .pending_portal
                .as_mut()
                .filter(|pending| pending.owner == owner)
            {
                // 通知登记任务撤回系统请求。占用保留到它完成清理。
                #[cfg(feature = "e2e")]
                log::debug!("Withdrawing the pending global send request for {label}");
                drop(pending.cancel.take());
            }
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
        // 门户注册的停止发送端随这里取出的会话一起释放。
        let Some(key) = removed.and_then(|registration| registration.backend.native_key()) else {
            return;
        };
        let _ = app.run_on_main_thread(move || {
            NATIVE.with(|manager| {
                if let Some(native) = manager.get()
                    && let Err(error) = native.unregister(key)
                {
                    log::warn!("Cannot release the global send shortcut: {error}");
                }
            });
        });
    }

    #[cfg(target_os = "linux")]
    async fn configure_portal(
        app: AppHandle,
        owner: usize,
        document: u64,
        id: String,
        binding: Option<ShortcutBinding>,
        description: String,
        events: Channel<GlobalSendEvent>,
    ) -> NativeResult<GlobalSendBinding> {
        use super::portal::Portal;
        let state = app.state::<Mutex<Dispatch>>();
        let (cancel, mut cancelled) = oneshot::channel();
        let removed = {
            let mut dispatch = state.lock().unwrap();
            if dispatch.documents[owner] != document {
                return Err(portal_cancelled());
            }
            if let Some(active) = dispatch
                .active
                .as_ref()
                .filter(|active| active.bound || binding.is_none())
            {
                if active.owner != owner {
                    return Err(NativeError::new(
                        ErrorCode::Conflict,
                        "Another workbench window owns the global send shortcut",
                    ));
                }
                if binding.is_some() {
                    return Err(NativeError::new(
                        ErrorCode::Conflict,
                        "Change the active Wayland shortcut in the desktop's shortcut settings",
                    ));
                }
            }
            if dispatch.pending_portal.is_some() {
                return Err(NativeError::new(
                    ErrorCode::NativeBusy,
                    "A portal request is pending",
                ));
            }
            // 认领窗口文档直到系统请求结算，包括停用工作。
            dispatch.pending_portal = Some(PendingPortal {
                owner,
                id: id.clone(),
                cancel: Some(cancel),
            });
            dispatch.active.take()
        };
        let result = async {
            close_portal(removed).await;
            let Some(binding) = binding else {
                return Ok(GlobalSendBinding::default());
            };
            let mut portal = tokio::select! {
                biased;
                _ = &mut cancelled => return Err(portal_cancelled()),
                result = Portal::connect(app.config().product_name.as_deref()) => result?,
            };
            let bound = tokio::select! {
                biased;
                _ = &mut cancelled => Err(portal_cancelled()),
                result = async {
                    let session = portal.create_session().await?;
                    let trigger = portal.bind(&session, &binding, &description).await?;
                    Ok((session, trigger))
                } => result,
            };
            let (session, trigger) = match bound {
                Ok(binding) => binding,
                Err(error) => {
                    portal.disconnect().await;
                    return Err(error);
                }
            };
            let (stop, stopped) = oneshot::channel();
            let (released, disconnected) = oneshot::channel();
            let settings = portal.settings(&session);
            let can_configure = settings.is_some();
            let registered = {
                let mut dispatch = state.lock().unwrap();
                let current = dispatch.documents[owner] == document;
                if current {
                    dispatch.active = Some(Registration {
                        owner,
                        document,
                        id: id.clone(),
                        backend: Backend::Portal(PortalRegistration {
                            stop,
                            disconnected,
                            settings,
                        }),
                        events,
                        revision: 0,
                        bound: true,
                        enabled: false,
                        pressed: false,
                    });
                }
                current
            };
            if !registered {
                portal.disconnect().await;
                return Err(portal_cancelled());
            }
            let handle = app.clone();
            let registration = id.clone();
            let initial_trigger = trigger.clone();
            tauri::async_runtime::spawn(async move {
                watch_portal(
                    handle,
                    registration,
                    portal,
                    session,
                    stopped,
                    initial_trigger,
                )
                .await;
                let _ = released.send(());
            });
            Ok(GlobalSendBinding {
                trigger: Some(trigger),
                can_configure,
            })
        }
        .await;
        let mut dispatch = state.lock().unwrap();
        if dispatch
            .pending_portal
            .as_ref()
            .is_some_and(|pending| pending.owner == owner && pending.id == id)
        {
            dispatch.pending_portal.take();
        }
        result
    }

    #[cfg(target_os = "linux")]
    pub async fn open_portal_settings(window: WebviewWindow, id: String) -> NativeResult<()> {
        let owner = window_index(window.label()).ok_or_else(unavailable)?;
        let settings = {
            let state = window.state::<Mutex<Dispatch>>();
            let dispatch = state.lock().unwrap();
            let active = dispatch
                .active
                .as_ref()
                .filter(|active| {
                    active.bound
                        && active.owner == owner
                        && active.document == dispatch.documents[owner]
                        && active.id == id
                })
                .ok_or_else(portal_cancelled)?;
            match &active.backend {
                Backend::Portal(registration) => registration.settings.clone(),
                Backend::Native(_) => None,
            }
        };
        settings.ok_or_else(unavailable)?.open().await
    }

    #[cfg(target_os = "linux")]
    fn portal_cancelled() -> NativeError {
        NativeError::new(
            ErrorCode::UserCancelled,
            "The global shortcut request is no longer current",
        )
    }

    #[cfg(target_os = "linux")]
    async fn close_portal(registration: Option<Registration>) {
        if let Some(Backend::Portal(PortalRegistration {
            stop, disconnected, ..
        })) = registration.map(|active| active.backend)
        {
            drop(stop);
            let _ = disconnected.await;
        }
    }

    #[cfg(target_os = "linux")]
    async fn watch_portal(
        app: AppHandle,
        id: String,
        mut portal: super::portal::Portal,
        session: zbus::zvariant::OwnedObjectPath,
        mut stopped: oneshot::Receiver<()>,
        initial_trigger: String,
    ) {
        use super::portal::Signal;
        let mut current_trigger = Some(initial_trigger);
        loop {
            tokio::select! {
                biased;
                _ = &mut stopped => break,
                result = portal.next(&session) => match result {
                    Signal::Pressed(pressed) => dispatch_press(&app, pressed, |active| active.id == id),
                    Signal::Binding(trigger) => {
                        if trigger == current_trigger {
                            continue;
                        }
                        current_trigger = trigger.clone();
                        let state = app.state::<Mutex<Dispatch>>();
                        let mut dispatch = state.lock().unwrap();
                        if let Some(active) = dispatch.active.as_mut().filter(|active| active.id == id) {
                            active.bound = trigger.is_some();
                            active.pressed = false;
                            active.enabled = false;
                            let _ = active.events.send(GlobalSendEvent::Binding { trigger });
                        }
                    }
                    Signal::Closed => {
                        let state = app.state::<Mutex<Dispatch>>();
                        let mut dispatch = state.lock().unwrap();
                        if dispatch.active.as_ref().is_some_and(|active| active.id == id)
                            && let Some(active) = dispatch.active.take()
                        {
                            let _ = active.events.send(GlobalSendEvent::Binding { trigger: None });
                        }
                        break;
                    }
                },
            }
        }
        portal.disconnect().await;
    }
}
