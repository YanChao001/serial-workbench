//! 独立回放核对签名终端原生场景保存的录制。
#[path = "support/terminal_capture.rs"]
mod terminal_capture;

use serde::Deserialize;
use serde_json::json;
use serial_workbench_core::{Id, U64};
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostIdentity {
    host_id: Id,
    instance_epoch: U64,
}

fn main() -> Result<(), Box<dyn Error>> {
    let [capture, expected, host]: [PathBuf; 3] = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>()
        .try_into()
        .map_err(|_| "Usage: terminal_capture_check <capture directory> <expected RX file> <Host evidence JSON>")?;
    let expected = fs::read(expected)?;
    let host: HostIdentity = serde_json::from_slice(&fs::read(host)?)?;
    let checked = terminal_capture::check(&capture, &expected)?;
    let first = &checked.rx[0];
    if first.host_id != host.host_id || first.instance_epoch != host.instance_epoch {
        return Err("The recording belongs to a different Host instance".into());
    }
    println!(
        "{}",
        json!({
            "hostId": first.host_id, "instanceEpoch": first.instance_epoch,
            "sessionId": first.session_id, "sessionEpoch": first.session_epoch,
            "sourceFingerprint": checked.report.source_fingerprint,
            "verifiedRecords": checked.report.verified_prefix,
            "rxEvents": checked.rx.len(), "rxBytes": expected.len(),
            "rxSha256": format!("{:x}", Sha256::digest(&expected)),
        })
    );
    Ok(())
}
