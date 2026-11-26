use super::{
    format::*,
    verify::{index_replay_directory, read_record_bytes},
};
use serial_workbench_core::*;
use std::path::{Path, PathBuf};

#[path = "search.rs"]
mod search;
#[path = "replay_search_service.rs"]
mod search_service;

/// 纯文件读者；类型不持有设备、TX 仲裁器或 Transport。
pub struct ReplayReader {
    archive: Arc<ReplayArchive>,
    capture_id: Id,
    configuration: SerialConfiguration,
    generation: U64,
    mixed_source_clocks: bool,
    playback: Playback,
}

struct ReplayArchive {
    path: PathBuf,
    format: CaptureFormat,
    index: CaptureIndex,
    record_digests: Vec<[u8; 32]>,
    directory_identity: String,
    _guard: crate::files::references::PathGuard,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReplayReadMode {
    Batch,
    Step,
    Inspect,
}

#[derive(Clone, Copy)]
struct Playback {
    position: usize,
    rate: ReplayRate,
    paused: bool,
    anchor: Option<PlaybackAnchor>,
    last_now: u64,
    breakpoint_record: Option<U64>,
    breakpoint_hit: bool,
}

#[derive(Clone, Copy)]
struct PlaybackAnchor {
    // 以百分之一纳秒保留切换速率时的进度。
    source: u128,
    host_ns: u64,
}
impl PlaybackAnchor {
    fn new(source_ns: u64, host_ns: u64) -> Self {
        Self {
            source: u128::from(source_ns) * 100,
            host_ns,
        }
    }

    fn source_at(self, now: u64, speed_percent: u16) -> u128 {
        self.source + u128::from(now.saturating_sub(self.host_ns)) * u128::from(speed_percent)
    }
}
impl Playback {
    fn rebase(&mut self, now: u64) {
        if let Some(anchor) = &mut self.anchor {
            if !self.paused
                && let ReplayRate::Timed { speed_percent } = self.rate
            {
                anchor.source = anchor.source_at(now, speed_percent);
            }
            anchor.host_ns = now;
        }
        self.last_now = now;
    }

    fn pause_at(&mut self, paused: bool, now: u64) {
        self.rebase(now);
        self.paused = paused;
    }

    fn pause_on_record(&mut self, source_time: Option<u64>, now: u64) {
        self.pause_at(true, now);
        if let Some(source_ns) = source_time {
            self.anchor = Some(PlaybackAnchor::new(source_ns, now));
        }
    }

    fn state(self) -> ReplayPlaybackState {
        ReplayPlaybackState {
            rate: self.rate,
            paused: self.paused,
            breakpoint_record: self.breakpoint_record,
            breakpoint_hit: self.paused && self.breakpoint_hit,
        }
    }
}

impl ReplayReader {
    pub fn open(path: &Path, mode: ReplayMode) -> HostResult<Self> {
        let guard = crate::files::references::PathGuard::new(path)?;
        let scan = index_replay_directory(path)?;
        if !scan.report.container_complete
            || !(scan.manifest.state == CaptureState::Complete
                || scan.manifest.state == CaptureState::Incomplete
                    && scan.manifest.recovered_from.is_some())
        {
            return Err(HostError::new(
                "CAPTURE_INCOMPLETE",
                "Recover the verified prefix before replay",
            ));
        }
        if mode == ReplayMode::OriginalTiming
            && scan.format == CaptureFormat::Legacy
            && scan.mixed_source_clocks
        {
            return Err(replay_clock_unavailable());
        }
        Ok(Self {
            archive: Arc::new(ReplayArchive {
                path: path.to_path_buf(),
                format: scan.format,
                index: scan.index,
                record_digests: scan.record_digests,
                directory_identity: crate::files::references::directory_identity(path)?,
                _guard: guard,
            }),
            capture_id: scan.manifest.capture_id,
            configuration: scan
                .manifest
                .streams
                .first()
                .map(|s| s.configuration.clone())
                .unwrap_or_default(),
            generation: 1.into(),
            mixed_source_clocks: scan.mixed_source_clocks,
            playback: Playback {
                position: 0,
                rate: mode.into(),
                paused: false,
                anchor: None,
                last_now: 0,
                breakpoint_record: None,
                breakpoint_hit: false,
            },
        })
    }
    pub fn read(&mut self, max: usize, now: u64) -> HostResult<ReplayReadResult> {
        self.read_limited(max, 256 * 1024, now)
    }
    pub fn read_limited(
        &mut self,
        max: usize,
        max_bytes: usize,
        now: u64,
    ) -> HostResult<ReplayReadResult> {
        self.read_with_references(
            max,
            max_bytes,
            now,
            ReplayReadMode::Batch,
            false,
            file_reference_required,
        )
    }

