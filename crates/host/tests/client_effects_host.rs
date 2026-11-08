//! These tests use the real Host dispatcher. They must fail until client actions
//! are registered and routed; a standalone effect registry cannot satisfy them.
mod support;

use serde_json::json;
use serial_workbench_client::{ConnectOptions, HostClient};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    auth::AuthService,
    client_effects::ClientEffects,
    ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler},
    settings::SettingsService,
    storage::{Acceptance, Settlement, Store, canonical_digest},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use support::{Harness, id};
use tokio::sync::{mpsc, oneshot};

fn client_target(h: &Harness) -> Target {
    Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("client").unwrap(),
        id: id("missing-viewer"),
        session_id: None,
        session_epoch: None,
    }
}

fn query(h: &Harness, action: &str, target: Target, params: serde_json::Value) -> Query {
    Query {
        protocol_version: ProtocolVersion::V0_1,
        host_id: h.host_id.clone(),
        instance_epoch: h.store.identity().unwrap().instance_epoch,
        actor_id: h.actor.id().clone(),
        request_id: RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap(),
        action_id: id(action),
        target,
        params: serde_json::from_value(params).unwrap(),
        reveal_target: RevealTarget {
            page_id: id("settings"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    }
}

// Catches GUI-only registration and silently selecting another/default window.
#[tokio::test]
async fn missing_viewer_returns_client_required_with_exact_capability() {
    let h = Harness::new().await;
    let error = h
        .host
        .query(
            &h.actor,
            query(&h, "client.window.read", client_target(&h), json!({})),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "CLIENT_REQUIRED");
    assert_eq!(
        serde_json::to_value(error.details.unwrap()).unwrap(),
        json!({"requiredCapabilities":["client.window.read"]})
    );
    h.host.shutdown().await.unwrap();
}

// Catches discovery being contingent on a window already being open.
#[tokio::test]
async fn catalog_exposes_typed_client_query_even_without_viewer() {
    let h = Harness::new().await;
    let target = Target {
        host_id: h.host_id.clone(),
        kind: ResourceKind::try_from("host").unwrap(),
        id: h.host_id.clone(),
        session_id: None,
        session_epoch: None,
    };
    let result = h
        .host
        .query(
            &h.actor,
            query(&h, "catalog.list", target, json!({"pageSize":"100"})),
        )
        .await
        .unwrap();
    let QueryResult::Catalog(catalog) = result else {
        panic!("catalog result")
    };
    let spec = catalog
        .items
        .iter()
        .find(|spec| spec.action_id.as_str() == "client.window.read")
        .expect("missing fixed client action");
    assert_eq!(spec.execution_location, ExecutionLocation::Client);
    assert_eq!(
        spec.target_kinds,
        vec![ResourceKind::try_from("client").unwrap()]
    );
    assert_eq!(
        serde_json::to_value(&spec.input_schema).unwrap()["additionalProperties"],
        false
    );
    assert!(
        !catalog
            .items
            .iter()
            .any(|spec| spec.action_id.as_str() == "client.clipboard.writeText")
    );
    h.host.shutdown().await.unwrap();
}

// Catches borrowing content.read/device.modify or the native operator identity
// to perform a normal caller's clipboard operation.
#[tokio::test]
async fn ordinary_actor_cannot_write_clipboard_without_explicit_client_permission() {
    let h = Harness::new().await;
    let q = query(
        &h,
        "client.clipboard.writeText",
        client_target(&h),
        json!({"text":"private"}),
    );
    let call = Call {
        protocol_version: q.protocol_version,
        host_id: q.host_id,
        instance_epoch: q.instance_epoch,
        actor_id: q.actor_id,
        request_id: q.request_id,
        request_context: h.store.issue_context(&h.actor).unwrap().token,
        action_id: q.action_id,
        target: q.target,
        params: q.params,
        reveal_target: q.reveal_target,
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    };
    assert_eq!(
        h.host.invoke(&h.actor, call).await.unwrap_err().code,
        "PERMISSION_DENIED"
    );
    h.host.shutdown().await.unwrap();
}

// Catches forwarding unknown native parameters before checking the fixed schema.
#[tokio::test]
async fn client_query_rejects_unknown_native_command_field() {
    let h = Harness::new().await;
    let error = h
        .host
        .query(
            &h.actor,
            query(
                &h,
                "client.window.read",
                client_target(&h),
                json!({"command":"quit_app"}),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");
    h.host.shutdown().await.unwrap();
}

// Component tests below use real AuthService and ConnectionContext values
// captured from authenticated HostServer sockets, then call ClientEffects
// directly. They do not claim to exercise the complete effect IPC pipeline.
struct ContextRecorder {
    host: Host,
    seen: mpsc::UnboundedSender<ConnectionContext>,
}
impl RequestHandler for ContextRecorder {
    fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
        let _ = self.seen.send(context.clone());
        self.host.handle(context, request)
    }
    fn disconnected(&self, context: &ConnectionContext) {
        self.host.disconnected(context);
    }
    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<()>> + Send>> {
        let host = self.host.clone();
        Box::pin(async move { host.shutdown().await })
    }
}
struct ComponentFixture {
    _profile: tempfile::TempDir,
    owner: ClientEffects,
    store: Store,
    auth: AuthService,
    manual_admissions: Mutex<Vec<Id>>,
    operator: ConnectionContext,
    ordinary: ConnectionContext,
    _operator_client: HostClient,
    _ordinary_client: HostClient,
    stop: oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}
impl ComponentFixture {
    async fn new() -> Self {
        let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(profile.path()).await.unwrap();
        let store = server.store();
        let auth = server.auth();
        let owner = ClientEffects::new(store.clone(), auth.clone());
        let host = Host::new(store.clone(), auth.clone()).await.unwrap();
        let (seen, mut contexts) = mpsc::unbounded_channel();
        let recorder = Arc::new(ContextRecorder { host, seen });
        let (stop, stopped) = oneshot::channel();
        let running = tokio::spawn(async move {
            server
                .serve_until(recorder, async {
                    let _ = stopped.await;
                })
                .await
        });
        let ordinary_client = HostClient::connect(ConnectOptions::new(
            profile.path().to_path_buf(),
            id("desktop"),
            ClientKind::Desktop,
        ))
        .await
        .unwrap();
        let ordinary = capture_context(&ordinary_client, &mut contexts).await;
        let mut options = ConnectOptions::new(
            profile.path().to_path_buf(),
            id("desktop"),
            ClientKind::Desktop,
        );
        options.user_control_credential =
            Some(serial_workbench_client::read_user_control_credential(profile.path()).unwrap());
        let operator_client = HostClient::connect(options).await.unwrap();
        let operator = capture_context(&operator_client, &mut contexts).await;
        assert_eq!(ordinary.actor.client_id(), operator.actor.client_id());
        assert_ne!(ordinary.actor.id(), operator.actor.id());
        assert!(!ordinary.actor.is_user_control());
        assert!(operator.actor.is_user_control());
        Self {
            _profile: profile,
            owner,
            store,
            auth,
            manual_admissions: Mutex::new(Vec::new()),
            operator,
            ordinary,
            _operator_client: operator_client,
            _ordinary_client: ordinary_client,
            stop,
            running,
        }
    }
    fn missing_target(&self) -> Target {
        Target {
            host_id: self._ordinary_client.attachment().host_id.clone(),
            kind: ResourceKind::try_from("client").unwrap(),
            id: id("missing-component-viewer"),
            session_id: None,
            session_epoch: None,
        }
    }
    fn grant(&self, target: &Target, permission: &str) {
        self.auth
            .authorize(
                &self.operator.actor,
                AuthorizeParams {
                    client_id: self.ordinary.actor.client_id().clone(),
                    permissions: vec![permission.into()],
                    targets: vec![target.clone()],
                    expires_at: None,
                },
            )
            .unwrap();
    }
    fn accept_effect(&self, target: &Target, action: &ClientEffectAction) -> (RequestId, Id) {
        let request_id = next_request_id();
        let wire = serde_json::to_value(action).unwrap();
        let call = Call {
            protocol_version: ProtocolVersion::V0_1,
            host_id: target.host_id.clone(),
            instance_epoch: self.store.identity().unwrap().instance_epoch,
            actor_id: self.ordinary.actor.id().clone(),
            request_id: request_id.clone(),
            request_context: self
                .store
                .issue_context(&self.ordinary.actor)
                .unwrap()
                .token,
            action_id: id(action.capability().action_id()),
            target: target.clone(),
            params: serde_json::from_value(wire["params"].clone()).unwrap(),
            reveal_target: RevealTarget {
                page_id: id("settings"),
                workspace_id: None,
                session_id: None,
                panel_id: None,
                result_ref: None,
            },
            expected_revision: None,
            lease_id: None,
            execution_mode: None,
        };
        let Acceptance::New(operation) = self
            .store
            .accept(
                &self.ordinary.actor,
                &call,
                &canonical_digest(&call).unwrap(),
            )
            .unwrap()
        else {
            panic!("new effect admission")
        };
        self.manual_admissions
            .lock()
            .unwrap()
            .push(operation.operation_id.clone());
        (request_id, operation.operation_id)
    }
    async fn finish(self) {
        // These records were created directly by this component fixture, without
        // a Host runner or native transport. Never fabricate completion for work
        // that reached durable Running or acquired an actual platform owner.
        for operation_id in self.manual_admissions.lock().unwrap().drain(..) {
            let operation = self.store.get(&self.ordinary.actor, &operation_id).unwrap();
            assert_eq!(operation.state, OperationState::Queued);
            assert!(operation.started_at.is_none());
            let cancelled = self
                .store
                .request_cancel(&self.ordinary.actor, &operation_id)
                .unwrap();
            assert_eq!(cancelled.state, OperationState::Cancelled);
            assert_eq!(
                self.store
                    .get(&self.ordinary.actor, &operation_id)
                    .unwrap()
                    .state,
                OperationState::Cancelled
            );
        }
        self.stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(6), self.running).await
            .expect("component fixture server did not finish after its queued admissions were cancelled")
            .unwrap().unwrap();
    }
}
async fn capture_context(
    client: &HostClient,
    contexts: &mut mpsc::UnboundedReceiver<ConnectionContext>,
) -> ConnectionContext {
    let attach = client.attachment();
    let query = Query {
        protocol_version: attach.protocol_version,
        host_id: attach.host_id.clone(),
        instance_epoch: attach.instance_epoch,
        actor_id: attach.actor_id.clone(),
        request_id: next_request_id(),
        action_id: id("catalog.list"),
        target: Target {
            host_id: attach.host_id.clone(),
            kind: ResourceKind::try_from("host").unwrap(),
            id: attach.host_id.clone(),
            session_id: None,
            session_epoch: None,
        },
        params: serde_json::from_value(json!({"pageSize":"100"})).unwrap(),
        reveal_target: RevealTarget {
            page_id: id("workbench"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
    };
    let reply = client.request(RpcRequest::Query(query)).await.unwrap();
    assert!(matches!(reply, RpcReply::Success { .. }));
    tokio::time::timeout(Duration::from_secs(3), contexts.recv())
        .await
        .unwrap()
        .unwrap()
}
fn next_request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).unwrap()
}
fn registration_params() -> ClientRegisterParams {
    ClientRegisterParams {
        generation: 1.into(),
        capabilities: vec![ClientCapability::WindowRead],
    }
}

// Catches a native-kind claim or same clientId being treated as operator authority.
#[tokio::test]
async fn component_registration_rejects_real_ordinary_desktop_connection() {
    let f = ComponentFixture::new().await;
    assert_eq!(
        f.owner
            .register(&f.ordinary, registration_params())
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    f.finish().await;
}

// Catches accepting no registration, or accidentally using a connection ID as
// the public resource target, while proving real operator registration succeeds.
#[tokio::test]
async fn component_operator_registration_produces_opaque_live_client_target() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(&f.operator, registration_params())
        .unwrap();
    assert_eq!(registration.target.kind.as_str(), "client");
    assert_ne!(registration.target.id, f.operator.connection_id);
    assert_ne!(registration.target.id, *f.operator.actor.client_id());
    f.owner
        .preflight(
            &f.ordinary.actor,
            &registration.target,
            &ClientEffectAction::WindowRead {},
        )
        .unwrap();
    let repeated = f
        .owner
        .register(&f.operator, registration_params())
        .unwrap();
    assert_eq!(registration, repeated);
    f.finish().await;
}

// Catches target preflight falling back to some other window or arbitrary OS label.
#[tokio::test]
async fn component_preflight_missing_target_reports_required_capability() {
    let f = ComponentFixture::new().await;
    let error = f
        .owner
        .preflight(
            &f.ordinary.actor,
            &f.missing_target(),
            &ClientEffectAction::WindowRead {},
        )
        .unwrap_err();
    assert_eq!(error.code, "CLIENT_REQUIRED");
    assert_eq!(
        serde_json::to_value(error.details.unwrap()).unwrap(),
        json!({"requiredCapabilities":["client.window.read"]})
    );
    f.finish().await;
}

// Catches reservation silently accepting an effect without a live receiver.
#[tokio::test]
async fn component_reserve_missing_target_does_not_admit_delivery() {
    let f = ComponentFixture::new().await;
    let result = f.owner.reserve(
        &f.ordinary.actor,
        &f.missing_target(),
        next_request_id(),
        None,
        ClientEffectAction::WindowRead {},
    );
    let Err(error) = result else {
        panic!("missing target admitted a delivery")
    };
    assert_eq!(error.code, "CLIENT_REQUIRED");
    f.finish().await;
}

// This reaches the budget assertion only after registration/reservation works.
// Dropping a query waiter must not create fresh delivery capacity indefinitely.
#[tokio::test]
async fn component_sixteen_dispatched_queries_keep_budget_when_waiters_drop() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(&f.operator, registration_params())
        .unwrap();
    for _ in 0..16 {
        let (dispatch, waiter) = f
            .owner
            .reserve(
                &f.ordinary.actor,
                &registration.target,
                next_request_id(),
                None,
                ClientEffectAction::WindowRead {},
            )
            .unwrap();
        f.owner
            .mark_dispatched(&dispatch.request.delivery_id)
            .unwrap();
        drop(waiter);
    }
    let result = f.owner.reserve(
        &f.ordinary.actor,
        &registration.target,
        next_request_id(),
        None,
        ClientEffectAction::WindowRead {},
    );
    let Err(error) = result else {
        panic!("dropped waiters released dispatched delivery budget")
    };
    assert_eq!(error.code, "HOST_BUSY");
    f.finish().await;
}

fn effect_receipt(
    request: &ClientEffectRequest,
    outcome: ClientEffectOutcome,
) -> ClientReceiptSubmission {
    ClientReceiptSubmission::Effect(Box::new(ClientEffectReceipt {
        host_id: request.host_id.clone(),
        instance_epoch: request.instance_epoch,
        client_target_id: request.client_target_id.clone(),
        generation: request.generation,
        delivery_id: request.delivery_id.clone(),
        outcome,
    }))
}
fn window_result() -> ClientEffectResult {
    ClientEffectResult::Window(ClientWindowSnapshot {
        geometry: ClientWindowGeometry {
            width: 900.into(),
            height: 600.into(),
            min_width: 300.into(),
            min_height: 200.into(),
            max_width: 1600.into(),
            max_height: 1000.into(),
            default_width: 900.into(),
            default_height: 600.into(),
        },
        maximized: false,
        fullscreen: false,
    })
}

// Catches releasing pending capacity before a valid receipt, and conflating
// confirmed platform failure with missing/uncertain transport completion.
#[tokio::test]
async fn component_valid_receipt_releases_budget_and_preserves_known_failure_outcome() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(&f.operator, registration_params())
        .unwrap();
    let mut first = None;
    for index in 0..16 {
        let (dispatch, waiter) = f
            .owner
            .reserve(
                &f.ordinary.actor,
                &registration.target,
                next_request_id(),
                None,
                ClientEffectAction::WindowRead {},
            )
            .unwrap();
        f.owner
            .mark_dispatched(&dispatch.request.delivery_id)
            .unwrap();
        if index == 0 {
            first = Some((dispatch, waiter));
        }
    }
    let (dispatch, waiter) = first.unwrap();
    let receipt = effect_receipt(
        &dispatch.request,
        ClientEffectOutcome::Failed {
            error: HostError::new("WINDOW_ERROR", "private platform detail"),
        },
    );
    f.owner.receipt(&f.operator, receipt.clone()).unwrap();
    f.owner.receipt(&f.operator, receipt).unwrap();
    let ClientEffectOutcome::Failed { error } = waiter.wait().await.unwrap() else {
        panic!("known failure receipt was not preserved")
    };
    assert_eq!(error.code, "WINDOW_ERROR");
    assert_ne!(error.message, "private platform detail");
    f.owner
        .reserve(
            &f.ordinary.actor,
            &registration.target,
            next_request_id(),
            None,
            ClientEffectAction::WindowRead {},
        )
        .unwrap();
    f.finish().await;
}

