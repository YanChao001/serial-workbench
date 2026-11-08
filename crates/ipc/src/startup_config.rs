//! 仅解析明确的启动覆盖；解析不读写 profile，不展开或执行输入。
use serial_workbench_core::{
    HostError, HostResult, StartupConfigSnapshot, StartupConfigSource, StartupLogLevel,
    StartupProfileReference,
};
use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct StartupConfig {
    profile: PathBuf,
    snapshot: StartupConfigSnapshot,
}

impl StartupConfig {
    pub fn profile(&self) -> &Path {
        &self.profile
    }
    pub fn snapshot(&self) -> StartupConfigSnapshot {
        self.snapshot.clone()
    }
    pub fn log_filter(&self) -> log::LevelFilter {
        match self.snapshot.log_level {
            StartupLogLevel::Off => log::LevelFilter::Off,
            StartupLogLevel::Error => log::LevelFilter::Error,
            StartupLogLevel::Warn => log::LevelFilter::Warn,
            StartupLogLevel::Info => log::LevelFilter::Info,
            StartupLogLevel::Debug => log::LevelFilter::Debug,
            StartupLogLevel::Trace => log::LevelFilter::Trace,
        }
    }
}

pub fn resolve(explicit_profile: Option<PathBuf>) -> HostResult<StartupConfig> {
    resolve_with(
        explicit_profile,
        |key| std::env::var_os(key),
        crate::default_profile,
        std::env::current_dir,
    )
}

fn resolve_with(
    explicit_profile: Option<PathBuf>,
    mut env: impl FnMut(&str) -> Option<OsString>,
    default_profile: impl FnOnce() -> HostResult<PathBuf>,
    current_dir: impl FnOnce() -> std::io::Result<PathBuf>,
) -> HostResult<StartupConfig> {
    let (profile, profile_source) = if let Some(profile) = explicit_profile {
        (profile, StartupConfigSource::Argument)
    } else if let Some(profile) = env("SWB_PROFILE") {
        (PathBuf::from(profile), StartupConfigSource::Environment)
    } else {
        (default_profile()?, StartupConfigSource::Default)
    };
    if profile.as_os_str().is_empty() || profile.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(HostError::new(
            "INVALID_ARGUMENT",
            "Invalid startup profile",
        ));
    }
    let profile = if profile.is_absolute() {
        profile
    } else {
        // Windows 的 C:relative 和 \rooted 依赖额外的 drive 状态，不把它们当普通相对路径。
        if profile.has_root() || matches!(profile.components().next(), Some(Component::Prefix(_))) {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Startup profile must be absolute or relative to the working directory",
            ));
        }
        let directory = current_dir().map_err(|_| unavailable_cwd())?;
        if !directory.is_absolute() {
            return Err(unavailable_cwd());
        }
        directory.join(profile)
    };
    let (log_level, log_level_source) = match env("SWB_LOG_LEVEL") {
        None => (StartupLogLevel::Info, StartupConfigSource::Default),
        Some(value) => {
            let invalid = || {
                HostError::new(
                    "INVALID_ARGUMENT",
                    "SWB_LOG_LEVEL must be off, error, warn, info, debug, or trace",
                )
            };
            let level = match value
                .to_str()
                .ok_or_else(invalid)?
                .to_ascii_lowercase()
                .as_str()
            {
                "off" => StartupLogLevel::Off,
                "error" => StartupLogLevel::Error,
                "warn" => StartupLogLevel::Warn,
                "info" => StartupLogLevel::Info,
                "debug" => StartupLogLevel::Debug,
                "trace" => StartupLogLevel::Trace,
                _ => return Err(invalid()),
            };
            (level, StartupConfigSource::Environment)
        }
    };
    Ok(StartupConfig {
        profile,
        snapshot: StartupConfigSnapshot {
            profile_reference: StartupProfileReference::HostProfile,
            profile_source,
            log_level,
            log_level_source,
        },
    })
}

fn unavailable_cwd() -> HostError {
    HostError::new(
        "STORAGE_UNAVAILABLE",
        "Startup working directory is unavailable",
    )
}

/// Host、CLI 和 MCP 的一次性日志安装；不占用承载协议或机器输出的 stdout。
pub fn init_stderr_logging(filter: log::LevelFilter) -> HostResult<()> {
    static LOGGER: StderrLogger = StderrLogger;
    log::set_logger(&LOGGER).map_err(|_| {
        HostError::new(
            "STORAGE_UNAVAILABLE",
            "Startup logger is already initialized",
        )
    })?;
    log::set_max_level(filter);
    Ok(())
}

/// 启动诊断只记录受控枚举字段，禁止扩展为整个配置或原始参数的 Debug 输出。
pub fn log_startup_configuration(snapshot: &StartupConfigSnapshot) {
    log::debug!(
        target: "serial_workbench_ipc",
        "Startup configuration profileSource={:?} logLevel={:?} logLevelSource={:?}",
        snapshot.profile_source,
        snapshot.log_level,
        snapshot.log_level_source,
    );
}

struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        // 应用日志只使用受控字段；不因提升级别而开启未审阅的第三方 payload 日志。
        metadata.target().starts_with("serial_workbench_") && metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            use std::io::Write;
            let _ = writeln!(
                std::io::stderr().lock(),
                "{} {}",
                record.level(),
                record.args()
            );
        }
    }

    fn flush(&self) {
        use std::io::Write;
        let _ = std::io::stderr().flush();
    }
}

#[cfg(test)]
#[path = "startup_config_tests.rs"]
mod tests;
