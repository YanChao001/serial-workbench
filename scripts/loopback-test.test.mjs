import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import manifest from "../packages/plugin-sdk/examples/reference-automation/builtin-manifest.json" with { type: "json" };
import { register } from "../packages/plugin-sdk/examples/reference-automation/builtin.ts";
import { builtinLoopbackTestAction } from "../packages/plugin-sdk/examples/reference-automation/loopback-test.ts";

const target = {
  kind: "session",
  id: "session-echo",
  sessionId: "session-echo",
  sessionEpoch: "3",
  hostId: "host-1",
};
const spec = manifest.contributes.actions.find(
  ({ actionId }) => actionId === builtinLoopbackTestAction,
);
const ajv = new Ajv();
const inputValid = ajv.compile(spec.inputSchema);
const outputValid = ajv.compile(spec.outputSchema);

function fixture({ change, partial = false, abort = false } = {}) {
  const controller = new AbortController();
  const handlers = new Map();
  register({
    actions: { register: (id, handler) => handlers.set(id, handler) },
  });
  const invocations = [];
  const sent = [];
  const progress = [];
  const events = [];
  let nextByte = 0;
  const configured = "4";
  const append = (kind, payload, time = 1n, revision = configured) =>
    events.push({
      ...target,
      eventSeq: String(events.length + 1),
      configurationRevision: revision,
      kind,
      payload,
      time: { clockId: "clock-A", sourceMonoNs: String(time) },
    });

  const rx = (bytes, now) => {
    const byteStart = nextByte;
    nextByte += bytes.length;
    append(
      "rx",
      {
        bytesBase64: bytes.toString("base64"),
        byteStart: String(byteStart),
        byteEnd: String(nextByte),
      },
      now,
    );
  };
  rx(Buffer.from("historical traffic"), 1n);
  const task = {
    signal: controller.signal,
    progress: { report: (report) => progress.push(report) },
    actions: {
      async invokeChild(call) {
        invocations.push(call);
        if (call.actionId === "lease.acquire")
          return {
            operationId: "acquire",
            state: "running",
            result: {
              kind: "lease",
              value: { leaseId: "lease-1", state: "active" },
            },
          };
        if (call.actionId === "lease.release")
          return {
            operationId: "release",
            state: "succeeded",
            result: {
              kind: "lease",
              value: { leaseId: "lease-1", state: "released" },
            },
          };
        assert.equal(call.actionId, "session.tx");
        assert.equal(call.leaseId, "lease-1");
        const bytes = Buffer.from(call.params.bytesBase64, "base64");
        sent.push(bytes);
        const operationId = "write-" + sent.length;
        const time = BigInt(sent.length) * 100_000_000n;
        const intent = {
          operationId,
          byteStart: String((sent.length - 1) * bytes.length),
          byteEnd: String(sent.length * bytes.length),
          bytesBase64: call.params.bytesBase64,
        };
        const receipt = {
          ...intent,
          sessionId: target.sessionId,
          sessionEpoch: target.sessionEpoch,
          outcome: partial ? "partial" : "accepted",
          acceptedRanges: [
            { start: "0", end: String(partial ? 1 : bytes.length) },
          ],
          unknownRanges: [],
        };
        append("tx_intent", intent, time);
        const echo = Buffer.from(bytes);
        if (change) change({ echo, append, rx, time, sent });
        else {
          rx(echo.subarray(0, 5), time + 10_000_000n);
          rx(echo.subarray(5), time + 20_000_000n);
        }
        append("tx", receipt, time + 23_000_000n);
        return {
          operationId,
          state: "succeeded",
          result: { kind: "tx", value: receipt },
        };
      },
    },
    streams: {
      async read({ startEventSeq }) {
        const first = Number(startEventSeq) - 1;
        if (abort && sent.length) controller.abort();
        const page = events.slice(first, first + 2);
        return {
          events: page,
          nextEventSeq: String(first + page.length + 1),
          hasMore: first + page.length < events.length,
        };
      },
    },
  };
  return {
    async run(overrides = {}) {
      const params = {
        source: "virtual_echo",
        seed: 123,
        count: 2,
        frameBytes: 24,
        timeoutMs: 100,
        startEventSeq: "1",
        sessionRevision: "7",
        configurationRevision: configured,
        ...overrides,
      };
      assert.ok(inputValid(params), JSON.stringify(inputValid.errors));
      const result = await handlers.get(builtinLoopbackTestAction)(
        { target, params },
        task,
      );
      assert.ok(outputValid(result), JSON.stringify(outputValid.errors));
      return result;
    },
    invocations,
    sent,
    progress,
  };
}

