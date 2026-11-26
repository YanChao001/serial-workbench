use serial_workbench_core::{HostError, HostResult};
use std::io::{self, Write};

pub fn json(value: &impl serde::Serialize) -> HostResult<()> {
    let mut output = io::stdout().lock();
    serde_json::to_writer(&mut output, value).map_err(|_| unavailable())?;
    output.write_all(b"\n").map_err(|_| unavailable())
}
pub fn exit_code(error: &HostError) -> u8 {
    match error.code.as_str() {
        "INVALID_ARGUMENT" | "LAN_SCOPE_REQUIRED" | "UNSUPPORTED_CAPABILITY" | "NOT_FOUND" => 2,
        "PERMISSION_DENIED"
        | "UNAUTHENTICATED"
        | "ACTOR_MISMATCH"
        | "LAN_AUTHENTICATION_FAILED" => 3,
        "REQUEST_CONFLICT"
        | "REVISION_CONFLICT"
        | "EPOCH_MISMATCH"
        | "HOST_ID_MISMATCH"
        | "STALE_CURSOR"
        | "CATALOG_CHANGED"
        | "RESULT_EXPIRED"
        | "LAN_PEER_CONFLICT"
        | "LAN_HOST_ID_MISMATCH" => 4,
        "BATCH_DEADLINE_EXCEEDED" => 5,
        "BATCH_PARTIAL" => 6,
        "BATCH_UNCONFIRMED" => 7,
        "BATCH_CANCELLED" => 130,
        "HOST_BUSY"
        | "STORAGE_UNAVAILABLE"
        | "HOST_UNAVAILABLE"
        | "HOST_START_FAILED"
        | "HOST_START_TIMEOUT"
        | "LAN_BIND_FAILED"
        | "LAN_UNAVAILABLE"
        | "LAN_CONNECTION_UNAVAILABLE"
        | "HOST_STOP_TIMEOUT" => 5,
        _ => 1,
    }
}
fn unavailable() -> HostError {
    HostError::new("OUTPUT_UNAVAILABLE", "Cannot write CLI output")
}
