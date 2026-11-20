//! 仅移除当前UUID对象；文件隔离与SQLite提交分别留证，不把两者伪装成原子事务。
use super::{
    Control, InstallDocument, NodePackageInstaller, NodePackageLimits, PathGuard, conflict,
    directory, document_id, failure, selected, storage,
};
use crate::files::references::{directory_identity, file_identity};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serial_workbench_core::{
    Digest, HostResult, NodePackageId, NodePackageIdentityParams, NodePackageUninstallResult,
    SchemaObject, U64,
};
use sha2::{Digest as _, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::atomic::AtomicBool,
};

const REMOVALS: &str = "uninstall";
const JOURNAL: &str = "journal.json";
const MARKER: &str = "committed.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum OriginalDirectory {
    Missing,
    Present { identity: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    format_version: U64,
    id: NodePackageId,
    archive_sha256: Digest,
    object_id: uuid::Uuid,
    pre_revision: U64,
    pre_image: Digest,
    post_image: Digest,
    object: OriginalDirectory,
    stage: OriginalDirectory,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitMarker {
    format_version: U64,
    object_id: uuid::Uuid,
    post_image: Digest,
    result: NodePackageUninstallResult,
}

struct Locations {
    objects: PathGuard,
    staging: PathGuard,
    removals: PathGuard,
}

impl NodePackageInstaller {
    /// 调用方先收敛真实执行并排除该UUID的证明；本层不停止或重启共享Node。
    pub(crate) fn uninstall_authorized<G>(
        &self,
        params: &NodePackageIdentityParams,
        expected_revision: U64,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
        mut authorize: impl FnMut() -> HostResult<G>,
        mut committed: impl FnMut(&NodePackageUninstallResult) -> HostResult<()>,
    ) -> HostResult<NodePackageUninstallResult> {
        let control = Control::new(cancel, limits.timeout)?;
        control.check()?;
        {
            let _authority = authorize()?;
        }
        let (revision, mut document) = Self::load(&self.store)?;
        if revision != expected_revision {
            return Err(conflict());
        }
        let package = selected(&mut document, &params.id, &params.archive_sha256)?.clone();
        let pre_image = document_hash(&document, &control)?;
        document.packages.remove(params.id.as_str());
        let post_image = document_hash(&document, &control)?;
        let expected_commit = revision.checked_next()?;
        let value: SchemaObject =
            serde_json::from_value(serde_json::to_value(&document).map_err(|_| storage())?)
                .map_err(|_| storage())?;
        let locations = Locations::create(&self.profile)?;
        let name = package.object_id.to_string();
        let object = inspect_directory(&locations.objects, &name)?;
        let stage = inspect_directory(&locations.staging, &name)?;
        let mut budget = WalkBudget::new(limits)?;
        audit_original(&locations.objects, &name, &object, &mut budget, &control)?;
        audit_original(&locations.staging, &name, &stage, &mut budget, &control)?;
        control.check()?;
        let journal = Journal {
            format_version: 1.into(),
            id: params.id.clone(),
            archive_sha256: params.archive_sha256.clone(),
            object_id: package.object_id,
            pre_revision: revision,
            pre_image,
            post_image,
            object,
            stage,
        };
        let mut removal = locations.removals.child(&name).map_err(|_| storage())?;
        if fs::symlink_metadata(removal.checked_path()).is_ok() {
            return Err(pending());
        }
        removal.create_directory().map_err(|_| storage())?;
        removal.sync_parent().map_err(|_| storage())?;
        let mut cas_attempted = false;
        let prepare: HostResult<NodePackageUninstallResult> = (|| {
            write_json(&removal, JOURNAL, &journal, limits, &control)?;
            move_original(&locations.objects, &name, &removal, "code", &journal.object)?;
            control.check()?;
            move_original(&locations.staging, &name, &removal, "stage", &journal.stage)?;
            control.check()?;
            let result = {
                let _authority = authorize()?;
                control.check()?;
                cas_attempted = true;
                self.store
                    .compare_and_swap_schema_document(&document_id(), revision, value)?
            };
            Ok(NodePackageUninstallResult {
                revision: result.revision,
                id: params.id.clone(),
                archive_sha256: params.archive_sha256.clone(),
            })
        })();
        // 提交回执若丢失，只按实际文档精确判定；不能把已生效CAS的原件搬回去。
        let prepare = match prepare {
            Err(cause)
                if cas_attempted
                    && !matches!(cause.code.as_str(), "REVISION_CONFLICT" | "HOST_BUSY") =>
            {
                let (current_revision, current) =
                    Self::load(&self.store).map_err(|_| uncertain_commit())?;
                if current
                    .packages
                    .values()
                    .any(|package| package.object_id == journal.object_id)
                {
                    Err(cause)
                } else if current_revision == expected_commit {
                    // CAS可能已经生效；迟到取消不能先于事实确认，原截止时刻仍约束核实。
                    let uncancelled = AtomicBool::new(false);
                    let confirmation = Control {
                        cancel: &uncancelled,
                        deadline: control.deadline,
                    };
                    if document_hash(&current, &confirmation).map_err(|_| uncertain_commit())?
                        != journal.post_image
                    {
                        return Err(uncertain_commit());
                    }
                    Ok(NodePackageUninstallResult {
                        revision: current_revision,
                        id: params.id.clone(),
                        archive_sha256: params.archive_sha256.clone(),
                    })
                } else {
                    return Err(uncertain_commit());
                }
            }
            other => other,
        };
        let result = match prepare {
            Ok(result) => result,
            Err(cause) => {
                // 取消或期限失败也必须尝试这两个固定恢复动作，不能先丢隔离证据。
                if restore(&locations, &removal, &journal).is_err()
                    || finish_metadata(&mut removal).is_err()
                {
                    return Err(pending());
                }
                return Err(cause);
            }
        };
        // 已提交事实不受迟到取消回滚；清理仍沿用原截止时刻，不另起预算。
        let uncancelled = AtomicBool::new(false);
        let after_commit = Control {
            cancel: &uncancelled,
            deadline: control.deadline,
        };
        let marker = CommitMarker {
            format_version: 1.into(),
            object_id: journal.object_id,
            post_image: journal.post_image.clone(),
            result: result.clone(),
        };
        let record_marker = write_json(&removal, MARKER, &marker, limits, &after_commit);
        // 即使标记写入失败，也把真实CAS结果交给调用方；二者都在提交锁外。
        let record_result = committed(&result);
        record_result?;
        record_marker?;
        let (_, current) = Self::load(&self.store)?;
        if current
            .packages
            .values()
            .any(|package| package.object_id == journal.object_id)
        {
            return Err(pending());
        }
        cleanup(&locations, &mut removal, &journal, limits, &after_commit)?;
        Ok(result)
    }

    /// 启动监督器前，或持独占安装名额时调用；构造器和普通读取不隐式修复。
    pub(crate) fn recover_uninstalls(
        &self,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<()> {
        let control = Control::new(cancel, limits.timeout)?;
        let path = self.profile.join("host-v0/node-packages").join(REMOVALS);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(storage()),
            Ok(_) => {}
        }
        Self::load(&self.store)?;
        let locations = Locations::open(&self.profile)?;
        for name in entry_names(&locations.removals, limits.max_files, &control)? {
            control.check()?;
            let object_id = uuid::Uuid::parse_str(&name).map_err(|_| pending())?;
            if object_id.to_string() != name {
                return Err(pending());
            }
            let mut removal = locations.removals.child(&name).map_err(|_| storage())?;
            removal.open_existing_directory().map_err(|_| pending())?;
            // 先识别安装文档格式，未来或损坏的文档绝不能触发文件恢复或删除。
            let (revision, document) = Self::load(&self.store)?;
            let referenced = document
                .packages
                .values()
                .any(|package| package.object_id == object_id);
            let journal: Option<Journal> = read_json(&removal, JOURNAL, limits, &control)?;
            let marker: Option<CommitMarker> = read_json(&removal, MARKER, limits, &control)?;
            let Some(journal) = journal else {
                let names = entry_names(&removal, 4, &control)?;
                if names.is_empty() {
                    unlink_entry(&mut removal, true)?;
                    continue;
                }
                // 最后删除元数据时可能只剩提交标记；此时不得再有任何代码目录。
                if let Some(marker) = marker
                    && marker.object_id == object_id
                    && !referenced
                    && revision >= marker.result.revision
                    && names.iter().all(|name| name == MARKER)
                {
                    finish_metadata(&mut removal)?;
                    continue;
                }
                return Err(pending());
            };
            if journal.object_id != object_id {
                return Err(pending());
            }
            if let Some(marker) = &marker {
                validate_marker(&journal, marker)?;
            }
            if referenced {
                restore(&locations, &removal, &journal)?;
                finish_metadata(&mut removal)?;
                continue;
            }
            let explicit_commit = marker
                .as_ref()
                .is_some_and(|marker| revision >= marker.result.revision);
            let exact_post_image = revision == journal.pre_revision.checked_next()?
                && document_hash(&document, &control)? == journal.post_image;
            if !explicit_commit && !exact_post_image {
                return Err(pending());
            }
            cleanup(&locations, &mut removal, &journal, limits, &control)?;
        }
        control.check()
    }
}

impl Locations {
    fn open(profile: &Path) -> HostResult<Self> {
        let namespace = PathGuard::new(&profile.join("host-v0/node-packages"))?;
        let open = |name: &str| -> HostResult<PathGuard> {
            let mut path = namespace.child(name).map_err(|_| pending())?;
            path.open_existing_directory().map_err(|_| pending())?;
            Ok(path)
        };
        Ok(Self {
            objects: open("objects")?,
            staging: open("staging")?,
            removals: open(REMOVALS)?,
        })
    }

    fn create(profile: &Path) -> HostResult<Self> {
        let host = PathGuard::new(&profile.join("host-v0"))?;
        let namespace = directory(&host, "node-packages")?;
        Ok(Self {
            objects: directory(&namespace, "objects")?,
            staging: directory(&namespace, "staging")?,
            removals: directory(&namespace, REMOVALS)?,
        })
    }
}

fn inspect_directory(parent: &PathGuard, name: &str) -> HostResult<OriginalDirectory> {
    let mut path = parent.child(name).map_err(|_| storage())?;
    match fs::symlink_metadata(path.checked_path()) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(OriginalDirectory::Missing)
        }
        Err(_) => Err(storage()),
        Ok(_) => {
            path.open_existing_directory().map_err(|_| pending())?;
            Ok(OriginalDirectory::Present {
                identity: path.directory_identity().map_err(|_| pending())?,
            })
        }
    }
}

