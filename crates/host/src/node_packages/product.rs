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
const FIELD_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/protocol-fields.zip");
const FIELD_DESCRIPTOR: &str = include_str!("../../resources/node-packages/protocol-fields.json");
const PREVIOUS_FIELD_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/protocol-fields-0.1.0.zip");
const PREVIOUS_FIELD_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/protocol-fields-0.1.0.json");
const RECENT_FIELD_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/protocol-fields-0.2.0.zip");
const RECENT_FIELD_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/protocol-fields-0.2.0.json");
const FIELD_0_3_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/protocol-fields-0.3.0.zip");
const FIELD_0_3_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/protocol-fields-0.3.0.json");
const FIELD_MARKER: &str = "node-packages:bundled-protocol-fields";
const MODBUS_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/modbus.zip");
const MODBUS_DESCRIPTOR: &str = include_str!("../../resources/node-packages/modbus.json");
const MODBUS_MARKER: &str = "node-packages:bundled-modbus";
const PREVIOUS_MODBUS_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/modbus-0.1.0.zip");
const PREVIOUS_MODBUS_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/modbus-0.1.0.json");
const MODBUS_SLAVE_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/modbus-slave.zip");
const MODBUS_SLAVE_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/modbus-slave.json");
const MODBUS_SLAVE_MARKER: &str = "node-packages:bundled-modbus-slave";
const PREVIOUS_MODBUS_SLAVE_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/modbus-slave-0.1.0.zip");
const PREVIOUS_MODBUS_SLAVE_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/modbus-slave-0.1.0.json");
const CHART_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/chart.zip");
const CHART_DESCRIPTOR: &str = include_str!("../../resources/node-packages/chart.json");
const PREVIOUS_CHART_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/chart-0.1.0.zip");
const PREVIOUS_CHART_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/chart-0.1.0.json");
const RECENT_CHART_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/chart-0.1.1.zip");
const RECENT_CHART_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/chart-0.1.1.json");
const CHART_MARKER: &str = "node-packages:bundled-chart";
const AUTOMATION_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/automation.zip");
const AUTOMATION_DESCRIPTOR: &str = include_str!("../../resources/node-packages/automation.json");
const PREVIOUS_AUTOMATION_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.0.zip");
const PREVIOUS_AUTOMATION_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.0.json");
const RECENT_AUTOMATION_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.1.zip");
const RECENT_AUTOMATION_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.1.json");
const AUTOMATION_0_1_2_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.2.zip");
const AUTOMATION_0_1_2_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.2.json");
const AUTOMATION_0_1_3_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.3.zip");
const AUTOMATION_0_1_3_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.3.json");
const AUTOMATION_0_1_4_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.4.zip");
const AUTOMATION_0_1_4_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.4.json");
const AUTOMATION_0_1_5_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.5.zip");
const AUTOMATION_0_1_5_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.5.json");
const AUTOMATION_0_1_6_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.6.zip");
const AUTOMATION_0_1_6_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.6.json");
const AUTOMATION_0_1_7_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.7.zip");
const AUTOMATION_0_1_7_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.7.json");
const AUTOMATION_0_1_8_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.8.zip");
const AUTOMATION_0_1_8_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.8.json");
const AUTOMATION_0_1_9_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.9.zip");
const AUTOMATION_0_1_9_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.9.json");
const AUTOMATION_0_1_10_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/automation-0.1.10.zip");
const AUTOMATION_0_1_10_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/automation-0.1.10.json");
const AUTOMATION_MARKER: &str = "node-packages:bundled-automation";
const TCP_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/tcp.zip");
const TCP_DESCRIPTOR: &str = include_str!("../../resources/node-packages/tcp.json");
const RFC2217_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/rfc2217.zip");
const RFC2217_DESCRIPTOR: &str = include_str!("../../resources/node-packages/rfc2217.json");
const RFC2217_MARKER: &str = "node-packages:bundled-rfc2217";
const PREVIOUS_RFC2217_ARCHIVE: &[u8] =
    include_bytes!("../../resources/node-packages/previous/rfc2217-0.1.0.zip");
const PREVIOUS_RFC2217_DESCRIPTOR: &str =
    include_str!("../../resources/node-packages/previous/rfc2217-0.1.0.json");
