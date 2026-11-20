//! 从已提交记录、保留的原始 ZIP 及实际目录建立内容证明；不会执行安装内容。
use super::{
    Control, InstalledNodePackage, NodePackageLimits, NodePackageSource, NodePackageSources,
    VerifiedNodePackage, failure, limit, paths::PackagePaths, verify_node_package,
};
use crate::files::references::{PathGuard, directory_identity};
use serial_workbench_core::{HostResult, U64};
use sha2::{Digest as _, Sha256};
use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, File, Metadata},
    io::{Cursor, Read},
    path::Path,
    sync::Arc,
    time::Instant,
};
use zip::ZipArchive;

pub struct VerifiedNodeInstallation {
    package: InstalledNodePackage,
    revision: U64,
    code: Arc<PathGuard>,
    ui_assets: Option<Arc<super::ui_assets::VerifiedUiAssets>>,
    #[cfg(windows)]
    _directories: Vec<PathGuard>,
    #[cfg(windows)]
    _files: Vec<File>,
}
impl VerifiedNodeInstallation {
    pub(crate) fn bind_enabled(
        mut self,
        package: &InstalledNodePackage,
        revision: U64,
    ) -> HostResult<Self> {
        let mut expected = self.package.clone();
        expected.enabled = package.enabled;
        expected.activation_authority = package.activation_authority.clone();
        if expected != *package {
            return Err(integrity("installedPreferenceBinding"));
        }
        self.package = package.clone();
        self.revision = revision;
        Ok(self)
    }
    pub fn package(&self) -> &InstalledNodePackage {
        &self.package
    }
    pub fn revision(&self) -> U64 {
        self.revision
    }
    pub fn code_directory(&self) -> &Path {
        self.code.checked_path()
    }
    pub(crate) fn ui_assets(&self) -> Option<Arc<super::ui_assets::VerifiedUiAssets>> {
        self.ui_assets.clone()
    }
}
impl fmt::Debug for VerifiedNodeInstallation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VerifiedNodeInstallation")
            .field("id", &self.package.manifest.id)
            .field("archive_sha256", &self.package.archive_sha256)
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

