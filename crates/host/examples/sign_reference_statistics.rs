//! 从公开 SDK 编译输出制作高级统计扩展验收包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_statistics",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-statistics/manifest.json"),
        None,
        &[],
    )
}
