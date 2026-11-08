//! 裸文件发送持有同一 Transmission owner，逐块持久保留意图和真实回执。
use super::*;
use crate::files::{FileService, FixedFile};
use crate::storage::Store;
use serde::{Deserialize, Serialize};

const MAX_CHUNK: u64 = 16384;
const MAX_RATE: u64 = 16 * 1024 * 1024;
const MAX_BATCH: usize = 256 * 1024;
const LEASE_NS: u64 = 30_000_000_000;
const RENEW_NS: u64 = 10_000_000_000;

pub(crate) struct FileTransferGuard {
    _turn: Turn,
    session: Arc<Session>,
    runtime: Arc<Runtime>,
    lease_id: Id,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReceiptJournalManifest {
    pub format_version: String,
    pub source_ref: ObjectRef,
    pub authority: Target,
    pub count: U64,
    pub sealed: bool,
}

pub fn validate_params(params: &FileTransferParams) -> HostResult<()> {
    if params.source_ref.kind.as_str() != "file"
        || params.source_ref.revision.is_none()
        || params
            .offset
            .get()
            .checked_add(params.length.get())
            .is_none()
        || params.chunk_bytes.get() == 0
        || params.bytes_per_second.get() == 0
    {
        return Err(invalid());
    }
    if params.chunk_bytes.get() > MAX_CHUNK
        || params.bytes_per_second.get() > MAX_RATE
        || params.inter_chunk_ms.get() > 2147483647
    {
        let mut error = HostError::new("LIMIT_EXCEEDED", "File transfer exceeds Host limits");
        error.details = Some(Box::new(
            [
                (
                    "maxChunkBytes".into(),
                    JsonValue::String(MAX_CHUNK.to_string()),
                ),
                (
                    "maxBytesPerSecond".into(),
                    JsonValue::String(MAX_RATE.to_string()),
                ),
            ]
            .into(),
        ));
        return Err(error);
    }
    Ok(())
}

impl TransmissionService {
    pub(super) async fn transfer_file(
        &self,
        accepted: &AcceptedCall,
        token: &ControlToken,
        session: &Arc<Session>,
        runtime: &Arc<Runtime>,
        guard: &mut Option<FileTransferGuard>,
    ) -> HostResult<Completion> {
        let params: FileTransferParams = decode(&accepted.call.params)?;
        validate_params(&params)?;
        let files = FileService::new(
            self.devices.inner.store.clone(),
            self.devices.inner.auth.clone(),
            self.devices.inner.identity.clone(),
        );
        let reference = params.source_ref.clone();
        let actor = accepted.actor.clone();
        let end = params
            .offset
            .get()
            .checked_add(params.length.get())
            .ok_or_else(invalid)?;
        let (fixed, authority) = blocking(move || {
            let authority = files.authorization_target(&reference, &actor, "content.read")?;
            let fixed = files.open_fixed(&reference, &actor)?;
            if end > fixed.len() {
                return Err(invalid());
            }
            Ok((fixed, authority))
        })
        .await?;
        let turn = self
            .acquire(
                accepted,
                token,
                session,
                runtime,
                params.chunk_bytes.get() as usize,
                None,
            )
            .await?;
        // Store.mark_dispatch只在queued -> running时调用一次。
        self.dispatch(accepted, token, session).await?;
        let lease = Lease {
            lease_id: new_id(),
            session_id: accepted.call.target.id.clone(),
            session_epoch: accepted.call.target.session_epoch.ok_or_else(invalid)?,
            actor_id: accepted.actor.id().clone(),
            owner_operation_id: accepted.operation.operation_id.clone(),
            kind: LeaseKind::Exclusive,
            state: LeaseState::Active,
            execution_mode: ExecutionMode::Independent,
            expires_at_mono_ns: self.now().checked_add(LEASE_NS).ok_or_else(invalid)?.into(),
        };
        *guard = Some(FileTransferGuard {
            _turn: turn,
            session: session.clone(),
            runtime: runtime.clone(),
            lease_id: lease.lease_id.clone(),
        });
        {
            let _transition = runtime.lease_transition.lock().await;
            *runtime.lease.lock().map_err(|_| invalid())? = Some(lease.clone());
            self.devices
                .publish_lease(session, Some(lease.clone()))
                .await?;
        }
        let mut call = accepted.call.clone();
        call.lease_id = Some(lease.lease_id.clone());
        // 本owner的lease发布会推进会话revision，原expectedRevision已在首次dispatch验证。
        call.expected_revision = None;
        let run = FileRun {
            service: self,
            accepted: AcceptedCall {
                actor: accepted.actor.clone(),
                call,
                operation: accepted.operation.clone(),
            },
            token,
            session: session.clone(),
            runtime: runtime.clone(),
            params,
        };
        let work = run.run(fixed, authority);
        tokio::pin!(work);
        let mut maintain = true;
        let mut renew_at = self.now().saturating_add(RENEW_NS);
        loop {
            tokio::select! {
                result = &mut work => return result,
                _ = runtime.changed.notified(), if maintain => {
                    if self.check_lease(runtime, &run.accepted).is_err() {
                        token.cancel();
                        maintain = false;
                    }
                }
                _ = crate::clock::wait_until(self.devices.inner.clock.as_ref(), renew_at), if maintain => {
                    if self.renew_file_lease(session, runtime, &lease.lease_id).await.is_err() {
                        token.cancel();
                        maintain = false;
                    }
                    renew_at = self.now().saturating_add(RENEW_NS);
                }
            }
        }
    }

