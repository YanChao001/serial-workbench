//! 验证并签名首方 RFC 2217 传输归档。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_builtin_rfc2217",
        include_bytes!(
            "../../../packages/plugin-sdk/examples/reference-rfc2217/builtin-manifest.json"
        ),
        None,
        &[],
    )
}
