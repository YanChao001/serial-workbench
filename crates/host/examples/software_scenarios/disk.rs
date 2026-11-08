//! T05 injects only the trusted CaptureVolume boundary, preserving real files.
use super::{
    client::id,
    evidence::{Case, hash, write_json},
    process::{Binaries, Owned, Processes, Result, checked},
};
use serde_json::json;
use serial_workbench_core::*;
use serial_workbench_host::capture::{
    format::CaptureSource,
    recovery::recover_directory,
    verify::verify_directory,
    writer::{CaptureLimits, CaptureVolume, CaptureWriter, VolumeOpener},
};
use std::{fs::File, io::Write, path::PathBuf, sync::Arc, time::Duration};

fn source() -> CaptureSource {
    CaptureSource {
        host_id: id("disk-harness-host"),
        instance_epoch: 1.into(),
        session_id: id("disk-harness-session"),
        session_epoch: 1.into(),
        configuration_digest: Digest::try_from(
            hash(&serde_json::to_vec(&SerialConfiguration::default()).expect("configuration JSON"))
                .as_str(),
        )
        .expect("digest"),
        configuration: SerialConfiguration::default(),
        time_precision: TimePrecision {
            source: TimeSource::HostRead,
            resolution_ns: 1.into(),
            sync_method: "none".into(),
            offset_estimate_ns: None,
            offset_error_ns: None,
            rtt_ns: None,
        },
    }
}
fn entry(n: u64) -> CaptureEntry {
    CaptureEntry::Event(Box::new(RawEvent {
        host_id: source().host_id,
        instance_epoch: 1.into(),
        session_id: source().session_id,
        session_epoch: 1.into(),
        event_seq: n.into(),
        configuration_revision: 1.into(),
        time: EventTime {
            clock_id: id("disk-harness-clock"),
            source_mono_ns: n.into(),
            received_wall_time: Timestamp::try_from("2026-11-08T00:00:00Z").expect("timestamp"),
            source_wall_time: None,
            precision: source().time_precision,
        },
        payload: RawPayload::Rx(RxPayload {
            bytes_base64: Bytes::try_from("AQID").expect("bytes"),
            byte_start: ((n - 1) * 3).into(),
            byte_end: (n * 3).into(),
            message: None,
        }),
    }))
}
struct FaultVolume {
    file: File,
    first: bool,
    left: usize,
    readonly: bool,
}
impl Write for FaultVolume {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.first {
            self.first = false;
            return self.file.write(bytes);
        }
        if self.readonly {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected read-only writer",
            ));
        }
        if self.left == 0 {
            return Err(std::io::Error::from_raw_os_error(if cfg!(windows) {
                112
            } else {
                28
            }));
        }
        let n = self.file.write(&bytes[..bytes.len().min(self.left)])?;
        self.left -= n;
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}
impl CaptureVolume for FaultVolume {
    fn sync_all(&mut self) -> std::io::Result<()> {
        self.file.sync_all()
    }
    fn length(&self) -> std::io::Result<u64> {
        Ok(self.file.metadata()?.len())
    }
}
fn opener(left: usize, readonly: bool) -> VolumeOpener {
    Arc::new(move |file| {
        Ok(Box::new(FaultVolume {
            file,
            first: true,
            left,
            readonly,
        }))
    })
}

