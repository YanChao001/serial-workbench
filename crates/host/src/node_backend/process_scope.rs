#[cfg(windows)]
use super::error;
use serial_workbench_core::HostResult;
use std::process::Child;

#[cfg(windows)]
pub(super) struct ProcessScope(Option<std::os::windows::io::OwnedHandle>);
#[cfg(unix)]
pub(super) struct ProcessScope;
impl ProcessScope {
    pub(super) fn new() -> HostResult<Self> {
        #[cfg(windows)]
        {
            use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
            use windows_sys::Win32::System::JobObjects::*;
            let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if job.is_null() {
                return Err(error("NODE_RUNTIME_START_FAILED", "backendJob"));
            }
            let job = unsafe { OwnedHandle::from_raw_handle(job) };
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if unsafe {
                SetInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            } == 0
            {
                return Err(error("NODE_RUNTIME_START_FAILED", "backendJobLimits"));
            }
            Ok(Self(Some(job)))
        }
        #[cfg(unix)]
        Ok(Self)
    }
    pub(super) fn attach(&self, child: &Child) -> HostResult<()> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if unsafe {
                windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                    self.0.as_ref().expect("active job").as_raw_handle(),
                    child.as_raw_handle(),
                )
            } == 0
            {
                return Err(error("NODE_RUNTIME_START_FAILED", "backendJobAssignment"));
            }
        }
        #[cfg(unix)]
        let _ = child;
        Ok(())
    }
    pub(super) fn terminate(&mut self, child: &mut Child) {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if let Some(job) = self.0.take() {
                let _ = unsafe {
                    windows_sys::Win32::System::JobObjects::TerminateJobObject(
                        job.as_raw_handle(),
                        1,
                    )
                };
                // KILL_ON_JOB_CLOSE 是终止调用失败时的第二条自有进程回收路径。
                drop(job);
            }
            let _ = child;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let Ok(pid) = libc::pid_t::try_from(child.id()) else {
                return;
            };
            // Child 尚未 wait/reap，组标识不能被其他无关进程复用。
            let _ = unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
        #[cfg(target_os = "macos")]
        // RuntimeChild在证明直接子仍可wait之后统一终止组，不能绕开其PID锚校验。
        let _ = child;
    }
}
