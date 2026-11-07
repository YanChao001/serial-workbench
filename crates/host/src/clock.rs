//! Host 期限使用计入系统休眠的单调时钟；墙钟仅用于展示和审计。
use chrono::{DateTime, SecondsFormat, Utc};
use serial_workbench_core::{Clock, HostError, HostResult, Timestamp};
use std::sync::OnceLock;

static SHARED_CLOCK: OnceLock<HostResult<ClockState>> = OnceLock::new();

struct ClockState {
    native: native::NativeClock,
    origin_ns: u128,
}

/// 所有默认构造共享进程内同一时钟域；有限期限计入系统休眠。
pub struct SystemClock {
    state: &'static ClockState,
}

impl SystemClock {
    /// 生产装配先调用此方法；原生时钟不可用时不能启动接纳业务。
    pub fn new() -> HostResult<Self> {
        let state = SHARED_CLOCK.get_or_init(|| {
            let native = native::NativeClock::new()?;
            let origin_ns = native.now_ns()?;
            Ok(ClockState { native, origin_ns })
        });
        match state {
            Ok(state) => Ok(Self { state }),
            Err(error) => Err(error.clone()),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new().unwrap_or_else(|_| clock_failed())
    }
}

impl Clock for SystemClock {
    fn mono_ns(&self) -> u64 {
        runtime_value(
            self.state
                .native
                .now_ns()
                .and_then(|now| elapsed_ns(self.state.origin_ns, now)),
        )
    }

    fn wall_time(&self) -> Timestamp {
        let now: DateTime<Utc> = std::time::SystemTime::now().into();
        Timestamp::try_from(now.to_rfc3339_opts(SecondsFormat::Millis, true).as_str())
            .expect("system time is RFC3339")
    }
}

fn unavailable() -> HostError {
    HostError::new("CLOCK_UNAVAILABLE", "Host monotonic clock is unavailable")
}

fn elapsed_ns(origin: u128, now: u128) -> HostResult<u64> {
    now.checked_sub(origin)
        .and_then(|elapsed| elapsed.try_into().ok())
        .ok_or_else(unavailable)
}

#[cfg(any(windows, target_os = "macos", test))]
fn ticks_ns(ticks: u64, numer: u32, denom: u32) -> HostResult<u128> {
    if numer == 0 || denom == 0 {
        return Err(unavailable());
    }
    Ok(u128::from(ticks) * u128::from(numer) / u128::from(denom))
}

#[cfg(any(all(target_os = "linux", target_env = "gnu"), test))]
fn timespec_ns(seconds: i64, nanos: i64) -> HostResult<u128> {
    if seconds < 0 || !(0..1_000_000_000).contains(&nanos) {
        return Err(unavailable());
    }
    Ok(seconds as u128 * 1_000_000_000 + nanos as u128)
}

fn runtime_value(value: HostResult<u64>) -> u64 {
    value.unwrap_or_else(|_| clock_failed())
}

/// 唤醒只用于重读原生期限；恢复后的 std/Tokio 时钟不决定授权是否过期。
pub(crate) async fn wait_until(clock: &dyn Clock, deadline_ns: u64) {
    loop {
        let now = clock.mono_ns();
        if now >= deadline_ns {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_nanos(
            (deadline_ns - now).min(20_000_000),
        ))
        .await;
    }
}

fn clock_failed() -> ! {
    // infallible Clock 无法传播错误；线程 panic 或最大值会让其他副作用继续。
    // 不写可能阻塞的 stderr；进程退出保留既有 dispatch 和清线恢复证据。
    std::process::exit(1)
}

#[cfg(windows)]
mod native {
    use super::*;
    use windows_sys::Win32::System::WindowsProgramming::QueryInterruptTimePrecise;

    pub(super) struct NativeClock;

    impl NativeClock {
        pub(super) fn new() -> HostResult<Self> {
            Ok(Self)
        }

        pub(super) fn now_ns(&self) -> HostResult<u128> {
            let mut ticks = 0;
            // 输出指向本地有效 u64；该 API 无错误返回。普通 interrupt time 计入休眠。
            unsafe { QueryInterruptTimePrecise(&mut ticks) };
            ticks_ns(ticks, 100, 1)
        }
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod native {
    use super::*;

    pub(super) struct NativeClock;

    impl NativeClock {
        pub(super) fn new() -> HostResult<Self> {
            let mut resolution = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            // 固定 CLOCK_BOOTTIME 与有效输出指针；失败时不读取输出或回退其他时钟。
            if unsafe { libc::clock_getres(libc::CLOCK_BOOTTIME, &mut resolution) } != 0
                || timespec_ns(resolution.tv_sec, resolution.tv_nsec)? == 0
            {
                return Err(unavailable());
            }
            Ok(Self)
        }

        pub(super) fn now_ns(&self) -> HostResult<u128> {
            let mut now = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            // CLOCK_BOOTTIME 计入 suspend；墙钟设置不会重设此时钟。
            if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut now) } != 0 {
                return Err(unavailable());
            }
            timespec_ns(now.tv_sec, now.tv_nsec)
        }
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;

    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }

    // Apple 公共 mach/mach_time.h ABI；libc 0.2.191 没有 continuous 符号。
    unsafe extern "C" {
        fn mach_continuous_time() -> u64;
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }

