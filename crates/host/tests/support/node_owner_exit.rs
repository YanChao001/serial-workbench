use std::{
    io,
    time::{Duration, Instant},
};

pub struct ParentReaper {
    #[cfg(target_os = "linux")]
    previous: libc::c_int,
}
impl ParentReaper {
    pub fn install() -> Self {
        #[cfg(target_os = "linux")]
        {
            let mut previous = 0;
            assert_eq!(
                unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut previous) },
                0
            );
            assert_eq!(unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) }, 0);
            Self { previous }
        }
        #[cfg(not(target_os = "linux"))]
        Self {}
    }
}
impl Drop for ParentReaper {
    fn drop(&mut self) {
        #[cfg(target_os = "linux")]
        unsafe {
            libc::prctl(libc::PR_SET_CHILD_SUBREAPER, self.previous);
        }
    }
}

pub struct ProcessExit {
    #[cfg(unix)]
    pid: u32,
    exited: bool,
    cleanup: bool,
    #[cfg(windows)]
    handle: std::os::windows::io::OwnedHandle,
}
impl ProcessExit {
    pub fn new(pid: u32) -> Self {
        Self::with_cleanup(pid, true)
    }
    pub fn observe(pid: u32) -> Self {
        Self::with_cleanup(pid, false)
    }
    fn with_cleanup(pid: u32, cleanup: bool) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
            };
            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | if cleanup { PROCESS_TERMINATE } else { 0 },
                    0,
                    pid,
                )
            };
            assert!(
                !handle.is_null(),
                "Native Node must be alive after its startup marker: {}",
                io::Error::last_os_error()
            );
            Self {
                exited: false,
                cleanup,
                handle: unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) },
            }
        }
        #[cfg(unix)]
        Self {
            pid,
            exited: false,
            cleanup,
        }
    }
    pub fn exited(&mut self) -> bool {
        if self.exited {
            return true;
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            let mut code = 259;
            assert_ne!(
                unsafe {
                    windows_sys::Win32::System::Threading::GetExitCodeProcess(
                        self.handle.as_raw_handle(),
                        &mut code,
                    )
                },
                0
            );
            self.exited = code != 259;
        }
        #[cfg(target_os = "linux")]
        {
            if self.cleanup {
                let mut status = 0;
                let waited = unsafe {
                    libc::waitpid(self.pid.try_into().unwrap(), &mut status, libc::WNOHANG)
                };
                self.exited = waited == self.pid as libc::pid_t;
            } else {
                // 只观察终止状态，不消费 owner 或夹具尚需收取的退出状态。
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                let waited = unsafe {
                    libc::waitid(
                        libc::P_PID,
                        self.pid,
                        &mut info,
                        libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                    )
                };
                self.exited = waited == 0 && unsafe { info.si_pid() } == self.pid as libc::pid_t;
            }
        }
        #[cfg(unix)]
        if !self.exited {
            let result = unsafe { libc::kill(self.pid.try_into().unwrap(), 0) };
            self.exited =
                result < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        }
        self.exited
    }
    pub fn wait(&mut self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.exited() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        self.exited()
    }
    pub fn reap_adopted_after_observation(&self) -> bool {
        assert!(
            !self.cleanup && self.exited,
            "Observe actual exit before fixture cleanup"
        );
        #[cfg(target_os = "linux")]
        {
            // 仅在退出证据成立后收取被 subreaper 收养的 child，不能补作产品证据。
            let mut status = 0;
            let waited =
                unsafe { libc::waitpid(self.pid.try_into().unwrap(), &mut status, libc::WNOHANG) };
            let reaped = waited == self.pid as libc::pid_t;
            assert!(
                reaped
                    || (waited < 0
                        && io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD)),
                "Fixture must not wait for a live child"
            );
            assert_gone(self.pid);
            reaped
        }
        #[cfg(not(target_os = "linux"))]
        false
    }
}
impl Drop for ProcessExit {
    fn drop(&mut self) {
        if !self.cleanup {
            return;
        }
        if self.exited() {
            return;
        }
        // 只清理本夹具刚建立并持续观察的 Node；独立原生验收按单线程运行。
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(
                    self.handle.as_raw_handle(),
                    1,
                );
            }
        }
        #[cfg(unix)]
        unsafe {
            libc::kill(self.pid.try_into().unwrap(), libc::SIGKILL);
        }
        let _ = self.wait();
    }
}

pub fn assert_gone(pid: u32) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, GetLastError},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            assert_eq!(GetLastError(), ERROR_INVALID_PARAMETER);
        } else {
            let mut code = 259;
            let read = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            assert_ne!(read, 0);
            assert_ne!(code, 259, "Owned Node must no longer execute");
        }
    }
    #[cfg(unix)]
    {
        assert_eq!(
            unsafe { libc::kill(pid.try_into().unwrap(), 0) },
            -1,
            "Owned Node must be reaped"
        );
        assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
}
