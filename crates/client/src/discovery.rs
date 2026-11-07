use crate::ConnectOptions;
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use serial_workbench_ipc::{self as local, DiscoveryRecord, identity::IdentityPin};
use sha2::{Digest as _, Sha256};
use std::path::{Path, PathBuf};

pub(crate) struct Loaded {
    pub discovery: DiscoveryRecord,
    pub pin: IdentityPin,
    pub credential: Option<ContextToken>,
    pub credential_path: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedCredential {
    host_id: Id,
    client_id: Id,
    credential: ContextToken,
}
pub(crate) fn load(options: &ConnectOptions) -> HostResult<Loaded> {
    let namespace = options.profile.join("host-v0");
    let discovery = DiscoveryRecord::read(&namespace.join("discovery.json"))?;
    let pin: IdentityPin = serde_json::from_slice(
        &local::read_secret(&namespace.join("identity.secret"))?.ok_or_else(unavailable)?,
    )
    .map_err(|_| unavailable())?;
    pin.verify_profile(&options.profile)?;
    if discovery.host_id != pin.host_id
        || options
            .expected_host_id
            .as_ref()
            .is_some_and(|id| id != &pin.host_id)
    {
        return Err(HostError::new(
            "HOST_ID_MISMATCH",
            "Discovery does not match the trusted Host identity",
        ));
    }
    if options.user_control_credential.is_some() {
        return Ok(Loaded {
            discovery,
            pin,
            credential: None,
            credential_path: None,
        });
    }
    let directory = namespace.join("clients");
    local::prepare_private_directory(&directory)?;
    let path = directory.join(format!(
        "{:x}.secret",
        Sha256::digest(options.client_id.as_str().as_bytes())
    ));
    let credential = match local::read_secret(&path)? {
        Some(bytes) => {
            let stored: SavedCredential =
                serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
            if stored.host_id != pin.host_id || stored.client_id != options.client_id {
                return Err(HostError::new(
                    "UNAUTHENTICATED",
                    "Stored client identity does not match",
                ));
            }
            Some(stored.credential)
        }
        None => None,
    };
    Ok(Loaded {
        discovery,
        pin,
        credential,
        credential_path: Some(path),
    })
}
pub(crate) fn save(
    path: &Path,
    host_id: Id,
    client_id: Id,
    credential: ContextToken,
) -> HostResult<()> {
    let bytes = serde_json::to_vec(&SavedCredential {
        host_id,
        client_id,
        credential,
    })
    .map_err(|_| unavailable())?;
    local::write_secret_new(path, &bytes)
}
/// 仅供明确的本地用户控制入口调用；普通 connect 不调用此函数。
pub fn read_user_control_credential(profile: &Path) -> HostResult<ContextToken> {
    let bytes = local::read_secret(&profile.join("host-v0/user-control.secret"))?
        .ok_or_else(unavailable)?;
    ContextToken::try_from(std::str::from_utf8(&bytes).map_err(|_| unavailable())?)
}
fn unavailable() -> HostError {
    HostError::new(
        "STORAGE_UNAVAILABLE",
        "Local Host credentials are unavailable",
    )
}
