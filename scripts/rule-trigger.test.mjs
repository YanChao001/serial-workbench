import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import manifest from "../packages/plugin-sdk/examples/reference-automation/manifest.json" with { type: "json" };
import { register } from "../packages/plugin-sdk/examples/reference-automation/main.ts";
import {
  createRuleTrigger,
  ruleTriggerAction,
} from "../packages/plugin-sdk/examples/reference-automation/rule-trigger.ts";

const target = {
  kind: "session",
  id: "local-device",
  hostId: "test-host",
  sessionId: "local-device",
  sessionEpoch: "2",
};
const rx = {
  kind: "rx",
  hostId: target.hostId,
  sessionId: target.sessionId,
  sessionEpoch: target.sessionEpoch,
  eventSeq: "20",
  time: {
    clockId: "clock",
    sourceMonoNs: "1000",
    precision: { source: "host_read", resolutionNs: "100" },
  },
  payload: { byteStart: "21", byteEnd: "27", bytesBase64: "QUxBUk0K" },
};

function fixture({
  old = false,
  gapOnEffect = false,
  cancelBeforeWrite = false,
  closedAfterMatch = false,
  beforeArm,
  action,
} = {}) {
  const requests = [];
  const readCursors = [];
  const progress = [];
  const closed = {
    ...rx,
    kind: "lifecycle",
    eventSeq: "21",
    payload: { state: "closed" },
  };
  const controller = new AbortController();
  let time = 0;
  const handler = createRuleTrigger(
    async (ms, signal) => {
      time += ms;
      signal.throwIfAborted();
    },
    () => time,
  );
  const task = {
    signal: controller.signal,
    progress: { report: (report) => progress.push(report) },
    streams: {
      async read({ startEventSeq }) {
        readCursors.push(startEventSeq);
        if (readCursors.length === 1) await beforeArm?.();
        if (
          (old && readCursors.length === 1) ||
          (!old && readCursors.length === 2)
        )
          return closedAfterMatch
            ? { events: [rx, closed], hasMore: false, nextEventSeq: "22" }
            : { events: [rx], hasMore: false, nextEventSeq: "21" };
        if (closedAfterMatch && startEventSeq === "21")
          return { events: [closed], hasMore: false, nextEventSeq: "22" };
        if (
          requests.some((request) => request.actionId === "lease.acquire") &&
          cancelBeforeWrite
        )
          controller.abort();
        if (gapOnEffect && startEventSeq === "21")
          return {
            events: [{ ...rx, kind: "configuration_boundary", eventSeq: "21" }],
            hasMore: false,
            nextEventSeq: "22",
          };
        return { events: [], hasMore: false, nextEventSeq: startEventSeq };
      },
    },
    actions: {
      async invokeChild(intent) {
        requests.push(intent);
        if (intent.actionId === "lease.acquire")
          return {
            state: "running",
            result: {
              kind: "lease",
              value: { state: "active", leaseId: "lease-1" },
            },
          };
        if (intent.actionId === "lease.release")
          return {
            state: "succeeded",
            result: {
              kind: "lease",
              value: { state: "released", leaseId: "lease-1" },
            },
          };
        if (intent.actionId === "session.tx")
          return {
            state: "succeeded",
            operationId: "write-1",
            result: {
              kind: "tx",
              value: {
                outcome: "accepted",
                operationId: "write-1",
                sessionId: target.sessionId,
                sessionEpoch: target.sessionEpoch,
                bytesBase64: intent.params.bytesBase64,
              },
            },
          };
        return { state: "succeeded", operationId: "authorized-action-1" };
      },
    },
  };
  function run(effect, options = {}) {
    return (action ?? handler)(
      {
        target,
        params: {
          startEventSeq: "20",
          definition: JSON.stringify({
            version: 1,
            startAtBoundary: true,
            observationMs: 60,
            condition: { kind: "regex", pattern: "^ALARM$" },
            effect,
            ...options,
          }),
        },
      },
      task,
    );
  }
  return { requests, readCursors, progress, run };
}

test("arms at a fresh cursor and performs at most one fully acknowledged serial write", async () => {
  const { requests, readCursors, run } = fixture();
  const result = await run({ kind: "send", bytesBase64: "UkVTRVQK" });
  assert.equal(result.outcome, "written");
  assert.equal(result.operationId, "write-1");
  assert.equal(result.source.byteStart, "21");
  assert.equal(result.source.byteEnd, "27");
  assert.deepEqual(readCursors, ["20", "20", "21"]);
  assert.deepEqual(
    requests.map(({ actionId }) => actionId),
    ["lease.acquire", "session.tx", "lease.release"],
  );
  assert.equal(requests[1].leaseId, "lease-1");
  assert.deepEqual(requests[1].target, target);
});