// Catches wrong-kind or old-generation receipts being acknowledged and releasing
// the slot while the original query is still waiting for its actual result.
#[tokio::test]
async fn component_wrong_receipt_does_not_complete_original_delivery() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(&f.operator, registration_params())
        .unwrap();
    let (dispatch, waiter) = f
        .owner
        .reserve(
            &f.ordinary.actor,
            &registration.target,
            next_request_id(),
            None,
            ClientEffectAction::WindowRead {},
        )
        .unwrap();
    f.owner
        .mark_dispatched(&dispatch.request.delivery_id)
        .unwrap();
    let wrong = effect_receipt(
        &dispatch.request,
        ClientEffectOutcome::Succeeded {
            result: ClientEffectResult::Installed {},
        },
    );
    assert_eq!(
        f.owner.receipt(&f.operator, wrong).unwrap_err().code,
        "INVALID_ARGUMENT"
    );
    let mut receipt = effect_receipt(
        &dispatch.request,
        ClientEffectOutcome::Succeeded {
            result: window_result(),
        },
    );
    if let ClientReceiptSubmission::Effect(receipt) = &mut receipt {
        receipt.generation = 2.into();
    }
    assert_eq!(
        f.owner.receipt(&f.operator, receipt).unwrap_err().code,
        "PERMISSION_DENIED"
    );
    f.owner
        .receipt(
            &f.operator,
            effect_receipt(
                &dispatch.request,
                ClientEffectOutcome::Succeeded {
                    result: window_result(),
                },
            ),
        )
        .unwrap();
    assert!(matches!(
        waiter.wait().await.unwrap(),
        ClientEffectOutcome::Succeeded {
            result: ClientEffectResult::Window(_),
        }
    ));
    f.finish().await;
}

