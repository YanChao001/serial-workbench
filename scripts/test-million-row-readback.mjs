import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readCaptureFrame } from "./test-capture-container-independent.mjs";

const [capture, firstArg, lastArg, output] = process.argv.slice(2);
assert.ok(isAbsolute(capture) && isAbsolute(output));
const first = Number(firstArg);
const last = Number(lastArg);
assert.ok(Number.isSafeInteger(first) && Number.isSafeInteger(last));
assert.ok(1 <= first && first <= last && last <= 1_300_000);

function read(name) {
  const path = join(capture, name);
  assert.ok(lstatSync(path).isFile(), `Expected regular file ${name}`);
  return readFileSync(path);
}

const manifest = JSON.parse(read("manifest.json"));
assert.equal(manifest.formatVersion, "0.4");
assert.equal(manifest.mode, "raw");
assert.equal(manifest.state, "complete");
assert.equal(manifest.streams.length, 1);
assert.equal(manifest.sourceContinuous, true);
assert.equal(manifest.watermarks.verified, String(last - first + 1));
const [source] = manifest.streams;
const payload = createHash("sha256");
const expected = createHash("sha256");
const names = ["manifest.json"];
const volumes = [];
let ordinal = 1;
let previous = "0".repeat(64);
let firstEvent;
let recorded;
for (const [i, meta] of manifest.volumes.entries()) {
  assert.equal(meta.ordinal, String(i + 1));
  assert.equal(meta.previousDigest, previous);
  assert.equal(meta.recordStart, String(ordinal));
  const suffix = String(i + 1).padStart(6, "0");
  const name = `volume-${suffix}.swbr`;
  const indexName = `index-${suffix}.swbi`;
  names.push(name, indexName);
  const bytes = read(name);
  const index = read(indexName);
  assert.equal(bytes.subarray(0, 7).toString(), "SWBR04\n");
  assert.equal(index.subarray(0, 7).toString(), "SWBI01\n");
  assert.equal(meta.length, String(bytes.length));
  const count = Number(meta.recordEnd) - ordinal;
  assert.ok(Number.isSafeInteger(count) && count >= 0);
  assert.equal(index.length, 7 + count * 12);
  let indexOffset = 7;
  let offset = 7;
  while (offset < bytes.length) {
    const { body, end } = readCaptureFrame(bytes, offset, true, name, ordinal);
    assert.equal(index.readBigUInt64LE(indexOffset), BigInt(offset));
    assert.equal(index.readUInt32LE(indexOffset + 8), end - offset);
    indexOffset += 12;
    const ns = bytes.readBigUInt64LE(offset + 4);
    assert.ok(recorded === undefined ? ns === 0n : ns >= recorded);
    recorded = ns;
    const record = JSON.parse(body);
    assert.equal(record.recordOrdinal, String(ordinal));
    assert.equal(record.entry.kind, "event");
    const event = record.entry.value;
    for (const key of [
      "hostId",
      "instanceEpoch",
      "sessionId",
      "sessionEpoch",
    ]) {
      assert.equal(event[key], source[key]);
    }
    firstEvent ??= BigInt(event.eventSeq);
    assert.equal(BigInt(event.eventSeq), firstEvent + BigInt(ordinal - 1));
    assert.equal(event.kind, "rx");
    const line = first + ordinal - 1;
    const data = Buffer.from(`SWB${String(line).padStart(7, "0")}\n`);
    const raw = Buffer.from(event.payload.bytesBase64, "base64");
    assert.ok(raw.equals(data), `Original byte mismatch at line ${line}`);
    assert.equal(event.payload.byteStart, String((line - 1) * data.length));
    assert.equal(event.payload.byteEnd, String(line * data.length));
    payload.update(raw);
    expected.update(data);
    ordinal++;
    offset = end;
  }
  assert.equal(indexOffset, index.length);
  assert.equal(meta.recordEnd, String(ordinal));
  previous = createHash("sha256").update(bytes).digest("hex");
  assert.equal(meta.digest, previous);
  volumes.push({
    name,
    bytes: bytes.length,
    firstRecord: meta.recordStart,
    nextRecord: meta.recordEnd,
    sha256: previous,
  });
}
assert.deepEqual(readdirSync(capture).sort(), names.sort());
assert.equal(ordinal - 1, last - first + 1);
const sha256 = payload.digest("hex");
assert.equal(sha256, expected.digest("hex"));
writeFileSync(
  output,
  JSON.stringify(
    {
      firstLine: first,
      lastLine: last,
      records: ordinal - 1,
      byteStart: (first - 1) * 11,
      byteEnd: last * 11,
      rxSha256: sha256,
      volumes,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
console.log(
  `Independently verified ${ordinal - 1} RX records from lines ${first}–${last}`,
);
