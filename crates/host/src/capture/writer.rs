use super::{
    format::*,
    volume_index::{self, VolumeIndexWriter},
};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
/// Trusted Host injection boundary for volume I/O; business requests cannot supply it.
pub trait CaptureVolume: Write + Send {
    fn sync_all(&mut self) -> std::io::Result<()>;
    fn length(&self) -> std::io::Result<u64>;
}
impl CaptureVolume for File {
    fn sync_all(&mut self) -> std::io::Result<()> {
        File::sync_all(self)
    }
    fn length(&self) -> std::io::Result<u64> {
        Ok(self.metadata()?.len())
    }
}
pub type VolumeOpener = Arc<dyn Fn(File) -> HostResult<Box<dyn CaptureVolume>> + Send + Sync>;
pub(crate) fn native_volume_opener() -> VolumeOpener {
    Arc::new(|file| Ok(Box::new(file)))
}
#[derive(Clone)]
pub struct CaptureLimits {
    pub volume_bytes: u64,
    pub volume_duration_ns: u64,
    pub capacity_bytes: u64,
    pub reserve_bytes: u64,
    pub max_records: usize,
}
impl Default for CaptureLimits {
    fn default() -> Self {
        let storage = CaptureStorageLimits::default();
        Self {
            volume_bytes: 64 * 1024 * 1024,
            volume_duration_ns: 60 * 60 * 1_000_000_000,
            capacity_bytes: storage.capacity_bytes.get(),
            reserve_bytes: storage.reserve_bytes.get(),
            max_records: MAX_CAPTURE_RECORDS,
        }
    }
}
pub struct CaptureWriter {
    path: PathBuf,
    format: CaptureFormat,
    timeline: RecorderTimeline,
    manifest: Manifest,
    // Legacy formats retain the JSON index. 0.4 keeps only pending entries.
    index: CaptureIndex,
    volume_index: Option<VolumeIndexWriter>,
    limits: CaptureLimits,
    file: Option<Box<dyn CaptureVolume>>,
    opener: VolumeOpener,
    volume_start: u64,
    volume_size: u64,
    volume_clock: Option<u64>,
    total: u64,
    settled: HashSet<SettlementKey>,
    replacement: Option<(crate::files::references::PathGuard, Digest)>,
    last_verified: Option<Digest>,
    volume_hash: Sha256,
    index_bytes: u64,
    checkpoint_bytes: u64,
    checkpoint_ns: u64,
    _guard: Option<crate::files::references::PathGuard>,
}

#[derive(Default)]
struct RecorderTimeline {
    offset_ns: u64,
    segment: Option<(u64, u64)>,
}

impl RecorderTimeline {
    fn at(&mut self, observed: Option<u64>) -> u64 {
        if let Some(observed) = observed {
            let (origin, base) = *self.segment.get_or_insert((observed, self.offset_ns));
            let elapsed = observed.saturating_sub(origin);
            self.offset_ns = self.offset_ns.max(base.saturating_add(elapsed));
        }
        self.offset_ns
    }
}

impl CaptureWriter {
    pub fn create(
        path: &Path,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
    ) -> HostResult<Self> {
        Self::create_with_storage(path, sources, limits, native_volume_opener())
    }
    pub fn create_with_storage(
        path: &Path,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        opener: VolumeOpener,
    ) -> HostResult<Self> {
        Self::create_at(
            crate::files::references::PathGuard::new(path)?,
            sources,
            limits,
            opener,
        )
    }
    pub(crate) fn create_at(
        guard: crate::files::references::PathGuard,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        opener: VolumeOpener,
    ) -> HostResult<Self> {
        Self::create_at_format(guard, sources, limits, opener, CaptureFormat::Indexed, None)
    }

