use super::{format::*, verify::verify_directory};
use base64::Engine as _;
use serial_workbench_core::*;
use std::{io::Write, path::Path};

#[cfg(test)]
#[path = "text_export_tests.rs"]
mod final_fix_tests;
/// 文本按独立源与方向增量解码；sourceSpans 保留跨记录字符的原始定位。
pub fn export_text(source: &Path, target: &Path) -> HostResult<()> {
    export_text_observed(source, target, |_| {})
}
/// Trusted Host test seam; not available through request parameters.
fn export_text_observed(
    source: &Path,
    target: &Path,
    observe: impl FnMut(super::verify::CopyPhase),
) -> HostResult<()> {
    export_bound(
        source,
        &crate::files::references::PathGuard::new(target)?,
        observe,
    )
}
pub(crate) fn export_at(
    source: &Path,
    target: &crate::files::references::PathGuard,
) -> HostResult<()> {
    export_bound(source, target, |_| {})
}
fn export_bound(
    source: &Path,
    destination: &crate::files::references::PathGuard,
    mut observe: impl FnMut(super::verify::CopyPhase),
) -> HostResult<()> {
    let target = destination.checked_path();
    let _source_guard = crate::files::references::PathGuard::new(source)?;
    if target.exists() {
        return Err(HostError::new(
            "TARGET_EXISTS",
            "Text export target already exists",
        ));
    }
    let mut scan = verify_directory(source)?;
    if !scan.report.container_complete {
        return Err(HostError::new(
            "CAPTURE_INCOMPLETE",
            "Recover the verified prefix before exporting",
        ));
    }
    scan.bind_files(source)?;
    let temporary = destination.sibling(std::ffi::OsStr::new(&format!(
        ".text-pending-{}",
        uuid::Uuid::new_v4()
    )))?;
    let mut output = temporary.create_file()?;
    let mut decoders: Vec<(SourceIdentity, Direction, TextDecoder)> = Vec::new();
    for position in 0..scan.index.records.len() {
        observe(super::verify::CopyPhase::BeforeRecord);
        let record = scan.read_verified_record(position)?;
        observe(super::verify::CopyPhase::AfterRecord);
        let location = &scan.index.records[position];
        let mut row = serde_json::json!({"recordOrdinal":record.record_ordinal,"volume":location.volume,"recordOffset":location.offset,"recordLength":location.length});
        let source = SourceIdentity::entry(&record.entry);
        let boundary = match &record.entry {
            CaptureEntry::ReaderGap(_) => Some(None),
            CaptureEntry::Event(event) => match &event.payload {
                RawPayload::Gap(gap) => Some(gap.direction),
                RawPayload::Lifecycle(state) if matches!(state.get("state"), Some(JsonValue::String(state)) if state == "closed" || state == "disconnected") => {
                    Some(None)
                }
                _ => None,
            },
            _ => None,
        };
        if let Some(direction) = boundary {
            for (key, stream_direction, decoder) in &mut decoders {
                if *key == source
                    && direction.is_none_or(|direction| direction == *stream_direction)
                    && let Some(tail) = decoder.flush()
                {
                    write_row(&mut output, &tail)?;
                }
            }
        }
        match &record.entry {
            CaptureEntry::Event(event) => {
                row["timestamp"] =
                    serde_json::to_value(&event.time.received_wall_time).map_err(|_| corrupt())?;
                let payload = match &event.payload {
                    RawPayload::Rx(rx) => {
                        Some((Direction::Rx, &rx.bytes_base64, rx.byte_start, rx.byte_end))
                    }
                    RawPayload::TxIntent(tx) => {
                        Some((Direction::Tx, &tx.bytes_base64, tx.byte_start, tx.byte_end))
                    }
                    _ => None,
                };
                if let Some((direction, bytes, start, end)) = payload {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(bytes.as_str())
                        .map_err(|_| corrupt())?;
                    if end.get().checked_sub(start.get()) != Some(bytes.len() as u64) {
                        return Err(corrupt());
                    }
                    row["hostId"] = serde_json::to_value(&event.host_id).map_err(|_| corrupt())?;
                    row["instanceEpoch"] =
                        serde_json::to_value(event.instance_epoch).map_err(|_| corrupt())?;
                    row["sessionId"] =
                        serde_json::to_value(&event.session_id).map_err(|_| corrupt())?;
                    row["sessionEpoch"] =
                        serde_json::to_value(event.session_epoch).map_err(|_| corrupt())?;
                    row["direction"] = serde_json::to_value(direction).map_err(|_| corrupt())?;
                    row["byteStart"] = serde_json::to_value(start).map_err(|_| corrupt())?;
                    row["byteEnd"] = serde_json::to_value(end).map_err(|_| corrupt())?;
                    let index = decoders
                        .iter()
                        .position(|(key, stream_direction, _)| {
                            *key == source && *stream_direction == direction
                        })
                        .unwrap_or_else(|| {
                            decoders.push((source, direction, TextDecoder::default()));
                            decoders.len() - 1
                        });
                    let decoder = &mut decoders[index].2;
                    if decoder.byte_end.is_some_and(|previous| previous != start)
                        && let Some(tail) = decoder.flush()
                    {
                        write_row(&mut output, &tail)?;
                    }
                    let span = TextSpan {
                        record_ordinal: record.record_ordinal,
                        volume: location.volume,
                        record_offset: location.offset,
                        record_length: location.length,
                        timestamp: event.time.received_wall_time.clone(),
                        byte_start: start,
                        byte_end: end,
                    };
                    row = decoder.push(row, bytes, span);
                } else {
                    row["entry"] = serde_json::to_value(&record.entry).map_err(|_| corrupt())?;
                }
            }
            _ => row["entry"] = serde_json::to_value(&record.entry).map_err(|_| corrupt())?,
        };
        write_row(&mut output, &row)?;
    }
    for (_, _, decoder) in &mut decoders {
        if let Some(tail) = decoder.flush() {
            write_row(&mut output, &tail)?;
        }
    }
    output.sync_all().map_err(io_error)?;
    drop(output);
    if fingerprint(source)? != scan.report.source_fingerprint {
        return Err(changed());
    }
    temporary.rename_to(destination, false)?;
    destination.sync_parent()
}

