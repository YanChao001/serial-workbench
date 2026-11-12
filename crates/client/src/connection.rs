use crate::{discovery, rpc::RpcConnection};
use serial_workbench_core::*;
use serial_workbench_ipc::{
    self as local, DiscoveryRecord, LocalStream,
    frame::{MAX_FRAME_BYTES, read_frame, write_frame},
    identity::{IdentityPin, random_token},
};
use std::{path::PathBuf, time::Duration};

#[derive(Clone)]
pub struct ConnectOptions {
    pub profile: PathBuf,
    pub client_id: Id,
    pub client_kind: ClientKind,
    pub expected_host_id: Option<Id>,
    /// 开发包装器指定不可变运行产物；普通客户端不限制同 profile 的 Host 构建。
    pub expected_host_executable: Option<PathBuf>,
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
            user_control_credential: None,
        }
    }
}
pub struct HostClient {
    options: ConnectOptions,
    connection: RpcConnection,
    attachment: AttachResult,
    raw: RawAttachment,
}
#[derive(Clone)]
pub struct RawAttachment {
    discovery: DiscoveryRecord,
    pin: IdentityPin,
    token: ContextToken,
}
pub struct RawConnection {
    connection: RpcConnection,
}
impl HostClient {
    pub async fn close(&self) -> HostResult<()> {
        self.connection.close().await
    }
    pub async fn connect(options: ConnectOptions) -> HostResult<Self> {
        Self::connect_inner(options, true).await
    }
    pub(crate) async fn connect_for_startup(options: ConnectOptions) -> HostResult<Self> {
        // The startup loop reloads discovery between attempts; do not wait on a stale endpoint.
        Self::connect_inner(options, false).await
    }
    async fn connect_inner(options: ConnectOptions, wait_for_endpoint: bool) -> HostResult<Self> {
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
        let body = match options.user_control_credential.clone() {
            Some(credential) => IpcMessage::AuthenticateUserControl {
                client_id: options.client_id.clone(),
                credential,
            },
            None => IpcMessage::Authenticate {
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
        let response = receive(&mut stream, &id, IpcChannel::Control).await?;
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
        let connection = RpcConnection::new(stream, IpcChannel::Control);
        let attached = connection
            .request(RpcRequest::Attach(AttachParams {
                supported_protocol_versions: vec!["0.1".into()],
                client_kind: options.client_kind,
                client_id: options.client_id.clone(),
                expected_host_id: Some(loaded.pin.host_id.clone()),
            }))
            .await?;
        let attachment = match attached {
            RpcReply::Success { result, .. } => match *result {
                RpcResult::Attach(result) => result,
                _ => return Err(invalid()),
            },
            RpcReply::Failure { error, .. } => return Err(error),
        };
        if attachment.host_id != loaded.pin.host_id
            || attachment.instance_epoch != loaded.discovery.instance_epoch
            || attachment.client_id != options.client_id
        {
            return Err(invalid());
        }
        if let Some(expected) = options.expected_host_executable.as_ref() {
            verify_runtime_executable(expected, loaded.discovery.executable.as_deref())?;
        }
        Ok(Self {
            options,
            connection,
            attachment,
            raw: RawAttachment {
                discovery: loaded.discovery,
                pin: loaded.pin,
                token: raw_attach_token,
            },
        })
    }
    pub fn attachment(&self) -> &AttachResult {
        &self.attachment
    }
    /// Reattach using the same private identity. Never start a Host or replay a business request.
    pub async fn reconnect(&self) -> HostResult<Self> {
        Self::connect(self.options.clone()).await
    }
    pub async fn request(&self, request: RpcRequest) -> HostResult<RpcReply> {
        self.connection.request(request).await
    }
    pub async fn next_event(&self) -> HostResult<Option<WireFrame>> {
        self.connection.next_event().await
    }
    /// 观察现有连接失效；不重连，也不代替实际资源清理。
    pub async fn wait_for_disconnect(&self) {
        self.connection.wait_for_disconnect().await;
    }
    pub fn raw_attachment(&self) -> RawAttachment {
        self.raw.clone()
    }
    pub async fn connect_raw(&self) -> HostResult<RawConnection> {
        RawConnection::connect(self.raw.clone()).await
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
    pub async fn close(&self) -> HostResult<()> {
        self.connection.close().await
    }
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
            receive(&mut stream, &id, IpcChannel::Raw).await?,
            IpcMessage::RawAttached {}
        ) {
            return Err(invalid());
        }
        Ok(Self {
            connection: RpcConnection::new(stream, IpcChannel::Raw),
        })
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
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut stream = loop {
        match local::connect(&discovery.endpoint).await {
            Ok(stream) => break stream,
            Err(error)
                if wait_for_endpoint
                    && error.code == "HOST_BUSY"
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            Err(error) => return Err(error),
        }
    };
    let id = new_request_id();
    let client_nonce = random_token();
    write_frame(
        &mut stream,
        &WireFrame {
            request_id: id.clone(),
            channel,
            body: IpcMessage::ClientHello {
                supported_protocol_versions: vec!["0.1".into()],
                client_nonce: client_nonce.clone(),
                expected_host_id: Some(pin.host_id.clone()),
            },
        },
        MAX_FRAME_BYTES,
    )
    .await?;
    let response = receive(&mut stream, &id, channel).await?;
    local::verify_peer(&stream)?;
    let IpcMessage::HostHello {
        protocol_version: ProtocolVersion::V0_1,
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
    pin.verify(instance_epoch, &client_nonce, &server_nonce, &proof)?;
    Ok(stream)
}
async fn receive(
    stream: &mut LocalStream,
    id: &RequestId,
    channel: IpcChannel,
) -> HostResult<IpcMessage> {
    let frame = tokio::time::timeout(Duration::from_secs(5), read_frame(stream, MAX_FRAME_BYTES))
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
