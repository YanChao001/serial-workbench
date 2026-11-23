use super::{
    Database, Store, command_position, next_library_revision, record_library_commit, revision,
    save_command, store_error,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use std::io::{BufRead, Read, Write};

const FORMAT: &str = "serial-workbench-command-library";
const VERSION: u32 = 1;
// JSON 转义最坏将单个 ASCII 字节扩到六字节。此限制约束单条缓冲，条数由存储决定。
const MAX_RECORD_BYTES: u64 = 512 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Record {
    Header {
        format: String,
        version: u32,
        library_revision: U64,
    },
    Group {
        group: CommandGroup,
    },
    Command {
        command: CommandDraft,
    },
    End {
        groups: U64,
        commands: U64,
    },
}

pub(crate) struct StagedCommandArchive {
    staging: Connection,
}

fn invalid_archive() -> HostError {
    HostError::new(
        "INVALID_COMMAND_ARCHIVE",
        "Invalid or incomplete command library archive",
    )
}

fn archive_io(error: std::io::Error) -> HostError {
    let message = "Command library archive could not be read or written";
    match error.downcast::<HostError>() {
        Ok(error) => error,
        Err(error) if error.kind() == std::io::ErrorKind::StorageFull => {
            HostError::new("STORAGE_FULL", "Command library archive storage is full")
        }
        Err(_) => HostError::new("STORAGE_IO", message),
    }
}

fn archive_insert(error: rusqlite::Error) -> HostError {
    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::ConstraintViolation) {
        invalid_archive()
    } else {
        store_error(error)
    }
}

fn read_record(reader: &mut impl BufRead, bytes: &mut Vec<u8>) -> HostResult<Option<Record>> {
    bytes.clear();
    reader
        .take(MAX_RECORD_BYTES + 1)
        .read_until(b'\n', bytes)
        .map_err(archive_io)?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.len() as u64 > MAX_RECORD_BYTES || bytes.last() != Some(&b'\n') {
        return Err(invalid_archive());
    }
    serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|_| invalid_archive())
}

