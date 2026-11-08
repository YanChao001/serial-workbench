// Private follow-up: production main wiring, separate from the injected Host tests.
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use std::{
    io::Read,
    process::{Child, Command, Stdio},
    time::Duration,
};

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}
fn query(client: &HostClient, action: &str) -> Query {
    let a = client.attachment();
    Query {
        protocol_version: a.protocol_version,
        host_id: a.host_id.clone(),
        instance_epoch: a.instance_epoch,
        actor_id: a.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id(action),
        target: Target {
            host_id: a.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: a.host_id.clone(),
            session_id: None,
            session_epoch: None,
        },
        params: serde_json::from_value(serde_json::json!({})).unwrap(),
        reveal_target: RevealTarget {
            page_id: id("settings"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    }
}

#[tokio::test]
async fn production_main_resolves_once_and_exposes_selected_startup_facts() {
    let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let unselected = profile.path().join("unselected-env-profile");
    let mut command = Command::new(env!("CARGO_BIN_EXE_serial-workbench-host"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = OwnedChild(
        command
            .arg("--profile")
            .arg(profile.path())
            .arg("--bootstrap-stdio")
            .env("SWB_PROFILE", &unselected)
            .env("SWB_LOG_LEVEL", "debug")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut stdout = child.0.stdout.take().unwrap();
    let mut stderr = child.0.stderr.take().unwrap();
    let errors = tokio::task::spawn_blocking(move || {
        let mut bytes = Vec::new();
        let mut block = [0u8; 4096];
        loop {
            let n = stderr.read(&mut block).unwrap();
            if n == 0 {
                break;
            }
            let keep = n.min(65536usize.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&block[..keep]);
        }
        bytes
    });
    let credential = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let mut size = [0; 4];
            stdout.read_exact(&mut size).unwrap();
            let size = u32::from_be_bytes(size) as usize;
            assert!((1..=2048).contains(&size));
            let mut token = vec![0; size];
            stdout.read_exact(&mut token).unwrap();
            ContextToken::try_from(std::str::from_utf8(&token).unwrap()).unwrap()
        }),
    )
    .await
    .unwrap()
    .unwrap();
    let mut options =
        ConnectOptions::new(profile.path().into(), id("startup-main"), ClientKind::Cli);
    options.user_control_credential = Some(credential);
    let control = HostClient::connect(options).await.unwrap();
    let reader = HostClient::connect(ConnectOptions::new(
        profile.path().into(),
        id("startup-main-reader"),
        ClientKind::Desktop,
    ))
    .await
    .unwrap();
    let RpcReply::Success { result, .. } = reader
        .request(RpcRequest::Query(query(&reader, "startup.config.get")))
        .await
        .unwrap()
    else {
        panic!("production startup snapshot unavailable")
    };
    let RpcResult::Query(result) = *result else {
        panic!("typed query")
    };
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"kind":"startup_config","value":{"profileReference":"host:profile","profileSource":"argument","logLevel":"debug","logLevelSource":"environment"}})
    );
    assert!(!unselected.exists());
    let q = query(&control, "host.shutdown");
    let call = Call {
        protocol_version: q.protocol_version,
        host_id: q.host_id,
        instance_epoch: q.instance_epoch,
        actor_id: q.actor_id,
        request_id: q.request_id,
        action_id: q.action_id,
        target: q.target,
        params: q.params,
        reveal_target: q.reveal_target,
        request_context: control.attachment().request_context.clone(),
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    };
    assert!(matches!(
        control.request(RpcRequest::Invoke(call)).await.unwrap(),
        RpcReply::Success { .. }
    ));
    let status = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(status.success());
    let stderr = String::from_utf8(
        tokio::time::timeout(Duration::from_secs(3), errors)
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert!(
        stderr.contains("DEBUG"),
        "selected debug filter must initialize the actual logger"
    );
    assert!(!stderr.contains(profile.path().to_str().unwrap()));
    assert!(!stderr.contains("user-control.secret"));
}
