use super::{
    Control, NodePackageLimits, NodePackageSource, VerifiedNodePackage, invalid, limit,
    paths::PackagePaths, source::verify_source,
};
use serial_workbench_core::{
    Digest, HostResult, parse_node_integrity, parse_node_manifest, parse_node_signature,
    validate_node_package_metadata,
};
use sha2::{Digest as _, Sha256};
use std::{
    collections::BTreeMap,
    io::{self, Cursor, Read, Seek, SeekFrom},
    sync::atomic::AtomicBool,
};
use zip::{
    CompressionMethod, ZipArchive,
    read::{ArchiveOffset, Config},
};

struct Entry {
    index: usize,
    size: u64,
}
struct GuardedReader<'a, 'b> {
    cursor: Cursor<&'a [u8]>,
    control: &'b Control<'b>,
}
impl Read for GuardedReader<'_, '_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.control.check().map_err(io::Error::other)?;
        self.cursor.read(buffer)
    }
}
impl Seek for GuardedReader<'_, '_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.control.check().map_err(io::Error::other)?;
        self.cursor.seek(position)
    }
}

/// 只读验证，不解包或执行。调用方须在有界后台任务中运行并等待真实退出。
pub fn verify_node_package(
    bytes: Vec<u8>,
    source: NodePackageSource<'_>,
    limits: &NodePackageLimits,
    cancel: &AtomicBool,
) -> HostResult<VerifiedNodePackage> {
    let control = Control::new(cancel, limits.timeout)?;
    control.check()?;
    if bytes.len() as u64 > limits.max_archive_bytes {
        return Err(limit("archiveBytes"));
    }
    let count = preflight_zip32(&bytes, limits)?;
    let reader = GuardedReader {
        cursor: Cursor::new(bytes.as_slice()),
        control: &control,
    };
    let mut archive = control.checked(
        ZipArchive::with_config(
            Config {
                archive_offset: ArchiveOffset::Known(0),
            },
            reader,
        ),
        "invalidArchive",
    )?;
    if archive.len() != count || archive.has_duplicate_names() {
        return Err(invalid("duplicateOrInconsistentEntries"));
    }
    let entries = inspect_entries(&archive, limits, &control)?;
    control.checked(
        archive.validate_header_consistency(),
        "inconsistentArchiveHeaders",
    )?;

    let raw_manifest = read_metadata(
        &mut archive,
        &entries,
        "manifest.json",
        limits.max_metadata_bytes,
        &control,
    )?;
    let raw_integrity = read_metadata(
        &mut archive,
        &entries,
        "integrity.json",
        limits.max_metadata_bytes,
        &control,
    )?;
    let manifest = parse_node_manifest(&raw_manifest)?;
    let integrity = parse_node_integrity(&raw_integrity)?;
    validate_node_package_metadata(&manifest, &integrity)?;
    let signature = if entries.contains_key("signature.json") {
        let raw = read_metadata(
            &mut archive,
            &entries,
            "signature.json",
            limits.max_metadata_bytes.min(8192),
            &control,
        )?;
        Some(parse_node_signature(&raw)?)
    } else {
        None
    };
    control.check()?;
    let verified_source = verify_source(source, &integrity, &raw_integrity, signature.as_ref())?;
    if entries.len() != integrity.files.len() + 1 + usize::from(signature.is_some()) {
        return Err(invalid("unlistedOrMissingPayload"));
    }
    for expected in &integrity.files {
        control.check()?;
        let entry = entries
            .get(expected.path.as_str())
            .ok_or_else(|| invalid("missingPayload"))?;
        if expected.size.get() != entry.size {
            return Err(invalid("payloadSizeMismatch"));
        }
        let mut file = control.checked(archive.by_index(entry.index), "payloadRead")?;
        let mut hasher = Sha256::new();
        read_bounded(&mut file, entry.size, &control, |chunk| {
            hasher.update(chunk);
        })?;
        if format!("{:x}", hasher.finalize()) != expected.sha256.as_str() {
            return Err(invalid("payloadDigestMismatch"));
        }
    }
    drop(archive);
    let mut hasher = Sha256::new();
    for chunk in bytes.chunks(64 * 1024) {
        control.check()?;
        hasher.update(chunk);
    }
    let archive_sha256 = Digest::try_from(format!("{:x}", hasher.finalize()).as_str())?;
    control.check()?;
    Ok(VerifiedNodePackage {
        bytes,
        manifest,
        integrity,
        archive_sha256,
        verified_source,
    })
}

