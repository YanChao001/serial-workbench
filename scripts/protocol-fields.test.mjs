import assert from "node:assert/strict";
import test from "node:test";
import {
  compileProtocolFields,
  ProtocolFieldError,
} from "../packages/plugin-sdk/examples/reference-framing/protocol-fields.ts";

function codec(byteLength, ...fields) {
  return compileProtocolFields({ version: "1", byteLength, fields });
}

function integer(id, byteOffset, width, order, extra = {}) {
  return { kind: "integer", id, byteOffset, width, order, ...extra };
}

function bits(id, byteOffset, order, bitOffset, bitLength, extra = {}) {
  return {
    kind: "bits",
    id,
    byteOffset,
    width: 2,
    order,
    bitOffset,
    bitLength,
    ...extra,
  };
}

function checksum(
  id,
  byteOffset,
  algorithm,
  coverageStart,
  coverageEnd,
  order = "little",
) {
  return {
    kind: "checksum",
    id,
    byteOffset,
    algorithm,
    coverageStart,
    coverageEnd,
    order,
  };
}

function fails(fn, path) {
  assert.throws(
    fn,
    (error) => error instanceof ProtocolFieldError && error.path === path,
  );
}

test("signed 24-bit and unsigned 64-bit fields preserve exact raw and engineering values", () => {
  const definition = codec(
    11,
    integer("sensor", 0, 3, "big", {
      signed: true,
      scale: "0.25",
      bias: "1",
      unit: "°C",
      labels: { "-10": "Cold" },
    }),
    integer("counter", 3, 8, "little", { scale: "0.000000000000000001" }),
  );
  const sample = Uint8Array.from([255, 255, 246, ...Array(8).fill(255)]);
  const [sensor, counter] = definition.decode(sample);
  assert.deepEqual(sensor, {
    id: "sensor",
    kind: "integer",
    bytes: { start: 0, end: 3 },
    unit: "°C",
    rawHex: "FFFFF6",
    rawValue: "-10",
    value: "-1.5",
    label: "Cold",
  });
  assert.equal(counter.rawValue, "18446744073709551615");
  assert.equal(counter.value, "18.446744073709551615");
  assert.deepEqual(
    definition.encode({ sensor: "-1.5", counter: counter.value }),
    sample,
  );
  fails(
    () => definition.encode({ sensor: "-1.6", counter: counter.value }),
    "values.sensor",
  );
  fails(
    () =>
      definition.encode({ sensor: "-1.5", counter: "18.446744073709551616" }),
    "values.counter",
  );
});

test("large and negative transforms remain constructible at their declared limits", () => {
  const huge = "-" + "9".repeat(40);
  const definition = codec(
    8,
    integer("reading", 0, 8, "big", { scale: huge, bias: "0.1" }),
  );
  const sample = new Uint8Array(8).fill(255);
  const [result] = definition.decode(sample);
  assert.equal(result.rawValue, "18446744073709551615");
  assert.equal(
    result.value,
    String(BigInt(result.rawValue) * BigInt(huge) + 1n) + ".9",
  );
  assert.deepEqual(definition.encode({ reading: result.value }), sample);
});

test("mixed-endian independent bits preserve padding and report their position", () => {
  const definition = codec(
    2,
    bits("left", 0, "little", 0, 4),
    bits("right", 0, "big", 0, 3, { signed: true, labels: { "-2": "Alarm" } }),
  );
  const base = Uint8Array.of(0xb0, 0xa0);
  const sample = definition.encode({ left: "5", right: "-2" }, base);
  assert.deepEqual(base, Uint8Array.of(0xb0, 0xa0));
  assert.deepEqual(sample, Uint8Array.of(0xb5, 0xa6));
  const [left, right] = definition.decode(sample);
  assert.deepEqual(left.bits, { start: 0, end: 4 });
  assert.deepEqual(right.bytes, { start: 0, end: 2 });
  assert.deepEqual(right.bits, { start: 0, end: 3 });
  assert.equal(right.rawHex, "B5A6");
  assert.equal(right.label, "Alarm");
  fails(
    () => codec(2, bits("a", 0, "little", 1, 7), bits("b", 0, "big", 9, 3)),
    "fields.b",
  );
});

