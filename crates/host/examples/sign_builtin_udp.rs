//! 验证并签名首方 UDP 传输归档。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_builtin_udp",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-udp/builtin-manifest.json"),
        None,
        &[],
    )
}
