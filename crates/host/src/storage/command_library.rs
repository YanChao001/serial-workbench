use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;

use super::{
    Store,
    db::{Database, counter},
    unavailable,
};

const PAGE_SIZE: usize = 32;

pub(super) const CREATE_COMMAND_LIBRARY: &str = "
CREATE TABLE IF NOT EXISTS command_library_versions (
    workspace TEXT PRIMARY KEY,
    revision TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS command_groups (
    workspace TEXT NOT NULL REFERENCES command_library_versions(workspace),
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY(workspace, id)
);
CREATE INDEX IF NOT EXISTS command_group_page ON command_groups(workspace, name, id);
CREATE TABLE IF NOT EXISTS command_entries (
    workspace TEXT NOT NULL,
    id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position >= 0),
    name TEXT NOT NULL,
    note TEXT NOT NULL,
    body_json TEXT NOT NULL,
    PRIMARY KEY(workspace, id),
    FOREIGN KEY(workspace, group_id) REFERENCES command_groups(workspace, id)
);
CREATE INDEX IF NOT EXISTS command_entry_page ON command_entries(workspace, group_id, position, id);
";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredBody {
    body: String,
    mode: TerminalMode,
    encoding: TextEncoding,
    line_ending: Option<LineEnding>,
}

fn store_error(error: rusqlite::Error) -> HostError {
    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull) {
        HostError::new("STORAGE_FULL", "Command library storage is full")
    } else {
        unavailable()
    }
}

fn missing() -> HostError {
    HostError::new(
        "NOT_FOUND",
        "Command or group was not found in this workspace",
    )
}

fn changed() -> HostError {
    HostError::new("REVISION_CONFLICT", "Command library revision changed")
}

impl Store {
    pub(crate) fn command_library_page(
        &self,
        workspace: Id,
        params: CommandLibraryReadParams,
    ) -> HostResult<CommandLibraryReadResult> {
        self.request(move |db| db.command_library_page(&workspace, params))
    }

    pub(crate) fn change_command_library(
        &self,
        workspace: Id,
        expected: U64,
        change: CommandLibraryChange,
        operation_id: Id,
    ) -> HostResult<CommandLibraryRevision> {
        let value = self.request(move |db| {
            db.change_command_library(&workspace, expected, change, Some(&operation_id))
        })?;
        self.publish_operation_change();
        Ok(value)
    }
}

impl Database {
    fn command_library_page(
        &self,
        workspace: &Id,
        params: CommandLibraryReadParams,
    ) -> HostResult<CommandLibraryReadResult> {
        // 一次 writer 请求内读取版本和索引，下一页必须引用同一版本。
        let conn = &self.connection;
        let revision = revision(conn, workspace)?;
        if params.revision.is_some_and(|expected| expected != revision) {
            return Err(changed());
        }
        let records = match params.selection {
            CommandLibraryView::Groups { after } => {
                require_cursor_revision(params.revision, after.as_ref())?;
                groups_page(conn, workspace, after.as_ref())?
            }
            CommandLibraryView::Commands { group_id, after } => {
                require_cursor_revision(params.revision, after.as_ref())?;
                commands_page(conn, workspace, &group_id, after.as_ref())?
            }
            CommandLibraryView::Entry { id } => CommandLibraryRecords::Entry {
                command: load_command(conn, workspace, &id)?,
            },
        };
        Ok(CommandLibraryReadResult { revision, records })
    }