    pub(super) struct NativeClock {
        timebase: Timebase,
    }

    impl NativeClock {
        pub(super) fn new() -> HostResult<Self> {
            let mut timebase = Timebase { numer: 0, denom: 0 };
            // 本地 repr(C) 输出对应两个 uint32 字段；KERN_SUCCESS 为0。
            if unsafe { mach_timebase_info(&mut timebase) } != 0
                || timebase.numer == 0
                || timebase.denom == 0
            {
                return Err(unavailable());
            }
            Ok(Self { timebase })
        }

        pub(super) fn now_ns(&self) -> HostResult<u128> {
            // continuous 时钟计入 sleep；在 u128 中先乘后除，避免溢出与提前截断。
            let ticks = unsafe { mach_continuous_time() };
            ticks_ns(ticks, self.timebase.numer, self.timebase.denom)
        }
    }
}

#[cfg(not(any(
    windows,
    target_os = "macos",
    all(target_os = "linux", target_env = "gnu")
)))]
mod native {
    use super::*;

    pub(super) struct NativeClock;

    impl NativeClock {
        pub(super) fn new() -> HostResult<Self> {
            Err(unavailable())
        }

        pub(super) fn now_ns(&self) -> HostResult<u128> {
            Err(unavailable())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_clock_starts_and_reads_valid_time() {
        let clock = SystemClock::new().unwrap();
        let before = clock.mono_ns();
        let wall = clock.wall_time();
        assert!(clock.mono_ns() >= before);
        assert!(DateTime::parse_from_rfc3339(wall.as_str()).is_ok());
    }

    #[test]
    fn separate_handles_share_a_single_origin() {
        let first = SystemClock::new().unwrap();
        let before = first.mono_ns();
        let second = SystemClock::new().unwrap();
        let middle = second.mono_ns();
        let after = first.mono_ns();
        assert!(before <= middle && middle <= after);
    }

    #[test]
    fn elapsed_keeps_large_boot_origin_and_checks_relative_range() {
        let origin = u128::from(u64::MAX) + 123;
        assert_eq!(elapsed_ns(origin, origin + 7).unwrap(), 7);
        assert_eq!(
            elapsed_ns(origin, origin - 1).unwrap_err().code,
            "CLOCK_UNAVAILABLE"
        );
        assert!(elapsed_ns(0, u128::from(u64::MAX) + 1).is_err());
    }

    #[test]
    fn tick_conversion_preserves_fraction_without_intermediate_overflow() {
        assert_eq!(ticks_ns(19, 100, 1).unwrap(), 1_900);
        assert_eq!(ticks_ns(7, 125, 3).unwrap(), 291);
        assert_eq!(
            ticks_ns(u64::MAX, u32::MAX, 1).unwrap(),
            u128::from(u64::MAX) * u128::from(u32::MAX)
        );
        assert!(ticks_ns(1, 1, 0).is_err());
        assert!(ticks_ns(1, 0, 1).is_err());
    }

    #[test]
    fn timespec_requires_valid_nonnegative_clock_output() {
        assert_eq!(timespec_ns(12, 345).unwrap(), 12_000_000_345);
        assert_eq!(
            timespec_ns(i64::MAX, 999_999_999).unwrap(),
            (i64::MAX as u128) * 1_000_000_000 + 999_999_999
        );
        assert!(timespec_ns(-1, 0).is_err());
        assert!(timespec_ns(0, -1).is_err());
        assert!(timespec_ns(0, 1_000_000_000).is_err());
    }

    #[test]
    fn runtime_failure_exits_without_continuing() {
        const CHILD: &str = "SERIAL_WORKBENCH_CLOCK_TEST_CHILD";
        const CONTINUED: &str = "CLOCK_FAILURE_CONTINUED";
        if std::env::var_os(CHILD).is_some() {
            runtime_value(Err(unavailable()));
            println!("{CONTINUED}");
            return;
        }
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "clock::tests::runtime_failure_exits_without_continuing",
                "--nocapture",
            ])
            .env(CHILD, "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(!String::from_utf8_lossy(&output.stdout).contains(CONTINUED));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_observes_clock_jump_without_advancing_runtime_deadline() {
        use std::sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        };
        struct JumpClock {
            now: AtomicU64,
            sampled: tokio::sync::Notify,
        }
        impl Clock for JumpClock {
            fn mono_ns(&self) -> u64 {
                let now = self.now.load(Ordering::SeqCst);
                self.sampled.notify_one();
                now
            }
            fn wall_time(&self) -> Timestamp {
                panic!("deadline waiting must not read wall time")
            }
        }
        let clock = Arc::new(JumpClock {
            now: AtomicU64::new(0),
            sampled: tokio::sync::Notify::new(),
        });
        let task_clock = clock.clone();
        let mut task =
            tokio::spawn(async move { wait_until(task_clock.as_ref(), 60_000_000_000).await });
        tokio::time::timeout(std::time::Duration::from_secs(1), clock.sampled.notified())
            .await
            .unwrap();
        assert!(!task.is_finished());
        clock.now.store(60_000_000_000, Ordering::SeqCst);
        let completed =
            tokio::time::timeout(std::time::Duration::from_millis(500), &mut task).await;
        if completed.is_err() {
            task.abort();
        }
        completed.unwrap().unwrap();
    }
}
