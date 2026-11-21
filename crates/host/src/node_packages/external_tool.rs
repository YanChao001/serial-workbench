use super::{NodePackageInstaller, NodePackageLimits, VerifiedNodeInstallation, failure};
use serial_workbench_core::{
    Digest, HostResult, Id, NodePackageFile, NodePackageId, NodePackageResourceKind, U64,
};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Instant,
};

/// 保留安装证明及签名清单中的准确文件身份，供交接执行者复核。
pub(crate) struct VerifiedExternalTool {
    _installation: VerifiedNodeInstallation,
    path: PathBuf,
    file: NodePackageFile,
}

impl VerifiedExternalTool {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn size(&self) -> U64 {
        self.file.size
    }

    pub(crate) fn sha256(&self) -> &Digest {
        &self.file.sha256
    }
}

impl VerifiedExternalTool {
    /// 排空串口前检查是否有可用的平台执行者和正常的设备地址。
    #[cfg(windows)]
    pub(crate) fn check_locator(&self, locator: &str) -> HostResult<()> {
        if !self
            .path()
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
        {
            return Err(failure("UNSUPPORTED_CAPABILITY", "externalToolExecutable"));
        }
        let name = locator.strip_prefix(r"\\.\").unwrap_or(locator);
        let is_port = name
            .get(..3)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("COM"))
            && name.get(3..).is_some_and(|number| {
                !number.is_empty()
                    && number.bytes().all(|byte| byte.is_ascii_digit())
                    && number.parse::<u32>().is_ok_and(|port| port != 0)
            });
        if !is_port {
            return Err(failure("INVALID_ARGUMENT", "externalToolDeviceLocator"));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub(crate) fn check_locator(&self, _locator: &str) -> HostResult<()> {
        Err(failure(
            "UNSUPPORTED_CAPABILITY",
            "externalToolProcessOwner",
        ))
    }

    /// 调用方在阻塞执行者持有串口预约和安装证明，直到可确认工具退出。
    #[cfg(windows)]
    pub(crate) fn run(
        &self,
        locator: &str,
        deadline: Instant,
        cancel: &AtomicBool,
    ) -> HostResult<u32> {
        self.check_locator(locator)?;
        windows::run(self.path(), locator, deadline, cancel)
    }

    #[cfg(not(windows))]
    pub(crate) fn run(
        &self,
        _locator: &str,
        _deadline: Instant,
        _cancel: &AtomicBool,
    ) -> HostResult<u32> {
        Err(failure(
            "UNSUPPORTED_CAPABILITY",
            "externalToolProcessOwner",
        ))
    }
}

impl NodePackageInstaller {
    /// 调用方须核对本地用户控制和本次设备授权，并在提交执行前复核当前来源与授权。
    pub(crate) fn verify_external_tool(
        &self,
        package_id: &NodePackageId,
        expected_revision: U64,
        archive_sha256: &Digest,
        tool_id: &Id,
        limits: &NodePackageLimits,
        cancel: &AtomicBool,
    ) -> HostResult<VerifiedExternalTool> {
        let installation = self.verify_installed(
            package_id,
            expected_revision,
            archive_sha256,
            limits,
            cancel,
        )?;
        let package = installation.package();
        let approved = package.execution_trust.as_ref().is_some_and(|trust| {
            trust.archive_sha256 == package.archive_sha256
                && trust.permissions == package.manifest.permissions
                && trust.verified_source == package.verified_source
                && trust.permissions.external_tools.contains(tool_id)
        });
        if !package.enabled || package.verified_source.is_none() || !approved {
            return Err(failure("PERMISSION_DENIED", "externalToolExecutionTrust"));
        }

        let target = crate::node_runtime::current_node_target()?;
        let resource = package
            .manifest
            .platform_resources
            .iter()
            .find(|resource| {
                &resource.id == tool_id
                    && resource.target == target
                    && resource.kind == NodePackageResourceKind::Tool
            })
            .ok_or_else(|| failure("UNSUPPORTED_CAPABILITY", "externalToolTarget"))?;
        let file = installation
            .tool_file(&resource.path)
            .ok_or_else(|| super::installed::integrity("externalToolFile"))?
            .clone();
        let path = installation.code_directory().join(resource.path.as_str());
        Ok(VerifiedExternalTool {
            _installation: installation,
            path,
            file,
        })
    }
}

#[cfg(windows)]
mod windows {
    use serial_workbench_core::{HostError, HostResult};
    use std::{
        os::windows::{
            ffi::OsStrExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::Path,
        ptr::{null, null_mut},
        sync::atomic::{AtomicBool, Ordering},
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
                JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject, TerminateJobObject,
            },
            Threading::{
                CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
                GetExitCodeProcess, PROCESS_INFORMATION, ResumeThread, STARTUPINFOW,
                TerminateProcess, WaitForSingleObject,
            },
        },
    };

    const POLL: Duration = Duration::from_millis(20);
    const CLEANUP_BUDGET: Duration = Duration::from_secs(5);
    const STOP_EXIT_CODE: u32 = 0xc000013a;

    pub(super) fn run(
        executable: &Path,
        locator: &str,
        deadline: Instant,
        cancel: &AtomicBool,
    ) -> HostResult<u32> {
        if let Some(error) = stop_reason(deadline, cancel) {
            return Err(error);
        }
        let job = job()?;
        let (process, thread) = spawn_suspended(executable, locator)?;
        // 首线程未运行，加入 Job 失败时工具还不能打开设备或创建子进程。
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) } == 0 {
            unsafe { TerminateProcess(process.as_raw_handle(), 1) };
            return if unsafe {
                WaitForSingleObject(process.as_raw_handle(), CLEANUP_BUDGET.as_millis() as u32)
            } == WAIT_OBJECT_0
            {
                Err(start_failed())
            } else {
                Err(exit_unconfirmed())
            };
        }
        if let Some(error) = stop_reason(deadline, cancel) {
            stop(&job, &process)?;
            return Err(error);
        }
        if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
            stop(&job, &process)?;
            return Err(start_failed());
        }
        drop(thread);

        loop {
            // 若期限或取消与退出并发，仍保留工具已经产生的真实结果。
            let reason = match exited(&job, &process) {
                Some(true) => return exit_code(&process),
                Some(false) => stop_reason(deadline, cancel),
                None => Some(result_unavailable()),
            };
            if let Some(error) = reason {
                let code = stop(&job, &process)?;
                return if code == STOP_EXIT_CODE {
                    Err(error)
                } else {
                    Ok(code)
                };
            }
            std::thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())));
        }
    }

    fn job() -> HostResult<OwnedHandle> {
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        if raw.is_null() {
            return Err(start_failed());
        }
        // 由 Host 单独持有，不把终止权限或其他 OS 句柄继承给工具。
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(start_failed());
        }
        Ok(job)
    }

    fn spawn_suspended(executable: &Path, locator: &str) -> HostResult<(OwnedHandle, OwnedHandle)> {
        let directory = executable.parent().ok_or_else(start_failed)?;
        let application: Vec<u16> = executable.as_os_str().encode_wide().collect();
        if !executable.is_absolute() || application.contains(&0) || application.contains(&34) {
            return Err(start_failed());
        }
        let directory = directory
            .as_os_str()
            .encode_wide()
            .chain([0])
            .collect::<Vec<_>>();
        let mut arguments = Vec::from([34]);
        arguments.extend_from_slice(&application);
        arguments.extend([34, 32]);
        arguments.extend(locator.encode_utf16());
        arguments.push(0);
        let application = application.into_iter().chain([0]).collect::<Vec<_>>();
        let environment = [0u16; 2];
        let startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut process = PROCESS_INFORMATION::default();
        // 应用路径精确指向安装证明持有的文件。COM 地址已检查，无需 Shell 或选项解析。
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                arguments.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr().cast(),
                directory.as_ptr(),
                &startup,
                &mut process,
            )
        } == 0
        {
            return Err(start_failed());
        }
        // CreateProcessW 成功后，调用方同时拥有进程及首线程句柄。
        Ok(unsafe {
            (
                OwnedHandle::from_raw_handle(process.hProcess),
                OwnedHandle::from_raw_handle(process.hThread),
            )
        })
    }

    fn exited(job: &OwnedHandle, process: &OwnedHandle) -> Option<bool> {
        let mut information = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&raw mut information).cast(),
                std::mem::size_of_val(&information) as u32,
                null_mut(),
            )
        } == 0
        {
            return None;
        }
        if information.ActiveProcesses != 0 {
            return Some(false);
        }
        match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => Some(true),
            WAIT_TIMEOUT => Some(false),
            _ => None,
        }
    }

    fn exit_code(process: &OwnedHandle) -> HostResult<u32> {
        let mut code = 0;
        if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } == 0 {
            return Err(result_unavailable());
        }
        Ok(code)
    }

    fn stop(job: &OwnedHandle, process: &OwnedHandle) -> HostResult<u32> {
        unsafe { TerminateJobObject(job.as_raw_handle(), STOP_EXIT_CODE) };
        let deadline = Instant::now() + CLEANUP_BUDGET;
        loop {
            if exited(job, process) == Some(true) {
                return exit_code(process);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(exit_unconfirmed());
            }
            std::thread::sleep(POLL.min(remaining));
        }
    }

    fn stop_reason(deadline: Instant, cancel: &AtomicBool) -> Option<HostError> {
        if cancel.load(Ordering::Acquire) {
            Some(HostError::new(
                "CANCELLED",
                "The external tool was cancelled",
            ))
        } else if Instant::now() >= deadline {
            Some(HostError::new(
                "LIMIT_EXCEEDED",
                "The external tool reached its deadline",
            ))
        } else {
            None
        }
    }

    fn start_failed() -> HostError {
        HostError::new(
            "TOOL_START_FAILED",
            "Cannot start the verified external tool",
        )
    }

    fn result_unavailable() -> HostError {
        HostError::new(
            "TOOL_RESULT_UNAVAILABLE",
            "The tool exited but its status could not be read",
        )
    }

    fn exit_unconfirmed() -> HostError {
        HostError::new(
            "TOOL_EXIT_UNCONFIRMED",
            "External tool exit could not be confirmed; the device remains reserved",
        )
    }
}