    pub fn step(&mut self, now: u64) -> HostResult<ReplayReadResult> {
        self.read_with_references(
            1,
            256 * 1024,
            now,
            ReplayReadMode::Step,
            true,
            file_reference_required,
        )
    }

    fn reply(
        &self,
        playback: Playback,
        records: Vec<ReplayRecord>,
        report_playback: bool,
    ) -> ReplayReadResult {
        ReplayReadResult {
            mode: self.archive.format.mode(),
            records,
            reader_generation: self.generation,
            next_record: (playback.position as u64 + 1).into(),
            at_end: playback.position == self.archive.index.records.len(),
            playback: report_playback.then(|| playback.state()),
        }
    }
    fn read_with_references(
        &mut self,
        max: usize,
        max_bytes: usize,
        now: u64,
        mode: ReplayReadMode,
        report_playback: bool,
        mut publish: impl FnMut(U64, &[u8]) -> HostResult<ReplayRecord>,
    ) -> HostResult<ReplayReadResult> {
        if max == 0 || max > 100 || max_bytes == 0 || max_bytes > 1024 * 1024 {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Invalid replay read budget",
            ));
        }
        self.archive.ensure_directory()?;
        let mut playback = self.playback;
        if mode != ReplayReadMode::Inspect {
            playback.last_now = now;
        }
        let limit = match mode {
            ReplayReadMode::Batch => max,
            ReplayReadMode::Step => 1,
            ReplayReadMode::Inspect => 0,
        };
        let single_step = mode == ReplayReadMode::Step;
        let mut records = Vec::new();
        let mut used = 0usize;
        while (single_step || !playback.paused)
            && records.len() < limit
            && playback.position < self.archive.index.records.len()
        {
            let (record, observed, json) = self.archive.read_verified_record(playback.position)?;
            let source_time =
                if self.mixed_source_clocks || self.archive.format == CaptureFormat::Redacted {
                    observed
                } else {
                    record_time(&record)
                };
            if !single_step
                && let (ReplayRate::Timed { speed_percent }, Some(source_ns)) =
                    (playback.rate, source_time)
            {
                let anchor = playback
                    .anchor
                    .get_or_insert_with(|| PlaybackAnchor::new(source_ns, now));
                if u128::from(source_ns) * 100 > anchor.source_at(now, speed_percent) {
                    break;
                }
            }

            let ordinal = record.record_ordinal;
            if !single_step
                && playback.breakpoint_record == Some(ordinal)
                && !playback.breakpoint_hit
            {
                playback.pause_on_record(source_time, now);
                playback.breakpoint_hit = true;
                break;
            }

            let mut advanced = playback;
            advanced.position += 1;
            advanced.breakpoint_hit = false;
            if single_step {
                advanced.pause_on_record(source_time, now);
            }

            let mut record = ReplayRecord::Inline { record };
            let mut size = serde_json::to_vec(&record).map_err(|_| corrupt())?.len();
            let envelope = self.reply(advanced, vec![], report_playback);
            let overhead = serde_json::to_vec(&envelope).map_err(|_| corrupt())?.len();
            if used + size + records.len() + overhead > max_bytes {
                if records.is_empty() {
                    record = publish(ordinal, &json)?;
                    size = serde_json::to_vec(&record).map_err(|_| corrupt())?.len();
                    if size + overhead > max_bytes {
                        return Err(HostError::new(
                            "LIMIT_EXCEEDED",
                            "Replay reference exceeds requested batch budget",
                        ));
                    }
                } else {
                    break;
                }
            }
            used += size;
            records.push(record);
            playback = advanced;
        }
        self.archive.ensure_directory()?;
        if single_step && records.is_empty() {
            playback.pause_at(true, now);
        }
        let result = self.reply(
            playback,
            records,
            report_playback || mode == ReplayReadMode::Inspect,
        );
        if serde_json::to_vec(&result).map_err(|_| corrupt())?.len() > max_bytes {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Replay reply exceeds requested batch budget",
            ));
        }
        self.playback = playback;
        Ok(result)
    }
}

