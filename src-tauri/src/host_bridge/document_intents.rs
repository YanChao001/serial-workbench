//! 本机明确文档动作；普通业务请求不授予权限。
use super::DesktopHostBridge;
use serial_workbench_core::*;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum LocalDocumentIntent {
    SettingsSave {
        expected_revision: U64,
        params: SettingsSaveParams,
    },
    WorkspaceSave {
        workspace_id: Id,
        expected_revision: U64,
        params: WorkspaceSaveParams,
    },
    FavoritesSave {
        workspace_id: Id,
        expected_revision: U64,
        params: FavoritesSaveParams,
    },
    DeviceRebind {
        workspace_id: Id,
        expected_revision: U64,
        params: RebindParams,
    },
}

impl DesktopHostBridge {
    pub(crate) async fn apply_document_intent(
        &self,
        window: &str,
        generation: U64,
        intent: LocalDocumentIntent,
    ) -> HostResult<Operation> {
        let business = self.attachment_at_generation(window, generation).await?;
        let (action, kind, id, permission, revision, params) = match intent {
            LocalDocumentIntent::SettingsSave {
                expected_revision,
                params,
            } => (
                "settings.save",
                "settings",
                Id::try_from("shared")?,
                "settings.modify",
                expected_revision,
                document_params(params)?,
            ),
            LocalDocumentIntent::WorkspaceSave {
                workspace_id,
                expected_revision,
                params,
            } => (
                "workspace.save",
                "workspace",
                workspace_id,
                "workspace.modify",
                expected_revision,
                document_params(params)?,
            ),
            LocalDocumentIntent::FavoritesSave {
                workspace_id,
                expected_revision,
                params,
            } => (
                "favorites.save",
                "workspace",
                workspace_id,
                "workspace.modify",
                expected_revision,
                document_params(params)?,
            ),
            LocalDocumentIntent::DeviceRebind {
                workspace_id,
                expected_revision,
                params,
            } => (
                "device.rebind",
                "workspace",
                workspace_id,
                "workspace.modify",
                expected_revision,
                document_params(params)?,
            ),
        };
        let target = Target {
            host_id: business.host_id.clone(),
            kind: ResourceKind::try_from(kind)?,
            id,
            session_id: None,
            session_epoch: None,
        };
        let call = Call {
            protocol_version: business.protocol_version,
            host_id: business.host_id.clone(),
            instance_epoch: business.instance_epoch,
            actor_id: business.actor_id.clone(),
            request_id: document_request_id()?,
            request_context: business.request_context,
            action_id: Id::try_from(action)?,
            target: target.clone(),
            params,
            reveal_target: RevealTarget {
                page_id: Id::try_from(if kind == "settings" {
                    "settings"
                } else {
                    "workbench"
                })?,
                workspace_id: (kind == "workspace").then(|| target.id.clone()),
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
            expected_revision: Some(revision),
            lease_id: None,
            execution_mode: Some(ExecutionMode::Interactive),
        };
        // 只授权当前业务 actor 的一个文档目标；执行仍走同代次的普通业务连接。
        let grant = crate::file_resource_commands::invoke_control(
            self,
            window,
            generation,
            "auth.authorize",
            serde_json::to_value(AuthorizeParams {
                client_id: business.client_id,
                permissions: vec![permission.into()],
                targets: vec![target],
                expires_at: None,
            })
            .map_err(|_| invalid_document_intent())?,
        )
        .await?;
        if !matches!(grant, ActionResult::AuthorizationChanged(_)) {
            return Err(HostError::new("INTERNAL", "Invalid authorization response"));
        }
        match self
            .request_at_generation(window, generation, RpcRequest::Invoke(call))
            .await?
        {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Operation(result) => Ok(result.operation),
                _ => Err(HostError::new(
                    "INTERNAL",
                    "Invalid document operation response",
                )),
            },
            RpcReply::Failure { error, .. } => Err(error),
        }
    }
}

