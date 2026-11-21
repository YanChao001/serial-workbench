//! 由签名交接用例预先编译并安装的独立 Windows 测试工具。
use std::{
    fs::{self, OpenOptions},
    os::windows::fs::OpenOptionsExt,
    path::Path,
    process::{self, ExitCode},
    thread,
    time::{Duration, Instant},
};

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    if !args
        .next()
        .is_some_and(|arg| arg == env!("SWB_TOOL_HANDOFF_PROBE_LOCATOR"))
        || args.next().is_some()
    {
        return ExitCode::from(2);
    }
    let directory = Path::new(env!("SWB_TOOL_HANDOFF_PROBE_DIRECTORY"));
    let Ok(device) = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(directory.join("device.lock"))
    else {
        return ExitCode::from(3);
    };
    let entered = directory.join("tool-entered");
    let pending = directory.join("tool-entered.tmp");
    if fs::write(&pending, process::id().to_string())
        .and_then(|()| fs::rename(pending, entered))
        .is_err()
    {
        return ExitCode::from(4);
    }
    let release = directory.join("tool-release");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !release.is_file() {
        if Instant::now() >= deadline {
            return ExitCode::from(5);
        }
        thread::sleep(Duration::from_millis(10));
    }
    drop(device);
    if fs::File::create(directory.join("tool-exited")).is_err() {
        return ExitCode::from(6);
    }
    ExitCode::SUCCESS
}
