use super::format::*;
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
        Self {
            volume_bytes: 64 * 1024 * 1024,
            volume_duration_ns: 60 * 60 * 1_000_000_000,
            capacity_bytes: 1024 * 1024 * 1024,
            reserve_bytes: 128 * 1024 * 1024,
            max_records: 100_000,
        }
    }
}
pub struct CaptureWriter {
    path: PathBuf,
    manifest: Manifest,
    index: CaptureIndex,
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
        mut guard: crate::files::references::PathGuard,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        opener: VolumeOpener,
    ) -> HostResult<Self> {
        guard.create_directory()?;
        let path = guard.checked_path();
        let manifest = Manifest {
            format_version: "0.1".into(),
            capture_id: Id::try_from(format!("capture-{}", uuid::Uuid::new_v4()).as_str())?,
            mode: CaptureMode::Raw,
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
            manifest,
            index: CaptureIndex {
                format_version: "0.1".into(),
                records: vec![],
            },
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
            index_bytes: 128,
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
        Self::append_at_positions(guard, sources, limits, opener, None)
    }
    pub(crate) fn append_at_positions(
        guard: crate::files::references::PathGuard,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        opener: VolumeOpener,
        positions: Option<Vec<U64>>,
    ) -> HostResult<Self> {
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
        if scan.manifest.streams != sources || scan.manifest.mode != CaptureMode::Raw {
            return Err(HostError::new(
                "CONFIGURATION_CONFLICT",
                "Capture source or configuration differs",
            ));
        }
        // 先确定续接证据，再改写 settled manifest；未知旧位置不能猜成连续。
        let mut gaps = Vec::new();
        if let Some(positions) = positions {
            if positions.len() != sources.len() {
                return Err(corrupt());
            }
            for (source, position) in sources.iter().zip(positions) {
                let previous = scan
                    .source_sequences
                    .get(&SourceIdentity::source(source))
                    .ok_or_else(|| {
                        HostError::new(
                            "CAPTURE_INCOMPLETE",
                            "Append requires a recorded source position",
                        )
                    })?;
                if position.get() < *previous {
                    return Err(changed());
                }
                if position.get() > *previous {
                    gaps.push(CaptureEntry::ReaderGap(Box::new(ReaderGap {
                        host_id: source.host_id.clone(),
                        instance_epoch: source.instance_epoch,
                        session_id: source.session_id.clone(),
                        session_epoch: source.session_epoch,
                        reason: ReaderGapReason::CapturePaused,
                        missing_event_range: ByteRange {
                            start: U64::from(*previous).checked_next()?,
                            end: position.checked_next()?,
                        },
                        missing_byte_ranges: None,
                    })));
                }
            }
        }
        let mut manifest = scan.manifest;
        manifest.state = CaptureState::Recording;
        let total = manifest.volumes.iter().map(|v| v.length.get()).sum();
        let start = manifest.watermarks.written.get() + 1;
        let index_bytes = serde_json::to_vec(&scan.index)
            .map_err(|_| corrupt())?
            .len() as u64;
        let mut writer = Self {
            path: path.to_path_buf(),
            manifest,
            index: scan.index,
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
            writer.push(gap, 0)?;
        }
        writer.checkpoint()?;
        Ok(writer)
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
        )
    }
    pub(crate) fn replace_at(
        guard: crate::files::references::PathGuard,
        sources: Vec<CaptureSource>,
        limits: CaptureLimits,
        expected: &Digest,
        opener: VolumeOpener,
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
        let mut writer = Self::create_at(candidate, sources, limits, opener)?;
        writer.replacement = Some((guard, expected.clone()));
        Ok(writer)
    }
    fn new_volume(&mut self) -> HostResult<()> {
        let number = self.manifest.volumes.len() as u64 + 1;
        let path = self
            ._guard
            .as_ref()
            .ok_or_else(corrupt)?
            .child(&volume_name(number))?;
        let mut file = (self.opener)(path.create_file()?)?;
        file.write_all(MAGIC).map_err(io_error)?;
        self.volume_hash = Sha256::new();
        self.volume_hash.update(MAGIC);
        self.volume_size = MAGIC.len() as u64;
        self.total += MAGIC.len() as u64;
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
            digest: digest(MAGIC),
            previous_digest: previous,
        });
        self.file = Some(file);
        Ok(())
    }
    pub fn push(&mut self, entry: CaptureEntry, now: u64) -> HostResult<()> {
        let result = self.push_inner(entry, now);
        if let Err(error) = &result {
            self.manifest.state = CaptureState::Failed;
            let _ = self.checkpoint();
            return Err(error.clone());
        }
        result
    }
    fn push_inner(&mut self, entry: CaptureEntry, now: u64) -> HostResult<()> {
        if self.manifest.state != CaptureState::Recording {
            return Err(HostError::new(
                "CAPTURE_INCOMPLETE",
                "Capture is no longer accepting records",
            ));
        }
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
        if json.len() > MAX_RECORD {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Capture record exceeds one MiB",
            ));
        }
        let size = json.len() as u64 + 36;
        if size + MAGIC.len() as u64 > self.limits.volume_bytes {
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
        if self.index.records.len() >= self.limits.max_records
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
        let rotate = self.volume_size > MAGIC.len() as u64
            && (self.volume_size + size > self.limits.volume_bytes
                || self.volume_clock.is_some_and(|start| {
                    now.saturating_sub(start) >= self.limits.volume_duration_ns
                }));
        if rotate {
            self.checkpoint()?;
            self.file.take();
            self.new_volume()?;
        }
        self.volume_clock.get_or_insert(now);
        let offset = self.volume_size;
        let file = self.file.as_mut().ok_or_else(corrupt)?;
        file.write_all(&(json.len() as u32).to_le_bytes())
            .map_err(io_error)?;
        file.write_all(&json).map_err(io_error)?;
        file.write_all(&ShaBytes::of(&json)).map_err(io_error)?;
        self.volume_hash.update((json.len() as u32).to_le_bytes());
        self.volume_hash.update(&json);
        self.volume_hash.update(ShaBytes::of(&json));
        self.volume_size += size;
        self.total += size;
        let location = IndexEntry {
            record_ordinal: ordinal,
            volume: (self.manifest.volumes.len() as u64).into(),
            offset: offset.into(),
            length: size.into(),
        };
        self.index_bytes += serde_json::to_vec(&location).map_err(|_| corrupt())?.len() as u64 + 1;
        self.index.records.push(location);
        self.manifest.watermarks.written = ordinal;
        if let Some(id) = settlement {
            self.settled.insert(id);
        }
        if matches!(&record.entry, CaptureEntry::ReaderGap(_))
            || matches!(&record.entry,CaptureEntry::Event(e) if matches!(e.payload,RawPayload::Gap(_)))
        {
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
        write_json_at(
            &self
                ._guard
                .as_ref()
                .ok_or_else(corrupt)?
                .child("index.json")?,
            &self.index,
        )?;
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
        self.last_verified = None;
        let _ = self.checkpoint();
        self.summary()
    }
    pub fn finish(mut self) -> HostResult<CaptureSummary> {
        self.finish_in_place()
    }
    pub(crate) fn finish_in_place(&mut self) -> HostResult<CaptureSummary> {
        let result = self.finish_inner();
        if result.is_err() {
            self.manifest.state = CaptureState::Failed;
            self.last_verified = None;
            let _ = self.checkpoint();
        }
        result
    }
    fn finish_inner(&mut self) -> HostResult<CaptureSummary> {
        if self.manifest.state == CaptureState::Failed {
            return Ok(self.summary());
        }
        self.manifest.state = CaptureState::Finalizing;
        self.checkpoint()?;
        self.file.take();
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
struct ShaBytes;
impl ShaBytes {
    fn of(bytes: &[u8]) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        Sha256::digest(bytes).into()
    }
}