impl ReplayArchive {
    fn ensure_directory(&self) -> HostResult<()> {
        if crate::files::references::directory_identity(&self.path)? != self.directory_identity {
            return Err(changed());
        }
        Ok(())
    }

    fn read_verified_record(
        &self,
        position: usize,
    ) -> HostResult<(CaptureRecord, Option<u64>, Vec<u8>)> {
        let location = self.index.records.get(position).ok_or_else(changed)?;
        let (record, observed, json) = read_record_bytes(&self.path, location, self.format)?;
        if self.record_digests.get(position) != Some(&record_digest(observed, &json)) {
            return Err(changed());
        }
        Ok((record, observed, json))
    }
}

impl ReplayReader {
    pub fn seek(&mut self, ordinal: U64, now: u64) -> HostResult<()> {
        if ordinal.get() == 0 || ordinal.get() > self.archive.index.records.len() as u64 + 1 {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Replay seek is outside the capture",
            ));
        }
        self.generation = self.generation.checked_next()?;
        self.playback.position = ordinal.get() as usize - 1;
        self.playback.anchor = None;
        self.playback.last_now = now;
        self.playback.breakpoint_hit = false;
        Ok(())
    }

    pub fn pause(&mut self, paused: bool) {
        self.pause_at(paused, self.playback.last_now)
    }

    pub fn pause_at(&mut self, paused: bool, now: u64) {
        self.playback.pause_at(paused, now);
    }

    pub fn set_rate(&mut self, rate: ReplayRate, now: u64) -> HostResult<()> {
        if matches!(rate, ReplayRate::Timed { .. })
            && self.archive.format == CaptureFormat::Legacy
            && self.mixed_source_clocks
        {
            return Err(replay_clock_unavailable());
        }
        if let ReplayRate::Timed { speed_percent } = rate
            && !(25..=400).contains(&speed_percent)
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Replay speed must be between 25% and 400%",
            ));
        }
        self.playback.rebase(now);
        if self.playback.rate == ReplayRate::Fastest || rate == ReplayRate::Fastest {
            self.playback.anchor = None;
        }
        self.playback.rate = rate;
        Ok(())
    }

    pub fn set_breakpoint(&mut self, record: Option<U64>) -> HostResult<()> {
        if let Some(ordinal) = record
            && (ordinal.get() == 0 || ordinal.get() > self.archive.index.records.len() as u64)
        {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Replay breakpoint is outside the capture",
            ));
        }
        if record != self.playback.breakpoint_record {
            self.playback.breakpoint_record = record;
            self.playback.breakpoint_hit = false;
        }
        Ok(())
    }
}

fn replay_clock_unavailable() -> HostError {
    HostError::new(
        "REPLAY_CLOCK_UNAVAILABLE",
        "The recording has no common source clock. Use fastest playback or single-step.",
    )
}

fn file_reference_required(_: U64, _: &[u8]) -> HostResult<ReplayRecord> {
    Err(HostError::new(
        "LIMIT_EXCEEDED",
        "Replay record requires a file reference",
    ))
}

#[cfg(test)]
mod format_tests {
    use super::*;
    use crate::capture::writer::{CaptureLimits, CaptureWriter, native_volume_opener};

