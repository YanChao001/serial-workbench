//! 为公开 SDK RFC 2217 示例生成可验签的参考归档。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_rfc2217",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-rfc2217/manifest.json"),
        None,
        &[],
    )
}
