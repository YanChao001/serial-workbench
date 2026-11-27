use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    ipc::HostServer,
    storage::Store,
};
use sha2::Digest as _;
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;
#[path = "support/experiment_browser.rs"]
mod experiment_browser;
#[path = "support/hold_send_browser.rs"]
mod hold_send_browser;
#[path = "support/mapped_capture_browser.rs"]
mod mapped_capture_browser;
#[path = "support/million_row_workload.rs"]
mod million_row_workload;
#[path = "support/operation_source_host.rs"]
mod operation_source_host;
#[path = "support/replay_search_host.rs"]
mod replay_search_host;
mod support;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct Fixture {
    dir: tempfile::TempDir,
    user: HostClient,
    control: HostClient,
    observer: HostClient,
    operator: AuthenticatedActor,
    auth: AuthService,
    store: Store,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_bundled_packages(false).await
    }
    async fn with_bundled_packages(bundled: bool) -> Self {
        Self::with_runtime(bundled, None).await
    }
    async fn with_runtime(
        bundled: bool,
        runtime: Option<serial_workbench_host::node_runtime::VerifiedNodeRuntime>,
    ) -> Self {
        Self::with_device(bundled, runtime, None).await
    }
    async fn with_device(
        bundled: bool,
        runtime: Option<serial_workbench_host::node_runtime::VerifiedNodeRuntime>,
        opener: Option<serial_workbench_host::device::TransportOpener>,
    ) -> Self {
        let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        if runtime.is_some() {
            let provision = HostServer::bind(dir.path()).await.unwrap();
            let startup =
                serial_workbench_ipc::startup_config::resolve(Some(dir.path().into())).unwrap();
            Host::with_startup_config(provision.store(), provision.auth(), startup.snapshot())
                .await
                .unwrap()
                .shutdown()
                .await
                .unwrap();
        }
        let mut server = HostServer::bind(dir.path()).await.unwrap();
        let store = server.store();
        let auth = server.auth();
        let secret =
            serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
                .unwrap()
                .unwrap();
        let credential = ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap();
        let operator = auth
            .authenticate_user_control(&id("capture-user"), &credential)
            .unwrap();
        let host = if let Some(runtime) = runtime {
            Host::with_verified_node_runtime_native(
                store.clone(),
                auth.clone(),
                Arc::new(serial_workbench_host::clock::SystemClock::new().unwrap()),
                runtime,
            )
            .await
            .unwrap()
        } else if let Some(opener) = opener {
            Host::with_runtime(
                store.clone(),
                auth.clone(),
                Arc::new(serial_workbench_host::clock::SystemClock::new().unwrap()),
                opener,
            )
            .await
            .unwrap()
        } else if bundled {
            let startup =
                serial_workbench_ipc::startup_config::resolve(Some(dir.path().to_path_buf()))
                    .unwrap();
            Host::with_startup_config(store.clone(), auth.clone(), startup.snapshot())
                .await
                .unwrap()
        } else {
            Host::new(store.clone(), auth.clone()).await.unwrap()
        };
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        let mut options =
            ConnectOptions::new(dir.path().into(), id("capture-user"), ClientKind::Desktop);
        options.user_control_credential = Some(credential);
        let control = HostClient::connect(options).await.unwrap();
        let user = HostClient::connect(ConnectOptions::new(
            dir.path().into(),
            id("capture-user"),
            ClientKind::Desktop,
        ))
        .await
        .unwrap();
        let host_target = Target {
            host_id: user.attachment().host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: user.attachment().host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: user.attachment().client_id.clone(),
                permissions: vec![
                    "metadata.read".into(),
                    "content.read".into(),
                    "device.modify".into(),
                    "workspace.modify".into(),
                ],
                targets: vec![host_target],
                expires_at: None,
            },
        )
        .unwrap();
        let observer = HostClient::connect(ConnectOptions::new(
            dir.path().into(),
            id("capture-observer"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        Self {
            dir,
            user,
            control,
            observer,
            operator,
            auth,
            store,
            stop,
            running,
        }
    }
    fn target(&self, kind: &str, name: &str) -> Target {
        Target {
            host_id: self.user.attachment().host_id.clone(),
            kind: ResourceKind::try_from(kind).unwrap(),
            id: id(name),
            session_id: None,
            session_epoch: None,
        }
    }
    fn reference_target(&self, reference: &ObjectRef) -> Target {
        self.target(reference.kind.as_str(), reference.id.as_str())
    }
    fn host(&self) -> Target {
        self.target("host", self.user.attachment().host_id.as_str())
    }
    fn query(&self, client: &HostClient, action: &str, target: Target, params: Value) -> Query {
        let a = client.attachment();
        Query {
            protocol_version: ProtocolVersion::V1_0,
            host_id: a.host_id.clone(),
            instance_epoch: a.instance_epoch,
            actor_id: a.actor_id.clone(),
            request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
            action_id: id(action),
            target,
            params: serde_json::from_value(params).unwrap(),
            reveal_target: RevealTarget {
                page_id: id("workbench"),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
        }
    }
    fn call(&self, client: &HostClient, action: &str, target: Target, params: Value) -> Call {
        let q = self.query(client, action, target, params);
        Call {
            protocol_version: q.protocol_version,
            host_id: q.host_id,
            instance_epoch: q.instance_epoch,
            actor_id: q.actor_id,
            request_id: q.request_id,
            request_context: client.attachment().request_context.clone(),
            action_id: q.action_id,
            target: q.target,
            params: q.params,
            reveal_target: q.reveal_target,
            expected_revision: None,
            lease_id: None,
            execution_mode: (action == "capture.start").then_some(ExecutionMode::Independent),
            workspace_startup: None,
        }
    }
    async fn invoke(
        &self,
        client: &HostClient,
        action: &str,
        target: Target,
        params: Value,
    ) -> Operation {
        let RpcResult::Operation(result) = success(
            client
                .request(RpcRequest::Invoke(
                    self.call(client, action, target, params),
                ))
                .await
                .unwrap(),
        ) else {
            panic!("operation reply")
        };
        result.operation
    }
    async fn wait(&self, operation: &Operation, evidence_only: bool) -> Operation {
        self.wait_with_timeout(operation, evidence_only, Duration::from_secs(15))
            .await
    }
    async fn wait_with_timeout(
        &self,
        operation: &Operation,
        evidence_only: bool,
        timeout: Duration,
    ) -> Operation {
        tokio::time::timeout(timeout, async {
            loop {
                let current = self
                    .store
                    .get(&self.operator, &operation.operation_id)
                    .unwrap();
                if !matches!(
                    current.state,
                    OperationState::Queued
                        | OperationState::Running
                        | OperationState::CancelRequested
                ) || (evidence_only && current.result.is_some())
                {
                    return current;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .unwrap_or_else(|error| {
            let state = self
                .store
                .get(&self.operator, &operation.operation_id)
                .map(|current| current.state);
            panic!(
                "{} operation {} did not settle: {error}; latest state: {state:?}",
                operation.action_id, operation.operation_id
            )
        })
    }
    async fn action(
        &self,
        client: &HostClient,
        action: &str,
        target: Target,
        params: Value,
    ) -> Operation {
        let accepted = self.invoke(client, action, target, params).await;
        self.wait(&accepted, false).await
    }
    async fn rejected_action(&self, action: &str, target: Target, params: Value) -> HostError {
        let reply = self
            .user
            .request(RpcRequest::Invoke(
                self.call(&self.user, action, target, params),
            ))
            .await
            .unwrap();
        match reply {
            RpcReply::Failure { error, .. } => error,
            reply => {
                let RpcResult::Operation(accepted) = success(reply) else {
                    panic!("operation")
                };
                self.wait(&accepted.operation, false)
                    .await
                    .error
                    .expect("action must be rejected")
            }
        }
    }
    async fn register(&self, name: &str) -> ObjectRef {
        let result = self.action(&self.control, "file.register", self.host(), json!({"path":self.dir.path().join(name).to_str().unwrap(),"purpose":"capture_target"})).await;
        assert_eq!(
            result.state,
            OperationState::Succeeded,
            "{:?}",
            result.error
        );
        let Some(ActionResult::FileMetadata(metadata)) = result.result else {
            panic!("file metadata")
        };
        metadata.file_ref
    }
    async fn open(&self) -> Target {
        let operation = self
            .action(
                &self.user,
                "device.open",
                self.target("device", "virtual:echo"),
                json!({"configuration":SerialConfiguration::default()}),
            )
            .await;
        assert_eq!(
            operation.state,
            OperationState::Succeeded,
            "{:?}",
            operation.error
        );
        let Some(ActionResult::Opened(opened)) = operation.result else {
            panic!("opened")
        };
        let mut target = self.target("session", opened.session_id.as_str());
        target.session_id = Some(opened.session_id);
        target.session_epoch = Some(opened.session_epoch);
        target
    }
    async fn start(
        &self,
        client: &HostClient,
        session: &Target,
        destination: &ObjectRef,
    ) -> (Operation, ObjectRef) {
        let operation = self
            .invoke(
                client,
                "capture.start",
                self.reference_target(destination),
                json!({"sessionRefs":[session],"targetRef":destination,"overflowPolicy":"stop"}),
            )
            .await;
        let current = self.wait(&operation, true).await;
        assert_eq!(
            current.state,
            OperationState::Running,
            "capture start: {:?}",
            current.error
        );
        let Some(ActionResult::Reference(reference)) = current.result else {
            panic!("live ref evidence")
        };
        (operation, reference.result_ref)
    }
    async fn wait_written(&self, live: &ObjectRef, minimum: u64) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let request = RpcRequest::Query(self.query(
                    &self.user,
                    "capture.status",
                    self.reference_target(live),
                    json!({"captureRef":live}),
                ));
                let RpcResult::Query(QueryResult::CaptureStatus(status)) =
                    success(self.user.request(request).await.unwrap())
                else {
                    panic!("capture status expected");
                };
                if status.summary.watermarks.written.get() >= minimum {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("capture did not reach the expected written watermark");
    }
    async fn stop_capture(&self, owner: &Operation, live: &ObjectRef) -> CaptureStatusResult {
        let stop = self
            .action(
                &self.user,
                "capture.stop",
                self.reference_target(live),
                json!({"captureRef":live}),
            )
            .await;
        assert_eq!(stop.state, OperationState::Succeeded, "{:?}", stop.error);
        let settled = self.wait(owner, false).await;
        let Some(ActionResult::CaptureStatus(status)) = settled.result else {
            panic!("fixed capture expected: {:?}", settled.error);
        };
        assert_eq!(
            settled.state,
            OperationState::Succeeded,
            "{:?}",
            settled.error
        );
        status
    }
    fn grant(&self, permission: &str, target: Target) {
        self.auth
            .authorize(
                &self.operator,
                AuthorizeParams {
                    client_id: self.observer.attachment().client_id.clone(),
                    permissions: vec![permission.into()],
                    targets: vec![target],
                    expires_at: None,
                },
            )
            .unwrap();
    }
    async fn finish(self) {
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
    }
}
fn success(reply: RpcReply) -> RpcResult {
    let RpcReply::Success { result, .. } = reply else {
        panic!("expected success: {reply:?}")
    };
    *result
}
fn failure(reply: RpcReply) -> HostError {
    let RpcReply::Failure { error, .. } = reply else {
        panic!("expected failure: {reply:?}")
    };
    error
}

#[tokio::test]
async fn redaction_preview_only_returns_the_transformed_sample_to_its_requester() {
    let f = Fixture::new().await;
    let query =
        |params| RpcRequest::Query(f.query(&f.user, "capture.redactionPreview", f.host(), params));
    const EXAMPLE: &str = "recorded-example-private-token";
    let reply = f
        .user
        .request(query(json!({
            "sample":format!("设备=7 token={EXAMPLE}\r\nphone=13800000000\nstate=ready"),
            "rules":[
                {"pattern":"token=[^ ]+","replacement":"token=[hidden]"},
                {"pattern":"phone=[0-9]+","replacement":"phone=$1"}
            ],
        })))
        .await
        .unwrap();
    let RpcResult::Query(QueryResult::CaptureRedactionPreview(result)) = success(reply) else {
        panic!("expected redaction preview");
    };
    assert_eq!(
        result.text,
        "设备=7 token=[hidden]\r\nphone=$1\nstate=ready"
    );
    assert_eq!(result.replacements.get(), 2);

    let invalid = f
        .user
        .request(query(json!({
            "sample":EXAMPLE,
            "rules":[{"pattern":format!("(?={EXAMPLE})"),"replacement":""}],
        })))
        .await
        .unwrap();
    let error = failure(invalid);
    assert_eq!(error.code, "INVALID_ARGUMENT");
    assert_eq!(
        serde_json::to_value(&error.details).unwrap(),
        json!({"ruleIndex":1}),
    );
    assert!(!serde_json::to_string(&error).unwrap().contains(EXAMPLE));

    let expansive = f
        .user
        .request(query(json!({
            "sample":"a".repeat(400),
            "rules":[{"pattern":"a","replacement":"b".repeat(128)}],
        })))
        .await
        .unwrap();
    assert_eq!(failure(expansive).code, "LIMIT_EXCEEDED");
    for file in ["state.sqlite3", "state.sqlite3-wal"] {
        match std::fs::read(f.dir.path().join("host-v0").join(file)) {
            Ok(bytes) => assert!(
                !bytes
                    .windows(EXAMPLE.len())
                    .any(|part| part == EXAMPLE.as_bytes())
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => panic!("cannot inspect test profile: {error}"),
        }
    }
    f.finish().await;
}

#[tokio::test]
async fn redacted_recording_writes_only_transformed_lines_and_omissions() {
    verify_redacted_recording(None).await;
}

#[tokio::test]
#[ignore = "Requires SWB_TEST_CAPTURE_NODE_BIN pointing to the repository Node executable"]
async fn redacted_host_archive_passes_independent_readback() {
    let node = std::env::var_os("SWB_TEST_CAPTURE_NODE_BIN").expect("missing test Node executable");
    let node = std::path::PathBuf::from(node);
    assert!(node.is_absolute() && node.is_file());
    verify_redacted_recording(Some(&node)).await;
}

async fn verify_redacted_recording(node: Option<&std::path::Path>) {
    let f = Fixture::new().await;
    let session = f.open().await;
    let invalid = f.register("refuse-unconfigured-redaction").await;
    let failed = f.action(
        &f.user, "capture.start", f.reference_target(&invalid),
        json!({"sessionRefs":[session],"targetRef":invalid,"mode":"redacted","overflowPolicy":"stop"}),
    ).await;
    assert_eq!(failed.error.unwrap().code, "INVALID_ARGUMENT");
    assert!(!f.dir.path().join("refuse-unconfigured-redaction").exists());

    let destination = f.register("capture").await;
    const POLICY_LITERAL: &str = "private-policy-input-canary";
    let rules = json!([
        {"pattern":"token=[^ ]+", "replacement":"token=[hidden]"},
        {"pattern":POLICY_LITERAL, "replacement":"unused"}
    ]);
    let chunks: [&[u8]; 3] = [b"board \xe8\xae", b"\xbe token=CARRY", b"-SECRET\r\n"];
    let byte_end = chunks.iter().map(|chunk| chunk.len() as u64).sum::<u64>();
    if node.is_some() {
        let attachment = f.user.attachment();
        let records = ["rx", "tx"].map(|direction| {
            json!({
                "direction":direction, "start":"0", "end":byte_end.to_string(),
                "text":"board 设 token=[hidden]", "replacements":"1",
            })
        });
        let expected = json!({
            "fixtureVersion":"virtual-echo-redacted-1", "mode":"redacted", "minimumVolumes":1,
            "streams":[{
                "hostId":attachment.host_id, "instanceEpoch":attachment.instance_epoch,
                "sessionId":session.session_id, "sessionEpoch":session.session_epoch,
            }],
            "rules":rules,
            "records":records,
            "rawPayloads":[], "finalReceipts":[],
        });
        std::fs::write(
            f.dir.path().join("expected.json"),
            serde_json::to_vec(&expected).unwrap(),
        )
        .unwrap();
    }
    let owner = f
        .invoke(
            &f.user,
            "capture.start",
            f.reference_target(&destination),
            json!({
                "sessionRefs":[session],
                "targetRef":destination,
                "mode":"redacted",
                "overflowPolicy":"stop",
                "redactionRules":rules,
            }),
        )
        .await;
    let running = f.wait(&owner, true).await;
    let Some(ActionResult::Reference(reference)) = running.result else {
        panic!("redacted capture did not start: {:?}", running.error);
    };
    let live = reference.result_ref;
    for chunk in chunks {
        let sent = f
            .action(
                &f.user,
                "session.tx",
                session.clone(),
                json!({"bytesBase64":STANDARD.encode(chunk),"writeWaitMs":"1000"}),
            )
            .await;
        assert_eq!(sent.state, OperationState::Succeeded, "{:?}", sent.error);
    }
    f.wait_written(&live, 2).await;
    let status = f.stop_capture(&owner, &live).await;
    let fixed = status.capture_ref;
    assert_eq!(status.summary.mode, CaptureMode::Redacted);
    assert_eq!(status.summary.watermarks.verified.get(), 2);
    let directory = f.dir.path().join("capture");
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(directory.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["formatVersion"], "0.3");
    assert_eq!(manifest["mode"], "redacted");
    assert_eq!(manifest["redactionDigest"].as_str().unwrap().len(), 64);
    assert_eq!(manifest["redactionResume"].as_array().unwrap().len(), 1);
    if let Some(node) = node {
        let output_dir = tempfile::tempdir().unwrap();
        let report = output_dir.path().join("readback.json");
        let reader = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/test-capture-container-independent.mjs");
        let mut command = tokio::process::Command::new(node);
        command
            .arg(reader)
            .arg("--fixture")
            .arg(f.dir.path())
            .arg("--result")
            .arg(&report)
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(15), command.output())
            .await
            .expect("independent reader timed out")
            .expect("could not launch independent reader");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: Value = serde_json::from_slice(&std::fs::read(report).unwrap()).unwrap();
        assert_eq!(report["status"], "passed");
        assert_eq!(report["recordCount"], 2);
        assert_eq!(report["redactionDigest"], manifest["redactionDigest"]);
    }

    for entry in std::fs::read_dir(&directory).unwrap() {
        let entry = entry.unwrap();
        let bytes = std::fs::read(entry.path()).unwrap();
        for private in [b"CARRY".as_slice(), b"-SECRET", POLICY_LITERAL.as_bytes()] {
            assert!(!bytes.windows(private.len()).any(|part| part == private));
        }
        for chunk in chunks {
            let encoded = STANDARD.encode(chunk);
            assert!(
                !bytes
                    .windows(encoded.len())
                    .any(|part| part == encoded.as_bytes())
            );
        }
    }
    for name in ["state.sqlite3", "state.sqlite3-wal"] {
        let path = f.dir.path().join("host-v0").join(name);
        if path.exists() {
            let bytes = std::fs::read(path).unwrap();
            assert!(
                !bytes
                    .windows(POLICY_LITERAL.len())
                    .any(|part| part == POLICY_LITERAL.as_bytes())
            );
        }
    }
    let verification = f
        .action(
            &f.user,
            "capture.verify",
            f.reference_target(&fixed),
            json!({"captureRef":fixed}),
        )
        .await;
    let Some(ActionResult::CaptureVerification(verification)) = verification.result else {
        panic!("verify failed: {:?}", verification.error);
    };
    assert!(verification.container_complete);
    assert_eq!(verification.mode, CaptureMode::Redacted);
    let tail_request = |client| {
        RpcRequest::Query(f.query(
            client,
            "capture.tail",
            f.reference_target(&fixed),
            json!({"captureRef":fixed}),
        ))
    };
    let observer_raw = f.observer.connect_raw().await.unwrap();
    assert_eq!(
        failure(
            observer_raw
                .request(tail_request(&f.observer))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED",
    );
    f.grant("content.read", f.reference_target(&destination));
    assert!(matches!(
        success(
            observer_raw
                .request(tail_request(&f.observer))
                .await
                .unwrap()
        ),
        RpcResult::Query(QueryResult::CaptureTail(_))
    ));
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.reference_target(&destination)],
            },
        )
        .unwrap();
    assert_eq!(
        failure(
            observer_raw
                .request(tail_request(&f.observer))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED",
    );

    let raw = f.user.connect_raw().await.unwrap();
    let RpcResult::Query(QueryResult::CaptureTail(tail)) =
        success(raw.request(tail_request(&f.user)).await.unwrap())
    else {
        panic!("capture tail expected");
    };
    let playback = f
        .action(
            &f.user,
            "replay.open",
            f.reference_target(&fixed),
            json!({"captureRef":fixed,"mode":"fastest"}),
        )
        .await;
    let Some(ActionResult::Opened(playback)) = playback.result else {
        panic!("redacted replay did not open: {:?}", playback.error);
    };
    let mut replay_target = f.target("session", playback.session_id.as_str());
    replay_target.session_id = Some(playback.session_id.clone());
    replay_target.session_epoch = Some(playback.session_epoch);
    let search = f.query(
        &f.user,
        "replay.search",
        replay_target.clone(),
        json!({
            "sessionId":playback.session_id,
            "sessionEpoch":playback.session_epoch,
            "command":{
                "kind":"start",
                "searchId":"a6b21411-cf47-472c-98d4-79482bd9d433",
                "bytesBase64":STANDARD.encode("[hidden]"),
                "direction":"rx"
            }
        }),
    );
    assert_eq!(
        failure(raw.request(RpcRequest::Query(search)).await.unwrap()).code,
        "UNSUPPORTED_CAPABILITY",
    );
    let read = f.query(
        &f.user,
        "replay.read",
        replay_target,
        json!({"sessionId":playback.session_id,"sessionEpoch":playback.session_epoch,
               "maxRecords":"100","maxBytes":"65536"}),
    );
    let RpcResult::Query(QueryResult::ReplayRead(page)) =
        success(raw.request(RpcRequest::Query(read)).await.unwrap())
    else {
        panic!("redacted replay page expected");
    };
    assert_eq!(page.records, tail.records);
    assert_eq!(tail.mode, CaptureMode::Redacted);
    assert_eq!(page.mode, CaptureMode::Redacted);
    let mut directions = Vec::new();
    for record in tail.records {
        let ReplayRecord::Inline { record } = record else {
            panic!("bounded record expected");
        };
        let CaptureEntry::Redacted(record) = record.entry else {
            panic!("private container entry");
        };
        let CaptureRedactedResult::Text { text, replacements } = record.result else {
            panic!("expected complete transformed line");
        };
        assert_eq!(text, "board 设 token=[hidden]");
        assert_eq!(replacements.get(), 1);
        let range = record.byte_range.unwrap();
        assert_eq!(range.start.get(), 0);
        assert_eq!(range.end.get(), byte_end);
        if range.direction == Direction::Tx {
            assert!(record.event_end.get() > record.event_start.get() + 1);
        }
        directions.push(range.direction);
    }
    assert_eq!(directions.len(), 2);
    assert!(directions.contains(&Direction::Tx) && directions.contains(&Direction::Rx));

    let text_target = f.register("redacted-export.csv").await;
    let export = f
        .action(
            &f.user,
            "capture.export",
            f.reference_target(&fixed),
            json!({"captureRef":fixed,"targetRef":text_target,"format":"csv"}),
        )
        .await;
    assert_eq!(
        export.state,
        OperationState::Succeeded,
        "{:?}",
        export.error
    );
    let csv = std::fs::read_to_string(f.dir.path().join("redacted-export.csv")).unwrap();
    assert!(csv.contains("board 设 token=[hidden]"));
    assert!(!csv.contains("CARRY") && !csv.contains("-SECRET"));

    let recovered_target = f.register("redacted-recovery").await;
    let recovered = f
        .action(
            &f.user,
            "capture.recover",
            f.reference_target(&recovered_target),
            json!({
                "verificationId":verification.verification_id,
                "sourceFingerprint":verification.source_fingerprint,
                "targetRef":recovered_target
            }),
        )
        .await;
    assert_eq!(
        recovered.state,
        OperationState::Succeeded,
        "{:?}",
        recovered.error
    );
    let recovered: Value = serde_json::from_slice(
        &std::fs::read(f.dir.path().join("redacted-recovery/manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(recovered["mode"], manifest["mode"]);
    assert_eq!(recovered["redactionDigest"], manifest["redactionDigest"]);
    assert!(recovered.get("redactionResume").is_none());
    f.finish().await;
}

#[tokio::test]
async fn redacted_replacement_verifies_old_fingerprint_and_archives_exact_prior_capture() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let name = "replace-capture";
    let path = f.dir.path().join(name);
    let destination = f.register(name).await;
    let (first, live) = f.start(&f.user, &session, &destination).await;
    let prior = f
        .action(
            &f.user,
            "session.tx",
            session.clone(),
            json!({"bytesBase64":STANDARD.encode(b"prior raw payload\n"),"writeWaitMs":"1000"}),
        )
        .await;
    assert_eq!(prior.state, OperationState::Succeeded, "{:?}", prior.error);
    f.wait_written(&live, 3).await;
    let original = f.stop_capture(&first, &live).await;
    assert_eq!(original.summary.mode, CaptureMode::Raw);
    let expected = original.summary.source_fingerprint.unwrap();
    let directory_contents = |path: &std::path::Path| {
        std::fs::read_dir(path)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (entry.file_name(), std::fs::read(entry.path()).unwrap())
            })
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    let original_files = directory_contents(&path);
    assert!(original_files.len() >= 3);
    let destination = f.register(name).await;
    let replacement = |fingerprint: &str| {
        json!({
            "sessionRefs":[session], "targetRef":destination, "mode":"redacted",
            "overflowPolicy":"stop", "writeMode":"replace", "expectedFingerprint":fingerprint,
            "redactionRules":[{"pattern":"token=[^ ]+", "replacement":"token=[hidden]"}],
        })
    };
    let stale = f
        .action(
            &f.user,
            "capture.start",
            f.reference_target(&destination),
            replacement(&"0".repeat(64)),
        )
        .await;
    assert_eq!(stale.error.unwrap().code, "SOURCE_CHANGED");
    assert_eq!(directory_contents(&path), original_files);
    let owner = f
        .invoke(
            &f.user,
            "capture.start",
            f.reference_target(&destination),
            replacement(expected.as_str()),
        )
        .await;
    let running = f.wait(&owner, true).await;
    let Some(ActionResult::Reference(live)) = running.result else {
        panic!("redacted replacement did not start: {:?}", running.error);
    };
    let live = live.result_ref;
    let sent = f
        .action(
            &f.user,
            "session.tx",
            session,
            json!({"bytesBase64":STANDARD.encode(b"discarded boundary\nnew token=SECOND-CANARY\n"),"writeWaitMs":"1000"}),
        )
        .await;
    assert_eq!(sent.state, OperationState::Succeeded, "{:?}", sent.error);
    f.wait_written(&live, 4).await;
    assert_eq!(directory_contents(&path), original_files);
    let fixed = f.stop_capture(&owner, &live).await;
    assert_eq!(fixed.summary.mode, CaptureMode::Redacted);
    assert_ne!(fixed.capture_ref.id, original.capture_ref.id);
    assert_ne!(fixed.summary.source_fingerprint.as_ref(), Some(&expected));

    let archives: Vec<_> = std::fs::read_dir(f.dir.path())
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("capture-archive-")
        })
        .collect();
    assert_eq!(archives.len(), 1);
    assert_eq!(directory_contents(&archives[0].path()), original_files);
    for bytes in directory_contents(&path).values() {
        assert!(
            !bytes
                .windows(b"SECOND-CANARY".len())
                .any(|part| part == b"SECOND-CANARY")
        );
    }
    let query = f.query(
        &f.user,
        "capture.tail",
        f.reference_target(&fixed.capture_ref),
        json!({"captureRef":fixed.capture_ref}),
    );
    let connection = f.user.connect_raw().await.unwrap();
    let RpcResult::Query(QueryResult::CaptureTail(tail)) =
        success(connection.request(RpcRequest::Query(query)).await.unwrap())
    else {
        panic!("replacement tail expected");
    };
    let mut text_directions = Vec::new();
    let mut boundaries = 0;
    for record in tail.records {
        let ReplayRecord::Inline { record } = record else {
            panic!("inline replacement record expected");
        };
        let CaptureEntry::Redacted(record) = record.entry else {
            panic!("raw entry in replacement capture");
        };
        match record.result {
            CaptureRedactedResult::Text { text, replacements } => {
                assert_eq!(text, "new token=[hidden]");
                assert_eq!(replacements.get(), 1);
                text_directions.push(record.byte_range.unwrap().direction);
            }
            CaptureRedactedResult::Omitted { reason } => {
                assert_eq!(reason, CaptureRedactionOmission::Boundary);
                boundaries += 1;
            }
        }
    }
    assert_eq!(boundaries, 2);
    assert_eq!(text_directions.len(), 2);
    assert!(text_directions.contains(&Direction::Rx) && text_directions.contains(&Direction::Tx));
    f.finish().await;
}

#[tokio::test]
async fn trusted_capture_keeps_independent_owner_after_client_disconnect_and_replays_raw() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("private-capture-location").await;
    let transient = f.user.reconnect().await.unwrap();
    let (owner, live) = f.start(&transient, &session, &destination).await;
    drop(transient);
    let tx = f
        .action(
            &f.user,
            "session.tx",
            session.clone(),
            json!({"bytesBase64":"AQID","writeWaitMs":"100"}),
        )
        .await;
    assert_eq!(tx.state, OperationState::Succeeded);
    // Wait for real writer evidence rather than sleeping and assuming RX was captured.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = success(
                f.user
                    .request(RpcRequest::Query(f.query(
                        &f.user,
                        "capture.status",
                        f.reference_target(&live),
                        json!({"captureRef":live}),
                    )))
                    .await
                    .unwrap(),
            );
            let status = serde_json::to_value(status).unwrap();
            let written = status
                .pointer("/value/value/summary/watermarks/written")
                .or_else(|| status.pointer("/value/summary/watermarks/written"))
                .and_then(Value::as_str)
                .unwrap_or("0")
                .parse::<u64>()
                .unwrap();
            if written > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .unwrap();
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
    assert_eq!(stop.state, OperationState::Succeeded, "{:?}", stop.error);
    let owner = f.wait(&owner, false).await;
    assert_eq!(owner.state, OperationState::Succeeded, "{:?}", owner.error);
    let body = serde_json::to_value(owner.result.unwrap()).unwrap();
    let fixed: ObjectRef = serde_json::from_value(body["value"]["captureRef"].clone()).unwrap();
    assert!(fixed.revision.is_some());
    assert!(
        !serde_json::to_string(&body)
            .unwrap()
            .contains("private-capture-location")
    );
    let verified = f
        .action(
            &f.user,
            "capture.verify",
            f.reference_target(&fixed),
            json!({"captureRef":fixed}),
        )
        .await;
    assert_eq!(
        verified.state,
        OperationState::Succeeded,
        "{:?}",
        verified.error
    );
    let Some(ActionResult::CaptureVerification(verification)) = verified.result else {
        panic!("verification report")
    };
    assert!(verification.container_complete);
    let exported_target = f.register("exported-text.jsonl").await;
    let exported = f
        .action(
            &f.user,
            "capture.export",
            f.reference_target(&fixed),
            json!({"captureRef":fixed,"targetRef":exported_target}),
        )
        .await;
    assert_eq!(
        exported.state,
        OperationState::Succeeded,
        "{:?}",
        exported.error
    );
    let Some(ActionResult::Reference(exported)) = exported.result else {
        panic!("export reference")
    };
    assert!(exported.result_ref.revision.is_some());

    let csv_target = f.register("exported-text.csv").await;
    let csv = f
        .action(
            &f.user,
            "capture.export",
            f.reference_target(&fixed),
            json!({"captureRef":fixed,"targetRef":csv_target,"format":"csv"}),
        )
        .await;
    assert_eq!(csv.state, OperationState::Succeeded, "{:?}", csv.error);
    let Some(ActionResult::Reference(csv)) = csv.result else {
        panic!("CSV export reference")
    };
    assert!(csv.result_ref.revision.is_some());
    let raw = f.user.connect_raw().await.unwrap();
    let read = f.query(
        &f.user,
        "file.read",
        f.reference_target(&csv.result_ref),
        json!({"fileRef":csv.result_ref,"offset":"0","maxBytes":"65536"}),
    );
    let RpcResult::Query(QueryResult::FileRead(page)) =
        success(raw.request(RpcRequest::Query(read)).await.unwrap())
    else {
        panic!("CSV bytes")
    };
    assert!(page.at_end);
    let bytes = STANDARD.decode(page.bytes_base64.as_str()).unwrap();
    assert!(bytes.starts_with(b"recordOrdinal,volume,recordOffset,recordLength,"));
    assert!(bytes.ends_with(b"\r\n"));
    let published = std::fs::read(f.dir.path().join("exported-text.csv")).unwrap();
    assert_eq!(bytes, published);
    assert_eq!(
        page.fingerprint.as_str(),
        format!("{:x}", sha2::Sha256::digest(&published))
    );

    let recovery_target = f.register("recovered-copy").await;
    let recovered=f.action(&f.user,"capture.recover",f.reference_target(&recovery_target),json!({"verificationId":verification.verification_id,"sourceFingerprint":verification.source_fingerprint,"targetRef":recovery_target})).await;
    assert_eq!(
        recovered.state,
        OperationState::Succeeded,
        "{:?}",
        recovered.error
    );
    let Some(ActionResult::Reference(recovered)) = recovered.result else {
        panic!("recovered reference")
    };
    assert!(recovered.result_ref.revision.is_some());
    let opened = f
        .action(
            &f.user,
            "replay.open",
            f.reference_target(&fixed),
            json!({"captureRef":fixed,"mode":"fastest"}),
        )
        .await;
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("replay opened: {:?}", opened.error)
    };
    let mut replay = f.target("session", opened.session_id.as_str());
    replay.session_id = Some(opened.session_id.clone());
    replay.session_epoch = Some(opened.session_epoch);
    let query=f.query(&f.user,"replay.read",replay.clone(),json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"maxRecords":"100","maxBytes":"262144"}));
    assert_eq!(
        failure(
            f.user
                .request(RpcRequest::Query(query.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    let records = success(raw.request(RpcRequest::Query(query)).await.unwrap());
    assert!(serde_json::to_string(&records).unwrap().contains("AQID"));
    let shared=f.query(&f.observer,"replay.read",replay.clone(),json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"maxRecords":"100","maxBytes":"262144"}));
    let observer_raw = f.observer.connect_raw().await.unwrap();
    assert_eq!(
        failure(
            observer_raw
                .request(RpcRequest::Query(shared.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    f.grant("content.read", f.reference_target(&destination));
    let reset=f.action(&f.user,"replay.control",replay.clone(),json!({"sessionId":opened.session_id,"sessionEpoch":opened.session_epoch,"paused":false,"seekRecord":"1"})).await;
    assert_eq!(reset.state, OperationState::Succeeded, "{:?}", reset.error);
    let shared_records = success(
        observer_raw
            .request(RpcRequest::Query(shared.clone()))
            .await
            .unwrap(),
    );
    assert!(
        serde_json::to_string(&shared_records)
            .unwrap()
            .contains("AQID")
    );
    let mut old = shared.clone();
    old.target.session_epoch = Some(2.into());
    old.params
        .insert("sessionEpoch".into(), JsonValue::String("2".into()));
    assert_eq!(
        failure(observer_raw.request(RpcRequest::Query(old)).await.unwrap()).code,
        "EPOCH_MISMATCH"
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.reference_target(&destination)],
            },
        )
        .unwrap();
    assert_eq!(
        failure(
            observer_raw
                .request(RpcRequest::Query(shared))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    let snapshot = success(
        f.user
            .request(RpcRequest::Query(f.query(
                &f.user,
                "session.get",
                replay.clone(),
                json!({}),
            )))
            .await
            .unwrap(),
    );
    assert!(
        serde_json::to_string(&snapshot)
            .unwrap()
            .contains("\"readOnly\":true")
    );
    for (action, params) in [
        (
            "session.tx",
            json!({"bytesBase64":"BA==","writeWaitMs":"100"}),
        ),
        (
            "session.configure",
            json!({"requested":SerialConfiguration::default()}),
        ),
        ("session.control", json!({"line":"dtr","value":true})),
    ] {
        assert_eq!(
            f.rejected_action(action, replay.clone(), params).await.code,
            "READ_ONLY"
        );
    }
    let closed = f.action(&f.user, "replay.close", replay, json!({})).await;
    assert_eq!(closed.state, OperationState::Succeeded);
    f.finish().await;
}

#[tokio::test]
async fn capture_status_requires_current_parent_permission_and_epoch() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("parent-authority").await;
    let (_, live) = f.start(&f.user, &session, &destination).await;
    // New clients receive Host-wide metadata.read. A narrower current denial
    // must override that default before we can test the saved parent scope.
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![f.reference_target(&destination)],
            },
        )
        .unwrap();
    let query = f.query(
        &f.observer,
        "capture.status",
        f.reference_target(&live),
        json!({"captureRef":live}),
    );
    assert_eq!(
        failure(
            f.observer
                .request(RpcRequest::Query(query.clone()))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    f.grant("metadata.read", f.reference_target(&destination));
    success(
        f.observer
            .request(RpcRequest::Query(query.clone()))
            .await
            .unwrap(),
    );
    let mut old = query.clone();
    old.instance_epoch = 0.into();
    assert_eq!(
        failure(f.observer.request(RpcRequest::Query(old)).await.unwrap()).code,
        "EPOCH_MISMATCH"
    );
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![f.reference_target(&destination)],
            },
        )
        .unwrap();
    assert_eq!(
        failure(f.observer.request(RpcRequest::Query(query)).await.unwrap()).code,
        "PERMISSION_DENIED"
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
    f.finish().await;
}

#[tokio::test]
async fn imported_capture_status_needs_only_metadata_and_omits_recording_owner() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("metadata-only-import").await;
    let (owner, live) = f.start(&f.user, &session, &destination).await;
    let stopped = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(
        stopped.state,
        OperationState::Succeeded,
        "{:?}",
        stopped.error
    );
    assert_eq!(f.wait(&owner, false).await.state, OperationState::Succeeded);
    let imported=f.action(&f.control,"file.register",f.host(),json!({"path":f.dir.path().join("metadata-only-import").to_str().unwrap(),"purpose":"capture_source"})).await;
    assert_eq!(
        imported.state,
        OperationState::Succeeded,
        "{:?}",
        imported.error
    );
    let Some(ActionResult::FileMetadata(imported)) = imported.result else {
        panic!("imported metadata")
    };
    f.grant("metadata.read", f.reference_target(&imported.file_ref));
    let status = success(
        f.observer
            .request(RpcRequest::Query(f.query(
                &f.observer,
                "capture.status",
                f.reference_target(&imported.file_ref),
                json!({"captureRef":imported.file_ref}),
            )))
            .await
            .unwrap(),
    );
    let RpcResult::Query(QueryResult::CaptureStatus(status)) = status else {
        panic!("capture status")
    };
    assert_eq!(status.owner_operation_id, None);
    assert!(status.capture_ref.revision.is_some());
    assert_eq!(status.summary.state, CaptureState::Complete);
    assert!(
        serde_json::to_value(status)
            .unwrap()
            .get("ownerOperationId")
            .is_none()
    );
    f.finish().await;
}

#[tokio::test]
async fn recording_survives_granting_read_access_to_its_destination() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("recording-read-grant").await;
    let destination_target = f.reference_target(&destination);
    let (owner, live) = f.start(&f.user, &session, &destination).await;
    let authorized = f
        .action(
            &f.control,
            "auth.authorize",
            f.host(),
            json!({
                "clientId": f.user.attachment().client_id,
                "permissions": ["content.read"],
                "targets": [destination_target]
            }),
        )
        .await;
    assert_eq!(
        authorized.state,
        OperationState::Succeeded,
        "{authorized:?}"
    );

    let tx = f
        .action(
            &f.user,
            "session.tx",
            session,
            json!({"bytesBase64":"AQID","writeWaitMs":"100"}),
        )
        .await;
    assert_eq!(tx.state, OperationState::Succeeded, "{tx:?}");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let current = f.store.get(&f.operator, &owner.operation_id).unwrap();
            assert_eq!(current.state, OperationState::Running, "{current:?}");
            let RpcResult::Query(QueryResult::CaptureStatus(status)) = success(
                f.user
                    .request(RpcRequest::Query(f.query(
                        &f.user,
                        "capture.status",
                        f.reference_target(&live),
                        json!({"captureRef":live}),
                    )))
                    .await
                    .unwrap(),
            ) else {
                panic!("Expected live capture status");
            };
            if status.summary.watermarks.written.get() >= 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Recording did not contain the RX after the read grant");
    let stopped = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(stopped.state, OperationState::Succeeded, "{stopped:?}");
    let finalized = f.wait(&owner, false).await;
    assert_eq!(finalized.state, OperationState::Succeeded, "{finalized:?}");
    let Some(ActionResult::CaptureStatus(status)) = finalized.result else {
        panic!("Expected completed capture");
    };
    assert!(status.summary.container_complete && status.summary.source_continuous);
    let raw = f.user.connect_raw().await.unwrap();
    let RpcResult::Query(QueryResult::CaptureTail(tail)) = success(
        raw.request(RpcRequest::Query(f.query(
            &f.user,
            "capture.tail",
            f.reference_target(&status.capture_ref),
            json!({"captureRef":status.capture_ref,"maxRecords":"32","maxBytes":"8192"}),
        )))
        .await
        .unwrap(),
    ) else {
        panic!("Expected completed capture tail");
    };
    assert!(tail.records.iter().any(|record| {
        let ReplayRecord::Inline { record } = record else {
            return false;
        };
        matches!(&record.entry, CaptureEntry::Event(event)
            if matches!(&event.payload, RawPayload::Rx(rx) if rx.bytes_base64.as_str() == "AQID"))
    }));
    raw.close().await.unwrap();
    f.finish().await;
}

#[tokio::test]
async fn revoking_either_recording_grant_stops_an_idle_capture() {
    for permission in ["content.read", "workspace.modify"] {
        let f = Fixture::new().await;
        let session = f.open().await;
        let destination = f.register("recording-revoked").await;
        let (owner, _) = f.start(&f.user, &session, &destination).await;
        let target = if permission == "content.read" {
            session
        } else {
            f.reference_target(&destination)
        };
        let revoked = f
            .action(
                &f.control,
                "auth.revoke",
                f.host(),
                json!({
                    "actorId": f.user.attachment().actor_id,
                    "permissions": [permission],
                    "targets": [target]
                }),
            )
            .await;
        assert_eq!(revoked.state, OperationState::Succeeded, "{revoked:?}");
        let settled = f.wait(&owner, false).await;
        assert_eq!(settled.state, OperationState::Failed, "{settled:?}");
        assert_eq!(settled.error.unwrap().code, "PERMISSION_DENIED");
        f.finish().await;
    }
}

#[tokio::test]
async fn capture_start_requires_explicit_independent_mode() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let target = f.register("explicit-independent").await;
    for mode in [None, Some(ExecutionMode::Interactive)] {
        let mut call = f.call(
            &f.user,
            "capture.start",
            f.reference_target(&target),
            json!({"sessionRefs":[session],"targetRef":target,"overflowPolicy":"stop"}),
        );
        call.execution_mode = mode;
        assert_eq!(
            failure(f.user.request(RpcRequest::Invoke(call)).await.unwrap()).code,
            "INVALID_ARGUMENT"
        );
    }
    assert!(!f.dir.path().join("explicit-independent").exists());
    f.finish().await;
}

