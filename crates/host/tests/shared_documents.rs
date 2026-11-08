use serial_workbench_core::{DurationMs, Id, Language, Theme, U64};
use serial_workbench_host::{
    settings::SettingsService, storage::Store, workspace::WorkspaceService,
};

#[test]
fn empty_store_supplies_shared_defaults_without_creating_a_document() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let settings = SettingsService::new(store.clone()).read().unwrap();
    assert_eq!(settings.revision, U64::from(0));
    assert_eq!(settings.value.theme, Theme::Dark);
    assert_eq!(settings.value.language, Language::Zh);
    assert!(settings.value.auto_check_updates);
    assert!(
        store
            .read_document(&Id::try_from("settings:shared").unwrap())
            .unwrap()
            .is_none()
    );
}

#[test]
fn stale_settings_save_cannot_overwrite_another_client() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let first = SettingsService::new(store.clone());
    let second = SettingsService::new(store);
    let a = first.read().unwrap();
    let b = second.read().unwrap();
    let mut updated = a.value;
    updated.run_in_background = true;
    first.save(a.revision, updated).unwrap();
    assert_eq!(
        second.save(b.revision, b.value).unwrap_err().code,
        "REVISION_CONFLICT"
    );
    assert!(second.read().unwrap().value.run_in_background);
}

#[test]
fn unknown_document_fields_are_preserved_and_cannot_be_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let service = SettingsService::new(store.clone());
    let initial = service.read().unwrap();
    service
        .save(initial.revision, initial.value.clone())
        .unwrap();
    let id = Id::try_from("settings:shared").unwrap();
    let mut stored = store.read_document(&id).unwrap().unwrap();
    stored.value.insert(
        "futureField".into(),
        serial_workbench_core::JsonValue::Bool(true),
    );
    let saved = store
        .compare_and_swap_document(&id, stored.revision, stored.value)
        .unwrap();
    assert!(service.read().is_err());
    assert!(service.save(saved.revision, initial.value).is_err());
    assert_eq!(store.read_document(&id).unwrap().unwrap(), saved);
    assert_eq!(saved.revision, U64::from(2));
}

#[test]
fn future_settings_are_rejected_without_replacing_original() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let service = SettingsService::new(store.clone());
    let original = service.read().unwrap();
    let id = Id::try_from("settings:shared").unwrap();
    let future = serde_json::from_value(serde_json::json!({
        "formatVersion": "99.0",
        "value": {"someFutureSetting": true}
    }))
    .unwrap();
    let stored = store
        .compare_and_swap_document(&id, U64::from(0), future)
        .unwrap();
    assert_eq!(service.read().unwrap_err().code, "FUTURE_FORMAT");
    assert_eq!(
        service
            .save(stored.revision, original.value)
            .unwrap_err()
            .code,
        "FUTURE_FORMAT"
    );
    assert_eq!(store.read_document(&id).unwrap().unwrap(), stored);
}

#[test]
fn workspace_revisions_are_independent_and_stale_save_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let first = WorkspaceService::new(store.clone(), Id::try_from("first").unwrap());
    let second = WorkspaceService::new(store, Id::try_from("second").unwrap());
    let original = first.read().unwrap();
    let saved = first
        .save(original.revision, original.value.clone())
        .unwrap();
    assert_eq!(saved.revision, U64::from(1));
    assert_eq!(
        first
            .save(original.revision, original.value)
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(second.read().unwrap().revision, U64::from(0));
}

#[test]
fn settings_json_round_trip_is_stable_and_invalid_import_preserves_document() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let service = SettingsService::new(store);
    let first = service.read().unwrap();
    let saved = service.save(first.revision, first.value).unwrap();
    let json = service.export_json().unwrap();
    let imported = service.import_json(saved.revision, &json).unwrap();
    assert_eq!(service.export_json().unwrap(), json);
    assert!(service.import_json(imported.revision, "{bad json").is_err());
    assert!(
        service
            .import_json(imported.revision, r#"{"formatVersion":"2.0","value":{}}"#)
            .is_err()
    );
    assert_eq!(service.export_json().unwrap(), json);
    assert_eq!(service.read().unwrap().revision, imported.revision);
}

#[test]
fn workspace_json_round_trip_preserves_template() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let workspace = WorkspaceService::new(store, Id::try_from("lab").unwrap());
    let initial = workspace.read().unwrap();
    let saved = workspace.save(initial.revision, initial.value).unwrap();
    let json = workspace.export_json().unwrap();
    let imported = workspace.import_json(saved.revision, &json).unwrap();
    assert_eq!(workspace.export_json().unwrap(), json);
    assert_eq!(workspace.read().unwrap(), imported);
}

