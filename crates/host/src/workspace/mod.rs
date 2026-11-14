use crate::{
    settings::{encode, export_document, import_document, read_document},
    storage::Store,
};
use serial_workbench_core::{HostResult, Id, U64, WorkspaceDocument, WorkspaceSnapshot};
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub struct WorkspaceService {
    store: Store,
    id: Id,
    workspace_id: Id,
}
impl WorkspaceService {
    pub fn new(store: Store, id: Id) -> Self {
        let workspace_id = id.clone();
        let digest = Sha256::digest(id.as_str().as_bytes());
        let id = Id::try_from(format!("workspace:{digest:x}").as_str()).expect("workspace id");
        Self {
            store,
            id,
            workspace_id,
        }
    }
    pub fn read(&self) -> HostResult<WorkspaceSnapshot> {
        let (revision, value) = read_document(&self.store, &self.id)?;
        let value: WorkspaceDocument = value;
        value.validate()?;
        if revision != U64::from(0) && !value.archived {
            self.store
                .register_workspace(&self.id, &self.workspace_id)?;
        }
        Ok(WorkspaceSnapshot { revision, value })
    }
    pub fn save(
        &self,
        expected_revision: U64,
        value: WorkspaceDocument,
    ) -> HostResult<WorkspaceSnapshot> {
        if self.read()?.value.archived {
            return Err(serial_workbench_core::HostError::new(
                "WORKSPACE_DELETED",
                "Workspace was removed",
            ));
        }
        if value.archived && self.workspace_id.as_str() == "default" {
            return Err(serial_workbench_core::HostError::new(
                "INVALID_ARGUMENT",
                "Default workspace cannot be removed",
            ));
        }
        value.validate()?;
        let (json, value) = encode(value)?;
        let saved = self.store.compare_and_swap_workspace(
            &self.id,
            expected_revision,
            json,
            &self.workspace_id,
        )?;
        Ok(WorkspaceSnapshot {
            revision: saved.revision,
            value,
        })
    }
    pub fn export_json(&self) -> HostResult<String> {
        let mut value = self.read()?.value;
        value.archived = false;
        export_document(&value)
    }
    pub fn import_json(&self, expected_revision: U64, json: &str) -> HostResult<WorkspaceSnapshot> {
        let mut value: WorkspaceDocument = import_document(json)?;
        value.archived = false;
        self.save(expected_revision, value)
    }
}
