use crate::{Digest, HostError, HostResult, Id, ResourceKind, Target};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::net::SocketAddr;

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

    pub fn socket_address(&self) -> HostResult<SocketAddr> {
        let address = parse_lan_socket_address(&self.address)?;
        if address.port() == 0 || address.ip().is_unspecified() {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Enter a reachable numeric IPv4 or IPv6 peer address and port",
            ));
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

pub fn parse_lan_socket_address(address: &str) -> HostResult<SocketAddr> {
    let address: SocketAddr = address.parse().map_err(|_| {
        HostError::new(
            "INVALID_ARGUMENT",
            "Enter a numeric IPv4 or bracketed IPv6 address and port",
        )
    })?;
    if let SocketAddr::V6(address) = address
        && address.ip().is_unicast_link_local()
        && address.scope_id() == 0
    {
        return Err(HostError::new(
            "LAN_SCOPE_REQUIRED",
            "Enter the local numeric interface index in the IPv6 link-local address, for example [fe80::1%12]:8022",
        ));
    }
    Ok(address)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_link_local_addresses_require_and_keep_the_numeric_scope() {
        for input in ["[fe80::1]:8022", "[fe80::1%0]:8022", "[febf::2]:8022"] {
            assert_eq!(
                parse_lan_socket_address(input).unwrap_err().code,
                "LAN_SCOPE_REQUIRED",
                "{input}"
            );
            assert_eq!(
                LanRoute::parse("peer", input.into()).unwrap_err().code,
                "LAN_SCOPE_REQUIRED",
                "{input}"
            );
        }
        for input in ["[fe80::1%12]:8022", "[febf::2%12]:8022"] {
            let route = LanRoute::parse("peer", input.into()).unwrap();
            let SocketAddr::V6(socket) = route.socket_address().unwrap() else {
                panic!("Expected IPv6");
            };
            assert_eq!(socket.scope_id(), 12);
            assert_eq!(socket.to_string(), input);
        }
        assert!(parse_lan_socket_address("[fe80::1%]:8022").is_err());
        assert!(parse_lan_socket_address("[fe80::1%4294967296]:8022").is_err());
    }

    #[test]
    fn lan_listener_and_remote_route_keep_their_port_and_address_boundaries() {
        for input in ["127.0.0.1:8022", "[::1]:8022", "[fd00::1]:8022"] {
            assert_eq!(
                LanRoute::parse("peer", input.into())
                    .unwrap()
                    .socket_address()
                    .unwrap()
                    .to_string(),
                input
            );
        }
        for input in ["[::]:8022", "[::1]:0", "0.0.0.0:8022", "127.0.0.1:0"] {
            assert!(parse_lan_socket_address(input).is_ok(), "{input}");
            assert!(LanRoute::parse("peer", input.into()).is_err(), "{input}");
        }
    }
}
