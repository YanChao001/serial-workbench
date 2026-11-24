use super::{Acceptance, Host, blocking, busy, decode, invalid};
use crate::{auth::GrantStamp, ipc::ConnectionContext};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{Instant, sleep_until},
};
use tokio_util::sync::CancellationToken;

const MAX_CHUNK_BYTES: usize = 64 * 1024;
const MAX_UPLOAD_BYTES: u64 = crate::files::references::MAX_FILE;
const MAX_UPLOADS: usize = 8;
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) struct BrowserFileBudget {
    slots: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
}

impl BrowserFileBudget {
    pub(super) fn new() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(MAX_UPLOADS)),
            bytes: Arc::new(Semaphore::new(MAX_UPLOAD_BYTES as usize)),
        }
    }

    fn open(&self, directory: &Path, target: Target, length: U64) -> HostResult<Upload> {
        let total = length.get();
        if total == 0 || total > MAX_UPLOAD_BYTES {
            return Err(HostError::new(
                "LIMIT_EXCEEDED",
                "Browser file size is outside the transfer limit",
            ));
        }
        let count = self.slots.clone().try_acquire_owned().map_err(|_| busy())?;
        let space = self
            .bytes
            .clone()
            .try_acquire_many_owned(total as u32)
            .map_err(|_| busy())?;
        serial_workbench_ipc::prepare_private_directory(directory)?;
        let file = tempfile::tempfile_in(directory).map_err(|_| storage())?;
        Ok(Upload {
            id: Id::try_from(uuid::Uuid::new_v4().to_string().as_str())?,
            target,
            file,
            length,
            received: 0,
            hash: Sha256::new(),
            grant: None,
            sealed: None,
            deadline: Instant::now() + IDLE_TIMEOUT,
            finished: CancellationToken::new(),
            _count: count,
            _space: space,
        })
    }
}

pub(crate) struct Upload {
    id: Id,
    target: Target,
    file: File,
    length: U64,
    received: u64,
    hash: Sha256,
    grant: Option<GrantStamp>,
    sealed: Option<Digest>,
    deadline: Instant,
    finished: CancellationToken,
    _count: OwnedSemaphorePermit,
    _space: OwnedSemaphorePermit,
}

impl Drop for Upload {
    fn drop(&mut self) {
        self.finished.cancel();
    }
}

impl Upload {
    pub(crate) fn read_chunk(&mut self, offset: u64, len: usize) -> HostResult<Vec<u8>> {
        let mut bytes = vec![0; len];
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|_| storage())?;
        self.file.read_exact(&mut bytes).map_err(|_| storage())?;
        Ok(bytes)
    }

    fn progress(&self) -> BrowserFileHandoffProgress {
        BrowserFileHandoffProgress {
            upload_id: self.id.clone(),
            received_bytes: self.received.into(),
            total_bytes: self.length,
            sealed_fingerprint: self.sealed.clone(),
        }
    }

    fn append(&mut self, offset: U64, input: &Bytes) -> HostResult<()> {
        if self.sealed.is_some()
            || offset.get() != self.received
            || input.as_str().len() > 4 * MAX_CHUNK_BYTES.div_ceil(3)
        {
            return Err(invalid());
        }
        let bytes = STANDARD.decode(input.as_str()).map_err(|_| invalid())?;
        let end = self.received + bytes.len() as u64;
        if bytes.is_empty() || bytes.len() > MAX_CHUNK_BYTES || end > self.length.get() {
            return Err(invalid());
        }
        self.file.write_all(&bytes).map_err(|_| storage())?;
        self.hash.update(&bytes);
        self.received = end;
        Ok(())
    }

    fn seal(&mut self) -> HostResult<()> {
        if self.received != self.length.get() {
            return Err(invalid());
        }
        self.sealed = Some(Digest::try_from(
            format!("{:x}", self.hash.clone().finalize()).as_str(),
        )?);
        Ok(())
    }
}

// One slot per authenticated browser Control connection, never shared by tabs or Raw.
#[derive(Default)]
pub(crate) struct BrowserUploadSlot {
    upload: Mutex<Option<Upload>>,
    closed: CancellationToken,
}

