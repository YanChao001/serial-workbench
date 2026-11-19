//! 只观察原生进程的内核唯一身份，不向可能复用的数字PID发信号。
use std::io;

// 对照macOS 14和当前Apple头文件：flavor 17、56字节布局及unique字段偏移相同。
// https://github.com/apple-oss-distributions/xnu/blob/xnu-10002.1.13/bsd/sys/proc_info_private.h
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h
#[repr(C)]
struct UniqueIdentifier {
    uuid: [u8; 16],
    unique: u64,
    parent_unique: u64,
    id_version: i32,
    original_parent_version: i32,
    reserved: [u64; 2],
}
const _: () = assert!(std::mem::size_of::<UniqueIdentifier>() == 56);

// 此函数也用于fork后的原生分支：只使用栈、libproc系统调用和OS错误值。
pub(super) fn read(pid: u32) -> io::Result<Option<u64>> {
    loop {
        let mut info: UniqueIdentifier = unsafe { std::mem::zeroed() };
        unsafe { *libc::__error() = 0 };
        let count = unsafe {
            libc::proc_pidinfo(
                pid as libc::pid_t,
                17, // PROC_PIDUNIQIDENTIFIERINFO
                1,  // 同时查找zombie，直到该唯一进程真正被回收。
                (&mut info as *mut UniqueIdentifier).cast(),
                std::mem::size_of::<UniqueIdentifier>() as libc::c_int,
            )
        };
        if count == std::mem::size_of::<UniqueIdentifier>() as libc::c_int && info.unique != 0 {
            return Ok(Some(info.unique));
        }
        let code = unsafe { *libc::__error() };
        match code {
            libc::EINTR => continue,
            libc::ESRCH => return Ok(None),
            0 => return Err(io::Error::from_raw_os_error(libc::EIO)),
            _ => return Err(io::Error::from_raw_os_error(code)),
        }
    }
}