    #[test]
    fn legacy_mixed_clocks_keep_exact_order_without_a_recorder_timeline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().canonicalize().unwrap().join("capture");
        let hosts = ["first", "second"];
        let sources = hosts
            .iter()
            .map(|&host| CaptureSource {
                host_id: Id::try_from(host).unwrap(),
                instance_epoch: 1.into(),
                session_id: Id::try_from("legacy").unwrap(),
                session_epoch: 1.into(),
                configuration_digest: zero_digest(),
                configuration: SerialConfiguration::default(),
                time_precision: TimePrecision {
                    source: TimeSource::HostRead,
                    resolution_ns: 1.into(),
                    sync_method: "none".into(),
                    offset_estimate_ns: None,
                    offset_error_ns: None,
                    rtt_ns: None,
                },
            })
            .collect();
        let mut writer = CaptureWriter::create_at_format(
            crate::files::references::PathGuard::new(&path).unwrap(),
            sources,
            CaptureLimits::default(),
            native_volume_opener(),
            CaptureFormat::Legacy,
            None,
        )
        .unwrap();
        for host in hosts {
            let event = serde_json::json!({
                "hostId": host, "instanceEpoch": "1", "sessionId": "legacy", "sessionEpoch": "1",
                "eventSeq": "1", "configurationRevision": "1",
                "time": {
                    "clockId": host, "sourceMonoNs": "1", "receivedWallTime": "2026-11-21T00:00:00Z",
                    "precision": {"source": "host_read", "resolutionNs": "1", "syncMethod": "none"}
                },
                "kind": "lifecycle", "payload": {"note": "legacy"}
            });
            writer
                .push(
                    CaptureEntry::Event(serde_json::from_value(event).unwrap()),
                    0,
                )
                .unwrap();
        }
        writer.finish().unwrap();
        let unavailable = ReplayReader::open(&path, ReplayMode::OriginalTiming)
            .err()
            .unwrap();
        assert_eq!(unavailable.code, "REPLAY_CLOCK_UNAVAILABLE");
        let mut reader = ReplayReader::open(&path, ReplayMode::Fastest).unwrap();
        assert_eq!(
            reader
                .set_rate(ReplayRate::Timed { speed_percent: 100 }, 0)
                .unwrap_err()
                .code,
            "REPLAY_CLOCK_UNAVAILABLE",
        );
        assert_eq!(reader.step(0).unwrap().next_record, U64::from(2));
        assert!(reader.step(0).unwrap().at_end);
    }
}

