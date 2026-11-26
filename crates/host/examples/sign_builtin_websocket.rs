//! 验证并签名首方 WebSocket 设备传输归档。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_builtin_websocket",
        include_bytes!(
            "../../../packages/plugin-sdk/examples/reference-websocket/builtin-manifest.json"
        ),
        None,
        &[(
            "third-party/ws.LICENSE",
            include_bytes!("../../../resources/third-party/ws.LICENSE"),
        )],
    )
}