test("historical RX at arm time and a changed configuration cannot trigger serial output", async () => {
  const historical = fixture({ old: true });
  assert.deepEqual(
    await historical.run(
      { kind: "send", bytesBase64: "UkVTRVQK" },
      { startAtBoundary: false },
    ),
    { outcome: "timed_out" },
  );
  assert.deepEqual(historical.requests, []);
  const changed = fixture({ gapOnEffect: true });
  assert.deepEqual(
    await changed.run({ kind: "send", bytesBase64: "UkVTRVQK" }),
    {
      outcome: "source_changed",
    },
  );
  assert.deepEqual(
    changed.requests.map(({ actionId }) => actionId),
    ["lease.acquire", "lease.release"],
  );
});

test("cancellation after capturing the match prevents admission of a write", async () => {
  const { requests, run } = fixture({ cancelBeforeWrite: true });
  await assert.rejects(run({ kind: "send", bytesBase64: "UkVTRVQK" }), {
    name: "AbortError",
  });
  assert.deepEqual(
    requests.map(({ actionId }) => actionId),
    ["lease.acquire"],
  );
});

test("effect action receives the same target and trigger can return a traceable notification", async () => {
  const action = fixture();
  const params = { mode: "append", row: ["temperature", 72] };
  assert.equal(
    (
      await action.run({
        kind: "action",
        actionId: "example.storage.record",
        params,
      })
    ).outcome,
    "action_completed",
  );
  assert.deepEqual(action.requests, [
    { actionId: "example.storage.record", target, params },
  ]);
  const notify = fixture();
  const result = await notify.run({
    kind: "notify",
    message: "High temperature",
  });
  assert.equal(result.outcome, "notification");
  assert.equal(result.message, "High temperature");
  assert.equal(result.source.eventStart, "20");
  assert.deepEqual(notify.requests, []);
});

test("rejected effects cannot use a self trigger or bypass the rule's transaction direction", async () => {
  const { run, requests, readCursors } = fixture();
  for (const actionId of [
    "swb.reference.automation.rule",
    "swb.builtin.automation.rule",
    "session.tx",
    "lease.release",
  ])
    await assert.rejects(
      run({ kind: "action", actionId, params: {} }),
      /invalid rule effect/i,
    );
  assert.deepEqual(requests, []);
  assert.deepEqual(readCursors, []);
});

test("the reference package registers the rule action and preserves the declared source contract", async () => {
  assert.equal(validateNodePackageManifest(manifest), true);
  const actions = new Map();
  const context = { actions: { register: (id, fn) => actions.set(id, fn) } };
  const dispose = register(context);
  try {
    const contributed = manifest.contributes.actions.find(
      ({ actionId }) => actionId === ruleTriggerAction,
    );
    assert.ok(contributed);
    const action = actions.get(ruleTriggerAction);
    assert.equal(typeof action, "function");
    const { run } = fixture({ action });
    const report = await run({ kind: "notify", message: "Alarm" });
    const output = new Ajv({ strict: false }).compile(contributed.outputSchema);
    assert.equal(output(report), true, JSON.stringify(output.errors));
    assert.equal(output({ outcome: "written" }), false);
    assert.equal(report.source.eventEnd, "21");
    assert.deepEqual(Object.keys(report.source).sort(), [
      "byteEnd",
      "byteStart",
      "direction",
      "eventEnd",
      "eventStart",
      "hostId",
      "sessionEpoch",
      "sessionId",
    ]);
  } finally {
    dispose();
  }
});

test("a closed lifecycle after a match prevents notification and authorized dispatch", async () => {
  for (const effect of [
    { kind: "notify", message: "Alarm" },
    { kind: "action", actionId: "example.storage.record", params: {} },
  ]) {
    const { requests, run } = fixture({ closedAfterMatch: true });
    assert.deepEqual(await run(effect), { outcome: "source_changed" });
    assert.deepEqual(requests, []);
  }
});

test("equivalent rules in independent requests can only arm once per exact session", async () => {
  const entering = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const first = fixture({
    beforeArm: () => {
      entering.resolve();
      return proceed.promise;
    },
  });
  const effect = { kind: "notify", message: "Alarm" };
  const pending = first.run(effect);
  try {
    await entering.promise;
    const duplicate = fixture();
    const equivalent = { pattern: "^ALARM$", ignoreCase: false, kind: "regex" };
    assert.deepEqual(await duplicate.run(effect, { condition: equivalent }), {
      outcome: "already_armed",
    });
    assert.deepEqual(duplicate.readCursors, []);
    assert.deepEqual(duplicate.progress, []);
    assert.deepEqual(duplicate.requests, []);
  } finally {
    proceed.resolve();
  }
  assert.equal((await pending).outcome, "notification");
  assert.deepEqual(
    first.progress.map(({ completed }) => completed),
    ["0", "1"],
  );
  assert.equal((await fixture().run(effect)).outcome, "notification");
});
