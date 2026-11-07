use std::{fs, path::Path, sync::Arc};

use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use serial_workbench_core::{Clock, HostError, HostResult, Id, U64};

use super::unavailable;
use crate::auth::{AuthenticatedActor, ContextSigner, HostIdentity, RequestContext};

const SCHEMA_VERSION: i64 = 1;

pub(super) struct Database {
    pub connection: Connection,
    pub clock: Arc<dyn Clock>,
    pub signer: ContextSigner,
    identity: Option<HostIdentity>,
    pub retention: RetentionClock,
}

/// 仅累计已确认的 Host 存活时间，重启时沿用已持久的基值。
pub(super) struct RetentionClock {
    base_ns: u64,
    mono_origin_ns: u64,
}

impl RetentionClock {
    pub fn now(&self, clock: &dyn Clock) -> HostResult<u64> {
        clock
            .mono_ns()
            .checked_sub(self.mono_origin_ns)
            .and_then(|elapsed| self.base_ns.checked_add(elapsed))
            .ok_or_else(|| HostError::new("COUNTER_EXHAUSTED", "Retention clock exhausted"))
    }
}

impl Database {
    pub fn open(path: &Path, clock: Arc<dyn Clock>) -> HostResult<Self> {
        // 未来版本首先以只读连接检查，不能先切换 journal 或提交任何 pragma。
        if path.exists() {
            let probe = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|_| unavailable())?;
            let version: i64 = probe
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .map_err(|_| unavailable())?;
            if version > SCHEMA_VERSION {
                return Err(HostError::new(
                    "FUTURE_FORMAT",
                    "Host database requires a newer version",
                ));
            }
        }
        fs::create_dir_all(path.parent().ok_or_else(unavailable)?).map_err(|_| unavailable())?;
        let mut connection = Connection::open(path).map_err(|_| unavailable())?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| unavailable())?;
        if version != 0 && version != SCHEMA_VERSION {
            return Err(HostError::new(
                "FUTURE_FORMAT",
                "Unsupported Host database version",
            ));
        }
        connection
            .execute_batch(
                "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
            )
            .map_err(|_| unavailable())?;
        if version == 0 {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|_| unavailable())?;
            transaction.execute_batch(
                "CREATE TABLE host_identity (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
                    host_id TEXT NOT NULL,
                    instance_epoch TEXT NOT NULL,
                    catalog_version TEXT NOT NULL,
                    retention_clock_ns TEXT NOT NULL
                );
                CREATE TABLE operations (
                    operation_id TEXT PRIMARY KEY,
                    actor_id TEXT NOT NULL,
                    context_digest TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    input_json TEXT NOT NULL,
                    operation_json TEXT NOT NULL,
                    dispatched INTEGER NOT NULL CHECK(dispatched IN (0,1)),
                    terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
                    expires_at_retention_ns TEXT,
                    UNIQUE(actor_id,context_digest,request_id)
                );
                CREATE INDEX operation_expiration ON operations(length(expires_at_retention_ns), expires_at_retention_ns) WHERE terminal=1;
                CREATE TABLE documents (id TEXT PRIMARY KEY, revision TEXT NOT NULL, value_json TEXT NOT NULL);
                PRAGMA user_version=1;"
            ).map_err(|_| unavailable())?;
            transaction
                .execute(
                    "INSERT INTO host_identity VALUES(1,?1,'0','1','0')",
                    [uuid::Uuid::new_v4().to_string()],
                )
                .map_err(|_| unavailable())?;
            transaction.commit().map_err(|_| unavailable())?;
        }
        let retention: String = connection
            .query_row(
                "SELECT retention_clock_ns FROM host_identity WHERE singleton=1",
                [],
                |row| row.get(0),
            )
            .map_err(|_| unavailable())?;
        let retention_base_ns = counter(&retention)?.get();
        let mono_origin_ns = clock.mono_ns();
        Ok(Self {
            connection,
            clock,
            signer: ContextSigner::new(),
            identity: None,
            retention: RetentionClock {
                base_ns: retention_base_ns,
                mono_origin_ns,
            },
        })
    }

    pub fn begin_instance(&mut self) -> HostResult<HostIdentity> {
        if self.identity.is_some() {
            return Err(HostError::new("HOST_BUSY", "Host instance already started"));
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let retention = self.retention.now(self.clock.as_ref())?;
        let (host_id, epoch, catalog): (String, String, String) = transaction.query_row("SELECT host_id,instance_epoch,catalog_version FROM host_identity WHERE singleton=1", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(|_| unavailable())?;
        let identity = HostIdentity {
            host_id: Id::try_from(host_id.as_str()).map_err(|_| unavailable())?,
            instance_epoch: counter(&epoch)?.checked_next()?,
            catalog_version: counter(&catalog)?,
        };
        transaction.execute("UPDATE host_identity SET instance_epoch=?1,retention_clock_ns=?2 WHERE singleton=1", params![identity.instance_epoch.to_string(), retention.to_string()]).map_err(|_| unavailable())?;
        transaction.commit().map_err(|_| unavailable())?;
        self.identity = Some(identity.clone());
        Ok(identity)
    }

    pub fn identity(&self) -> HostResult<HostIdentity> {
        self.identity
            .clone()
            .ok_or_else(|| HostError::new("OPERATION_NOT_RUNNING", "Host instance has not started"))
    }

    pub fn synchronize_catalog(
        &mut self,
        digest: serial_workbench_core::Digest,
    ) -> HostResult<U64> {
        use rusqlite::OptionalExtension;
        let mut identity = self.identity()?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| unavailable())?;
        let prior: Option<String> = transaction
            .query_row(
                "SELECT value_json FROM documents WHERE id='host:catalog-digest'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| unavailable())?;
        let encoded = serde_json::json!({"digest":digest}).to_string();
        if prior.as_ref() != Some(&encoded) {
            identity.catalog_version = identity.catalog_version.checked_next()?;
            transaction
                .execute(
                    "UPDATE host_identity SET catalog_version=?1 WHERE singleton=1",
                    [identity.catalog_version.to_string()],
                )
                .map_err(|_| unavailable())?;
            transaction.execute("INSERT INTO documents(id,revision,value_json) VALUES('host:catalog-digest','1',?1) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json", [encoded]).map_err(|_| unavailable())?;
        }
        transaction.commit().map_err(|_| unavailable())?;
        self.identity = Some(identity.clone());
        Ok(identity.catalog_version)
    }

    pub fn issue_context(&self, actor: &AuthenticatedActor) -> HostResult<RequestContext> {
        self.signer
            .issue(actor, &self.identity()?, self.clock.as_ref())
    }

    pub fn retention_now(&self) -> HostResult<u64> {
        self.retention.now(self.clock.as_ref())
    }

    pub fn checkpoint(&mut self) -> HostResult<()> {
        let now = self.retention_now()?;
        save_retention(&self.connection, now)
    }
}

pub(super) fn save_retention(connection: &Connection, now: u64) -> HostResult<()> {
    connection
        .execute(
            "UPDATE host_identity SET retention_clock_ns=?1 WHERE singleton=1",
            [now.to_string()],
        )
        .map_err(|_| unavailable())?;
    Ok(())
}
pub(super) fn counter(value: &str) -> HostResult<U64> {
    U64::try_from(value).map_err(|_| unavailable())
}
