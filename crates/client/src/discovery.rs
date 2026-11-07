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
    let (discovery, pin) = trusted_discovery(options)?;
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
    let path = credential_path(&namespace, &options.client_id);
    let credential = read_credential(&path, &pin, &options.client_id)?;
    Ok(Loaded {
        discovery,
        pin,
        credential,
        credential_path: Some(path),
    })
}

fn credential_path(namespace: &Path, client_id: &Id) -> PathBuf {
    namespace.join("clients").join(format!(
        "{:x}.secret",
        Sha256::digest(client_id.as_str().as_bytes())
    ))
}

pub(crate) fn registration_path(options: &ConnectOptions) -> HostResult<Option<PathBuf>> {
    if options.user_control_credential.is_some() {
        return Ok(None);
    }
    // Do not create coordination files before the existing protected identity is validated.
    trusted_discovery(options)?;
    let namespace = options.profile.join("host-v0");
    local::prepare_private_directory(&namespace.join("clients"))?;
    Ok(Some(
        credential_path(&namespace, &options.client_id).with_extension("lock"),
    ))
}

fn read_credential(
    path: &Path,
    pin: &IdentityPin,
    client_id: &Id,
) -> HostResult<Option<ContextToken>> {
    match local::read_secret(path)? {
        Some(bytes) => {
            let stored: SavedCredential =
                serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
            if stored.host_id != pin.host_id || &stored.client_id != client_id {
                return Err(HostError::new(
                    "UNAUTHENTICATED",
                    "Stored client identity does not match",
                ));
            }
            Ok(Some(stored.credential))
        }
        None => Ok(None),
    }
}

fn trusted_pin(options: &ConnectOptions) -> HostResult<Option<IdentityPin>> {
    let Some(bytes) = local::read_secret(&options.profile.join("host-v0/identity.secret"))? else {
        return Ok(None);
    };
    let pin: IdentityPin = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    pin.verify_profile(&options.profile)?;
    if options
        .expected_host_id
        .as_ref()
        .is_some_and(|id| id != &pin.host_id)
    {
        return Err(identity_mismatch());
    }
    Ok(Some(pin))
}

fn trusted_discovery(options: &ConnectOptions) -> HostResult<(DiscoveryRecord, IdentityPin)> {
    let discovery = DiscoveryRecord::read(&options.profile.join("host-v0/discovery.json"))?;
    let pin = trusted_pin(options)?.ok_or_else(unavailable)?;
    if discovery.host_id != pin.host_id {
        return Err(identity_mismatch());
    }
    Ok((discovery, pin))
}

/// Validate saved identity before a launch; absence is not permission to repair an existing profile.
pub(crate) fn validate_start(options: &ConnectOptions) -> HostResult<()> {
    let namespace = options.profile.join("host-v0");
    if !present(&namespace)? {
        return if options.expected_host_id.is_none() {
            Ok(())
        } else {
            Err(identity_mismatch())
        };
    }
    let Some(pin) = trusted_pin(options)? else {
        if options.expected_host_id.is_some()
            || present(&namespace.join("state.sqlite3"))?
            || present(&namespace.join("discovery.json"))?
            || present(&namespace.join("clients"))?
        {
            return Err(HostError::new(
                "UNAUTHENTICATED",
                "Existing Host identity is unavailable; restore the original profile",
            ));
        }
        return Ok(());
    };
    if !present(&namespace.join("state.sqlite3"))?
        || !present(&namespace.join("user-control.secret"))?
    {
        return Err(HostError::new(
            "UNAUTHENTICATED",
            "Existing Host profile is incomplete; restore the original profile",
        ));
    }
    if present(&namespace.join("discovery.json"))? {
        let discovery = DiscoveryRecord::read(&namespace.join("discovery.json"))?;
        if discovery.host_id != pin.host_id {
            return Err(identity_mismatch());
        }
    }
    if options.user_control_credential.is_none() && present(&namespace.join("clients"))? {
        read_credential(
            &credential_path(&namespace, &options.client_id),
            &pin,
            &options.client_id,
        )?;
    }
    Ok(())
}

fn present(path: &Path) -> HostResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(unavailable()),
    }
}

fn identity_mismatch() -> HostError {
    HostError::new(
        "HOST_ID_MISMATCH",
        "Discovery does not match the trusted Host identity",
    )
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
