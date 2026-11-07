//! 当前用户 Unix socket、私有文件及继承管道；实例锁和 endpoint 清理由 Host 持有。

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};

use serial_workbench_core::{HostError, HostResult};
use tokio::net::{UnixListener, UnixStream};

const MAX_SECRET_BYTES: usize = 65_536;
const MAX_PUBLIC_BYTES: usize = 1_048_576;
// macOS sockaddr_un::sun_path 为 104 字节，保留末尾 NUL；Linux 同样接受此长度。
const MAX_SOCKET_PATH_BYTES: usize = 103;

pub type LocalStream = UnixStream;

pub struct LocalListener {
    listener: UnixListener,
    endpoint: String,
}

impl LocalListener {
    /// runtime 已由持有实例锁的 Host 准备；不移除任何现有 endpoint。
    pub fn bind(runtime: &Path, endpoint_tag: &str) -> HostResult<Self> {
        let _directory = open_private_directory(runtime)?;
        if endpoint_tag.is_empty()
            || endpoint_tag.len() > 128
            || !endpoint_tag
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
        {
            return Err(invalid_path());
        }
        let path = runtime.join(format!("ipc-{endpoint_tag}.sock"));
        validate_socket_path(&path)?;
        let endpoint = path.to_str().ok_or_else(invalid_path)?.to_owned();
        let listener = UnixListener::bind(&path).map_err(io_error)?;
        // 私有目录已阻止其他 UID 在 chmod 前访问 socket。
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(io_error)?;
        validate_socket(&path)?;
        Ok(Self { listener, endpoint })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub async fn accept(&mut self) -> HostResult<LocalStream> {
        loop {
            let (stream, _) = self.listener.accept().await.map_err(io_error)?;
            // 对端可能在 accept 前关闭，Darwin 此时无法读取 peer PID。
            // 验证失败只丢弃该连接；监听器本身的 OS 错误仍向调用方返回。
            if verify_peer(&stream).is_ok() {
                return Ok(stream);
            }
        }
    }
}

pub async fn connect(endpoint: &str) -> HostResult<LocalStream> {
    let path = Path::new(endpoint);
    validate_socket_path(path)?;
    let _directory = open_file_parent(path)?;
    validate_socket(path)?;
    let stream = UnixStream::connect(path).await.map_err(io_error)?;
    verify_peer(&stream)?;
    Ok(stream)
}

pub fn verify_peer(stream: &LocalStream) -> HostResult<()> {
    let credential = stream.peer_cred().map_err(io_error)?;
    if credential.uid() != effective_uid() {
        return Err(permission_error());
    }
    Ok(())
}

/// 创建缺失目录；已有不安全目录只拒绝，不修权限或替换原件。
pub fn prepare_private_directory(path: &Path) -> HostResult<()> {
    validate_local_path(path)?;
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, Component::RootDir) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match DirBuilder::new().mode(0o700).create(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(io_error(error)),
                }
                fs::symlink_metadata(&current).map_err(io_error)?
            }
            Err(error) => return Err(io_error(error)),
        };
        if !metadata.file_type().is_dir() {
            return Err(permission_error());
        }
    }
    open_private_directory(path).map(|_| ())
}

pub fn read_secret(path: &Path) -> HostResult<Option<Vec<u8>>> {
    let _directory = open_file_parent(path)?;
    let Some(file) = open_private_file(path)? else {
        return Ok(None);
    };
    let metadata = file.metadata().map_err(io_error)?;
    check_secret_length(metadata.len())?;
    let mut bytes = Vec::new();
    file.take(MAX_SECRET_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    check_secret_length(bytes.len() as u64)?;
    Ok(Some(bytes))
}

pub(crate) fn open_existing_instance_lock(namespace: &Path) -> HostResult<Option<File>> {
    validate_local_path(namespace)?;
    let mut current = PathBuf::new();
    for component in namespace.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err(permission_error()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        }
    }
    let _directory = open_private_directory(namespace)?;
    open_private_file(&namespace.join(crate::INSTANCE_LOCK_NAME))
}

pub(crate) fn open_private_lock_file(path: &Path) -> HostResult<File> {
    let _directory = open_file_parent(path)?;
    if let Some(file) = open_private_file(path)? {
        return Ok(file);
    }
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return open_private_file(path)?.ok_or_else(|| io_error(error));
        }
        Err(error) => return Err(io_error(error)),
    };
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(io_error)?;
    check_private_file(&file.metadata().map_err(io_error)?)?;
    Ok(file)
}

