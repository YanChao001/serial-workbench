//! 从公开 SDK 编译输出制作签名图表包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_chart",
        include_bytes!("../../../packages/plugin-sdk/examples/reference-chart/manifest.json"),
        Some((
            include_bytes!("../../../packages/plugin-sdk/examples/reference-chart/index.html"),
            include_bytes!("../../../packages/plugin-sdk/examples/reference-chart/view.css"),
        )),
        &[],
    )
}
