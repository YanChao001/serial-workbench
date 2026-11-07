use serial_workbench_core::{HostError, HostResult};
use std::io::{self, Write};

pub fn json(value: &impl serde::Serialize) -> HostResult<()> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, value).map_err(|_| unavailable())?;
    output.write_all(b"\n").map_err(|_| unavailable())
}
pub fn exit_code(error: &HostError) -> u8 {
    match error.code.as_str() {
        "INVALID_ARGUMENT" | "UNSUPPORTED_CAPABILITY" | "NOT_FOUND" => 2,
        "PERMISSION_DENIED" | "UNAUTHENTICATED" | "ACTOR_MISMATCH" => 3,
        "REQUEST_CONFLICT" | "REVISION_CONFLICT" | "EPOCH_MISMATCH" | "HOST_ID_MISMATCH"
        | "STALE_CURSOR" | "CATALOG_CHANGED" | "RESULT_EXPIRED" => 4,
        "HOST_BUSY"
        | "STORAGE_UNAVAILABLE"
        | "HOST_UNAVAILABLE"
        | "HOST_START_FAILED"
        | "HOST_START_TIMEOUT"
        | "HOST_STOP_TIMEOUT" => 5,
        _ => 1,
    }
}
fn unavailable() -> HostError {
    HostError::new("OUTPUT_UNAVAILABLE", "Cannot write CLI output")
}
