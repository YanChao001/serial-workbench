import assert from "node:assert/strict";
import test from "node:test";
import { register } from "../packages/plugin-sdk/examples/reference-protocol-fields/main.ts";

const handlers = new Map();
register({ parsers: { register: (id, handler) => handlers.set(id, handler) } });
const definition = JSON.stringify({
  version: "1",
  byteLength: 2,
  fields: [
    {
      id: "value",
      kind: "integer",
      byteOffset: 0,
      width: 1,
      order: "big",
      scale: "0.5",
      bias: "1",
    },
    {
      id: "check",
      kind: "checksum",
      byteOffset: 1,
      algorithm: "sum",
      coverageStart: 0,
      coverageEnd: 1,
      order: "big",
    },
  ],
});

async function call(name, params, signal = new AbortController().signal) {
  const handler = handlers.get(`swb.reference.fields.${name}`);
  assert.equal(typeof handler, "function");
  return handler({ params }, { signal });
}

test("the signed Modbus action constructs ASCII and decodes RTU with precise faults", async () => {
  const packet = {
    unitId: 1,
    pdu: { functionCode: 3, address: 0, quantity: 10 },
  };
  const encoded = await call("modbus", {
    mode: "encode",
    transport: "ascii",
    direction: "request",
    packet,
  });
  assert.equal(encoded.status, "encoded");
  assert.equal(
    Buffer.from(encoded.bytesBase64, "base64").toString("ascii"),
    ":01030000000AF2\r\n",
  );
  const decode = { mode: "decode", transport: "rtu", direction: "request" };
  const bytes = (hex) => Buffer.from(hex, "hex").toString("base64");
  assert.deepEqual(
    await call("modbus", { ...decode, bytesBase64: bytes("01030000000ac5cd") }),
    {
      status: "decoded",
      packet,
      broadcast: false,
    },
  );
  assert.deepEqual(
    await call("modbus", { ...decode, bytesBase64: bytes("01030000000ac5cc") }),
    {
      status: "invalid",
      path: "frame.crc",
    },
  );
});

test("the signed-field CRC handler preserves candidate evidence and validation", async () => {
  const sample = { bytesBase64: "MTIzNDU2Nzg5", checksumBase64: "N0s=" };
  const one = await call("identifyCrc", { samples: [sample] });
  assert.equal(one.status, "more-samples");
  assert.equal(one.distinctSamples, 1);
  assert.equal(one.candidates[0].name, "CRC-16/MODBUS");
  assert.equal(one.candidates[0].order, "little");
  assert.deepEqual(
    await call("identifyCrc", {
      samples: [sample, { bytesBase64: "QQ==", checksumBase64: "QQ==" }],
    }),
    { status: "invalid", path: "samples[1].checksum" },
  );
  assert.deepEqual(
    await call("identifyCrc", { samples: [{ ...sample, bytesBase64: "??" }] }),
    {
      status: "invalid",
      path: "samples[0].bytesBase64",
    },
  );
});

test("Node field actions construct and decode the same byte positions and checksum", async () => {
  const encoded = await call("encode", {
    definition,
    values: { value: "33.5" },
  });
  assert.deepEqual(encoded, { status: "encoded", bytesBase64: "QUE=" });
  const decoded = await call("decode", {
    definition,
    bytesBase64: encoded.bytesBase64,
  });
  assert.equal(decoded.status, "decoded");
  assert.equal(decoded.readings[0].value, "33.5");
  assert.deepEqual(decoded.readings[0].bytes, { start: 0, end: 1 });
  assert.equal(decoded.readings[0].rawHex, "41");
  assert.deepEqual(decoded.readings[1].checksum, {
    expectedHex: "41",
    valid: true,
    coverage: { start: 0, end: 1 },
  });
});

test("Node field actions report invalid paths and keep cancellation distinct", async () => {
  assert.deepEqual(
    await call("decode", { definition: "{", bytesBase64: "QQ==" }),
    { status: "invalid", path: "definition", position: { line: 1, column: 2 } },
  );
  assert.deepEqual(await call("decode", { definition, bytesBase64: "QQ" }), {
    status: "invalid",
    path: "bytesBase64",
  });
  assert.deepEqual(
    await call("encode", { definition, values: { value: "NaN" } }),
    { status: "invalid", path: "values.value" },
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    call("decode", { definition, bytesBase64: "QUE=" }, abort.signal),
    { name: "AbortError" },
  );
});

test("Node field actions accept YAML with string values and locate version errors", async () => {
  const source = [
    'version: "1"',
    "byteLength: 1",
    "fields:",
    "  - id: value",
    "    kind: integer",
    "    byteOffset: 0",
    "    width: 1",
    "    order: big",
    '    scale: "0.5"',
    '    bias: "1"',
  ].join("\n");
  const params = { definition: source, definitionFormat: "yaml" };
  const encoded = await call("encode", {
    ...params,
    values: { value: "33.5" },
  });
  assert.deepEqual(encoded, { status: "encoded", bytesBase64: "QQ==" });
  const decoded = await call("decode", {
    ...params,
    bytesBase64: encoded.bytesBase64,
  });
  assert.equal(decoded.readings[0].value, "33.5");
  assert.deepEqual(
    await call("decode", {
      ...params,
      definition: source.replace('version: "1"', 'version: "2"'),
      bytesBase64: encoded.bytesBase64,
    }),
    { status: "invalid", path: "version", position: { line: 1, column: 1 } },
  );
});

test("field actions reject ambiguous documents and keep one-based locations", async () => {
  const conditions = [
    ["json", "version: '1'"],
    ["json", '{"version":"1","version":"2"}'],
    ["yaml", "version: &version '1'"],
    ["yaml", "version: '1'\n---\nversion: '2'"],
    ["yaml", " "],
  ];
  for (const [definitionFormat, source] of conditions) {
    const result = await call("decode", {
      definition: source,
      definitionFormat,
      bytesBase64: "QQ==",
    });
    assert.equal(result.status, "invalid", source);
    assert.ok(result.position.line >= 1, source);
    assert.ok(result.position.column >= 1, source);
  }
});