    fn change_command_library(
        &mut self,
        workspace: &Id,
        expected: U64,
        change: CommandLibraryChange,
        operation_id: Option<&Id>,
    ) -> HostResult<CommandLibraryRevision> {
        change.validate()?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        if revision(&tx, workspace)? != expected {
            return Err(changed());
        }
        let revision = expected.checked_next()?;
        tx.execute(
            "INSERT INTO command_library_versions(workspace,revision) VALUES(?1,?2)
             ON CONFLICT(workspace) DO UPDATE SET revision=excluded.revision",
            params![workspace.as_str(), revision.to_string()],
        )
        .map_err(store_error)?;

        match change {
            CommandLibraryChange::SaveGroup { group } => {
                tx.execute(
                    "INSERT INTO command_groups(workspace,id,name) VALUES(?1,?2,?3)
                     ON CONFLICT(workspace,id) DO UPDATE SET name=excluded.name",
                    params![workspace.as_str(), group.id.as_str(), group.name],
                )
                .map_err(store_error)?;
            }
            CommandLibraryChange::DeleteGroup { id } => {
                group_name(&tx, workspace, &id)?;
                let occupied: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM command_entries WHERE workspace=?1 AND group_id=?2)",
                    params![workspace.as_str(), id.as_str()],
                    |row| row.get(0),
                ).map_err(store_error)?;
                if occupied {
                    return Err(HostError::new(
                        "GROUP_NOT_EMPTY",
                        "Move commands out of this group before deleting it",
                    ));
                }
                tx.execute(
                    "DELETE FROM command_groups WHERE workspace=?1 AND id=?2",
                    params![workspace.as_str(), id.as_str()],
                )
                .map_err(store_error)?;
            }
            CommandLibraryChange::SaveCommand { command } => {
                save_command(&tx, workspace, command)?;
            }
            CommandLibraryChange::MoveCommand {
                id,
                group_id,
                before,
            } => {
                move_command(&tx, workspace, &id, &group_id, before.as_ref())?;
            }
            CommandLibraryChange::DeleteCommand { id } => {
                let (group, position) =
                    command_position(&tx, workspace, &id)?.ok_or_else(missing)?;
                tx.execute(
                    "DELETE FROM command_entries WHERE workspace=?1 AND id=?2",
                    params![workspace.as_str(), id.as_str()],
                )
                .map_err(store_error)?;
                close_position(&tx, workspace, &group, position)?;
            }
        }

        let result = CommandLibraryRevision { revision };
        if let Some(id) = operation_id {
            super::operations::record_result_evidence_in(
                &tx,
                id,
                ActionResult::CommandLibraryRevision(result.clone()),
            )?;
        }
        tx.commit().map_err(store_error)?;
        Ok(result)
    }
}

fn revision(conn: &Connection, workspace: &Id) -> HostResult<U64> {
    let current: Option<String> = conn
        .query_row(
            "SELECT revision FROM command_library_versions WHERE workspace=?1",
            [workspace.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(store_error)?;
    Ok(current
        .as_deref()
        .map(counter)
        .transpose()?
        .unwrap_or(U64::from(0)))
}

fn require_cursor_revision(revision: Option<U64>, cursor: Option<&Id>) -> HostResult<()> {
    if cursor.is_some() && revision.is_none() {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "A page cursor requires its library revision",
        ));
    }
    Ok(())
}

fn group_name(conn: &Connection, workspace: &Id, id: &Id) -> HostResult<String> {
    conn.query_row(
        "SELECT name FROM command_groups WHERE workspace=?1 AND id=?2",
        params![workspace.as_str(), id.as_str()],
        |row| row.get(0),
    )
    .optional()
    .map_err(store_error)?
    .ok_or_else(missing)
}

fn groups_page(
    conn: &Connection,
    workspace: &Id,
    after: Option<&Id>,
) -> HostResult<CommandLibraryRecords> {
    let anchor = after
        .map(|id| group_name(conn, workspace, id))
        .transpose()?
        .unwrap_or_default();
    let mut statement = conn
        .prepare(
            "SELECT id,name FROM command_groups WHERE workspace=?1 AND (name,id)>(?2,?3)
         ORDER BY name,id LIMIT ?4",
        )
        .map_err(store_error)?;
    let rows = statement
        .query_map(
            params![
                workspace.as_str(),
                anchor,
                after.map_or("", Id::as_str),
                PAGE_SIZE as i64 + 1
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get(1)?)),
        )
        .map_err(store_error)?;
    let mut groups: Vec<CommandGroup> = rows
        .map(|row| {
            let (id, name) = row.map_err(store_error)?;
            Ok(CommandGroup {
                id: Id::try_from(id.as_str()).map_err(|_| unavailable())?,
                name,
            })
        })
        .collect::<HostResult<_>>()?;
    let has_more = groups.len() > PAGE_SIZE;
    groups.truncate(PAGE_SIZE);
    let next_cursor = has_more.then(|| groups.last().expect("full group page").id.clone());
    Ok(CommandLibraryRecords::Groups {
        groups,
        next_cursor,
    })
}

