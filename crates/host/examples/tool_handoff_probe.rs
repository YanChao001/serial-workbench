//! 隔离 Windows 验收用的无数据写入串口工具。
use std::process::ExitCode;

#[cfg(windows)]
fn main() -> ExitCode {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt, thread, time::Duration};

    let mut args = std::env::args_os().skip(1);
    let Some(locator) = args.next().and_then(|value| value.into_string().ok()) else {
        return ExitCode::from(2);
    };
    let locator = locator
        .strip_prefix(r"\\.\")
        .unwrap_or(&locator)
        .to_ascii_uppercase();
    let valid = locator
        .strip_prefix("COM")
        .filter(|suffix| suffix.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|suffix| suffix.parse::<u32>().ok())
        .is_some_and(|port| port != 0);
    if args.next().is_some() || !valid {
        return ExitCode::from(2);
    }
    let Ok(port) = OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(format!(r"\\.\{locator}"))
    else {
        return ExitCode::from(3);
    };
    // 给隔离验收留出观察工具持口的时间。
    thread::sleep(Duration::from_millis(250));
    drop(port);
    ExitCode::SUCCESS
}

#[cfg(not(windows))]
fn main() -> ExitCode {
    ExitCode::from(4)
}
