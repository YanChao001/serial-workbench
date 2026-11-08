use serde_json::{Value, json};
use serial_workbench_client::{ConnectOptions, HostClient, read_user_control_credential};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler},
};
use std::{
    path::PathBuf,
    process::{Output, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::{Notify, oneshot},
    task::JoinHandle,
};

struct Fixture {
    directory: tempfile::TempDir,
    host_id: Id,
    stop: Option<oneshot::Sender<()>>,
    running: Option<JoinHandle<HostResult<()>>>,
}
impl Fixture {
    async fn new() -> Self {
        // macOS exposes /tmp through a symlink; keep production path checks intact.
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let directory = tempfile::tempdir_in(temp).unwrap();
        let mut server = HostServer::bind(directory.path()).await.unwrap();
        let host_id = server.store().identity().unwrap().host_id;
        let host = Host::new(server.store(), server.auth()).await.unwrap();
        let (stop, done) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        Self {
            directory,
            host_id,
            stop: Some(stop),
            running: Some(running),
        }
    }
    fn target(&self) -> Value {
        json!({"hostId":self.host_id,"kind":"host","id":self.host_id})
    }
    fn file(&self, name: &str, value: Value) -> PathBuf {
        let path = self.directory.path().join(name);
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        path
    }
    async fn cli(&self, args: &[&str]) -> Output {
        let mut command = Command::new(env!("CARGO_BIN_EXE_serial-workbench-cli"));
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        command
            .args(args)
            .arg("--profile")
            .arg(self.directory.path())
            .kill_on_drop(true);
        tokio::time::timeout(Duration::from_secs(15), command.output())
            .await
            .unwrap()
            .unwrap()
    }
    async fn json(&self, args: &[&str]) -> Value {
        self.json_at(args[0], args).await
    }
    async fn json_at(&self, stage: &str, args: &[&str]) -> Value {
        let started = std::time::Instant::now();
        let output = self.cli(args).await;
        assert!(
            output.status.success(),
            "stage={stage} elapsed={:?} status={} stdout={} stderr={}",
            started.elapsed(),
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            output.stderr.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("stdout must contain exactly one JSON value")
    }
    async fn finish(mut self) {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), self.running.take().unwrap())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    async fn call(&self, action: &str, target: Value, params: Value, request: &str) -> Value {
        let target = self.file("call-target.json", target);
        let params = self.file("call-params.json", params);
        let context = self.directory.path().join("context.json");
        if !context.exists() {
            self.json(&["context", "--out", context.to_str().unwrap(), "--json"])
                .await;
        }
        self.json(&[
            "invoke",
            action,
            "--target-json",
            target.to_str().unwrap(),
            "--params-json",
            params.to_str().unwrap(),
            "--request-id",
            request,
            "--request-context-json",
            context.to_str().unwrap(),
            "--json",
        ])
        .await
    }
    async fn restart(&mut self) {
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), self.running.take().unwrap())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let mut server = HostServer::bind(self.directory.path()).await.unwrap();
        let host = Host::new(server.store(), server.auth()).await.unwrap();
        let (stop, done) = oneshot::channel();
        self.stop = Some(stop);
        self.running = Some(tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        }));
    }
    async fn settled(&self, accepted: Value) -> Value {
        let id = operation(&accepted)["operationId"].as_str().unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let result = self.json(&["operation", "get", id, "--json"]).await;
                if !matches!(
                    operation(&result)["state"].as_str().unwrap(),
                    "queued" | "running" | "cancel_requested"
                ) {
                    return result;
                }
            }
        })
        .await
        .unwrap()
    }
    async fn settled_user_control(&self, accepted: &Value) {
        // CLI 返回接纳回执；以同一显式用户身份等到提交，避免目录回包跨越授权代次。
        let mut options = ConnectOptions::new(
            self.directory.path().into(),
            Id::try_from("serial-workbench-cli").unwrap(),
            ClientKind::Cli,
        );
        options.user_control_credential =
            Some(read_user_control_credential(self.directory.path()).unwrap());
        let client = HostClient::connect(options).await.unwrap();
        let attached = client.attachment();
        assert_eq!(operation(accepted)["actorId"], attached.actor_id.as_str());
        let params: JsonObject =
            serde_json::from_value(json!({"operationId":operation(accepted)["operationId"]}))
                .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let reply = client
                    .request(RpcRequest::OperationGet(Query {
                        protocol_version: attached.protocol_version,
                        host_id: attached.host_id.clone(),
                        instance_epoch: attached.instance_epoch,
                        actor_id: attached.actor_id.clone(),
                        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str())
                            .unwrap(),
                        action_id: Id::try_from("operation.get").unwrap(),
                        target: serde_json::from_value(self.target()).unwrap(),
                        params: params.clone(),
                        reveal_target: BuiltinAction::OperationGet.spec().reveal_target,
                    }))
                    .await
                    .unwrap();
                let result = match reply {
                    RpcReply::Success { result, .. } => match *result {
                        RpcResult::Operation(result) => result.operation,
                        _ => panic!("user-control operation.get returned an unexpected result"),
                    },
                    RpcReply::Failure { error, .. } => {
                        panic!("user-control operation.get failed: {}", error.code)
                    }
                };
                if !matches!(
                    result.state,
                    OperationState::Queued
                        | OperationState::Running
                        | OperationState::CancelRequested
                ) {
                    assert_eq!(
                        result.state,
                        OperationState::Succeeded,
                        "authorization operation failed: {:?}",
                        result.error.map(|error| error.code)
                    );
                    break;
                }
            }
        })
        .await
        .expect("user-control operation must settle before reading the catalog");
    }
    async fn grant_device_access(&self) {
        self.json(&["catalog", "--json"]).await;
        let params = self.file("grant.json", json!({"clientId":"serial-workbench-cli","permissions":["device.modify","content.read"],"targets":[self.target()]}));
        let accepted = self
            .json(&[
                "authorize",
                "--params-json",
                params.to_str().unwrap(),
                "--json",
            ])
            .await;
        self.settled_user_control(&accepted).await;
        assert!(has_action(
            &self.json(&["catalog", "--json"]).await,
            "device.open"
        ));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(running) = self.running.take() {
            running.abort();
        }
    }
}
fn operation(value: &Value) -> &Value {
    &value["result"]["operation"]
}
fn has_action(value: &Value, id: &str) -> bool {
    value["result"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["actionId"] == id)
}

