use serial_workbench_core::{HostError, HostResult};
use std::{
    ffi::{OsStr, c_void},
    fs::{self, File},
    io::{self, Read, Write},
    os::windows::{
        ffi::OsStrExt,
        fs::MetadataExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Component, Path, Prefix},
    pin::Pin,
    ptr::{null, null_mut},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
};
use windows_sys::Win32::{
    Foundation::{GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, LocalFree},
    Security::{
        ACCESS_ALLOWED_ACE, ACL,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        CopySid,
        Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
        DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetLengthSid, GetSecurityDescriptorControl,
        GetTokenInformation, INHERITED_ACE, IsValidSid, OWNER_SECURITY_INFORMATION, PSID,
        SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        CREATE_NEW, CreateDirectoryW, CreateFileW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_TYPE_PIPE, GetFileType, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH, MoveFileExW, OPEN_EXISTING, READ_CONTROL, SECURITY_IDENTIFICATION,
    },
    System::{
        Pipes::{GetNamedPipeClientProcessId, GetNamedPipeInfo, GetNamedPipeServerProcessId},
        Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

const PIPE_PREFIX: &str = r"\\.\pipe\serial-workbench-host-v0-";
const MAX_SECRET: usize = 65536;
const MAX_CIPHERTEXT: usize = 131072;
const MAX_PUBLIC_FILE: usize = 1_048_576;

fn storage_error() -> HostError {
    HostError::new(
        "STORAGE_UNAVAILABLE",
        "Current-user local storage is unavailable",
    )
}
fn denied() -> HostError {
    HostError::new(
        "PERMISSION_DENIED",
        "Local object is not private to the current user",
    )
}
fn invalid() -> HostError {
    HostError::new(
        "INVALID_ARGUMENT",
        "Invalid local endpoint or bounded file input",
    )
}
fn wide(value: &OsStr) -> HostResult<Vec<u16>> {
    let mut result: Vec<_> = value.encode_wide().collect();
    if result.contains(&0) {
        return Err(invalid());
    }
    result.push(0);
    Ok(result)
}

// Win32 LocalAlloc/DPAPI 返回的内存只能通过 LocalFree 释放。
struct LocalMemory(*mut c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct UserSid(Vec<u32>);
impl UserSid {
    fn as_ptr(&self) -> PSID {
        self.0.as_ptr().cast_mut().cast()
    }
    fn for_process(process: HANDLE) -> HostResult<Self> {
        unsafe {
            let mut token = null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return Err(denied());
            }
            let token = OwnedHandle::from_raw_handle(token);
            let mut length = 0;
            GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut length);
            if length < size_of::<TOKEN_USER>() as u32 || length > 65536 {
                return Err(denied());
            }
            // Vec<u8> 不保证 TOKEN_USER 内指针对齐；使用指针宽度的存储。
            let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
            if GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            ) == 0
            {
                return Err(denied());
            }
            let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
            if IsValidSid(user.User.Sid) == 0 {
                return Err(denied());
            }
            let size = GetLengthSid(user.User.Sid);
            if size == 0 || size > 68 {
                return Err(denied());
            }
            let mut sid = Self(vec![0; (size as usize).div_ceil(size_of::<u32>())]);
            if CopySid(size, sid.0.as_mut_ptr().cast(), user.User.Sid) == 0 {
                return Err(denied());
            }
            Ok(sid)
        }
    }
    fn current() -> HostResult<Self> {
        Self::for_process(unsafe { GetCurrentProcess() })
    }
    fn text(&self) -> HostResult<String> {
        unsafe {
            let mut output = null_mut();
            if ConvertSidToStringSidW(self.as_ptr(), &mut output) == 0 {
                return Err(denied());
            }
            let _allocation = LocalMemory(output.cast());
            let mut length = 0;
            while *output.add(length) != 0 {
                length += 1;
            }
            String::from_utf16(std::slice::from_raw_parts(output, length)).map_err(|_| denied())
        }
    }
}

