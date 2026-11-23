use super::*;
use crate::capture::writer::{CaptureLimits, CaptureWriter};
use serde_json::{Value, json};

fn source(session: &str, epoch: u64) -> CaptureSource {
    serde_json::from_value(json!({
        "hostId":"h","instanceEpoch":"1","sessionId":session,"sessionEpoch":epoch.to_string(),
        "configurationDigest":"0000000000000000000000000000000000000000000000000000000000000000",
        "configuration":SerialConfiguration::default(),"timePrecision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}
    })).unwrap()
}
fn event(
    session: &str,
    epoch: u64,
    seq: u64,
    direction: &str,
    start: usize,
    bytes: &[u8],
) -> CaptureEntry {
    let mut payload = json!({"bytesBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"byteStart":start.to_string(),"byteEnd":(start+bytes.len()).to_string()});
    if direction == "tx_intent" {
        payload["operationId"] = "tx-owner".into();
    }
    CaptureEntry::Event(Box::new(serde_json::from_value(json!({
        "hostId":"h","instanceEpoch":"1","sessionId":session,"sessionEpoch":epoch.to_string(),"eventSeq":seq.to_string(),"configurationRevision":"1",
        "time":{"clockId":"c","sourceMonoNs":seq.to_string(),"receivedWallTime":"2026-11-07T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},
        "kind":direction,"payload":payload
    })).unwrap()))
}
fn export(sources: Vec<CaptureSource>, entries: Vec<CaptureEntry>) -> Vec<Value> {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut writer =
        CaptureWriter::create(&root.join("source"), sources, CaptureLimits::default()).unwrap();
    for entry in entries {
        writer.push(entry, 0).unwrap();
    }
    writer.finish().unwrap();
    export_text(&root.join("source"), &root.join("text.jsonl")).unwrap();
    std::fs::read_to_string(root.join("text.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}
fn text(rows: &[Value]) -> String {
    rows.iter().filter_map(|row| row["text"].as_str()).collect()
}

#[test]
fn final_fix_utf8_all_multibyte_split_points_preserve_text_and_record_spans() {
    for value in ["¢", "中", "😀"] {
        for split in 1..value.len() {
            let rows = export(
                vec![source("s", 1)],
                vec![
                    event("s", 1, 1, "rx", 0, &value.as_bytes()[..split]),
                    event("s", 1, 2, "rx", split, &value.as_bytes()[split..]),
                ],
            );
            assert_eq!(text(&rows), value, "split {split} in {value}");
            assert!(
                rows.iter()
                    .filter(|r| r.get("text").is_some())
                    .all(|r| r["hadReplacement"] == false)
            );
            let row = rows.iter().find(|r| r["text"] == value).unwrap();
            let spans = row["sourceSpans"]
                .as_array()
                .expect("cross-record text needs exact byte and record provenance");
            assert_eq!(spans.len(), 2);
            assert_eq!(spans[0]["recordOrdinal"], "1");
            assert_eq!(spans[1]["recordOrdinal"], "2");
            assert_eq!(spans[0]["byteStart"], "0");
            assert_eq!(spans[0]["byteEnd"], split.to_string());
            assert_eq!(spans[1]["byteStart"], split.to_string());
            assert_eq!(spans[1]["byteEnd"], value.len().to_string());
            for span in spans {
                assert!(span["volume"].is_string());
                assert!(span["recordOffset"].is_string());
                assert!(span["recordLength"].is_string());
            }
        }
    }
}

#[test]
fn final_fix_utf8_decoder_isolates_source_direction_and_epoch() {
    let rows = export(
        vec![source("s", 1), source("other", 1), source("s", 2)],
        vec![
            event("s", 1, 1, "rx", 0, &[0xe4]),
            event("s", 1, 2, "tx_intent", 0, &[0xc2]),
            event("other", 1, 1, "rx", 0, &[0xf0, 0x9f]),
            event("s", 2, 1, "rx", 0, &[0xe6]),
            event("s", 1, 3, "rx", 1, &[0xb8, 0xad]),
            event("s", 1, 4, "tx_intent", 1, &[0xa2]),
            event("other", 1, 2, "rx", 2, &[0x98, 0x80]),
            event("s", 2, 2, "rx", 1, &[0x96, 0x87]),
        ],
    );
    for (session, epoch, direction, want) in [
        ("s", "1", "rx", "中"),
        ("s", "1", "tx", "¢"),
        ("other", "1", "rx", "😀"),
        ("s", "2", "rx", "文"),
    ] {
        let selected: Vec<_> = rows
            .iter()
            .filter(|r| {
                r["sessionId"] == session
                    && r["sessionEpoch"] == epoch
                    && r["direction"] == direction
            })
            .cloned()
            .collect();
        assert_eq!(text(&selected), want);
        assert!(selected.iter().all(|r| r["hadReplacement"] == false));
    }
}

#[test]
fn final_fix_utf8_gap_and_stream_end_flush_only_real_truncated_tails() {
    let gap = CaptureEntry::ReaderGap(Box::new(ReaderGap {
        host_id: Id::try_from("h").unwrap(),
        instance_epoch: 1.into(),
        session_id: Id::try_from("s").unwrap(),
        session_epoch: 1.into(),
        reason: ReaderGapReason::ReaderOverflow,
        missing_event_range: ByteRange {
            start: 2.into(),
            end: 3.into(),
        },
        missing_byte_ranges: None,
    }));
    let rows = export(
        vec![source("s", 1)],
        vec![
            event("s", 1, 1, "rx", 0, &[0xe4, 0xb8]),
            gap,
            event("s", 1, 3, "rx", 3, &[0xad]),
            event("s", 1, 4, "rx", 4, &[0xf0, 0x9f]),
        ],
    );
    assert_eq!(text(&rows), "���");
    assert!(
        rows.iter()
            .filter(|r| r["text"].as_str().is_some_and(|s| !s.is_empty()))
            .all(|r| r["hadReplacement"] == true)
    );
    let tail = rows
        .iter()
        .find(|r| {
            r["text"] == "�"
                && r["sourceSpans"]
                    .as_array()
                    .is_some_and(|spans| spans.iter().any(|s| s["recordOrdinal"] == "4"))
        })
        .expect("truncated EOF must preserve its source record");
    assert_eq!(tail["sourceSpans"][0]["byteStart"], "4");
    assert_eq!(tail["sourceSpans"][0]["byteEnd"], "6");
}

#[test]
fn csv_preserves_jsonl_rows_and_never_replaces_an_existing_export() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let capture = root.join("source");
    let csv = root.join("text.csv");
    let jsonl = root.join("text.jsonl");
    let session = "-source";
    let mut writer =
        CaptureWriter::create(&capture, vec![source(session, 1)], CaptureLimits::default())
            .unwrap();
    let reading = "=SUM(1,2)📟,\"\r\n";
    let split = "=SUM(1,2)".len() + 2;
    let gap = CaptureEntry::ReaderGap(Box::new(ReaderGap {
        host_id: Id::try_from("h").unwrap(),
        instance_epoch: 1.into(),
        session_id: Id::try_from(session).unwrap(),
        session_epoch: 1.into(),
        reason: ReaderGapReason::ReaderOverflow,
        missing_event_range: ByteRange {
            start: 4.into(),
            end: 5.into(),
        },
        missing_byte_ranges: None,
    }));
    for entry in [
        event(session, 1, 1, "rx", 0, &reading.as_bytes()[..split]),
        event(session, 1, 2, "tx_intent", 0, b"tx\t"),
        event(session, 1, 3, "rx", split, &reading.as_bytes()[split..]),
        gap,
    ] {
        writer.push(entry, 0).unwrap();
    }
    writer.finish().unwrap();
    let inside = capture.join("export.csv");
    let source_digest = fingerprint(&capture).unwrap();
    for format in [TextExportFormat::Jsonl, TextExportFormat::Csv] {
        let error = export_text_observed(&capture, &inside, format, |_| {}).unwrap_err();
        assert_eq!(error.code, "INVALID_ARGUMENT");
        assert!(!inside.exists());
        assert_eq!(fingerprint(&capture).unwrap(), source_digest);
    }
    export_text(&capture, &jsonl).unwrap();
    export_text_observed(&capture, &csv, TextExportFormat::Csv, |_| {}).unwrap();
    let output = std::fs::read_to_string(&csv).unwrap();
    let mut lines = output.split_terminator("\r\n");
    let columns: Vec<_> = lines.next().unwrap().split(',').collect();
    assert_eq!(
        columns,
        [
            "recordOrdinal",
            "volume",
            "recordOffset",
            "recordLength",
            "timestamp",
            "hostIdJson",
            "instanceEpoch",
            "sessionIdJson",
            "sessionEpoch",
            "direction",
            "byteStart",
            "byteEnd",
            "textJson",
            "hadReplacement",
            "sourceSpansJson",
            "entryJson"
        ]
    );
    let original = std::fs::read_to_string(&jsonl).unwrap();
    let mut jsonl_rows = original.lines();
    let mut saw_formula_as_text = false;
    let mut saw_spanning_character = false;
    for line in lines {
        let cells = read_csv_cells(line);
        let expected: Value = serde_json::from_str(jsonl_rows.next().unwrap()).unwrap();
        assert_eq!(cells.len(), columns.len());
        for (column, cell) in columns.iter().zip(cells) {
            if let Some(key) = column.strip_suffix("Json") {
                if let Some(value) = expected.get(key) {
                    let parsed: Value = serde_json::from_str(&cell).unwrap();
                    assert_eq!(&parsed, value);
                    if key == "text" && parsed == "=SUM(1,2)" {
                        assert!(cell.starts_with("\"="));
                        saw_formula_as_text = true;
                    }
                    if key == "text" && parsed == "📟,\"\r\n" {
                        assert_eq!(expected["sourceSpans"].as_array().unwrap().len(), 2);
                        saw_spanning_character = true;
                    }
                } else {
                    assert!(cell.is_empty());
                }
            } else if let Some(value) = expected.get(*column) {
                assert_eq!(
                    cell,
                    value
                        .as_str()
                        .map_or_else(|| value.to_string(), str::to_owned)
                );
            } else {
                assert!(cell.is_empty());
            }
        }
    }
    assert!(jsonl_rows.next().is_none());
    assert!(saw_formula_as_text && saw_spanning_character);
    let error = export_text_observed(&capture, &csv, TextExportFormat::Csv, |_| {}).unwrap_err();
    assert_eq!(error.code, "TARGET_EXISTS");
    assert_eq!(std::fs::read_to_string(&csv).unwrap(), output);
}

fn read_csv_cells(line: &str) -> Vec<String> {
    let mut cells = vec![String::new()];
    let mut quoted = false;
    let mut input = line.chars().peekable();
    while let Some(character) = input.next() {
        match character {
            '"' if quoted && input.next_if_eq(&'"').is_some() => {
                cells.last_mut().unwrap().push('"')
            }
            '"' => quoted = !quoted,
            ',' if !quoted => cells.push(String::new()),
            character => cells.last_mut().unwrap().push(character),
        }
    }
    assert!(!quoted);
    cells
}