fn commands_page(
    conn: &Connection,
    workspace: &Id,
    group: &Id,
    after: Option<&Id>,
) -> HostResult<CommandLibraryRecords> {
    group_name(conn, workspace, group)?;
    let anchor = after
        .map(|id| position_in_group(conn, workspace, group, id))
        .transpose()?
        .unwrap_or(-1);
    let mut statement = conn
        .prepare(
            "SELECT id,name,note FROM command_entries WHERE workspace=?1 AND group_id=?2
         AND position>?3 ORDER BY position,id LIMIT ?4",
        )
        .map_err(store_error)?;
    let rows = statement
        .query_map(
            params![
                workspace.as_str(),
                group.as_str(),
                anchor,
                PAGE_SIZE as i64 + 1
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(store_error)?;
    let mut commands: Vec<CommandSummary> = rows
        .map(|row| {
            let (id, name, note) = row.map_err(store_error)?;
            Ok(CommandSummary {
                id: Id::try_from(id.as_str()).map_err(|_| unavailable())?,
                group_id: group.clone(),
                name,
                note,
            })
        })
        .collect::<HostResult<_>>()?;
    let has_more = commands.len() > PAGE_SIZE;
    commands.truncate(PAGE_SIZE);
    let next_cursor = has_more.then(|| commands.last().expect("full command page").id.clone());
    Ok(CommandLibraryRecords::Commands {
        commands,
        next_cursor,
    })
}

fn load_command(conn: &Connection, workspace: &Id, id: &Id) -> HostResult<CommandDraft> {
    let (group, name, note, data): (String, String, String, String) = conn
        .query_row(
            "SELECT group_id,name,note,body_json FROM command_entries WHERE workspace=?1 AND id=?2",
            params![workspace.as_str(), id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(store_error)?
        .ok_or_else(missing)?;
    let payload: StoredBody = serde_json::from_str(&data).map_err(|_| unavailable())?;
    Ok(CommandDraft {
        summary: CommandSummary {
            id: id.clone(),
            group_id: Id::try_from(group.as_str()).map_err(|_| unavailable())?,
            name,
            note,
        },
        body: payload.body,
        mode: payload.mode,
        encoding: payload.encoding,
        line_ending: payload.line_ending,
    })
}

fn command_position(
    conn: &Connection,
    workspace: &Id,
    id: &Id,
) -> HostResult<Option<(String, i64)>> {
    conn.query_row(
        "SELECT group_id,position FROM command_entries WHERE workspace=?1 AND id=?2",
        params![workspace.as_str(), id.as_str()],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(store_error)
}

fn position_in_group(conn: &Connection, workspace: &Id, group: &Id, id: &Id) -> HostResult<i64> {
    let (current, position) = command_position(conn, workspace, id)?.ok_or_else(missing)?;
    if current != group.as_str() {
        return Err(missing());
    }
    Ok(position)
}

fn next_position(conn: &Connection, workspace: &Id, group: &Id) -> HostResult<i64> {
    let last: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position),-1) FROM command_entries WHERE workspace=?1 AND group_id=?2",
        params![workspace.as_str(), group.as_str()],
        |row| row.get(0),
    ).map_err(store_error)?;
    last.checked_add(1)
        .ok_or_else(|| HostError::new("COUNTER_EXHAUSTED", "Command order counter exhausted"))
}

fn close_position(conn: &Connection, workspace: &Id, group: &str, position: i64) -> HostResult<()> {
    conn.execute(
        "UPDATE command_entries SET position=position-1 WHERE workspace=?1 AND group_id=?2 AND position>?3",
        params![workspace.as_str(), group, position],
    ).map_err(store_error)?;
    Ok(())
}

fn save_command(conn: &Connection, workspace: &Id, command: CommandDraft) -> HostResult<()> {
    let summary = command.summary;
    group_name(conn, workspace, &summary.group_id)?;
    let position = if let Some((group, position)) = command_position(conn, workspace, &summary.id)?
    {
        if group != summary.group_id.as_str() {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Move the command before changing its group",
            ));
        }
        load_command(conn, workspace, &summary.id)?;
        position
    } else {
        next_position(conn, workspace, &summary.group_id)?
    };
    let body_json = serde_json::to_string(&StoredBody {
        body: command.body,
        mode: command.mode,
        encoding: command.encoding,
        line_ending: command.line_ending,
    })
    .map_err(|_| unavailable())?;
    conn.execute(
        "INSERT INTO command_entries(workspace,id,group_id,position,name,note,body_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(workspace,id)
         DO UPDATE SET name=excluded.name,note=excluded.note,body_json=excluded.body_json",
        params![
            workspace.as_str(),
            summary.id.as_str(),
            summary.group_id.as_str(),
            position,
            summary.name,
            summary.note,
            body_json
        ],
    )
    .map_err(store_error)?;
    Ok(())
}