/// create_new 失败时保留原件；写入失败时保留已创建的文件供诊断。
pub fn write_secret_new(path: &Path, bytes: &[u8]) -> HostResult<()> {
    check_secret_length(bytes.len() as u64)?;
    let directory = open_file_parent(path)?;
    let mut file = create_private_file(path)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    directory.sync_all().map_err(io_error)
}

/// 同目录原子替换；rename 前失败保留原件和临时文件，不按年龄清理失败证据。
pub fn write_atomic(path: &Path, bytes: &[u8]) -> HostResult<()> {
    if bytes.len() > MAX_PUBLIC_BYTES {
        return Err(limit_error());
    }
    let directory = open_file_parent(path)?;
    validate_atomic_destination(path)?;
    let parent = path.parent().ok_or_else(invalid_path)?;
    let temporary = parent.join(format!(".ipc-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = create_private_file(&temporary)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    validate_atomic_destination(path)?;
    fs::rename(&temporary, path).map_err(io_error)?;
    // rename 已提交后 fsync 失败也返回错误；调用方必须重读，不能假设未写入。
    directory.sync_all().map_err(io_error)
}

/// 仅向继承的 stdout FIFO 写入原始 capability 帧，拒绝终端、文件、null 和 socket。
pub fn write_bootstrap_capability(bytes: &[u8]) -> HostResult<()> {
    write_bootstrap_to(&mut io::stdout().lock(), bytes)
}

fn write_bootstrap_to<W: Write + AsRawFd>(writer: &mut W, bytes: &[u8]) -> HostResult<()> {
    if bytes.is_empty() || bytes.len() > 2048 {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "Invalid bootstrap capability length",
        ));
    }
    let mut metadata = std::mem::MaybeUninit::<libc::stat>::uninit();
    // fstat 成功才读取输出；借用的描述符在同步写入和 flush 完成前始终存活。
    if unsafe { libc::fstat(writer.as_raw_fd(), metadata.as_mut_ptr()) } != 0 {
        return Err(io_error(io::Error::last_os_error()));
    }
    let metadata = unsafe { metadata.assume_init() };
    if metadata.st_mode & libc::S_IFMT != libc::S_IFIFO {
        return Err(permission_error());
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(io_error)?;
    writer.write_all(bytes).map_err(io_error)?;
    writer.flush().map_err(io_error)
}

fn validate_socket_path(path: &Path) -> HostResult<()> {
    validate_local_path(path)?;
    if path.as_os_str().as_bytes().len() > MAX_SOCKET_PATH_BYTES {
        return Err(limit_error());
    }
    Ok(())
}

fn validate_socket(path: &Path) -> HostResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.file_type().is_socket() {
        return Err(permission_error());
    }
    check_owner_mode(metadata.uid(), metadata.mode(), 0o600)
}

fn validate_local_path(path: &Path) -> HostResult<()> {
    let bytes = path.as_os_str().as_bytes();
    if !path.is_absolute() || bytes.starts_with(b"//") || bytes.contains(&0) {
        return Err(invalid_path());
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::RootDir | Component::Normal(_)))
    {
        return Err(invalid_path());
    }
    Ok(())
}

fn open_file_parent(path: &Path) -> HostResult<File> {
    validate_local_path(path)?;
    if path.file_name().is_none() {
        return Err(invalid_path());
    }
    open_private_directory(path.parent().ok_or_else(invalid_path)?)
}

fn open_private_directory(path: &Path) -> HostResult<File> {
    validate_local_path(path)?;
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if !fs::symlink_metadata(&current)
            .map_err(io_error)?
            .file_type()
            .is_dir()
        {
            return Err(permission_error());
        }
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(io_error)?;
    let metadata = directory.metadata().map_err(io_error)?;
    if !metadata.is_dir() {
        return Err(permission_error());
    }
    check_owner_mode(metadata.uid(), metadata.mode(), 0o700)?;
    Ok(directory)
}

fn open_private_file(path: &Path) -> HostResult<Option<File>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => check_private_file(&metadata)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    }
    // NONBLOCK 防止 leaf 在检查后被换成 FIFO 而永久阻塞；真正打开后再次验证类型和权限。
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(error)),
    };
    check_private_file(&file.metadata().map_err(io_error)?)?;
    Ok(Some(file))
}

fn create_private_file(path: &Path) -> HostResult<File> {
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(io_error)?;
    // mode 参数受 umask 收紧；只对本次 create_new 打开的描述符设置精确私有权限。
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(io_error)?;
    check_private_file(&file.metadata().map_err(io_error)?)?;
    Ok(file)
}

