use super::windows_stage::read_text;
use serde::Deserialize;
use serial_workbench_core::{Digest, RequestId};
use serial_workbench_ipc::{
    install_switch::{InstallOutcome, InstallPaths, InstallSwitch, suite_digest},
    profile_has_host_state, reserve_host_instance,
};
use std::{
    error::Error,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SwitchRequest {
    profile: PathBuf,
    active_install: PathBuf,
    operation: RequestId,
    suites: Option<SuiteDigests>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SuiteDigests {
    previous: Digest,
    candidate: Digest,
}

pub fn switch_windows_release(input: &Path) -> Result<(), Box<dyn Error>> {
    let request: SwitchRequest = serde_json::from_str(&read_text(input, 64 * 1024)?)?;
    let paths = InstallPaths::new(&request.active_install, request.operation)?;
    if !request.profile.is_absolute() || !profile_has_host_state(&request.profile)? {
        return Err("Windows suite switching requires the existing Host profile".into());
    }
    let reservation = if let Some(suites) = &request.suites {
        if suite_digest(&request.active_install)? != suites.previous
            || suite_digest(paths.staged())? != suites.candidate
        {
            return Err("Windows install suite digests differ from this request".into());
        }
        crate::updater::prepare_windows_suite_switch(&request.profile)?
    } else {
        reserve_host_instance(&request.profile.join("host-v0"))?
    };
    let mut switch = InstallSwitch::open(
        &request.profile,
        paths.clone(),
        reservation,
        Duration::from_secs(15),
    )?;
    let outcome = if let Some(suites) = request.suites {
        if let Err(error) = switch.replace(&suites.previous, &suites.candidate) {
            switch.recover().map_err(|recovery| {
                format!("Windows suite switch failed ({error}) and recovery failed ({recovery})")
            })?;
            return Err(error.into());
        }
        Some(InstallOutcome::Committed)
    } else {
        switch.recover()?
    };
    let state = match outcome {
        Some(InstallOutcome::Committed) => "committed",
        Some(InstallOutcome::RolledBack) => "rolled_back",
        None => "not_started",
    };
    println!(
        "{}",
        serde_json::json!({
            "operation": paths.operation(),
            "state": state,
        })
    );
    Ok(())
}
