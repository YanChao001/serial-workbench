//! 安装先发布独立代码对象，再由 SQLite CAS 决定可见版本；孤立对象不是已安装版本。
use super::{
    Control, NodePackageLimits, VerifiedNodePackage, VerifiedNodePackageSource, failure, invalid,
    limit, paths::PackagePaths,
};
use crate::{files::references::PathGuard, storage::Store};
use serde::{Deserialize, Serialize};
use serial_workbench_core::{
    Digest, HostError, HostResult, Id, JsonObject, NodePackageId, NodePackageManifest,
    NodePackagePermissions, U64,
};
use sha2::{Digest as _, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
use zip::ZipArchive;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeExecutionTrust {
    pub archive_sha256: Digest,
    pub permissions: NodePackagePermissions,
    pub verified_source: Option<VerifiedNodePackageSource>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledNodePackage {
    pub manifest: NodePackageManifest,
    pub archive_sha256: Digest,
    pub verified_source: Option<VerifiedNodePackageSource>,
    pub enabled: bool,
    pub execution_trust: Option<NodeExecutionTrust>,
    object_id: uuid::Uuid,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NodePackageSnapshot {
    pub revision: U64,
    pub packages: Vec<InstalledNodePackage>,
}

#[derive(Debug)]
pub struct NodePackageInstallReceipt {
    pub revision: U64,
    pub package: InstalledNodePackage,
    code_directory: PathBuf,
}
impl NodePackageInstallReceipt {
    /// 只供可信 Host 内部接线；不能作为客户端任意路径能力。
    pub fn code_directory(&self) -> &Path {
        &self.code_directory
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallDocument {
    format_version: U64,
    packages: BTreeMap<String, InstalledNodePackage>,
}
impl Default for InstallDocument {
    fn default() -> Self {
        Self {
            format_version: 1.into(),
            packages: BTreeMap::new(),
        }
    }
}

#[derive(Clone)]
pub struct NodePackageInstaller {
    store: Store,
    profile: PathBuf,
}
impl NodePackageInstaller {
    pub fn new(store: Store, profile: &Path) -> HostResult<Self> {
        if !profile.is_absolute() {
            return Err(invalid("relativeProfile"));
        }
        Ok(Self {
            store,
            profile: fs::canonicalize(profile).map_err(|_| storage())?,
        })
    }

    fn load(&self) -> HostResult<(U64, InstallDocument)> {
        let Some(stored) = self.store.read_document(&document_id())? else {
            return Ok((0.into(), InstallDocument::default()));
        };
        // 先识别格式，未来字段即使无法解码也不能被当前版本覆盖。
        let raw = serde_json::to_value(stored.value).map_err(|_| storage())?;
        if raw.get("formatVersion") != Some(&serde_json::json!("1")) {
            return Err(failure("FUTURE_FORMAT", "installationFormat"));
        }
        let document: InstallDocument = serde_json::from_value(raw).map_err(|_| storage())?;
        for (id, package) in &document.packages {
            if id != package.manifest.id.as_str() {
                return Err(storage());
            }
            package.manifest.validate().map_err(|_| storage())?;
        }
        Ok((stored.revision, document))
    }

    pub fn snapshot(&self) -> HostResult<NodePackageSnapshot> {
        let (revision, document) = self.load()?;
        Ok(NodePackageSnapshot {
            revision,
            packages: document.packages.into_values().collect(),
        })
    }

    /// 只复核已提交代码，不授予执行授权、不注册贡献。
    pub fn verify_installed(
        &self,
        id: &NodePackageId,
        expected_revision: U64,
        archive_sha256: &Digest,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<super::VerifiedNodeInstallation> {
        let control = Control::new(cancel, limits.timeout)?;
        control.check()?;
        let (revision, mut document) = self.load()?;
        if revision != expected_revision {
            return Err(conflict());
        }
        let package = selected(&mut document, id, archive_sha256)?.clone();
        let object_id = package.object_id;
        let sources = super::NodePackageSources::new(self.store.clone());
        let verified = super::installed::verify_contents(
            package,
            revision,
            &self.profile.join("host-v0/node-packages"),
            object_id,
            &sources,
            limits,
            &control,
        )?;
        control.check()?;
        let (current_revision, current) = self.load()?;
        if current_revision != revision
            || current.packages.get(id.as_str()) != Some(verified.package())
        {
            return Err(conflict());
        }
        if let Some(source) = verified.package().verified_source.as_ref() {
            sources.require_current(source)?;
        }
        control.check()?;
        Ok(verified)
    }

    /// 仅可信 Host 用户确认入口调用；包声明、MCP 生成或来源验签不构成该确认。
    pub fn confirm_execution_trust(
        &self,
        id: &NodePackageId,
        expected_revision: U64,
        archive_sha256: &Digest,
    ) -> HostResult<NodePackageSnapshot> {
        let (revision, mut document) = self.load()?;
        if revision != expected_revision {
            return Err(conflict());
        }
        let package = selected(&mut document, id, archive_sha256)?;
        package.execution_trust = Some(NodeExecutionTrust {
            archive_sha256: package.archive_sha256.clone(),
            permissions: package.manifest.permissions.clone(),
            verified_source: package.verified_source.clone(),
        });
        self.save_preferences(revision, document)
    }

    /// 保存启用意图，不启动代码；停用时调用方必须先关闭接纳并结算实际执行 owner。
    pub fn set_enabled(
        &self,
        id: &NodePackageId,
        enabled: bool,
        expected_revision: U64,
        archive_sha256: &Digest,
    ) -> HostResult<NodePackageSnapshot> {
        let (revision, mut document) = self.load()?;
        if revision != expected_revision {
            return Err(conflict());
        }
        let package = selected(&mut document, id, archive_sha256)?;
        if enabled
            && !package.execution_trust.as_ref().is_some_and(|trust| {
                trust.archive_sha256 == package.archive_sha256
                    && trust.permissions == package.manifest.permissions
                    && trust.verified_source == package.verified_source
            })
        {
            return Err(failure("PERMISSION_DENIED", "executionTrustRequired"));
        }
        package.enabled = enabled;
        self.save_preferences(revision, document)
    }

    /// 调用方先阻止新效果并结算执行 owner；撤权不删除来源证据、代码或私有数据。
    pub fn revoke_execution_trust(
        &self,
        id: &NodePackageId,
        expected_revision: U64,
        archive_sha256: &Digest,
    ) -> HostResult<NodePackageSnapshot> {
        let (revision, mut document) = self.load()?;
        if revision != expected_revision {
            return Err(conflict());
        }
        let package = selected(&mut document, id, archive_sha256)?;
        package.enabled = false;
        package.execution_trust = None;
        self.save_preferences(revision, document)
    }

    fn save_preferences(
        &self,
        revision: U64,
        document: InstallDocument,
    ) -> HostResult<NodePackageSnapshot> {
        let value = serde_json::from_value(serde_json::to_value(&document).map_err(|_| storage())?)
            .map_err(|_| storage())?;
        let committed = self
            .store
            .compare_and_swap_document(&document_id(), revision, value)?;
        Ok(NodePackageSnapshot {
            revision: committed.revision,
            packages: document.packages.into_values().collect(),
        })
    }

    /// 阻塞安装边界。调用方负责名额、当前授权和升级前的旧执行 owner 结算。
    pub fn install(
        &self,
        package: VerifiedNodePackage,
        expected_revision: U64,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<NodePackageInstallReceipt> {
        let control = Control::new(cancel, limits.timeout)?;
        control.check()?;
        let (revision, mut document) = self.load()?;
        if revision != expected_revision {
            return Err(conflict());
        }
        if let Some(previous) = document.packages.get(package.manifest().id.as_str())
            && !package
                .manifest()
                .version
                .is_upgrade_from(&previous.manifest.version)
        {
            return Err(failure("VERSION_CONFLICT", "packageVersion"));
        }
        if package.archive_bytes().len() as u64 > limits.max_archive_bytes {
            return Err(limit("archiveBytes"));
        }
        control.check()?;
        let host = PathGuard::new(&self.profile.join("host-v0"))?;
        let namespace = directory(&host, "node-packages")?;
        let staging = directory(&namespace, "staging")?;
        let objects = directory(&namespace, "objects")?;
        let object_id = uuid::Uuid::new_v4();
        let mut stage = staging.child(&object_id.to_string())?;
        stage.create_directory().map_err(|_| storage())?;
        stage.sync_parent().map_err(|_| storage())?;
        let outcome: HostResult<NodePackageInstallReceipt> = (|| {
            write_bytes(
                &stage.child("input.zip")?,
                package.archive_bytes(),
                &control,
            )?;
            let mut code = stage.child("code")?;
            code.create_directory().map_err(|_| storage())?;
            extract(&package, &code, limits, &control)?;
            let destination = objects.child(&object_id.to_string())?;
            control.check()?;
            // Windows 的目录句柄拒绝 delete-share，发布前只释放待移动的最终目录。
            code.release_directory();
            code.rename_to(&destination, false).map_err(|_| storage())?;
            destination.sync_parent().map_err(|_| storage())?;
            code.sync_parent().map_err(|_| storage())?;
            let previous = document.packages.get(package.manifest().id.as_str());
            let execution_trust = previous.and_then(|previous| inherited_trust(previous, &package));
            let enabled =
                execution_trust.is_some() && previous.is_some_and(|previous| previous.enabled);
            let installed = InstalledNodePackage {
                manifest: package.manifest().clone(),
                archive_sha256: package.archive_sha256().clone(),
                verified_source: package.verified_source().cloned(),
                enabled,
                execution_trust,
                object_id,
            };
            document
                .packages
                .insert(installed.manifest.id.as_str().into(), installed.clone());
            let value: JsonObject =
                serde_json::from_value(serde_json::to_value(&document).map_err(|_| storage())?)
                    .map_err(|_| storage())?;
            control.check()?;
            let committed =
                self.store
                    .compare_and_swap_document(&document_id(), revision, value)?;
            // 提交后不再响应取消，成功提交不能被报告为未安装。
            Ok(NodePackageInstallReceipt {
                revision: committed.revision,
                package: installed,
                code_directory: destination.checked_path().to_path_buf(),
            })
        })();
        let evidence = serde_json::json!({
            "schemaVersion":"0.1", "objectId":object_id,
            "archiveSha256":package.archive_sha256(),
            "outcome": match &outcome {
                Ok(receipt) => serde_json::json!({"committed":true,"revision":receipt.revision}),
                Err(error) => serde_json::json!({"committed":false,"error":error}),
            }
        });
        // 失败不回滚或删除代码对象和原件；只读恢复按已提交记录判断可见版本。
        let record_evidence = || {
            write_bytes(
                &stage.child("installation.json")?,
                &serde_json::to_vec_pretty(&evidence).map_err(|_| storage())?,
                &Control::new(&AtomicBool::new(false), std::time::Duration::from_secs(5))?,
            )
        };
        if let Err(error) = record_evidence() {
            eprintln!(
                "Node package installation evidence unavailable: {}",
                error.code
            );
        }
        outcome
    }
}

fn inherited_trust(
    previous: &InstalledNodePackage,
    package: &VerifiedNodePackage,
) -> Option<NodeExecutionTrust> {
    let source = package.verified_source()?;
    let previous_source = previous.verified_source.as_ref()?;
    let trust = previous.execution_trust.as_ref()?;
    if source != previous_source
        || trust.archive_sha256 != previous.archive_sha256
        || trust.verified_source.as_ref() != Some(previous_source)
        || trust.permissions != previous.manifest.permissions
        || package.manifest().host_protocol_version != previous.manifest.host_protocol_version
        || package.manifest().runtime_ref != previous.manifest.runtime_ref
        || !permissions_within(&package.manifest().permissions, &trust.permissions)
    {
        return None;
    }
    Some(NodeExecutionTrust {
        archive_sha256: package.archive_sha256().clone(),
        permissions: package.manifest().permissions.clone(),
        verified_source: Some(source.clone()),
    })
}

fn permissions_within(
    requested: &NodePackagePermissions,
    approved: &NodePackagePermissions,
) -> bool {
    requested
        .execution_purposes
        .iter()
        .all(|purpose| approved.execution_purposes.contains(purpose))
        && requested
            .external_tools
            .iter()
            .all(|tool| approved.external_tools.contains(tool))
        && requested.host_api.iter().all(|scope| {
            scope.permissions.iter().all(|permission| {
                scope.target_kinds.iter().all(|target| {
                    approved.host_api.iter().any(|approved| {
                        approved.permissions.contains(permission)
                            && approved.target_kinds.contains(target)
                    })
                })
            })
        })
}

fn selected<'a>(
    document: &'a mut InstallDocument,
    id: &NodePackageId,
    archive_sha256: &Digest,
) -> HostResult<&'a mut InstalledNodePackage> {
    let package = document
        .packages
        .get_mut(id.as_str())
        .ok_or_else(|| failure("NOT_FOUND", "packageNotInstalled"))?;
    if &package.archive_sha256 != archive_sha256 {
        return Err(failure("INTEGRITY_FAILED", "installationArchiveChanged"));
    }
    Ok(package)
}

fn extract(
    package: &VerifiedNodePackage,
    root: &PathGuard,
    limits: &NodePackageLimits,
    control: &Control<'_>,
) -> HostResult<()> {
    let mut archive =
        ZipArchive::new(Cursor::new(package.archive_bytes())).map_err(|_| storage())?;
    if archive.len() > limits.max_files {
        return Err(limit("archiveEntries"));
    }
    let expected: BTreeMap<_, _> = package
        .integrity()
        .files
        .iter()
        .map(|f| (f.path.as_str(), f))
        .collect();
    let mut total = 0_u64;
    let mut paths = PackagePaths::default();
    for index in 0..archive.len() {
        control.check()?;
        let mut entry = archive.by_index(index).map_err(|_| storage())?;
        let path = paths.add(
            entry.name_raw(),
            entry.is_dir(),
            limits.max_path_bytes,
            limits.max_files,
        )?;
        let components: Vec<_> = path.trim_end_matches('/').split('/').collect();
        let directory_count = components.len() - usize::from(!entry.is_dir());
        let mut parents = Vec::new();
        for component in components.iter().take(directory_count) {
            let parent = parents.last().unwrap_or(root);
            parents.push(directory(parent, component)?);
        }
        if entry.is_dir() {
            continue;
        }
        if entry.size() > limits.max_file_bytes {
            return Err(limit("fileBytes"));
        }
        let metadata_limit = match path.as_str() {
            "manifest.json" | "integrity.json" => Some(limits.max_metadata_bytes),
            "signature.json" => Some(limits.max_metadata_bytes.min(8192)),
            _ => None,
        };
        if metadata_limit.is_some_and(|maximum| entry.size() > maximum as u64) {
            return Err(limit("metadataBytes"));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| limit("totalBytes"))?;
        if total > limits.max_total_bytes {
            return Err(limit("totalBytes"));
        }
        let parent = parents.last().unwrap_or(root);
        let target = parent.child(components.last().ok_or_else(|| invalid("emptyPath"))?)?;
        let mut file = target.create_file().map_err(|_| storage())?;
        let mut hasher = Sha256::new();
        let mut written = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            control.check()?;
            let read = entry.read(&mut buffer).map_err(|_| storage())?;
            if read == 0 {
                break;
            }
            written = written
                .checked_add(read as u64)
                .ok_or_else(|| limit("fileBytes"))?;
            if written > entry.size() || written > limits.max_file_bytes {
                return Err(limit("fileBytes"));
            }
            file.write_all(&buffer[..read]).map_err(|_| storage())?;
            hasher.update(&buffer[..read]);
        }
        if written != entry.size()
            || expected.get(path.as_str()).is_some_and(|f| {
                f.size.get() != written || f.sha256.as_str() != format!("{:x}", hasher.finalize())
            })
        {
            return Err(failure("INTEGRITY_FAILED", "installedPayload"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if entry.unix_mode().unwrap_or(0) & 0o111 != 0 {
                0o555
            } else {
                0o444
            };
            file.set_permissions(fs::Permissions::from_mode(mode))
                .map_err(|_| storage())?;
        }
        file.sync_all().map_err(|_| storage())?;
        target.sync_parent().map_err(|_| storage())?;
    }
    Ok(())
}

fn directory(parent: &PathGuard, name: &str) -> HostResult<PathGuard> {
    let mut child = parent.child(name).map_err(|_| storage())?;
    match fs::symlink_metadata(child.checked_path()) {
        Ok(_) => child.open_existing_directory().map_err(|_| storage())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            child.create_directory().map_err(|_| storage())?;
            child.sync_parent().map_err(|_| storage())?;
        }
        Err(_) => return Err(storage()),
    }
    Ok(child)
}
fn write_bytes(path: &PathGuard, bytes: &[u8], control: &Control<'_>) -> HostResult<()> {
    let mut file = path.create_file().map_err(|_| storage())?;
    for chunk in bytes.chunks(64 * 1024) {
        control.check()?;
        file.write_all(chunk).map_err(|_| storage())?;
    }
    file.sync_all().map_err(|_| storage())?;
    path.sync_parent().map_err(|_| storage())
}
fn document_id() -> Id {
    Id::try_from("node-packages:installed").expect("installation document id")
}
fn storage() -> HostError {
    failure("STORAGE_UNAVAILABLE", "installationStorage")
}
fn conflict() -> HostError {
    failure("REVISION_CONFLICT", "installationRevision")
}
