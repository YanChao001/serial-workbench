use crate::{discovery, rpc::RpcConnection};
use serial_workbench_core::*;
use serial_workbench_ipc::{
    self as local, DiscoveryRecord, LocalStream,
    frame::{MAX_FRAME_BYTES, read_frame, write_frame},
    identity::{IdentityPin, random_token},
};
use std::{path::PathBuf, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite};

const LOCAL_ATTACH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct ConnectOptions {
    pub profile: PathBuf,
    pub client_id: Id,
    pub client_kind: ClientKind,
    pub expected_host_id: Option<Id>,
    /// 开发包装器指定不可变运行产物；普通客户端不限制同 profile 的 Host 构建。
    pub expected_host_executable: Option<PathBuf>,
    pub lan_route: Option<LanRoute>,
    /// 调用方通过明确本地用户入口取得；不能由 clientKind 推导或自动加载。
    pub user_control_credential: Option<ContextToken>,
}
impl ConnectOptions {
    pub fn new(profile: PathBuf, client_id: Id, client_kind: ClientKind) -> Self {
        Self {
            profile,
            client_id,
            client_kind,
            expected_host_id: None,
            expected_host_executable: None,
            lan_route: None,
            user_control_credential: None,
        }
    }
}
pub struct HostClient {
    options: ConnectOptions,
    control: ControlConnection,
    raw: RawAttachment,
}
#[derive(Clone)]
pub struct RawAttachment {
    discovery: DiscoveryRecord,
    pin: IdentityPin,
    token: ContextToken,
    routed: bool,
}
pub struct ControlConnection<S = LocalStream> {
    connection: RpcConnection<S>,
    attachment: AttachResult,
}
pub struct RawConnection<S = LocalStream> {
    connection: RpcConnection<S>,
}
impl HostClient {
    pub async fn close(&self) -> HostResult<()> {
        self.control.close().await
    }
    pub async fn connect(options: ConnectOptions) -> HostResult<Self> {
        Self::connect_inner(options, true).await
    }
    pub(crate) async fn connect_for_startup(options: ConnectOptions) -> HostResult<Self> {
        // The startup loop reloads discovery between attempts; do not wait on a stale endpoint.
        Self::connect_inner(options, false).await
    }
    async fn connect_inner(options: ConnectOptions, wait_for_endpoint: bool) -> HostResult<Self> {
        if options.lan_route.is_some() && options.user_control_credential.is_some() {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Local user control cannot use a LAN route",
            ));
        }
        let mut registration = registration_lock(&options).await?;
        let to_load = options.clone();
        let loaded = tokio::task::spawn_blocking(move || discovery::load(&to_load))
            .await
            .map_err(|_| disconnected())??;
        let mut stream = verified_connection(
            &loaded.discovery,
            &loaded.pin,
            IpcChannel::Control,
            wait_for_endpoint,
        )
        .await?;
        let id = new_request_id();
        let body = match (&options.lan_route, options.user_control_credential.clone()) {
            (_, Some(credential)) => IpcMessage::AuthenticateUserControl {
                client_id: options.client_id.clone(),
                credential,
            },
            (Some(route), None) => IpcMessage::AuthenticateLan {
                client_id: options.client_id.clone(),
                credential: loaded.credential.clone(),
                route: route.clone(),
                client_kind: options.client_kind,
            },
            (None, None) => IpcMessage::Authenticate {
                client_id: options.client_id.clone(),
                credential: loaded.credential.clone(),
            },
        };
        write_frame(
            &mut stream,
            &WireFrame {
                request_id: id.clone(),
                channel: IpcChannel::Control,
                body,
            },
            MAX_FRAME_BYTES,
        )
        .await?;
        let response = receive(&mut stream, &id, IpcChannel::Control, LOCAL_ATTACH_TIMEOUT).await?;
        let IpcMessage::Authenticated {
            credential,
            raw_attach_token,
        } = response
        else {
            return Err(invalid());
        };
        if let Some(credential) = credential {
            if loaded.credential.is_some() {
                return Err(invalid());
            }
            let path = loaded.credential_path.ok_or_else(invalid)?;
            let host_id = loaded.pin.host_id.clone();
            let client_id = options.client_id.clone();
            let registration = registration.take();
            tokio::task::spawn_blocking(move || {
                // Cancellation stops the waiter, not this write: retain the OS lock until sync ends.
                let _registration = registration;
                discovery::save(&path, host_id, client_id, credential)
            })
            .await
            .map_err(|_| disconnected())??;
        } else if loaded.credential.is_none() && loaded.credential_path.is_some() {
            return Err(invalid());
        }
        drop(registration);
        let (host_id, instance_epoch, client_id) = if let Some(route) = &options.lan_route {
            match receive(&mut stream, &id, IpcChannel::Control, LAN_ATTACH_TIMEOUT).await? {
                IpcMessage::LanRouted {
                    host_id,
                    instance_epoch,
                    client_id,
                } if host_id == route.host_id => (host_id, instance_epoch, client_id),
                _ => return Err(invalid()),
            }
        } else {
            (
                loaded.pin.host_id.clone(),
                loaded.discovery.instance_epoch,
                options.client_id.clone(),
            )
        };
        let control = ControlConnection::attach_authenticated(
            stream,
            options.client_kind,
            client_id,
            &host_id,
            instance_epoch,
        )
        .await?;
        if let Some(expected) = options.expected_host_executable.as_ref() {
            verify_runtime_executable(expected, loaded.discovery.executable.as_deref())?;
        }
        let routed = options.lan_route.is_some();
        Ok(Self {
            options,
            control,
            raw: RawAttachment {
                discovery: loaded.discovery,
                pin: loaded.pin,
                token: raw_attach_token,
                routed,
            },
        })
    }
    pub fn attachment(&self) -> &AttachResult {
        self.control.attachment()
    }
    /// 业务连接经 LAN 中继时，这里仍返回本机认证的中继 Host。
    pub fn local_instance(&self) -> (&Id, U64) {
        (
            &self.raw.discovery.host_id,
            self.raw.discovery.instance_epoch,
        )
    }
    /// Keep a handle to the same authenticated Windows Host until program replacement.
    #[cfg(windows)]
    pub async fn observe_local_host_process(&self) -> HostResult<local::LocalHostProcess> {
        let discovery = &self.raw.discovery;
        let mut stream = connect_endpoint(discovery, true).await?;
        let process = local::LocalHostProcess::observe(&stream, discovery.pid)?;
        verify_host(&mut stream, discovery, &self.raw.pin, IpcChannel::Control).await?;
        Ok(process)
    }

    /// 维护调用方持有本机实例锁，并在阻塞任务中验证关停回执。
    pub fn verify_local_shutdown_completed(&self) -> HostResult<()> {
        local::shutdown::verify_completed_shutdown(
            &self.options.profile.join("host-v0"),
            &self.raw.pin,
            self.raw.discovery.instance_epoch,
        )
    }

    /// 持有实例锁时核对关停回执，并持久化实际 Windows 退出结果。
    #[cfg(windows)]
    pub fn verify_local_shutdown_exit(
        &self,
        process: &local::LocalHostProcess,
        timeout: Duration,
    ) -> HostResult<()> {
        local::shutdown::verify_shutdown_process_exit(
            &self.options.profile.join("host-v0"),
            &self.raw.pin,
            self.raw.discovery.instance_epoch,
            process,
            timeout,
        )
    }

    /// Reattach using the same private identity. Never start a Host or replay a business request.
    pub async fn reconnect(&self) -> HostResult<Self> {
        let reconnected = Self::connect(self.options.clone()).await?;
        if self.options.lan_route.is_some()
            && reconnected.attachment().actor_id != self.attachment().actor_id
        {
            return Err(HostError::new(
                "ACTOR_MISMATCH",
                "The paired actor changed while reconnecting",
            ));
        }
        Ok(reconnected)
    }
    pub async fn request(&self, request: RpcRequest) -> HostResult<RpcReply> {
        self.control.request(request).await
    }
    pub async fn next_event(&self) -> HostResult<Option<WireFrame>> {
        self.control.next_event().await
    }
    /// 观察现有连接失效；不重连，也不代替实际资源清理。
    pub async fn wait_for_disconnect(&self) {
        self.control.wait_for_disconnect().await;
    }
    pub fn raw_attachment(&self) -> RawAttachment {
        self.raw.clone()
    }
    pub async fn connect_raw(&self) -> HostResult<RawConnection> {
        RawConnection::connect(self.raw.clone()).await
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> ControlConnection<S> {
    /// 传输必须已认证到指定 Host 并完成 Control 通道握手。
    pub async fn attach_authenticated(
        stream: S,
        client_kind: ClientKind,
        client_id: Id,
        host_id: &Id,
        instance_epoch: U64,
    ) -> HostResult<Self> {
        let connection = RpcConnection::new(stream, IpcChannel::Control);
        let attached = connection
            .request(RpcRequest::Attach(AttachParams {
                supported_protocol_versions: vec![ProtocolVersion::CURRENT.as_wire().into()],
                client_kind,
                client_id: client_id.clone(),
                expected_host_id: Some(host_id.clone()),
            }))
            .await?;
        let attachment = match attached {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Attach(result) => result,
                _ => return Err(invalid()),
            },
            RpcReply::Failure { error, .. } => return Err(error),
        };
        if &attachment.host_id != host_id
            || attachment.instance_epoch != instance_epoch
            || attachment.client_id != client_id
        {
            return Err(invalid());
        }
        Ok(Self {
            connection,
            attachment,
        })
    }

    pub fn attachment(&self) -> &AttachResult {
        &self.attachment
    }

    pub async fn request(&self, request: RpcRequest) -> HostResult<RpcReply> {
        self.connection.request(request).await
    }

    pub async fn next_event(&self) -> HostResult<Option<WireFrame>> {
        self.connection.next_event().await
    }

    pub async fn wait_for_disconnect(&self) {
        self.connection.wait_for_disconnect().await;
    }

    pub async fn close(&self) -> HostResult<()> {
        self.connection.close().await
    }
}

