use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{sync::Arc, time::Duration};
use tokio::sync::oneshot;

fn id(value: &str) -> Id {
    Id::try_from(value).unwrap()
}

#[tokio::test]
async fn catalog_notifications_follow_visible_tools_and_expiry_on_the_real_connection() {
    let dir = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let mut server = HostServer::bind(dir.path()).await.unwrap();
    let auth = server.auth();
    let store = server.store();
    let secret = serial_workbench_ipc::read_secret(&dir.path().join("host-v0/user-control.secret"))
        .unwrap()
        .unwrap();
    let operator = auth
        .authenticate_user_control(
            &id("operator"),
            &ContextToken::try_from(std::str::from_utf8(&secret).unwrap()).unwrap(),
        )
        .unwrap();
    let host = Host::new(store.clone(), auth.clone()).await.unwrap();
    let (stop, done) = oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });
    let client = HostClient::connect(ConnectOptions::new(
        dir.path().to_path_buf(),
        id("catalog-reader"),
        ClientKind::Mcp,
    ))
    .await
    .unwrap();
    let attachment = client.attachment();
    let target = Target {
        host_id: attachment.host_id.clone(),
        id: attachment.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    let query = Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: attachment.host_id.clone(),
        instance_epoch: attachment.instance_epoch,
        actor_id: attachment.actor_id.clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id("catalog.list"),
        target: target.clone(),
        params: serde_json::from_value(serde_json::json!({"pageSize":"100"})).unwrap(),
        reveal_target: BuiltinAction::CatalogList.spec().reveal_target,
    };
    let reply = client
        .request(RpcRequest::CatalogList(query))
        .await
        .unwrap();
    assert!(matches!(reply, RpcReply::Success { .. }));
    let version = store.identity().unwrap().catalog_version;
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: id("catalog-reader"),
            permissions: vec!["device.modify".into()],
            targets: vec![target.clone()],
            expires_at: Some(
                Timestamp::try_from(
                    (chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
                        + chrono::Duration::seconds(3))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                    .as_str(),
                )
                .unwrap(),
            ),
        },
    )
    .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(2), client.next_event())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let IpcMessage::CatalogChanged {
        catalog_version,
        visibility_token: granted,
    } = first.body
    else {
        panic!("unexpected event")
    };
    assert_eq!(catalog_version, version);
    assert_eq!(first.channel, IpcChannel::Control);
    auth.authenticate(&id("unrelated"), None).unwrap();
    auth.authorize(
        &operator,
        AuthorizeParams {
            client_id: id("unrelated"),
            permissions: vec!["device.modify".into()],
            targets: vec![target],
            expires_at: None,
        },
    )
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(150), client.next_event())
            .await
            .is_err(),
        "another actor must not produce this reader's catalog notification"
    );
    let expired = tokio::time::timeout(Duration::from_secs(5), client.next_event())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(expired.body, IpcMessage::CatalogChanged {catalog_version, visibility_token} if catalog_version == version && visibility_token != granted)
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(150), client.next_event())
            .await
            .is_err(),
        "an expired grant must not create repeated notifications"
    );
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
}