impl BrowserUploadSlot {
    pub(crate) fn close(&self) {
        self.closed.cancel();
        if let Ok(mut upload) = self.upload.try_lock() {
            upload.take();
        }
    }

    fn begin(
        &self,
        open: impl FnOnce() -> HostResult<Upload>,
    ) -> HostResult<(BrowserFileHandoffProgress, CancellationToken)> {
        let mut current = self.upload.lock().map_err(|_| busy())?;
        if self.closed.is_cancelled() {
            return Err(closed());
        }
        if current
            .as_ref()
            .is_some_and(|upload| upload.deadline > Instant::now())
        {
            return Err(busy());
        }
        current.take();
        let upload = open()?;
        if self.closed.is_cancelled() {
            return Err(closed());
        }
        let result = (upload.progress(), upload.finished.clone());
        *current = Some(upload);
        Ok(result)
    }

    fn change(
        &self,
        id: &Id,
        edit: impl FnOnce(&mut Upload) -> HostResult<()>,
    ) -> HostResult<BrowserFileHandoffProgress> {
        let mut current = self.upload.lock().map_err(|_| busy())?;
        if !current.as_ref().is_some_and(|upload| &upload.id == id) {
            return Err(missing());
        }
        let mut upload = current.take().expect("matched browser upload");
        if self.closed.is_cancelled() || upload.deadline <= Instant::now() {
            return Err(closed());
        }
        edit(&mut upload)?;
        if self.closed.is_cancelled() {
            return Err(closed());
        }
        upload.deadline = Instant::now() + IDLE_TIMEOUT;
        let result = upload.progress();
        *current = Some(upload);
        Ok(result)
    }

    fn lifetime(&self, id: &Id) -> HostResult<Option<(Instant, Option<GrantStamp>)>> {
        let current = self.upload.lock().map_err(|_| busy())?;
        Ok(current
            .as_ref()
            .filter(|upload| &upload.id == id)
            .map(|upload| (upload.deadline, upload.grant.clone())))
    }

    fn discard(&self, id: &Id) -> HostResult<bool> {
        let mut current = self.upload.lock().map_err(|_| busy())?;
        if current.as_ref().is_some_and(|upload| &upload.id == id) {
            current.take();
            return Ok(true);
        }
        Ok(false)
    }
}

pub(super) struct BrowserFileAdmission {
    context: ConnectionContext,
    slot: Arc<BrowserUploadSlot>,
    upload_id: Id,
}

impl BrowserFileAdmission {
    pub(super) fn validate_reference(&self, query: &Query) -> HostResult<()> {
        let params: FileTransferParams = decode(&query.params)?;
        let reference = &params.source_ref;
        if reference.host_id != query.target.host_id
            || reference.kind.as_str() != "file"
            || reference.id != self.upload_id
            || reference.revision != Some(1.into())
        {
            return Err(invalid());
        }
        Ok(())
    }

    pub(super) fn accept(
        &self,
        host: &Host,
        call: &Call,
        digest: &Digest,
    ) -> HostResult<(Acceptance, Option<GrantStamp>, Option<Upload>)> {
        let mut current = self.slot.upload.lock().map_err(|_| busy())?;
        let store = &host.inner.store;
        let actor = &self.context.actor;
        let Some(upload) = current.as_ref().filter(|file| file.id == self.upload_id) else {
            // 同连接的另一个请求可能已在首次查回执之后接纳文件。
            return store
                .lookup_call(actor, call, digest)?
                .map(|existing| (Acceptance::Existing(existing), None, None))
                .ok_or_else(missing);
        };
        if upload.target != call.target {
            return Err(denied());
        }
        if self.slot.closed.is_cancelled() || upload.deadline <= Instant::now() {
            current.take();
            return Err(closed());
        }
        let params: FileTransferParams = decode(&call.params)?;
        if upload.sealed.is_none()
            || params
                .offset
                .get()
                .checked_add(params.length.get())
                .is_none_or(|end| end > upload.length.get())
        {
            return Err(invalid());
        }
        let initial = upload.grant.as_ref().ok_or_else(denied)?;
        let grant = host.browser_file_grants(&self.context, &upload.target, Some(initial))?;
        let acceptance = host.inner.auth.commit_grant_stamp(&grant, || {
            // 撤权和接纳线性化。连接关闭或主动丢弃在此之前生效时，不能写入。
            if self.slot.closed.is_cancelled()
                || upload.deadline <= Instant::now()
                || self.context.is_closed()
                || self
                    .context
                    .browser_stopped
                    .as_ref()
                    .is_none_or(|stopped| *stopped.borrow())
            {
                return Err(closed());
            }
            host.inner
                .auth
                .require(actor, "content.read", &upload.target)?;
            store.accept_with_source(actor, call, digest, None)
        })?;
        let owned = if matches!(acceptance, Acceptance::New(_)) {
            let upload = current.take().expect("matched browser upload");
            upload.finished.cancel();
            Some(upload)
        } else {
            None
        };
        Ok((acceptance, Some(grant), owned))
    }
}