fn validate_atomic_destination(path: &Path) -> HostResult<()> {
    if let Some(file) = open_private_file(path)?
        && file.metadata().map_err(io_error)?.len() > MAX_PUBLIC_BYTES as u64
    {
        return Err(limit_error());
    }
    Ok(())
}

fn check_private_file(metadata: &Metadata) -> HostResult<()> {
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(permission_error());
    }
    check_owner_mode(metadata.uid(), metadata.mode(), 0o600)
}

fn check_owner_mode(uid: u32, mode: u32, expected_mode: u32) -> HostResult<()> {
    if uid != effective_uid() || mode & 0o7777 != expected_mode {
        return Err(permission_error());
    }
    Ok(())
}

fn check_secret_length(length: u64) -> HostResult<()> {
    if length == 0 {
        return Err(HostError::new("INVALID_ARGUMENT", "Secret file is empty"));
    }
    if length > MAX_SECRET_BYTES as u64 {
        return Err(limit_error());
    }
    Ok(())
}

fn effective_uid() -> u32 {
    // geteuid 无指针参数，也不修改进程身份。
    unsafe { libc::geteuid() }
}

fn invalid_path() -> HostError {
    HostError::new("INVALID_ARGUMENT", "Invalid local IPC path")
}

fn permission_error() -> HostError {
    HostError::new(
        "PERMISSION_DENIED",
        "Local IPC permissions or ownership are unsafe",
    )
}

fn limit_error() -> HostError {
    HostError::new(
        "LIMIT_EXCEEDED",
        "Local IPC resource exceeds its size limit",
    )
}

