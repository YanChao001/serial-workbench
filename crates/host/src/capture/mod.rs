pub mod format;
pub mod recovery;
pub mod replay;
pub mod text_export;
pub mod verify;
pub mod writer;

use crate::{
    auth::{AuthService, AuthenticatedActor, HostIdentity},
    device::DeviceService,
    files::FileService,
    storage::Store,
    stream::{RawSubscription, StreamHub},
};
use serial_workbench_core::*;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use writer::{CaptureLimits, CaptureWriter};
pub struct CaptureRuntime {
    pub store: Store,
    pub auth: AuthService,
    pub identity: HostIdentity,
    pub files: FileService,
    pub streams: StreamHub,
    pub devices: DeviceService,
    pub clock: Arc<dyn Clock>,
}
#[derive(Clone)]
pub struct CaptureService {
    runtime: Arc<CaptureRuntime>,
    limits: CaptureLimits,
    opener: writer::VolumeOpener,
    active: Arc<Mutex<HashMap<Id, ActiveCapture>>>,
    verifications: Arc<Mutex<VecDeque<VerificationLease>>>,
    starts: Arc<Mutex<HashSet<Id>>>,
    queue_budget: Arc<Semaphore>,
    queue_peak: Arc<AtomicUsize>,
    tail_budget: Arc<Semaphore>,
}
struct ActiveCapture {
    location_id: Id,
    stop: watch::Sender<bool>,
    summary: watch::Receiver<CaptureSummary>,
    done: watch::Receiver<Option<HostResult<CaptureSummary>>>,
}
const CAPTURE_QUEUE_BYTES: usize = 16 * 1024 * 1024;
const HOST_CAPTURE_QUEUE_BYTES: usize = 64 * 1024 * 1024;
const CAPTURE_READERS_BYTES: usize = 4 * 1024 * 1024;
const CAPTURE_QUEUE_METADATA: usize = 128 * 1024;
pub struct CaptureMemory {
    pub queued_bytes: usize,
    pub queue_limit: usize,
    pub peak_queued_bytes: usize,
}
struct StartReservation {
    id: Id,
    starts: Arc<Mutex<HashSet<Id>>>,
}
impl Drop for StartReservation {
    fn drop(&mut self) {
        if let Ok(mut starts) = self.starts.lock() {
            starts.remove(&self.id);
        }
    }
}
#[derive(Clone)]
struct PumpBudget {
    capture: Arc<Semaphore>,
    host: Arc<Semaphore>,
    peak: Arc<AtomicUsize>,
    reader_credit: u64,
}
struct CapturedBatch {
    entries: Vec<CaptureEntry>,
    _capture: OwnedSemaphorePermit,
    _host: OwnedSemaphorePermit,
}
struct VerificationLease {
    reference: ObjectRef,
    report: VerificationReport,
    actor_id: Id,
    _scan: verify::VerifiedCapture,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum TailPhase {
    BindFiles,
    ReadRecord,
    ReturnResult,
}
impl CaptureService {
    pub fn with_storage(
        runtime: CaptureRuntime,
        limits: CaptureLimits,
        opener: writer::VolumeOpener,
    ) -> Self {
        let mut service = Self::new(runtime);
        service.limits = limits;
        service.opener = opener;
        service
    }
    pub fn new(runtime: CaptureRuntime) -> Self {
        Self {
            runtime: Arc::new(runtime),
            limits: CaptureLimits::default(),
            opener: writer::native_volume_opener(),
            active: Arc::new(Mutex::new(HashMap::new())),
            verifications: Arc::new(Mutex::new(VecDeque::new())),
            starts: Arc::new(Mutex::new(HashSet::new())),
            queue_budget: Arc::new(Semaphore::new(HOST_CAPTURE_QUEUE_BYTES)),
            queue_peak: Arc::new(AtomicUsize::new(0)),
            tail_budget: Arc::new(Semaphore::new(1)),
        }
    }
    pub fn memory_usage(&self) -> CaptureMemory {
        CaptureMemory {
            queued_bytes: HOST_CAPTURE_QUEUE_BYTES - self.queue_budget.available_permits(),
            queue_limit: HOST_CAPTURE_QUEUE_BYTES,
            peak_queued_bytes: self.queue_peak.load(Ordering::Relaxed),
        }
    }
    pub async fn start(
        &self,
        params: CaptureStartParams,
        owner: &Operation,
        actor: &AuthenticatedActor,
    ) -> HostResult<ObjectRef> {
        if params.mode != CaptureMode::Raw {
            return Err(HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "Redacted capture is not implemented",
            ));
        }
        if params.overflow_policy != OverflowPolicy::Stop {
            return Err(HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "Capture requires stop-on-overflow",
            ));
        }
        if params.session_refs.is_empty()
            || params.session_refs.len() > 16
            || owner.actor_id != *actor.id()
            || owner.execution_mode != ExecutionMode::Independent
            || owner.state != OperationState::Running
        {
            return Err(invalid());
        }
        let _start = {
            let mut starts = self.starts.lock().map_err(|_| busy())?;
            if !starts.insert(params.target_ref.id.clone()) {
                return Err(HostError::new(
                    "REQUEST_CONFLICT",
                    "Capture target is being started",
                ));
            }
            StartReservation {
                id: params.target_ref.id.clone(),
                starts: self.starts.clone(),
            }
        };
        {
            let mut active = self.active.lock().map_err(|_| busy())?;
            if active.len() >= 64 {
                active.retain(|_, a| a.done.borrow().is_none());
            }
            if active
                .values()
                .filter(|a| a.done.borrow().is_none())
                .count()
                >= 16
                || active.values().any(|entry| {
                    entry.location_id == params.target_ref.id && entry.done.borrow().is_none()
                })
            {
                return Err(HostError::new(
                    "LIMIT_EXCEEDED",
                    "Capture owner or target is already active",
                ));
            }
        }
        let files = self.runtime.files.clone();
        let reference = params.target_ref.clone();
        let actor_copy = actor.clone();
        let guard = blocking(move || files.resolve(&reference, &actor_copy, true)).await?;
        let reader_bytes = CAPTURE_READERS_BYTES / params.session_refs.len();
        let budget = PumpBudget {
            capture: Arc::new(Semaphore::new(CAPTURE_QUEUE_BYTES)),
            host: self.queue_budget.clone(),
            peak: self.queue_peak.clone(),
            reader_credit: reader_bytes as u64,
        };
        let reserved =
            u32::try_from(reader_bytes * params.session_refs.len() + CAPTURE_QUEUE_METADATA)
                .map_err(|_| invalid())?;
        let reader_local = budget
            .capture
            .clone()
            .try_acquire_many_owned(reserved)
            .map_err(|_| queue_overflow())?;
        let reader_global = budget
            .host
            .clone()
            .try_acquire_many_owned(reserved)
            .map_err(|_| queue_overflow())?;
        budget.peak.fetch_max(
            HOST_CAPTURE_QUEUE_BYTES - budget.host.available_permits(),
            Ordering::Relaxed,
        );
        let mut sources = Vec::new();
        let mut append_positions = Vec::new();
        let mut subscriptions = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for target in &params.session_refs {
            target.validate()?;
            if target.kind.as_str() != "session" || !seen.insert(target.id.clone()) {
                close_readers(&subscriptions);
                return Err(invalid());
            }
            let auth = self.runtime.auth.clone();
            let a = actor.clone();
            let t = target.clone();
            blocking(move || auth.require(&a, "content.read", &t)).await?;
            let snapshot = self.runtime.devices.snapshot(target).await?;
            let meta = crate::device::sessions::source_meta(
                &self.runtime.identity,
                self.runtime.clock.as_ref(),
                snapshot.configuration_revision,
            );
            sources.push(format::CaptureSource {
                host_id: target.host_id.clone(),
                instance_epoch: self.runtime.identity.instance_epoch,
                session_id: target.id.clone(),
                session_epoch: snapshot.session_epoch,
                configuration_digest: format::digest(
                    &serde_json::to_vec(&snapshot.configuration).map_err(|_| invalid())?,
                ),
                configuration: snapshot.configuration,
                time_precision: meta.time.precision,
            });
            let cursor = self.runtime.streams.current_cursor(target)?;
            append_positions.push(cursor.position);
            if self
                .runtime
                .devices
                .snapshot(target)
                .await?
                .configuration_revision
                != snapshot.configuration_revision
            {
                close_readers(&subscriptions);
                return Err(HostError::new(
                    "CONFIGURATION_CONFLICT",
                    "Session configuration changed during capture start",
                ));
            }
            match self
                .runtime
                .streams
                .subscribe(
                    actor,
                    StreamSubscribeParams {
                        scope_id: cursor.scope_id.clone(),
                        after: cursor,
                        queue_bytes: (reader_bytes as u64).into(),
                        initial_credit_bytes: (reader_bytes as u64).into(),
                        overflow_policy: OverflowPolicy::Stop,
                    },
                )
                .await
            {
                Ok(reader) => subscriptions.push(reader),
                Err(error) => {
                    close_readers(&subscriptions);
                    return Err(error);
                }
            }
        }
        let mode = params.write_mode;
        let expected = params.expected_fingerprint.clone();
        let files = self.runtime.files.clone();
        let location = params.target_ref.clone();
        let creator = actor.clone();
        let mut limits = self.limits.clone();
        if let Some(storage_limits) = params.storage_limits {
            limits.capacity_bytes = storage_limits.capacity_bytes.get();
            limits.reserve_bytes = storage_limits.reserve_bytes.get();
        }
        let opener = self.opener.clone();
        let writer = blocking(move || {
            files.require_reference(&location, &creator, "workspace.modify")?;
            match mode {
                CaptureWriteMode::CreateNew => {
                    CaptureWriter::create_at(guard, sources, limits, opener)
                }
                CaptureWriteMode::Append => CaptureWriter::append_at_positions(
                    guard,
                    sources,
                    limits,
                    opener,
                    Some(append_positions),
                ),
                CaptureWriteMode::Replace => CaptureWriter::replace_at(
                    guard,
                    sources,
                    limits,
                    expected.as_ref().ok_or_else(invalid)?,
                    opener,
                ),
            }
        })
        .await;
        let writer = match writer {
            Ok(w) => w,
            Err(e) => {
                close_readers(&subscriptions);
                return Err(e);
            }
        };
        let initial = writer.summary();
        let files = self.runtime.files.clone();
        let location = params.target_ref.clone();
        let a = actor.clone();
        let storage_path = writer.storage_path().to_path_buf();
        let capture_id = initial.capture_id.clone();
        let capture_owner_id = owner.operation_id.clone();
        let capture_ref = match blocking(move || {
            files.begin_capture(
                &location,
                &storage_path,
                &capture_id,
                &a,
                mode == CaptureWriteMode::Append,
                Some(capture_owner_id),
            )
        })
        .await
        {
            Ok(reference) => reference,
            Err(error) => {
                close_readers(&subscriptions);
                return Err(error);
            }
        };
        let (summary_tx, summary_rx) = watch::channel(initial);
        let (done_tx, done_rx) = watch::channel(None);
        let (stop_tx, stop_rx) = watch::channel(false);
        let reason = Arc::new(Mutex::new(None::<HostError>));
        let (sender, receiver) = mpsc::sync_channel::<CapturedBatch>(1024);
        let stored = self.runtime.store.clone();
        let operation_id = owner.operation_id.clone();
        let evidence = ActionResult::Reference(ResultReference {
            result_ref: capture_ref.clone(),
        });
        if let Err(error) =
            blocking(move || stored.record_result_evidence(&operation_id, &evidence)).await
        {
            close_readers(&subscriptions);
            return Err(error);
        }
        self.active.lock().map_err(|_| busy())?.insert(
            capture_ref.id.clone(),
            ActiveCapture {
                location_id: params.target_ref.id.clone(),
                stop: stop_tx.clone(),
                summary: summary_rx,
                done: done_rx.clone(),
            },
        );
        for reader in subscriptions {
            let runtime = self.runtime.clone();
            let actor = actor.clone();
            let reference = capture_ref.clone();
            let send = sender.clone();
            let stop = stop_tx.clone();
            let stopped = stop_rx.clone();
            let reason = reason.clone();
            let budget = budget.clone();
            tokio::spawn(async move {
                if let Err(error) = pump(
                    runtime,
                    actor,
                    reference,
                    reader.clone(),
                    send.clone(),
                    stopped,
                    budget,
                )
                .await
                {
                    if let Ok(mut slot) = reason.lock() {
                        slot.get_or_insert(error);
                    }
                    stop.send_replace(true);
                }
                reader.close();
                drop(send);
            });
        }
        drop(sender);
        let clock = self.runtime.clock.clone();
        let stopped = stop_tx.clone();
        let worker_reason = reason.clone();
        let final_path = writer.publication_path().to_path_buf();
        let files = self.runtime.files.clone();
        let publication_ref = capture_ref.clone();
        let publication_actor = actor.clone();
        let progress_store = self.runtime.store.clone();
        let progress_owner = owner.operation_id.clone();
        tokio::task::spawn_blocking(move || {
            let outcome = {
                let mut writer = writer;
                let mut failure = None;
                let mut last_synced = U64::from(0);
                let mut publish_summary = |summary: CaptureSummary| -> HostResult<()> {
                    if summary.watermarks.synced > last_synced {
                        progress_store.record_progress(
                            &progress_owner,
                            &Progress {
                                completed: summary.watermarks.synced,
                                unit: "records".into(),
                                total: None,
                            },
                        )?;
                        last_synced = summary.watermarks.synced;
                    }
                    summary_tx.send_replace(summary);
                    Ok(())
                };
                loop {
                    let batch = match receiver.recv_timeout(std::time::Duration::from_millis(100)) {
                        Ok(batch) => batch,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if let Err(error) = writer.flush_due(clock.mono_ns()) {
                                failure = Some(error);
                                stopped.send_replace(true);
                                break;
                            }
                            if let Err(error) = publish_summary(writer.summary()) {
                                failure = Some(error);
                                stopped.send_replace(true);
                                break;
                            }
                            continue;
                        }
                    };
                    for entry in batch.entries {
                        if let Err(error) = writer.push(entry, clock.mono_ns()) {
                            failure = Some(error);
                            stopped.send_replace(true);
                            break;
                        }
                        if let Err(error) = publish_summary(writer.summary()) {
                            failure = Some(error);
                            stopped.send_replace(true);
                            break;
                        }
                    }
                    if failure.is_some() {
                        break;
                    }
                }
                if failure.is_none() {
                    failure = worker_reason.lock().ok().and_then(|v| v.clone());
                }
                // A failed disk stops producers; discard their queued suffix and await
                // reader closure before releasing the reserved upstream budget.
                if failure.is_some() {
                    for batch in receiver {
                        drop(batch);
                    }
                }
                if let Some(error) = failure {
                    let summary = writer.fail();
                    summary_tx.send_replace(summary);
                    Err(error)
                } else {
                    let result = writer.finish_in_place().and_then(|summary| {
                        publish_summary(summary.clone())?;
                        let fingerprint = summary
                            .source_fingerprint
                            .as_ref()
                            .ok_or_else(format::corrupt)?;
                        files.publish_capture(
                            &publication_ref,
                            &final_path,
                            fingerprint,
                            &publication_actor,
                        )?;
                        Ok(summary)
                    });
                    if let Ok(summary) = &result {
                        summary_tx.send_replace(summary.clone());
                    } else {
                        summary_tx.send_replace(writer.fail());
                    }
                    result
                }
            };
            drop(reader_local);
            drop(reader_global);
            done_tx.send_replace(Some(outcome));
            stopped.send_replace(true);
        });
        let runtime = self.runtime.clone();
        let actor = actor.clone();
        let owner_id = owner.operation_id.clone();
        let stop = stop_tx;
        let mut done = done_rx;
        tokio::spawn(async move {
            loop {
                tokio::select! {_ = done.changed()=>break,_ = tokio::time::sleep(std::time::Duration::from_millis(20))=>{let store=runtime.store.clone();let a=actor.clone();let id=owner_id.clone();match blocking(move||store.get(&a,&id)).await{Ok(op) if op.state==OperationState::CancelRequested=>{stop.send_replace(true);break},Err(_)=>{stop.send_replace(true);break},_=>{}}}}
            }
        });
        Ok(capture_ref)
    }
    pub async fn status(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<CaptureSummary> {
        let files = self.runtime.files.clone();
        let r = reference.clone();
        let a = actor.clone();
        blocking(move || files.require_reference(&r, &a, "metadata.read")).await?;
        if let Some(active) = self.active.lock().map_err(|_| busy())?.get(&reference.id) {
            return Ok(active.summary.borrow().clone());
        }
        let files = self.runtime.files.clone();
        let r = reference.clone();
        let a = actor.clone();
        let guard = blocking(move || files.resolve_metadata(&r, &a)).await?;
        blocking(move || verify::verify_directory(guard.checked_path()).map(|s| s.summary)).await
    }
    pub async fn stop(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<CaptureSummary> {
        let files = self.runtime.files.clone();
        let r = reference.clone();
        let a = actor.clone();
        blocking(move || files.require_reference(&r, &a, "workspace.modify")).await?;
        let mut done = {
            let active = self.active.lock().map_err(|_| busy())?;
            let active = active
                .get(&reference.id)
                .ok_or_else(|| HostError::new("NOT_FOUND", "Active capture was not found"))?;
            active.stop.send_replace(true);
            active.done.clone()
        };
        wait_done(&mut done).await
    }
    /// start 的独立 operation 持续到此等待完成；GUI 断开不触发 stop。
    pub async fn wait(&self, reference: &ObjectRef) -> HostResult<CaptureSummary> {
        let mut done = self
            .active
            .lock()
            .map_err(|_| busy())?
            .get(&reference.id)
            .ok_or_else(|| HostError::new("NOT_FOUND", "Capture was not found"))?
            .done
            .clone();
        wait_done(&mut done).await
    }
    pub async fn owner_operation(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<Option<Id>> {
        let files = self.runtime.files.clone();
        let reference = reference.clone();
        let actor = actor.clone();
        blocking(move || files.capture_owner(&reference, &actor)).await
    }
    pub async fn final_reference(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<ObjectRef> {
        self.owner_operation(reference, actor).await?;
        let done = self
            .active
            .lock()
            .map_err(|_| busy())?
            .get(&reference.id)
            .map(|active| active.done.clone());
        if let Some(mut done) = done {
            wait_done(&mut done).await?;
        }
        let files = self.runtime.files.clone();
        let reference = reference.clone();
        let actor = actor.clone();
        blocking(move || {
            let result = files.metadata(&reference, &actor)?.file_ref;
            if result.revision.is_none() {
                return Err(HostError::new(
                    "CAPTURE_INCOMPLETE",
                    "Capture has not published a fixed revision",
                ));
            }
            Ok(result)
        })
        .await
    }
    pub async fn verify(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<VerificationReport> {
        let files = self.runtime.files.clone();
        let r = reference.clone();
        let a = actor.clone();
        let scan = blocking(move || {
            let guard = files.resolve(&r, &a, false)?;
            verify::verify_directory(guard.checked_path())
        })
        .await?;
        let report = scan.report.clone();
        let mut cache = self.verifications.lock().map_err(|_| busy())?;
        while cache.len() >= 16 {
            cache.pop_front();
        }
        cache.push_back(VerificationLease {
            reference: reference.clone(),
            report: report.clone(),
            actor_id: actor.id().clone(),
            _scan: scan,
        });
        Ok(report)
    }
    /// 一次性验证并读取末段；不登记 verification lease，也不创建回放会话。
    pub async fn tail(
        &self,
        params: CaptureTailParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<CaptureTailResult> {
        self.tail_observed(params, actor, |_| {}).await
    }
    // 与已有导出/恢复 seam 相同：仅供可信 Host 观察，wire 参数不能控制。
    async fn tail_observed(
        &self,
        params: CaptureTailParams,
        actor: &AuthenticatedActor,
        mut observe: impl FnMut(TailPhase) + Send + 'static,
    ) -> HostResult<CaptureTailResult> {
        if !(1..=100).contains(&params.max_records.get())
            || !(1..=262144).contains(&params.max_bytes.get())
        {
            return Err(invalid());
        }
        let permit = self
            .tail_budget
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let service = self.clone();
        let actor = actor.clone();
        blocking(move || {
            // 等待者被取消后，实际扫描仍持有名额，完成或出错才释放。
            let _permit = permit;
            let files = &service.runtime.files;
            let reference = files.current_reference(&params.capture_ref, &actor)?;
            {
                let active = service.active.lock().map_err(|_| busy())?;
                if active
                    .get(&reference.id)
                    .is_some_and(|capture| capture.done.borrow().is_none())
                {
                    return Err(HostError::new(
                        "CAPTURE_ACTIVE",
                        "Capture is still recording",
                    ));
                }
            }
            let guard = files.resolve(&reference, &actor, false)?;
            let mut scan = verify::verify_directory(guard.checked_path())?;
            observe(TailPhase::BindFiles);
            scan.bind_files(guard.checked_path())
                .map_err(|_| format::changed())?;
            let prefix = scan.report.verified_prefix.get();
            let mut result = CaptureTailResult {
                capture_ref: reference.clone(),
                source_fingerprint: scan.report.source_fingerprint.clone(),
                state: scan.summary.state,
                verified_prefix: scan.report.verified_prefix,
                container_complete: scan.report.container_complete,
                source_continuous: scan.report.source_continuous,
                first_record: prefix.checked_add(1).ok_or_else(tail_limit)?.into(),
                records: vec![],
            };
            let fits = |result: &CaptureTailResult| -> HostResult<bool> {
                Ok(
                    serde_json::to_vec(result).map_err(|_| invalid())?.len() as u64
                        <= params.max_bytes.get(),
                )
            };
            if !fits(&result)? {
                return Err(tail_limit());
            }
            let start = prefix.saturating_sub(params.max_records.get());
            for position in (start..prefix).rev() {
                observe(TailPhase::ReadRecord);
                let (record, json) = scan
                    .read_verified_record_bytes(position as usize)
                    .map_err(|_| format::changed())?;
                let ordinal = record.record_ordinal;
                let previous_first = result.first_record;
                result.first_record = ordinal;
                result.records.insert(0, ReplayRecord::Inline { record });
                if !fits(&result)? {
                    result.records[0] = files.publish_record(&reference, &actor, ordinal, &json)?;
                    if !fits(&result)? {
                        result.records.remove(0);
                        result.first_record = previous_first;
                        if result.records.is_empty() {
                            return Err(tail_limit());
                        }
                        break;
                    }
                }
            }
            // 重新解析原引用，核对路径身份、固定修订和本次完整指纹后才交付正文。
            observe(TailPhase::ReturnResult);
            let current = files.current_reference(&params.capture_ref, &actor)?;
            if current != reference {
                return Err(format::changed());
            }
            let final_guard = files.resolve(&current, &actor, false)?;
            if final_guard.directory_identity()? != guard.directory_identity()?
                || format::fingerprint(final_guard.checked_path()).map_err(|_| format::changed())?
                    != result.source_fingerprint
            {
                return Err(format::changed());
            }
            Ok(result)
        })
        .await
    }
    pub fn recovery_authorization_target(
        &self,
        params: &RecoverPrefixParams,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<Target> {
        if !matches!(permission, "metadata.read" | "content.read") {
            return Err(invalid());
        }
        let source = {
            let cache = self.verifications.lock().map_err(|_| busy())?;
            let lease = cache
                .iter()
                .find(|lease| lease.report.verification_id == params.verification_id)
                .ok_or_else(|| HostError::new("NOT_FOUND", "Verification lease was not found"))?;
            if lease.actor_id != *actor.id()
                || lease.report.source_fingerprint != params.source_fingerprint
            {
                return Err(format::changed());
            }
            lease.reference.clone()
        };
        self.runtime
            .files
            .authorization_target(&source, actor, permission)
    }
    pub async fn recover_prefix(
        &self,
        params: RecoverPrefixParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<ObjectRef> {
        let (source, report, source_scan) = {
            let mut cache = self.verifications.lock().map_err(|_| busy())?;
            let position = cache
                .iter()
                .position(|lease| lease.report.verification_id == params.verification_id)
                .ok_or_else(|| HostError::new("NOT_FOUND", "Verification lease was not found"))?;
            let lease = &cache[position];
            if lease.actor_id != *actor.id()
                || lease.report.source_fingerprint != params.source_fingerprint
            {
                return Err(format::changed());
            }
            let lease = cache.remove(position).expect("existing verification lease");
            (lease.reference, lease.report, lease._scan)
        };
        let files = self.runtime.files.clone();
        let a = actor.clone();
        let target = params.target_ref.clone();
        let recovered = blocking(move || {
            let _source_scan = source_scan;
            let source = files.resolve(&source, &a, false)?;
            let destination = files.resolve(&target, &a, true)?;
            let summary = recovery::recover_at(source.checked_path(), &destination, &report)?;
            let reference = files.begin_capture(
                &target,
                destination.checked_path(),
                &summary.capture_id,
                &a,
                false,
                None,
            )?;
            files.publish_capture(
                &reference,
                destination.checked_path(),
                summary
                    .source_fingerprint
                    .as_ref()
                    .ok_or_else(format::corrupt)?,
                &a,
            )
        })
        .await?;

        Ok(recovered)
    }
    pub async fn export_text(
        &self,
        params: TextExportParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<ObjectRef> {
        let files = self.runtime.files.clone();
        let a = actor.clone();
        let target = params.target_ref.clone();
        blocking(move || {
            let source = files.resolve(&params.capture_ref, &a, false)?;
            let destination = files.resolve(&target, &a, true)?;
            text_export::export_at(source.checked_path(), &destination)?;
            files.publish_file(&target, destination.checked_path(), &a)
        })
        .await
    }
    pub async fn shutdown(&self) -> HostResult<()> {
        self.verifications.lock().map_err(|_| busy())?.clear();
        let pending: Vec<_> = self
            .active
            .lock()
            .map_err(|_| busy())?
            .values()
            .map(|a| {
                a.stop.send_replace(true);
                a.done.clone()
            })
            .collect();
        for mut done in pending {
            // done 只在 writer 与 readers 释放后发布；其中的 Err 是已持久化的业务结果。
            while done.borrow().is_none() {
                done.changed().await.map_err(|_| busy())?;
            }
        }
        Ok(())
    }
}
async fn pump(
    runtime: Arc<CaptureRuntime>,
    actor: AuthenticatedActor,
    reference: ObjectRef,
    reader: RawSubscription,
    sender: mpsc::SyncSender<CapturedBatch>,
    mut stopped: watch::Receiver<bool>,
    budget: PumpBudget,
) -> HostResult<()> {
    let mut granted = budget.reader_credit;
    loop {
        if *stopped.borrow() {
            return Ok(());
        }
        let batch = tokio::select! {biased;_ = stopped.changed()=>return Ok(()),batch=reader.next()=>batch?};
        let Some(batch) = batch else { return Ok(()) };
        let files = runtime.files.clone();
        let r = reference.clone();
        let a = actor.clone();
        blocking(move || files.resolve(&r, &a, true).map(|_| ())).await?;
        let encoded = serde_json::to_vec(batch.batch())
            .map_err(|_| invalid())?
            .len();
        let cost = encoded
            .checked_mul(4)
            .and_then(|v| v.checked_add(8192))
            .ok_or_else(invalid)?;
        let permits = u32::try_from(cost).map_err(|_| invalid())?;
        let local = budget
            .capture
            .clone()
            .try_acquire_many_owned(permits)
            .map_err(|_| queue_overflow())?;
        let global = budget
            .host
            .clone()
            .try_acquire_many_owned(permits)
            .map_err(|_| queue_overflow())?;
        budget.peak.fetch_max(
            HOST_CAPTURE_QUEUE_BYTES - budget.host.available_permits(),
            Ordering::Relaxed,
        );
        let items = batch
            .batch()
            .items
            .iter()
            .map(|item| match item {
                StreamItem::Source { event } => CaptureEntry::Event(event.clone()),
                StreamItem::ReaderGap { gap } => CaptureEntry::ReaderGap(Box::new(gap.clone())),
            })
            .collect();
        sender
            .try_send(CapturedBatch {
                entries: items,
                _capture: local,
                _host: global,
            })
            .map_err(|_| queue_overflow())?;
        reader.mark_sent(&batch)?;
        granted = granted.checked_add(encoded as u64).ok_or_else(invalid)?;
        runtime
            .streams
            .credit(
                &actor,
                StreamCreditParams {
                    subscription_id: reader.id().clone(),
                    ack_cursor: batch.batch().cursor.clone(),
                    granted_bytes_total: granted.into(),
                },
            )
            .await?;
    }
}
fn close_readers(readers: &[RawSubscription]) {
    for reader in readers {
        reader.close();
    }
}
fn queue_overflow() -> HostError {
    HostError::new(
        "CAPTURE_IO_FAILED",
        "Capture writer byte budget or queue exhausted",
    )
}
async fn wait_done(
    done: &mut watch::Receiver<Option<HostResult<CaptureSummary>>>,
) -> HostResult<CaptureSummary> {
    loop {
        if let Some(result) = done.borrow().clone() {
            return result;
        }
        done.changed().await.map_err(|_| busy())?;
    }
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> HostResult<T> + Send + 'static,
) -> HostResult<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| busy())?
}
fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid capture request")
}
fn busy() -> HostError {
    HostError::new("HOST_BUSY", "Capture state is unavailable")
}

fn tail_limit() -> HostError {
    HostError::new(
        "LIMIT_EXCEEDED",
        "Capture tail does not fit the encoded response budget",
    )
}

#[cfg(test)]
mod tail_tests {
    use super::*;
    use crate::{
        state::{ProjectionLimits, ProjectionStore},
        stream::StreamLimits,
    };
    use serde_json::json;
    struct Fixture {
        _dir: tempfile::TempDir,
        path: std::path::PathBuf,
        service: CaptureService,
        actor: AuthenticatedActor,
        reference: ObjectRef,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let store = Store::open(dir.path()).unwrap();
            let identity = store.begin_instance().unwrap();
            let secret = ContextToken::try_from("tail-test").unwrap();
            let auth = AuthService::new(store.clone(), secret.clone());
            let operator = auth
                .authenticate_user_control(&Id::try_from("user").unwrap(), &secret)
                .unwrap();
            let actor = auth
                .authenticate(&Id::try_from("user").unwrap(), None)
                .unwrap()
                .actor;
            auth.authorize(
                &operator,
                AuthorizeParams {
                    client_id: actor.client_id().clone(),
                    permissions: vec!["content.read".into(), "workspace.modify".into()],
                    targets: vec![Target {
                        host_id: identity.host_id.clone(),
                        kind: ResourceKind::try_from("host").unwrap(),
                        id: identity.host_id.clone(),
                        session_id: None,
                        session_epoch: None,
                    }],
                    expires_at: None,
                },
            )
            .unwrap();
            let files = FileService::new(store.clone(), auth.clone(), identity.clone());
            let path = dir.path().canonicalize().unwrap().join("abandoned");
            let location = files
                .register(
                    RegisterFileParams {
                        path: path.to_str().unwrap().into(),
                        purpose: FilePurpose::CaptureTarget,
                    },
                    &operator,
                )
                .unwrap();
            let source = serde_json::from_value(json!({"hostId":"original","instanceEpoch":"7","sessionId":"source","sessionEpoch":"9","configurationDigest":"0000000000000000000000000000000000000000000000000000000000000000","configuration":SerialConfiguration::default(),"timePrecision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}})).unwrap();
            let mut writer =
                CaptureWriter::create(&path, vec![source], CaptureLimits::default()).unwrap();
            let event = serde_json::from_value(json!({"hostId":"original","instanceEpoch":"7","sessionId":"source","sessionEpoch":"9","eventSeq":"1","configurationRevision":"1","time":{"clockId":"c","sourceMonoNs":"1","receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},"kind":"lifecycle","payload":{"note":"original"}})).unwrap();
            writer
                .push(CaptureEntry::Event(Box::new(event)), 0)
                .unwrap();
            let summary = writer.finish().unwrap();
            // 模拟写入结束后发布前退出：当前 0.1 capture 引用仍合法且没有 revision。
            let reference = files
                .begin_capture(&location, &path, &summary.capture_id, &actor, false, None)
                .unwrap();
            let clock: Arc<dyn Clock> = Arc::new(crate::test_support::ManualClock(0.into()));
            let streams = StreamHub::new(identity.clone(), auth.clone(), StreamLimits::default());
            let projections =
                ProjectionStore::new(identity.clone(), auth.clone(), ProjectionLimits::default());
            let devices = DeviceService::new(
                store.clone(),
                auth.clone(),
                identity.clone(),
                streams.clone(),
                clock.clone(),
                DeviceService::virtual_opener(),
                projections,
            );
            let service = CaptureService::new(CaptureRuntime {
                store,
                auth,
                identity,
                files,
                streams,
                devices,
                clock,
            });
            Self {
                _dir: dir,
                path,
                service,
                actor,
                reference,
            }
        }
        fn params(&self) -> CaptureTailParams {
            CaptureTailParams {
                capture_ref: self.reference.clone(),
                max_records: 100.into(),
                max_bytes: 262144.into(),
            }
        }
        fn no_retained_resources(&self) {
            assert!(self.service.verifications.lock().unwrap().is_empty());
            assert!(self.service.active.lock().unwrap().is_empty());
            assert!(self.service.starts.lock().unwrap().is_empty());
            assert_eq!(self.service.tail_budget.available_permits(), 1);
            assert_eq!(
                self.service
                    .runtime
                    .store
                    .operation_metadata()
                    .unwrap()
                    .get("items"),
                Some(&JsonValue::Array(vec![]))
            );
        }
    }
    #[tokio::test]
    async fn abandoned_live_capture_tail_uses_local_snapshot_and_releases_all_handles() {
        let f = Fixture::new();
        let before = format::fingerprint(&f.path).unwrap();
        for _ in 0..18 {
            let result = f.service.tail(f.params(), &f.actor).await.unwrap();
            assert_eq!(result.capture_ref, f.reference);
            assert_eq!(result.verified_prefix.get(), 1);
            assert_eq!(result.source_fingerprint, before);
            f.no_retained_resources();
        }
        assert_eq!(format::fingerprint(&f.path).unwrap(), before);
        std::fs::rename(&f.path, f.path.with_file_name("archived")).unwrap();
    }
    #[tokio::test]
    async fn capture_tail_source_change_at_each_consumption_boundary_is_atomic() {
        for phase in [
            TailPhase::BindFiles,
            TailPhase::ReadRecord,
            TailPhase::ReturnResult,
        ] {
            let f = Fixture::new();
            let path = f.path.clone();
            let result = f
                .service
                .tail_observed(f.params(), &f.actor, move |current| {
                    if current == phase {
                        let volume = path.join(format::volume_name(1));
                        let mut bytes = std::fs::read(&volume).unwrap();
                        *bytes.last_mut().unwrap() ^= 1;
                        std::fs::write(volume, bytes).unwrap();
                    }
                })
                .await;
            assert_eq!(result.unwrap_err().code, "SOURCE_CHANGED");
            f.no_retained_resources();
            std::fs::rename(&f.path, f.path.with_file_name("archived")).unwrap();
        }
    }
    #[tokio::test]
    async fn capture_tail_cancelled_waiter_keeps_scan_admission_until_worker_exits() {
        let f = Fixture::new();
        let gate = Arc::new(crate::test_support::Gate::default());
        let seen = gate.clone();
        let service = f.service.clone();
        let actor = f.actor.clone();
        let params = f.params();
        let waiting = tokio::spawn(async move {
            service
                .tail_observed(params, &actor, move |phase| {
                    if phase == TailPhase::BindFiles {
                        seen.hold();
                    }
                })
                .await
        });
        gate.entered().await;
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());
        assert_eq!(
            f.service.tail(f.params(), &f.actor).await.unwrap_err().code,
            "HOST_BUSY"
        );
        gate.release();
        crate::test_support::until(|| f.service.tail_budget.available_permits() == 1).await;
        f.no_retained_resources();
        f.service.tail(f.params(), &f.actor).await.unwrap();
    }

    #[tokio::test]
    async fn capture_tail_revoked_during_scan_returns_no_content() {
        let f = Fixture::new();
        let auth = f.service.runtime.auth.clone();
        let operator = auth
            .authenticate_user_control(
                &Id::try_from("user").unwrap(),
                &ContextToken::try_from("tail-test").unwrap(),
            )
            .unwrap();
        let actor_id = f.actor.id().clone();
        let identity = f.service.runtime.identity.clone();
        let result = f
            .service
            .tail_observed(f.params(), &f.actor, move |phase| {
                if phase == TailPhase::ReadRecord {
                    auth.revoke(
                        &operator,
                        RevokeParams {
                            actor_id: actor_id.clone(),
                            permissions: vec!["content.read".into()],
                            targets: vec![Target {
                                host_id: identity.host_id.clone(),
                                kind: ResourceKind::try_from("host").unwrap(),
                                id: identity.host_id.clone(),
                                session_id: None,
                                session_epoch: None,
                            }],
                        },
                    )
                    .unwrap();
                }
            })
            .await;
        assert_eq!(result.unwrap_err().code, "PERMISSION_DENIED");
        f.no_retained_resources();
    }
}
