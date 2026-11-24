//! 首方信任以 Host 内嵌的完整归档为范围。
use super::{
    InstalledNodePackage, NodePackageLimits, NodePackageSource, VerifiedNodePackage, failure,
    verify_node_package,
};
use serde::Deserialize;
use serial_workbench_core::{
    Digest, HostResult, Id, NodePackageId, NodeSourceApproveParams, VerifiedNodePackageSource,
};
use std::sync::{OnceLock, atomic::AtomicBool};

const FRAMING_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/framing.zip");
const FRAMING_DESCRIPTOR: &str = include_str!("../../resources/node-packages/framing.json");
const PRODUCT_SOURCE: &str = "swb.product";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductPackage {
    id: NodePackageId,
    archive_sha256: Digest,
    source_approval: NodeSourceApproveParams,
}

fn framing() -> &'static ProductPackage {
    static FRAMING: OnceLock<ProductPackage> = OnceLock::new();
    FRAMING.get_or_init(|| {
        serde_json::from_str(FRAMING_DESCRIPTOR).expect("compiled product package descriptor")
    })
}

pub(super) fn is_product_source(source: &Id) -> bool {
    source.as_str() == PRODUCT_SOURCE
}

pub(super) fn require_external_source(source: &Id) -> HostResult<()> {
    if is_product_source(source) {
        return Err(failure("PERMISSION_DENIED", "productSourceReserved"));
    }
    Ok(())
}

pub(super) fn require_current(receipt: &VerifiedNodePackageSource) -> HostResult<()> {
    let approval = &framing().source_approval;
    if receipt.source != approval.source
        || receipt.key_id != approval.key_id
        || receipt.public_key_sha256 != approval.public_key_sha256
    {
        return Err(failure("PERMISSION_DENIED", "productSourceKey"));
    }
    Ok(())
}

pub(super) fn framing_id() -> &'static NodePackageId {
    &framing().id
}

pub(super) fn bundled_framing(
    limits: &NodePackageLimits,
    cancel: &AtomicBool,
) -> HostResult<VerifiedNodePackage> {
    verify(FRAMING_ARCHIVE.to_vec(), limits, cancel)
}

pub(super) fn has_product_origin(package: &InstalledNodePackage) -> bool {
    package.activation_authority.is_none()
        && &package.manifest.id == framing_id()
        && package.archive_sha256 == framing().archive_sha256
        && package
            .verified_source
            .as_ref()
            .is_some_and(|source| require_current(source).is_ok())
}

