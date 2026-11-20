use super::ViewContext;
use serial_workbench_core::NodePackagePath;
use std::sync::{Arc, atomic::Ordering};
use url::Url;
use wry::{
    RequestAsyncResponder,
    http::{Method, Request, Response, StatusCode},
};

pub(super) const SHELL: &str = "swbviewshell";
pub(super) const ASSET: &str = "swbviewasset";
const SHELL_JS: &str = include_str!("shell.js");
const SHELL_CSS: &str = "body{margin:0;height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr);background:Canvas;color:CanvasText;font:14px system-ui}p{margin:0;padding:8px 12px}[hidden]{display:none}iframe{grid-row:2;border:0;width:100%;height:100%;background:Canvas}";

fn origin(scheme: &str) -> Url {
    let text = if cfg!(windows) {
        format!("http://{scheme}.localhost/")
    } else {
        format!("{scheme}://localhost/")
    };
    Url::parse(&text).expect("static protocol origin")
}

fn sources(scheme: &str) -> String {
    format!("{scheme}: http://{scheme}.localhost")
}

pub(super) fn is_asset_url(destination: &str) -> bool {
    let Ok(url) = Url::parse(destination) else {
        return false;
    };
    if url.scheme() == ASSET {
        return url.host_str() == Some("localhost");
    }
    url.scheme() == "http"
        && url.host_str() == Some("swbviewasset.localhost")
        && url.port().is_none()
}

fn response(status: StatusCode, mime: &str, csp: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("content-security-policy", csp)
        .header("referrer-policy", "no-referrer")
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .body(body)
        .expect("static protocol headers")
}

fn rejected() -> Response<Vec<u8>> {
    response(
        StatusCode::NOT_FOUND,
        "text/plain",
        "default-src 'none'",
        Vec::new(),
    )
}

fn mime(path: &NodePackagePath) -> Option<&'static str> {
    Some(
        match path
            .as_str()
            .rsplit_once('.')?
            .1
            .to_ascii_lowercase()
            .as_str()
        {
            "html" | "htm" => "text/html; charset=utf-8",
            "js" | "mjs" => "application/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "png" => "image/png",
            "jpeg" | "jpg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => return None,
        },
    )
}

impl ViewContext {
    pub(super) fn shell_url(&self) -> Url {
        let mut url = origin(SHELL);
        url.set_path(&format!("/{}/index.html", self.shell_token));
        url
    }

    fn shell_csp() -> String {
        let shell = sources(SHELL);
        let assets = sources(ASSET);
        format!(
            "default-src 'none'; script-src {shell}; style-src {shell}; frame-src {assets}; object-src 'none'; base-uri 'none'; form-action 'none'"
        )
    }

