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
            user_control_credential: None,
        }
    }
}
pub struct HostClient {
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
    pub async fn connect(options: ConnectOptions) -> HostResult<Self> {
        let to_load = options.clone();
        let loaded = tokio::task::spawn_blocking(move || discovery::load(&to_load))
            .await
            .map_err(|_| disconnected())??;
        let mut stream =
            verified_connection(&loaded.discovery, &loaded.pin, IpcChannel::Control).await?;
        let id = new_request_id();
        let body = match options.user_control_credential {
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
            tokio::task::spawn_blocking(move || {
                discovery::save(&path, host_id, client_id, credential)
            })
            .await
            .map_err(|_| disconnected())??;
        } else if loaded.credential.is_none() && loaded.credential_path.is_some() {
            return Err(invalid());
        }
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
        Ok(Self {
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
    pub async fn request(&self, request: RpcRequest) -> HostResult<RpcReply> {
        self.connection.request(request).await
    }
    pub async fn next_event(&self) -> HostResult<Option<WireFrame>> {
        self.connection.next_event().await
    }
    pub fn raw_attachment(&self) -> RawAttachment {
        self.raw.clone()
    }
    pub async fn connect_raw(&self) -> HostResult<RawConnection> {
        RawConnection::connect(self.raw.clone()).await
    }
}
impl RawConnection {
    pub async fn connect(attachment: RawAttachment) -> HostResult<Self> {
        let mut stream =
            verified_connection(&attachment.discovery, &attachment.pin, IpcChannel::Raw).await?;
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
) -> HostResult<LocalStream> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut stream = loop {
        match local::connect(&discovery.endpoint).await {
            Ok(stream) => break stream,
            Err(error) if error.code == "HOST_BUSY" && tokio::time::Instant::now() < deadline => {
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
