//! 本机 Host 清理完成的证明，与关停接纳回执分开。
use crate::{
    DiscoveryRecord, discovery::read_bounded_metadata, identity::IdentityPin, write_atomic,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::Mac;
use serde::{Deserialize, Serialize};
use serial_workbench_core::{ContextToken, HostError, HostResult, Id, U64};
use std::{fs, io::ErrorKind, path::Path, time::Duration};

const FILE_NAME: &str = "shutdown-complete.json";
const DOMAIN: &str = "serial-workbench/shutdown-complete/0.1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    host_id: Id,
    instance_epoch: U64,
    pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    process_created: Option<U64>,
    proof: ContextToken,
}

pub fn record_completed_shutdown(
    namespace: &Path,
    pin: &IdentityPin,
    instance_epoch: U64,
) -> HostResult<()> {
    let pid = std::process::id();
    #[cfg(windows)]
    let process_created = Some(crate::windows::current_process_creation_time()?.into());
    #[cfg(unix)]
    let process_created: Option<U64> = None;
    let proof = pin
        .transcript_mac(&(
            DOMAIN,
            &pin.host_id,
            pin.profile_binding(),
            instance_epoch,
            pid,
            process_created,
        ))?
        .finalize()
        .into_bytes();
    let record = Record {
        host_id: pin.host_id.clone(),
        instance_epoch,
        pid,
        process_created,
        proof: ContextToken::try_from(URL_SAFE_NO_PAD.encode(proof).as_str())?,
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|_| HostError::new("STORAGE_UNAVAILABLE", "Cannot encode Host shutdown record"))?;
    write_atomic(&namespace.join(FILE_NAME), &bytes)
}

/// 维护调用方持有实例锁，确保核对期间 Host 代次不变。
pub fn verify_completed_shutdown(
    namespace: &Path,
    pin: &IdentityPin,
    instance_epoch: U64,
) -> HostResult<()> {
    let discovery = DiscoveryRecord::read(&namespace.join("discovery.json"))?;
    verify_record(namespace, pin, instance_epoch, &discovery).map(|_| ())
}

/// 已取得实例锁的桌面检查旧 Host 的完整清理证明。全新 profile 可直接进入更新。
pub fn verify_idle_profile_shutdown(profile: &Path, timeout: Duration) -> HostResult<()> {
    let namespace = profile.join("host-v0");
    let Some(bytes) = crate::read_secret(&namespace.join("identity.secret"))? else {
        for name in [
            "state.sqlite3",
            "discovery.json",
            "clients",
            "user-control.secret",
        ] {
            match fs::symlink_metadata(namespace.join(name)) {
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                _ => return Err(unconfirmed()),
            }
        }
        return Ok(());
    };
    let pin: IdentityPin = serde_json::from_slice(&bytes).map_err(|_| unconfirmed())?;
    pin.verify_profile(profile)?;
    let discovery = DiscoveryRecord::read(&namespace.join("discovery.json"))?;
    let record = verify_record(&namespace, &pin, discovery.instance_epoch, &discovery)?;
    #[cfg(windows)]
    crate::windows::wait_for_recorded_process_exit(
        record.pid,
        record.process_created.ok_or_else(unconfirmed)?.get(),
        timeout,
    )?;
    #[cfg(unix)]
    let _ = (record, timeout);
    Ok(())
}

fn verify_record(
    namespace: &Path,
    pin: &IdentityPin,
    instance_epoch: U64,
    discovery: &DiscoveryRecord,
) -> HostResult<Record> {
    if discovery.host_id != pin.host_id || discovery.instance_epoch != instance_epoch {
        return Err(HostError::new(
            "EPOCH_MISMATCH",
            "The Host instance changed before maintenance acquired the profile",
        ));
    }
    let bytes = read_bounded_metadata(&namespace.join(FILE_NAME), 1024).ok_or_else(unconfirmed)?;
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| unconfirmed())?;
    if record.host_id != pin.host_id
        || record.instance_epoch != instance_epoch
        || record.pid != discovery.pid
    {
        return Err(unconfirmed());
    }
    let proof = URL_SAFE_NO_PAD
        .decode(record.proof.as_str())
        .map_err(|_| unconfirmed())?;
    pin.transcript_mac(&(
        DOMAIN,
        &pin.host_id,
        pin.profile_binding(),
        instance_epoch,
        record.pid,
        record.process_created,
    ))?
    .verify_slice(&proof)
    .map_err(|_| unconfirmed())?;
    Ok(record)
}

fn unconfirmed() -> HostError {
    HostError::new(
        "SHUTDOWN_INCOMPLETE",
        "The old Host has no verified shutdown completion record. Start it from this installation and retry.",
    )
}
