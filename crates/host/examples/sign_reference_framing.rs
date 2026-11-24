//! 制作通用分帧器的签名插件包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_framing",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-framing/manifest.json"),
        None,
        &[],
    )
}
