//! Line buffering sits between the authorized Raw queue and the capture writer.
use super::{CompiledRules, MAX_SAMPLE_BYTES, is_text_line};
use crate::capture::format::{
    RedactionLineEnd, RedactionSourcePosition, SourceIdentity, changed, corrupt, digest,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serial_workbench_core::*;

pub(in crate::capture) struct RecordingRedactor {
    rules: CompiledRules,
    sources: Vec<Source>,
}
struct Source {
    identity: SourceIdentity,
    position: U64,
    rx: Lane,
    tx: Lane,
}
#[derive(Default)]
struct Lane {
    expected: Option<RedactionLineEnd>,
    verified_line_end: bool,
    resync: bool,
    pending: Option<Pending>,
}
struct Pending {
    record: CaptureRedactedRecord,
    bytes: Vec<u8>,
    omitted: Option<CaptureRedactionOmission>,
}
struct Chunk<'a> {
    direction: Direction,
    start: U64,
    end: U64,
    data: &'a Bytes,
}

impl RecordingRedactor {
    pub(in crate::capture) fn new(rules: Vec<CaptureRedactionRule>) -> HostResult<(Self, Digest)> {
        let material = serde_json::to_vec(&("utf8-lines-1", &rules)).map_err(|_| corrupt())?;
        let rules = CompiledRules::new(rules)?;
        Ok((
            Self {
                rules,
                sources: Vec::new(),
            },
            digest(&material),
        ))
    }

    pub(in crate::capture) fn bind_sources(
        &mut self,
        identities: Vec<SourceIdentity>,
        positions: Vec<RedactionSourcePosition>,
    ) {
        self.sources = identities
            .into_iter()
            .zip(positions)
            .map(|(identity, position)| Source {
                identity,
                position: position.event_position,
                rx: Lane::resume(position.rx),
                tx: Lane::resume(position.tx),
            })
            .collect();
    }

    pub(in crate::capture) fn processed(&mut self, source: usize, position: U64) -> HostResult<()> {
        let current = &mut self.sources.get_mut(source).ok_or_else(corrupt)?.position;
        if position < *current {
            return Err(changed());
        }
        *current = position;
        Ok(())
    }

    pub(in crate::capture) fn push(
        &mut self,
        entry: CaptureEntry,
        mut emit: impl FnMut(CaptureEntry) -> HostResult<()>,
    ) -> HostResult<()> {
        let identity = SourceIdentity::entry(&entry);
        let source = self
            .sources
            .iter_mut()
            .find(|source| source.identity == identity)
            .ok_or_else(corrupt)?;
        match entry {
            CaptureEntry::Event(event) => match &event.payload {
                RawPayload::Rx(rx) => source.rx.push(
                    &event,
                    Chunk {
                        direction: Direction::Rx,
                        start: rx.byte_start,
                        end: rx.byte_end,
                        data: &rx.bytes_base64,
                    },
                    &self.rules,
                    &mut emit,
                ),
                RawPayload::TxIntent(tx) => source.tx.push(
                    &event,
                    Chunk {
                        direction: Direction::Tx,
                        start: tx.byte_start,
                        end: tx.byte_end,
                        data: &tx.bytes_base64,
                    },
                    &self.rules,
                    &mut emit,
                ),
                RawPayload::Gap(gap) => {
                    source.boundary(gap.direction, &mut emit)?;
                    let record = record_for_event(&event, gap.missing_byte_range.clone())?;
                    emit(CaptureEntry::Redacted(Box::new(record)))
                }
                RawPayload::ConfigurationBoundary(_) | RawPayload::Lifecycle(_) => {
                    source.boundary(None, &mut emit)
                }
                RawPayload::Control(_) | RawPayload::Tx(_) => Ok(()),
            },
            CaptureEntry::ReaderGap(gap) => {
                source.boundary(None, &mut emit)?;
                emit(CaptureEntry::ReaderGap(gap))
            }
            CaptureEntry::TxSettlement(_) => Ok(()),
            CaptureEntry::Redacted(_) => Err(corrupt()),
        }
    }

    pub(in crate::capture) fn finish(
        &mut self,
        mut emit: impl FnMut(CaptureEntry) -> HostResult<()>,
    ) -> HostResult<Vec<RedactionSourcePosition>> {
        for source in &mut self.sources {
            source
                .rx
                .omit(CaptureRedactionOmission::Incomplete, &mut emit)?;
            source
                .tx
                .omit(CaptureRedactionOmission::Incomplete, &mut emit)?;
        }
        Ok(self
            .sources
            .iter()
            .map(|source| RedactionSourcePosition {
                event_position: source.position,
                rx: source.rx.line_end(),
                tx: source.tx.line_end(),
            })
            .collect())
    }
}

