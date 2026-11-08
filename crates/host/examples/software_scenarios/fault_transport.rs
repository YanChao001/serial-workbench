//! Fault transports belong only to this executable; no production action selects them.
use serial_workbench_core::*;
use serial_workbench_host::device::virtual_backend::VirtualTransport;
use sha2::{Digest as _, Sha256};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
pub(super) enum Mode {
    PartialUnknown,
    ConfigurationAndBreak,
    PacedProducer,
}

#[cfg(test)]
pub(super) fn transport(mode: Mode) -> Box<dyn Transport> {
    configured(mode, SerialConfiguration::default(), None)
}

pub(super) fn configured(
    mode: Mode,
    configuration: SerialConfiguration,
    probe: Option<PathBuf>,
) -> Box<dyn Transport> {
    let producer = matches!(mode, Mode::PacedProducer).then(|| {
        Producer::new(
            probe
                .as_ref()
                .and_then(|path| path.parent())
                .map(std::path::Path::to_path_buf),
        )
    });
    Box::new(FaultTransport {
        mode,
        echo: VirtualTransport::new(configuration),
        configuration_failed: false,
        break_asserted: false,
        writes: Vec::new(),
        probe,
        producer,
    })
}

struct FaultTransport {
    mode: Mode,
    echo: VirtualTransport,
    configuration_failed: bool,
    break_asserted: bool,
    writes: Vec<serde_json::Value>,
    probe: Option<PathBuf>,
    producer: Option<Producer>,
}

struct ReadyWrite(Option<BackendWrite>);
impl PendingWrite for ReadyWrite {
    fn poll(&mut self) -> Option<BackendResult<BackendWrite>> {
        self.0.take().map(Ok)
    }
}

impl FaultTransport {
    fn save_probe(&self) -> BackendResult<()> {
        let Some(path) = &self.probe else {
            return Ok(());
        };
        let producer = self.producer.as_ref().map(Producer::snapshot);
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "writes":self.writes, "producer":producer,
            "breakAsserted":self.break_asserted,
        }))
        .map_err(|_| HostError::new("HARNESS_EVIDENCE_FAILED", "Cannot encode backend probe"))?;
        std::fs::write(path, bytes)
            .map_err(|error| HostError::new("HARNESS_EVIDENCE_FAILED", error.to_string()).into())
    }
}

