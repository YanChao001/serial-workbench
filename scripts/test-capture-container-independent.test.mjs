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
function saveContainer(directory, records, expected, times, indexed = false) {
  const capture = join(directory, "capture");
  const redacted = expected.mode === "redacted";
  const version = redacted ? "0.3" : indexed ? "0.4" : times ? "0.2" : "0.1";
  mkdirSync(capture, { recursive: true });
  const locations = [],
    volumes = [];
  let previous = "0".repeat(64);
  for (
    let start = 0, ordinal = 1;
    start < records.length;
    start += 4, ordinal++
  ) {
    const chunks = [Buffer.from(`SWBR0${version.at(-1)}\n`)];
    let offset = 7;
    for (const record of records.slice(start, start + 4)) {
      const body = Buffer.from(JSON.stringify(record));
      const time = Buffer.alloc(times ? 8 : 0);
      if (times)
        time.writeBigUInt64LE(BigInt(times[Number(record.recordOrdinal) - 1]));
      const length = Buffer.alloc(4);
      length.writeUInt32LE(body.length);
      const encoded = Buffer.concat([
        length,
        time,
        body,
        Buffer.from(hash(Buffer.concat([time, body])), "hex"),
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
    if (indexed) {
      const entries = locations.slice(start).map(({ offset, length }) => {
        const entry = Buffer.alloc(12);
        entry.writeBigUInt64LE(BigInt(offset));
        entry.writeUInt32LE(Number(length), 8);
        return entry;
      });
      writeFileSync(
        join(capture, `index-${String(ordinal).padStart(6, "0")}.swbi`),
        Buffer.concat([Buffer.from("SWBI01\n"), ...entries]),
      );
    }
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
      formatVersion: version,
      captureId: "fixture-capture",
      mode: expected.mode ?? "raw",
      ...(redacted ? { redactionDigest: expected.redactionDigest } : {}),
      streams: [{ ...source }],
      volumes,
      state: "complete",
      watermarks: {
        written: count,
        flushed: count,
        synced: count,
        verified: count,
      },
      sourceContinuous: expected.sourceContinuous ?? !redacted,
      recoveredFrom: null,
      verifiedPrefix: "0",
    }),
  );
  if (!indexed)
    writeFileSync(
      join(capture, "index.json"),
      JSON.stringify({
        formatVersion: version,
        records: locations,
      }),
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
function redactedFixture(change = (records) => records) {
  const fields = { ...source, timestamp: "2026-11-25T03:00:00Z" };
  const textEntry = (ordinal, direction, text) => ({
    recordOrdinal: String(ordinal),
    entry: {
      kind: "redacted",
      value: {
        ...fields,
        eventStart: String(2 * ordinal - 1),
        eventEnd: String(2 * ordinal + 1),
        byteRange: {
          direction,
          start: "9007199254740999",
          end: "9007199254741012",
        },
        result: { kind: "text", text, replacements: "1" },
      },
    },
  });
  const records = change([
    textEntry(1, "rx", "设备 token=[hidden]"),
    textEntry(2, "tx", "token=[hidden]"),
    {
      recordOrdinal: "3",
      entry: {
        kind: "redacted",
        value: {
          ...fields,
          eventStart: "5",
          eventEnd: "7",
          result: { kind: "omitted", reason: "incomplete" },
        },
      },
    },
    {
      recordOrdinal: "4",
      entry: {
        kind: "reader_gap",
        value: {
          ...source,
          reason: "capture_overflow",
          missingEventRange: { start: "7", end: "8" },
        },
      },
    },
    textEntry(5, "rx", "temperature=24 token=[hidden]"),
  ]);
  const directory = mkdtempSync(join(tmpdir(), "swb-independent-redacted-"));
  const recordedMonoNs = ["0", "10", "20", "30", "30"];
  const expected = {
    ...expectations(records),
    mode: "redacted",
    redactionDigest: hash("fixed redaction fixture policy"),
    recordedMonoNs,
  };
  saveContainer(directory, records, expected, recordedMonoNs);
  return directory;
}

test("independently reads two 0.3 volumes and reports transformed record hashes and omissions", () => {
  const directory = redactedFixture();
  const before = sourceHashes(directory);
  const result = readFixtureContainer(directory);
  assert.equal(result.mode, "redacted");
  assert.equal(result.recordCount, 5);
  assert.equal(result.volumes.length, 2);
  assert.deepEqual(result.recordedMonoNs, ["0", "10", "20", "30", "30"]);
  assert.deepEqual(result.rawPayloads, []);
  assert.equal(
    result.redactedRecords[0].textSha256,
    hash("设备 token=[hidden]"),
  );
  assert.deepEqual(result.redactedRecords[2], {
    recordOrdinal: "3",
    kind: "omitted",
    reason: "incomplete",
  });
  assert.deepEqual(sourceHashes(directory), before);
});

test("checks a redacted resume cursor and only accepts line ends after the last gap", () => {
  const directory = redactedFixture();
  const path = join(directory, "capture", "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const lineEnd = { byteEnd: "9007199254741012", configurationRevision: "2" };
  const resume = { eventPosition: "11", rx: lineEnd };
  manifest.redactionResume = [resume];
  writeFileSync(path, JSON.stringify(manifest));
  assert.equal(readFixtureContainer(directory).recordCount, 5);

  manifest.redactionResume = [{ ...resume, tx: lineEnd }];
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(
    () => readFixtureContainer(directory),
    /resume line end differs/,
  );

  manifest.redactionResume = [{ ...resume, eventPosition: "9" }];
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(
    () => readFixtureContainer(directory),
    /resume cursor precedes/,
  );
});

test("rejects raw entries in a redacted container even with rebuilt digests and oracle", () => {
  const directory = redactedFixture((records) => [
    { ...inputs()[1], recordOrdinal: "1" },
    ...records.slice(1),
  ]);
  assert.throws(
    () => readFixtureContainer(directory),
    /Unexpected capture entry kind/,
  );
});

test("rejects raw payload fields nested inside a redacted result", () => {
  const directory = redactedFixture((records) => {
    records[0].entry.value.result.bytesBase64 = "U0VDUkVU";
    return records;
  });
  assert.throws(
    () => readFixtureContainer(directory),
    /Unexpected redacted text result fields/,
  );
});

test("validates the redaction policy against the pre-write oracle", () => {
  const directory = redactedFixture();
  const path = join(directory, "expected.json");
  const expected = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(
    path,
    JSON.stringify({ ...expected, redactionDigest: "0".repeat(64) }),
  );
  assert.throws(
    () => readFixtureContainer(directory),
    /Redaction policy digest/,
  );
});

test("rejects files outside the closed redacted volume layout", () => {
  const directory = redactedFixture();
  writeFileSync(join(directory, "capture", "unexpected.bin"), Buffer.of(0, 1));
  assert.throws(
    () => readFixtureContainer(directory),
    /Unexpected file in a redacted capture/,
  );
});

test("the live redaction oracle rejects wrong text with a self-consistent index and digests", () => {
  const rules = [{ pattern: "token=[^ ]+", replacement: "token=[hidden]" }];
  const expected = {
    fixtureVersion: "virtual-echo-redacted-1",
    mode: "redacted",
    minimumVolumes: 1,
    rules,
    redactionDigest: hash(JSON.stringify(["utf8-lines-1", rules])),
    streams: [source],
    records: ["rx", "tx"].map((direction) => ({
      direction,
      start: "0",
      end: "19",
      text: "token=[hidden]",
      replacements: "1",
    })),
    rawPayloads: [],
    finalReceipts: [],
    sourceContinuous: true,
  };
  const records = expected.records.map(
    ({ direction, start, end, text, replacements }, index) => ({
      recordOrdinal: String(index + 1),
      entry: {
        kind: "redacted",
        value: {
          ...source,
          eventStart: String(index + 1),
          eventEnd: String(index + 2),
          timestamp: "2026-11-25T03:00:00Z",
          byteRange: { direction, start, end },
          result: { kind: "text", text, replacements },
        },
      },
    }),
  );
  const directory = mkdtempSync(join(tmpdir(), "swb-independent-live-oracle-"));
  saveContainer(directory, records, expected, ["0", "17"]);
  assert.equal(readFixtureContainer(directory).recordCount, 2);
  records[0].entry.value.result.text = "token=[wrong]";
  saveContainer(directory, records, expected, ["0", "18"]);
  assert.throws(
    () => readFixtureContainer(directory),
    /Transformed lines differ from the Virtual Echo input oracle/,
  );
});

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

test("checks 0.4 index entries against independently decoded positions", () => {
  const directory = mkdtempSync(join(tmpdir(), "swb-independent-index-"));
  const records = inputs();
  const times = records.map((_, position) => String(position * 25));
  saveContainer(
    directory,
    records,
    {
      ...expectations(records),
      recordedMonoNs: times,
    },
    times,
    true,
  );
  assert.deepEqual(readFixtureContainer(directory).recordedMonoNs, times);
  const path = join(directory, "capture", "index-000002.swbi");
  const bytes = readFileSync(path);
  bytes[7] ^= 1;
  writeFileSync(path, bytes);
  const before = sourceHashes(directory);
  assert.throws(() => readFixtureContainer(directory), /Index offset/);
  assert.deepEqual(sourceHashes(directory), before);
});

test("accepts a cross-volume recorder timeline and rejects reversed time despite valid hashes", () => {
  const directory = mkdtempSync(join(tmpdir(), "swb-independent-timing-"));
  const records = inputs();
  const times = records.map((_, index) => String(index * 25));
  const expected = {
    ...expectations(records),
    recordedMonoNs: times,
  };
  saveContainer(directory, records, expected, times);
  assert.deepEqual(readFixtureContainer(directory).recordedMonoNs, times);
  const reversed = [...times];
  reversed[4] = "1";
  saveContainer(directory, records, expected, reversed);
  assert.throws(
    () => readFixtureContainer(directory),
    /timeline is not nondecreasing/,
  );
});
