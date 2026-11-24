import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import manifest from "../packages/plugin-sdk/examples/reference-automation/manifest.json" with { type: "json" };
import {
  calendarTaskAction,
  createCalendarTask,
} from "../packages/plugin-sdk/examples/reference-automation/calendar-task.ts";
import { register } from "../packages/plugin-sdk/examples/reference-automation/main.ts";

const target = {
  kind: "session",
  id: "serial-1",
  hostId: "host-1",
  sessionId: "serial-1",
  sessionEpoch: "4",
};
const start = Date.parse("2026-11-24T03:00:00Z");
const minute = 60_000;
const bytes = "QUxBUk0K";

function fixture({
  firstWaitMs,
  confirm = true,
  abortDuringWait = false,
  hold = false,
  pauseBeforeDispatch = false,
  rejectFirstWindow = false,
} = {}) {
  let now = start;
  let waited = false;
  let observationsAtDue = 0;
  const controller = new AbortController();
  const waiting = Promise.withResolvers();
  const writes = [];
  const handler = createCalendarTask({
    now() {
      if (
        pauseBeforeDispatch &&
        now === start + minute &&
        observationsAtDue++ === 1
      )
        now += 5_000;
      return now;
    },
    async wait(ms) {
      if (hold) {
        waiting.resolve();
        await new Promise((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          ),
        );
      }
      if (abortDuringWait) controller.abort();
      now += waited ? ms : (firstWaitMs ?? ms);
      waited = true;
    },
  });
  const task = {
    signal: controller.signal,
    progress: { report() {} },
    actions: {
      async invokeChild(intent) {
        writes.push({ intent, dispatched: now });
        const operationId = "tx-" + writes.length;
        const missed = rejectFirstWindow && writes.length === 1;
        return {
          state: missed ? "interrupted" : confirm ? "succeeded" : "unknown",
          operationId,
          result: {
            kind: "tx",
            value: {
              outcome: missed ? "rejected" : "accepted",
              acceptedRanges: [],
              unknownRanges: [],
              backendError: missed
                ? { code: "TX_DISPATCH_WINDOW_MISSED" }
                : undefined,
              operationId,
              sessionId: target.sessionId,
              sessionEpoch: target.sessionEpoch,
              bytesBase64: bytes,
            },
          },
        };
      },
    },
  };
  const invoke = (schedule, definition = {}) =>
    handler(
      {
        target,
        params: {
          schedule,
          bytesBase64: bytes,
          sessionRevision: "12",
          ...definition,
        },
      },
      task,
    );
  return {
    invoke,
    writes,
    waiting: waiting.promise,
    cancel: () => controller.abort(),
  };
}

const cron = { kind: "cron", expression: "* * * * *", timeZone: "UTC" };
const end = new Date(start + 4 * minute).toISOString();

test("registers calendar sending and dispatches the exact scoped write only at the due time", async () => {
  const handlers = new Map();
  register({
    actions: { register: (id, handler) => handlers.set(id, handler) },
  });
  assert.equal(typeof handlers.get(calendarTaskAction), "function");
  const { invoke, writes } = fixture();
  const scheduled = start + minute;
  const result = await invoke({
    kind: "once",
    at: new Date(scheduled).toISOString(),
  });
  assert.deepEqual(writes, [
    {
      dispatched: scheduled,
      intent: {
        actionId: "session.tx",
        target,
        expectedRevision: "12",
        params: {
          bytesBase64: bytes,
          writeWaitMs: "1000",
          dispatchWindow: {
            earliestUnixMs: String(scheduled),
            latestUnixMs: String(scheduled + 2_000),
          },
        },
      },
    },
  ]);
  assert.deepEqual(result, {
    outcome: "completed",
    runs: [
      {
        scheduledMs: scheduled,
        observedMs: scheduled,
        operationId: "tx-1",
        outcome: "written",
      },
    ],
    skipped: [],
  });
});

test("does not backfill missed writes and ends a recurrent task after an unconfirmed child", async () => {
  const { invoke, writes } = fixture({
    firstWaitMs: 2 * minute + 5_000,
    confirm: false,
  });
  const result = await invoke(cron, { endAt: end, count: 2 });
  assert.deepEqual(
    writes.map(({ dispatched }) => dispatched),
    [start + 3 * minute],
  );
  assert.equal(result.outcome, "transmit_unconfirmed");
  assert.deepEqual(result.skipped, [
    { firstMs: start + minute, throughMs: start + 2 * minute + 5_000 },
  ]);
  assert.equal(result.runs[0].operationId, "tx-1");
});