impl Transport for FaultTransport {
    fn capabilities(&self) -> TransportCapabilities {
        self.echo.capabilities()
    }
    fn read(&mut self, limit: usize, wait: Duration) -> BackendResult<ReadBlock> {
        if let Some(producer) = &self.producer {
            let mut state = producer
                .state
                .lock()
                .map_err(|_| HostError::new("HARNESS_PRODUCER_FAILED", "Producer lock poisoned"))?;
            let n = limit.min(state.queue.len());
            let bytes: Vec<u8> = state.queue.drain(..n).collect();
            state.delivered += bytes.len() as u64;
            state.delivered_hash.update(&bytes);
            return Ok(ReadBlock {
                bytes: Arc::from(bytes),
                message: None,
            });
        }
        self.echo.read(limit, wait)
    }
    fn begin_write(
        &mut self,
        bytes: WritePayload,
        wait: Duration,
        cancelled: Arc<AtomicBool>,
        closing: Arc<AtomicBool>,
    ) -> BackendResult<Box<dyn PendingWrite>> {
        if !matches!(self.mode, Mode::PartialUnknown) {
            return self.echo.begin_write(bytes, wait, cancelled, closing);
        }
        if cancelled.load(Ordering::SeqCst) || closing.load(Ordering::SeqCst) {
            return Err(HostError::new("CANCELLED", "Fault write was not submitted").into());
        }
        let accepted = bytes.len().min(2);
        let unknown = bytes.len().min(4);
        let outcome = BackendWrite {
            accepted_ranges: (accepted > 0)
                .then(|| ByteRange {
                    start: 0.into(),
                    end: (accepted as u64).into(),
                })
                .into_iter()
                .collect(),
            unknown_ranges: (unknown > accepted)
                .then(|| ByteRange {
                    start: (accepted as u64).into(),
                    end: (unknown as u64).into(),
                })
                .into_iter()
                .collect(),
            error: Some(HostError::new(
                "HARNESS_PARTIAL_UNKNOWN",
                "Injected accepted prefix and unknown middle; tail unsubmitted",
            )),
        };
        self.writes.push(serde_json::json!({"submittedBytes":bytes.len(),"submittedSha256":format!("{:x}",Sha256::digest(&*bytes)),"acceptedRanges":outcome.accepted_ranges,"unknownRanges":outcome.unknown_ranges}));
        let mut echo = self.echo.begin_write(
            WritePayload::owned(Arc::from(&bytes[..accepted])),
            wait,
            cancelled,
            closing,
        )?;
        echo.poll().ok_or_else(|| {
            HostError::new("HARNESS_BACKEND_FAILED", "Expected synchronous echo")
        })??;
        self.save_probe()?;
        Ok(Box::new(ReadyWrite(Some(outcome))))
    }
    fn configure(&mut self, config: &SerialConfiguration) -> BackendResult<ConfigApplication> {
        if matches!(self.mode, Mode::ConfigurationAndBreak) && !self.configuration_failed {
            self.configuration_failed = true;
            let mut report = self.echo.configure(&SerialConfiguration::default())?;
            for field in &mut report.fields {
                if field.field == "baudRate" {
                    field.status = FieldStatus::Rejected;
                }
            }
            return Ok(report);
        }
        self.echo.configure(config)
    }
    fn control(&mut self, command: ControlCommand) -> BackendResult<ControlResult> {
        if matches!(self.mode, Mode::ConfigurationAndBreak) {
            match command {
                ControlCommand::AssertBreak => self.break_asserted = true,
                ControlCommand::ClearBreak => {
                    self.save_probe()?;
                    return Err(HostError::new(
                        "HARNESS_BREAK_CLEAR_FAILED",
                        "Injected failure leaves BREAK responsibility unknown",
                    )
                    .into());
                }
                _ => {}
            }
        }
        self.echo.control(command)
    }
    fn begin_drain(&mut self, request: DrainRequest) -> BackendResult<Box<dyn PendingDrain>> {
        self.echo.begin_drain(request)
    }
    fn close(&mut self) -> BackendResult<()> {
        if let Some(producer) = &mut self.producer {
            producer.stop();
        }
        self.save_probe()?;
        if self.break_asserted {
            return Err(HostError::new(
                "HARNESS_BREAK_CLEAR_FAILED",
                "Injected close cannot confirm line cleanup",
            )
            .into());
        }
        self.echo.close()
    }
}

impl Drop for FaultTransport {
    fn drop(&mut self) {
        if let Some(producer) = &mut self.producer {
            producer.stop();
        }
        let _ = self.save_probe();
    }
}

