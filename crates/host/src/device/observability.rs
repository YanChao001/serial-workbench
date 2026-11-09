//! 会话级累计与短窗；仅从 owner RX、实际 I/O 故障及唯一 TX 结算边界更新。
use super::sessions::{DeviceService, Session, unavailable};
use serial_workbench_core::*;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::oneshot;

const BUCKET_MS: u64 = 10;
const BUCKET_COUNT: usize = 100;

#[derive(Clone, Copy, Default)]
struct RateBucket {
    tick: u64,
    rx: u64,
    tx: u64,
}

#[derive(Default)]
pub(crate) struct SessionObservability {
    epoch: u64,
    connected_at: u64,
    stopped_at: Option<u64>,
    rx: u64,
    accepted: u64,
    unknown: u64,
    read_errors: u64,
    write_errors: u64,
    // 固定 2400 bytes；近一秒按 10ms 量化，空闲一秒后一定归零。
    rates: RateWindow,
}
struct RateWindow([RateBucket; BUCKET_COUNT]);
impl Default for RateWindow {
    fn default() -> Self {
        Self([RateBucket::default(); BUCKET_COUNT])
    }
}
impl SessionObservability {
    pub fn connected(&mut self, epoch: U64, at: u64) {
        self.epoch = epoch.get();
        self.connected_at = at;
        self.stopped_at = None;
    }
    pub fn disconnected(&mut self, at: u64) {
        self.stopped_at.get_or_insert(at);
    }
    fn bucket(&mut self, now: u64) -> &mut RateBucket {
        let tick = now / 1_000_000 / BUCKET_MS;
        let bucket = &mut self.rates.0[(tick % BUCKET_COUNT as u64) as usize];
        if bucket.tick != tick {
            *bucket = RateBucket {
                tick,
                ..RateBucket::default()
            };
        }
        bucket
    }
    pub fn received(&mut self, bytes: usize, now: u64) {
        self.rx = self.rx.saturating_add(bytes as u64);
        let bucket = self.bucket(now);
        bucket.rx = bucket.rx.saturating_add(bytes as u64);
    }
    pub fn read_error(&mut self, error: &HostError) {
        if error.code != "CANCELLED" {
            self.read_errors = self.read_errors.saturating_add(1);
        }
    }
    pub fn write_error(&mut self, error: &HostError) {
        if error.code != "CANCELLED" {
            self.write_errors = self.write_errors.saturating_add(1);
        }
    }
    fn settled(&mut self, receipt: &TxReceipt, now: u64) {
        // receipt 已由意图/结算边界验证；未知范围始终与接受字节分开。
        let accepted = receipt
            .accepted_ranges
            .iter()
            .map(|r| r.end.get() - r.start.get())
            .sum::<u64>();
        let unknown = receipt
            .unknown_ranges
            .iter()
            .map(|r| r.end.get() - r.start.get())
            .sum::<u64>();
        self.accepted = self.accepted.saturating_add(accepted);
        self.unknown = self.unknown.saturating_add(unknown);
        let bucket = self.bucket(now);
        bucket.tx = bucket.tx.saturating_add(accepted);
    }
    fn snapshot(
        &self,
        target: &Target,
        instance_epoch: U64,
        clock: &dyn Clock,
    ) -> HostResult<SessionMetrics> {
        if target.session_epoch != Some(self.epoch.into()) {
            return Err(HostError::new("EPOCH_MISMATCH", "Session epoch changed"));
        }
        let now = clock.mono_ns();
        let tick = now / 1_000_000 / BUCKET_MS;
        let (rx_rate, tx_rate) = self
            .rates
            .0
            .iter()
            .filter(|bucket| tick.saturating_sub(bucket.tick) < BUCKET_COUNT as u64)
            .fold((0u64, 0u64), |(rx, tx), bucket| {
                (rx.saturating_add(bucket.rx), tx.saturating_add(bucket.tx))
            });
        Ok(SessionMetrics {
            session_id: target.id.clone(),
            session_epoch: self.epoch.into(),
            instance_epoch,
            observed_at: clock.wall_time(),
            observed_mono_ns: now.into(),
            connection_duration_ms: (self
                .stopped_at
                .unwrap_or(now)
                .saturating_sub(self.connected_at)
                / 1_000_000)
                .into(),
            rx_bytes: self.rx.into(),
            tx_accepted_bytes: self.accepted.into(),
            tx_unknown_bytes: self.unknown.into(),
            rx_read_errors: self.read_errors.into(),
            tx_write_errors: self.write_errors.into(),
            rx_bytes_per_second: rx_rate.into(),
            tx_accepted_bytes_per_second: tx_rate.into(),
            rate_window_ms: (BUCKET_MS * BUCKET_COUNT as u64).into(),
            rate_resolution_ms: BUCKET_MS.into(),
            line_errors_available: False,
            frame_counts_available: False,
        })
    }
}
impl DeviceService {
    pub fn metrics(&self, target: &Target) -> HostResult<SessionMetrics> {
        let session = self.session(target)?;
        session
            .observability
            .lock()
            .map_err(|_| unavailable())?
            .snapshot(
                target,
                self.inner.identity.instance_epoch,
                self.inner.clock.as_ref(),
            )
    }
    pub async fn inputs(&self, target: &Target) -> HostResult<SessionInputs> {
        let session = self.session(target)?;
        let inputs = session
            .sample_inputs(target.session_epoch.ok_or_else(unavailable)?)
            .await?;
        // 等待期间 reopen 替换了 map 中的 owner 时，不能把旧样本作为当前查询结果。
        self.session(target)?;
        Ok(inputs)
    }
}
impl Session {
    pub(crate) fn record_tx(&self, receipt: &TxReceipt, now: u64) -> HostResult<()> {
        self.observability
            .lock()
            .map_err(|_| unavailable())?
            .settled(receipt, now);
        Ok(())
    }
}

