use super::*;
use crate::test_support::{Gate, Harness, id};

struct Release(Arc<Gate>);
impl Drop for Release {
    fn drop(&mut self) {
        self.0.release();
    }
}
fn hold(gate: &Gate) {
    while !gate.is_released() {
        gate.hold();
    }
}
struct OpeningPort {
    close_gate: Arc<Gate>,
    closed: Arc<AtomicBool>,
}
impl NativePort for OpeningPort {
    fn capabilities(&self) -> TransportCapabilities {
        serial_capabilities()
    }
    fn read(&mut self, _: usize, _: Duration) -> BackendResult<ReadBlock> {
        Ok(ReadBlock {
            bytes: Arc::from([]),
            message: None,
        })
    }
    fn begin_write(
        &mut self,
        _: WritePayload,
        _: Duration,
        _: Arc<AtomicBool>,
        _: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        unreachable!()
    }
    fn configure(&mut self, _: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        unreachable!()
    }
    fn control(&mut self, _: ControlCommand) -> BackendResult<ControlResult> {
        unreachable!()
    }
    fn begin_drain(&mut self, _: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        unreachable!()
    }
    fn close(&mut self) -> BackendResult<()> {
        hold(&self.close_gate);
        self.closed.store(true, Ordering::SeqCst);
        Ok(())
    }
}
async fn opening_host(open: Arc<Gate>, close: Arc<Gate>, closed: Arc<AtomicBool>) -> Harness {
    let mut h = Harness::new().await;
    h.host.shutdown().await.unwrap();
    h.host = crate::Host::with_runtime(
        h.store.clone(),
        h.auth.clone(),
        h.clock.clone(),
        Arc::new(move |_, _| {
            let open = open.clone();
            let close_gate = close.clone();
            let closed = closed.clone();
            start_native(
                move || {
                    hold(&open);
                    Ok(Box::new(OpeningPort { close_gate, closed }))
                },
                Arc::new(AtomicBool::new(false)),
            )
        }),
    )
    .await
    .unwrap();
    h
}

#[tokio::test]
async fn final_fix_native_open_timeout_retains_unpublished_owner_until_close() {
    let open = Arc::new(Gate::default());
    let close = Arc::new(Gate::default());
    let _release_open = Release(open.clone());
    let _release_close = Release(close.clone());
    let closed = Arc::new(AtomicBool::new(false));
    let h = opening_host(open.clone(), close.clone(), closed.clone()).await;
    let operation = h
        .invoke(h.call(
            &h.device("opening-timeout"),
            "device.open",
            serde_json::json!({"configuration": SerialConfiguration::default()}),
        ))
        .await;
    open.entered().await;
    let outcome = h.wait(&operation.operation_id).await;
    assert!(
        outcome.error.is_some(),
        "two-second native open wait must settle without inventing success"
    );
    let first = tokio::time::timeout(Duration::from_secs(6), h.host.shutdown())
        .await
        .expect("shutdown must remain bounded");
    assert!(!closed.load(Ordering::SeqCst));
    open.release();
    close.entered().await;
    let second = tokio::time::timeout(Duration::from_secs(6), h.host.shutdown())
        .await
        .expect("late native close must remain bounded");
    close.release();
    crate::test_support::until(|| closed.load(Ordering::SeqCst)).await;
    assert_eq!(
        first.unwrap_err().code,
        "SHUTDOWN_INCOMPLETE",
        "opening native owner must remain Host-owned"
    );
    assert_eq!(
        second.unwrap_err().code,
        "SHUTDOWN_INCOMPLETE",
        "late close must remain Host-owned"
    );
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            if h.host.shutdown().await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("confirmed unpublished close must release Host responsibility");
}

#[tokio::test]
async fn final_fix_revocation_before_publication_retains_native_close_owner() {
    let open = Arc::new(Gate::default());
    let close = Arc::new(Gate::default());
    let _release_open = Release(open.clone());
    let _release_close = Release(close.clone());
    let closed = Arc::new(AtomicBool::new(false));
    let h = opening_host(open.clone(), close.clone(), closed.clone()).await;
    let operation = h
        .invoke(h.call(
            &h.device("opening-revoked"),
            "device.open",
            serde_json::json!({"configuration": SerialConfiguration::default()}),
        ))
        .await;
    open.entered().await;
    let operator = h
        .auth
        .authenticate_user_control(
            &id("operator"),
            &ContextToken::try_from("test-user-control").unwrap(),
        )
        .unwrap();
    h.auth
        .revoke(
            &operator,
            RevokeParams {
                actor_id: h.actor.id().clone(),
                permissions: vec!["device.modify".into()],
                targets: vec![Target {
                    host_id: h.host_id.clone(),
                    kind: ResourceKind::try_from("host").unwrap(),
                    id: h.host_id.clone(),
                    session_id: None,
                    session_epoch: None,
                }],
            },
        )
        .unwrap();
    open.release();
    let outcome = h.wait(&operation.operation_id).await;
    assert_eq!(outcome.state, OperationState::Failed);
    let error = outcome.error.expect("revoked open must fail");
    // 授权复核与撤权通知竞争；两条路径都必须拒绝发布并保留清理责任。
    assert!(
        matches!(error.code.as_str(), "CANCELLED" | "PERMISSION_DENIED"),
        "{error:?}"
    );
    assert_eq!(
        h.auth
            .require(&h.actor, "device.modify", &operation.target)
            .unwrap_err()
            .code,
        "PERMISSION_DENIED"
    );
    close.entered().await;
    let shutdown = tokio::time::timeout(Duration::from_secs(6), h.host.shutdown())
        .await
        .expect("shutdown must remain bounded");
    assert!(!closed.load(Ordering::SeqCst));
    close.release();
    crate::test_support::until(|| closed.load(Ordering::SeqCst)).await;
    assert_eq!(
        shutdown.unwrap_err().code,
        "SHUTDOWN_INCOMPLETE",
        "failed publication cannot discard native close responsibility"
    );
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            if h.host.shutdown().await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("confirmed unpublished close must release Host responsibility");
}