// Catches unlimited new generations bypassing the global target count by
// retiring already-dispatched deliveries; only true destruction frees a slot.
#[tokio::test]
async fn component_retired_dispatched_targets_hold_global_slots_until_destroyed() {
    let f = ComponentFixture::new().await;
    let mut first = None;
    for generation in 1..=16_u64 {
        let registration = f
            .owner
            .register(
                &f.operator,
                ClientRegisterParams {
                    generation: generation.into(),
                    capabilities: vec![ClientCapability::WindowRead],
                },
            )
            .unwrap();
        let (dispatch, waiter) = f
            .owner
            .reserve(
                &f.ordinary.actor,
                &registration.target,
                next_request_id(),
                None,
                ClientEffectAction::WindowRead {},
            )
            .unwrap();
        f.owner
            .mark_dispatched(&dispatch.request.delivery_id)
            .unwrap();
        drop(waiter);
        f.owner
            .unregister(
                &f.operator,
                ClientUnregisterParams {
                    client_target_id: registration.target.id.clone(),
                    generation: registration.generation,
                },
            )
            .unwrap();
        if generation == 1 {
            first = Some(registration);
        }
    }
    assert_eq!(
        f.owner
            .register(
                &f.operator,
                ClientRegisterParams {
                    generation: 17.into(),
                    capabilities: vec![ClientCapability::WindowRead]
                }
            )
            .unwrap_err()
            .code,
        "HOST_BUSY"
    );
    let first = first.unwrap();
    assert_eq!(
        f.owner
            .destroyed(&first.target.id, 99.into())
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    f.owner
        .destroyed(&first.target.id, first.generation)
        .unwrap();
    let next = f
        .owner
        .register(
            &f.operator,
            ClientRegisterParams {
                generation: 17.into(),
                capabilities: vec![ClientCapability::WindowRead],
            },
        )
        .unwrap();
    assert_ne!(next.target.id, first.target.id);
    f.finish().await;
}

// Catches accounting only the pending item count while allowing several large
// fixed clipboard payloads to exceed the shared per-target encoded-byte budget.
#[tokio::test]
async fn component_encoded_byte_limit_rejects_fourth_full_clipboard_payload() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(
            &f.operator,
            ClientRegisterParams {
                generation: 1.into(),
                capabilities: vec![ClientCapability::ClipboardWriteText],
            },
        )
        .unwrap();
    f.grant(&registration.target, "client.clipboard.write");
    let action = ClientEffectAction::ClipboardWriteText {
        text: "x".repeat(256 * 1024),
    };
    for _ in 0..3 {
        let (request_id, operation) = f.accept_effect(&registration.target, &action);
        let (dispatch, waiter) = f
            .owner
            .reserve(
                &f.ordinary.actor,
                &registration.target,
                request_id,
                Some(operation),
                action.clone(),
            )
            .unwrap();
        f.owner
            .mark_dispatched(&dispatch.request.delivery_id)
            .unwrap();
        drop(waiter);
    }
    let (request_id, operation) = f.accept_effect(&registration.target, &action);
    let result = f.owner.reserve(
        &f.ordinary.actor,
        &registration.target,
        request_id,
        Some(operation),
        action,
    );
    let Err(error) = result else {
        panic!("four encoded 256 KiB payloads exceeded 1 MiB budget")
    };
    assert_eq!(error.code, "HOST_BUSY");
    f.finish().await;
}