fn move_original(
    from: &PathGuard,
    from_name: &str,
    to: &PathGuard,
    to_name: &str,
    expected: &OriginalDirectory,
) -> HostResult<()> {
    if &inspect_directory(from, from_name)? != expected
        || inspect_directory(to, to_name)? != OriginalDirectory::Missing
    {
        return Err(pending());
    }
    if matches!(expected, OriginalDirectory::Missing) {
        return Ok(());
    }
    let mut source = from.child(from_name).map_err(|_| storage())?;
    source.open_existing_directory().map_err(|_| pending())?;
    let target = to.child(to_name).map_err(|_| storage())?;
    // 只释放待移动目录自身；祖先和两端父目录仍由PathGuard保护。
    source.release_directory();
    source.rename_to(&target, false).map_err(|_| storage())?;
    source.sync_parent().map_err(|_| storage())?;
    target.sync_parent().map_err(|_| storage())?;
    if &inspect_directory(to, to_name)? != expected {
        return Err(pending());
    }
    Ok(())
}

fn restore(locations: &Locations, removal: &PathGuard, journal: &Journal) -> HostResult<()> {
    let name = journal.object_id.to_string();
    for (parent, saved, expected) in [
        (&locations.objects, "code", &journal.object),
        (&locations.staging, "stage", &journal.stage),
    ] {
        let original = inspect_directory(parent, &name)?;
        let quarantined = inspect_directory(removal, saved)?;
        match (&original, &quarantined, expected) {
            (
                OriginalDirectory::Missing,
                OriginalDirectory::Missing,
                OriginalDirectory::Missing,
            ) => {}
            (_, OriginalDirectory::Missing, _) if &original == expected => {}
            (OriginalDirectory::Missing, _, _) if &quarantined == expected => {
                move_original(removal, saved, parent, &name, expected)?;
            }
            _ => return Err(pending()),
        }
    }
    Ok(())
}

