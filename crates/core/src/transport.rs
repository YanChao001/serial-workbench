//! 会话 owner 的后端边界；在途 TX/drain 轮询期间继续 RX，并保留部分写入证据。
use crate::*;
use std::{
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};

pub type BackendResult<T> = Result<T, BackendError>;
/// 等待结果超时后仍由调用方持有的原生清理责任；poll 不阻塞。
pub trait BackendCleanup: std::fmt::Debug + Send + Sync {
    fn poll(&self) -> Option<HostResult<()>>;
}
#[derive(Debug, Clone)]
pub struct BackendError {
    pub error: Box<HostError>,
    pub accepted_ranges: Vec<ByteRange>,
    pub unknown_ranges: Vec<ByteRange>,
    pub cleanup: Option<Arc<dyn BackendCleanup>>,
}
impl From<HostError> for BackendError {
    fn from(error: HostError) -> Self {
        Self {
            error: Box::new(error),
            accepted_ranges: Vec::new(),
            unknown_ranges: Vec::new(),
            cleanup: None,
        }
    }
}
#[derive(Debug, Clone)]
pub struct ReadBlock {
    pub bytes: Arc<[u8]>,
    pub message: Option<MessageFragment>,
}
#[derive(Debug, Clone)]
pub struct BackendWrite {
    pub accepted_ranges: Vec<ByteRange>,
    pub unknown_ranges: Vec<ByteRange>,
    pub error: Option<HostError>,
}

/// 字节与其分配记账具有同一生命周期；未决原生任务必须保留整个载荷。
#[derive(Clone)]
pub struct WritePayload {
    bytes: Arc<[u8]>,
    _retention: Arc<dyn Send + Sync>,
}
impl WritePayload {
    pub fn owned(bytes: Arc<[u8]>) -> Self {
        Self::retained(bytes, Arc::new(()))
    }
    pub fn retained(bytes: Arc<[u8]>, retention: Arc<dyn Send + Sync>) -> Self {
        Self {
            bytes,
            _retention: retention,
        }
    }
}
impl std::ops::Deref for WritePayload {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}
#[derive(Debug, Clone)]
pub struct ConfigApplication {
    pub fields: Vec<ConfigField>,
    pub readback: JsonObject,
}
#[derive(Debug, Clone)]
pub enum ControlCommand {
    SetLine { line: ControlLine, value: bool },
    AssertBreak,
    ClearBreak,
    QueueStatus,
    ModemStatus,
    Purge { direction: PurgeDirection },
}
#[derive(Debug, Clone)]
pub enum ControlResult {
    Line {
        line: ControlLine,
        value: bool,
    },
    Break {
        asserted: bool,
    },
    Queue {
        pending_bytes: U64,
    },
    Modem {
        cts: bool,
        dsr: bool,
        ring: bool,
        carrier: bool,
    },
    Drained {
        status: ControlStatus,
        error: Option<HostError>,
    },
    Purged {
        ranges: Vec<DirectionalRange>,
        unknown_extent: bool,
    },
}
#[derive(Debug, Clone)]
pub struct DrainRequest {
    pub wait: Duration,
    pub cancelled: Arc<AtomicBool>,
    pub closing: Arc<AtomicBool>,
}

/// poll 不阻塞 owner；未确认的原生工作在丢弃后仍须保留资源所有权。
pub trait PendingDrain: Send {
    fn poll(&mut self) -> Option<BackendResult<ControlResult>>;
}

pub trait PendingWrite: Send {
    /// 不阻塞 owner；已知前缀、在途未知区间与未提交尾部必须分别结算。
    fn poll(&mut self) -> Option<BackendResult<BackendWrite>>;
}

pub trait Transport: Send {
    fn capabilities(&self) -> TransportCapabilities;
    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock>;
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>>;
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication>;
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult>;
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>>;
    fn close(&mut self) -> BackendResult<()>;
}