// Catches treating receiver timeout as destruction and letting the old target
// continue sending while the first effect may still be executing natively.
#[tokio::test]
async fn component_timeout_revokes_target_but_late_query_receipt_is_still_valid() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(&f.operator, registration_params())
        .unwrap();
    let (dispatch, waiter) = f
        .owner
        .reserve(
            &f.ordinary.actor,
            &registration.target,
            next_request_id(),
            None,
            ClientEffectAction::WindowRead {},
        )
        .unwrap();
    f.owner
        .mark_dispatched(&dispatch.request.delivery_id)
        .unwrap();
    f.owner.timeout(&dispatch.request.delivery_id).unwrap();
    assert_eq!(waiter.wait().await.unwrap_err().code, "TIMEOUT");
    assert_eq!(
        f.owner
            .preflight(
                &f.ordinary.actor,
                &registration.target,
                &ClientEffectAction::WindowRead {}
            )
            .unwrap_err()
            .code,
        "CLIENT_REQUIRED"
    );
    f.owner
        .receipt(
            &f.operator,
            effect_receipt(
                &dispatch.request,
                ClientEffectOutcome::Succeeded {
                    result: window_result(),
                },
            ),
        )
        .unwrap();
    assert!(f.owner.quiesce().unwrap().is_empty());
    f.finish().await;
}

