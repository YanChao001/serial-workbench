import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFixtureContainer } from "./test-capture-container-independent.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  JSON.stringify(value, (_key, child) =>
    child && !Array.isArray(child) && typeof child === "object"
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((key) => [key, child[key]]),
        )
      : child,
  );
const source = {
  hostId: "fixture-host",
  instanceEpoch: "9007199254740993",
  sessionId: "fixture-session",
  sessionEpoch: "7",
};
function inputs() {
  const event = (eventSeq, kind, payload) => ({
    kind: "event",
    value: {
      ...source,
      eventSeq: String(eventSeq),
      configurationRevision: "2",
      time: {
        clockId: "fixture-clock",
        sourceMonoNs: "9007199254741001",
        receivedWallTime: "2026-11-08T00:00:00Z",
        precision: {
          source: "host_read",
          resolutionNs: "1",
          syncMethod: "none",
        },
      },
      kind,
      payload,
    },
  });
  const receipt = (unknown) => ({
    operationId: "fixture-owner",
    sessionId: source.sessionId,
    sessionEpoch: source.sessionEpoch,
    outcome: unknown ? "unknown" : "partial",
    bytesBase64: unknown ? "BgcICQ==" : "AAECAwQF",
    byteStart: unknown ? "6" : "0",
    byteEnd: unknown ? "10" : "6",
    acceptedRanges: unknown ? [] : [{ start: "0", end: "2" }],
    unknownRanges: unknown
      ? [{ start: "6", end: "10" }]
      : [{ start: "2", end: "4" }],
    peerAcknowledged: false,
    backendError: {
      code: "FIXTURE_UNCERTAIN",
      message: "Fixed unknown evidence",
    },
  });
  const entries = [
    event(1, "lifecycle", { state: "open" }),
    event(2, "rx", { bytesBase64: "AP8NCg==", byteStart: "0", byteEnd: "4" }),
    event(3, "tx_intent", {
      operationId: "fixture-owner",
      bytesBase64: "AAECAwQF",
      byteStart: "0",
      byteEnd: "6",
    }),
    event(4, "tx", receipt(false)),
    event(5, "tx_intent", {
      operationId: "fixture-owner",
      bytesBase64: "BgcICQ==",
      byteStart: "6",
      byteEnd: "10",
    }),
    {
      kind: "tx_settlement",
      value: {
        hostId: source.hostId,
        instanceEpoch: source.instanceEpoch,
        receipt: receipt(true),
      },
    },
    event(6, "rx", {
      bytesBase64: "UkVBRFlcMA==",
      byteStart: "4",
      byteEnd: "11",
    }),
    event(7, "control", { line: "dtr", value: true }),
  ];
  return entries.map((entry, index) => ({
    recordOrdinal: String(index + 1),
    entry,
  }));
}
function expectations(records) {
  const rawPayloads = [],
    finalReceipts = [];
  for (const record of records) {
    const value = record.entry.value;
    const receipt =
      record.entry.kind === "tx_settlement"
        ? value.receipt
        : value.kind === "tx"
          ? value.payload
          : undefined;
    const payload =
      receipt ??
      (["rx", "tx_intent"].includes(value.kind) ? value.payload : undefined);
    if (payload) {
      const bytes = Buffer.from(payload.bytesBase64, "base64");
      rawPayloads.push({
        recordOrdinal: record.recordOrdinal,
        kind:
          record.entry.kind === "tx_settlement" ? "tx_settlement" : value.kind,
        byteStart: payload.byteStart,
        byteEnd: payload.byteEnd,
        bytesHex: bytes.toString("hex"),
        sha256: hash(bytes),
      });
    }
    if (receipt)
      finalReceipts.push({
        recordOrdinal: record.recordOrdinal,
        source: {
          hostId: value.hostId,
          instanceEpoch: value.instanceEpoch,
          sessionId: receipt.sessionId,
          sessionEpoch: receipt.sessionEpoch,
        },
        receipt,
        receiptSha256: hash(canonical(receipt)),
      });
  }
  return {
    fixtureVersion: "1",
    minimumVolumes: 2,
    streams: [{ ...source }],
    records,
    recordJsonSha256: records.map((record) => hash(JSON.stringify(record))),
    rawPayloads,
    finalReceipts,
  };
}
// This encoder exists only in tests, implements the published byte contract,
// and never imports the Rust writer or the reader's parsing/hash helpers.
function saveContainer(directory, records, expected) {
  const capture = join(directory, "capture");
  mkdirSync(capture, { recursive: true });
  const locations = [],
    volumes = [];
  let previous = "0".repeat(64);
  for (
    let start = 0, ordinal = 1;
    start < records.length;
    start += 4, ordinal++
  ) {
    const chunks = [Buffer.from("SWBR01\n")];
    let offset = 7;
    for (const record of records.slice(start, start + 4)) {
      const body = Buffer.from(JSON.stringify(record));
      const length = Buffer.alloc(4);
      length.writeUInt32LE(body.length);
      const encoded = Buffer.concat([
        length,
        body,
        Buffer.from(hash(body), "hex"),
      ]);
      chunks.push(encoded);
      locations.push({
        recordOrdinal: record.recordOrdinal,
        volume: String(ordinal),
        offset: String(offset),
        length: String(encoded.length),
      });
      offset += encoded.length;
    }
    const bytes = Buffer.concat(chunks);
    const digest = hash(bytes);
    writeFileSync(
      join(capture, `volume-${String(ordinal).padStart(6, "0")}.swbr`),
      bytes,
    );
    volumes.push({
      ordinal: String(ordinal),
      recordStart: String(start + 1),
      recordEnd: String(Math.min(start + 4, records.length) + 1),
      length: String(bytes.length),
      digest,
      previousDigest: previous,
    });
    previous = digest;
  }
  const count = String(records.length);
  writeFileSync(
    join(capture, "manifest.json"),
    JSON.stringify({
      formatVersion: "0.1",
      captureId: "fixture-capture",
      mode: "raw",
      streams: [{ ...source }],
      volumes,
      state: "complete",
      watermarks: {
        written: count,
        flushed: count,
        synced: count,
        verified: count,
      },
      sourceContinuous: true,
      recoveredFrom: null,
      verifiedPrefix: "0",
    }),
  );
  writeFileSync(
    join(capture, "index.json"),
    JSON.stringify({ formatVersion: "0.1", records: locations }),
  );
  writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
}
function fixture(change = (records) => records) {
  const directory = mkdtempSync(join(tmpdir(), "swb-independent-capture-"));
  const records = inputs();
  const expected = expectations(structuredClone(records));
  saveContainer(directory, change(records), expected);
  return directory;
}
function sourceHashes(directory) {
  const capture = join(directory, "capture");
  return Object.fromEntries(
    readdirSync(capture)
      .sort()
      .map((name) => [name, hash(readFileSync(join(capture, name)))]),
  );
}
test("independent reader compares all eight records, six raw payloads and both final receipt blocks", () => {
  const directory = fixture();
  const before = sourceHashes(directory);
  const result = readFixtureContainer(directory);
  assert.equal(result.recordCount, 8);
  assert.equal(result.rawPayloads.length, 6);
  assert.equal(result.finalReceipts.length, 2);
  assert.deepEqual(
    result.finalReceipts.map((item) => item.receipt.outcome),
    ["partial", "unknown"],
  );
  assert.equal(
    result.finalReceipts[0].source.instanceEpoch,
    "9007199254740993",
  );
  assert.deepEqual(result.rawPayloads[0].bytesHex, "00ff0d0a");
  assert.deepEqual(sourceHashes(directory), before);
});
test("rejects a changed payload even after all record and volume hashes are rebuilt", () => {
  const directory = fixture((records) => {
    records[1].entry.value.payload.bytesBase64 = "AQIDBA==";
    return records;
  });
  const before = sourceHashes(directory);
  assert.throws(
    () => readFixtureContainer(directory),
    /expected|oracle|record/i,
  );
  assert.deepEqual(sourceHashes(directory), before);
});
test("rejects silently omitted record despite consistent reindexing and rebuilt hashes", () => {
  const directory = fixture((records) =>
    records
      .filter((_record, index) => index !== 7)
      .map((record, index) => ({
        ...record,
        recordOrdinal: String(index + 1),
      })),
  );
  assert.throws(
    () => readFixtureContainer(directory),
    /count|expected|oracle/i,
  );
});
test("rejects a final Unknown receipt changed to Accepted with valid structural hashes", () => {
  const directory = fixture((records) => {
    const receipt = records[5].entry.value.receipt;
    receipt.outcome = "accepted";
    receipt.acceptedRanges = receipt.unknownRanges;
    receipt.unknownRanges = [];
    return records;
  });
  assert.throws(
    () => readFixtureContainer(directory),
    /expected|oracle|receipt|record/i,
  );
});
test("rejects replacing the second owner block with a duplicate first-block receipt", () => {
  const directory = fixture((records) => {
    records[5].entry.value.receipt = structuredClone(
      records[3].entry.value.payload,
    );
    return records;
  });
  assert.throws(
    () => readFixtureContainer(directory),
    /expected|oracle|receipt|record|duplicate/i,
  );
});
test("rejects truncated final digest and preserves the damaged source", () => {
  const directory = fixture();
  const path = join(directory, "capture", "volume-000002.swbr");
  const bytes = readFileSync(path);
  writeFileSync(path, bytes.subarray(0, bytes.length - 1));
  const before = sourceHashes(directory);
  assert.throws(
    () => readFixtureContainer(directory),
    /truncat|length|digest/i,
  );
  assert.deepEqual(sourceHashes(directory), before);
});
test("rejects index offsets which disagree with a full sequential volume scan", () => {
  const directory = fixture();
  const path = join(directory, "capture", "index.json");
  const index = JSON.parse(readFileSync(path, "utf8"));
  index.records[1].offset = "9007199254740993";
  writeFileSync(path, JSON.stringify(index));
  assert.throws(() => readFixtureContainer(directory), /index|offset/i);
});
test("rejects broken previous-volume chain", () => {
  const directory = fixture();
  const path = join(directory, "capture", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.volumes[1].previousDigest = "0".repeat(64);
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(
    () => readFixtureContainer(directory),
    /chain|previous|digest/i,
  );
});
test("rejects an over-one-MiB record length before reading a huge allocation", () => {
  const directory = fixture();
  const path = join(directory, "capture", "volume-000001.swbr");
  const bytes = readFileSync(path);
  bytes.writeUInt32LE(1024 * 1024 + 1, 7);
  writeFileSync(path, bytes);
  assert.throws(() => readFixtureContainer(directory), /limit|MiB|length/i);
});
test("unknown container format is rejected read-only", () => {
  const directory = fixture();
  const path = join(directory, "capture", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.formatVersion = "9.0";
  writeFileSync(path, JSON.stringify(manifest));
  const before = sourceHashes(directory);
  assert.throws(() => readFixtureContainer(directory), /format|future/i);
  assert.deepEqual(sourceHashes(directory), before);
});
