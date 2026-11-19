use super::probe::NodeRuntimeProbeDiagnostics;
use super::{Control, failure, integrity, macos_supervisor, open_file, read_descriptor};
use serde::Deserialize;
use serial_workbench_core::{
    Digest, HostResult, NodePackageTarget, NodeRuntimeFile, NodeRuntimeTarget, U64,
};
use sha2::{Digest as _, Sha256};
use std::{
    cell::UnsafeCell, ffi::CString, io, os::unix::ffi::OsStrExt, path::Path, process::Command,
};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MacRuntimeImage {
    schema_version: String,
    target: NodePackageTarget,
    source_sha256: Digest,
    size: U64,
    sha256: Digest,
    code_directory_hash: String,
    entitlements_sha256: Digest,
}

impl MacRuntimeImage {
    pub(super) fn load(
        root: &Path,
        spec: &NodeRuntimeTarget,
        control: &Control<'_>,
    ) -> HostResult<Self> {
        let compiled: Option<Self> = serde_json::from_slice(include_bytes!(concat!(
            env!("OUT_DIR"),
            "/node-runtime-build-image.json"
        )))
        .map_err(|_| integrity("compiledImageBinding"))?;
        let image =
            compiled.ok_or_else(|| failure("NODE_RUNTIME_INCOMPATIBLE", "unboundRuntimeImage"))?;
        let policy = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../resources/runtime/node-entitlements.plist"
        ));
        let policy_hash = format!("{:x}", Sha256::digest(policy));
        if image.schema_version != "0.1"
            || image.target != spec.target
            || image.source_sha256 != spec.executable.sha256
            || image.size.get() == 0
            || image.size.get() > 256 * 1024 * 1024
            || image.entitlements_sha256.as_str() != policy_hash
            || image.code_directory_hash.len() != 40
            || !image
                .code_directory_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(integrity("compiledImageBinding"));
        }
        let record = open_file(
            root,
            Path::new("runtime/node-image.json"),
            "NODE_RUNTIME_MISSING",
            control,
        )?;
        let actual: Self = serde_json::from_slice(&read_descriptor(record, control)?)
            .map_err(|_| integrity("installedImageBinding"))?;
        if actual != image {
            return Err(integrity("installedImageBinding"));
        }
        Ok(image)
    }

    pub(super) fn executable(&self, source: &NodeRuntimeFile) -> NodeRuntimeFile {
        let mut executable = source.clone();
        executable.size = self.size;
        executable.sha256 = self.sha256.clone();
        executable
    }

    pub(super) fn configure(
        &self,
        command: &mut Command,
    ) -> io::Result<macos_supervisor::Prepared> {
        let exec = SuspendedExec::new(command)?;
        macos_supervisor::Prepared::configure(command, exec)
    }

    pub(super) fn authenticate(
        &self,
        process_id: u32,
        control: &Control<'_>,
        diagnostics: &mut NodeRuntimeProbeDiagnostics,
    ) -> HostResult<()> {
        control.check()?;
        let pid: libc::pid_t = process_id
            .try_into()
            .map_err(|_| integrity("processIdentity"))?;
        let mut status: u32 = 0;
        let mut cdhash = [0u8; 20];
        // csops 读取内核的主可执行 vnode 身份，不信任 Node 自报或重新打开同名路径。
        let read_status = unsafe {
            csops(
                pid,
                0,
                (&mut status as *mut u32).cast(),
                std::mem::size_of::<u32>(),
            )
        };
        let status_errno = (read_status != 0).then(|| io::Error::last_os_error().raw_os_error());
        let read_hash = unsafe { csops(pid, 5, cdhash.as_mut_ptr().cast(), cdhash.len()) };
        let hash_errno = (read_hash != 0).then(|| io::Error::last_os_error().raw_os_error());
        const REQUIRED: u32 = 0x1 | 0x100 | 0x200 | 0x10000; // VALID / HARD / KILL / RUNTIME
        const DISALLOWED: u32 = 0x4 | 0x20 | 0x10000000; // GET_TASK_ALLOW / INVALID_ALLOWED / DEBUGGED
        let actual: String = cdhash.iter().map(|byte| format!("{byte:02x}")).collect();
        if read_status == 0 {
            diagnostics.image_signature_flags = Some(status);
        }
        if read_hash == 0 {
            diagnostics.image_cdhash = Some(actual.clone());
        }
        if read_status != 0 || read_hash != 0 {
            diagnostics.io_error = Some(format!(
                "csops status: return={read_status} errno={:?}, cdhash: return={read_hash} errno={:?}",
                status_errno.flatten(),
                hash_errno.flatten(),
            ));
        }
        if read_status != 0
            || read_hash != 0
            || status & REQUIRED != REQUIRED
            || status & DISALLOWED != 0
            || actual != self.code_directory_hash
        {
            return Err(integrity("processSignature"));
        }
        control.check()
    }
}