impl StagedCommandArchive {
    pub(crate) fn read(reader: &mut impl BufRead) -> HostResult<Self> {
        let mut bytes = Vec::new();
        match read_record(reader, &mut bytes)? {
            Some(Record::Header {
                format, version, ..
            }) if format == FORMAT => {
                if version > VERSION {
                    return Err(HostError::new(
                        "FUTURE_FORMAT",
                        "Unsupported command library archive version",
                    ));
                }
                if version != VERSION {
                    return Err(invalid_archive());
                }
            }
            _ => return Err(invalid_archive()),
        }
        // 空路径创建 SQLite 私有临时库。表可溢写到磁盘，随连接自动清理。
        let mut staging = Connection::open("").map_err(store_error)?;
        staging
            .execute_batch(
                "PRAGMA foreign_keys=ON;
             PRAGMA cache_size=-2048;
             CREATE TABLE groups(id TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
             CREATE TABLE commands(
               id TEXT NOT NULL UNIQUE,
               group_id TEXT NOT NULL REFERENCES groups(id),
               command_json TEXT NOT NULL
             );
             CREATE TABLE group_map(id TEXT PRIMARY KEY, destination TEXT NOT NULL);",
            )
            .map_err(store_error)?;
        let tx = staging.transaction().map_err(store_error)?;
        let mut group_count = U64::from(0);
        let mut command_count = U64::from(0);
        {
            let mut add_group = tx
                .prepare("INSERT INTO groups(id,name) VALUES(?1,?2)")
                .map_err(store_error)?;
            let mut add_command = tx
                .prepare("INSERT INTO commands(id,group_id,command_json) VALUES(?1,?2,?3)")
                .map_err(store_error)?;
            loop {
                match read_record(reader, &mut bytes)?.ok_or_else(invalid_archive)? {
                    Record::Group { group } => {
                        group.validate().map_err(|_| invalid_archive())?;
                        add_group
                            .execute(params![group.id.as_str(), group.name])
                            .map_err(archive_insert)?;
                        group_count = group_count.checked_next()?;
                    }
                    Record::Command { command } => {
                        command.validate().map_err(|_| invalid_archive())?;
                        let payload =
                            serde_json::to_string(&command).map_err(|_| invalid_archive())?;
                        add_command
                            .execute(params![
                                command.summary.id.as_str(),
                                command.summary.group_id.as_str(),
                                payload
                            ])
                            .map_err(archive_insert)?;
                        command_count = command_count.checked_next()?;
                    }
                    Record::End { groups, commands } => {
                        if groups != group_count
                            || commands != command_count
                            || !reader.fill_buf().map_err(archive_io)?.is_empty()
                        {
                            return Err(invalid_archive());
                        }
                        break;
                    }
                    Record::Header { .. } => return Err(invalid_archive()),
                }
            }
        }
        tx.commit().map_err(store_error)?;
        Ok(Self { staging })
    }
}

fn write_record(output: &mut impl Write, record: &Record) -> HostResult<()> {
    serde_json::to_writer(&mut *output, record).map_err(|error| {
        if error.is_io() {
            archive_io(std::io::Error::from(error))
        } else {
            invalid_archive()
        }
    })?;
    output.write_all(b"\n").map_err(archive_io)
}

impl Store {
    pub(crate) fn export_command_archive(
        &self,
        workspace: &Id,
        expected: U64,
        mut output: impl Write,
        mut check: impl FnMut() -> HostResult<()>,
    ) -> HostResult<()> {
        let mut group_count = U64::from(0);
        let mut command_count = U64::from(0);
        write_record(
            &mut output,
            &Record::Header {
                format: FORMAT.into(),
                version: VERSION,
                library_revision: expected,
            },
        )?;
        let mut group_cursor = None;
        loop {
            check()?;
            let groups = self.command_library_page(
                workspace.clone(),
                CommandLibraryReadParams {
                    selection: CommandLibraryView::Groups {
                        after: group_cursor,
                    },
                    revision: Some(expected),
                },
            )?;
            let CommandLibraryRecords::Groups {
                groups,
                next_cursor,
            } = groups.records
            else {
                unreachable!()
            };
            for group in groups {
                let group_id = group.id.clone();
                write_record(&mut output, &Record::Group { group })?;
                group_count = group_count.checked_next()?;
                let mut command_cursor = None;
                loop {
                    check()?;
                    let page = self.command_library_page(
                        workspace.clone(),
                        CommandLibraryReadParams {
                            selection: CommandLibraryView::Commands {
                                group_id: group_id.clone(),
                                after: command_cursor,
                            },
                            revision: Some(expected),
                        },
                    )?;
                    let CommandLibraryRecords::Commands {
                        commands,
                        next_cursor,
                    } = page.records
                    else {
                        unreachable!()
                    };
                    for summary in commands {
                        check()?;
                        let entry = self.command_library_page(
                            workspace.clone(),
                            CommandLibraryReadParams {
                                selection: CommandLibraryView::Entry { id: summary.id },
                                revision: Some(expected),
                            },
                        )?;
                        let CommandLibraryRecords::Entry { command } = entry.records else {
                            unreachable!()
                        };
                        write_record(&mut output, &Record::Command { command })?;
                        command_count = command_count.checked_next()?;
                    }
                    command_cursor = next_cursor;
                    if command_cursor.is_none() {
                        break;
                    }
                }
            }
            group_cursor = next_cursor;
            if group_cursor.is_none() {
                break;
            }
        }
        check()?;
        write_record(
            &mut output,
            &Record::End {
                groups: group_count,
                commands: command_count,
            },
        )?;
        output.flush().map_err(archive_io)
    }

    pub(crate) fn import_command_archive(
        &self,
        workspace: Id,
        expected: U64,
        archive: StagedCommandArchive,
        operation_id: Id,
    ) -> HostResult<CommandLibraryRevision> {
        let result = self.request(move |db| {
            db.import_command_archive(&workspace, expected, archive, Some(&operation_id))
        })?;
        self.publish_operation_change();
        Ok(result)
    }