fn observation(
    registration: &ClientRegistration,
    epoch: U64,
    revision: u64,
) -> ClientReceiptSubmission {
    ClientReceiptSubmission::SettingsObserved(ClientSettingsObservation {
        client_target_id: registration.target.id.clone(),
        generation: registration.generation,
        receipt: ClientSettingsEffectsReceipt {
            host_id: registration.target.host_id.clone(),
            instance_epoch: epoch,
            revision: revision.into(),
            effects: ClientPlatformEffects {
                tray_language: true,
                network_mode: true,
                run_in_background: true,
            },
        },
    })
}

// Catches automatic application being invisible to Host, overwriting newer
// application facts, or accidentally settling an unrelated business delivery.
#[tokio::test]
async fn component_settings_observation_is_target_local_monotone_and_not_a_delivery_receipt() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(&f.operator, registration_params())
        .unwrap();
    let epoch = f.store.identity().unwrap().instance_epoch;
    SettingsService::new(f.store.clone())
        .save(0.into(), SharedSettings::default())
        .unwrap();
    assert!(
        f.owner.list(&f.ordinary.actor).unwrap().clients[0]
            .settings_application
            .is_none()
    );
    let (dispatch, waiter) = f
        .owner
        .reserve(
            &f.ordinary.actor,
            &registration.target,
            next_request_id(),
            None,
            ClientEffectAction::WindowRead {},
        )
        .unwrap();
    f.owner
        .mark_dispatched(&dispatch.request.delivery_id)
        .unwrap();
    let mut waiting = Box::pin(waiter.wait());
    f.owner
        .receipt(&f.operator, observation(&registration, epoch, 1))
        .unwrap();
    f.owner
        .receipt(&f.operator, observation(&registration, epoch, 1))
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut waiting)
            .await
            .is_err()
    );
    assert_eq!(
        f.owner.list(&f.ordinary.actor).unwrap().clients[0]
            .settings_application
            .as_ref()
            .unwrap()
            .receipt
            .revision,
        U64::from(1)
    );
    assert_eq!(
        f.owner
            .receipt(&f.operator, observation(&registration, epoch, 0))
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        f.owner
            .receipt(&f.operator, observation(&registration, epoch, 2))
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        f.owner
            .receipt(
                &f.operator,
                observation(&registration, (epoch.get() + 1).into(), 1)
            )
            .unwrap_err()
            .code,
        "EPOCH_MISMATCH"
    );
    f.owner
        .receipt(
            &f.operator,
            effect_receipt(
                &dispatch.request,
                ClientEffectOutcome::Succeeded {
                    result: window_result(),
                },
            ),
        )
        .unwrap();
    assert!(matches!(
        waiting.await.unwrap(),
        ClientEffectOutcome::Succeeded { .. }
    ));
    f.finish().await;
}

