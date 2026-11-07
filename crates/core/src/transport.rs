//! 同步后端边界；唯一持口线程调用，后端不得吞掉部分写入证据。
use crate::*;
use std::{sync::Arc, time::Duration};

pub type BackendResult<T> = Result<T, BackendError>;
#[derive(Debug, Clone)]
pub struct BackendError {
    pub error: Box<HostError>,
    pub accepted_ranges: Vec<ByteRange>,
    pub unknown_ranges: Vec<ByteRange>,
}
impl From<HostError> for BackendError {
    fn from(error: HostError) -> Self {
        Self {
            error: Box::new(error),
            accepted_ranges: Vec::new(),
            unknown_ranges: Vec::new(),
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
    Drain { wait: Duration },
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
    Drained,
    Purged {
        ranges: Vec<DirectionalRange>,
        unknown_extent: bool,
    },
}
pub trait Transport: Send {
    fn capabilities(&self) -> TransportCapabilities;
    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock>;
    fn write(&mut self, bytes: &[u8], wait: Duration) -> BackendResult<BackendWrite>;
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication>;
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult>;
    fn close(&mut self) -> BackendResult<()>;
}
