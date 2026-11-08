//! OS containment survives a forced wrapper termination (which cannot run Drop).
use super::process::Result;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::process::checked;

#[cfg(windows)]
pub(super) struct Containment {
    // Exactly one bounded, non-inheritable OS handle exists for this executable
    // invocation. It intentionally has no Rust Drop: ordinary errors must reach
    // main, preserve/print evidence and exit(1) before the OS closes this handle
    // and kills remaining members (including this process). Forced termination
    // also closes it in the OS. Only confirmed complete cleanup disarms/closes it.
    job: windows_sys::Win32::Foundation::HANDLE,
}
#[cfg(not(windows))]
pub(super) struct Containment;

impl Containment {
    #[cfg(windows)]
    pub fn install() -> Result<Self> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::GetCurrentProcess},
        };
        // A NULL SECURITY_ATTRIBUTES makes the sole job handle non-inheritable.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0 {
            unsafe {
                CloseHandle(job);
            }
            return Err(std::io::Error::last_os_error().to_string());
        }
        if unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(job);
            }
            return Err(error.to_string());
        }
        Ok(Self { job })
    }
    #[cfg(unix)]
    pub fn install() -> Result<Self> {
        // Node owns the separately-created process group and targets its negative
        // child PID on interruption, including SIGKILL. Never adopt another group.
        if unsafe { libc::getpgrp() } != unsafe { libc::getpid() } {
            return Err("POSIX harness must be spawned in its own process group (detached:true) before any Host child is started".into());
        }
        Ok(Self)
    }
    #[cfg(not(any(windows, unix)))]
    pub fn install() -> Result<Self> {
        Err("No owned-process containment implementation for this OS".into())
    }

    #[cfg(windows)]
    pub fn disarm(&self) -> Result<()> {
        use windows_sys::Win32::System::JobObjects::*;
        let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            SetInformationJobObject(
                self.job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    pub fn disarm(&self) -> Result<()> {
        Ok(())
    }
}

pub(super) fn rss(pid: u32) -> Result<u64> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{
                ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
                Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
            },
        };
        // Only an explicitly owned, still-live PID or this Rust client process is
        // passed by the caller. No system process enumeration occurs.
        let process = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if process.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        counters.cb = std::mem::size_of_val(&counters) as u32;
        let ok = unsafe {
            GetProcessMemoryInfo(
                process,
                &mut counters,
                std::mem::size_of_val(&counters) as u32,
            )
        };
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(process);
        }
        if ok == 0 {
            return Err(error.to_string());
        }
        Ok(counters.WorkingSetSize as u64)
    }
    #[cfg(target_os = "linux")]
    {
        let text = checked(std::fs::read_to_string(format!("/proc/{pid}/status")))?;
        let line = text
            .lines()
            .find(|line| line.starts_with("VmRSS:"))
            .ok_or("VmRSS absent from owned process status")?;
        let words: Vec<_> = line.split_whitespace().collect();
        if words.len() != 3 || words[2] != "kB" {
            return Err("Unexpected Linux VmRSS units".into());
        }
        checked(words[1].parse::<u64>())?
            .checked_mul(1024)
            .ok_or_else(|| "RSS overflow".into())
    }
    #[cfg(target_os = "macos")]
    {
        // Apple adv_cmds/ps/ps.1 defines rss in 1024-byte units and an empty
        // -o header suppresses the header. The fixed executable uses no shell.
        let output = checked(
            std::process::Command::new("/bin/ps")
                .args(["-o", "rss=", "-p", &pid.to_string()])
                .output(),
        )?;
        if !output.status.success() {
            return Err(format!(
                "Owned PID {pid} ps RSS query failed: {}",
                output.status
            ));
        }
        let text = checked(std::str::from_utf8(&output.stdout))?;
        if text.split_whitespace().count() != 1 {
            return Err("Unexpected macOS ps RSS output".into());
        }
        checked(text.trim().parse::<u64>())?
            .checked_mul(1024)
            .ok_or_else(|| "RSS overflow".into())
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        Err("Actual RSS sampling unsupported on this target".into())
    }
}
