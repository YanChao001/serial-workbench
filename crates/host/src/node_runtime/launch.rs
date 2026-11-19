use super::{
    Control, NodeRuntimeProbeDiagnostics, RuntimeChild, VerifiedNodeRuntime, child, failure,
};
use serial_workbench_core::{HostResult, NodeRuntimeSelfTest, bundled_node_runtime_release};
use std::{
    process::{Command, Stdio},
    sync::atomic::AtomicBool,
    time::Duration,
};

impl VerifiedNodeRuntime {
    pub(super) fn initialize_child(
        &self,
        child: &mut RuntimeChild,
        control: &Control<'_>,
        diagnostics: &mut NodeRuntimeProbeDiagnostics,
    ) -> HostResult<()> {
        let initialized = child.initialize(control, diagnostics);
        #[cfg(target_os = "macos")]
        if diagnostics.launch_errno == Some(libc::ENOENT) {
            return Err(failure(
                if self.executable.exists() {
                    "NODE_RUNTIME_DEPENDENCY_MISSING"
                } else {
                    "NODE_RUNTIME_MISSING"
                },
                "processLaunch",
            ));
        }
        initialized
    }
    pub(super) fn command(&self) -> Command {
        #[cfg(target_os = "linux")]
        let executable = self.image.executable();
        #[cfg(not(target_os = "linux"))]
        let executable = &self.executable;
        let environment = std::env::vars_os().filter(|(key, _)| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            !["NODE_", "LD_", "DYLD_", "OPENSSL_", "_RLD_"]
                .iter()
                .any(|prefix| key.starts_with(prefix))
                && !["GCONV_PATH", "GLIBC_TUNABLES", "MALLOC_TRACE"].contains(&key.as_str())
        });
        let mut command = Command::new(executable);
        command
            .current_dir(&self.runtime_directory)
            .env_clear()
            .envs(environment);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            super::probe::initialize_headless_errors();
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        command
    }

    pub(super) fn configure(
        &self,
        command: &mut Command,
        diagnostics: &mut NodeRuntimeProbeDiagnostics,
    ) -> HostResult<child::Launch> {
        #[cfg(target_os = "linux")]
        {
            self.image.configure(command);
            diagnostics.image_sealed = true;
        }
        #[cfg(target_os = "macos")]
        let supervisor = {
            super::macos_supervisor::validate_parent_wait_policy()?;
            self.image.configure(command).map_err(|error| {
                diagnostics.io_error = Some(error.to_string());
                failure("NODE_RUNTIME_START_FAILED", "processConfiguration")
            })?
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let _ = (command, diagnostics);
        Ok(child::Launch {
            #[cfg(target_os = "macos")]
            supervisor,
        })
    }

    pub(crate) fn validate_process_probe(&self, probe: &NodeRuntimeSelfTest) -> HostResult<()> {
        self.spec
            .validate_self_test(bundled_node_runtime_release(), probe)
            .map_err(|_| failure("NODE_RUNTIME_INCOMPATIBLE", "probeAbi"))?;
        #[cfg(target_os = "linux")]
        let matches = self.image.matches_executable(&probe.exec_path)?;
        #[cfg(not(target_os = "linux"))]
        let matches = std::path::Path::new(&probe.exec_path)
            .canonicalize()
            .map_err(|_| failure("NODE_RUNTIME_INCOMPATIBLE", "probeExecutable"))?
            == self
                .executable
                .canonicalize()
                .map_err(|_| failure("NODE_RUNTIME_INTEGRITY_FAILED", "resourcePath"))?;
        if !matches {
            return Err(failure("NODE_RUNTIME_INCOMPATIBLE", "probeExecutable"));
        }
        Ok(())
    }

    pub(crate) fn spawn_backend(
        &self,
        program: &str,
        timeout: Duration,
        cancel: &AtomicBool,
        mut observe: impl FnMut(u32, bool, Option<i32>),
    ) -> HostResult<RuntimeChild> {
        let control = Control::new(cancel, timeout, "backendStartupDeadline")?;
        control.check()?;
        let mut diagnostics = NodeRuntimeProbeDiagnostics::default();
        let mut command = self.command();
        command
            .args(["--input-type=module", "--eval", program])
            .arg("--")
            .arg(std::process::id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let launch = self.configure(&mut command, &mut diagnostics)?;
        control.check()?;
        let mut child = launch
            .spawn(command)
            .map_err(|_| failure("NODE_RUNTIME_START_FAILED", "backendLaunch"))?;
        let started = (|| {
            self.initialize_child(&mut child, &control, &mut diagnostics)?;
            observe(child.id(), false, None);
            #[cfg(target_os = "macos")]
            {
                self.image
                    .authenticate(child.id(), &control, &mut diagnostics)?;
                child.resume()?;
            }
            Ok(())
        })();
        if let Err(error) = started {
            let _ = child.kill();
            loop {
                match child.wait() {
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Ok(status) => {
                        observe(child.id(), true, status.code());
                        break;
                    }
                    Err(_) if child.is_closed() => {
                        observe(child.id(), true, None);
                        break;
                    }
                    Err(_) => {
                        return Err(failure("NODE_OWNER_EXIT_UNCONFIRMED", "backendStartupReap"));
                    }
                }
            }
            return Err(error);
        }
        Ok(child)
    }
}