impl Source {
    fn boundary(
        &mut self,
        direction: Option<Direction>,
        emit: &mut impl FnMut(CaptureEntry) -> HostResult<()>,
    ) -> HostResult<()> {
        if direction != Some(Direction::Tx) {
            self.rx.boundary(emit)?;
        }
        if direction != Some(Direction::Rx) {
            self.tx.boundary(emit)?;
        }
        Ok(())
    }
}

impl Lane {
    fn resume(expected: Option<RedactionLineEnd>) -> Self {
        Self {
            expected,
            verified_line_end: expected.is_some(),
            ..Self::default()
        }
    }

    fn line_end(&self) -> Option<RedactionLineEnd> {
        self.expected.filter(|_| self.verified_line_end)
    }

    fn boundary(
        &mut self,
        emit: &mut impl FnMut(CaptureEntry) -> HostResult<()>,
    ) -> HostResult<()> {
        self.omit(CaptureRedactionOmission::Boundary, emit)?;
        self.resync = true;
        self.expected = None;
        self.verified_line_end = false;
        Ok(())
    }

    fn omit(
        &mut self,
        reason: CaptureRedactionOmission,
        emit: &mut impl FnMut(CaptureEntry) -> HostResult<()>,
    ) -> HostResult<()> {
        if let Some(mut pending) = self.pending.take() {
            pending.record.result = CaptureRedactedResult::Omitted {
                reason: pending.omitted.unwrap_or(reason),
            };
            emit(CaptureEntry::Redacted(Box::new(pending.record)))?;
        }
        Ok(())
    }

    fn push(
        &mut self,
        event: &RawEvent,
        chunk: Chunk<'_>,
        rules: &CompiledRules,
        emit: &mut impl FnMut(CaptureEntry) -> HostResult<()>,
    ) -> HostResult<()> {
        let bytes = STANDARD
            .decode(chunk.data.as_str())
            .map_err(|_| corrupt())?;
        if chunk.end.get().checked_sub(chunk.start.get()) != Some(bytes.len() as u64) {
            return Err(corrupt());
        }
        let start = RedactionLineEnd {
            byte_end: chunk.start,
            configuration_revision: event.configuration_revision,
        };
        if let Some(expected) = self.expected {
            if start != expected {
                self.boundary(emit)?;
            }
        } else if chunk.start.get() != 0 {
            self.resync = true;
        }
        self.expected = Some(RedactionLineEnd {
            byte_end: chunk.end,
            configuration_revision: event.configuration_revision,
        });
        let mut offset = chunk.start.get();
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            self.verified_line_end = false;
            let end = offset + part.len() as u64;
            if let Some(pending) = &mut self.pending {
                pending.record.event_end = event.event_seq.checked_next()?;
                pending.record.timestamp = event.time.received_wall_time.clone();
                pending.record.byte_range.as_mut().ok_or_else(corrupt)?.end = end.into();
            } else {
                let record = record_for_event(
                    event,
                    Some(DirectionalRange {
                        direction: chunk.direction,
                        start: offset.into(),
                        end: end.into(),
                    }),
                )?;
                self.pending = Some(Pending {
                    record,
                    bytes: Vec::new(),
                    omitted: self.resync.then_some(CaptureRedactionOmission::Boundary),
                });
            }
            offset = end;
            let pending = self.pending.as_mut().ok_or_else(corrupt)?;
            if pending.omitted.is_none() {
                if pending.bytes.len() + part.len() <= MAX_SAMPLE_BYTES + 2 {
                    pending.bytes.extend_from_slice(part);
                } else {
                    pending.bytes.clear();
                    pending.omitted = Some(CaptureRedactionOmission::LineTooLong);
                }
            }
            if part.ends_with(b"\n") {
                let mut pending = self.pending.take().ok_or_else(corrupt)?;
                pending.record.result = pending.complete(rules)?;
                self.verified_line_end =
                    matches!(&pending.record.result, CaptureRedactedResult::Text { .. });
                emit(CaptureEntry::Redacted(Box::new(pending.record)))?;
                self.resync = false;
            }
        }
        Ok(())
    }
}

impl Pending {
    fn complete(&self, rules: &CompiledRules) -> HostResult<CaptureRedactedResult> {
        if let Some(reason) = self.omitted {
            return Ok(CaptureRedactedResult::Omitted { reason });
        }
        let line = self
            .bytes
            .strip_suffix(b"\r\n")
            .or_else(|| self.bytes.strip_suffix(b"\n"))
            .ok_or_else(corrupt)?;
        if line.len() > MAX_SAMPLE_BYTES {
            return Ok(CaptureRedactedResult::Omitted {
                reason: CaptureRedactionOmission::LineTooLong,
            });
        }
        let Ok(line) = std::str::from_utf8(line) else {
            return Ok(CaptureRedactedResult::Omitted {
                reason: CaptureRedactionOmission::InvalidText,
            });
        };
        if !is_text_line(line) {
            return Ok(CaptureRedactedResult::Omitted {
                reason: CaptureRedactionOmission::InvalidText,
            });
        }
        let (text, replacements) = rules.apply_line(line)?;
        Ok(CaptureRedactedResult::Text {
            text,
            replacements: replacements.into(),
        })
    }
}

