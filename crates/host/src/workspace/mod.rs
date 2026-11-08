use crate::{
    settings::{export_document, import_document, read_document, save_document},
    storage::Store,
};
use serial_workbench_core::{HostResult, Id, U64, WorkspaceDocument, WorkspaceSnapshot};
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub struct WorkspaceService {
    store: Store,
    id: Id,
}
impl WorkspaceService {
    pub fn new(store: Store, id: Id) -> Self {
        let digest = Sha256::digest(id.as_str().as_bytes());
        let id = Id::try_from(format!("workspace:{digest:x}").as_str()).expect("workspace id");
        Self { store, id }
    }
    pub fn read(&self) -> HostResult<WorkspaceSnapshot> {
        let (revision, value) = read_document(&self.store, &self.id)?;
        let value: WorkspaceDocument = value;
        value.validate()?;
        Ok(WorkspaceSnapshot { revision, value })
    }
    pub fn save(
        &self,
        expected_revision: U64,
        value: WorkspaceDocument,
    ) -> HostResult<WorkspaceSnapshot> {
        self.read()?;
        value.validate()?;
        let (revision, value) = save_document(&self.store, &self.id, expected_revision, value)?;
        Ok(WorkspaceSnapshot { revision, value })
    }
    pub fn export_json(&self) -> HostResult<String> {
        export_document(&self.read()?.value)
    }
    pub fn import_json(&self, expected_revision: U64, json: &str) -> HostResult<WorkspaceSnapshot> {
        self.save(expected_revision, import_document(json)?)
    }
}
