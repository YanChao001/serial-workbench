mod support;

use serial_workbench_core::*;
use serial_workbench_host::{
    capture::{
        CaptureRuntime, CaptureService,
        format::{MAGIC, fingerprint},
        verify::verify_directory,
        writer::CaptureLimits,
    },
    files::FileService,
    storage::{Acceptance, canonical_digest},
    stream::{SourceMeta, StreamHub, StreamKey, StreamLimits, StreamSource},
};
use std::{fs, path::PathBuf, sync::Arc, time::Duration};

struct Fixture {
    h: support::Harness,
    session: Target,
    files: FileService,
    service: CaptureService,
    source: StreamSource,
}

impl Fixture {
    async fn new(trusted: CaptureLimits) -> Self {
        let h = support::Harness::new().await;
        let session = h.open("public-capture-limits").await;
        let user = h
            .auth
            .authenticate_user_control(
                h.actor.client_id(),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        h.auth
            .authorize(
                &user,
                AuthorizeParams {
                    client_id: h.actor.client_id().clone(),
                    permissions: vec!["workspace.modify".into()],
                    targets: vec![Target {
                        host_id: h.host_id.clone(),
                        kind: ResourceKind::try_from("host").unwrap(),
                        id: h.host_id.clone(),
                        session_id: None,
                        session_epoch: None,
                    }],
                    expires_at: None,
                },
            )
            .unwrap();
        let identity = h.store.identity().unwrap();
        let files = FileService::new(h.store.clone(), h.auth.clone(), identity.clone());
        let streams = StreamHub::new(identity.clone(), h.auth.clone(), StreamLimits::default());
        let source = streams
            .register_source(
                StreamKey {
                    session_id: session.id.clone(),
                    session_epoch: session.session_epoch.unwrap(),
                },
                session.clone(),
            )
            .unwrap();
        let service = CaptureService::with_storage(
            CaptureRuntime {
                store: h.store.clone(),
                auth: h.auth.clone(),
                identity,
                files: files.clone(),
                streams,
                devices: h.host.devices().clone(),
                clock: h.clock.clone(),
            },
            trusted,
            Arc::new(|file| Ok(Box::new(file))),
        );
        Self {
            h,
            session,
            files,
            service,
            source,
        }
    }

    async fn start(
        &self,
        name: &str,
        limits: Option<CaptureStorageLimits>,
    ) -> (ObjectRef, PathBuf) {
        let path = self.h.dir.path().canonicalize().unwrap().join(name);
        let user = self
            .h
            .auth
            .authenticate_user_control(
                self.h.actor.client_id(),
                &ContextToken::try_from("test-user-control").unwrap(),
            )
            .unwrap();
        let location = self
            .files
            .register(
                RegisterFileParams {
                    path: path.to_string_lossy().into_owned(),
                    purpose: FilePurpose::CaptureTarget,
                },
                &user,
            )
            .unwrap();
        let mut wire = serde_json::json!({
            "sessionRefs":[self.session],
            "targetRef":location,
            "overflowPolicy":"stop"
        });
        if let Some(limits) = limits {
            wire["storageLimits"] = serde_json::to_value(limits).unwrap();
        }
        let business: JsonObject = serde_json::from_value(wire.clone()).unwrap();
        let params: CaptureStartParams =
            serde_json::from_value(serde_json::to_value(business).unwrap()).unwrap();
        let mut call = self.h.call(&self.session, "capture.start", wire);
        call.execution_mode = Some(ExecutionMode::Independent);
        let Acceptance::New(owner) = self
            .h
            .store
            .accept(&self.h.actor, &call, &canonical_digest(&call).unwrap())
            .unwrap()
        else {
            panic!("new independent capture operation")
        };
        self.h.store.mark_dispatch(&owner.operation_id).unwrap();
        let owner = self
            .h
            .store
            .get(&self.h.actor, &owner.operation_id)
            .unwrap();
        let reference = self
            .service
            .start(params, &owner, &self.h.actor)
            .await
            .unwrap();
        (reference, path)
    }

    fn emit(&self, ordinal: u64) {
        self.source
            .append_rx(
                SourceMeta {
                    configuration_revision: 1.into(),
                    time: EventTime {
                        clock_id: support::id("test-clock"),
                        source_mono_ns: ordinal.into(),
                        source_wall_time: None,
                        received_wall_time: self.h.clock.wall_time(),
                        precision: TimePrecision {
                            source: TimeSource::HostRead,
                            resolution_ns: 1.into(),
                            sync_method: "none".into(),
                            offset_estimate_ns: None,
                            offset_error_ns: None,
                            rtt_ns: None,
                        },
                    },
                },
                Arc::from(vec![ordinal as u8; 16_384]),
                None,
            )
            .unwrap();
    }

    async fn observed(&self, reference: &ObjectRef, records: u64) -> CaptureSummary {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let summary = self.service.status(reference, &self.h.actor).await.unwrap();
                if summary.state == CaptureState::Failed
                    || summary.watermarks.written.get() >= records
                {
                    return summary;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
    }

    async fn failed(&self, reference: &ObjectRef, path: &std::path::Path, prefix: u64) {
        let error = tokio::time::timeout(Duration::from_secs(5), self.service.wait(reference))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "CAPTURE_IO_FAILED");
        assert!(error.message.contains("capacity or disk reserve"));
        let summary = self.service.status(reference, &self.h.actor).await.unwrap();
        assert_eq!(summary.state, CaptureState::Failed);
        assert_eq!(summary.watermarks.written, U64::from(prefix));
        assert!(summary.watermarks.verified <= summary.watermarks.synced);
        assert!(summary.watermarks.synced <= summary.watermarks.flushed);
        assert!(summary.watermarks.flushed <= summary.watermarks.written);
        assert_eq!(summary.watermarks.verified, U64::from(0));
        assert!(!summary.container_complete);
        let before = fingerprint(path).unwrap();
        let scan = verify_directory(path).unwrap();
        assert_eq!(scan.report.verified_prefix, U64::from(prefix));
        assert!(scan.report.recoverable);
        assert_eq!(scan.summary.state, CaptureState::Failed);
        assert_eq!(fingerprint(path).unwrap(), before);
        let bytes = fs::read(path.join("volume-000001.swbr")).unwrap();
        assert!(bytes.starts_with(MAGIC));
        if prefix > 0 {
            let offset = MAGIC.len();
            let size = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            let record: CaptureRecord =
                serde_json::from_slice(&bytes[offset + 4..offset + 4 + size]).unwrap();
            assert_eq!(record.record_ordinal, U64::from(1));
            let CaptureEntry::Event(event) = record.entry else {
                panic!("RX record")
            };
            assert_eq!(event.event_seq, U64::from(1));
            let RawPayload::Rx(payload) = event.payload else {
                panic!("RX bytes")
            };
            use base64::Engine as _;
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(payload.bytes_base64.as_str())
                    .unwrap(),
                vec![1; 16_384]
            );
        }
    }
}

