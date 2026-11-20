//! 从公开 SDK 编译输出制作签名终端包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_terminal",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-terminal/manifest.json"),
        Some((
            include_bytes!("../../../packages/plugin-sdk/examples/reference-terminal/index.html"),
            include_bytes!("../../../packages/plugin-sdk/examples/reference-terminal/view.css"),
        )),
    )
}
