import assert from "node:assert/strict";
import test from "node:test";
import {
  createRepeatSend,
  repeatSendAction,
} from "../packages/plugin-sdk/examples/reference-automation/repeat-send.ts";
import manifest from "../packages/plugin-sdk/examples/reference-automation/manifest.json" with { type: "json" };

const target = {
  kind: "session",
  hostId: "host",
  id: "session",
  sessionId: "session",
  sessionEpoch: "1",
};
const encode = (value) => Buffer.from(value).toString("base64");
const bytes = encode("poll");
const base = { sendBase64: bytes, periodMs: 50, count: 3 };

function harness({
  incoming = [],
  offsets = [],
  durations = [],
  oversleeps = [],
  beforeWait = () => {},
  afterWrite = () => {},
  writeOutcome = "accepted",
} = {}) {
  let time = 0;
  let held = false;
  let byteEnd = 0;
  const controller = new AbortController();
  const writes = [];
  const events = [];
  function append(at, kind, payload) {
    events.push({
      at,
      ...target,
      time: { clockId: "source", sourceMonoNs: String(at * 1_000_000) },
      eventSeq: String(events.length + 1),
      kind,
      payload,
    });
  }
  function rx(at, text) {
    const start = byteEnd;
    byteEnd += Buffer.byteLength(text);
    append(at, "rx", {
      byteStart: String(start),
      byteEnd: String(byteEnd),
      bytesBase64: encode(text),
    });
  }
  for (const [at, text] of incoming) {
    if (text === null) append(at, "gap", {});
    else rx(at, text);
  }
  const clock = {
    now: () => time,
    async wait(ms, signal) {
      assert.equal(
        held,
        false,
        "The scheduler must release its transaction during the delay",
      );
      beforeWait(controller);
      signal.throwIfAborted();
      time += ms + (oversleeps.shift() ?? 0);
    },
    jitter(limit) {
      assert.ok(limit >= 0);
      const value = offsets.shift() ?? 0;
      assert.ok(Math.abs(value) <= limit);
      return value;
    },
  };
  const progress = [];
  const task = {
    signal: controller.signal,
    actions: {
      async invokeChild({ actionId, params, leaseId }) {
        if (actionId === "lease.acquire") {
          assert.equal(held, false);
          held = true;
          return {
            state: "running",
            result: {
              kind: "lease",
              value: { state: "active", leaseId: "lease" },
            },
          };
        }
        if (actionId === "lease.release") {
          assert.equal(held, true);
          assert.equal(params.leaseId, "lease");
          held = false;
          return {
            state: "succeeded",
            result: {
              kind: "lease",
              value: { state: "released", leaseId: "lease" },
            },
          };
        }
        assert.equal(actionId, "session.tx");
        assert.equal(leaseId, "lease");
        assert.equal(params.bytesBase64, bytes);
        assert.equal(held, true);
        const operationId = "tx-" + (writes.length + 1);
        writes.push({ operationId, at: time });
        time += durations.shift() ?? 0;
        afterWrite({ at: time, operationId, append, rx });
        return {
          operationId,
          state: "succeeded",
          result: {
            kind: "tx",
            value: {
              operationId,
              sessionId: target.sessionId,
              sessionEpoch: target.sessionEpoch,
              outcome: writeOutcome,
              bytesBase64: bytes,
            },
          },
        };
      },
    },
    streams: {
      async read({ startEventSeq }) {
        const visible = events.filter(
          ({ at, eventSeq }) =>
            at <= time && BigInt(eventSeq) >= BigInt(startEventSeq),
        );
        return {
          events: visible,
          nextEventSeq: visible.length
            ? String(BigInt(visible.at(-1).eventSeq) + 1n)
            : startEventSeq,
          hasMore: false,
        };
      },
    },
    progress: { report: (value) => progress.push(value) },
  };
  return {
    writes,
    progress,
    get held() {
      return held;
    },
    run: (params = {}) =>
      createRepeatSend(clock)({ target, params: { ...base, ...params } }, task),
  };
}