#[tokio::test]
async fn catalog_stdout_is_json_and_explicit_authorization_changes_visibility() {
    let f = Fixture::new().await;
    let catalog = f
        .json_at("catalog before authorize", &["catalog", "--json"])
        .await;
    assert!(has_action(&catalog, "catalog.list"));
    assert!(!has_action(&catalog, "device.open"));
    assert!(!has_action(&catalog, "stream.read"));
    let authorize = f.file("authorize.json", json!({"clientId":"serial-workbench-cli","permissions":["device.modify","content.read"],"targets":[f.target()]}));
    let accepted = f
        .json(&[
            "authorize",
            "--params-json",
            authorize.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(operation(&accepted)["actionId"], "auth.authorize");
    f.settled_user_control(&accepted).await;
    let catalog = f
        .json_at("catalog after authorize settled", &["catalog", "--json"])
        .await;
    assert!(has_action(&catalog, "device.open"));
    assert!(has_action(&catalog, "stream.read"));
    let client = HostClient::connect(ConnectOptions::new(
        f.directory.path().into(),
        Id::try_from("serial-workbench-cli").unwrap(),
        ClientKind::Cli,
    ))
    .await
    .unwrap();
    let revoke = f.file("revoke.json", json!({"actorId":client.attachment().actor_id,"permissions":["device.modify","content.read"],"targets":[f.target()]}));
    drop(client);
    let accepted = f
        .json(&[
            "revoke",
            "--params-json",
            revoke.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(operation(&accepted)["actionId"], "auth.revoke");
    f.settled_user_control(&accepted).await;
    let catalog = f
        .json_at("catalog after revoke settled", &["catalog", "--json"])
        .await;
    assert!(!has_action(&catalog, "device.open"));
    f.finish().await;
}

#[tokio::test]
async fn invalid_arguments_have_stable_json_errors_and_no_host_start() {
    let temp = std::env::temp_dir().canonicalize().unwrap();
    let directory = tempfile::tempdir_in(temp).unwrap();
    for args in [
        vec!["unknown", "--json"],
        vec!["invoke", "device.open", "--request-id", "bad", "--json"],
        vec!["catalog", "--bogus", "--json"],
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_serial-workbench-cli"));
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = command
            .args(args)
            .arg("--profile")
            .arg(directory.path())
            .output()
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["error"]["code"], "INVALID_ARGUMENT");
        assert!(!output.stderr.is_empty());
    }
    assert!(!directory.path().join("host-v0").exists());
}

#[tokio::test]
async fn generic_query_returns_real_typed_result_and_domain_failure() {
    let f = Fixture::new().await;
    let target = f.file("target.json", f.target());
    let params = f.file("params.json", json!({}));
    let result = f
        .json(&[
            "query",
            "device.list",
            "--target-json",
            target.to_str().unwrap(),
            "--params-json",
            params.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(result["result"]["kind"], "devices");
    let devices: DeviceList = serde_json::from_value(result["result"]["value"].clone()).unwrap();
    let virtual_devices = devices
        .devices
        .iter()
        .filter(|device| device.device_id.as_str() == "virtual:echo")
        .collect::<Vec<_>>();
    assert_eq!(virtual_devices.len(), 1);
    assert_eq!(virtual_devices[0].host_id, f.host_id);
    assert_eq!(
        virtual_devices[0].fingerprint.transport,
        DeviceTransportKind::Virtual
    );
    let bad = f.file("bad.json", json!({"unknown":true}));
    let output = f
        .cli(&[
            "query",
            "device.list",
            "--target-json",
            target.to_str().unwrap(),
            "--params-json",
            bad.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(output.status.code(), Some(2));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["error"]["code"], "INVALID_ARGUMENT");
    f.finish().await;
}

#[tokio::test]
async fn virtual_invoke_preserves_request_id_reads_raw_and_explicitly_cancels() {
    let f = Fixture::new().await;
    f.grant_device_access().await;
    let request = uuid::Uuid::new_v4().to_string();
    let opened = f
        .call(
            "device.open",
            json!({"hostId":f.host_id,"kind":"device","id":"virtual:echo"}),
            json!({"configuration":SerialConfiguration::default()}),
            &request,
        )
        .await;
    assert_eq!(operation(&opened)["requestId"], request);
    let repeated = f
        .call(
            "device.open",
            json!({"hostId":f.host_id,"kind":"device","id":"virtual:echo"}),
            json!({"configuration":SerialConfiguration::default()}),
            &request,
        )
        .await;
    assert_eq!(
        operation(&opened)["operationId"],
        operation(&repeated)["operationId"]
    );
    let changed = SerialConfiguration {
        baud_rate: PositiveU64::try_from(U64::from(115200)).unwrap(),
        ..SerialConfiguration::default()
    };
    let conflict_params = f.file("conflict.json", json!({"configuration":changed}));
    let conflict = f
        .cli(&[
            "invoke",
            "device.open",
            "--target-json",
            f.directory
                .path()
                .join("call-target.json")
                .to_str()
                .unwrap(),
            "--params-json",
            conflict_params.to_str().unwrap(),
            "--request-id",
            &request,
            "--request-context-json",
            f.directory.path().join("context.json").to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(conflict.status.code(), Some(4));
    assert_eq!(
        serde_json::from_slice::<Value>(&conflict.stdout).unwrap()["error"]["code"],
        "REQUEST_CONFLICT"
    );
    let opened = f.settled(opened).await;
    assert_eq!(operation(&opened)["state"], "succeeded");
    let session = &operation(&opened)["result"]["value"];
    let target = json!({"hostId":f.host_id,"kind":"session","id":session["sessionId"],"sessionId":session["sessionId"],"sessionEpoch":session["sessionEpoch"]});
    let tx = f
        .call(
            "session.tx",
            target.clone(),
            json!({"bytesBase64":"aGVsbG8=","writeWaitMs":"1000"}),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await;
    let tx = f.settled(tx).await;
    assert_eq!(operation(&tx)["state"], "succeeded");
    assert_eq!(operation(&tx)["result"]["kind"], "tx");
    let read_target = f.file("read-target.json", target.clone());
    let read_params = f.file("read-params.json", json!({"sessionId":session["sessionId"],"sessionEpoch":session["sessionEpoch"],"startEventSeq":"1","maxEvents":"100","maxBytes":"65536"}));
    let read = f
        .json(&[
            "query",
            "stream.read",
            "--target-json",
            read_target.to_str().unwrap(),
            "--params-json",
            read_params.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(read["result"]["kind"], "stream_read");
    assert!(
        !read["result"]["value"]["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let accepted = f
        .call(
            "session.break",
            target.clone(),
            json!({"durationMs":"5000"}),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await;
    let id = operation(&accepted)["operationId"].as_str().unwrap();
    let still_running = f.json(&["operation", "get", id, "--json"]).await;
    assert!(matches!(
        operation(&still_running)["state"].as_str(),
        Some("queued" | "running")
    ));
    let cancellation = f.json(&["operation", "cancel", id, "--json"]).await;
    assert_eq!(operation(&cancellation)["actionId"], "operation.cancel");
    let cancelled = f.settled(accepted).await;
    assert_eq!(operation(&cancelled)["state"], "cancelled");
    let closed = f
        .call(
            "session.close",
            target,
            json!({}),
            &uuid::Uuid::new_v4().to_string(),
        )
        .await;
    assert_eq!(operation(&f.settled(closed).await)["state"], "succeeded");
    f.finish().await;
}

#[tokio::test]
async fn explicit_context_is_no_clobber_and_old_request_can_be_found_after_restart() {
    let mut f = Fixture::new().await;
    f.grant_device_access().await;
    let request = uuid::Uuid::new_v4().to_string();
    let accepted = f
        .call(
            "device.open",
            json!({"hostId":f.host_id,"kind":"device","id":"virtual:echo"}),
            json!({"configuration":SerialConfiguration::default()}),
            &request,
        )
        .await;
    let operation_id = operation(&f.settled(accepted).await)["operationId"].clone();
    let context = f.directory.path().join("context.json");
    let original = std::fs::read(&context).unwrap();
    let context_dto: AttachResult = serde_json::from_slice(&original).unwrap();
    assert_eq!(context_dto.client_id.as_str(), "serial-workbench-cli");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&context).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let overwrite = f
        .cli(&["context", "--out", context.to_str().unwrap(), "--json"])
        .await;
    assert!(!overwrite.status.success());
    assert_eq!(std::fs::read(&context).unwrap(), original);
    f.restart().await;
    let stale = f
        .cli(&[
            "invoke",
            "device.open",
            "--target-json",
            f.directory
                .path()
                .join("call-target.json")
                .to_str()
                .unwrap(),
            "--params-json",
            f.directory
                .path()
                .join("call-params.json")
                .to_str()
                .unwrap(),
            "--request-id",
            &request,
            "--request-context-json",
            context.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(stale.status.code(), Some(4));
    assert_eq!(
        serde_json::from_slice::<Value>(&stale.stdout).unwrap()["error"]["code"],
        "EPOCH_MISMATCH"
    );
    let found = f
        .json(&[
            "operation",
            "get",
            "--request-id",
            &request,
            "--request-context-json",
            context.to_str().unwrap(),
            "--json",
        ])
        .await;
    assert_eq!(operation(&found)["operationId"], operation_id);
    f.finish().await;
}

#[tokio::test]
async fn host_stop_waits_for_the_attached_instance_lock_to_release() {
    let f = Fixture::new().await;
    let result = f.json(&["host", "stop", "--json"]).await;
    assert_eq!(result["hostId"], f.host_id.as_str());
    assert_eq!(result["stopped"], true);
    assert!(!serial_workbench_ipc::profile_has_running_host(f.directory.path()).unwrap());
    f.finish().await;
}

// 暂缓真实停机信号的消费，模拟原实例仍在结算且继续持有 OS 锁。
struct DelayedStop {
    host: Host,
    requested: Arc<Notify>,
    release: Mutex<Option<oneshot::Receiver<()>>>,
}
impl RequestHandler for DelayedStop {
    fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
        self.host.handle(context, request)
    }
    fn disconnected(&self, context: &ConnectionContext) {
        self.host.disconnected(context);
    }
    fn stop_requested(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        let stopped = self.host.stop_requested();
        let requested = self.requested.clone();
        let release = self.release.lock().unwrap().take().unwrap();
        Box::pin(async move {
            stopped.await;
            requested.notify_one();
            let _ = release.await;
        })
    }
    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<()>> + Send>> {
        let host = self.host.clone();
        Box::pin(async move { host.shutdown().await })
    }
}

async fn collect_child(mut child: Child) -> Result<Output, String> {
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |stream: tokio::process::ChildStdout| async move {
        let mut bytes = Vec::new();
        stream
            .take(1024 * 1024)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    };
    let stdout = tokio::spawn(read(stdout));
    let stderr = tokio::spawn(async move {
        let mut bytes = Vec::new();
        stderr
            .take(1024 * 1024)
            .read_to_end(&mut bytes)
            .await
            .map(|_| bytes)
    });
    let status = match tokio::time::timeout(Duration::from_secs(25), child.wait()).await {
        Ok(result) => result.map_err(|error| error.to_string()),
        Err(_) => {
            let _ = tokio::time::timeout(Duration::from_secs(5), child.kill()).await;
            let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
            Err("CLI did not exit before the test deadline".into())
        }
    };
    let stdout = tokio::time::timeout(Duration::from_secs(5), stdout)
        .await
        .map_err(|_| "CLI stdout did not close")?
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    let stderr = tokio::time::timeout(Duration::from_secs(5), stderr)
        .await
        .map_err(|_| "CLI stderr did not close")?
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(Output {
        status: status?,
        stdout,
        stderr,
    })
}

#[tokio::test]
async fn host_stop_rejects_unauthenticated_higher_discovery_while_old_lock_is_live() {
    let temp = std::env::temp_dir().canonicalize().unwrap();
    let directory = tempfile::tempdir_in(temp).unwrap();
    let mut server = HostServer::bind(directory.path()).await.unwrap();
    let host = Host::new(server.store(), server.auth()).await.unwrap();
    let requested = Arc::new(Notify::new());
    let (release, held) = oneshot::channel();
    let handler = Arc::new(DelayedStop {
        host,
        requested: requested.clone(),
        release: Mutex::new(Some(held)),
    });
    let (stop, done) = oneshot::channel();
    let serving = tokio::spawn(async move {
        server
            .serve_until(handler, async {
                let _ = done.await;
            })
            .await
    });
    let mut command = Command::new(env!("CARGO_BIN_EXE_serial-workbench-cli"));
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let child = command
        .args(["host", "stop", "--json", "--profile"])
        .arg(directory.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::spawn(collect_child(child));
    let signal = tokio::time::timeout(Duration::from_secs(5), requested.notified()).await;
    let path = directory.path().join("host-v0/discovery.json");
    let original = serial_workbench_ipc::DiscoveryRecord::read(&path).unwrap();
    let mut fake = original.clone();
    fake.instance_epoch = fake.instance_epoch.checked_next().unwrap();
    fake.write(&path).unwrap();
    let lock_before = serial_workbench_ipc::profile_has_running_host(directory.path());
    let output = output.await;
    let lock_after = serial_workbench_ipc::profile_has_running_host(directory.path());
    original.write(&path).unwrap();
    let _ = release.send(());
    let _ = stop.send(());
    let closed = tokio::time::timeout(Duration::from_secs(10), serving).await;
    // 先有界收回 CLI 和 Host，再传播断言，避免失败分支遗漏进程或停机屏障。
    closed.unwrap().unwrap().unwrap();
    signal.unwrap();
    assert!(lock_before.unwrap());
    assert!(lock_after.unwrap());
    let output = output.unwrap().unwrap();
    assert_eq!(
        output.status.code(),
        Some(5),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let error: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(error["error"]["code"], "HOST_STOP_TIMEOUT");
    assert_ne!(error["stopped"], true);
}