const UDP_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/udp.zip");
const UDP_DESCRIPTOR: &str = include_str!("../../resources/node-packages/udp.json");
const WEBSOCKET_ARCHIVE: &[u8] = include_bytes!("../../resources/node-packages/websocket.zip");
const WEBSOCKET_DESCRIPTOR: &str = include_str!("../../resources/node-packages/websocket.json");
const PRODUCT_SOURCE: &str = "swb.product";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedDescriptor {
    id: NodePackageId,
    archive_sha256: Digest,
    source_approval: NodeSourceApproveParams,
}

pub(super) struct ProductPackage {
    descriptor: SignedDescriptor,
    archive: &'static [u8],
    pub(super) marker: &'static str,
}

impl ProductPackage {
    fn new(descriptor: &str, archive: &'static [u8], marker: &'static str) -> Self {
        Self {
            descriptor: serde_json::from_str(descriptor)
                .expect("compiled product package descriptor"),
            archive,
            marker,
        }
    }

    pub(super) fn id(&self) -> &NodePackageId {
        &self.descriptor.id
    }

    fn matches_source(&self, receipt: &VerifiedNodePackageSource) -> bool {
        let approval = &self.descriptor.source_approval;
        receipt.source == approval.source
            && receipt.key_id == approval.key_id
            && receipt.public_key_sha256 == approval.public_key_sha256
    }

    fn matches_installation(&self, package: &InstalledNodePackage) -> bool {
        package.activation_authority.is_none()
            && self.id() == &package.manifest.id
            && self.descriptor.archive_sha256 == package.archive_sha256
            && package
                .verified_source
                .as_ref()
                .is_some_and(|source| self.matches_source(source))
    }

    pub(super) fn replaces(&self, package: &InstalledNodePackage) -> bool {
        self.descriptor.archive_sha256 != package.archive_sha256
            && previous_packages().iter().any(|previous| {
                self.marker == previous.marker && previous.matches_installation(package)
            })
    }