fn inspect_entries<R: Read + Seek>(
    archive: &ZipArchive<R>,
    limits: &NodePackageLimits,
    control: &Control<'_>,
) -> HostResult<BTreeMap<String, Entry>> {
    let mut paths = PackagePaths::default();
    let mut entries = BTreeMap::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        control.check()?;
        let entry = archive
            .by_index_data(index)
            .map_err(|_| invalid("entryMetadata"))?;
        let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
        let raw_mode = (entry.external_attributes() >> 16) & 0o170000;
        let directory = entry.is_dir();
        if entry.encrypted()
            || entry.is_symlink()
            || entry.external_attributes() & 0x400 != 0
            || (mode != 0 && mode != if directory { 0o040000 } else { 0o100000 })
            // DOS 创建标记会让库忽略 Unix 高位；不能让同一归档在不同解包器下变成链接。
            || (raw_mode != 0 && raw_mode != if directory { 0o040000 } else { 0o100000 })
            || !matches!(
                entry.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            )
            || entry.version_needed() > 20
        {
            return Err(invalid("unsupportedEntryType"));
        }
        let name = paths.add(
            entry.name_raw(),
            directory,
            limits.max_path_bytes,
            limits.max_files,
        )?;
        let decoded = entry.name().map_err(|_| invalid("entryEncoding"))?;
        let original =
            std::str::from_utf8(entry.name_raw()).map_err(|_| invalid("entryEncoding"))?;
        if decoded != original {
            return Err(invalid("ambiguousEntryEncoding"));
        }
        if directory {
            if entry.size() != 0 {
                return Err(invalid("directoryPayload"));
            }
            continue;
        }
        if entry.size() > limits.max_file_bytes {
            return Err(limit("fileBytes"));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| limit("expandedBytes"))?;
        if total > limits.max_total_bytes {
            return Err(limit("expandedBytes"));
        }
        if entries
            .insert(
                name,
                Entry {
                    index,
                    size: entry.size(),
                },
            )
            .is_some()
        {
            return Err(invalid("duplicateEntry"));
        }
    }
    Ok(entries)
}

fn read_metadata<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entries: &BTreeMap<String, Entry>,
    name: &str,
    cap: usize,
    control: &Control<'_>,
) -> HostResult<Vec<u8>> {
    let entry = entries
        .get(name)
        .ok_or_else(|| invalid("missingMetadata"))?;
    if entry.size > cap as u64 {
        return Err(limit("metadataBytes"));
    }
    let mut bytes = Vec::with_capacity(entry.size as usize);
    let mut file = control.checked(archive.by_index(entry.index), "metadataRead")?;
    read_bounded(&mut file, entry.size, control, |chunk| {
        bytes.extend_from_slice(chunk)
    })?;
    Ok(bytes)
}

fn read_bounded(
    reader: &mut impl Read,
    expected: u64,
    control: &Control<'_>,
    mut consume: impl FnMut(&[u8]),
) -> HostResult<()> {
    let mut buffer = [0u8; 32 * 1024];
    let mut total = 0u64;
    loop {
        control.check()?;
        let count = control.checked(reader.read(&mut buffer), "invalidPayload")?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or_else(|| limit("expandedBytes"))?;
        if total > expected {
            return Err(limit("undeclaredExpandedBytes"));
        }
        consume(&buffer[..count]);
    }
    if total != expected {
        return Err(invalid("payloadSizeMismatch"));
    }
    Ok(())
}

/// v0 的条目/字节预算不需要 ZIP64。先限制 EOCD，避免库按恶意 u64 条目数预分配。
/// 库仍负责全部 ZIP 解析、CRC、重复名称、局部头/中央目录一致性及条目重叠验证。
fn preflight_zip32(bytes: &[u8], limits: &NodePackageLimits) -> HostResult<usize> {
    if bytes.len() < 22 {
        return Err(invalid("invalidArchive"));
    }
    let mut count = None;
    let start = bytes.len().saturating_sub(65_535 + 22);
    for position in start..=bytes.len() - 22 {
        if &bytes[position..position + 4] != b"PK\x05\x06" {
            continue;
        }
        let end = &bytes[position..position + 22];
        let u16_at = |offset| u16::from_le_bytes([end[offset], end[offset + 1]]);
        let u32_at =
            |offset| u32::from_le_bytes(end[offset..offset + 4].try_into().expect("EOCD field"));
        if u16_at(8) == u16::MAX
            || u16_at(10) == u16::MAX
            || u32_at(12) == u32::MAX
            || u32_at(16) == u32::MAX
            || position >= 20 && &bytes[position - 20..position - 16] == b"PK\x06\x07"
        {
            return Err(invalid("zip64NotSupported"));
        }
        if position + 22 + u16_at(20) as usize != bytes.len() {
            continue;
        }
        if u16_at(4) != 0 || u16_at(6) != 0 || u16_at(8) != u16_at(10) {
            return Err(invalid("multiDiskArchive"));
        }
        let entries = u16_at(10) as usize;
        if entries > limits.max_files {
            return Err(limit("entryCount"));
        }
        if u32_at(12) > 16 * 1024 * 1024 {
            return Err(limit("centralDirectoryBytes"));
        }
        if u64::from(u32_at(12)) + u64::from(u32_at(16)) != position as u64 {
            return Err(invalid("archiveLayout"));
        }
        if count.replace(entries).is_some() {
            return Err(invalid("ambiguousArchiveEnd"));
        }
    }
    count.ok_or_else(|| invalid("invalidArchiveEnd"))
}
