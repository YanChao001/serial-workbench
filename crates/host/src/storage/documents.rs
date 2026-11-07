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
        transaction.commit().map_err(|_| unavailable())?;
        Ok(StoredDocument { revision, value })
    }
}
