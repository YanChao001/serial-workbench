use serial_workbench_ipc::startup_config::{init_stderr_logging, resolve};
use std::process::Command;

fn child(level: &str) -> std::process::Output {
    let mut command = Command::new(std::env::current_exe().unwrap());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .args(["--exact", "logging_child", "--nocapture"])
        .env("SWB_STARTUP_LOGGING_TEST_CHILD", "1")
        .env(
            "SWB_PROFILE",
            std::env::temp_dir().join("swb-unused-logging-profile"),
        )
        .env("SWB_LOG_LEVEL", level)
        .output()
        .unwrap()
}

#[test]
fn stderr_logger_applies_threshold_and_preserves_machine_stdout() {
    let output = child("warn");
    assert!(output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("runtime-error-marker"));
    assert!(stderr.contains("runtime-warn-marker"));
    assert!(!stderr.contains("runtime-info-marker"));
    assert!(!stderr.contains("runtime-debug-marker"));
    assert!(!stderr.contains("third-party-private-payload-marker"));
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("{\"result\":\"machine-output-marker\"}"));
    assert!(!stdout.contains("runtime-"));
}

#[test]
fn off_suppresses_logs_but_preserves_fatal_error_output() {
    let output = child("off");
    assert!(output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(!stderr.contains("runtime-"));
    assert!(stderr.contains("fatal-error-marker"));
}

#[test]
fn trace_enables_debug_and_trace() {
    let output = child("trace");
    assert!(output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("runtime-debug-marker"));
    assert!(stderr.contains("runtime-trace-marker"));
    assert!(!stderr.contains("third-party-private-payload-marker"));
}

#[test]
fn logging_child() {
    if std::env::var_os("SWB_STARTUP_LOGGING_TEST_CHILD").is_none() {
        return;
    }
    let config = resolve(None).unwrap();
    init_stderr_logging(config.log_filter()).unwrap();
    log::error!(target: "serial_workbench_startup", "runtime-error-marker");
    log::warn!(target: "serial_workbench_startup", "runtime-warn-marker");
    log::info!(target: "serial_workbench_startup", "runtime-info-marker");
    log::debug!(target: "serial_workbench_ipc", "runtime-debug-marker");
    log::trace!(target: "serial_workbench_ipc::startup_config", "runtime-trace-marker");
    log::error!(target: "unreviewed_dependency", "third-party-private-payload-marker");
    println!("{{\"result\":\"machine-output-marker\"}}");
    eprintln!("fatal-error-marker");
    assert_eq!(
        init_stderr_logging(log::LevelFilter::Off).unwrap_err().code,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(log::max_level(), config.log_filter());
}
