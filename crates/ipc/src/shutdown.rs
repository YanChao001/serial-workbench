//! Attestation of a completed local Host teardown, separate from shutdown admission.
use crate::{
    DiscoveryRecord, discovery::read_bounded_metadata, identity::IdentityPin, write_atomic,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::Mac;
use serde::{Deserialize, Serialize};
use serial_workbench_core::{ContextToken, HostError, HostResult, Id, U64};
use std::path::Path;

const FILE_NAME: &str = "shutdown-complete.json";
const DOMAIN: &str = "serial-workbench/shutdown-complete/0.1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    host_id: Id,
    instance_epoch: U64,
    proof: ContextToken,
}

pub fn record_completed_shutdown(
    namespace: &Path,
    pin: &IdentityPin,
    instance_epoch: U64,
) -> HostResult<()> {
    let proof = pin
        .transcript_mac(&(DOMAIN, &pin.host_id, pin.profile_binding(), instance_epoch))?
        .finalize()
        .into_bytes();
    let record = Record {
        host_id: pin.host_id.clone(),
        instance_epoch,
        proof: ContextToken::try_from(URL_SAFE_NO_PAD.encode(proof).as_str())?,
    };
    let bytes = serde_json::to_vec(&record)
        .map_err(|_| HostError::new("STORAGE_UNAVAILABLE", "Cannot encode Host shutdown record"))?;
    write_atomic(&namespace.join(FILE_NAME), &bytes)
}

/// The maintenance caller holds the instance lock while checking this record.
pub fn verify_completed_shutdown(
    namespace: &Path,
    pin: &IdentityPin,
    instance_epoch: U64,
) -> HostResult<()> {
    let discovery = DiscoveryRecord::read(&namespace.join("discovery.json"))?;
    if discovery.host_id != pin.host_id || discovery.instance_epoch != instance_epoch {
        return Err(HostError::new(
            "EPOCH_MISMATCH",
            "The Host instance changed before maintenance acquired the profile",
        ));
    }
    let bytes = read_bounded_metadata(&namespace.join(FILE_NAME), 1024).ok_or_else(unconfirmed)?;
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| unconfirmed())?;
    if record.host_id != pin.host_id || record.instance_epoch != instance_epoch {
        return Err(unconfirmed());
    }
    let proof = URL_SAFE_NO_PAD
        .decode(record.proof.as_str())
        .map_err(|_| unconfirmed())?;
    pin.transcript_mac(&(DOMAIN, &pin.host_id, pin.profile_binding(), instance_epoch))?
        .verify_slice(&proof)
        .map_err(|_| unconfirmed())
}

fn unconfirmed() -> HostError {
    HostError::new(
        "SHUTDOWN_INCOMPLETE",
        "The old Host has no verified shutdown completion record",
    )
}
