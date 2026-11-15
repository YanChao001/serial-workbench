use super::{NodePackageSource, VerifiedNodePackageSource, failure, invalid};
use base64::{Engine, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, VerifyingKey};
use serial_workbench_core::{
    Digest, HostResult, NODE_PACKAGE_SIGNATURE_PREFIX, NodePackageIntegrity, NodePackageSignature,
};
use sha2::{Digest as _, Sha256};

pub(super) fn verify_source(
    source: NodePackageSource<'_>,
    integrity: &NodePackageIntegrity,
    raw_integrity: &[u8],
    signature: Option<&NodePackageSignature>,
) -> HostResult<Option<VerifiedNodePackageSource>> {
    if signature.is_some_and(|signature| signature.key_id != integrity.key_id) {
        return Err(invalid("signatureKeyMismatch"));
    }
    let NodePackageSource::Trusted {
        source,
        key_id,
        public_key,
    } = source
    else {
        // 即使本地包自述可信来源或附带签名，也不从包本身建立信任。
        return Ok(None);
    };
    let signature = signature.ok_or_else(|| failure("PERMISSION_DENIED", "signatureRequired"))?;
    if &integrity.source != source || &integrity.key_id != key_id {
        return Err(failure("PERMISSION_DENIED", "sourceKeyMismatch"));
    }
    let key = VerifyingKey::from_bytes(public_key)
        .map_err(|_| failure("PERMISSION_DENIED", "invalidSourceKey"))?;
    let bytes = STANDARD
        .decode(signature.signature_base64.as_str())
        .map_err(|_| invalid("signatureEncoding"))?;
    let signature = Signature::from_slice(&bytes).map_err(|_| invalid("signatureEncoding"))?;
    let message = [NODE_PACKAGE_SIGNATURE_PREFIX, raw_integrity].concat();
    key.verify_strict(&message, &signature)
        .map_err(|_| failure("PERMISSION_DENIED", "signatureInvalid"))?;
    Ok(Some(VerifiedNodePackageSource {
        source: source.clone(),
        key_id: key_id.clone(),
        public_key_sha256: Digest::try_from(format!("{:x}", Sha256::digest(public_key)).as_str())?,
    }))
}
