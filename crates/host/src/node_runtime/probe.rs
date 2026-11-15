use super::{Control, NodeRuntimeLimits, VerifiedNodeRuntime, failure};
use serial_workbench_core::{HostResult, NodeRuntimeSelfTest, bundled_node_runtime_release};
use std::{
    io::{self, Read},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

const PROBE: &str = "console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,modulesAbi:process.versions.modules,nodeApiVersion:process.versions.napi,execPath:process.execPath}))";

/// 原始输出只供 Host 私有诊断保存，不实现 wire 序列化或进入错误 details。
#[derive(Debug, Default)]
pub struct NodeRuntimeProbeDiagnostics {
    pub process_id: Option<u32>,
    pub exit_code: Option<i32>,
    pub reaped: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub io_error: Option<String>,
    pub image_cdhash: Option<String>,
    pub image_signature_flags: Option<u32>,
    pub image_sealed: bool,
}
#[derive(Debug)]
pub struct NodeRuntimeProbeReport {
    pub outcome: HostResult<NodeRuntimeSelfTest>,
    pub diagnostics: NodeRuntimeProbeDiagnostics,
}

struct OutputBudget {
    limit: usize,
    received: AtomicUsize,
    exceeded: AtomicBool,
    read_failed: AtomicBool,
}
#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    error: Option<String>,
}
fn start_reader(
    mut pipe: impl Read + Send + 'static,
    budget: Arc<OutputBudget>,
) -> io::Result<JoinHandle<Capture>> {
    thread::Builder::new()
        .name("node-runtime-probe-read".into())
        .spawn(move || {
            let mut result = Capture::default();
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(count) => {
                        let before = budget
                            .received
                            .try_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                                Some(value.saturating_add(count))
                            })
                            .expect("update always succeeds");
                        let keep = count.min(budget.limit.saturating_sub(before));
                        result.bytes.extend_from_slice(&chunk[..keep]);
                        if keep != count {
                            budget.exceeded.store(true, Ordering::Release);
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        result.error = Some(error.to_string());
                        budget.read_failed.store(true, Ordering::Release);
                        break;
                    }
                }
            }
            result
        })
}

