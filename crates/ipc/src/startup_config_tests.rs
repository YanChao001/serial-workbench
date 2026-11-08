use super::*;
use serial_workbench_core::{HostError, StartupConfigSource, StartupLogLevel};

fn root() -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(r"C:\controlled")
    }
    #[cfg(unix)]
    {
        PathBuf::from("/controlled")
    }
}

fn resolve_values(profile: Option<&str>, level: Option<&str>) -> HostResult<StartupConfig> {
    resolve_with(
        None,
        |key| match key {
            "SWB_PROFILE" => profile.map(OsString::from),
            "SWB_LOG_LEVEL" => level.map(OsString::from),
            _ => panic!("unexpected environment access"),
        },
        || Ok(root().join("default")),
        || Ok(root()),
    )
}

#[test]
fn explicit_profile_wins_and_never_requires_platform_defaults_or_cwd() {
    let expected = root().join("argument");
    let result = resolve_with(
        Some(expected.clone()),
        |key| match key {
            "SWB_PROFILE" => panic!("overridden environment must not be parsed"),
            "SWB_LOG_LEVEL" => None,
            _ => panic!("unexpected environment access"),
        },
        || panic!("default must be lazy"),
        || panic!("absolute path needs no cwd"),
    )
    .unwrap();
    assert_eq!(result.profile(), expected);
    assert_eq!(
        result.snapshot().profile_source,
        StartupConfigSource::Argument
    );
}

#[test]
fn environment_profile_is_absolute_before_host_launch_without_expanding_variables() {
    let config = resolve_values(Some("$HOME/%PRIVATE%/new-profile"), None).unwrap();
    assert_eq!(config.profile(), root().join("$HOME/%PRIVATE%/new-profile"));
    assert_eq!(
        config.snapshot().profile_source,
        StartupConfigSource::Environment
    );
}

#[test]
fn absent_overrides_select_platform_default_and_info_with_default_sources() {
    let config = resolve_values(None, None).unwrap();
    assert_eq!(config.profile(), root().join("default"));
    let public = serde_json::to_value(config.snapshot()).unwrap();
    assert_eq!(
        public,
        serde_json::json!({
            "profileReference": "host:profile", "profileSource": "default",
            "logLevel": "info", "logLevelSource": "default"
        })
    );
    assert_eq!(config.log_filter(), log::LevelFilter::Info);
}

#[test]
fn every_supported_level_controls_the_runtime_filter() {
    for (value, expected, filter) in [
        ("off", StartupLogLevel::Off, log::LevelFilter::Off),
        ("ERROR", StartupLogLevel::Error, log::LevelFilter::Error),
        ("Warn", StartupLogLevel::Warn, log::LevelFilter::Warn),
        ("info", StartupLogLevel::Info, log::LevelFilter::Info),
        ("DEBUG", StartupLogLevel::Debug, log::LevelFilter::Debug),
        ("trace", StartupLogLevel::Trace, log::LevelFilter::Trace),
    ] {
        let config = resolve_values(None, Some(value)).unwrap();
        assert_eq!(config.snapshot().log_level, expected);
        assert_eq!(
            config.snapshot().log_level_source,
            StartupConfigSource::Environment
        );
        assert_eq!(config.log_filter(), filter);
    }
}

#[test]
fn invalid_log_levels_are_rejected_without_echoing_sensitive_values() {
    for value in [
        "",
        " info",
        "info ",
        "debug,private-secret=trace",
        "private-secret",
    ] {
        let error = resolve_values(None, Some(value)).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("private-secret")
        );
    }
}

#[test]
fn empty_profile_fails_instead_of_falling_back() {
    let error = resolve_values(Some(""), None).unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");
    let error =
        resolve_with(Some(PathBuf::new()), |_| None, || Ok(root()), || Ok(root())).unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");
}