#[tokio::test]
async fn running_capture_reports_synced_progress_without_replacing_live_reference() {
    let f = Fixture::new().await;
    let session = f.open().await;
    let destination = f.register("running-synced-progress").await;
    let (owner, live) = f.start(&f.user, &session, &destination).await;
    let RpcResult::Snapshot(snapshot) = success(
        f.user
            .request(RpcRequest::StateSnapshot(f.query(
                &f.user,
                "state.snapshot",
                f.host(),
                json!({"scopeId":"host.operations"}),
            )))
            .await
            .unwrap(),
    ) else {
        panic!("operation snapshot")
    };
    let RpcResult::Subscription(subscription) = success(
        f.user
            .request(RpcRequest::StateSubscribe(f.query(
                &f.user,
                "state.subscribe",
                f.host(),
                json!({"scopeId":"host.operations","after":snapshot.cursor}),
            )))
            .await
            .unwrap(),
    ) else {
        panic!("operation subscription")
    };
    let mut completed = 0u64;
    let mut revision = owner.revision;
    for payload in ["AQID", "BAUG"] {
        let tx = f
            .action(
                &f.user,
                "session.tx",
                session.clone(),
                json!({"bytesBase64":payload,"writeWaitMs":"100"}),
            )
            .await;
        assert_eq!(tx.state, OperationState::Succeeded, "{:?}", tx.error);
        let progress = tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let RpcResult::Query(QueryResult::CaptureStatus(status)) = success(
                    f.user
                        .request(RpcRequest::Query(f.query(
                            &f.user,
                            "capture.status",
                            f.reference_target(&live),
                            json!({"captureRef":live}),
                        )))
                        .await
                        .unwrap(),
                ) else {
                    panic!("capture status")
                };
                assert_eq!(status.summary.state, CaptureState::Recording);
                assert_eq!(status.owner_operation_id, Some(owner.operation_id.clone()));
                let current = f.store.get(&f.operator, &owner.operation_id).unwrap();
                assert_eq!(current.state, OperationState::Running);
                assert_eq!(
                    current.result,
                    Some(ActionResult::Reference(ResultReference {
                        result_ref: live.clone()
                    }))
                );
                if status.summary.watermarks.synced.get() > completed
                    && let Some(progress) = current.progress
                    && progress.completed == status.summary.watermarks.synced
                {
                    assert!(current.revision > revision);
                    revision = current.revision;
                    break progress;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("durable synced records must update the still-running owner before stop");
        assert_eq!(progress.unit, "records");
        assert_eq!(progress.total, None);
        completed = progress.completed.get();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame = f.user.next_event().await.unwrap().expect("operation event");
                let IpcMessage::Delta {
                    subscription_id,
                    delta,
                } = frame.body
                else {
                    continue;
                };
                if subscription_id != subscription.subscription_id {
                    continue;
                }
                let payload = serde_json::to_value(delta.payload).unwrap();
                let found = payload["items"].as_array().is_some_and(|items| {
                    items.iter().any(|item| {
                        item["operationId"] == json!(owner.operation_id)
                            && item["state"] == json!("running")
                            && item["progress"]["completed"]
                                .as_str()
                                .and_then(|v| v.parse::<u64>().ok())
                                .is_some_and(|value| value >= completed)
                            && item["progress"]["unit"] == json!("records")
                    })
                });
                if found {
                    break;
                }
            }
        })
        .await
        .expect("host.operations subscription must publish running capture progress");
    }
    success(
        f.user
            .request(RpcRequest::SubscriptionClose(f.query(
                &f.user,
                "subscription.close",
                f.host(),
                json!({"subscriptionId":subscription.subscription_id}),
            )))
            .await
            .unwrap(),
    );
    let stopped = f
        .action(
            &f.user,
            "capture.stop",
            f.reference_target(&live),
            json!({"captureRef":live}),
        )
        .await;
    assert_eq!(
        stopped.state,
        OperationState::Succeeded,
        "{:?}",
        stopped.error
    );
    assert_eq!(f.wait(&owner, false).await.state, OperationState::Succeeded);
    f.finish().await;
}

