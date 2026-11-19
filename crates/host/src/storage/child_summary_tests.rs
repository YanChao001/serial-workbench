//! 真实 Store 的子摘要合并与写保护；逻辑保留时钟不代表实际七天或原生执行验收。
use super::*;
use crate::storage::Settlement;
use rusqlite::{OptionalExtension, params};

const AFTER_CHILD_RETENTION_NS: u64 = 604_800_000_000_001;
const SEEDED_SUMMARY_REVISION: u64 = 41;

// 只用于本文件固定的父/子两个操作，保留原始输入、回执和保留期列以验证回滚。
type RawOperationRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    bool,
    bool,
    Option<String>,
);

#[derive(Debug, PartialEq)]
struct SummaryRows {
    document: Option<(String, String)>,
    operations: Vec<RawOperationRow>,
}

fn summary_key(parent: &Id) -> String {
    format!("operation-children-{parent}")
}

fn seed_summary(store: &Store, parent: &Id, raw: &str) {
    let key = summary_key(parent);
    let raw = raw.to_owned();
    store
        .request(move |database| {
            database
                .connection
                .execute(
                    "INSERT INTO documents(id,revision,value_json) VALUES(?1,?2,?3)",
                    params![key, SEEDED_SUMMARY_REVISION.to_string(), raw],
                )
                .map_err(|_| crate::storage::unavailable())?;
            Ok(())
        })
        .unwrap();
}

fn summary_rows(store: &Store, parent: &Id) -> SummaryRows {
    let key = summary_key(parent);
    store
        .request(move |database| {
            let document = database
                .connection
                .query_row(
                    "SELECT revision,value_json FROM documents WHERE id=?1",
                    [key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|_| crate::storage::unavailable())?;
            let mut statement = database.connection.prepare(
                "SELECT operation_id,actor_id,context_digest,request_id,digest,input_json,operation_json,dispatched,terminal,expires_at_retention_ns FROM operations ORDER BY operation_id",
            ).map_err(|_| crate::storage::unavailable())?;
            let operations: Vec<RawOperationRow> = statement
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                    ))
                })
                .map_err(|_| crate::storage::unavailable())?
                .collect::<rusqlite::Result<_>>()
                .map_err(|_| crate::storage::unavailable())?;
            Ok(SummaryRows { document, operations })
        })
        .unwrap()
}

fn settled_child(fixture: &TaskFixture, unknown: bool) -> Operation {
    let Acceptance::New(child) = fixture.accept(&fixture.child).unwrap() else {
        panic!("Expected a newly admitted child")
    };
    fixture.store.mark_dispatch(&child.operation_id).unwrap();
    fixture
        .store
        .settle(
            &child.operation_id,
            Settlement {
                state: if unknown {
                    OperationState::Unknown
                } else {
                    OperationState::Succeeded
                },
                result: None,
                error: None,
            },
        )
        .unwrap()
}

fn child_selector(fixture: &TaskFixture) -> OperationGetParams {
    OperationGetParams::ByChild {
        parent_operation_id: fixture.parent.operation_id.clone(),
        child_key: fixture.child.child_key,
    }
}

