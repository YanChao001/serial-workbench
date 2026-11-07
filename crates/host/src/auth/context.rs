use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, SecondsFormat};
use hmac::{Hmac, Mac};
use serial_workbench_core::{Clock, ContextToken, Digest, HostError, HostResult, Timestamp};
use sha2::{Digest as _, Sha256};

use super::{AuthenticatedActor, HostIdentity};

const ACCEPTANCE_NS: u64 = 86_400_000_000_000;
const PAYLOAD_LEN: usize = 113;
const TOKEN_LEN: usize = PAYLOAD_LEN + 32;
type HmacSha256 = Hmac<Sha256>;

/// 密钥仅存于当前实例内存；旧实例上下文不能在新实例重新接纳。
pub struct ContextSigner {
    key_id: [u8; 16],
    key: [u8; 32],
}

pub struct RequestContext {
    pub token: ContextToken,
    pub accept_until: Timestamp,
}

#[derive(Debug)]
pub struct ValidatedContext {
    pub digest: Digest,
}

impl Default for ContextSigner {
    fn default() -> Self {
        Self::new()
    }
}

impl ContextSigner {
    pub fn new() -> Self {
        // UUID v4 使用系统随机源；哈希收敛多份随机输入，密钥不带 UUID 固定位。
        let mut entropy = Sha256::new();
        for _ in 0..3 {
            entropy.update(uuid::Uuid::new_v4().as_bytes());
        }
        Self {
            key_id: *uuid::Uuid::new_v4().as_bytes(),
            key: entropy.finalize().into(),
        }
    }

    pub fn issue(
        &self,
        actor: &AuthenticatedActor,
        identity: &HostIdentity,
        clock: &dyn Clock,
    ) -> HostResult<RequestContext> {
        let deadline = clock
            .mono_ns()
            .checked_add(ACCEPTANCE_NS)
            .ok_or_else(exhausted)?;
        let mut bytes = [0u8; TOKEN_LEN];
        bytes[0] = 1;
        bytes[1..17].copy_from_slice(&self.key_id);
        bytes[17..33].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes[33..41].copy_from_slice(&identity.instance_epoch.get().to_be_bytes());
        bytes[41..49].copy_from_slice(&deadline.to_be_bytes());
        bytes[49..81].copy_from_slice(&Sha256::digest(identity.host_id.as_str().as_bytes()));
        bytes[81..113].copy_from_slice(&Sha256::digest(actor.id().as_str().as_bytes()));
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts a 32-byte key");
        mac.update(&bytes[..PAYLOAD_LEN]);
        bytes[PAYLOAD_LEN..].copy_from_slice(&mac.finalize().into_bytes());
        Ok(RequestContext {
            token: ContextToken::try_from(URL_SAFE_NO_PAD.encode(bytes).as_str())?,
            accept_until: add_wall_seconds(&clock.wall_time(), 86_400)?,
        })
    }

    pub fn validate(
        &self,
        token: &ContextToken,
        actor: &AuthenticatedActor,
        identity: &HostIdentity,
        clock: &dyn Clock,
    ) -> HostResult<ValidatedContext> {
        // 固定尺寸先于任何字段切片；令牌不能触发可变长度分配。
        let mut bytes = [0u8; TOKEN_LEN];
        if token.as_str().len() != TOKEN_LEN.div_ceil(3) * 4 - 2
            || URL_SAFE_NO_PAD
                .decode_slice(token.as_str(), &mut bytes)
                .ok()
                != Some(TOKEN_LEN)
            || bytes[0] != 1
        {
            return Err(unauthenticated());
        }
        if bytes[1..17] != self.key_id {
            return Err(expired());
        }
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts a 32-byte key");
        mac.update(&bytes[..PAYLOAD_LEN]);
        mac.verify_slice(&bytes[PAYLOAD_LEN..])
            .map_err(|_| unauthenticated())?;
        if bytes[49..81] != Sha256::digest(identity.host_id.as_str().as_bytes())[..] {
            return Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Request context belongs to another Host",
            ));
        }
        if bytes[81..113] != Sha256::digest(actor.id().as_str().as_bytes())[..] {
            return Err(HostError::new(
                "ACTOR_MISMATCH",
                "Request context belongs to another actor",
            ));
        }
        let epoch = u64::from_be_bytes(bytes[33..41].try_into().expect("fixed-width epoch"));
        let deadline = u64::from_be_bytes(bytes[41..49].try_into().expect("fixed-width deadline"));
        if epoch != identity.instance_epoch.get() || clock.mono_ns() >= deadline {
            return Err(expired());
        }
        Ok(ValidatedContext {
            digest: hash(token.as_str().as_bytes()),
        })
    }
}

pub(crate) fn hash(bytes: &[u8]) -> Digest {
    Digest::try_from(format!("{:x}", Sha256::digest(bytes)).as_str())
        .expect("SHA-256 is a canonical digest")
}

pub(crate) fn add_wall_seconds(wall: &Timestamp, seconds: i64) -> HostResult<Timestamp> {
    let parsed = DateTime::parse_from_rfc3339(wall.as_str())
        .map_err(|_| HostError::new("INVALID_ARGUMENT", "Invalid wall-clock timestamp"))?;
    let next = parsed
        .checked_add_signed(chrono::TimeDelta::seconds(seconds))
        .ok_or_else(exhausted)?;
    Timestamp::try_from(next.to_rfc3339_opts(SecondsFormat::Millis, true).as_str())
}

fn expired() -> HostError {
    HostError::new("RESULT_EXPIRED", "Request context expired")
}
fn unauthenticated() -> HostError {
    HostError::new("UNAUTHENTICATED", "Invalid request context")
}
fn exhausted() -> HostError {
    HostError::new("COUNTER_EXHAUSTED", "Clock counter exhausted")
}
