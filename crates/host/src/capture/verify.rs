use super::format::*;
use serial_workbench_core::*;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
pub struct VerifiedCapture {
    pub report: VerificationReport,
    pub summary: CaptureSummary,
    pub(crate) manifest: Manifest,
    pub(crate) index: CaptureIndex,
    pub(crate) settlements: HashSet<SettlementKey>,
    pub(crate) source_sequences: HashMap<SourceIdentity, u64>,
    pub(crate) record_digests: Vec<[u8; 32]>,
    volume_identities: HashMap<u64, (String, u64)>,
    volume_files: HashMap<u64, File>,
}
impl VerifiedCapture {
    /// Bind actual source files only while consuming a snapshot. A report alone
    /// must not prevent a settled container from being archived on Windows.
    pub(crate) fn bind_files(&mut self, path: &Path) -> HostResult<()> {
        if fingerprint(path)? != self.report.source_fingerprint {
            return Err(changed());
        }
        let mut files = HashMap::new();
        for (&ordinal, (identity, length)) in &self.volume_identities {
            let file = open_read(&path.join(volume_name(ordinal)))?;
            if crate::files::references::file_identity(&file)? != *identity
                || file.metadata().map_err(io_error)?.len() != *length
            {
                return Err(changed());
            }
            files.insert(ordinal, file);
        }
        if fingerprint(path)? != self.report.source_fingerprint {
            return Err(changed());
        }
        self.volume_files = files;
        Ok(())
    }
    pub(crate) fn read_verified_record(&mut self, position: usize) -> HostResult<CaptureRecord> {
        self.read_verified_record_bytes(position)
            .map(|(record, _)| record)
    }
    pub(crate) fn read_verified_record_bytes(
        &mut self,
        position: usize,
    ) -> HostResult<(CaptureRecord, Vec<u8>)> {
        let location = self.index.records.get(position).ok_or_else(changed)?;
        let file = self
            .volume_files
            .get_mut(&location.volume.get())
            .ok_or_else(changed)?;
        let (record, json) = read_record_from(file, location)?;
        if self.record_digests.get(position) != Some(&json_digest(&json)) {
            return Err(changed());
        }
        Ok((record, json))
    }
}
/// Trusted synchronous observation points for deterministic copy fault injection.
pub(crate) enum CopyPhase {
    BeforeRecord,
    AfterRecord,
}
pub fn verify_directory(path: &Path) -> HostResult<VerifiedCapture> {
    let before = fingerprint(path)?;
    let value: serde_json::Value = read_json(&path.join("manifest.json"))?;
    if value.get("formatVersion").and_then(|v| v.as_str()) != Some("0.1") {
        return Err(HostError::new(
            "FUTURE_FORMAT",
            "Capture format is unsupported",
        ));
    }
    let manifest: Manifest = serde_json::from_value(value).map_err(|_| corrupt())?;
    let index = read_json::<CaptureIndex>(&path.join("index.json"))
        .ok()
        .filter(|i| i.format_version == "0.1" && i.records.len() <= 100_000);
    let has_index = index.is_some();
    let index = index.unwrap_or(CaptureIndex {
        format_version: "0.1".into(),
        records: vec![],
    });
    let mut prefix = 0u64;
    let mut all = has_index;
    let mut continuous = true;
    let mut volumes = Vec::new();
    let mut previous = zero_digest();
    let mut settled = HashSet::new();
    let mut pending = HashSet::new();
    let mut sequences: HashMap<SourceIdentity, u64> = HashMap::new();
    let mut record_digests = Vec::new();
    let mut volume_identities = HashMap::new();
    for (position, volume) in manifest.volumes.iter().enumerate() {
        if !all {
            break;
        }
        let ordinal = position as u64 + 1;
        let id = Id::try_from(format!("volume-{ordinal:06}").as_str())?;
        if volume.ordinal.get() != ordinal
            || volume.record_start.get() != prefix + 1
            || volume.previous_digest != previous
        {
            all = false;
            volumes.push(CaptureVolumeResult {
                volume_id: id,
                status: CaptureVolumeStatus::Corrupt,
                verified_prefix: prefix.into(),
            });
            break;
        }
        let mut file = match open_read(&path.join(volume_name(ordinal))) {
            Ok(f) => f,
            Err(_) => {
                all = false;
                volumes.push(CaptureVolumeResult {
                    volume_id: id,
                    status: CaptureVolumeStatus::Missing,
                    verified_prefix: prefix.into(),
                });
                break;
            }
        };
        let mut magic = [0; 7];
        volume_identities.insert(
            ordinal,
            (
                crate::files::references::file_identity(&file)?,
                file.metadata().map_err(io_error)?.len(),
            ),
        );
        if file.read_exact(&mut magic).is_err() || &magic != MAGIC {
            all = false;
        }
        let mut offset = 7u64;
        while all && prefix + 1 < volume.record_end.get() {
            let record_start = offset;
            let (record, length, json) = match decode_record(&mut file) {
                Ok(r) => r,
                Err(_) => {
                    all = false;
                    break;
                }
            };
            if record.record_ordinal.get() != prefix + 1 {
                all = false;
                break;
            }
            let expected = IndexEntry {
                record_ordinal: record.record_ordinal,
                volume: ordinal.into(),
                offset: record_start.into(),
                length: length.into(),
            };
            if index.records.get(prefix as usize) != Some(&expected) {
                all = false;
                break;
            }
            let source = match validate_entry_source(&record.entry, &manifest.streams) {
                Ok(source) => source,
                Err(_) => {
                    all = false;
                    break;
                }
            };
            match &record.entry {
                CaptureEntry::Event(event) => {
                    let key = source.clone();
                    if let Some(last) = sequences.insert(key, event.event_seq.get())
                        && event.event_seq.get() != last + 1
                    {
                        continuous = false;
                        all = false;
                        break;
                    }
                    match &event.payload {
                        RawPayload::Gap(_) => continuous = false,
                        RawPayload::TxIntent(intent) => {
                            pending.insert(SettlementKey::intent(source, intent));
                        }
                        RawPayload::Tx(receipt) => {
                            let key = SettlementKey::receipt(source, receipt);
                            if !settled.insert(key.clone()) {
                                all = false;
                                break;
                            }
                            pending.remove(&key);
                        }
                        _ => {}
                    }
                }
                CaptureEntry::TxSettlement(receipt) => {
                    let key = SettlementKey::receipt(source, &receipt.receipt);
                    if !settled.insert(key.clone()) {
                        all = false;
                        break;
                    }
                    pending.remove(&key);
                }
                CaptureEntry::ReaderGap(gap) => {
                    continuous = false;
                    sequences.insert(source, gap.missing_event_range.end.get().saturating_sub(1));
                }
            }
            record_digests.push(json_digest(&json));
            prefix += 1;
            offset += length;
        }
        let length = file.metadata().map_err(io_error)?.len();
        let hash = hash_file(&mut file)?;
        if offset != length || length != volume.length.get() || hash != volume.digest {
            all = false
        }
        previous = hash;
        volumes.push(CaptureVolumeResult {
            volume_id: id,
            status: if all {
                CaptureVolumeStatus::Verified
            } else {
                CaptureVolumeStatus::Corrupt
            },
            verified_prefix: prefix.into(),
        });
    }
    if manifest.volumes.is_empty()
        || prefix as usize != index.records.len()
        || prefix != manifest.watermarks.written.get()
    {
        all = false
    }
    let w = &manifest.watermarks;
    if !(w.verified <= w.synced && w.synced <= w.flushed && w.flushed <= w.written) {
        all = false
    }
    if manifest.source_continuous != continuous {
        all = false
    }
    let after = fingerprint(path)?;
    if before != after {
        return Err(changed());
    }
    let mut pending: Vec<_> = pending
        .into_iter()
        .map(|key| key.operation_id)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    pending.sort();
    let report = VerificationReport {
        verification_id: Id::try_from(format!("verification-{}", uuid::Uuid::new_v4()).as_str())?,
        source_fingerprint: after,
        verified_prefix: prefix.into(),
        volume_results: volumes,
        recoverable: has_index && (prefix > 0 || all),
        container_complete: all,
        source_continuous: continuous,
        unsettled_operations: pending,
    };
    let mut watermarks = manifest.watermarks.clone();
    watermarks.verified = watermarks.verified.min(prefix.into());
    let summary = CaptureSummary {
        capture_id: manifest.capture_id.clone(),
        state: if all {
            manifest.state
        } else {
            CaptureState::Incomplete
        },
        watermarks,
        container_complete: all,
        source_continuous: continuous,
        source_fingerprint: Some(report.source_fingerprint.clone()),
    };
    Ok(VerifiedCapture {
        report,
        summary,
        manifest,
        index,
        settlements: settled,
        source_sequences: sequences,
        record_digests,
        volume_identities,
        volume_files: HashMap::new(),
    })
}
pub(crate) fn json_digest(json: &[u8]) -> [u8; 32] {
    use sha2::{Digest as _, Sha256};
    Sha256::digest(json).into()
}
fn decode_record(file: &mut File) -> HostResult<(CaptureRecord, u64, Vec<u8>)> {
    let mut size = [0; 4];
    file.read_exact(&mut size).map_err(|_| corrupt())?;
    let len = u32::from_le_bytes(size) as usize;
    if len == 0 || len > MAX_RECORD {
        return Err(corrupt());
    }
    let mut bytes = vec![0; len];
    file.read_exact(&mut bytes).map_err(|_| corrupt())?;
    let mut hash = [0; 32];
    file.read_exact(&mut hash).map_err(|_| corrupt())?;
    use sha2::{Digest as _, Sha256};
    let actual: [u8; 32] = Sha256::digest(&bytes).into();
    if hash != actual {
        return Err(corrupt());
    }
    let record = serde_json::from_slice(&bytes).map_err(|_| corrupt())?;
    Ok((record, len as u64 + 36, bytes))
}
pub(crate) fn read_record_bytes(
    path: &Path,
    location: &IndexEntry,
) -> HostResult<(CaptureRecord, Vec<u8>)> {
    let mut file = open_read(&path.join(volume_name(location.volume.get())))?;
    read_record_from(&mut file, location)
}
fn read_record_from(
    file: &mut File,
    location: &IndexEntry,
) -> HostResult<(CaptureRecord, Vec<u8>)> {
    file.seek(SeekFrom::Start(location.offset.get()))
        .map_err(io_error)?;
    let (record, len, json) = decode_record(file)?;
    if record.record_ordinal != location.record_ordinal || len != location.length.get() {
        return Err(corrupt());
    }
    Ok((record, json))
}
