use super::{
    format::*,
    volume_index::{self, VolumeIndexReader},
};
use serial_workbench_core::*;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
};
#[derive(Default)]
struct RedactionBounds {
    event_position: u64,
    rx_line_end: Option<U64>,
    tx_line_end: Option<U64>,
}

pub struct VerifiedCapture {
    pub report: VerificationReport,
    pub summary: CaptureSummary,
    pub(crate) manifest: Manifest,
    pub(crate) format: CaptureFormat,
    pub(crate) index: CaptureIndex,
    pub(crate) settlements: HashSet<SettlementKey>,
    pub(crate) source_sequences: HashMap<SourceIdentity, u64>,
    pub(crate) record_digests: Vec<[u8; 32]>,
    pub(crate) mixed_source_clocks: bool,
    pub(crate) last_recorded_ns: Option<u64>,
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
        self.read_verified_stored(position)
            .map(|(record, _, _)| record)
    }
    pub(crate) fn read_verified_record_bytes(
        &mut self,
        position: usize,
    ) -> HostResult<(CaptureRecord, Vec<u8>)> {
        self.read_verified_stored(position)
            .map(|(record, _, json)| (record, json))
    }

    pub(crate) fn read_verified_stored(
        &mut self,
        position: usize,
    ) -> HostResult<(CaptureRecord, Option<u64>, Vec<u8>)> {
        let location = self.index.records.get(position).ok_or_else(changed)?;
        let file = self
            .volume_files
            .get_mut(&location.volume.get())
            .ok_or_else(changed)?;
        let (record, observed, json) = read_record_from(file, location, self.format)?;
        if self.record_digests.get(position) != Some(&record_digest(observed, &json)) {
            return Err(changed());
        }
        Ok((record, observed, json))
    }
}
/// Trusted synchronous observation points for deterministic copy fault injection.
pub(crate) enum CopyPhase {
    BeforeRecord,
    AfterRecord,
}
pub fn verify_directory(path: &Path) -> HostResult<VerifiedCapture> {
    scan_directory(path, false, None)
}

pub(super) fn index_replay_directory(
    path: &Path,
    interactive_budget: Option<u64>,
) -> HostResult<VerifiedCapture> {
    scan_directory(path, true, interactive_budget)
}