fn record_for_event(
    event: &RawEvent,
    byte_range: Option<DirectionalRange>,
) -> HostResult<CaptureRedactedRecord> {
    Ok(CaptureRedactedRecord {
        host_id: event.host_id.clone(),
        instance_epoch: event.instance_epoch,
        session_id: event.session_id.clone(),
        session_epoch: event.session_epoch,
        event_start: event.event_seq,
        event_end: event.event_seq.checked_next()?,
        timestamp: event.time.received_wall_time.clone(),
        byte_range,
        result: CaptureRedactedResult::Omitted {
            reason: CaptureRedactionOmission::Boundary,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacted_contiguous_append_uses_saved_cursor_and_keeps_the_first_complete_line() {
        use crate::capture::{
            format::{CaptureFormat, CaptureSource},
            verify::verify_directory,
            writer::{CaptureLimits, CaptureWriter, native_volume_opener},
        };
        use crate::files::references::PathGuard;
        let receive = |seq: u64, start: u64, data: &[u8]| {
            CaptureEntry::Event(Box::new(serde_json::from_value(serde_json::json!({
                "hostId":"host","instanceEpoch":"1","sessionId":"session","sessionEpoch":"1",
                "eventSeq":seq.to_string(),"configurationRevision":"1",
                "time":{
                    "clockId":"host","sourceMonoNs":"1","receivedWallTime":"2026-11-25T00:00:00Z",
                    "precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}
                },
                "kind":"rx","payload":{
                    "bytesBase64":STANDARD.encode(data),"byteStart":start.to_string(),"byteEnd":(start + data.len() as u64).to_string()
                }
            })).unwrap()))
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap().join("continuous");
        let rules = vec![CaptureRedactionRule {
            pattern: "token=[^ ]+".into(),
            replacement: "token=[hidden]".into(),
        }];
        let (mut redactor, policy) = RecordingRedactor::new(rules.clone()).unwrap();
        let source: CaptureSource = serde_json::from_value(serde_json::json!({
            "hostId":"host","instanceEpoch":"1","sessionId":"session","sessionEpoch":"1",
            "configurationDigest":"0".repeat(64),"configuration":SerialConfiguration::default(),
            "timePrecision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}
        }))
        .unwrap();
        let identities = || vec![SourceIdentity::source(&source)];
        let mut writer = CaptureWriter::create_at_format(
            PathGuard::new(&path).unwrap(),
            vec![source.clone()],
            CaptureLimits::default(),
            native_volume_opener(),
            CaptureFormat::Redacted,
            Some(policy.clone()),
        )
        .unwrap();
        redactor.bind_sources(
            identities(),
            vec![RedactionSourcePosition::without_line_ends(0.into())],
        );
        let first = b"token=FIRST\n";
        redactor
            .push(receive(1, 0, first), |entry| writer.push(entry, 0))
            .unwrap();
        // The raw cursor advances through observed events that produce no transformed record.
        redactor.processed(0, 3.into()).unwrap();
        let resume = redactor.finish(|entry| writer.push(entry, 0)).unwrap();
        writer.finish_in_place(Some(resume)).unwrap();
        drop(writer);
        let volume = path.join("volume-000001.swbr");
        let original = std::fs::read(&volume).unwrap();

        let append = |position| {
            CaptureWriter::append_at_positions(
                PathGuard::new(&path).unwrap(),
                vec![source.clone()],
                CaptureLimits::default(),
                native_volume_opener(),
                Some(vec![position]),
                Some(policy.clone()),
            )
        };
        let (mut writer, resume) = append(3.into()).unwrap();
        let (mut next, _) = RecordingRedactor::new(rules).unwrap();
        next.bind_sources(identities(), resume.unwrap());
        next.push(receive(4, first.len() as u64, b"token=SECOND\n"), |entry| {
            writer.push(entry, 1)
        })
        .unwrap();
        next.processed(0, 5.into()).unwrap();
        let resume = next.finish(|entry| writer.push(entry, 1)).unwrap();
        writer.finish_in_place(Some(resume)).unwrap();
        drop(writer);

        let mut scan = verify_directory(&path).unwrap();
        assert!(scan.report.container_complete && scan.report.source_continuous);
        assert_eq!(scan.report.verified_prefix.get(), 2);
        scan.bind_files(&path).unwrap();
        let CaptureEntry::Redacted(second) = scan.read_verified_record(1).unwrap().entry else {
            panic!("expected transformed line")
        };
        assert_eq!(
            second.result,
            CaptureRedactedResult::Text {
                text: "token=[hidden]".into(),
                replacements: 1.into()
            }
        );
        assert_eq!(second.byte_range.unwrap().start.get(), first.len() as u64);
        let manifest = scan.manifest.clone();
        drop(scan);

        assert_eq!(append(4.into()).err().unwrap().code, "SOURCE_CHANGED");
        let manifest_path = path.join("manifest.json");
        let mut tampered = manifest.clone();
        tampered.redaction_resume.as_mut().unwrap()[0]
            .rx
            .as_mut()
            .unwrap()
            .byte_end = 1.into();
        std::fs::write(&manifest_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
        assert!(!verify_directory(&path).unwrap().report.container_complete);
        let mut legacy = manifest;
        legacy.redaction_resume = None;
        let legacy = serde_json::to_vec(&legacy).unwrap();
        std::fs::write(&manifest_path, &legacy).unwrap();
        assert!(verify_directory(&path).unwrap().report.container_complete);
        assert_eq!(append(5.into()).err().unwrap().code, "CAPTURE_INCOMPLETE");
        assert_eq!(std::fs::read(&manifest_path).unwrap(), legacy);
        assert_eq!(std::fs::read(volume).unwrap(), original);
    }

    #[test]
    fn discontinuity_invalid_text_and_stop_never_return_pending_bytes() {
        let rules = vec![CaptureRedactionRule {
            pattern: "secret=[^ ]+".into(),
            replacement: "secret=[hidden]".into(),
        }];
        let (mut redactor, _) = RecordingRedactor::new(rules).unwrap();
        let mut records = Vec::new();
        let base: RawEvent = serde_json::from_value(serde_json::json!({
            "hostId":"host","instanceEpoch":"1","sessionId":"session","sessionEpoch":"1",
            "eventSeq":"1","configurationRevision":"1",
            "time":{
                "clockId":"host","sourceMonoNs":"1","receivedWallTime":"2026-11-25T00:00:00Z",
                "precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}
            },
            "kind":"rx","payload":{"bytesBase64":"AA==","byteStart":"0","byteEnd":"1"}
        }))
        .unwrap();
        redactor.bind_sources(
            vec![SourceIdentity::entry(&CaptureEntry::Event(Box::new(
                base.clone(),
            )))],
            vec![RedactionSourcePosition::without_line_ends(0.into())],
        );
        assert!(
            crate::capture::format::CaptureFormat::Redacted
                .validate_entry(&CaptureEntry::Event(Box::new(base.clone())))
                .is_err()
        );
        let long = [b'a'; MAX_SAMPLE_BYTES + 1];
        let contiguous_inputs: [(u64, u64, &[u8]); 6] = [
            (5, 1, b"clipped\nclean\n"),
            (19, 1, b"secret=EARLY"),
            (31, 2, b"-AFTER\n\xffbroken\n"),
            (46, 2, &long),
            (46 + long.len() as u64, 2, b"\n"),
            (47 + long.len() as u64, 2, b"secret=UNTERMINATED"),
        ];
        for (index, (start, revision, bytes)) in contiguous_inputs.into_iter().enumerate() {
            let mut event = base.clone();
            event.event_seq = (index as u64 + 1).into();
            event.configuration_revision = revision.into();
            event.payload = RawPayload::Rx(RxPayload {
                bytes_base64: Bytes::try_from(STANDARD.encode(bytes).as_str()).unwrap(),
                byte_start: start.into(),
                byte_end: (start + bytes.len() as u64).into(),
                message: None,
            });
            redactor
                .push(CaptureEntry::Event(Box::new(event)), |entry| {
                    records.push(entry);
                    Ok(())
                })
                .unwrap();
        }
        redactor
            .finish(|entry| {
                records.push(entry);
                Ok(())
            })
            .unwrap();
        assert!(records.iter().all(|entry| {
            crate::capture::format::CaptureFormat::Legacy
                .validate_entry(entry)
                .is_err()
        }));
        let actual: Vec<_> = records
            .into_iter()
            .map(|entry| {
                let CaptureEntry::Redacted(record) = entry else {
                    panic!("expected transformed record");
                };
                record.result
            })
            .collect();
        use CaptureRedactionOmission::{Boundary, Incomplete, InvalidText, LineTooLong};
        let omitted = |reason| CaptureRedactedResult::Omitted { reason };
        assert_eq!(
            actual,
            [
                omitted(Boundary),
                CaptureRedactedResult::Text {
                    text: "clean".into(),
                    replacements: 0.into()
                },
                omitted(Boundary),
                omitted(Boundary),
                omitted(InvalidText),
                omitted(LineTooLong),
                omitted(Incomplete),
            ],
        );
    }
}