fn descriptor(sid: &str, directory: bool) -> HostResult<LocalMemory> {
    let flags = if directory { "OICI" } else { "" };
    let sddl = wide(OsStr::new(&format!("O:{sid}D:P(A;{flags};FA;;;{sid})")))?;
    let mut output = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut output,
            null_mut(),
        )
    } == 0
    {
        return Err(denied());
    }
    Ok(LocalMemory(output))
}
fn attributes(descriptor: &LocalMemory) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    }
}
fn validate_security(handle: HANDLE, sid: &UserSid) -> HostResult<()> {
    unsafe {
        let mut owner = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut descriptor = null_mut();
        if GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        ) != 0
        {
            return Err(denied());
        }
        let _allocation = LocalMemory(descriptor);
        if owner.is_null()
            || EqualSid(owner, sid.as_ptr()) == 0
            || dacl.is_null()
            || (*dacl).AceCount != 1
        {
            return Err(denied());
        }
        let mut control = 0;
        let mut revision = 0;
        if GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) == 0
            || control & SE_DACL_PROTECTED == 0
        {
            return Err(denied());
        }
        let mut ace = null_mut();
        if GetAce(dacl, 0, &mut ace) == 0 || ace.is_null() {
            return Err(denied());
        }
        let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
        // ACCESS_ALLOWED_ACE_TYPE = 0；不接受 callback/object/deny 或继承 ACE。
        if ace.Header.AceType != 0
            || u32::from(ace.Header.AceFlags) & INHERITED_ACE != 0
            || ace.Mask != FILE_ALL_ACCESS
            || EqualSid(
                std::ptr::addr_of!(ace.SidStart).cast_mut().cast(),
                sid.as_ptr(),
            ) == 0
        {
            return Err(denied());
        }
        Ok(())
    }
}

