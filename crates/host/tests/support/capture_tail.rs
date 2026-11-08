use super::*;
use serial_workbench_host::capture::{
    format::{CaptureSource, fingerprint, volume_name},
    writer::{CaptureLimits, CaptureWriter},
};

fn source() -> CaptureSource {
    serde_json::from_value(json!({
        "hostId":"original-host","instanceEpoch":"7","sessionId":"original-session","sessionEpoch":"9",
        "configurationDigest":"0000000000000000000000000000000000000000000000000000000000000000",
        "configuration":SerialConfiguration::default(),"timePrecision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}
    })).unwrap()
}
fn entry(seq: u64, note: &str) -> CaptureEntry {
    CaptureEntry::Event(Box::new(serde_json::from_value(json!({
        "hostId":"original-host","instanceEpoch":"7","sessionId":"original-session","sessionEpoch":"9",
        "eventSeq":seq.to_string(),"configurationRevision":"3",
        "time":{"clockId":"original-clock","sourceMonoNs":seq.to_string(),"receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},
        "kind":"lifecycle","payload":{"note":note}
    })).unwrap()))
}
async fn imported(
    f: &Fixture,
    name: &str,
    entries: Vec<CaptureEntry>,
    corrupt_last: bool,
) -> ObjectRef {
    let path = f.dir.path().canonicalize().unwrap().join(name);
    let mut writer =
        CaptureWriter::create(&path, vec![source()], CaptureLimits::default()).unwrap();
    for entry in entries {
        writer.push(entry, 0).unwrap();
    }
    writer.finish().unwrap();
    // 保存合法但键顺序不同的原始 JSON，防止重新序列化冒充原件。
    {
        use sha2::{Digest as _, Sha256};
        let volume = path.join(volume_name(1));
        let mut bytes = std::fs::read(&volume).unwrap();
        let mut offset = 7;
        while offset < bytes.len() {
            let size = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            let start = offset + 4;
            let value: Value = serde_json::from_slice(&bytes[start..start + size]).unwrap();
            let original = serde_json::to_vec(&value).unwrap();
            assert_eq!(original.len(), size);
            bytes[start..start + size].copy_from_slice(&original);
            bytes[start + size..start + size + 32].copy_from_slice(&Sha256::digest(&original));
            offset = start + size + 32;
        }
        std::fs::write(&volume, &bytes).unwrap();
        let manifest = path.join("manifest.json");
        let mut value: Value = serde_json::from_slice(&std::fs::read(&manifest).unwrap()).unwrap();
        value["volumes"][0]["digest"] = format!("{:x}", Sha256::digest(&bytes)).into();
        std::fs::write(manifest, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    if corrupt_last {
        let volume = path.join(volume_name(1));
        let mut bytes = std::fs::read(&volume).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        std::fs::write(volume, bytes).unwrap();
    }
    let registered = f
        .action(
            &f.control,
            "file.register",
            f.host(),
            json!({"path":path.to_str().unwrap(),"purpose":"capture_source"}),
        )
        .await;
    let Some(ActionResult::FileMetadata(metadata)) = registered.result else {
        panic!("register: {:?}", registered.error)
    };
    metadata.file_ref
}
fn tail_query(
    f: &Fixture,
    client: &HostClient,
    reference: &ObjectRef,
    records: u64,
    bytes: u64,
) -> Query {
    f.query(client,"capture.tail",f.reference_target(reference),json!({"captureRef":reference,"maxRecords":records.to_string(),"maxBytes":bytes.to_string()}))
}
fn tail_value(reply: RpcReply) -> Value {
    let RpcResult::Query(result) = success(reply) else {
        panic!("query")
    };
    let result = serde_json::to_value(result).unwrap();
    assert_eq!(result["kind"], "capture_tail");
    result["value"].clone()
}

#[tokio::test]
async fn capture_tail_keeps_gap_and_unknown_tx_source_facts() {
    let f = Fixture::new().await;
    let gap:CaptureEntry=serde_json::from_value(json!({"kind":"reader_gap","value":{
        "hostId":"original-host","instanceEpoch":"7","sessionId":"original-session","sessionEpoch":"9",
        "reason":"capture_paused","missingEventRange":{"start":"2","end":"4"}
    }})).unwrap();
    let tx:CaptureEntry=serde_json::from_value(json!({"kind":"tx_settlement","value":{
        "hostId":"original-host","instanceEpoch":"7","receipt":{
            "operationId":"unknown-tx","sessionId":"original-session","sessionEpoch":"9","outcome":"unknown",
            "bytesBase64":"AQID","byteStart":"0","byteEnd":"3","acceptedRanges":[{"start":"0","end":"1"}],
            "unknownRanges":[{"start":"1","end":"3"}],"peerAcknowledged":false
        }
    }})).unwrap();
    let reference = imported(
        &f,
        "gap-unknown",
        vec![entry(1, "before"), gap.clone(), tx.clone()],
        false,
    )
    .await;
    let raw = f.user.connect_raw().await.unwrap();
    let result = tail_value(
        raw.request(RpcRequest::Query(tail_query(
            &f, &f.user, &reference, 2, 262144,
        )))
        .await
        .unwrap(),
    );
    assert_eq!(result["containerComplete"], true);
    assert_eq!(result["sourceContinuous"], false);
    assert_eq!(result["firstRecord"], "2");
    assert_eq!(result["records"][0]["record"]["entry"], json!(gap));
    assert_eq!(result["records"][1]["record"]["entry"], json!(tx));
    f.finish().await;
}

#[tokio::test]
async fn capture_tail_returns_verified_suffix_over_raw_without_mutating_source() {
    let f = Fixture::new().await;
    let reference = imported(
        &f,
        "tail-complete",
        (1..=4).map(|n| entry(n, "original")).collect(),
        false,
    )
    .await;
    let path = f.dir.path().canonicalize().unwrap().join("tail-complete");
    let before = fingerprint(&path).unwrap();
    let operations = f.store.operation_metadata().unwrap();
    let query = tail_query(&f, &f.user, &reference, 2, 262144);
    let raw = f.user.connect_raw().await.unwrap();
    let result = tail_value(raw.request(RpcRequest::Query(query.clone())).await.unwrap());
    assert_eq!(result["verifiedPrefix"], "4");
    assert_eq!(result["firstRecord"], "3");
    assert_eq!(result["containerComplete"], true);
    assert_eq!(result["records"].as_array().unwrap().len(), 2);
    assert_eq!(
        result["records"][0]["record"]["entry"]["value"]["hostId"],
        "original-host"
    );
    assert_eq!(result["records"][1]["record"]["recordOrdinal"], "4");
    assert_eq!(result["sourceFingerprint"], json!(before));
    assert_eq!(fingerprint(&path).unwrap(), before);
    assert_eq!(f.store.operation_metadata().unwrap(), operations);
    assert_eq!(
        failure(f.user.request(RpcRequest::Query(query)).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    let broken = imported(
        &f,
        "tail-broken",
        (1..=3).map(|n| entry(n, "prefix")).collect(),
        true,
    )
    .await;
    let result = tail_value(
        raw.request(RpcRequest::Query(tail_query(
            &f, &f.user, &broken, 100, 262144,
        )))
        .await
        .unwrap(),
    );
    assert_eq!(result["verifiedPrefix"], "2");
    assert_eq!(result["firstRecord"], "1");
    assert_eq!(result["containerComplete"], false);
    assert_eq!(result["state"], "incomplete");
    assert_eq!(result["records"].as_array().unwrap().len(), 2);
    let empty = imported(&f, "tail-no-prefix", vec![entry(1, "broken")], true).await;
    let result = tail_value(
        raw.request(RpcRequest::Query(tail_query(
            &f, &f.user, &empty, 100, 262144,
        )))
        .await
        .unwrap(),
    );
    assert_eq!(result["verifiedPrefix"], "0");
    assert_eq!(result["firstRecord"], "1");
    assert_eq!(result["records"], json!([]));
    assert_eq!(result["containerComplete"], false);
    f.finish().await;
}

#[tokio::test]
async fn capture_tail_bounds_reference_json_and_requires_current_content_authority() {
    use base64::Engine as _;
    use serial_workbench_host::capture::format::MAX_RECORD;
    use sha2::{Digest as _, Sha256};
    let f = Fixture::new().await;
    let mut record = CaptureRecord {
        record_ordinal: 2.into(),
        entry: entry(2, ""),
    };
    let overhead = serde_json::to_vec(&record).unwrap().len();
    record.entry = entry(2, &"X".repeat(MAX_RECORD - overhead));
    let original = serde_json::to_vec(&serde_json::to_value(&record).unwrap()).unwrap();
    assert_ne!(original, serde_json::to_vec(&record).unwrap());
    assert_eq!(original.len(), MAX_RECORD);
    let reference = imported(
        &f,
        "tail-large",
        vec![entry(1, "first"), record.entry.clone()],
        false,
    )
    .await;
    let raw = f.observer.connect_raw().await.unwrap();
    let query = tail_query(&f, &f.observer, &reference, 100, 262144);
    assert_eq!(
        failure(raw.request(RpcRequest::Query(query.clone())).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    f.grant("content.read", f.reference_target(&reference));
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![f.reference_target(&reference)],
            },
        )
        .unwrap();
    let result = tail_value(raw.request(RpcRequest::Query(query.clone())).await.unwrap());
    assert_eq!(result["firstRecord"], "1");
    assert_eq!(result["records"][1]["kind"], "reference");
    assert_eq!(result["records"][1]["jsonBytes"], MAX_RECORD.to_string());
    assert_eq!(
        result["records"][1]["jsonSha256"],
        format!("{:x}", Sha256::digest(&original))
    );
    assert!(serde_json::to_vec(&result).unwrap().len() <= 262144);
    let mut only_latest = result.clone();
    only_latest["firstRecord"] = "2".into();
    only_latest["records"] = json!([result["records"][1]]);
    let budget = serde_json::to_vec(&only_latest).unwrap().len() as u64;
    let bounded = tail_value(
        raw.request(RpcRequest::Query(tail_query(
            &f,
            &f.observer,
            &reference,
            100,
            budget,
        )))
        .await
        .unwrap(),
    );
    assert_eq!(bounded, only_latest);
    assert_eq!(serde_json::to_vec(&bounded).unwrap().len() as u64, budget);
    let record_ref: ObjectRef =
        serde_json::from_value(result["records"][1]["recordRef"].clone()).unwrap();
    let mut actual = vec![];
    while actual.len() < original.len() {
        let request = f.query(
            &f.observer,
            "file.read",
            f.reference_target(&record_ref),
            json!({"fileRef":record_ref,"offset":actual.len().to_string(),"maxBytes":"65536"}),
        );
        let RpcResult::Query(QueryResult::FileRead(chunk)) =
            success(raw.request(RpcRequest::Query(request)).await.unwrap())
        else {
            panic!("file chunk")
        };
        actual.extend(
            base64::engine::general_purpose::STANDARD
                .decode(chunk.bytes_base64.as_str())
                .unwrap(),
        );
    }
    assert_eq!(actual, original);
    for (records, bytes, code) in [
        (0, 262144, "INVALID_ARGUMENT"),
        (101, 262144, "INVALID_ARGUMENT"),
        (1, 0, "INVALID_ARGUMENT"),
        (1, 262145, "INVALID_ARGUMENT"),
        (1, 1, "LIMIT_EXCEEDED"),
    ] {
        assert_eq!(
            failure(
                raw.request(RpcRequest::Query(tail_query(
                    &f,
                    &f.observer,
                    &reference,
                    records,
                    bytes
                )))
                .await
                .unwrap()
            )
            .code,
            code
        );
    }
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.reference_target(&reference)],
            },
        )
        .unwrap();
    assert_eq!(
        failure(raw.request(RpcRequest::Query(query)).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    let user_raw = f.user.connect_raw().await.unwrap();
    let mut stale = reference.clone();
    stale.revision = Some(99.into());
    assert_eq!(
        failure(
            user_raw
                .request(RpcRequest::Query(tail_query(
                    &f, &f.user, &stale, 100, 262144
                )))
                .await
                .unwrap()
        )
        .code,
        "REVISION_CONFLICT"
    );
    std::fs::write(f.dir.path().join("tail-large/index.json"), b"{}").unwrap();
    assert_eq!(
        failure(
            user_raw
                .request(RpcRequest::Query(tail_query(
                    &f, &f.user, &reference, 100, 262144
                )))
                .await
                .unwrap()
        )
        .code,
        "SOURCE_CHANGED"
    );
    f.finish().await;
}

#[tokio::test]
async fn capture_tail_live_reference_refuses_active_writer_then_returns_published_revision() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("tail-live").await;
    let (owner, live) = f.start(&f.user, &session, &destination).await;
    assert!(live.revision.is_none());
    let raw = f.user.connect_raw().await.unwrap();
    let query = tail_query(&f, &f.user, &live, 100, 262144);
    assert_eq!(
        failure(raw.request(RpcRequest::Query(query.clone())).await.unwrap()).code,
        "CAPTURE_ACTIVE"
    );
    assert_eq!(
        f.store.get(&f.operator, &owner.operation_id).unwrap().state,
        OperationState::Running
    );
    let stop = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(stop.state, OperationState::Succeeded);
    assert_eq!(f.wait(&owner, false).await.state, OperationState::Succeeded);
    let result = tail_value(raw.request(RpcRequest::Query(query)).await.unwrap());
    assert_eq!(result["captureRef"]["id"], json!(live.id));
    assert!(result["captureRef"]["revision"].is_string());
    assert_eq!(result["verifiedPrefix"], "0");
    assert_eq!(result["firstRecord"], "1");
    assert_eq!(result["records"], json!([]));
    f.finish().await;
}
