import assert from "node:assert/strict";
import test from "node:test";
import { formatHex, parseHex } from "../packages/plugin-sdk/src/hex.ts";
import {
  compileFrameTemplate,
  defaultFrameTemplate,
} from "../packages/plugin-sdk/examples/reference-protocol-fields/frame-template.ts";

test("assembles the six fields and roundtrips both named variables", () => {
  const codec = compileFrameTemplate(defaultFrameTemplate);
  const result = codec.assemble({ serial: "258", data: "10 20 30" });
  assert.equal(formatHex(result.bytes), "AA 55 03 02 01 10 20 30 03 0D");
  assert.deepEqual(
    result.parts.map(({ id, range }) => [id, range.start, range.end]),
    [
      ["header", 0, 2],
      ["length", 2, 3],
      ["sequence", 3, 5],
      ["payload", 5, 8],
      ["checksum", 8, 9],
      ["tail", 9, 10],
    ],
  );
  assert.deepEqual(result.parts[1].coverage, { start: 5, end: 8 });
  assert.deepEqual(result.parts[4].coverage, { start: 3, end: 8 });
  assert.equal(result.parts[2].variable, "serial");
  assert.equal(result.parts[3].variable, "data");
  assert.deepEqual(codec.decode(result.bytes).values, {
    serial: "258",
    data: "10 20 30",
  });
});

test("calculates the byte length of UTF-8 and preserves an exact unsigned sequence", () => {
  const codec = compileFrameTemplate({
    ...defaultFrameTemplate,
    headerHex: "",
    tailHex: "",
    length: { width: 2, order: "little", coverage: "frame" },
    sequence: { width: 8, order: "big", variable: "counter" },
    payload: { variable: "message", format: "utf8" },
    checksum: { algorithm: "ccitt", order: "big", coverage: "header-payload" },
  });
  const input = { counter: "18446744073709551615", message: "字𐍈" };
  const result = codec.assemble(input);
  assert.equal(result.bytes.length, 19);
  assert.equal(result.parts[1].hex, "13 00");
  assert.equal(result.parts[2].hex, "FF FF FF FF FF FF FF FF");
  assert.equal(result.parts[3].hex, "E5 AD 97 F0 90 8D 88");
  assert.equal(result.parts[4].hex, "57 38");
  assert.deepEqual(codec.decode(result.bytes).values, input);
});

test("an empty payload has an empty coverage range and a valid check value", () => {
  const codec = compileFrameTemplate({
    ...defaultFrameTemplate,
    checksum: { algorithm: "modbus", order: "little", coverage: "payload" },
  });
  const result = codec.assemble({ serial: "0", data: "" });
  assert.equal(formatHex(result.bytes), "AA 55 00 00 00 FF FF 0D");
  assert.deepEqual(result.parts[4].coverage, { start: 5, end: 5 });
  assert.deepEqual(codec.decode(result.bytes).values, {
    serial: "0",
    data: "",
  });
});

test("rejects damaged fields, oversized payloads, invalid values, and unknown settings", () => {
  const codec = compileFrameTemplate(defaultFrameTemplate);
  for (const [packet, field] of [
    ["AB 55 03 02 01 10 20 30 03 0D", "headerHex"],
    ["AA 55 03 02 01 10 20 30 03 0E", "tailHex"],
    ["AA 55 04 02 01 10 20 30 03 0D", "length"],
    ["AA 55 03 02 01 10 20 31 03 0D", "checksum"],
    ["AA 55", "frame"],
  ]) {
    assert.throws(() => codec.decode(parseHex(packet)), { path: field });
  }
  assert.throws(() => codec.assemble({ serial: "65536", data: "" }), {
    path: "values.sequence",
  });
  assert.throws(() => codec.assemble({ serial: "0", data: "F" }), {
    path: "values.payload",
  });
  assert.throws(() => codec.assemble({ serial: "0", data: "00".repeat(256) }), {
    path: "length.width",
  });
  assert.throws(() => codec.assemble({ serial: "0", data: "00", extra: "" }), {
    path: "values",
  });
  assert.throws(
    () => compileFrameTemplate({ ...defaultFrameTemplate, version: "2" }),
    { path: "version" },
  );
  assert.throws(
    () =>
      compileFrameTemplate({
        ...defaultFrameTemplate,
        payload: { variable: "serial", format: "hex" },
      }),
    { path: "payload.variable" },
  );
});
