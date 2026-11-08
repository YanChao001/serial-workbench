use crate::error::{ErrorCode, NativeError, NativeResult};
use serde::{Deserialize, Serialize};
use serial_workbench_core::U64;
use specta::Type;
use std::{collections::BTreeMap, path::PathBuf};

pub const CLIENT_STATE_FILE: &str = "client-state-v0.json";
pub const MAX_CLIENT_STATE_FILE_SIZE: usize = 512 * 1024;
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum WindowPosition {
    #[default]
    Remember,
    Center,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientPreferences {
    pub menu_bar: bool,
    pub window_position: WindowPosition,
    pub sidebar_collapsed: bool,
    pub sidebar_width: u16,
}
impl Default for ClientPreferences {
    fn default() -> Self {
        Self {
            menu_bar: true,
            window_position: WindowPosition::Remember,
            sidebar_collapsed: false,
            sidebar_width: 224,
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GalleryEntry {
    pub reference: serial_workbench_core::ObjectRef,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientWindowState {
    pub preferences: ClientPreferences,
    pub current_page: String,
    pub focused_panel_id: Option<String>,
    pub scroll_offset: u32,
    pub follow: bool,
    pub last_workspace_id: Option<String>,
    pub drafts: BTreeMap<String, String>,
    #[serde(default)]
    pub gallery: Vec<GalleryEntry>,
}
impl Default for ClientWindowState {
    fn default() -> Self {
        Self {
            preferences: ClientPreferences::default(),
            current_page: "workbench".into(),
            focused_panel_id: None,
            scroll_offset: 0,
            follow: true,
            last_workspace_id: None,
            drafts: BTreeMap::new(),
            gallery: Vec::new(),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientStateSnapshot {
    pub format_version: String,
    pub revision: U64,
    pub state: ClientWindowState,
}
impl Default for ClientStateSnapshot {
    fn default() -> Self {
        Self {
            format_version: "0.1".into(),
            revision: 0.into(),
            state: ClientWindowState::default(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClientStateDocument {
    format_version: String,
    windows: BTreeMap<String, ClientStateSnapshot>,
}
impl Default for ClientStateDocument {
    fn default() -> Self {
        Self {
            format_version: "0.1".into(),
            windows: ["main", "secondary"]
                .into_iter()
                .map(|label| (label.into(), ClientStateSnapshot::default()))
                .collect(),
        }
    }
}
pub struct ClientStateStore {
    path: PathBuf,
    writing: std::sync::Mutex<()>,
}
fn corrupt(message: &str) -> NativeError {
    NativeError::new(ErrorCode::StorageCorrupt, message)
}
fn validate_state(state: &ClientWindowState) -> NativeResult<()> {
    use crate::error::bounded_text;
    if !(180..=360).contains(&state.preferences.sidebar_width)
        || !matches!(
            state.current_page.as_str(),
            "workbench" | "settings" | "diagnostics" | "recovery"
        )
        || state.focused_panel_id.as_deref().is_some_and(|id| {
            !matches!(
                id,
                "devices" | "terminal" | "send" | "capture" | "tasks" | "activity"
            )
        })
    {
        return Err(NativeError::new(
            ErrorCode::InvalidArgument,
            "Invalid client window preferences",
        ));
    }
    if let Some(id) = &state.last_workspace_id {
        bounded_text(id, 128, "Workspace identity")?;
    }
    if state.gallery.len() > 24 {
        return Err(NativeError::new(
            ErrorCode::InputTooLong,
            "Too many gallery entries",
        ));
    }
    let mut references = std::collections::BTreeSet::new();
    for entry in &state.gallery {
        if entry.name.trim().is_empty()
            || entry.name.chars().count() > 120
            || entry.name.chars().any(char::is_control)
            || entry.reference.kind.as_str() != "file"
            || entry.reference.revision.is_none()
            || !references.insert((&entry.reference.host_id, &entry.reference.id))
        {
            return Err(NativeError::new(
                ErrorCode::InvalidArgument,
                "Invalid gallery entry",
            ));
        }
    }
    if state.drafts.len() > 128 {
        return Err(NativeError::new(
            ErrorCode::InputTooLong,
            "Too many client drafts",
        ));
    }
    for (id, text) in &state.drafts {
        bounded_text(id, 128, "Draft identity")?;
        if id.is_empty() || id.chars().any(char::is_control) {
            return Err(NativeError::new(
                ErrorCode::InvalidArgument,
                "Invalid draft identity",
            ));
        }
        bounded_text(text, 65536, "Draft text")?;
    }
    Ok(())
}
pub(crate) fn future_client_format(value: &serde_json::Value) -> bool {
    let unsupported_version = |document: &serde_json::Value| {
        document
            .get("formatVersion")
            .is_some_and(|version| version.as_str() != Some("0.1"))
    };
    unsupported_version(value)
        || value
            .get("windows")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|windows| windows.values().any(unsupported_version))
}
pub(crate) fn read_document(path: &std::path::Path) -> NativeResult<ClientStateDocument> {
    use std::io::Read;
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_symlink() || !metadata.is_file() => {
            return Err(corrupt("Client state must be a regular file"));
        }
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ClientStateDocument::default());
        }
        Err(error) => {
            return Err(NativeError::operation(
                ErrorCode::StorageIo,
                "Cannot inspect client state",
                error,
            ));
        }
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| {
            file.take((MAX_CLIENT_STATE_FILE_SIZE + 1) as u64)
                .read_to_end(&mut bytes)
        })
        .map_err(|error| {
            NativeError::operation(ErrorCode::StorageIo, "Cannot read client state", error)
        })?;
    if bytes.len() > MAX_CLIENT_STATE_FILE_SIZE {
        return Err(corrupt("Client state exceeds the supported size"));
    }
    let document: ClientStateDocument = serde_json::from_slice(&bytes)
        .map_err(|_| corrupt("Invalid or unsupported client state"))?;
    if document.format_version != "0.1" || document.windows.len() != 2 {
        return Err(corrupt("Unsupported client state format"));
    }
    for label in ["main", "secondary"] {
        let window = document
            .windows
            .get(label)
            .ok_or_else(|| corrupt("Missing client window state"))?;
        if window.format_version != "0.1" || validate_state(&window.state).is_err() {
            return Err(corrupt("Invalid client window state"));
        }
    }
    Ok(document)
}
impl ClientStateStore {
    pub fn open(path: PathBuf) -> NativeResult<Self> {
        read_document(&path)?;
        Ok(Self {
            path,
            writing: std::sync::Mutex::new(()),
        })
    }
    pub fn snapshot(&self, label: &str) -> NativeResult<ClientStateSnapshot> {
        crate::commands::require_host_window(label)?;
        Ok(read_document(&self.path)?
            .windows
            .remove(label)
            .expect("validated window"))
    }
    pub fn save(
        &self,
        label: &str,
        state: ClientWindowState,
        expected: U64,
    ) -> NativeResult<ClientStateSnapshot> {
        crate::commands::require_host_window(label)?;
        validate_state(&state)?;
        let _writing = self.writing.lock().map_err(|_| {
            NativeError::new(ErrorCode::Internal, "Client state writer is unavailable")
        })?;
        let mut document = read_document(&self.path)?;
        let current = document.windows.get(label).expect("validated window");
        if current.revision != expected {
            return Err(NativeError {
                code: ErrorCode::Conflict,
                message: "Client window state changed; reload before saving".into(),
                retryable: true,
            });
        }
        let revision = current.revision.get().checked_add(1).ok_or_else(|| {
            NativeError::new(ErrorCode::StorageIo, "Client state revision exhausted")
        })?;
        let next = ClientStateSnapshot {
            format_version: "0.1".into(),
            revision: revision.into(),
            state,
        };
        document.windows.insert(label.into(), next.clone());
        let bytes = serde_json::to_vec(&document).map_err(|error| {
            NativeError::operation(ErrorCode::StorageIo, "Cannot encode client state", error)
        })?;
        if bytes.len() > MAX_CLIENT_STATE_FILE_SIZE {
            return Err(NativeError::new(
                ErrorCode::InputTooLong,
                "Client state exceeds the supported size",
            ));
        }
        crate::storage::atomic_write(&self.path, &bytes)?;
        Ok(next)
    }
    pub fn window_position(&self, label: &str) -> WindowPosition {
        self.snapshot(label)
            .map_or(WindowPosition::default(), |snapshot| {
                snapshot.state.preferences.window_position
            })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn drafts_roundtrip_without_reading_or_changing_legacy_shared_settings() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("settings.json");
        fs::write(&legacy, b"broken v7 user original").unwrap();
        let path = dir.path().join(CLIENT_STATE_FILE);
        let store = ClientStateStore::open(path.clone()).unwrap();
        let mut state = store.snapshot("main").unwrap().state;
        state
            .drafts
            .insert("view-1".into(), "unsent AT+RESET".into());
        let saved = store.save("main", state, 0.into()).unwrap();
        assert_eq!(saved.revision, 1.into());
        assert_eq!(
            ClientStateStore::open(path)
                .unwrap()
                .snapshot("main")
                .unwrap(),
            saved
        );
        assert_eq!(fs::read(legacy).unwrap(), b"broken v7 user original");
    }
    #[test]
    fn independent_windows_and_separately_opened_stores_enforce_revision_cas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CLIENT_STATE_FILE);
        let a = ClientStateStore::open(path.clone()).unwrap();
        let b = ClientStateStore::open(path).unwrap();
        let mut state = ClientWindowState::default();
        state.preferences.sidebar_collapsed = true;
        a.save("main", state.clone(), 0.into()).unwrap();
        assert_eq!(
            b.save("main", state.clone(), 0.into()).unwrap_err().code,
            ErrorCode::Conflict
        );
        b.save("secondary", state, 0.into()).unwrap();
        assert_eq!(a.snapshot("secondary").unwrap().revision, 1.into());
        assert_eq!(a.snapshot("main").unwrap().revision, 1.into());
        assert_eq!(
            a.snapshot("../../other").unwrap_err().code,
            ErrorCode::PlatformUnavailable
        );
    }
    #[test]
    fn bad_future_unknown_and_external_replacement_remain_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CLIENT_STATE_FILE);
        let store = ClientStateStore::open(path.clone()).unwrap();
        for bytes in [
            b"broken".as_slice(),
            br#"{"formatVersion":"9.0","windows":{}}"#,
            br#"{"formatVersion":"0.1","windows":{},"unknown":true}"#,
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(ClientStateStore::open(path.clone()).is_err());
            assert!(
                store
                    .save("main", ClientWindowState::default(), 0.into())
                    .is_err()
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
    #[test]
    fn failed_atomic_commit_keeps_original_and_does_not_publish_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CLIENT_STATE_FILE);
        let store = ClientStateStore::open(path.clone()).unwrap();
        store
            .save("main", ClientWindowState::default(), 0.into())
            .unwrap();
        let original = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        fs::write(path.join("evidence"), &original).unwrap();
        assert!(
            store
                .save("main", ClientWindowState::default(), 1.into())
                .is_err()
        );
        assert_eq!(fs::read(path.join("evidence")).unwrap(), original);
    }
    #[cfg(windows)]
    #[test]
    fn atomic_replace_failure_preserves_last_committed_window_and_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CLIENT_STATE_FILE);
        let store = ClientStateStore::open(path.clone()).unwrap();
        let saved = store
            .save("main", ClientWindowState::default(), 0.into())
            .unwrap();
        let original = fs::read(&path).unwrap();
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        let mut next = saved.state.clone();
        next.drafts.insert("view-1".into(), "unsent change".into());
        let result = store.save("main", next, 1.into());
        fs::set_permissions(&path, original_permissions).unwrap();
        assert_eq!(result.unwrap_err().code, ErrorCode::StorageIo);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(store.snapshot("main").unwrap(), saved);
    }
    #[test]
    fn concurrent_saves_of_one_window_commit_exactly_one_revision() {
        let directory = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(
            ClientStateStore::open(directory.path().join(CLIENT_STATE_FILE)).unwrap(),
        );
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let tasks: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|text| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut state = ClientWindowState::default();
                    state.drafts.insert("view-1".into(), text.into());
                    barrier.wait();
                    store.save("main", state, 0.into())
                })
            })
            .collect();
        let results: Vec<_> = tasks.into_iter().map(|task| task.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter_map(|result| result.as_ref().err())
                .next()
                .unwrap()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(store.snapshot("main").unwrap().revision, 1.into());
        assert_eq!(store.snapshot("secondary").unwrap().revision, 0.into());
    }
    #[test]
    fn oversized_drafts_and_invalid_preferences_never_create_storage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(CLIENT_STATE_FILE);
        let store = ClientStateStore::open(path.clone()).unwrap();
        let mut state = ClientWindowState::default();
        state.drafts.insert("view-1".into(), "x".repeat(65537));
        assert_eq!(
            store.save("main", state, 0.into()).unwrap_err().code,
            ErrorCode::InputTooLong
        );
        let mut state = ClientWindowState::default();
        state.preferences.sidebar_width = 1;
        assert_eq!(
            store.save("main", state, 0.into()).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
        assert!(!path.exists());
    }
}

