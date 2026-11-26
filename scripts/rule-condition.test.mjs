import assert from "node:assert/strict";
import test from "node:test";
import { compileRuleCondition } from "../packages/plugin-sdk/examples/reference-automation/rule-condition.ts";
import { watchRuleCondition } from "../packages/plugin-sdk/examples/reference-automation/rule-observation.ts";

const utf8 = new TextEncoder();
const uint64 = {
  version: "1",
  byteLength: 8,
  fields: [
    { kind: "integer", id: "counter", byteOffset: 0, width: 8, order: "big" },
  ],
};

test("matches complete UTF-8 lines and the payload before a CRLF terminator", () => {
  const condition = compileRuleCondition({
    kind: "regex",
    pattern: "^温度: [0-9]+ C$",
    ignoreCase: true,
  });
  assert.deepEqual(condition.framing, { kind: "line", maxBytes: 4096 });
  assert.equal(condition.matches(utf8.encode("温度: 23 c\r")), true);
  assert.equal(condition.matches(utf8.encode("温度: 23 c; extra")), false);
  assert.equal(condition.matches(Uint8Array.of(0xff)), false);
  assert.equal(condition.matches(new Uint8Array(4097)), false);
});

test("rejects invalid expressions and aborts exponential matching within the task", () => {
  assert.throws(
    () => compileRuleCondition({ kind: "regex", pattern: "[" }),
    /regular expression/i,
  );
  assert.throws(
    () => compileRuleCondition({ kind: "regex", pattern: "x".repeat(257) }),
    /regular expression/i,
  );
  const condition = compileRuleCondition({
    kind: "regex",
    pattern: "^(a+)+$",
  });
  assert.throws(() => condition.matches(utf8.encode("a".repeat(128) + "!")), {
    code: "ERR_SCRIPT_EXECUTION_TIMEOUT",
  });
  assert.equal(condition.matches(utf8.encode("aaa")), true);
});

test("compares protocol field thresholds using exact 64-bit values", () => {
  const condition = compileRuleCondition({
    kind: "field",
    definition: uint64,
    fieldId: "counter",
    operator: "gt",
    expected: "9007199254740992",
  });
  assert.deepEqual(condition.framing, { kind: "fixed", byteLength: 8 });
  assert.equal(condition.matches(Buffer.from("0020000000000001", "hex")), true);
  assert.equal(
    condition.matches(Buffer.from("0020000000000000", "hex")),
    false,
  );
  assert.equal(condition.matches(Uint8Array.of(1)), false);
});

test("borrows calibrated units and explicit raw codes from the shared field decoder", () => {
  const definition = {
    version: "1",
    byteLength: 1,
    fields: [
      {
        kind: "integer",
        id: "voltage",
        byteOffset: 0,
        width: 1,
        order: "big",
        calibration: {
          kind: "linear",
          revision: "1",
          scale: "0.25",
          bias: "-1",
        },
      },
    ],
  };
  const condition = {
    kind: "field",
    definition,
    fieldId: "voltage",
    operator: "eq",
  };
  assert.equal(
    compileRuleCondition({ ...condition, expected: "1.25" }).matches(
      Uint8Array.of(9),
    ),
    true,
  );
  assert.equal(
    compileRuleCondition({
      ...condition,
      compare: "raw",
      expected: "9",
    }).matches(Uint8Array.of(9)),
    true,
  );
  assert.equal(
    compileRuleCondition({ ...condition, expected: "9" }).matches(
      Uint8Array.of(9),
    ),
    false,
  );
});

test("invalid checksums and invalid frame encodings never trigger a field effect", () => {
  const definition = {
    version: "1",
    byteLength: 2,
    fields: [
      { kind: "integer", id: "alarm", byteOffset: 0, width: 1, order: "big" },
      {
        kind: "checksum",
        id: "crc",
        byteOffset: 1,
        algorithm: "sum",
        order: "little",
        coverageStart: 0,
        coverageEnd: 1,
      },
    ],
  };
  const condition = compileRuleCondition({
    kind: "field",
    definition,
    fieldId: "alarm",
    operator: "eq",
    expected: "16",
  });
  assert.equal(condition.matches(Uint8Array.of(16, 16)), true);
  assert.equal(condition.matches(Uint8Array.of(16, 0)), false);
  assert.throws(
    () =>
      compileRuleCondition({
        kind: "field",
        definition,
        fieldId: "missing",
        operator: "eq",
        expected: "16",
      }),
    /unknown field/i,
  );
});

const session = { hostId: "host", sessionId: "session", sessionEpoch: "2" };
const baseOffset = 9007199254740993n;
const watchAlarm = (startAtBoundary) =>
  watchRuleCondition(
    { kind: "regex", pattern: "^ERROR$" },
    session,
    "31",
    startAtBoundary,
  );

