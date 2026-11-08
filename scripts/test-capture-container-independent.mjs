// Test-only fixed-fixture acceptance reader. Deliberately independent of Rust
// capture parsers, application SDKs, Host IPC, and production package wiring.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const MAGIC = Buffer.from("SWBR01\n");
const MAX_RECORD = 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function u64(value, label) {
  requireThat(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    `${label} must be a U64 decimal string`,
  );
  const integer = BigInt(value);
  requireThat(integer <= 18446744073709551615n, `${label} exceeds U64`);
  return integer;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function regular(path) {
  const stat = lstatSync(path);
  requireThat(
    stat.isFile() && !stat.isSymbolicLink(),
    `Fixture input is not a regular file: ${path}`,
  );
  return readFileSync(path);
}
function json(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`Invalid UTF-8/JSON in ${label}: ${error.message}`, {
      cause: error,
    });
  }
}
const sourceOf = (entry) =>
  entry.kind === "tx_settlement"
    ? {
        hostId: entry.value.hostId,
        instanceEpoch: entry.value.instanceEpoch,
        sessionId: entry.value.receipt.sessionId,
        sessionEpoch: entry.value.receipt.sessionEpoch,
      }
    : {
        hostId: entry.value.hostId,
        instanceEpoch: entry.value.instanceEpoch,
        sessionId: entry.value.sessionId,
        sessionEpoch: entry.value.sessionEpoch,
      };
const sourceKey = (source) =>
  JSON.stringify([
    source.hostId,
    source.instanceEpoch,
    source.sessionId,
    source.sessionEpoch,
  ]);
const blockKey = (source, payload) =>
  JSON.stringify([
    sourceKey(source),
    payload.operationId,
    payload.byteStart,
    payload.byteEnd,
  ]);

