#[cfg(feature = "bindings")]
use super::windows_stage::read_text;
use serde::{Deserialize, Serialize};
use serial_workbench_core::{Digest, RequestId, U64};
use serial_workbench_ipc::{
    InstalledProcess,
    install_switch::{InstallPaths, InstallRegistration, InstallSwitch, suite_digest},
    profile_has_host_state,
};
#[cfg(feature = "bindings")]
use serial_workbench_ipc::{install_switch::InstallOutcome, reserve_host_instance};
use std::{
    error::Error,
    path::{Component, Path, PathBuf},
    time::Duration,
};

#[cfg(feature = "bindings")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SwitchRequest {
    profile: PathBuf,
    active_install: PathBuf,
    operation: Option<RequestId>,
    suites: Option<SuiteDigests>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SuiteDigests {
    pub previous: Digest,
    pub candidate: Digest,
    pub registration: Option<RegisteredRelease>,
    pub desktop: Option<DesktopExit>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopExit {
    pub pid: u32,
    pub created: U64,
    pub image: PathBuf,
}

impl DesktopExit {
    fn observe(&self, active: &Path) -> Result<InstalledProcess, Box<dyn Error>> {
        if self.image.as_os_str().is_empty()
            || !self
                .image
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("The desktop image must be relative to the active install".into());
        }
        Ok(InstalledProcess::observe(
            self.pid,
            self.created.get(),
            &active.join(&self.image),
        )?)
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RegisteredRelease {
    pub product: String,
    pub previous_version: String,
    pub candidate_version: String,
    pub candidate_kib: u32,
}

const WAIT: Duration = Duration::from_secs(15);

pub(crate) enum SwitchPhase {
    Ready,
    Recovered,
}

pub(crate) fn replace_windows_suite(
    profile: &Path,
    active: &Path,
    operation: &RequestId,
    suites: &SuiteDigests,
    mut on_phase: impl FnMut(SwitchPhase) -> std::io::Result<()>,
) -> Result<(), Box<dyn Error>> {
    if !profile.is_absolute() || !profile_has_host_state(profile)? {
        return Err("Windows suite switching requires the existing Host profile".into());
    }
    let paths = InstallPaths::new(active, operation.clone())?;
    if suite_digest(active)? != suites.previous || suite_digest(paths.staged())? != suites.candidate
    {
        return Err("Windows install suite digests differ from this request".into());
    }
    let desktop = suites
        .desktop
        .as_ref()
        .map(|desktop| desktop.observe(active))
        .transpose()?;
    let registration = suites
        .registration
        .as_ref()
        .map(|release| {
            InstallRegistration::capture(
                active,
                &release.product,
                &release.previous_version,
                &release.candidate_version,
                release.candidate_kib,
            )
        })
        .transpose()?;
    let reservation = crate::updater::prepare_windows_suite_switch(profile)?;
    let mut switch = InstallSwitch::open(profile, paths, reservation, WAIT)?;
    on_phase(SwitchPhase::Ready)?;
    if let Some(desktop) = desktop {
        desktop.wait_for_clean_exit(WAIT)?;
    }
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
        on_phase(SwitchPhase::Recovered)?;
        return Err(error.into());
    }
    Ok(())
}

#[cfg(feature = "bindings")]
pub fn switch_windows_release(input: &Path) -> Result<(), Box<dyn Error>> {
    let request: SwitchRequest = serde_json::from_str(&read_text(input, 64 * 1024)?)?;
    if !request.profile.is_absolute() || !profile_has_host_state(&request.profile)? {
        return Err("Windows suite switching requires the existing Host profile".into());
    }
    let Some(operation) = request.operation else {
        if request.suites.is_some() {
            return Err("Replacing a Windows suite requires a staged operation ID".into());
        }
        let reservation = reserve_host_instance(&request.profile.join("host-v0"))?;
        let found = InstallSwitch::recover_pending(
            &request.profile,
            &request.active_install,
            reservation,
            WAIT,
        )?;
        let (operation, outcome) = found
            .map(|(id, outcome)| (Some(id), Some(outcome)))
            .unwrap_or_default();
        print_receipt(operation.as_ref(), outcome);
        return Ok(());
    };
    let outcome = if let Some(suites) = &request.suites {
        replace_windows_suite(
            &request.profile,
            &request.active_install,
            &operation,
            suites,
            |phase| {
                if suites.desktop.is_some() && matches!(phase, SwitchPhase::Ready) {
                    eprintln!(
                        "Windows update holds the Host reservation and waits for the old desktop"
                    );
                }
                Ok(())
            },
        )?;
        Some(InstallOutcome::Committed)
    } else {
        let paths = InstallPaths::new(&request.active_install, operation.clone())?;
        let reservation = reserve_host_instance(&request.profile.join("host-v0"))?;
        let mut switch = InstallSwitch::open(&request.profile, paths, reservation, WAIT)?;
        switch.recover()?
    };
    print_receipt(Some(&operation), outcome);
    Ok(())
}

#[cfg(feature = "bindings")]
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