pub(super) fn verify_contents(
    package: InstalledNodePackage,
    revision: U64,
    namespace: &Path,
    object_id: uuid::Uuid,
    sources: &NodePackageSources,
    limits: &NodePackageLimits,
    control: &Control<'_>,
) -> HostResult<VerifiedNodeInstallation> {
    let root = PathGuard::new(namespace).map_err(|_| integrity("installedRoot"))?;
    let staging = open_directory(&root, "staging")?;
    let stage = open_directory(&staging, &object_id.to_string())?;
    let input = stage
        .child("input.zip")
        .map_err(|_| integrity("installedArchive"))?;
    let mut file = input
        .open_pinned_file()
        .map_err(|_| integrity("installedArchive"))?;
    let mut bytes = Vec::new();
    let metadata = file.metadata().map_err(|_| integrity("installedArchive"))?;
    if link_count(&file, &metadata)? != 1 {
        return Err(integrity("installedArchiveHardLink"));
    }
    if metadata.len() > limits.max_archive_bytes {
        return Err(limit("archiveBytes"));
    }
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        control.check()?;
        let read = file
            .read(&mut buffer)
            .map_err(|_| integrity("installedArchive"))?;
        if read == 0 {
            break;
        }
        if bytes.len() as u64 + read as u64 > limits.max_archive_bytes {
            return Err(limit("archiveBytes"));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    if format!("{:x}", Sha256::digest(&bytes)) != package.archive_sha256.as_str() {
        return Err(integrity("installedArchiveDigest"));
    }
    control.check()?;
    let nested_limits = NodePackageLimits {
        timeout: control.deadline.saturating_duration_since(Instant::now()),
        ..limits.clone()
    };
    let verified = if let Some(source) = package.verified_source.as_ref() {
        sources.require_current(source)?;
        sources.verify(
            bytes,
            &source.source,
            &source.key_id,
            &nested_limits,
            control.cancel,
        )?
    } else {
        verify_node_package(
            bytes,
            NodePackageSource::Local,
            &nested_limits,
            control.cancel,
        )?
    };
    if verified.manifest() != &package.manifest
        || verified.verified_source() != package.verified_source.as_ref()
    {
        return Err(integrity("installedRecordMismatch"));
    }
    let expected = expected_tree(&verified, control)?;
    let objects = open_directory(&root, "objects")?;
    let code = Arc::new(open_directory(&objects, &object_id.to_string())?);
    let mut check = TreeCheck {
        expected,
        paths: PackagePaths::default(),
        limits,
        control,
        ui_index: super::ui_assets::UiAssetIndex::from_archive(&verified),
        #[cfg(windows)]
        files: Vec::new(),
        #[cfg(windows)]
        directories: Vec::new(),
    };
    check.directory(&code, "")?;
    if !check.expected.is_empty() {
        return Err(integrity("missingInstalledEntry"));
    }
    control.check()?;
    let ui_assets = check
        .ui_index
        .map(|index| Arc::new(index.seal(code.clone())));
    #[cfg(windows)]
    let directories = {
        check.directories.extend([root, staging, stage, objects]);
        check.directories
    };
    Ok(VerifiedNodeInstallation {
        package,
        revision,
        code,
        ui_assets,
        #[cfg(windows)]
        _directories: directories,
        #[cfg(windows)]
        _files: check.files,
    })
}

struct ExpectedFile {
    size: u64,
    sha256: String,
    #[cfg(unix)]
    mode: u32,
}
enum ExpectedNode {
    Directory,
    File(ExpectedFile),
}
fn expected_tree(
    package: &VerifiedNodePackage,
    control: &Control<'_>,
) -> HostResult<BTreeMap<String, ExpectedNode>> {
    let mut tree = BTreeMap::new();
    let files: BTreeMap<_, _> = package
        .integrity()
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut archive = ZipArchive::new(Cursor::new(package.archive_bytes()))
        .map_err(|_| integrity("installedArchive"))?;
    for index in 0..archive.len() {
        control.check()?;
        let mut entry = archive
            .by_index(index)
            .map_err(|_| integrity("installedArchive"))?;
        let path = entry
            .name()
            .map_err(|_| integrity("installedArchive"))?
            .trim_end_matches('/')
            .to_owned();
        let mut parent = path.as_str();
        while let Some((directory, _)) = parent.rsplit_once('/') {
            tree.entry(path_key(directory))
                .or_insert(ExpectedNode::Directory);
            parent = directory;
        }
        let node = if entry.is_dir() {
            ExpectedNode::Directory
        } else {
            let expected = files.get(path.as_str());
            let sha256 = if let Some(expected) = expected {
                expected.sha256.as_str().to_owned()
            } else {
                let mut hash = Sha256::new();
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    control.check()?;
                    let read = entry
                        .read(&mut buffer)
                        .map_err(|_| integrity("installedArchive"))?;
                    if read == 0 {
                        break;
                    }
                    hash.update(&buffer[..read]);
                }
                format!("{:x}", hash.finalize())
            };
            ExpectedNode::File(ExpectedFile {
                size: entry.size(),
                sha256,
                #[cfg(unix)]
                mode: if entry.unix_mode().unwrap_or(0) & 0o111 != 0 {
                    0o555
                } else {
                    0o444
                },
            })
        };
        tree.insert(path_key(&path), node);
    }
    Ok(tree)
}

