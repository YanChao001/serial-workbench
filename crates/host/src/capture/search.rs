use super::ReplayArchive;
use crate::capture::{format::*, verify::SearchVolumeReader};
use base64::Engine as _;
use serial_workbench_core::*;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Weak};

const MAX_PAGE_RECORDS: usize = 1024;
const MAX_PAGE_DISK_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PAGE_HITS: usize = 64;
const MAX_STREAM_DIRECTIONS: usize = 32;

/// A cursor over one verified replay. It does not hold payloads or alter playback.
#[derive(Clone)]
pub(super) struct ReplaySearch {
    reader: Weak<ReplayArchive>,
    needle: Arc<Needle>,
    direction: Option<Direction>,
    record: usize,
    offset: usize,
    streams: HashMap<(SourceIdentity, bool), StreamMatch>,
}

struct Needle {
    bytes: Vec<u8>,
    fallback: Vec<usize>,
}

impl Needle {
    fn new(bytes: Vec<u8>) -> HostResult<Self> {
        if !(1..=REPLAY_SEARCH_MAX_BYTES).contains(&bytes.len()) {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Replay search needs 1 to 256 bytes",
            ));
        }
        let mut fallback = vec![0; bytes.len()];
        let mut length = 0;
        for (index, &byte) in bytes.iter().enumerate().skip(1) {
            while length > 0 && byte != bytes[length] {
                length = fallback[length - 1];
            }
            if byte == bytes[length] {
                length += 1;
            }
            fallback[index] = length;
        }
        Ok(Self { bytes, fallback })
    }
}

#[derive(Clone, PartialEq, Eq)]
struct MessageIdentity {
    id: Id,
    byte_origin: u64,
    length: U64,
}

#[derive(Clone)]
struct StreamMatch {
    configuration: U64,
    message: Option<MessageIdentity>,
    next_byte: u64,
    matched: usize,
    window: VecDeque<U64>,
}

impl StreamMatch {
    fn new(configuration: U64, message: Option<MessageIdentity>, next_byte: u64) -> Self {
        Self {
            configuration,
            message,
            next_byte,
            matched: 0,
            window: VecDeque::new(),
        }
    }

    fn push(
        &mut self,
        needle: &Needle,
        byte: u8,
        record: U64,
        direction: Direction,
    ) -> Option<ReplaySearchHit> {
        if self.window.len() == needle.bytes.len() {
            self.window.pop_front();
        }
        self.window.push_back(record);
        self.next_byte += 1;
        while self.matched > 0 && byte != needle.bytes[self.matched] {
            self.matched = needle.fallback[self.matched - 1];
        }
        if byte == needle.bytes[self.matched] {
            self.matched += 1;
        }
        if self.matched != needle.bytes.len() {
            return None;
        }
        self.matched = needle.fallback[self.matched - 1];
        Some(ReplaySearchHit {
            direction,
            first_record: *self.window.front().expect("non-empty matching window"),
            last_record: record,
            byte_start: U64::from(self.next_byte - needle.bytes.len() as u64),
            byte_end: U64::from(self.next_byte),
        })
    }
}

impl ReplayArchive {
    /// Search the bytes stored for RX and TX intent, using half-open offsets per source.
    pub(super) fn start_search(
        self: &Arc<Self>,
        bytes: Vec<u8>,
        direction: Option<Direction>,
    ) -> HostResult<ReplaySearch> {
        if self.format == CaptureFormat::Redacted {
            return Err(HostError::new(
                "UNSUPPORTED_CAPABILITY",
                "Raw byte search requires an original-byte recording",
            ));
        }
        Ok(ReplaySearch {
            reader: Arc::downgrade(self),
            needle: Arc::new(Needle::new(bytes)?),
            direction,
            record: 0,
            offset: 0,
            streams: HashMap::new(),
        })
    }