fn limits(capacity: u64, reserve: u64) -> CaptureStorageLimits {
    CaptureStorageLimits {
        capacity_bytes: PositiveU64::try_from(U64::from(capacity)).unwrap(),
        reserve_bytes: reserve.into(),
    }
}

#[tokio::test]
async fn public_capacity_limits_are_per_capture_and_omission_preserves_service_defaults() {
    let f = Fixture::new(CaptureLimits::default()).await;
    let (small, path) = f.start("small", Some(limits(40_000, 0))).await;
    let (large, _) = f.start("large", Some(limits(1_000_000, 0))).await;
    let (default, _) = f.start("default", None).await;
    f.emit(1);
    assert_eq!(f.observed(&small, 1).await.watermarks.written, U64::from(1));
    f.emit(2);
    assert_eq!(
        f.observed(&small, 2).await.state,
        CaptureState::Failed,
        "public capacity must stop only the small capture after its verified first record"
    );
    f.failed(&small, &path, 1).await;
    for reference in [&large, &default] {
        assert_eq!(
            f.observed(reference, 2).await.state,
            CaptureState::Recording
        );
        let complete = f.service.stop(reference, &f.h.actor).await.unwrap();
        assert_eq!(complete.state, CaptureState::Complete);
        assert_eq!(complete.watermarks.verified, U64::from(2));
    }
    f.service.shutdown().await.unwrap();
    let archived = path.with_file_name("archived-small");
    fs::rename(&path, &archived).unwrap();
    assert_eq!(
        verify_directory(&archived).unwrap().report.verified_prefix,
        U64::from(1)
    );
}

#[tokio::test]
async fn public_reserve_stops_before_first_record_and_does_not_contaminate_other_captures() {
    let f = Fixture::new(CaptureLimits::default()).await;
    let (reserved, path) = f.start("reserved", Some(limits(u64::MAX, u64::MAX))).await;
    let (unreserved, _) = f.start("unreserved", Some(limits(1_000_000, 0))).await;
    f.emit(1);
    assert_eq!(
        f.observed(&reserved, 1).await.state,
        CaptureState::Failed,
        "public disk reserve must stop before writing the first record"
    );
    f.failed(&reserved, &path, 0).await;
    assert_eq!(
        f.observed(&unreserved, 1).await.state,
        CaptureState::Recording
    );
    let complete = f.service.stop(&unreserved, &f.h.actor).await.unwrap();
    assert_eq!(complete.watermarks.verified, U64::from(1));
    f.service.shutdown().await.unwrap();
}

#[tokio::test]
async fn omitted_limits_keep_trusted_injection_while_public_override_changes_only_its_writer() {
    let f = Fixture::new(CaptureLimits {
        capacity_bytes: 40_000,
        reserve_bytes: 0,
        ..CaptureLimits::default()
    })
    .await;
    let (overridden, _) = f.start("overridden", Some(limits(1_000_000, 0))).await;
    let (trusted, path) = f.start("trusted", None).await;
    f.emit(1);
    f.observed(&overridden, 1).await;
    f.observed(&trusted, 1).await;
    f.emit(2);
    assert_eq!(
        f.observed(&overridden, 2).await.state,
        CaptureState::Recording,
        "explicit public capacity must override the trusted capacity for this writer"
    );
    assert_eq!(f.observed(&trusted, 2).await.state, CaptureState::Failed);
    f.failed(&trusted, &path, 1).await;
    let complete = f.service.stop(&overridden, &f.h.actor).await.unwrap();
    assert_eq!(complete.watermarks.verified, U64::from(2));
    f.service.shutdown().await.unwrap();
}