fn binding() -> serial_workbench_core::DeviceBinding {
    use serial_workbench_core::*;
    DeviceBinding {
        binding_id: Id::try_from("binding").unwrap(),
        host_id: Id::try_from("host").unwrap(),
        device_id: Id::try_from("device").unwrap(),
        fingerprint: DeviceFingerprint {
            transport: DeviceTransportKind::Virtual,
            vid: None,
            pid: None,
            serial_number: None,
            topology_path: None,
            evidence: IdentityEvidence::Unreliable,
        },
        configuration: SerialConfiguration::default(),
        reconnect: ReconnectPolicy::default(),
    }
}
fn view() -> serial_workbench_core::WorkspaceView {
    use serial_workbench_core::*;
    WorkspaceView {
        id: Id::try_from("view").unwrap(),
        name: "View".into(),
        color: "blue".into(),
        icon: "terminal".into(),
        pinned: false,
        receive_mode: TerminalMode::Text,
        send_mode: TerminalMode::Hex,
        binding_id: Id::try_from("binding").unwrap(),
    }
}
#[test]
fn workspace_rejects_invalid_references_and_reconnect_policy_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let workspace = WorkspaceService::new(store, Id::try_from("lab").unwrap());
    let initial = workspace.read().unwrap();
    let mut valid = initial.value.clone();
    valid.bindings.push(binding());
    valid.views.push(view());
    valid
        .favorite_binding_ids
        .push(Id::try_from("binding").unwrap());
    let saved = workspace.save(initial.revision, valid.clone()).unwrap();
    let mut invalid = Vec::new();
    let mut dangling_view = valid.clone();
    dangling_view.views[0].binding_id = Id::try_from("missing").unwrap();
    invalid.push(dangling_view);
    let mut duplicate_view = valid.clone();
    duplicate_view.views.push(view());
    invalid.push(duplicate_view);
    let mut duplicate_binding = valid.clone();
    duplicate_binding.bindings.push(binding());
    invalid.push(duplicate_binding);
    let mut dangling_favorite = valid.clone();
    dangling_favorite
        .favorite_binding_ids
        .push(Id::try_from("missing").unwrap());
    invalid.push(dangling_favorite);
    let mut duplicate_favorite = valid.clone();
    duplicate_favorite
        .favorite_binding_ids
        .push(Id::try_from("binding").unwrap());
    invalid.push(duplicate_favorite);
    let mut invalid_reconnect = valid.clone();
    invalid_reconnect.bindings[0].reconnect.enabled = true;
    invalid_reconnect.bindings[0].reconnect.max_delay_ms =
        DurationMs::try_from(U64::from(1)).unwrap();
    invalid.push(invalid_reconnect);
    for candidate in invalid {
        assert_eq!(
            workspace
                .save(saved.revision, candidate.clone())
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
        let json = serde_json::json!({"formatVersion":"0.1","value":candidate}).to_string();
        assert!(workspace.import_json(saved.revision, &json).is_err());
        assert_eq!(workspace.read().unwrap(), saved);
    }
}
#[test]
fn workspace_read_rejects_invalid_stored_references_without_replacing_them() {
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let workspace = WorkspaceService::new(store.clone(), Id::try_from("lab").unwrap());
    let mut invalid = workspace.read().unwrap().value;
    invalid.views.push(view());
    let id = Id::try_from(format!("workspace:{:x}", Sha256::digest(b"lab")).as_str()).unwrap();
    let document =
        serde_json::from_value(serde_json::json!({"formatVersion":"0.1","value":invalid})).unwrap();
    let stored = store
        .compare_and_swap_document(&id, U64::from(0), document)
        .unwrap();
    assert!(workspace.read().is_err());
    assert!(workspace.save(stored.revision, Default::default()).is_err());
    assert_eq!(store.read_document(&id).unwrap().unwrap(), stored);
}

#[test]
fn background_variants_parse_and_reject_unknown_fields() {
    use serial_workbench_core::BackgroundSelection;
    let valid = [
        serde_json::json!({"kind":"preset","value":"aurora"}),
        serde_json::json!({"kind":"bundled","id":"wallpaper:001"}),
        serde_json::json!({"kind":"media","reference":{"hostId":"host","kind":"file","id":"media"},"fit":"cover"}),
    ];
    for input in valid {
        let parsed: BackgroundSelection = serde_json::from_value(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), input);
        let mut invalid = input;
        invalid
            .as_object_mut()
            .unwrap()
            .insert("unexpected".into(), serde_json::json!(true));
        assert!(serde_json::from_value::<BackgroundSelection>(invalid).is_err());
    }
    assert!(serde_json::from_value::<BackgroundSelection>(serde_json::json!({"kind":"media","reference":{"hostId":"host","kind":"file","id":"media"},"fit":"stretch"})).is_err());
}

#[test]
fn settings_background_default_is_plain_and_old_custom_background_is_rejected() {
    use serial_workbench_core::SharedSettings;
    let mut json = serde_json::to_value(SharedSettings::default()).unwrap();
    assert_eq!(
        json["background"],
        serde_json::json!({"kind":"preset","value":"plain"})
    );
    json.as_object_mut().unwrap().insert(
        "customBackground".into(),
        serde_json::json!({"hostId":"host","kind":"file","id":"old"}),
    );
    assert!(serde_json::from_value::<SharedSettings>(json).is_err());
}

#[test]
fn settings_service_persists_each_background_selection() {
    use serial_workbench_core::{BackgroundSelection, SharedSettings};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path()).unwrap();
    let service = SettingsService::new(store);
    let mut revision = service.read().unwrap().revision;
    for background in [
        serde_json::json!({"kind":"preset","value":"dune"}),
        serde_json::json!({"kind":"bundled","id":"wallpaper:001"}),
        serde_json::json!({"kind":"media","reference":{"hostId":"host","kind":"file","id":"media"},"fit":"contain"}),
    ] {
        let settings = SharedSettings {
            background: serde_json::from_value::<BackgroundSelection>(background.clone()).unwrap(),
            ..SharedSettings::default()
        };
        let saved = service.save(revision, settings).unwrap();
        revision = saved.revision;
        assert_eq!(
            serde_json::to_value(service.read().unwrap().value).unwrap()["background"],
            background
        );
    }
}
