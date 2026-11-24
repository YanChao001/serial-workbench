//! 从共享调度实现制作 Host 随包签名自动化归档。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_builtin_automation",
        include_bytes!(
            "../../../packages/plugin-sdk/examples/reference-automation/builtin-manifest.json"
        ),
        None,
        &[],
    )
}
