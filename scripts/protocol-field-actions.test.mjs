import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { register } from "../packages/plugin-sdk/examples/reference-protocol-fields/main.ts";
import { defaultFrameTemplate } from "../packages/plugin-sdk/examples/reference-protocol-fields/frame-template.ts";

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

test("the field package uses one versioned template for assembly and verification", async () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../packages/plugin-sdk/examples/reference-protocol-fields/manifest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const action = manifest.contributes.parsers.find(
    ({ actionId }) => actionId === "swb.reference.fields.frameTemplate",
  );
  assert.deepEqual(action.permissions, ["content.read"]);
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validInput = ajv.compile(action.inputSchema);
  const validOutput = ajv.compile(action.outputSchema);
  const template = JSON.stringify(defaultFrameTemplate);
  const assemble = {
    mode: "assemble",
    template,
    values: { serial: "258", data: "10 20 30" },
  };
  assert.equal(validInput(assemble), true);
  const built = await call("frameTemplate", assemble);
  assert.equal(validOutput(built), true);
  assert.equal(
    Buffer.from(built.bytesBase64, "base64").toString("hex"),
    "aa55030201102030030d",
  );
  const decode = { mode: "decode", template, bytesBase64: built.bytesBase64 };
  assert.equal(validInput(decode), true);
  assert.equal(validInput({ ...decode, values: assemble.values }), false);
  assert.deepEqual(await call("frameTemplate", decode), built);
  const damaged = Buffer.from(built.bytesBase64, "base64");
  damaged[8] ^= 1;
  const failed = await call("frameTemplate", {
    ...decode,
    bytesBase64: damaged.toString("base64"),
  });
  assert.equal(validOutput(failed), true);
  assert.deepEqual(failed, { status: "invalid", path: "checksum" });
});

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

const comparisonSpec = JSON.parse(
  readFileSync(
    new URL(
      "../packages/plugin-sdk/examples/reference-protocol-fields/manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
).contributes.parsers.find(
  ({ actionId }) => actionId === "swb.reference.fields.compareSessions",
);
const ajv = new Ajv({ strict: false });
const validateComparisonInput = ajv.compile(comparisonSpec.inputSchema);
const validateComparisonOutput = ajv.compile(comparisonSpec.outputSchema);

function capturedFrame(position, bytes, time) {
  return {
    position: String(position),
    bytesBase64: Buffer.from(bytes).toString("base64"),
    ...(time ? { time } : {}),
  };
}

test("session comparison returns aligned rows with paged byte and field details", async () => {
  const time = (clockId, monoNs, segment = 0) => ({ clockId, monoNs, segment });
  const frameDefinition = JSON.stringify({
    version: "1",
    byteLength: 3,
    fields: ["unit", "register", "value"].map((id, byteOffset) => ({
      id,
      byteOffset,
      kind: "integer",
      width: 1,
      order: "big",
    })),
  });
  const params = {
    baseline: [
      capturedFrame(1, [1, 8, 11], time("base", "9007199254740993")),
      capturedFrame(4, [2, 7, 13], time("base", "9007199254741014")),
    ],
    candidate: [
      capturedFrame(1, [1, 8, 77], time("candidate", "9007199254800000")),
      capturedFrame(2, [3, 6, 1], time("candidate", "9007199254800005")),
      capturedFrame(3, [2, 7, 13], time("candidate", "9007199254800015")),
    ],
    alignment: { kind: "fields", ids: ["unit", "register"] },
    definition: frameDefinition,
    detail: { rowIndex: 0 },
  };
  assert.equal(
    validateComparisonInput(params),
    true,
    JSON.stringify(validateComparisonInput.errors),
  );
  const result = await call("compareSessions", params);
  assert.equal(
    validateComparisonOutput(result),
    true,
    JSON.stringify(validateComparisonOutput.errors),
  );
  assert.deepEqual(
    result.rows.map(
      ({ baselinePosition, candidatePosition, elapsedDeltaNs }) => [
        baselinePosition,
        candidatePosition,
        elapsedDeltaNs,
      ],
    ),
    [
      ["1", "1", "0"],
      ["4", "3", "-6"],
      [null, "2", null],
    ],
  );
  assert.equal(result.rows[0].changedBytes, 1);
  assert.deepEqual(result.detail, {
    rowIndex: 0,
    byteRanges: { offset: 0, total: 1, items: [{ start: 2, end: 3 }] },
    fields: {
      offset: 0,
      total: 1,
      items: [
        {
          id: "value",
          baseline: { value: "11", rawHex: "0B", rawValue: "11" },
          candidate: { value: "77", rawHex: "4D", rawValue: "77" },
        },
      ],
    },
  });
});

test("session comparison pages large byte and field change sets without discarding the totals", async () => {
  const baseline = Buffer.alloc(4096),
    candidate = Buffer.alloc(4096);
  for (let i = 0; i < candidate.length; i += 2) candidate[i] = 1;
  const large = {
    baseline: [capturedFrame(1, baseline)],
    candidate: [capturedFrame(1, candidate)],
    alignment: { kind: "ordinal" },
    detail: { rowIndex: 0, byteOffset: 1920 },
  };
  const result = await call("compareSessions", large);
  assert.equal(validateComparisonOutput(result), true);
  assert.equal(result.rows[0].changedBytes, 2048);
  assert.equal(result.detail.byteRanges.total, 2048);
  assert.equal(result.detail.byteRanges.items.length, 128);
  assert.deepEqual(result.detail.byteRanges.items.at(-1), {
    start: 4094,
    end: 4095,
  });
  const byteLength = 9;
  const frames = {
    baseline: [capturedFrame(1, Buffer.alloc(byteLength))],
    candidate: [capturedFrame(1, Buffer.alloc(byteLength, 1))],
    alignment: { kind: "ordinal" },
    detail: { rowIndex: 0, fieldOffset: 8 },
    definition: JSON.stringify({
      version: "1",
      byteLength,
      fields: Array.from({ length: byteLength }, (_, i) => ({
        id: "f" + i,
        kind: "integer",
        width: 1,
        order: "big",
        byteOffset: i,
      })),
    }),
  };
  const fields = await call("compareSessions", frames);
  assert.equal(validateComparisonOutput(fields), true);
  assert.equal(fields.rows[0].changedFields, 9);
  assert.equal(fields.detail.fields.total, 9);
  assert.deepEqual(
    fields.detail.fields.items.map(({ id }) => id),
    ["f8"],
  );
});

test("session comparison reports invalid frame positions and windows without turning cancellation into input errors", async () => {
  const params = {
    baseline: [capturedFrame(1, [1])],
    candidate: [],
    alignment: { kind: "ordinal" },
  };
  assert.deepEqual(
    await call("compareSessions", {
      ...params,
      baseline: [capturedFrame(0, [1])],
    }),
    { status: "invalid", path: "baseline[0].position" },
  );
  assert.deepEqual(
    await call("compareSessions", {
      ...params,
      baseline: [capturedFrame("18446744073709551616", [1])],
    }),
    { status: "invalid", path: "baseline[0].position" },
  );
  assert.deepEqual(
    await call("compareSessions", {
      ...params,
      baseline: Array.from({ length: 17 }, (_, i) =>
        capturedFrame(i + 1, Buffer.alloc(4096)),
      ),
    }),
    { status: "invalid", path: "baseline" },
  );
  assert.deepEqual(
    await call("compareSessions", { ...params, detail: { rowIndex: 1 } }),
    { status: "invalid", path: "detail.rowIndex" },
  );
  await assert.rejects(call("compareSessions", params, AbortSignal.abort()), {
    name: "AbortError",
  });
});
