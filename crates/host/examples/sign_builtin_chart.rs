//! 从共享图表源码的编译输出制作 Host 随包签名归档。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_builtin_chart",
        include_bytes!(
            "../../../packages/plugin-sdk/examples/reference-chart/builtin-manifest.json"
        ),
        Some((
            include_bytes!("../../../packages/plugin-sdk/examples/reference-chart/index.html"),
            include_bytes!("../../../packages/plugin-sdk/examples/reference-chart/view.css"),
        )),
        &[],
    )
}