fn verify_runtime_executable(
    expected: &std::path::Path,
    actual: Option<&std::path::Path>,
) -> HostResult<()> {
    let matches = expected
        .canonicalize()
        .ok()
        .zip(actual.and_then(|path| path.canonicalize().ok()))
        .is_some_and(|(expected, actual)| expected == actual);
    if matches {
        return Ok(());
    }
    Err(HostError::new(
        "DEV_RUNTIME_MISMATCH",
        "A different Host build is still running. Run pnpm host:stop, then pnpm app:dev again. Active work is preserved; no Host was stopped automatically.",
    ))
}

async fn registration_lock(options: &ConnectOptions) -> HostResult<Option<local::PrivateFileLock>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let preparing = options.clone();
    let path = tokio::time::timeout_at(
        deadline,
        tokio::task::spawn_blocking(move || discovery::registration_path(&preparing)),
    )
    .await
    .map_err(|_| registration_busy())?
    .map_err(|_| disconnected())??;
    let Some(path) = path else {
        return Ok(None);
    };
    loop {
        let attempt = path.clone();
        let guard = tokio::time::timeout_at(
            deadline,
            tokio::task::spawn_blocking(move || local::try_lock_private_file(&attempt)),
        )
        .await
        .map_err(|_| registration_busy())?
        .map_err(|_| disconnected())??;
        if let Some(guard) = guard {
            return Ok(Some(guard));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(registration_busy());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn registration_busy() -> HostError {
    HostError::new(
        "HOST_BUSY",
        "Another connection is initializing this client identity",
    )
}
impl RawConnection {
    pub async fn connect(attachment: RawAttachment) -> HostResult<Self> {
        let mut stream = verified_connection(
            &attachment.discovery,
            &attachment.pin,
            IpcChannel::Raw,
            true,
        )
        .await?;
        let id = new_request_id();
        write_frame(
            &mut stream,
            &WireFrame {
                request_id: id.clone(),
                channel: IpcChannel::Raw,
                body: IpcMessage::RawAttach {
                    token: attachment.token,
                },
            },
            MAX_FRAME_BYTES,
        )
        .await?;
        if !matches!(
            receive(
                &mut stream,
                &id,
                IpcChannel::Raw,
                if attachment.routed {
                    LAN_ATTACH_TIMEOUT
                } else {
                    LOCAL_ATTACH_TIMEOUT
                },
            )
            .await?,
            IpcMessage::RawAttached {}
        ) {
            return Err(invalid());
        }
        Ok(Self::from_authenticated_stream(stream))
    }
}
impl<S: AsyncRead + AsyncWrite + Unpin + Send + 'static> RawConnection<S> {
    /// 传输必须已完成 Raw 附着握手。
    pub fn from_authenticated_stream(stream: S) -> Self {
        Self {
            connection: RpcConnection::new(stream, IpcChannel::Raw),
        }
    }

    pub async fn close(&self) -> HostResult<()> {
        self.connection.close().await
    }

    pub async fn wait_for_disconnect(&self) {
        self.connection.wait_for_disconnect().await;
    }
    pub async fn request(&self, request: RpcRequest) -> HostResult<RpcReply> {
        self.connection.request(request).await
    }
    pub async fn next_event(&self) -> HostResult<Option<WireFrame>> {
        self.connection.next_event().await
    }
}
async fn verified_connection(
    discovery: &DiscoveryRecord,
    pin: &IdentityPin,
    channel: IpcChannel,
    wait_for_endpoint: bool,
) -> HostResult<LocalStream> {
    let mut stream = connect_endpoint(discovery, wait_for_endpoint).await?;
    verify_host(&mut stream, discovery, pin, channel).await?;
    Ok(stream)
}

async fn connect_endpoint(
    discovery: &DiscoveryRecord,
    wait_for_endpoint: bool,
) -> HostResult<LocalStream> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match local::connect(&discovery.endpoint).await {
            Ok(stream) => return Ok(stream),
            Err(error)
                if wait_for_endpoint
                    && error.code == "HOST_BUSY"
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            Err(error) => return Err(error),
        }
    }
}

