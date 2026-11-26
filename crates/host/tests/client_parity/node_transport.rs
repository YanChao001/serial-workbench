//! 真实签名的公开 SDK 连接通过 Host 的设备、会话和 Raw 合同工作。
use super::*;
use ed25519_dalek::SigningKey;
use serial_workbench_client::read_user_control_credential;
use serial_workbench_host::{
    auth::{AuthService, AuthenticatedActor},
    clock::SystemClock,
    node_runtime::{NodeRuntimeLimits, verify_node_runtime},
};
use sha2::{Digest as _, Sha256};
use std::{collections::BTreeMap, net::Ipv4Addr, path::Path, sync::atomic::AtomicBool};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

use support::node_package::{archive, with_metadata};

const PACKAGE: &str = "reference.transport";
const PROVIDER: &str = "reference.transport.tcp";
const OWNER_EXIT_MARKER: &str = "transport-owner-exit.marker";
const WAIT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
enum TransportScenario {
    Normal,
    Server,
    Rfc2217,
    OwnerExit,
    Messages,
}

const EXIT_DURING_WRITE: &str = r#"
import { existsSync, writeFileSync } from "node:fs";
import { register as registerTransport } from "./transport.mjs";

const marker = __SWB_TEST_OWNER_EXIT_MARKER__;

export const register = (context) => {
  if (existsSync(marker)) throw new Error("Fixture refuses recovery after forced owner exit");
  return registerTransport({
    ...context,
    transports: {
      register(id, open) {
        context.transports.register(id, async (options) => {
          const connection = await open(options);
          return {
            ...connection,
            async write(input) {
              await connection.write(input);
              writeFileSync(marker, "", { flag: "wx" });
              process.exit(47);
            },
          };
        });
      },
    },
  });
};
"#;

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_transport_owns_tcp_session_source_and_closes_peer() {
    signed_transport(TransportScenario::Normal).await;
}

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_transport_listens_for_one_peer_per_generation() {
    signed_transport(TransportScenario::Server).await;
}

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_transport_owner_exit_preserves_unknown_tx() {
    signed_transport(TransportScenario::OwnerExit).await;
}

#[tokio::test]
#[ignore = "Requires pnpm plugin-sdk:fixture and SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_transport_rfc2217_requires_confirmed_serial_settings() {
    signed_transport(TransportScenario::Rfc2217).await;
}

#[tokio::test]
#[ignore = "Requires SWB_NODE_RUNTIME_TEST_ROOT"]
async fn native_node_dynamic_transport_keeps_message_boundaries_in_raw_and_recording() {
    signed_transport(TransportScenario::Messages).await;
}

