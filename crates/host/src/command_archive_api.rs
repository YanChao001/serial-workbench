use super::{DocumentService, decode, invalid, unavailable};
use crate::{
    auth::AuthenticatedActor,
    files::{FileService, FixedFile, references::PendingFile},
    storage::StagedCommandArchive,
    workspace::WorkspaceService,
};
use serial_workbench_core::*;
use std::io::{self, BufReader, BufWriter, Read};

impl DocumentService {
    pub(super) fn import_command_archive(
        &self,
        files: &FileService,
        actor: &AuthenticatedActor,
        call: &Call,
        operation_id: &Id,
    ) -> HostResult<CommandLibraryRevision> {
        let expected = call.expected_revision.ok_or_else(invalid)?;
        let params: CommandLibraryFileParams = decode(&call.params)?;
        let source = files.authorization_target(&params.file_ref, actor, "content.read")?;
        let grants = self.auth.snapshot(actor)?.capture_bound_grants(&[
            ("content.read", &source),
            ("workspace.modify", &call.target),
        ])?;
        self.require_archive_revision(call, expected)?;
        let file = files.open_fixed(&params.file_ref, actor)?;
        let mut input =
            BufReader::with_capacity(FixedFile::MAX_CHUNK_BYTES, ArchiveInput { file, offset: 0 });
        let archive = StagedCommandArchive::read(&mut input)?;

        let reference = Self::reference(&call.target)?;
        let lock = self.document_lock(&reference)?;
        let _document = lock.lock().map_err(|_| unavailable())?;
        WorkspaceService::new(self.store.clone(), call.target.id.clone()).ensure_editable()?;
        self.auth.commit_grant_stamp(&grants, || {
            self.require_archive_epoch(call)?;
            input.get_ref().file.check()?;
            self.store.import_command_archive(
                call.target.id.clone(),
                expected,
                archive,
                operation_id.clone(),
            )
        })
    }

    pub(super) fn export_command_archive(
        &self,
        files: &FileService,
        actor: &AuthenticatedActor,
        call: &Call,
    ) -> HostResult<ObjectRef> {
        let expected = call.expected_revision.ok_or_else(invalid)?;
        let params: CommandLibraryFileParams = decode(&call.params)?;
        let target = files.authorization_target(&params.file_ref, actor, "workspace.modify")?;
        let grants = self.auth.snapshot(actor)?.capture_bound_grants(&[
            ("content.read", &call.target),
            ("workspace.modify", &target),
        ])?;
        self.require_archive_revision(call, expected)?;
        let destination = files.resolve(&params.file_ref, actor, true)?;
        let mut output = PendingFile::new(&destination, "command-library")?;
        self.store.export_command_archive(
            &call.target.id,
            expected,
            BufWriter::new(output.file()),
            || self.auth.validate_grants(&grants),
        )?;
        output.publish(&destination, |temporary, destination| {
            let publish =
                files.prepare_file_publication(&params.file_ref, temporary, destination, actor)?;
            self.auth.commit_grant_stamp(&grants, || {
                self.require_archive_epoch(call)?;
                self.require_archive_revision(call, expected)?;
                files.require_reference(&params.file_ref, actor, "workspace.modify")?;
                publish()
            })
        })
    }

    fn require_archive_revision(&self, call: &Call, expected: U64) -> HostResult<()> {
        if self
            .store
            .command_library_revision(call.target.id.clone())?
            != expected
        {
            return Err(HostError::new(
                "REVISION_CONFLICT",
                "Command library revision changed",
            ));
        }
        Ok(())
    }

    fn require_archive_epoch(&self, call: &Call) -> HostResult<()> {
        if self.store.identity()?.instance_epoch != call.instance_epoch {
            return Err(HostError::new("EPOCH_MISMATCH", "Host instance changed"));
        }
        Ok(())
    }
}

struct ArchiveInput {
    file: FixedFile,
    offset: u64,
}

impl Read for ArchiveInput {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let count = (output.len().min(FixedFile::MAX_CHUNK_BYTES) as u64)
            .min(self.file.len() - self.offset) as usize;
        if count == 0 {
            return Ok(0);
        }
        let data = self
            .file
            .read_chunk(self.offset, count)
            .map_err(io::Error::other)?;
        output[..count].copy_from_slice(&data);
        self.offset += count as u64;
        Ok(count)
    }
}