test("uses one transaction, follows split echo across pages, and counts payload bits", async () => {
  const f = fixture({
    change({ echo, rx, time, sent }) {
      if (sent.length === 2) {
        echo[17] ^= 0b10110000;
        echo[23] ^= 1;
      }
      rx(echo.subarray(0, 5), time + 10_000_000n);
      rx(echo.subarray(5), time + 20_000_000n);
    },
  });
  const result = await f.run();
  assert.equal(result.outcome, "completed");
  assert.equal(result.sentBytes, 48);
  assert.equal(result.comparedFrames, 2);
  assert.equal(result.comparedBits, 128);
  assert.equal(result.bitErrors, 4);
  assert.equal(result.bitErrorRate, 4 / 128);
  assert.equal(result.throughputBytesPerSecond, 400);
  assert.deepEqual(result.latencyNs, {
    min: 20_000_000,
    max: 20_000_000,
    mean: 20_000_000,
  });
  assert.equal(result.frames[1].source.byteStart, "42");
  assert.equal(result.frames[1].source.byteEnd, "66");
  assert.equal(result.frames[1].source.eventStart, "7");
  assert.equal(result.frames[1].source.eventEnd, "9");
  assert.deepEqual(
    f.progress.map(({ completed }) => completed),
    ["1", "2"],
  );
  assert.equal(f.sent[0].readUInt32LE(0), 123);
  assert.equal(f.sent[1].readUInt32LE(4), 2);
  assert.equal(f.sent[1].subarray(8, 16).toString("hex"), result.runTag);
  assert.deepEqual(
    f.invocations.map(({ actionId, expectedRevision }) => [
      actionId,
      expectedRevision,
    ]),
    [
      ["lease.acquire", "7"],
      ["session.tx", "8"],
      ["session.tx", "8"],
      ["lease.release", undefined],
    ],
  );

  const next = fixture();
  assert.notEqual((await next.run()).runTag, result.runTag);
  assert.deepEqual(next.sent[0].subarray(16), f.sent[0].subarray(16));
});

for (const [outcome, change, expectedBytes] of [
  [
    "marker_mismatch",
    ({ echo, rx, time }) => {
      echo[8] ^= 1;
      rx(echo, time + 1n);
    },
    24,
  ],
  [
    "missing_bytes",
    ({ echo, rx, time }) => rx(echo.subarray(0, 17), time + 1n),
    17,
  ],
  ["response_timeout", () => {}, 0],
  [
    "unexpected_bytes",
    ({ echo, rx, time }) => {
      rx(echo, time + 1n);
      rx(Buffer.of(1), time + 2n);
    },
    24,
  ],
  ["source_changed", ({ append, time }) => append("gap", {}, time + 1n), 0],
  [
    "source_changed",
    ({ append, time }) => append("configuration_boundary", {}, time + 1n, "5"),
    0,
  ],
  ["timing_unavailable", ({ echo, rx, time }) => rx(echo, time - 1n), 0],
]) {
  test("halts on " + outcome + " without claiming a comparison", async () => {
    const f = fixture({ change });
    const result = await f.run();
    assert.equal(result.outcome, outcome);
    assert.equal(result.bitErrorRate, null);
    assert.equal(result.throughputBytesPerSecond, null);
    assert.equal(result.frames[0].receivedBytes, expectedBytes);
    assert.equal(f.sent.length, 1);
    assert.equal(f.invocations.at(-1).actionId, "lease.release");
  });
}

test("does not compare after partial or unconfirmed writing", async () => {
  const f = fixture({ partial: true });
  const result = await f.run();
  assert.equal(result.outcome, "transmit_unconfirmed");
  assert.equal(result.sentBytes, 0);
  assert.equal(result.comparedBits, 0);
  assert.equal(f.sent.length, 1);
});

test("checks physical wiring and total duration before acquiring the lease", async () => {
  const f = fixture();
  await assert.rejects(
    f.run({ source: "serial_loopback" }),
    /confirmed source/,
  );
  await assert.rejects(
    f.run({ count: 16, timeoutMs: 1000 }),
    /bounded duration/,
  );
  assert.deepEqual(f.invocations, []);
});

test("parent cancellation stops further probes and leaves child cleanup to the Host", async () => {
  const f = fixture({ abort: true });
  await assert.rejects(f.run(), { name: "AbortError" });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(
    f.invocations.map(({ actionId }) => actionId),
    ["lease.acquire", "session.tx"],
  );
});
