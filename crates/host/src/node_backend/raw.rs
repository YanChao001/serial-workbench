//! 私有 Raw 传输继承公开 stream.read 形状，有序会话是独立选择。
use super::{Authority, error};
use crate::stream::{RawOutputLease, SessionSourceEnd};
use serde::{Deserialize, Serialize};
use serial_workbench_core::{
    False, HostError, HostResult, StreamReadParams, StreamReadResult, True, U64,
};
use std::{future::Future, pin::Pin};

pub(super) const FLAG: u32 = 1 << 31;
pub(crate) const SLOTS: usize = 4;
pub(super) const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_REPLY_BYTES: usize = 256 * 1024 + 4096;

pub(crate) type TaskRawFuture = Pin<Box<dyn Future<Output = HostResult<TaskRawPage>> + Send>>;

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum TaskRawRequest {
    Read(StreamReadParams),
    Session(SessionRawRequest),
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum SessionRawRequest {
    SessionEvents { params: StreamReadParams },
    CloseSessionEvents,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum TaskRawResult {
    StreamRead(StreamReadResult),
    SessionEvents {
        #[serde(flatten)]
        page: StreamReadResult,
        #[serde(skip_serializing_if = "Option::is_none")]
        end: Option<SessionSourceEnd>,
    },
    SessionEventsClosed,
}

type Guard = (Authority, Option<RawOutputLease>);

pub(crate) struct TaskRawPage {
    result: HostResult<TaskRawResult>,
    guarded: Option<Guard>,
}

impl TaskRawPage {
    pub(crate) fn protected(
        result: HostResult<TaskRawResult>,
        authorize: Authority,
        lease: Option<RawOutputLease>,
    ) -> Self {
        Self {
            result,
            guarded: Some((authorize, lease)),
        }
    }

    pub(crate) fn closed() -> Self {
        Self {
            result: Ok(TaskRawResult::SessionEventsClosed),
            guarded: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RawReply {
    request_id: U64,
    reply: Reply,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Reply {
    Success {
        ok: True,
        result: Box<TaskRawResult>,
    },
    Failure {
        ok: False,
        error: HostError,
    },
}

fn encode(request_id: U64, result: HostResult<TaskRawResult>) -> HostResult<Vec<u8>> {
    let reply = RawReply {
        request_id,
        reply: match result {
            Ok(result) => Reply::Success {
                ok: True,
                result: Box::new(result),
            },
            Err(error) => Reply::Failure { ok: False, error },
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
    guarded: Option<Guard>,
}

impl Write {
    pub(super) fn new(request_id: U64, result: HostResult<TaskRawPage>) -> HostResult<Self> {
        let (result, guarded) = match result {
            Ok(page) => (page.result, page.guarded),
            Err(error) => (Err(error), None),
        };
        Ok(Self {
            request_id,
            bytes: encode(request_id, result)?,
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use serial_workbench_core::Cursor;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    fn page() -> StreamReadResult {
        StreamReadResult {
            events: vec![],
            next_event_seq: 7.into(),
            has_more: false,
        }
    }

    #[test]
    fn legacy_raw_reply_and_params_preserve_their_wire_shape() {
        let params = json!({
            "sessionId":"session",
            "sessionEpoch":"1",
            "startEventSeq":"7",
            "maxEvents":"1",
            "maxBytes":"2048"
        });
        assert!(matches!(
            serde_json::from_value::<TaskRawRequest>(params.clone()).unwrap(),
            TaskRawRequest::Read(_)
        ));
        assert!(matches!(
            serde_json::from_value::<TaskRawRequest>(
                json!({"kind":"session_events","params":params})
            )
            .unwrap(),
            TaskRawRequest::Session(SessionRawRequest::SessionEvents { .. })
        ));
        let bytes = encode(3.into(), Ok(TaskRawResult::StreamRead(page()))).unwrap();
        let wire: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            wire,
            json!({
                "requestId":"3",
                "reply":{"ok":true,"result":{
                    "kind":"stream_read","events":[],"nextEventSeq":"7","hasMore":false
                }}
            })
        );
    }

    #[test]
    fn revocation_replaces_queued_terminal_and_retention_gap_before_write() {
        let allowed = Arc::new(AtomicBool::new(true));
        let authorize: Authority = Arc::new({
            let allowed = allowed.clone();
            move || {
                if allowed.load(Ordering::Acquire) {
                    return Ok(());
                }
                Err(HostError::new("PERMISSION_DENIED", "Reader grant changed"))
            }
        });
        let after: Cursor = serde_json::from_value(json!({
            "hostId":"host","instanceEpoch":"1","scopeId":"raw","position":"6"
        }))
        .unwrap();
        let mut expired = HostError::new("CURSOR_EXPIRED", "History expired");
        expired.details = Some(Box::new(
            serde_json::from_value(json!({"oldestCursor":after})).unwrap(),
        ));
        let end = SessionSourceEnd {
            after,
            reason: crate::stream::SessionEndReason::BackendFault { code: None },
            tx_evidence_gap: true,
        };
        let terminal = Write::new(
            1.into(),
            Ok(TaskRawPage::protected(
                Ok(TaskRawResult::SessionEvents {
                    page: page(),
                    end: Some(end),
                }),
                authorize.clone(),
                None,
            )),
        )
        .unwrap();
        let gap = Write::new(
            2.into(),
            Ok(TaskRawPage::protected(Err(expired), authorize, None)),
        )
        .unwrap();
        let terminal_allowed: Value = serde_json::from_slice(&terminal.body().unwrap()).unwrap();
        let gap_allowed: Value = serde_json::from_slice(&gap.body().unwrap()).unwrap();
        assert_eq!(
            terminal_allowed["reply"]["result"]["end"]["reason"],
            json!({"kind":"backend_fault"})
        );
        assert_eq!(
            gap_allowed["reply"]["error"]["details"]["oldestCursor"]["position"],
            "6"
        );
        allowed.store(false, Ordering::Release);
        for pending in [terminal, gap] {
            let denied: Value = serde_json::from_slice(&pending.body().unwrap()).unwrap();
            assert_eq!(denied["reply"]["ok"], false);
            assert_eq!(denied["reply"]["error"]["code"], "PERMISSION_DENIED");
            assert!(denied["reply"].get("result").is_none());
            assert!(denied["reply"]["error"].get("details").is_none());
        }
    }
}