    /// Advance only if the current batch and its final authorization check succeed.
    pub(super) fn search_page(
        self: &Arc<Self>,
        search: &mut ReplaySearch,
        mut check: impl FnMut() -> HostResult<()>,
    ) -> HostResult<ReplaySearchPage> {
        if !Weak::ptr_eq(&Arc::downgrade(self), &search.reader) {
            return Err(HostError::new(
                "INVALID_ARGUMENT",
                "Replay search belongs to another reader",
            ));
        }
        check()?;
        self.ensure_directory()?;
        let mut pending = search.clone();
        let mut hits = Vec::new();
        let mut disk_bytes = 0;
        let mut volumes = SearchVolumeReader::new(&self.path, self.format);
        for _ in 0..MAX_PAGE_RECORDS {
            let Some(location) = self.index.records.get(pending.record) else {
                break;
            };
            if disk_bytes + location.length.get() > MAX_PAGE_DISK_BYTES {
                break;
            }
            check()?;
            let (record, observed, bytes) = volumes.read(location)?;
            self.ensure_record_digest(pending.record, observed, &bytes)?;
            disk_bytes += location.length.get();
            pending.scan_record(&record, &mut hits)?;
            if hits.len() == MAX_PAGE_HITS {
                break;
            }
        }
        volumes.verify()?;
        self.ensure_directory()?;
        check()?;
        let scanned_records = pending.record;
        let total_records = self.index.records.len();
        *search = pending;
        Ok(ReplaySearchPage {
            hits,
            scanned_records: U64::from(scanned_records as u64),
            total_records: U64::from(total_records as u64),
            complete: scanned_records == total_records,
        })
    }
}

impl ReplaySearch {
    fn advance_record(&mut self) {
        self.record += 1;
        self.offset = 0;
    }

    fn reset_source(&mut self, source: SourceIdentity, direction: Option<Direction>) {
        if direction != Some(Direction::Tx) {
            self.streams.remove(&(source.clone(), false));
        }
        if direction != Some(Direction::Rx) {
            self.streams.remove(&(source, true));
        }
    }

