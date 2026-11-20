//! Host 只读取同套应用资源；校验失败不会启动另一份 Node 或改变 Rust 基础服务。
mod child;
mod launch;
#[cfg(target_os = "linux")]
mod linux_image;
mod locator;
#[cfg(target_os = "macos")]
mod macos_image;
#[cfg(target_os = "macos")]
mod macos_supervisor;
mod probe;
pub(crate) use child::RuntimeChild;
pub use locator::{installed_node_resource_root, resource_root_for_executable};
pub use probe::{NodeRuntimeProbeDiagnostics, NodeRuntimeProbeReport};
use serial_workbench_core::{
    Digest, HostError, HostResult, NodePackageTarget, NodeRuntimeFile, NodeRuntimeTarget,
    bundled_node_runtime_library, bundled_node_runtime_release, parse_node_runtime_release,
};
use sha2::{Digest as _, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[derive(Debug, Clone)]
pub struct NodeRuntimeLimits {
    pub verification_timeout: Duration,
    pub probe_timeout: Duration,
    pub max_output_bytes: usize,
}
impl Default for NodeRuntimeLimits {
    fn default() -> Self {
        Self {
            verification_timeout: Duration::from_secs(30),
            probe_timeout: Duration::from_secs(10),
            max_output_bytes: 256 * 1024,
        }
    }
}

#[derive(Debug)]
pub struct VerifiedNodeRuntime {
    resource_root: PathBuf,
    executable: PathBuf,
    runtime_directory: PathBuf,
    spec: &'static NodeRuntimeTarget,
    // Windows 拒绝写入/删除共享；持有到自检和实际子进程结束，更新不能提前换文件。
    _files: Vec<File>,
    #[cfg(windows)]
    _paths: RuntimePaths,
    #[cfg(target_os = "linux")]
    image: linux_image::LinuxRuntimeImage,
    #[cfg(target_os = "macos")]
    image: macos_image::MacRuntimeImage,
}
#[cfg(windows)]
struct RuntimePaths(Vec<crate::files::references::PathGuard>);
#[cfg(windows)]
impl std::fmt::Debug for RuntimePaths {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RuntimePaths")
            .field("count", &self.0.len())
            .finish()
    }
}
impl VerifiedNodeRuntime {
    pub fn resource_root(&self) -> &Path {
        &self.resource_root
    }
    pub fn executable(&self) -> &Path {
        &self.executable
    }
    pub fn runtime_directory(&self) -> &Path {
        &self.runtime_directory
    }
    pub fn target(&self) -> NodePackageTarget {
        self.spec.target
    }
}

pub fn current_node_target() -> HostResult<NodePackageTarget> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok(NodePackageTarget::WindowsX64),
        ("macos", "aarch64") => Ok(NodePackageTarget::MacosArm64),
        ("macos", "x86_64") => Ok(NodePackageTarget::MacosX64),
        ("linux", "x86_64") => Ok(NodePackageTarget::LinuxX64),
        _ => Err(failure("NODE_RUNTIME_TARGET_UNSUPPORTED", "hostTarget")),
    }
}

fn failure(code: &str, reason: &str) -> HostError {
    let mut error = HostError::new(code, "Bundled Node runtime is unavailable");
    error.details = Some(Box::new(
        serde_json::from_value(serde_json::json!({
            "component":"nodeRuntime", "reason":reason
        }))
        .expect("static runtime details"),
    ));
    error
}
fn integrity(reason: &str) -> HostError {
    failure("NODE_RUNTIME_INTEGRITY_FAILED", reason)
}

struct Control<'a> {
    cancel: &'a AtomicBool,
    deadline: Instant,
    deadline_reason: &'static str,
}
impl<'a> Control<'a> {
    fn new(
        cancel: &'a AtomicBool,
        budget: Duration,
        deadline_reason: &'static str,
    ) -> HostResult<Self> {
        if budget > Duration::from_secs(120) {
            return Err(failure("INVALID_ARGUMENT", "invalidBudget"));
        }
        Ok(Self {
            cancel,
            deadline_reason,
            deadline: Instant::now()
                .checked_add(budget)
                .ok_or_else(|| failure("INVALID_ARGUMENT", "invalidBudget"))?,
        })
    }
    fn check(&self) -> HostResult<()> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(failure("CANCELLED", "cancelled"));
        }
        if Instant::now() >= self.deadline {
            return Err(failure("NODE_RUNTIME_START_TIMEOUT", self.deadline_reason));
        }
        Ok(())
    }
}

fn is_link(info: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    info.file_type().is_symlink()
}

