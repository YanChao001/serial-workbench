#[cfg(windows)]
use std::fs::OpenOptions;
// 位置授权与捕获资源分离；私有 parentRef 只复用现有授权，不自动授予内容读取。
use crate::transmission::file_transfer::ReceiptJournalManifest;
use crate::{
    auth::{AuthService, AuthenticatedActor, HostIdentity},
    storage::Store,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
const BLOCK: usize = 16384;
const MAX_FILE: u64 = 1024 * 1024 * 1024;
const PROOF_BUDGET: u64 = 8 * 1024 * 1024;
const PROOF_ENTRIES: usize = 64;
type ReadProofs = Arc<Mutex<VecDeque<(ObjectRef, Arc<ReadProof>)>>>;
#[derive(Clone)]
pub struct FileService {
    store: Store,
    auth: AuthService,
    identity: HostIdentity,
    read_bytes: Arc<AtomicU64>,
    proofs: ReadProofs,
    proof_bytes: Arc<AtomicU64>,
}
struct ProofLease {
    bytes: u64,
    used: Arc<AtomicU64>,
}
impl Drop for ProofLease {
    fn drop(&mut self) {
        self.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
struct ReadProof {
    identity: String,
    length: u64,
    digest: Digest,
    stamp: ChangeStamp,
    blocks: Vec<[u8; 32]>,
    _lease: Option<ProofLease>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct ChangeStamp {
    modified: i128,
    changed: i128,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileBinding {
    client_id: Id,
    parent_ref: Option<ObjectRef>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileDocument {
    format_version: String,
    path: PathBuf,
    purpose: FilePurpose,
    fingerprint: Digest,
    identity: String,
    parent_identity: String,
    length: U64,
    content_revision: U64,
    live: bool,
    capture_id: Option<Id>,
    owner_operation_id: Option<Id>,
    bindings: Vec<FileBinding>,
}
pub struct FixedFile {
    file: File,
    path: PathBuf,
    identity: String,
    length: u64,
    digest: Digest,
    proof: Arc<ReadProof>,
    service: FileService,
    reference: ObjectRef,
    actor: AuthenticatedActor,
    _guard: PathGuard,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordDocument {
    format_version: String,
    source_ref: ObjectRef,
    authority: Target,
    record_ordinal: U64,
    fingerprint: Digest,
    bytes_base64: Bytes,
}
fn digest_bytes(bytes: &[u8]) -> HostResult<Digest> {
    Digest::try_from(format!("{:x}", Sha256::digest(bytes)).as_str())
}
impl FileService {
    /// Actual bytes read from registered files by this Host service and its clones.
    pub fn file_read_bytes(&self) -> u64 {
        self.read_bytes.load(Ordering::Relaxed)
    }
    pub fn read(
        &self,
        params: FileReadParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<FileReadResult> {
        if params.max_bytes.get() == 0 || params.max_bytes.get() > 65536 {
            return Err(invalid());
        }
        let (bytes, total, fingerprint) = if params.file_ref.kind.as_str() == "capture_record" {
            let document = self.record_document(&params.file_ref, actor, "content.read")?;
            let raw = STANDARD
                .decode(document.bytes_base64.as_str())
                .map_err(|_| invalid())?;
            if raw.len() > crate::capture::format::MAX_RECORD
                || digest_bytes(&raw)? != document.fingerprint
            {
                return Err(changed());
            }
            if params.offset.get() > raw.len() as u64 {
                return Err(invalid());
            }
            let start = params.offset.get() as usize;
            let end = (start + params.max_bytes.get() as usize).min(raw.len());
            (
                raw[start..end].to_vec(),
                raw.len() as u64,
                document.fingerprint,
            )
        } else {
            let mut file = self.open_fixed(&params.file_ref, actor)?;
            if params.offset.get() > file.len() {
                return Err(invalid());
            }
            let length = (file.len() - params.offset.get()).min(params.max_bytes.get()) as usize;
            let mut bytes = Vec::with_capacity(length);
            while bytes.len() < length {
                let chunk = file.read_chunk(
                    params.offset.get() + bytes.len() as u64,
                    (length - bytes.len()).min(BLOCK),
                )?;
                bytes.extend_from_slice(&chunk);
            }
            (bytes, file.len(), file.digest.clone())
        };
        self.require_reference(&params.file_ref, actor, "content.read")?;
        let next = params.offset.get() + bytes.len() as u64;
        Ok(FileReadResult {
            file_ref: params.file_ref,
            offset: params.offset,
            next_offset: next.into(),
            total_bytes: total.into(),
            bytes_base64: Bytes::try_from(STANDARD.encode(bytes).as_str())?,
            fingerprint,
            at_end: next == total,
        })
    }
    fn receipts_manifest(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<ReceiptJournalManifest> {
        if reference.host_id != self.identity.host_id
            || reference.kind.as_str() != "transfer_receipts"
        {
            return Err(invalid());
        }
        let key = Id::try_from(format!("transfer-receipts-{}", reference.id).as_str())?;
        let saved = self
            .store
            .read_document(&key)?
            .ok_or_else(|| HostError::new("NOT_FOUND", "Receipt journal was not found"))?;
        let manifest: ReceiptJournalManifest =
            serde_json::from_value(serde_json::to_value(saved.value).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        if manifest.format_version != "0.1" {
            return Err(HostError::new(
                "FUTURE_FORMAT",
                "Receipt journal format is unsupported",
            ));
        }
        if reference
            .revision
            .is_some_and(|revision| revision.get() != 1 || !manifest.sealed)
        {
            return Err(revision_changed());
        }
        self.auth
            .require(actor, "content.read", &manifest.authority)?;
        Ok(manifest)
    }
    pub fn authorize_receipts(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<()> {
        self.receipts_manifest(reference, actor).map(|_| ())
    }
    pub fn read_receipts(
        &self,
        params: FileTransferReceiptsParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<FileTransferReceiptsResult> {
        if params.max_receipts.get() == 0
            || params.max_receipts.get() > 256
            || params.max_bytes.get() == 0
            || params.max_bytes.get() > 256 * 1024
        {
            return Err(invalid());
        }
        let manifest = self.receipts_manifest(&params.receipts_ref, actor)?;
        if params.start_ordinal > manifest.count {
            return Err(invalid());
        }
        let mut reference = params.receipts_ref.clone();
        reference.revision = manifest.sealed.then_some(1.into());
        let mut result = FileTransferReceiptsResult {
            receipts_ref: reference,
            count: manifest.count,
            receipts: vec![],
            next_ordinal: params.start_ordinal,
            has_more: params.start_ordinal < manifest.count,
            sealed: manifest.sealed,
        };
        if serde_json::to_vec(&result).map_err(|_| invalid())?.len()
            > params.max_bytes.get() as usize
        {
            return Err(limit());
        }
        while result.next_ordinal < manifest.count
            && result.receipts.len() < params.max_receipts.get() as usize
        {
            let key = Id::try_from(
                format!(
                    "transfer-receipts-{}-{}",
                    params.receipts_ref.id, result.next_ordinal
                )
                .as_str(),
            )?;
            let saved = self
                .store
                .read_document(&key)?
                .ok_or_else(|| HostError::new("CORRUPT_DATA", "Committed receipt is missing"))?;
            let receipt: FileTransferReceipt =
                serde_json::from_value(serde_json::to_value(saved.value).map_err(|_| invalid())?)
                    .map_err(|_| invalid())?;
            result.receipts.push(receipt);
            result.next_ordinal = result.next_ordinal.checked_next()?;
            result.has_more = result.next_ordinal < result.count;
            if serde_json::to_vec(&result).map_err(|_| invalid())?.len()
                > params.max_bytes.get() as usize
            {
                result.receipts.pop();
                result.next_ordinal = (result.next_ordinal.get() - 1).into();
                result.has_more = true;
                if result.receipts.is_empty() {
                    return Err(limit());
                }
                break;
            }
        }
        self.auth
            .require(actor, "content.read", &manifest.authority)?;
        Ok(result)
    }
    fn record_document(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<RecordDocument> {
        if reference.host_id != self.identity.host_id
            || reference.kind.as_str() != "capture_record"
            || reference.revision != Some(1.into())
        {
            return Err(invalid());
        }
        let saved = self
            .store
            .read_document(&doc_key(&reference.id)?)?
            .ok_or_else(|| HostError::new("NOT_FOUND", "Capture record was not found"))?;
        let document: RecordDocument =
            serde_json::from_value(serde_json::to_value(saved.value).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        if document.format_version != "0.1" {
            return Err(HostError::new(
                "FUTURE_FORMAT",
                "Capture record format is unsupported",
            ));
        }
        self.auth.require(actor, permission, &document.authority)?;
        Ok(document)
    }
    pub(crate) fn publish_record(
        &self,
        source: &ObjectRef,
        actor: &AuthenticatedActor,
        ordinal: U64,
        json: &[u8],
    ) -> HostResult<ReplayRecord> {
        if json.len() > crate::capture::format::MAX_RECORD {
            return Err(limit());
        }
        let authority = self.authorization_target(source, actor, "content.read")?;
        let fingerprint = digest_bytes(json)?;
        let identity = serde_json::to_vec(&(source, &authority, ordinal, &fingerprint))
            .map_err(|_| invalid())?;
        let id = Id::try_from(format!("record-{}", digest_bytes(&identity)?).as_str())?;
        let reference = ObjectRef {
            host_id: self.identity.host_id.clone(),
            kind: ResourceKind::try_from("capture_record")?,
            id: id.clone(),
            revision: Some(1.into()),
        };
        let document = RecordDocument {
            format_version: "0.1".into(),
            source_ref: source.clone(),
            authority,
            record_ordinal: ordinal,
            fingerprint: fingerprint.clone(),
            bytes_base64: Bytes::try_from(STANDARD.encode(json).as_str())?,
        };
        if self.store.read_document(&doc_key(&id)?)?.is_none() {
            let value =
                serde_json::from_value(serde_json::to_value(&document).map_err(|_| invalid())?)
                    .map_err(|_| invalid())?;
            if let Err(error) =
                self.store
                    .compare_and_swap_document(&doc_key(&id)?, 0.into(), value)
                && error.code.as_str() != "REVISION_CONFLICT"
            {
                return Err(error);
            }
        }
        self.record_document(&reference, actor, "content.read")?;
        Ok(ReplayRecord::Reference {
            record_ref: reference,
            record_ordinal: ordinal,
            json_bytes: (json.len() as u64).into(),
            json_sha256: fingerprint,
        })
    }
    pub fn new(store: Store, auth: AuthService, identity: HostIdentity) -> Self {
        Self {
            store,
            auth,
            identity,
            read_bytes: Arc::new(AtomicU64::new(0)),
            proofs: Arc::new(Mutex::new(VecDeque::new())),
            proof_bytes: Arc::new(AtomicU64::new(0)),
        }
    }
    pub fn register(
        &self,
        params: RegisterFileParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<ObjectRef> {
        if !actor.is_user_control() {
            return Err(denied());
        }
        self.auth.require(
            actor,
            "auth.manage",
            &Target {
                host_id: self.identity.host_id.clone(),
                kind: ResourceKind::try_from("host")?,
                id: self.identity.host_id.clone(),
                session_id: None,
                session_epoch: None,
            },
        )?;
        let path = selected_path(Path::new(&params.path))?;
        validate_path(&path, params.purpose == FilePurpose::CaptureTarget)?;
        let guard = PathGuard::new(&path)?;
        let parent_identity = directory_identity(path.parent().ok_or_else(invalid)?)?;
        let (identity, length, fingerprint) = if params.purpose == FilePurpose::ReadFile {
            let mut file = open_regular(&path)?;
            let length = file.metadata().map_err(io_error)?.len();
            if length > MAX_FILE {
                return Err(limit());
            }
            (
                file_identity(&file)?,
                length,
                hash_reader(&mut file, &self.read_bytes)?.0,
            )
        } else if path.exists() {
            if !fs::metadata(&path).map_err(io_error)?.is_dir() {
                return Err(invalid());
            }
            if params.purpose == FilePurpose::CaptureSource {
                // Identify a container without rejecting a damaged recoverable prefix.
                guard.child("manifest.json")?.open_file()?;
            }
            (
                directory_identity(&path)?,
                0,
                crate::capture::format::fingerprint(&path)?,
            )
        } else {
            (String::new(), 0, zero_digest())
        };
        let document = FileDocument {
            format_version: "0.1".into(),
            path: guard.checked_path().to_path_buf(),
            purpose: params.purpose,
            fingerprint,
            identity,
            parent_identity,
            length: length.into(),
            content_revision: 1.into(),
            live: false,
            capture_id: None,
            owner_operation_id: None,
            bindings: vec![FileBinding {
                client_id: actor.client_id().clone(),
                parent_ref: None,
            }],
        };
        let id = Id::try_from(format!("file-{}", uuid::Uuid::new_v4()).as_str())?;
        self.save(&id, 0.into(), &document)?;
        Ok(ObjectRef {
            host_id: self.identity.host_id.clone(),
            kind: ResourceKind::try_from("file")?,
            id,
            revision: Some(1.into()),
        })
    }
    fn load(&self, reference: &ObjectRef) -> HostResult<(U64, FileDocument)> {
        let (revision, document) = self.load_registration(reference)?;
        if reference
            .revision
            .is_some_and(|revision| revision != document.content_revision || document.live)
            || reference.revision.is_none() && document.capture_id.is_none()
        {
            return Err(revision_changed());
        }
        Ok((revision, document))
    }
    fn load_registration(&self, reference: &ObjectRef) -> HostResult<(U64, FileDocument)> {
        if reference.host_id != self.identity.host_id
            || !["file", "capture"].contains(&reference.kind.as_str())
        {
            return Err(invalid());
        }
        let saved = self
            .store
            .read_document(&doc_key(&reference.id)?)?
            .ok_or_else(|| HostError::new("NOT_FOUND", "File reference was not found"))?;
        let document: FileDocument =
            serde_json::from_value(serde_json::to_value(saved.value).map_err(|_| invalid())?)
                .map_err(|_| invalid())?;
        if document.format_version != "0.1" {
            return Err(HostError::new(
                "FUTURE_FORMAT",
                "File reference format is unsupported",
            ));
        }
        if reference.kind.as_str()
            != if document.capture_id.is_some() {
                "capture"
            } else {
                "file"
            }
        {
            return Err(invalid());
        }
        Ok((saved.revision, document))
    }
    fn save(&self, id: &Id, expected: U64, document: &FileDocument) -> HostResult<()> {
        let value = serde_json::from_value(serde_json::to_value(document).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
        self.store
            .compare_and_swap_document(&doc_key(id)?, expected, value)?;
        Ok(())
    }
    /// 统一 dispatcher 可在入队和执行时调用；返回授权对象，不返回路径。
    pub fn authorization_target(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<Target> {
        self.reference_authority(reference, actor, permission, true)
    }
    /// 历史操作只读取已保存事实；原授权仍检查当前 grants，内容修订只约束实际内容读取。
    pub(crate) fn require_inspection_reference(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<()> {
        if !matches!(permission, "content.read" | "metadata.read") {
            return Err(denied());
        }
        self.reference_authority(reference, actor, permission, false)
            .map(|_| ())
    }
    fn reference_authority(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
        fixed_content: bool,
    ) -> HostResult<Target> {
        if reference.kind.as_str() == "capture_record" {
            return Ok(self
                .record_document(reference, actor, permission)?
                .authority);
        }
        let load = |reference: &ObjectRef| {
            if fixed_content {
                self.load(reference)
            } else {
                self.load_registration(reference)
            }
        };
        let (_, document) = load(reference)?;
        let reading = matches!(permission, "content.read" | "metadata.read");
        for binding in document
            .bindings
            .iter()
            .filter(|b| reading || b.client_id == *actor.client_id())
        {
            let authority = if let Some(parent) = &binding.parent_ref {
                let (_, parent_document) = load(parent)?;
                if parent_document.capture_id.is_some()
                    || parent_document.purpose != FilePurpose::CaptureTarget
                    || !parent_document.bindings.iter().any(|b| {
                        (reading || b.client_id == *actor.client_id()) && b.parent_ref.is_none()
                    })
                {
                    continue;
                }
                target(parent)
            } else {
                target(reference)
            };
            if self.auth.require(actor, permission, &authority).is_ok() {
                return Ok(authority);
            }
        }
        Err(denied())
    }
    pub fn require_reference(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<()> {
        self.authorization_target(reference, actor, permission)
            .map(|_| ())
    }
    fn document(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<FileDocument> {
        self.require_reference(reference, actor, permission)?;
        Ok(self.load(reference)?.1)
    }
    pub fn metadata(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<FileMetadata> {
        let d = self.document(reference, actor, "metadata.read")?;
        let mut result = reference.clone();
        result.revision = if d.live {
            None
        } else {
            Some(d.content_revision)
        };
        Ok(FileMetadata {
            file_ref: result,
            purpose: d.purpose,
            length: d.length,
            fingerprint: d.fingerprint,
        })
    }
    /// 内容查询沿现有修订与授权规则获取本次真实引用，不要求 metadata.read。
    pub(crate) fn current_reference(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<ObjectRef> {
        let document = self.document(reference, actor, "content.read")?;
        let mut current = reference.clone();
        current.revision = if document.live {
            None
        } else {
            Some(document.content_revision)
        };
        Ok(current)
    }
    pub(crate) fn resolve(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        write: bool,
    ) -> HostResult<PathGuard> {
        self.resolve_authorized(
            reference,
            actor,
            if write {
                "workspace.modify"
            } else {
                "content.read"
            },
        )
    }
    pub(crate) fn resolve_metadata(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<PathGuard> {
        self.resolve_authorized(reference, actor, "metadata.read")
    }
    fn resolve_authorized(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<PathGuard> {
        let d = self.document(reference, actor, permission)?;
        let write = permission == "workspace.modify";
        if write && d.purpose != FilePurpose::CaptureTarget && d.capture_id.is_none() {
            return Err(denied());
        }
        let guard = PathGuard::new(&d.path)?;
        if guard.parent_identity()? != d.parent_identity {
            return Err(changed());
        }
        if let Some(capture_id) = &d.capture_id {
            if manifest_id(&d.path)? != *capture_id {
                return Err(revision_changed());
            }
            if guard.directory_identity()? != d.identity {
                return Err(changed());
            }
            if reference.revision.is_some()
                && crate::capture::format::fingerprint(&d.path)? != d.fingerprint
            {
                return Err(changed());
            }
        } else if d.purpose == FilePurpose::CaptureSource
            && crate::capture::format::fingerprint(&d.path)? != d.fingerprint
        {
            return Err(changed());
        }
        Ok(guard)
    }
    pub(crate) fn begin_capture(
        &self,
        location: &ObjectRef,
        path: &Path,
        capture_id: &Id,
        actor: &AuthenticatedActor,
        append: bool,
        owner_operation_id: Option<Id>,
    ) -> HostResult<ObjectRef> {
        let parent = self.document(location, actor, "workspace.modify")?;
        if parent.purpose != FilePurpose::CaptureTarget
            || parent.capture_id.is_some()
            || path.parent() != parent.path.parent()
        {
            return Err(denied());
        }
        if manifest_id(path)? != *capture_id {
            return Err(changed());
        }
        let key = doc_key(capture_id)?;
        let existing = self.store.read_document(&key)?;
        let (stored_revision, mut document) = if let Some(saved) = existing {
            let mut doc: FileDocument =
                serde_json::from_value(serde_json::to_value(saved.value).map_err(|_| invalid())?)
                    .map_err(|_| invalid())?;
            if !append
                || doc.capture_id.as_ref() != Some(capture_id)
                || doc.path != path
                || doc.live
            {
                return Err(revision_changed());
            }
            doc.content_revision = doc.content_revision.checked_next()?;
            (saved.revision, doc)
        } else {
            (
                0.into(),
                FileDocument {
                    format_version: "0.1".into(),
                    path: path.to_path_buf(),
                    purpose: FilePurpose::CaptureSource,
                    fingerprint: zero_digest(),
                    identity: directory_identity(path)?,
                    parent_identity: directory_identity(path.parent().ok_or_else(invalid)?)?,
                    length: 0.into(),
                    content_revision: 1.into(),
                    live: true,
                    capture_id: Some(capture_id.clone()),
                    owner_operation_id: None,
                    bindings: vec![],
                },
            )
        };
        if !document
            .bindings
            .iter()
            .any(|b| b.client_id == *actor.client_id() && b.parent_ref.as_ref() == Some(location))
        {
            if document.bindings.len() >= 64 {
                return Err(limit());
            }
            document.bindings.push(FileBinding {
                client_id: actor.client_id().clone(),
                parent_ref: Some(location.clone()),
            });
        }
        document.live = true;
        document.owner_operation_id = owner_operation_id;
        document.fingerprint = zero_digest();
        self.save(capture_id, stored_revision, &document)?;
        Ok(ObjectRef {
            host_id: self.identity.host_id.clone(),
            kind: ResourceKind::try_from("capture")?,
            id: capture_id.clone(),
            revision: None,
        })
    }
    pub(crate) fn publish_capture(
        &self,
        reference: &ObjectRef,
        path: &Path,
        fingerprint: &Digest,
        actor: &AuthenticatedActor,
    ) -> HostResult<ObjectRef> {
        self.require_reference(reference, actor, "workspace.modify")?;
        let (revision, mut doc) = self.load(reference)?;
        if doc.capture_id.as_ref() != Some(&manifest_id(path)?)
            || crate::capture::format::fingerprint(path)? != *fingerprint
        {
            return Err(changed());
        }
        doc.path = path.to_path_buf();
        doc.identity = directory_identity(path)?;
        doc.parent_identity = directory_identity(path.parent().ok_or_else(invalid)?)?;
        doc.fingerprint = fingerprint.clone();
        doc.live = false;
        self.save(&reference.id, revision, &doc)?;
        Ok(ObjectRef {
            revision: Some(doc.content_revision),
            ..reference.clone()
        })
    }
    pub(crate) fn capture_owner(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<Option<Id>> {
        let document = self.document(reference, actor, "metadata.read")?;
        if document.purpose != FilePurpose::CaptureSource {
            return Err(invalid());
        }
        Ok(document.owner_operation_id)
    }
    pub fn open_fixed(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
    ) -> HostResult<FixedFile> {
        let d = self.document(reference, actor, "content.read")?;
        if d.purpose != FilePurpose::ReadFile {
            return Err(invalid());
        }
        let guard = self.resolve(reference, actor, false)?;
        let mut file = open_regular(&d.path)?;
        if file_identity(&file)? != d.identity
            || file.metadata().map_err(io_error)?.len() != d.length.get()
        {
            return Err(changed());
        }
        let stamp = change_stamp(&file)?;
        let cached = {
            let mut proofs = self
                .proofs
                .lock()
                .map_err(|_| io_error(std::io::Error::other("proof lock")))?;
            let found = proofs.iter().position(|(key, proof)| {
                key == reference
                    && proof.identity == d.identity
                    && proof.length == d.length.get()
                    && proof.digest == d.fingerprint
                    && proof.stamp == stamp
            });
            found.map(|index| {
                let item = proofs.remove(index).expect("existing proof");
                let proof = item.1.clone();
                proofs.push_back(item);
                proof
            })
        };
        let proof = if let Some(proof) = cached {
            proof
        } else {
            let proof_size = d.length.get().div_ceil(BLOCK as u64) * 32;
            let lease = self.reserve_proof(proof_size)?;
            let (digest, blocks) = hash_reader(&mut file, &self.read_bytes)?;
            if digest != d.fingerprint
                || change_stamp(&file)? != stamp
                || file_identity(&file)? != d.identity
                || file.metadata().map_err(io_error)?.len() != d.length.get()
            {
                return Err(changed());
            }
            let cacheable = lease.is_some();
            let proof = Arc::new(ReadProof {
                identity: d.identity.clone(),
                length: d.length.get(),
                digest,
                stamp,
                blocks,
                _lease: lease,
            });
            if cacheable {
                let mut proofs = self
                    .proofs
                    .lock()
                    .map_err(|_| io_error(std::io::Error::other("proof lock")))?;
                proofs.retain(|(key, _)| key != reference);
                while proofs.len() >= PROOF_ENTRIES {
                    proofs.pop_front();
                }
                proofs.push_back((reference.clone(), proof.clone()));
            }
            proof
        };
        self.require_reference(reference, actor, "content.read")?;
        if change_stamp(&file)? != proof.stamp {
            return Err(changed());
        }
        Ok(FixedFile {
            file,
            path: d.path,
            identity: d.identity,
            length: d.length.get(),
            digest: proof.digest.clone(),
            proof,
            service: self.clone(),
            reference: reference.clone(),
            actor: actor.clone(),
            _guard: guard,
        })
    }
    fn reserve_proof(&self, bytes: u64) -> HostResult<Option<ProofLease>> {
        if bytes > PROOF_BUDGET {
            return Ok(None);
        }
        let mut proofs = self
            .proofs
            .lock()
            .map_err(|_| io_error(std::io::Error::other("proof lock")))?;
        loop {
            if self
                .proof_bytes
                .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                    used.checked_add(bytes)
                        .filter(|total| *total <= PROOF_BUDGET)
                })
                .is_ok()
            {
                return Ok(Some(ProofLease {
                    bytes,
                    used: self.proof_bytes.clone(),
                }));
            }
            if proofs.pop_front().is_none() {
                return Ok(None);
            }
        }
    }
    pub(crate) fn publish_file(
        &self,
        location: &ObjectRef,
        path: &Path,
        actor: &AuthenticatedActor,
    ) -> HostResult<ObjectRef> {
        let parent = self.document(location, actor, "workspace.modify")?;
        if parent.purpose != FilePurpose::CaptureTarget || path != parent.path {
            return Err(denied());
        }
        let mut file = open_regular(path)?;
        let document = FileDocument {
            format_version: "0.1".into(),
            path: path.to_path_buf(),
            purpose: FilePurpose::ReadFile,
            fingerprint: hash_reader(&mut file, &self.read_bytes)?.0,
            identity: file_identity(&file)?,
            parent_identity: directory_identity(path.parent().ok_or_else(invalid)?)?,
            length: file.metadata().map_err(io_error)?.len().into(),
            content_revision: 1.into(),
            live: false,
            capture_id: None,
            owner_operation_id: None,
            bindings: vec![FileBinding {
                client_id: actor.client_id().clone(),
                parent_ref: Some(location.clone()),
            }],
        };
        let id = Id::try_from(format!("file-{}", uuid::Uuid::new_v4()).as_str())?;
        self.save(&id, 0.into(), &document)?;
        Ok(ObjectRef {
            host_id: self.identity.host_id.clone(),
            kind: ResourceKind::try_from("file")?,
            id,
            revision: Some(1.into()),
        })
    }
}
fn manifest_id(path: &Path) -> HostResult<Id> {
    let value: serde_json::Value = crate::capture::format::read_json(&path.join("manifest.json"))?;
    if value.get("formatVersion").and_then(|v| v.as_str()) != Some("0.1") {
        return Err(HostError::new(
            "FUTURE_FORMAT",
            "Capture format is unsupported",
        ));
    }
    Id::try_from(
        value
            .get("captureId")
            .and_then(|v| v.as_str())
            .ok_or_else(invalid)?,
    )
}
fn revision_changed() -> HostError {
    HostError::new("REVISION_CONFLICT", "Capture content revision changed")
}
impl FixedFile {
    pub fn len(&self) -> u64 {
        self.length
    }
    pub fn is_empty(&self) -> bool {
        self.length == 0
    }
    fn check(&self) -> HostResult<()> {
        self.service
            .document(&self.reference, &self.actor, "content.read")?;
        if self.file.metadata().map_err(io_error)?.len() != self.length
            || file_identity(&self.file)? != self.identity
            || file_identity(&open_regular(&self.path)?)? != self.identity
            || change_stamp(&self.file)? != self.proof.stamp
        {
            return Err(changed());
        }
        Ok(())
    }
    pub fn validate_revision(&mut self) -> HostResult<()> {
        self.check()?;
        if hash_reader(&mut self.file, &self.service.read_bytes)?.0 != self.digest {
            return Err(changed());
        }
        self.check()
    }
    pub fn read_chunk(&mut self, offset: u64, length: usize) -> HostResult<Vec<u8>> {
        if length > BLOCK
            || offset
                .checked_add(length as u64)
                .is_none_or(|end| end > self.length)
        {
            return Err(invalid());
        }
        self.check()?;
        let mut out = Vec::with_capacity(length);
        if length == 0 {
            return Ok(out);
        }
        let end = offset + length as u64;
        for block in offset / BLOCK as u64..=(end - 1) / BLOCK as u64 {
            let start = block * BLOCK as u64;
            let size = (self.length - start).min(BLOCK as u64) as usize;
            let mut bytes = vec![0; size];
            self.file.seek(SeekFrom::Start(start)).map_err(io_error)?;
            self.file.read_exact(&mut bytes).map_err(|_| changed())?;
            self.service
                .read_bytes
                .fetch_add(size as u64, Ordering::Relaxed);
            let hash: [u8; 32] = Sha256::digest(&bytes).into();
            if self.proof.blocks.get(block as usize) != Some(&hash) {
                return Err(changed());
            }
            let from = offset.saturating_sub(start) as usize;
            let to = (end - start).min(size as u64) as usize;
            out.extend_from_slice(&bytes[from..to]);
        }
        self.check()?;
        Ok(out)
    }
}
fn hash_reader(file: &mut File, read_bytes: &AtomicU64) -> HostResult<(Digest, Vec<[u8; 32]>)> {
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let initial_length = file.metadata().map_err(io_error)?.len();
    if initial_length > MAX_FILE {
        return Err(limit());
    }
    let mut hash = Sha256::new();
    let mut blocks = Vec::with_capacity(initial_length.div_ceil(BLOCK as u64) as usize);
    let mut total = 0u64;
    loop {
        let mut bytes = vec![0; BLOCK];
        let mut n = 0;
        while n < BLOCK {
            let read = file.read(&mut bytes[n..]).map_err(io_error)?;
            read_bytes.fetch_add(read as u64, Ordering::Relaxed);
            if read == 0 {
                break;
            }
            n += read;
        }
        if n == 0 {
            break;
        }
        total = total.checked_add(n as u64).ok_or_else(limit)?;
        if total > MAX_FILE {
            return Err(limit());
        }
        if total > initial_length {
            return Err(changed());
        }
        hash.update(&bytes[..n]);
        blocks.push(Sha256::digest(&bytes[..n]).into());
    }
    Ok((
        Digest::try_from(format!("{:x}", hash.finalize()).as_str())?,
        blocks,
    ))
}
fn change_stamp(file: &File) -> HostResult<ChangeStamp> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().map_err(io_error)?;
        Ok(ChangeStamp {
            modified: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
            changed: i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandleEx,
        };
        let mut info: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                (&mut info as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok(ChangeStamp {
            modified: i128::from(info.LastWriteTime),
            changed: i128::from(info.ChangeTime),
        })
    }
}
pub(crate) fn target(reference: &ObjectRef) -> Target {
    Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    }
}
fn doc_key(id: &Id) -> HostResult<Id> {
    Id::try_from(format!("ref:{id}").as_str())
}
pub(crate) fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid file reference request")
}
fn denied() -> HostError {
    HostError::new("PERMISSION_DENIED", "File access is not authorized")
}
pub(crate) fn changed() -> HostError {
    HostError::new("SOURCE_CHANGED", "File identity or contents changed")
}
pub(crate) fn io_error(_: std::io::Error) -> HostError {
    HostError::new("CAPTURE_IO_FAILED", "File operation failed")
}
fn limit() -> HostError {
    HostError::new("LIMIT_EXCEEDED", "File read budget exhausted")
}
fn zero_digest() -> Digest {
    Digest::try_from("0000000000000000000000000000000000000000000000000000000000000000")
        .expect("zero digest")
}
pub(crate) fn validate_path(path: &Path, allow_missing: bool) -> HostResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        current.push(part);
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(invalid());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(invalid());
                    }
                }
            }
            Err(e)
                if allow_missing && current == path && e.kind() == std::io::ErrorKind::NotFound => {
            }
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(())
}
/// 只有可信选择入口解析初始父目录别名；持久引用之后使用固定物理路径。
fn selected_path(path: &Path) -> HostResult<PathBuf> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid());
    }
    let parent = fs::canonicalize(path.parent().ok_or_else(invalid)?).map_err(io_error)?;
    Ok(parent.join(path.file_name().ok_or_else(invalid)?))
}
pub(crate) fn open_regular(path: &Path) -> HostResult<File> {
    validate_path(path, false)?;
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .custom_flags(0x00200000)
            .open(path)
            .map_err(io_error)?
    };
    #[cfg(unix)]
    let file = {
        use std::os::fd::{AsRawFd, FromRawFd};
        let (parent, name) = open_parent(path)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        unsafe { File::from_raw_fd(fd) }
    };
    if !file.metadata().map_err(io_error)?.is_file() {
        return Err(invalid());
    }
    Ok(file)
}
#[cfg(windows)]
pub(crate) fn create_regular(path: &Path) -> HostResult<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .custom_flags(0x00200000)
            .open(path)
            .map_err(crate::capture::format::no_clobber)
    }
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        let (parent, name) = open_parent(path)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(crate::capture::format::no_clobber(
                std::io::Error::last_os_error(),
            ));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
#[cfg(windows)]
pub(crate) fn create_directory(path: &Path) -> HostResult<()> {
    #[cfg(windows)]
    {
        fs::create_dir(path).map_err(crate::capture::format::no_clobber)
    }
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let (parent, name) = open_parent(path)?;
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(crate::capture::format::no_clobber(
                std::io::Error::last_os_error(),
            ));
        }
        Ok(())
    }
}
pub(crate) fn open_directory(path: &Path) -> HostResult<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000 | 0x00200000)
            .share_mode(1 | 2)
            .open(path)
            .map_err(io_error)?;
        use std::os::windows::fs::MetadataExt;
        let meta = file.metadata().map_err(io_error)?;
        if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
        Ok(file)
    }
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        if !path.is_absolute() {
            return Err(invalid());
        }
        let mut directory = File::open("/").map_err(io_error)?;
        for component in path.components() {
            match component {
                Component::RootDir => {}
                Component::Normal(name) => {
                    let name = std::ffi::CString::new(name.as_bytes()).map_err(|_| invalid())?;
                    let fd = unsafe {
                        libc::openat(
                            directory.as_raw_fd(),
                            name.as_ptr(),
                            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        )
                    };
                    if fd < 0 {
                        return Err(io_error(std::io::Error::last_os_error()));
                    }
                    directory = unsafe { File::from_raw_fd(fd) };
                }
                _ => return Err(invalid()),
            }
        }
        Ok(directory)
    }
}
#[cfg(unix)]
pub(crate) fn open_parent(path: &Path) -> HostResult<(File, std::ffi::CString)> {
    use std::os::unix::ffi::OsStrExt;
    let directory = open_directory(path.parent().ok_or_else(invalid)?)?;
    let name = std::ffi::CString::new(path.file_name().ok_or_else(invalid)?.as_bytes())
        .map_err(|_| invalid())?;
    Ok((directory, name))
}
pub(crate) fn directory_identity(path: &Path) -> HostResult<String> {
    file_identity(&open_directory(path)?)
}
pub(crate) fn file_identity(file: &File) -> HostResult<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().map_err(io_error)?;
        Ok(format!("{}:{}", meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok(format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
}
/// Windows 持有祖先目录的非 delete-share 句柄，阻止登记到提交期间父目录替换。
pub(crate) struct PathGuard {
    path: PathBuf,
    _ancestors: Vec<File>,
    parent: File,
    directory: Option<File>,
}
impl PathGuard {
    pub(crate) fn new(path: &Path) -> HostResult<Self> {
        validate_path(path, true)?;
        let mut current = PathBuf::new();
        let mut ancestors = Vec::new();
        let pinned = path.parent().ok_or_else(invalid)?;
        for part in pinned.components() {
            current.push(part);
            if current.is_dir() {
                ancestors.push(open_directory(&current)?);
            }
        }
        validate_path(path, true)?;
        let parent = open_directory(path.parent().ok_or_else(invalid)?)?;
        let directory = if path.is_dir() {
            Some(open_guard_directory(&parent, path)?)
        } else {
            None
        };
        Ok(Self {
            path: path.to_path_buf(),
            _ancestors: ancestors,
            parent,
            directory,
        })
    }
    pub(crate) fn checked_path(&self) -> &Path {
        &self.path
    }
}

#[cfg(unix)]
fn guard_name(path: &Path) -> HostResult<std::ffi::CString> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        std::ffi::CString::new(path.file_name().ok_or_else(invalid)?.as_bytes())
            .map_err(|_| invalid())
    }
    #[cfg(windows)]
    {
        let _ = path;
        Err(invalid())
    }
}
fn open_guard_directory(parent: &File, path: &Path) -> HostResult<File> {
    #[cfg(unix)]
    {
        use std::os::fd::{AsRawFd, FromRawFd};
        let name = guard_name(path)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io_error(std::io::Error::last_os_error()));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    #[cfg(windows)]
    {
        let _ = parent;
        open_directory(path)
    }
}
impl PathGuard {
    pub(crate) fn release_directory(&mut self) {
        self.directory.take();
    }
    pub(crate) fn parent_identity(&self) -> HostResult<String> {
        file_identity(&self.parent)
    }
    pub(crate) fn directory_identity(&self) -> HostResult<String> {
        file_identity(self.directory.as_ref().ok_or_else(changed)?)
    }
    pub(crate) fn sibling(&self, name: &std::ffi::OsStr) -> HostResult<Self> {
        if Path::new(name).components().count() != 1
            || !matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err(invalid());
        }
        let path = self.path.with_file_name(name);
        Ok(Self {
            directory: None,
            path,
            parent: self.parent.try_clone().map_err(io_error)?,
            _ancestors: self
                ._ancestors
                .iter()
                .map(File::try_clone)
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(io_error)?,
        })
    }
    pub(crate) fn child(&self, name: &str) -> HostResult<Self> {
        if Path::new(name).components().count() != 1
            || !matches!(
                Path::new(name).components().next(),
                Some(Component::Normal(_))
            )
        {
            return Err(invalid());
        }
        Ok(Self {
            path: self.path.join(name),
            parent: self
                .directory
                .as_ref()
                .ok_or_else(invalid)?
                .try_clone()
                .map_err(io_error)?,
            directory: None,
            _ancestors: self
                ._ancestors
                .iter()
                .map(File::try_clone)
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(io_error)?,
        })
    }
    pub(crate) fn create_directory(&mut self) -> HostResult<()> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let name = guard_name(&self.path)?;
            if unsafe { libc::mkdirat(self.parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                return Err(crate::capture::format::no_clobber(
                    std::io::Error::last_os_error(),
                ));
            }
        }
        #[cfg(windows)]
        {
            create_directory(&self.path)?;
        }
        self.directory = Some(open_guard_directory(&self.parent, &self.path)?);
        Ok(())
    }
    pub(crate) fn create_file(&self) -> HostResult<File> {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = guard_name(&self.path)?;
            let fd = unsafe {
                libc::openat(
                    self.parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDWR
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(crate::capture::format::no_clobber(
                    std::io::Error::last_os_error(),
                ));
            }
            Ok(unsafe { File::from_raw_fd(fd) })
        }
        #[cfg(windows)]
        {
            create_regular(&self.path)
        }
    }
    fn open_file(&self) -> HostResult<File> {
        #[cfg(unix)]
        {
            use std::os::fd::{AsRawFd, FromRawFd};
            let name = guard_name(&self.path)?;
            let fd = unsafe {
                libc::openat(
                    self.parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io_error(std::io::Error::last_os_error()));
            }
            let file = unsafe { File::from_raw_fd(fd) };
            if !file.metadata().map_err(io_error)?.is_file() {
                return Err(invalid());
            }
            Ok(file)
        }
        #[cfg(windows)]
        {
            open_regular(&self.path)
        }
    }
    pub(crate) fn rename_to(&self, target: &Self, replace: bool) -> HostResult<()> {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let from = guard_name(&self.path)?;
            let to = guard_name(&target.path)?;
            let result = if replace {
                unsafe {
                    libc::renameat(
                        self.parent.as_raw_fd(),
                        from.as_ptr(),
                        target.parent.as_raw_fd(),
                        to.as_ptr(),
                    )
                }
            } else {
                #[cfg(target_os = "linux")]
                {
                    unsafe {
                        libc::renameat2(
                            self.parent.as_raw_fd(),
                            from.as_ptr(),
                            target.parent.as_raw_fd(),
                            to.as_ptr(),
                            libc::RENAME_NOREPLACE,
                        )
                    }
                }
                #[cfg(target_os = "macos")]
                {
                    unsafe {
                        libc::renameatx_np(
                            self.parent.as_raw_fd(),
                            from.as_ptr(),
                            target.parent.as_raw_fd(),
                            to.as_ptr(),
                            libc::RENAME_EXCL,
                        )
                    }
                }
            };
            if result != 0 {
                return Err(crate::capture::format::no_clobber(
                    std::io::Error::last_os_error(),
                ));
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
            };
            let from: Vec<u16> = self.path.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = target
                .path
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let flags = MOVEFILE_WRITE_THROUGH
                | if replace {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                };
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
                let error = std::io::Error::last_os_error();
                if !replace && target.path.exists() {
                    return Err(HostError::new("TARGET_EXISTS", "Target already exists"));
                }
                let os_code = error.raw_os_error();
                let mut error = crate::capture::format::no_clobber(error);
                error.message = format!("Capture rename failed (Windows OS code {os_code:?})");
                return Err(error);
            }
        }
        Ok(())
    }
    pub(crate) fn sync_parent(&self) -> HostResult<()> {
        #[cfg(unix)]
        {
            self.parent.sync_all().map_err(io_error)?;
        }
        Ok(())
    }
}
