use super::*;
use crate::{auth::AuthenticatedActor, ipc::HostServer};
use serial_workbench_client::read_user_control_credential;
use serial_workbench_core::{AuthorizeParams, Id, ResourceKind, Target};
use std::net::IpAddr;
use tempfile::TempDir;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[path = "rpc_tests.rs"]
mod rpc;

fn profile() -> TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}

fn identity(profile: &TempDir) -> LanIdentity {
    let namespace = profile.path().join("host-v0");
    serial_workbench_ipc::prepare_private_directory(&namespace).unwrap();
    LanIdentity::load_or_create(&namespace).unwrap()
}

fn operator(host: &HostServer, profile: &TempDir) -> AuthenticatedActor {
    host.auth()
        .authenticate_user_control(
            &Id::try_from("lan-test-operator").unwrap(),
            &read_user_control_credential(profile.path()).unwrap(),
        )
        .unwrap()
}

async fn exchange(server: &LanIdentity, client: &LanIdentity, address: IpAddr) {
    let listener = TcpListener::bind((address, 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let service = server
        .server(HashSet::from([client.fingerprint().clone()]))
        .unwrap();
    let dial = client.client(server.fingerprint().clone()).unwrap();
    let expected_client = client.fingerprint().clone();
    let request = [0, 0x0d, 0x0a, 0xff];
    let receiving = async {
        let (socket, _) = listener.accept().await.unwrap();
        let (peer, mut stream) = service.accept(socket).await.unwrap();
        assert_eq!(peer, expected_client);
        let mut input = [0; 4];
        stream.read_exact(&mut input).await.unwrap();
        assert_eq!(input, request);
        stream.write_all(&input).await.unwrap();
        stream.flush().await.unwrap();
    };
    let sending = async {
        let mut stream = dial.connect(address).await.unwrap();
        stream.write_all(&request[..2]).await.unwrap();
        stream.write_all(&request[2..]).await.unwrap();
        stream.flush().await.unwrap();
        let mut response = [0; 4];
        stream.read_exact(&mut response).await.unwrap();
        assert_eq!(response, request);
    };
    timeout(Duration::from_secs(15), async {
        tokio::join!(receiving, sending);
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn pinned_profiles_reconnect_and_exchange_bytes_in_each_role_on_ipv4_and_ipv6() {
    let first_profile = profile();
    let second_profile = profile();
    let first = identity(&first_profile);
    let second = identity(&second_profile);
    assert_ne!(first.fingerprint(), second.fingerprint());
    let expected = first.fingerprint().clone();
    drop(first);
    let first = identity(&first_profile);
    assert_eq!(first.fingerprint(), &expected);
    for address in ["127.0.0.1", "::1"] {
        let address = address.parse().unwrap();
        exchange(&first, &second, address).await;
        exchange(&second, &first, address).await;
    }
}

#[tokio::test]
async fn wrong_keys_and_incompatible_protocol_are_rejected_before_server_delivery() {
    let server_profile = profile();
    let client_profile = profile();
    let unrelated_profile = profile();
    let server = identity(&server_profile);
    let client = identity(&client_profile);
    let unrelated = identity(&unrelated_profile);
    let service = server
        .server(HashSet::from([client.fingerprint().clone()]))
        .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let receive = || async {
        let (socket, _) = listener.accept().await.unwrap();
        service.accept(socket).await.unwrap_err().code
    };

    let dial = client.client(unrelated.fingerprint().clone()).unwrap();
    let (outbound, inbound) = tokio::join!(dial.connect(address), receive());
    assert_eq!(outbound.unwrap_err().code, "LAN_AUTHENTICATION_FAILED");
    assert_eq!(inbound, "LAN_AUTHENTICATION_FAILED");

    let dial = unrelated.client(server.fingerprint().clone()).unwrap();
    let (_, inbound) = tokio::join!(dial.connect(address), receive());
    assert_eq!(inbound, "LAN_AUTHENTICATION_FAILED");

    let dial = client.client(server.fingerprint().clone()).unwrap();
    let mut config = dial.0.config().as_ref().clone();
    config.alpn_protocols = vec![b"serial-workbench-lan/0.2".to_vec()];
    let incompatible = LanClient(TlsConnector::from(Arc::new(config)));
    let (outbound, inbound) = tokio::join!(incompatible.connect(address), receive());
    assert_eq!(outbound.unwrap_err().code, "LAN_PROTOCOL_MISMATCH");
    assert_eq!(inbound, "LAN_PROTOCOL_MISMATCH");
}

#[tokio::test]
async fn paired_hosts_apply_only_shared_scopes_and_recheck_pairing_after_restart_and_revocation() {
    let owner_profile = profile();
    let peer_profile = profile();
    let mut owner = HostServer::bind(owner_profile.path()).await.unwrap();
    let mut peer = HostServer::bind(peer_profile.path()).await.unwrap();
    let owner_endpoint = owner.lan_endpoint().unwrap();
    let peer_endpoint = peer.lan_endpoint().unwrap();
    let peer_operator = operator(&peer, &peer_profile);
    let owner_operator = operator(&owner, &owner_profile);
    let owner_identity = owner_endpoint.peer();
    let peer_identity = peer_endpoint.peer();
    let owner_epoch = owner.identity().instance_epoch;
    let peer_epoch = peer.identity().instance_epoch;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    peer_endpoint
        .set_shares(&peer_operator, owner_identity.clone(), &[])
        .unwrap();
    let device = Target {
        host_id: owner_identity.host_id.clone(),
        id: Id::try_from("virtual:echo").unwrap(),
        kind: ResourceKind::try_from("device").unwrap(),
        session_id: None,
        session_epoch: None,
    };
    let hidden_device = Target {
        id: Id::try_from("private-port").unwrap(),
        ..device.clone()
    };
    let shares = [LanShare {
        target: device.clone(),
        access: LanShareAccess::ReadOnly,
    }];

    async fn accept(
        listener: &TcpListener,
        admission: &LanAdmission,
    ) -> HostResult<(
        AuthenticatedActor,
        LanConnection<server::TlsStream<TcpStream>>,
    )> {
        let (socket, _) = listener.accept().await.unwrap();
        admission.accept(socket).await
    }

    // 公钥匹配也不得接受声称错误 Host ID 的连接。
    let mut incorrect_peer = peer_identity.clone();
    incorrect_peer.host_id = Id::try_from("incorrect-peer").unwrap();
    owner_endpoint
        .set_shares(&owner_operator, incorrect_peer.clone(), &shares)
        .unwrap();
    let admission = owner_endpoint.admission().unwrap();
    let (outbound, inbound) = tokio::join!(
        peer_endpoint.connect(address, &owner_identity.host_id),
        accept(&listener, &admission),
    );
    assert!(outbound.is_err());
    assert_eq!(inbound.unwrap_err().code, "LAN_HOST_ID_MISMATCH");
    owner_endpoint
        .unpair(&owner_operator, &incorrect_peer)
        .unwrap();
    owner_endpoint
        .set_shares(&owner_operator, peer_identity.clone(), &shares)
        .unwrap();

    // 重启同一 Host，保留配对身份并公布新进程代次。
    drop(owner_endpoint);
    drop(owner);
    let mut owner = HostServer::bind(owner_profile.path()).await.unwrap();
    let owner_endpoint = owner.lan_endpoint().unwrap();
    let admission = owner_endpoint.admission().unwrap();
    let (outbound, inbound) = tokio::join!(
        peer_endpoint.connect(address, &owner_identity.host_id),
        accept(&listener, &admission),
    );
    let outbound = outbound.unwrap();
    let (actor, inbound) = inbound.unwrap();
    assert_eq!(outbound.peer, owner_identity);
    assert_eq!(outbound.instance_epoch, owner.identity().instance_epoch);
    assert_ne!(outbound.instance_epoch, owner_epoch);
    assert_eq!(inbound.peer, peer_identity);
    assert_eq!(inbound.instance_epoch, peer_epoch);

    let auth = owner.auth();
    auth.require(&actor, "content.read", &device).unwrap();
    assert_eq!(
        auth.require(&actor, "metadata.read", &hidden_device)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        auth.require(&actor, "device.modify", &device)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    assert_eq!(
        auth.authenticate(actor.client_id(), None)
            .err()
            .unwrap()
            .code,
        "UNAUTHENTICATED"
    );
    let operator = operator(&owner, &owner_profile);
    assert_eq!(
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: actor.client_id().clone(),
                permissions: vec!["device.modify".into()],
                targets: vec![hidden_device],
                expires_at: None,
            }
        )
        .unwrap_err()
        .code,
        "PERMISSION_DENIED"
    );
    owner_endpoint
        .set_shares(
            &operator,
            peer_identity.clone(),
            &[LanShare {
                target: device.clone(),
                access: LanShareAccess::Operate,
            }],
        )
        .unwrap();
    auth.require(&actor, "device.modify", &device).unwrap();
    owner_endpoint.unpair(&operator, &peer_identity).unwrap();
    assert_eq!(
        auth.require(&actor, "content.read", &device)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    let (outbound, inbound) = tokio::join!(
        peer_endpoint.connect(address, &owner_identity.host_id),
        accept(&listener, &admission),
    );
    assert!(outbound.is_err());
    assert_eq!(inbound.unwrap_err().code, "UNAUTHENTICATED");
}