fn validate_path(path: &Path) -> HostResult<()> {
    if !path.is_absolute() {
        return Err(invalid());
    }
    for component in path.components() {
        match component {
            Component::Prefix(prefix)
                if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) =>
            {
                return Err(invalid());
            }
            Component::ParentDir | Component::CurDir => return Err(invalid()),
            Component::Normal(name)
                if name
                    .encode_wide()
                    .any(|unit| unit == 0 || unit == u16::from(b':')) =>
            {
                return Err(invalid());
            }
            _ => {}
        }
    }
    // 检查全部祖先；只检查末级会允许 junction 父目录绕过私有 namespace。
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 => {
                return Err(denied());
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(storage_error()),
        }
    }
    Ok(())
}
fn open_existing(path: &Path, directory: bool) -> io::Result<File> {
    let name = wide(path.as_os_str()).map_err(io::Error::other)?;
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    let access = READ_CONTROL
        | if directory {
            0x80 /* FILE_READ_ATTRIBUTES */
        } else {
            GENERIC_READ
        };
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            access,
            FILE_SHARE_READ | if directory { FILE_SHARE_WRITE } else { 0 },
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_handle(handle) })
    }
}
fn validate_file(file: &File, directory: bool) -> HostResult<()> {
    let meta = file.metadata().map_err(|_| storage_error())?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
    {
        return Err(denied());
    }
    validate_security(file.as_raw_handle(), &UserSid::current()?)
}
fn private_parent(path: &Path) -> HostResult<File> {
    validate_path(path)?;
    if path.file_name().is_none() {
        return Err(invalid());
    }
    let parent = path.parent().ok_or_else(invalid)?;
    let file = open_existing(parent, true).map_err(|_| storage_error())?;
    validate_file(&file, true)?;
    Ok(file)
}
fn create_private_file(path: &Path) -> HostResult<File> {
    let security = descriptor(&UserSid::current()?.text()?, false)?;
    let attrs = attributes(&security);
    let name = wide(path.as_os_str())?;
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ,
            &attrs,
            CREATE_NEW,
            FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(storage_error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    validate_file(&file, false)?;
    Ok(file)
}

pub enum LocalStream {
    Server(NamedPipeServer),
    Client(NamedPipeClient),
}
impl AsyncRead for LocalStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(s) => Pin::new(s).poll_read(cx, buf),
            Self::Client(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}
impl AsyncWrite for LocalStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Server(s) => Pin::new(s).poll_write(cx, buf),
            Self::Client(s) => Pin::new(s).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(s) => Pin::new(s).poll_flush(cx),
            Self::Client(s) => Pin::new(s).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Server(s) => Pin::new(s).poll_shutdown(cx),
            Self::Client(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}
pub struct LocalListener {
    endpoint: String,
    pending: NamedPipeServer,
    sid: String,
}
fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 128
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}
fn create_pipe(endpoint: &str, sid: &str, first: bool) -> HostResult<NamedPipeServer> {
    let descriptor = descriptor(sid, false)?;
    let mut attrs = attributes(&descriptor);
    // descriptor 与 attributes 保持存活，直到 CreateNamedPipe 返回。
    unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .create_with_security_attributes_raw(
                endpoint,
                (&mut attrs as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
    .map_err(|_| HostError::new("HOST_BUSY", "Local pipe endpoint is unavailable"))
}
impl LocalListener {
    pub fn bind(runtime: &Path, endpoint_tag: &str) -> HostResult<Self> {
        validate_path(runtime)?;
        let directory = open_existing(runtime, true).map_err(|_| storage_error())?;
        validate_file(&directory, true)?;
        if !valid_tag(endpoint_tag) {
            return Err(invalid());
        }
        let endpoint = format!("{PIPE_PREFIX}{endpoint_tag}");
        let sid = UserSid::current()?.text()?;
        let pending = create_pipe(&endpoint, &sid, true)?;
        Ok(Self {
            endpoint,
            pending,
            sid,
        })
    }
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }
    pub async fn accept(&mut self) -> HostResult<LocalStream> {
        self.pending
            .connect()
            .await
            .map_err(|_| HostError::new("UNAUTHENTICATED", "Local pipe connection failed"))?;
        // 始终保留活动实例；移交 connected instance 前先占住下一实例。
        let next = create_pipe(&self.endpoint, &self.sid, false)?;
        Ok(LocalStream::Server(std::mem::replace(
            &mut self.pending,
            next,
        )))
    }
}
pub async fn connect(endpoint: &str) -> HostResult<LocalStream> {
    if !endpoint.strip_prefix(PIPE_PREFIX).is_some_and(valid_tag) {
        return Err(invalid());
    }
    ClientOptions::new()
        .security_qos_flags(SECURITY_IDENTIFICATION)
        .open(endpoint)
        .map(LocalStream::Client)
        .map_err(|_| HostError::new("HOST_BUSY", "Local pipe endpoint is unavailable"))
}
pub fn verify_peer(stream: &LocalStream) -> HostResult<()> {
    unsafe {
        let mut pid = 0;
        let success = match stream {
            LocalStream::Server(pipe) => {
                GetNamedPipeClientProcessId(pipe.as_raw_handle(), &mut pid)
            }
            LocalStream::Client(pipe) => {
                GetNamedPipeServerProcessId(pipe.as_raw_handle(), &mut pid)
            }
        };
        if success == 0 || pid == 0 {
            return Err(denied());
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return Err(denied());
        }
        let process = OwnedHandle::from_raw_handle(process);
        let peer = UserSid::for_process(process.as_raw_handle())?;
        let current = UserSid::current()?;
        if EqualSid(peer.as_ptr(), current.as_ptr()) == 0 {
            return Err(denied());
        }
        Ok(())
    }
}
pub fn prepare_private_directory(path: &Path) -> HostResult<()> {
    validate_path(path)?;
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(invalid)?;
            if !parent.exists() {
                prepare_private_directory(parent)?;
            }
            let descriptor = descriptor(&UserSid::current()?.text()?, true)?;
            let attrs = attributes(&descriptor);
            let name = wide(path.as_os_str())?;
            if unsafe { CreateDirectoryW(name.as_ptr(), &attrs) } == 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(storage_error());
                }
            }
        }
        Err(_) => return Err(storage_error()),
    }
    let directory = open_existing(path, true).map_err(|_| storage_error())?;
    validate_file(&directory, true)
}
fn crypt(bytes: &[u8], protect: bool) -> HostResult<Vec<u8>> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        if protect {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err(storage_error());
    }
    let _allocation = LocalMemory(output.pbData.cast());
    let max = if protect { MAX_CIPHERTEXT } else { MAX_SECRET };
    if output.pbData.is_null() || output.cbData == 0 || output.cbData as usize > max {
        return Err(storage_error());
    }
    Ok(unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec())
}
pub fn read_secret(path: &Path) -> HostResult<Option<Vec<u8>>> {
    let _parent = private_parent(path)?;
    let mut file = match open_existing(path, false) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage_error()),
    };
    validate_file(&file, false)?;
    if file.metadata().map_err(|_| storage_error())?.len() > MAX_CIPHERTEXT as u64 {
        return Err(storage_error());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_CIPHERTEXT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| storage_error())?;
    if bytes.is_empty() || bytes.len() > MAX_CIPHERTEXT {
        return Err(storage_error());
    }
    crypt(&bytes, false).map(Some)
}
pub fn write_secret_new(path: &Path, bytes: &[u8]) -> HostResult<()> {
    if bytes.is_empty() || bytes.len() > MAX_SECRET {
        return Err(invalid());
    }
    let _parent = private_parent(path)?;
    let encrypted = crypt(bytes, true)?;
    let mut file = create_private_file(path)?;
    file.write_all(&encrypted)
        .and_then(|()| file.sync_all())
        .map_err(|_| storage_error())
}
pub fn write_atomic(path: &Path, bytes: &[u8]) -> HostResult<()> {
    if bytes.len() > MAX_PUBLIC_FILE {
        return Err(invalid());
    }
    let _parent = private_parent(path)?;
    match open_existing(path, false) {
        Ok(file) => validate_file(&file, false)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(storage_error()),
    }
    let candidate = path
        .parent()
        .ok_or_else(invalid)?
        .join(format!(".swb-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = create_private_file(&candidate)?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| storage_error())?;
    drop(file);
    let source = wide(candidate.as_os_str())?;
    let destination = wide(path.as_os_str())?;
    // 同目录同卷 rename，不设置 COPY_ALLOWED；失败保留原件与私有候选证据。
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(storage_error());
    }
    Ok(())
}
pub fn write_bootstrap_capability(bytes: &[u8]) -> HostResult<()> {
    if bytes.is_empty() || bytes.len() > 2048 {
        return Err(invalid());
    }
    let stdout = io::stdout();
    if unsafe { GetFileType(stdout.as_raw_handle()) } != FILE_TYPE_PIPE {
        return Err(denied());
    }
    // FILE_TYPE_PIPE 也包括 socket；必须由 pipe 专用查询确认后才能写首字节。
    // 写端查询需要 GENERIC_WRITE 和 FILE_READ_ATTRIBUTES，缺少查询权也拒绝。
    if unsafe {
        GetNamedPipeInfo(
            stdout.as_raw_handle(),
            null_mut(),
            null_mut(),
            null_mut(),
            null_mut(),
        )
    } == 0
    {
        return Err(denied());
    }
    let mut writer = stdout.lock();
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|()| writer.write_all(bytes))
        .and_then(|()| writer.flush())
        .map_err(|_| storage_error())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::windows::{io::AsRawHandle, process::CommandExt},
        process::{Command, Stdio},
        time::Duration,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo,
                SDDL_REVISION_1, SE_FILE_OBJECT,
            },
            DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        },
    };

    // 直接读取内核对象实际 descriptor；不会仅断言实现生成的 SDDL。
    fn dacl_text(handle: std::os::windows::io::RawHandle) -> String {
        unsafe {
            let mut descriptor = std::ptr::null_mut();
            assert_eq!(
                GetSecurityInfo(
                    handle,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut descriptor
                ),
                0
            );
            let mut text = std::ptr::null_mut();
            assert_ne!(
                ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    descriptor,
                    SDDL_REVISION_1,
                    DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
                    &mut text,
                    std::ptr::null_mut()
                ),
                0
            );
            let mut length = 0;
            while *text.add(length) != 0 {
                length += 1;
            }
            let result = String::from_utf16(std::slice::from_raw_parts(text, length)).unwrap();
            LocalFree(text.cast());
            LocalFree(descriptor);
            result
        }
    }
    fn assert_private(handle: std::os::windows::io::RawHandle) {
        let text = dacl_text(handle);
        assert!(text.contains("D:P"), "unprotected DACL: {text}");
        assert_eq!(text.matches("(A;").count(), 1, "extra principals: {text}");
        assert!(!text.contains(";;;WD)") && !text.contains(";;;BA)") && !text.contains(";;;SY)"));
    }
    fn directory() -> (tempfile::TempDir, std::path::PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("private");
        prepare_private_directory(&path).unwrap();
        (temp, path)
    }
    #[test]
    fn private_directory_has_protected_single_user_dacl_and_rejects_inherited_directory() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_temp, path) = directory();
        let dir = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .open(&path)
            .unwrap();
        assert_private(dir.as_raw_handle());
        prepare_private_directory(&path).unwrap();
        let inherited = path.parent().unwrap().join("inherited");
        fs::create_dir(&inherited).unwrap();
        assert!(prepare_private_directory(&inherited).is_err());
    }
    #[test]
    fn secret_is_dpapi_ciphertext_roundtrips_and_never_overwrites() {
        let (_temp, path) = directory();
        let path = path.join("credential");
        assert_eq!(read_secret(&path).unwrap(), None);
        let secret = b"test-current-user-capability-value";
        write_secret_new(&path, secret).unwrap();
        let encrypted = fs::read(&path).unwrap();
        assert!(!encrypted.windows(secret.len()).any(|bytes| bytes == secret));
        assert_eq!(read_secret(&path).unwrap().unwrap(), secret);
        assert_private(fs::File::open(&path).unwrap().as_raw_handle());
        assert!(write_secret_new(&path, b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), encrypted);
    }
    #[test]
    fn corrupt_secret_and_wrong_file_type_are_errors_and_preserve_evidence() {
        let (_temp, dir) = directory();
        let path = dir.join("credential");
        write_atomic(&path, b"invalid-dpapi-data").unwrap();
        assert!(read_secret(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid-dpapi-data");
        assert!(read_secret(&dir).is_err());
        assert!(write_secret_new(&dir.join("empty"), b"").is_err());
        assert!(write_secret_new(&dir.join("oversize"), &vec![7; 65537]).is_err());
    }
    #[test]
    fn atomic_replacement_is_complete_and_refuses_unsafe_parent() {
        use std::os::windows::fs::OpenOptionsExt;
        let (temp, dir) = directory();
        let path = dir.join("discovery.json");
        write_atomic(&path, b"original").unwrap();
        let guard = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        assert!(write_atomic(&path, b"blocked-replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        drop(guard);
        write_atomic(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_private(fs::File::open(&path).unwrap().as_raw_handle());
        assert!(write_atomic(&temp.path().join("unsafe"), b"data").is_err());
        assert!(write_atomic(&dir, b"data").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
    }
    #[test]
    fn junction_parent_and_inherited_secret_are_rejected_without_modifying_target() {
        let (temp, dir) = directory();
        let inherited = dir.join("inherited-secret");
        fs::write(&inherited, b"original-evidence").unwrap();
        assert!(read_secret(&inherited).is_err());
        assert!(write_atomic(&inherited, b"replacement").is_err());
        assert_eq!(fs::read(&inherited).unwrap(), b"original-evidence");
        let secret = dir.join("credential");
        write_secret_new(&secret, b"secret").unwrap();
        let link = temp.path().join("junction");
        let output = Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:SWB_TEST_JUNCTION -Target $env:SWB_TEST_TARGET | Out-Null",
            ])
            .env("SWB_TEST_JUNCTION", &link)
            .env("SWB_TEST_TARGET", &dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "cannot create controlled junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(prepare_private_directory(&link).is_err());
        assert!(read_secret(&link.join("credential")).is_err());
        assert!(write_atomic(&link.join("credential"), b"replacement").is_err());
        assert_eq!(read_secret(&secret).unwrap().unwrap(), b"secret");
        fs::remove_dir(&link).unwrap();
    }
    #[tokio::test]
    async fn named_pipe_has_private_dacl_first_instance_and_real_same_user_peers() {
        let (_temp, dir) = directory();
        let tag = format!("test-{}", uuid::Uuid::new_v4());
        let mut listener = LocalListener::bind(&dir, &tag).unwrap();
        assert!(LocalListener::bind(&dir, &tag).is_err());
        let endpoint = listener.endpoint().to_owned();
        let mut client = connect(&endpoint).await.unwrap();
        let mut server = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let handle = match &server {
            LocalStream::Server(s) => s.as_raw_handle(),
            LocalStream::Client(_) => panic!("wrong side"),
        };
        assert_private(handle);
        client.write_all(b"c").await.unwrap();
        let mut byte = [0];
        server.read_exact(&mut byte).await.unwrap();
        verify_peer(&server).unwrap();
        server.write_all(b"s").await.unwrap();
        client.read_exact(&mut byte).await.unwrap();
        verify_peer(&client).unwrap();
        // 移交连接之后仍有活实例，竞争者不能抢占名称。
        assert!(LocalListener::bind(&dir, &tag).is_err());
        let _next = connect(&endpoint).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .is_ok()
        );
    }
    #[tokio::test]
    async fn remote_or_non_product_endpoints_and_invalid_tags_are_rejected() {
        for endpoint in [
            r"\\remote\pipe\serial-workbench-host-v0-x",
            r"\\.\pipe\other-product",
            "tcp://localhost:1234",
        ] {
            assert!(connect(endpoint).await.is_err());
        }
        let (_temp, dir) = directory();
        for tag in ["", "../bad", r"x\bad", "a:b"] {
            assert!(LocalListener::bind(&dir, tag).is_err());
        }
    }
    #[tokio::test]
    async fn listener_remains_available_when_client_disconnects_before_accept() {
        let (_temp, dir) = directory();
        let mut listener = LocalListener::bind(&dir, &uuid::Uuid::new_v4().to_string()).unwrap();
        let endpoint = listener.endpoint().to_owned();
        drop(connect(&endpoint).await.unwrap());
        let _ = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap();
        let _client = connect(&endpoint).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .is_ok()
        );
    }
    #[test]
    fn bootstrap_only_writes_a_bounded_frame_to_an_inherited_pipe() {
        let exe = std::env::current_exe().unwrap();
        let output = Command::new(&exe)
            .creation_flags(0x08000000)
            .args([
                "--ignored",
                "--exact",
                "windows::tests::bootstrap_driver",
                "--nocapture",
            ])
            .env("SWB_BOOTSTRAP_DRIVER", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // libtest 在进入 driver 前写固定测试进度；driver 后直接退出，帧必须完整位于末尾。
        let frame = [0, 0, 0, 15]
            .into_iter()
            .chain(*b"test-capability")
            .collect::<Vec<_>>();
        assert!(
            output.stdout.ends_with(&frame),
            "bootstrap frame missing or followed by output"
        );
        assert_eq!(
            output
                .stdout
                .windows(15)
                .filter(|bytes| *bytes == b"test-capability")
                .count(),
            1
        );
        let output = Command::new(&exe)
            .creation_flags(0x08000000)
            .args([
                "--ignored",
                "--exact",
                "windows::tests::bootstrap_driver",
                "--nocapture",
            ])
            .env("SWB_BOOTSTRAP_DRIVER", "reject")
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    fn bootstrap_rejects_real_socket_stdout_before_writing_any_bytes() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .creation_flags(0x08000000)
            .args([
                "--ignored",
                "--exact",
                "windows::tests::bootstrap_driver",
                "--nocapture",
            ])
            .env("SWB_BOOTSTRAP_DRIVER", "socket")
            .env(
                "SWB_BOOTSTRAP_SOCKET_ADDRESS",
                listener.local_addr().unwrap().to_string(),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        let (mut receiver, _) = listener
            .accept()
            .expect("driver must connect the real socket");
        receiver
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut received = Vec::new();
        receiver.read_to_end(&mut received).unwrap();
        assert!(
            received.is_empty(),
            "non-pipe stdout received {} bytes",
            received.len()
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[test]
    #[ignore = "仅由父测试启动的受控子进程；不计产品通过"]
    fn bootstrap_driver() {
        let mode = std::env::var("SWB_BOOTSTRAP_DRIVER").expect("controlled driver only");
        if mode == "socket" {
            use std::os::windows::io::AsRawSocket;
            use windows_sys::Win32::System::Console::{STD_OUTPUT_HANDLE, SetStdHandle};
            let stream = std::net::TcpStream::connect(
                std::env::var("SWB_BOOTSTRAP_SOCKET_ADDRESS").unwrap(),
            )
            .unwrap();
            io::stdout().flush().unwrap();
            let original = io::stdout().as_raw_handle();
            let changed =
                unsafe { SetStdHandle(STD_OUTPUT_HANDLE, stream.as_raw_socket() as HANDLE) };
            // 先恢复 stdout，再做任何断言，libtest 文字不进入 socket。
            let file_type = unsafe { GetFileType(io::stdout().as_raw_handle()) };
            let result = write_bootstrap_capability(b"test-capability");
            let restored = unsafe { SetStdHandle(STD_OUTPUT_HANDLE, original) };
            drop(stream);
            assert_ne!(changed, 0);
            assert_ne!(restored, 0);
            assert_eq!(file_type, FILE_TYPE_PIPE);
            assert_eq!(result.unwrap_err().code, "PERMISSION_DENIED");
        } else if mode == "reject" {
            assert!(write_bootstrap_capability(b"test-capability").is_err());
        } else {
            assert!(write_bootstrap_capability(b"").is_err());
            assert!(write_bootstrap_capability(&vec![9; 2049]).is_err());
            write_bootstrap_capability(b"test-capability").unwrap();
        }
        // 避免 libtest 把统计文字写入 capability 管道。
        std::process::exit(0);
    }
}