    async fn renew_file_lease(
        &self,
        session: &Session,
        runtime: &Runtime,
        id: &Id,
    ) -> HostResult<()> {
        let _transition = runtime.lease_transition.lock().await;
        let lease = {
            let mut slot = runtime.lease.lock().map_err(|_| invalid())?;
            let lease = slot
                .as_mut()
                .filter(|v| {
                    &v.lease_id == id
                        && v.state == LeaseState::Active
                        && self.now() < v.expires_at_mono_ns.get()
                })
                .ok_or_else(cancelled)?;
            lease.expires_at_mono_ns = self.now().checked_add(LEASE_NS).ok_or_else(invalid)?.into();
            lease.clone()
        };
        self.devices.publish_lease(session, Some(lease)).await
    }

    pub(super) async fn finish_file_transfer(
        &self,
        guard: FileTransferGuard,
        settled: &HostResult<Operation>,
    ) -> HostResult<()> {
        // 结算失败也属于未知；先关TX gate，再释放Turn，不能让下一普通TX越过失败证据。
        if settled
            .as_ref()
            .map_or(true, |op| op.state == OperationState::Unknown)
        {
            self.isolate_lease(&guard.session).await?;
        }
        let _transition = guard.runtime.lease_transition.lock().await;
        let lease = {
            let mut slot = guard.runtime.lease.lock().map_err(|_| invalid())?;
            slot.as_mut()
                .filter(|v| v.lease_id == guard.lease_id)
                .map(|lease| {
                    lease.state = LeaseState::Released;
                    lease.clone()
                })
        };
        if let Some(lease) = lease {
            self.devices
                .publish_lease(&guard.session, Some(lease))
                .await?;
        }
        Ok(())
    }
}

struct FileRun<'a> {
    service: &'a TransmissionService,
    accepted: AcceptedCall,
    token: &'a ControlToken,
    session: Arc<Session>,
    runtime: Arc<Runtime>,
    params: FileTransferParams,
}
impl FileRun<'_> {
    async fn gate(&self) -> HostResult<()> {
        if self.token.cancelled.load(Ordering::SeqCst) {
            return Err(cancelled());
        }
        self.service
            .require_token(&self.accepted, self.token)
            .await?;
        self.service.devices.session(&self.accepted.call.target)?;
        self.service.gate(&self.session, &self.accepted)?;
        self.service.check_lease(&self.runtime, &self.accepted)
    }
    async fn evidence(&self, result: &FileTransferResult) -> HostResult<()> {
        let store = self.service.devices.inner.store.clone();
        let id = self.accepted.operation.operation_id.clone();
        let evidence = ActionResult::FileTransfer(result.clone());
        blocking(move || store.record_result_evidence(&id, &evidence)).await?;
        Ok(())
    }
    async fn run(&self, mut fixed: FixedFile, authority: Target) -> HostResult<Completion> {
        let mut journal = ReceiptJournal::create(
            self.service.devices.inner.store.clone(),
            &self.accepted.operation,
            self.params.source_ref.clone(),
            authority,
        )
        .await?;
        let mut result = FileTransferResult {
            requested: self.params.length,
            accepted: 0.into(),
            unknown: 0.into(),
            receipts_ref: journal.reference.clone(),
            peer_acknowledged: false,
        };
        self.evidence(&result).await?;
        let mut pacer = ChunkPacer::new(
            self.service.now(),
            self.params.chunk_bytes.get(),
            self.params.bytes_per_second.get(),
            self.params.inter_chunk_ms.get(),
        );
        let mut consumed = 0;
        let mut failure = None;
        while consumed < self.params.length.get() {
            let length =
                (self.params.length.get() - consumed).min(self.params.chunk_bytes.get()) as usize;
            let attempt = async {
                self.gate().await?;
                let ready = pacer.ready_at(self.service.now(), length as u64);
                tokio::select! {
                    _ = crate::clock::wait_until(self.service.devices.inner.clock.as_ref(), ready) => {},
                    _ = self.token.wake.notified() => {},
                }
                self.gate().await?;
                pacer.consume(self.service.now(), length as u64);
                self.chunk(fixed, self.params.offset.get() + consumed, length, &mut journal, &mut result).await
            }.await;
            match attempt {
                Ok((next, receipt)) => {
                    fixed = next;
                    consumed += length as u64;
                    pacer.finished(self.service.now());
                    if receipt.outcome != TxOutcome::Accepted || receipt.backend_error.is_some() {
                        failure = Some(receipt.backend_error.unwrap_or_else(|| {
                            HostError::new(
                                "PARTIAL_WRITE",
                                "File transfer stopped after an incomplete chunk",
                            )
                        }));
                        break;
                    }
                }
                Err(error) => {
                    if error.code == "STORAGE_UNAVAILABLE" {
                        // 不封存落库不确定的journal；保留已持久水位和live证据供查询。
                        return Err(error);
                    }
                    failure = Some(error);
                    break;
                }
            }
        }
        journal.seal().await?;
        result.receipts_ref = journal.reference;
        self.evidence(&result).await?;
        let state = if result.unknown.get() > 0 {
            OperationState::Unknown
        } else if consumed == self.params.length.get() && failure.is_none() {
            OperationState::Succeeded
        } else if self.token.cancelled.load(Ordering::SeqCst) {
            OperationState::Cancelled
        } else {
            OperationState::Failed
        };
        Ok(Completion {
            state,
            result: ActionResult::FileTransfer(result),
            error: failure,
        })
    }

    async fn chunk(
        &self,
        mut fixed: FixedFile,
        offset: u64,
        length: usize,
        journal: &mut ReceiptJournal,
        aggregate: &mut FileTransferResult,
    ) -> HostResult<(FixedFile, TxReceipt)> {
        // 每次只读取一个有界块；固定源自己核对当前授权、文件身份和块摘要。
        let (next, bytes) = blocking(move || {
            let bytes = fixed.read_chunk(offset, length)?;
            Ok((fixed, bytes))
        })
        .await?;
        fixed = next;
        self.gate().await?;
        let bytes: Arc<[u8]> = bytes.into();
        let prepared = self
            .session
            .source
            .reserve_tx_intent(self.service.devices.meta(&self.session)?, bytes.clone())?;
        let intent = self
            .session
            .source
            .commit_tx_intent(prepared, self.accepted.operation.operation_id.clone())?;
        let pending = TxSettlement {
            outcome: TxOutcome::Unknown,
            accepted_ranges: vec![],
            unknown_ranges: vec![ByteRange {
                start: 0.into(),
                end: (length as u64).into(),
            }],
            backend_error: None,
        };
        let appended = journal
            .append(&FileTransferReceipt {
                source_offset: offset.into(),
                receipt: intent.receipt(&pending)?,
            })
            .await;
        let ordinal = match appended {
            Ok(ordinal) => ordinal,
            Err(error) => {
                self.reject_intent(&intent, &error)?;
                return Err(error);
            }
        };
        aggregate.unknown = (aggregate.unknown.get() + length as u64).into();
        if let Err(error) = self.evidence(aggregate).await {
            self.reject_intent(&intent, &error)?;
            return Err(error);
        }
        // 与取消协商共享dispatch guard，但不让RX或capture等待文件读或native完成。
        let dispatch = self.token.dispatch.lock().await;
        let ready = self.gate().await;
        let (fixed, ready) = if ready.is_ok() {
            let next = blocking(move || {
                let checked = fixed.read_chunk(offset, length);
                Ok((fixed, checked))
            })
            .await?;
            (
                next.0,
                next.1.and_then(|checked| {
                    if checked.as_slice() == bytes.as_ref() {
                        Ok(())
                    } else {
                        Err(HostError::new(
                            "SOURCE_CHANGED",
                            "File changed before chunk dispatch",
                        ))
                    }
                }),
            )
        } else {
            (fixed, ready)
        };
        let ready = match ready {
            Ok(()) => self.gate().await,
            other => other,
        };
        let outcome = match ready {
            Ok(()) => {
                // session.write内部投递不跨await；释放dispatch锁使用户取消能到达native owner。
                drop(dispatch);
                write_settlement(
                    self.session
                        .write(
                            intent.write_payload(),
                            Duration::from_millis(self.params.write_wait_ms.get()),
                            self.service.backend_admission(
                                &self.accepted,
                                self.token,
                                &self.runtime,
                            ),
                        )
                        .await,
                    length,
                )?
            }
            Err(error) => {
                drop(dispatch);
                TxSettlement {
                    outcome: TxOutcome::Rejected,
                    accepted_ranges: vec![],
                    unknown_ranges: vec![],
                    backend_error: Some(error),
                }
            }
        };
        let receipt = intent.receipt(&outcome)?;
        aggregate.accepted =
            (aggregate.accepted.get() + range_bytes(&receipt.accepted_ranges)?).into();
        aggregate.unknown = (aggregate.unknown.get() - length as u64
            + range_bytes(&receipt.unknown_ranges)?)
        .into();
        // native已提供的证据先进入公共TX源和持久累计结果，journal失败不能盖掉已知前缀。
        let published = self.session.source.complete_tx(
            &intent,
            self.service.devices.meta(&self.session)?,
            outcome,
        );
        self.evidence(aggregate).await?;
        journal
            .replace(
                ordinal,
                &FileTransferReceipt {
                    source_offset: offset.into(),
                    receipt: receipt.clone(),
                },
            )
            .await
            .map_err(journal_error)?;
        published?;
        Ok((fixed, receipt))
    }

    fn reject_intent(
        &self,
        intent: &crate::stream::TxIntentRef,
        error: &HostError,
    ) -> HostResult<()> {
        self.session.source.complete_tx(
            intent,
            self.service.devices.meta(&self.session)?,
            TxSettlement {
                outcome: TxOutcome::Rejected,
                accepted_ranges: vec![],
                unknown_ranges: vec![],
                backend_error: Some(error.clone()),
            },
        )?;
        Ok(())
    }
}