#[test]
fn resolving_first_use_profile_creates_no_directory_or_old_state() {
    let directory = tempfile::tempdir().unwrap();
    let profile = directory.path().join("new-profile");
    let config = resolve_with(
        Some(profile.clone()),
        |_| None,
        || panic!("unused default"),
        || panic!("unused cwd"),
    )
    .unwrap();
    assert_eq!(config.profile(), profile);
    assert!(!profile.exists());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn public_snapshot_contains_no_private_profile_path() {
    let profile = root().join("private-person/private-secret");
    let config = resolve_with(Some(profile), |_| None, || Ok(root()), || Ok(root())).unwrap();
    let encoded = serde_json::to_string(&config.snapshot()).unwrap();
    assert!(!encoded.contains("private-person"));
    assert!(!encoded.contains("private-secret"));
    assert!(encoded.contains("host:profile"));
}

#[test]
fn default_resolution_error_propagates_without_needing_cwd() {
    let error = resolve_with(
        None,
        |_| None,
        || {
            Err(HostError::new(
                "STORAGE_UNAVAILABLE",
                "no platform directory",
            ))
        },
        || panic!("failed default requires no cwd"),
    )
    .unwrap_err();
    assert_eq!(error.code, "STORAGE_UNAVAILABLE");
}

#[test]
fn relative_profile_requires_a_usable_absolute_working_directory() {
    let error = resolve_with(
        Some(PathBuf::from("profile")),
        |_| None,
        || Ok(root()),
        || Err(std::io::Error::other("private-secret")),
    )
    .unwrap_err();
    assert_eq!(error.code, "STORAGE_UNAVAILABLE");
    assert!(!error.message.contains("private-secret"));
    let error = resolve_with(
        Some(PathBuf::from("profile")),
        |_| None,
        || Ok(root()),
        || Ok(PathBuf::from("relative-cwd")),
    )
    .unwrap_err();
    assert_eq!(error.code, "STORAGE_UNAVAILABLE");
}

#[cfg(windows)]
#[test]
fn windows_ambiguous_drive_or_root_relative_profiles_are_rejected() {
    for profile in [r"C:profile", r"\profile"] {
        assert_eq!(
            resolve_values(Some(profile), None).unwrap_err().code,
            "INVALID_ARGUMENT"
        );
    }
}

#[cfg(unix)]
#[test]
fn unix_profile_preserves_non_unicode_os_paths_and_rejects_non_unicode_log_level() {
    use std::os::unix::ffi::OsStringExt;
    let profile = root().join(OsString::from_vec(vec![b'p', 0xff]));
    let config = resolve_with(
        Some(profile.clone()),
        |_| None,
        || Ok(root()),
        || Ok(root()),
    )
    .unwrap();
    assert_eq!(config.profile(), profile);
    let error = resolve_with(
        None,
        |key| (key == "SWB_LOG_LEVEL").then(|| OsString::from_vec(vec![0xff])),
        || Ok(root()),
        || Ok(root()),
    )
    .unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");
}

#[cfg(windows)]
#[test]
fn windows_profile_preserves_non_unicode_os_paths_and_rejects_non_unicode_log_level() {
    use std::os::windows::ffi::OsStringExt;
    let profile = root().join(OsString::from_wide(&[b'p' as u16, 0xd800]));
    let config = resolve_with(
        Some(profile.clone()),
        |_| None,
        || Ok(root()),
        || Ok(root()),
    )
    .unwrap();
    assert_eq!(config.profile(), profile);
    let error = resolve_with(
        None,
        |key| (key == "SWB_LOG_LEVEL").then(|| OsString::from_wide(&[0xd800])),
        || Ok(root()),
        || Ok(root()),
    )
    .unwrap_err();
    assert_eq!(error.code, "INVALID_ARGUMENT");
}

#[test]
fn nul_profile_cannot_reach_later_filesystem_calls() {
    assert_eq!(
        resolve_values(Some("private-secret\0profile"), None)
            .unwrap_err()
            .code,
        "INVALID_ARGUMENT"
    );
}
