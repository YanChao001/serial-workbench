//! 单个worker隔离场景的Virtual、Raw与录制连续性证据。
use crate::test_support::node_host_actions::Fixture;
use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient, RawConnection};
use serial_workbench_core::*;
use std::time::Duration;

pub(super) struct CaptureProbe {
    client: HostClient,
    session: Target,
    owner: Id,
    live: ObjectRef,
    raw: RawConnection,
    subscription: Id,
    cursor: Cursor,
    rx: Vec<u8>,
    rx_events: Vec<RawEvent>,
    phases: Vec<Vec<u8>>,
    synced: u64,
}

impl CaptureProbe {
    pub(super) async fn start(fixture: &Fixture) -> Self {
        let client = HostClient::connect(ConnectOptions::new(
            fixture.dir.path().to_path_buf(),
            fixture.user.attachment().client_id.clone(),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        // 普通/控制连接沿用同一客户端的文件选择绑定；人工控制凭据不授予业务权限。
        probe_action(
            fixture,
            &fixture.user,
            &fixture.target,
            "auth.authorize",
            json!({
                "clientId":client.attachment().client_id,
                "permissions":["metadata.read","content.read","device.modify","workspace.modify"],
                "targets":[fixture.target]
            }),
        )
        .await;
        let device = Target {
            kind: ResourceKind::try_from("device").unwrap(),
            id: Id::try_from("virtual:echo").unwrap(),
            ..fixture.target.clone()
        };
        let opened = probe_action(
            fixture,
            &client,
            &device,
            "device.open",
            json!({"configuration":SerialConfiguration::default()}),
        )
        .await;
        let Some(ActionResult::Opened(opened)) = opened.result else {
            panic!("Expected actual Virtual session: {opened:?}");
        };
        let session = Target {
            kind: ResourceKind::try_from("session").unwrap(),
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
            ..fixture.target.clone()
        };
        let path = fixture.dir.path().join("task-worker-continuity-capture");
        let registered = probe_action(
            fixture,
            &fixture.user,
            &fixture.target,
            "file.register",
            json!({"path":path.to_str().unwrap(),"purpose":"capture_target"}),
        )
        .await;
        let Some(ActionResult::FileMetadata(metadata)) = registered.result else {
            panic!("Expected registered capture destination: {registered:?}");
        };
        let accepted = fixture
            .invoke(
                &client,
                fixture.call(
                    &client,
                    &reference_target(&metadata.file_ref),
                    "capture.start",
                    json!({"sessionRefs":[session],"targetRef":metadata.file_ref,"overflowPolicy":"stop"}),
                ),
            )
            .await;
        // 长期Operation在Running时持有live reference；不能用Fixture::wait等待其终态。
        let live = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let QueryResult::Operation(current) = fixture
                    .query(
                        &client,
                        &fixture.target,
                        "operation.get",
                        json!({"operationId":accepted.operation_id}),
                    )
                    .await
                else {
                    panic!("Expected capture owner Operation");
                };
                let current = current.operation;
                assert!(!current.state.is_terminal(), "{current:?}");
                if current.state == OperationState::Running
                    && let Some(ActionResult::Reference(reference)) = current.result
                {
                    break reference.result_ref;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Capture did not publish its actual live reference within five seconds");
        assert!(live.revision.is_none());
        let raw = client.connect_raw().await.unwrap();
        let QueryResult::StreamCursor(reference) = raw_query(
            &raw,
            fixture.query_call(&client, &session, "stream.cursor", json!({})),
        )
        .await
        else {
            panic!("Expected actual stream cursor");
        };
        assert_eq!(reference.target, session);
        assert_eq!(reference.cursor.host_id, session.host_id);
        assert_eq!(
            reference.cursor.instance_epoch,
            client.attachment().instance_epoch
        );
        let QueryResult::StreamSubscribe(subscription) = raw_query(
            &raw,
            fixture.query_call(
                &client,
                &session,
                "stream.subscribe",
                json!({"scopeId":reference.cursor.scope_id,"after":reference.cursor,
                    "queueBytes":"65536","initialCreditBytes":"65536","overflowPolicy":"drop_with_gap"}),
            ),
        )
        .await
        else {
            panic!("Expected actual Raw subscription");
        };
        Self {
            client,
            session,
            owner: accepted.operation_id,
            live,
            raw,
            subscription: subscription.subscription_id,
            cursor: reference.cursor,
            rx: Vec::new(),
            rx_events: Vec::new(),
            phases: Vec::new(),
            synced: 0,
        }
    }

    pub(super) fn session(&self) -> &Target {
        &self.session
    }

    pub(super) async fn phase(&mut self, fixture: &Fixture, bytes: &[u8]) -> Id {
        // 固定小场景，初始64KiB credit足够；ACK归还已消费队列，不无限追加credit。
        assert!(!bytes.is_empty() && bytes.len() <= 64);
        assert!(
            self.phases.len() < 4,
            "This helper covers at most four small phases"
        );
        assert!(!self.phases.iter().any(|previous| previous == bytes));
        let baseline = self.status(fixture).await;
        assert_eq!(baseline.summary.state, CaptureState::Recording);
        assert!(baseline.summary.watermarks.synced.get() >= self.synced);
        let baseline_synced = baseline.summary.watermarks.synced.get();
        let begin = self.rx.len();
        self.phases.push(bytes.to_vec());
        let expected: Vec<u8> = self.phases.iter().flatten().copied().collect();
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        let tx = probe_action(
            fixture,
            &self.client,
            &self.session,
            "session.tx",
            json!({"bytesBase64":encoded,"writeWaitMs":"1000"}),
        )
        .await;
        let Some(ActionResult::Tx(receipt)) = tx.result else {
            panic!("Expected actual TX receipt: {tx:?}");
        };
        assert_eq!(receipt.outcome, TxOutcome::Accepted);
        assert_eq!(receipt.session_id, self.session.id);
        assert_eq!(Some(receipt.session_epoch), self.session.session_epoch);
        assert_eq!(receipt.bytes_base64.as_str(), encoded);
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.rx.len() < expected.len() {
                let frame = self.raw.next_event().await.unwrap().expect("Raw connection ended");
                let IpcMessage::RawBatch { batch } = frame.body else {
                    panic!("Unexpected Raw event: {frame:?}");
                };
                assert_eq!(batch.subscription_id, self.subscription);
                assert_eq!(batch.previous_cursor, self.cursor);
                assert_eq!(batch.cursor.host_id, self.cursor.host_id);
                assert_eq!(batch.cursor.instance_epoch, self.cursor.instance_epoch);
                assert_eq!(batch.cursor.scope_id, self.cursor.scope_id);
                assert!(batch.cursor.position > self.cursor.position);
                for item in batch.items {
                    let StreamItem::Source { event } = item else {
                        panic!("Raw reader gap in finite continuity probe: {item:?}");
                    };
                    self.same_source(&event);
                    assert!(!matches!(&event.payload, RawPayload::Gap(_)), "{event:?}");
                    if let RawPayload::Rx(payload) = &event.payload {
                        let chunk = base64::Engine::decode(
                            &base64::engine::general_purpose::STANDARD,
                            payload.bytes_base64.as_str(),
                        )
                        .unwrap();
                        assert_eq!(payload.byte_start.get(), self.rx.len() as u64);
                        assert_eq!(payload.byte_end.get() - payload.byte_start.get(), chunk.len() as u64);
                        self.rx.extend_from_slice(&chunk);
                        assert!(self.rx.len() <= expected.len(), "Unexpected extra Virtual RX");
                        assert_eq!(self.rx.as_slice(), &expected[..self.rx.len()]);
                        self.rx_events.push(*event);
                    }
                }
                self.cursor = batch.cursor;
                let QueryResult::StreamCredit(credit) = raw_query(
                    &self.raw,
                    fixture.query_call(
                        &self.client,
                        &self.session,
                        "stream.credit",
                        json!({"subscriptionId":self.subscription,"ackCursor":self.cursor,"grantedBytesTotal":"65536"}),
                    ),
                )
                .await
                else {
                    panic!("Expected Raw credit acknowledgement");
                };
                assert_eq!(credit.ack_cursor, self.cursor);
                assert_eq!(credit.granted_bytes_total, 65_536.into());
            }
        })
        .await
        .unwrap_or_else(|_| panic!("Virtual RX stalled: expected={expected:?} actual={:?}", self.rx));
        assert_eq!(&self.rx[begin..], bytes);
        let next = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let status = self.status(fixture).await;
                assert_eq!(status.summary.state, CaptureState::Recording);
                assert_eq!(status.owner_operation_id, Some(self.owner.clone()));
                if status.summary.watermarks.synced.get() > baseline_synced {
                    break status.summary.watermarks.synced.get();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("Capture synced watermark did not advance after the new phase");
        assert!(next > self.synced);
        self.synced = next;
        eprintln!(
            "task_worker_capture_phase phase={} same_epoch={} rx_bytes={} synced={next}",
            self.phases.len(),
            self.session.session_epoch.unwrap().get(),
            self.rx.len()
        );
        tx.operation_id
    }

    pub(super) async fn finish(self, fixture: &Fixture) -> ObjectRef {
        assert!(!self.phases.is_empty());
        probe_action(
            fixture,
            &self.client,
            &reference_target(&self.live),
            "capture.stop",
            json!({"captureRef":self.live}),
        )
        .await;
        let owner = fixture.wait(&self.client, &self.owner).await;
        assert_eq!(owner.state, OperationState::Succeeded, "{owner:?}");
        let Some(ActionResult::CaptureStatus(status)) = owner.result else {
            panic!("Expected final published capture status: {owner:?}");
        };
        assert_eq!(status.summary.state, CaptureState::Complete);
        assert!(status.summary.watermarks.synced.get() >= self.synced);
        let fixed = status.capture_ref;
        assert!(fixed.revision.is_some());
        let verified = probe_action(
            fixture,
            &self.client,
            &reference_target(&fixed),
            "capture.verify",
            json!({"captureRef":fixed}),
        )
        .await;
        let Some(ActionResult::CaptureVerification(verification)) = verified.result else {
            panic!("Expected physical capture verification: {verified:?}");
        };
        assert!(verification.container_complete && verification.source_continuous);
        // capture.tail是Raw-only；不用内部CaptureWriter/磁盘解析替代公开读路径。
        let QueryResult::CaptureTail(tail) = raw_query(
            &self.raw,
            fixture.query_call(
                &self.client,
                &reference_target(&fixed),
                "capture.tail",
                json!({"captureRef":fixed,"maxRecords":"100","maxBytes":"262144"}),
            ),
        )
        .await
        else {
            panic!("Expected verified capture tail");
        };
        assert_eq!(tail.capture_ref, fixed);
        assert_eq!(tail.state, CaptureState::Complete);
        assert!(tail.container_complete && tail.source_continuous);
        assert_eq!(tail.source_fingerprint, verification.source_fingerprint);
        assert_eq!(tail.verified_prefix, verification.verified_prefix);
        assert_eq!(
            tail.first_record,
            1.into(),
            "The bounded probe must fit in the full tail"
        );
        assert_eq!(tail.records.len() as u64, tail.verified_prefix.get());
        let mut saved_rx = Vec::new();
        let mut saved_events = Vec::new();
        for item in tail.records {
            let ReplayRecord::Inline { record } = item else {
                panic!("Small probe unexpectedly produced a large referenced record: {item:?}");
            };
            match record.entry {
                CaptureEntry::Event(event) => {
                    self.same_source(&event);
                    if let RawPayload::Rx(payload) = &event.payload {
                        saved_rx.extend(
                            base64::Engine::decode(
                                &base64::engine::general_purpose::STANDARD,
                                payload.bytes_base64.as_str(),
                            )
                            .unwrap(),
                        );
                        saved_events.push(*event);
                    }
                }
                CaptureEntry::ReaderGap(gap) => panic!("Capture reader gap: {gap:?}"),
                CaptureEntry::TxSettlement(_) => {}
            }
        }
        assert_eq!(saved_rx, self.rx);
        assert_eq!(
            saved_events, self.rx_events,
            "Capture must preserve the same RX events"
        );
        assert_eq!(
            saved_rx,
            self.phases.iter().flatten().copied().collect::<Vec<_>>()
        );
        self.raw.close().await.unwrap();
        probe_action(
            fixture,
            &self.client,
            &self.session,
            "session.close",
            json!({}),
        )
        .await;
        eprintln!(
            "task_worker_capture_complete phases={} raw_rx_bytes={} capture_rx_bytes={} verified=true same_epoch=true",
            self.phases.len(),
            self.rx.len(),
            saved_rx.len()
        );
        fixed
    }

    async fn status(&self, fixture: &Fixture) -> CaptureStatusResult {
        let QueryResult::CaptureStatus(status) = fixture
            .query(
                &self.client,
                &reference_target(&self.live),
                "capture.status",
                json!({"captureRef":self.live}),
            )
            .await
        else {
            panic!("Expected capture status");
        };
        assert_eq!(status.capture_ref, self.live);
        status
    }

    fn same_source(&self, event: &RawEvent) {
        assert_eq!(event.host_id, self.session.host_id);
        assert_eq!(event.instance_epoch, self.cursor.instance_epoch);
        assert_eq!(event.session_id, self.session.id);
        assert_eq!(Some(event.session_epoch), self.session.session_epoch);
    }
}

fn reference_target(reference: &ObjectRef) -> Target {
    Target {
        host_id: reference.host_id.clone(),
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        session_id: None,
        session_epoch: None,
    }
}

async fn probe_action(
    fixture: &Fixture,
    client: &HostClient,
    target: &Target,
    action: &str,
    params: serde_json::Value,
) -> Operation {
    let accepted = fixture
        .invoke(client, fixture.call(client, target, action, params))
        .await;
    let settled = fixture.wait(client, &accepted.operation_id).await;
    assert_eq!(
        settled.state,
        OperationState::Succeeded,
        "{action}: {settled:?}"
    );
    settled
}

async fn raw_query(raw: &RawConnection, query: Query) -> QueryResult {
    let reply = raw.request(RpcRequest::Query(query)).await.unwrap();
    let RpcReply::Success { result, .. } = reply else {
        panic!("Raw query failed: {reply:?}");
    };
    let RpcResult::Query(value) = *result else {
        panic!("Expected Raw query result");
    };
    value
}
