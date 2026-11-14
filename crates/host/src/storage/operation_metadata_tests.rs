use super::{Acceptance, Settlement, Store, canonical_digest};
use crate::auth;
use serial_workbench_core::*;

#[test]
fn history_preserves_summary_fields_and_keeps_full_evidence_separate() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    let actor = auth::actor("history-owner");
    let call: Call = serde_json::from_value(serde_json::json!({
        "protocolVersion":"0.1","hostId":identity.host_id,"instanceEpoch":identity.instance_epoch,
        "actorId":actor.id(),"requestId":"44444444-4444-4444-8444-444444444444",
        "requestContext":store.issue_context(&actor).unwrap().token,
        "actionId":"session.tx","target":{"hostId":identity.host_id,"kind":"session","id":"session","sessionId":"session","sessionEpoch":"1"},
        "params":{},"executionMode":"independent","revealTarget":{"pageId":"workbench",
            "resultRef":{"hostId":identity.host_id,"kind":"capture","id":"private-result"}}
    })).unwrap();
    let Acceptance::New(accepted) = store
        .accept(&actor, &call, &canonical_digest(&call).unwrap())
        .unwrap()
    else {
        panic!("new operation")
    };
    store.mark_dispatch(&accepted.operation_id).unwrap();
    let progress = Progress {
        completed: 75000.into(),
        total: Some(75000.into()),
        unit: "bytes".into(),
    };
    store
        .record_progress(&accepted.operation_id, &progress)
        .unwrap();
    let result = ActionResult::Tx(TxReceipt {
        operation_id: accepted.operation_id.clone(),
        session_id: Id::try_from("session").unwrap(),
        session_epoch: 1.into(),
        outcome: TxOutcome::Partial,
        bytes_base64: Bytes::try_from("QUFB".repeat(25000).as_str()).unwrap(),
        byte_start: 0.into(),
        byte_end: 75000.into(),
        accepted_ranges: vec![ByteRange {
            start: 0.into(),
            end: 75000.into(),
        }],
        unknown_ranges: vec![],
        peer_acknowledged: False,
        backend_error: Some(HostError::new("BACKEND_IO", "private-backend-message")),
    });
    let settled = store
        .settle(
            &accepted.operation_id,
            Settlement {
                state: OperationState::Succeeded,
                result: Some(result.clone()),
                error: None,
            },
        )
        .unwrap();
    let read = || {
        let value = store.operation_metadata().unwrap();
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(!encoded.contains("private-"));
        assert!(!encoded.contains("bytesBase64"));
        assert!(!encoded.contains("requestContext"));
        serde_json::from_str::<OperationsSnapshot>(&encoded)
            .unwrap()
            .items
            .remove(0)
    };
    let summary = read();
    assert_eq!(summary.operation_id, settled.operation_id);
    assert_eq!(summary.target, call.target);
    assert_eq!(summary.execution_mode, ExecutionMode::Independent);
    assert_eq!(summary.state, settled.state);
    assert_eq!(summary.revision, settled.revision);
    assert_eq!(summary.accepted_at, settled.accepted_at);
    assert_eq!(summary.started_at, settled.started_at);
    assert_eq!(summary.settled_at, settled.settled_at);
    assert_eq!(summary.progress, Some(progress));
    assert_eq!(summary.error_code.as_deref(), Some("BACKEND_IO"));
    assert!(summary.reveal_target.result_ref.is_none());
    let retained = store.get(&actor, &accepted.operation_id).unwrap();
    assert_eq!(retained.result, Some(result));
    assert_eq!(retained.reveal_target, call.reveal_target);

    // A top-level error takes precedence over the TX backend error.
    store
        .request(move |database| {
            let mut changed = settled;
            changed.state = OperationState::Failed;
            changed.error = Some(HostError::new(
                "OPERATION_FAILED",
                "private-operation-error",
            ));
            database
                .connection
                .execute(
                    "UPDATE operations SET operation_json=?1 WHERE operation_id=?2",
                    rusqlite::params![
                        serde_json::to_string(&changed).unwrap(),
                        changed.operation_id.as_str()
                    ],
                )
                .unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(read().error_code.as_deref(), Some("OPERATION_FAILED"));
}

#[test]
fn history_keeps_active_operations_first_and_bounds_the_latest_terminal_rows() {
    let profile = tempfile::tempdir().unwrap();
    let store = Store::open(profile.path()).unwrap();
    let identity = store.begin_instance().unwrap();
    store.request(move |database| {
        let transaction = database.connection.transaction().unwrap();
        for index in 0..260 {
            let terminal = index != 0;
            let mut operation = serde_json::json!({
                "operationId":format!("operation-{index}"),"executionHostId":identity.host_id,
                "actorId":"history-owner","requestId":format!("00000000-0000-4000-8000-{index:012}"),
                "admission":{"kind":"request","requestContextDigest":"0".repeat(64)},
                "rootOperationId":format!("operation-{index}"),"childHighWatermark":"0",
                "actionId":"auth.authorize","target":{"hostId":identity.host_id,"kind":"host","id":identity.host_id},
                "executionMode":"interactive","state":if terminal {"cancelled"} else {"queued"},
                "revision":"1","revealTarget":{"pageId":"workbench"},"acceptedAt":"2026-11-13T00:00:00Z",
                "owner":{"kind":"host","id":identity.host_id}
            });
            if terminal { operation["settledAt"] = serde_json::json!("2026-11-13T00:00:01Z"); }
            transaction.execute("INSERT INTO operations(operation_id,actor_id,context_digest,request_id,digest,input_json,operation_json,dispatched,terminal) VALUES(?1,'history-owner','context',?1,'digest','{}',?2,0,?3)",rusqlite::params![format!("operation-{index}"),operation.to_string(),terminal]).unwrap();
        }
        transaction.commit().unwrap();
        Ok(())
    }).unwrap();
    let snapshot: OperationsSnapshot =
        serde_json::from_value(serde_json::to_value(store.operation_metadata().unwrap()).unwrap())
            .unwrap();
    assert_eq!(snapshot.items.len(), 256);
    assert_eq!(snapshot.items[0].operation_id.as_str(), "operation-0");
    assert_eq!(snapshot.items[0].state, OperationState::Queued);
    assert_eq!(snapshot.items[1].operation_id.as_str(), "operation-259");
    assert_eq!(snapshot.items[255].operation_id.as_str(), "operation-5");
    assert!(snapshot.items.iter().all(|item| item.started_at.is_none()
        && item.settled_at.is_some() == (item.state == OperationState::Cancelled)
        && item.progress.is_none()
        && item.error_code.is_none()));
}
