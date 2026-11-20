use super::{CONNECT_DEADLINE, LanConnection, connection_error, protocol_error};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serial_workbench_core::{ContextToken, HostResult, Id};
use serial_workbench_ipc::frame::{read_json_frame, write_json_frame};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    time::timeout,
};

const MAX_LANE_BYTES: usize = 4096;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LanOrigin {
    pub actor_id: Id,
    pub client_id: Id,
    pub mcp: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Lane {
    Control {
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<LanOrigin>,
    },
    Raw {
        token: ContextToken,
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<LanOrigin>,
    },
}

impl Lane {
    pub(crate) fn origin(&self) -> Option<&LanOrigin> {
        match self {
            Self::Control { origin } | Self::Raw { origin, .. } => origin.as_ref(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum LaneReady {
    Control {
        client_id: Id,
        raw_attach_token: ContextToken,
    },
    Raw,
}

impl<S: AsyncRead + AsyncWrite + Unpin> LanConnection<S> {
    pub(crate) async fn open_control(
        &mut self,
        origin: Option<LanOrigin>,
    ) -> HostResult<(Id, ContextToken)> {
        match self.open_lane(Lane::Control { origin }).await? {
            LaneReady::Control {
                client_id,
                raw_attach_token,
            } => Ok((client_id, raw_attach_token)),
            LaneReady::Raw => Err(protocol_error()),
        }
    }

    pub(crate) async fn open_raw(
        &mut self,
        token: ContextToken,
        origin: Option<LanOrigin>,
    ) -> HostResult<()> {
        match self.open_lane(Lane::Raw { token, origin }).await? {
            LaneReady::Raw => Ok(()),
            LaneReady::Control { .. } => Err(protocol_error()),
        }
    }

    async fn open_lane(&mut self, lane: Lane) -> HostResult<LaneReady> {
        timeout(CONNECT_DEADLINE, async {
            write_lane(&mut self.stream, &lane).await?;
            read_lane(&mut self.stream).await
        })
        .await
        .map_err(|_| connection_error())?
    }
}

pub(crate) async fn read_lane<T: DeserializeOwned>(
    stream: &mut (impl AsyncRead + Unpin),
) -> HostResult<T> {
    read_json_frame(stream, MAX_LANE_BYTES)
        .await
        .map_err(|error| match error.code.as_str() {
            "UNAUTHENTICATED" => connection_error(),
            _ => protocol_error(),
        })?
        .ok_or_else(connection_error)
}

pub(crate) async fn write_lane(
    stream: &mut (impl AsyncWrite + Unpin),
    message: &impl Serialize,
) -> HostResult<()> {
    write_json_frame(stream, message, MAX_LANE_BYTES)
        .await
        .map_err(|_| connection_error())
}
