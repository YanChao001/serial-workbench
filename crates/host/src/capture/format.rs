//! SWBR01 编码与同步元数据；未知版本只读拒绝。
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
pub const MAGIC: &[u8; 7] = b"SWBR01\n";
pub const MAX_RECORD: usize = 1024 * 1024;
pub const MAX_METADATA: u64 = 64 * 1024 * 1024;
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureSource {
    pub host_id: Id,
    pub instance_epoch: U64,
    pub session_id: Id,
    pub session_epoch: U64,
    pub configuration_digest: Digest,
    pub configuration: SerialConfiguration,
    pub time_precision: TimePrecision,
}
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SourceIdentity {
    host_id: Id,
    instance_epoch: U64,
    session_id: Id,
    session_epoch: U64,
}
impl SourceIdentity {
    pub(crate) fn source(source: &CaptureSource) -> Self {
        Self {
            host_id: source.host_id.clone(),
            instance_epoch: source.instance_epoch,
            session_id: source.session_id.clone(),
            session_epoch: source.session_epoch,
        }
    }
    pub(crate) fn entry(entry: &CaptureEntry) -> Self {
        let (host, instance, session, epoch) = match entry {
            CaptureEntry::Event(event) => (
                &event.host_id,
                event.instance_epoch,
                &event.session_id,
                event.session_epoch,
            ),
            CaptureEntry::TxSettlement(settlement) => (
                &settlement.host_id,
                settlement.instance_epoch,
                &settlement.receipt.session_id,
                settlement.receipt.session_epoch,
            ),
            CaptureEntry::ReaderGap(gap) => (
                &gap.host_id,
                gap.instance_epoch,
                &gap.session_id,
                gap.session_epoch,
            ),
        };
        Self {
            host_id: host.clone(),
            instance_epoch: instance,
            session_id: session.clone(),
            session_epoch: epoch,
        }
    }
    pub(crate) fn declared(&self, sources: &[CaptureSource]) -> bool {
        sources.iter().any(|source| {
            source.host_id == self.host_id
                && source.instance_epoch == self.instance_epoch
                && source.session_id == self.session_id
                && source.session_epoch == self.session_epoch
        })
    }
}
pub(crate) fn validate_entry_source(
    entry: &CaptureEntry,
    sources: &[CaptureSource],
) -> HostResult<SourceIdentity> {
    let source = SourceIdentity::entry(entry);
    if !source.declared(sources) {
        return Err(corrupt());
    }
    if let CaptureEntry::Event(event) = entry
        && let RawPayload::Tx(receipt) = &event.payload
        && (receipt.session_id != event.session_id || receipt.session_epoch != event.session_epoch)
    {
        return Err(corrupt());
    }
    Ok(source)
}
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SettlementKey {
    source: SourceIdentity,
    pub(crate) operation_id: Id,
    byte_start: U64,
    byte_end: U64,
}
impl SettlementKey {
    pub(crate) fn intent(source: SourceIdentity, intent: &TxIntent) -> Self {
        Self {
            source,
            operation_id: intent.operation_id.clone(),
            byte_start: intent.byte_start,
            byte_end: intent.byte_end,
        }
    }
    pub(crate) fn receipt(source: SourceIdentity, receipt: &TxReceipt) -> Self {
        Self {
            source,
            operation_id: receipt.operation_id.clone(),
            byte_start: receipt.byte_start,
            byte_end: receipt.byte_end,
        }
    }
    pub(crate) fn entry(entry: &CaptureEntry) -> Option<Self> {
        let receipt = match entry {
            CaptureEntry::TxSettlement(settlement) => &settlement.receipt,
            CaptureEntry::Event(event) => {
                if let RawPayload::Tx(receipt) = &event.payload {
                    receipt
                } else {
                    return None;
                }
            }
            _ => return None,
        };
        Some(Self::receipt(SourceIdentity::entry(entry), receipt))
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Volume {
    pub ordinal: U64,
    pub record_start: U64,
    pub record_end: U64,
    pub length: U64,
    pub digest: Digest,
    pub previous_digest: Digest,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: String,
    pub capture_id: Id,
    pub mode: CaptureMode,
    pub streams: Vec<CaptureSource>,
    pub volumes: Vec<Volume>,
    pub state: CaptureState,
    pub watermarks: CaptureWatermarks,
    pub source_continuous: bool,
    pub recovered_from: Option<Digest>,
    pub verified_prefix: U64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexEntry {
    pub record_ordinal: U64,
    pub volume: U64,
    pub offset: U64,
    pub length: U64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureIndex {
    pub format_version: String,
    pub records: Vec<IndexEntry>,
}
pub fn volume_name(ordinal: u64) -> String {
    format!("volume-{ordinal:06}.swbr")
}
pub fn digest(bytes: &[u8]) -> Digest {
    Digest::try_from(format!("{:x}", Sha256::digest(bytes)).as_str()).expect("SHA256 hex")
}
pub fn zero_digest() -> Digest {
    Digest::try_from("0000000000000000000000000000000000000000000000000000000000000000")
        .expect("zero digest")
}
pub(crate) use crate::files::references::{changed, io_error};
pub fn corrupt() -> HostError {
    HostError::new("CAPTURE_CORRUPT", "Capture structure or digest is invalid")
}
pub fn no_clobber(error: std::io::Error) -> HostError {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        HostError::new("TARGET_EXISTS", "Target already exists")
    } else {
        io_error(error)
    }
}
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> HostResult<T> {
    let mut file = open_read(path)?;
    if file.metadata().map_err(io_error)?.len() > MAX_METADATA {
        return Err(corrupt());
    }
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(io_error)?;
    serde_json::from_slice(&data).map_err(|_| corrupt())
}
pub fn open_read(path: &Path) -> HostResult<File> {
    crate::files::references::open_regular(path)
}
pub fn hash_file(file: &mut File) -> HostResult<Digest> {
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    loop {
        let n = file.read(&mut bytes).map_err(io_error)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Digest::try_from(format!("{:x}", hash.finalize()).as_str())
}
pub fn write_json(path: &Path, value: &impl Serialize) -> HostResult<()> {
    write_json_at(&crate::files::references::PathGuard::new(path)?, value)
}
pub(crate) fn write_json_at(
    target: &crate::files::references::PathGuard,
    value: &impl Serialize,
) -> HostResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| corrupt())?;
    if bytes.len() as u64 > MAX_METADATA {
        return Err(HostError::new(
            "LIMIT_EXCEEDED",
            "Capture metadata budget exhausted",
        ));
    }
    let temp = target.sibling(std::ffi::OsStr::new(&format!(
        ".pending-{}",
        uuid::Uuid::new_v4()
    )))?;
    let mut file = temp.create_file()?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    temp.rename_to(target, true)?;
    target.sync_parent()
}
pub fn rename_no_replace(source: &Path, target: &Path) -> HostResult<()> {
    let mut source = crate::files::references::PathGuard::new(source)?;
    let mut target = crate::files::references::PathGuard::new(target)?;
    source.release_directory();
    target.release_directory();
    source.rename_to(&target, false)
}
pub fn sync_directory(path: &Path) -> HostResult<()> {
    #[cfg(unix)]
    {
        crate::files::references::open_directory(path)?
            .sync_all()
            .map_err(io_error)?;
    }
    #[cfg(windows)]
    {
        let _ = path;
    }
    Ok(())
}
pub fn fingerprint(path: &Path) -> HostResult<Digest> {
    crate::files::references::validate_path(path, false)?;
    let mut names = fs::read_dir(path)
        .map_err(io_error)?
        .map(|e| e.map(|e| e.path()).map_err(io_error))
        .collect::<HostResult<Vec<_>>>()?;
    names.sort();
    let mut hash = Sha256::new();
    hash.update(crate::files::references::directory_identity(path)?.as_bytes());
    for name in names {
        let file_name = name
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(corrupt)?;
        if file_name.starts_with('.') {
            continue;
        }
        let mut file = open_read(&name)?;
        hash.update(file_name.as_bytes());
        hash.update(crate::files::references::file_identity(&file)?.as_bytes());
        hash.update(file.metadata().map_err(io_error)?.len().to_le_bytes());
        hash.update(hash_file(&mut file)?.as_str().as_bytes());
    }
    Digest::try_from(format!("{:x}", hash.finalize()).as_str())
}
pub fn record_time(record: &CaptureRecord) -> Option<u64> {
    if let CaptureEntry::Event(event) = &record.entry {
        Some(event.time.source_mono_ns.get())
    } else {
        None
    }
}
pub fn available_bytes(path: &Path) -> HostResult<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        if unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok(available)
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| corrupt())?;
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
}