export function readFixtureContainer(fixtureDirectory) {
  const capture = join(fixtureDirectory, "capture");
  const expected = json(
    regular(join(fixtureDirectory, "expected.json")),
    "pre-write expected oracle",
  );
  requireThat(
    expected.fixtureVersion === "1" &&
      Array.isArray(expected.records) &&
      expected.records.length > 0,
    "Missing fixed input expected oracle",
  );
  const manifest = json(regular(join(capture, "manifest.json")), "manifest");
  const index = json(regular(join(capture, "index.json")), "index");
  requireThat(
    manifest.formatVersion === "0.1" && index.formatVersion === "0.1",
    "Future/unsupported capture format",
  );
  requireThat(
    manifest.mode === "raw" && manifest.state === "complete",
    "Expected a complete raw fixed fixture",
  );
  requireThat(
    Array.isArray(manifest.volumes) &&
      manifest.volumes.length >= expected.minimumVolumes,
    "Expected rotated fixture volumes",
  );
  requireThat(Array.isArray(index.records), "Missing index records");
  requireThat(
    isDeepStrictEqual(manifest.streams, expected.streams),
    "Manifest sources differ from expected input oracle",
  );
  const sources = new Set(manifest.streams.map(sourceKey));
  const records = [],
    locations = [],
    recordJsonSha256 = [],
    volumes = [];
  let previous = "0".repeat(64);
  const names = [];
  for (let position = 0; position < manifest.volumes.length; position++) {
    const meta = manifest.volumes[position];
    const ordinal = BigInt(position + 1);
    requireThat(
      u64(meta.ordinal, "volume ordinal") === ordinal,
      "Non-contiguous volume ordinal",
    );
    requireThat(
      meta.previousDigest === previous,
      "Broken previous-volume digest chain",
    );
    requireThat(
      u64(meta.recordStart, "volume recordStart") ===
        BigInt(records.length + 1),
      "Volume record start differs from sequential records",
    );
    const name = `volume-${String(ordinal).padStart(6, "0")}.swbr`;
    names.push(name);
    const bytes = regular(join(capture, name));
    requireThat(
      bytes.length >= 7 && bytes.subarray(0, 7).equals(MAGIC),
      `Invalid volume magic: ${name}`,
    );
    let offset = 7;
    while (offset < bytes.length) {
      requireThat(
        offset + 4 <= bytes.length,
        `Truncated record length in ${name}`,
      );
      const length = bytes.readUInt32LE(offset);
      requireThat(
        length > 0 && length <= MAX_RECORD,
        `Record JSON length exceeds 1 MiB limit in ${name}`,
      );
      const end = offset + 4 + length + 32;
      requireThat(
        end <= bytes.length,
        `Truncated record digest/body in ${name}`,
      );
      const body = bytes.subarray(offset + 4, offset + 4 + length);
      const digest = hash(body);
      requireThat(
        bytes.subarray(offset + 4 + length, end).toString("hex") === digest,
        `Record JSON digest mismatch at ordinal ${records.length + 1}`,
      );
      const record = json(body, `record ${records.length + 1}`);
      requireThat(
        u64(record.recordOrdinal, "record ordinal") ===
          BigInt(records.length + 1),
        "Record ordinal is not a continuous prefix",
      );
      records.push(record);
      recordJsonSha256.push(digest);
      locations.push({
        recordOrdinal: record.recordOrdinal,
        volume: meta.ordinal,
        offset: String(offset),
        length: String(end - offset),
      });
      offset = end;
    }
    requireThat(
      u64(meta.recordEnd, "volume recordEnd") === BigInt(records.length + 1),
      "Volume record end differs from its exclusive record prefix",
    );
    requireThat(
      u64(meta.length, "volume length") === BigInt(bytes.length),
      "Volume length mismatch",
    );
    const digest = hash(bytes);
    requireThat(meta.digest === digest, "Volume digest mismatch");
    previous = digest;
    volumes.push({
      ordinal: meta.ordinal,
      bytes: bytes.length,
      sha256: digest,
    });
  }
  const actualNames = readdirSync(capture)
    .filter((name) => /^volume-[0-9]+\.swbr$/.test(name))
    .sort();
  requireThat(
    isDeepStrictEqual(actualNames, [...names].sort()),
    "Unexpected or missing unindexed volume file",
  );
  requireThat(
    isDeepStrictEqual(index.records, locations),
    "Index offset/length/record locations differ from complete volume scan",
  );
  requireThat(
    records.length === expected.records.length,
    "Record count differs from expected input oracle (silent omission or duplication)",
  );
  requireThat(
    isDeepStrictEqual(records, expected.records),
    "Complete record contents differ from expected pre-write input oracle",
  );
  requireThat(
    isDeepStrictEqual(recordJsonSha256, expected.recordJsonSha256),
    "Raw record JSON hashes differ from expected input oracle",
  );
  for (const name of ["written", "flushed", "synced", "verified"])
    requireThat(
      u64(manifest.watermarks[name], `watermark ${name}`) ===
        BigInt(records.length),
      "Complete fixture watermark count mismatch",
    );
  const rawPayloads = [],
    finalReceipts = [],
    pending = new Set(),
    settled = new Set(),
    sequences = new Map();
  let continuous = true;
  for (const record of records) {
    const entry = record.entry;
    requireThat(
      ["event", "tx_settlement", "reader_gap"].includes(entry.kind),
      "Unexpected capture entry kind",
    );
    const value = entry.value;
    const source = sourceOf(entry);
    u64(source.instanceEpoch, "source instanceEpoch");
    u64(source.sessionEpoch, "source sessionEpoch");
    requireThat(
      sources.has(sourceKey(source)),
      "Record source is not declared in manifest",
    );
    if (entry.kind === "reader_gap") {
      continuous = false;
      sequences.set(
        sourceKey(source),
        u64(value.missingEventRange.end, "reader gap end") - 1n,
      );
    }
    if (entry.kind === "event") {
      const sequence = u64(value.eventSeq, "source eventSeq");
      const last = sequences.get(sourceKey(source));
      requireThat(
        last === undefined || sequence === last + 1n,
        "Source event sequence is not continuous",
      );
      sequences.set(sourceKey(source), sequence);
      u64(value.configurationRevision, "configurationRevision");
      u64(value.time.sourceMonoNs, "sourceMonoNs");
      u64(value.time.precision.resolutionNs, "time resolutionNs");
      if (value.kind === "gap") continuous = false;
      if (value.kind === "tx_intent")
        pending.add(blockKey(source, value.payload));
    }
    const receipt =
      entry.kind === "tx_settlement"
        ? value.receipt
        : value.kind === "tx"
          ? value.payload
          : undefined;
    const payload =
      receipt ??
      (["rx", "tx_intent"].includes(value.kind) ? value.payload : undefined);
    if (payload) {
      const start = u64(payload.byteStart, "raw byteStart"),
        end = u64(payload.byteEnd, "raw byteEnd");
      requireThat(
        typeof payload.bytesBase64 === "string",
        "Missing raw bytesBase64",
      );
      const bytes = Buffer.from(payload.bytesBase64, "base64");
      requireThat(
        bytes.toString("base64") === payload.bytesBase64 &&
          end - start === BigInt(bytes.length),
        "Raw payload byte range/base64 length mismatch",
      );
      rawPayloads.push({
        recordOrdinal: record.recordOrdinal,
        kind: entry.kind === "tx_settlement" ? "tx_settlement" : value.kind,
        byteStart: payload.byteStart,
        byteEnd: payload.byteEnd,
        bytesHex: bytes.toString("hex"),
        sha256: hash(bytes),
      });
    }
    if (receipt) {
      requireThat(
        receipt.sessionId === source.sessionId &&
          receipt.sessionEpoch === source.sessionEpoch,
        "Final receipt source identity mismatch",
      );
      const key = blockKey(source, receipt);
      requireThat(
        !settled.has(key),
        "Duplicate final receipt for one source/owner/block",
      );
      settled.add(key);
      pending.delete(key);
      finalReceipts.push({
        recordOrdinal: record.recordOrdinal,
        source,
        receipt,
        receiptSha256: hash(canonical(receipt)),
      });
    }
  }
  requireThat(pending.size === 0, "Fixed input TX intents lack final receipts");
  requireThat(
    manifest.sourceContinuous === continuous,
    "Source continuity flag mismatch",
  );
  requireThat(
    isDeepStrictEqual(rawPayloads, expected.rawPayloads),
    "Raw payload bytes/hashes differ from expected oracle",
  );
  requireThat(
    isDeepStrictEqual(finalReceipts, expected.finalReceipts),
    "Final Partial/Unknown receipt contents/hashes differ from expected oracle",
  );
  return {
    status: "passed",
    source:
      "independent Node fs/crypto full-volume scan + pre-write input oracle",
    recordCount: records.length,
    volumes,
    recordJsonSha256,
    rawPayloads,
    finalReceipts,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2),
      options = new Map();
    requireThat(
      args.length === 4,
      "Usage: node test-capture-container-independent.mjs --fixture <absolute-directory> --result <new-absolute-file>",
    );
    for (let i = 0; i < args.length; i += 2) {
      requireThat(
        ["--fixture", "--result"].includes(args[i]) && !options.has(args[i]),
        "Unknown/repeated reader option",
      );
      options.set(args[i], args[i + 1]);
    }
    const fixture = options.get("--fixture"),
      result = options.get("--result");
    requireThat(
      fixture && result && isAbsolute(fixture) && isAbsolute(result),
      "Reader requires absolute fixture/result paths",
    );
    requireThat(
      resolve(result) !== resolve(fixture) &&
        !resolve(result).startsWith(`${resolve(fixture)}${sep}`),
      "Result must be outside the read-only fixture source",
    );
    const report = readFixtureContainer(fixture);
    writeFileSync(result, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
    process.stdout.write(
      `Verified ${report.recordCount} records and ${report.finalReceipts.length} final receipts\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Independent capture validation failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