impl Host {
    pub(super) async fn browser_file_handoff(
        &self,
        context: ConnectionContext,
        request: BrowserFileHandoffParams,
    ) -> HostResult<RpcResult> {
        let slot = context.browser_upload.clone().ok_or_else(denied)?;
        match request {
            BrowserFileHandoffParams::Begin { target, length } => {
                let host = self.clone();
                let local_slot = slot.clone();
                let browser = context.clone();
                let upload_target = target.clone();
                let (progress, finished) = blocking(move || {
                    let stamp = host.browser_file_grants(&browser, &upload_target, None)?;
                    local_slot.begin(|| {
                        let directory = host.inner.store.profile().join("host-v0/browser-handoff");
                        let mut upload = host.inner.browser_file_budget.open(
                            &directory,
                            upload_target,
                            length,
                        )?;
                        upload.grant = Some(stamp);
                        Ok(upload)
                    })
                })
                .await?;
                let host = self.clone();
                let upload_id = progress.upload_id.clone();
                tokio::spawn(async move {
                    host.watch_browser_file(context, slot, target, upload_id, finished)
                        .await;
                });
                Ok(RpcResult::BrowserFileHandoff(progress))
            }
            BrowserFileHandoffParams::Submit { upload_id, call } => {
                if call.action_id.as_str() != "transfer.file" {
                    return Err(invalid());
                }
                let actor = context.actor.clone();
                self.invoke_with_browser_file(
                    &actor,
                    *call,
                    Some(BrowserFileAdmission {
                        context,
                        slot,
                        upload_id,
                    }),
                )
                .await
                .map(|operation| RpcResult::Operation(Box::new(OperationResult { operation })))
            }
            BrowserFileHandoffParams::Discard { upload_id } => {
                blocking(move || slot.discard(&upload_id)).await?;
                Ok(RpcResult::Closed(ClosedResult { closed: True }))
            }
            BrowserFileHandoffParams::Append {
                upload_id,
                offset,
                bytes_base64,
            } => {
                self.advance_browser_file(context, slot, upload_id, move |upload| {
                    upload.append(offset, &bytes_base64)
                })
                .await
            }
            BrowserFileHandoffParams::Seal { upload_id } => {
                self.advance_browser_file(context, slot, upload_id, Upload::seal)
                    .await
            }
        }
    }

    async fn advance_browser_file(
        &self,
        context: ConnectionContext,
        slot: Arc<BrowserUploadSlot>,
        upload_id: Id,
        edit: impl FnOnce(&mut Upload) -> HostResult<()> + Send + 'static,
    ) -> HostResult<RpcResult> {
        let host = self.clone();
        blocking(move || {
            slot.change(&upload_id, |upload| {
                let grant = upload.grant.as_ref().ok_or_else(denied)?;
                host.browser_file_grants(&context, &upload.target, Some(grant))?;
                edit(upload)
            })
            .map(RpcResult::BrowserFileHandoff)
        })
        .await
    }

