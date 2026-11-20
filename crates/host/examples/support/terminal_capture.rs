use base64::{Engine, engine::general_purpose::STANDARD};
use serial_workbench_core::{
    CaptureEntry, CaptureState, RawEvent, RawPayload, ReplayMode, ReplayRecord, VerificationReport,
};
use serial_workbench_host::capture::{replay::ReplayReader, verify::verify_directory};
use std::{error::Error, path::Path};

pub struct CheckedCapture {
    pub report: VerificationReport,
    pub rx: Vec<RawEvent>,
}

pub fn check(path: &Path, expected: &[u8]) -> Result<CheckedCapture, Box<dyn Error>> {
    let verified = verify_directory(path)?;
    let report = verified.report;
    if verified.summary.state != CaptureState::Complete
        || !report.container_complete
        || !report.source_continuous
        || !report.unsettled_operations.is_empty()
    {
        return Err("The terminal recording did not settle continuously".into());
    }
    let mut replay = ReplayReader::open(path, ReplayMode::Fastest)?;
    let page = replay.read(100, 0)?;
    if !page.at_end {
        return Err("The terminal recording exceeds the short scenario limit".into());
    }
    let mut rx = Vec::<RawEvent>::new();
    let mut bytes = Vec::new();
    let mut previous_end = None;
    for record in page.records {
        let ReplayRecord::Inline { record } = record else {
            return Err("Expected inline recording records".into());
        };
        if let CaptureEntry::Event(event) = record.entry
            && let RawPayload::Rx(payload) = &event.payload
        {
            if let Some(first) = rx.first()
                && (event.host_id != first.host_id
                    || event.instance_epoch != first.instance_epoch
                    || event.session_id != first.session_id
                    || event.session_epoch != first.session_epoch)
            {
                return Err("The recording combines different RX sources".into());
            }
            let decoded = STANDARD.decode(payload.bytes_base64.as_str())?;
            if previous_end.is_some_and(|end| end != payload.byte_start)
                || payload.byte_start.get().checked_add(decoded.len() as u64)
                    != Some(payload.byte_end.get())
            {
                return Err("The recording has discontinuous RX byte ranges".into());
            }
            previous_end = Some(payload.byte_end);
            bytes.extend(decoded);
            rx.push(*event);
        }
    }
    if rx.is_empty() || bytes != expected {
        return Err(format!(
            "Unexpected recording RX bytes: expected {}, observed {}",
            expected.len(),
            bytes.len()
        )
        .into());
    }
    Ok(CheckedCapture { report, rx })
}