fn action_call(
    f: &ComponentFixture,
    target: &Target,
    action: &ClientEffectAction,
    request_id: RequestId,
) -> Call {
    let value = serde_json::to_value(action).unwrap();
    Call {
        protocol_version: ProtocolVersion::V0_1,
        host_id: target.host_id.clone(),
        instance_epoch: f.store.identity().unwrap().instance_epoch,
        actor_id: f.ordinary.actor.id().clone(),
        request_id,
        request_context: f.store.issue_context(&f.ordinary.actor).unwrap().token,
        action_id: id(action.capability().action_id()),
        target: target.clone(),
        params: serde_json::from_value(value["params"].clone()).unwrap(),
        reveal_target: RevealTarget {
            page_id: id("settings"),
            workspace_id: None,
            session_id: None,
            panel_id: None,
            result_ref: None,
        },
        expected_revision: None,
        lease_id: None,
        execution_mode: None,
    }
}
fn admit_call(f: &ComponentFixture, call: &Call) -> Operation {
    let Acceptance::New(operation) = f
        .store
        .accept(&f.ordinary.actor, call, &canonical_digest(call).unwrap())
        .unwrap()
    else {
        panic!("new fixture admission")
    };
    f.manual_admissions
        .lock()
        .unwrap()
        .push(operation.operation_id.clone());
    operation
}
fn forget_terminal_admission(f: &ComponentFixture, operation: &Id) {
    let state = f.store.get(&f.ordinary.actor, operation).unwrap().state;
    assert!(matches!(
        state,
        OperationState::Succeeded
            | OperationState::Failed
            | OperationState::Cancelled
            | OperationState::Interrupted
            | OperationState::Unknown
    ));
    f.manual_admissions
        .lock()
        .unwrap()
        .retain(|id| id != operation);
}

// Catches deducting bytes only after durable acceptance or expanding the
// reservation when the actual Host-generated operation UUID is filled in.
#[tokio::test]
async fn component_prepare_accounts_final_operation_uuid_before_store_acceptance() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(
            &f.operator,
            ClientRegisterParams {
                generation: 1.into(),
                capabilities: vec![ClientCapability::ClipboardWriteText],
            },
        )
        .unwrap();
    f.grant(&registration.target, "client.clipboard.write");
    let action = ClientEffectAction::ClipboardWriteText {
        text: "x".repeat(256 * 1024),
    };
    let mut prepared = Vec::new();
    for _ in 0..3 {
        let call = action_call(&f, &registration.target, &action, next_request_id());
        let reservation = f
            .owner
            .prepare(
                &f.ordinary.actor,
                &registration.target,
                call.request_id.clone(),
                action.clone(),
            )
            .unwrap();
        prepared.push((call, reservation));
    }
    assert_eq!(
        serde_json::to_value(f.store.operation_metadata().unwrap()).unwrap()["items"],
        json!([])
    );
    let Err(error) = f.owner.prepare(
        &f.ordinary.actor,
        &registration.target,
        next_request_id(),
        action.clone(),
    ) else {
        panic!("prepare accepted a fourth full payload")
    };
    assert_eq!(error.code, "HOST_BUSY");
    let mut encoded = 0;
    for (call, reservation) in prepared {
        let operation = admit_call(&f, &call);
        let (dispatch, waiter) = reservation.bind(Some(&operation)).unwrap();
        assert_eq!(
            dispatch.request.operation_id.as_ref(),
            Some(&operation.operation_id)
        );
        let frame = WireFrame {
            request_id: dispatch.request.request_id.clone(),
            channel: IpcChannel::Control,
            body: IpcMessage::ClientEffect {
                request: Box::new(dispatch.request.clone()),
            },
        };
        encoded += serial_workbench_ipc::frame::encoded_length(&frame, 1024 * 1024).unwrap();
        // This fixture never handed the frame to any native/transport executor.
        f.owner
            .reject_undelivered(
                &dispatch.request.delivery_id,
                HostError::new("USER_CANCELLED", "Unsent fixture effect"),
            )
            .unwrap();
        assert!(waiter.wait().await.is_err());
    }
    assert!(encoded <= 1024 * 1024);
    f.finish().await;
}