async fn verify_host(
    stream: &mut LocalStream,
    discovery: &DiscoveryRecord,
    pin: &IdentityPin,
    channel: IpcChannel,
) -> HostResult<()> {
    let id = new_request_id();
    let client_nonce = random_token();
    write_frame(
        stream,
        &WireFrame {
            request_id: id.clone(),
            channel,
            body: IpcMessage::ClientHello {
                supported_protocol_versions: vec![ProtocolVersion::CURRENT.as_wire().into()],
                client_nonce: client_nonce.clone(),
                expected_host_id: Some(pin.host_id.clone()),
            },
        },
        MAX_FRAME_BYTES,
    )
    .await?;
    let response = receive(stream, &id, channel, LOCAL_ATTACH_TIMEOUT).await?;
    local::verify_peer(stream)?;
    let IpcMessage::HostHello {
        protocol_version,
        host_id,
        instance_epoch,
        server_nonce,
        proof,
    } = response
    else {
        return Err(invalid());
    };
    if host_id != pin.host_id
        || host_id != discovery.host_id
        || instance_epoch != discovery.instance_epoch
    {
        return Err(HostError::new(
            "HOST_ID_MISMATCH",
            "Connected Host identity differs from discovery",
        ));
    }
    if protocol_version != ProtocolVersion::CURRENT {
        return Err(invalid());
    }
    pin.verify(
        protocol_version,
        instance_epoch,
        &client_nonce,
        &server_nonce,
        &proof,
    )?;
    Ok(())
}
async fn receive(
    stream: &mut LocalStream,
    id: &RequestId,
    channel: IpcChannel,
    limit: Duration,
) -> HostResult<IpcMessage> {
    let frame = tokio::time::timeout(limit, read_frame(stream, MAX_FRAME_BYTES))
        .await
        .map_err(|_| disconnected())??
        .ok_or_else(disconnected)?;
    if let IpcMessage::Error { error } = frame.body {
        return Err(error);
    }
    if &frame.request_id != id || frame.channel != channel {
        return Err(invalid());
    }
    Ok(frame.body)
}
pub(crate) fn new_request_id() -> RequestId {
    RequestId::try_from(uuid::Uuid::new_v4().to_string().as_str()).expect("UUID request Id")
}
pub(crate) fn invalid() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid Host response")
}
pub(crate) fn disconnected() -> HostError {
    HostError::new("UNAUTHENTICATED", "Local Host connection is closed")
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    #[test]
    fn development_runtime_requires_the_actual_expected_executable_path() {
        let dir = tempfile::tempdir().unwrap();
        let expected = dir.path().join("expected-host");
        let old = dir.path().join("old-host");
        std::fs::write(&expected, b"current").unwrap();
        std::fs::write(&old, b"old").unwrap();
        verify_runtime_executable(&expected, Some(&expected)).unwrap();
        for actual in [
            Some(old.as_path()),
            None,
            Some(dir.path().join("missing").as_path()),
        ] {
            assert_eq!(
                verify_runtime_executable(&expected, actual)
                    .unwrap_err()
                    .code,
                "DEV_RUNTIME_MISMATCH"
            );
        }
    }
}
