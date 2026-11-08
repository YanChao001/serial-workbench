use serial_workbench_core::{Clock, DeviceBinding, Id, U64};
use std::sync::Arc;

#[derive(Clone, Copy)]
pub struct ReconnectGate {
    pub authorized: bool,
    pub identity_exact: bool,
    pub configuration_settled: bool,
    pub epoch_current: bool,
    pub closed: bool,
    pub cancelled: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub enum ReconnectDecision {
    Wait,
    Attempt,
    Stopped,
}

/// 决策仅调度下一次尝试；调用方必须以当前授权、身份和会话事实重新填充 gate。
pub struct ReconnectResponsibility {
    pub actor_id: Id,
    pub binding: DeviceBinding,
    pub session_epoch: U64,
    clock: Arc<dyn Clock>,
    deadline_ns: u64,
    delay_ms: u64,
    attempts: u64,
    in_flight: bool,
    stopped: bool,
}
impl ReconnectResponsibility {
    /// 在当前打开尝试失败并结算后，开始计算下一次退避。
    pub fn attempt_failed(&mut self) {
        if self.stopped || !self.in_flight {
            return;
        }
        self.in_flight = false;
        self.delay_ms = self
            .delay_ms
            .saturating_mul(2)
            .min(self.binding.reconnect.max_delay_ms.get());
        self.deadline_ns = self
            .clock
            .mono_ns()
            .saturating_add(self.delay_ms.saturating_mul(1_000_000));
    }
    pub fn new(
        actor_id: Id,
        binding: DeviceBinding,
        session_epoch: U64,
        clock: Arc<dyn Clock>,
    ) -> serial_workbench_core::HostResult<Self> {
        binding.validate()?;
        let delay_ms = binding.configuration.reconnect_backoff_ms.get();
        let deadline_ns = clock
            .mono_ns()
            .saturating_add(delay_ms.saturating_mul(1_000_000));
        let stopped = !binding.reconnect.enabled;
        Ok(Self {
            actor_id,
            binding,
            session_epoch,
            clock,
            deadline_ns,
            delay_ms,
            attempts: 0,
            in_flight: false,
            stopped,
        })
    }
    pub fn poll(&mut self, gate: ReconnectGate) -> ReconnectDecision {
        if self.stopped || !gate.authorized || !gate.epoch_current || gate.closed || gate.cancelled
        {
            self.stopped = true;
            return ReconnectDecision::Stopped;
        }
        if self.in_flight {
            return ReconnectDecision::Wait;
        }
        if self.attempts >= self.binding.reconnect.max_attempts.get() {
            self.stopped = true;
            return ReconnectDecision::Stopped;
        }
        if !gate.identity_exact
            || !gate.configuration_settled
            || self.clock.mono_ns() < self.deadline_ns
        {
            return ReconnectDecision::Wait;
        }
        self.attempts += 1;
        self.in_flight = true;
        ReconnectDecision::Attempt
    }
}
