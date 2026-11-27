use super::{AttachSelection, DesktopAttachment, DesktopHostBridge};
use serial_workbench_core::{
    ActionResult, AuthorizeParams, HostError, HostResult, LAN_CONNECT_PERMISSION, LanAccessParams,
    LanAccessResult, LanRoute, RpcReply, RpcRequest, RpcResult, U64,
};

impl DesktopHostBridge {
    pub(super) async fn select_lan_route(
        &self,
        window: &str,
        instance: u64,
        generation: Option<U64>,
        route: Option<LanRoute>,
        authorize_desktop: bool,
    ) -> HostResult<DesktopAttachment> {
        if let Some(route) = &route {
            route.socket_address()?;
        }
        self.attach_selected(
            window,
            instance,
            AttachSelection::Switch {
                generation,
                route,
                authorize_desktop,
            },
            async {},
            async { Ok(()) },
        )
        .await
    }

    pub(super) async fn authorize_paired_lan(
        &self,
        window: &str,
        instance: u64,
        route: &LanRoute,
    ) -> HostResult<()> {
        let local = self.attachment_for_instance(window, instance).await?;
        let status = self
            .manage_lan(window, local.generation, LanAccessParams::Status {})
            .await?;
        if !status
            .peers
            .iter()
            .any(|pair| pair.peer.host_id == route.host_id)
        {
            return Err(HostError::new(
                "LAN_PEER_NOT_PAIRED",
                "Pair with this computer before connecting",
            ));
        }
        // A desktop gesture grants this desktop identity one paired peer. B
        // authenticates independently and still controls which serial targets are shared.
        let params = serde_json::to_value(AuthorizeParams {
            client_id: local.attachment.client_id,
            permissions: vec![LAN_CONNECT_PERMISSION.into()],
            targets: vec![route.authorization_target(&local.attachment.host_id)],
            expires_at: None,
        })
        .map_err(|_| HostError::new("INTERNAL", "Invalid LAN access parameters"))?;
        let result = crate::file_resource_commands::invoke_control(
            self,
            window,
            local.generation,
            "auth.authorize",
            params,
        )
        .await?;
        if !matches!(result, ActionResult::AuthorizationChanged(_)) {
            return Err(HostError::new(
                "INTERNAL",
                "Invalid LAN authorization response",
            ));
        }
        Ok(())
    }