    pub(super) fn verify_embedded(
        &self,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<VerifiedNodePackage> {
        self.verify_bytes(self.archive.to_vec(), limits, cancel)
    }

    fn verify_bytes(
        &self,
        bytes: Vec<u8>,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<VerifiedNodePackage> {
        let approval = &self.descriptor.source_approval;
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
        if &package.manifest().id != self.id()
            || package.archive_sha256() != &self.descriptor.archive_sha256
            || !package
                .verified_source()
                .is_some_and(|source| self.matches_source(source))
        {
            return Err(super::installed::integrity("productPackageDescriptor"));
        }
        Ok(package)
    }
}

pub(super) fn packages() -> &'static [ProductPackage] {
    static PACKAGES: OnceLock<[ProductPackage; 10]> = OnceLock::new();
    PACKAGES.get_or_init(|| {
        [
            ProductPackage::new(
                FRAMING_DESCRIPTOR,
                FRAMING_ARCHIVE,
                "node-packages:bundled-framing",
            ),
            ProductPackage::new(FIELD_DESCRIPTOR, FIELD_ARCHIVE, FIELD_MARKER),
            ProductPackage::new(MODBUS_DESCRIPTOR, MODBUS_ARCHIVE, MODBUS_MARKER),
            ProductPackage::new(
                MODBUS_SLAVE_DESCRIPTOR,
                MODBUS_SLAVE_ARCHIVE,
                MODBUS_SLAVE_MARKER,
            ),
            ProductPackage::new(CHART_DESCRIPTOR, CHART_ARCHIVE, CHART_MARKER),
            ProductPackage::new(AUTOMATION_DESCRIPTOR, AUTOMATION_ARCHIVE, AUTOMATION_MARKER),
            ProductPackage::new(TCP_DESCRIPTOR, TCP_ARCHIVE, "node-packages:bundled-tcp"),
            ProductPackage::new(RFC2217_DESCRIPTOR, RFC2217_ARCHIVE, RFC2217_MARKER),
            ProductPackage::new(UDP_DESCRIPTOR, UDP_ARCHIVE, "node-packages:bundled-udp"),
            ProductPackage::new(
                WEBSOCKET_DESCRIPTOR,
                WEBSOCKET_ARCHIVE,
                "node-packages:bundled-websocket",
            ),
        ]
    })
}

fn previous_packages() -> &'static [ProductPackage; 19] {
    static PREVIOUS: OnceLock<[ProductPackage; 19]> = OnceLock::new();
    PREVIOUS.get_or_init(|| {
        [
            ProductPackage::new(
                PREVIOUS_FIELD_DESCRIPTOR,
                PREVIOUS_FIELD_ARCHIVE,
                FIELD_MARKER,
            ),
            ProductPackage::new(RECENT_FIELD_DESCRIPTOR, RECENT_FIELD_ARCHIVE, FIELD_MARKER),
            ProductPackage::new(FIELD_0_3_DESCRIPTOR, FIELD_0_3_ARCHIVE, FIELD_MARKER),
            ProductPackage::new(
                PREVIOUS_CHART_DESCRIPTOR,
                PREVIOUS_CHART_ARCHIVE,
                CHART_MARKER,
            ),
            ProductPackage::new(RECENT_CHART_DESCRIPTOR, RECENT_CHART_ARCHIVE, CHART_MARKER),
            ProductPackage::new(
                PREVIOUS_AUTOMATION_DESCRIPTOR,
                PREVIOUS_AUTOMATION_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                RECENT_AUTOMATION_DESCRIPTOR,
                RECENT_AUTOMATION_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_2_DESCRIPTOR,
                AUTOMATION_0_1_2_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_3_DESCRIPTOR,
                AUTOMATION_0_1_3_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_4_DESCRIPTOR,
                AUTOMATION_0_1_4_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_5_DESCRIPTOR,
                AUTOMATION_0_1_5_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_6_DESCRIPTOR,
                AUTOMATION_0_1_6_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_7_DESCRIPTOR,
                AUTOMATION_0_1_7_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_8_DESCRIPTOR,
                AUTOMATION_0_1_8_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_9_DESCRIPTOR,
                AUTOMATION_0_1_9_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                AUTOMATION_0_1_10_DESCRIPTOR,
                AUTOMATION_0_1_10_ARCHIVE,
                AUTOMATION_MARKER,
            ),
            ProductPackage::new(
                PREVIOUS_RFC2217_DESCRIPTOR,
                PREVIOUS_RFC2217_ARCHIVE,
                RFC2217_MARKER,
            ),
            ProductPackage::new(
                PREVIOUS_MODBUS_DESCRIPTOR,
                PREVIOUS_MODBUS_ARCHIVE,
                MODBUS_MARKER,
            ),
            ProductPackage::new(
                PREVIOUS_MODBUS_SLAVE_DESCRIPTOR,
                PREVIOUS_MODBUS_SLAVE_ARCHIVE,
                MODBUS_SLAVE_MARKER,
            ),
        ]
    })
}

pub(crate) const CONNECTION_SEQUENCE_ACTION: &str = "swb.builtin.automation.connect";
pub(crate) const TRUSTED_SCRIPT_ACTION: &str = "swb.builtin.automation.script";
const CONNECTION_SEQUENCE_PACKAGE: &str = "swb.builtin.automation";

pub(crate) fn is_current_automation_archive(id: &NodePackageId, digest: &Digest) -> bool {
    id.as_str() == CONNECTION_SEQUENCE_PACKAGE
        && packages()
            .iter()
            .any(|package| package.id() == id && &package.descriptor.archive_sha256 == digest)
}

pub(crate) fn is_connection_sequence_device_scope(
    scope: &serial_workbench_core::NodeHostApiScope,
) -> bool {
    matches!(scope.target_kinds.as_slice(), [kind] if kind.as_str() == "device")
        && scope.permissions.as_slice() == ["metadata.read", "device.modify"]
}

pub(super) fn retains_execution_permissions(
    previous: &InstalledNodePackage,
    next: &VerifiedNodePackage,
) -> bool {
    if previous.manifest.permissions == next.manifest().permissions {
        return true;
    }
    // The signed 0.1.8 scope remains owned by the pinned connection action.
    // Task dispatch still removes the device scope for unrelated actions.
    if !is_current_automation_archive(&next.manifest().id, next.archive_sha256()) {
        return false;
    }
    let mut existing_permissions = next.manifest().permissions.clone();
    let count_before = existing_permissions.host_api.len();
    existing_permissions
        .host_api
        .retain(|scope| !is_connection_sequence_device_scope(scope));
    existing_permissions.host_api.len() + 1 == count_before
        && existing_permissions == previous.manifest.permissions
}

