import assert from "node:assert/strict";
import test from "node:test";
import { crcValue } from "../packages/plugin-sdk/src/crc.ts";
import { crcModels } from "../packages/plugin-sdk/examples/reference-protocol-fields/crc-catalogue.ts";
import { recognizeCrc } from "../packages/plugin-sdk/examples/reference-protocol-fields/crc-recognition.ts";

const textVector = new TextEncoder().encode("123456789");
const sample = (bytes, checksum) => ({
  bytes: Buffer.from(bytes, "hex"),
  checksum: Buffer.from(checksum, "hex"),
});
const modbus = [
  { bytes: textVector, checksum: Buffer.from("374B", "hex") },
  sample("01030000000A", "C5CD"),
];

test("all 104 published check values exercise direct and reflected widths", () => {
  assert.equal(new Set(crcModels.map(({ name }) => name)).size, 104);
  for (const model of crcModels)
    assert.equal(crcValue(textVector, model), model.check, model.name);
});

test("a single catalogue match and repetitions still require different samples", () => {
  const one = recognizeCrc([modbus[0]], { width: 16 });
  assert.equal(one.status, "more-samples");
  assert.deepEqual(
    one.candidates.map(({ name, order }) => [name, order]),
    [["CRC-16/MODBUS", "little"]],
  );
  const repeated = recognizeCrc([modbus[0], modbus[0]], { width: 16 });
  assert.equal(repeated.distinctSamples, 1);
  assert.equal(repeated.duplicateSamples, 1);
  assert.equal(repeated.status, "more-samples");
  const confirmed = recognizeCrc(modbus, { width: 16 });
  assert.deepEqual(confirmed, {
    status: "matched",
    distinctSamples: 2,
    duplicateSamples: 0,
    candidates: one.candidates,
  });
  assert.equal(
    recognizeCrc(modbus, { width: 16, order: "big" }).status,
    "no-match",
  );
});

test("contradictions, ambiguous matches, and non-byte widths remain distinct", () => {
  const different = { ...modbus[0], checksum: Buffer.from("374A", "hex") };
  assert.deepEqual(recognizeCrc([modbus[0], different, different]), {
    status: "contradictory",
    distinctSamples: 1,
    duplicateSamples: 1,
    candidates: [],
  });
  const ambiguous = recognizeCrc([sample("00", "00")], { width: 8 });
  assert.equal(ambiguous.status, "more-samples");
  assert.ok(ambiguous.candidates.length > 1);
  const narrowed = recognizeCrc(
    [{ bytes: textVector, checksum: Buffer.from("0DAF", "hex") }],
    {
      width: 12,
      order: "big",
    },
  );
  assert.deepEqual(
    narrowed.candidates.map(({ name }) => name),
    ["CRC-12/UMTS"],
  );
  assert.throws(() => recognizeCrc([modbus[0], sample("0103", "C5")]), {
    path: "samples[1].checksum",
  });
  assert.throws(() => recognizeCrc(modbus, { width: 9 }), { path: "width" });
});