#[test]
fn false_child_summary_merges_unknown_before_pruning_and_survives_store_reopen() {
    for unknown in [true, false] {
        let clock = Arc::new(TestClock::default());
        let fixture = TaskFixture::new(clock.clone());
        let child = settled_child(&fixture, unknown);
        let raw = " \n{ \"formatVersion\": \"0.1\", \"unknown\": false }\n";
        seed_summary(&fixture.store, &fixture.parent.operation_id, raw);
        let before = summary_rows(&fixture.store, &fixture.parent.operation_id);
        assert_eq!(before.operations.len(), 2);
        let parent_before = fixture
            .store
            .get(&fixture.actor, &fixture.parent.operation_id)
            .unwrap();
        assert_eq!(parent_before.state, OperationState::Running);
        assert_eq!(parent_before.child_high_watermark, 1.into());
        let selector = child_selector(&fixture);

        clock.0.store(AFTER_CHILD_RETENTION_NS, Ordering::SeqCst);
        fixture.store.prune().unwrap();
        let pruned = summary_rows(&fixture.store, &fixture.parent.operation_id);
        assert_eq!(
            pruned.operations.len(),
            1,
            "Actual child row must be deleted"
        );
        assert_eq!(pruned.operations[0].0, fixture.parent.operation_id.as_str());
        assert!(
            pruned
                .operations
                .iter()
                .all(|row| row.0 != child.operation_id.as_str()),
            "An expired read alone does not prove deletion"
        );
        let (revision, retained) = pruned.document.as_ref().unwrap();
        assert_eq!(
            revision,
            &(SEEDED_SUMMARY_REVISION + u64::from(unknown)).to_string()
        );
        let retained: serde_json::Value = serde_json::from_str(retained).unwrap();
        assert_eq!(
            retained,
            serde_json::json!({"formatVersion":"0.1","unknown":unknown})
        );
        if !unknown {
            assert_eq!(
                pruned.document, before.document,
                "Known child must not rewrite false"
            );
        }
        assert_eq!(
            fixture
                .store
                .get(&fixture.actor, &fixture.parent.operation_id)
                .unwrap(),
            parent_before,
            "Pruning must not advance the parent watermark or revision"
        );
        assert_eq!(
            fixture
                .store
                .get_selected(&fixture.actor, &selector)
                .unwrap_err()
                .code,
            "RESULT_EXPIRED"
        );
        assert_eq!(
            fixture
                .store
                .get(&fixture.actor, &child.operation_id)
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );

        // 只检查 Store 保留收到的领域回执，不声称发生了真实串口 I/O。
        let receipt = ActionResult::Tx(TxReceipt {
            operation_id: fixture.parent.operation_id.clone(),
            session_id: Id::try_from("summary-receipt-session").unwrap(),
            session_epoch: 1.into(),
            outcome: TxOutcome::Accepted,
            bytes_base64: Bytes::try_from("AQIDBAU=").unwrap(),
            byte_start: 0.into(),
            byte_end: 5.into(),
            accepted_ranges: vec![ByteRange {
                start: 0.into(),
                end: 5.into(),
            }],
            unknown_ranges: vec![],
            peer_acknowledged: False,
            backend_error: None,
        });
        fixture
            .store
            .record_result_evidence(&fixture.parent.operation_id, &receipt)
            .unwrap();
        // 必须先在原实例尝试成功结算，避免 recover 的 dispatched→Unknown 掩盖摘要丢失。
        let settled = fixture
            .store
            .settle(
                &fixture.parent.operation_id,
                Settlement {
                    state: OperationState::Succeeded,
                    result: None,
                    error: None,
                },
            )
            .unwrap();
        assert_eq!(
            settled.state,
            if unknown {
                OperationState::Unknown
            } else {
                OperationState::Succeeded
            }
        );
        assert_eq!(
            settled.child_high_watermark,
            parent_before.child_high_watermark
        );
        assert_eq!(settled.result, Some(receipt));
        if unknown {
            assert_eq!(
                settled.error.as_ref().unwrap().code,
                "CHILD_OUTCOME_UNKNOWN"
            );
        } else {
            assert!(settled.error.is_none());
        }
        let settled_rows = summary_rows(&fixture.store, &fixture.parent.operation_id);
        let original_identity = fixture.store.identity().unwrap();
        let TaskFixture {
            store,
            actor,
            parent,
            _profile: profile,
            ..
        } = fixture;
        drop(store);
        let reopened = Store::open_with_clock(profile.path(), clock).unwrap();
        let identity = reopened.begin_instance().unwrap();
        assert_eq!(identity.host_id, original_identity.host_id);
        assert_eq!(
            identity.instance_epoch,
            original_identity.instance_epoch.checked_next().unwrap()
        );
        assert!(reopened.recover().unwrap().is_empty());
        assert!(reopened.recover().unwrap().is_empty());
        assert_eq!(reopened.get(&actor, &parent.operation_id).unwrap(), settled);
        assert_eq!(summary_rows(&reopened, &parent.operation_id), settled_rows);
        assert_eq!(
            reopened.get_selected(&actor, &selector).unwrap_err().code,
            "RESULT_EXPIRED"
        );
        assert_eq!(
            reopened
                .mark_dispatch(&parent.operation_id)
                .unwrap_err()
                .code,
            "OPERATION_NOT_RUNNING"
        );
        assert_eq!(reopened.get(&actor, &parent.operation_id).unwrap(), settled);
        drop(reopened);
        drop(profile);
    }
}

