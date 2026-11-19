use super::error;
use serde::Serialize;
use serial_workbench_core::{DerivedPublishResult, False, HostError, HostResult, True, U64};
use std::{future::Future, pin::Pin};

pub(super) const FLAG: u32 = 1 << 30;
pub(crate) const SLOTS: usize = 4;
pub(super) const MAX_REQUEST_BYTES: usize = 32 * 1024;
const MAX_REPLY_BYTES: usize = 8192;

pub(crate) type TaskDerivedFuture =
    Pin<Box<dyn Future<Output = HostResult<DerivedPublishResult>> + Send>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    request_id: U64,
    reply: Reply,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Reply {
    Success {
        ok: True,
        result: DerivedPublishResult,
    },
    Failure {
        ok: False,
        error: HostError,
    },
}

pub(super) fn encode(
    request_id: U64,
    result: HostResult<DerivedPublishResult>,
) -> HostResult<Vec<u8>> {
    let envelope = Envelope {
        request_id,
        reply: match result {
            Ok(result) => Reply::Success { ok: True, result },
            Err(error) => Reply::Failure { ok: False, error },
        },
    };
    let size = serial_workbench_ipc::frame::encoded_length(&envelope, MAX_REPLY_BYTES)
        .map_err(|_| error("LIMIT_EXCEEDED", "backendDerivedReplyFrame"))?;
    let mut bytes = Vec::with_capacity(size);
    serde_json::to_writer(&mut bytes, &envelope)
        .map_err(|_| error("PROTOCOL_ERROR", "backendDerivedReply"))?;
    Ok(bytes)
}
