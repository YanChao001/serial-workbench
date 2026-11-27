export function replaySourceUnavailable(code: string | undefined): boolean {
  return (
    code === "PERMISSION_DENIED" ||
    code === "NOT_FOUND" ||
    code === "SOURCE_CHANGED" ||
    code === "EPOCH_MISMATCH" ||
    code === "BACKEND_DISCONNECTED"
  );
}