    pub(crate) fn create_at_format(
        mut guard: crate::files::references::PathGuard,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        opener: VolumeOpener,
        format: CaptureFormat,
        redaction_digest: Option<Digest>,
    ) -> HostResult<Self> {
        if (format == CaptureFormat::Redacted) != redaction_digest.is_some() {
            return Err(corrupt());
        }
        guard.create_directory()?;
        let path = guard.checked_path();
        let manifest = Manifest {
            format_version: format.version().into(),
            capture_id: Id::try_from(format!("capture-{}", uuid::Uuid::new_v4()).as_str())?,
            mode: format.mode(),
            redaction_digest,
            redaction_resume: None,
            streams: sources,
            volumes: vec![],
            state: CaptureState::Recording,
            watermarks: CaptureWatermarks::default(),
            source_continuous: true,
            recovered_from: None,
            verified_prefix: 0.into(),
        };
        let mut writer = Self {
            path: path.to_path_buf(),
            format,
            timeline: RecorderTimeline::default(),
            manifest,
            index: CaptureIndex {
                format_version: format.version().into(),
                records: vec![],
            },
            volume_index: None,
            limits,
            file: None,
            opener,
            volume_start: 1,
            volume_size: 0,
            volume_clock: None,
            total: 0,
            settled: HashSet::new(),
            replacement: None,
            last_verified: None,
            volume_hash: Sha256::new(),
            index_bytes: if format == CaptureFormat::Indexed {
                0
            } else {
                128
            },
            checkpoint_bytes: 0,
            checkpoint_ns: 0,
            _guard: Some(guard),
        };
        writer.new_volume()?;
        writer.checkpoint()?;
        Ok(writer)
    }
    pub fn append(
        path: &Path,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
    ) -> HostResult<Self> {
        Self::append_with_storage(path, sources, limits, native_volume_opener())
    }
    pub fn append_with_storage(
        path: &Path,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        opener: VolumeOpener,
    ) -> HostResult<Self> {
        Self::append_at(
            crate::files::references::PathGuard::new(path)?,
            sources,
            limits,
            opener,
        )
    }
    pub(crate) fn append_at(
        guard: crate::files::references::PathGuard,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        opener: VolumeOpener,
    ) -> HostResult<Self> {
        Self::append_at_positions(guard, sources, limits, opener, None, None)
            .map(|(writer, _)| writer)
    }
    pub(crate) fn append_at_positions(
        guard: crate::files::references::PathGuard,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        opener: VolumeOpener,
        positions: Option<Vec<U64>>,
        redaction_digest: Option<Digest>,
    ) -> HostResult<(Self, Option<Vec<RedactionSourcePosition>>)> {
        let path = guard.checked_path();
        let scan = super::verify::verify_directory(path)?;
        if !scan.report.container_complete
            || !(scan.manifest.state == CaptureState::Complete
                || scan.manifest.state == CaptureState::Incomplete
                    && scan.manifest.recovered_from.is_some())
        {
            return Err(HostError::new(
                "CAPTURE_INCOMPLETE",
                "Append requires a settled, completely verified capture",
            ));
        }
        if scan.manifest.streams != sources || scan.manifest.redaction_digest != redaction_digest {
            return Err(HostError::new(
                "CONFIGURATION_CONFLICT",
                "Capture source, configuration, mode or redaction rules differ",
            ));
        }
        let missing_position = || {
            HostError::new(
                "CAPTURE_INCOMPLETE",
                "Append requires a recorded source position",
            )
        };
        let mut resume = if redaction_digest.is_some() {
            if positions.is_none() {
                return Err(missing_position());
            }
            Some(
                scan.manifest
                    .redaction_resume
                    .clone()
                    .ok_or_else(missing_position)?,
            )
        } else {
            None
        };
        // 先确定续接证据，再改写 settled manifest；未知旧位置不能猜成连续。
        let mut gaps = Vec::new();
        if let Some(positions) = positions {
            if positions.len() != sources.len() {
                return Err(corrupt());
            }
            for (index, (source, position)) in sources.iter().zip(positions).enumerate() {
                let checkpoint = resume
                    .as_mut()
                    .and_then(|positions| positions.get_mut(index));
                let previous = match &checkpoint {
                    Some(value) => value.event_position,
                    None => U64::from(
                        *scan
                            .source_sequences
                            .get(&SourceIdentity::source(source))
                            .ok_or_else(missing_position)?,
                    ),
                };
                if position < previous {
                    return Err(changed());
                }
                if position > previous {
                    if let Some(checkpoint) = checkpoint {
                        *checkpoint = RedactionSourcePosition::without_line_ends(position);
                    }
                    gaps.push(CaptureEntry::ReaderGap(Box::new(ReaderGap {
                        host_id: source.host_id.clone(),
                        instance_epoch: source.instance_epoch,
                        session_id: source.session_id.clone(),
                        session_epoch: source.session_epoch,
                        reason: ReaderGapReason::CapturePaused,
                        missing_event_range: ByteRange {
                            start: previous.checked_next()?,
                            end: position.checked_next()?,
                        },
                        missing_byte_ranges: None,
                    })));
                }
            }
        }
        let mut manifest = scan.manifest;
        manifest.state = CaptureState::Recording;
        manifest.redaction_resume = None;
        let total = manifest.volumes.iter().map(|v| v.length.get()).sum();
        let start = manifest.watermarks.written.get() + 1;
        let mut index = scan.index;
        let index_bytes = if scan.format == CaptureFormat::Indexed {
            let bytes = index.records.len() as u64 * volume_index::ENTRY_BYTES
                + manifest.volumes.len() as u64 * volume_index::HEADER_BYTES;
            index.records = Vec::new();
            bytes
        } else {
            serde_json::to_vec(&index).map_err(|_| corrupt())?.len() as u64
        };
        let mut writer = Self {
            path: path.to_path_buf(),
            format: scan.format,
            timeline: RecorderTimeline {
                offset_ns: scan.last_recorded_ns.unwrap_or_default(),
                segment: None,
            },
            manifest,
            index,
            volume_index: None,
            limits,
            file: None,
            opener,
            volume_start: start,
            volume_size: 0,
            volume_clock: None,
            total,
            settled: scan.settlements,
            replacement: None,
            last_verified: None,
            volume_hash: Sha256::new(),
            index_bytes,
            checkpoint_bytes: total,
            checkpoint_ns: 0,
            _guard: Some(guard),
        };
        writer.new_volume()?;
        for gap in gaps {
            writer.push_observed(gap, 0, None)?;
        }
        writer.checkpoint()?;
        Ok((writer, resume))
    }
    pub fn replace(
        path: &Path,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        expected: &Digest,
    ) -> HostResult<Self> {
        Self::replace_with_storage(path, sources, limits, expected, native_volume_opener())
    }
    pub fn replace_with_storage(
        path: &Path,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        expected: &Digest,
        opener: VolumeOpener,
    ) -> HostResult<Self> {
        Self::replace_at(
            crate::files::references::PathGuard::new(path)?,
            sources,
            limits,
            expected,
            opener,
            None,
        )
    }
    pub(crate) fn replace_at(
        guard: crate::files::references::PathGuard,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        expected: &Digest,
        opener: VolumeOpener,
        redaction_digest: Option<Digest>,
    ) -> HostResult<Self> {
        let path = guard.checked_path();
        let scan = super::verify::verify_directory(path)?;
        if &scan.report.source_fingerprint != expected {
            return Err(changed());
        }
        let candidate = guard.sibling(std::ffi::OsStr::new(&format!(
            ".capture-pending-{}",
            uuid::Uuid::new_v4()
        )))?;
        let mut writer = match redaction_digest {
            Some(digest) => Self::create_at_format(
                candidate,
                sources,
                limits,
                opener,
                CaptureFormat::Redacted,
                Some(digest),
            )?,
            None => Self::create_at(candidate, sources, limits, opener)?,
        };
        writer.replacement = Some((guard, expected.clone()));
        Ok(writer)
    }
    fn new_volume(&mut self) -> HostResult<()> {
        let number = self.manifest.volumes.len() as u64 + 1;
        let directory = self._guard.as_ref().ok_or_else(corrupt)?;
        let path = directory.child(&volume_name(number))?;
        let mut file = (self.opener)(path.create_file()?)?;
        let magic = self.format.magic();
        file.write_all(magic).map_err(io_error)?;
        if self.format == CaptureFormat::Indexed {
            self.volume_index = Some(VolumeIndexWriter::create(directory, number)?);
            self.index_bytes += volume_index::HEADER_BYTES;
        }
        self.volume_hash = Sha256::new();
        self.volume_hash.update(magic);
        self.volume_size = magic.len() as u64;
        self.total += magic.len() as u64;
        self.volume_start = self.manifest.watermarks.written.get() + 1;
        self.volume_clock = None;
        let previous = self
            .manifest
            .volumes
            .last()
            .map(|v| v.digest.clone())
            .unwrap_or_else(zero_digest);
        self.manifest.volumes.push(Volume {
            ordinal: number.into(),
            record_start: self.volume_start.into(),
            record_end: self.volume_start.into(),
            length: self.volume_size.into(),
            digest: digest(magic),
            previous_digest: previous,
        });
        self.file = Some(file);
        Ok(())
    }
    pub fn push(&mut self, entry: CaptureEntry, now: u64) -> HostResult<()> {
        self.push_observed(entry, now, Some(now))
    }

