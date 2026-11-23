use super::windows_stage::read_text;
use serde::Deserialize;
use serial_workbench_core::{Digest, RequestId};
use serial_workbench_ipc::{
    install_switch::{
        InstallOutcome, InstallPaths, InstallRegistration, InstallSwitch, suite_digest,
    },
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
    operation: Option<RequestId>,
    suites: Option<SuiteDigests>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SuiteDigests {
    previous: Digest,
    candidate: Digest,
    registration: Option<RegisteredRelease>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisteredRelease {
    product: String,
    previous_version: String,
    candidate_version: String,
    candidate_kib: u32,
}

pub fn switch_windows_release(input: &Path) -> Result<(), Box<dyn Error>> {
    let request: SwitchRequest = serde_json::from_str(&read_text(input, 64 * 1024)?)?;
    if !request.profile.is_absolute() || !profile_has_host_state(&request.profile)? {
        return Err("Windows suite switching requires the existing Host profile".into());
    }
    let wait = Duration::from_secs(15);
    let Some(operation) = request.operation else {
        if request.suites.is_some() {
            return Err("Replacing a Windows suite requires a staged operation ID".into());
        }
        let reservation = reserve_host_instance(&request.profile.join("host-v0"))?;
        let found = InstallSwitch::recover_pending(
            &request.profile,
            &request.active_install,
            reservation,
            wait,
        )?;
        let (operation, outcome) = found
            .map(|(id, outcome)| (Some(id), Some(outcome)))
            .unwrap_or_default();
        print_receipt(operation.as_ref(), outcome);
        return Ok(());
    };
    let paths = InstallPaths::new(&request.active_install, operation)?;
    let (reservation, registration) = if let Some(suites) = &request.suites {
        if suite_digest(&request.active_install)? != suites.previous
            || suite_digest(paths.staged())? != suites.candidate
        {
            return Err("Windows install suite digests differ from this request".into());
        }
        let registration = suites
            .registration
            .as_ref()
            .map(|release| {
                InstallRegistration::capture(
                    &request.active_install,
                    &release.product,
                    &release.previous_version,
                    &release.candidate_version,
                    release.candidate_kib,
                )
            })
            .transpose()?;
        (
            crate::updater::prepare_windows_suite_switch(&request.profile)?,
            registration,
        )
    } else {
        (
            reserve_host_instance(&request.profile.join("host-v0"))?,
            None,
        )
    };
    let mut switch = InstallSwitch::open(&request.profile, paths.clone(), reservation, wait)?;
    let outcome = if let Some(suites) = request.suites {
        let result = match registration {
            Some(registration) => {
                switch.replace_registered(&suites.previous, &suites.candidate, registration)
            }
            None => switch.replace(&suites.previous, &suites.candidate),
        };
        if let Err(error) = result {
            switch.recover().map_err(|recovery| {
                format!("Windows suite switch failed ({error}) and recovery failed ({recovery})")
            })?;
            return Err(error.into());
        }
        Some(InstallOutcome::Committed)
    } else {
        switch.recover()?
    };
    print_receipt(Some(paths.operation()), outcome);
    Ok(())
}

fn print_receipt(operation: Option<&RequestId>, outcome: Option<InstallOutcome>) {
    let state = match outcome {
        Some(InstallOutcome::Committed) => "committed",
        Some(InstallOutcome::RolledBack) => "rolled_back",
        None => "not_started",
    };
    println!(
        "{}",
        serde_json::json!({
            "operation": operation,
            "state": state,
        })
    );
}