fn validate_marker(journal: &Journal, marker: &CommitMarker) -> HostResult<()> {
    if marker.object_id != journal.object_id
        || marker.post_image != journal.post_image
        || marker.result.id != journal.id
        || marker.result.archive_sha256 != journal.archive_sha256
        || marker.result.revision != journal.pre_revision.checked_next()?
    {
        return Err(pending());
    }
    Ok(())
}

fn cleanup(
    locations: &Locations,
    removal: &mut PathGuard,
    journal: &Journal,
    limits: &NodePackageLimits,
    control: &Control<'_>,
) -> HostResult<()> {
    let mut budget = WalkBudget::new(limits)?;
    let name = journal.object_id.to_string();
    for (original_parent, saved, expected) in [
        (&locations.objects, "code", &journal.object),
        (&locations.staging, "stage", &journal.stage),
    ] {
        control.check()?;
        if inspect_directory(original_parent, &name)? != OriginalDirectory::Missing {
            return Err(pending());
        }
        let actual = inspect_directory(removal, saved)?;
        if actual == OriginalDirectory::Missing {
            continue;
        }
        if &actual != expected {
            return Err(pending());
        }
        walk_tree(
            removal.child(saved).map_err(|_| storage())?,
            0,
            &mut budget,
            control,
            true,
        )?;
    }
    control.check()?;
    finish_metadata(removal)
}