fn open_file(root: &Path, path: &Path, missing: &str, control: &Control<'_>) -> HostResult<File> {
    let mut next = root.to_path_buf();
    for component in path.components() {
        control.check()?;
        let Component::Normal(name) = component else {
            return Err(integrity("resourcePath"));
        };
        next.push(name);
        let info = fs::symlink_metadata(&next).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                failure(missing, "resourceMissing")
            } else {
                integrity("resourceMetadata")
            }
        })?;
        if is_link(&info) {
            return Err(integrity("resourceLink"));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&next).map_err(|_| integrity("resourceOpen"))?;
    let info = file.metadata().map_err(|_| integrity("resourceMetadata"))?;
    if !info.is_file()
        || is_link(&info)
        || !next
            .canonicalize()
            .map_err(|_| integrity("resourcePath"))?
            .starts_with(root)
    {
        return Err(integrity("resourceType"));
    }
    control.check()?;
    Ok(file)
}

fn read_descriptor(mut file: File, control: &Control<'_>) -> HostResult<Vec<u8>> {
    if file
        .metadata()
        .map_err(|_| integrity("releaseDescriptor"))?
        .len()
        > 64 * 1024
    {
        return Err(integrity("releaseDescriptorBudget"));
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| integrity("releaseDescriptor"))?;
    control.check()?;
    if bytes.len() > 64 * 1024 {
        return Err(integrity("releaseDescriptorBudget"));
    }
    Ok(bytes)
}

