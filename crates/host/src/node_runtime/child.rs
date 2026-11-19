//! 进程及平台监护责任一起持有；返回的是实际 Node 的身份和退出状态。
#[cfg(target_os = "macos")]
use super::failure;
use super::{Control, NodeRuntimeProbeDiagnostics};
use serial_workbench_core::HostResult;
use std::{
    io,
    process::{Child, Command, ExitStatus},
};
#[cfg(all(test, target_os = "macos"))]
mod native_tests;
#[cfg(all(test, target_os = "macos"))]
pub(super) fn before_fork_descriptor() -> Option<std::os::fd::RawFd> {
    native_tests::before_fork_descriptor()
}
#[cfg(all(test, target_os = "macos"))]
pub(super) fn before_exec_descriptors() -> Option<(std::os::fd::RawFd, std::os::fd::RawFd)> {
    native_tests::before_exec_descriptors()
}
#[cfg(all(test, target_os = "macos"))]
pub(super) fn before_observer_descriptor() -> Option<std::os::fd::RawFd> {
    native_tests::before_observer_descriptor()
}

pub(super) struct Launch {
    #[cfg(target_os = "macos")]
    pub(super) supervisor: super::macos_supervisor::Prepared,
}
pub(crate) struct RuntimeChild {
    process: Child,
    exit_status: Option<ExitStatus>,
    closed: bool,
    #[cfg(target_os = "macos")]
    supervisor: super::macos_supervisor::Node,
}
impl Launch {
    pub(super) fn spawn(self, mut command: Command) -> io::Result<RuntimeChild> {
        let spawned = command.spawn();
        // pre_exec 捕获的子端不能留在父进程，尤其不能维持停止管道的存活。
        drop(command);
        let process = spawned?;
        Ok(RuntimeChild {
            process,
            exit_status: None,
            closed: false,
            #[cfg(target_os = "macos")]
            supervisor: self.supervisor.into_node(),
        })
    }
}
impl RuntimeChild {
    pub(super) fn initialize(
        &mut self,
        control: &Control<'_>,
        diagnostics: &mut NodeRuntimeProbeDiagnostics,
    ) -> HostResult<()> {
        #[cfg(target_os = "macos")]
        self.supervisor.initialize(control, diagnostics)?;
        #[cfg(not(target_os = "macos"))]
        let _ = (control, diagnostics);
        #[cfg(all(test, target_os = "macos"))]
        native_tests::observe(
            self.id(),
            self.supervisor_id(),
            self.supervisor.observer_id(),
        );
        Ok(())
    }
    pub(crate) fn id(&self) -> u32 {
        #[cfg(target_os = "macos")]
        {
            self.supervisor.id()
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.process.id()
        }
    }
    pub(crate) fn is_closed(&self) -> bool {
        self.closed
    }
    pub(crate) fn check_owner(&self) -> HostResult<()> {
        #[cfg(target_os = "macos")]
        if super::macos_supervisor::owner_exited(self.process.id())
            .map_err(|_| failure("NODE_BACKEND_INTERRUPTED", "supervisorInspection"))?
        {
            return Err(failure(
                "NODE_BACKEND_INTERRUPTED",
                "nativeSupervisorExited",
            ));
        }
        Ok(())
    }
    pub(crate) fn process(&self) -> &Child {
        &self.process
    }
    pub(crate) fn io(&mut self) -> &mut Child {
        &mut self.process
    }
    #[cfg(all(test, target_os = "macos"))]
    pub(super) fn supervisor_id(&self) -> u32 {
        self.process.id()
    }
    #[cfg(target_os = "macos")]
    pub(super) fn resume(&mut self) -> HostResult<()> {
        self.supervisor
            .resume()
            .map_err(|_| failure("NODE_RUNTIME_START_FAILED", "processResume"))
    }
    pub(crate) fn kill(&mut self) -> io::Result<()> {
        if self.closed {
            return Ok(());
        }
        #[cfg(target_os = "macos")]
        {
            // 先用仍未reap的直接子PID锚定Node组；监护已死也能终止忙线程和普通子进程。
            let stopped = super::macos_supervisor::owner_exited(self.process.id())
                .and_then(|_| super::macos_supervisor::stop_group(self.process.id()));
            // 即便发现ECHILD，也可关闭独立私有通道；不再向失去锚的数字PID发信号。
            let control = self.supervisor.stop();
            stopped.and(control)
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.process.kill()
        }
    }
    fn completed(&mut self, status: ExitStatus) -> io::Result<ExitStatus> {
        // macOS进入此处前已观察整组结束，且监护已wait。丢失原始终态不等于仍有进程。
        self.closed = true;
        #[cfg(target_os = "macos")]
        let status = self.supervisor.exit_status(status)?;
        self.exit_status = Some(status);
        Ok(status)
    }
    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        if let Some(status) = self.exit_status {
            return Ok(status);
        }
        if self.closed {
            return Err(io::Error::other("Native Node exit status unavailable"));
        }
        #[cfg(target_os = "macos")]
        {
            self.kill()?;
            // 监护PID保持未reap，组ID不会落到无关进程；组中已无成员后才收取监护。
            super::macos_supervisor::wait_group_gone(self.process.id())?;
            self.supervisor.wait_observer()?;
        }
        let status = self.process.wait()?;
        self.completed(status)
    }
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        if let Some(status) = self.exit_status {
            return Ok(Some(status));
        }
        #[cfg(target_os = "macos")]
        {
            if !super::macos_supervisor::owner_exited(self.process.id())? {
                Ok(None)
            } else {
                self.wait().map(Some)
            }
        }
        #[cfg(not(target_os = "macos"))]
        self.process
            .try_wait()?
            .map(|status| self.completed(status))
            .transpose()
    }
}
impl Drop for RuntimeChild {
    fn drop(&mut self) {
        if !self.closed {
            let _ = self.kill();
            loop {
                match self.wait() {
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    #[cfg(target_os = "macos")]
                    Err(_) if !self.closed => {
                        std::thread::sleep(std::time::Duration::from_millis(50))
                    }
                    _ => break,
                }
            }
        }
    }
}
