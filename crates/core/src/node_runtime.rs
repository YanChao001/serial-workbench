//! 应用固定 runtime 的来源、文件布局及 ABI；不从用户 PATH 或工作目录推断。
use crate::{
    Digest, HostError, HostResult, Id, NodePackagePath, NodePackageSchemaVersion,
    NodePackageTarget, NodePackageVersion, U64,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::HashSet, sync::LazyLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeRelease {
    pub schema_version: NodePackageSchemaVersion,
    pub id: Id,
    pub version: NodePackageVersion,
    pub modules_abi: U64,
    pub node_api_version: U64,
    pub upstream: NodeRuntimeUpstream,
    pub targets: Vec<NodeRuntimeTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeUpstream {
    pub keyring_commit: Id,
    pub keyring_url: String,
    pub keyring_sha256: Digest,
    pub signer_fingerprint: String,
    pub public_key_path: NodePackagePath,
    pub public_key_sha256: Digest,
    pub checksums_url: String,
    pub checksums_sha256: Digest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub enum NodeRuntimeArchiveFormat {
    Zip,
    TarGz,
    TarXz,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "lowercase")]
pub enum NodeRuntimePlatform {
    Win32,
    Darwin,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "lowercase")]
pub enum NodeRuntimeArch {
    X64,
    Arm64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeArchive {
    pub name: NodePackagePath,
    pub url: String,
    pub format: NodeRuntimeArchiveFormat,
    pub size: U64,
    pub sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeFile {
    pub archive_path: NodePackagePath,
    pub resource_path: NodePackagePath,
    pub size: U64,
    pub sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeTarget {
    pub target: NodePackageTarget,
    pub platform: NodeRuntimePlatform,
    pub arch: NodeRuntimeArch,
    pub archive: NodeRuntimeArchive,
    pub executable: NodeRuntimeFile,
    pub license: NodeRuntimeFile,
    pub required_private_libraries: Vec<NodePackagePath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeSelfTest {
    pub version: NodePackageVersion,
    pub platform: NodeRuntimePlatform,
    pub arch: NodeRuntimeArch,
    pub modules_abi: U64,
    pub node_api_version: U64,
    pub exec_path: String,
}

fn invalid_runtime() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid Node runtime metadata")
}

impl NodeRuntimeRelease {
    pub fn validate(&self) -> HostResult<()> {
        let version = self.version.as_str();
        let commit = self.upstream.keyring_commit.as_str();
        if self.id.as_str() != format!("node-{version}")
            || version.contains(['-', '+'])
            || self.modules_abi.get() == 0
            || self.node_api_version.get() == 0
            || commit.len() != 40
            || !commit
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.upstream.signer_fingerprint.len() != 40
            || !self
                .upstream
                .signer_fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
            || self.upstream.keyring_url
                != format!(
                    "https://raw.githubusercontent.com/nodejs/release-keys/{commit}/gpg/pubring.kbx"
                )
            || self.upstream.public_key_path.as_str() != "resources/runtime/node-release-key.gpg"
            || self.upstream.checksums_url
                != format!("https://nodejs.org/download/release/v{version}/SHASUMS256.txt.asc")
            || self.targets.len() != 4
        {
            return Err(invalid_runtime());
        }
        let mut targets = HashSet::new();
        for target in &self.targets {
            if !targets.insert(target.target) {
                return Err(invalid_runtime());
            }
            target.validate(version)?;
        }
        Ok(())
    }
    pub fn for_target(&self, target: NodePackageTarget) -> HostResult<&NodeRuntimeTarget> {
        self.targets
            .iter()
            .find(|entry| entry.target == target)
            .ok_or_else(invalid_runtime)
    }
}

impl NodeRuntimeTarget {
    fn validate(&self, version: &str) -> HostResult<()> {
        use NodeRuntimeArch::{Arm64, X64};
        use NodeRuntimeArchiveFormat::{TarGz, TarXz, Zip};
        use NodeRuntimePlatform::{Darwin, Linux, Win32};
        let (suffix, platform, arch, format) = match self.target {
            NodePackageTarget::WindowsX64 => ("win-x64", Win32, X64, Zip),
            NodePackageTarget::MacosArm64 => ("darwin-arm64", Darwin, Arm64, TarGz),
            NodePackageTarget::MacosX64 => ("darwin-x64", Darwin, X64, TarGz),
            NodePackageTarget::LinuxX64 => ("linux-x64", Linux, X64, TarXz),
        };
        let extension = match format {
            Zip => "zip",
            TarGz => "tar.gz",
            TarXz => "tar.xz",
        };
        let root = format!("node-v{version}-{suffix}");
        let archive = format!("{root}.{extension}");
        let name = if platform == Win32 {
            "node.exe"
        } else {
            "node"
        };
        let entry = if platform == Win32 {
            name.into()
        } else {
            format!("bin/{name}")
        };
        let target = serde_json::to_value(self.target).expect("target serialization");
        let target = target.as_str().expect("string target");
        let resource_root = format!("runtime/node/{version}/{target}");
        let libraries: Vec<&str> = if platform == Linux {
            vec!["lib/libatomic.so.1"]
        } else {
            Vec::new()
        };
        if self.platform != platform
            || self.arch != arch
            || self.archive.format != format
            || self.archive.name.as_str() != archive
            || self.archive.url
                != format!("https://nodejs.org/download/release/v{version}/{archive}")
            || self.archive.size.get() == 0
            || self.archive.size.get() > 256 * 1024 * 1024
            || self.executable.archive_path.as_str() != format!("{root}/{entry}")
            || self.executable.resource_path.as_str() != format!("{resource_root}/bin/{name}")
            || self.executable.size.get() == 0
            || self.executable.size.get() > 256 * 1024 * 1024
            || self.license.archive_path.as_str() != format!("{root}/LICENSE")
            || self.license.resource_path.as_str() != format!("{resource_root}/LICENSE")
            || self.license.size.get() == 0
            || self.license.size.get() > 1024 * 1024
            || self
                .required_private_libraries
                .iter()
                .map(NodePackagePath::as_str)
                .collect::<Vec<_>>()
                != libraries
        {
            return Err(invalid_runtime());
        }
        Ok(())
    }
    /// 核对版本/ABI/target；实际资源根、文件身份和 execPath 由 Host 绑定。
    pub fn validate_self_test(
        &self,
        release: &NodeRuntimeRelease,
        probe: &NodeRuntimeSelfTest,
    ) -> HostResult<()> {
        if probe.version != release.version
            || probe.modules_abi != release.modules_abi
            || probe.node_api_version != release.node_api_version
            || probe.platform != self.platform
            || probe.arch != self.arch
            || probe.exec_path.is_empty()
        {
            return Err(invalid_runtime());
        }
        Ok(())
    }
}

pub fn parse_node_runtime_release(bytes: &[u8]) -> HostResult<NodeRuntimeRelease> {
    let release: NodeRuntimeRelease =
        crate::node_package::decode_node_json(bytes).map_err(|_| invalid_runtime())?;
    release.validate()?;
    Ok(release)
}
pub fn bundled_node_runtime_release() -> &'static NodeRuntimeRelease {
    static RELEASE: LazyLock<NodeRuntimeRelease> = LazyLock::new(|| {
        parse_node_runtime_release(include_bytes!(
            "../../../resources/runtime/node-release.json"
        ))
        .expect("validated bundled runtime release")
    });
    &RELEASE
}
