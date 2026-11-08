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
        let mut call = self.h.call(&self.target(&self.location), "capture.start", json!({"sessionRefs":[self.session],"targetRef":self.location,"overflowPolicy":"stop","writeMode": if append { "append" } else { "create_new" }}));
        call.execution_mode = Some(ExecutionMode::Independent);
        let accepted = self.h.invoke(call).await;
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

struct CaptureGateRelease(Arc<crate::test_support::Gate>);
impl Drop for CaptureGateRelease {
    fn drop(&mut self) {
        self.0.release();
    }
}
struct GatedFailureVolume {
    file: Option<std::fs::File>,
    gate: Arc<crate::test_support::Gate>,
    armed: Arc<std::sync::atomic::AtomicBool>,
    closed: Arc<std::sync::atomic::AtomicBool>,
}
impl std::io::Write for GatedFailureVolume {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
            while !self.gate.is_released() {
                self.gate.hold();
            }
            return Err(std::io::Error::other("gated capture write failure"));
        }
        std::io::Write::write(self.file.as_mut().unwrap(), bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        std::io::Write::flush(self.file.as_mut().unwrap())
    }
}
impl crate::capture::writer::CaptureVolume for GatedFailureVolume {
    fn sync_all(&mut self) -> std::io::Result<()> {
        self.file.as_ref().unwrap().sync_all()
    }
    fn length(&self) -> std::io::Result<u64> {
        Ok(self.file.as_ref().unwrap().metadata()?.len())
    }
}
impl Drop for GatedFailureVolume {
    fn drop(&mut self) {
        self.file.take();
        self.closed.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

#[tokio::test]
async fn final_fix_pending_capture_failure_retains_owner_until_real_file_is_released() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let gate = Arc::new(crate::test_support::Gate::default());
    let _release = CaptureGateRelease(gate.clone());
    let armed = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    let opener = {
        let gate = gate.clone();
        let armed = armed.clone();
        let closed = closed.clone();
        Arc::new(move |file| {
            Ok(Box::new(GatedFailureVolume {
                file: Some(file),
                gate: gate.clone(),
                armed: armed.clone(),
                closed: closed.clone(),
            })
                as Box<dyn crate::capture::writer::CaptureVolume>)
        })
    };
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
