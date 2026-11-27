use crate::{
    settings::{encode, export_document, import_document, read_document},
    storage::{StagedCommandArchive, Store, WorkspaceConfigurationCommit},
};
use serde::{Deserialize, Serialize};
use serial_workbench_core::{
    HostError, HostResult, Id, U64, WorkspaceConfiguration, WorkspaceCredentialReference,
    WorkspaceDocument, WorkspaceDocumentResult, WorkspaceScriptReference, WorkspaceSnapshot,
};
use sha2::{Digest, Sha256};
#[derive(Clone)]
pub struct WorkspaceService {
    store: Store,
    id: Id,
    workspace_id: Id,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConfigurationReferences {
    pub(crate) scripts: Vec<WorkspaceScriptReference>,
    pub(crate) credentials: Vec<WorkspaceCredentialReference>,
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
        let snapshot = self.snapshot()?;
        if snapshot.revision != U64::from(0) && !snapshot.value.archived {
            self.store
                .register_workspace(&self.id, &self.workspace_id)?;
        }
        Ok(snapshot)
    }
    pub(crate) fn snapshot(&self) -> HostResult<WorkspaceSnapshot> {
        let (revision, value) = read_document(&self.store, &self.id)?;
        let value: WorkspaceDocument = value;
        value.validate()?;
        Ok(WorkspaceSnapshot { revision, value })
    }
    pub(crate) fn ensure_editable(&self) -> HostResult<()> {
        if self.read()?.value.archived {
            return Err(serial_workbench_core::HostError::new(
                "WORKSPACE_DELETED",
                "Workspace was removed",
            ));
        }
        Ok(())
    }
    pub fn save(
        &self,
        expected_revision: U64,
        value: WorkspaceDocument,
    ) -> HostResult<WorkspaceSnapshot> {
        self.ensure_editable()?;
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
    pub(crate) fn prepare_configuration(
        &self,
        expected_workspace_revision: U64,
        expected_command_revision: Option<U64>,
        configuration: WorkspaceConfiguration,
        document: WorkspaceDocumentResult,
        operation_id: Id,
    ) -> HostResult<WorkspaceConfigurationCommit> {
        let commands = match expected_command_revision {
            Some(expected) if !configuration.groups.is_empty() => Some((
                expected,
                StagedCommandArchive::from_configuration(
                    configuration.groups,
                    configuration.commands,
                )?,
            )),
            None if configuration.groups.is_empty() => None,
            _ => {
                return Err(HostError::new(
                    "INVALID_ARGUMENT",
                    "Expected command library revision does not match the configuration",
                ));
            }
        };
        let references_document_id = self.references_document_id();
        let (expected_references_revision, _) = self.configuration_references()?;
        let (references, _) = encode(ConfigurationReferences {
            scripts: configuration.scripts,
            credentials: configuration.credential_refs,
        })?;
        Ok(WorkspaceConfigurationCommit {
            workspace_document_id: self.id.clone(),
            references_document_id,
            expected_workspace_revision,
            expected_references_revision,
            document,
            references,
            commands,
            operation_id,
        })
    }

    fn references_document_id(&self) -> Id {
        Id::try_from(format!("{}:configuration", self.id).as_str()).expect("reference document ID")
    }

    pub(crate) fn configuration_references(&self) -> HostResult<(U64, ConfigurationReferences)> {
        read_document(&self.store, &self.references_document_id())
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
