//! Explicit test-only writer fixture for the independent Node acceptance reader.
//! Expected values are derived from input before any writer or parser is called.
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use serial_workbench_core::*;
use serial_workbench_host::capture::{
    format::CaptureSource,
    writer::{CaptureLimits, CaptureWriter},
};
use sha2::{Digest as _, Sha256};
use std::{ffi::OsString, path::PathBuf};

type Result<T> = std::result::Result<T, String>;
fn checked<T>(value: std::result::Result<T, impl std::fmt::Debug>) -> Result<T> {
    value.map_err(|error| format!("{error:?}"))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn id(value: &str) -> Id {
    Id::try_from(value).expect("fixed fixture identity")
}
fn source() -> Result<CaptureSource> {
    Ok(CaptureSource {
        host_id: id("fixture-host"),
        instance_epoch: U64::from(9_007_199_254_740_993),
        session_id: id("fixture-session"),
        session_epoch: 7.into(),
        configuration_digest: checked(Digest::try_from(
            digest(&checked(serde_json::to_vec(
                &SerialConfiguration::default(),
            ))?)
            .as_str(),
        ))?,
        configuration: SerialConfiguration::default(),
        time_precision: TimePrecision {
            source: TimeSource::HostRead,
            resolution_ns: 1.into(),
            sync_method: "none".into(),
            offset_estimate_ns: None,
            offset_error_ns: None,
            rtt_ns: None,
        },
    })
}
fn event(sequence: u64, kind: &str, payload: Value) -> Value {
    json!({"kind":"event","value":{"hostId":"fixture-host","instanceEpoch":"9007199254740993","sessionId":"fixture-session","sessionEpoch":"7","eventSeq":sequence.to_string(),"configurationRevision":"2","time":{"clockId":"fixture-clock","sourceMonoNs":"9007199254741001","receivedWallTime":"2026-11-08T00:00:00Z","precision":{"source":"host_read","resolutionNs":"1","syncMethod":"none"}},"kind":kind,"payload":payload}})
}
fn receipt(unknown: bool) -> Value {
    json!({"operationId":"fixture-owner","sessionId":"fixture-session","sessionEpoch":"7","outcome":if unknown{"unknown"}else{"partial"},"bytesBase64":if unknown{"BgcICQ=="}else{"AAECAwQF"},"byteStart":if unknown{"6"}else{"0"},"byteEnd":if unknown{"10"}else{"6"},"acceptedRanges":if unknown{json!([])}else{json!([{"start":"0","end":"2"}])},"unknownRanges":if unknown{json!([{"start":"6","end":"10"}])}else{json!([{"start":"2","end":"4"}])},"peerAcknowledged":false,"backendError":{"code":"FIXTURE_UNCERTAIN","message":"Fixed unknown evidence","retryable":false}})
}
fn input_records() -> Result<Vec<CaptureRecord>> {
    let entries = [
        event(1, "lifecycle", json!({"state":"open"})),
        event(
            2,
            "rx",
            json!({"bytesBase64":"AP8NCg==","byteStart":"0","byteEnd":"4"}),
        ),
        event(
            3,
            "tx_intent",
            json!({"operationId":"fixture-owner","bytesBase64":"AAECAwQF","byteStart":"0","byteEnd":"6"}),
        ),
        event(4, "tx", receipt(false)),
        event(
            5,
            "tx_intent",
            json!({"operationId":"fixture-owner","bytesBase64":"BgcICQ==","byteStart":"6","byteEnd":"10"}),
        ),
        json!({"kind":"tx_settlement","value":{"hostId":"fixture-host","instanceEpoch":"9007199254740993","receipt":receipt(true)}}),
        event(
            6,
            "rx",
            json!({"bytesBase64":"UkVBRFlcMA==","byteStart":"4","byteEnd":"11"}),
        ),
        event(7, "control", json!({"line":"dtr","value":true})),
    ];
    entries
        .into_iter()
        .enumerate()
        .map(|(index, entry)| {
            Ok(CaptureRecord {
                record_ordinal: ((index + 1) as u64).into(),
                entry: checked(serde_json::from_value(entry))?,
            })
        })
        .collect()
}
// Fixture-side semantic receipt hashing: recursive lexicographic object keys,
// original array order, compact JSON. This does not read container bytes.
fn canonical(value: &Value) -> Result<String> {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort();
            let fields: Result<Vec<_>> = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        checked(serde_json::to_string(key))?,
                        canonical(&object[key])?
                    ))
                })
                .collect();
            Ok(format!("{{{}}}", fields?.join(",")))
        }
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(canonical)
                .collect::<Result<Vec<_>>>()?
                .join(",")
        )),
        _ => checked(serde_json::to_string(value)),
    }
}
fn expected(source: &CaptureSource, records: &[CaptureRecord]) -> Result<Value> {
    let mut raw = Vec::new();
    let mut receipts = Vec::new();
    let mut record_hashes = Vec::new();
    for record in records {
        record_hashes.push(digest(&checked(serde_json::to_vec(record))?));
        let (kind, payload, receipt, identity) = match &record.entry {
            CaptureEntry::Event(event) => {
                let identity = json!({"hostId":event.host_id,"instanceEpoch":event.instance_epoch,"sessionId":event.session_id,"sessionEpoch":event.session_epoch});
                match &event.payload {
                    RawPayload::Rx(value) => (
                        "rx",
                        Some((
                            value.bytes_base64.as_str(),
                            value.byte_start,
                            value.byte_end,
                        )),
                        None,
                        identity,
                    ),
                    RawPayload::TxIntent(value) => (
                        "tx_intent",
                        Some((
                            value.bytes_base64.as_str(),
                            value.byte_start,
                            value.byte_end,
                        )),
                        None,
                        identity,
                    ),
                    RawPayload::Tx(value) => (
                        "tx",
                        Some((
                            value.bytes_base64.as_str(),
                            value.byte_start,
                            value.byte_end,
                        )),
                        Some(value.as_ref()),
                        identity,
                    ),
                    _ => ("event", None, None, identity),
                }
            }
            CaptureEntry::TxSettlement(value) => {
                let receipt = &value.receipt;
                (
                    "tx_settlement",
                    Some((
                        receipt.bytes_base64.as_str(),
                        receipt.byte_start,
                        receipt.byte_end,
                    )),
                    Some(receipt),
                    json!({"hostId":value.host_id,"instanceEpoch":value.instance_epoch,"sessionId":receipt.session_id,"sessionEpoch":receipt.session_epoch}),
                )
            }
            CaptureEntry::ReaderGap(_) => {
                return Err("Fixed input must not silently introduce a reader gap".into());
            }
        };
        if let Some((base64, start, end)) = payload {
            let bytes = checked(STANDARD.decode(base64))?;
            let hex = bytes
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<Vec<_>>()
                .join("");
            raw.push(json!({"recordOrdinal":record.record_ordinal,"kind":kind,"byteStart":start,"byteEnd":end,"bytesHex":hex,"sha256":digest(&bytes)}));
        }
        if let Some(receipt) = receipt {
            let value = checked(serde_json::to_value(receipt))?;
            receipts.push(json!({"recordOrdinal":record.record_ordinal,"source":identity,"receipt":value,"receiptSha256":digest(canonical(&value)?.as_bytes())}));
        }
    }
    Ok(
        json!({"fixtureVersion":"1","minimumVolumes":2,"streams":[source],"records":records,"recordJsonSha256":record_hashes,"rawPayloads":raw,"finalReceipts":receipts}),
    )
}
fn output(args: impl IntoIterator<Item = OsString>) -> Result<PathBuf> {
    let args: Vec<_> = args.into_iter().collect();
    if args.len() != 2 || args[0] != "--output" {
        return Err("Usage: capture_fixture --output <new-absolute-directory>".into());
    }
    let path = PathBuf::from(&args[1]);
    if !path.is_absolute() || path.exists() {
        return Err("Fixture output must be a new absolute directory".into());
    }
    Ok(path)
}
fn run() -> Result<()> {
    let output = output(std::env::args_os().skip(1))?;
    let source = source()?;
    let records = input_records()?;
    // The complete oracle exists before the writer is constructed. Never derive
    // it from Rust verify/replay or from an emitted manifest/index/volume.
    let expected = expected(&source, &records)?;
    checked(std::fs::create_dir(&output))?;
    checked(std::fs::write(
        output.join("expected.json"),
        checked(serde_json::to_vec_pretty(&expected))?,
    ))?;
    let mut writer = checked(CaptureWriter::create(
        &output.join("capture"),
        vec![source],
        CaptureLimits {
            volume_bytes: 2048,
            ..CaptureLimits::default()
        },
    ))?;
    for (index, record) in records.into_iter().enumerate() {
        checked(writer.push(record.entry, (index as u64 + 1) * 1_000_000_000))?;
    }
    checked(writer.finish())?;
    println!(
        "Wrote fixed capture fixture with 8 input records; independent Node validation is still required"
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("capture fixture failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_oracle_preserves_all_events_binary_bytes_and_both_owner_blocks() {
        let input = input_records().unwrap();
        let expected = expected(&source().unwrap(), &input).unwrap();
        assert_eq!(input.len(), 8);
        assert_eq!(expected["rawPayloads"].as_array().unwrap().len(), 6);
        assert_eq!(expected["finalReceipts"].as_array().unwrap().len(), 2);
        assert_eq!(
            expected["finalReceipts"][0]["receipt"]["outcome"],
            "partial"
        );
        assert_eq!(
            expected["finalReceipts"][1]["receipt"]["outcome"],
            "unknown"
        );
        assert_eq!(expected["rawPayloads"][0]["bytesHex"], "00ff0d0a");
        assert_eq!(
            expected["finalReceipts"][0]["source"]["instanceEpoch"],
            "9007199254740993"
        );
    }
}