fn finish_metadata(removal: &mut PathGuard) -> HostResult<()> {
    // 这里只做至多四个已知元数据项；回滚不能因原取消而跳过，也不续起时间预算。
    let identity = removal.directory_identity().map_err(|_| pending())?;
    let mut names = Vec::new();
    for entry in fs::read_dir(removal.checked_path()).map_err(|_| storage())? {
        if names.len() >= 4 {
            return Err(pending());
        }
        names.push(
            entry
                .map_err(|_| storage())?
                .file_name()
                .into_string()
                .map_err(|_| pending())?,
        );
    }
    if directory_identity(removal.checked_path()).map_err(|_| pending())? != identity {
        return Err(pending());
    }
    if names.iter().any(|name| {
        !matches!(
            name.as_str(),
            JOURNAL | MARKER | "journal.json.pending" | "committed.json.pending"
        )
    }) {
        return Err(pending());
    }
    // 标记最后删除；journal删除后的崩溃窗口仍能明确认出已清完代码的事务。
    for name in [
        "journal.json.pending",
        "committed.json.pending",
        JOURNAL,
        MARKER,
    ] {
        let mut file = removal.child(name).map_err(|_| storage())?;
        match fs::symlink_metadata(file.checked_path()) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(storage()),
            Ok(_) => unlink_entry(&mut file, false)?,
        }
    }
    unlink_entry(removal, true)
}

fn write_json(
    directory: &PathGuard,
    name: &str,
    value: &impl Serialize,
    limits: &NodePackageLimits,
    control: &Control<'_>,
) -> HostResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| storage())?;
    if bytes.len() > limits.max_metadata_bytes {
        return Err(failure("LIMIT_EXCEEDED", "uninstallJournalBytes"));
    }
    control.check()?;
    let temporary = directory
        .child(&format!("{name}.pending"))
        .map_err(|_| storage())?;
    super::write_bytes(&temporary, &bytes, control)?;
    control.check()?;
    let target = directory.child(name).map_err(|_| storage())?;
    temporary.rename_to(&target, false).map_err(|_| storage())?;
    target.sync_parent().map_err(|_| storage())
}

