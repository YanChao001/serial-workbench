use super::tool_handoff_test_package::SignedHandoffFixture;
use crate::{
    Host,
    auth::{AuthService, AuthenticatedActor},
    device::serial::tool_handoff_sim_provider::{SIMULATED_LOCATOR, SimSerialProvider},
    storage::Store,
    test_support::{ManualClock, Profile, id},
    workspace::WorkspaceService,
};
use serde_json::{Value, json};
use serial_workbench_core::*;
use std::{sync::Arc, time::Duration};

fn request(
    store: &Store,
    actor: &AuthenticatedActor,
    target: &Target,
    action: &str,
    params: Value,
) -> Call {
    Call {
        protocol_version: ProtocolVersion::V1_0,
        host_id: target.host_id.clone(),
        instance_epoch: store.identity().unwrap().instance_epoch,
        actor_id: actor.id().clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        request_context: store.issue_context(actor).unwrap().token,
        action_id: id(action),
        target: target.clone(),
        params: serde_json::from_value(params).unwrap(),
        reveal_target: serde_json::from_value(json!({"pageId":"workbench"})).unwrap(),
        expected_revision: None,
        lease_id: None,
        execution_mode: (action == "session.toolHandoff").then_some(ExecutionMode::Independent),
        workspace_startup: None,
    }
}