pub(super) fn verify(
    bytes: Vec<u8>,
    limits: &NodePackageLimits,
    cancel: &AtomicBool,
) -> HostResult<VerifiedNodePackage> {
    if bytes.as_slice() != FRAMING_ARCHIVE {
        return Err(failure("PERMISSION_DENIED", "productArchiveMismatch"));
    }
    let descriptor = framing();
    let approval = &descriptor.source_approval;
    let package = verify_node_package(
        bytes,
        NodePackageSource::Trusted {
            source: &approval.source,
            key_id: &approval.key_id,
            public_key: &approval.public_key,
        },
        limits,
        cancel,
    )?;
    if package.manifest().id != descriptor.id
        || package.archive_sha256() != &descriptor.archive_sha256
    {
        return Err(super::installed::integrity("productPackageDescriptor"));
    }
    require_current(
        package
            .verified_source()
            .expect("trusted verification receipt"),
    )?;
    Ok(package)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        node_packages::{NodePackageInstaller, NodePackageSources},
        storage::Store,
    };

    #[test]
    fn product_archive_matches_signature_and_descriptor() {
        let limits = NodePackageLimits::default();
        let cancel = AtomicBool::new(false);
        let package = verify(FRAMING_ARCHIVE.to_vec(), &limits, &cancel).unwrap();
        assert_eq!(package.manifest().id.as_str(), "swb.reference.framing");
        let raw: serde_json::Value = serde_json::from_str(FRAMING_DESCRIPTOR).unwrap();
        assert_eq!(
            Some(package.manifest().version.as_str()),
            raw["version"].as_str()
        );
        for (path, field) in [
            ("dist/main.mjs", "compiledModuleSha256"),
            ("manifest.json", "manifestSha256"),
        ] {
            let entry = package
                .integrity()
                .files
                .iter()
                .find(|entry| entry.path.as_str() == path)
                .unwrap();
            assert_eq!(Some(entry.sha256.as_str()), raw[field].as_str());
        }
        let mut modified = FRAMING_ARCHIVE.to_vec();
        modified[0] ^= 1;
        assert_eq!(
            verify(modified, &limits, &cancel).unwrap_err().code,
            "PERMISSION_DENIED"
        );
    }

    #[test]
    fn product_key_cannot_be_registered_or_used_by_external_installation() {
        let profile = tempfile::tempdir().unwrap();
        let sources = NodePackageSources::new(Store::open(profile.path()).unwrap());
        let approval = &framing().source_approval;
        assert_eq!(
            sources
                .approve_key(
                    approval.source.clone(),
                    approval.key_id.clone(),
                    approval.public_key,
                    0.into()
                )
                .unwrap_err()
                .code,
            "PERMISSION_DENIED",
        );
        assert_eq!(
            sources
                .verify(
                    FRAMING_ARCHIVE.to_vec(),
                    &approval.source,
                    &approval.key_id,
                    &NodePackageLimits::default(),
                    &AtomicBool::new(false)
                )
                .unwrap_err()
                .code,
            "PERMISSION_DENIED",
        );
        assert!(sources.snapshot().unwrap().keys.is_empty());
    }

    #[test]
    fn installed_product_archive_revalidates_without_an_external_key() {
        let profile = tempfile::tempdir().unwrap();
        let store = Store::open(profile.path()).unwrap();
        let sources = NodePackageSources::new(store.clone());
        let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
        let limits = NodePackageLimits::default();
        let cancel = AtomicBool::new(false);
        let package = verify(FRAMING_ARCHIVE.to_vec(), &limits, &cancel).unwrap();
        let installed = installer
            .install(package, 0.into(), &limits, &cancel)
            .unwrap();
        let proof = installer
            .verify_installed(
                &installed.package.manifest.id,
                installed.revision,
                &installed.package.archive_sha256,
                &limits,
                &cancel,
            )
            .unwrap();
        assert_eq!(proof.package(), &installed.package);
        assert!(!installed.package.enabled);
        assert!(sources.snapshot().unwrap().keys.is_empty());
    }

    #[test]
    fn default_installation_is_not_recreated_after_disable_and_uninstall() {
        let profile = tempfile::tempdir().unwrap();
        let store = Store::open(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
        let limits = NodePackageLimits::default();
        let cancel = AtomicBool::new(true);

        assert_eq!(
            installer
                .provision_bundled_framing(&limits, &cancel)
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert!(installer.snapshot().unwrap().packages.is_empty());

        cancel.store(false, std::sync::atomic::Ordering::Release);
        installer
            .provision_bundled_framing(&limits, &cancel)
            .unwrap();
        let installed = installer.snapshot().unwrap();
        let package = installed.packages.first().unwrap();
        assert!(package.enabled && has_product_origin(package));
        assert!(package.execution_trust.is_some());
        installer
            .provision_bundled_framing(&limits, &cancel)
            .unwrap();
        assert_eq!(installer.snapshot().unwrap(), installed);

        let disabled = installer
            .set_enabled(
                framing_id(),
                false,
                installed.revision,
                &package.archive_sha256,
            )
            .unwrap();
        assert!(!disabled.packages[0].enabled);
        installer
            .provision_bundled_framing(&limits, &cancel)
            .unwrap();
        assert_eq!(installer.snapshot().unwrap(), disabled);

        installer
            .uninstall_authorized(
                &serial_workbench_core::NodePackageIdentityParams {
                    id: framing_id().clone(),
                    archive_sha256: package.archive_sha256.clone(),
                },
                disabled.revision,
                &limits,
                &cancel,
                || Ok(()),
                |_| Ok(()),
            )
            .unwrap();
        let removed = installer.snapshot().unwrap();
        assert!(removed.packages.is_empty());
        installer
            .provision_bundled_framing(&limits, &cancel)
            .unwrap();
        assert_eq!(installer.snapshot().unwrap(), removed);
    }

    #[test]
    fn same_id_local_package_retains_its_own_installation_and_trust() {
        let profile = tempfile::tempdir().unwrap();
        let store = Store::open(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
        let limits = NodePackageLimits::default();
        let cancel = AtomicBool::new(false);
        let local = verify_node_package(
            FRAMING_ARCHIVE.to_vec(),
            NodePackageSource::Local,
            &limits,
            &cancel,
        )
        .unwrap();
        let receipt = installer
            .install(local, 0.into(), &limits, &cancel)
            .unwrap();
        installer
            .provision_bundled_framing(&limits, &cancel)
            .unwrap();
        let after = installer.snapshot().unwrap();
        assert_eq!(after.revision, receipt.revision);
        assert_eq!(after.packages, [receipt.package]);
        assert!(!has_product_origin(&after.packages[0]));
        assert!(after.packages[0].execution_trust.is_none());
    }
}