fn io_error(error: io::Error) -> HostError {
    let code = match error.kind() {
        io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
        io::ErrorKind::AlreadyExists | io::ErrorKind::AddrInUse => "HOST_BUSY",
        _ if error.raw_os_error() == Some(libc::ELOOP) => "PERMISSION_DENIED",
        _ => "STORAGE_UNAVAILABLE",
    };
    HostError::new(code, "Local IPC operating system operation failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::FromRawFd;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixStream as StdUnixStream;

    fn private_directory() -> tempfile::TempDir {
        // macOS 的 /var、/tmp 可为系统链接；测试只向规范化后的自有目录写入。
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let directory = tempfile::Builder::new()
            .prefix("sw-ipc-")
            .tempdir_in(base)
            .unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        directory
    }

    #[test]
    fn private_directory_creates_0700_and_rejects_unsafe_existing_directory() {
        let root = private_directory();
        let path = root.path().join("nested/runtime");
        prepare_private_directory(&path).unwrap();
        let metadata = std::fs::metadata(&path).unwrap();
        assert_eq!(metadata.mode() & 0o7777, 0o700);
        assert_eq!(metadata.uid(), effective_uid());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            prepare_private_directory(&path).unwrap_err().code,
            "PERMISSION_DENIED"
        );
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o7777, 0o755);
    }

    #[test]
    fn private_paths_reject_symlink_components_and_nonlocal_names() {
        let root = private_directory();
        let linked = root.path().join("linked");
        symlink(root.path(), &linked).unwrap();
        assert!(prepare_private_directory(&linked).is_err());
        assert!(prepare_private_directory(&linked.join("child")).is_err());
        assert!(prepare_private_directory(Path::new("//remote/share/runtime")).is_err());
        assert!(prepare_private_directory(Path::new("relative/runtime")).is_err());
        assert!(prepare_private_directory(&root.path().join("../escape")).is_err());
    }

    #[test]
    fn owner_and_mode_predicate_rejects_a_different_uid() {
        // 此项只验证拒绝分支；真实 peer 测试在下方使用 OS credential。
        assert!(check_owner_mode(effective_uid(), 0o600, 0o600).is_ok());
        assert!(check_owner_mode(effective_uid().wrapping_add(1), 0o600, 0o600).is_err());
        assert!(check_owner_mode(effective_uid(), 0o660, 0o600).is_err());
    }

    #[test]
    fn secret_round_trip_is_private_and_create_new_does_not_replace() {
        let root = private_directory();
        let path = root.path().join("identity");
        assert_eq!(read_secret(&path).unwrap(), None);
        write_secret_new(&path, b"original").unwrap();
        assert_eq!(read_secret(&path).unwrap(), Some(b"original".to_vec()));
        let metadata = std::fs::metadata(&path).unwrap();
        assert_eq!(metadata.mode() & 0o7777, 0o600);
        assert_eq!(metadata.uid(), effective_uid());
        assert!(write_secret_new(&path, b"replacement").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"original");
        let maximum = root.path().join("maximum");
        write_secret_new(&maximum, &vec![0xa5; 65_536]).unwrap();
        assert_eq!(read_secret(&maximum).unwrap().unwrap(), vec![0xa5; 65_536]);
    }

    #[test]
    fn secret_rejects_symlink_unsafe_mode_hardlink_directory_fifo_and_oversize() {
        let root = private_directory();
        let original = root.path().join("original");
        write_secret_new(&original, b"retained").unwrap();
        let link = root.path().join("link");
        symlink(&original, &link).unwrap();
        assert!(read_secret(&link).is_err());
        assert!(write_secret_new(&link, b"replacement").is_err());
        std::fs::set_permissions(&original, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_secret(&original).is_err());
        assert!(write_secret_new(&original, b"replacement").is_err());
        std::fs::set_permissions(&original, std::fs::Permissions::from_mode(0o600)).unwrap();
        let hardlink = root.path().join("hardlink");
        std::fs::hard_link(&original, &hardlink).unwrap();
        assert!(read_secret(&hardlink).is_err());
        assert!(read_secret(root.path()).is_err());
        let fifo = root.path().join("fifo");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // 仅创建本测试临时目录中的 FIFO，不更改账户或进程身份。
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read_secret(&fifo).is_err());
        let oversized = root.path().join("oversized");
        std::fs::write(&oversized, vec![7; 65_537]).unwrap();
        std::fs::set_permissions(&oversized, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_secret(&oversized).unwrap_err().code, "LIMIT_EXCEEDED");
        assert!(write_secret_new(&root.path().join("empty"), b"").is_err());
        let empty = root.path().join("empty-on-disk");
        std::fs::write(&empty, b"").unwrap();
        std::fs::set_permissions(&empty, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_secret(&empty).unwrap_err().code, "INVALID_ARGUMENT");
        assert!(write_secret_new(&root.path().join("too-large"), &vec![7; 65_537]).is_err());
        assert!(!root.path().join("too-large").exists());
        assert_eq!(std::fs::read(&original).unwrap(), b"retained");
    }

    #[tokio::test]
    async fn socket_is_private_and_both_ends_have_current_user_peer() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let root = private_directory();
        let mut listener = LocalListener::bind(root.path(), "host-a").unwrap();
        let metadata = std::fs::symlink_metadata(listener.endpoint()).unwrap();
        assert!(metadata.file_type().is_socket());
        assert_eq!(metadata.mode() & 0o7777, 0o600);
        assert_eq!(metadata.uid(), effective_uid());
        let mut client = connect(listener.endpoint()).await.unwrap();
        let mut server = listener.accept().await.unwrap();
        verify_peer(&server).unwrap();
        verify_peer(&client).unwrap();
        assert_eq!(server.peer_cred().unwrap().uid(), effective_uid());
        client.write_all(b"local").await.unwrap();
        let mut bytes = [0; 5];
        server.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"local");
    }

    #[tokio::test]
    async fn binding_conflict_does_not_steal_the_live_socket() {
        let root = private_directory();
        let mut first = LocalListener::bind(root.path(), "same").unwrap();
        let original = std::fs::symlink_metadata(first.endpoint()).unwrap();
        assert_eq!(
            LocalListener::bind(root.path(), "same").err().unwrap().code,
            "HOST_BUSY"
        );
        let current = std::fs::symlink_metadata(first.endpoint()).unwrap();
        assert_eq!(
            (current.dev(), current.ino()),
            (original.dev(), original.ino())
        );
        let _client = connect(first.endpoint()).await.unwrap();
        let _server = first.accept().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn disconnected_peer_does_not_stop_accepting_verified_connections() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = private_directory();
        let mut listener = LocalListener::bind(root.path(), "disconnected").unwrap();
        // 在 accept 之前关闭，确定触发 Darwin LOCAL_PEEREPID 的 ENOTCONN 分支。
        drop(StdUnixStream::connect(listener.endpoint()).unwrap());
        let mut client = connect(listener.endpoint()).await.unwrap();
        client.write_all(b"live").await.unwrap();
        let mut server = tokio::time::timeout(std::time::Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        verify_peer(&server).unwrap();
        let mut bytes = [0; 4];
        server.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes, b"live");
    }

    #[tokio::test]
    async fn socket_rejects_long_or_non_socket_endpoints_and_unsafe_runtime() {
        let root = private_directory();
        assert!(LocalListener::bind(root.path(), "../escape").is_err());
        let long = root.path().join("a".repeat(104));
        prepare_private_directory(&long).unwrap();
        assert_eq!(
            LocalListener::bind(&long, "host").err().unwrap().code,
            "LIMIT_EXCEEDED"
        );
        let file = root.path().join("file");
        write_secret_new(&file, b"not a socket").unwrap();
        assert!(connect(file.to_str().unwrap()).await.is_err());
        let listener = LocalListener::bind(root.path(), "permissions").unwrap();
        std::fs::set_permissions(listener.endpoint(), std::fs::Permissions::from_mode(0o666))
            .unwrap();
        assert!(connect(listener.endpoint()).await.is_err());
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(LocalListener::bind(root.path(), "unsafe").is_err());
        // listener 不负责移除 endpoint；持锁 Host 才能进行生命周期清理。
        let endpoint = listener.endpoint().to_owned();
        drop(listener);
        assert!(
            std::fs::symlink_metadata(endpoint)
                .unwrap()
                .file_type()
                .is_socket()
        );
    }

    #[test]
    fn atomic_write_replaces_a_complete_private_file_and_preserves_bad_destination() {
        let root = private_directory();
        let path = root.path().join("discovery");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"complete replacement").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"complete replacement");
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o7777, 0o600);
        let bad = root.path().join("bad");
        symlink(&path, &bad).unwrap();
        assert!(write_atomic(&bad, b"damaged").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"complete replacement");
        assert!(write_atomic(&path, &vec![0; 1_048_577]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"complete replacement");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(write_atomic(&path, b"damaged").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"complete replacement");
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
    }

    #[test]
    fn bootstrap_writes_big_endian_length_only_to_an_actual_pipe() {
        let mut descriptors = [-1; 2];
        // 成功返回后立即把两个描述符交给 File，测试结束关闭自有管道。
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        let mut reader = unsafe { File::from_raw_fd(descriptors[0]) };
        let mut writer = unsafe { File::from_raw_fd(descriptors[1]) };
        assert!(write_bootstrap_to(&mut writer, b"").is_err());
        assert!(write_bootstrap_to(&mut writer, &vec![0; 2049]).is_err());
        write_bootstrap_to(&mut writer, &[0xff, 0x00, 0x81]).unwrap();
        write_bootstrap_to(&mut writer, &vec![0xa5; 2048]).unwrap();
        drop(writer);
        let mut actual = Vec::new();
        reader.read_to_end(&mut actual).unwrap();
        assert_eq!(actual.len(), 2059);
        assert_eq!(&actual[..7], [0, 0, 0, 3, 0xff, 0x00, 0x81]);
        assert_eq!(&actual[7..11], [0, 0, 8, 0]);
        assert!(actual[11..].iter().all(|byte| *byte == 0xa5));
        let mut regular = tempfile::tempfile().unwrap();
        assert!(write_bootstrap_to(&mut regular, b"secret").is_err());
        assert_eq!(regular.metadata().unwrap().len(), 0);
        let mut null = OpenOptions::new().write(true).open("/dev/null").unwrap();
        assert!(write_bootstrap_to(&mut null, b"secret").is_err());
        let (mut socket, _) = StdUnixStream::pair().unwrap();
        assert!(write_bootstrap_to(&mut socket, b"secret").is_err());
    }

    #[test]
    fn bootstrap_stdout_accepts_inherited_pipe_and_rejects_null() {
        for (mode, stdout) in [
            ("pipe", std::process::Stdio::piped()),
            ("null", std::process::Stdio::null()),
        ] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "unix::tests::bootstrap_child_helper",
                    "--ignored",
                    "--nocapture",
                ])
                .env("SW_IPC_BOOTSTRAP_TEST", mode)
                .stdout(stdout)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "bootstrap helper failed: {:?}",
                output.status
            );
            if mode == "pipe" {
                // libtest 也使用 stdout；只核对 helper 写入的独立二进制帧。
                assert!(
                    output
                        .stdout
                        .windows(7)
                        .any(|bytes| bytes == [0, 0, 0, 3, 0xff, 0x00, 0x81])
                );
            }
        }
    }

    #[test]
    #[ignore = "只由父测试设置 stdout 类型后调用，不计为独立通过项"]
    fn bootstrap_child_helper() {
        let result = write_bootstrap_capability(&[0xff, 0x00, 0x81]);
        match std::env::var("SW_IPC_BOOTSTRAP_TEST").as_deref() {
            Ok("pipe") => assert!(result.is_ok()),
            Ok("null") => assert!(result.is_err()),
            _ => panic!("bootstrap helper requires its parent test"),
        }
    }
}