fn write_row(output: &mut impl Write, row: &serde_json::Value) -> HostResult<()> {
    serde_json::to_writer(&mut *output, row).map_err(|_| corrupt())?;
    output.write_all(b"\n").map_err(io_error)
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TextSpan {
    record_ordinal: U64,
    volume: U64,
    record_offset: U64,
    record_length: U64,
    timestamp: Timestamp,
    byte_start: U64,
    byte_end: U64,
}
#[derive(Default)]
struct TextDecoder {
    // 每个源/方向最多暂存一个未完成码点（3 字节）及其位置。
    pending: Vec<u8>,
    spans: Vec<TextSpan>,
    row: Option<serde_json::Value>,
    byte_end: Option<U64>,
}
impl TextDecoder {
    fn push(
        &mut self,
        row: serde_json::Value,
        bytes: Vec<u8>,
        span: TextSpan,
    ) -> serde_json::Value {
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(&bytes);
        self.byte_end = Some(span.byte_end);
        self.spans.push(span);
        let mut consumed = 0;
        let mut text = String::new();
        let mut replaced = false;
        while consumed < input.len() {
            match std::str::from_utf8(&input[consumed..]) {
                Ok(valid) => {
                    text.push_str(valid);
                    consumed = input.len();
                }
                Err(error) => {
                    let end = consumed + error.valid_up_to();
                    text.push_str(
                        std::str::from_utf8(&input[consumed..end]).expect("validated UTF-8 prefix"),
                    );
                    consumed = end;
                    if let Some(length) = error.error_len() {
                        text.push('\u{fffd}');
                        replaced = true;
                        consumed += length;
                    } else {
                        break;
                    }
                }
            }
        }
        self.pending.extend_from_slice(&input[consumed..]);
        let mut remaining = consumed as u64;
        let mut output_spans = Vec::new();
        for mut span in std::mem::take(&mut self.spans) {
            let used = remaining.min(span.byte_end.get() - span.byte_start.get());
            if used > 0 {
                let mut used_span = span.clone();
                used_span.byte_end = (span.byte_start.get() + used).into();
                span.byte_start = used_span.byte_end;
                output_spans.push(used_span);
                remaining -= used;
            }
            if span.byte_start < span.byte_end {
                self.spans.push(span);
            }
        }
        self.row = Some(row.clone());
        text_row(row, text, replaced, output_spans)
    }
    fn flush(&mut self) -> Option<serde_json::Value> {
        self.byte_end = None;
        if self.pending.is_empty() {
            return None;
        }
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        Some(text_row(
            self.row.take().expect("pending text source"),
            text,
            true,
            std::mem::take(&mut self.spans),
        ))
    }
}
fn text_row(
    mut row: serde_json::Value,
    text: String,
    replaced: bool,
    spans: Vec<TextSpan>,
) -> serde_json::Value {
    if let (Some(first), Some(last)) = (spans.first(), spans.last()) {
        row["byteStart"] = serde_json::json!(first.byte_start);
        row["byteEnd"] = serde_json::json!(last.byte_end);
    }
    row["text"] = text.into();
    row["hadReplacement"] = replaced.into();
    row["sourceSpans"] = serde_json::json!(spans);
    row
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{
        verify::{CopyPhase, verify_directory},
        writer::{CaptureLimits, CaptureWriter},
    };
    use sha2::{Digest as _, Sha256};
    #[test]
    fn copied_record_must_match_verified_snapshot_despite_source_restore() {
        let d = tempfile::tempdir().unwrap();
        let source = d.path().canonicalize().unwrap().join("source");
        let target = d.path().canonicalize().unwrap().join("target");
        let source_meta = CaptureSource {
            host_id: Id::try_from("h").unwrap(),
            instance_epoch: 1.into(),
            session_id: Id::try_from("s").unwrap(),
            session_epoch: 1.into(),
            configuration_digest: Digest::try_from(
                "0000000000000000000000000000000000000000000000000000000000000000",
            )
            .unwrap(),
            configuration: SerialConfiguration::default(),
            time_precision: TimePrecision {
                source: TimeSource::HostRead,
                resolution_ns: 1.into(),
                sync_method: "none".into(),
                offset_estimate_ns: None,
                offset_error_ns: None,
                rtt_ns: None,
            },
        };
        let event = CaptureEntry::Event(Box::new(serde_json::from_value(serde_json::json!({
            "hostId":"h","instanceEpoch":"1","sessionId":"s","sessionEpoch":"1","eventSeq":"1",
            "configurationRevision":"1","time":{"clockId":"c","sourceMonoNs":"1","receivedWallTime":"2026-11-07T00:00:00Z",
            "precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},
            "kind":"rx","payload":{"bytesBase64":"AQID","byteStart":"0","byteEnd":"3"}
        })).unwrap()));
        let mut writer =
            CaptureWriter::create(&source, vec![source_meta], CaptureLimits::default()).unwrap();
        writer.push(event, 0).unwrap();
        writer.finish().unwrap();
        let scan = verify_directory(&source).unwrap();
        let volume = source.join(volume_name(1));
        let original = std::fs::read(&volume).unwrap();
        let mut altered = original.clone();
        let len = u32::from_le_bytes(original[7..11].try_into().unwrap()) as usize;
        let json = String::from_utf8(original[11..11 + len].to_vec())
            .unwrap()
            .replace("AQID", "CQID");
        assert_eq!(json.len(), len);
        assert_ne!(json.as_bytes(), &original[11..11 + len]);
        altered[11..11 + len].copy_from_slice(json.as_bytes());
        altered[11 + len..11 + len + 32].copy_from_slice(&Sha256::digest(json.as_bytes()));
        let observe = |phase| match phase {
            CopyPhase::BeforeRecord => {
                std::fs::write(&volume, &altered).unwrap();
            }
            CopyPhase::AfterRecord => {
                std::fs::write(&volume, &original).unwrap();
            }
        };
        let result = export_text_observed(&source, &target, observe);
        std::fs::write(&volume, &original).unwrap();
        assert_eq!(
            fingerprint(&source).unwrap(),
            scan.report.source_fingerprint
        );
        assert_eq!(result.unwrap_err().code, "SOURCE_CHANGED");
        assert!(!target.exists(), "unverified bytes must never be published");
    }
}
