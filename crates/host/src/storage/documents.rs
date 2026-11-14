use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serial_workbench_core::{HostError, HostResult, Id, JsonObject, U64};

use super::{
    db::{Database, counter},
    unavailable,
};

#[derive(Debug, Clone, PartialEq)]
pub struct StoredDocument {
    pub revision: U64,
    pub value: JsonObject,
}

impl Database {
    pub fn read_document(&self, id: &Id) -> HostResult<Option<StoredDocument>> {
        let row: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT revision,value_json FROM documents WHERE id=?1",
                [id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| unavailable())?;
        row.map(|(revision, json)| {
            Ok(StoredDocument {
                revision: counter(&revision)?,
                value: serde_json::from_str(&json).map_err(|_| unavailable())?,
            })
        })
        .transpose()
    }

    pub fn compare_and_swap_document(
        &mut self,
        id: &Id,
        expected: U64,
        value: JsonObject,
    ) -> HostResult<StoredDocument> {
        self.save_document(id, expected, value, None)
    }
    pub fn compare_and_swap_workspace(
        &mut self,
        id: &Id,
        expected: U64,
        value: JsonObject,
        workspace_id: &Id,
    ) -> HostResult<StoredDocument> {
        self.save_document(id, expected, value, Some(workspace_id))
    }
    fn save_document(
        &mut self,
        id: &Id,
        expected: U64,
        value: JsonObject,
        workspace_id: Option<&Id>,
    ) -> HostResult<StoredDocument> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let previous: Option<String> = transaction
            .query_row(
                "SELECT revision FROM documents WHERE id=?1",
                [id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unavailable())?;
        let current = previous
            .as_deref()
            .map(counter)
            .transpose()?
            .unwrap_or(U64::from(0));
        if current != expected {
            return Err(HostError::new(
                "REVISION_CONFLICT",
                "Document revision changed",
            ));
        }
        let revision = current.checked_next()?;
        let json = serde_json::to_string(&value).map_err(|_| unavailable())?;
        transaction.execute("INSERT INTO documents(id,revision,value_json) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json", params![id.as_str(), revision.to_string(), json]).map_err(|_| unavailable())?;
        if let Some(workspace_id) = workspace_id {
            let archived = matches!(value.get("value"),Some(serial_workbench_core::JsonValue::Object(document)) if document.get("archived") == Some(&serial_workbench_core::JsonValue::Bool(true)));
            if archived {
                transaction
                    .execute(
                        "DELETE FROM workspace_directory WHERE workspace_id=?1 AND document_id=?2",
                        params![workspace_id.as_str(), id.as_str()],
                    )
                    .map_err(|_| unavailable())?;
            } else {
                transaction.execute("INSERT INTO workspace_directory(workspace_id,document_id) VALUES(?1,?2) ON CONFLICT(workspace_id) DO UPDATE SET document_id=excluded.document_id", params![workspace_id.as_str(), id.as_str()]).map_err(|_| unavailable())?;
            }
        }
        transaction.commit().map_err(|_| unavailable())?;
        Ok(StoredDocument { revision, value })
    }
    pub fn register_workspace(&self, id: &Id, workspace_id: &Id) -> HostResult<()> {
        // 仅登记已经成功读取的持久文档，不让探测未知标识产生空工作区。
        self.connection.execute("INSERT INTO workspace_directory(workspace_id,document_id) SELECT ?1,id FROM documents WHERE id=?2 ON CONFLICT(workspace_id) DO NOTHING", params![workspace_id.as_str(), id.as_str()]).map_err(|_| unavailable())?;
        Ok(())
    }
    pub fn workspace_page(&self, after: Option<&Id>) -> HostResult<Vec<(Id, Id, U64, String)>> {
        // 用不可逆的文档键分页，翻页游标不暴露被权限过滤的工作区标识。
        let mut statement = self.connection.prepare("SELECT w.document_id,w.workspace_id,d.revision,json_extract(d.value_json,'$.value.name') FROM workspace_directory w JOIN documents d ON d.id=w.document_id WHERE w.document_id>?1 ORDER BY w.document_id LIMIT 64").map_err(|_| unavailable())?;
        let rows = statement
            .query_map([after.map_or("", Id::as_str)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|_| unavailable())?;
        rows.map(|row| {
            let (cursor, id, revision, name) = row.map_err(|_| unavailable())?;
            Ok((
                Id::try_from(cursor.as_str()).map_err(|_| unavailable())?,
                Id::try_from(id.as_str()).map_err(|_| unavailable())?,
                counter(&revision)?,
                name.unwrap_or_default(),
            ))
        })
        .collect()
    }
}

#[cfg(test)]
mod workspace_directory_tests {
    use super::*;
    use crate::{storage::Store, workspace::WorkspaceService};
    use serial_workbench_core::WorkspaceDocument;
    fn id(value: &str) -> Id {
        Id::try_from(value).unwrap()
    }

