import type {
  CaptureRecord,
  FileReadParams,
  FileReadResult,
  ReplayRecord,
} from "@serial-workbench/contracts";
import {
  ContractValidationError,
  parseCaptureRecord,
} from "@serial-workbench/contracts";
export async function readReplayRecord(
  reference: Extract<ReplayRecord, { kind: "reference" }>,
  readFile: (
    params: FileReadParams,
    signal?: AbortSignal,
  ) => Promise<FileReadResult>,
  signal?: AbortSignal,
): Promise<CaptureRecord> {
  signal?.throwIfAborted();
  const length = BigInt(reference.jsonBytes);
  // Bound the display allocation independently of the advertised record size.
  if (length <= 0n || length > 1024n * 1024n)
    throw new ContractValidationError(
      "Replay record exceeds the display budget",
    );
  const bytes = new Uint8Array(Number(length));
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const requested = Math.min(65536, bytes.length - offset);
    const page = await readFile(
      {
        fileRef: reference.recordRef,
        offset: String(offset),
        maxBytes: String(requested),
      },
      signal,
    );
    signal?.throwIfAborted();
    if (
      page.fileRef.hostId !== reference.recordRef.hostId ||
      page.fileRef.kind !== reference.recordRef.kind ||
      page.fileRef.id !== reference.recordRef.id ||
      page.fileRef.revision !== reference.recordRef.revision ||
      page.offset !== String(offset) ||
      page.totalBytes !== reference.jsonBytes ||
      page.fingerprint !== reference.jsonSha256 ||
      page.bytesBase64.length > 4 * Math.ceil(requested / 3)
    )
      throw new ContractValidationError("Replay record page identity changed");
    const binary = atob(page.bytesBase64);
    const next = offset + binary.length;
    if (
      binary.length === 0 ||
      binary.length > requested ||
      page.nextOffset !== String(next) ||
      page.atEnd !== (next === bytes.length)
    )
      throw new ContractValidationError("Replay record page range changed");
    for (let index = 0; index < binary.length; index++)
      bytes[offset + index] = binary.charCodeAt(index);
    offset = next;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  signal?.throwIfAborted();
  const fingerprint = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (fingerprint !== reference.jsonSha256)
    throw new ContractValidationError("Replay record hash changed");
  const record = parseCaptureRecord(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (record.recordOrdinal !== reference.recordOrdinal)
    throw new ContractValidationError("Replay record ordinal changed");
  return record;
}