async fn settled(store: &Store, actor: &AuthenticatedActor, operation: &Operation) -> Operation {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let current = store.get(actor, &operation.operation_id).unwrap();
            if current.state.is_terminal() {
                return current;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    result.unwrap_or_else(|_| {
        panic!(
            "operation {} did not settle: {:?}",
            operation.action_id,
            store.get(actor, &operation.operation_id)
        )
    })
}

async fn rejection(
    host: &Host,
    store: &Store,
    actor: &AuthenticatedActor,
    request: Call,
) -> HostError {
    match host.invoke(actor, request).await {
        Err(error) => error,
        Ok(accepted) => {
            let operation = settled(store, actor, &accepted).await;
            operation
                .error
                .clone()
                .unwrap_or_else(|| panic!("competing operation was not refused: {operation:?}"))
        }
    }
}

async fn wait_snapshot(
    host: &Host,
    target: &Target,
    ready: impl Fn(&SessionSnapshot) -> bool,
) -> SessionSnapshot {
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(snapshot) = host.devices().snapshot(target).await
                && ready(&snapshot)
            {
                return snapshot;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    match result {
        Ok(snapshot) => snapshot,
        Err(_) => panic!(
            "session did not reach expected state: {:?}",
            host.devices().snapshot(target).await
        ),
    }
}

fn next_session_epoch(target: &Target) -> Target {
    Target {
        session_epoch: Some(target.session_epoch.unwrap().checked_next().unwrap()),
        ..target.clone()
    }
}

fn reconnect_state(snapshot: &SessionSnapshot, state: ReconnectState) -> bool {
    snapshot
        .reconnect
        .as_ref()
        .is_some_and(|status| status.state == state)
}

async fn cancel_handoff(
    host: &Host,
    store: &Store,
    operator: &AuthenticatedActor,
    handoff: &Operation,
) {
    let target = Target {
        host_id: handoff.target.host_id.clone(),
        kind: ResourceKind::try_from("operation").unwrap(),
        id: handoff.operation_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let stopping = host
        .invoke(
            operator,
            request(
                store,
                operator,
                &target,
                "operation.cancel",
                json!({"reason":"user"}),
            ),
        )
        .await
        .unwrap();
    let stopped = settled(store, operator, &stopping).await;
    assert_eq!(stopped.state, OperationState::Succeeded, "{stopped:?}");
}

#[tokio::test]
async fn simulated_signed_tool_handoff_restores_only_current_reconnect_responsibility() {
    for (cancel, revoke_reconnect, cancel_before_launch) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (true, false, true),
    ] {
        let profile = Profile::isolated("tool-handoff-simulation-");
        let clock = Arc::new(ManualClock(0.into()));
        let store = Store::open_with_clock(profile.path(), clock.clone()).unwrap();
        let identity = store.begin_instance().unwrap();
        let secret = ContextToken::try_from("test-handoff-control").unwrap();
        let auth = AuthService::with_clock(store.clone(), secret.clone(), clock.clone());
        let operator = auth
            .authenticate_user_control(&id("operator"), &secret)
            .unwrap();
        let actor = auth.authenticate(&id("client"), None).unwrap().actor;
        let fixture = SignedHandoffFixture::install(
            &store,
            &profile.path().join("tool-fixture"),
            SIMULATED_LOCATOR,
        );
        let provider = Arc::new(SimSerialProvider::new(
            identity.host_id.clone(),
            fixture.device_lock(),
        ));
        let host = Host::with_device_provider(
            store.clone(),
            auth.clone(),
            clock.clone(),
            provider.clone(),
        )
        .await
        .unwrap();
        let descriptor = host
            .devices()
            .refresh()
            .await
            .unwrap()
            .devices
            .into_iter()
            .find(|device| device.system_name == SIMULATED_LOCATOR)
            .expect("simulated device disappeared from the Host directory");
        assert_eq!(descriptor.fingerprint, provider.descriptor().fingerprint);
        let device = Target {
            host_id: identity.host_id,
            kind: ResourceKind::try_from("device").unwrap(),
            id: descriptor.device_id,
            session_id: None,
            session_epoch: None,
        };
        let configuration = SerialConfiguration::default();
        let binding = DeviceBindingReference {
            workspace_id: id("bench"),
            binding_id: id("probe"),
        };
        WorkspaceService::new(store.clone(), binding.workspace_id.clone())
            .save(
                0.into(),
                WorkspaceDocument {
                    bindings: vec![DeviceBinding {
                        binding_id: binding.binding_id.clone(),
                        host_id: device.host_id.clone(),
                        device_id: device.id.clone(),
                        port_name: Some(descriptor.system_name),
                        fingerprint: descriptor.fingerprint,
                        configuration: configuration.clone(),
                        reconnect: ReconnectPolicy {
                            enabled: true,
                            ..Default::default()
                        },
                    }],
                    ..Default::default()
                },
            )
            .unwrap();
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: id("client"),
                permissions: vec!["device.modify".into()],
                targets: vec![Target {
                    kind: ResourceKind::try_from("host").unwrap(),
                    id: device.host_id.clone(),
                    ..device.clone()
                }],
                expires_at: None,
            },
        )
        .unwrap();
        auth.authorize(
            &operator,
            AuthorizeParams {
                client_id: id("client"),
                permissions: vec!["metadata.read".into()],
                targets: vec![Target {
                    kind: ResourceKind::try_from("workspace").unwrap(),
                    id: binding.workspace_id.clone(),
                    ..device.clone()
                }],
                expires_at: None,
            },
        )
        .unwrap();
        let open = || {
            request(
                &store,
                &actor,
                &device,
                "device.open",
                json!({"configuration":configuration,"binding":binding}),
            )
        };
        let admitted = host.invoke(&actor, open()).await.unwrap();
        let operation = settled(&store, &actor, &admitted).await;
        let Some(ActionResult::Opened(original)) = operation.result else {
            panic!("simulated serial device was not opened: {operation:?}");
        };
        assert!(provider.handle_is_open());
        assert_eq!(provider.open_count(), 1);
        let mut session = Target {
            kind: ResourceKind::try_from("session").unwrap(),
            id: original.session_id.clone(),
            session_id: Some(original.session_id.clone()),
            session_epoch: Some(original.session_epoch),
            ..device.clone()
        };
        let delay = configuration.reconnect_backoff_ms.get();
        wait_snapshot(&host, &session, |snapshot| {
            reconnect_state(snapshot, ReconnectState::Idle)
        })
        .await;
        if !cancel && !revoke_reconnect {
            // 在交接冻结前模拟掉线，证明自动重连实际穿过正常打开路径但被物理预约挡住。
            let handoff = host
                .devices()
                .reserve_native_tool(&operator, &session)
                .await
                .unwrap();
            let attempts = provider.native_open_attempts();
            provider.disconnect();
            wait_snapshot(&host, &session, |snapshot| {
                reconnect_state(snapshot, ReconnectState::Waiting)
            })
            .await;
            clock.advance_ms(delay);
            wait_snapshot(&host, &session, |snapshot| {
                snapshot.reconnect.as_ref().is_some_and(|status| {
                    status.state == ReconnectState::Waiting
                        && status
                            .last_error
                            .as_ref()
                            .is_some_and(|error| error.code == "DEVICE_BUSY")
                })
            })
            .await;
            assert_eq!(provider.native_open_attempts(), attempts + 1);
            assert_eq!(provider.open_count(), 1);
            assert!(!provider.handle_is_open());
            drop(handoff);
            clock.advance_ms(delay * 2);
            session = next_session_epoch(&session);
            wait_snapshot(&host, &session, |snapshot| {
                snapshot.state == SessionState::Open
                    && reconnect_state(snapshot, ReconnectState::Idle)
            })
            .await;
            assert_eq!(provider.open_count(), 2);
        }
        let opens_before_tool = provider.open_count();
        let closes_before_tool = provider.close_count();
        let held_tx = if cancel_before_launch {
            let (entered, release) = host.hold_next_session_dispatch();
            let tx = host
                .invoke(
                    &actor,
                    request(
                        &store,
                        &actor,
                        &session,
                        "session.tx",
                        json!({"bytesBase64":"AQID","writeWaitMs":"1000"}),
                    ),
                )
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), entered)
                .await
                .unwrap()
                .unwrap();
            Some((tx, release))
        } else {
            None
        };
        let handoff = host
            .invoke(
                &operator,
                request(
                    &store,
                    &operator,
                    &session,
                    "session.toolHandoff",
                    json!(fixture.params(20_000)),
                ),
            )
            .await
            .unwrap();
        if let Some((tx, release)) = held_tx {
            wait_snapshot(&host, &session, |state| {
                state.state == SessionState::Closing
            })
            .await;
            assert!(provider.handle_is_open());
            assert!(!fixture.tool_entered());
            cancel_handoff(&host, &store, &operator, &handoff).await;
            release.send(()).unwrap();
            assert_eq!(
                settled(&store, &actor, &tx).await.state,
                OperationState::Cancelled
            );
            let completed = settled(&store, &operator, &handoff).await;
            assert_eq!(completed.state, OperationState::Cancelled, "{completed:?}");
            let Some(ActionResult::ToolHandoff(receipt)) = completed.result else {
                panic!("tool handoff receipt missing: {completed:?}");
            };
            assert!(!receipt.ownership_unconfirmed);
            assert_eq!(receipt.exit_code, None);
            let returned = receipt
                .reopened
                .expect("pre-launch cancellation must return the device");
            let returned_target = next_session_epoch(&session);
            assert_eq!(returned.session_id, original.session_id);
            assert_eq!(Some(returned.session_epoch), returned_target.session_epoch);
            assert_eq!(provider.open_count(), opens_before_tool + 1);
            assert_eq!(provider.close_count(), closes_before_tool + 1);
            assert!(!fixture.tool_entered());
            let snapshot = host.devices().snapshot(&returned_target).await.unwrap();
            assert_eq!(snapshot.state, SessionState::Open);
            assert!(reconnect_state(&snapshot, ReconnectState::Idle));
            host.shutdown().await.unwrap();
            assert!(!provider.handle_is_open());
            continue;
        }
        tokio::time::timeout(Duration::from_secs(10), async {
            while !fixture.tool_entered() {
                let current = store.get(&operator, &handoff.operation_id).unwrap();
                assert!(!current.state.is_terminal(), "{current:?}");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("signed executable did not acquire the simulated serial owner");

        assert!(!provider.handle_is_open());
        assert!(!fixture.tool_exited());
        assert_eq!(provider.close_count(), closes_before_tool + 1);
        let refused = rejection(&host, &store, &actor, open()).await;
        assert!(
            matches!(refused.code.as_str(), "DEVICE_BUSY" | "HOST_BUSY"),
            "{refused:?}"
        );
        let stale_tx = request(
            &store,
            &actor,
            &session,
            "session.tx",
            json!({"bytesBase64":"AQID","writeWaitMs":"1000"}),
        );
        rejection(&host, &store, &actor, stale_tx).await;
        assert_eq!(provider.open_count(), opens_before_tool);
        assert!(!fixture.tool_exited());

        if revoke_reconnect {
            auth.revoke(
                &operator,
                RevokeParams {
                    actor_id: actor.id().clone(),
                    permissions: vec!["device.modify".into()],
                    targets: vec![device.clone()],
                },
            )
            .unwrap();
        }
        if cancel {
            cancel_handoff(&host, &store, &operator, &handoff).await;
        } else {
            fixture.allow_tool_exit();
        }
        let completed = settled(&store, &operator, &handoff).await;
        assert_eq!(
            completed.state,
            if cancel {
                OperationState::Cancelled
            } else {
                OperationState::Succeeded
            },
            "{completed:?}"
        );
        assert_eq!(fixture.tool_exited(), !cancel);
        let Some(ActionResult::ToolHandoff(receipt)) = completed.result else {
            panic!("tool handoff receipt missing: {completed:?}");
        };
        assert!(!receipt.ownership_unconfirmed);
        assert_eq!(receipt.exit_code, (!cancel).then_some(0));
        let returned = receipt
            .reopened
            .expect("confirmed exit did not return the owner");
        assert_eq!(returned.session_id, original.session_id);
        let returned_target = next_session_epoch(&session);
        assert_eq!(Some(returned.session_epoch), returned_target.session_epoch);
        assert_eq!(provider.open_count(), opens_before_tool + 1);
        assert_eq!(provider.close_count(), closes_before_tool + 1);
        assert!(provider.handle_is_open());
        let returned_snapshot = host.devices().snapshot(&returned_target).await.unwrap();
        let status = returned_snapshot
            .reconnect
            .expect("prior reconnect policy was lost");
        if revoke_reconnect {
            assert_eq!(status.state, ReconnectState::Stopped);
            assert_eq!(status.last_error.unwrap().code, "PERMISSION_DENIED");
        } else {
            assert_eq!(status.state, ReconnectState::Idle);
            provider.disconnect();
            wait_snapshot(&host, &returned_target, |snapshot| {
                reconnect_state(snapshot, ReconnectState::Waiting)
            })
            .await;
            clock.advance_ms(delay);
            let reopened = next_session_epoch(&returned_target);
            wait_snapshot(&host, &reopened, |snapshot| {
                snapshot.state == SessionState::Open
                    && reconnect_state(snapshot, ReconnectState::Idle)
            })
            .await;
            assert_eq!(provider.open_count(), opens_before_tool + 2);
        }
        host.shutdown().await.unwrap();
        assert!(!provider.handle_is_open());
    }
}