test("a stopped calendar task makes no child call", async () => {
  const { invoke, writes } = fixture({ abortDuringWait: true });
  await assert.rejects(invoke(cron, { endAt: end, count: 2 }), {
    name: "AbortError",
  });
  assert.deepEqual(writes, []);
});

test("admitting a past one-time write reports expiry without replay", async () => {
  const { invoke, writes } = fixture();
  const scheduled = start - minute;
  const result = await invoke({
    kind: "once",
    at: new Date(scheduled).toISOString(),
  });
  assert.deepEqual(result, {
    outcome: "missed",
    runs: [],
    skipped: [{ firstMs: scheduled, throughMs: scheduled }],
  });
  assert.deepEqual(writes, []);
});

test("recurring writes settle in order, each with its own operation", async () => {
  const { invoke, writes } = fixture();
  const result = await invoke(cron, { endAt: end, count: 2 });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(
    result.runs.map(({ operationId, scheduledMs }) => [
      operationId,
      scheduledMs,
    ]),
    [
      ["tx-1", start + minute],
      ["tx-2", start + 2 * minute],
    ],
  );
  assert.deepEqual(
    writes.map(({ dispatched }) => dispatched),
    [start + minute, start + 2 * minute],
  );
});

test("the reference manifest declares the calendar handler and requires an end for cron", () => {
  assert.ok(validateNodePackageManifest(manifest));
  const action = manifest.contributes.actions.find(
    ({ actionId }) => actionId === calendarTaskAction,
  );
  assert.ok(action);
  const check = new Ajv({ strict: false }).compile(action.inputSchema);
  const base = { bytesBase64: bytes, sessionRevision: "12" };
  assert.ok(check({ ...base, schedule: cron, count: 2, endAt: end }));
  assert.equal(check({ ...base, schedule: cron }), false);
  assert.ok(check({ ...base, schedule: { kind: "once", at: end } }));
  assert.equal(
    check({ ...base, schedule: { kind: "once", at: end }, count: 2 }),
    false,
  );
});

test("two calendar waits leave shared Host slots available and release their quota on stop", async () => {
  const first = fixture({ hold: true });
  const second = fixture({ hold: true });
  const third = fixture();

  const firstStopped = assert.rejects(first.invoke(cron, { endAt: end }), {
    name: "AbortError",
  });
  await first.waiting;
  const secondStopped = assert.rejects(second.invoke(cron, { endAt: end }), {
    name: "AbortError",
  });
  await second.waiting;

  assert.deepEqual(await third.invoke(cron, { endAt: end }), {
    outcome: "capacity_reached",
    runs: [],
    skipped: [],
  });

  first.cancel();
  second.cancel();
  await Promise.all([firstStopped, secondStopped]);
  assert.equal((await third.invoke(cron, { endAt: end })).outcome, "completed");
});

test("a pause between wake-up and dispatch still skips the stale write", async () => {
  const { invoke, writes } = fixture({ pauseBeforeDispatch: true });
  const scheduled = start + minute;
  const result = await invoke({
    kind: "once",
    at: new Date(scheduled).toISOString(),
  });
  assert.equal(result.outcome, "missed");
  assert.deepEqual(writes, []);
});

test("a confirmed Host window rejection skips the stale slot and reports the next write", async () => {
  const { invoke, writes } = fixture({ rejectFirstWindow: true });
  const result = await invoke(cron, { endAt: end, count: 2 });
  assert.equal(result.outcome, "completed_with_misses");
  assert.deepEqual(
    result.runs.map(({ outcome, operationId }) => [outcome, operationId]),
    [
      ["missed", "tx-1"],
      ["written", "tx-2"],
    ],
  );
  assert.deepEqual(
    writes.map(({ intent }) => intent.params.dispatchWindow),
    [
      {
        earliestUnixMs: String(start + minute),
        latestUnixMs: String(start + minute + 2_000),
      },
      {
        earliestUnixMs: String(start + 2 * minute),
        latestUnixMs: String(start + 2 * minute + 2_000),
      },
    ],
  );
});

test("a pre-epoch date reports signed Unix milliseconds allowed by the manifest", async () => {
  const { invoke } = fixture();
  const action = manifest.contributes.actions.find(
    ({ actionId }) => actionId === calendarTaskAction,
  );
  const ajv = new Ajv({ strict: false });
  const params = {
    schedule: { kind: "once", at: "1969-12-31T23:59:59Z" },
    bytesBase64: bytes,
    sessionRevision: "12",
  };
  assert.ok(ajv.compile(action.inputSchema)(params));
  const result = await invoke(params.schedule);
  assert.ok(ajv.compile(action.outputSchema)(result));
  assert.deepEqual(result.skipped, [{ firstMs: -1_000, throughMs: -1_000 }]);
});
