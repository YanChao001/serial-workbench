// Test-only fixed-fixture acceptance reader. Deliberately independent of Rust
// capture parsers, application SDKs, Host IPC, and production package wiring.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const MAGIC = new Map([
  ["0.1", Buffer.from("SWBR01\n")],
  ["0.2", Buffer.from("SWBR02\n")],
  ["0.3", Buffer.from("SWBR03\n")],
  ["0.4", Buffer.from("SWBR04\n")],
]);
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
function closedObject(value, required, optional, label) {
  requireThat(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    `Unexpected ${label} fields`,
  );
}
function directionalByteRange(range) {
  closedObject(range, ["direction", "start", "end"], [], "redacted byte range");
  requireThat(
    ["rx", "tx"].includes(range.direction) &&
      u64(range.end, "redacted byte end") >
        u64(range.start, "redacted byte start"),
    "Invalid redacted byte range",
  );
}

function readVolumeIndex(capture, manifest) {
  const records = [];
  const names = [];
  const magic = Buffer.from("SWBI01\n");
  for (const volume of manifest.volumes) {
    const ordinal = u64(volume.ordinal, "index volume ordinal");
    const start = u64(volume.recordStart, "index record start");
    const end = u64(volume.recordEnd, "index record end");
    requireThat(
      start <= end && end <= 1_100_001n,
      "Invalid volume index range",
    );
    const name = `index-${ordinal.toString().padStart(6, "0")}.swbi`;
    names.push(name);
    const bytes = regular(join(capture, name));
    requireThat(
      bytes.subarray(0, magic.length).equals(magic) &&
        BigInt(bytes.length - magic.length) === (end - start) * 12n,
      "Invalid volume index header or size",
    );
    let position = magic.length;
    for (let recordOrdinal = start; recordOrdinal < end; recordOrdinal++) {
      records.push({
        recordOrdinal: recordOrdinal.toString(),
        volume: ordinal.toString(),
        offset: bytes.readBigUInt64LE(position).toString(),
        length: bytes.readUInt32LE(position + 8).toString(),
      });
      position += 12;
    }
  }
  return { formatVersion: manifest.formatVersion, records, names };
}

