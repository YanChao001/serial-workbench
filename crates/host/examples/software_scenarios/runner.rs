use super::{
    containment::Containment,
    evidence::{Case, write_json},
    fault_transport::{self, Mode},
    process::{Binaries, Processes, Result, checked},
};
use serde_json::{Value, json};
use serial_workbench_core::*;
use serial_workbench_host::{Host, ipc::HostServer};
use std::{path::PathBuf, sync::Arc, time::SystemTime};

pub(super) async fn owned_host(profile: PathBuf, log_dir: PathBuf) -> Result<()> {
    let mut server = checked(HostServer::bind(&profile).await)?;
    let directory = log_dir.clone();
    let opener: serial_workbench_host::device::TransportOpener = Arc::new(move |device, config| {
        let (mode, name) = match device.as_str() {
            "harness:partial" => (Mode::PartialUnknown, "partial-probe.json"),
            "harness:control" => (Mode::ConfigurationAndBreak, "control-probe.json"),
            "harness:producer" => (Mode::PacedProducer, "producer-probe.json"),
            "virtual:echo" => {
                return Ok(Box::new(
                    serial_workbench_host::device::virtual_backend::VirtualTransport::new(
                        config.clone(),
                    ),
                ));
            }
            _ => {
                return Err(
                    HostError::new("DEVICE_NOT_FOUND", "Unknown example-owned device").into(),
                );
            }
        };
        Ok(fault_transport::configured(
            mode,
            config.clone(),
            Some(directory.join(name)),
        ))
    });
    let host = checked(
        Host::with_runtime(
            server.store(),
            server.auth(),
            Arc::new(checked(serial_workbench_host::clock::SystemClock::new())?),
            opener,
        )
        .await,
    )?;
    checked(
        server
            .serve_until(Arc::new(host), std::future::pending::<()>())
            .await,
    )
}
fn timestamp() -> String {
    chrono::DateTime::<chrono::Utc>::from(SystemTime::now()).to_rfc3339()
}
fn target() -> String {
    let arch = std::env::consts::ARCH;
    if cfg!(windows) {
        format!("{arch}-pc-windows-msvc")
    } else if cfg!(target_os = "macos") {
        format!("{arch}-apple-darwin")
    } else if cfg!(target_env = "musl") {
        format!("{arch}-unknown-linux-musl")
    } else {
        format!("{arch}-unknown-linux-gnu")
    }
}
pub(super) async fn run(
    profile: PathBuf,
    duration: u64,
    result: PathBuf,
    log_dir: PathBuf,
) -> Result<()> {
    if duration != 600 || !profile.is_absolute() || !result.is_absolute() || !log_dir.is_absolute()
    {
        return Err("Absolute profile/result/log-dir and exactly 600 seconds are required".into());
    }
    let profile = checked(profile.canonicalize())?;
    let log_dir = checked(log_dir.canonicalize())?;
    if !profile.is_dir()
        || !log_dir.is_dir()
        || checked(std::fs::read_dir(&profile))?.next().is_some()
    {
        return Err("Scenario profile must be an existing empty private directory".into());
    }
    if result.exists()
        || result.parent().and_then(|p| p.canonicalize().ok()).as_ref() != Some(&log_dir)
    {
        return Err("Result must be a new file directly inside log-dir".into());
    }
    let binaries = Binaries::discover()?;
    let containment = Containment::install()?;
    let started = timestamp();
    let mut processes = Processes::new(log_dir.clone());
    let mut t01 = Case::new(
        "T01",
        "production Host runtime over real local IPC; actual CLI and official rmcp SDK; private fault backend probe",
    );
    let mut t03 = Case::new(
        "T03",
        "formal Host executable and production CLI host stop; fresh private profile; actual wait handles",
    );
    let mut t04 = Case::new(
        "T04",
        "production Host session owner and ordinary RPC; example-private configuration/BREAK backend",
    );
    let mut t05 = Case::new(
        "T05",
        "production CaptureWriter/verify/recover; private CaptureVolume faults; real retained files and killed owned writer child",
    );
    let mut t06 = Case::new(
        "T06",
        "600-second independent paced producer; actual Rust raw/control clients; real Host capture and host.metrics; OS RSS",
    );
    let mut t08 = Case::new(
        "T08",
        "formal Host capture/replay actions over local IPC plus independent production-format readback and SHA256",
    );
    let formal_profile = profile.join("formal");
    checked(std::fs::create_dir(&formal_profile))?;
    let formal = super::formal::run(
        &mut t03,
        &mut t08,
        &mut processes,
        &binaries,
        &formal_profile,
    )
    .await;
    t08.finish(
        if t08.observed_all() {
            Ok(())
        } else {
            formal.clone()
        },
        &log_dir,
    )?;
    t03.finish(formal, &log_dir)?;
    let private_profile = profile.join("controlled");
    checked(std::fs::create_dir(&private_profile))?;
    let host_index = processes.start_host(&binaries.harness, &private_profile, true)?;
    let setup = super::scenarios::setup(&private_profile).await;
    let mut telemetry = Value::Null;
    match setup {
        Ok((user, control)) => {
            let parity = super::scenarios::parity(
                &mut t01,
                &mut processes,
                &binaries,
                &private_profile,
                &user,
            )
            .await;
            t01.finish(parity, &log_dir)?;
            let controls = super::scenarios::controls(&mut t04, &user).await;
            t04.finish(controls, &log_dir)?;
            let disk = super::disk::run(&mut t05, &mut processes, &binaries).await;
            t05.finish(disk, &log_dir)?;
            let load = super::load::run(
                &mut t06,
                &mut processes,
                &private_profile,
                host_index,
                &user,
                &control,
            )
            .await;
            match load {
                Ok(value) => {
                    telemetry = value;
                    t06.finish(Ok(()), &log_dir)?;
                }
                Err(error) => t06.finish(Err(error), &log_dir)?,
            }
        }
        Err(error) => {
            t01.finish(Err(error.clone()), &log_dir)?;
            t04.finish(Err(error.clone()), &log_dir)?;
            let disk = super::disk::run(&mut t05, &mut processes, &binaries).await;
            t05.finish(disk, &log_dir)?;
            t06.finish(Err(error), &log_dir)?;
        }
    }
    // Controlled BREAK fault intentionally leaves an isolated Host, so teardown
    // may need to kill that one owned child. Formal stop evidence is separate.
    let cleanup = processes.cleanup().await;
    let complete = cleanup.is_ok() && processes.records().iter().all(|p| p.exited);
    let cases = [t01, t03, t04, t05, t06, t08];
    let success = complete && cases.iter().all(Case::passed);
    write_json(
        &result,
        &json!({"version":env!("CARGO_PKG_VERSION"),"target":target(),"platform":std::env::consts::OS,"protocol":"0.1","startedAt":started,"endedAt":timestamp(),"cases":cases,"cleanup":{"complete":complete,"ownedProcesses":processes.records(),"processLedger":"owned-processes.jsonl","error":cleanup.err(),"containment":if cfg!(windows){"Windows non-inheritable kill-on-close Job; all descendants inherit membership"}else{"wrapper-owned independent POSIX process group"}},"telemetry":telemetry}),
    )?;
    if complete {
        containment.disarm()?;
    }
    if success {
        Ok(())
    } else {
        Err(format!(
            "Software scenarios failed or were incomplete; preserve profile {} and evidence {}",
            profile.display(),
            log_dir.display()
        ))
    }
}