async fn signed_transport(scenario: TransportScenario) {
    let rfc2217 = scenario == TransportScenario::Rfc2217;
    let (package_id, provider_id, example) = if rfc2217 {
        (
            "reference.rfc2217",
            "reference.rfc2217.transport",
            "reference-rfc2217",
        )
    } else {
        (PACKAGE, PROVIDER, "reference-transport")
    };
    let package_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let program = if scenario == TransportScenario::Messages {
        include_bytes!("message_provider.mjs").to_vec()
    } else {
        std::fs::read(
            package_root
                .join(".cache/plugin-sdk/examples")
                .join(example)
                .join("main.js"),
        )
        .expect("Compile the public SDK transport fixture")
    };
    let profile = support::Profile::isolated("host-node-transport-public-");
    let runtime = tokio::task::spawn_blocking(|| {
        let root = std::env::var_os("SWB_NODE_RUNTIME_TEST_ROOT")
            .expect("Set the verified fixed Node runtime root");
        verify_node_runtime(
            Path::new(&root),
            &NodeRuntimeLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
    })
    .await
    .unwrap();
    let path = profile.path().to_path_buf();
    let mut server = HostServer::bind(&path).await.unwrap();
    let auth = server.auth();
    let credential = read_user_control_credential(&path).unwrap();
    let operator_id = id("transport-operator");
    let operator = auth
        .authenticate_user_control(&operator_id, &credential)
        .unwrap();
    let host = Host::with_verified_node_runtime_native(
        server.store(),
        auth.clone(),
        Arc::new(SystemClock::new().unwrap()),
        runtime,
    )
    .await
    .unwrap();
    let (stop, done) = oneshot::channel();
    let running = tokio::spawn(async move {
        server
            .serve_until(Arc::new(host), async {
                let _ = done.await;
            })
            .await
    });

    // 断言失败仍由外层等 Host 收回自有的 Node 和套接字。
    let checked = tokio::spawn(async move {
        let mut admin_options =
            ConnectOptions::new(path.clone(), operator_id.clone(), ClientKind::Desktop);
        admin_options.user_control_credential = Some(credential);
        let admin = HostClient::connect(admin_options).await.unwrap();
        let manager = HostClient::connect(ConnectOptions::new(
            path.clone(),
            id("transport-manager"),
            ClientKind::Cli,
        ))
        .await
        .unwrap();
        let (client_name, client_kind) = if scenario == TransportScenario::Messages {
            // The desktop action uses the same file-selection client with a non-control context.
            (operator_id, ClientKind::Desktop)
        } else {
            (id("transport-driver"), ClientKind::Cli)
        };
        let client =
            HostClient::connect(ConnectOptions::new(path.clone(), client_name, client_kind))
                .await
                .unwrap();
        let host_id = client.attachment().host_id.clone();
        let host_target = Target {
            host_id: host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: host_id.clone(),
            session_id: None,
            session_epoch: None,
        };
        grant(
            &auth,
            &operator,
            &manager,
            &host_target,
            &["plugins.manage", "content.read", "metadata.read"],
        );
        let enabled = install_signed_provider(
            &admin,
            &manager,
            &host_target,
            &path,
            program,
            scenario,
            package_id,
        )
        .await;
        let RpcResult::Query(QueryResult::NodePackageRuntime(runtime_status)) = success(
            manager
                .request(RpcRequest::Query(query(
                    &manager,
                    "node.packages.runtime",
                    &host_target,
                    json!({"id": package_id}),
                )))
                .await
                .unwrap(),
        ) else {
            panic!("Expected the signed provider runtime status");
        };
        assert_eq!(
            runtime_status.phase,
            NodePackageRuntimePhase::Active,
            "{runtime_status:?}"
        );
        grant(&auth, &operator, &client, &host_target, &["metadata.read"]);
        // Wait for a new directory scan after the package has actually activated.
        success(
            client
                .request(RpcRequest::Query(query(
                    &client,
                    "device.refresh",
                    &host_target,
                    json!({}),
                )))
                .await
                .unwrap(),
        );
        let RpcResult::Query(QueryResult::Devices(devices)) = success(
            client
                .request(RpcRequest::Query(query(
                    &client,
                    "device.list",
                    &host_target,
                    json!({}),
                )))
                .await
                .unwrap(),
        ) else {
            panic!("Expected the product device directory");
        };
        let providers = devices
            .devices
            .into_iter()
            .filter(|device| {
                device.fingerprint.transport == DeviceTransportKind::Plugin
                    && device.system_name == provider_id
            })
            .collect::<Vec<_>>();
        let [provider] = providers.as_slice() else {
            panic!("Expected exactly one signed provider: {providers:?}");
        };
        assert_eq!(provider.host_id, host_id);
        assert_eq!(provider.driver.as_deref(), Some(package_id));
        assert_eq!(provider.capabilities.semantics, TransportSemantics::Stream);
        let device = Target {
            kind: ResourceKind::try_from("device").unwrap(),
            id: provider.device_id.clone(),
            ..host_target.clone()
        };
        if scenario == TransportScenario::Messages {
            check_messages(
                &admin,
                &client,
                &auth,
                &operator,
                &host_target,
                &device,
                &path,
            )
            .await;
            return;
        }
        let reserved = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let endpoint = reserved.local_addr().unwrap();
        let (listener, transport_params) = if scenario == TransportScenario::Server {
            drop(reserved);
            (None, json!({"role":"server","port":endpoint.port()}))
        } else {
            let params = if rfc2217 {
                json!({"port": endpoint.port(), "baudRate": 115200})
            } else {
                json!({"port":endpoint.port()})
            };
            (Some(reserved), params)
        };
        let mut requested = SerialConfiguration::default();
        if rfc2217 {
            requested.data_bits = DataBits::Seven;
            requested.parity = Parity::Odd;
            requested.stop_bits = StopBits::Two;
            requested.flow_control = FlowControl::RtsCts;
        }
        let open_params = json!({
            "configuration": requested,
            "transportParams": transport_params,
        });
        denied(
            client
                .request(RpcRequest::Invoke(call(
                    &client,
                    "device.open",
                    &device,
                    open_params.clone(),
                )))
                .await
                .unwrap(),
        );
        if let Some(listener) = &listener {
            assert!(
                timeout(Duration::from_millis(100), listener.accept())
                    .await
                    .is_err()
            );
        } else {
            let unused = TcpListener::bind(endpoint)
                .await
                .expect("Unauthorized open reserved the TCP port");
            drop(unused);
        }

        grant(&auth, &operator, &client, &device, &["device.modify"]);
        if rfc2217 {
            let listener = listener.as_ref().unwrap();
            let open_failure =
                |params| rfc2217_open_failure(&client, &host_target, &device, params);
            let peer = async {
                let mut peer = accept_rfc2217(listener, true).await;
                peer_eof(&mut peer).await;
            };
            let (mismatch, ()) = tokio::join!(open_failure(open_params.clone()), peer);
            assert!(!mismatch.retryable);
            assert_eq!(
                serde_json::to_value(mismatch.details.unwrap()).unwrap(),
                json!({"protocol":"rfc2217","reason":"different_value","field":"baudRate","requestedValue":115200,"reportedValue":9600})
            );
            eprintln!("rfc2217_mismatched_baud requested=115200 reported=9600 closed=true");

            let silent_peer = async {
                let mut peer = timeout(WAIT, listener.accept()).await.unwrap().unwrap().0;
                let mut options = [0; 9];
                timeout(WAIT, peer.read_exact(&mut options))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(options, [255, 251, 0, 255, 253, 0, 255, 251, 44]);
                peer_eof(&mut peer).await;
            };
            let (expired, ()) = tokio::join!(open_failure(open_params.clone()), silent_peer);
            assert!(expired.retryable);
            assert_eq!(
                serde_json::to_value(expired.details.unwrap()).unwrap(),
                json!({"protocol":"rfc2217","reason":"timeout","field":"options"})
            );
            eprintln!("rfc2217_silent_peer reason=timeout field=options closed=true");
        }
        let opening = open_session(&client, &host_target, &device, open_params.clone());
        let (first, configured_peer) = if rfc2217 {
            let (session, peer) =
                tokio::join!(opening, accept_rfc2217(listener.as_ref().unwrap(), false));
            (session, Some(peer))
        } else {
            (opening.await, None)
        };
        let raw = client.connect_raw().await.unwrap();
        let read_params = json!({
            "sessionId":first.session_id, "sessionEpoch":first.session_epoch,
            "startEventSeq":"1", "maxEvents":"20", "maxBytes":"65536",
        });
        denied(
            raw.request(RpcRequest::Query(query(
                &client,
                "stream.read",
                &first,
                read_params.clone(),
            )))
            .await
            .unwrap(),
        );
        grant(
            &auth,
            &operator,
            &client,
            &first,
            &["content.read", "device.modify", "metadata.read"],
        );

        if rfc2217 {
            let QueryResult::Session(snapshot) = query_result(success(
                client
                    .request(RpcRequest::Query(query(
                        &client,
                        "session.get",
                        &first,
                        json!({}),
                    )))
                    .await
                    .unwrap(),
            )) else {
                panic!("Expected the confirmed serial configuration");
            };
            assert_eq!(
                snapshot.configuration,
                SerialConfiguration {
                    baud_rate: PositiveU64::try_from(U64::from(115_200)).unwrap(),
                    ..SerialConfiguration::default()
                }
            );
            eprintln!(
                "rfc2217_session_configuration baud=115200 data_bits=8 parity=none stop_bits=1 flow=none"
            );
        }

        if scenario == TransportScenario::Server {
            let empty = wait_for_terminal(
                &client,
                &host_target,
                success(
                    client
                        .request(RpcRequest::Invoke(tx_call(&client, &first, &[0xEE])))
                        .await
                        .unwrap(),
                ),
            )
            .await;
            let Some(ActionResult::Tx(receipt)) = empty.result else {
                panic!("Expected an explicit no-peer TX receipt: {empty:?}");
            };
            assert!(
                receipt.accepted_ranges.is_empty() && receipt.unknown_ranges.is_empty(),
                "{receipt:?}"
            );
        }
        let mut peer = if let Some(peer) = configured_peer {
            peer
        } else {
            connect_peer(listener.as_ref(), endpoint).await
        };
        if scenario == TransportScenario::OwnerExit {
            verify_owner_exit(&client, &manager, &host_target, &device, &first, &mut peer).await;
            assert!(path.join(OWNER_EXIT_MARKER).is_file());
            let attempt = client
                .request(RpcRequest::Invoke(call(
                    &client,
                    "device.open",
                    &device,
                    open_params,
                )))
                .await
                .unwrap();
            let fault = match attempt {
                RpcReply::Failure { error, .. } => error,
                reply => wait_for_terminal(&client, &host_target, success(reply))
                    .await
                    .error
                    .expect("Open must fail for a disappeared provider"),
            };
            assert_eq!(fault.code, "DEVICE_NOT_FOUND");
            assert!(
                timeout(
                    Duration::from_millis(100),
                    listener.as_ref().unwrap().accept()
                )
                .await
                .is_err()
            );
            eprintln!(
                "transport owner_exit signed_archive={} status=failed directory_unloaded=true open_rejected=true fixture_reactivation_gated=true",
                enabled.package.archive_sha256,
            );
            return;
        }
        let sent = [0, b'T', 13, 10, 255, 128, b'C'];
        let expected_wire = if rfc2217 {
            vec![0, b'T', 13, 10, 255, 255, 128, b'C']
        } else {
            sent.to_vec()
        };
        let accepted = success(
            client
                .request(RpcRequest::Invoke(tx_call(&client, &first, &sent)))
                .await
                .unwrap(),
        );
        let (settled, ()) = tokio::join!(settlement(&client, &host_target, accepted), async {
            let mut received = vec![0; expected_wire.len()];
            timeout(WAIT, peer.read_exact(&mut received))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(received, expected_wire);
            timeout(WAIT, peer.write_all(&received))
                .await
                .unwrap()
                .unwrap();
        },);
        let Some(ActionResult::Tx(receipt)) = settled.result else {
            panic!("Expected the Host's actual TX receipt");
        };
        assert_eq!(receipt.operation_id, settled.operation_id);
        assert_eq!(receipt.outcome, TxOutcome::Accepted);
        assert_eq!(receipt.session_id, first.id);
        assert_eq!(Some(receipt.session_epoch), first.session_epoch);
        assert!(receipt.unknown_ranges.is_empty());
        assert_eq!(
            receipt.accepted_ranges,
            vec![ByteRange {
                start: 0.into(),
                end: (sent.len() as u64).into()
            }],
        );
        assert_eq!(
            STANDARD.decode(receipt.bytes_base64.as_str()).unwrap(),
            sent
        );
        let events = timeout(WAIT, async {
            loop {
                let RpcResult::Query(QueryResult::StreamRead(page)) = success(
                    raw.request(RpcRequest::Query(query(
                        &client,
                        "stream.read",
                        &first,
                        read_params.clone(),
                    )))
                    .await
                    .unwrap(),
                ) else {
                    panic!("Expected the original byte stream");
                };
                if rx_bytes(&page.events).len() >= sent.len() {
                    break page.events;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("TCP RX did not arrive in the Host Raw source");
        assert_eq!(rx_bytes(&events), sent);
        assert!(
            events
                .windows(2)
                .all(|pair| pair[0].event_seq < pair[1].event_seq)
        );
        for event in &events {
            assert_eq!(event.host_id, host_id);
            assert_eq!(event.instance_epoch, client.attachment().instance_epoch);
            assert_eq!(event.session_id, first.id);
            assert_eq!(Some(event.session_epoch), first.session_epoch);
        }
        assert!(
            events.iter().any(
                |event| matches!(&event.payload, RawPayload::Tx(tx) if tx.as_ref() == &receipt)
            )
        );
        if rfc2217 {
            let dtr = |actor: &HostClient| {
                call(
                    actor,
                    "session.control",
                    &first,
                    json!({"line":"dtr","value":true}),
                )
            };
            denied(
                manager
                    .request(RpcRequest::Invoke(dtr(&manager)))
                    .await
                    .unwrap(),
            );
            let admitted = success(
                client
                    .request(RpcRequest::Invoke(dtr(&client)))
                    .await
                    .unwrap(),
            );
            let settle = wait_for_terminal(&client, &host_target, admitted);
            let observe = async {
                let mut command = [0; 7];
                timeout(WAIT, peer.read_exact(&mut command))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(command, [255, 250, 44, 5, 8, 255, 240]);
                peer.write_all(&[b'L', 255, 255, 10]).await.unwrap();
                timeout(Duration::from_millis(900), async {
                    loop {
                        let RpcResult::Query(QueryResult::StreamRead(page)) = success(
                            raw.request(RpcRequest::Query(query(
                                &client,
                                "stream.read",
                                &first,
                                read_params.clone(),
                            )))
                            .await
                            .unwrap(),
                        ) else {
                            panic!("Expected an active Raw page")
                        };
                        if rx_bytes(&page.events).ends_with(&[b'L', 255, 10]) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("Raw reception must keep advancing before the line reply");
                peer.write_all(&[255, 250, 44, 105, 9, 255, 240])
                    .await
                    .unwrap();
            };
            let (result, ()) = tokio::join!(settle, observe);
            assert_eq!(result.state, OperationState::Succeeded, "{result:?}");
            assert!(
                matches!(
                    result.result,
                    Some(ActionResult::Control(ControlReceipt {
                        line: ControlLine::Dtr,
                        requested: true,
                        status: ControlStatus::Confirmed,
                        actual: Some(false)
                    }))
                ),
                "{result:?}"
            );
            let confirmed_rts = async {
                completed(
                    &client,
                    &host_target,
                    call(
                        &client,
                        "session.control",
                        &first,
                        json!({"line":"rts","value":true}),
                    ),
                )
                .await
            };
            let observe_rts = async {
                let mut command = [0; 7];
                timeout(WAIT, peer.read_exact(&mut command))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(command, [255, 250, 44, 5, 11, 255, 240]);
                peer.write_all(&[255, 250, 44, 105, 11, 255, 240])
                    .await
                    .unwrap();
            };
            let (result, ()) = tokio::join!(confirmed_rts, observe_rts);
            assert!(
                matches!(
                    result.result,
                    Some(ActionResult::Control(ControlReceipt {
                        line: ControlLine::Rts,
                        requested: true,
                        status: ControlStatus::Confirmed,
                        actual: Some(true)
                    }))
                ),
                "{result:?}"
            );
            eprintln!(
                "rfc2217_live_controls denial_before_wire=true dtr_requested=true dtr_actual=false rts_actual=true raw_before_ack=true"
            );
        }
        completed(
            &client,
            &host_target,
            call(&client, "session.close", &first, json!({})),
        )
        .await;
        peer_eof(&mut peer).await;

        let reopening = open_session(&client, &host_target, &device, open_params.clone());
        let (second, mut peer) = if rfc2217 {
            tokio::join!(reopening, accept_rfc2217(listener.as_ref().unwrap(), false))
        } else {
            (
                reopening.await,
                connect_peer(listener.as_ref(), endpoint).await,
            )
        };
        assert_eq!(second.id, first.id);
        assert!(second.session_epoch > first.session_epoch);
        grant(
            &auth,
            &operator,
            &client,
            &second,
            &["content.read", "device.modify"],
        );
        let cursor_query = query(&client, "stream.cursor", &second, json!({}));
        let RpcResult::Query(QueryResult::StreamCursor(result)) = success(
            raw.request(RpcRequest::Query(cursor_query.clone()))
                .await
                .unwrap(),
        ) else {
            panic!("Expected the reopened Raw source cursor");
        };
        assert_eq!(result.target, second);
        assert_eq!(result.cursor.host_id, host_id);
        assert_eq!(
            result.cursor.instance_epoch,
            client.attachment().instance_epoch
        );
        let RpcResult::Subscription(subscription) = success(
            raw.request(RpcRequest::StreamSubscribe(query(
                &client,
                "stream.subscribe",
                &second,
                json!({
                    "scopeId": result.cursor.scope_id,
                    "after": result.cursor,
                    "queueBytes":"65536",
                    "initialCreditBytes":"0",
                    "overflowPolicy":"drop_with_gap",
                }),
            )))
            .await
            .unwrap(),
        ) else {
            panic!("Expected a live Raw subscription");
        };

        auth.revoke(
            &operator,
            RevokeParams {
                actor_id: client.attachment().actor_id.clone(),
                permissions: vec!["content.read".into(), "device.modify".into()],
                targets: vec![device.clone(), second.clone()],
            },
        )
        .unwrap();
        denied(raw.request(RpcRequest::Query(cursor_query)).await.unwrap());
        denied(
            client
                .request(RpcRequest::Invoke(tx_call(&client, &second, &[1])))
                .await
                .unwrap(),
        );
        let ended = timeout(WAIT, raw.next_event())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            matches!(&ended.body, IpcMessage::SubscriptionEnded { subscription_id, error }
                if subscription_id == &subscription.subscription_id && error.code == "PERMISSION_DENIED"),
            "{ended:?}",
        );

        // 其他获准调用仍可使用同一实际连接，停用包后由对端核对关闭。
        grant(&auth, &operator, &manager, &second, &["device.modify"]);
        let survived = completed(&manager, &host_target, tx_call(&manager, &second, &[0x5a])).await;
        assert!(
            matches!(survived.result, Some(ActionResult::Tx(ref tx)) if tx.outcome == TxOutcome::Accepted)
        );
        let mut payload = [0];
        timeout(WAIT, peer.read_exact(&mut payload))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(payload, [0x5a]);
        if rfc2217 {
            let control = async {
                let request = call(
                    &manager,
                    "session.control",
                    &second,
                    json!({"line":"dtr","value":false}),
                );
                let admitted = success(manager.request(RpcRequest::Invoke(request)).await.unwrap());
                wait_for_terminal(&manager, &host_target, admitted).await
            };
            let silent = async {
                let mut command = [0; 7];
                timeout(WAIT, peer.read_exact(&mut command))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(command, [255, 250, 44, 5, 9, 255, 240]);
                peer_eof(&mut peer).await;
            };
            let (result, ()) = tokio::join!(control, silent);
            assert_eq!(result.state, OperationState::Unknown, "{result:?}");
            assert!(
                matches!(
                    result.result,
                    Some(ActionResult::Control(ControlReceipt {
                        line: ControlLine::Dtr,
                        requested: false,
                        status: ControlStatus::Unknown,
                        actual: None
                    }))
                ),
                "{result:?}"
            );
            grant(&auth, &operator, &manager, &device, &["device.modify"]);
            let (third, new_peer) = tokio::join!(
                open_session(&manager, &host_target, &device, open_params),
                accept_rfc2217(listener.as_ref().unwrap(), false),
            );
            assert!(third.session_epoch > second.session_epoch);
            peer = new_peer;
            eprintln!("rfc2217_live_control_unknown closed=true new_session_epoch=true");
        }
        let disabled = package_change(
            &manager,
            &host_target,
            "node.packages.setEnabled",
            json!({"id":package_id,"archiveSha256":enabled.package.archive_sha256,"enabled":false}),
            enabled.revision,
        )
        .await;
        assert!(!disabled.package.enabled);
        peer_eof(&mut peer).await;
        if rfc2217 {
            eprintln!(
                "rfc2217_verified configured_baud=115200 raw_bytes=7 telnet_bytes=8 rejected_mismatch_before_session=true reopened_and_peer_closed=true"
            );
        }
        if listener.is_none() {
            TcpListener::bind(endpoint)
                .await
                .expect("The provider left the TCP port open");
        }
        eprintln!(
            "transport role={} signed_archive={} device={} session={} epochs={:?}/{:?} tcp_tx_rx_bytes={} peer_closed=true",
            if listener.is_some() {
                "client"
            } else {
                "server"
            },
            enabled.package.archive_sha256,
            device.id,
            first.id,
            first.session_epoch,
            second.session_epoch,
            sent.len(),
        );
    });
    let result = checked.await;
    let _ = stop.send(());
    timeout(Duration::from_secs(15), running)
        .await
        .expect("Host did not finish transport teardown")
        .unwrap()
        .unwrap();
    result.unwrap();
}

fn denied(reply: RpcReply) {
    assert!(
        matches!(&reply, RpcReply::Failure { error, .. } if error.code == "PERMISSION_DENIED"),
        "{reply:?}",
    );
}

async fn check_messages(
    admin: &HostClient,
    client: &HostClient,
    auth: &AuthService,
    operator: &AuthenticatedActor,
    host: &Target,
    device: &Target,
    path: &Path,
) {
    use tokio::net::UdpSocket;
    assert_eq!(admin.attachment().client_id, client.attachment().client_id);
    let peer = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    grant(auth, operator, client, device, &["device.modify"]);
    let session = open_session(
        client,
        host,
        device,
        json!({
            "configuration": SerialConfiguration::default(),
            "transportParams": {"port": peer.local_addr().unwrap().port()},
        }),
    )
    .await;
    grant(
        auth,
        operator,
        client,
        &session,
        &["metadata.read", "content.read", "device.modify"],
    );
    let QueryResult::Session(snapshot) = query_result(success(
        client
            .request(RpcRequest::Query(query(
                client,
                "session.get",
                &session,
                json!({}),
            )))
            .await
            .unwrap(),
    )) else {
        panic!("Expected negotiated message session");
    };
    assert_eq!(snapshot.capabilities.semantics, TransportSemantics::Message);
    let target_for = |reference: &ObjectRef| Target {
        kind: reference.kind.clone(),
        id: reference.id.clone(),
        ..host.clone()
    };
    let registered = completed(
        admin,
        host,
        call(
            admin,
            "file.register",
            host,
            json!({
                "path": path.join("message-recording"), "purpose": "capture_target",
            }),
        ),
    )
    .await;
    let Some(ActionResult::FileMetadata(archive)) = registered.result else {
        panic!("Expected archive reference");
    };
    let destination = target_for(&archive.file_ref);
    grant(
        auth,
        operator,
        client,
        &destination,
        &["workspace.modify", "content.read", "metadata.read"],
    );
    let mut record = call(
        client,
        "capture.start",
        &destination,
        json!({
            "sessionRefs": [&session], "targetRef": archive.file_ref, "overflowPolicy": "stop",
        }),
    );
    record.execution_mode = Some(ExecutionMode::Independent);
    let RpcResult::Operation(owner) =
        success(client.request(RpcRequest::Invoke(record)).await.unwrap())
    else {
        panic!("Expected capture operation");
    };
    let owner_id = owner.operation.operation_id.clone();
    let live = timeout(WAIT, async {
        loop {
            let RpcResult::Operation(observed) = success(
                client
                    .request(RpcRequest::OperationGet(query(
                        client,
                        "operation.get",
                        host,
                        json!({"operationId":owner_id}),
                    )))
                    .await
                    .unwrap(),
            ) else {
                panic!("Expected capture status");
            };
            if let Some(ActionResult::Reference(result)) = observed.operation.result {
                break result.result_ref;
            }
            assert!(
                !observed.operation.state.is_terminal(),
                "{:?}",
                observed.operation.error
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();

    let sent = completed(client, host, tx_call(client, &session, b"probe")).await;
    assert!(matches!(
        sent.result,
        Some(ActionResult::Tx(TxReceipt {
            outcome: TxOutcome::Accepted,
            ..
        }))
    ));
    let mut packet = [0; 16];
    let (length, address) = timeout(WAIT, peer.recv_from(&mut packet))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&packet[..length], b"probe");
    let text = "T测试".as_bytes();
    let binary = vec![0xa5; 20_001];
    for bytes in [text, &[][..], &binary] {
        assert_eq!(peer.send_to(bytes, address).await.unwrap(), bytes.len());
    }
    let raw = client.connect_raw().await.unwrap();
    let read_params = json!({
        "sessionId":session.session_id, "sessionEpoch":session.session_epoch,
        "startEventSeq":"1", "maxEvents":"20", "maxBytes":"65536",
    });
    let chunks = timeout(WAIT, async {
        loop {
            let QueryResult::StreamRead(read) = query_result(success(
                raw.request(RpcRequest::Query(query(
                    client,
                    "stream.read",
                    &session,
                    read_params.clone(),
                )))
                .await
                .unwrap(),
            )) else {
                panic!("Expected Raw read");
            };
            let chunks = read
                .events
                .into_iter()
                .filter_map(|event| match event.payload {
                    RawPayload::Rx(chunk) => Some(chunk),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if chunks.len() >= 4 {
                break chunks;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(chunks.len(), 4, "Idle reads must not create RX events");
    let [short, zero, head, tail] = chunks.as_slice() else {
        unreachable!()
    };
    let decode = |chunk: &RxPayload| STANDARD.decode(chunk.bytes_base64.as_str()).unwrap();
    assert_eq!(decode(short), text);
    assert!(decode(zero).is_empty());
    assert_eq!(zero.byte_start, zero.byte_end);
    let second = tail.message.as_ref().unwrap();
    let first = head.message.as_ref().unwrap();
    assert_eq!(short.message.as_ref().unwrap().message_type, "text");
    let empty = zero.message.as_ref().unwrap();
    assert_eq!(empty.message_type, "datagram");
    assert_eq!(empty.message_length.get(), 0);
    assert_eq!(head.byte_start, zero.byte_end);
    assert_eq!(first.message_id, second.message_id);
    assert_ne!(first.message_id, empty.message_id);
    assert_eq!(first.message_type, "binary");
    assert_eq!(second.message_type, "binary");
    assert_eq!(first.fragment_offset.get(), 0);
    assert_eq!(second.fragment_offset.get(), 16384);
    assert_eq!(first.message_length.get(), 20_001);
    assert_eq!(first.message_length, second.message_length);
    assert_eq!([decode(head), decode(tail)].concat(), binary);
    assert_eq!(head.byte_end, tail.byte_start);

    let ambiguous = wait_for_terminal(
        client,
        host,
        success(
            client
                .request(RpcRequest::Invoke(tx_call(client, &session, b"partial")))
                .await
                .unwrap(),
        ),
    )
    .await;
    let Some(ActionResult::Tx(receipt)) = ambiguous.result else {
        panic!("Expected unknown write evidence");
    };
    assert_eq!(receipt.outcome, TxOutcome::Unknown);
    assert_eq!(
        receipt.unknown_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: 7.into()
        }]
    );

    timeout(WAIT, async {
        loop {
            let QueryResult::CaptureStatus(progress) = query_result(success(
                client
                    .request(RpcRequest::Query(query(
                        client,
                        "capture.status",
                        &target_for(&live),
                        json!({"captureRef":live}),
                    )))
                    .await
                    .unwrap(),
            )) else {
                panic!("Expected live capture");
            };
            if progress.summary.watermarks.written.get() >= 8 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    completed(
        client,
        host,
        call(
            client,
            "capture.stop",
            &target_for(&live),
            json!({"captureRef":live}),
        ),
    )
    .await;
    let finished = wait_for_terminal(client, host, RpcResult::Operation(owner)).await;
    assert_eq!(finished.state, OperationState::Succeeded, "{finished:?}");
    let Some(ActionResult::CaptureStatus(status)) = finished.result else {
        panic!("Expected finished recording reference");
    };
    assert!(status.summary.container_complete && status.summary.source_continuous);
    let QueryResult::CaptureTail(capture) = query_result(success(
        raw.request(RpcRequest::Query(query(
            client,
            "capture.tail",
            &target_for(&status.capture_ref),
            json!({"captureRef":status.capture_ref,"maxRecords":"30","maxBytes":"65536"}),
        )))
        .await
        .unwrap(),
    )) else {
        panic!("Expected recorded instances");
    };
    for expected in [short, zero] {
        assert!(capture.records.iter().any(|record| matches!(record, ReplayRecord::Inline { record }
            if matches!(&record.entry, CaptureEntry::Event(event) if matches!(&event.payload, RawPayload::Rx(rx) if rx == expected)))),
            "Recorded message is missing its original metadata");
    }
    let session_state = || async {
        let QueryResult::Session(current) = query_result(success(
            client
                .request(RpcRequest::Query(query(
                    client,
                    "session.get",
                    &session,
                    json!({}),
                )))
                .await
                .unwrap(),
        )) else {
            panic!("Expected session state");
        };
        current.state
    };
    assert_eq!(session_state().await, SessionState::Open);
    peer.send_to(&[0xfa, 0xce], address).await.unwrap();
    timeout(WAIT, async {
        loop {
            if session_state().await == SessionState::Disconnected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    raw.close().await.unwrap();
    eprintln!(
        "node_message fixture=udp text_bytes={} empty_events=1 binary_bytes={} fragments=2 recorded_metadata=true partial_write_unknown=true eof_disconnected=true",
        text.len(),
        binary.len()
    );
}
fn grant(
    auth: &AuthService,
    operator: &AuthenticatedActor,
    client: &HostClient,
    target: &Target,
    permissions: &[&str],
) {
    auth.authorize(
        operator,
        AuthorizeParams {
            client_id: client.attachment().client_id.clone(),
            permissions: permissions
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
            targets: vec![target.clone()],
            expires_at: None,
        },
    )
    .unwrap();
}

fn call(client: &HostClient, action: &str, target: &Target, params: Value) -> Call {
    let query = query(client, action, target, params);
    Call {
        protocol_version: query.protocol_version,
        host_id: query.host_id,
        instance_epoch: query.instance_epoch,
        actor_id: query.actor_id,
        request_id: query.request_id,
        request_context: client.attachment().request_context.clone(),
        action_id: query.action_id,
        target: query.target,
        params: query.params,
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
        reveal_target: query.reveal_target,
    }
}

fn tx_call(client: &HostClient, session: &Target, bytes: &[u8]) -> Call {
    call(
        client,
        "session.tx",
        session,
        json!({"bytesBase64":STANDARD.encode(bytes),"writeWaitMs":"1000"}),
    )
}

async fn settlement(client: &HostClient, host: &Target, result: RpcResult) -> Operation {
    let settled = wait_for_terminal(client, host, result).await;
    assert_eq!(settled.state, OperationState::Succeeded, "{settled:?}");
    settled
}

async fn wait_for_terminal(client: &HostClient, host: &Target, result: RpcResult) -> Operation {
    let RpcResult::Operation(result) = result else {
        panic!("Expected accepted Operation")
    };
    let operation_id = result.operation.operation_id;
    timeout(WAIT, async {
        loop {
            let reply = client
                .request(RpcRequest::OperationGet(query(
                    client,
                    "operation.get",
                    host,
                    json!({"operationId":operation_id}),
                )))
                .await
                .unwrap();
            let RpcResult::Operation(result) = success(reply) else {
                panic!("Expected operation.get receipt")
            };
            if result.operation.state.is_terminal() {
                break result.operation;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Transport Operation did not settle")
}

async fn completed(client: &HostClient, host: &Target, call: Call) -> Operation {
    settlement(
        client,
        host,
        success(client.request(RpcRequest::Invoke(call)).await.unwrap()),
    )
    .await
}

async fn open_session(
    client: &HostClient,
    host: &Target,
    device: &Target,
    params: Value,
) -> Target {
    let opened = completed(client, host, call(client, "device.open", device, params)).await;
    let Some(ActionResult::Opened(opened)) = opened.result else {
        panic!("Expected a Host-owned session");
    };
    assert!(!opened.reused);
    Target {
        host_id: host.host_id.clone(),
        kind: ResourceKind::try_from("session").unwrap(),
        id: opened.session_id.clone(),
        session_id: Some(opened.session_id),
        session_epoch: Some(opened.session_epoch),
    }
}

async fn connect_peer(listener: Option<&TcpListener>, endpoint: std::net::SocketAddr) -> TcpStream {
    if let Some(listener) = listener {
        let (peer, address) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
        assert!(address.ip().is_loopback());
        peer
    } else {
        timeout(WAIT, TcpStream::connect(endpoint))
            .await
            .unwrap()
            .unwrap()
    }
}

async fn rfc2217_open_failure(
    client: &HostClient,
    host_target: &Target,
    device: &Target,
    open_params: Value,
) -> HostError {
    let request = call(client, "device.open", device, open_params);
    let attempt = client
        .request(RpcRequest::Invoke(request.clone()))
        .await
        .unwrap();
    let terminal = wait_for_terminal(client, host_target, success(attempt)).await;
    assert_eq!(terminal.state, OperationState::Failed, "{terminal:?}");
    assert!(terminal.result.is_none(), "{terminal:?}");
    let repeated = client.request(RpcRequest::Invoke(request)).await.unwrap();
    let RpcResult::Operation(repeated) = success(repeated) else {
        panic!("Expected the replayed operation");
    };
    assert_eq!(repeated.operation.operation_id, terminal.operation_id);
    assert_eq!(repeated.operation.error, terminal.error);
    let error = terminal.error.unwrap();
    assert_eq!(error.code, "PLUGIN_TRANSPORT_OPEN_FAILED");
    error
}

async fn accept_rfc2217(listener: &TcpListener, different_baud: bool) -> TcpStream {
    let (mut peer, address) = timeout(WAIT, listener.accept()).await.unwrap().unwrap();
    assert!(address.ip().is_loopback());
    let mut options = [0; 9];
    timeout(WAIT, peer.read_exact(&mut options))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(options, [255, 251, 0, 255, 253, 0, 255, 251, 44]);
    timeout(
        WAIT,
        peer.write_all(&[255, 253, 0, 255, 251, 0, 255, 253, 44]),
    )
    .await
    .unwrap()
    .unwrap();
    let expected: &[&[u8]] = &[&[1, 0, 1, 194, 0], &[2, 8], &[3, 1], &[4, 1], &[5, 1]];
    for &setting in expected {
        let mut frame = vec![255, 250, 44];
        frame.extend_from_slice(setting);
        frame.extend_from_slice(&[255, 240]);
        let mut received = vec![0; frame.len()];
        timeout(WAIT, peer.read_exact(&mut received))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received, frame);
        if different_baud {
            timeout(
                WAIT,
                peer.write_all(&[255, 250, 44, 101, 0, 0, 37, 128, 255, 240]),
            )
            .await
            .unwrap()
            .unwrap();
            return peer;
        }
        frame[3] += 100;
        timeout(WAIT, peer.write_all(&frame))
            .await
            .unwrap()
            .unwrap();
    }
    peer
}

async fn peer_eof(peer: &mut TcpStream) {
    let mut byte = [0];
    assert_eq!(
        timeout(WAIT, peer.read(&mut byte))
            .await
            .expect("Peer did not close")
            .unwrap(),
        0
    );
}

async fn verify_owner_exit(
    client: &HostClient,
    manager: &HostClient,
    host: &Target,
    device: &Target,
    session: &Target,
    peer: &mut TcpStream,
) {
    let payload = [0, 0x7e, 0x80, 0xff];
    let accepted = success(
        client
            .request(RpcRequest::Invoke(tx_call(client, session, &payload)))
            .await
            .unwrap(),
    );
    let (operation, ()) = tokio::join!(wait_for_terminal(client, host, accepted), async {
        let mut observed = [0; 4];
        timeout(WAIT, peer.read_exact(&mut observed))
            .await
            .expect("TCP peer did not receive the dispatched bytes")
            .unwrap();
        assert_eq!(observed, payload);
        let mut extra = [0];
        match timeout(WAIT, peer.read(&mut extra)).await.unwrap() {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            other => panic!("Expected peer closure without extra bytes: {other:?}"),
        }
    });
    let Some(ActionResult::Tx(receipt)) = operation.result.as_ref() else {
        panic!("Expected a durable TX receipt: {operation:?}");
    };
    assert_eq!(operation.state, OperationState::Unknown);
    assert_eq!(receipt.outcome, TxOutcome::Unknown);
    assert!(receipt.accepted_ranges.is_empty());
    assert_eq!(
        receipt.unknown_ranges,
        vec![ByteRange {
            start: 0.into(),
            end: (payload.len() as u64).into()
        }]
    );

    let stopped = timeout(WAIT, async {
        loop {
            let RpcResult::Query(QueryResult::NodePackageRuntime(status)) = success(
                manager
                    .request(RpcRequest::Query(query(
                        manager,
                        "node.packages.runtime",
                        host,
                        json!({"id":PACKAGE}),
                    )))
                    .await
                    .unwrap(),
            ) else {
                panic!("Expected the package runtime status");
            };
            if status.phase == NodePackageRuntimePhase::Failed {
                break status;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Host did not observe the provider process exit");
    assert!(stopped.error.is_some(), "{stopped:?}");
    for action in ["device.list", "device.refresh"] {
        let RpcResult::Query(QueryResult::Devices(directory)) = success(
            client
                .request(RpcRequest::Query(query(client, action, host, json!({}))))
                .await
                .unwrap(),
        ) else {
            panic!("Expected device directory from {action}");
        };
        assert!(
            !directory
                .devices
                .iter()
                .any(|item| item.device_id == device.id),
            "Retired provider returned by {action}: {directory:?}"
        );
    }
    eprintln!(
        "transport tx={} actual_peer_bytes={} accepted_bytes=0 unknown_bytes={} provider_process_exited=true",
        operation.operation_id,
        payload.len(),
        payload.len(),
    );
}

async fn install_signed_provider(
    admin: &HostClient,
    manager: &HostClient,
    host: &Target,
    profile: &Path,
    program: Vec<u8>,
    scenario: TransportScenario,
    package_id: &str,
) -> NodePackageChangeResult {
    let key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    let key_digest = format!("{:x}", Sha256::digest(key));
    let mut approve = call(
        admin,
        "node.sources.approveKey",
        host,
        json!({"source":"test-source","keyId":"test-key","publicKey":key,"publicKeySha256":key_digest}),
    );
    approve.expected_revision = Some(0.into());
    completed(admin, host, approve).await;
    let (entry, wrapped) = match scenario {
        TransportScenario::Normal
        | TransportScenario::Server
        | TransportScenario::Rfc2217
        | TransportScenario::Messages => (program, None),
        TransportScenario::OwnerExit => (
            EXIT_DURING_WRITE
                .replace(
                    "__SWB_TEST_OWNER_EXIT_MARKER__",
                    &serde_json::to_string(&profile.join(OWNER_EXIT_MARKER)).unwrap(),
                )
                .into_bytes(),
            Some(program),
        ),
    };
    let mut payload = BTreeMap::from([
        (
            "manifest.json".into(),
            if scenario == TransportScenario::Rfc2217 {
                include_bytes!(
                    "../../../../packages/plugin-sdk/examples/reference-rfc2217/manifest.json"
                )
                .to_vec()
            } else {
                include_bytes!(
                    "../../../../packages/plugin-sdk/examples/reference-transport/manifest.json"
                )
                .to_vec()
            },
        ),
        ("dist/main.mjs".into(), entry),
        (
            "LICENSE".into(),
            include_bytes!("../../../../LICENSE").to_vec(),
        ),
        (
            "NOTICE".into(),
            include_bytes!("../../../../NOTICE").to_vec(),
        ),
    ]);
    if let Some(wrapped) = wrapped {
        payload.insert("dist/transport.mjs".into(), wrapped);
    }
    let archive_path = profile.join("signed-reference-transport.zip");
    std::fs::write(&archive_path, archive(&with_metadata(payload, true))).unwrap();
    let registered = completed(
        admin,
        host,
        call(
            admin,
            "file.register",
            host,
            json!({"path":archive_path,"purpose":"read_file"}),
        ),
    )
    .await;
    let Some(ActionResult::FileMetadata(reference)) = registered.result else {
        panic!("Expected a registered signed archive");
    };
    let installed = package_change(
        manager, host, "node.packages.install",
        json!({"archiveRef":reference.file_ref,"source":{"kind":"trusted","source":"test-source","keyId":"test-key"}}),
        0.into(),
    ).await;
    assert!(installed.package.source_verified);
    assert_eq!(installed.package.id.as_str(), package_id);
    let trust = package_change(
        admin,
        host,
        "node.packages.confirmExecutionTrust",
        json!({"id":package_id,"archiveSha256":installed.package.archive_sha256}),
        installed.revision,
    )
    .await;
    assert!(trust.package.execution_approved);
    let enabled = package_change(
        manager,
        host,
        "node.packages.setEnabled",
        json!({"id":package_id,"archiveSha256":trust.package.archive_sha256,"enabled":true}),
        trust.revision,
    )
    .await;
    assert!(enabled.package.enabled);
    enabled
}

async fn package_change(
    admin: &HostClient,
    host: &Target,
    action: &str,
    params: Value,
    revision: U64,
) -> NodePackageChangeResult {
    let mut call = call(admin, action, host, params);
    call.expected_revision = Some(revision);
    let result = completed(admin, host, call).await;
    match result.result {
        Some(
            ActionResult::NodePackageChanged(value) | ActionResult::NodePackageInstalled(value),
        ) => *value,
        other => panic!("Expected a package change receipt: {other:?}"),
    }
}