struct TreeCheck<'a, 'b> {
    expected: BTreeMap<String, ExpectedNode>,
    paths: PackagePaths,
    limits: &'a NodePackageLimits,
    control: &'a Control<'b>,
    ui_index: Option<super::ui_assets::UiAssetIndex>,
    #[cfg(windows)]
    files: Vec<File>,
    #[cfg(windows)]
    directories: Vec<PathGuard>,
}
impl TreeCheck<'_, '_> {
    fn directory(&mut self, directory: &PathGuard, prefix: &str) -> HostResult<()> {
        let identity = directory
            .directory_identity()
            .map_err(|_| integrity("installedDirectory"))?;
        for entry in
            fs::read_dir(directory.checked_path()).map_err(|_| integrity("installedDirectory"))?
        {
            self.control.check()?;
            let entry = entry.map_err(|_| integrity("installedDirectory"))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| integrity("installedPath"))?;
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let metadata =
                fs::symlink_metadata(entry.path()).map_err(|_| integrity("installedMetadata"))?;
            if is_link(&metadata) {
                return Err(integrity("installedLink"));
            }
            let raw = if metadata.is_dir() {
                format!("{path}/")
            } else {
                path.clone()
            };
            self.paths.add(
                raw.as_bytes(),
                metadata.is_dir(),
                self.limits.max_path_bytes,
                self.limits.max_files,
            )?;
            let expected = self
                .expected
                .remove(&path_key(&path))
                .ok_or_else(|| integrity("unlistedInstalledEntry"))?;
            let mut child = directory
                .child(&name)
                .map_err(|_| integrity("installedPath"))?;
            match expected {
                ExpectedNode::Directory => {
                    child
                        .open_existing_directory()
                        .map_err(|_| integrity("installedDirectory"))?;
                    self.directory(&child, &path)?;
                    #[cfg(windows)]
                    self.directories.push(child);
                }
                ExpectedNode::File(expected) => {
                    let mut file = child
                        .open_pinned_file()
                        .map_err(|_| integrity("installedFile"))?;
                    self.file(&mut file, &expected, &path)?;
                    #[cfg(windows)]
                    self.files.push(file);
                }
            }
        }
        if directory_identity(directory.checked_path())
            .map_err(|_| integrity("installedDirectoryChanged"))?
            != identity
        {
            return Err(integrity("installedDirectoryChanged"));
        }
        Ok(())
    }

    fn file(&mut self, file: &mut File, expected: &ExpectedFile, path: &str) -> HostResult<()> {
        let metadata = file
            .metadata()
            .map_err(|_| integrity("installedMetadata"))?;
        if link_count(file, &metadata)? != 1 {
            return Err(integrity("installedHardLink"));
        }
        if metadata.len() != expected.size {
            return Err(integrity("installedFileSize"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o7777 != expected.mode {
                return Err(integrity("installedFileMode"));
            }
        }
        let mut hash = Sha256::new();
        let mut remaining = expected.size;
        let mut buffer = [0_u8; serial_workbench_core::NODE_VIEW_ASSET_CHUNK_BYTES];
        let mut index = self
            .ui_index
            .as_mut()
            .and_then(|ui| ui.chunks(&path_key(path)));
        while remaining > 0 {
            self.control.check()?;
            let size = remaining.min(buffer.len() as u64) as usize;
            let chunk = &mut buffer[..size];
            file.read_exact(chunk)
                .map_err(|_| integrity("installedFile"))?;
            hash.update(&*chunk);
            if let Some(chunks) = index.as_mut() {
                chunks.push(Sha256::digest(chunk).into());
            }
            remaining -= size as u64;
        }
        if file
            .read(&mut buffer[..1])
            .map_err(|_| integrity("installedFile"))?
            != 0
        {
            return Err(integrity("installedFileSize"));
        }
        if format!("{:x}", hash.finalize()) != expected.sha256 {
            return Err(integrity("installedFileDigest"));
        }
        Ok(())
    }
}

pub(super) fn open_directory(parent: &PathGuard, name: &str) -> HostResult<PathGuard> {
    let mut child = parent
        .child(name)
        .map_err(|_| integrity("installedDirectory"))?;
    child
        .open_existing_directory()
        .map_err(|_| integrity("installedDirectory"))?;
    Ok(child)
}
fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}
pub(super) fn link_count(file: &File, metadata: &Metadata) -> HostResult<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = file;
        Ok(metadata.nlink())
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let _ = metadata;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(integrity("installedFileIdentity"));
        }
        Ok(u64::from(info.nNumberOfLinks))
    }
}
pub(super) fn path_key(path: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        use unicode_normalization::UnicodeNormalization;
        // APFS/HFS+ 返回的名字可能分解；原始包已经禁止规范化别名。
        path.nfc().collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        path.to_owned()
    }
}
pub(super) fn integrity(reason: &str) -> serial_workbench_core::HostError {
    failure("INTEGRITY_FAILED", reason)
}
