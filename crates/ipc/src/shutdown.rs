//! 本机 Host 清理完成的证明，与关停接纳回执分开。
use crate::{
    DiscoveryRecord, discovery::read_bounded_metadata, identity::IdentityPin, write_atomic,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::Mac;
use serde::{Deserialize, Serialize};
use serial_workbench_core::{ContextToken, HostError, HostResult, Id, U64};
#[cfg(windows)]
use std::{fs, io::ErrorKind};
use std::{path::Path, time::Duration};

#[cfg(windows)]
use crate::LocalHostProcess;

const FILE_NAME: &str = "shutdown-complete.json";
const DOMAIN: &str = "serial-workbench/shutdown-complete/0.1";
#[cfg(windows)]
const EXIT_DOMAIN: &str = "serial-workbench/shutdown-exit/0.1";

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

#[cfg(windows)]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExitObservation {
    shutdown_proof: ContextToken,
    exit_code: Option<u32>,
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
        if crate::profile_has_host_state(profile)? {
            return Err(unconfirmed());
        }
        return Ok(());
    };
    let pin: IdentityPin = serde_json::from_slice(&bytes).map_err(|_| unconfirmed())?;
    pin.verify_profile(profile)?;
    let discovery = DiscoveryRecord::read(&namespace.join("discovery.json"))?;
    let record = verify_record(&namespace, &pin, discovery.instance_epoch, &discovery)?;
    #[cfg(windows)]
    verify_exit(&namespace, &pin, &record, None, timeout)?;
    #[cfg(unix)]
    let _ = (record, timeout);
    Ok(())
}

/// 调用方持实例锁，并传入关停前从已认证连接取得的进程句柄。
#[cfg(windows)]
pub fn verify_shutdown_process_exit(
    namespace: &Path,
    pin: &IdentityPin,
    epoch: U64,
    process: &LocalHostProcess,
    timeout: Duration,
) -> HostResult<()> {
    let discovery = DiscoveryRecord::read(&namespace.join("discovery.json"))?;
    let record = verify_record(namespace, pin, epoch, &discovery)?;
    verify_exit(namespace, pin, &record, Some(process), timeout)
}

#[cfg(windows)]
fn verify_exit(
    namespace: &Path,
    pin: &IdentityPin,
    record: &Record,
    observed: Option<&LocalHostProcess>,
    timeout: Duration,
) -> HostResult<()> {
    let path = namespace.join(format!("shutdown-exit-{}.json", record.instance_epoch));
    if let Some(previous) = read_observation(&path, pin)?
        && previous.shutdown_proof == record.proof
        && let Some(code) = previous.exit_code
    {
        return exit_result(code);
    }
    let created = record.process_created.ok_or_else(unconfirmed)?.get();
    let reopened;
    let process = match observed {
        Some(process) if process.matches(record.pid, created)? => process,
        Some(_) => return Err(unconfirmed()),
        None => {
            reopened = LocalHostProcess::reopen(record.pid, created)?.ok_or_else(unconfirmed)?;
            &reopened
        }
    };
    // 写入待定状态后再观察。退出码未知时，重试不能仅凭进程已消失判定成功。
    save_observation(&path, pin, &record.proof, None)?;
    let code = process.wait_for_exit(timeout)?;
    save_observation(&path, pin, &record.proof, Some(code))?;
    exit_result(code)
}

#[cfg(windows)]
fn read_observation(path: &Path, pin: &IdentityPin) -> HostResult<Option<ExitObservation>> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(unconfirmed()),
    }
    let bytes = read_bounded_metadata(path, 1024).ok_or_else(unconfirmed)?;
    let record: ExitObservation = serde_json::from_slice(&bytes).map_err(|_| unconfirmed())?;
    let mac = URL_SAFE_NO_PAD
        .decode(record.proof.as_str())
        .map_err(|_| unconfirmed())?;
    pin.transcript_mac(&(EXIT_DOMAIN, &record.shutdown_proof, record.exit_code))?
        .verify_slice(&mac)
        .map_err(|_| unconfirmed())?;
    Ok(Some(record))
}

#[cfg(windows)]
fn save_observation(
    path: &Path,
    pin: &IdentityPin,
    shutdown_proof: &ContextToken,
    exit_code: Option<u32>,
) -> HostResult<()> {
    let mac = pin
        .transcript_mac(&(EXIT_DOMAIN, shutdown_proof, exit_code))?
        .finalize()
        .into_bytes();
    let bytes = serde_json::to_vec(&ExitObservation {
        shutdown_proof: shutdown_proof.clone(),
        exit_code,
        proof: ContextToken::try_from(URL_SAFE_NO_PAD.encode(mac).as_str())?,
    })
    .map_err(|_| HostError::new("STORAGE_UNAVAILABLE", "Cannot encode Host exit observation"))?;
    write_atomic(path, &bytes)
}

#[cfg(windows)]
fn exit_result(code: u32) -> HostResult<()> {
    if code != 0 {
        return Err(HostError::new(
            "SHUTDOWN_INCOMPLETE",
            format!("The old Host exited with status {code}"),
        ));
    }
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
        "The old Host has no verified shutdown completion and exit. Start it from this installation and retry.",
    )
}
