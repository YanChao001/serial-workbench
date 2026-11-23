//! 来源认可与 Node 执行确认分开；当前密钥变化不删除历史公开材料。
use super::{
    NodePackageLimits, NodePackageSource, VerifiedNodePackage, VerifiedNodePackageSource, failure,
    product, verify_node_package,
};
use crate::storage::Store;
use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};
pub use serial_workbench_core::NodePackageSourceKey;
use serial_workbench_core::{Digest, HostError, HostResult, Id, U64};
use sha2::{Digest as _, Sha256};
use std::{collections::BTreeSet, sync::atomic::AtomicBool};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodePackageSourceSnapshot {
    pub revision: U64,
    pub keys: Vec<NodePackageSourceKey>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceDocument {
    format_version: U64,
    keys: Vec<NodePackageSourceKey>,
}
impl Default for SourceDocument {
    fn default() -> Self {
        Self {
            format_version: 1.into(),
            keys: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub struct NodePackageSources {
    store: Store,
}
impl NodePackageSources {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    fn load(&self) -> HostResult<(U64, SourceDocument)> {
        let Some(stored) = self.store.read_document(&document_id())? else {
            return Ok((0.into(), SourceDocument::default()));
        };
        let raw = serde_json::to_value(stored.value).map_err(|_| corrupt())?;
        if raw.get("formatVersion") != Some(&serde_json::json!("1")) {
            return Err(failure("FUTURE_FORMAT", "sourceTrustFormat"));
        }
        let document: SourceDocument = serde_json::from_value(raw).map_err(|_| corrupt())?;
        let mut identities = BTreeSet::new();
        let mut active = BTreeSet::new();
        for key in &document.keys {
            if validate_key(&key.public_key).is_err()
                || digest(&key.public_key)? != key.public_key_sha256
                || !identities.insert((
                    key.source.as_str(),
                    key.key_id.as_str(),
                    key.public_key_sha256.as_str(),
                ))
                || key.approved && !active.insert((key.source.as_str(), key.key_id.as_str()))
            {
                return Err(corrupt());
            }
        }
        Ok((stored.revision, document))
    }

    pub fn snapshot(&self) -> HostResult<NodePackageSourceSnapshot> {
        let (revision, document) = self.load()?;
        Ok(NodePackageSourceSnapshot {
            revision,
            keys: document.keys,
        })
    }

    /// 仅可信 Host 来源认可入口调用；包中的公钥或作者文字不能调用此入口。
    pub fn approve_key(
        &self,
        source: Id,
        key_id: Id,
        public_key: [u8; 32],
        expected_revision: U64,
    ) -> HostResult<NodePackageSourceSnapshot> {
        self.approve_key_authorized(source, key_id, public_key, expected_revision, || Ok(()))
    }

    pub(crate) fn approve_key_authorized<G>(
        &self,
        source: Id,
        key_id: Id,
        public_key: [u8; 32],
        expected_revision: U64,
        authorize: impl FnMut() -> HostResult<G>,
    ) -> HostResult<NodePackageSourceSnapshot> {
        product::require_external_source(&source)?;
        validate_key(&public_key)?;
        let (revision, mut document) = self.load()?;
        if revision != expected_revision {
            return Err(failure("REVISION_CONFLICT", "sourceTrustRevision"));
        }
        let fingerprint = digest(&public_key)?;
        for key in &mut document.keys {
            if key.source == source && key.key_id == key_id {
                key.approved = false;
            }
        }
        if let Some(previous) = document.keys.iter_mut().find(|key| {
            key.source == source && key.key_id == key_id && key.public_key_sha256 == fingerprint
        }) {
            previous.approved = true;
        } else {
            document.keys.push(NodePackageSourceKey {
                source,
                key_id,
                public_key,
                public_key_sha256: fingerprint,
                approved: true,
            });
        }
        self.save(revision, document, authorize)
    }

    /// 撤销只关闭当前认可，保留公钥历史；运行中 owner 的停止由管理器协调。
    pub fn revoke_key(
        &self,
        source: &Id,
        key_id: &Id,
        expected_revision: U64,
    ) -> HostResult<NodePackageSourceSnapshot> {
        self.revoke_key_authorized(source, key_id, expected_revision, || Ok(()))
    }

    pub(crate) fn revoke_key_authorized<G>(
        &self,
        source: &Id,
        key_id: &Id,
        expected_revision: U64,
        authorize: impl FnMut() -> HostResult<G>,
    ) -> HostResult<NodePackageSourceSnapshot> {
        product::require_external_source(source)?;
        let (revision, mut document) = self.load()?;
        if revision != expected_revision {
            return Err(failure("REVISION_CONFLICT", "sourceTrustRevision"));
        }
        let mut found = false;
        for key in &mut document.keys {
            if &key.source == source && &key.key_id == key_id {
                key.approved = false;
                found = true;
            }
        }
        if !found {
            return Err(failure("NOT_FOUND", "sourceKeyUnknown"));
        }
        self.save(revision, document, authorize)
    }

    fn save<G>(
        &self,
        revision: U64,
        document: SourceDocument,
        mut authorize: impl FnMut() -> HostResult<G>,
    ) -> HostResult<NodePackageSourceSnapshot> {
        let raw = serde_json::to_vec(&document).map_err(|_| corrupt())?;
        if raw.len() > 1024 * 1024 {
            return Err(failure("LIMIT_EXCEEDED", "sourceTrustBytes"));
        }
        let value = serde_json::from_slice(&raw).map_err(|_| corrupt())?;
        let _authority = authorize()?;
        let saved = self
            .store
            .compare_and_swap_document(&document_id(), revision, value)?;
        Ok(NodePackageSourceSnapshot {
            revision: saved.revision,
            keys: document.keys,
        })
    }

    fn current(&self, source: &Id, key_id: &Id) -> HostResult<NodePackageSourceKey> {
        product::require_external_source(source)?;
        self.load()?
            .1
            .keys
            .into_iter()
            .find(|key| &key.source == source && &key.key_id == key_id && key.approved)
            .ok_or_else(|| failure("PERMISSION_DENIED", "sourceKeyNotApproved"))
    }

    /// 这是本次观察的当前状态；生产效果接纳仍须协调撤权与实际执行 owner。
    pub fn require_current(&self, receipt: &VerifiedNodePackageSource) -> HostResult<()> {
        if product::is_product_source(&receipt.source) {
            return product::require_current(receipt);
        }
        let key = self.current(&receipt.source, &receipt.key_id)?;
        if key.public_key_sha256 != receipt.public_key_sha256 {
            return Err(failure("PERMISSION_DENIED", "sourceKeyChanged"));
        }
        Ok(())
    }

    pub fn verify(
        &self,
        bytes: Vec<u8>,
        source: &Id,
        key_id: &Id,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<VerifiedNodePackage> {
        let key = self.current(source, key_id)?;
        let package = verify_node_package(
            bytes,
            NodePackageSource::Trusted {
                source,
                key_id,
                public_key: &key.public_key,
            },
            limits,
            cancel,
        )?;
        self.require_current(package.verified_source().ok_or_else(corrupt)?)?;
        Ok(package)
    }
}

fn validate_key(bytes: &[u8; 32]) -> HostResult<()> {
    let key = VerifyingKey::from_bytes(bytes)
        .map_err(|_| failure("INVALID_ARGUMENT", "invalidSourceKey"))?;
    if key.is_weak() {
        return Err(failure("INVALID_ARGUMENT", "weakSourceKey"));
    }
    Ok(())
}
fn digest(bytes: &[u8]) -> HostResult<Digest> {
    Digest::try_from(format!("{:x}", Sha256::digest(bytes)).as_str())
}
fn document_id() -> Id {
    Id::try_from("node-packages:sources").expect("source trust document id")
}
fn corrupt() -> HostError {
    failure("STORAGE_UNAVAILABLE", "sourceTrustStorage")
}
