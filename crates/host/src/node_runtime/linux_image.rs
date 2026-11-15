use super::{Control, failure, integrity};
use serial_workbench_core::{HostResult, NodeRuntimeFile};
use sha2::{Digest as _, Sha256};
use std::{
    fs::{self, File},
    io::{self, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{fs::FileExt, process::CommandExt},
    },
    path::PathBuf,
    process::Command,
};

/// 只读 fd 不能冻结 Unix inode；执行与 loader 只消费核哈希后封印的匿名快照。
#[derive(Debug)]
pub(super) struct LinuxRuntimeImage {
    node: File,
    library: File,
}

fn sealed_copy(
    input: &File,
    expected: &NodeRuntimeFile,
    name: &std::ffi::CStr,
    control: &Control<'_>,
) -> HostResult<File> {
    control.check()?;
    let flags = libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING;
    let mut descriptor = unsafe { libc::memfd_create(name.as_ptr(), flags | libc::MFD_EXEC) };
    if descriptor < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
        // Ubuntu 22.04 的原始内核尚无 MFD_EXEC；旧接口默认创建可执行 memfd。
        descriptor = unsafe { libc::memfd_create(name.as_ptr(), flags) };
    }
    if descriptor < 0 {
        return Err(failure("NODE_RUNTIME_START_FAILED", "executionSnapshot"));
    }
    // 从这里起任一错误都由 File 归还真正的内核对象。
    let mut snapshot = unsafe { File::from_raw_fd(descriptor) };
    let mut offset = 0;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        control.check()?;
        let count = match input.read_at(&mut buffer, offset) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => result.map_err(|_| integrity("snapshotRead"))?,
        };
        if count == 0 {
            break;
        }
        offset += count as u64;
        if offset > expected.size.get() {
            return Err(integrity("snapshotSize"));
        }
        hash.update(&buffer[..count]);
        snapshot
            .write_all(&buffer[..count])
            .map_err(|_| failure("NODE_RUNTIME_START_FAILED", "snapshotWrite"))?;
    }
    if offset != expected.size.get() || format!("{:x}", hash.finalize()) != expected.sha256.as_str()
    {
        return Err(integrity("snapshotDigest"));
    }
    let seals = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    if unsafe { libc::fchmod(descriptor, 0o500) } != 0
        || unsafe { libc::fcntl(descriptor, libc::F_ADD_SEALS, seals) } != 0
        || unsafe { libc::fcntl(descriptor, libc::F_GET_SEALS) } != seals
    {
        return Err(failure("NODE_RUNTIME_START_FAILED", "snapshotSeal"));
    }
    control.check()?;
    Ok(snapshot)
}

impl LinuxRuntimeImage {
    pub(super) fn new(
        node: &File,
        executable: &NodeRuntimeFile,
        library: &File,
        library_spec: &NodeRuntimeFile,
        control: &Control<'_>,
    ) -> HostResult<Self> {
        Ok(Self {
            node: sealed_copy(node, executable, c"serial-workbench-node", control)?,
            library: sealed_copy(
                library,
                library_spec,
                c"serial-workbench-libatomic",
                control,
            )?,
        })
    }

    pub(super) fn executable(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.node.as_raw_fd()))
    }

    pub(super) fn library(&self) -> String {
        format!("/proc/self/fd/{}", self.library.as_raw_fd())
    }

    pub(super) fn configure(&self, command: &mut Command) {
        let descriptor = self.library.as_raw_fd();
        command.env("LD_PRELOAD", self.library());
        // 只改变 fork 子进程的 fd 标志；父进程仍 CLOEXEC，其他子进程不会继承它。
        unsafe {
            command.pre_exec(move || {
                let flags = libc::fcntl(descriptor, libc::F_GETFD);
                if flags < 0
                    || libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    pub(super) fn matches_executable(&self, actual: &str) -> HostResult<bool> {
        let path = fs::read_link(self.executable()).map_err(|_| integrity("snapshotIdentity"))?;
        let path = path.to_str().ok_or_else(|| integrity("snapshotIdentity"))?;
        // libuv 的版本可能省略内核给匿名 inode 附加的 deleted 标记。
        Ok(actual == path || Some(actual) == path.strip_suffix(" (deleted)"))
    }
}
