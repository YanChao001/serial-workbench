//! 生命周期只经已核验的 Node 进程启动；数据面进入独立、有界的会话线路。
use super::{Authority, ExitObservation, NodeBackend, RegisteredHandler, Request, error, pipes};
use crate::device::plugin_transport::{PendingPluginTransport, capabilities};
use serial_workbench_core::*;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

pub(super) struct TransportEndpoint {
    pub address: String,
    pub credential: ContextToken,
}

#[derive(Clone)]
pub(crate) struct RegisteredTransport {
    handler: RegisteredHandler,
    stop: Arc<AtomicBool>,
}

impl NodeBackend {
    pub(crate) fn registered_transports(&self) -> HostResult<Vec<RegisteredTransport>> {
        if self.is_finished() || self.stop.load(Ordering::Acquire) {
            return Ok(Vec::new());
        }
        Ok(self
            .registrations
            .transports()?
            .into_iter()
            .map(|entry| RegisteredTransport {
                handler: self.bound_handler(entry),
                stop: self.stop.clone(),
            })
            .collect())
    }
}

impl RegisteredTransport {
    pub(crate) fn owner_accepting(&self) -> bool {
        !self.stop.load(Ordering::Acquire) && !self.handler.finished.load(Ordering::Acquire)
    }

    pub(crate) fn spec(&self) -> &ActionSpec {
        self.handler.spec()
    }

    pub(crate) fn instance_id(&self) -> &Id {
        self.handler.instance_id()
    }

    pub(crate) fn device_id(&self) -> Id {
        let digest = crate::auth::hash(self.spec().action_id.as_str().as_bytes());
        Id::try_from(format!("plugin:{}", digest.as_str()).as_str())
            .expect("bounded plugin device id")
    }

    pub(crate) fn descriptor(&self, host_id: &Id) -> DeviceDescriptor {
        DeviceDescriptor {
            device_id: self.device_id(),
            host_id: host_id.clone(),
            system_name: self.spec().action_id.as_str().to_owned(),
            description: None,
            manufacturer: None,
            driver: Some(self.handler.package().as_str().to_owned()),
            fingerprint: DeviceFingerprint {
                transport: DeviceTransportKind::Plugin,
                vid: None,
                pid: None,
                serial_number: None,
                topology_path: None,
                evidence: IdentityEvidence::Unreliable,
            },
            capabilities: capabilities(),
        }
    }

    pub(crate) fn current(&self) -> HostResult<()> {
        if !self.owner_accepting() {
            return Err(error(
                "NODE_BACKEND_INTERRUPTED",
                "backendTransportOwnerEnded",
            ));
        }
        (self.handler.authority)()?;
        self.handler
            .registrations
            .validate_transport(self.handler.package(), &self.handler.definition)
    }

    pub(crate) fn normalize_parameters(&self, params: &JsonObject) -> HostResult<JsonObject> {
        self.handler.normalize_parameters(params)
    }

    pub(crate) fn open(
        &self,
        params: JsonObject,
        authorize: Authority,
    ) -> BackendResult<Box<dyn Transport>> {
        self.current()?;
        authorize()?;
        let rfc2217 = matches!(
            (
                self.handler.package().as_str(),
                self.spec().action_id.as_str()
            ),
            ("swb.builtin.rfc2217", "swb.builtin.rfc2217.transport")
                | ("reference.rfc2217", "reference.rfc2217.transport")
        );
        let waiting = PendingPluginTransport::listen()?.with_rfc2217_diagnostics(rfc2217);
        let endpoint = TransportEndpoint {
            address: waiting.address().to_string(),
            credential: waiting.credential().clone(),
        };
        let cleanup = Arc::new(TransportOwnerCleanup {
            stop: self.stop.clone(),
            requests: self.handler.requests.clone(),
            observation: self.handler.observation.clone(),
            finished: self.handler.finished.clone(),
        });
        let (reply, response) = mpsc::sync_channel(1);
        let registration = self.clone();
        let check = authorize.clone();
        self.handler
            .requests
            .try_send(Request::OpenTransport {
                package: self.handler.package().clone(),
                definition: self.handler.definition.clone(),
                endpoint,
                params,
                authorize: Arc::new(move || {
                    registration.current()?;
                    check()
                }),
                reply,
            })
            .map_err(|cause| match cause {
                mpsc::TrySendError::Full(_) => error("HOST_BUSY", "backendTransportQueue"),
                mpsc::TrySendError::Disconnected(_) => {
                    error("NODE_BACKEND_INTERRUPTED", "backendTransportOwnerEnded")
                }
            })?;
        // Node 收到 start 前只连接 Host 私有线路，尚未调用 provider.open。
        response
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| {
                error(
                    "NODE_BACKEND_INTERRUPTED",
                    "backendTransportStartUnconfirmed",
                )
            })??;
        // RFC 2217 先完成自己的三秒有界协商与断连，再回报终态。
        let open_wait = Duration::from_secs(if rfc2217 { 4 } else { 2 });
        waiting.with_cleanup(cleanup).accept(open_wait, || {
            self.current()?;
            authorize()
        })
    }
}

struct TransportOwnerCleanup {
    stop: Arc<AtomicBool>,
    requests: pipes::WakingSender<Request>,
    observation: Arc<Mutex<ExitObservation>>,
    finished: Arc<AtomicBool>,
}
impl std::fmt::Debug for TransportOwnerCleanup {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output
            .debug_struct("TransportOwnerCleanup")
            .finish_non_exhaustive()
    }
}
impl BackendCleanup for TransportOwnerCleanup {
    fn poll(&self) -> Option<HostResult<()>> {
        if !self.finished.load(Ordering::Acquire) {
            // 线路无法证明已清理时，停止本连接所属的实际 Node owner。
            // 重启后的新 owner 不共享这里的退出观察或停止信号。
            if !self.stop.swap(true, Ordering::AcqRel) {
                self.requests.wake();
            }
            return None;
        }
        Some(
            self.observation
                .lock()
                .map_err(|_| error("CONTROL_UNKNOWN", "backendTransportExitState"))
                .and_then(|status| {
                    if status.reaped {
                        Ok(())
                    } else {
                        Err(error("CONTROL_UNKNOWN", "backendTransportExitUnconfirmed"))
                    }
                }),
        )
    }
}
