//! 制作协议字段编解码器的签名插件包。
#[path = "support/reference_package.rs"]
mod reference_package;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    reference_package::sign(
        "sign_reference_protocol_fields",
        include_bytes!(
            "../../../packages/plugin-sdk/examples/reference-protocol-fields/manifest.json"
        ),
        None,
        &[(
            "third-party/yaml.LICENSE",
            include_bytes!("../../../resources/third-party/yaml.LICENSE"),
        )],
    )
}