fn verify_digest(
    file: &mut File,
    size: u64,
    expected: &Digest,
    control: &Control<'_>,
) -> HostResult<()> {
    if file
        .metadata()
        .map_err(|_| integrity("resourceMetadata"))?
        .len()
        != size
    {
        return Err(integrity("resourceSize"));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| integrity("resourceRead"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut total = 0u64;
    loop {
        control.check()?;
        let count = file
            .read(&mut buffer)
            .map_err(|_| integrity("resourceRead"))?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > size {
            return Err(integrity("resourceSize"));
        }
        hash.update(&buffer[..count]);
    }
    control.check()?;
    if total != size || format!("{:x}", hash.finalize()) != expected.as_str() {
        return Err(integrity("resourceDigest"));
    }
    Ok(())
}

fn verify_file(
    root: &Path,
    expected: &NodeRuntimeFile,
    missing: &str,
    binary_target: Option<NodePackageTarget>,
    control: &Control<'_>,
) -> HostResult<File> {
    let mut file = open_file(
        root,
        Path::new(expected.resource_path.as_str()),
        missing,
        control,
    )?;
    if let Some(target) = binary_target {
        verify_binary_target(&mut file, target, control)?;
    }
    verify_digest(&mut file, expected.size.get(), &expected.sha256, control)?;
    Ok(file)
}

fn verify_binary_target(
    file: &mut File,
    target: NodePackageTarget,
    control: &Control<'_>,
) -> HostResult<()> {
    control.check()?;
    let mut header = [0u8; 64];
    file.seek(SeekFrom::Start(0))
        .and_then(|_| file.read_exact(&mut header))
        .map_err(|_| integrity("binaryHeader"))?;
    let matches = if &header[..2] == b"MZ" {
        let offset = u32::from_le_bytes(header[60..64].try_into().expect("four bytes"));
        if offset > 1024 * 1024 {
            return Err(integrity("binaryHeader"));
        }
        let mut pe = [0u8; 6];
        file.seek(SeekFrom::Start(u64::from(offset)))
            .and_then(|_| file.read_exact(&mut pe))
            .map_err(|_| integrity("binaryHeader"))?;
        if &pe[..4] != b"PE\0\0" {
            return Err(integrity("binaryHeader"));
        }
        target == NodePackageTarget::WindowsX64 && u16::from_le_bytes([pe[4], pe[5]]) == 0x8664
    } else if &header[..4] == b"\x7fELF" {
        target == NodePackageTarget::LinuxX64
            && header[4] == 2
            && header[5] == 1
            && u16::from_le_bytes([header[18], header[19]]) == 62
    } else if u32::from_le_bytes(header[..4].try_into().expect("four bytes")) == 0xfeedfacf {
        let cpu = u32::from_le_bytes(header[4..8].try_into().expect("four bytes"));
        matches!(
            (target, cpu),
            (NodePackageTarget::MacosX64, 0x01000007) | (NodePackageTarget::MacosArm64, 0x0100000c)
        )
    } else {
        return Err(integrity("binaryFormat"));
    };
    control.check()?;
    if !matches {
        return Err(failure("NODE_RUNTIME_TARGET_UNSUPPORTED", "binaryTarget"));
    }
    Ok(())
}

/// root 只由受信任的安装位置定位器传入，不接收客户端路径，不搜索 cwd 或 PATH。
/// 阻塞调用；异步 Host 通过有界 owner 执行，取消后仍等待实际 I/O 完成。
pub fn verify_node_runtime(
    root: &Path,
    limits: &NodeRuntimeLimits,
    cancel: &AtomicBool,
) -> HostResult<VerifiedNodeRuntime> {
    #[cfg(windows)]
    probe::initialize_headless_errors();
    let control = Control::new(cancel, limits.verification_timeout, "verificationDeadline")?;
    control.check()?;
    if !root.is_absolute() {
        return Err(failure("INVALID_ARGUMENT", "absoluteResourceRootRequired"));
    }
    let root = root
        .canonicalize()
        .map_err(|_| failure("NODE_RUNTIME_MISSING", "resourceRoot"))?;
    let descriptor = open_file(
        &root,
        Path::new("runtime/node-release.json"),
        "NODE_RUNTIME_MISSING",
        &control,
    )?;
    let descriptor = parse_node_runtime_release(&read_descriptor(descriptor, &control)?)
        .map_err(|_| integrity("releaseDescriptor"))?;
    let release = bundled_node_runtime_release();
    if descriptor != *release {
        return Err(failure("NODE_RUNTIME_INCOMPATIBLE", "releaseMismatch"));
    }
    let spec = release.for_target(current_node_target()?)?;
    #[cfg(windows)]
    let paths = RuntimePaths(
        [&spec.executable, &spec.license]
            .into_iter()
            .map(|file| {
                control.check()?;
                let path = root.join(file.resource_path.as_str());
                crate::files::references::PathGuard::new(&path).map_err(|_| {
                    if path.parent().is_some_and(|parent| !parent.exists()) {
                        failure("NODE_RUNTIME_MISSING", "resourceDirectory")
                    } else {
                        integrity("resourceDirectory")
                    }
                })
            })
            .collect::<HostResult<Vec<_>>>()?,
    );
    let executable = root.join(spec.executable.resource_path.as_str());
    let runtime_directory = executable
        .parent()
        .and_then(Path::parent)
        .expect("validated runtime path")
        .to_path_buf();
    #[cfg(not(target_os = "macos"))]
    let node = verify_file(
        &root,
        &spec.executable,
        "NODE_RUNTIME_MISSING",
        Some(spec.target),
        &control,
    )?;
    #[cfg(target_os = "macos")]
    let (node, image) = {
        let mut node = open_file(
            &root,
            Path::new(spec.executable.resource_path.as_str()),
            "NODE_RUNTIME_MISSING",
            &control,
        )?;
        verify_binary_target(&mut node, spec.target, &control)?;
        let image = macos_image::MacRuntimeImage::load(&root, spec, &control)?;
        let expected = image.executable(&spec.executable);
        verify_digest(&mut node, expected.size.get(), &expected.sha256, &control)?;
        (node, image)
    };
    let mut files = vec![
        node,
        verify_file(
            &root,
            &spec.license,
            "NODE_RUNTIME_INTEGRITY_FAILED",
            None,
            &control,
        )?,
    ];
    if !spec.required_private_libraries.is_empty() {
        let library = bundled_node_runtime_library();
        for expected in [&library.library, &library.copyright, &library.gpl_license] {
            let mut expected = expected.clone();
            let prefix = runtime_directory
                .strip_prefix(&root)
                .expect("runtime below resource root");
            let path = format!(
                "{}/{}",
                prefix.to_string_lossy().replace('\\', "/"),
                expected.resource_path.as_str()
            );
            expected.resource_path = path
                .as_str()
                .try_into()
                .map_err(|_| integrity("privateLibraryPath"))?;
            files.push(verify_file(
                &root,
                &expected,
                if expected.archive_path == library.library.archive_path {
                    "NODE_RUNTIME_DEPENDENCY_MISSING"
                } else {
                    "NODE_RUNTIME_INTEGRITY_FAILED"
                },
                if expected.archive_path == library.library.archive_path {
                    Some(spec.target)
                } else {
                    None
                },
                &control,
            )?);
        }
        let link = runtime_directory.join(library.soname_link.resource_path.as_str());
        let actual = fs::read_link(&link).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                failure("NODE_RUNTIME_DEPENDENCY_MISSING", "privateLibraryLink")
            } else {
                integrity("privateLibraryLink")
            }
        })?;
        if actual != Path::new(library.soname_link.target.as_str())
            || !link
                .canonicalize()
                .map_err(|_| integrity("privateLibraryLink"))?
                .starts_with(&runtime_directory)
        {
            return Err(integrity("privateLibraryLink"));
        }
    }
    #[cfg(target_os = "linux")]
    let image = linux_image::LinuxRuntimeImage::new(
        &files[0],
        &spec.executable,
        &files[2],
        &bundled_node_runtime_library().library,
        &control,
    )?;
    control.check()?;
    Ok(VerifiedNodeRuntime {
        resource_root: root,
        executable,
        runtime_directory,
        spec,
        _files: files,
        #[cfg(windows)]
        _paths: paths,
        #[cfg(target_os = "linux")]
        image,
        #[cfg(target_os = "macos")]
        image,
    })
}
