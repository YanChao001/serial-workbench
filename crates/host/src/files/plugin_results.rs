//! 逻辑结果是不可变资源；原任务的当前读取权限不依赖插件是否仍启用。
use super::*;
use base64::Engine as _;
use sha2::Digest as _;
impl FileService {
    pub(super) fn plugin_result_authority(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<Option<Target>> {
        let Some(id) = crate::storage::plugin_result_operation(reference)? else {
            return Ok(None);
        };
        if reference.host_id != self.identity.host_id
            || reference.revision.is_some_and(|value| value != 1.into())
        {
            return Err(changed());
        }
        if !matches!(permission, "metadata.read" | "content.read") {
            return Err(denied());
        }
        let (operation, _) = self.store.retained_operation(&id)?;
        if operation.action_id.as_str() == crate::node_packages::TRUSTED_SCRIPT_ACTION
            && &operation.actor_id != actor.id()
        {
            return Err(denied());
        }
        self.auth.require(actor, permission, &operation.target)?;
        self.store.plugin_operation(&id)?;
        let Some(ActionResult::Reference(result)) = &operation.result else {
            return Err(HostError::new(
                "NOT_FOUND",
                "Plugin result is not committed",
            ));
        };
        if result.result_ref.kind != reference.kind
            || result.result_ref.id != reference.id
            || result.result_ref.host_id != reference.host_id
        {
            return Err(changed());
        }
        Ok(Some(operation.target))
    }
    pub(super) fn read_plugin_result(
        &self,
        params: &FileReadParams,
        actor: &AuthenticatedActor,
    ) -> HostResult<Option<FileReadResult>> {
        let Some(authority) =
            self.plugin_result_authority(&params.file_ref, actor, "content.read")?
        else {
            return Ok(None);
        };
        let document = self.store.plugin_result(&params.file_ref.id)?;
        let bytes = STANDARD
            .decode(document.bytes_base64.as_str())
            .map_err(|_| changed())?;
        if bytes.len() as u64 != document.length.get()
            || Digest::try_from(format!("{:x}", Sha256::digest(&bytes)).as_str())?
                != document.fingerprint
        {
            return Err(changed());
        }
        if params.offset.get() > document.length.get() {
            return Err(invalid());
        }
        let start = params.offset.get() as usize;
        let end = (start + params.max_bytes.get() as usize).min(bytes.len());
        let encoded = Bytes::try_from(STANDARD.encode(&bytes[start..end]).as_str())?;
        self.auth.require(actor, "content.read", &authority)?;
        Ok(Some(FileReadResult {
            file_ref: ObjectRef {
                revision: Some(1.into()),
                ..params.file_ref.clone()
            },
            offset: params.offset,
            next_offset: (end as u64).into(),
            total_bytes: document.length,
            bytes_base64: encoded,
            fingerprint: document.fingerprint,
            at_end: end == bytes.len(),
        }))
    }
    pub(super) fn plugin_result_metadata(
        &self,
        reference: &ObjectRef,
        actor: &AuthenticatedActor,
        permission: &str,
    ) -> HostResult<Option<FileMetadata>> {
        let Some(authority) = self.plugin_result_authority(reference, actor, permission)? else {
            return Ok(None);
        };
        let document = self.store.plugin_result(&reference.id)?;
        self.auth.require(actor, permission, &authority)?;
        Ok(Some(FileMetadata {
            file_ref: ObjectRef {
                revision: Some(1.into()),
                ..reference.clone()
            },
            purpose: FilePurpose::ReadFile,
            length: document.length,
            fingerprint: document.fingerprint,
        }))
    }
}
