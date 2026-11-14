use crate::storage::Store;
use serde::{Serialize, de::DeserializeOwned};
use serial_workbench_core::{
    HostError, HostResult, Id, JsonObject, SettingsSnapshot, SharedSettings, U64,
};
#[derive(Clone)]
pub struct SettingsService {
    store: Store,
}
impl SettingsService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }
    fn id() -> Id {
        Id::try_from("settings:shared").expect("settings id")
    }
    pub fn read(&self) -> HostResult<SettingsSnapshot> {
        let (revision, value) = read_document(&self.store, &Self::id())?;
        Ok(SettingsSnapshot { revision, value })
    }
    pub fn save(
        &self,
        expected_revision: U64,
        value: SharedSettings,
    ) -> HostResult<SettingsSnapshot> {
        let (revision, value) = save_document(&self.store, &Self::id(), expected_revision, value)?;
        Ok(SettingsSnapshot { revision, value })
    }
    pub fn export_json(&self) -> HostResult<String> {
        export_document(&self.read()?.value)
    }
    pub fn import_json(&self, expected_revision: U64, json: &str) -> HostResult<SettingsSnapshot> {
        self.save(expected_revision, import_document(json)?)
    }
}
fn invalid() -> HostError {
    HostError::new("INVALID_DOCUMENT", "Invalid shared document")
}
fn check_version(value: &serde_json::Value) -> HostResult<()> {
    let version = value
        .as_object()
        .and_then(|v| v.get("formatVersion"))
        .and_then(|v| v.as_str())
        .ok_or_else(invalid)?;
    let (major, minor) = version.split_once('.').ok_or_else(invalid)?;
    if major.is_empty()
        || minor.is_empty()
        || !major.bytes().all(|b| b.is_ascii_digit())
        || !minor.bytes().all(|b| b.is_ascii_digit())
        || (major.len() > 1 && major.starts_with('0'))
        || (minor.len() > 1 && minor.starts_with('0'))
    {
        return Err(invalid());
    }
    let major: u64 = major.parse().map_err(|_| invalid())?;
    let minor: u64 = minor.parse().map_err(|_| invalid())?;
    if major > 0 || minor > 1 {
        return Err(HostError::new(
            "FUTURE_FORMAT",
            "Document was created by a newer format",
        ));
    }
    if major != 0 || minor != 1 {
        return Err(invalid());
    }
    Ok(())
}
fn decode<T: DeserializeOwned>(json: serde_json::Value) -> HostResult<T> {
    check_version(&json)?;
    let object = json.as_object().ok_or_else(invalid)?;
    if object.len() != 2 || !object.contains_key("value") {
        return Err(invalid());
    }
    serde_json::from_value(object["value"].clone()).map_err(|_| invalid())
}
pub(crate) fn encode<T: Serialize + DeserializeOwned>(value: T) -> HostResult<(JsonObject, T)> {
    let json = serde_json::to_value(value).map_err(|_| invalid())?;
    let value = serde_json::from_value(json.clone()).map_err(|_| invalid())?;
    let envelope = serde_json::json!({"formatVersion": "0.1", "value": json});
    Ok((
        serde_json::from_value(envelope).map_err(|_| invalid())?,
        value,
    ))
}
pub(crate) fn read_document<T: DeserializeOwned + Default>(
    store: &Store,
    id: &Id,
) -> HostResult<(U64, T)> {
    match store.read_document(id)? {
        Some(stored) => Ok((
            stored.revision,
            decode(serde_json::to_value(stored.value).map_err(|_| invalid())?)?,
        )),
        None => Ok((U64::from(0), T::default())),
    }
}
pub(crate) fn save_document<T: Serialize + DeserializeOwned + Default>(
    store: &Store,
    id: &Id,
    expected: U64,
    value: T,
) -> HostResult<(U64, T)> {
    let _ = read_document::<T>(store, id)?;
    let (json, value) = encode(value)?;
    let saved = store.compare_and_swap_document(id, expected, json)?;
    Ok((saved.revision, value))
}
pub(crate) fn export_document<T: Serialize + DeserializeOwned>(value: &T) -> HostResult<String> {
    let json = serde_json::to_value(value).map_err(|_| invalid())?;
    let _: T = serde_json::from_value(json.clone()).map_err(|_| invalid())?;
    serde_json::to_string_pretty(&serde_json::json!({"formatVersion":"0.1", "value":json}))
        .map_err(|_| invalid())
}
pub(crate) fn import_document<T: DeserializeOwned>(json: &str) -> HostResult<T> {
    decode(serde_json::from_str(json).map_err(|_| invalid())?)
}