use crate::{
    auth::{AuthenticatedActor, HostIdentity},
    files::FileService,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct ReplayService {
    files: FileService,
    identity: HostIdentity,
    clock: Arc<dyn Clock>,
    sessions: Arc<Mutex<HashMap<Id, Arc<Mutex<ReplaySession>>>>>,
    slots: Arc<tokio::sync::Semaphore>,
    searches: search_service::ReplaySearches,
}
struct ReplaySession {
    source: ObjectRef,
    _actor_id: Id,
    _client_id: Id,
    snapshot: SessionSnapshot,
    reader: Option<ReplayReader>,
    slot: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl ReplayService {
    pub fn new(files: FileService, identity: HostIdentity, clock: Arc<dyn Clock>) -> Self {
        Self {
            files,
            identity,
            clock,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            slots: Arc::new(tokio::sync::Semaphore::new(16)),
            searches: search_service::ReplaySearches::default(),
        }
    }
    pub fn owns(&self, id: &Id) -> bool {
        self.sessions
            .lock()
            .is_ok_and(|sessions| sessions.contains_key(id))
    }
    pub async fn open(
        &self,
        params: ReplayOpenParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<OpenResult> {
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| HostError::new("LIMIT_EXCEEDED", "Replay session budget exhausted"))?;
        let service = self.clone();
        let actor = actor.clone();
        super::blocking(move || {
            let guard = service.files.resolve(&params.capture_ref, &actor, false)?;
            let fixed = service
                .files
                .metadata(&params.capture_ref, &actor)?
                .file_ref;
            if fixed.revision.is_none() {
                return Err(HostError::new(
                    "CAPTURE_INCOMPLETE",
                    "Capture has not published a fixed content revision",
                ));
            }
            let reader = ReplayReader::open(guard.checked_path(), params.mode)?;
            let id = Id::try_from(format!("replay-{}", uuid::Uuid::new_v4()).as_str())?;
            let snapshot = SessionSnapshot {
                reconnect: None,
                session_id: id.clone(),
                device_id: reader.capture_id.clone(),
                session_epoch: 1.into(),
                revision: 1.into(),
                configuration_revision: 1.into(),
                state: SessionState::Open,
                configuration: reader.configuration.clone(),
                read_only: true,
                tx_gate: TxGate::Ready,
                control_state: ControlState::Clear,
                capabilities: TransportCapabilities {
                    semantics: TransportSemantics::Stream,
                    configuration: false,
                    dtr: false,
                    rts: false,
                    finite_break: false,
                    queue_status: false,
                    drain: false,
                    purge_rx: false,
                    purge_tx: false,
                },
                lease: None,
            };
            let opened = OpenResult {
                session_id: id.clone(),
                session_epoch: snapshot.session_epoch,
                revision: snapshot.revision,
                reused: false,
                recent_error: None,
            };
            let mut sessions = service.sessions.lock().map_err(|_| replay_busy())?;
            if sessions.len() >= 64 {
                sessions.retain(|_, session| session.lock().is_ok_and(|s| s.reader.is_some()));
            }
            sessions.insert(
                id,
                Arc::new(Mutex::new(ReplaySession {
                    source: fixed,
                    _actor_id: actor.id().clone(),
                    _client_id: actor.client_id().clone(),
                    snapshot,
                    reader: Some(reader),
                    slot: Some(slot),
                })),
            );
            Ok(opened)
        })
        .await
    }
    fn target(&self, id: &Id, epoch: U64) -> HostResult<Target> {
        Ok(Target {
            host_id: self.identity.host_id.clone(),
            kind: ResourceKind::try_from("session")?,
            id: id.clone(),
            session_id: Some(id.clone()),
            session_epoch: Some(epoch),
        })
    }
    fn find(&self, target: &Target) -> HostResult<Arc<Mutex<ReplaySession>>> {
        target.validate()?;
        if target.host_id != self.identity.host_id || target.kind.as_str() != "session" {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Invalid replay session target",
            ));
        }
        self.sessions
            .lock()
            .map_err(|_| replay_busy())?
            .get(&target.id)
            .cloned()
            .ok_or_else(|| HostError::new("NOT_FOUND", "Replay session was not found"))
    }
    fn authorize(
        &self,
        session: &ReplaySession,
        target: &Target,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<Target> {
        if target.session_epoch != Some(session.snapshot.session_epoch) {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Replay session epoch differs",
            ));
        }
        self.files
            .authorization_target(&session.source, actor, permission)
    }
    pub fn authorization_target(
        &self,
        target: &Target,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<Target> {
        let session = self.find(target)?;
        let session = session.lock().map_err(|_| replay_busy())?;
        self.authorize(&session, target, actor, permission)
    }
    pub async fn read(
        &self,
        params: ReplayReadParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<ReplayReadResult> {
        let service = self.clone();
        let actor = actor.clone();
        super::blocking(move || {
            let target = service.target(&params.session_id, params.session_epoch)?;
            let session = service.find(&target)?;
            let mut session = session.lock().map_err(|_| replay_busy())?;
            service.authorize(&session, &target, &actor, "content.read")?;
            let source = session.source.clone();
            let reader = session.reader.as_mut().ok_or_else(replay_closed)?;
            let mode = match (
                params.single_step.unwrap_or_default(),
                params.inspect_playback.unwrap_or_default(),
            ) {
                (false, false) => ReplayReadMode::Batch,
                (true, false) => ReplayReadMode::Step,
                (false, true) => ReplayReadMode::Inspect,
                (true, true) => {
                    return Err(HostError::new(
                        "INVALID_ARGUMENT",
                        "Replay inspection cannot be combined with a step",
                    ));
                }
            };
            reader.read_with_references(
                usize::try_from(params.max_records.get()).map_err(|_| super::invalid())?,
                usize::try_from(params.max_bytes.get()).map_err(|_| super::invalid())?,
                service.clock.mono_ns(),
                mode,
                params.report_playback.unwrap_or_default(),
                |ordinal, json| service.files.publish_record(&source, &actor, ordinal, json),
            )
        })
        .await
    }
    pub async fn control(
        &self,
        params: ReplayControlParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<ReplayReadResult> {
        let service = self.clone();
        let actor = actor.clone();
        super::blocking(move || {
            let target = service.target(&params.session_id, params.session_epoch)?;
            let session = service.find(&target)?;
            let mut session = session.lock().map_err(|_| replay_busy())?;
            service.authorize(&session, &target, &actor, "content.read")?;
            let revision = session.snapshot.revision.checked_next()?;
            let reader = session.reader.as_mut().ok_or_else(replay_closed)?;
            let now = service.clock.mono_ns();
            if let Some(playback) = params.playback {
                if params.seek_record.is_some() {
                    return Err(HostError::new(
                        "INVALID_ARGUMENT",
                        "Replay playback controls cannot be combined with a seek",
                    ));
                }
                match playback {
                    ReplayPlaybackControl::SetRate { rate } => reader.set_rate(rate, now)?,
                    ReplayPlaybackControl::SetBreakpoint { record } => {
                        reader.set_breakpoint(record)?
                    }
                }
            } else {
                if let Some(ordinal) = params.seek_record {
                    reader.seek(ordinal, now)?;
                }
                reader.pause_at(params.paused, now);
            }
            // 旧客户端可能通过 operation.get 读取这条持久回执。
            let position = reader.reply(reader.playback, vec![], false);
            session.snapshot.revision = revision;
            Ok(position)
        })
        .await
    }
    pub async fn snapshot(
        &self,
        target: &Target,
        actor: &AuthenticatedActor,
    ) -> HostResult<SessionSnapshot> {
        let service = self.clone();
        let actor = actor.clone();
        let target = target.clone();
        super::blocking(move || {
            let session = service.find(&target)?;
            let session = session.lock().map_err(|_| replay_busy())?;
            service.authorize(&session, &target, &actor, "metadata.read")?;
            Ok(session.snapshot.clone())
        })
        .await
    }
    pub async fn close(
        &self,
        target: &Target,
        actor: &AuthenticatedActor,
    ) -> HostResult<SessionSnapshot> {
        let service = self.clone();
        let actor = actor.clone();
        let target = target.clone();
        super::blocking(move || {
            let session = service.find(&target)?;
            let mut session = session.lock().map_err(|_| replay_busy())?;
            service.authorize(&session, &target, &actor, "content.read")?;
            if session.reader.is_some() {
                let revision = session.snapshot.revision.checked_next()?;
                service.searches.release_session(&target.id)?;
                session.reader.take();
                session.snapshot.state = SessionState::Closed;
                session.snapshot.tx_gate = TxGate::Closing;
                session.snapshot.revision = revision;
                session.slot.take();
            }
            Ok(session.snapshot.clone())
        })
        .await
    }
    pub fn shutdown(&self) -> HostResult<()> {
        for (id, session) in self.sessions.lock().map_err(|_| replay_busy())?.iter() {
            let mut session = session.lock().map_err(|_| replay_busy())?;
            session.reader.take();
            self.searches.release_session(id)?;
            session.slot.take();
            session.snapshot.state = SessionState::Closed;
            session.snapshot.tx_gate = TxGate::Closing;
        }
        Ok(())
    }
}
fn replay_busy() -> HostError {
    HostError::new("HOST_BUSY", "Replay state is unavailable")
}
fn replay_closed() -> HostError {
    HostError::new("BACKEND_DISCONNECTED", "Replay session is closed")
}
