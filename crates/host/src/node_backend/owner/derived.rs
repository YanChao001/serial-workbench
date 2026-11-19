use super::{Owner, TaskDataRequest};
use crate::node_backend::{derived, error};
use serial_workbench_core::{DerivedPublishParams, DerivedPublishResult, HostResult, U64};
use std::collections::BTreeMap;
use tokio::{sync::oneshot, task::JoinHandle};

#[derive(Default)]
pub(super) struct Lane {
    sequence: u64,
    pending: BTreeMap<u64, Publish>,
}

struct Publish {
    response: oneshot::Receiver<HostResult<DerivedPublishResult>>,
    work: JoinHandle<()>,
}

impl Drop for Publish {
    fn drop(&mut self) {
        self.work.abort();
    }
}

impl Owner {
    pub(super) fn poll_derived(&mut self) -> HostResult<()> {
        let ready: Vec<_> = self
            .derived
            .pending
            .iter_mut()
            .filter_map(|(id, pending)| {
                let result = match pending.response.try_recv() {
                    Ok(result) => result,
                    Err(oneshot::error::TryRecvError::Empty) => return None,
                    Err(oneshot::error::TryRecvError::Closed) => {
                        Err(error("NODE_ACTION_FAILED", "backendDerivedPublishEnded"))
                    }
                };
                Some((*id, result))
            })
            .collect();
        for (id, result) in ready {
            self.derived.pending.remove(&id);
            self.derived_reply(id.into(), result)?;
        }
        if let Ok(bytes) = self.process.io.derived_receive.try_recv() {
            let request: TaskDataRequest = serde_json::from_slice(&bytes)
                .map_err(|_| error("PROTOCOL_ERROR", "backendDerivedRequest"))?;
            let id = request.request_id.get();
            if id <= self.derived.sequence {
                return Err(error("PROTOCOL_ERROR", "backendDerivedSequence"));
            }
            self.derived.sequence = id;
            match self.start_derived(request) {
                Ok(work) => {
                    self.derived.pending.insert(id, work);
                }
                Err(error) => self.derived_reply(id.into(), Err(error))?,
            }
        }
        Ok(())
    }

    fn start_derived(&self, request: TaskDataRequest) -> HostResult<Publish> {
        if self.derived.pending.len() >= derived::SLOTS {
            return Err(error("HOST_BUSY", "backendDerivedCapacity"));
        }
        let task = self.task_context(
            request.parent_request_id,
            &request.parent_operation_id,
            &request.task_context,
        )?;
        let params: DerivedPublishParams = serde_json::from_value(request.params)
            .map_err(|_| error("INVALID_ARGUMENT", "backendDerivedPublishParams"))?;
        let future = (task.publish_derived)(params);
        let (reply, response) = oneshot::channel();
        let work = task.runtime.spawn(async move {
            // 成功回执代表已经发布的事实，父任务结束也不能改写它。
            let _ = reply.send(future.await);
        });
        Ok(Publish { response, work })
    }

    fn derived_reply(&self, id: U64, result: HostResult<DerivedPublishResult>) -> HostResult<()> {
        self.process
            .io
            .derived_send
            .try_send(derived::encode(id, result)?)
            .map_err(|_| error("HOST_BUSY", "backendDerivedWriteQueue"))
    }
}