    pub(super) fn respond_shell(
        self: Arc<Self>,
        request: Request<Vec<u8>>,
        responder: RequestAsyncResponder,
    ) {
        let prefix = format!("/{}/", self.shell_token);
        if request.method() != Method::GET || *self.stopped.borrow() {
            responder.respond(rejected());
            return;
        }
        let csp = Self::shell_csp();
        let content = match request.uri().path().strip_prefix(&prefix) {
            Some("index.html") => {
                let mut asset = origin(ASSET);
                asset.set_path(&format!("/{}", self.host.entry.entry.as_str()));
                let dark = if self.dark { "dark" } else { "light" };
                asset.set_fragment(Some(&format!("{}.{}.{dark}", self.frame_id, self.locale)));
                let escape_html = |value: &str| {
                    value
                        .replace('&', "&amp;")
                        .replace('"', "&quot;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                };
                let frame_url = escape_html(asset.as_str());
                let title = escape_html(self.title());
                let opening = if self.locale == "zh-CN" {
                    "正在打开插件视图…"
                } else {
                    "Opening plugin view…"
                };
                let html = format!(
                    r#"<!doctype html><html lang="{}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="{dark}"><title>{title}</title><link rel="stylesheet" href="shell.css"><script defer src="shell.js"></script></head><body data-frame="{}"><p role="status">{opening}</p><template><iframe title="{title}" sandbox="allow-scripts" referrerpolicy="no-referrer" data-src="{frame_url}"></iframe></template></body></html>"#,
                    self.locale, self.frame_id
                );
                response(
                    StatusCode::OK,
                    "text/html; charset=utf-8",
                    &csp,
                    html.into_bytes(),
                )
            }
            Some("shell.js") => response(
                StatusCode::OK,
                "application/javascript; charset=utf-8",
                &csp,
                SHELL_JS.as_bytes().to_vec(),
            ),
            Some("shell.css") => response(
                StatusCode::OK,
                "text/css; charset=utf-8",
                &csp,
                SHELL_CSS.as_bytes().to_vec(),
            ),
            Some("stop.js") => {
                self.stop();
                #[cfg(feature = "e2e")]
                super::trace_terminal_view(
                    &format!("node-view-{}", self.frame_id),
                    "stopped",
                    0,
                    0,
                    None,
                );
                response(
                    StatusCode::OK,
                    "application/javascript; charset=utf-8",
                    &csp,
                    Vec::new(),
                )
            }
            Some("next.js") => {
                let mut stopped = self.stopped.subscribe();
                tauri::async_runtime::spawn(async move {
                    let Some(mut reader) = self.reader.try_lock().ok() else {
                        responder.respond(rejected());
                        return;
                    };
                    let outcome = if *stopped.borrow() {
                        None
                    } else if let Some(active) = reader.as_mut() {
                        let data = async {
                            if self.snapshot_pending.swap(false, Ordering::AcqRel) {
                                self.host
                                    .snapshot()
                                    .await
                                    .map(|snapshot| serde_json::json!({ "snapshot": snapshot }))
                            } else {
                                active.next(&self.host).await
                            }
                        };
                        tokio::select! {
                            biased;
                            _ = stopped.changed() => None,
                            data = data => Some(data),
                        }
                    } else {
                        None
                    };
                    let payload = match outcome {
                        Some(Ok(payload)) if !*stopped.borrow() => payload,
                        Some(Err(error)) => {
                            reader.take();
                            serde_json::json!({ "error": error.code })
                        }
                        _ => {
                            reader.take();
                            serde_json::json!({ "error": "VIEW_CLOSED" })
                        }
                    };
                    #[cfg(feature = "e2e")]
                    self.trace_read_termination(&payload);
                    // 外部 JS 只调用壳的固定入口，设备正文始终以 JSON 数据传递。
                    let argument =
                        serde_json::to_string(&payload.to_string()).expect("JSON string");
                    let body = format!("globalThis.swbViewReceive(JSON.parse({argument}));");
                    responder.respond(response(
                        StatusCode::OK,
                        "application/javascript; charset=utf-8",
                        &csp,
                        body.into_bytes(),
                    ));
                });
                return;
            }
            _ => rejected(),
        };
        responder.respond(content);
    }

    #[cfg(feature = "e2e")]
    fn trace_read_termination(&self, payload: &serde_json::Value) {
        if std::env::var("STARTER_E2E_PHASE").as_deref() != Ok("terminal-automated") {
            return;
        }
        let code = payload["error"].as_str().or_else(|| {
            payload
                .pointer("/frame/body/error/code")
                .and_then(serde_json::Value::as_str)
        });
        if let Some(code) = code {
            let label = format!("node-view-{}", self.frame_id);
            log::info!("e2e_terminal_read_end view={label} code={code}");
            // 权限变化可在资产复核或 Raw 订阅终止两个入口先被观察到。
            if matches!(
                code,
                "UNSUPPORTED_CAPABILITY" | "CATALOG_CHANGED" | "PERMISSION_DENIED"
            ) {
                super::trace_terminal_view(&label, "withdrawn", 0, 0, None);
            }
        }
    }

    pub(super) fn respond_asset(
        self: Arc<Self>,
        request: Request<Vec<u8>>,
        responder: RequestAsyncResponder,
    ) {
        let decoded = percent_encoding::percent_decode_str(
            request.uri().path().strip_prefix('/').unwrap_or(""),
        )
        .decode_utf8();
        let path = decoded
            .ok()
            .and_then(|path| NodePackagePath::try_from(path.as_ref()).ok());
        let Some((path, mime)) = path.and_then(|path| mime(&path).map(|mime| (path, mime))) else {
            responder.respond(rejected());
            return;
        };
        if request.method() != Method::GET || *self.stopped.borrow() {
            responder.respond(rejected());
            return;
        }
        let mut stopped = self.stopped.subscribe();
        tauri::async_runtime::spawn(async move {
            let acquire = async {
                let _permit = self.assets.try_acquire().ok()?;
                self.host.asset(path).await.ok()
            };
            let bytes = if *stopped.borrow() {
                None
            } else {
                tokio::select! { biased; _ = stopped.changed() => None, bytes = acquire => bytes }
            };
            let assets = sources(ASSET);
            let csp = format!(
                "sandbox allow-scripts; default-src 'none'; script-src {assets}; style-src {assets}; img-src {assets} data:; font-src {assets}; base-uri 'none'; form-action 'none'; object-src 'none'"
            );
            let reply = match bytes {
                Some(bytes) if !*stopped.borrow() => response(StatusCode::OK, mime, &csp, bytes),
                _ => rejected(),
            };
            responder.respond(reply);
        });
    }
}
