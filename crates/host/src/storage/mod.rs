//! 串行持久提交边界。调用者等待回执，设备 RX 不持有或等待本模块的数据库锁。
mod db;
mod documents;
mod operations;

use crate::auth::{AuthenticatedActor, HostIdentity, RequestContext};
use crate::clock::SystemClock;
use db::Database;
pub use documents::StoredDocument;
pub use operations::{Acceptance, Settlement, canonical_digest};
use serial_workbench_core::*;
use std::{
    path::Path,
    sync::{Arc, Mutex, mpsc},
    thread::{self, JoinHandle},
};

const WRITER_QUEUE_CAPACITY: usize = 256;
type Job = Box<dyn FnOnce(&mut Database) + Send>;
enum WriterMessage {
    Run(Job),
    Shutdown,
}
struct Writer {
    sender: mpsc::SyncSender<WriterMessage>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for Writer {
    fn drop(&mut self) {
        let _ = self.sender.send(WriterMessage::Shutdown);
        if let Ok(slot) = self.join.get_mut()
            && let Some(join) = slot.take()
        {
            let _ = join.join();
        }
    }
}

#[derive(Clone)]
pub struct Store {
    writer: Arc<Writer>,
    operation_changes: tokio::sync::watch::Sender<()>,
    #[cfg(test)]
    request_diagnostics: Arc<RequestDiagnostics>,
}

#[cfg(test)]
#[derive(Default)]
struct RequestDiagnostics {
    enabled: std::sync::atomic::AtomicBool,
    sequence: std::sync::atomic::AtomicU64,
}

impl Store {
    /// profile 是已选定的独立 Host 配置根；只使用其中的 host-v0 命名空间。
    pub fn open(profile: &Path) -> HostResult<Self> {
        Self::open_with_clock(profile, Arc::new(SystemClock::new()?))
    }

    pub fn open_with_clock(profile: &Path, clock: Arc<dyn Clock>) -> HostResult<Self> {
        let path = profile.join("host-v0/state.sqlite3");
        let (sender, receiver) = mpsc::sync_channel(WRITER_QUEUE_CAPACITY);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let join = thread::Builder::new()
            .name("host-storage".into())
            .spawn(move || {
                let mut database = match Database::open(&path, clock) {
                    Ok(database) => {
                        let _ = ready_sender.send(Ok(()));
                        database
                    }
                    Err(error) => {
                        let _ = ready_sender.send(Err(error));
                        return;
                    }
                };
                while let Ok(message) = receiver.recv() {
                    match message {
                        WriterMessage::Run(job) => job(&mut database),
                        WriterMessage::Shutdown => {
                            let _ = database.checkpoint();
                            break;
                        }
                    }
                }
            })
            .map_err(|_| unavailable())?;
        if let Err(error) = ready_receiver.recv().unwrap_or_else(|_| Err(unavailable())) {
            let _ = join.join();
            return Err(error);
        }
        Ok(Self {
            operation_changes: tokio::sync::watch::channel(()).0,
            writer: Arc::new(Writer {
                sender,
                join: Mutex::new(Some(join)),
            }),
            #[cfg(test)]
            request_diagnostics: Arc::default(),
        })
    }

