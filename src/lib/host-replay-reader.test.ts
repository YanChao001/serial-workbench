// @vitest-environment node
import { expect, it, vi } from "vitest";
import type {
  CaptureRecord,
  FileReadParams,
  FileReadResult,
  ReplayRecord,
} from "@serial-workbench/contracts";
import { readReplayRecord } from "./host-reader";
import { ContractValidationError } from "@serial-workbench/contracts";
function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
const record: CaptureRecord = {
  recordOrdinal: "1",
  entry: {
    kind: "reader_gap",
    value: {
      hostId: "host",
      instanceEpoch: "1",
      sessionId: "session",
      sessionEpoch: "1",
      reason: "reader_overflow",
      missingEventRange: { start: "1", end: "2" },
    },
  },
};
async function source(text = " ".repeat(66000) + JSON.stringify(record)) {
  const bytes = new TextEncoder().encode(text);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const reference: Extract<ReplayRecord, { kind: "reference" }> = {
    kind: "reference",
    recordRef: {
      hostId: "host",
      kind: "capture_record",
      id: "record-one",
      revision: "1",
    },
    recordOrdinal: "1",
    jsonBytes: String(bytes.length),
    jsonSha256: hash,
  };
  const readFile = vi.fn(
    async (
      params: FileReadParams,
      _signal?: AbortSignal,
    ): Promise<FileReadResult> => {
      const offset = Number(params.offset);
      const end = Math.min(bytes.length, offset + Number(params.maxBytes));
      return {
        fileRef: reference.recordRef,
        offset: String(offset),
        nextOffset: String(end),
        totalBytes: String(bytes.length),
        bytesBase64: base64(bytes.slice(offset, end)),
        fingerprint: hash,
        atEnd: end === bytes.length,
      };
    },
  );
  return { reference, readFile };
}
it("reads a bounded record in 64 KiB pages and verifies its hash and generated schema", async () => {
  const { reference, readFile } = await source();
  expect(await readReplayRecord(reference, readFile)).toEqual(record);
  expect(readFile).toHaveBeenCalledTimes(2);
  expect(readFile.mock.calls.map(([params]) => params.offset)).toEqual([
    "0",
    "65536",
  ]);
  expect(
    readFile.mock.calls.every(([params]) => BigInt(params.maxBytes) <= 65536n),
  ).toBe(true);
});
it("rejects an oversized declared record before allocating or requesting pages", async () => {
  const { reference, readFile } = await source();
  await expect(
    readReplayRecord({ ...reference, jsonBytes: "1048577" }, readFile),
  ).rejects.toBeInstanceOf(ContractValidationError);
  expect(readFile).not.toHaveBeenCalled();
});
it.each(["offset", "fingerprint", "reference", "hash"])(
  "rejects a %s mismatch",
  async (field) => {
    const { reference, readFile } = await source(JSON.stringify(record));
    const page = await readFile({
      fileRef: reference.recordRef,
      offset: "0",
      maxBytes: "65536",
    });
    if (field === "offset") page.nextOffset = "0";
    if (field === "fingerprint") page.fingerprint = "0".repeat(64);
    if (field === "reference")
      page.fileRef = { ...page.fileRef, id: "different" };
    if (field === "hash")
      page.bytesBase64 = base64(
        new TextEncoder().encode(
          JSON.stringify(record).replace("host", "lost"),
        ),
      );
    readFile.mockResolvedValue(page);
    await expect(readReplayRecord(reference, readFile)).rejects.toBeInstanceOf(
      ContractValidationError,
    );
  },
);
it("rejects a matching-hash payload whose record ordinal or schema does not match", async () => {
  for (const payload of [
    { ...record, recordOrdinal: "2" },
    { ...record, extra: true },
  ]) {
    const { reference, readFile } = await source(JSON.stringify(payload));
    await expect(readReplayRecord(reference, readFile)).rejects.toBeInstanceOf(
      ContractValidationError,
    );
  }
});
it("stops before another page when the consumer aborts a pending read", async () => {
  const { reference, readFile } = await source();
  const controller = new AbortController();
  const read = readFile.getMockImplementation();
  if (!read) throw new Error("reader missing");
  readFile.mockImplementation(async (params) => {
    const result = await read(params);
    controller.abort();
    return result;
  });
  await expect(
    readReplayRecord(reference, readFile, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(readFile).toHaveBeenCalledTimes(1);
});