pub fn export_defaults(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&ClientWindowState::default())?,
    )?;
    Ok(())
}

#[cfg(test)]
mod gallery_tests {
    use super::*;
    use serde_json::json;
    use serial_workbench_core::{Id, ObjectRef, ResourceKind};
    use std::fs;

    fn entry(index: usize, name: &str) -> GalleryEntry {
        GalleryEntry {
            reference: ObjectRef {
                host_id: Id::try_from("local-host").unwrap(),
                kind: ResourceKind::try_from("file").unwrap(),
                id: Id::try_from(format!("image-{index}").as_str()).unwrap(),
                revision: Some(1.into()),
            },
            name: name.into(),
        }
    }
    #[test]
    fn gallery_metadata_serializes_and_absent_unreleased_field_defaults_empty() {
        let mut state = ClientWindowState::default();
        state.gallery.push(entry(0, "Photo"));
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value.pointer("/gallery/0/name"), Some(&json!("Photo")));
        assert_eq!(
            value.pointer("/gallery/0/reference/kind"),
            Some(&json!("file"))
        );
        let restored: ClientWindowState = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(restored.gallery, state.gallery);
        let mut before_gallery = value;
        before_gallery.as_object_mut().unwrap().remove("gallery");
        assert!(
            serde_json::from_value::<ClientWindowState>(before_gallery)
                .unwrap()
                .gallery
                .is_empty()
        );
    }
    #[test]
    fn gallery_save_rename_delete_are_window_local_and_keep_host_object_and_drafts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CLIENT_STATE_FILE);
        let object = directory.path().join("host-owned-media");
        fs::write(&object, b"Host object bytes").unwrap();
        let legacy = directory.path().join("wallpapers.json");
        fs::write(&legacy, b"legacy library original").unwrap();
        let store = ClientStateStore::open(path.clone()).unwrap();
        let mut main = ClientWindowState::default();
        main.gallery.push(entry(0, "Photo"));
        main.drafts.insert("view-1".into(), "unsent".into());
        store.save("main", main, 0.into()).unwrap();
        let mut secondary = ClientWindowState::default();
        secondary.gallery.push(entry(0, "Other window"));
        store.save("secondary", secondary, 0.into()).unwrap();
        let reopened = ClientStateStore::open(path).unwrap();
        let mut main = reopened.snapshot("main").unwrap().state;
        assert_eq!(main.gallery.len(), 1, "saved gallery must survive reopen");
        assert_eq!(main.gallery[0].name, "Photo");
        assert_eq!(
            reopened.snapshot("secondary").unwrap().state.gallery[0].name,
            "Other window"
        );
        main.gallery[0].name = "Renamed".into();
        reopened.save("main", main.clone(), 1.into()).unwrap();
        assert_eq!(
            reopened.snapshot("main").unwrap().state.gallery[0].name,
            "Renamed"
        );
        main.gallery.clear();
        reopened.save("main", main, 2.into()).unwrap();
        let saved = reopened.snapshot("main").unwrap();
        assert!(saved.state.gallery.is_empty());
        assert_eq!(saved.state.drafts["view-1"], "unsent");
        assert_eq!(
            reopened.snapshot("secondary").unwrap().state.gallery[0].name,
            "Other window"
        );
        assert_eq!(fs::read(object).unwrap(), b"Host object bytes");
        assert_eq!(fs::read(legacy).unwrap(), b"legacy library original");
    }
    #[test]
    fn gallery_over_capacity_never_replaces_successful_archive() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CLIENT_STATE_FILE);
        let store = ClientStateStore::open(path.clone()).unwrap();
        let mut state = ClientWindowState {
            gallery: (0..24)
                .map(|index| entry(index, "Same allowed name"))
                .collect(),
            ..ClientWindowState::default()
        };
        store.save("main", state.clone(), 0.into()).unwrap();
        let original = fs::read(&path).unwrap();
        state.gallery.push(entry(24, "Too many"));
        assert_eq!(
            store.save("main", state, 1.into()).unwrap_err().code,
            ErrorCode::InputTooLong
        );
        assert_eq!(fs::read(path).unwrap(), original);
    }
    #[test]
    fn gallery_invalid_names_non_media_refs_and_duplicate_objects_are_rejected() {
        let mut invalid = Vec::new();
        for name in [
            "".to_owned(),
            "  ".to_owned(),
            "bad\nname".to_owned(),
            "x".repeat(121),
        ] {
            invalid.push(vec![entry(0, &name)]);
        }
        let mut non_media = entry(0, "Session");
        non_media.reference.kind = ResourceKind::try_from("session").unwrap();
        invalid.push(vec![non_media]);
        let mut unversioned = entry(0, "Unversioned");
        unversioned.reference.revision = None;
        invalid.push(vec![unversioned]);
        invalid.push(vec![entry(0, "One"), entry(0, "Two")]);
        for gallery in invalid {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(CLIENT_STATE_FILE);
            let store = ClientStateStore::open(path.clone()).unwrap();
            let state = ClientWindowState {
                gallery,
                ..ClientWindowState::default()
            };
            assert_eq!(
                store.save("main", state, 0.into()).unwrap_err().code,
                ErrorCode::InvalidArgument
            );
            assert!(!path.exists());
        }
    }
    #[test]
    fn gallery_unknown_fields_preserve_the_original_archive() {
        for extra in [
            json!({"dataUrl":"data:image/png;base64,AAAA"}),
            json!({"path":"C:/private.png"}),
            json!({"bytes":[1,2]}),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join(CLIENT_STATE_FILE);
            let store = ClientStateStore::open(path.clone()).unwrap();
            store
                .save("main", ClientWindowState::default(), 0.into())
                .unwrap();
            let mut document: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            let mut value = serde_json::to_value(entry(0, "Photo")).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            document["windows"]["main"]["state"]["gallery"] = json!([value]);
            let original = serde_json::to_vec(&document).unwrap();
            fs::write(&path, &original).unwrap();
            assert!(ClientStateStore::open(path.clone()).is_err());
            assert!(
                store
                    .save("main", ClientWindowState::default(), 1.into())
                    .is_err()
            );
            assert_eq!(fs::read(path).unwrap(), original);
        }
    }
    #[test]
    fn gallery_and_drafts_share_the_existing_document_byte_budget() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CLIENT_STATE_FILE);
        let store = ClientStateStore::open(path.clone()).unwrap();
        let state = ClientWindowState {
            gallery: (0..24).map(|index| entry(index, "Photo")).collect(),
            drafts: (0..8)
                .map(|index| (format!("view-{index}"), "x".repeat(65536)))
                .collect(),
            ..ClientWindowState::default()
        };
        assert_eq!(
            store.save("main", state, 0.into()).unwrap_err().code,
            ErrorCode::InputTooLong
        );
        assert!(!path.exists());
    }
}