/// Validates the archive recorded by Host admission, including supported product predecessors.
pub(crate) fn is_product_connection_sequence(operation: &serial_workbench_core::Operation) -> bool {
    let Some([dependency]) = operation.dependencies.as_deref() else {
        return false;
    };
    operation.action_id.as_str() == CONNECTION_SEQUENCE_ACTION
        && operation.owner.kind == serial_workbench_core::OwnerKind::Plugin
        && dependency.id.as_str() == CONNECTION_SEQUENCE_PACKAGE
        && trusted_packages().any(|package| {
            package.id().as_str() == CONNECTION_SEQUENCE_PACKAGE
                && package.descriptor.archive_sha256 == dependency.digest
        })
}

fn trusted_packages() -> impl Iterator<Item = &'static ProductPackage> {
    packages().iter().chain(previous_packages())
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
    if !trusted_packages().any(|package| package.matches_source(receipt)) {
        return Err(failure("PERMISSION_DENIED", "productSourceKey"));
    }
    Ok(())
}

pub(super) fn has_product_origin(package: &InstalledNodePackage) -> bool {
    trusted_packages().any(|bundle| bundle.matches_installation(package))
}

pub(super) fn verify(
    bytes: Vec<u8>,
    limits: &NodePackageLimits,
    cancel: &AtomicBool,
) -> HostResult<VerifiedNodePackage> {
    let bundle = trusted_packages()
        .find(|bundle| bundle.archive == bytes.as_slice())
        .ok_or_else(|| failure("PERMISSION_DENIED", "productArchiveMismatch"))?;
    bundle.verify_bytes(bytes, limits, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        node_packages::{NodePackageInstaller, NodePackageSources},
        storage::Store,
    };

    #[test]
    fn known_predecessor_upgrades_and_preserves_the_profile_decision() {
        let [
            old_fields,
            recent_fields,
            comparison_fields,
            old_chart,
            recent_chart,
            old_automation,
            recent_automation,
            recording_automation,
            assertion_automation,
            rule_automation,
            calendar_automation,
            response_automation,
            loopback_automation,
            connection_automation,
            script_automation,
            current_script_automation,
            old_rfc2217,
            old_modbus,
            old_modbus_slave,
        ] = previous_packages();
        check_predecessor_upgrade(old_fields, "0.1.0", "0.4.0");
        check_predecessor_upgrade(recent_fields, "0.2.0", "0.4.0");
        check_predecessor_upgrade(comparison_fields, "0.3.0", "0.4.0");
        check_predecessor_upgrade(old_chart, "0.1.0", "0.1.2");
        check_predecessor_upgrade(recent_chart, "0.1.1", "0.1.2");
        check_predecessor_upgrade(old_automation, "0.1.0", "0.1.11");
        check_predecessor_upgrade(recent_automation, "0.1.1", "0.1.11");
        check_predecessor_upgrade(recording_automation, "0.1.2", "0.1.11");
        check_predecessor_upgrade(assertion_automation, "0.1.3", "0.1.11");
        check_predecessor_upgrade(rule_automation, "0.1.4", "0.1.11");
        check_predecessor_upgrade(calendar_automation, "0.1.5", "0.1.11");
        check_predecessor_upgrade(response_automation, "0.1.6", "0.1.11");
        check_predecessor_upgrade(loopback_automation, "0.1.7", "0.1.11");
        check_predecessor_upgrade(connection_automation, "0.1.8", "0.1.11");
        check_predecessor_upgrade(script_automation, "0.1.9", "0.1.11");
        check_predecessor_upgrade(current_script_automation, "0.1.10", "0.1.11");
        check_predecessor_upgrade(old_rfc2217, "0.1.0", "0.1.1");
        check_predecessor_upgrade(old_modbus, "0.1.0", "0.1.1");
        check_predecessor_upgrade(old_modbus_slave, "0.1.0", "0.1.1");
    }

    fn check_predecessor_upgrade(old: &ProductPackage, old_version: &str, next_version: &str) {
        let limits = NodePackageLimits::default();
        let cancel = AtomicBool::new(false);
        let latest = packages()
            .iter()
            .find(|item| item.marker == old.marker)
            .unwrap();
        for expected_enabled in [Some(true), Some(false), None] {
            let profile = tempfile::tempdir().unwrap();
            let store = Store::open(profile.path()).unwrap();
            let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
            installer
                .provision_bundled_package(old, &limits, &cancel)
                .unwrap();
            let original = installer.snapshot().unwrap();
            let package = original.packages.first().unwrap();
            assert!(has_product_origin(package));
            assert!(latest.replaces(package));
            assert_eq!(package.manifest.version.as_str(), old_version);
            let mut foreign = package.clone();
            foreign.verified_source = None;
            assert!(!latest.replaces(&foreign));
            let disabled = if expected_enabled != Some(true) {
                installer
                    .set_enabled(old.id(), false, original.revision, &package.archive_sha256)
                    .unwrap()
            } else {
                original.clone()
            };
            if expected_enabled.is_none() {
                installer
                    .uninstall_authorized(
                        &serial_workbench_core::NodePackageIdentityParams {
                            id: old.id().clone(),
                            archive_sha256: package.archive_sha256.clone(),
                        },
                        disabled.revision,
                        &limits,
                        &cancel,
                        || Ok(()),
                        |_| Ok(()),
                    )
                    .unwrap();
            }
            installer
                .provision_bundled_package(latest, &limits, &cancel)
                .unwrap();
            let migrated = installer.snapshot().unwrap();
            assert_eq!(
                migrated.packages.first().map(|package| package.enabled),
                expected_enabled,
                "{} {old_version} → {next_version}",
                old.id().as_str()
            );
            if let Some(package) = migrated.packages.first() {
                assert_eq!(package.manifest.version.as_str(), next_version);
                assert_eq!(package.archive_sha256, latest.descriptor.archive_sha256);
                assert!(has_product_origin(package));
                assert_eq!(package.activation_authority, None);
            }
            installer
                .provision_bundled_package(latest, &limits, &cancel)
                .unwrap();
            assert_eq!(installer.snapshot().unwrap(), migrated);
        }
    }

    #[test]
    fn product_archive_matches_signature_and_descriptor() {
        let limits = NodePackageLimits::default();
        let cancel = AtomicBool::new(false);
        for (archive, descriptor) in [
            (FRAMING_ARCHIVE, FRAMING_DESCRIPTOR),
            (AUTOMATION_ARCHIVE, AUTOMATION_DESCRIPTOR),
        ] {
            let package = verify(archive.to_vec(), &limits, &cancel).unwrap();
            let raw: serde_json::Value = serde_json::from_str(descriptor).unwrap();
            assert_eq!(Some(package.manifest().id.as_str()), raw["id"].as_str());
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
                assert_eq!(Some(entry.sha256.as_str()), raw[field].as_str(), "{path}");
            }
        }
        let mut modified = FRAMING_ARCHIVE.to_vec();
        modified[0] ^= 1;
        assert_eq!(
            verify(modified, &limits, &cancel).unwrap_err().code,
            "PERMISSION_DENIED"
        );
    }

    #[test]
    fn bundled_chart_signature_covers_view_assets() {
        let package = verify(
            CHART_ARCHIVE.to_vec(),
            &NodePackageLimits::default(),
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(package.manifest().id.as_str(), "swb.builtin.chart");
        let descriptor: serde_json::Value = serde_json::from_str(CHART_DESCRIPTOR).unwrap();
        assert_eq!(
            Some(package.manifest().version.as_str()),
            descriptor["version"].as_str()
        );
        for (path, field) in [
            ("dist/main.mjs", "compiledModuleSha256"),
            ("manifest.json", "manifestSha256"),
            ("ui/index.html", "viewHtmlSha256"),
            ("ui/view.css", "viewCssSha256"),
            ("ui/view.js", "viewScriptSha256"),
        ] {
            let entry = package
                .integrity()
                .files
                .iter()
                .find(|entry| entry.path.as_str() == path)
                .unwrap();
            assert_eq!(Some(entry.sha256.as_str()), descriptor[field].as_str());
        }
    }

    #[test]
    fn product_key_cannot_be_registered_or_used_by_external_installation() {
        let profile = tempfile::tempdir().unwrap();
        let sources = NodePackageSources::new(Store::open(profile.path()).unwrap());
        let approval = &packages()[0].descriptor.source_approval;
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
    fn product_archives_keep_separate_source_receipts_and_activation() {
        let profile = tempfile::tempdir().unwrap();
        let store = Store::open(profile.path()).unwrap();
        let installer = NodePackageInstaller::new(store, profile.path()).unwrap();
        let limits = NodePackageLimits::default();
        let cancel = AtomicBool::new(false);
        let framing = packages()[0].verify_embedded(&limits, &cancel).unwrap();
        let fields = packages()[1].verify_embedded(&limits, &cancel).unwrap();
        let modbus = packages()[2].verify_embedded(&limits, &cancel).unwrap();
        assert_ne!(framing.verified_source(), fields.verified_source());
        assert_ne!(modbus.verified_source(), framing.verified_source());
        assert_ne!(modbus.verified_source(), fields.verified_source());
        assert_eq!(fields.manifest().id, packages()[1].descriptor.id);
        assert_eq!(modbus.manifest().id, packages()[2].descriptor.id);
        let other_source = framing.verified_source().unwrap().clone();
        installer
            .provision_bundled_package(&packages()[0], &limits, &cancel)
            .unwrap();
        let previous = installer.snapshot().unwrap();
        let previous_archive = &previous.packages[0].archive_sha256;
        let disabled = installer
            .set_enabled(
                packages()[0].id(),
                false,
                previous.revision,
                previous_archive,
            )
            .unwrap();
        installer
            .provision_bundled_package(&packages()[1], &limits, &cancel)
            .unwrap();
        installer
            .provision_bundled_package(&packages()[2], &limits, &cancel)
            .unwrap();
        installer
            .provision_bundled_package(&packages()[0], &limits, &cancel)
            .unwrap();
        let after = installer.snapshot().unwrap();
        assert_eq!(after.packages.len(), 3);
        assert!(after.packages.contains(&disabled.packages[0]));
        let provided_fields = after
            .packages
            .iter()
            .find(|entry| &entry.manifest.id == packages()[1].id())
            .unwrap();
        assert!(provided_fields.enabled && has_product_origin(provided_fields));
        let mut wrong = provided_fields.clone();
        wrong.verified_source = Some(other_source);
        assert!(!has_product_origin(&wrong));
        let provided_modbus = after
            .packages
            .iter()
            .find(|entry| &entry.manifest.id == packages()[2].id())
            .unwrap();
        assert!(provided_modbus.enabled && has_product_origin(provided_modbus));
        let disabled_modbus = installer
            .set_enabled(
                packages()[2].id(),
                false,
                after.revision,
                &provided_modbus.archive_sha256,
            )
            .unwrap();
        installer
            .provision_bundled_package(&packages()[2], &limits, &cancel)
            .unwrap();
        assert_eq!(installer.snapshot().unwrap(), disabled_modbus);
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
                .provision_bundled_package(&packages()[0], &limits, &cancel)
                .unwrap_err()
                .code,
            "CANCELLED"
        );
        assert!(installer.snapshot().unwrap().packages.is_empty());

        cancel.store(false, std::sync::atomic::Ordering::Release);
        installer
            .provision_bundled_package(&packages()[0], &limits, &cancel)
            .unwrap();
        let installed = installer.snapshot().unwrap();
        let package = installed.packages.first().unwrap();
        assert!(package.enabled && has_product_origin(package));
        assert!(package.execution_trust.is_some());
        installer
            .provision_bundled_package(&packages()[0], &limits, &cancel)
            .unwrap();
        assert_eq!(installer.snapshot().unwrap(), installed);

        let disabled = installer
            .set_enabled(
                packages()[0].id(),
                false,
                installed.revision,
                &package.archive_sha256,
            )
            .unwrap();
        assert!(!disabled.packages[0].enabled);
        installer
            .provision_bundled_package(&packages()[0], &limits, &cancel)
            .unwrap();
        assert_eq!(installer.snapshot().unwrap(), disabled);

        installer
            .uninstall_authorized(
                &serial_workbench_core::NodePackageIdentityParams {
                    id: packages()[0].id().clone(),
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
            .provision_bundled_package(&packages()[0], &limits, &cancel)
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
            .provision_bundled_package(&packages()[0], &limits, &cancel)
            .unwrap();
        let after = installer.snapshot().unwrap();
        assert_eq!(after.revision, receipt.revision);
        assert_eq!(after.packages, [receipt.package]);
        assert!(!has_product_origin(&after.packages[0]));
        assert!(after.packages[0].execution_trust.is_none());
    }
}