pub(super) async fn run(
    case: &mut Case,
    processes: &mut Processes,
    binaries: &Binaries,
) -> Result<()> {
    let root = processes.log_dir.join("T05-storage");
    checked(std::fs::create_dir(&root))?;
    let mut failures = Vec::new();
    for (name, left, readonly, expected_len) in [
        ("full-class", 0, false, 7),
        ("read-only", 0, true, 7),
        ("partial-write", 12, false, 19),
    ] {
        let path = root.join(name);
        let mut writer = checked(CaptureWriter::create_with_storage(
            &path,
            vec![source()],
            CaptureLimits::default(),
            opener(left, readonly),
        ))?;
        let error = writer
            .push(entry(1), 1)
            .err()
            .ok_or("Injected disk error was not observed")?;
        let summary = writer.summary();
        drop(writer);
        let before = checked(std::fs::read(path.join("volume-000001.swbr")))?;
        let scan = checked(verify_directory(&path))?;
        if error.code != "CAPTURE_IO_FAILED"
            || summary.state != CaptureState::Failed
            || summary.container_complete
            || summary.watermarks.written.get() != 0
            || summary.watermarks.flushed.get() != 0
            || summary.watermarks.synced.get() != 0
            || summary.watermarks.verified.get() != 0
            || before.len() != expected_len
            || checked(std::fs::read(path.join("volume-000001.swbr")))? != before
            || scan.report.verified_prefix.get() != 0
            || scan.report.container_complete != (left == 0)
        {
            return Err(format!(
                "{name}: writer did not retain the failed original with honest watermarks"
            ));
        }
        failures.push(json!({"mode":name,"injectedBoundary":"CaptureVolume::write","error":error,"summary":summary,"retainedBytes":before.len(),"retainedSha256":hash(&before),"verification":scan.report}));
        case.artifact(&format!("T05-storage/{name}/volume-000001.swbr"));
    }
    case.check(
        "disk_failure_evidence",
        true,
        json!({"failures":failures,"osFullFilesystem":false}),
    )?;
    let rotated = root.join("rotated");
    let limits = CaptureLimits {
        volume_bytes: 900,
        ..CaptureLimits::default()
    };
    let mut writer = checked(CaptureWriter::create(&rotated, vec![source()], limits))?;
    for n in 1..=4 {
        checked(writer.push(entry(n), n))?;
    }
    checked(writer.finish())?;
    let scan = checked(verify_directory(&rotated))?;
    let before = checked(std::fs::read(rotated.join("volume-000001.swbr")))?;
    let recovery = root.join("rotation-recovery");
    checked(recover_directory(&rotated, &recovery, &scan.report))?;
    let restored = checked(verify_directory(&recovery))?;
    case.check("rotation_recovery",rotated.join("volume-000002.swbr").is_file() && scan.report.verified_prefix.get()==4 && restored.report.verified_prefix.get()==4 && checked(std::fs::read(rotated.join("volume-000001.swbr")))?==before,json!({"original":scan.report,"recovery":restored.report,"originalVolumeSha256":hash(&before)}))?;
    let crash = root.join("crash");
    let ready = root.join("crash-ready.json");
    let mut command = tokio::process::Command::new(&binaries.harness);
    command
        .arg("--owned-crash-writer")
        .arg(&crash)
        .arg("--ready")
        .arg(&ready)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let index = processes.children.len();
    processes.children.push(Owned::spawn(
        command,
        "forced-crash capture writer",
        &processes.log_dir,
    )?);
    checked(
        tokio::time::timeout(Duration::from_secs(10), async {
            while !ready.is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await,
    )?;
    processes.children[index].force_stop().await?;
    let original = checked(std::fs::read(crash.join("volume-000001.swbr")))?;
    let scan = checked(verify_directory(&crash))?;
    let recovered = root.join("crash-recovery");
    checked(recover_directory(&crash, &recovered, &scan.report))?;
    let fixed = checked(verify_directory(&recovered))?;
    case.check("crash_prefix",scan.report.verified_prefix.get()>0 && fixed.report.verified_prefix==scan.report.verified_prefix && checked(std::fs::read(crash.join("volume-000001.swbr")))?==original && processes.children[index].record.exited,json!({"ownedCrashPid":processes.children[index].record.pid,"forced":true,"before":scan.report,"recovered":fixed.report,"originalSha256":hash(&original)}))?;
    Ok(())
}
pub(super) async fn crash_writer(path: PathBuf, ready: PathBuf) -> Result<()> {
    let mut writer = checked(CaptureWriter::create(
        &path,
        vec![source()],
        CaptureLimits {
            volume_bytes: 900,
            ..CaptureLimits::default()
        },
    ))?;
    for n in 1..=4 {
        checked(writer.push(entry(n), n))?;
    }
    write_json(
        &ready,
        &json!({"pid":std::process::id(),"written":writer.summary().watermarks.written}),
    )?;
    // Retain the live writer until the owning parent forcibly terminates this
    // process; Drop/finalize deliberately never runs in this crash checkpoint.
    std::future::pending::<()>().await;
    drop(writer);
    Ok(())
}