    fn scan_record(
        &mut self,
        record: &CaptureRecord,
        hits: &mut Vec<ReplaySearchHit>,
    ) -> HostResult<()> {
        let event = match &record.entry {
            CaptureEntry::Event(event) => event,
            CaptureEntry::Redacted(_) => return Err(corrupt()),
            CaptureEntry::ReaderGap(_) => {
                self.reset_source(SourceIdentity::entry(&record.entry), None);
                self.advance_record();
                return Ok(());
            }
            CaptureEntry::TxSettlement(_) => {
                self.advance_record();
                return Ok(());
            }
        };
        let (direction, encoded, start, end, message) = match &event.payload {
            RawPayload::Rx(rx) => (
                Direction::Rx,
                &rx.bytes_base64,
                rx.byte_start,
                rx.byte_end,
                rx.message.as_ref(),
            ),
            RawPayload::TxIntent(tx) => (
                Direction::Tx,
                &tx.bytes_base64,
                tx.byte_start,
                tx.byte_end,
                None,
            ),
            payload => {
                match payload {
                    RawPayload::Gap(gap) => self.reset_source(
                        SourceIdentity::entry(&record.entry),
                        gap.direction
                            .or(gap.missing_byte_range.as_ref().map(|range| range.direction)),
                    ),
                    RawPayload::ConfigurationBoundary(_) | RawPayload::Lifecycle(_) => {
                        self.reset_source(SourceIdentity::entry(&record.entry), None);
                    }
                    _ => {}
                }
                self.advance_record();
                return Ok(());
            }
        };
        if self.direction.is_some_and(|wanted| wanted != direction) {
            self.advance_record();
            return Ok(());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_str())
            .map_err(|_| corrupt())?;
        if end.get().checked_sub(start.get()) != Some(bytes.len() as u64) {
            return Err(corrupt());
        }
        let message = message
            .map(|fragment| {
                let offset = fragment.fragment_offset.get();
                if offset
                    .checked_add(bytes.len() as u64)
                    .is_none_or(|end| end > fragment.message_length.get())
                {
                    return Err(corrupt());
                }
                Ok(MessageIdentity {
                    id: fragment.message_id.clone(),
                    byte_origin: start.get().checked_sub(offset).ok_or_else(corrupt)?,
                    length: fragment.message_length,
                })
            })
            .transpose()?;
        let limit = self.streams.len() == MAX_STREAM_DIRECTIONS;
        let key = (
            SourceIdentity::entry(&record.entry),
            direction == Direction::Tx,
        );
        let first_byte = start.get() + self.offset as u64;
        let configuration = event.configuration_revision;
        let state = match self.streams.entry(key) {
            std::collections::hash_map::Entry::Occupied(stream) => stream.into_mut(),
            std::collections::hash_map::Entry::Vacant(stream) if !limit => {
                stream.insert(StreamMatch::new(configuration, message.clone(), first_byte))
            }
            std::collections::hash_map::Entry::Vacant(_) => {
                return Err(HostError::new(
                    "LIMIT_EXCEEDED",
                    "Replay search source budget exhausted",
                ));
            }
        };
        if state.next_byte != first_byte
            || state.configuration != configuration
            || state.message != message
        {
            *state = StreamMatch::new(configuration, message, first_byte);
        }
        for &byte in bytes.get(self.offset..).ok_or_else(corrupt)? {
            self.offset += 1;
            if let Some(hit) = state.push(&self.needle, byte, record.record_ordinal, direction) {
                hits.push(hit);
                if hits.len() == MAX_PAGE_HITS {
                    break;
                }
            }
        }
        if self.offset == bytes.len() {
            self.advance_record();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{
        replay::ReplayReader,
        verify::verify_directory,
        writer::{CaptureLimits, CaptureWriter},
    };
    use std::{
        fs,
        io::{Read, Seek, SeekFrom, Write},
        path::PathBuf,
    };

    fn id(value: &str) -> Id {
        Id::try_from(value).unwrap()
    }

    fn precision() -> TimePrecision {
        TimePrecision {
            source: TimeSource::HostRead,
            resolution_ns: U64::from(1),
            sync_method: "none".into(),
            offset_estimate_ns: None,
            offset_error_ns: None,
            rtt_ns: None,
        }
    }

    fn event(host: &str, seq: u64, revision: u64, payload: RawPayload) -> CaptureEntry {
        CaptureEntry::Event(Box::new(RawEvent {
            host_id: id(host),
            instance_epoch: U64::from(1),
            session_id: id("serial"),
            session_epoch: U64::from(1),
            event_seq: seq.into(),
            configuration_revision: revision.into(),
            time: EventTime {
                clock_id: id(host),
                source_mono_ns: seq.into(),
                received_wall_time: Timestamp::try_from("2026-11-25T00:00:00Z").unwrap(),
                precision: precision(),
                source_wall_time: None,
            },
            payload,
        }))
    }

    fn rx(host: &str, seq: u64, revision: u64, start: u64, bytes: &[u8]) -> CaptureEntry {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        event(
            host,
            seq,
            revision,
            RawPayload::Rx(RxPayload {
                bytes_base64: Bytes::try_from(encoded.as_str()).unwrap(),
                byte_start: start.into(),
                byte_end: (start + bytes.len() as u64).into(),
                message: None,
            }),
        )
    }

    fn write_recording(
        entries: impl IntoIterator<Item = CaptureEntry>,
        limits: CaptureLimits,
    ) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("capture.swbc");
        let sources = ["primary", "secondary"]
            .into_iter()
            .map(|host| CaptureSource {
                host_id: id(host),
                instance_epoch: U64::from(1),
                session_id: id("serial"),
                session_epoch: U64::from(1),
                configuration_digest: zero_digest(),
                configuration: SerialConfiguration::default(),
                time_precision: precision(),
            })
            .collect();
        let mut writer = CaptureWriter::create(&path, sources, limits).unwrap();
        for (index, entry) in entries.into_iter().enumerate() {
            writer.push(entry, index as u64).unwrap();
        }
        writer.finish().unwrap();
        (directory, path)
    }

    fn recording(
        entries: impl IntoIterator<Item = CaptureEntry>,
    ) -> (tempfile::TempDir, ReplayReader) {
        let (directory, path) = write_recording(entries, CaptureLimits::default());
        let reader = ReplayReader::open(&path, ReplayMode::Fastest).unwrap();
        (directory, reader)
    }

    #[test]
    fn large_multivolume_replay_rebuilds_invalid_index_and_locates_original_bytes() {
        const RECORDS: u64 = 1024;
        const PAYLOAD_BYTES: u64 = 4096;
        let needle = b"SWB!";
        let entries = (1..=RECORDS).map(|sequence| {
            let mut payload = [0; PAYLOAD_BYTES as usize];
            if sequence == RECORDS {
                payload[..needle.len()].copy_from_slice(needle);
            }
            rx(
                "primary",
                sequence,
                1,
                (sequence - 1) * PAYLOAD_BYTES,
                &payload,
            )
        });
        let (_directory, path) = write_recording(
            entries,
            CaptureLimits {
                volume_bytes: 256 * 1024,
                ..CaptureLimits::default()
            },
        );
        let scan = verify_directory(&path).unwrap();
        let last = scan.index.records.last().unwrap();
        assert!(last.volume.get() > 2);
        let volume_path = path.join(volume_name(last.volume.get()));
        let stored_index = path.join(crate::capture::volume_index::name(last.volume.get()));
        let mut incorrect_bytes = fs::read(&stored_index).unwrap();
        let last_offset =
            incorrect_bytes.len() - crate::capture::volume_index::ENTRY_BYTES as usize;
        incorrect_bytes[last_offset] ^= 1;
        fs::write(&stored_index, &incorrect_bytes).unwrap();
        assert!(!verify_directory(&path).unwrap().report.container_complete);

        let mut reader = ReplayReader::open(&path, ReplayMode::Fastest).unwrap();
        let mut search = reader
            .archive
            .start_search(needle.to_vec(), Some(Direction::Rx))
            .unwrap();
        let mut scanned = 0;
        loop {
            let result = reader.archive.search_page(&mut search, || Ok(())).unwrap();
            assert_eq!(result.total_records.get(), RECORDS);
            let next = result.scanned_records.get();
            assert!(next > scanned && next - scanned <= MAX_PAGE_RECORDS as u64);
            assert_eq!(result.complete, next == RECORDS);
            scanned = next;
            if result.complete {
                let [hit] = result.hits.as_slice() else {
                    panic!("expected exactly one hit in the final volume");
                };
                assert_eq!(hit.first_record.get(), RECORDS);
                assert_eq!(hit.last_record.get(), RECORDS);
                assert_eq!(hit.byte_start.get(), (RECORDS - 1) * PAYLOAD_BYTES);
                assert_eq!(
                    hit.byte_end.get() - hit.byte_start.get(),
                    needle.len() as u64
                );
                reader.seek(hit.first_record, 0).unwrap();
                let step = reader.step(0).unwrap();
                let [ReplayRecord::Inline { record }] = step.records.as_slice() else {
                    panic!("expected the original record at the search hit");
                };
                assert_eq!(record.record_ordinal.get(), RECORDS);
                break;
            } else {
                assert!(result.hits.is_empty());
            }
        }
        assert_eq!(fs::read(stored_index).unwrap(), incorrect_bytes);
        drop(reader);

        let mut volume = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(volume_path)
            .unwrap();
        volume.seek(SeekFrom::End(-1)).unwrap();
        let mut last_byte = [0];
        volume.read_exact(&mut last_byte).unwrap();
        volume.seek(SeekFrom::End(-1)).unwrap();
        volume.write_all(&[last_byte[0] ^ 1]).unwrap();
        drop(volume);
        assert_eq!(
            ReplayReader::open(&path, ReplayMode::Fastest)
                .err()
                .unwrap()
                .code,
            "CAPTURE_INCOMPLETE",
        );
    }

    #[test]
    fn indexed_recording_search_spans_pages_without_mixing_sources_or_moving_playback() {
        let boundary = MAX_PAGE_RECORDS as u64;
        let mut entries: Vec<_> = (1..boundary)
            .map(|seq| event("primary", seq, 1, RawPayload::Control(Default::default())))
            .collect();
        entries.push(rx("primary", boundary, 1, 0, b"AB"));
        entries.push(rx("secondary", 1, 1, 2, b"A"));
        entries.push(rx("primary", boundary + 1, 1, 2, b"ABA"));
        let (_directory, mut reader) = recording(entries);
        reader.seek(42.into(), 0).unwrap();
        let mut search = reader.archive.start_search(b"ABA".to_vec(), None).unwrap();

        let first = reader.archive.search_page(&mut search, || Ok(())).unwrap();
        assert_eq!(first.scanned_records, U64::from(boundary));
        assert!(!first.complete);
        assert!(first.hits.is_empty());

        let second = reader.archive.search_page(&mut search, || Ok(())).unwrap();
        assert!(second.complete);
        assert_eq!(second.total_records, U64::from(boundary + 2));
        assert_eq!(
            second.hits,
            [
                ReplaySearchHit {
                    direction: Direction::Rx,
                    first_record: boundary.into(),
                    last_record: (boundary + 2).into(),
                    byte_start: 0.into(),
                    byte_end: 3.into(),
                },
                ReplaySearchHit {
                    direction: Direction::Rx,
                    first_record: (boundary + 2).into(),
                    last_record: (boundary + 2).into(),
                    byte_start: 2.into(),
                    byte_end: 5.into(),
                },
            ]
        );
        assert_eq!(reader.step(0).unwrap().next_record, U64::from(43));
    }

    #[test]
    fn replacing_a_volume_already_buffered_in_the_current_page_rejects_it() {
        let (directory, reader) =
            recording([rx("primary", 1, 1, 0, b"AB"), rx("primary", 2, 1, 2, b"CD")]);
        let volume = reader.archive.path.join(volume_name(1));
        let bytes = fs::read(&volume).unwrap();
        let mut search = reader.archive.start_search(b"AB".to_vec(), None).unwrap();
        let mut checks = 0;
        let error = reader
            .archive
            .search_page(&mut search, || {
                checks += 1;
                if checks == 3 {
                    fs::rename(&volume, directory.path().join("old-volume")).unwrap();
                    fs::write(&volume, &bytes).unwrap();
                }
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, "SOURCE_CHANGED");
        assert_eq!(search.record, 0);
    }

    #[test]
    fn cancelled_dense_search_page_can_retry_without_skipping_offsets() {
        let (_directory, reader) = recording([rx("primary", 1, 1, 0, &[b'A'; 130])]);
        let mut search = reader
            .archive
            .start_search(vec![b'A'], Some(Direction::Rx))
            .unwrap();

        let first = reader.archive.search_page(&mut search, || Ok(())).unwrap();
        assert_eq!(first.scanned_records, U64::from(0));
        assert_eq!(first.hits.len(), 64);
        assert_eq!(first.hits[63].byte_start, U64::from(63));

        let mut checks = 0;
        let denied = reader
            .archive
            .search_page(&mut search, || {
                checks += 1;
                if checks == 3 {
                    return Err(HostError::new("PERMISSION_DENIED", "fixture grant ended"));
                }
                Ok(())
            })
            .unwrap_err();
        assert_eq!(denied.code, "PERMISSION_DENIED");

        let retried = reader.archive.search_page(&mut search, || Ok(())).unwrap();
        assert_eq!(retried.hits.len(), 64);
        assert_eq!(retried.hits[0].byte_start, U64::from(64));
        let last = reader.archive.search_page(&mut search, || Ok(())).unwrap();
        assert!(last.complete);
        assert_eq!(last.hits.len(), 2);
        assert_eq!(last.hits[1].byte_end, U64::from(130));
    }

    #[test]
    fn search_resets_between_gaps_and_reconfigurations_and_filters_tx() {
        let (_directory, reader) = recording([
            rx("primary", 1, 1, 0, b"AB"),
            event(
                "primary",
                2,
                1,
                RawPayload::Gap(SourceGap {
                    reason: SourceGapReason::SourceUnknown,
                    known_extent: false,
                    missing_event_range: None,
                    missing_byte_range: None,
                    direction: Some(Direction::Rx),
                }),
            ),
            rx("primary", 3, 1, 2, b"AAB"),
            rx("primary", 4, 2, 5, b"A"),
            event(
                "primary",
                5,
                2,
                RawPayload::TxIntent(TxIntent {
                    operation_id: id("send-1"),
                    bytes_base64: Bytes::try_from("QUJB").unwrap(),
                    byte_start: 0.into(),
                    byte_end: 3.into(),
                }),
            ),
            rx("primary", 6, 2, 6, b"ABA"),
        ]);
        let mut receive = reader
            .archive
            .start_search(b"ABA".to_vec(), Some(Direction::Rx))
            .unwrap();
        let found = reader.archive.search_page(&mut receive, || Ok(())).unwrap();
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].first_record, U64::from(6));

        let mut send = reader
            .archive
            .start_search(b"ABA".to_vec(), Some(Direction::Tx))
            .unwrap();
        let found = reader.archive.search_page(&mut send, || Ok(())).unwrap();
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].first_record, U64::from(5));
        assert_eq!(found.hits[0].direction, Direction::Tx);
    }

    #[test]
    fn replay_search_joins_only_contiguous_fragments_of_the_same_message() {
        fn fragment(
            seq: u64,
            start: u64,
            bytes: &[u8],
            packet: &str,
            offset: u64,
            length: u64,
        ) -> CaptureEntry {
            let mut entry = rx("primary", seq, 1, start, bytes);
            let CaptureEntry::Event(event) = &mut entry else {
                unreachable!()
            };
            let RawPayload::Rx(payload) = &mut event.payload else {
                unreachable!()
            };
            payload.message = Some(MessageFragment {
                message_id: id(packet),
                fragment_offset: offset.into(),
                message_length: length.into(),
                message_type: "test".into(),
            });
            entry
        }
        let (_directory, reader) = recording([
            fragment(1, 0, b"AB", "first", 0, 2),
            fragment(2, 2, b"A", "second", 0, 1),
            fragment(3, 3, b"AB", "third", 0, 3),
            fragment(4, 5, b"A", "third", 2, 3),
        ]);
        let mut search = reader.archive.start_search(b"ABA".to_vec(), None).unwrap();
        let found = reader.archive.search_page(&mut search, || Ok(())).unwrap();
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].first_record, U64::from(3));
        assert_eq!(found.hits[0].last_record, U64::from(4));
    }

    #[test]
    fn reopened_replay_requires_a_new_search_cursor() {
        let (_directory, reader) = recording([rx("primary", 1, 1, 0, b"serial")]);
        let mut search = reader
            .archive
            .start_search(b"serial".to_vec(), None)
            .unwrap();
        let another = ReplayReader::open(&reader.archive.path, ReplayMode::Fastest).unwrap();
        assert_eq!(
            another
                .archive
                .search_page(&mut search, || Ok(()))
                .unwrap_err()
                .code,
            "INVALID_ARGUMENT"
        );
        let mut rebuilt = another
            .archive
            .start_search(b"serial".to_vec(), None)
            .unwrap();
        let original = reader.archive.search_page(&mut search, || Ok(())).unwrap();
        assert_eq!(
            another
                .archive
                .search_page(&mut rebuilt, || Ok(()))
                .unwrap()
                .hits,
            original.hits
        );
    }
}