    pub(crate) fn push_observed(
        &mut self,
        entry: CaptureEntry,
        now: u64,
        observed: Option<u64>,
    ) -> HostResult<()> {
        let result = self.push_inner(entry, now, observed);
        if let Err(error) = &result {
            self.manifest.state = CaptureState::Failed;
            let _ = self.checkpoint();
            return Err(error.clone());
        }
        result
    }
    fn push_inner(
        &mut self,
        entry: CaptureEntry,
        now: u64,
        observed: Option<u64>,
    ) -> HostResult<()> {
        if self.manifest.state != CaptureState::Recording {
            return Err(HostError::new(
                "CAPTURE_INCOMPLETE",
                "Capture is no longer accepting records",
            ));
        }
        self.format.validate_entry(&entry)?;
        validate_entry_source(&entry, &self.manifest.streams)?;
        let settlement = SettlementKey::entry(&entry);
        if settlement
            .as_ref()
            .is_some_and(|id| self.settled.contains(id))
        {
            return Err(corrupt());
        }
        let ordinal = self.manifest.watermarks.written.checked_next()?;
        let record = CaptureRecord {
            record_ordinal: ordinal,
            entry,
        };
        let json = serde_json::to_vec(&record).map_err(|_| corrupt())?;
        let recorded = self
            .format
            .uses_recorder_clock()
            .then(|| self.timeline.at(observed));
        let time = recorded.map(u64::to_le_bytes);
        let time_bytes = time.as_ref().map_or(&[][..], |value| value.as_slice());
        if json.len() > MAX_RECORD {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Capture record exceeds one MiB",
            ));
        }
        let size = (json.len() + time_bytes.len()) as u64 + 36;
        if size + self.format.magic().len() as u64 > self.limits.volume_bytes {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Record does not fit in a capture volume",
            ));
        }
        let metadata = serde_json::to_vec(&self.manifest)
            .map_err(|_| corrupt())?
            .len() as u64
            + self.index_bytes
            + 512;
        if self.manifest.watermarks.written.get()
            >= self.limits.max_records.min(self.format.max_records()) as u64
            || self.total.saturating_add(size).saturating_add(metadata) > self.limits.capacity_bytes
            || available_bytes(&self.path)?
                < self
                    .limits
                    .reserve_bytes
                    .saturating_add(size)
                    .saturating_add(metadata)
        {
            return Err(HostError::new(
                "CAPTURE_IO_FAILED",
                "Capture capacity or disk reserve reached",
            ));
        }
        let rotate = self.volume_size > self.format.magic().len() as u64
            && (self.volume_size + size > self.limits.volume_bytes
                || self.volume_clock.is_some_and(|start| {
                    now.saturating_sub(start) >= self.limits.volume_duration_ns
                }));
        if rotate {
            self.checkpoint()?;
            self.file.take();
            self.volume_index.take();
            self.new_volume()?;
        }
        self.volume_clock.get_or_insert(now);
        let offset = self.volume_size;
        let file = self.file.as_mut().ok_or_else(corrupt)?;
        file.write_all(&(json.len() as u32).to_le_bytes())
            .map_err(io_error)?;
        file.write_all(time_bytes).map_err(io_error)?;
        file.write_all(&json).map_err(io_error)?;
        let checksum = record_digest(recorded, &json);
        file.write_all(&checksum).map_err(io_error)?;
        self.volume_hash.update((json.len() as u32).to_le_bytes());
        self.volume_hash.update(time_bytes);
        self.volume_hash.update(&json);
        self.volume_hash.update(checksum);
        self.volume_size += size;
        self.total += size;
        let location = IndexEntry {
            record_ordinal: ordinal,
            volume: (self.manifest.volumes.len() as u64).into(),
            offset: offset.into(),
            length: size.into(),
        };
        self.index_bytes += if self.format == CaptureFormat::Indexed {
            volume_index::ENTRY_BYTES
        } else {
            serde_json::to_vec(&location).map_err(|_| corrupt())?.len() as u64 + 1
        };
        self.index.records.push(location);
        self.manifest.watermarks.written = ordinal;
        if let Some(id) = settlement {
            self.settled.insert(id);
        }
        if breaks_continuity(&record.entry) {
            self.manifest.source_continuous = false;
        }
        if self.total.saturating_sub(self.checkpoint_bytes) >= 1024 * 1024
            || now.saturating_sub(self.checkpoint_ns) >= 1_000_000_000
        {
            self.checkpoint()?;
            self.checkpoint_ns = now;
        }
        Ok(())
    }
    pub(crate) fn flush_due(&mut self, now: u64) -> HostResult<()> {
        if self.manifest.watermarks.written > self.manifest.watermarks.synced
            && now.saturating_sub(self.checkpoint_ns) >= 1_000_000_000
        {
            self.checkpoint()?;
            self.checkpoint_ns = now;
        }
        Ok(())
    }
    fn checkpoint(&mut self) -> HostResult<()> {
        if let Some(file) = &mut self.file {
            file.flush().map_err(io_error)?;
            file.sync_all().map_err(io_error)?;
            let length = file.length().map_err(io_error)?;
            let hash =
                Digest::try_from(format!("{:x}", self.volume_hash.clone().finalize()).as_str())?;
            let volume = self.manifest.volumes.last_mut().ok_or_else(corrupt)?;
            volume.record_end = self.manifest.watermarks.written.checked_next()?;
            volume.length = length.into();
            volume.digest = hash;
        }
        let directory = self._guard.as_ref().ok_or_else(corrupt)?;
        if let Some(index) = &mut self.volume_index {
            index.checkpoint(&self.index.records)?;
            self.index.records.clear();
        } else if self.format != CaptureFormat::Indexed {
            write_json_at(&directory.child("index.json")?, &self.index)?;
        }
        let mut candidate = self.manifest.clone();
        candidate.watermarks.flushed = candidate.watermarks.written;
        candidate.watermarks.synced = candidate.watermarks.written;
        write_json_at(
            &self
                ._guard
                .as_ref()
                .ok_or_else(corrupt)?
                .child("manifest.json")?,
            &candidate,
        )?;
        self.manifest = candidate;
        self.checkpoint_bytes = self.total;
        Ok(())
    }
    pub fn summary(&self) -> CaptureSummary {
        CaptureSummary {
            mode: self.manifest.mode,
            capture_id: self.manifest.capture_id.clone(),
            state: self.manifest.state,
            watermarks: self.manifest.watermarks.clone(),
            container_complete: self.manifest.state == CaptureState::Complete,
            source_continuous: self.manifest.source_continuous,
            source_fingerprint: self.last_verified.clone(),
        }
    }
    pub(crate) fn storage_path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn publication_path(&self) -> &Path {
        self.replacement
            .as_ref()
            .map_or(self.path.as_path(), |(path, _)| path.checked_path())
    }
    pub(crate) fn fail(mut self) -> CaptureSummary {
        self.manifest.state = CaptureState::Failed;
        self.manifest.redaction_resume = None;
        self.last_verified = None;
        let _ = self.checkpoint();
        self.summary()
    }
    pub fn finish(mut self) -> HostResult<CaptureSummary> {
        self.finish_in_place(None)
    }
    pub(crate) fn finish_in_place(
        &mut self,
        redaction_resume: Option<Vec<RedactionSourcePosition>>,
    ) -> HostResult<CaptureSummary> {
        let result = self.finish_inner(redaction_resume);
        if result.is_err() {
            self.manifest.state = CaptureState::Failed;
            self.manifest.redaction_resume = None;
            self.last_verified = None;
            let _ = self.checkpoint();
        }
        result
    }
    fn finish_inner(
        &mut self,
        redaction_resume: Option<Vec<RedactionSourcePosition>>,
    ) -> HostResult<CaptureSummary> {
        if self.manifest.state == CaptureState::Failed {
            return Ok(self.summary());
        }
        self.manifest.state = CaptureState::Finalizing;
        self.checkpoint()?;
        self.file.take();
        self.volume_index.take();
        let scan = super::verify::verify_directory(&self.path)?;
        if !scan.report.container_complete
            || scan.report.verified_prefix != self.manifest.watermarks.written
        {
            return Err(HostError::new(
                "CAPTURE_INCOMPLETE",
                "Independent readback did not verify the full capture",
            ));
        }
        self.manifest.watermarks.verified = scan.report.verified_prefix;
        self.manifest.verified_prefix = scan.report.verified_prefix;
        self.manifest.state = CaptureState::Complete;
        self.manifest.redaction_resume = redaction_resume;
        write_json_at(
            &self
                ._guard
                .as_ref()
                .ok_or_else(corrupt)?
                .child("manifest.json")?,
            &self.manifest,
        )?;
        let final_scan = super::verify::verify_directory(&self.path)?;
        if !final_scan.report.container_complete {
            return Err(corrupt());
        }
        self.last_verified = Some(final_scan.report.source_fingerprint);
        if let Some((target, expected)) = &mut self.replacement {
            if fingerprint(target.checked_path())? != *expected {
                return Err(changed());
            }
            let archive = target.sibling(std::ffi::OsStr::new(&format!(
                "capture-archive-{}",
                uuid::Uuid::new_v4()
            )))?;
            target.release_directory();
            let candidate = self._guard.as_mut().ok_or_else(corrupt)?;
            candidate.release_directory();
            target.rename_to(&archive, false).map_err(|mut error| {
                error.message = format!("Capture archive rename: {}", error.message);
                error
            })?;
            if fingerprint(archive.checked_path()).map_err(|mut error| {
                error.message = format!("Capture archive readback: {}", error.message);
                error
            })? != *expected
            {
                return Err(changed());
            }
            candidate.rename_to(target, false).map_err(|mut error| {
                error.message = format!("Capture candidate publish: {}", error.message);
                error
            })?;
            target.sync_parent()?;
        }
        Ok(self.summary())
    }
    pub(crate) fn recover_from(&mut self, fingerprint: Digest) {
        self.manifest.recovered_from = Some(fingerprint)
    }
    pub(crate) fn finish_recovered(mut self) -> HostResult<CaptureSummary> {
        self.checkpoint()?;
        self.file.take();
        self.volume_index.take();
        let scan = super::verify::verify_directory(&self.path)?;
        if !scan.report.container_complete {
            return Err(corrupt());
        }
        self.manifest.state = CaptureState::Incomplete;
        self.manifest.watermarks.verified = scan.report.verified_prefix;
        self.manifest.verified_prefix = scan.report.verified_prefix;
        write_json_at(
            &self
                ._guard
                .as_ref()
                .ok_or_else(corrupt)?
                .child("manifest.json")?,
            &self.manifest,
        )?;
        let final_scan = super::verify::verify_directory(&self.path)?;
        if !final_scan.report.container_complete {
            return Err(corrupt());
        }
        self.last_verified = Some(final_scan.report.source_fingerprint);
        Ok(self.summary())
    }
}
