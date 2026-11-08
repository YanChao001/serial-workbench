use super::{
    format::*,
    verify::verify_directory,
    writer::{CaptureLimits, CaptureWriter},
};
use serial_workbench_core::*;
use std::path::Path;
pub fn recover_directory(
    source: &Path,
    target: &Path,
    report: &VerificationReport,
) -> HostResult<CaptureSummary> {
    recover_directory_observed(source, target, report, |_| {})
}
/// Trusted Host test seam; not available through request parameters.
fn recover_directory_observed(
    source: &Path,
    target: &Path,
    report: &VerificationReport,
    observe: impl FnMut(super::verify::CopyPhase),
) -> HostResult<CaptureSummary> {
    recover_bound(
        source,
        &crate::files::references::PathGuard::new(target)?,
        report,
        observe,
    )
}
pub(crate) fn recover_at(
    source: &Path,
    target: &crate::files::references::PathGuard,
    report: &VerificationReport,
) -> HostResult<CaptureSummary> {
    recover_bound(source, target, report, |_| {})
}
fn recover_bound(
    source: &Path,
    destination: &crate::files::references::PathGuard,
    report: &VerificationReport,
    mut observe: impl FnMut(super::verify::CopyPhase),
) -> HostResult<CaptureSummary> {
    let target = destination.checked_path();
    let _source_guard = crate::files::references::PathGuard::new(source)?;
    if target.exists() {
        return Err(HostError::new(
            "TARGET_EXISTS",
            "Recovery target already exists",
        ));
    }
    if fingerprint(source)? != report.source_fingerprint {
        return Err(changed());
    }
    let mut scan = verify_directory(source)?;
    if scan.report.source_fingerprint != report.source_fingerprint
        || scan.report.verified_prefix != report.verified_prefix
    {
        return Err(changed());
    }
    if !scan.report.recoverable {
        return Err(HostError::new(
            "CAPTURE_INCOMPLETE",
            "No verified prefix is available",
        ));
    }
    scan.bind_files(source)?;
    let name = format!(".recovery-pending-{}", uuid::Uuid::new_v4());
    let temporary = destination.sibling(std::ffi::OsStr::new(&name))?;
    let mut writer = CaptureWriter::create_at(
        destination.sibling(std::ffi::OsStr::new(&name))?,
        scan.manifest.streams.clone(),
        CaptureLimits::default(),
        super::writer::native_volume_opener(),
    )?;
    writer.recover_from(report.source_fingerprint.clone());
    for position in 0..report.verified_prefix.get() as usize {
        observe(super::verify::CopyPhase::BeforeRecord);
        let record = scan.read_verified_record(position)?;
        observe(super::verify::CopyPhase::AfterRecord);
        let now = record_time(&record).unwrap_or(0);
        writer.push(record.entry, now)?;
    }
    let summary = writer.finish_recovered()?;
    if fingerprint(source)? != report.source_fingerprint {
        return Err(changed());
    }
    temporary.rename_to(destination, false)?;
    destination.sync_parent()?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{
        verify::{CopyPhase, verify_directory},
        writer::{CaptureLimits, CaptureWriter},
    };
    use sha2::{Digest as _, Sha256};
    #[test]
    fn copied_record_must_match_verified_snapshot_despite_source_restore() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().canonicalize().unwrap().join("source");
        let target = d.path().canonicalize().unwrap().join("target");
        let source_meta = CaptureSource {
            host_id: Id::try_from("h").unwrap(),
            instance_epoch: 1.into(),
            session_id: Id::try_from("s").unwrap(),
            session_epoch: 1.into(),
            configuration_digest: Digest::try_from(
                "0000000000000000000000000000000000000000000000000000000000000000",
            )
            .unwrap(),
            configuration: SerialConfiguration::default(),
            time_precision: TimePrecision {
                source: TimeSource::HostRead,
                resolution_ns: 1.into(),
                sync_method: "none".into(),
                offset_estimate_ns: None,
                offset_error_ns: None,
                rtt_ns: None,
            },
        };
        let event = CaptureEntry::Event(Box::new(serde_json::from_value(serde_json::json!({
            "hostId":"h","instanceEpoch":"1","sessionId":"s","sessionEpoch":"1","eventSeq":"1",
            "configurationRevision":"1","time":{"clockId":"c","sourceMonoNs":"1","receivedWallTime":"2026-11-07T00:00:00Z",
            "precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},
            "kind":"rx","payload":{"bytesBase64":"AQID","byteStart":"0","byteEnd":"3"}
        })).unwrap()));
        let mut writer =
            CaptureWriter::create(&source, vec![source_meta], CaptureLimits::default()).unwrap();
        writer.push(event, 0).unwrap();
        writer.finish().unwrap();
        let scan = verify_directory(&source).unwrap();
        let volume = source.join(volume_name(1));
        let original = std::fs::read(&volume).unwrap();
        let mut altered = original.clone();
        let len = u32::from_le_bytes(original[7..11].try_into().unwrap()) as usize;
        let json = String::from_utf8(original[11..11 + len].to_vec())
            .unwrap()
            .replace("AQID", "CQID");
        assert_eq!(json.len(), len);
        assert_ne!(json.as_bytes(), &original[11..11 + len]);
        altered[11..11 + len].copy_from_slice(json.as_bytes());
        altered[11 + len..11 + len + 32].copy_from_slice(&Sha256::digest(json.as_bytes()));
        let observe = |phase| match phase {
            CopyPhase::BeforeRecord => {
                std::fs::write(&volume, &altered).unwrap();
            }
            CopyPhase::AfterRecord => {
                std::fs::write(&volume, &original).unwrap();
            }
        };
        let result =
            recover_directory_observed(&source, &target, &scan.report, observe).map(|_| ());
        std::fs::write(&volume, &original).unwrap();
        assert_eq!(
            fingerprint(&source).unwrap(),
            scan.report.source_fingerprint
        );
        assert_eq!(result.unwrap_err().code, "SOURCE_CHANGED");
        assert!(!target.exists(), "unverified bytes must never be published");
    }
}
