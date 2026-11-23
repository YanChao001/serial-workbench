//! 从公开 SDK 编译输出制作签名主题包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_theme",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-theme/manifest.json"),
        None,
        &[(
            "themes/bench-teal.json",
            include_bytes!("../../../packages/plugin-sdk/examples/reference-theme/theme.json"),
        )],
    )
}
