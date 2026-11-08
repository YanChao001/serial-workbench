use crate::{
    device::identity::{IdentityMatcher, MatchResult},
    storage::Store,
};
use serde::{Deserialize, Serialize};
use serial_workbench_core::{
    DeviceDescriptor, DeviceList, HostError, HostResult, Id, JsonObject, RecentConnection,
    RecentList,
};
use std::collections::{BTreeMap, BTreeSet};

pub struct DeviceDirectory {
    snapshot: DeviceList,
}
impl Default for DeviceDirectory {
    fn default() -> Self {
        Self {
            snapshot: DeviceList {
                devices: Vec::new(),
                stale: false,
            },
        }
    }
}
impl DeviceDirectory {
    pub fn apply(&mut self, result: HostResult<Vec<DeviceDescriptor>>) -> Option<DeviceList> {
        self.apply_with_anchors(result, &[])
    }
    pub(crate) fn apply_with_anchors(
        &mut self,
        result: HostResult<Vec<DeviceDescriptor>>,
        anchors: &[DeviceDescriptor],
    ) -> Option<DeviceList> {
        let mut next = match result {
            Err(_) => DeviceList {
                devices: self.snapshot.devices.clone(),
                stale: true,
            },
            Ok(mut devices) => {
                devices.sort_by(|a, b| {
                    (&a.host_id, &a.system_name, &a.device_id).cmp(&(
                        &b.host_id,
                        &b.system_name,
                        &b.device_id,
                    ))
                });
                let mut matches: BTreeMap<Id, Vec<Id>> = BTreeMap::new();
                let mut remembered = self.snapshot.devices.clone();
                for anchor in anchors {
                    if !remembered
                        .iter()
                        .any(|old| old.device_id == anchor.device_id)
                    {
                        remembered.push(anchor.clone());
                    }
                }
                for old in &remembered {
                    let candidates: Vec<_> = devices
                        .iter()
                        .filter(|candidate| candidate.host_id == old.host_id)
                        .cloned()
                        .collect();
                    if let MatchResult::Exact(id) =
                        IdentityMatcher::match_device(&old.fingerprint, &candidates)
                    {
                        matches.entry(id).or_default().push(old.device_id.clone());
                    }
                }
                let mut used = BTreeSet::new();
                for device in &mut devices {
                    let same: Vec<_> = self
                        .snapshot
                        .devices
                        .iter()
                        .filter(|old| {
                            old.host_id == device.host_id
                                && old.system_name == device.system_name
                                && old.fingerprint == device.fingerprint
                                && !used.contains(&old.device_id)
                        })
                        .collect();
                    let prior =
                        matches
                            .get(&device.device_id)
                            .and_then(|ids| match ids.as_slice() {
                                [id] if !used.contains(id) => Some(id.clone()),
                                _ => None,
                            });
                    if let Some(id) = prior {
                        device.device_id = id.clone();
                        used.insert(id);
                    } else if let [old] = same.as_slice() {
                        device.device_id = old.device_id.clone();
                        used.insert(old.device_id.clone());
                    } else {
                        device.device_id = Id::try_from(uuid::Uuid::new_v4().to_string().as_str())
                            .expect("UUID is a valid ID");
                    }
                }
                DeviceList {
                    devices,
                    stale: false,
                }
            }
        };
        next.devices.sort_by(|a, b| a.device_id.cmp(&b.device_id));
        if self.snapshot == next {
            return None;
        }
        self.snapshot = next.clone();
        Some(next)
    }
    pub fn snapshot(&self) -> &DeviceList {
        &self.snapshot
    }
}

const RECENT_DOCUMENT: &str = "host:recent-devices";
const RECENT_LIMIT: usize = 100;
const CAS_ATTEMPTS: usize = 16;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecentDocument {
    format_version: String,
    entries: Vec<RecentConnection>,
}

pub struct RecentConnections {
    store: Store,
}
impl RecentConnections {
    pub fn new(store: Store) -> Self {
        Self { store }
    }
    pub fn list(&self) -> HostResult<RecentList> {
        let key = Id::try_from(RECENT_DOCUMENT)?;
        match self.store.read_document(&key)? {
            None => Ok(RecentList {
                revision: 0.into(),
                entries: Vec::new(),
            }),
            Some(document) => {
                let data: RecentDocument = serde_json::from_value(
                    serde_json::to_value(document.value).map_err(|_| invalid_recent())?,
                )
                .map_err(|_| invalid_recent())?;
                if data.format_version != "0.1" || data.entries.len() > RECENT_LIMIT {
                    return Err(invalid_recent());
                }
                Ok(RecentList {
                    revision: document.revision,
                    entries: data.entries,
                })
            }
        }
    }
    pub fn record(&self, entry: RecentConnection) -> HostResult<RecentList> {
        let key = Id::try_from(RECENT_DOCUMENT)?;
        for _ in 0..CAS_ATTEMPTS {
            let mut list = self.list()?;
            if let Some(existing) = list
                .entries
                .iter()
                .find(|old| old.device_id == entry.device_id)
                && recent_time(existing) > recent_time(&entry)
            {
                return Ok(list);
            }
            list.entries.retain(|old| old.device_id != entry.device_id);
            list.entries.push(entry.clone());
            list.entries.sort_by(|a, b| {
                recent_time(b)
                    .cmp(&recent_time(a))
                    .then_with(|| a.device_id.cmp(&b.device_id))
            });
            list.entries.truncate(RECENT_LIMIT);
            let value = serde_json::to_value(RecentDocument {
                format_version: "0.1".into(),
                entries: list.entries.clone(),
            })
            .map_err(|_| invalid_recent())?;
            let value: JsonObject = serde_json::from_value(value).map_err(|_| invalid_recent())?;
            match self
                .store
                .compare_and_swap_document(&key, list.revision, value)
            {
                Ok(saved) => {
                    list.revision = saved.revision;
                    return Ok(list);
                }
                Err(error) if error.code == "REVISION_CONFLICT" => continue,
                Err(error) => return Err(error),
            }
        }
        Err(HostError::new(
            "REVISION_CONFLICT",
            "Recent connections changed repeatedly",
        ))
    }
}
fn recent_time(entry: &RecentConnection) -> chrono::DateTime<chrono::FixedOffset> {
    chrono::DateTime::parse_from_rfc3339(entry.opened_at.as_str()).expect("validated timestamp")
}
fn invalid_recent() -> HostError {
    HostError::new(
        "INVALID_DOCUMENT",
        "Recent connections document is invalid or unsupported",
    )
}