struct ProducerState {
    queue: VecDeque<u8>,
    generated: u64,
    delivered: u64,
    dropped: u64,
    generated_hash: Sha256,
    delivered_hash: Sha256,
}
struct Producer {
    state: Arc<Mutex<ProducerState>>,
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}
impl Producer {
    fn new(directory: Option<PathBuf>) -> Self {
        let state = Arc::new(Mutex::new(ProducerState {
            queue: VecDeque::new(),
            generated: 0,
            delivered: 0,
            dropped: 0,
            generated_hash: Sha256::new(),
            delivered_hash: Sha256::new(),
        }));
        let stopped = Arc::new(AtomicBool::new(false));
        let shared = state.clone();
        let stop = stopped.clone();
        let started = Instant::now();
        let worker = thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(100));
                if stop.load(Ordering::SeqCst)
                    || directory
                        .as_ref()
                        .is_some_and(|path| path.join("producer-stop").is_file())
                {
                    break;
                }
                let goal = (started.elapsed().as_nanos() * 11_520 / 1_000_000_000) as u64;
                let mut state = shared.lock().expect("example producer state");
                for offset in state.generated..goal {
                    let byte = (offset % 251) as u8;
                    state.generated_hash.update([byte]);
                    if state.queue.len() < 64 * 1024 {
                        state.queue.push_back(byte);
                    } else {
                        state.dropped += 1;
                    }
                }
                state.generated = goal;
            }
            if let Some(directory) = directory {
                let state = shared.lock().expect("example producer state");
                let result = serde_json::json!({"generated":state.generated,"generatedSha256":format!("{:x}",state.generated_hash.clone().finalize()),"dropped":state.dropped});
                if let Ok(bytes) = serde_json::to_vec(&result) {
                    let _ = std::fs::write(directory.join("producer-stopped.json"), bytes);
                }
            }
        });
        Self {
            state,
            stopped,
            worker: Some(worker),
        }
    }
    fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
    fn snapshot(&self) -> serde_json::Value {
        let state = self.state.lock().expect("example producer state");
        serde_json::json!({
            "rateBytesPerSecond":11_520,"queueLimitBytes":64*1024,
            "generated":state.generated,"delivered":state.delivered,"dropped":state.dropped,
            "pending":state.queue.len(),"generatedSha256":format!("{:x}",state.generated_hash.clone().finalize()),
            "deliveredSha256":format!("{:x}",state.delivered_hash.clone().finalize()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{Arc, atomic::AtomicBool},
        time::Duration,
    };

    #[test]
    fn fault_write_retains_accepted_unknown_and_unsubmitted_tail() {
        let mut device = transport(Mode::PartialUnknown);
        let mut pending = device
            .begin_write(
                WritePayload::owned(Arc::from(&b"abcdef"[..])),
                Duration::from_secs(1),
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap();
        let result = pending
            .poll()
            .expect("synchronous test completion")
            .unwrap();
        assert_eq!(
            result.accepted_ranges,
            vec![ByteRange {
                start: 0.into(),
                end: 2.into()
            }]
        );
        assert_eq!(
            result.unknown_ranges,
            vec![ByteRange {
                start: 2.into(),
                end: 4.into()
            }]
        );
        assert_eq!(result.error.unwrap().code, "HARNESS_PARTIAL_UNKNOWN");
        assert_eq!(
            device.read(64, Duration::ZERO).unwrap().bytes.as_ref(),
            b"ab"
        );
        assert!(
            device.read(64, Duration::ZERO).unwrap().bytes.is_empty(),
            "unknown and tail must not be echoed or replayed"
        );
    }

    #[test]
    fn fault_configuration_reports_actual_fields_and_break_clear_fails() {
        let mut device = transport(Mode::ConfigurationAndBreak);
        let mut config = SerialConfiguration::default();
        config.baud_rate = PositiveU64::try_from(U64::from(19200)).unwrap();
        let report = device.configure(&config).unwrap();
        assert!(
            report
                .fields
                .iter()
                .any(|field| field.status != FieldStatus::Applied)
        );
        assert!(matches!(
            device.control(ControlCommand::AssertBreak),
            Ok(ControlResult::Break { asserted: true })
        ));
        assert!(
            matches!(device.control(ControlCommand::ClearBreak), Err(error) if error.error.code == "HARNESS_BREAK_CLEAR_FAILED")
        );
    }

    #[test]
    fn paced_producer_creates_bytes_without_tx_or_reader_driving_it() {
        let mut device = transport(Mode::PacedProducer);
        std::thread::sleep(Duration::from_millis(110));
        let bytes = device.read(4096, Duration::ZERO).unwrap().bytes;
        assert!(
            bytes.len() >= 1152,
            "independent 11,520 B/s producer must already hold bytes; got {}",
            bytes.len()
        );
        for (offset, byte) in bytes.iter().enumerate() {
            assert_eq!(*byte, (offset % 251) as u8);
        }
        device.close().unwrap();
    }
}