    #[test]
    fn saved_directory_survives_restart_and_conflicts_do_not_replace_names() {
        let directory = tempfile::tempdir().unwrap();
        {
            let store = Store::open(directory.path()).unwrap();
            let service = WorkspaceService::new(store.clone(), id("bench"));
            service
                .save(
                    0.into(),
                    WorkspaceDocument {
                        name: "Saved bench".into(),
                        ..Default::default()
                    },
                )
                .unwrap();
            assert_eq!(
                service
                    .save(
                        0.into(),
                        WorkspaceDocument {
                            name: "Stale name".into(),
                            ..Default::default()
                        }
                    )
                    .unwrap_err()
                    .code,
                "REVISION_CONFLICT"
            );
            WorkspaceService::new(store.clone(), id("never-saved"))
                .read()
                .unwrap();
        }
        let store = Store::open(directory.path()).unwrap();
        let page = store.workspace_page(None).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].1, id("bench"));
        assert_eq!(page[0].2, U64::from(1));
        assert_eq!(page[0].3, "Saved bench");
    }

    #[test]
    fn removing_a_workspace_hides_the_directory_but_retains_originals_and_blocks_late_saves() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let service = WorkspaceService::new(store.clone(), id("removed"));
        let original = service
            .save(
                0.into(),
                WorkspaceDocument {
                    name: "Original layout".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        let removed = service
            .save(
                original.revision,
                WorkspaceDocument {
                    archived: true,
                    ..original.value.clone()
                },
            )
            .unwrap();
        assert!(store.workspace_page(None).unwrap().is_empty());
        let retained = service.read().unwrap();
        assert_eq!(retained, removed);
        assert_eq!(retained.value.name, "Original layout");
        assert!(store.workspace_page(None).unwrap().is_empty());
        assert_eq!(
            service
                .save(original.revision, original.value)
                .unwrap_err()
                .code,
            "WORKSPACE_DELETED"
        );
        assert_eq!(
            service
                .save(removed.revision, WorkspaceDocument::default())
                .unwrap_err()
                .code,
            "WORKSPACE_DELETED"
        );
        assert_eq!(
            WorkspaceService::new(store, id("default"))
                .save(
                    0.into(),
                    WorkspaceDocument {
                        archived: true,
                        ..Default::default()
                    }
                )
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
    }
    #[test]
    fn directory_pages_do_not_repeat_or_drop_entries() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        for index in 0..67 {
            WorkspaceService::new(store.clone(), id(&format!("bench-{index}")))
                .save(0.into(), WorkspaceDocument::default())
                .unwrap();
        }
        let first = store.workspace_page(None).unwrap();
        assert_eq!(first.len(), 64);
        let second = store
            .workspace_page(Some(first.last().unwrap().0.clone()))
            .unwrap();
        assert_eq!(second.len(), 3);
        let ids: std::collections::HashSet<_> =
            first.iter().chain(&second).map(|item| &item.1).collect();
        assert_eq!(ids.len(), 67);
    }
}