fn range_bytes(ranges: &[ByteRange]) -> HostResult<u64> {
    ranges
        .iter()
        .try_fold(0u64, |sum, range| {
            sum.checked_add(range.end.get().checked_sub(range.start.get())?)
        })
        .ok_or_else(invalid)
}

struct ReceiptJournal {
    store: Store,
    reference: ObjectRef,
    manifest: ReceiptJournalManifest,
    revision: U64,
}
impl ReceiptJournal {
    async fn create(
        store: Store,
        operation: &Operation,
        source_ref: ObjectRef,
        authority: Target,
    ) -> HostResult<Self> {
        let mut journal = Self {
            store,
            reference: ObjectRef {
                host_id: operation.execution_host_id.clone(),
                kind: ResourceKind::try_from("transfer_receipts")?,
                id: operation.operation_id.clone(),
                revision: None,
            },
            manifest: ReceiptJournalManifest {
                format_version: "0.1".into(),
                source_ref,
                authority,
                count: 0.into(),
                sealed: false,
            },
            revision: 0.into(),
        };
        journal.save_manifest().await?;
        Ok(journal)
    }
    async fn save_manifest(&mut self) -> HostResult<()> {
        let store = self.store.clone();
        let key =
            Id::try_from(format!("transfer-receipts-{}", self.reference.id.as_str()).as_str())?;
        let expected = self.revision;
        let value = object(&self.manifest)?;
        self.revision = blocking(move || store.compare_and_swap_document(&key, expected, value))
            .await
            .map_err(journal_error)?
            .revision;
        Ok(())
    }
    async fn record(
        &self,
        ordinal: U64,
        expected: U64,
        record: &FileTransferReceipt,
    ) -> HostResult<()> {
        if serde_json::to_vec(record).map_err(|_| invalid())?.len() > MAX_BATCH {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Transfer receipt exceeds one batch",
            ));
        }
        let store = self.store.clone();
        let key = Id::try_from(
            format!(
                "transfer-receipts-{}-{}",
                self.reference.id.as_str(),
                ordinal.get()
            )
            .as_str(),
        )?;
        let value = object(record)?;
        blocking(move || store.compare_and_swap_document(&key, expected, value))
            .await
            .map_err(journal_error)?;
        Ok(())
    }
    async fn append(&mut self, record: &FileTransferReceipt) -> HostResult<U64> {
        let ordinal = self.manifest.count;
        self.record(ordinal, 0.into(), record).await?;
        self.manifest.count = ordinal.checked_next()?;
        self.save_manifest().await?;
        Ok(ordinal)
    }
    async fn replace(&self, ordinal: U64, record: &FileTransferReceipt) -> HostResult<()> {
        self.record(ordinal, 1.into(), record).await
    }
    async fn seal(&mut self) -> HostResult<()> {
        self.manifest.sealed = true;
        self.save_manifest().await?;
        self.reference.revision = Some(1.into());
        Ok(())
    }
}