#[path = "support/capture_tail.rs"]
mod capture_tail;

#[tokio::test]
async fn recorded_peer_replays_confirmed_bytes_only_in_its_own_simulated_session() {
    let f = Fixture::new().await;
    let live_device = f.open().await;
    let raw = f.user.connect_raw().await.unwrap();
    let read_live_cursor = || async {
        let request = f.query(&f.user, "stream.cursor", live_device.clone(), json!({}));
        let RpcResult::Query(QueryResult::StreamCursor(value)) =
            success(raw.request(RpcRequest::Query(request)).await.unwrap())
        else {
            panic!("independent live cursor expected");
        };
        value.cursor
    };
    let source_name = "recorded-peer-source";
    let destination = f.register(source_name).await;
    let (owner, live) = f.start(&f.user, &live_device, &destination).await;
    let transmitted = f
        .action(
            &f.user,
            "session.tx",
            live_device.clone(),
            json!({"bytesBase64":"AQID","writeWaitMs":"100"}),
        )
        .await;
    assert_eq!(
        transmitted.state,
        OperationState::Succeeded,
        "{transmitted:?}"
    );
    f.wait_written(&live, 3).await;
    let second = f
        .action(
            &f.user,
            "session.tx",
            live_device.clone(),
            json!({"bytesBase64":"BAU=","writeWaitMs":"100"}),
        )
        .await;
    assert_eq!(second.state, OperationState::Succeeded, "{second:?}");
    f.wait_written(&live, 6).await;
    let verified = f.stop_capture(&owner, &live).await;
    let source = verified.capture_ref;
    let real_cursor = read_live_cursor().await;
    let root = f.reference_target(&source);
    let open =
        |action: &'static str, params: Value| f.action(&f.user, action, root.clone(), params);
    let playback = open("replay.open", json!({"captureRef":source,"mode":"fastest"})).await;
    assert_eq!(playback.state, OperationState::Succeeded, "{playback:?}");
    let peer_open = open("replay.peer.open", json!({"captureRef":source})).await;
    assert_eq!(peer_open.state, OperationState::Succeeded, "{peer_open:?}");
    let Some(ActionResult::Opened(opened)) = peer_open.result else {
        panic!("simulator session expected");
    };
    let mut peer = f.target("session", opened.session_id.as_str());
    peer.session_id = Some(opened.session_id);
    peer.session_epoch = Some(opened.session_epoch);
    assert_ne!(peer.id, live_device.id);

    let state_request =
        |client| RpcRequest::Query(f.query(client, "replay.peer.state", peer.clone(), json!({})));
    let state = || async {
        let RpcResult::Query(QueryResult::ReplayPeerState(state)) =
            success(f.user.request(state_request(&f.user)).await.unwrap())
        else {
            panic!("peer state expected");
        };
        state
    };
    let initial = state().await;
    assert_eq!(initial.progress.revision, 1.into());
    assert_eq!(initial.progress.remaining_request_bytes, 3.into());
    assert!(initial.responses.is_empty());

    f.grant("content.read", f.reference_target(&destination));
    assert_eq!(
        failure(
            f.observer
                .request(state_request(&f.observer))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        f.rejected_action(
            "session.tx",
            peer.clone(),
            json!({"bytesBase64":"AQID","writeWaitMs":"100"})
        )
        .await
        .code,
        "READ_ONLY"
    );

    let submit = |revision, bytes: &str| {
        let mut call = f.call(
            &f.user,
            "replay.peer.submit",
            peer.clone(),
            json!({"bytesBase64":bytes}),
        );
        call.expected_revision = Some(U64::from(revision));
        call
    };
    let action = |call| async {
        let RpcResult::Operation(admitted) =
            success(f.user.request(RpcRequest::Invoke(call)).await.unwrap())
        else {
            panic!("submit receipt expected");
        };
        let terminal = f.wait(&admitted.operation, false).await;
        let operation_id = &terminal.operation_id;
        let request = f.query(
            &f.user,
            "operation.get",
            f.target("operation", operation_id.as_str()),
            json!({"operationId":operation_id}),
        );
        let RpcResult::Operation(public) = success(
            f.user
                .request(RpcRequest::OperationGet(request))
                .await
                .unwrap(),
        ) else {
            panic!("public simulator receipt expected");
        };
        assert_eq!(public.operation.state, terminal.state);
        public.operation
    };

    let fragment = submit(1, "AQ==");
    let first = action(fragment.clone()).await;
    assert!(
        matches!(first.result, Some(ActionResult::ReplayPeerProgress(progress)) if progress.remaining_request_bytes == U64::from(2))
    );
    assert_eq!(action(fragment).await.operation_id, first.operation_id);
    assert!(state().await.responses.is_empty());
    let mismatch = action(submit(2, "AAA=")).await;
    let error = mismatch.error.unwrap();
    assert_eq!(error.code, "REPLAY_PEER_MISMATCH");
    assert_eq!(
        serde_json::to_value(error.details).unwrap(),
        json!({"turn":1,"matchedBytes":1,"mismatchOffset":1})
    );
    assert_eq!(state().await.progress.revision, 2.into());
    let old = action(submit(1, "AgM=")).await;
    assert_eq!(old.error.unwrap().code, "REVISION_CONFLICT");
    let first_match = submit(2, "AgM=");
    let first_turn = action(first_match.clone()).await;
    let Some(ActionResult::ReplayPeerProgress(first_progress)) = &first_turn.result else {
        panic!("first turn progress")
    };
    assert!(!first_progress.at_end);
    assert_eq!(first_progress.response_start, 0.into());
    assert!(first_progress.response_count.get() > 0);
    let second_partial = action(submit(3, "BA==")).await;
    assert_eq!(second_partial.state, OperationState::Succeeded);
    let prior = action(first_match).await;
    assert_eq!(prior.result, first_turn.result);
    let retained = state().await;
    let first_response = retained
        .responses
        .iter()
        .take(first_progress.response_count.get() as usize)
        .flat_map(|response| STANDARD.decode(response.bytes_base64.as_str()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(first_response, [1, 2, 3]);
    let final_match = action(submit(4, "BQ==")).await;
    assert!(
        matches!(final_match.result, Some(ActionResult::ReplayPeerProgress(progress)) if progress.at_end && progress.response_start == first_progress.response_count)
    );
    let completed = state().await;
    assert_eq!(completed.progress.revision, 5.into());
    let bytes = completed
        .responses
        .iter()
        .flat_map(|response| STANDARD.decode(response.bytes_base64.as_str()).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(bytes, [1, 2, 3, 4, 5]);
    assert!(
        completed
            .responses
            .windows(2)
            .all(|pair| pair[0].record_ordinal < pair[1].record_ordinal)
    );
    assert_eq!(read_live_cursor().await, real_cursor);
    drop(raw);

    let directory = f.dir.path().join(source_name);
    let excess = directory.join("excess.bin");
    std::fs::File::create(&excess)
        .unwrap()
        .set_len(8 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        failure(f.user.request(state_request(&f.user)).await.unwrap()).code,
        "REPLAY_PEER_LIMIT"
    );
    let registration = |purpose: &'static str| {
        f.action(
            &f.control,
            "file.register",
            f.host(),
            json!({"path":directory,"purpose":purpose}),
        )
    };
    let denied_registration = registration("capture_peer_source").await;
    assert_eq!(denied_registration.error.unwrap().code, "REPLAY_PEER_LIMIT");
    let passive_registration = registration("capture_source").await;
    assert_eq!(passive_registration.state, OperationState::Succeeded);
    std::fs::remove_file(excess).unwrap();
    let accepted_registration = registration("capture_peer_source").await;
    assert!(
        matches!(accepted_registration.result, Some(ActionResult::FileMetadata(ref item)) if item.purpose == FilePurpose::CaptureSource)
    );
    let manifest = directory.join("manifest.json");
    let saved = std::fs::read(&manifest).unwrap();
    std::fs::File::options()
        .write(true)
        .open(&manifest)
        .unwrap()
        .set_len(8 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        failure(f.user.request(state_request(&f.user)).await.unwrap()).code,
        "REPLAY_PEER_LIMIT"
    );
    let mut changed = saved.clone();
    changed.push(b' ');
    std::fs::write(&manifest, changed).unwrap();
    assert_eq!(
        failure(f.user.request(state_request(&f.user)).await.unwrap()).code,
        "SOURCE_CHANGED"
    );
    std::fs::write(&manifest, saved).unwrap();
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.user.attachment().actor_id.clone(),
                permissions: vec!["content.read".into()],
                targets: vec![f.host()],
            },
        )
        .unwrap();
    assert_eq!(
        failure(f.user.request(state_request(&f.user)).await.unwrap()).code,
        "PERMISSION_DENIED"
    );
    let observer_close = f.call(&f.observer, "replay.peer.close", peer.clone(), json!({}));
    assert_eq!(
        failure(
            f.observer
                .request(RpcRequest::Invoke(observer_close))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    let closed = f
        .action(&f.user, "replay.peer.close", peer.clone(), json!({}))
        .await;
    assert_eq!(closed.state, OperationState::Succeeded, "{closed:?}");
    let id = &closed.operation_id;
    let query = f.query(
        &f.user,
        "operation.get",
        f.target("operation", id.as_str()),
        json!({"operationId":id}),
    );
    let RpcResult::Operation(replay_close) = success(
        f.user
            .request(RpcRequest::OperationGet(query))
            .await
            .unwrap(),
    ) else {
        panic!("peer teardown receipt")
    };
    assert_eq!(
        replay_close.operation.result,
        Some(ActionResult::ReplayPeerClosed(ReplayPeerClosed {
            session_id: peer.id.clone(),
            session_epoch: 1.into(),
            revision: 6.into()
        }))
    );
    f.finish().await;
}

#[tokio::test]
async fn replay_transmit_keeps_preview_offline_and_sends_only_confirmed_bytes() {
    let f = Fixture::new().await;
    let target = f.open().await;
    let destination = f.register("replay-transmit-source").await;
    let (recording, live) = f.start(&f.user, &target, &destination).await;
    let recorded = f
        .action(
            &f.user,
            "session.tx",
            target.clone(),
            json!({"bytesBase64":"AQID","writeWaitMs":"100"}),
        )
        .await;
    assert_eq!(recorded.state, OperationState::Succeeded);
    f.wait_written(&live, 3).await;
    let source = f.stop_capture(&recording, &live).await.capture_ref;
    let raw = f.user.connect_raw().await.unwrap();
    let cursor = || async {
        let request = f.query(&f.user, "stream.cursor", target.clone(), json!({}));
        let RpcResult::Query(QueryResult::StreamCursor(position)) =
            success(raw.request(RpcRequest::Query(request)).await.unwrap())
        else {
            panic!("raw device cursor")
        };
        position.cursor.position
    };
    let before = cursor().await;
    let selection = json!({"captureRef":source,"direction":"tx","bytesPerSecond":"1024"});
    let request = f.query(
        &f.user,
        "replay.transmit.preview",
        target.clone(),
        selection.clone(),
    );
    let RpcResult::Query(QueryResult::ReplayTransmitPreview(preview)) =
        success(f.user.request(RpcRequest::Query(request)).await.unwrap())
    else {
        panic!("confirmed recording preview")
    };
    assert_eq!(preview.target, target);
    assert_eq!(preview.direction, Direction::Tx);
    assert_eq!(preview.bytes_base64.as_str(), "AQID");
    assert_eq!(preview.bytes_per_second, 1024.into());
    assert_eq!(preview.spans.len(), 1);
    assert_eq!(cursor().await, before);

    let invoke = |selection: Value, preview_digest: &Digest, revision: U64| {
        let mut call = f.call(
            &f.user,
            "replay.transmit",
            target.clone(),
            json!({"selection":selection,"previewDigest":preview_digest}),
        );
        call.expected_revision = Some(revision);
        call.execution_mode = Some(ExecutionMode::Independent);
        call
    };
    let run = |call| async {
        let RpcResult::Operation(receipt) =
            success(f.user.request(RpcRequest::Invoke(call)).await.unwrap())
        else {
            panic!("replay transmit admission")
        };
        f.wait(&receipt.operation, false).await
    };
    let mut wrong_epoch = invoke(
        selection.clone(),
        &preview.preview_digest,
        preview.target_revision,
    );
    wrong_epoch.target.session_epoch = Some(target.session_epoch.unwrap().checked_next().unwrap());
    assert_eq!(
        failure(
            f.user
                .request(RpcRequest::Invoke(wrong_epoch))
                .await
                .unwrap()
        )
        .code,
        "EPOCH_MISMATCH"
    );
    assert_eq!(cursor().await, before);

    let mut changed = selection.clone();
    changed["bytesPerSecond"] = json!("1025");
    let rejected = run(invoke(
        changed,
        &preview.preview_digest,
        preview.target_revision,
    ))
    .await;
    assert_eq!(rejected.error.unwrap().code, "REPLAY_PREVIEW_CHANGED");
    assert_eq!(cursor().await, before);

    let manifest = f.dir.path().join("replay-transmit-source/manifest.json");
    let original = std::fs::read(&manifest).unwrap();
    let mut tampered = original.clone();
    tampered.push(b' ');
    std::fs::write(&manifest, tampered).unwrap();
    let changed_source = run(invoke(
        selection.clone(),
        &preview.preview_digest,
        preview.target_revision,
    ))
    .await;
    assert_eq!(changed_source.error.unwrap().code, "SOURCE_CHANGED");
    assert_eq!(cursor().await, before);
    std::fs::write(&manifest, original).unwrap();

    let approved = invoke(
        selection.clone(),
        &preview.preview_digest,
        preview.target_revision,
    );
    let accepted = run(approved.clone()).await;
    assert_eq!(accepted.state, OperationState::Succeeded, "{accepted:?}");
    let Some(ActionResult::FileTransfer(transfer)) = &accepted.result else {
        panic!("settled replay transmission")
    };
    assert_eq!(transfer.accepted, 3.into());
    assert_eq!(transfer.unknown, 0.into());
    assert_eq!(transfer.requested, 3.into());
    assert_eq!(run(approved).await.operation_id, accepted.operation_id);
    let operation_id = &accepted.operation_id;
    let public = f.query(
        &f.user,
        "operation.get",
        f.target("operation", operation_id.as_str()),
        json!({"operationId":operation_id}),
    );
    let RpcResult::Operation(public) = success(
        f.user
            .request(RpcRequest::OperationGet(public))
            .await
            .unwrap(),
    ) else {
        panic!("public recorded send receipt")
    };
    assert_eq!(public.operation.result, accepted.result);
    let read_receipts = |client| {
        RpcRequest::Query(f.query(client, "transfer.receiptsRead", f.reference_target(&transfer.receipts_ref), json!({"receiptsRef":transfer.receipts_ref,"startOrdinal":"0","maxReceipts":"4","maxBytes":"65536"})))
    };
    let RpcResult::Query(QueryResult::FileTransferReceipts(receipts)) =
        success(raw.request(read_receipts(&f.user)).await.unwrap())
    else {
        panic!("independent recorded send journal")
    };
    assert_eq!(receipts.receipts[0].receipt.bytes_base64.as_str(), "AQID");
    assert_eq!(
        receipts.receipts[0].replay_spans.as_deref(),
        Some(preview.spans.as_slice())
    );
    f.grant("content.read", f.reference_target(&destination));
    f.auth
        .revoke(
            &f.operator,
            RevokeParams {
                actor_id: f.observer.attachment().actor_id.clone(),
                permissions: vec!["metadata.read".into()],
                targets: vec![target.clone()],
            },
        )
        .unwrap();
    let observer_raw = f.observer.connect_raw().await.unwrap();
    assert_eq!(
        failure(
            observer_raw
                .request(read_receipts(&f.observer))
                .await
                .unwrap()
        )
        .code,
        "PERMISSION_DENIED"
    );
    drop(observer_raw);
    let settled = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let current = cursor().await;
            if current.get() >= before.get() + 3 {
                break current;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(settled > before);
    let read = f.query(
        &f.user, "stream.read", target.clone(),
        json!({"sessionId":target.session_id,"sessionEpoch":target.session_epoch,"startEventSeq":before.checked_next().unwrap(),"maxEvents":"32","maxBytes":"65536"}),
    );
    let RpcResult::Query(QueryResult::StreamRead(page)) =
        success(raw.request(RpcRequest::Query(read)).await.unwrap())
    else {
        panic!("raw replay transmission evidence")
    };
    let writes = page
        .events
        .iter()
        .filter_map(|event| match &event.payload {
            RawPayload::TxIntent(intent) => {
                Some((&intent.operation_id, intent.bytes_base64.as_str()))
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(writes, [(&accepted.operation_id, "AQID")]);

    let stale = run(invoke(
        selection,
        &preview.preview_digest,
        preview.target_revision,
    ))
    .await;
    assert_eq!(stale.error.unwrap().code, "REPLAY_PREVIEW_CHANGED");
    assert_eq!(cursor().await, settled);
    drop(raw);
    f.finish().await;
}

#[tokio::test]
async fn replay_transmit_cancel_keeps_the_actual_prefix_and_stops_later_chunks() {
    let f = Fixture::new().await;
    let target = f.open().await;
    let destination = f.register("replay-cancel-source").await;
    let (recording, live) = f.start(&f.user, &target, &destination).await;
    let bytes = STANDARD.encode((1..=24_u8).collect::<Vec<_>>());
    let original = f
        .action(
            &f.user,
            "session.tx",
            target.clone(),
            json!({"bytesBase64":bytes,"writeWaitMs":"100"}),
        )
        .await;
    assert_eq!(original.state, OperationState::Succeeded);
    f.wait_written(&live, 3).await;
    let fixed = f.stop_capture(&recording, &live).await.capture_ref;
    let selection = json!({"captureRef":fixed,"direction":"tx","bytesPerSecond":"1"});
    let request = f.query(
        &f.user,
        "replay.transmit.preview",
        target.clone(),
        selection.clone(),
    );
    let RpcResult::Query(QueryResult::ReplayTransmitPreview(preview)) =
        success(f.user.request(RpcRequest::Query(request)).await.unwrap())
    else {
        panic!("paced preview expected")
    };
    let mut confirmed = f.call(
        &f.user,
        "replay.transmit",
        target,
        json!({"selection":selection,"previewDigest":preview.preview_digest}),
    );
    confirmed.expected_revision = Some(preview.target_revision);
    confirmed.execution_mode = Some(ExecutionMode::Independent);
    let RpcResult::Operation(started) =
        success(f.user.request(RpcRequest::Invoke(confirmed)).await.unwrap())
    else {
        panic!("paced replay acceptance expected")
    };
    let operation_id = &started.operation.operation_id;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let current = f.store.get(&f.operator, operation_id).unwrap();
            assert!(!current.state.is_terminal(), "paced transfer stopped before first confirmed chunk: {current:?}");
            if matches!(current.result, Some(ActionResult::FileTransfer(result)) if result.accepted.get() > 0) { break; }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }).await.unwrap();
    let cancel = f.call(
        &f.user,
        "operation.cancel",
        f.target("operation", operation_id.as_str()),
        json!({"reason":"user"}),
    );
    success(
        f.user
            .request(RpcRequest::OperationCancel(cancel))
            .await
            .unwrap(),
    );
    let terminal = f.wait(&started.operation, false).await;
    assert_eq!(terminal.state, OperationState::Cancelled, "{terminal:?}");
    let Some(ActionResult::FileTransfer(transfer)) = terminal.result else {
        panic!("confirmed prefix receipt")
    };
    assert_eq!(transfer.requested, 24.into());
    assert!(transfer.accepted.get() >= 1 && transfer.accepted.get() < 24);
    assert_eq!(transfer.unknown, 0.into());

    let raw = f.user.connect_raw().await.unwrap();
    let receipts_request = || {
        RpcRequest::Query(f.query(&f.user, "transfer.receiptsRead", f.reference_target(&transfer.receipts_ref), json!({"receiptsRef":transfer.receipts_ref,"startOrdinal":"0","maxReceipts":"32","maxBytes":"65536"})))
    };
    let response = success(raw.request(receipts_request()).await.unwrap());
    let RpcResult::Query(QueryResult::FileTransferReceipts(receipts)) = response else {
        panic!("sealed recorded send journal")
    };
    let written: Vec<_> = receipts
        .receipts
        .iter()
        .filter(|item| item.receipt.outcome == TxOutcome::Accepted)
        .flat_map(|item| STANDARD.decode(item.receipt.bytes_base64.as_str()).unwrap())
        .collect();
    assert_eq!(
        written,
        (1..=transfer.accepted.get() as u8).collect::<Vec<_>>()
    );
    for receipt in receipts
        .receipts
        .iter()
        .filter(|item| item.receipt.outcome == TxOutcome::Accepted)
    {
        let [span] = receipt.replay_spans.as_deref().unwrap() else {
            panic!("one clipped source range per byte")
        };
        assert_eq!(span.output_offset, receipt.source_offset);
        assert_eq!(span.source.byte_start, Some(receipt.source_offset));
        assert_eq!(
            span.source.byte_end,
            Some(receipt.source_offset.checked_next().unwrap())
        );
    }
    assert!(receipts.sealed);
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let RpcResult::Query(QueryResult::FileTransferReceipts(after)) =
        success(raw.request(receipts_request()).await.unwrap())
    else {
        panic!("sealed journal reread")
    };
    assert_eq!(receipts, after);
    drop(raw);
    f.finish().await;
}