fn read_json<T: DeserializeOwned>(
    directory: &PathGuard,
    name: &str,
    limits: &NodePackageLimits,
    control: &Control<'_>,
) -> HostResult<Option<T>> {
    let path = directory.child(name).map_err(|_| storage())?;
    match fs::symlink_metadata(path.checked_path()) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage()),
        Ok(_) => {}
    }
    let mut file = path.open_pinned_file().map_err(|_| pending())?;
    if file.metadata().map_err(|_| storage())?.len() > limits.max_metadata_bytes as u64 {
        return Err(failure("LIMIT_EXCEEDED", "uninstallJournalBytes"));
    }
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        control.check()?;
        let count = file.read(&mut buffer).map_err(|_| storage())?;
        if count == 0 {
            break;
        }
        if count > limits.max_metadata_bytes.saturating_sub(bytes.len()) {
            return Err(failure("LIMIT_EXCEEDED", "uninstallJournalBytes"));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| pending())?;
    if value.get("formatVersion") != Some(&serde_json::json!("1")) {
        return Err(failure("FUTURE_FORMAT", "uninstallJournalFormat"));
    }
    serde_json::from_value(value)
        .map(Some)
        .map_err(|_| pending())
}

struct HashWriter<'a, 'b> {
    hash: Sha256,
    control: &'a Control<'b>,
}
impl Write for HashWriter<'_, '_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.control
            .check()
            .map_err(|_| std::io::Error::other("uninstall hash stopped"))?;
        self.hash.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn document_hash(document: &InstallDocument, control: &Control<'_>) -> HostResult<Digest> {
    let mut writer = HashWriter {
        hash: Sha256::new(),
        control,
    };
    let result = serde_json::to_writer(&mut writer, document);
    control.check()?;
    result.map_err(|_| storage())?;
    Digest::try_from(format!("{:x}", writer.hash.finalize()).as_str())
}

struct WalkBudget {
    nodes: usize,
    max_nodes: usize,
    max_path_bytes: usize,
}
impl WalkBudget {
    fn new(limits: &NodePackageLimits) -> HostResult<Self> {
        Ok(Self {
            nodes: 0,
            // 固定stage及隔离元数据另占常量节点，不放大包内容本身的预算。
            max_nodes: limits
                .max_files
                .checked_add(8)
                .ok_or_else(|| failure("LIMIT_EXCEEDED", "uninstallNodes"))?,
            max_path_bytes: limits.max_path_bytes,
        })
    }
    fn enter(&mut self, bytes: usize) -> HostResult<()> {
        if bytes > self.max_path_bytes || self.nodes >= self.max_nodes {
            return Err(failure("LIMIT_EXCEEDED", "uninstallTree"));
        }
        self.nodes += 1;
        Ok(())
    }
}

fn audit_original(
    parent: &PathGuard,
    name: &str,
    original: &OriginalDirectory,
    budget: &mut WalkBudget,
    control: &Control<'_>,
) -> HostResult<()> {
    if matches!(original, OriginalDirectory::Present { .. }) {
        walk_tree(
            parent.child(name).map_err(|_| storage())?,
            0,
            budget,
            control,
            false,
        )?;
        if &inspect_directory(parent, name)? != original {
            return Err(pending());
        }
    }
    Ok(())
}

