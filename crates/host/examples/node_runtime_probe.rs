//! 无界面验收入口：只调用正式 Host/runtime 边界，原始输出留在唯一证据目录。
use serial_workbench_core::HostResult;
use serial_workbench_host::node_runtime::{
    NodeRuntimeLimits, installed_node_resource_root, verify_node_runtime,
};
use std::{
    collections::HashSet, fs, path::PathBuf, process::ExitCode, sync::atomic::AtomicBool,
    time::Duration,
};

const USAGE: &str = "Usage: node_runtime_probe --evidence <absolute-directory> [--resource-root <absolute-directory>] [--verify-only] [--cancel] [--max-output-bytes <integer>] [--probe-timeout-ms <integer>]";

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::from(1),
        Err(error) => {
            eprintln!("Runtime probe setup failed: {error}");
            ExitCode::from(2)
        }
    }
}

fn run() -> Result<bool, Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() == 1 && matches!(arguments[0].to_str(), Some("--help" | "-h")) {
        println!("{USAGE}");
        return Ok(true);
    }
    let mut arguments = arguments.into_iter();
    let mut root = None;
    let mut evidence = None;
    let mut verify_only = false;
    let mut cancelled = false;
    let mut limits = NodeRuntimeLimits::default();
    let mut seen = HashSet::new();
    while let Some(argument) = arguments.next() {
        let flag = argument.to_str().ok_or(USAGE)?;
        if !seen.insert(flag.to_owned()) {
            return Err(USAGE.into());
        }
        match flag {
            "--resource-root" => root = Some(PathBuf::from(arguments.next().ok_or(USAGE)?)),
            "--evidence" => evidence = Some(PathBuf::from(arguments.next().ok_or(USAGE)?)),
            "--verify-only" => verify_only = true,
            "--cancel" => cancelled = true,
            "--max-output-bytes" => {
                limits.max_output_bytes = arguments
                    .next()
                    .ok_or(USAGE)?
                    .to_str()
                    .ok_or(USAGE)?
                    .parse()?
            }
            "--probe-timeout-ms" => {
                limits.probe_timeout = Duration::from_millis(
                    arguments
                        .next()
                        .ok_or(USAGE)?
                        .to_str()
                        .ok_or(USAGE)?
                        .parse()?,
                )
            }
            _ => return Err(USAGE.into()),
        }
    }
    let evidence = evidence.ok_or(USAGE)?;
    if !evidence.is_absolute() {
        return Err("Evidence directory must be absolute".into());
    }
    fs::create_dir_all(&evidence)?;
    let evidence = evidence.join(format!("host-runtime-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&evidence)?;
    let requested_root = root
        .as_ref()
        .map(|path| path.to_string_lossy().into_owned());
    let root = root.map_or_else(installed_node_resource_root, Ok);
    let cancel = AtomicBool::new(cancelled);
    let verified = root.and_then(|root| verify_node_runtime(&root, &limits, &cancel));
    let (outcome, diagnostics) = match verified {
        Ok(runtime) if verify_only => (
            serde_json::json!({"ok":true,"result":{"verified":true,"target":runtime.target()}}),
            None,
        ),
        Ok(runtime) => {
            let report = runtime.self_test(&limits, &cancel);
            fs::write(evidence.join("probe.stdout"), &report.diagnostics.stdout)?;
            fs::write(evidence.join("probe.stderr"), &report.diagnostics.stderr)?;
            if let Some(error) = &report.diagnostics.io_error {
                fs::write(evidence.join("probe-io.txt"), error)?;
            }
            let diagnostics = serde_json::json!({
                "processId":report.diagnostics.process_id,"exitCode":report.diagnostics.exit_code,
                "reaped":report.diagnostics.reaped,"stdoutBytes":report.diagnostics.stdout.len(),
                "stderrBytes":report.diagnostics.stderr.len(),
                "imageCdhash":report.diagnostics.image_cdhash,
                "imageSignatureFlags":report.diagnostics.image_signature_flags,
                "imageSealed":report.diagnostics.image_sealed
            });
            (result_json(&report.outcome), Some(diagnostics))
        }
        Err(error) => (serde_json::json!({"ok":false,"error":error}), None),
    };
    let passed = outcome["ok"].as_bool().unwrap_or(false);
    let receipt = serde_json::json!({
        "schemaVersion":"0.1","platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
        "requestedResourceRoot":requested_root,"evidence":evidence,"outcome":outcome,
        "diagnostics":diagnostics,"verifyOnly":verify_only,"cancelled":cancelled
    });
    let json = serde_json::to_string_pretty(&receipt)?;
    fs::write(evidence.join("receipt.json"), format!("{json}\n"))?;
    println!("{json}");
    Ok(passed)
}

fn result_json<T: serde::Serialize>(result: &HostResult<T>) -> serde_json::Value {
    match result {
        Ok(value) => serde_json::json!({"ok":true,"result":value}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    }
}