enum ProbeStream {
    Stdout,
    Stderr,
}
struct ProbeOwner {
    child: Child,
    readers: Vec<(ProbeStream, JoinHandle<Capture>)>,
    reaped: bool,
}
impl ProbeOwner {
    fn wait(&mut self, stop: bool) -> io::Result<ExitStatus> {
        if stop {
            let _ = self.child.kill();
        }
        loop {
            match self.child.wait() {
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => {
                    self.reaped = result.is_ok();
                    return result;
                }
            }
        }
    }
    fn finish(&mut self, stop: bool, diagnostics: &mut NodeRuntimeProbeDiagnostics) {
        let status = self.wait(stop).or_else(|_| self.wait(true));
        match status {
            Ok(status) => {
                diagnostics.exit_code = status.code();
                diagnostics.reaped = true;
            }
            Err(error) => {
                diagnostics.io_error = Some(error.to_string());
                return;
            }
        }
        for (stream, reader) in self.readers.drain(..) {
            match reader.join() {
                Ok(capture) => {
                    if capture.error.is_some() {
                        diagnostics.io_error = capture.error;
                    }
                    match stream {
                        ProbeStream::Stdout => diagnostics.stdout = capture.bytes,
                        ProbeStream::Stderr => diagnostics.stderr = capture.bytes,
                    }
                }
                Err(_) => diagnostics.io_error = Some("Runtime probe reader failed".into()),
            }
        }
    }
}
impl Drop for ProbeOwner {
    fn drop(&mut self) {
        // 包括线程创建失败、提前返回及 panic：实际退出后再回收读者与句柄。
        if !self.reaped {
            let _ = self.wait(true);
        }
        for (_, reader) in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

impl VerifiedNodeRuntime {
    /// 阻塞的固定脚本自检；取消/超时只在真实进程退出、输出读者结束后返回。
    pub fn self_test(
        &self,
        limits: &NodeRuntimeLimits,
        cancel: &AtomicBool,
    ) -> NodeRuntimeProbeReport {
        let mut diagnostics = NodeRuntimeProbeDiagnostics::default();
        let outcome = self.probe(limits, cancel, &mut diagnostics);
        NodeRuntimeProbeReport {
            outcome,
            diagnostics,
        }
    }

    fn probe(
        &self,
        limits: &NodeRuntimeLimits,
        cancel: &AtomicBool,
        diagnostics: &mut NodeRuntimeProbeDiagnostics,
    ) -> HostResult<NodeRuntimeSelfTest> {
        if limits.max_output_bytes == 0 || limits.max_output_bytes > 1024 * 1024 {
            return Err(failure("INVALID_ARGUMENT", "invalidOutputBudget"));
        }
        let control = Control::new(cancel, limits.probe_timeout, "probeDeadline")?;
        control.check()?;
        let environment = std::env::vars_os().filter(|(key, _)| {
            let key = key.to_string_lossy().to_ascii_uppercase();
            !["NODE_", "LD_", "DYLD_", "OPENSSL_", "_RLD_"]
                .iter()
                .any(|prefix| key.starts_with(prefix))
                && !["GCONV_PATH", "GLIBC_TUNABLES", "MALLOC_TRACE"].contains(&key.as_str())
        });
        #[cfg(target_os = "linux")]
        let executable = self.image.executable();
        #[cfg(not(target_os = "linux"))]
        let executable = &self.executable;
        let mut command = Command::new(executable);
        command
            .args(["--input-type=module", "--eval", PROBE])
            .current_dir(&self.runtime_directory)
            .env_clear()
            .envs(environment)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !self.spec.required_private_libraries.is_empty() {
            // 私有库由封印 fd preload；原目录不能成为其余系统依赖的搜索入口。
            command.env("LD_DEBUG", "libs");
        }
        #[cfg(target_os = "linux")]
        {
            self.image.configure(&mut command);
            diagnostics.image_sealed = true;
        }
        #[cfg(target_os = "macos")]
        self.image.configure(&mut command).map_err(|error| {
            diagnostics.io_error = Some(error.to_string());
            failure("NODE_RUNTIME_START_FAILED", "processConfiguration")
        })?;
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            initialize_headless_errors();
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        control.check()?;
        let child = command.spawn().map_err(|error| {
            diagnostics.io_error = Some(error.to_string());
            let code = if error.kind() == io::ErrorKind::NotFound {
                if self.executable.exists() {
                    "NODE_RUNTIME_DEPENDENCY_MISSING"
                } else {
                    "NODE_RUNTIME_MISSING"
                }
            } else {
                "NODE_RUNTIME_START_FAILED"
            };
            failure(code, "processLaunch")
        })?;
        drop(command);
        diagnostics.process_id = Some(child.id());
        let mut owner = ProbeOwner {
            child,
            readers: Vec::new(),
            reaped: false,
        };
        #[cfg(target_os = "macos")]
        if let Err(error) = self
            .image
            .authenticate_and_resume(&owner.child, &control, diagnostics)
        {
            owner.finish(true, diagnostics);
            return Err(error);
        }
        let budget = Arc::new(OutputBudget {
            limit: limits.max_output_bytes,
            received: AtomicUsize::new(0),
            exceeded: AtomicBool::new(false),
            read_failed: AtomicBool::new(false),
        });
        let stdout = owner.child.stdout.take().expect("piped stdout");
        let stderr = owner.child.stderr.take().expect("piped stderr");
        let readers = [
            (ProbeStream::Stdout, start_reader(stdout, budget.clone())),
            (ProbeStream::Stderr, start_reader(stderr, budget.clone())),
        ];
        let mut reader_error = false;
        for (stream, reader) in readers {
            match reader {
                Ok(reader) => owner.readers.push((stream, reader)),
                Err(error) => {
                    diagnostics.io_error = Some(error.to_string());
                    reader_error = true;
                }
            }
        }
        if reader_error {
            owner.finish(true, diagnostics);
            return Err(failure("NODE_RUNTIME_START_FAILED", "probeReader"));
        }
        let mut stopped = None;
        loop {
            if let Err(error) = control.check() {
                stopped = Some(error);
                break;
            }
            if budget.exceeded.load(Ordering::Acquire) {
                stopped = Some(failure("LIMIT_EXCEEDED", "probeOutput"));
                break;
            }
            if budget.read_failed.load(Ordering::Acquire) {
                stopped = Some(failure("NODE_RUNTIME_START_FAILED", "probeRead"));
                break;
            }
            match owner.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(error) => {
                    diagnostics.io_error = Some(error.to_string());
                    stopped = Some(failure("NODE_RUNTIME_START_FAILED", "processWait"));
                    break;
                }
            }
        }
        owner.finish(stopped.is_some(), diagnostics);
        if let Some(error) = stopped {
            return Err(error);
        }
        if budget.exceeded.load(Ordering::Acquire) {
            return Err(failure("LIMIT_EXCEEDED", "probeOutput"));
        }
        if !diagnostics.reaped || diagnostics.io_error.is_some() {
            return Err(failure("NODE_RUNTIME_START_FAILED", "probeRead"));
        }
        if diagnostics.exit_code != Some(0) {
            let stderr = String::from_utf8_lossy(&diagnostics.stderr);
            let dependency = diagnostics
                .exit_code
                .is_some_and(|code| matches!(code as u32, 0xc0000135 | 0xc000007b))
                || stderr.contains("error while loading shared libraries:")
                || stderr.contains("GLIBC_")
                || stderr.contains("GLIBCXX_")
                || stderr.contains("Library not loaded:");
            return Err(failure(
                if dependency {
                    "NODE_RUNTIME_DEPENDENCY_MISSING"
                } else {
                    "NODE_RUNTIME_START_FAILED"
                },
                "processExit",
            ));
        }
        let probe: NodeRuntimeSelfTest = serde_json::from_slice(&diagnostics.stdout)
            .map_err(|_| failure("NODE_RUNTIME_INCOMPATIBLE", "probeResponse"))?;
        self.spec
            .validate_self_test(bundled_node_runtime_release(), &probe)
            .map_err(|_| failure("NODE_RUNTIME_INCOMPATIBLE", "probeAbi"))?;
        #[cfg(target_os = "linux")]
        let matches_executable = self.image.matches_executable(&probe.exec_path)?;
        #[cfg(not(target_os = "linux"))]
        let matches_executable = std::path::Path::new(&probe.exec_path)
            .canonicalize()
            .map_err(|_| failure("NODE_RUNTIME_INCOMPATIBLE", "probeExecutable"))?
            == self
                .executable
                .canonicalize()
                .map_err(|_| failure("NODE_RUNTIME_INTEGRITY_FAILED", "resourcePath"))?;
        if !matches_executable {
            return Err(failure("NODE_RUNTIME_INCOMPATIBLE", "probeExecutable"));
        }
        if !self.spec.required_private_libraries.is_empty() {
            #[cfg(target_os = "linux")]
            let library = self.image.library();
            #[cfg(not(target_os = "linux"))]
            let library = self
                .runtime_directory
                .join("lib/libatomic.so.1")
                .to_string_lossy()
                .into_owned();
            if !String::from_utf8_lossy(&diagnostics.stderr)
                .lines()
                .any(|line| line.contains("calling init:") && line.trim().ends_with(&library))
            {
                return Err(failure(
                    "NODE_RUNTIME_DEPENDENCY_MISSING",
                    "privateLibraryNotLoaded",
                ));
            }
        }
        Ok(probe)
    }
}

#[cfg(windows)]
pub(super) fn initialize_headless_errors() {
    static INITIALIZED: std::sync::Once = std::sync::Once::new();
    INITIALIZED.call_once(|| {
        use windows_sys::Win32::System::Diagnostics::Debug::{
            GetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX,
            SetErrorMode,
        };
        // 独立后台 Host 没有错误窗口；子进程继承进程模式，缺 DLL 等故障由诊断报告。
        // 只增加标志且不恢复全局旧值，避免并发启动再次打开系统错误对话框。
        unsafe {
            SetErrorMode(
                GetErrorMode()
                    | SEM_FAILCRITICALERRORS
                    | SEM_NOGPFAULTERRORBOX
                    | SEM_NOOPENFILEERRORBOX,
            );
        }
    });
}