    pub(super) async fn manage_lan(
        &self,
        window: &str,
        generation: U64,
        params: LanAccessParams,
    ) -> HostResult<LanAccessResult> {
        match self
            .control_request_at_generation(window, generation, RpcRequest::LanAccess(params))
            .await?
        {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::LanAccess(result) => Ok(result),
                _ => Err(HostError::new("INTERNAL", "Invalid LAN settings response")),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_select_lan_route(
    window: tauri::WebviewWindow,
    generation: Option<U64>,
    route: Option<LanRoute>,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<DesktopAttachment> {
    let instance = state.bind_window(&window)?;
    state
        .select_lan_route(window.label(), instance, generation, route, true)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_lan_access(
    window: tauri::WebviewWindow,
    generation: U64,
    params: LanAccessParams,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<LanAccessResult> {
    state.bind_window(&window)?;
    state.manage_lan(window.label(), generation, params).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_bridge::tests::query;
    use serial_workbench_core::*;
    use serial_workbench_host::{Host, auth::AuthenticatedActor, ipc::HostServer};
    use std::{path::Path, sync::Arc, time::Duration};
    use tokio::{sync::oneshot, task::JoinHandle, time::timeout};

    fn operator(server: &HostServer, profile: &Path) -> AuthenticatedActor {
        server
            .auth()
            .authenticate_user_control(
                &Id::try_from("lan-test-operator").unwrap(),
                &serial_workbench_client::read_user_control_credential(profile).unwrap(),
            )
            .unwrap()
    }

    fn serve(
        mut server: HostServer,
        host: Host,
    ) -> (oneshot::Sender<()>, JoinHandle<HostResult<()>>) {
        let (stop, done) = oneshot::channel();
        let task = tokio::spawn(async move {
            server
                .serve_until(Arc::new(host), async {
                    let _ = done.await;
                })
                .await
        });
        (stop, task)
    }

    #[tokio::test]
    async fn desktop_lan_switch_uses_remote_business_and_local_management() {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let local_profile = directory.path().join("local");
        let owner_profile = directory.path().join("owner");
        let mut local_server = HostServer::bind(&local_profile).await.unwrap();
        let mut owner_server = HostServer::bind(&owner_profile).await.unwrap();
        let local_operator = operator(&local_server, &local_profile);
        let owner_operator = operator(&owner_server, &owner_profile);
        let local_auth = local_server.auth();
        let local_host = Host::new(local_server.store(), local_auth.clone())
            .await
            .unwrap();
        let owner_host = Host::new(owner_server.store(), owner_server.auth())
            .await
            .unwrap();
        let local_endpoint = local_server.lan_endpoint().unwrap();
        let owner_endpoint = owner_server.lan_endpoint().unwrap();
        let local_peer = local_endpoint.peer();
        let owner_peer = owner_endpoint.peer();
        let device = Target {
            host_id: owner_peer.host_id.clone(),
            kind: ResourceKind::try_from("device").unwrap(),
            id: Id::try_from("virtual:echo").unwrap(),
            session_id: None,
            session_epoch: None,
        };
        let opened = owner_host
            .devices()
            .open(
                &device,
                OpenParams {
                    transport_params: None,
                    configuration: SerialConfiguration::default(),
                    binding: None,
                },
            )
            .await
            .unwrap();
        let session = Target {
            kind: ResourceKind::try_from("session").unwrap(),
            id: opened.session_id.clone(),
            session_id: Some(opened.session_id),
            session_epoch: Some(opened.session_epoch),
            ..device
        };
        local_endpoint
            .set_shares(&local_operator, owner_peer.clone(), &[])
            .unwrap();
        owner_endpoint
            .set_shares(
                &owner_operator,
                local_peer.clone(),
                &[LanShare {
                    target: session.clone(),
                    access: LanShareAccess::Operate,
                }],
            )
            .unwrap();
        let local = serve(local_server, local_host);
        let owner = serve(owner_server, owner_host.clone());
        let owner_bridge = DesktopHostBridge::new(owner_profile);
        let owner_attach = owner_bridge.attach("main").await.unwrap();
        let enabled = owner_bridge
            .manage_lan(
                "main",
                owner_attach.generation,
                LanAccessParams::Enable {
                    address: "127.0.0.1:0".into(),
                },
            )
            .await
            .unwrap();
        let LanListenerState::Listening { address } = enabled.listener else {
            panic!("expected owner LAN listener");
        };
        let bridge = DesktopHostBridge::new(local_profile);
        let initial = bridge.attach("main").await.unwrap();
        let instance = bridge.instances.lock().unwrap().active["main"];
        let route = LanRoute {
            host_id: owner_peer.host_id.clone(),
            address,
        };
        let denied = bridge
            .select_lan_route(
                "main",
                instance,
                Some(initial.generation),
                Some(route.clone()),
                false,
            )
            .await;
        assert!(matches!(denied, Err(error) if error.code == "PERMISSION_DENIED"));
        assert_eq!(
            bridge.attach("main").await.unwrap().generation,
            initial.generation
        );
        let unpaired = bridge
            .select_lan_route(
                "main",
                instance,
                Some(initial.generation),
                Some(LanRoute {
                    host_id: Id::try_from("another-computer").unwrap(),
                    address: route.address.clone(),
                }),
                true,
            )
            .await;
        assert!(matches!(unpaired, Err(error) if error.code == "LAN_PEER_NOT_PAIRED"));
        let remote = bridge
            .select_lan_route(
                "main",
                instance,
                Some(initial.generation),
                Some(route.clone()),
                true,
            )
            .await
            .unwrap();
        assert_eq!(remote.attachment.host_id, owner_peer.host_id);
        assert_eq!(remote.lan_route, Some(route));
        assert_ne!(remote.generation, initial.generation);
        let preferences = bridge
            .attach_selected("main", instance, AttachSelection::Local, async {}, async {
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(preferences.generation, initial.generation);
        assert_eq!(preferences.attachment.host_id, local_peer.host_id);
        assert_eq!(
            bridge.attach("main").await.unwrap().generation,
            remote.generation
        );
        let mut settings_query = query(
            &preferences.attachment,
            "settings.read",
            serde_json::json!({}),
            "d4144170-064b-40fd-9988-50bf03b41a1d",
        );
        settings_query.target.kind = ResourceKind::try_from("settings").unwrap();
        settings_query.target.id = Id::try_from("shared").unwrap();
        assert!(matches!(
            bridge.request_for_generation("main", preferences.generation, RpcRequest::Query(settings_query)).await.unwrap(),
            RpcReply::Success { result, .. } if matches!(*result, RpcResult::Query(QueryResult::Settings(_)))
        ));
        let settings = bridge
            .manage_lan("main", remote.generation, LanAccessParams::Status {})
            .await
            .unwrap();
        assert_eq!(settings.local_peer, local_peer);
        let denied = bridge
            .control_request_at_generation(
                "main",
                remote.generation,
                RpcRequest::BrowserAccess(BrowserAccessParams::Status {}),
            )
            .await;
        assert!(matches!(denied, Err(error) if error.code == "PERMISSION_DENIED"));

        let bytes = "AEENCv8=";
        let mut tx = query(
            &remote.attachment,
            "session.tx",
            serde_json::json!({"bytesBase64":bytes, "writeWaitMs":"1000"}),
            "c4144170-064b-40fd-9988-50bf03b41a1d",
        );
        tx.target = session.clone();
        tx.reveal_target.session_id = session.session_id.clone();
        let call = Call {
            protocol_version: tx.protocol_version,
            host_id: tx.host_id,
            instance_epoch: tx.instance_epoch,
            actor_id: tx.actor_id,
            request_id: tx.request_id,
            request_context: remote.attachment.request_context.clone(),
            action_id: tx.action_id,
            target: tx.target,
            params: tx.params,
            reveal_target: tx.reveal_target,
            expected_revision: None,
            lease_id: None,
            execution_mode: Some(ExecutionMode::Interactive),
            workspace_startup: None,
        };
        let RpcReply::Success { result, .. } = bridge
            .request_for_generation("main", remote.generation, RpcRequest::Invoke(call))
            .await
            .unwrap()
        else {
            panic!("expected routed TX admission");
        };
        let RpcResult::Operation(accepted) = *result else {
            panic!("expected operation");
        };
        assert_eq!(accepted.operation.execution_host_id, owner_peer.host_id);
        assert_eq!(accepted.operation.actor_id, remote.attachment.actor_id);
        timeout(Duration::from_secs(8), async {
            loop {
                let mut raw = query(&remote.attachment, "stream.read", serde_json::json!({
                    "sessionId": session.id, "sessionEpoch": session.session_epoch,
                    "startEventSeq":"1", "maxEvents":"100", "maxBytes":"262144",
                }), crate::host_bridge::local_request_id().unwrap().as_str());
                raw.target = session.clone();
                let reply = bridge.raw_request_for_generation(
                    "main", remote.generation, RpcRequest::Query(raw)).await.unwrap();
                let RpcReply::Success { result, .. } = reply else { panic!("{reply:?}"); };
                let RpcResult::Query(QueryResult::StreamRead(data)) = *result else { panic!("{result:?}"); };
                if data.events.iter().any(|event| {
                    matches!(&event.payload, RawPayload::Rx(rx) if rx.bytes_base64.as_str() == bytes)
                }) && data.events.iter().any(|event| {
                    matches!(&event.payload, RawPayload::Tx(tx) if tx.operation_id == accepted.operation.operation_id)
                }) { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.unwrap();
        bridge
            .business_connection("main", remote.generation)
            .await
            .unwrap()
            .close()
            .await
            .unwrap();
        timeout(Duration::from_secs(8), async {
            while bridge.inner.lock().await.lan_windows.contains_key("main") {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        let reattached = bridge.attach("main").await.unwrap();
        assert_eq!(reattached.attachment.actor_id, remote.attachment.actor_id);
        assert_eq!(reattached.lan_route, remote.lan_route);
        assert_ne!(reattached.generation, remote.generation);
        let returned = bridge
            .select_lan_route("main", instance, Some(reattached.generation), None, true)
            .await
            .unwrap();
        assert_eq!(returned.attachment.host_id, local_peer.host_id);
        assert!(returned.lan_route.is_none());
        assert_eq!(returned.generation, initial.generation);
        assert!(
            matches!(bridge.attachment_at_generation("main", reattached.generation).await,
            Err(error) if error.code == "EPOCH_MISMATCH")
        );
        let preserved = owner_host.devices().snapshot(&session).await.unwrap();
        assert_eq!(preserved.state, SessionState::Open);
        drop(bridge);
        drop(owner_bridge);
        for (stop, task) in [local, owner] {
            stop.send(()).unwrap();
            timeout(Duration::from_secs(8), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
    }
}