unsafe extern "C" {
    fn csops(
        pid: libc::pid_t,
        operations: u32,
        address: *mut libc::c_void,
        size: usize,
    ) -> libc::c_int;
}

pub(super) struct SuspendedExec {
    path: CString,
    _arguments: Vec<CString>,
    _environment: Vec<CString>,
    argument_pointers: Vec<*mut libc::c_char>,
    environment_pointers: Vec<*mut libc::c_char>,
    attributes: libc::posix_spawnattr_t,
    group_argument: Box<UnsafeCell<[libc::c_char; 11]>>,
}
// 指针引用稳定自有存储；固定PID参数槽仅由fork后的Node子分支写入，父进程不修改。
unsafe impl Send for SuspendedExec {}
unsafe impl Sync for SuspendedExec {}

fn cstring(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Invalid runtime process input"))
}

impl SuspendedExec {
    fn new(command: &Command) -> io::Result<Self> {
        let path = cstring(command.get_program().as_bytes())?;
        let mut arguments = vec![path.clone()];
        for argument in command.get_args() {
            arguments.push(cstring(argument.as_bytes())?);
        }
        let mut environment = Vec::new();
        for (key, value) in command.get_envs() {
            if let Some(value) = value {
                let mut entry = key.as_bytes().to_vec();
                entry.push(b'=');
                entry.extend_from_slice(value.as_bytes());
                environment.push(cstring(&entry)?);
            }
        }
        let pointers = |values: &[CString]| {
            values
                .iter()
                .map(|value| value.as_ptr().cast_mut())
                .chain(std::iter::once(std::ptr::null_mut()))
                .collect()
        };
        let mut attributes = std::ptr::null_mut();
        let result = unsafe { libc::posix_spawnattr_init(&mut attributes) };
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        let group_argument = Box::new(UnsafeCell::new([0; 11]));
        let mut argument_pointers: Vec<*mut libc::c_char> = pointers(&arguments);
        argument_pointers.insert(argument_pointers.len() - 1, group_argument.get().cast());
        let mut value = Self {
            argument_pointers,
            environment_pointers: pointers(&environment),
            path,
            _arguments: arguments,
            _environment: environment,
            attributes,
            group_argument,
        };
        let flags =
            (libc::POSIX_SPAWN_SETEXEC | libc::POSIX_SPAWN_START_SUSPENDED) as libc::c_short;
        let result = unsafe { libc::posix_spawnattr_setflags(&mut value.attributes, flags) };
        if result != 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        Ok(value)
    }

    pub(super) fn replace(&self, group: libc::pid_t) -> io::Result<()> {
        // 预分配槽写入实际组身份；fork后不格式化、不分配、不调用setenv。
        let buffer = unsafe { &mut *self.group_argument.get() };
        let mut number = group as u32;
        let mut start = 10;
        loop {
            start -= 1;
            buffer[start] = (b'0' + (number % 10) as u8) as libc::c_char;
            number /= 10;
            if number == 0 {
                break;
            }
        }
        buffer.copy_within(start..10, 0);
        buffer[10 - start] = 0;
        let mut pid = 0;
        let result = unsafe {
            libc::posix_spawn(
                &mut pid,
                self.path.as_ptr(),
                std::ptr::null(),
                &self.attributes,
                self.argument_pointers.as_ptr(),
                self.environment_pointers.as_ptr(),
            )
        };
        // SETEXEC 成功不返回，失败保留 Rust Command 的 exec-error 管道责任。
        Err(io::Error::from_raw_os_error(if result == 0 {
            libc::EIO
        } else {
            result
        }))
    }
}
impl Drop for SuspendedExec {
    fn drop(&mut self) {
        unsafe {
            libc::posix_spawnattr_destroy(&mut self.attributes);
        }
    }
}
