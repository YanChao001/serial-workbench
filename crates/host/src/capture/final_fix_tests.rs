use super::*;
use crate::{
    auth::AuthenticatedActor,
    capture::{CaptureRuntime, verify::verify_directory, writer::CaptureLimits},
    device::DeviceService,
    test_support::{Harness, id},
};
use serde_json::json;
use std::time::Duration;

struct Fixture {
    h: Harness,
    operator: AuthenticatedActor,
    session: Target,
    location: ObjectRef,
    path: std::path::PathBuf,
}
impl Fixture {
    async fn new(limits: CaptureLimits) -> Self {
        Self::with_storage(limits, crate::capture::writer::native_volume_opener()).await
    }
    async fn with_storage(
        limits: CaptureLimits,
        opener: crate::capture::writer::VolumeOpener,
    ) -> Self {
        let mut h = Harness::new().await;
        h.host.shutdown().await.unwrap();
        h.host = Host::with_runtime(
            h.store.clone(),
            h.auth.clone(),
            h.clock.clone(),
            DeviceService::virtual_opener(),
        )
        .await
        .unwrap();
        h.host.stop_operation_projection().await.unwrap();
        {
            let inner = Arc::get_mut(&mut h.host.inner).expect("test setup owns the idle Host");
            inner.capture_api = crate::capture_api::with_storage_for_test(
                CaptureRuntime {
                    store: h.store.clone(),
                    auth: h.auth.clone(),
                    identity: h.store.identity().unwrap(),
                    files: inner.files.clone(),
                    streams: inner.streams.clone(),
                    devices: inner.devices.clone(),
                    clock: h.clock.clone(),
                },
                limits,
                opener,
            );
        }
        h.host.start_operation_projection().unwrap();
        let operator = h
            .auth
            .authenticate_user_control(
                &id("client"),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let host_target = Target {
            host_id: h.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: h.host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        h.auth
            .authorize(
                &operator,
                AuthorizeParams {
                    client_id: h.actor.client_id().clone(),
                    permissions: vec!["workspace.modify".into(), "metadata.read".into()],
                    targets: vec![host_target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
        let path = h.dir.path().canonicalize().unwrap().join("recording");
        let metadata = h
            .host
            .inner
            .files
            .register(
                RegisterFileParams {
                    path: path.to_str().unwrap().into(),
                    purpose: FilePurpose::CaptureTarget,
                },
                &operator,
            )
            .unwrap();
        let session = h.open("virtual:echo").await;
        Self {
            h,
            operator,
            session,
            location: metadata,
            path,
        }
    }
    fn target(&self, reference: &ObjectRef) -> Target {
        Target {
            host_id: reference.host_id.clone(),
            kind: reference.kind.clone(),
            id: reference.id.clone(),
            session_id: None,
            session_epoch: None,
        }
    }
    async fn query(
        &self,
        actor: &AuthenticatedActor,
        action: &str,
        target: Target,
        params: serde_json::Value,
    ) -> HostResult<QueryResult> {
        let call = self.h.call_as(actor, &target, action, params);
        self.h
            .host
            .query(
                actor,
                Query {
                    protocol_version: call.protocol_version,
                    host_id: call.host_id,
                    instance_epoch: call.instance_epoch,
                    actor_id: call.actor_id,
                    request_id: call.request_id,
                    action_id: call.action_id,
                    target: call.target,
                    params: call.params,
                    reveal_target: call.reveal_target,
                },
            )
            .await
    }
    async fn start(&self, append: bool) -> (Operation, ObjectRef) {
        self.start_with_options(append, None).await
    }
    async fn start_with_options(
        &self,
        append: bool,
        rules: Option<&[CaptureRedactionRule]>,
    ) -> (Operation, ObjectRef) {
        let accepted = self.request_start(append, rules).await;
        let live = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let current = self
                    .h
                    .store
                    .get(&self.h.actor, &accepted.operation_id)
                    .unwrap();
                if let Some(ActionResult::Reference(reference)) = current.result {
                    break reference.result_ref;
                }
                assert!(
                    matches!(
                        current.state,
                        OperationState::Queued | OperationState::Running
                    ),
                    "capture start failed: {:?}",
                    current.error
                );
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
        (accepted, live)
    }
    async fn request_start(
        &self,
        append: bool,
        rules: Option<&[CaptureRedactionRule]>,
    ) -> Operation {
        let mut params = json!({"sessionRefs":[self.session],"targetRef":self.location,"overflowPolicy":"stop","writeMode": if append { "append" } else { "create_new" }});
        if let Some(rules) = rules {
            params["mode"] = json!("redacted");
            params["redactionRules"] = json!(rules);
        }
        let mut call = self
            .h
            .call(&self.target(&self.location), "capture.start", params);
        call.execution_mode = Some(ExecutionMode::Independent);
        self.h.invoke(call).await
    }
    async fn tx(&self, bytes: &str) {
        let before = self
            .h
            .host
            .streams()
            .current_cursor(&self.session)
            .unwrap()
            .position
            .get();
        let sent = self
            .h
            .action(
                &self.session,
                "session.tx",
                json!({"bytesBase64": bytes,"writeWaitMs":"100"}),
            )
            .await;
        assert_eq!(sent.state, OperationState::Succeeded, "{:?}", sent.error);
        tokio::time::timeout(Duration::from_secs(5), async {
            while self
                .h
                .host
                .streams()
                .current_cursor(&self.session)
                .unwrap()
                .position
                .get()
                < before + 3
            {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("real virtual RX must enter the Host source before continuing");
    }
    async fn written(&self, live: &ObjectRef, minimum: u64) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let QueryResult::CaptureStatus(status) = self
                    .query(
                        &self.h.actor,
                        "capture.status",
                        self.target(live),
                        json!({"captureRef":live}),
                    )
                    .await
                    .unwrap()
                else {
                    panic!("status")
                };
                if status.summary.watermarks.written.get() >= minimum {
                    break;
                }
                assert_eq!(status.summary.state, CaptureState::Recording);
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap();
    }
    async fn stop(&self, owner: &Operation, live: &ObjectRef) -> (Operation, Operation) {
        let stopped = self
            .h
            .action(
                &self.target(live),
                "capture.stop",
                json!({"captureRef":live}),
            )
            .await;
        let owner = self.h.wait(&owner.operation_id).await;
        (stopped, owner)
    }
    async fn get(
        &self,
        actor: &AuthenticatedActor,
        operation: &Operation,
    ) -> HostResult<QueryResult> {
        self.query(
            actor,
            "operation.get",
            Target {
                host_id: self.h.host_id.clone(),
                kind: ResourceKind::try_from("host").unwrap(),
                id: self.h.host_id.clone(),
                session_id: None,
                session_epoch: None,
            },
            json!({"operationId":operation.operation_id}),
        )
        .await
    }
}
fn fixed(operation: &Operation) -> ObjectRef {
    let Some(ActionResult::CaptureStatus(status)) = &operation.result else {
        panic!("capture result: {:?}", operation.error)
    };
    status.capture_ref.clone()
}
fn records(path: &std::path::Path) -> Vec<CaptureRecord> {
    let mut scan = verify_directory(path).unwrap();
    assert!(scan.report.container_complete);
    scan.bind_files(path).unwrap();
    (0..scan.index.records.len())
        .map(|position| scan.read_verified_record(position).unwrap())
        .collect()
}

async fn written_rx(path: &std::path::Path, volume: u64, expected: &str) {
    use std::io::Read;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let mut file =
                std::fs::File::open(path.join(crate::capture::format::volume_name(volume)))
                    .unwrap();
            let mut magic = [0; 7];
            file.read_exact(&mut magic).unwrap();
            assert_eq!(&magic, crate::capture::format::MAGIC);
            loop {
                let mut length = [0; 4];
                if file.read_exact(&mut length).is_err() {
                    break;
                }
                let mut json = vec![0; u32::from_le_bytes(length) as usize];
                let mut digest = [0; 32];
                if file.read_exact(&mut json).is_err() || file.read_exact(&mut digest).is_err() {
                    break;
                }
                let record: CaptureRecord = serde_json::from_slice(&json).unwrap();
                if let CaptureEntry::Event(event) = record.entry
                    && let RawPayload::Rx(rx) = event.payload
                    && rx.bytes_base64.as_str() == expected
                {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("capture must write actual RX before the stop boundary");
}

#[tokio::test]
async fn capture_source_revoke_before_queue_admission_keeps_only_the_authorized_prefix() {
    let f = Fixture::new(CaptureLimits::default()).await;
    let (owner, _) = f.start(false).await;
    f.tx("AQ==").await;
    written_rx(&f.path, 1, "AQ==").await;

    let mut admission = f.h.host.inner.capture_api.capture_queue_gate().arm();
    f.tx("Ag==").await;
    admission.entered().await;
    f.h.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.h.actor.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.session.clone()],
            },
        )
        .unwrap();
    admission.release();

    let failed = f.h.wait(&owner.operation_id).await;
    assert_eq!(failed.state, OperationState::Failed);
    assert_eq!(failed.error.unwrap().code, "PERMISSION_DENIED");
    let mut scan = verify_directory(&f.path).unwrap();
    scan.bind_files(&f.path).unwrap();
    let received: Vec<_> = (0..scan.index.records.len())
        .filter_map(
            |position| match scan.read_verified_record(position).unwrap().entry {
                CaptureEntry::Event(event) => match event.payload {
                    RawPayload::Rx(rx) => Some(rx.bytes_base64.to_string()),
                    _ => None,
                },
                CaptureEntry::ReaderGap(_) | CaptureEntry::TxSettlement(_) => None,
                CaptureEntry::Redacted(_) => {
                    panic!("Raw duplicate-settlement fixture produced transformed data")
                }
            },
        )
        .collect();
    assert_eq!(received, ["AQ=="]);
    drop(scan);
    f.h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn redacted_capture_revokes_before_rx_suffix_and_preserves_only_authorized_receive_text() {
    assert_redacted_revoke_before_rx_suffix("content.read", |f| f.session.clone()).await;
}

#[tokio::test]
async fn redacted_capture_target_revoke_stops_admission_and_publication() {
    assert_redacted_revoke_before_rx_suffix("workspace.modify", |f| f.target(&f.location)).await;
}

async fn assert_redacted_revoke_before_rx_suffix(
    permission: &str,
    target: impl FnOnce(&Fixture) -> Target,
) {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let f = Fixture::new(CaptureLimits::default()).await;
    let target = target(&f);
    f.h.auth.require(&f.h.actor, permission, &target).unwrap();
    let rules = [CaptureRedactionRule {
        pattern: "token=[^ ]+".into(),
        replacement: "token=[hidden]".into(),
    }];
    let (owner, live) = f.start_with_options(false, Some(&rules)).await;
    f.tx(&STANDARD.encode(b"token=FIRST-APPROVED\n")).await;
    f.written(&live, 2).await;

    let gate = f.h.host.inner.capture_api.capture_queue_gate();
    let mut prefix = gate.arm();
    f.tx(&STANDARD.encode(b"pending tok")).await;
    prefix.entered().await;
    prefix.release();
    let mut suffix = gate.arm();
    f.tx(&STANDARD.encode(b"en=REVOKED-SUFFIX\n")).await;
    suffix.entered().await;
    f.h.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.h.actor.id().clone(),
                permissions: vec![permission.into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    assert_eq!(
        f.h.auth
            .require(&f.h.actor, permission, &target)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    suffix.release();

    let failed = f.h.wait(&owner.operation_id).await;
    assert_eq!(failed.state, OperationState::Failed);
    assert_eq!(failed.error.unwrap().code, "PERMISSION_DENIED");
    assert!(matches!(
        failed.result,
        Some(ActionResult::Reference(reference)) if reference.result_ref == live
    ));
    assert_eq!(
        f.h.host
            .inner
            .files
            .metadata(&live, &f.h.actor)
            .unwrap()
            .file_ref
            .revision,
        None
    );
    f.tx(&STANDARD.encode(b"token=AFTER-REVOKE\n")).await;
    let mut scan = verify_directory(&f.path).unwrap();
    assert_eq!(scan.summary.mode, CaptureMode::Redacted);
    assert_eq!(scan.summary.state, CaptureState::Failed);
    assert!(scan.report.container_complete);
    assert!(scan.report.recoverable);
    assert!(scan.manifest.redaction_resume.is_none());
    scan.bind_files(&f.path).unwrap();
    let mut received = Vec::new();
    for position in 0..scan.index.records.len() {
        let CaptureEntry::Redacted(record) = scan.read_verified_record(position).unwrap().entry
        else {
            panic!("unexpected non-text source entry");
        };
        if record
            .byte_range
            .as_ref()
            .is_some_and(|range| range.direction == Direction::Rx)
        {
            received.push(record.result);
        }
    }
    assert_eq!(
        received,
        [CaptureRedactedResult::Text {
            text: "token=[hidden]".into(),
            replacements: 1.into()
        }]
    );
    for entry in std::fs::read_dir(&f.path).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        for secret in [
            b"FIRST-APPROVED".as_slice(),
            b"REVOKED-SUFFIX",
            b"AFTER-REVOKE",
        ] {
            assert!(!bytes.windows(secret.len()).any(|part| part == secret));
        }
    }
    drop(scan);
    f.h.host.shutdown().await.unwrap();
}

struct CaptureGateRelease(Arc<crate::test_support::Gate>);
impl Drop for CaptureGateRelease {
    fn drop(&mut self) {
        self.0.release();
    }
}
struct GatedVolume {
    file: Option<std::fs::File>,
    gate: Arc<crate::test_support::Gate>,
    armed: Arc<std::sync::atomic::AtomicBool>,
    closed: Arc<std::sync::atomic::AtomicBool>,
    fail_write: bool,
}
impl std::io::Write for GatedVolume {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
            while !self.gate.is_released() {
                self.gate.hold();
            }
            if self.fail_write {
                return Err(std::io::Error::other("gated capture write failure"));
            }
        }
        std::io::Write::write(self.file.as_mut().unwrap(), bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        std::io::Write::flush(self.file.as_mut().unwrap())
    }
}
impl crate::capture::writer::CaptureVolume for GatedVolume {
    fn sync_all(&mut self) -> std::io::Result<()> {
        self.file.as_ref().unwrap().sync_all()
    }
    fn length(&self) -> std::io::Result<u64> {
        Ok(self.file.as_ref().unwrap().metadata()?.len())
    }
}
impl Drop for GatedVolume {
    fn drop(&mut self) {
        self.file.take();
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

fn gated_volume_opener(
    gate: Arc<crate::test_support::Gate>,
    armed: Arc<std::sync::atomic::AtomicBool>,
    closed: Arc<std::sync::atomic::AtomicBool>,
    fail_write: bool,
) -> crate::capture::writer::VolumeOpener {
    Arc::new(move |file| {
        Ok(Box::new(GatedVolume {
            file: Some(file),
            gate: gate.clone(),
            armed: armed.clone(),
            closed: closed.clone(),
            fail_write,
        }))
    })
}

#[tokio::test]
async fn redacted_slow_writer_stops_on_backpressure_and_recovers_only_admitted_prefix() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::sync::atomic::{AtomicBool, Ordering};

    let gate = Arc::new(crate::test_support::Gate::default());
    let _release = CaptureGateRelease(gate.clone());
    let armed = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    let opener = gated_volume_opener(gate.clone(), armed.clone(), closed.clone(), false);
    let f = Fixture::with_storage(CaptureLimits::default(), opener).await;
    let stream = f.h.host.streams();
    let reader_baseline = stream.memory_usage().reader_bytes;
    let capture = &f.h.host.inner.capture_api;
    let rules = [CaptureRedactionRule {
        pattern: "token=[^ ]+".into(),
        replacement: "token=[hidden]".into(),
    }];
    let (owner, live) = f.start_with_options(false, Some(&rules)).await;
    f.tx(&STANDARD.encode(b"token=FIRST-APPROVED\n")).await;
    f.written(&live, 2).await;
    assert!(stream.memory_usage().reader_bytes > reader_baseline);

    armed.store(true, Ordering::SeqCst);
    f.tx(&STANDARD.encode(b"token=ADMITTED-WHILE-BLOCKED\n"))
        .await;
    gate.entered().await;
    let queued_at_stall = capture.memory_usage().queued_bytes;
    let mut line = vec![b'x'; 32 * 1024];
    line[..16].copy_from_slice(b"OVERFLOW-RAW-DAT");
    *line.last_mut().unwrap() = b'\n';
    let payload = STANDARD.encode(line);
    for _ in 0..96 {
        if stream.memory_usage().reader_bytes == reader_baseline {
            break;
        }
        let before = capture.memory_usage().queued_bytes;
        f.tx(&payload).await;
        crate::test_support::until(|| {
            stream.memory_usage().reader_bytes == reader_baseline
                || capture.memory_usage().queued_bytes >= before + 64 * 1024
        })
        .await;
    }
    assert_eq!(stream.memory_usage().reader_bytes, reader_baseline);
    assert!(capture.memory_usage().queued_bytes > queued_at_stall + 64 * 1024);
    assert!(!closed.load(Ordering::SeqCst));
    assert!(
        !f.h.store
            .get(&f.h.actor, &owner.operation_id)
            .unwrap()
            .state
            .is_terminal()
    );

    // The session still accepts real input while the recording writer is blocked.
    let source_position_at_stop = stream.current_cursor(&f.session).unwrap().position;
    f.tx(&STANDARD.encode(b"token=AFTER-OVERFLOW\n")).await;
    gate.release();
    let failed = f.h.wait(&owner.operation_id).await;
    assert_eq!(failed.state, OperationState::Failed);
    let error = failed.error.unwrap();
    assert!(
        error.code == "READER_OVERFLOW"
            || (error.code == "CAPTURE_IO_FAILED"
                && error
                    .message
                    .contains("writer byte budget or queue exhausted")),
        "{error:?}"
    );
    assert!(closed.load(Ordering::SeqCst));
    assert_eq!(capture.memory_usage().queued_bytes, 0);

    let mut scan = verify_directory(&f.path).unwrap();
    assert_eq!(scan.summary.state, CaptureState::Failed);
    assert!(scan.report.container_complete);
    assert!(scan.report.recoverable);
    assert!(scan.report.verified_prefix.get() >= 4);
    assert!(scan.manifest.redaction_resume.is_none());
    let source_fingerprint = scan.report.source_fingerprint.clone();
    let recovered_path = f.path.with_file_name("redacted-recovery");
    let recovery =
        crate::capture::recovery::recover_directory(&f.path, &recovered_path, &scan.report)
            .unwrap();
    assert_eq!(recovery.state, CaptureState::Incomplete);
    assert_eq!(recovery.watermarks.verified, scan.report.verified_prefix);
    let mut recovered = verify_directory(&recovered_path).unwrap();
    assert_eq!(
        recovered.report.verified_prefix,
        scan.report.verified_prefix
    );
    assert!(recovered.manifest.redaction_resume.is_none());
    scan.bind_files(&f.path).unwrap();
    recovered.bind_files(&recovered_path).unwrap();
    let mut text_count = 0;
    for position in 0..scan.report.verified_prefix.get() as usize {
        let original = scan.read_verified_record(position).unwrap().entry;
        let copied = recovered.read_verified_record(position).unwrap().entry;
        assert_eq!(original, copied);
        let CaptureEntry::Redacted(record) = original else {
            panic!("overflow cannot create missing source ranges or raw records");
        };
        assert!(record.event_end <= source_position_at_stop.checked_next().unwrap());
        if let CaptureRedactedResult::Text { text, .. } = record.result {
            assert_eq!(text, "token=[hidden]");
            text_count += 1;
        }
    }
    assert_eq!(text_count, 4);
    for path in [&f.path, &recovered_path] {
        for entry in std::fs::read_dir(path).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            for secret in [
                b"FIRST-APPROVED".as_slice(),
                b"ADMITTED-WHILE-BLOCKED",
                b"OVERFLOW-RAW-DAT",
                b"AFTER-OVERFLOW",
            ] {
                assert!(!bytes.windows(secret.len()).any(|part| part == secret));
            }
        }
    }
    assert_eq!(
        crate::capture::format::fingerprint(&f.path).unwrap(),
        source_fingerprint
    );
    f.h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn final_fix_pending_capture_failure_retains_owner_until_real_file_is_released() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let gate = Arc::new(crate::test_support::Gate::default());
    let _release = CaptureGateRelease(gate.clone());
    let armed = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    let opener = gated_volume_opener(gate.clone(), armed.clone(), closed.clone(), true);
    let f = Fixture::with_storage(CaptureLimits::default(), opener).await;
    let (owner, _) = f.start(false).await;
    armed.store(true, Ordering::SeqCst);
    f.tx("AQ==").await;
    gate.entered().await;
    let pending = tokio::time::timeout(Duration::from_secs(6), f.h.host.shutdown())
        .await
        .expect("pending writer cleanup stays bounded");
    assert!(!closed.load(Ordering::SeqCst));
    gate.release();
    let failed = f.h.wait(&owner.operation_id).await;
    assert_eq!(pending.unwrap_err().code, "SHUTDOWN_INCOMPLETE");
    assert_eq!(failed.state, OperationState::Failed);
    assert_eq!(failed.error.as_ref().unwrap().code, "CAPTURE_IO_FAILED");
    assert!(closed.load(Ordering::SeqCst));
    assert!(failed.result.is_some());
    tokio::time::timeout(Duration::from_secs(6), f.h.host.shutdown())
        .await
        .unwrap()
        .expect("released writer must not leave a cached historical cleanup failure");
    assert_eq!(
        f.h.store.get(&f.h.actor, &owner.operation_id).unwrap(),
        failed
    );
}

#[tokio::test]
async fn final_fix_finished_capacity_failure_preserves_evidence_and_allows_host_shutdown() {
    let f = Fixture::new(CaptureLimits {
        capacity_bytes: 8192,
        ..CaptureLimits::default()
    })
    .await;
    let (owner, live) = f.start(false).await;
    f.tx("AQ==").await;
    f.written(&live, 3).await;
    use base64::Engine as _;
    f.tx(&base64::engine::general_purpose::STANDARD.encode([2; 8192]))
        .await;
    let failed = f.h.wait(&owner.operation_id).await;
    assert_eq!(failed.state, OperationState::Failed);
    assert_eq!(failed.error.as_ref().unwrap().code, "CAPTURE_IO_FAILED");
    assert!(
        failed.result.is_some(),
        "failed owner must retain its original capture reference"
    );
    let before = std::fs::read(f.path.join("manifest.json")).unwrap();
    let shutdown = tokio::time::timeout(Duration::from_secs(6), f.h.host.shutdown())
        .await
        .expect("shutdown remains bounded");
    assert_eq!(std::fs::read(f.path.join("manifest.json")).unwrap(), before);
    assert_eq!(
        f.h.store.get(&f.h.actor, &owner.operation_id).unwrap(),
        failed
    );
    assert_eq!(f.h.host.inner.capture_api.memory_usage().queued_bytes, 0);
    let scan = verify_directory(&f.path).unwrap();
    assert!(
        scan.report.verified_prefix.get() >= 3,
        "written failure evidence remains recoverable"
    );
    shutdown.expect("finished capture business failure must not permanently block Host exit");
}

#[tokio::test]
async fn final_fix_host_append_records_real_pause_gap_without_damaging_old_segment() {
    let f = Fixture::new(CaptureLimits::default()).await;
    let (owner, live) = f.start(false).await;
    f.tx("AQ==").await;
    f.written(&live, 3).await;
    let (stopped, first) = f.stop(&owner, &live).await;
    assert_eq!(stopped.state, OperationState::Succeeded);
    assert_eq!(first.state, OperationState::Succeeded);
    let old = records(&f.path);
    let old_volume = std::fs::read(f.path.join("volume-000001.swbr")).unwrap();
    let gap_start =
        f.h.host
            .streams()
            .current_cursor(&f.session)
            .unwrap()
            .position
            .get()
            + 1;
    f.tx("Ag==").await;
    let gap_end =
        f.h.host
            .streams()
            .current_cursor(&f.session)
            .unwrap()
            .position
            .get()
            + 1;
    let (owner, live) = f.start(true).await;
    f.tx("Aw==").await;
    f.written(&live, old.len() as u64 + 3).await;
    written_rx(&f.path, 2, "Aw==").await;
    let (stopped, appended) = f.stop(&owner, &live).await;
    let shutdown = f.h.host.shutdown().await;
    assert_eq!(
        stopped.state,
        OperationState::Succeeded,
        "{:?}",
        stopped.error
    );
    assert_eq!(
        appended.state,
        OperationState::Succeeded,
        "{:?}",
        appended.error
    );
    shutdown.unwrap();
    assert_eq!(
        std::fs::read(f.path.join("volume-000001.swbr")).unwrap(),
        old_volume
    );
    let all = records(&f.path);
    assert_eq!(&all[..old.len()], &old);
    let gaps: Vec<_> = all
        .iter()
        .filter_map(|r| {
            if let CaptureEntry::ReaderGap(gap) = &r.entry {
                Some(gap)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(gaps.len(), 1);
    assert_eq!(
        gaps[0].missing_event_range,
        ByteRange {
            start: gap_start.into(),
            end: gap_end.into()
        }
    );
    assert_eq!(
        serde_json::to_value(gaps[0].reason).unwrap(),
        json!("capture_paused")
    );
    let rx: Vec<_> = all
        .iter()
        .filter_map(|r| {
            if let CaptureEntry::Event(event) = &r.entry
                && let RawPayload::Rx(rx) = &event.payload
            {
                Some(rx.bytes_base64.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(rx, ["AQ==", "Aw=="]);
    let verified = verify_directory(&f.path).unwrap();
    assert!(verified.report.container_complete);
    assert!(!verified.report.source_continuous);
}

#[tokio::test]
async fn redacted_host_append_preserves_pause_gap_and_rejects_another_policy() {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let f = Fixture::new(CaptureLimits::default()).await;
    let rules = [CaptureRedactionRule {
        pattern: "token=[^ ]+".into(),
        replacement: "token=[hidden]".into(),
    }];
    let (owner, live) = f.start_with_options(false, Some(&rules)).await;
    f.tx(&STANDARD.encode(b"token=FIRST\n")).await;
    f.written(&live, 2).await;
    let (stopped, owner) = f.stop(&owner, &live).await;
    assert_eq!(
        stopped.state,
        OperationState::Succeeded,
        "{:?}",
        stopped.error
    );
    assert_eq!(owner.state, OperationState::Succeeded, "{:?}", owner.error);
    let first_ref = fixed(&owner);
    let manifest = f.path.join("manifest.json");
    let first_manifest = std::fs::read(&manifest).unwrap();
    let first_report = verify_directory(&f.path).unwrap();
    let saved = first_report.manifest.redaction_resume.unwrap().remove(0);
    let volume = f.path.join("volume-000001.swbr");
    let original = std::fs::read(&volume).unwrap();

    let different = [CaptureRedactionRule {
        pattern: rules[0].pattern.clone(),
        replacement: "[other]".into(),
    }];
    for attempted in [Some(different.as_slice()), None] {
        let operation = f.request_start(true, attempted).await;
        let rejected = f.h.wait(&operation.operation_id).await;
        assert_eq!(rejected.state, OperationState::Failed);
        assert_eq!(rejected.error.unwrap().code, "CONFIGURATION_CONFLICT");
        assert_eq!(std::fs::read(&manifest).unwrap(), first_manifest);
        assert_eq!(std::fs::read(&volume).unwrap(), original);
        assert!(!f.path.join("volume-000002.swbr").exists());
    }

    f.tx(&STANDARD.encode(b"paused tok")).await;
    let pause_end =
        f.h.host
            .streams()
            .current_cursor(&f.session)
            .unwrap()
            .position;
    let (owner, live) = f.start_with_options(true, Some(&rules)).await;
    assert_eq!(live.id, first_ref.id);
    f.tx(&STANDARD.encode(b"en=PAUSED-CANARY\ntoken=SECOND-CANARY\n"))
        .await;
    f.written(&live, 7).await;
    let (stopped, owner) = f.stop(&owner, &live).await;
    assert_eq!(
        stopped.state,
        OperationState::Succeeded,
        "{:?}",
        stopped.error
    );
    assert_eq!(owner.state, OperationState::Succeeded, "{:?}", owner.error);
    assert_ne!(fixed(&owner).revision, first_ref.revision);
    let mut scan = verify_directory(&f.path).unwrap();
    assert!(scan.report.container_complete);
    assert!(!scan.report.source_continuous);
    assert_eq!(std::fs::read(&volume).unwrap(), original);
    scan.bind_files(&f.path).unwrap();
    let CaptureEntry::ReaderGap(gap) = scan.read_verified_record(2).unwrap().entry else {
        panic!("expected explicit pause gap")
    };
    assert_eq!(gap.reason, ReaderGapReason::CapturePaused);
    assert_eq!(
        gap.missing_event_range,
        ByteRange {
            start: saved.event_position.checked_next().unwrap(),
            end: pause_end.checked_next().unwrap()
        }
    );
    let mut boundary_count = 0;
    let mut text_directions = Vec::new();
    for position in 3..scan.index.records.len() {
        let CaptureEntry::Redacted(record) = scan.read_verified_record(position).unwrap().entry
        else {
            panic!("expected transformed append entry")
        };
        match record.result {
            CaptureRedactedResult::Text { text, replacements } => {
                assert_eq!(text, "token=[hidden]");
                assert_eq!(replacements.get(), 1);
                text_directions.push(record.byte_range.unwrap().direction);
            }
            CaptureRedactedResult::Omitted { reason } => {
                assert_eq!(reason, CaptureRedactionOmission::Boundary);
                boundary_count += 1;
            }
        }
    }
    assert_eq!(boundary_count, 2);
    assert_eq!(text_directions.len(), 2);
    assert!(text_directions.contains(&Direction::Rx) && text_directions.contains(&Direction::Tx));
    drop(scan);
    let appended = std::fs::read(f.path.join("volume-000002.swbr")).unwrap();
    for secret in [b"PAUSED-CANARY".as_slice(), b"SECOND-CANARY"] {
        assert!(!appended.windows(secret.len()).any(|bytes| bytes == secret));
    }
    f.h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn recorded_peer_checks_cancellation_at_open_submit_and_close_boundaries() {
    let f = Fixture::new(CaptureLimits::default()).await;
    let (owner, live) = f.start(false).await;
    f.tx("AQID").await;
    f.written(&live, 3).await;
    let (_, finished) = f.stop(&owner, &live).await;
    let params = ReplayPeerOpenParams {
        capture_ref: fixed(&finished),
    };
    let replay = crate::capture::replay::ReplayService::new(
        f.h.host.inner.files.clone(),
        f.h.store.identity().unwrap(),
        f.h.clock.clone(),
    );
    fn cancelled() -> HostResult<()> {
        Err(HostError::new(
            "CANCELLED",
            "cancel requested before simulated effect",
        ))
    }
    let actor = &f.h.actor;
    let auth = &f.h.auth;
    for _ in 0..16 {
        let error = replay
            .open_peer(params.clone(), actor, auth, cancelled)
            .await
            .unwrap_err();
        assert_eq!(error.code, "CANCELLED");
    }
    let opened = replay
        .open_peer(params, actor, auth, || Ok(()))
        .await
        .unwrap();
    let target = Target {
        host_id: f.h.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
    };
    let input = ReplayPeerSubmitParams {
        bytes_base64: Bytes::try_from("AQID").unwrap(),
    };
    let error = replay
        .submit_peer(&target, 1.into(), input.clone(), actor, auth, cancelled)
        .await
        .unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    let before = replay.peer_state(&target, actor).await.unwrap();
    assert_eq!(before.progress.revision, 1.into());
    assert_eq!(before.progress.remaining_request_bytes, 3.into());
    assert!(before.responses.is_empty());

    let error = replay
        .close_peer(&target, actor, cancelled)
        .await
        .unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    let matched = replay
        .submit_peer(&target, 1.into(), input, actor, auth, || Ok(()))
        .await
        .unwrap();
    assert!(matched.at_end);
    assert_eq!(matched.revision, 2.into());
    replay.close_peer(&target, actor, || Ok(())).await.unwrap();
    f.h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn final_fix_historical_capture_operations_keep_authority_across_append() {
    let f = Fixture::new(CaptureLimits::default()).await;
    let (owner, live) = f.start(false).await;
    f.tx("AQ==").await;
    f.written(&live, 3).await;
    let (stopped, owner) = f.stop(&owner, &live).await;
    assert_eq!(owner.state, OperationState::Succeeded);
    let old_ref = fixed(&owner);
    let verified =
        f.h.action(
            &f.target(&old_ref),
            "capture.verify",
            json!({"captureRef":old_ref}),
        )
        .await;
    let replay =
        f.h.action(
            &f.target(&old_ref),
            "replay.open",
            json!({"captureRef":old_ref,"mode":"fastest"}),
        )
        .await;
    assert_eq!(verified.state, OperationState::Succeeded);
    assert_eq!(replay.state, OperationState::Succeeded);
    let reader =
        f.h.auth
            .authenticate(&id("history-reader"), None)
            .unwrap()
            .actor;
    f.h.auth
        .authorize(
            &f.operator,
            AuthorizeParams {
                client_id: reader.client_id().clone(),
                permissions: vec!["metadata.read".into(), "content.read".into()],
                targets: vec![f.session.clone(), f.target(&f.location)],
                expires_at: None,
            },
        )
        .unwrap();
    let historical = [&owner, &stopped, &verified, &replay];
    for op in historical {
        f.get(&reader, op).await.unwrap();
    }
    let (new_owner, new_live) = f.start(true).await;
    let after: Vec<_> = {
        let mut results = Vec::new();
        for op in historical {
            results.push(f.get(&reader, op).await);
        }
        results
    };
    let old_content =
        f.h.host
            .inner
            .files
            .resolve(&old_ref, &reader, false)
            .err()
            .expect("old fixed content must conflict");
    f.h.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: reader.id().clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.target(&f.location)],
            },
        )
        .unwrap();
    let mut revoked = Vec::new();
    for op in historical {
        revoked.push(f.get(&reader, op).await);
    }
    let (_, appended) = f.stop(&new_owner, &new_live).await;
    assert_eq!(
        appended.state,
        OperationState::Succeeded,
        "{:?}",
        appended.error
    );
    f.h.host.shutdown().await.unwrap();
    assert_eq!(old_content.code, "REVISION_CONFLICT");
    for (op, result) in historical.into_iter().zip(after) {
        let QueryResult::Operation(current) =
            result.expect("current original grants must permit historical inspection after append")
        else {
            panic!("operation")
        };
        assert_eq!(&current.operation, op);
    }
    for result in revoked {
        assert_eq!(result.unwrap_err().code, "PERMISSION_DENIED");
    }
}
