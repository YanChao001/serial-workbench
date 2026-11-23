use super::{Owner, TaskDataRequest};
use crate::node_backend::{SessionRawRequest, TaskRawPage, TaskRawRequest, error, raw};
use serial_workbench_core::{HostResult, U64};
use std::collections::BTreeMap;
use tokio::{sync::oneshot, task::JoinHandle};

#[derive(Default)]
pub(super) struct Lane {
    sequence: u64,
    pending: BTreeMap<u64, Read>,
}

enum Accepted {
    Read(Read),
    Closed(TaskRawPage),
}

struct Read {
    parent: U64,
    response: oneshot::Receiver<HostResult<TaskRawPage>>,
    work: JoinHandle<()>,
    retired: bool,
}

impl Drop for Read {
    fn drop(&mut self) {
        self.work.abort();
    }
}

impl Owner {
    pub(super) fn poll_raw(&mut self) -> HostResult<()> {
        let mut ready = Vec::new();
        let mut retired = Vec::new();
        for (id, pending) in &mut self.raw.pending {
            if !pending.retired {
                let reason = match self.actions.get(&pending.parent.get()) {
                    None => Some(error("OPERATION_NOT_RUNNING", "backendRawParentFinished")),
                    Some(action) if action.cancelling.is_some() => {
                        Some(error("CANCELLED", "backendRawParentCancelled"))
                    }
                    Some(_) => None,
                };
                if let Some(reason) = reason {
                    pending.retired = true;
                    retired.push((*id, reason));
                }
            }
            let result = match pending.response.try_recv() {
                Ok(result) => result,
                Err(oneshot::error::TryRecvError::Empty) => continue,
                Err(oneshot::error::TryRecvError::Closed) => {
                    Err(error("NODE_ACTION_FAILED", "backendRawReadEnded"))
                }
            };
            ready.push((*id, (!pending.retired).then_some(result)));
        }
        for (id, reason) in retired {
            // 先结束 Node 等待，再由实际完成归还工作名额。
            self.raw_reply(id.into(), Err(reason))?;
        }
        for (id, reply) in ready {
            self.raw.pending.remove(&id);
            if let Some(result) = reply {
                self.raw_reply(id.into(), result)?;
            }
        }

        // 每轮最多接纳一个 Raw 请求，控制帧及监督仍由外层的正常轮转处理。
        if let Ok(bytes) = self.process.io.raw_receive.try_recv() {
            let request: TaskDataRequest = serde_json::from_slice(&bytes)
                .map_err(|_| error("PROTOCOL_ERROR", "backendRawRequest"))?;
            let id = request.request_id.get();
            if id <= self.raw.sequence {
                return Err(error("PROTOCOL_ERROR", "backendRawSequence"));
            }
            self.raw.sequence = id;
            match self.start_raw(request) {
                Ok(Accepted::Read(work)) => {
                    self.raw.pending.insert(id, work);
                }
                Ok(Accepted::Closed(page)) => self.raw_reply(id.into(), Ok(page))?,
                Err(error) => self.raw_reply(id.into(), Err(error))?,
            }
        }
        Ok(())
    }

    fn start_raw(&self, request: TaskDataRequest) -> HostResult<Accepted> {
        let task = self.task_context(
            request.parent_request_id,
            &request.parent_operation_id,
            &request.task_context,
        )?;
        let raw_request = serde_json::from_value(request.params)
            .map_err(|_| error("INVALID_ARGUMENT", "backendRawReadParams"))?;
        let (params, ordered) = match raw_request {
            TaskRawRequest::Read(params) => (params, false),
            TaskRawRequest::Session(SessionRawRequest::SessionEvents { params }) => (params, true),
            TaskRawRequest::Session(SessionRawRequest::CloseSessionEvents) => {
                // 已退休的读工作可能仍占全部名额。所属任务仍可归还跟随读取器。
                return (task.close_session_events)().map(Accepted::Closed);
            }
        };
        if self.raw.pending.len() >= raw::SLOTS {
            return Err(error("HOST_BUSY", "backendRawCapacity"));
        }
        let future = (task.read_raw)(params, ordered);
        let (reply, response) = oneshot::channel();
        let owner = std::thread::current();
        let work = task.runtime.spawn(async move {
            let _ = reply.send(future.await);
            owner.unpark();
        });
        Ok(Accepted::Read(Read {
            parent: request.parent_request_id,
            response,
            work,
            retired: false,
        }))
    }

    fn raw_reply(&self, id: U64, result: HostResult<TaskRawPage>) -> HostResult<()> {
        self.process
            .io
            .raw_send
            .try_send(raw::Write::new(id, result)?)
            .map_err(|_| error("HOST_BUSY", "backendRawWriteQueue"))
    }
}