/// 许可随邮箱命令保留；调用者取消不能马上腾位后再次灌满邮箱。
pub(super) struct InputPermit(Arc<AtomicBool>);
impl InputPermit {
    pub fn acquire(pending: &Arc<AtomicBool>) -> HostResult<Self> {
        pending
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| HostError::new("HOST_BUSY", "An input sample is already pending"))?;
        Ok(Self(pending.clone()))
    }
}
impl Drop for InputPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
pub(super) struct InputSample {
    pub epoch: U64,
    pub reply: oneshot::Sender<HostResult<SessionInputs>>,
    pub permit: InputPermit,
}
impl InputSample {
    pub fn complete(
        self,
        backend: &mut dyn Transport,
        snapshot: &Mutex<SessionSnapshot>,
        clock: &dyn Clock,
        closing: &AtomicBool,
    ) {
        let Self {
            epoch,
            reply,
            permit,
        } = self;
        if !reply.is_closed() {
            let sample = (|| {
                let state = current(snapshot, epoch, closing)?;
                let result = backend
                    .control(ControlCommand::ModemStatus)
                    .map_err(|error| *error.error)?;
                let sampled_mono_ns = clock.mono_ns().into();
                let sampled_at = clock.wall_time();
                current(snapshot, epoch, closing)?;
                match result {
                    ControlResult::Modem {
                        cts,
                        dsr,
                        ring,
                        carrier,
                    } => Ok(SessionInputs {
                        session_id: state.session_id,
                        session_epoch: epoch,
                        sampled_at,
                        sampled_mono_ns,
                        cts,
                        dsr,
                        ri: ring,
                        cd: carrier,
                    }),
                    _ => Err(HostError::new(
                        "BACKEND_IO",
                        "Backend returned an invalid modem sample",
                    )),
                }
            })();
            // 在发布完成前归还许可，下一次正常刷新不会遇到迟到的 busy。
            drop(permit);
            let _ = reply.send(sample);
        }
    }
}
fn current(
    snapshot: &Mutex<SessionSnapshot>,
    epoch: U64,
    closing: &AtomicBool,
) -> HostResult<SessionSnapshot> {
    let state = snapshot.lock().map_err(|_| unavailable())?;
    if state.session_epoch != epoch {
        return Err(HostError::new("EPOCH_MISMATCH", "Session epoch changed"));
    }
    if closing.load(Ordering::SeqCst) || state.state != SessionState::Open {
        return Err(HostError::new(
            "HOST_BUSY",
            "Session is not open for input sampling",
        ));
    }
    Ok(state.clone())
}