// Catches reservations leaking on an Existing response or failed durable accept.
#[tokio::test]
async fn component_prepared_drop_returns_capacity_after_existing_or_accept_failure() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(
            &f.operator,
            ClientRegisterParams {
                generation: 1.into(),
                capabilities: vec![ClientCapability::ClipboardWriteText],
            },
        )
        .unwrap();
    f.grant(&registration.target, "client.clipboard.write");
    let action = ClientEffectAction::ClipboardWriteText {
        text: "fixture".into(),
    };
    let original = action_call(&f, &registration.target, &action, next_request_id());
    let original_operation = admit_call(&f, &original);
    let mut held = Vec::new();
    for _ in 0..15 {
        held.push(
            f.owner
                .prepare(
                    &f.ordinary.actor,
                    &registration.target,
                    next_request_id(),
                    action.clone(),
                )
                .unwrap(),
        );
    }
    let existing_reservation = f
        .owner
        .prepare(
            &f.ordinary.actor,
            &registration.target,
            original.request_id.clone(),
            action.clone(),
        )
        .unwrap();
    let Acceptance::Existing(existing) = f
        .store
        .accept(
            &f.ordinary.actor,
            &original,
            &canonical_digest(&original).unwrap(),
        )
        .unwrap()
    else {
        panic!("expected original operation")
    };
    assert_eq!(existing.operation_id, original_operation.operation_id);
    drop(existing_reservation);
    let mut rejected_call = action_call(&f, &registration.target, &action, next_request_id());
    let rejected_reservation = f
        .owner
        .prepare(
            &f.ordinary.actor,
            &registration.target,
            rejected_call.request_id.clone(),
            action.clone(),
        )
        .unwrap();
    rejected_call.request_context = ContextToken::try_from("invalid-context").unwrap();
    assert!(
        f.store
            .accept(
                &f.ordinary.actor,
                &rejected_call,
                &canonical_digest(&rejected_call).unwrap()
            )
            .is_err()
    );
    drop(rejected_reservation);
    let replacement = f
        .owner
        .prepare(
            &f.ordinary.actor,
            &registration.target,
            next_request_id(),
            action,
        )
        .unwrap();
    drop(replacement);
    drop(held);
    assert_eq!(
        serde_json::to_value(f.store.operation_metadata().unwrap()).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.finish().await;
}

