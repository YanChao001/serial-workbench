//! 验证并签名首方 TCP 传输归档。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_builtin_tcp",
        include_bytes!(
            "../../../packages/plugin-sdk/examples/reference-transport/builtin-manifest.json"
        ),
        None,
        &[],
    )
}
