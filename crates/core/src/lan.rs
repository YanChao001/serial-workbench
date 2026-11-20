use crate::{Digest, HostError, HostResult, Id, ResourceKind, Target};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;

pub const LAN_CONNECT_PERMISSION: &str = "lan.connect";
pub const LAN_ATTACH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(25);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanRoute {
    pub host_id: Id,
    pub address: String,
}

impl LanRoute {
    pub fn parse(host_id: &str, address: String) -> HostResult<Self> {
        let route = Self {
            host_id: Id::try_from(host_id)?,
            address,
        };
        route.socket_address()?;
        Ok(route)
    }

    pub fn socket_address(&self) -> HostResult<std::net::SocketAddr> {
        let invalid = || {
            HostError::new(
                "INVALID_ARGUMENT",
                "Enter a reachable numeric IPv4 or IPv6 peer address and port",
            )
        };
        let address: std::net::SocketAddr = self.address.parse().map_err(|_| invalid())?;
        if address.port() == 0 || address.ip().is_unspecified() {
            return Err(invalid());
        }
        Ok(address)
    }

    pub fn authorization_target(&self, local_host_id: &Id) -> Target {
        Target {
            host_id: local_host_id.clone(),
            kind: ResourceKind::try_from("swb:lan-peer").expect("LAN peer scope"),
            id: self.host_id.clone(),
            session_id: None,
            session_epoch: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanPeer {
    pub host_id: Id,
    pub fingerprint: Digest,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanShare {
    pub target: Target,
    pub access: LanShareAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub enum LanShareAccess {
    ReadOnly,
    Operate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum LanAccessParams {
    Status {},
    Enable {
        address: String,
    },
    Disable {},
    SetShares {
        peer: LanPeer,
        shares: Vec<LanShare>,
    },
    Unpair {
        peer: LanPeer,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum LanListenerState {
    Disabled {},
    Listening { address: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanPeerSettings {
    pub peer: LanPeer,
    pub shares: Vec<LanShare>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LanAccessResult {
    pub local_peer: LanPeer,
    pub listener: LanListenerState,
    pub peers: Vec<LanPeerSettings>,
}
