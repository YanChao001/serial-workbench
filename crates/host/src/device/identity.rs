use serial_workbench_core::{DeviceDescriptor, DeviceFingerprint, Id, IdentityEvidence};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchResult {
    Exact(Id),
    RequiresRebind(Vec<Id>),
    Missing,
}

pub struct IdentityMatcher;
impl IdentityMatcher {
    pub fn match_device(saved: &DeviceFingerprint, candidates: &[DeviceDescriptor]) -> MatchResult {
        let plausible: Vec<_> = candidates
            .iter()
            .filter(|candidate| {
                let found = &candidate.fingerprint;
                saved.transport == found.transport
                    && compatible(saved.vid, found.vid)
                    && compatible(saved.pid, found.pid)
                    && compatible_text(
                        saved.serial_number.as_deref(),
                        found.serial_number.as_deref(),
                    )
            })
            .collect();
        if plausible.is_empty() {
            return MatchResult::Missing;
        }
        if let [candidate] = plausible.as_slice() {
            let found = &candidate.fingerprint;
            let saved_serial = nonempty(saved.serial_number.as_deref());
            let found_serial = nonempty(found.serial_number.as_deref());
            if saved.evidence == IdentityEvidence::SerialNumber
                && found.evidence == IdentityEvidence::SerialNumber
                && saved_serial.is_some()
                && saved_serial == found_serial
                && (saved.vid.is_none() || saved.vid == found.vid)
                && (saved.pid.is_none() || saved.pid == found.pid)
                && compatible_topology(
                    saved.topology_path.as_deref(),
                    found.topology_path.as_deref(),
                )
            {
                return MatchResult::Exact(candidate.device_id.clone());
            }
        }
        let mut ids: Vec<_> = plausible
            .into_iter()
            .map(|item| item.device_id.clone())
            .collect();
        ids.sort();
        ids.dedup();
        MatchResult::RequiresRebind(ids)
    }
}
fn compatible<T: Eq>(left: Option<T>, right: Option<T>) -> bool {
    left.is_none() || right.is_none() || left == right
}
fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}
fn compatible_text(left: Option<&str>, right: Option<&str>) -> bool {
    compatible(nonempty(left), nonempty(right))
}
fn compatible_topology(left: Option<&str>, right: Option<&str>) -> bool {
    match (nonempty(left), nonempty(right)) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}
