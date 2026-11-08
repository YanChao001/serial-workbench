use super::{
    format::*,
    verify::{read_record_bytes, verify_directory},
};
use serial_workbench_core::*;
use std::path::{Path, PathBuf};
/// 纯文件读者；类型不持有设备、TX 仲裁器或 Transport。
pub struct ReplayReader {
    path: PathBuf,
    index: CaptureIndex,
    record_digests: Vec<[u8; 32]>,
    directory_identity: String,
    capture_id: Id,
    configuration: SerialConfiguration,
    position: usize,
    generation: U64,
    mode: ReplayMode,
    paused: bool,
    anchor: Option<(u64, u64)>,
    last_now: u64,
    pause_start: Option<u64>,
    _guard: crate::files::references::PathGuard,
}
impl ReplayReader {
    pub fn open(path: &Path, mode: ReplayMode) -> HostResult<Self> {
        let guard = crate::files::references::PathGuard::new(path)?;
        let scan = verify_directory(path)?;
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
        Ok(Self {
            path: path.to_path_buf(),
            index: scan.index,
            record_digests: scan.record_digests,
            directory_identity: crate::files::references::directory_identity(path)?,
            capture_id: scan.manifest.capture_id,
            configuration: scan
                .manifest
                .streams
                .first()
                .map(|s| s.configuration.clone())
                .unwrap_or_default(),
            position: 0,
            generation: 1.into(),
            mode,
            paused: false,
            anchor: None,
            last_now: 0,
            pause_start: None,
            _guard: guard,
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
        self.read_with_references(max, max_bytes, now, |_, _| {
            Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Replay record requires a file reference",
            ))
        })
    }
    fn read_with_references(
        &mut self,
        max: usize,
        max_bytes: usize,
        now: u64,
        mut publish: impl FnMut(U64, &[u8]) -> HostResult<ReplayRecord>,
    ) -> HostResult<ReplayReadResult> {
        if max == 0 || max > 100 || max_bytes == 0 || max_bytes > 1024 * 1024 {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Invalid replay read budget",
            ));
        }
        self.last_now = now;
        if crate::files::references::directory_identity(&self.path)? != self.directory_identity {
            return Err(changed());
        }
        let mut records = Vec::new();
        let mut used = 0usize;
        while !self.paused && records.len() < max && self.position < self.index.records.len() {
            let (record, json) = read_record_bytes(&self.path, &self.index.records[self.position])?;
            if self.record_digests.get(self.position) != Some(&super::verify::json_digest(&json)) {
                return Err(changed());
            }
            if self.mode == ReplayMode::OriginalTiming
                && let Some(source) = record_time(&record)
            {
                let (start, origin) = *self.anchor.get_or_insert((source, now));
                if source.saturating_sub(start) > now.saturating_sub(origin) {
                    break;
                }
            }
            let ordinal = record.record_ordinal;
            let mut record = ReplayRecord::Inline { record };
            let mut size = serde_json::to_vec(&record).map_err(|_| corrupt())?.len();
            let envelope = ReplayReadResult {
                records: vec![],
                reader_generation: self.generation,
                next_record: (self.position as u64 + 2).into(),
                at_end: self.position + 1 == self.index.records.len(),
            };
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
            self.position += 1;
        }
        if crate::files::references::directory_identity(&self.path)? != self.directory_identity {
            return Err(changed());
        }
        let result = ReplayReadResult {
            records,
            reader_generation: self.generation,
            next_record: (self.position as u64 + 1).into(),
            at_end: self.position == self.index.records.len(),
        };
        if serde_json::to_vec(&result).map_err(|_| corrupt())?.len() > max_bytes {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Replay reply exceeds requested batch budget",
            ));
        }
        Ok(result)
    }
    pub fn seek(&mut self, ordinal: U64, now: u64) -> HostResult<()> {
        if ordinal.get() == 0 || ordinal.get() > self.index.records.len() as u64 + 1 {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Replay seek is outside the capture",
            ));
        }
        self.position = ordinal.get() as usize - 1;
        self.generation = self.generation.checked_next()?;
        self.anchor = None;
        self.last_now = now;
        self.pause_start = self.paused.then_some(now);
        Ok(())
    }
    pub fn pause(&mut self, paused: bool) {
        self.pause_at(paused, self.last_now)
    }
    pub fn pause_at(&mut self, paused: bool, now: u64) {
        if paused && !self.paused {
            self.pause_start = Some(now)
        } else if !paused
            && self.paused
            && let (Some((_, origin)), Some(start)) = (&mut self.anchor, self.pause_start.take())
        {
            *origin = origin.saturating_add(now.saturating_sub(start));
        }
        self.paused = paused;
        self.last_now = now;
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
            reader.read_with_references(
                usize::try_from(params.max_records.get()).map_err(|_| super::invalid())?,
                usize::try_from(params.max_bytes.get()).map_err(|_| super::invalid())?,
                service.clock.mono_ns(),
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
            let reader = session.reader.as_mut().ok_or_else(replay_closed)?;
            let now = service.clock.mono_ns();
            if let Some(ordinal) = params.seek_record {
                reader.seek(ordinal, now)?;
            }
            reader.pause_at(params.paused, now);
            let position = ReplayReadResult {
                records: vec![],
                reader_generation: reader.generation,
                next_record: (reader.position as u64 + 1).into(),
                at_end: reader.position == reader.index.records.len(),
            };
            session.snapshot.revision = session.snapshot.revision.checked_next()?;
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
            if session.reader.take().is_some() {
                session.snapshot.state = SessionState::Closed;
                session.snapshot.tx_gate = TxGate::Closing;
                session.snapshot.revision = session.snapshot.revision.checked_next()?;
                session.slot.take();
            }
            Ok(session.snapshot.clone())
        })
        .await
    }
    pub fn shutdown(&self) -> HostResult<()> {
        for session in self.sessions.lock().map_err(|_| replay_busy())?.values() {
            let mut session = session.lock().map_err(|_| replay_busy())?;
            session.reader.take();
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
