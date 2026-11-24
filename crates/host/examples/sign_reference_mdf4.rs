//! 从公开 SDK 的专业 MDF4 示例生成供隔离 Host 验收的签名包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_mdf4",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-mdf4/manifest.json"),
        None,
        &[],
    )
}
