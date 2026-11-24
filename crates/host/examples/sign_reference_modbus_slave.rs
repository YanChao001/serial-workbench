//! 从公开 SDK 编译输出制作首方 Modbus 从站包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_modbus_slave",
        include_bytes!(
            "../../../packages/plugin-sdk/examples/reference-modbus-slave/manifest.json"
        ),
        None,
        &[],
    )
}
