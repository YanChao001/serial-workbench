import type {
  CaptureRecord,
  FileReadParams,
  FileReadResult,
  ObjectRef,
  ReplayRecord,
} from "@serial-workbench/contracts";
import {
  ContractValidationError,
  parseCaptureRecord,
} from "@serial-workbench/contracts";
import { parseU64 } from "./u64";

type FileReader = (
  params: FileReadParams,
  signal?: AbortSignal,
) => Promise<FileReadResult>;

/** Read one immutable, bounded result, checking the identity and digest across all pages. */
export async function readVerifiedFile(
  reference: ObjectRef,
  readFile: FileReader,
  signal?: AbortSignal,
  expected?: { totalBytes: string; fingerprint: string },
): Promise<Uint8Array<ArrayBuffer>> {
  signal?.throwIfAborted();
  let metadata = expected;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let offset = 0;
  do {
    signal?.throwIfAborted();
    const advertised = parseU64(metadata?.totalBytes);
    if (
      metadata &&
      (advertised === undefined || advertised === 0n || advertised > 1_048_576n)
    )
      throw new ContractValidationError(
        "File result exceeds the display budget",
      );
    const requested = Math.min(
      65536,
      advertised === undefined ? 65536 : Number(advertised) - offset,
    );
    const page = await readFile(
      {
        fileRef: reference,
        offset: String(offset),
        maxBytes: String(requested),
      },
      signal,
    );
    signal?.throwIfAborted();
    metadata ??= { totalBytes: page.totalBytes, fingerprint: page.fingerprint };
    if (
      page.fileRef.hostId !== reference.hostId ||
      page.fileRef.kind !== reference.kind ||
      page.fileRef.id !== reference.id ||
      page.fileRef.revision !== reference.revision ||
      page.offset !== String(offset) ||
      page.totalBytes !== metadata.totalBytes ||
      page.fingerprint !== metadata.fingerprint ||
      page.bytesBase64.length > 4 * Math.ceil(requested / 3)
    )
      throw new ContractValidationError("File result page identity changed");
    if (!bytes) {
      const length = parseU64(metadata.totalBytes);
      if (length === undefined || length === 0n || length > 1_048_576n)
        throw new ContractValidationError(
          "File result exceeds the display budget",
        );
      bytes = new Uint8Array(Number(length));
    }
    const binary = atob(page.bytesBase64);
    const next = offset + binary.length;
    if (
      binary.length === 0 ||
      binary.length > requested ||
      next > bytes.length ||
      page.nextOffset !== String(next) ||
      page.atEnd !== (next === bytes.length)
    )
      throw new ContractValidationError("File result page range changed");
    for (let index = 0; index < binary.length; index++)
      bytes[offset + index] = binary.charCodeAt(index);
    offset = next;
  } while (offset < bytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  signal?.throwIfAborted();
  const fingerprint = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (fingerprint !== metadata.fingerprint)
    throw new ContractValidationError("File result hash changed");
  return bytes;
}

export async function readReplayRecord(
  reference: Extract<ReplayRecord, { kind: "reference" }>,
  readFile: FileReader,
  signal?: AbortSignal,
): Promise<CaptureRecord> {
  const bytes = await readVerifiedFile(reference.recordRef, readFile, signal, {
    totalBytes: reference.jsonBytes,
    fingerprint: reference.jsonSha256,
  });
  const record = parseCaptureRecord(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (record.recordOrdinal !== reference.recordOrdinal)
    throw new ContractValidationError("Replay record ordinal changed");
  return record;
}
