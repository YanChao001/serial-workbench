use std::{
    fs::OpenOptions,
    io::{self, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle},
    path::Path,
};
use windows_sys::Win32::System::{JobObjects::*, Threading::GetCurrentProcess};

/// Install before the first WebView starts. The app owns the sole,
/// non-inheritable handle for its process lifetime.
pub(crate) fn contain(receipt: &Path) -> io::Result<()> {
    let mut receipt = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(receipt)?;
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), GetCurrentProcess()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Windows closes the handle at process teardown, including forced termination.
    let _ = job.into_raw_handle();
    writeln!(receipt, "{}", std::process::id())
}