fn document_params(params: impl serde::Serialize) -> HostResult<JsonObject> {
    serde_json::from_value(serde_json::to_value(params).map_err(|_| invalid_document_intent())?)
        .map_err(|_| invalid_document_intent())
}

fn invalid_document_intent() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid local document parameters")
}

fn document_request_id() -> HostResult<RequestId> {
    use sha2::Digest as _;
    let token = serial_workbench_ipc::identity::random_token();
    let hash = format!("{:x}", sha2::Sha256::digest(token.as_str().as_bytes()));
    RequestId::try_from(
        format!(
            "{}-{}-{}-{}-{}",
            &hash[..8],
            &hash[8..12],
            &hash[12..16],
            &hash[16..20],
            &hash[20..32]
        )
        .as_str(),
    )
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_apply_document_intent(
    window: tauri::WebviewWindow,
    generation: U64,
    intent: LocalDocumentIntent,
    state: tauri::State<'_, DesktopHostBridge>,
) -> HostResult<Operation> {
    state.bind_window(&window)?;
    state
        .apply_document_intent(window.label(), generation, intent)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_workbench_host::{Host, ipc::HostServer};
    use std::{sync::Arc, time::Duration};

    struct Fixture {
        bridge: DesktopHostBridge,
        attached: super::super::DesktopAttachment,
        store: serial_workbench_host::storage::Store,
        auth: serial_workbench_host::auth::AuthService,
        directory: tempfile::TempDir,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
        running: tokio::task::JoinHandle<HostResult<()>>,
    }

    impl Fixture {
        async fn start() -> Self {
            let directory =
                tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
            let mut server = HostServer::bind(directory.path()).await.unwrap();
            let store = server.store();
            let auth = server.auth();
            let host = Host::new(store.clone(), auth.clone()).await.unwrap();
            let (stop, done) = tokio::sync::oneshot::channel();
            let running = tokio::spawn(async move {
                server
                    .serve_until(Arc::new(host), async {
                        let _ = done.await;
                    })
                    .await
            });
            let bridge = DesktopHostBridge::new(directory.path().into());
            let attached = bridge.attach("main").await.unwrap();
            Self {
                bridge,
                attached,
                store,
                auth,
                directory,
                stop: Some(stop),
                running,
            }
        }

        fn target(&self, kind: &str, id: &str) -> Target {
            Target {
                host_id: self.attached.attachment.host_id.clone(),
                kind: ResourceKind::try_from(kind).unwrap(),
                id: Id::try_from(id).unwrap(),
                session_id: None,
                session_epoch: None,
            }
        }

        async fn request(&self, request: RpcRequest) -> HostResult<RpcResult> {
            unpack(
                self.bridge
                    .request_for_generation("main", self.attached.generation, request)
                    .await?,
            )
        }

        async fn invoke(
            &self,
            action: &str,
            target: Target,
            revision: U64,
            params: impl serde::Serialize,
        ) -> HostResult<Operation> {
            let call = call(&self.attached.attachment, action, target, revision, params);
            match self.request(RpcRequest::Invoke(call)).await? {
                RpcResult::Operation(result) => Ok(result.operation),
                _ => panic!("Expected operation reply"),
            }
        }

        async fn intent(&self, intent: LocalDocumentIntent) -> Operation {
            let operation = self
                .bridge
                .apply_document_intent("main", self.attached.generation, intent)
                .await
                .expect("Explicit local document action must be accepted by the real Host");
            assert_eq!(operation.actor_id, self.attached.attachment.actor_id);
            self.settle(operation).await
        }

        async fn settle(&self, mut operation: Operation) -> Operation {
            tokio::time::timeout(Duration::from_secs(5), async {
                while matches!(
                    operation.state,
                    OperationState::Queued
                        | OperationState::Running
                        | OperationState::CancelRequested
                ) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    let request = query(
                        &self.attached.attachment,
                        "operation.get",
                        self.target("host", self.attached.attachment.host_id.as_str()),
                        serde_json::json!({
                            "operationId": operation.operation_id,
                            "requestContext": self.attached.attachment.request_context,
                        }),
                    );
                    let RpcResult::Operation(result) = self
                        .request(RpcRequest::OperationGet(request))
                        .await
                        .unwrap()
                    else {
                        panic!("Expected persisted operation");
                    };
                    operation = result.operation;
                }
                operation
            })
            .await
            .expect("Host must settle document operation")
        }

        async fn settings(&self) -> SettingsDocumentResult {
            let query = query(
                &self.attached.attachment,
                "settings.read",
                self.target("settings", "shared"),
                serde_json::json!({}),
            );
            match self.request(RpcRequest::Query(query)).await.unwrap() {
                RpcResult::Query(QueryResult::Settings(result)) => result,
                _ => panic!("Expected settings document"),
            }
        }

        async fn workspace(&self, id: &str) -> WorkspaceDocumentResult {
            let query = query(
                &self.attached.attachment,
                "workspace.read",
                self.target("workspace", id),
                serde_json::json!({}),
            );
            match self.request(RpcRequest::Query(query)).await.unwrap() {
                RpcResult::Query(QueryResult::Workspace(result)) => result,
                _ => panic!("Expected workspace document"),
            }
        }

        async fn revoke(&self, target: Target, permission: &str) {
            let result = crate::file_resource_commands::invoke_control(
                &self.bridge,
                "main",
                self.attached.generation,
                "auth.revoke",
                serde_json::to_value(RevokeParams {
                    actor_id: self.attached.attachment.actor_id.clone(),
                    permissions: vec![permission.into()],
                    targets: vec![target],
                })
                .unwrap(),
            )
            .await
            .unwrap();
            assert!(matches!(result, ActionResult::AuthorizationChanged(_)));
        }

        async fn shutdown(mut self) {
            let _ = self.stop.take().unwrap().send(());
            (&mut self.running).await.unwrap().unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.running.abort();
        }
    }

    fn request_id() -> RequestId {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        RequestId::try_from(
            format!(
                "00000000-0000-4000-8000-{:012x}",
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            )
            .as_str(),
        )
        .unwrap()
    }

    fn query(
        attached: &AttachResult,
        action: &str,
        target: Target,
        params: serde_json::Value,
    ) -> Query {
        Query {
            protocol_version: attached.protocol_version,
            host_id: attached.host_id.clone(),
            instance_epoch: attached.instance_epoch,
            actor_id: attached.actor_id.clone(),
            request_id: request_id(),
            action_id: Id::try_from(action).unwrap(),
            target,
            params: serde_json::from_value(params).unwrap(),
            reveal_target: RevealTarget {
                page_id: Id::try_from("workbench").unwrap(),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
        }
    }

    fn call(
        attached: &AttachResult,
        action: &str,
        target: Target,
        revision: U64,
        params: impl serde::Serialize,
    ) -> Call {
        let query = query(
            attached,
            action,
            target,
            serde_json::to_value(params).unwrap(),
        );
        Call {
            protocol_version: query.protocol_version,
            host_id: query.host_id,
            instance_epoch: query.instance_epoch,
            actor_id: query.actor_id,
            request_id: query.request_id,
            request_context: attached.request_context.clone(),
            action_id: query.action_id,
            target: query.target,
            params: query.params,
            reveal_target: query.reveal_target,
            expected_revision: Some(revision),
            lease_id: None,
            execution_mode: Some(ExecutionMode::Interactive),
        }
    }

    fn unpack(reply: RpcReply) -> HostResult<RpcResult> {
        match reply {
            RpcReply::Success { result, .. } => Ok(*result),
            RpcReply::Failure { error, .. } => Err(error),
        }
    }

    fn succeeded(operation: &Operation, action: &str, target: &Target) {
        assert_eq!(operation.state, OperationState::Succeeded, "{operation:?}");
        assert_eq!(operation.action_id.as_str(), action);
        assert_eq!(&operation.target, target);
        assert!(operation.error.is_none());
    }

    #[tokio::test]
    async fn default_business_actor_cannot_save_settings_or_workspace() {
        let fixture = Fixture::start().await;
        let revision = fixture.auth.current_revision().unwrap();
        for (action, target, params) in [
            (
                "settings.save",
                fixture.target("settings", "shared"),
                serde_json::to_value(SettingsSaveParams {
                    value: SharedSettings::default(),
                })
                .unwrap(),
            ),
            (
                "workspace.save",
                fixture.target("workspace", "alpha"),
                serde_json::to_value(WorkspaceSaveParams {
                    value: WorkspaceDocument::default(),
                })
                .unwrap(),
            ),
        ] {
            assert_eq!(
                fixture
                    .invoke(action, target, 0.into(), params)
                    .await
                    .unwrap_err()
                    .code,
                "PERMISSION_DENIED"
            );
        }
        assert_eq!(fixture.settings().await.document.revision, U64::from(0));
        assert_eq!(
            fixture.workspace("alpha").await.document.revision,
            U64::from(0)
        );
        assert_eq!(fixture.auth.current_revision().unwrap(), revision);
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn settings_intent_commits_real_cas_and_keeps_other_actor_and_workspace_denied() {
        let fixture = Fixture::start().await;
        let target = fixture.target("settings", "shared");
        let mut value = fixture.settings().await.document.value;
        value.language = Language::En;
        let saved = fixture
            .intent(LocalDocumentIntent::SettingsSave {
                expected_revision: 0.into(),
                params: SettingsSaveParams {
                    value: value.clone(),
                },
            })
            .await;
        succeeded(&saved, "settings.save", &target);
        assert!(
            matches!(saved.result, Some(ActionResult::Settings(ref result)) if result.document.revision == U64::from(1) && result.document.value.language == Language::En)
        );
        assert_eq!(fixture.settings().await.document.revision, U64::from(1));
        let stored = serial_workbench_host::settings::SettingsService::new(fixture.store.clone())
            .read()
            .unwrap();
        assert_eq!(stored.value.language, Language::En);
        assert_eq!(stored.revision, U64::from(1));

        value.theme = Theme::Light;
        let revision = fixture.auth.current_revision().unwrap();
        let ordinary = fixture
            .invoke(
                "settings.save",
                target.clone(),
                1.into(),
                SettingsSaveParams {
                    value: value.clone(),
                },
            )
            .await
            .unwrap();
        let ordinary = fixture.settle(ordinary).await;
        succeeded(&ordinary, "settings.save", &target);
        assert_eq!(fixture.settings().await.document.revision, U64::from(2));
        assert_eq!(fixture.settings().await.document.value.theme, Theme::Light);
        assert_eq!(fixture.auth.current_revision().unwrap(), revision);
        assert_eq!(
            fixture
                .invoke(
                    "workspace.save",
                    fixture.target("workspace", "alpha"),
                    0.into(),
                    WorkspaceSaveParams {
                        value: WorkspaceDocument::default()
                    }
                )
                .await
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );

        let other = serial_workbench_client::HostClient::connect(
            serial_workbench_client::ConnectOptions::new(
                fixture.directory.path().into(),
                Id::try_from("other-desktop").unwrap(),
                ClientKind::Desktop,
            ),
        )
        .await
        .unwrap();
        assert_ne!(
            other.attachment().actor_id,
            fixture.attached.attachment.actor_id
        );
        let reply = other
            .request(RpcRequest::Invoke(call(
                other.attachment(),
                "settings.save",
                target,
                2.into(),
                SettingsSaveParams { value },
            )))
            .await
            .unwrap();
        assert_eq!(unpack(reply).unwrap_err().code, "PERMISSION_DENIED");
        other.close().await.unwrap();
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn workspace_intent_commits_only_selected_workspace_and_preserves_cas_conflicts() {
        let fixture = Fixture::start().await;
        let target = fixture.target("workspace", "alpha");
        let mut value = fixture.workspace("alpha").await.document.value;
        value.name = "Saved alpha".into();
        let saved = fixture
            .intent(LocalDocumentIntent::WorkspaceSave {
                workspace_id: Id::try_from("alpha").unwrap(),
                expected_revision: 0.into(),
                params: WorkspaceSaveParams {
                    value: value.clone(),
                },
            })
            .await;
        succeeded(&saved, "workspace.save", &target);
        assert!(
            matches!(saved.result, Some(ActionResult::Workspace(ref result)) if result.document.revision == U64::from(1) && result.document.value.name == "Saved alpha")
        );
        let stored = serial_workbench_host::workspace::WorkspaceService::new(
            fixture.store.clone(),
            Id::try_from("alpha").unwrap(),
        )
        .read()
        .unwrap();
        assert_eq!(stored.revision, U64::from(1));
        assert_eq!(stored.value.name, "Saved alpha");

        let conflict = fixture
            .intent(LocalDocumentIntent::WorkspaceSave {
                workspace_id: Id::try_from("alpha").unwrap(),
                expected_revision: 0.into(),
                params: WorkspaceSaveParams {
                    value: WorkspaceDocument::default(),
                },
            })
            .await;
        assert_eq!(conflict.state, OperationState::Failed);
        assert_eq!(conflict.error.unwrap().code, "REVISION_CONFLICT");
        assert_eq!(
            fixture.workspace("alpha").await.document.value.name,
            "Saved alpha"
        );
        let ordinary = fixture
            .invoke(
                "workspace.save",
                target.clone(),
                1.into(),
                WorkspaceSaveParams {
                    value: value.clone(),
                },
            )
            .await
            .unwrap();
        succeeded(&fixture.settle(ordinary).await, "workspace.save", &target);
        assert_eq!(
            fixture.workspace("alpha").await.document.revision,
            U64::from(2)
        );
        assert_eq!(
            fixture
                .invoke(
                    "workspace.save",
                    fixture.target("workspace", "beta"),
                    0.into(),
                    WorkspaceSaveParams { value }
                )
                .await
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        assert_eq!(
            fixture.workspace("beta").await.document.revision,
            U64::from(0)
        );
        assert_eq!(
            fixture
                .invoke(
                    "settings.save",
                    fixture.target("settings", "shared"),
                    0.into(),
                    SettingsSaveParams {
                        value: SharedSettings::default()
                    }
                )
                .await
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn favorites_and_rebind_intents_use_host_workspace_actions() {
        let fixture = Fixture::start().await;
        let target = fixture.target("workspace", "alpha");
        let binding_id = Id::try_from("binding-a").unwrap();
        let initial = WorkspaceDocument {
            bindings: vec![DeviceBinding {
                binding_id: binding_id.clone(),
                host_id: fixture.attached.attachment.host_id.clone(),
                device_id: Id::try_from("absent-device").unwrap(),
                fingerprint: DeviceFingerprint {
                    transport: DeviceTransportKind::Virtual,
                    vid: None,
                    pid: None,
                    serial_number: None,
                    topology_path: None,
                    evidence: IdentityEvidence::Unreliable,
                },
                configuration: SerialConfiguration::default(),
                reconnect: ReconnectPolicy::default(),
            }],
            ..WorkspaceDocument::default()
        };
        // 仅预置已有文档；被测收藏与重绑定全部经过真实 IPC / Host CAS。
        serial_workbench_host::workspace::WorkspaceService::new(
            fixture.store.clone(),
            Id::try_from("alpha").unwrap(),
        )
        .save(0.into(), initial)
        .unwrap();
        let saved = fixture
            .intent(LocalDocumentIntent::FavoritesSave {
                workspace_id: Id::try_from("alpha").unwrap(),
                expected_revision: 1.into(),
                params: FavoritesSaveParams {
                    binding_ids: vec![binding_id.clone()],
                },
            })
            .await;
        succeeded(&saved, "favorites.save", &target);
        assert_eq!(
            fixture.workspace("alpha").await.document.revision,
            U64::from(2)
        );
        assert_eq!(
            fixture
                .workspace("alpha")
                .await
                .document
                .value
                .favorite_binding_ids,
            vec![binding_id.clone()]
        );
        fixture.revoke(target.clone(), "workspace.modify").await;
        let rebound = fixture
            .intent(LocalDocumentIntent::DeviceRebind {
                workspace_id: Id::try_from("alpha").unwrap(),
                expected_revision: 2.into(),
                params: RebindParams {
                    binding_id,
                    device_id: Id::try_from("virtual:echo").unwrap(),
                },
            })
            .await;
        succeeded(&rebound, "device.rebind", &target);
        let current = fixture.workspace("alpha").await.document;
        assert_eq!(current.revision, U64::from(3));
        assert_eq!(current.value.bindings[0].device_id.as_str(), "virtual:echo");
        assert_eq!(
            current.value.bindings[0].host_id,
            fixture.attached.attachment.host_id
        );
        assert_eq!(
            fixture
                .invoke(
                    "favorites.save",
                    fixture.target("workspace", "beta"),
                    0.into(),
                    FavoritesSaveParams {
                        binding_ids: vec![]
                    }
                )
                .await
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn revoked_settings_permission_is_not_regranted_by_reads_or_ordinary_retry() {
        let fixture = Fixture::start().await;
        let target = fixture.target("settings", "shared");
        fixture
            .intent(LocalDocumentIntent::SettingsSave {
                expected_revision: 0.into(),
                params: SettingsSaveParams {
                    value: SharedSettings::default(),
                },
            })
            .await;
        fixture.revoke(target.clone(), "settings.modify").await;
        let revision = fixture.auth.current_revision().unwrap();
        for _ in 0..2 {
            assert_eq!(fixture.settings().await.document.revision, U64::from(1));
            assert_eq!(
                fixture
                    .invoke(
                        "settings.save",
                        target.clone(),
                        1.into(),
                        SettingsSaveParams {
                            value: SharedSettings::default()
                        }
                    )
                    .await
                    .unwrap_err()
                    .code,
                "PERMISSION_DENIED"
            );
        }
        assert_eq!(fixture.auth.current_revision().unwrap(), revision);
        assert_eq!(fixture.settings().await.document.revision, U64::from(1));
        fixture.shutdown().await;
    }

    #[tokio::test]
    async fn stale_generation_cannot_grant_to_replacement_attachment() {
        let mut fixture = Fixture::start().await;
        let old_generation = fixture.attached.generation;
        fixture.bridge.destroy_window("main", old_generation).await;
        fixture.attached = fixture.bridge.attach("main").await.unwrap();
        assert_ne!(fixture.attached.generation, old_generation);
        let revision = fixture.auth.current_revision().unwrap();
        for intent in [
            LocalDocumentIntent::SettingsSave {
                expected_revision: 0.into(),
                params: SettingsSaveParams {
                    value: SharedSettings::default(),
                },
            },
            LocalDocumentIntent::WorkspaceSave {
                workspace_id: Id::try_from("alpha").unwrap(),
                expected_revision: 0.into(),
                params: WorkspaceSaveParams {
                    value: WorkspaceDocument::default(),
                },
            },
        ] {
            assert_eq!(
                fixture
                    .bridge
                    .apply_document_intent("main", old_generation, intent)
                    .await
                    .unwrap_err()
                    .code,
                "EPOCH_MISMATCH"
            );
        }
        assert_eq!(fixture.auth.current_revision().unwrap(), revision);
        assert_eq!(
            fixture
                .invoke(
                    "settings.save",
                    fixture.target("settings", "shared"),
                    0.into(),
                    SettingsSaveParams {
                        value: SharedSettings::default()
                    }
                )
                .await
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        assert_eq!(
            fixture
                .invoke(
                    "workspace.save",
                    fixture.target("workspace", "alpha"),
                    0.into(),
                    WorkspaceSaveParams {
                        value: WorkspaceDocument::default()
                    }
                )
                .await
                .unwrap_err()
                .code,
            "PERMISSION_DENIED"
        );
        fixture.shutdown().await;
    }
}