    fn browser_file_grants(
        &self,
        context: &ConnectionContext,
        target: &Target,
        previous: Option<&GrantStamp>,
    ) -> HostResult<GrantStamp> {
        let listener = context.browser_stopped.as_ref().ok_or_else(denied)?;
        if *listener.borrow() || context.is_closed() {
            return Err(closed());
        }
        target.validate()?;
        let grants = self.inner.auth.snapshot(&context.actor)?;
        grants.require("device.modify", target)?;
        let session = self.devices().session(target)?.snapshot()?;
        if session.state != SessionState::Open || session.read_only {
            return Err(HostError::new(
                "SESSION_NOT_OPEN",
                "Browser file handoff requires a writable open session",
            ));
        }
        if let Some(stamp) = previous {
            grants.validate_grants(stamp)?;
            return Ok(stamp.clone());
        }
        grants
            .capture_session_write_grants(target)
            .ok_or_else(denied)
    }

    async fn watch_browser_file(
        &self,
        context: ConnectionContext,
        slot: Arc<BrowserUploadSlot>,
        target: Target,
        upload_id: Id,
        finished: CancellationToken,
    ) {
        let auth = &self.inner.auth;
        let mut grants_changed = auth.subscribe_changes();
        let Some(mut listener) = context.browser_stopped.clone() else {
            return;
        };
        loop {
            let host = self.clone();
            let browser = context.clone();
            let current = slot.clone();
            let target = target.clone();
            let id = upload_id.clone();
            let Ok(Some((deadline, stamp))) = blocking(move || {
                let Some((deadline, stamp)) = current.lifetime(&id)? else {
                    return Ok(None);
                };
                if deadline <= Instant::now() {
                    return Ok(None);
                }
                Ok(Some((
                    deadline,
                    host.browser_file_grants(
                        &browser,
                        &target,
                        Some(stamp.as_ref().ok_or_else(denied)?),
                    )?,
                )))
            })
            .await
            else {
                break;
            };
            tokio::select! {
                biased;
                _ = finished.cancelled() => return,
                _ = slot.closed.cancelled() => break,
                _ = listener.wait_for(|stopped| *stopped) => break,
                _ = sleep_until(deadline) => {},
                _ = auth.wait_grant_expiry(Some(&stamp)) => {},
                changed = grants_changed.changed() => {
                    if changed.is_err() { break; }
                }
            }
        }
        let _ = blocking(move || slot.discard(&upload_id)).await;
    }
}

fn denied() -> HostError {
    HostError::new(
        "PERMISSION_DENIED",
        "File handoff requires a paired browser Control connection",
    )
}

fn closed() -> HostError {
    HostError::new("CLIENT_CLOSED", "Browser file handoff is closed")
}

fn missing() -> HostError {
    HostError::new(
        "NOT_FOUND",
        "Browser file handoff does not belong to this connection",
    )
}