fn move_command(
    conn: &Connection,
    workspace: &Id,
    id: &Id,
    group: &Id,
    before: Option<&Id>,
) -> HostResult<()> {
    let (from_group, old) = command_position(conn, workspace, id)?.ok_or_else(missing)?;
    group_name(conn, workspace, group)?;
    let mut target = match before {
        Some(anchor) => position_in_group(conn, workspace, group, anchor)?,
        None => next_position(conn, workspace, group)?,
    };
    if from_group == group.as_str() {
        if old < target {
            target -= 1;
            conn.execute(
                "UPDATE command_entries SET position=position-1
                 WHERE workspace=?1 AND group_id=?2 AND position>?3 AND position<=?4",
                params![workspace.as_str(), group.as_str(), old, target],
            )
            .map_err(store_error)?;
        } else if old > target {
            conn.execute(
                "UPDATE command_entries SET position=position+1
                 WHERE workspace=?1 AND group_id=?2 AND position>=?3 AND position<?4",
                params![workspace.as_str(), group.as_str(), target, old],
            )
            .map_err(store_error)?;
        }
    } else {
        close_position(conn, workspace, &from_group, old)?;
        conn.execute(
            "UPDATE command_entries SET position=position+1
             WHERE workspace=?1 AND group_id=?2 AND position>=?3",
            params![workspace.as_str(), group.as_str(), target],
        )
        .map_err(store_error)?;
    }
    conn.execute(
        "UPDATE command_entries SET group_id=?3,position=?4 WHERE workspace=?1 AND id=?2",
        params![workspace.as_str(), id.as_str(), group.as_str(), target],
    )
    .map_err(store_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::SystemClock;
    use std::sync::Arc;

    fn key(value: &str) -> Id {
        Id::try_from(value).unwrap()
    }

    fn open(dir: &tempfile::TempDir) -> Database {
        Database::open(
            &dir.path().join("state.sqlite3"),
            Arc::new(SystemClock::new().unwrap()),
        )
        .unwrap()
    }

    fn group(id: &str, name: &str) -> CommandLibraryChange {
        CommandLibraryChange::SaveGroup {
            group: CommandGroup {
                id: key(id),
                name: name.into(),
            },
        }
    }

    fn command(id: &str, group: &str, body: &str) -> CommandLibraryChange {
        CommandLibraryChange::SaveCommand {
            command: CommandDraft {
                summary: CommandSummary {
                    id: key(id),
                    group_id: key(group),
                    name: id.into(),
                    note: "bench note".into(),
                },
                body: body.into(),
                mode: TerminalMode::Text,
                encoding: TextEncoding::Utf8,
                line_ending: Some(LineEnding::Cr {}),
            },
        }
    }

    fn apply(db: &mut Database, library: &Id, revision: u64, change: CommandLibraryChange) {
        assert_eq!(
            db.change_command_library(library, revision.into(), change, None)
                .unwrap()
                .revision,
            (revision + 1).into(),
        );
    }

    fn page(
        db: &Database,
        workspace: &Id,
        group: &str,
        frame: Option<(&Id, u64)>,
    ) -> HostResult<CommandLibraryReadResult> {
        db.command_library_page(
            workspace,
            CommandLibraryReadParams {
                selection: CommandLibraryView::Commands {
                    group_id: key(group),
                    after: frame.map(|(cursor, _)| cursor.clone()),
                },
                revision: frame.map(|(_, value)| value.into()),
            },
        )
    }

    fn entry(db: &Database, workspace: &Id, id: &str) -> CommandDraft {
        let result = db
            .command_library_page(
                workspace,
                CommandLibraryReadParams {
                    selection: CommandLibraryView::Entry { id: key(id) },
                    revision: None,
                },
            )
            .unwrap();
        let CommandLibraryRecords::Entry { command } = result.records else {
            panic!("Expected command")
        };
        command
    }

    #[test]
    fn command_directory_pages_and_moves_by_stable_id_across_pages_and_groups() {
        let root = tempfile::tempdir().unwrap();
        let mut db = open(&root);
        let bench = key("bench");
        let other = key("other");
        apply(&mut db, &bench, 0, group("a", "A"));
        apply(&mut db, &bench, 1, group("b", "B"));
        for index in 0..34 {
            apply(
                &mut db,
                &bench,
                index + 2,
                command(&format!("cmd-{index:02}"), "a", "AT+VALUE=${value}"),
            );
        }
        apply(&mut db, &other, 0, group("a", "Unrelated"));
        apply(&mut db, &other, 1, command("cmd-33", "a", "other"));
        let result = page(&db, &bench, "a", None).unwrap();
        assert_eq!(result.revision, 36.into());
        let CommandLibraryRecords::Commands {
            commands,
            next_cursor,
        } = result.records
        else {
            panic!("Expected command page")
        };
        assert_eq!(commands.len(), PAGE_SIZE);
        assert!(
            serde_json::to_value(&commands[0])
                .unwrap()
                .get("body")
                .is_none()
        );
        let cursor = next_cursor.unwrap();
        let second = page(&db, &bench, "a", Some((&cursor, 36))).unwrap();
        let CommandLibraryRecords::Commands {
            commands,
            next_cursor,
        } = second.records
        else {
            panic!("Expected next page")
        };
        assert_eq!(
            commands
                .iter()
                .map(|command| command.id.as_str())
                .collect::<Vec<_>>(),
            ["cmd-32", "cmd-33"]
        );
        assert!(next_cursor.is_none());

        apply(
            &mut db,
            &bench,
            36,
            CommandLibraryChange::MoveCommand {
                id: key("cmd-33"),
                group_id: key("a"),
                before: Some(key("cmd-01")),
            },
        );
        assert_eq!(
            page(&db, &bench, "a", Some((&cursor, 36)))
                .unwrap_err()
                .code,
            "REVISION_CONFLICT"
        );
        let first = page(&db, &bench, "a", None).unwrap();
        let CommandLibraryRecords::Commands { commands, .. } = first.records else {
            panic!("Expected reordered page")
        };
        assert_eq!(commands[1].id, key("cmd-33"));
        apply(
            &mut db,
            &bench,
            37,
            CommandLibraryChange::MoveCommand {
                id: key("cmd-33"),
                group_id: key("b"),
                before: None,
            },
        );
        assert_eq!(entry(&db, &bench, "cmd-33").summary.group_id, key("b"));
        assert_eq!(entry(&db, &other, "cmd-33").body, "other");
        drop(db);
        let db = open(&root);
        let persisted = entry(&db, &bench, "cmd-33");
        assert_eq!(persisted.body, "AT+VALUE=${value}");
        assert_eq!(persisted.line_ending, Some(LineEnding::Cr {}));
    }

    #[test]
    fn command_storage_full_and_missing_operation_receipt_preserve_prior_body_and_revision() {
        let root = tempfile::tempdir().unwrap();
        let mut db = open(&root);
        let bench = key("bench");
        apply(&mut db, &bench, 0, group("a", "A"));
        apply(&mut db, &bench, 1, command("known", "a", "prior"));

        assert!(
            db.change_command_library(
                &bench,
                2.into(),
                command("known", "a", "discard"),
                Some(&key("absent-operation"))
            )
            .is_err()
        );
        assert_eq!(entry(&db, &bench, "known").body, "prior");
        assert_eq!(revision(&db.connection, &bench).unwrap(), 2.into());

        let pages: i64 = db
            .connection
            .pragma_query_value(None, "page_count", |row| row.get(0))
            .unwrap();
        db.connection
            .pragma_update(None, "max_page_count", pages)
            .unwrap();
        let error = db
            .change_command_library(
                &bench,
                2.into(),
                command("known", "a", &"X".repeat(65_536)),
                None,
            )
            .unwrap_err();
        assert_eq!(error.code, "STORAGE_FULL");
        assert_eq!(entry(&db, &bench, "known").body, "prior");
        assert_eq!(revision(&db.connection, &bench).unwrap(), 2.into());
    }

    #[test]
    fn additive_command_tables_open_existing_workspace_state_without_increasing_its_format_version()
    {
        let root = tempfile::tempdir().unwrap();
        let mut db = open(&root);
        db.compare_and_swap_document(&key("untouched"), 0.into(), Default::default())
            .unwrap();
        db.connection.execute_batch("DROP TABLE command_entries; DROP TABLE command_groups; DROP TABLE command_library_versions;").unwrap();
        drop(db);
        let mut db = open(&root);
        assert_eq!(
            db.read_document(&key("untouched"))
                .unwrap()
                .unwrap()
                .revision,
            1.into()
        );
        let version: i64 = db
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 1);
        apply(&mut db, &key("legacy"), 0, group("a", "A"));
    }
}