    pub(crate) fn command_library_revision(&self, workspace: Id) -> HostResult<U64> {
        self.request(move |db| revision(&db.connection, &workspace))
    }
}

impl Database {
    fn import_command_archive(
        &mut self,
        workspace: &Id,
        expected: U64,
        archive: StagedCommandArchive,
        operation_id: Option<&Id>,
    ) -> HostResult<CommandLibraryRevision> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(store_error)?;
        let revision = next_library_revision(&tx, workspace, expected)?;
        let staging = archive.staging;
        {
            let mut groups = staging
                .prepare("SELECT id,name FROM groups ORDER BY rowid")
                .map_err(store_error)?;
            let mut remap_group = staging
                .prepare("INSERT INTO group_map(id,destination) VALUES(?1,?2)")
                .map_err(store_error)?;
            let mut rows = groups.query([]).map_err(store_error)?;
            while let Some(row) = rows.next().map_err(store_error)? {
                let original: String = row.get(0).map_err(store_error)?;
                let name: String = row.get(1).map_err(store_error)?;
                let target = unused_id(&original, "group", |id| {
                    let found = tx
                        .query_row(
                            "SELECT 1 FROM command_groups WHERE workspace=?1 AND id=?2",
                            params![workspace.as_str(), id.as_str()],
                            |row| row.get::<_, i64>(0),
                        )
                        .optional()
                        .map_err(store_error)?;
                    Ok(found.is_some())
                })?;
                tx.execute(
                    "INSERT INTO command_groups(workspace,id,name) VALUES(?1,?2,?3)",
                    params![workspace.as_str(), target.as_str(), name],
                )
                .map_err(store_error)?;
                remap_group
                    .execute(params![original, target.as_str()])
                    .map_err(store_error)?;
            }
        }
        {
            let mut commands = staging
                .prepare(
                    "SELECT c.command_json,m.destination FROM commands c
                 JOIN group_map m ON m.id=c.group_id ORDER BY c.rowid",
                )
                .map_err(store_error)?;
            let mut rows = commands.query([]).map_err(store_error)?;
            while let Some(row) = rows.next().map_err(store_error)? {
                let payload: String = row.get(0).map_err(store_error)?;
                let group: String = row.get(1).map_err(store_error)?;
                let mut command: CommandDraft =
                    serde_json::from_str(&payload).map_err(|_| invalid_archive())?;
                command.summary.group_id = Id::try_from(group.as_str())?;
                command.summary.id = unused_id(command.summary.id.as_str(), "command", |id| {
                    Ok(command_position(&tx, workspace, id)?.is_some())
                })?;
                save_command(&tx, workspace, command)?;
            }
        }
        record_library_commit(tx, revision, operation_id)
    }
}