function rx(eventSeq, relativeOffset, input, other = {}) {
  const bytes = Buffer.from(input);
  const start = baseOffset + BigInt(relativeOffset);
  return {
    ...session,
    kind: "rx",
    eventSeq,
    time: {
      clockId: "source-clock",
      sourceMonoNs: eventSeq,
      precision: { source: "host_read", resolutionNs: "1000" },
    },
    payload: {
      bytesBase64: bytes.toString("base64"),
      byteStart: String(start),
      byteEnd: String(start + BigInt(bytes.length)),
    },
    ...other,
  };
}

test("synchronizes regex matching and emits one exact range across receive events", () => {
  const watch = watchAlarm(false);
  assert.equal(watch.observe(rx("31", 0, "ER")), undefined);
  assert.equal(watch.observe(rx("32", 2, "ROR\nERR")), undefined);
  assert.deepEqual(watch.observe(rx("33", 9, "OR\r\nERROR\n")), {
    kind: "match",
    source: {
      ...session,
      direction: "rx",
      eventStart: "32",
      eventEnd: "34",
      byteStart: String(baseOffset + 6n),
      byteEnd: String(baseOffset + 13n),
    },
  });
  assert.equal(watch.observe(rx("34", 19, "ERROR\n")), undefined);
});

test("checks fixed-frame alignment and returns source before an unrelated remainder", () => {
  const field = {
    kind: "field",
    definition: uint64,
    fieldId: "counter",
    operator: "gt",
    expected: "9007199254740992",
  };
  assert.throws(
    () => watchRuleCondition(field, session, "31", false),
    /confirmed starting boundary/,
  );
  const watch = watchRuleCondition(field, session, "31", true);
  assert.equal(
    watch.observe(rx("31", 0, Buffer.from("002000", "hex"))),
    undefined,
  );
  const matched = watch.observe(
    rx("32", 3, Buffer.from("0000000001abcd", "hex")),
  );
  assert.equal(matched?.source.byteEnd, String(baseOffset + 8n));
  assert.equal(matched?.source.eventEnd, "33");
});

test("discarded overlong lines cannot produce effects and a new line can match", () => {
  const watch = watchAlarm(true);
  assert.equal(watch.observe(rx("31", 0, "X".repeat(4090))), undefined);
  const result = watch.observe(rx("32", 4090, "ERRORERROR\nERROR\n"));
  assert.equal(result?.source.byteStart, String(baseOffset + 4101n));
  assert.equal(result?.source.byteEnd, String(baseOffset + 4107n));
});

test("rejects capture gaps, timing changes, lost cursor positions and epoch changes", () => {
  const changedEvent = [
    rx("32", 3, "OR\n", { kind: "gap" }),
    rx("32", 3, "OR\n", { kind: "configuration_boundary" }),
    rx("32", 3, "OR\n", {
      time: { ...rx("32", 3, "OR\n").time, clockId: "other-source-clock" },
    }),
    rx("32", 3, "OR\n", {
      time: { ...rx("32", 3, "OR\n").time, sourceMonoNs: "30" },
    }),
    rx("32", 3, "OR\n", {
      time: {
        ...rx("32", 3, "OR\n").time,
        precision: { source: "host_read", resolutionNs: "2000" },
      },
    }),
    rx("33", 3, "OR\n"),
    rx("32", 4, "OR\n"),
    rx("32", 3, "OR\n", { sessionEpoch: "3" }),
  ];
  for (const event of changedEvent) {
    const watch = watchAlarm(true);
    assert.equal(watch.observe(rx("31", 0, "ERR")), undefined);
    assert.deepEqual(watch.observe(event), { kind: "source_changed" });
    assert.equal(watch.observe(rx("32", 3, "OR\n")), undefined);
  }
});

test("exact HEX request requires a known boundary and matches only one full frame across blocks", () => {
  const condition = { kind: "hex", hex: "aa 55 00 FF" };
  assert.throws(
    () => watchRuleCondition(condition, session, "31", false),
    /confirmed starting boundary/i,
  );
  const watch = watchRuleCondition(condition, session, "31", true);
  assert.equal(
    watch.observe(rx("31", 0, [0xaa, 0x55, 0x00, 0x01, 0xaa, 0x55])),
    undefined,
  );
  assert.deepEqual(watch.observe(rx("32", 6, [0x00, 0xff, 0x00])), {
    kind: "match",
    source: {
      ...session,
      direction: "rx",
      eventStart: "31",
      eventEnd: "33",
      byteStart: String(baseOffset + 4n),
      byteEnd: String(baseOffset + 8n),
    },
  });
  for (const hex of ["", "A", "ZZ", "AB".repeat(257)]) {
    assert.throws(() => compileRuleCondition({ kind: "hex", hex }));
  }
});