test("declares the scheduled action and preserves monotonic slots across delayed writes", async () => {
  const action = manifest.contributes.actions.find(
    ({ actionId }) => actionId === repeatSendAction,
  );
  assert.equal(action.executionLocation, "resource_host");
  const h = harness({ offsets: [4, -4], durations: [7, 130, 5] });
  const result = await h.run({ jitterMs: 4, startDelayMs: 10 });
  assert.equal(result.outcome, "completed");
  assert.equal(result.completed, 3);
  assert.equal(result.skippedSlots, 2);
  assert.deepEqual(
    h.writes.map(({ at }) => at),
    [10, 64, 206],
  );
  assert.deepEqual(
    result.attempted.map(({ scheduledMs, startedMs }) => [
      scheduledMs,
      startedMs,
    ]),
    [
      [0, 0],
      [54, 54],
      [196, 196],
    ],
  );
  assert.deepEqual(
    h.progress.map(({ completed }) => completed),
    ["1", "2", "3"],
  );
  assert.equal(h.held, false);
});

test("waits for the next fresh slot after a suspended timer wakes up", async () => {
  const h = harness({ oversleeps: [130] });
  const result = await h.run();
  assert.equal(result.outcome, "completed");
  assert.equal(result.skippedSlots, 3);
  assert.deepEqual(
    h.writes.map(({ at }) => at),
    [0, 200, 250],
  );
  assert.equal(h.held, false);
});

test("uses fresh, contiguous RX to start and stop across read pages", async () => {
  const h = harness({
    incoming: [
      [0, "GO!"],
      [20, "G"],
      [40, "O"],
      [60, "HAL"],
      [80, "T"],
    ],
  });
  const result = await h.run({
    startOnBase64: encode("GO"),
    stopOnBase64: encode("HALT"),
  });
  assert.equal(result.outcome, "stop_condition");
  assert.equal(result.completed, 1);
  assert.deepEqual(
    h.writes.map(({ at }) => at),
    [40],
  );
  assert.equal(h.held, false);
});

test("honors a stop trigger immediately after a start trigger in the same RX record", async () => {
  const h = harness({ incoming: [[20, "GOSTOP"]] });
  const result = await h.run({
    startOnBase64: encode("GO"),
    stopOnBase64: encode("STOP"),
  });
  assert.equal(result.outcome, "stop_condition");
  assert.equal(result.completed, 0);
  assert.deepEqual(h.writes, []);
});

test("stops on an expired start trigger or Raw discontinuity without admitting a write", async () => {
  const stale = harness({ incoming: [[300, "GO"]] });
  const timed = await stale.run({
    startOnBase64: encode("GO"),
    startTimeoutMs: 100,
  });
  assert.equal(timed.outcome, "start_timeout");
  assert.deepEqual(stale.writes, []);
  const unreliable = harness({
    incoming: [
      [10, "G"],
      [15, null],
      [20, "O"],
    ],
  });
  const result = await unreliable.run({ startOnBase64: encode("GO") });
  assert.equal(result.outcome, "source_changed");
  assert.deepEqual(unreliable.writes, []);
});

test("requires the current round receipt and exact expected response before scheduling another write", async () => {
  const h = harness({
    afterWrite({ at, operationId, append, rx }) {
      append(at, "tx_intent", { operationId });
      rx(at, operationId === "tx-1" ? "OK" : "WRONG");
      append(at, "tx", { operationId });
    },
  });
  const result = await h.run({ expectBase64: encode("OK") });
  assert.equal(result.outcome, "unexpected_response");
  assert.equal(result.completed, 1);
  assert.deepEqual(
    result.attempted.map(({ outcome }) => outcome),
    ["matched", "unexpected_response"],
  );
  assert.equal(h.writes.length, 2);
  assert.equal(h.held, false);
});

test("does not admit another round after a partial result or cancellation during the wait", async () => {
  const partial = harness({ writeOutcome: "partial" });
  const result = await partial.run();
  assert.equal(result.outcome, "transmit_unconfirmed");
  assert.equal(partial.writes.length, 1);
  assert.equal(partial.held, false);
  const interrupted = harness({
    beforeWait: (controller) => controller.abort(),
  });
  await assert.rejects(interrupted.run(), { name: "AbortError" });
  assert.equal(interrupted.writes.length, 1);
  assert.equal(interrupted.held, false);
});
