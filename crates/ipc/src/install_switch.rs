//! 同卷切换已校验的 Windows 安装目录。仅供本机安装协调进程调用。

use crate::{
    DiscoveryRecord, PrivateFileLock, discovery::read_bounded_metadata, identity::IdentityPin,
    read_secret, shutdown::verify_idle_profile_shutdown, write_atomic,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::Mac;
use serde::{Deserialize, Serialize};
use serial_workbench_core::{Digest, HostError, HostResult, RequestId, U64};
use sha2::{Digest as _, Sha256};
use std::{
    fs::{self, File},
    io::{self, ErrorKind},
    os::windows::{ffi::OsStrExt, fs::MetadataExt, io::AsRawHandle},
    path::{Component, Path, PathBuf, Prefix},
    time::Duration,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_REPARSE_POINT, GetFileInformationByHandle, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

const DOMAIN: &str = "serial-workbench/install-switch/1";

/// 每轮替换使用独立的同卷暂存和归档目录。调用方须保留操作 ID 供重启恢复。
#[derive(Clone)]
pub struct InstallPaths {
    operation: RequestId,
    active: PathBuf,
    staged: PathBuf,
    backup: PathBuf,
}

impl InstallPaths {
    pub fn new(active: &Path, operation: RequestId) -> HostResult<Self> {
        let parent = active.parent().ok_or_else(integrity)?;
        let name = active.file_name().ok_or_else(integrity)?;
        if !active.is_absolute() || name.to_string_lossy().to_lowercase().starts_with(".swb-") {
            return Err(integrity());
        }
        directory(parent)?;
        let parent = fs::canonicalize(parent).map_err(|_| storage())?;
        if !matches!(
            parent.components().next(),
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_))
        ) {
            return Err(integrity());
        }
        let active = parent.join(name);
        Ok(Self {
            staged: parent.join(format!(".swb-stage-{operation}")),
            backup: parent.join(format!(".swb-old-{operation}")),
            operation,
            active,
        })
    }

    pub fn staged(&self) -> &Path {
        &self.staged
    }

    pub fn backup(&self) -> &Path {
        &self.backup
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
enum Phase {
    Prepared,
    Committed,
    RolledBack,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallOutcome {
    Committed,
    RolledBack,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    operation: RequestId,
    active: PathBuf,
    epoch: U64,
    previous: Digest,
    candidate: Digest,
    phase: Phase,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt<T> {
    intent: T,
    proof: String,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Checkpoint {
    Intent,
    Publish,
    Commit,
}

/// 协调进程持有旧 Host 的 profile 锁，直到替换或恢复完毕。
/// 调用方负责确认桌面及安装器终态、排除套件目录的其他写入者，
/// 并从可信清单取得完整的新旧摘要。
pub struct InstallSwitch {
    _reservation: PrivateFileLock,
    paths: InstallPaths,
    pin: IdentityPin,
    epoch: U64,
    journal: PathBuf,
}

impl InstallSwitch {
    pub fn open(
        profile: &Path,
        paths: InstallPaths,
        reservation: PrivateFileLock,
        timeout: Duration,
    ) -> HostResult<Self> {
        let install = Self::open_verified_identity(profile, paths, reservation)?;
        verify_idle_profile_shutdown(profile, timeout)?;
        Ok(install)
    }

    fn open_verified_identity(
        profile: &Path,
        paths: InstallPaths,
        reservation: PrivateFileLock,
    ) -> HostResult<Self> {
        let namespace = profile.join("host-v0");
        reservation.require_host_namespace(&namespace)?;
        let profile_path = fs::canonicalize(profile).map_err(|_| storage())?;
        if [&paths.active, &paths.staged, &paths.backup]
            .iter()
            .any(|path| paths_overlap(path, &profile_path))
        {
            return Err(integrity());
        }
        let bytes = read_secret(&namespace.join("identity.secret"))?.ok_or_else(integrity)?;
        let pin: IdentityPin = serde_json::from_slice(&bytes).map_err(|_| integrity())?;
        pin.verify_profile(profile)?;
        let record = DiscoveryRecord::read(&namespace.join("discovery.json"))?;
        if record.host_id != pin.host_id {
            return Err(integrity());
        }
        let journal = namespace.join(format!("install-switch-{}.json", paths.operation));
        Ok(Self {
            _reservation: reservation,
            paths,
            pin,
            epoch: record.instance_epoch,
            journal,
        })
    }

    /// 写入意图，再换入已验证的新套件。返回错误时保留收据供 recover 使用。
    pub fn replace(&mut self, previous: &Digest, candidate: &Digest) -> HostResult<()> {
        self.replace_with(previous, candidate, |_| Ok(()))
    }

    fn replace_with(
        &mut self,
        previous: &Digest,
        candidate: &Digest,
        mut checkpoint: impl FnMut(Checkpoint) -> HostResult<()>,
    ) -> HostResult<()> {
        if self.read_intent()?.is_some()
            || previous == candidate
            || digest_if_present(&self.paths.backup)?.is_some()
            || suite_digest(&self.paths.active)? != *previous
            || suite_digest(&self.paths.staged)? != *candidate
        {
            return Err(integrity());
        }
        let mut intent = Intent {
            operation: self.paths.operation.clone(),
            active: self.paths.active.clone(),
            epoch: self.epoch,
            previous: previous.clone(),
            candidate: candidate.clone(),
            phase: Phase::Prepared,
        };
        checkpoint(Checkpoint::Intent)?;
        self.save_intent(&intent)?;
        move_directory(&self.paths.active, &self.paths.backup)?;
        checkpoint(Checkpoint::Publish)?;
        move_directory(&self.paths.staged, &self.paths.active)?;
        self.verify_committed(&intent)?;
        checkpoint(Checkpoint::Commit)?;
        intent.phase = Phase::Committed;
        self.save_intent(&intent)
    }

    /// 重开同一操作时，根据真实目录恢复未提交的替换，或重新核对已落盘终态。
    pub fn recover(&mut self) -> HostResult<Option<InstallOutcome>> {
        let Some(mut intent) = self.read_intent()? else {
            return Ok(None);
        };
        match intent.phase {
            Phase::Committed => {
                self.verify_committed(&intent)?;
                Ok(Some(InstallOutcome::Committed))
            }
            Phase::RolledBack => {
                self.verify_rolled_back(&intent)?;
                Ok(Some(InstallOutcome::RolledBack))
            }
            Phase::Prepared => {
                if digest_if_present(&self.paths.backup)?.as_ref() == Some(&intent.previous) {
                    if let Some(active) = digest_if_present(&self.paths.active)? {
                        if active != intent.candidate
                            || digest_if_present(&self.paths.staged)?.is_some()
                        {
                            return Err(integrity());
                        }
                        move_directory(&self.paths.active, &self.paths.staged)?;
                    }
                    move_directory(&self.paths.backup, &self.paths.active)?;
                }
                self.verify_rolled_back(&intent)?;
                intent.phase = Phase::RolledBack;
                self.save_intent(&intent)?;
                Ok(Some(InstallOutcome::RolledBack))
            }
        }
    }

    fn verify_committed(&self, intent: &Intent) -> HostResult<()> {
        if suite_digest(&self.paths.active)? != intent.candidate
            || suite_digest(&self.paths.backup)? != intent.previous
            || digest_if_present(&self.paths.staged)?.is_some()
        {
            return Err(integrity());
        }
        Ok(())
    }

    fn verify_rolled_back(&self, intent: &Intent) -> HostResult<()> {
        if suite_digest(&self.paths.active)? != intent.previous
            || digest_if_present(&self.paths.backup)?.is_some()
        {
            return Err(integrity());
        }
        Ok(())
    }

    fn read_intent(&self) -> HostResult<Option<Intent>> {
        match fs::symlink_metadata(&self.journal) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(storage()),
        }
        let bytes = read_bounded_metadata(&self.journal, 262_144).ok_or_else(integrity)?;
        let receipt: Receipt<Intent> = serde_json::from_slice(&bytes).map_err(|_| integrity())?;
        let proof = URL_SAFE_NO_PAD
            .decode(receipt.proof)
            .map_err(|_| integrity())?;
        self.pin
            .transcript_mac(&(DOMAIN, &receipt.intent))?
            .verify_slice(&proof)
            .map_err(|_| integrity())?;
        let intent = receipt.intent;
        if intent.operation != self.paths.operation
            || intent.active != self.paths.active
            || intent.epoch != self.epoch
        {
            return Err(integrity());
        }
        Ok(Some(intent))
    }

    fn save_intent(&self, intent: &Intent) -> HostResult<()> {
        let proof = self.pin.transcript_mac(&(DOMAIN, intent))?.finalize();
        let bytes = serde_json::to_vec(&Receipt {
            intent,
            proof: URL_SAFE_NO_PAD.encode(proof.into_bytes()),
        })
        .map_err(|_| storage())?;
        write_atomic(&self.journal, &bytes)
    }
}

/// 指纹覆盖每个文件的相对路径与 SHA-256，以及目录路径（包括空目录）。
pub fn suite_digest(path: &Path) -> HostResult<Digest> {
    directory(path)?;
    let mut tree = Sha256::new();
    tree.update(b"serial-workbench/install-tree/1");
    let mut has_file = false;
    let mut pending = vec![path.to_path_buf()];
    while let Some(parent) = pending.pop() {
        let mut entries = fs::read_dir(&parent)
            .and_then(|entries| entries.collect::<io::Result<Vec<_>>>())
            .map_err(|_| storage())?;
        entries.sort_unstable_by_key(fs::DirEntry::file_name);
        for entry in entries {
            let child = entry.path();
            let metadata = fs::symlink_metadata(&child).map_err(|_| storage())?;
            if reparse(&metadata) {
                return Err(integrity());
            }
            let relative = child.strip_prefix(path).map_err(|_| integrity())?;
            let units: Vec<_> = relative.as_os_str().encode_wide().collect();
            tree.update((units.len() as u64).to_le_bytes());
            for unit in units {
                tree.update(unit.to_le_bytes());
            }
            if metadata.is_dir() {
                tree.update(b"D");
                pending.push(child);
            } else if metadata.is_file() {
                tree.update(b"F");
                let mut file = File::open(child).map_err(|_| storage())?;
                let mut info = Default::default();
                // A linked candidate file could let a later write also modify the rollback copy.
                if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0
                    || info.nNumberOfLinks != 1
                    || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                {
                    return Err(integrity());
                }
                let mut contents = Sha256::new();
                io::copy(&mut file, &mut contents).map_err(|_| storage())?;
                tree.update(contents.finalize());
                has_file = true;
            } else {
                return Err(integrity());
            }
        }
    }
    if !has_file {
        return Err(integrity());
    }
    Digest::try_from(format!("{:x}", tree.finalize()).as_str())
}

fn digest_if_present(path: &Path) -> HostResult<Option<Digest>> {
    match fs::symlink_metadata(path) {
        Ok(_) => suite_digest(path).map(Some),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(storage()),
    }
}

fn paths_overlap(first: &Path, second: &Path) -> bool {
    let first = first.canonicalize().unwrap_or_else(|_| first.to_path_buf());
    let first = PathBuf::from(first.to_string_lossy().to_lowercase());
    let second = PathBuf::from(second.to_string_lossy().to_lowercase());
    first.starts_with(&second) || second.starts_with(&first)
}

fn reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn directory(path: &Path) -> HostResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| storage())?;
    if !metadata.is_dir() || reparse(&metadata) {
        return Err(integrity());
    }
    Ok(())
}

fn move_directory(source: &Path, destination: &Path) -> HostResult<()> {
    directory(source)?;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>()
    };
    if unsafe {
        MoveFileExW(
            wide(source).as_ptr(),
            wide(destination).as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(HostError::new(
            "STORAGE_UNAVAILABLE",
            format!(
                "Cannot move Windows install directory: {}",
                io::Error::last_os_error()
            ),
        ));
    }
    Ok(())
}

fn integrity() -> HostError {
    HostError::new(
        "INSTALL_INTEGRITY",
        "Windows install state failed verification",
    )
}

fn storage() -> HostError {
    HostError::new(
        "STORAGE_UNAVAILABLE",
        "Windows install storage is unavailable",
    )
}

#[cfg(test)]
mod tests;