fn journal_error(cause: HostError) -> HostError {
    if cause.code == "STORAGE_UNAVAILABLE" {
        return cause;
    }
    let mut error = HostError::new(
        "STORAGE_UNAVAILABLE",
        "Transfer journal was not durably committed",
    );
    error.details = Some(Box::new(
        [("causeCode".into(), JsonValue::String(cause.code))].into(),
    ));
    error
}

/// 容量至多一个chunk，信用以纳秒×字节保存，避免低速和尾块的舍入突发。
struct ChunkPacer {
    last: u64,
    credit: u128,
    capacity: u128,
    rate: u64,
    interval_ns: u64,
    after: u64,
}
impl ChunkPacer {
    fn new(now: u64, chunk: u64, rate: u64, inter_chunk_ms: u64) -> Self {
        Self {
            last: now,
            credit: u128::from(chunk) * 1_000_000_000,
            capacity: u128::from(chunk) * 1_000_000_000,
            rate,
            interval_ns: inter_chunk_ms * 1_000_000,
            after: now,
        }
    }
    fn refill(&mut self, now: u64) {
        self.credit = self
            .capacity
            .min(self.credit + u128::from(now.saturating_sub(self.last)) * u128::from(self.rate));
        self.last = now;
    }
    fn ready_at(&mut self, now: u64, bytes: u64) -> u64 {
        self.refill(now);
        let missing = (u128::from(bytes) * 1_000_000_000).saturating_sub(self.credit);
        let wait = missing.div_ceil(u128::from(self.rate));
        now.saturating_add(wait.min(u128::from(u64::MAX)) as u64)
            .max(self.after)
    }
    fn consume(&mut self, now: u64, bytes: u64) {
        self.refill(now);
        self.credit = self
            .credit
            .saturating_sub(u128::from(bytes) * 1_000_000_000);
        self.finished(now);
    }
    fn finished(&mut self, now: u64) {
        self.after = now.saturating_add(self.interval_ns);
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_token_bucket_caps_idle_credit_at_one_chunk() {
        let mut bucket = ChunkPacer::new(0, 2, 2, 0);
        assert_eq!(bucket.ready_at(0, 2), 0);
        bucket.consume(0, 2);
        assert_eq!(bucket.ready_at(0, 2), 1_000_000_000);
        bucket.consume(1_000_000_000, 2);
        assert_eq!(bucket.ready_at(50_000_000_000, 2), 50_000_000_000);
        bucket.consume(50_000_000_000, 2);
        assert_eq!(bucket.ready_at(50_000_000_000, 2), 51_000_000_000);
    }

    #[test]
    fn file_token_bucket_partial_tail_and_inter_chunk_deadline() {
        let mut bucket = ChunkPacer::new(100, 2, 2, 1500);
        bucket.consume(100, 2);
        assert_eq!(bucket.ready_at(100, 1), 1_500_000_100);
    }
}

#[cfg(test)]
#[test]
fn file_transfer_validates_chunk_rate_duration_and_fixed_source() {
    let value = serde_json::json!({"hostId":"host","kind":"file","id":"source","revision":"1"});
    let reference: ObjectRef = serde_json::from_value(value).unwrap();
    for (field, bad) in [
        ("chunkBytes", "0"),
        ("chunkBytes", "16385"),
        ("bytesPerSecond", "0"),
        ("bytesPerSecond", "16777217"),
        ("interChunkMs", "2147483648"),
    ] {
        let mut value = serde_json::json!({"sourceRef":reference,"offset":"0","length":"5","chunkBytes":"2","bytesPerSecond":"1000000","interChunkMs":"0","writeWaitMs":"1000"});
        value[field] = serde_json::json!(bad);
        let parsed: FileTransferParams = serde_json::from_value(value).unwrap();
        assert!(validate_params(&parsed).is_err(), "{field}={bad}");
    }
    let mut value: FileTransferParams = serde_json::from_value(serde_json::json!({"sourceRef":reference,"offset":"0","length":"5","chunkBytes":"2","bytesPerSecond":"1000000","interChunkMs":"0","writeWaitMs":"1000"})).unwrap();
    value.source_ref.revision = None;
    assert!(validate_params(&value).is_err());
}