fn unused_id(
    original: &str,
    prefix: &str,
    exists: impl Fn(&Id) -> HostResult<bool>,
) -> HostResult<Id> {
    let original = Id::try_from(original)?;
    if !exists(&original)? {
        return Ok(original);
    }
    loop {
        let candidate = Id::try_from(format!("{prefix}-{}", uuid::Uuid::new_v4()).as_str())?;
        if !exists(&candidate)? {
            return Ok(candidate);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn id(value: &str) -> Id {
        Id::try_from(value).unwrap()
    }

    fn make_archive(groups: usize, commands: usize, body: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_record(
            &mut bytes,
            &Record::Header {
                format: FORMAT.into(),
                version: VERSION,
                library_revision: 23.into(),
            },
        )
        .unwrap();
        for number in 0..groups {
            let key = format!("group-{number:03}");
            write_record(
                &mut bytes,
                &Record::Group {
                    group: CommandGroup {
                        id: id(&key),
                        name: key,
                    },
                },
            )
            .unwrap();
            if number == 0 {
                for entry in 0..commands {
                    write_record(
                        &mut bytes,
                        &Record::Command {
                            command: CommandDraft {
                                summary: CommandSummary {
                                    id: id(&format!("cmd-{entry:03}")),
                                    group_id: id("group-000"),
                                    name: format!("Command {entry}"),
                                    note: "preserve this note".into(),
                                },
                                body: body.into(),
                                mode: TerminalMode::Text,
                                encoding: TextEncoding::Utf8,
                                line_ending: Some(LineEnding::Lf {}),
                            },
                        },
                    )
                    .unwrap();
                }
            }
        }
        write_record(
            &mut bytes,
            &Record::End {
                groups: (groups as u64).into(),
                commands: (commands as u64).into(),
            },
        )
        .unwrap();
        bytes
    }

    #[test]
    fn command_archive_streams_multiple_group_and_command_pages_in_record_order() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let archive = make_archive(36, 68, "tested body");
        let staged = StagedCommandArchive::read(&mut Cursor::new(archive)).unwrap();
        let scope = id("bench");
        let imported = store
            .request({
                let scope = scope.clone();
                move |db| db.import_command_archive(&scope, 0.into(), staged, None)
            })
            .unwrap();
        assert_eq!(imported.revision, 1.into());
        let mut exported = Vec::new();
        store
            .export_command_archive(&scope, 1.into(), &mut exported, || Ok(()))
            .unwrap();
        let mut cursor = Cursor::new(exported.as_slice());
        let mut buffer = Vec::new();
        assert!(matches!(read_record(&mut cursor, &mut buffer).unwrap(),
            Some(Record::Header { library_revision, .. }) if library_revision == 1.into()));
        assert!(matches!(read_record(&mut cursor, &mut buffer).unwrap(),
            Some(Record::Group { group }) if group.id == id("group-000")));
        for index in 0..68 {
            assert!(matches!(read_record(&mut cursor, &mut buffer).unwrap(),
                Some(Record::Command { command }) if command.summary.id == id(&format!("cmd-{index:03}"))
                && command.body == "tested body"));
        }
        for index in 1..36 {
            assert!(matches!(read_record(&mut cursor, &mut buffer).unwrap(),
                Some(Record::Group { group }) if group.id == id(&format!("group-{index:03}"))));
        }
        assert!(matches!(read_record(&mut cursor, &mut buffer).unwrap(),
            Some(Record::End { groups, commands }) if groups == 36.into() && commands == 68.into()));
        assert!(read_record(&mut cursor, &mut buffer).unwrap().is_none());
    }

    #[test]
    fn command_archive_disk_full_and_missing_receipts_roll_back_the_library() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let scope = id("bench");
        // 先保留命令库已有的记录，再用当前页数限制模拟持久卷写满。
        let reserved =
            StagedCommandArchive::read(&mut Cursor::new(make_archive(1, 1, "original"))).unwrap();
        assert_eq!(
            store
                .request({
                    let scope = scope.clone();
                    move |db| db.import_command_archive(&scope, 0.into(), reserved, None)
                })
                .unwrap()
                .revision,
            1.into()
        );
        let before = store
            .command_library_page(
                scope.clone(),
                CommandLibraryReadParams {
                    selection: CommandLibraryView::Entry { id: id("cmd-000") },
                    revision: Some(1.into()),
                },
            )
            .unwrap();
        let full =
            StagedCommandArchive::read(&mut Cursor::new(make_archive(1, 2, &"\0".repeat(65_536))))
                .unwrap();
        let error = store
            .request({
                let scope = scope.clone();
                move |db| {
                    let pages: i64 = db
                        .connection
                        .query_row("PRAGMA page_count", [], |row| row.get(0))
                        .unwrap();
                    db.connection
                        .pragma_update(None, "max_page_count", pages)
                        .unwrap();
                    let outcome = db.import_command_archive(&scope, 1.into(), full, None);
                    db.connection
                        .pragma_update(None, "max_page_count", 2_147_483_646_i64)
                        .unwrap();
                    outcome
                }
            })
            .unwrap_err();
        assert_eq!(error.code, "STORAGE_FULL");
        let import =
            StagedCommandArchive::read(&mut Cursor::new(make_archive(1, 1, "copy"))).unwrap();
        assert!(
            store
                .import_command_archive(scope.clone(), 1.into(), import, id("missing-operation"))
                .is_err()
        );
        let current = store
            .command_library_page(
                scope.clone(),
                CommandLibraryReadParams {
                    selection: CommandLibraryView::Entry { id: id("cmd-000") },
                    revision: Some(1.into()),
                },
            )
            .unwrap();
        assert_eq!(current, before);
        let groups = store
            .command_library_page(
                scope,
                CommandLibraryReadParams {
                    selection: CommandLibraryView::Groups { after: None },
                    revision: Some(1.into()),
                },
            )
            .unwrap();
        assert!(
            matches!(groups.records, CommandLibraryRecords::Groups { groups, .. } if groups.len() == 1)
        );
    }
}