fn walk_tree(
    mut directory: PathGuard,
    prefix_bytes: usize,
    budget: &mut WalkBudget,
    control: &Control<'_>,
    remove: bool,
) -> HostResult<()> {
    control.check()?;
    budget.enter(prefix_bytes)?;
    directory.open_existing_directory().map_err(|_| pending())?;
    let identity = directory.directory_identity().map_err(|_| pending())?;
    let entries = fs::read_dir(directory.checked_path()).map_err(|_| storage())?;
    for entry in entries {
        control.check()?;
        let entry = entry.map_err(|_| storage())?;
        let name = entry.file_name().into_string().map_err(|_| pending())?;
        let bytes = prefix_bytes
            .checked_add(usize::from(prefix_bytes != 0))
            .and_then(|bytes| bytes.checked_add(name.len()))
            .ok_or_else(|| failure("LIMIT_EXCEEDED", "uninstallPath"))?;
        let mut child = directory.child(&name).map_err(|_| pending())?;
        let metadata = fs::symlink_metadata(child.checked_path()).map_err(|_| storage())?;
        if linked(&metadata) {
            return Err(pending());
        }
        if metadata.is_dir() {
            walk_tree(child, bytes, budget, control, remove)?;
        } else if metadata.is_file() {
            budget.enter(bytes)?;
            let file = child.open_pinned_file().map_err(|_| pending())?;
            if !file.metadata().map_err(|_| storage())?.is_file() {
                return Err(pending());
            }
            drop(file);
            if remove {
                control.check()?;
                unlink_entry(&mut child, false)?;
            }
        } else {
            return Err(pending());
        }
    }
    if directory_identity(directory.checked_path()).map_err(|_| pending())? != identity {
        return Err(pending());
    }
    if remove {
        control.check()?;
        unlink_entry(&mut directory, true)?;
    }
    Ok(())
}

fn entry_names(
    directory: &PathGuard,
    max: usize,
    control: &Control<'_>,
) -> HostResult<Vec<String>> {
    let identity = directory.directory_identity().map_err(|_| pending())?;
    let mut names = Vec::new();
    for entry in fs::read_dir(directory.checked_path()).map_err(|_| storage())? {
        control.check()?;
        if names.len() >= max {
            return Err(failure("LIMIT_EXCEEDED", "uninstallJournalCount"));
        }
        names.push(
            entry
                .map_err(|_| storage())?
                .file_name()
                .into_string()
                .map_err(|_| pending())?,
        );
    }
    if directory_identity(directory.checked_path()).map_err(|_| pending())? != identity {
        return Err(pending());
    }
    names.sort();
    Ok(names)
}

fn linked(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(unix)]
    false
}

fn unlink_entry(path: &mut PathGuard, directory: bool) -> HostResult<()> {
    let expected_directory = if directory {
        Some(path.directory_identity().map_err(|_| pending())?)
    } else {
        None
    };
    path.release_directory();
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let (parent, name) = crate::files::references::open_parent(path.checked_path())?;
        if file_identity(&parent)? != path.parent_identity()? {
            return Err(pending());
        }
        if let Some(expected) = expected_directory
            && directory_identity(path.checked_path())? != expected
        {
            return Err(pending());
        }
        let flags = if directory { libc::AT_REMOVEDIR } else { 0 };
        if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), flags) } != 0 {
            return Err(storage());
        }
    }
    #[cfg(windows)]
    {
        use std::fs::OpenOptions;
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Storage::FileSystem::{
            DELETE, FILE_DISPOSITION_INFO, FileDispositionInfo, SetFileInformationByHandle,
        };
        let file = OpenOptions::new()
            .access_mode(DELETE | 0x80)
            .share_mode(1 | 2 | 4)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path.checked_path())
            .map_err(|_| storage())?;
        let metadata = file.metadata().map_err(|_| storage())?;
        if linked(&metadata)
            || metadata.is_dir() != directory
            || (!directory && !metadata.is_file())
        {
            return Err(pending());
        }
        if let Some(expected) = expected_directory
            && file_identity(&file)? != expected
        {
            return Err(pending());
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err(storage());
        }
        drop(file);
    }
    path.sync_parent().map_err(|_| storage())
}

fn pending() -> serial_workbench_core::HostError {
    failure(
        "NODE_UNINSTALL_RECOVERY_REQUIRED",
        "uninstallJournalPending",
    )
}

fn uncertain_commit() -> serial_workbench_core::HostError {
    failure("NODE_PACKAGE_OPERATION_UNKNOWN", "uninstallCommitUncertain")
}

#[cfg(test)]
#[path = "uninstall_tests.rs"]
mod tests;
