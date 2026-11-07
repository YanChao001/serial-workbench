use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serial_workbench_core::*;
use sha2::{Digest as _, Sha256};
type HmacSha256 = Hmac<Sha256>;

pub fn random_token() -> ContextToken {
    let mut entropy = Sha256::new();
    for _ in 0..3 {
        entropy.update(uuid::Uuid::new_v4().as_bytes());
    }
    ContextToken::try_from(URL_SAFE_NO_PAD.encode(entropy.finalize()).as_str())
        .expect("random token has canonical encoding")
}

/// 持久 verifier 不保存 bearer credential；随机凭据不存在口令字典空间。
pub fn credential_verifier(credential: &ContextToken) -> ContextToken {
    let mut mac = HmacSha256::new_from_slice(credential.as_str().as_bytes())
        .expect("HMAC accepts arbitrary key length");
    mac.update(b"serial-workbench/credential-verifier/0.1");
    ContextToken::try_from(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()).as_str())
        .expect("HMAC token encoding")
}
pub fn verify_credential(verifier: &ContextToken, credential: &ContextToken) -> bool {
    let mut mac = HmacSha256::new_from_slice(credential.as_str().as_bytes())
        .expect("HMAC accepts arbitrary key length");
    mac.update(b"serial-workbench/credential-verifier/0.1");
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(verifier.as_str()) else {
        return false;
    };
    mac.verify_slice(&bytes).is_ok()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityPin {
    pub host_id: Id,
    secret: ContextToken,
    profile_binding: Digest,
}
impl IdentityPin {
    pub fn new(host_id: Id, profile: &std::path::Path) -> HostResult<Self> {
        Ok(Self {
            host_id,
            secret: random_token(),
            profile_binding: profile_digest(profile)?,
        })
    }
    pub fn verify_profile(&self, profile: &std::path::Path) -> HostResult<()> {
        if self.profile_binding == profile_digest(profile)? {
            Ok(())
        } else {
            Err(HostError::new(
                "HOST_ID_MISMATCH",
                "Protected Host identity belongs to a different profile location",
            ))
        }
    }
    fn mac(
        &self,
        epoch: U64,
        client: &ContextToken,
        server: &ContextToken,
    ) -> HostResult<HmacSha256> {
        let secret = URL_SAFE_NO_PAD
            .decode(self.secret.as_str())
            .map_err(|_| invalid())?;
        if secret.len() != 32 {
            return Err(invalid());
        }
        let mut mac = HmacSha256::new_from_slice(&secret).expect("32-byte HMAC key");
        let transcript = serde_json::to_vec(&(
            "serial-workbench/host-proof",
            ProtocolVersion::V0_1,
            &self.host_id,
            &self.profile_binding,
            epoch,
            client,
            server,
        ))
        .map_err(|_| invalid())?;
        mac.update(&transcript);
        Ok(mac)
    }
    pub fn proof(
        &self,
        epoch: U64,
        client: &ContextToken,
        server: &ContextToken,
    ) -> HostResult<ContextToken> {
        ContextToken::try_from(
            URL_SAFE_NO_PAD
                .encode(self.mac(epoch, client, server)?.finalize().into_bytes())
                .as_str(),
        )
    }
    pub fn verify(
        &self,
        epoch: U64,
        client: &ContextToken,
        server: &ContextToken,
        proof: &ContextToken,
    ) -> HostResult<()> {
        let bytes = URL_SAFE_NO_PAD
            .decode(proof.as_str())
            .map_err(|_| invalid())?;
        self.mac(epoch, client, server)?
            .verify_slice(&bytes)
            .map_err(|_| invalid())
    }
}
fn profile_digest(profile: &std::path::Path) -> HostResult<Digest> {
    // 先验证私有目录与原路径的链接边界，再规范化；不把 symlink 悄悄洗成可信路径。
    crate::prepare_private_directory(&profile.join("host-v0"))?;
    let canonical = profile.canonicalize().map_err(|_| invalid())?;
    let mut digest = Sha256::new();
    digest.update(b"serial-workbench/profile-binding/0.1\0");
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for unit in canonical.as_os_str().encode_wide() {
            digest.update(unit.to_le_bytes());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        digest.update(canonical.as_os_str().as_bytes());
    }
    Digest::try_from(format!("{:x}", digest.finalize()).as_str())
}
fn invalid() -> HostError {
    HostError::new("UNAUTHENTICATED", "Host identity proof is invalid")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proof_is_bound_to_host_epoch_and_both_nonces() {
        let profile = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let pin = IdentityPin::new(Id::try_from("host-a").unwrap(), profile.path()).unwrap();
        let client = ContextToken::try_from("client-nonce").unwrap();
        let server = ContextToken::try_from("server-nonce").unwrap();
        let other = ContextToken::try_from("different-nonce").unwrap();
        let proof = pin.proof(1.into(), &client, &server).unwrap();
        pin.verify(1.into(), &client, &server, &proof).unwrap();
        assert!(pin.verify(2.into(), &client, &server, &proof).is_err());
        assert!(pin.verify(1.into(), &other, &server, &proof).is_err());
        assert!(pin.verify(1.into(), &client, &other, &proof).is_err());
        let mut copied = pin.clone();
        copied.host_id = Id::try_from("host-b").unwrap();
        assert!(copied.verify(1.into(), &client, &server, &proof).is_err());
    }
}