fn scan_directory(
    path: &Path,
    rebuild_index: bool,
    interactive_budget: Option<u64>,
) -> HostResult<VerifiedCapture> {
    let before = fingerprint_with_budget(path, interactive_budget)?;
    let value: serde_json::Value =
        read_json_with_budget(&path.join("manifest.json"), interactive_budget)?;
    let format = CaptureFormat::from_version(value.get("formatVersion").and_then(|v| v.as_str()))?;
    let manifest: Manifest = serde_json::from_value(value).map_err(|_| corrupt())?;
    if manifest.mode != format.mode()
        || (format == CaptureFormat::Redacted) != manifest.redaction_digest.is_some()
    {
        return Err(corrupt());
    }
    let indexed = format == CaptureFormat::Indexed;
    let stored_index = if rebuild_index || indexed {
        None
    } else {
        read_json::<CaptureIndex>(&path.join("index.json"))
            .ok()
            .filter(|index| {
                index.format_version == format.version()
                    && index.records.len() <= format.max_records()
            })
    };
    let index_available = rebuild_index || indexed || stored_index.is_some();
    let mut index = stored_index.unwrap_or(CaptureIndex {
        format_version: format.version().into(),
        records: vec![],
    });
    let mut prefix = 0u64;
    let mut all = index_available;
    let mut continuous = true;
    let mut volumes = Vec::new();
    let mut previous = zero_digest();
    let mut settled = HashSet::new();
    let mut pending = HashSet::new();
    let mut sequences: HashMap<SourceIdentity, u64> = HashMap::new();
    let mut redaction_bounds: HashMap<SourceIdentity, RedactionBounds> = HashMap::new();
    let mut record_digests = Vec::new();
    let mut first_clock = None;
    let mut mixed_source_clocks = false;
    let mut last_recorded_ns = None;
    let mut volume_identities = HashMap::new();
    let mut volume_bytes_left = interactive_budget;
    for (position, volume) in manifest.volumes.iter().enumerate() {
        if !all {
            break;
        }
        let ordinal = position as u64 + 1;
        let id = Id::try_from(format!("volume-{ordinal:06}").as_str())?;
        if volume.ordinal.get() != ordinal
            || volume.record_start.get() != prefix + 1
            || volume.record_end < volume.record_start
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
        let file = match open_read(&path.join(volume_name(ordinal))) {
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
        let opened_length = file.metadata().map_err(io_error)?.len();
        if let Some(remaining) = &mut volume_bytes_left {
            *remaining = remaining
                .checked_sub(opened_length)
                .ok_or_else(super::recorded_peer::limit)?;
        }
        volume_identities.insert(
            ordinal,
            (
                crate::files::references::file_identity(&file)?,
                opened_length,
            ),
        );
        let mut reader = BufReader::new(file.take(opened_length));
        if reader.read_exact(&mut magic).is_err() || &magic != format.magic() {
            all = false;
        }
        let mut volume_index = if indexed && !rebuild_index {
            match VolumeIndexReader::open(path, ordinal) {
                Ok(index) => Some(index),
                Err(_) => {
                    all = false;
                    None
                }
            }
        } else {
            None
        };
        let mut offset = 7u64;
        while all && prefix + 1 < volume.record_end.get() {
            if interactive_budget.is_some() && prefix >= super::recorded_peer::MAX_RECORDS as u64 {
                return Err(super::recorded_peer::limit());
            }
            if prefix >= format.max_records() as u64 {
                all = false;
                break;
            }
            let record_start = offset;
            let decoded = decode_record(&mut reader, format);
            let (record, observed, length, json) = match decoded {
                Ok(r) => r,
                Err(_) => {
                    all = false;
                    break;
                }
            };
            if record.record_ordinal.get() != prefix + 1
                || observed
                    .is_some_and(|value| last_recorded_ns.map_or(value != 0, |last| value < last))
            {
                all = false;
                break;
            }
            let expected = IndexEntry {
                record_ordinal: record.record_ordinal,
                volume: ordinal.into(),
                offset: record_start.into(),
                length: length.into(),
            };
            if !rebuild_index {
                let matches = if let Some(volume_index) = &mut volume_index {
                    volume_index.check(&expected).is_ok()
                } else {
                    index.records.get(prefix as usize) == Some(&expected)
                };
                if !matches {
                    all = false;
                    break;
                }
            }
            if format.validate_entry(&record.entry).is_err() {
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
            continuous &= !breaks_continuity(&record.entry);
            match &record.entry {
                CaptureEntry::Redacted(record) => {
                    let bounds = redaction_bounds.entry(source).or_default();
                    bounds.event_position = bounds.event_position.max(record.event_end.get() - 1);
                    if let Some(range) = &record.byte_range {
                        let line_end = match range.direction {
                            Direction::Rx => &mut bounds.rx_line_end,
                            Direction::Tx => &mut bounds.tx_line_end,
                        };
                        *line_end = matches!(&record.result, CaptureRedactedResult::Text { .. })
                            .then_some(range.end);
                    }
                }
                CaptureEntry::Event(event) => {
                    let (host, epoch, clock) = first_clock.get_or_insert_with(|| {
                        (
                            event.host_id.clone(),
                            event.instance_epoch,
                            event.time.clock_id.clone(),
                        )
                    });
                    mixed_source_clocks |= *host != event.host_id
                        || *epoch != event.instance_epoch
                        || *clock != event.time.clock_id;
                    let key = source.clone();
                    if let Some(last) = sequences.insert(key, event.event_seq.get())
                        && event.event_seq.get() != last + 1
                    {
                        continuous = false;
                        all = false;
                        break;
                    }
                    match &event.payload {
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
                CaptureEntry::ReaderGap(gap) if format == CaptureFormat::Redacted => {
                    if gap.missing_event_range.end <= gap.missing_event_range.start {
                        all = false;
                        break;
                    }
                    let bounds = redaction_bounds.entry(source).or_default();
                    bounds.event_position = bounds
                        .event_position
                        .max(gap.missing_event_range.end.get() - 1);
                    bounds.rx_line_end = None;
                    bounds.tx_line_end = None;
                }
                CaptureEntry::ReaderGap(gap) => {
                    sequences.insert(source, gap.missing_event_range.end.get().saturating_sub(1));
                }
            }
            if rebuild_index || indexed {
                index.records.push(expected);
            }
            last_recorded_ns = observed;
            record_digests.push(record_digest(observed, &json));
            prefix += 1;
            offset += length;
        }
        if let Some(index) = &mut volume_index {
            all &= index.at_end().unwrap_or(false);
        }
        let mut file = reader.into_inner().into_inner();
        let length = file.metadata().map_err(io_error)?.len();
        let hash = if interactive_budget.is_some() {
            hash_file_bounded(&mut file, opened_length)?
        } else {
            hash_file(&mut file)?
        };
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
    if indexed {
        all &= volume_index::only_declared_files(path, manifest.volumes.len() as u64)?;
    }
    let w = &manifest.watermarks;
    if !(w.verified <= w.synced && w.synced <= w.flushed && w.flushed <= w.written) {
        all = false
    }
    if manifest.source_continuous != continuous {
        all = false
    }
    if let Some(positions) = &manifest.redaction_resume {
        all &= format == CaptureFormat::Redacted
            && manifest.state == CaptureState::Complete
            && positions.len() == manifest.streams.len()
            && manifest
                .streams
                .iter()
                .zip(positions)
                .all(|(stream, position)| {
                    let known = redaction_bounds.get(&SourceIdentity::source(stream));
                    position.event_position.get() >= known.map_or(0, |bounds| bounds.event_position)
                        && position.rx.is_none_or(|end| {
                            Some(end.byte_end) == known.and_then(|bounds| bounds.rx_line_end)
                        })
                        && position.tx.is_none_or(|end| {
                            Some(end.byte_end) == known.and_then(|bounds| bounds.tx_line_end)
                        })
                });
    }
    let after = fingerprint_with_budget(path, interactive_budget)?;
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
        mode: manifest.mode,
        verification_id: Id::try_from(format!("verification-{}", uuid::Uuid::new_v4()).as_str())?,
        source_fingerprint: after,
        verified_prefix: prefix.into(),
        volume_results: volumes,
        recoverable: index_available && (prefix > 0 || all),
        container_complete: all,
        source_continuous: continuous,
        unsettled_operations: pending,
    };
    let mut watermarks = manifest.watermarks.clone();
    watermarks.verified = watermarks.verified.min(prefix.into());
    let summary = CaptureSummary {
        mode: manifest.mode,
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
        format,
        index,
        settlements: settled,
        source_sequences: sequences,
        record_digests,
        mixed_source_clocks,
        last_recorded_ns,
        volume_identities,
        volume_files: HashMap::new(),
    })
}
fn decode_record(
    file: &mut impl Read,
    format: CaptureFormat,
) -> HostResult<(CaptureRecord, Option<u64>, u64, Vec<u8>)> {
    let mut size = [0; 4];
    file.read_exact(&mut size).map_err(|_| corrupt())?;
    let len = u32::from_le_bytes(size) as usize;
    if len == 0 || len > MAX_RECORD {
        return Err(corrupt());
    }
    let observed = if format.uses_recorder_clock() {
        let mut time = [0; 8];
        file.read_exact(&mut time).map_err(|_| corrupt())?;
        Some(u64::from_le_bytes(time))
    } else {
        None
    };
    let mut bytes = vec![0; len];
    file.read_exact(&mut bytes).map_err(|_| corrupt())?;
    let mut hash = [0; 32];
    file.read_exact(&mut hash).map_err(|_| corrupt())?;
    if hash != record_digest(observed, &bytes) {
        return Err(corrupt());
    }
    let record = serde_json::from_slice(&bytes).map_err(|_| corrupt())?;
    let time_length = if observed.is_some() { 8 } else { 0 };
    Ok((record, observed, len as u64 + 36 + time_length, bytes))
}
pub(crate) fn read_record_bytes(
    path: &Path,
    location: &IndexEntry,
    format: CaptureFormat,
) -> HostResult<(CaptureRecord, Option<u64>, Vec<u8>)> {
    let mut file = open_read(&path.join(volume_name(location.volume.get())))?;
    read_record_from(&mut file, location, format)
}
fn read_record_from(
    file: &mut File,
    location: &IndexEntry,
    format: CaptureFormat,
) -> HostResult<(CaptureRecord, Option<u64>, Vec<u8>)> {
    file.seek(SeekFrom::Start(location.offset.get()))
        .map_err(io_error)?;
    let (record, observed, len, json) = decode_record(file, format)?;
    if record.record_ordinal != location.record_ordinal || len != location.length.get() {
        return Err(corrupt());
    }
    Ok((record, observed, json))
}
