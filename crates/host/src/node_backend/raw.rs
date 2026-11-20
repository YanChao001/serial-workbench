//! 私有 Raw 传输沿用公开 stream.read 的数据和错误，其独立队列由进程 owner 管理。
use super::{Authority, error};
use crate::stream::RawOutputLease;
use serde::Serialize;
use serial_workbench_core::{False, HostResult, RpcReply, RpcResult, StreamReadResult, True, U64};
use std::{future::Future, pin::Pin};

pub(super) const FLAG: u32 = 1 << 31;
pub(crate) const SLOTS: usize = 4;
pub(super) const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_REPLY_BYTES: usize = 256 * 1024 + 4096;

pub(crate) type TaskRawFuture = Pin<Box<dyn Future<Output = HostResult<TaskRawPage>> + Send>>;

pub(crate) struct TaskRawPage {
    pub result: StreamReadResult,
    pub lease: RawOutputLease,
    pub authorize: Authority,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RawReply {
    request_id: U64,
    reply: RpcReply,
}

fn encode(request_id: U64, result: HostResult<StreamReadResult>) -> HostResult<Vec<u8>> {
    let reply = RawReply {
        request_id,
        reply: match result {
            Ok(result) => RpcReply::Success {
                ok: True,
                result: Box::new(RpcResult::StreamRead(result)),
            },
            Err(error) => RpcReply::Failure { ok: False, error },
        },
    };
    let capacity = serial_workbench_ipc::frame::encoded_length(&reply, MAX_REPLY_BYTES)
        .map_err(|_| error("LIMIT_EXCEEDED", "backendRawReplyFrame"))?;
    let mut bytes = Vec::with_capacity(capacity);
    serde_json::to_writer(&mut bytes, &reply)
        .map_err(|_| error("PROTOCOL_ERROR", "backendRawReply"))?;
    Ok(bytes)
}

pub(super) struct Write {
    request_id: U64,
    bytes: Vec<u8>,
    guarded: Option<(Authority, RawOutputLease)>,
}

impl Write {
    pub(super) fn new(request_id: U64, result: HostResult<TaskRawPage>) -> HostResult<Self> {
        let (bytes, guarded) = match result {
            Ok(page) => (
                encode(request_id, Ok(page.result))?,
                Some((page.authorize, page.lease)),
            ),
            Err(error) => (encode(request_id, Err(error))?, None),
        };
        Ok(Self {
            request_id,
            bytes,
            guarded,
        })
    }

    pub(super) fn body(&self) -> HostResult<std::borrow::Cow<'_, [u8]>> {
        use std::borrow::Cow;
        if let Some((authorize, _)) = &self.guarded
            && let Err(error) = authorize()
        {
            return encode(self.request_id, Err(error)).map(Cow::Owned);
        }
        Ok(Cow::Borrowed(&self.bytes))
    }
}