test("float32, float64, binary data and UTF-8 use their declared byte lengths", () => {
  const definition = codec(
    17,
    {
      kind: "float",
      id: "speed",
      byteOffset: 0,
      width: 4,
      order: "little",
      scale: "2",
      bias: "1",
    },
    { kind: "float", id: "zero", byteOffset: 4, width: 8, order: "big" },
    { kind: "utf8", id: "caption", byteOffset: 12, width: 3 },
    { kind: "bytes", id: "opaque", byteOffset: 15, width: 2 },
  );
  const sample = definition.encode({
    speed: "7",
    zero: "-0",
    caption: "中",
    opaque: "00ff",
  });
  const [speed, zero, caption, opaque] = definition.decode(sample);
  assert.equal(speed.rawHex, "00004040");
  assert.equal(speed.rawValue, "3");
  assert.equal(speed.value, "7");
  assert.equal(zero.rawHex, "8000000000000000");
  assert.equal(zero.value, "-0");
  assert.equal(caption.rawHex, "E4B8AD");
  assert.equal(caption.value, "中");
  assert.equal(opaque.value, "00FF");
  fails(
    () =>
      definition.encode({
        speed: "1e100",
        zero: "0",
        caption: "中",
        opaque: "00FF",
      }),
    "values.speed",
  );
  fails(
    () =>
      definition.encode({
        speed: "7",
        zero: "0",
        caption: "ab",
        opaque: "00FF",
      }),
    "values.caption",
  );
  sample[12] = 255;
  fails(() => definition.decode(sample), "values.caption");
});

test("checksums are calculated in dependency order and identify the exact invalid range", () => {
  const definition = codec(
    12,
    checksum("sum", 11, "sum", 0, 11),
    checksum("crc", 9, "modbus", 0, 9),
    { kind: "utf8", id: "body", byteOffset: 0, width: 9 },
  );
  const data = definition.encode({ body: "123456789" });
  assert.deepEqual(Array.from(data.subarray(9)), [0x37, 0x4b, 0x5f]);
  const [sum, crc] = definition.decode(data);
  assert.equal(crc.rawHex, "374B");
  assert.deepEqual(crc.checksum, {
    coverage: { start: 0, end: 9 },
    expectedHex: "374B",
    valid: true,
  });
  assert.equal(sum.checksum.valid, true);
  data[9] ^= 1;
  const [badSum, badCrc] = definition.decode(data);
  assert.equal(badCrc.rawHex, "364B");
  assert.equal(badCrc.checksum.expectedHex, "374B");
  assert.equal(badCrc.checksum.valid, false);
  assert.equal(badSum.checksum.valid, false);
  fails(
    () => definition.encode({ body: "123456789", crc: "374B" }),
    "values.crc",
  );
});

test("invalid shapes and wire layouts report their paths before accessing frame bytes", () => {
  fails(
    () => compileProtocolFields({ version: "2", byteLength: 1, fields: [] }),
    "version",
  );
  fails(() => codec(0, integer("x", 0, 1, "big")), "byteLength");
  fails(
    () => codec(1, integer("x", 0, 1, "big", { other: 1 })),
    "fields[0].other",
  );
  fails(() => codec(1, integer("x", 0, 2, "big")), "fields[0].width");
  fails(
    () => codec(1, integer("x", 0, 1, "big", { scale: "0" })),
    "fields[0].scale",
  );
  fails(
    () => codec(1, integer("x", 0, 1, "big", { labels: { 256: "A" } })),
    "fields[0].labels.256",
  );
  fails(
    () => codec(2, integer("x", 0, 1, "big"), integer("x", 1, 1, "little")),
    "fields",
  );
  fails(
    () => codec(2, integer("x", 0, 2, "big"), integer("y", 1, 1, "little")),
    "fields.y",
  );
  fails(
    () =>
      codec(2, checksum("a", 0, "sum", 1, 2), checksum("b", 1, "xor", 0, 1)),
    "fields",
  );
  fails(() => codec(1, checksum("a", 0, "sum", 0, 1)), "fields");
  const definition = codec(1, integer("x", 0, 1, "big"));
  fails(() => definition.decode(new Uint8Array(2)), "frame");
  fails(() => definition.encode({}, new Uint8Array(2)), "frame");
  fails(() => definition.encode({}), "values.x");
  fails(() => definition.encode({ x: 0 }), "values.x");
});
