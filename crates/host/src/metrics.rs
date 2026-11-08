//! 只观测既有 Host 预算与本进程 OS RSS，不创建 reader 或采样后台任务。
use crate::{auth::HostIdentity, capture::CaptureMemory, stream::StreamMemory};
use serial_workbench_core::{Clock, HostError, HostMetrics, HostResult, MemoryBudget};

/// 内存值必须来自当前 Host 的既有服务；Linux proc 读取由调用方放入 blocking 路径。
pub fn snapshot(
    identity: &HostIdentity,
    stream: StreamMemory,
    capture: CaptureMemory,
    clock: &dyn Clock,
) -> HostResult<HostMetrics> {
    let (rss_bytes, rss_peak_bytes) = process_memory()?;
    Ok(HostMetrics {
        host_id: identity.host_id.clone(),
        instance_epoch: identity.instance_epoch,
        observed_at: clock.wall_time(),
        process_id: u64::from(std::process::id()).into(),
        rss_bytes: rss_bytes.into(),
        rss_peak_bytes: rss_peak_bytes.into(),
        source: budget(stream.source_bytes, stream.source_peak, stream.source_limit),
        reader: budget(stream.reader_bytes, stream.reader_peak, stream.reader_limit),
        capture_queue: budget(
            capture.queued_bytes,
            capture.peak_queued_bytes,
            capture.queue_limit,
        ),
    })
}

fn budget(used: usize, peak: usize, limit: usize) -> MemoryBudget {
    MemoryBudget {
        used_bytes: (used as u64).into(),
        peak_bytes: (peak as u64).into(),
        limit_bytes: (limit as u64).into(),
    }
}

fn unavailable() -> HostError {
    HostError::new(
        "METRICS_UNAVAILABLE",
        "Host process memory metrics are unavailable",
    )
}

#[cfg(windows)]
fn process_memory() -> HostResult<(u64, u64)> {
    use windows_sys::Win32::System::{
        ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
        Threading::GetCurrentProcess,
    };

    let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // 结构没有无效的零位模式，cb 和输出缓冲区长度与 Win32 ABI 一致。
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = size;
    // 当前进程伪句柄不需要关闭；内核填写同一次查询的当前工作集和生命周期峰值。
    if unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) } == 0 {
        return Err(unavailable());
    }
    Ok((
        counters.WorkingSetSize as u64,
        counters.PeakWorkingSetSize as u64,
    ))
}

#[cfg(target_os = "linux")]
fn process_memory() -> HostResult<(u64, u64)> {
    let status = std::fs::read_to_string("/proc/self/status").map_err(|_| unavailable())?;
    linux_status_memory(&status)
}

#[cfg(any(target_os = "linux", test))]
fn linux_status_memory(status: &str) -> HostResult<(u64, u64)> {
    fn field(status: &str, name: &str) -> HostResult<u64> {
        let raw = status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .ok_or_else(unavailable)?;
        let mut parts = raw.split_ascii_whitespace();
        let value = parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(unavailable)?;
        if parts.next() != Some("kB") || parts.next().is_some() {
            return Err(unavailable());
        }
        value.checked_mul(1024).ok_or_else(unavailable)
    }
    Ok((field(status, "VmRSS:")?, field(status, "VmHWM:")?))
}

#[cfg(target_os = "macos")]
fn process_memory() -> HostResult<(u64, u64)> {
    let mut info = std::mem::MaybeUninit::<libc::mach_task_basic_info>::zeroed();
    let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
    // 锁定 libc 已提供该 ABI；仅在此复用其现有 task-self 接口，避免另加依赖包。
    #[allow(deprecated)]
    let task = unsafe { libc::mach_task_self() };
    // 缓冲区与 count 对应同一 MACH_TASK_BASIC_INFO ABI，成功后才读取输出。
    let result = unsafe {
        libc::task_info(
            task,
            libc::MACH_TASK_BASIC_INFO,
            info.as_mut_ptr().cast(),
            &mut count,
        )
    };
    if result != libc::KERN_SUCCESS || count < libc::MACH_TASK_BASIC_INFO_COUNT {
        return Err(unavailable());
    }
    let info = unsafe { info.assume_init() };
    Ok((info.resident_size, info.resident_size_max))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn process_memory() -> HostResult<(u64, u64)> {
    Err(unavailable())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_status_converts_kernel_kib_to_bytes() {
        let status = "Name:\thost\nVmSize:\t999 kB\nVmHWM:\t8192 kB\nVmRSS:\t4096 kB\n";
        assert_eq!(linux_status_memory(status).unwrap(), (4_194_304, 8_388_608));
    }

    #[test]
    fn linux_status_rejects_missing_fields_wrong_units_and_overflow() {
        for status in [
            "VmRSS: 4 kB\n",
            "VmHWM: 8 kB\n",
            "VmRSS: -1 kB\nVmHWM: 8 kB\n",
            "VmRSS: 4 bytes\nVmHWM: 8 kB\n",
            "VmRSS: 4 kB extra\nVmHWM: 8 kB\n",
            "VmRSS: 18446744073709551615 kB\nVmHWM: 8 kB\n",
        ] {
            assert_eq!(
                linux_status_memory(status).unwrap_err().code,
                "METRICS_UNAVAILABLE"
            );
        }
    }
}