function redactedFacts(recordOrdinal, value) {
  closedObject(
    value,
    [
      "hostId",
      "instanceEpoch",
      "sessionId",
      "sessionEpoch",
      "eventStart",
      "eventEnd",
      "timestamp",
      "result",
    ],
    ["byteRange"],
    "redacted record",
  );
  const start = u64(value.eventStart, "redacted eventStart");
  requireThat(
    start > 0n && u64(value.eventEnd, "redacted eventEnd") > start,
    "Invalid redacted event range",
  );
  requireThat(
    typeof value.timestamp === "string" &&
      Number.isFinite(Date.parse(value.timestamp)),
    "Invalid redacted timestamp",
  );
  const range = value.byteRange;
  if (Object.hasOwn(value, "byteRange")) directionalByteRange(range);
  const result = value.result;
  if (result?.kind === "text") {
    closedObject(
      result,
      ["kind", "text", "replacements"],
      [],
      "redacted text result",
    );
    requireThat(
      range &&
        typeof result.text === "string" &&
        Buffer.byteLength(result.text) <= 32768 &&
        !/\p{Cc}/u.test(result.text.replaceAll("\t", "")) &&
        u64(result.replacements, "redacted replacements") <= 1024n,
      "Invalid redacted text result",
    );
    return {
      recordOrdinal,
      kind: "text",
      textSha256: hash(result.text),
      replacements: result.replacements,
    };
  }
  closedObject(result, ["kind", "reason"], [], "redacted omission");
  requireThat(
    result.kind === "omitted" &&
      ["boundary", "invalid_text", "line_too_long", "incomplete"].includes(
        result.reason,
      ),
    "Invalid redacted omission",
  );
  return { recordOrdinal, kind: "omitted", reason: result.reason };
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

function checkRedactionResume(manifest, bounds) {
  if (!Object.hasOwn(manifest, "redactionResume")) return;
  const positions = manifest.redactionResume;
  requireThat(
    manifest.mode === "redacted" &&
      Array.isArray(positions) &&
      positions.length === manifest.streams.length,
    "Invalid redacted resume source count",
  );
  for (const [index, position] of positions.entries()) {
    closedObject(
      position,
      ["eventPosition"],
      ["rx", "tx"],
      "redacted resume position",
    );
    const known = bounds.get(sourceKey(manifest.streams[index]));
    requireThat(
      u64(position.eventPosition, "redacted resume eventPosition") >=
        (known?.position ?? 0n),
      "Redacted resume cursor precedes a verified record",
    );
    for (const direction of ["rx", "tx"]) {
      if (!Object.hasOwn(position, direction)) continue;
      const line = position[direction];
      closedObject(
        line,
        ["byteEnd", "configurationRevision"],
        [],
        "redacted resume line end",
      );
      u64(line.configurationRevision, "redacted resume configurationRevision");
      requireThat(
        u64(line.byteEnd, "redacted resume byteEnd") === known?.[direction],
        "Redacted resume line end differs from the last transformed line",
      );
    }
  }
}

export function readFixtureContainer(fixtureDirectory) {
  const capture = join(fixtureDirectory, "capture");
  const expected = json(
    regular(join(fixtureDirectory, "expected.json")),
    "pre-write expected oracle",
  );
  const liveRedacted = expected.fixtureVersion === "virtual-echo-redacted-1";
  requireThat(
    Array.isArray(expected.records) &&
      expected.records.length > 0 &&
      (expected.fixtureVersion === "1" ||
        (liveRedacted &&
          expected.mode === "redacted" &&
          Array.isArray(expected.rules) &&
          expected.rules.length > 0)),
    "Missing fixed input expected oracle",
  );
  const manifest = json(regular(join(capture, "manifest.json")), "manifest");
  const magic = MAGIC.get(manifest.formatVersion);
  requireThat(magic, "Future/unsupported capture format");
  const redacted = manifest.formatVersion === "0.3";
  const indexed = manifest.formatVersion === "0.4";
  const timed = manifest.formatVersion !== "0.1";
  const index = indexed
    ? readVolumeIndex(capture, manifest)
    : json(regular(join(capture, "index.json")), "index");
  requireThat(
    magic && index.formatVersion === manifest.formatVersion,
    "Future/unsupported capture format",
  );
  requireThat(
    manifest.mode === (redacted ? "redacted" : "raw") &&
      manifest.mode === (expected.mode ?? "raw") &&
      manifest.state === "complete",
    "Expected a complete fixed fixture of the stated mode",
  );
  const expectedPolicy = liveRedacted
    ? hash(
        JSON.stringify([
          "utf8-lines-1",
          expected.rules.map(({ pattern, replacement }) => ({
            pattern,
            replacement,
          })),
        ]),
      )
    : expected.redactionDigest;
  requireThat(
    redacted
      ? typeof manifest.redactionDigest === "string" &&
          /^[0-9a-f]{64}$/.test(manifest.redactionDigest) &&
          manifest.redactionDigest === expectedPolicy
      : !Object.hasOwn(manifest, "redactionDigest"),
    "Redaction policy digest differs from the fixture mode or input oracle",
  );
  requireThat(
    Array.isArray(manifest.volumes) &&
      manifest.volumes.length >= expected.minimumVolumes,
    "Expected rotated fixture volumes",
  );
  requireThat(Array.isArray(index.records), "Missing index records");
  requireThat(
    liveRedacted
      ? isDeepStrictEqual(
          manifest.streams.map(sourceKey),
          expected.streams.map(sourceKey),
        )
      : isDeepStrictEqual(manifest.streams, expected.streams),
    "Manifest sources differ from expected input oracle",
  );
  const sources = new Set(manifest.streams.map(sourceKey));
  const records = [],
    locations = [],
    recordJsonSha256 = [],
    volumes = [];
  let previous = "0".repeat(64);
  const recordedMonoNs = [];
  let lastRecorded;
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
      bytes.length >= magic.length &&
        bytes.subarray(0, magic.length).equals(magic),
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
      const bodyStart = offset + 4 + (timed ? 8 : 0);
      const bodyEnd = bodyStart + length;
      const end = bodyEnd + 32;
      requireThat(
        end <= bytes.length,
        `Truncated record digest/body in ${name}`,
      );
      const body = bytes.subarray(bodyStart, bodyEnd);
      requireThat(
        bytes.subarray(bodyEnd, end).toString("hex") ===
          hash(bytes.subarray(offset + 4, bodyEnd)),
        `Record digest mismatch at ordinal ${records.length + 1}`,
      );
      const record = json(body, `record ${records.length + 1}`);
      if (timed) {
        const elapsed = bytes.readBigUInt64LE(offset + 4);
        requireThat(
          lastRecorded === undefined ? elapsed === 0n : elapsed >= lastRecorded,
          "Recorder timeline is not nondecreasing from zero",
        );
        lastRecorded = elapsed;
        recordedMonoNs.push(String(elapsed));
      }
      requireThat(
        u64(record.recordOrdinal, "record ordinal") ===
          BigInt(records.length + 1),
        "Record ordinal is not a continuous prefix",
      );
      records.push(record);
      recordJsonSha256.push(hash(body));
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
  const files = readdirSync(capture).sort();
  const actualNames = files.filter((name) =>
    /^volume-[0-9]+\.swbr$/.test(name),
  );
  requireThat(
    isDeepStrictEqual(actualNames, [...names].sort()),
    "Unexpected or missing unindexed volume file",
  );
  if (redacted || indexed)
    requireThat(
      isDeepStrictEqual(
        files,
        [
          "manifest.json",
          ...(indexed ? index.names : ["index.json"]),
          ...names,
        ].sort(),
      ),
      redacted
        ? "Unexpected file in a redacted capture"
        : "Unexpected file in an indexed capture",
    );
  requireThat(
    isDeepStrictEqual(index.records, locations),
    "Index offset/length/record locations differ from complete volume scan",
  );
  requireThat(
    records.length === expected.records.length,
    "Record count differs from expected input oracle (silent omission or duplication)",
  );
  if (!liveRedacted) {
    requireThat(
      isDeepStrictEqual(records, expected.records),
      "Complete record contents differ from expected pre-write input oracle",
    );
    requireThat(
      isDeepStrictEqual(recordJsonSha256, expected.recordJsonSha256),
      "Raw record JSON hashes differ from expected input oracle",
    );
    if (timed)
      requireThat(
        isDeepStrictEqual(recordedMonoNs, expected.recordedMonoNs),
        "Recorder timeline differs from expected input oracle",
      );
  }
  for (const name of ["written", "flushed", "synced", "verified"])
    requireThat(
      u64(manifest.watermarks[name], `watermark ${name}`) ===
        BigInt(records.length),
      "Complete fixture watermark count mismatch",
    );
  const rawPayloads = [],
    finalReceipts = [],
    redactedRecords = [],
    pending = new Set(),
    settled = new Set(),
    sequences = new Map();
  const redactionBounds = new Map();
  let continuous = true;
  for (const record of records) {
    const entry = record.entry;
    if (redacted) {
      closedObject(record, ["recordOrdinal", "entry"], [], "record frame");
      closedObject(entry, ["kind", "value"], [], "record entry");
    }
    requireThat(
      (redacted
        ? ["redacted", "reader_gap"]
        : ["event", "tx_settlement", "reader_gap"]
      ).includes(entry.kind),
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
    if (redacted && entry.kind === "redacted") {
      const facts = redactedFacts(record.recordOrdinal, value);
      redactedRecords.push(facts);
      const key = sourceKey(source);
      const known = redactionBounds.get(key) ?? { position: 0n };
      const end = u64(value.eventEnd, "redacted eventEnd") - 1n;
      if (end > known.position) known.position = end;
      if (value.byteRange) {
        known[value.byteRange.direction] =
          facts.kind === "text"
            ? u64(value.byteRange.end, "redacted line end")
            : undefined;
      }
      redactionBounds.set(key, known);
      if (facts.kind === "omitted") continuous = false;
      continue;
    }
    if (entry.kind === "reader_gap") {
      continuous = false;
      if (redacted) {
        closedObject(
          value,
          [
            "hostId",
            "instanceEpoch",
            "sessionId",
            "sessionEpoch",
            "reason",
            "missingEventRange",
          ],
          ["missingByteRanges"],
          "redacted gap",
        );
        closedObject(
          value.missingEventRange,
          ["start", "end"],
          [],
          "redacted gap range",
        );
        requireThat(
          u64(value.missingEventRange.end, "redacted gap end") >
            u64(value.missingEventRange.start, "redacted gap start"),
          "Invalid redacted gap range",
        );
        requireThat(
          [
            "reader_overflow",
            "capture_overflow",
            "capture_paused",
            "network_loss",
          ].includes(value.reason),
          "Invalid redacted gap reason",
        );
        if (Object.hasOwn(value, "missingByteRanges")) {
          requireThat(
            Array.isArray(value.missingByteRanges),
            "Invalid redacted gap byte ranges",
          );
          value.missingByteRanges.forEach(directionalByteRange);
        }
        const key = sourceKey(source);
        const end = u64(value.missingEventRange.end, "redacted gap end") - 1n;
        const previous = redactionBounds.get(key)?.position ?? 0n;
        redactionBounds.set(key, { position: previous > end ? previous : end });
        continue;
      }
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
  checkRedactionResume(manifest, redactionBounds);
  requireThat(
    manifest.sourceContinuous === continuous,
    "Source continuity flag mismatch",
  );
  if (liveRedacted) {
    const lines = records.map(({ entry }) => {
      requireThat(
        entry.kind === "redacted" && entry.value.result.kind === "text",
        "Virtual Echo generated an unexpected gap or omission",
      );
      return {
        ...entry.value.byteRange,
        text: entry.value.result.text,
        replacements: entry.value.result.replacements,
      };
    });
    const byDirection = (a, b) => a.direction.localeCompare(b.direction, "en");
    requireThat(
      isDeepStrictEqual(
        lines.sort(byDirection),
        [...expected.records].sort(byDirection),
      ),
      "Transformed lines differ from the Virtual Echo input oracle",
    );
  }
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
    ...(timed ? { recordedMonoNs } : {}),
    ...(redacted
      ? {
          mode: manifest.mode,
          redactionDigest: manifest.redactionDigest,
          redactedRecords,
        }
      : {}),
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
