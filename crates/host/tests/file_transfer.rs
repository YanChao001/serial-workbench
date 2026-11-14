mod support;
use serial_workbench_core::*;
use serial_workbench_host::files::FileService;
use std::sync::Arc;
use support::{Gate, Harness, WriteStep, id};

fn source(h: &Harness, bytes: &[u8]) -> ObjectRef {
    let path = h.dir.path().join("source.bin");
    std::fs::write(&path, bytes).unwrap();
    let operator = h
        .auth
        .authenticate_user_control(
            &id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    FileService::new(h.store.clone(), h.auth.clone(), h.store.identity().unwrap())
        .register(
            RegisterFileParams {
                path: path.to_str().unwrap().into(),
                purpose: FilePurpose::ReadFile,
            },
            &operator,
        )
        .unwrap()
}
fn params(reference: &ObjectRef) -> serde_json::Value {
    serde_json::json!({
        "sourceRef":reference,"offset":"0","length":"5","chunkBytes":"2",
        "bytesPerSecond":"1000000","interChunkMs":"0","writeWaitMs":"1000"
    })
}

fn receipts(h: &Harness, reference: &ObjectRef) -> FileTransferReceiptsResult {
    FileService::new(h.store.clone(), h.auth.clone(), h.store.identity().unwrap())
        .read_receipts(
            FileTransferReceiptsParams {
                receipts_ref: reference.clone(),
                start_ordinal: 0.into(),
                max_receipts: 256.into(),
                max_bytes: 50000.into(),
            },
            &h.actor,
        )
        .unwrap()
}

#[tokio::test]
async fn file_transfer_preserves_partial_and_cancel() {
    let mut h = Harness::new().await;
    let gate = Arc::new(Gate::default());
    let received = Arc::new(std::sync::Mutex::new(Vec::new()));
    let output = received.clone();
    let second = gate.clone();
    let clock = h.clock.clone();
    h.host = serial_workbench_host::Host::with_runtime(
        h.store.clone(),
        h.auth.clone(),
        h.clock.clone(),
        Arc::new(move |_, config| {
            Ok(Box::new(PrefixReceiver {
                inner: serial_workbench_host::device::virtual_backend::VirtualTransport::new(
                    config.clone(),
                ),
                bytes: output.clone(),
                second: second.clone(),
                clock: clock.clone(),
                calls: 0,
            }))
        }),
    )
    .await
    .unwrap();
    let target = h.open("transfer-partial").await;
    let reference = source(&h, &[1, 2, 3, 4, 5]);
    let mut call = h.call(&target, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    let operation = h.invoke(call).await;
    gate.entered().await;
    h.cancel(&operation).await;
    gate.release();
    let done = h.wait(&operation.operation_id).await;
    h.host.shutdown().await.unwrap();
    let value = serde_json::to_value(done.result).unwrap();
    assert_eq!(value["kind"], "file_transfer");
    assert_eq!(value["value"]["accepted"], "3");
    assert_eq!(value["value"]["unknown"], "0");
    assert_eq!(value["value"]["peerAcknowledged"], false);
    assert_eq!(done.state, OperationState::Cancelled);
    assert_eq!(received.lock().unwrap().as_slice(), &[1, 2, 3]);
    let progress = done.progress.expect("durable transfer progress");
    assert_eq!(progress.completed, U64::from(3));
    assert_eq!(progress.total, Some(U64::from(5)));
    assert_eq!(progress.unit, "bytes");
}

#[test]
fn transfer_dto_default_and_strict_wire_contract() {
    let reference = serde_json::json!({"hostId":"host","kind":"file","id":"source","revision":"1"});
    let mut value = params(&serde_json::from_value(reference).unwrap());
    value.as_object_mut().unwrap().remove("chunkBytes");
    let parsed: FileTransferParams = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(parsed.chunk_bytes, U64::from(4096));
    value["chunkBytes"] = serde_json::Value::Null;
    assert!(serde_json::from_value::<FileTransferParams>(value.clone()).is_err());
    value["chunkBytes"] = serde_json::json!(2);
    assert!(serde_json::from_value::<FileTransferParams>(value.clone()).is_err());
    value["chunkBytes"] = serde_json::json!("2");
    value["unexpected"] = serde_json::json!("value");
    assert!(serde_json::from_value::<FileTransferParams>(value).is_err());
}

#[tokio::test]
async fn file_transfer_rejects_changed_revision_and_old_epoch_without_writes() {
    let h = Harness::new().await;
    let target = h.open("transfer-revision").await;
    let mut reference = source(&h, &[1, 2, 3, 4, 5]);
    reference.revision = Some(2.into());
    let mut call = h.call(&target, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    assert_eq!(
        h.host.invoke(&h.actor, call).await.unwrap_err().code,
        "REVISION_CONFLICT"
    );
    reference.revision = Some(1.into());
    let mut old = target;
    old.session_epoch = Some(old.session_epoch.unwrap().checked_next().unwrap());
    let mut call = h.call(&old, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    assert_eq!(
        h.host.invoke(&h.actor, call).await.unwrap_err().code,
        "EPOCH_MISMATCH"
    );
    h.host.shutdown().await.unwrap();
    assert_eq!(h.write_count(), 0);
}

#[tokio::test]
async fn file_transfer_is_one_exclusive_owner_while_rx_continues() {
    let h = Harness::new().await;
    let target = h.open("transfer-exclusive").await;
    let reference = source(&h, &[1, 2, 3, 4, 5]);
    let gate = Arc::new(Gate::default());
    h.probe.steps.lock().unwrap().extend([
        WriteStep {
            accepted: 2,
            unknown: false,
            gate: Some(gate.clone()),
            advance_ms: 1,
        },
        WriteStep {
            accepted: 2,
            unknown: false,
            gate: None,
            advance_ms: 1,
        },
        WriteStep {
            accepted: 1,
            unknown: false,
            gate: None,
            advance_ms: 1,
        },
    ]);
    let mut call = h.call(&target, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    let operation = h.invoke(call).await;
    gate.entered().await;
    h.probe
        .drain_started
        .store(true, std::sync::atomic::Ordering::SeqCst);
    support::until(|| {
        h.probe
            .rx_during_drain
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0
    })
    .await;
    h.probe
        .drain_release
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let ordinary = h
        .invoke(h.call(
            &target,
            "session.tx",
            serde_json::json!({"bytesBase64":"CQ==","writeWaitMs":"1000"}),
        ))
        .await;
    assert_eq!(h.write_count(), 1);
    gate.release();
    let done = h.wait(&operation.operation_id).await;
    h.wait(&ordinary.operation_id).await;
    h.host.shutdown().await.unwrap();
    assert_eq!(done.state, OperationState::Succeeded);
    let writes = h.probe.writes.lock().unwrap();
    assert_eq!(
        writes.iter().map(|w| w.1.clone()).collect::<Vec<_>>(),
        vec![vec![1, 2], vec![3, 4], vec![5], vec![9]]
    );
}

#[tokio::test]
async fn file_transfer_unknown_chunk_preserves_evidence_and_stops_tail() {
    let h = Harness::new().await;
    let target = h.open("transfer-unknown").await;
    let reference = source(&h, &[1, 2, 3, 4, 5]);
    h.probe.steps.lock().unwrap().extend([
        WriteStep {
            accepted: 2,
            unknown: false,
            gate: None,
            advance_ms: 1,
        },
        WriteStep {
            accepted: 1,
            unknown: true,
            gate: None,
            advance_ms: 1,
        },
    ]);
    let mut call = h.call(&target, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    let operation = h.invoke(call).await;
    let done = h.wait(&operation.operation_id).await;
    let value = serde_json::to_value(&done.result).unwrap();
    assert_eq!(done.state, OperationState::Unknown);
    assert_eq!(value["value"]["accepted"], "3");
    assert_eq!(value["value"]["unknown"], "1");
    assert_eq!(h.write_count(), 2);
    let ActionResult::FileTransfer(result) = done.result.as_ref().unwrap() else {
        panic!("transfer evidence")
    };
    let journal = receipts(&h, &result.receipts_ref);
    assert_eq!(journal.count, U64::from(2));
    assert_eq!(journal.receipts.len(), 2);
    assert_eq!(journal.receipts[1].receipt.outcome, TxOutcome::Unknown);
    assert!(!journal.receipts[1].receipt.unknown_ranges.is_empty());
    let report = h.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
    assert!(report.completed, "{report:?}");
    assert!(report.unsettled_operation_ids.is_empty());
    assert!(report.quarantined_sessions.is_empty());
    assert!(report.failures.is_empty());
    assert!(report.evidence_refs.contains(&ObjectRef {
        host_id: done.execution_host_id.clone(),
        kind: ResourceKind::try_from("operation").unwrap(),
        id: done.operation_id.clone(),
        revision: Some(done.revision),
    }));
    assert!(report.evidence_refs.contains(&result.receipts_ref));
    assert_eq!(h.store.get(&h.actor, &done.operation_id).unwrap(), done);
    assert_eq!(receipts(&h, &result.receipts_ref), journal);
    let session = h.host.devices().snapshot(&target).await.unwrap();
    assert_eq!(session.state, SessionState::Closed);
    assert_eq!(session.tx_gate, TxGate::ControlUnknown);
    assert_eq!(
        h.probe
            .close_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(h.probe.closes.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(h.write_count(), 2);
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn file_change_between_chunks_retains_written_prefix() {
    let h = Harness::new().await;
    let target = h.open("transfer-source-change").await;
    let reference = source(&h, &[1, 2, 3, 4, 5]);
    let gate = Arc::new(Gate::default());
    h.probe.steps.lock().unwrap().push_back(WriteStep {
        accepted: 2,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 1,
    });
    let mut call = h.call(&target, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    let operation = h.invoke(call).await;
    gate.entered().await;
    std::fs::write(h.dir.path().join("source.bin"), [1, 2, 9, 4, 5]).unwrap();
    gate.release();
    let done = h.wait(&operation.operation_id).await;
    h.host.shutdown().await.unwrap();
    let value = serde_json::to_value(done.result).unwrap();
    assert_eq!(value["value"]["accepted"], "2");
    assert_eq!(value["value"]["unknown"], "0");
    assert_eq!(done.state, OperationState::Failed);
    assert_eq!(h.write_count(), 1);
}

// 独立接收端probe只记录实际接受的字节，不把整个提交payload当作已发送。
struct PrefixReceiver {
    inner: serial_workbench_host::device::virtual_backend::VirtualTransport,
    bytes: Arc<std::sync::Mutex<Vec<u8>>>,
    second: Arc<Gate>,
    clock: Arc<support::ManualClock>,
    calls: usize,
}
impl Transport for PrefixReceiver {
    fn capabilities(&self) -> TransportCapabilities {
        self.inner.capabilities()
    }
    fn read(&mut self, limit: usize, wait: std::time::Duration) -> BackendResult<ReadBlock> {
        self.inner.read(limit, wait)
    }
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        _: std::time::Duration,
        cancelled: Arc<std::sync::atomic::AtomicBool>,
        _: Arc<std::sync::atomic::AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        self.calls += 1;
        let count = if self.calls == 2 { 1 } else { bytes.len() };
        self.bytes
            .lock()
            .unwrap()
            .extend_from_slice(&bytes[..count]);
        self.clock.advance_ms(1);
        Ok(support::pending_write_on_cancel(
            BackendWrite {
                accepted_ranges: vec![ByteRange {
                    start: 0.into(),
                    end: (count as u64).into(),
                }],
                unknown_ranges: vec![],
                error: None,
            },
            (self.calls == 2).then(|| self.second.clone()),
            cancelled,
        ))
    }
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        self.inner.configure(config)
    }
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        self.inner.control(command)
    }
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        self.inner.begin_drain(request)
    }
    fn close(&mut self) -> BackendResult<()> {
        self.inner.close()
    }
}

#[tokio::test]
async fn cancellation_wakes_throttle_without_advancing_monotonic_clock() {
    let h = Harness::new().await;
    let target = h.open("transfer-throttle-cancel").await;
    let reference = source(&h, &[1, 2, 3, 4, 5]);
    let mut value = params(&reference);
    value["bytesPerSecond"] = serde_json::json!("1");
    let mut call = h.call(&target, "transfer.file", value);
    call.execution_mode = Some(ExecutionMode::Independent);
    let operation = h.invoke(call).await;
    support::until(|| h.write_count() == 1).await;
    h.cancel(&operation).await;
    let done = h.wait(&operation.operation_id).await;
    h.host.shutdown().await.unwrap();
    let value = serde_json::to_value(done.result).unwrap();
    assert_eq!(done.state, OperationState::Cancelled);
    assert_eq!(value["value"]["accepted"], "2");
    assert_eq!(h.clock.mono_ns(), 0);
    assert_eq!(h.write_count(), 1);
}

#[tokio::test]
async fn transfer_requires_explicit_independent_mode() {
    let h = Harness::new().await;
    let target = h.open("transfer-execution-mode").await;
    let reference = source(&h, &[1, 2, 3, 4, 5]);
    for mode in [None, Some(ExecutionMode::Interactive)] {
        let mut call = h.call(&target, "transfer.file", params(&reference));
        call.execution_mode = mode;
        assert_eq!(
            h.host.invoke(&h.actor, call).await.unwrap_err().code,
            "INVALID_ARGUMENT"
        );
    }
    h.host.shutdown().await.unwrap();
    assert_eq!(h.write_count(), 0);
}

#[tokio::test]
async fn device_modify_and_file_metadata_do_not_authorize_file_content() {
    let h = Harness::new().await;
    let target = h.open("transfer-content-permission").await;
    let operator = h
        .auth
        .authenticate_user_control(
            &id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    let actor = h
        .auth
        .authenticate(&id("metadata-client"), None)
        .unwrap()
        .actor;
    h.auth
        .authorize(
            &operator,
            AuthorizeParams {
                client_id: actor.client_id().clone(),
                permissions: vec!["device.modify".into(), "metadata.read".into()],
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
    let path = h.dir.path().join("metadata-only.bin");
    std::fs::write(&path, [1, 2, 3, 4, 5]).unwrap();
    let files = FileService::new(h.store.clone(), h.auth.clone(), h.store.identity().unwrap());
    let reference = files
        .register(
            RegisterFileParams {
                path: path.to_str().unwrap().into(),
                purpose: FilePurpose::ReadFile,
            },
            &operator,
        )
        .unwrap();
    assert_eq!(
        files.metadata(&reference, &actor).unwrap().length,
        U64::from(5)
    );
    h.auth.require(&actor, "device.modify", &target).unwrap();
    let mut call = h.call_as(&actor, &target, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    assert_eq!(
        h.host.invoke(&actor, call).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    h.host.shutdown().await.unwrap();
    assert_eq!(h.write_count(), 0);
}

#[tokio::test]
async fn receipts_are_bounded_authorized_pages_and_survive_source_changes() {
    use sha2::{Digest as _, Sha256};
    let h = Harness::new().await;
    let target = h.open("transfer-receipt-pages").await;
    let bytes: Vec<u8> = (0..20 * 16384).map(|n| (n % 251) as u8).collect();
    let reference = source(&h, &bytes);
    h.probe
        .steps
        .lock()
        .unwrap()
        .extend((0..20).map(|_| WriteStep {
            accepted: 16384,
            unknown: false,
            gate: None,
            advance_ms: 1,
        }));
    let mut value = params(&reference);
    value["length"] = serde_json::json!(bytes.len().to_string());
    value["chunkBytes"] = serde_json::json!("16384");
    value["bytesPerSecond"] = serde_json::json!("16777216");
    let mut call = h.call(&target, "transfer.file", value);
    call.execution_mode = Some(ExecutionMode::Independent);
    let operation = h.invoke(call).await;
    let done = h.wait(&operation.operation_id).await;
    assert_eq!(done.state, OperationState::Succeeded);
    let ActionResult::FileTransfer(result) = done.result.unwrap() else {
        panic!("transfer result")
    };
    assert_eq!(result.accepted, U64::from(bytes.len() as u64));
    assert_eq!(result.receipts_ref.revision, Some(U64::from(1)));
    assert!(!result.peer_acknowledged);
    std::fs::write(h.dir.path().join("source.bin"), [9]).unwrap();
    let reader = h.new_actor("receipt-reader");
    let files = FileService::new(h.store.clone(), h.auth.clone(), h.store.identity().unwrap());
    let mut ordinal = U64::from(0);
    let mut hash = Sha256::new();
    loop {
        let page = files
            .read_receipts(
                FileTransferReceiptsParams {
                    receipts_ref: result.receipts_ref.clone(),
                    start_ordinal: ordinal,
                    max_receipts: 256.into(),
                    max_bytes: 50000.into(),
                },
                &reader,
            )
            .unwrap();
        assert_eq!(page.count, U64::from(20));
        assert!(page.sealed);
        assert!(serde_json::to_vec(&page).unwrap().len() <= 50000);
        assert!(page.receipts.len() <= 2);
        for entry in &page.receipts {
            use base64::Engine as _;
            hash.update(
                base64::engine::general_purpose::STANDARD
                    .decode(entry.receipt.bytes_base64.as_str())
                    .unwrap(),
            );
        }
        ordinal = page.next_ordinal;
        if !page.has_more {
            break;
        }
    }
    assert_eq!(
        hash.finalize().as_slice(),
        Sha256::digest(&bytes).as_slice()
    );
    let denied = h.auth.authenticate(&id("no-content"), None).unwrap().actor;
    assert_eq!(
        files
            .read_receipts(
                FileTransferReceiptsParams {
                    receipts_ref: result.receipts_ref,
                    start_ordinal: 0.into(),
                    max_receipts: 1.into(),
                    max_bytes: 50000.into(),
                },
                &denied
            )
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    h.host.shutdown().await.unwrap();
}

#[tokio::test]
async fn transfer_rejects_caller_supplied_lease() {
    let h = Harness::new().await;
    let target = h.open("transfer-internal-lease").await;
    let reference = source(&h, &[1, 2, 3, 4, 5]);
    let mut call = h.call(&target, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    call.lease_id = Some(id("external-lease"));
    assert_eq!(
        h.host.invoke(&h.actor, call).await.unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    h.host.shutdown().await.unwrap();
    assert_eq!(h.write_count(), 0);
}

#[tokio::test]
async fn journal_commit_failure_preserves_actual_chunk_prefix() {
    let h = Harness::new().await;
    let target = h.open("transfer-journal-failure").await;
    let reference = source(&h, &[1, 2, 3, 4, 5]);
    let gate = Arc::new(Gate::default());
    h.probe.steps.lock().unwrap().push_back(WriteStep {
        accepted: 2,
        unknown: false,
        gate: Some(gate.clone()),
        advance_ms: 1,
    });
    let mut call = h.call(&target, "transfer.file", params(&reference));
    call.execution_mode = Some(ExecutionMode::Independent);
    let operation = h.invoke(call).await;
    gate.entered().await;
    // 使pending -> actual的持久CAS失败，而不改变native实际接受的两字节。
    let key = id(&format!(
        "transfer-receipts-{}-0",
        operation.operation_id.as_str()
    ));
    let record = h.store.read_document(&key).unwrap().unwrap();
    h.store
        .compare_and_swap_document(&key, record.revision, record.value)
        .unwrap();
    gate.release();
    let done = h.wait(&operation.operation_id).await;
    let ActionResult::FileTransfer(result) = done.result.as_ref().unwrap() else {
        panic!("transfer evidence")
    };
    assert_eq!(done.state, OperationState::Unknown);
    assert_eq!(result.accepted, U64::from(2));
    assert_eq!(result.unknown, U64::from(0));
    assert_eq!(result.receipts_ref.revision, None);
    assert_eq!(h.write_count(), 1);
    let journal = receipts(&h, &result.receipts_ref);
    assert_eq!(journal.count, U64::from(1));
    assert!(!journal.sealed);
    assert_eq!(journal.receipts.len(), 1);
    assert_eq!(journal.receipts[0].receipt.outcome, TxOutcome::Unknown);
    assert!(journal.receipts[0].receipt.accepted_ranges.is_empty());
    assert_eq!(
        journal.receipts[0].receipt.unknown_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: 2.into(),
        }]
    );
    let report = h.host.quiesce(ShutdownMode::CancelAndSettle).await.unwrap();
    assert!(report.completed, "{report:?}");
    assert!(report.unsettled_operation_ids.is_empty());
    assert!(report.quarantined_sessions.is_empty());
    assert!(report.failures.is_empty());
    assert!(report.evidence_refs.contains(&ObjectRef {
        host_id: done.execution_host_id.clone(),
        kind: ResourceKind::try_from("operation").unwrap(),
        id: done.operation_id.clone(),
        revision: Some(done.revision),
    }));
    assert!(report.evidence_refs.contains(&result.receipts_ref));
    assert_eq!(h.store.get(&h.actor, &done.operation_id).unwrap(), done);
    assert_eq!(receipts(&h, &result.receipts_ref), journal);
    let session = h.host.devices().snapshot(&target).await.unwrap();
    assert_eq!(session.state, SessionState::Closed);
    assert_eq!(session.tx_gate, TxGate::ControlUnknown);
    assert_eq!(
        h.probe
            .close_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(h.probe.closes.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(h.write_count(), 1);
    h.host.shutdown().await.unwrap();
}
