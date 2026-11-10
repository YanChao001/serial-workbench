use super::{
    DesktopHostBridge,
    stage_trace::{ConnectTrace, TraceEvent},
};
use serial_workbench_core::*;
use serial_workbench_host::{
    Host,
    ipc::{ConnectionContext, HandlerFuture, HostServer, RequestHandler},
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

// 此处约束测试同步；连接性能由实际阶段采样单独验收。
const REPLY_WAIT_BUDGET: Duration = Duration::from_secs(10);

struct ReplyGate {
    host: Host,
    phase: &'static str,
    entered: Arc<tokio::sync::Notify>,
    release: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    reply_delay: Duration,
    actions: Mutex<Vec<String>>,
}

impl RequestHandler for ReplyGate {
    fn handle(&self, context: ConnectionContext, request: RpcRequest) -> HandlerFuture {
        let phase = match &request {
            RpcRequest::Invoke(call) => {
                self.actions
                    .lock()
                    .unwrap()
                    .push(call.action_id.to_string());
                match call.action_id.as_str() {
                    "device.open" => Some("open-acceptance"),
                    "auth.authorize" => {
                        let params: AuthorizeParams =
                            serde_json::from_value(serde_json::to_value(&call.params).unwrap())
                                .unwrap();
                        match params.targets.first().map(|target| target.kind.as_str()) {
                            Some("device") => Some("device-grant"),
                            Some("session") => Some("session-grant"),
                            _ => None,
                        }
                    }
                    _ => None,
                }
            }
            RpcRequest::Query(query) if query.action_id.as_str() == "session.get" => {
                Some("session-get")
            }
            _ => None,
        };
        let release = if phase == Some(self.phase) {
            self.release.lock().unwrap().take()
        } else {
            None
        };
        let host = self.host.clone();
        let entered = self.entered.clone();
        let reply_delay = self.reply_delay;
        Box::pin(async move {
            // 只暂停真实回复交付，不伪造接纳、权限变化或会话终态。
            let reply = host.handle(context, request).await?;
            if let Some(release) = release {
                tokio::time::sleep(reply_delay).await;
                entered.notify_one();
                release.await.unwrap();
            }
            Ok(reply)
        })
    }

    fn disconnected(&self, context: &ConnectionContext) {
        self.host.disconnected(context);
    }

    fn shutdown(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = HostResult<()>> + Send>> {
        RequestHandler::shutdown(&self.host)
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    bridge: DesktopHostBridge,
    generation: U64,
    handler: Arc<ReplyGate>,
    release: Option<tokio::sync::oneshot::Sender<()>>,
    stop: tokio::sync::oneshot::Sender<()>,
    running: tokio::task::JoinHandle<HostResult<()>>,
}

impl Fixture {
    async fn new(phase: &'static str, reply_delay: Duration) -> Self {
        let directory = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let mut server = HostServer::bind(directory.path()).await.unwrap();
        let host = Host::new(server.store(), server.auth()).await.unwrap();
        let (release, held) = tokio::sync::oneshot::channel();
        let handler = Arc::new(ReplyGate {
            host,
            phase,
            entered: Arc::new(tokio::sync::Notify::new()),
            release: Mutex::new(Some(held)),
            reply_delay,
            actions: Mutex::new(Vec::new()),
        });
        let (stop, done) = tokio::sync::oneshot::channel();
        let served = handler.clone();
        let running = tokio::spawn(async move {
            server
                .serve_until(served, async {
                    let _ = done.await;
                })
                .await
        });
        let bridge = DesktopHostBridge::new(directory.path().to_path_buf());
        let attached = bridge.attach("main").await.unwrap();
        handler.actions.lock().unwrap().clear();
        Self {
            _directory: directory,
            bridge,
            generation: attached.generation,
            handler,
            release: Some(release),
            stop,
            running,
        }
    }

    fn connect(
        &self,
        events: Arc<Mutex<Vec<TraceEvent>>>,
    ) -> tokio::task::JoinHandle<HostResult<SessionSnapshot>> {
        let bridge = self.bridge.clone();
        let generation = self.generation;
        tokio::spawn(async move {
            bridge
                .connect_device_intent_with_trace(
                    "main",
                    generation,
                    Id::try_from("virtual:echo").unwrap(),
                    OpenParams {
                        configuration: SerialConfiguration::default(),
                        binding: None,
                    },
                    ConnectTrace::observed(move |event| events.lock().unwrap().push(event)),
                )
                .await
        })
    }

    async fn wait_for_reply(
        &self,
        pending: &mut tokio::task::JoinHandle<HostResult<SessionSnapshot>>,
        events: &Arc<Mutex<Vec<TraceEvent>>>,
    ) {
        tokio::select! {
            () = self.handler.entered.notified() => {},
            result = pending => {
                let outcome = match result {
                    Ok(Ok(_)) => "succeeded before the reply was released".to_owned(),
                    Ok(Err(error)) => format!("failed with {}", error.code),
                    Err(error) => format!("task failed: {error}"),
                };
                panic!("Connection ended before {} reply gate: {outcome}", self.handler.phase);
            },
            () = tokio::time::sleep(REPLY_WAIT_BUDGET) => {
                panic!(
                    "Connection did not reach {} reply gate within {REPLY_WAIT_BUDGET:?}; stages={:?}",
                    self.handler.phase,
                    events.lock().unwrap(),
                );
            },
        }
    }

    fn release(&mut self) {
        self.release.take().unwrap().send(()).unwrap();
    }

    async fn stop(self) {
        drop(self.bridge);
        self.stop.send(()).unwrap();
        self.running.await.unwrap().unwrap();
    }
}

fn assert_single_open_and_grants(actions: &[String]) {
    assert_eq!(
        actions
            .iter()
            .filter(|action| action.as_str() == "device.open")
            .count(),
        1
    );
    assert_eq!(
        actions
            .iter()
            .filter(|action| action.as_str() == "auth.authorize")
            .count(),
        2
    );
}

#[tokio::test]
async fn device_connection_stage_done_waits_for_real_reply_without_replaying_open() {
    for phase in [
        "device-grant",
        "open-acceptance",
        "session-grant",
        "session-get",
    ] {
        // 真实回复在交付前额外延迟，阶段顺序不能依赖三秒内完成的机器速度。
        let reply_delay = if phase == "device-grant" {
            Duration::from_secs(4)
        } else {
            Duration::ZERO
        };
        let mut fixture = Fixture::new(phase, reply_delay).await;
        let events = Arc::new(Mutex::new(Vec::new()));
        let mut pending = fixture.connect(events.clone());
        fixture.wait_for_reply(&mut pending, &events).await;
        assert!(!pending.is_finished());
        {
            let events = events.lock().unwrap();
            let last = events.last().unwrap();
            assert_eq!((last.phase, last.event), (phase, "start"));
            assert!(
                !events
                    .iter()
                    .any(|event| event.phase == phase && event.event == "done")
            );
        }
        fixture.release();
        let session = tokio::time::timeout(REPLY_WAIT_BUDGET, pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(session.state, SessionState::Open);
        let actions = fixture.handler.actions.lock().unwrap().clone();
        assert_single_open_and_grants(&actions);
        {
            let events = events.lock().unwrap();
            let done = events
                .iter()
                .filter(|event| event.event == "done")
                .map(|event| event.phase)
                .collect::<Vec<_>>();
            assert_eq!(
                done,
                [
                    "attachment",
                    "device-grant",
                    "open-acceptance",
                    "open-wait",
                    "session-grant",
                    "session-get",
                    "complete"
                ]
            );
            assert!(
                events
                    .iter()
                    .all(|event| event.attempt == events[0].attempt && event.error_code.is_none())
            );
            assert!(
                events
                    .windows(2)
                    .all(|pair| pair[0].elapsed_ms <= pair[1].elapsed_ms)
            );
            let (pairs, remainder) = events.as_chunks::<2>();
            assert!(remainder.is_empty());
            assert!(
                pairs
                    .iter()
                    .all(|pair| pair[0].phase_ms <= pair[1].phase_ms)
            );
            assert!(
                events
                    .iter()
                    .filter(|event| event.phase != "open-wait")
                    .all(|event| event.polls == 0)
            );
            let trace = format!("{events:?}");
            assert!(!trace.contains("virtual:echo"));
            assert!(!trace.contains(session.session_id.as_str()));
        }
        fixture.stop().await;
    }
}

#[tokio::test]
async fn retiring_window_keeps_original_error_and_marks_incomplete_stage_failed() {
    let mut fixture = Fixture::new("session-get", Duration::ZERO).await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let mut pending = fixture.connect(events.clone());
    fixture.wait_for_reply(&mut pending, &events).await;
    fixture
        .bridge
        .destroy_window("main", fixture.generation)
        .await;
    fixture.release();
    let error = tokio::time::timeout(REPLY_WAIT_BUDGET, pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(
        error,
        HostError::new(
            "EPOCH_MISMATCH",
            "Window Host connection changed; the request may have completed"
        )
    );
    assert_single_open_and_grants(&fixture.handler.actions.lock().unwrap());
    {
        let events = events.lock().unwrap();
        let last = events.last().unwrap();
        assert_eq!(
            (last.phase, last.event, last.error_code.as_deref()),
            ("session-get", "failed", Some("EPOCH_MISMATCH"))
        );
        assert!(
            !events
                .iter()
                .any(|event| event.phase == "session-get" && event.event == "done")
        );
        assert!(!events.iter().any(|event| event.phase == "complete"));
        let trace = format!("{events:?}");
        assert!(!trace.contains("virtual:echo"));
        assert!(!trace.contains(&error.message));
    }
    fixture.stop().await;
}
