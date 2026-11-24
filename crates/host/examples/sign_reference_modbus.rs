//! 从公开 SDK 编译输出制作首方 Modbus 主站包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_modbus",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-modbus/manifest.json"),
        None,
        &[],
    )
}
