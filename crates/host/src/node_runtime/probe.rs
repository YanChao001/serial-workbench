use super::{Control, NodeRuntimeLimits, RuntimeChild, VerifiedNodeRuntime, failure};
use serial_workbench_core::{HostResult, NodeRuntimeSelfTest};
use std::{
    io::{self, Read},
    process::{ExitStatus, Stdio},
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
    pub launch_errno: Option<i32>,
    pub image_cdhash: Option<String>,
    pub image_signature_flags: Option<u32>,
    pub image_sealed: bool,
}
impl NodeRuntimeProbeDiagnostics {
    fn append_io_error(&mut self, detail: &str) {
        if let Some(error) = &mut self.io_error {
            error.push_str("; ");
            error.push_str(detail);
        } else {
            self.io_error = Some(detail.to_owned());
        }
    }

    #[cfg(target_os = "macos")]
    pub(super) fn record_startup_exit(&mut self, child: &RuntimeChild) {
        if let Some((code, status)) = child.startup_exit() {
            self.append_io_error(&format!(
                "Node exit observed before resume: si_code={code} si_status={status}"
            ));
        }
    }
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
    child: RuntimeChild,
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
                    self.reaped = self.child.is_closed();
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
                diagnostics.append_io_error(&error.to_string());
                diagnostics.reaped = self.child.is_closed();
                if !diagnostics.reaped {
                    return;
                }
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
        let mut command = self.command();
        command
            .args(["--input-type=module", "--eval", PROBE])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !self.spec.required_private_libraries.is_empty() {
            // 私有库由封印 fd preload；原目录不能成为其余系统依赖的搜索入口。
            command.env("LD_DEBUG", "libs");
        }
        let launch = self.configure(&mut command, diagnostics)?;
        control.check()?;
        let child = launch.spawn(command).map_err(|error| {
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
        let mut owner = ProbeOwner {
            child,
            readers: Vec::new(),
            reaped: false,
        };
        if let Err(error) = self.initialize_child(&mut owner.child, &control, diagnostics) {
            if owner.child.id() != 0 {
                diagnostics.process_id = Some(owner.child.id());
            }
            owner.finish(true, diagnostics);
            #[cfg(target_os = "macos")]
            diagnostics.record_startup_exit(&owner.child);
            return Err(error);
        }
        diagnostics.process_id = Some(owner.child.id());
        #[cfg(target_os = "macos")]
        if let Err(error) = self
            .image
            .authenticate(owner.child.id(), &control, diagnostics)
            .and_then(|()| owner.child.resume())
        {
            owner.finish(true, diagnostics);
            diagnostics.record_startup_exit(&owner.child);
            return Err(error);
        }
        let budget = Arc::new(OutputBudget {
            limit: limits.max_output_bytes,
            received: AtomicUsize::new(0),
            exceeded: AtomicBool::new(false),
            read_failed: AtomicBool::new(false),
        });
        let stdout = owner.child.io().stdout.take().expect("piped stdout");
        let stderr = owner.child.io().stderr.take().expect("piped stderr");
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
        self.validate_process_probe(&probe)?;
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
