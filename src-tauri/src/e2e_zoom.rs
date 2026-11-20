//! 记录独立 Windows 验收桌面上的实际 WebView2 缩放变化。
use webview2_com::{
    Microsoft::Web::WebView2::Win32::ICoreWebView2Controller, ZoomFactorChangedEventHandler,
};

pub(crate) fn enabled() -> bool {
    std::env::var("STARTER_E2E_PHASE").as_deref() == Ok("terminal-automated")
        && std::env::var("SWB_E2E_WINDOWS_NATIVE_PICKERS").as_deref() == Ok("1")
}

pub(crate) fn observe(window: &tauri::Window, controller: ICoreWebView2Controller) {
    let Ok(hwnd) = window.hwnd() else { return };
    let handle = hwnd.0 as usize;
    let label = window.label().to_owned();
    let record = move |controller: &ICoreWebView2Controller| -> windows_core::Result<()> {
        let mut factor = 0.0;
        // WebView2 controller 及回调都使用窗口的 UI 线程。
        unsafe { controller.ZoomFactor(&mut factor)? };
        log::info!("e2e_webview_zoom window={label} handle={handle} factor={factor}");
        Ok(())
    };
    if let Err(error) = record(&controller) {
        log::warn!("Cannot read initial WebView2 zoom: {error}");
    }
    let handler = ZoomFactorChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(controller) = sender {
            record(&controller)?;
        }
        Ok(())
    }));
    // WebView2 持有观察回调，销毁 controller 时一并释放。
    if let Err(error) = unsafe { controller.add_ZoomFactorChanged(&handler, &mut 0) } {
        log::warn!("Cannot observe WebView2 zoom: {error}");
    }
}