    // 同步 API 只供控制 worker / spawn_blocking 使用，不在采集或异步调度线程上等待。
    #[cfg_attr(test, track_caller)]
    fn request<T: Send + 'static>(
        &self,
        execute: impl FnOnce(&mut Database) -> HostResult<T> + Send + 'static,
    ) -> HostResult<T> {
        let (sender, receiver) = mpsc::sync_channel(1);
        #[cfg(test)]
        let site = std::panic::Location::caller();
        #[cfg(test)]
        let trace = self
            .request_diagnostics
            .enabled
            .load(std::sync::atomic::Ordering::SeqCst)
            .then(|| {
                let sequence = self
                    .request_diagnostics
                    .sequence
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let queued = std::time::Instant::now();
                eprintln!(
                    "store_request sequence={sequence} stage=enqueue site={site} at={queued:?}"
                );
                (sequence, queued, site)
            });
        let job = Box::new(move |database: &mut Database| {
            #[cfg(test)]
            let started = trace.map(|(sequence, queued, site)| {
                let started = std::time::Instant::now();
                eprintln!(
                    "store_request sequence={sequence} stage=start site={site} at={started:?} queue_us={}",
                    started.duration_since(queued).as_micros()
                );
                started
            });
            let result = execute(database);
            #[cfg(test)]
            if let Some((sequence, _, site)) = trace {
                let finished = std::time::Instant::now();
                eprintln!(
                    "store_request sequence={sequence} stage=finish site={site} at={finished:?} execute_us={}",
                    finished
                        .duration_since(started.expect("traced request start"))
                        .as_micros()
                );
            }
            let _ = sender.send(result);
        });
        self.writer
            .sender
            .try_send(WriterMessage::Run(job))
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => HostError::new("HOST_BUSY", "Storage queue is full"),
                mpsc::TrySendError::Disconnected(_) => unavailable(),
            })?;
        receiver.recv().map_err(|_| unavailable())?
    }

    #[cfg(test)]
    pub(crate) fn trace_requests(&self, enabled: bool) {
        self.request_diagnostics
            .enabled
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn begin_instance(&self) -> HostResult<HostIdentity> {
        self.request(Database::begin_instance)
    }
    pub fn identity(&self) -> HostResult<HostIdentity> {
        self.request(|database| database.identity())
    }
    pub fn synchronize_catalog(&self, digest: &Digest) -> HostResult<U64> {
        let digest = digest.clone();
        self.request(move |database| database.synchronize_catalog(digest))
    }
    pub fn get_selected(
        &self,
        actor: &AuthenticatedActor,
        selector: &OperationGetParams,
    ) -> HostResult<Operation> {
        let (actor, selector) = (actor.clone(), selector.clone());
        self.request(move |database| database.get_selected(&actor, &selector))
    }
    /// Trusted dispatcher only: callers must authorize the original resources before disclosure.
    pub(crate) fn retained_operation(
        &self,
        id: &Id,
    ) -> HostResult<(Operation, Option<JsonObject>)> {
        let id = id.clone();
        self.request(move |database| database.retained_operation(&id))
    }
    pub(crate) fn record_operation_source_authority(
        &self,
        id: &Id,
        source: &Target,
    ) -> HostResult<()> {
        let (id, source) = (id.clone(), source.clone());
        self.request(move |database| database.record_operation_source_authority(&id, &source))
    }
    pub(crate) fn operation_source_authority(&self, id: &Id) -> HostResult<Target> {
        let id = id.clone();
        self.request(move |database| database.operation_source_authority(&id))
    }
    pub fn request_cancel(&self, actor: &AuthenticatedActor, id: &Id) -> HostResult<Operation> {
        let (actor, id) = (actor.clone(), id.clone());
        let operation = self.request(move |database| database.request_cancel(&actor, &id))?;
        self.operation_changes.send_replace(());
        Ok(operation)
    }
    pub(crate) fn subscribe_operation_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.operation_changes.subscribe()
    }
    pub fn operation_metadata(&self) -> HostResult<JsonObject> {
        self.request(|database| database.operation_metadata())
    }
    pub fn issue_context(&self, actor: &AuthenticatedActor) -> HostResult<RequestContext> {
        let actor = actor.clone();
        self.request(move |database| database.issue_context(&actor))
    }
    pub fn accept(
        &self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
    ) -> HostResult<Acceptance> {
        let (actor, call, digest) = (actor.clone(), call.clone(), digest.clone());
        let acceptance = self.request(move |database| database.accept(&actor, &call, &digest))?;
        if matches!(&acceptance, Acceptance::New(_)) {
            self.operation_changes.send_replace(());
        }
        Ok(acceptance)
    }
    /// Publish the accepted operation and its trusted parent in the same transaction.
    pub(crate) fn accept_with_source(
        &self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
        source: Option<&Target>,
    ) -> HostResult<Acceptance> {
        let (actor, call, digest, source) =
            (actor.clone(), call.clone(), digest.clone(), source.cloned());
        let acceptance = self.request(move |database| {
            database.accept_with_source(&actor, &call, &digest, source.as_ref())
        })?;
        if matches!(&acceptance, Acceptance::New(_)) {
            self.operation_changes.send_replace(());
        }
        Ok(acceptance)
    }
    pub(crate) fn lookup_call(
        &self,
        actor: &AuthenticatedActor,
        call: &Call,
        digest: &Digest,
    ) -> HostResult<Option<Operation>> {
        let (actor, call, digest) = (actor.clone(), call.clone(), digest.clone());
        self.request(move |database| database.lookup_call(&actor, &call, &digest))
    }
    pub fn mark_dispatch(&self, id: &Id) -> HostResult<()> {
        let id = id.clone();
        self.request(move |database| database.mark_dispatch(&id))?;
        self.operation_changes.send_replace(());
        Ok(())
    }
    pub fn settle(&self, id: &Id, outcome: Settlement) -> HostResult<Operation> {
        let id = id.clone();
        let operation = self.request(move |database| database.settle(&id, outcome))?;
        self.operation_changes.send_replace(());
        Ok(operation)
    }
    pub fn record_result_evidence(&self, id: &Id, result: &ActionResult) -> HostResult<Operation> {
        let (id, result) = (id.clone(), result.clone());
        let operation =
            self.request(move |database| database.record_result_evidence(&id, result))?;
        self.operation_changes.send_replace(());
        Ok(operation)
    }
    pub(crate) fn record_progress(&self, id: &Id, progress: &Progress) -> HostResult<Operation> {
        let (id, progress) = (id.clone(), progress.clone());
        let operation = self.request(move |database| database.record_progress(&id, progress))?;
        self.operation_changes.send_replace(());
        Ok(operation)
    }
    pub(crate) fn record_client_receipt_evidence(
        &self,
        id: &Id,
        receipt: &ClientEffectReceipt,
    ) -> HostResult<Operation> {
        let (id, receipt) = (id.clone(), receipt.clone());
        let operation =
            self.request(move |database| database.record_client_receipt_evidence(&id, receipt))?;
        self.operation_changes.send_replace(());
        Ok(operation)
    }
    pub fn recover(&self) -> HostResult<Vec<Operation>> {
        let operations = self.request(Database::recover)?;
        self.operation_changes.send_replace(());
        Ok(operations)
    }
    pub fn get(&self, actor: &AuthenticatedActor, id: &Id) -> HostResult<Operation> {
        let (actor, id) = (actor.clone(), id.clone());
        self.request(move |database| database.get(&actor, &id))
    }
    pub(crate) fn operation_state(&self, id: &Id) -> HostResult<OperationState> {
        let id = id.clone();
        self.request(move |database| database.operation_state(&id))
    }
    pub(crate) fn boundary_operations(
        &self,
        target: &Target,
        through: &Id,
        owners: Vec<Id>,
    ) -> HostResult<Vec<Id>> {
        let target = target.clone();
        let through = through.clone();
        self.request(move |database| database.boundary_operations(&target, &through, owners))
    }
    pub fn prune(&self) -> HostResult<()> {
        self.request(Database::prune)?;
        self.operation_changes.send_replace(());
        Ok(())
    }
    pub(crate) fn shutdown_operations(
        &self,
        tracked: &[Id],
        limit: usize,
    ) -> HostResult<Vec<Operation>> {
        let tracked = tracked.to_vec();
        self.request(move |database| database.shutdown_operations(&tracked, limit))
    }
    /// 正常退出前显式等待此提交，错误由关闭协调器记录；Drop 仅作最后一次尽力提交。
    pub fn checkpoint(&self) -> HostResult<()> {
        self.request(Database::checkpoint)
    }
    pub fn read_document(&self, id: &Id) -> HostResult<Option<StoredDocument>> {
        let id = id.clone();
        self.request(move |database| database.read_document(&id))
    }
    pub fn compare_and_swap_document(
        &self,
        id: &Id,
        expected_revision: U64,
        value: JsonObject,
    ) -> HostResult<StoredDocument> {
        let id = id.clone();
        self.request(move |database| {
            database.compare_and_swap_document(&id, expected_revision, value)
        })
    }
}

fn unavailable() -> HostError {
    HostError::new("STORAGE_UNAVAILABLE", "Host storage is unavailable")
}

#[cfg(test)]
mod client_receipt_tests;
#[cfg(test)]
mod operation_progress_tests;
#[cfg(test)]
mod operation_recovery_tests;
#[cfg(test)]
mod operation_source_tests;