// Catches losing late success/failure evidence or rewriting settled Unknown
// history after timeout. Both outcomes must persist before the ledger is freed.
#[tokio::test]
async fn component_late_business_receipts_persist_without_changing_unknown_history() {
    for outcome in [
        ClientEffectOutcome::Succeeded {
            result: ClientEffectResult::ClipboardWritten { written: True },
        },
        ClientEffectOutcome::Failed {
            error: HostError::new("CLIPBOARD_ERROR", "Client platform effect failed"),
        },
    ] {
        let f = ComponentFixture::new().await;
        let registration = f
            .owner
            .register(
                &f.operator,
                ClientRegisterParams {
                    generation: 1.into(),
                    capabilities: vec![ClientCapability::ClipboardWriteText],
                },
            )
            .unwrap();
        f.grant(&registration.target, "client.clipboard.write");
        let action = ClientEffectAction::ClipboardWriteText {
            text: "fixture".into(),
        };
        let (request, operation_id) = f.accept_effect(&registration.target, &action);
        let (dispatch, waiter) = f
            .owner
            .reserve(
                &f.ordinary.actor,
                &registration.target,
                request,
                Some(operation_id.clone()),
                action,
            )
            .unwrap();
        f.store.mark_dispatch(&operation_id).unwrap();
        f.owner
            .mark_dispatched(&dispatch.request.delivery_id)
            .unwrap();
        f.owner.timeout(&dispatch.request.delivery_id).unwrap();
        assert_eq!(waiter.wait().await.unwrap_err().code, "TIMEOUT");
        let before = f
            .store
            .settle(
                &operation_id,
                Settlement {
                    state: OperationState::Unknown,
                    result: None,
                    error: Some(HostError::new("TIMEOUT", "No final platform receipt")),
                },
            )
            .unwrap();
        forget_terminal_admission(&f, &operation_id);
        let receipt = effect_receipt(&dispatch.request, outcome.clone());
        f.owner.receipt(&f.operator, receipt.clone()).unwrap();
        let stored = f.store.get(&f.ordinary.actor, &operation_id).unwrap();
        assert_eq!(stored.state, OperationState::Unknown);
        assert_eq!(stored.result, before.result);
        assert_eq!(stored.error, before.error);
        assert_eq!(stored.settled_at, before.settled_at);
        assert_eq!(stored.result_expires_at, before.result_expires_at);
        let ClientReceiptSubmission::Effect(expected) = &receipt else {
            unreachable!()
        };
        assert_eq!(
            serde_json::to_value(&stored).unwrap()["clientEffectReceipt"],
            serde_json::to_value(expected).unwrap()
        );
        f.owner.receipt(&f.operator, receipt).unwrap();
        assert_eq!(
            f.store
                .get(&f.ordinary.actor, &operation_id)
                .unwrap()
                .revision,
            stored.revision
        );
        let conflict = effect_receipt(
            &dispatch.request,
            ClientEffectOutcome::Failed {
                error: HostError::new("DIFFERENT_ERROR", "Client platform effect failed"),
            },
        );
        assert_eq!(
            f.owner.receipt(&f.operator, conflict).unwrap_err().code,
            "REQUEST_CONFLICT"
        );
        assert!(f.owner.quiesce().unwrap().is_empty());
        f.finish().await;
    }
}

// Catches a database failure being acknowledged while freeing dispatched memory.
#[tokio::test]
async fn component_receipt_storage_failure_keeps_pending_budget_and_waiter() {
    let f = ComponentFixture::new().await;
    let registration = f
        .owner
        .register(
            &f.operator,
            ClientRegisterParams {
                generation: 1.into(),
                capabilities: vec![
                    ClientCapability::ClipboardWriteText,
                    ClientCapability::WindowRead,
                ],
            },
        )
        .unwrap();
    f.grant(&registration.target, "client.clipboard.write");
    let action = ClientEffectAction::ClipboardWriteText {
        text: "fixture".into(),
    };
    let (request, operation_id) = f.accept_effect(&registration.target, &action);
    let (dispatch, waiter) = f
        .owner
        .reserve(
            &f.ordinary.actor,
            &registration.target,
            request,
            Some(operation_id.clone()),
            action,
        )
        .unwrap();
    f.store.mark_dispatch(&operation_id).unwrap();
    f.owner
        .mark_dispatched(&dispatch.request.delivery_id)
        .unwrap();
    for _ in 0..15 {
        let (next, waiting) = f
            .owner
            .reserve(
                &f.ordinary.actor,
                &registration.target,
                next_request_id(),
                None,
                ClientEffectAction::WindowRead {},
            )
            .unwrap();
        f.owner.mark_dispatched(&next.request.delivery_id).unwrap();
        drop(waiting);
    }
    let database =
        rusqlite::Connection::open(f._profile.path().join("host-v0/state.sqlite3")).unwrap();
    database.execute_batch("CREATE TRIGGER component_receipt_write_failure BEFORE UPDATE OF operation_json ON operations BEGIN SELECT RAISE(ABORT,'fixture receipt write failure'); END;").unwrap();
    let receipt = effect_receipt(
        &dispatch.request,
        ClientEffectOutcome::Failed {
            error: HostError::new("CLIPBOARD_ERROR", "Client platform effect failed"),
        },
    );
    assert!(f.owner.receipt(&f.operator, receipt.clone()).is_err());
    let mut waiting = Box::pin(waiter.wait());
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut waiting)
            .await
            .is_err()
    );
    let Err(error) = f.owner.reserve(
        &f.ordinary.actor,
        &registration.target,
        next_request_id(),
        None,
        ClientEffectAction::WindowRead {},
    ) else {
        panic!("failed persistence released delivered budget")
    };
    assert_eq!(error.code, "HOST_BUSY");
    database
        .execute_batch("DROP TRIGGER component_receipt_write_failure;")
        .unwrap();
    f.owner.receipt(&f.operator, receipt).unwrap();
    assert!(matches!(
        waiting.await.unwrap(),
        ClientEffectOutcome::Failed { .. }
    ));
    f.store
        .settle(
            &operation_id,
            Settlement {
                state: OperationState::Failed,
                result: None,
                error: Some(HostError::new(
                    "CLIPBOARD_ERROR",
                    "Client platform effect failed",
                )),
            },
        )
        .unwrap();
    forget_terminal_admission(&f, &operation_id);
    f.owner
        .reserve(
            &f.ordinary.actor,
            &registration.target,
            next_request_id(),
            None,
            ClientEffectAction::WindowRead {},
        )
        .unwrap();
    f.finish().await;
}
