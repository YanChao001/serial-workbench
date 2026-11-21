//! 从公开 SDK 编译输出制作签名自动化包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_automation",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-automation/manifest.json"),
        None,
        &[],
    )
}
