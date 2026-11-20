//! 派发凭据与根请求分域；父任务存活期间不受根请求24小时接纳窗口限制。
use super::{ContextSigner, HmacSha256, URL_SAFE_NO_PAD, hash, unauthenticated};
use base64::Engine as _;
use hmac::Mac;
use serial_workbench_core::{ContextToken, Digest, HostError, HostResult, Id, Operation};
use sha2::{Digest as _, Sha256};

const PAYLOAD: usize = 73;
const LENGTH: usize = PAYLOAD + 32;

fn claims(operation: &Operation, epoch: u64, owner_instance: &Id) -> HostResult<[u8; 32]> {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "hostId":operation.execution_host_id,"instanceEpoch":epoch.to_string(),
        "parentOperationId":operation.operation_id,"rootOperationId":operation.root_operation_id,
        "actorId":operation.actor_id,"executionMode":operation.execution_mode,
        "owner":operation.owner,"ownerInstanceId":owner_instance
    }))
    .map_err(|_| unauthenticated())?;
    let mut digest = Sha256::new();
    digest.update(b"serial-workbench.task-context.v0\0");
    digest.update(bytes);
    Ok(digest.finalize().into())
}
impl ContextSigner {
    pub(crate) fn issue_task(
        &self,
        operation: &Operation,
        epoch: u64,
        owner_instance: &Id,
    ) -> HostResult<ContextToken> {
        let mut bytes = [0_u8; LENGTH];
        bytes[0] = 2;
        bytes[1..17].copy_from_slice(&self.key_id);
        bytes[17..33].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[33..41].copy_from_slice(&epoch.to_be_bytes());
        bytes[41..73].copy_from_slice(&claims(operation, epoch, owner_instance)?);
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts a 32-byte key");
        mac.update(&bytes[..PAYLOAD]);
        bytes[PAYLOAD..].copy_from_slice(&mac.finalize().into_bytes());
        ContextToken::try_from(URL_SAFE_NO_PAD.encode(bytes).as_str())
    }
    pub(crate) fn validate_task(
        &self,
        token: &ContextToken,
        operation: &Operation,
        epoch: u64,
        owner_instance: &Id,
    ) -> HostResult<Digest> {
        let mut bytes = [0_u8; LENGTH];
        if token.as_str().len() != LENGTH.div_ceil(3) * 4
            || URL_SAFE_NO_PAD
                .decode_slice(token.as_str(), &mut bytes)
                .ok()
                != Some(LENGTH)
            || bytes[0] != 2
        {
            return Err(unauthenticated());
        }
        if bytes[1..17] != self.key_id || bytes[33..41] != epoch.to_be_bytes() {
            return Err(HostError::new(
                "EPOCH_MISMATCH",
                "Task context belongs to another Host instance",
            ));
        }
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts a 32-byte key");
        mac.update(&bytes[..PAYLOAD]);
        mac.verify_slice(&bytes[PAYLOAD..])
            .map_err(|_| unauthenticated())?;
        if bytes[41..73] != claims(operation, epoch, owner_instance)? {
            return Err(unauthenticated());
        }
        Ok(hash(token.as_str().as_bytes()))
    }
}
