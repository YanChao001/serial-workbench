use super::{BrowserState, only_header};
use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};

pub(super) const PATH: &str = "/browser-plugin-frame";
const SCRIPT: &str = include_str!("plugin_frame.js");

pub(super) async fn serve(State(state): State<BrowserState>, headers: HeaderMap) -> Response {
    if !only_header(&headers, header::HOST).is_some_and(|value| value == state.authority.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let script = SCRIPT.replace("\r\n", "\n");
    let hash = STANDARD.encode(Sha256::digest(script.as_bytes()));
    let policy = format!(
        "sandbox allow-scripts; default-src 'none'; script-src 'sha256-{hash}' blob:;          style-src blob:; img-src blob: data:; connect-src 'none'; base-uri 'none';          form-action 'none'; object-src 'none'; frame-ancestors {}",
        state.origin,
    );
    let html = format!(
        "<!doctype html><html><head><meta charset=utf-8><meta name=viewport          content=\"width=device-width,initial-scale=1\"></head><body><script>{script}</script></body></html>",
    );
    let mut response = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response();
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_str(&policy).expect("loopback origin and script digest"),
    );
    for (header, value) in [
        (header::CACHE_CONTROL, "no-store"),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
    ] {
        response
            .headers_mut()
            .insert(header, HeaderValue::from_static(value));
    }
    response
}
