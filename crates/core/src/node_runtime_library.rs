//! v0 唯一私有库为 Ubuntu Jammy libatomic；来源证据与实际载荷分别锁定。
use crate::{
    Digest, HostError, HostResult, Id, NodePackagePath, NodePackageSchemaVersion,
    NodePackageTarget, NodePackageVersion, NodeRuntimeFile, U64,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{collections::HashSet, sync::LazyLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeLibraryRelease {
    pub schema_version: NodePackageSchemaVersion,
    pub id: Id,
    pub version: String,
    pub target: NodePackageTarget,
    pub architecture: String,
    pub license_expression: String,
    pub upstream: NodeRuntimeLibraryUpstream,
    pub artifacts: Vec<NodeRuntimeSourceArtifact>,
    pub library: NodeRuntimeFile,
    pub library_mode: String,
    pub soname_link: NodeRuntimeLibraryLink,
    pub copyright: NodeRuntimeFile,
    pub copyright_source_path: NodePackagePath,
    pub gpl_license: NodeRuntimeFile,
    pub gpl_source_path: NodePackagePath,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeLibraryUpstream {
    pub base_url: String,
    pub signer_fingerprint: String,
    pub keyring: NodeRuntimeRepositoryFile,
    pub in_release: NodeRuntimeRepositoryFile,
    pub package_index: NodeRuntimeRepositoryFile,
    pub source_index: NodeRuntimeRepositoryFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeRepositoryFile {
    pub repository_path: NodePackagePath,
    pub bundled_path: NodePackagePath,
    pub size: U64,
    pub sha256: Digest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub enum NodeRuntimeSourceArtifactKind {
    Binary,
    CorrespondingSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeSourceArtifact {
    pub kind: NodeRuntimeSourceArtifactKind,
    pub package: Id,
    pub version: String,
    pub filename: NodePackagePath,
    pub size: U64,
    pub sha256: Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeRuntimeLibraryLink {
    pub resource_path: NodePackagePath,
    pub target: NodePackagePath,
}

fn invalid_library() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid Node private library metadata")
}
impl NodeRuntimeLibraryRelease {
    pub fn validate(&self) -> HostResult<()> {
        let Some((upstream_version, revision)) = self.version.split_once('-') else {
            return Err(invalid_library());
        };
        NodePackageVersion::try_from(upstream_version).map_err(|_| invalid_library())?;
        if !upstream_version.starts_with("12.")
            || revision.is_empty()
            || !revision
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+~".contains(&b))
            || !self.id.as_str().starts_with("libatomic1-jammy-")
            || self.target != NodePackageTarget::LinuxX64
            || self.architecture != "amd64"
            || self.license_expression != "GPL-3.0-or-later WITH GCC-exception-3.1"
            || self.upstream.base_url != "https://archive.ubuntu.com/ubuntu/"
            || self.upstream.signer_fingerprint.len() != 40
            || !self
                .upstream
                .signer_fingerprint
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
            || self.library.archive_path.as_str() != "usr/lib/x86_64-linux-gnu/libatomic.so.1.2.0"
            || self.library.resource_path.as_str() != "lib/libatomic.so.1.2.0"
            || self.library_mode != "0644"
            || self.soname_link.resource_path.as_str() != "lib/libatomic.so.1"
            || self.soname_link.target.as_str() != "libatomic.so.1.2.0"
            || self.copyright.archive_path.as_str() != "usr/share/doc/gcc-12-base/copyright"
            || self.copyright.resource_path.as_str() != "licenses/libatomic/COPYRIGHT"
            || self.copyright_source_path.as_str() != "resources/runtime/libatomic.COPYRIGHT"
            || self.library.size.get() == 0
            || self.library.size.get() > 1024 * 1024
            || self.copyright.size.get() == 0
            || self.copyright.size.get() > 1024 * 1024
            || self.artifacts.len() != 5
            || self.gpl_license.archive_path.as_str() != format!("gcc-{upstream_version}/COPYING3")
            || self.gpl_license.resource_path.as_str() != "licenses/libatomic/GPL-3.0"
            || self.gpl_source_path.as_str() != "resources/runtime/libatomic.GPL-3.0"
            || self.gpl_license.size.get() == 0
            || self.gpl_license.size.get() > 128 * 1024
        {
            return Err(invalid_library());
        }
        for (file, repository, bundled, cap) in [
            (
                &self.upstream.keyring,
                "project/ubuntu-archive-keyring.gpg",
                "ubuntu-archive-keyring.gpg",
                64 * 1024,
            ),
            (
                &self.upstream.in_release,
                "dists/jammy-updates/InRelease",
                "ubuntu-jammy-InRelease.asc",
                512 * 1024,
            ),
            (
                &self.upstream.package_index,
                "dists/jammy-updates/main/binary-amd64/Packages.gz",
                "ubuntu-jammy-Packages.gz",
                8 * 1024 * 1024,
            ),
            (
                &self.upstream.source_index,
                "dists/jammy-updates/main/source/Sources.gz",
                "ubuntu-jammy-Sources.gz",
                8 * 1024 * 1024,
            ),
        ] {
            if file.repository_path.as_str() != repository
                || file.bundled_path.as_str() != format!("resources/runtime/{bundled}")
                || file.size.get() == 0
                || file.size.get() > cap
            {
                return Err(invalid_library());
            }
        }
        use NodeRuntimeSourceArtifactKind::{Binary, CorrespondingSource};
        let version = &self.version;
        let expected = [
            (
                Binary,
                "libatomic1",
                format!("libatomic1_{version}_amd64.deb"),
            ),
            (
                Binary,
                "gcc-12-base",
                format!("gcc-12-base_{version}_amd64.deb"),
            ),
            (
                CorrespondingSource,
                "gcc-12",
                format!("gcc-12_{upstream_version}.orig.tar.gz"),
            ),
            (
                CorrespondingSource,
                "gcc-12",
                format!("gcc-12_{version}.debian.tar.xz"),
            ),
            (
                CorrespondingSource,
                "gcc-12",
                format!("gcc-12_{version}.dsc"),
            ),
        ];
        let mut paths = HashSet::new();
        for artifact in &self.artifacts {
            if artifact.version != self.version
                || artifact.size.get() == 0
                || artifact.size.get() > 128 * 1024 * 1024
                || !paths.insert(&artifact.filename)
                || !expected.iter().any(|(kind, package, name)| {
                    artifact.kind == *kind
                        && artifact.package.as_str() == *package
                        && artifact.filename.as_str() == format!("pool/main/g/gcc-12/{name}")
                })
            {
                return Err(invalid_library());
            }
        }
        Ok(())
    }
}

pub fn parse_node_runtime_library(bytes: &[u8]) -> HostResult<NodeRuntimeLibraryRelease> {
    let release: NodeRuntimeLibraryRelease =
        crate::node_package::decode_node_json(bytes).map_err(|_| invalid_library())?;
    release.validate()?;
    Ok(release)
}
pub fn bundled_node_runtime_library() -> &'static NodeRuntimeLibraryRelease {
    static RELEASE: LazyLock<NodeRuntimeLibraryRelease> = LazyLock::new(|| {
        parse_node_runtime_library(include_bytes!(
            "../../../resources/runtime/libatomic-jammy.json"
        ))
        .expect("validated bundled private library release")
    });
    &RELEASE
}