fn storage() -> HostError {
    HostError::new("STORAGE_UNAVAILABLE", "Browser file staging is unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Seek, SeekFrom};

    fn directory() -> tempfile::TempDir {
        tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
    }

    fn target() -> Target {
        let session = Id::try_from("session").unwrap();
        Target {
            host_id: Id::try_from("host").unwrap(),
            kind: ResourceKind::try_from("session").unwrap(),
            id: session.clone(),
            session_id: Some(session),
            session_epoch: Some(1.into()),
        }
    }

    fn bytes(input: &[u8]) -> Bytes {
        Bytes::try_from(STANDARD.encode(input).as_str()).unwrap()
    }

    #[test]
    fn writer_keeps_the_exact_sealed_bytes_and_releases_the_reservation_on_discard() {
        let root = directory();
        let budget = BrowserFileBudget::new();
        let slot = BrowserUploadSlot::default();
        let (opened, done) = slot
            .begin(|| budget.open(&root.path().join("private"), target(), 5.into()))
            .unwrap();
        assert_eq!(opened.received_bytes.get(), 0);
        assert_eq!(
            budget.bytes.available_permits(),
            MAX_UPLOAD_BYTES as usize - 5
        );
        let mut data = vec![0, 255, 0x24];
        slot.change(&opened.upload_id, |upload| {
            upload.append(0.into(), &bytes(&data))
        })
        .unwrap();
        let last = [0x7b, 0x0a];
        slot.change(&opened.upload_id, |upload| {
            upload.append(3.into(), &bytes(&last))
        })
        .unwrap();
        data.extend(last);
        let sealed = slot.change(&opened.upload_id, Upload::seal).unwrap();
        assert_eq!(sealed.received_bytes.get(), data.len() as u64);
        assert_eq!(
            sealed.sealed_fingerprint.unwrap().as_str(),
            format!("{:x}", Sha256::digest(&data))
        );
        let mut current = slot.upload.lock().unwrap();
        let file = &mut current.as_mut().unwrap().file;
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut actual = Vec::new();
        file.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, data);
        drop(current);
        assert!(slot.discard(&opened.upload_id).unwrap());
        assert!(!slot.discard(&opened.upload_id).unwrap());
        assert!(done.is_cancelled());
        assert_eq!(budget.bytes.available_permits(), MAX_UPLOAD_BYTES as usize);
    }

    #[test]
    fn a_failed_write_and_an_idle_slot_drop_their_file_and_quota() {
        let root = directory();
        let path = root.path().join("private");
        let protected = root.path().join("existing-source");
        std::fs::write(&protected, "preserved").unwrap();
        let budget = BrowserFileBudget::new();
        let slot = BrowserUploadSlot::default();
        let (upload, finished) = slot
            .begin(|| budget.open(&path, target(), 2.into()))
            .unwrap();
        slot.upload.lock().unwrap().as_mut().unwrap().file = File::open(&protected).unwrap();
        let result = slot.change(&upload.upload_id, |writer| {
            writer.append(0.into(), &bytes(b"x"))
        });
        assert!(matches!(result, Err(error) if error.code == "STORAGE_UNAVAILABLE"));
        assert!(finished.is_cancelled());
        assert_eq!(std::fs::read(&protected).unwrap(), b"preserved");
        let (_, expired) = slot
            .begin(|| budget.open(&path, target(), MAX_UPLOAD_BYTES.into()))
            .unwrap();
        slot.upload.lock().unwrap().as_mut().unwrap().deadline = Instant::now();
        let (replacement, _) = slot
            .begin(|| budget.open(&path, target(), 1.into()))
            .unwrap();
        assert!(expired.is_cancelled());
        assert!(slot.discard(&replacement.upload_id).unwrap());
        assert_eq!(budget.slots.available_permits(), MAX_UPLOADS);
        assert_eq!(budget.bytes.available_permits(), MAX_UPLOAD_BYTES as usize);
    }

    #[test]
    fn invalid_boundaries_disk_failure_and_late_connection_writes_release_the_slot() {
        let root = directory();
        let budget = BrowserFileBudget::new();
        let path = root.path().join("private");
        std::fs::write(&path, "fixture").unwrap();
        assert!(budget.open(&path, target(), 1.into()).is_err());
        assert_eq!(budget.slots.available_permits(), MAX_UPLOADS);
        assert_eq!(std::fs::read(&path).unwrap(), b"fixture");
        std::fs::remove_file(&path).unwrap();
        assert!(budget.open(&path, target(), 0.into()).is_err());
        assert!(
            budget
                .open(&path, target(), (MAX_UPLOAD_BYTES + 1).into())
                .is_err()
        );
        let slot = BrowserUploadSlot::default();
        let (opened, done) = slot
            .begin(|| budget.open(&path, target(), MAX_UPLOAD_BYTES.into()))
            .unwrap();
        assert!(budget.open(&path, target(), 1.into()).is_err());
        assert!(
            slot.change(&opened.upload_id, |upload| upload
                .append(1.into(), &bytes(b"x")))
                .is_err()
        );
        assert!(done.is_cancelled());
        let (opened, done) = slot
            .begin(|| budget.open(&path, target(), 2.into()))
            .unwrap();
        assert!(slot.change(&opened.upload_id, Upload::seal).is_err());
        assert!(done.is_cancelled());
        let (opened, done) = slot
            .begin(|| budget.open(&path, target(), 2.into()))
            .unwrap();
        slot.close();
        assert!(
            slot.change(&opened.upload_id, |upload| upload
                .append(0.into(), &bytes(b"x")))
                .is_err()
        );
        assert!(done.is_cancelled());
        assert!(
            slot.begin(|| budget.open(&path, target(), 1.into()))
                .is_err()
        );
        assert_eq!(budget.slots.available_permits(), MAX_UPLOADS);
        assert_eq!(budget.bytes.available_permits(), MAX_UPLOAD_BYTES as usize);
    }
}
