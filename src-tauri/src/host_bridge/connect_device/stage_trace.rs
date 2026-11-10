//! Debug and isolated E2E stage metadata; no business identity or error text enters the log.
use serial_workbench_core::HostResult;
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::Instant,
};

static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(1);

#[cfg(test)]
#[derive(Clone, Debug)]
pub(super) struct TraceEvent {
    pub attempt: u64,
    pub phase: &'static str,
    pub event: &'static str,
    pub elapsed_ms: u128,
    pub phase_ms: u128,
    pub polls: u64,
    pub error_code: Option<String>,
}

pub(super) struct ConnectTrace {
    attempt: u64,
    started: Instant,
    phase_started: Instant,
    phase: &'static str,
    polls: u64,
    finished: bool,
    #[cfg(test)]
    observer: Option<std::sync::Arc<dyn Fn(TraceEvent) + Send + Sync>>,
}

impl ConnectTrace {
    pub fn new() -> Self {
        let started = Instant::now();
        Self {
            attempt: NEXT_ATTEMPT.fetch_add(1, Ordering::Relaxed),
            started,
            phase_started: started,
            phase: "attachment",
            polls: 0,
            finished: false,
            #[cfg(test)]
            observer: None,
        }
    }

    #[cfg(test)]
    pub fn observed(observer: impl Fn(TraceEvent) + Send + Sync + 'static) -> Self {
        let mut trace = Self::new();
        trace.observer = Some(std::sync::Arc::new(observer));
        trace
    }

    pub fn begin(&mut self, phase: &'static str) {
        self.phase = phase;
        self.phase_started = Instant::now();
        self.polls = 0;
        self.emit("start", None);
    }

    pub fn done(&self) {
        self.emit("done", None);
    }

    pub fn poll(&mut self) {
        self.polls = self.polls.saturating_add(1);
    }

    pub fn finish<T>(&mut self, result: &HostResult<T>) {
        match result {
            Ok(_) => {
                self.begin("complete");
                self.done();
            }
            Err(error) => {
                let code = error.code.as_str();
                let stable = !code.is_empty()
                    && code.len() <= 64
                    && code.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    });
                self.emit("failed", Some(if stable { code } else { "UNKNOWN" }));
            }
        }
        self.finished = true;
    }

    fn emit(&self, event: &'static str, error_code: Option<&str>) {
        let now = Instant::now();
        let elapsed_ms = now.duration_since(self.started).as_millis();
        let phase_ms = now.duration_since(self.phase_started).as_millis();
        // 独立 E2E 固定采集安全阶段元数据，普通程序仍仅在 debug 日志级别输出。
        let level = if cfg!(feature = "e2e") {
            log::Level::Info
        } else {
            log::Level::Debug
        };
        log::log!(
            level,
            "DeviceConnect attempt={} phase={} event={} elapsed_ms={} phase_ms={} polls={} error_code={}",
            self.attempt,
            self.phase,
            event,
            elapsed_ms,
            phase_ms,
            self.polls,
            error_code.unwrap_or("-")
        );
        #[cfg(test)]
        if let Some(observer) = &self.observer {
            observer(TraceEvent {
                attempt: self.attempt,
                phase: self.phase,
                event,
                elapsed_ms,
                phase_ms,
                polls: self.polls,
                error_code: error_code.map(str::to_owned),
            });
        }
    }
}

impl Drop for ConnectTrace {
    fn drop(&mut self) {
        if !self.finished {
            // Only this Native waiter was dropped; the accepted work may continue.
            self.emit("wait-dropped", None);
        }
    }
}