fn assert_summary_write_protected(raw: &str, expected_code: &str) {
    let clock = Arc::new(TestClock::default());
    let fixture = TaskFixture::new(clock.clone());
    let child = settled_child(&fixture, true);
    seed_summary(&fixture.store, &fixture.parent.operation_id, raw);
    clock.0.store(AFTER_CHILD_RETENTION_NS, Ordering::SeqCst);
    let original = summary_rows(&fixture.store, &fixture.parent.operation_id);
    assert_eq!(original.operations.len(), 2);
    assert_eq!(
        original.document,
        Some((SEEDED_SUMMARY_REVISION.to_string(), raw.to_owned()))
    );
    let parent = fixture
        .store
        .get(&fixture.actor, &fixture.parent.operation_id)
        .unwrap();
    assert_eq!(parent.state, OperationState::Running);
    assert_eq!(parent.child_high_watermark, 1.into());
    assert!(
        original
            .operations
            .iter()
            .any(|row| row.0 == child.operation_id.as_str())
    );

    assert_eq!(fixture.store.prune().unwrap_err().code, expected_code);
    assert_eq!(
        summary_rows(&fixture.store, &fixture.parent.operation_id),
        original
    );
    assert_eq!(
        fixture
            .store
            .settle(
                &fixture.parent.operation_id,
                Settlement {
                    state: OperationState::Succeeded,
                    result: None,
                    error: None
                },
            )
            .unwrap_err()
            .code,
        expected_code
    );
    assert_eq!(
        summary_rows(&fixture.store, &fixture.parent.operation_id),
        original
    );
    assert_eq!(
        fixture
            .store
            .child_summary(&fixture.parent.operation_id)
            .unwrap_err()
            .code,
        expected_code
    );

    let TaskFixture {
        store,
        actor,
        _profile: profile,
        ..
    } = fixture;
    drop(store);
    let reopened = Store::open_with_clock(profile.path(), clock.clone()).unwrap();
    reopened.begin_instance().unwrap();
    // 失败的 prune 未提交保留时钟；重开只累计新的已存活时间，再推进同一逻辑期限。
    clock
        .0
        .fetch_add(AFTER_CHILD_RETENTION_NS, Ordering::SeqCst);
    // 此分支只重开存储并重复写保护；不借启动恢复改写仍 Running 的父记录。
    assert_eq!(summary_rows(&reopened, &parent.operation_id), original);
    assert_eq!(reopened.prune().unwrap_err().code, expected_code);
    assert_eq!(summary_rows(&reopened, &parent.operation_id), original);
    assert_eq!(
        reopened
            .settle(
                &parent.operation_id,
                Settlement {
                    state: OperationState::Succeeded,
                    result: None,
                    error: None
                },
            )
            .unwrap_err()
            .code,
        expected_code
    );
    assert_eq!(summary_rows(&reopened, &parent.operation_id), original);
    assert_eq!(reopened.get(&actor, &parent.operation_id).unwrap(), parent);
    drop(reopened);
    drop(profile);
}

#[test]
fn future_child_summary_rejects_prune_and_parent_settlement_without_overwriting_evidence() {
    assert_summary_write_protected(
        " \n{ \"formatVersion\": \"0.2\", \"unknown\": false }\n",
        "UNSUPPORTED_FORMAT",
    );
}

#[test]
fn malformed_child_summary_rejects_prune_and_parent_settlement_without_overwriting_evidence() {
    for raw in [
        r#"{"formatVersion":"0.1","unknown":false"#,
        r#"{"formatVersion":"0.1","unknown":false,"extra":0}"#,
        r#"{"formatVersion":"0.1","unknown":"false"}"#,
    ] {
        assert_summary_write_protected(raw, "STORAGE_UNAVAILABLE");
    }
}
