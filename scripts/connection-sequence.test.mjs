import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionSequence } from "../packages/plugin-sdk/examples/reference-automation/connection-sequence.ts";
import { compileConnectionSequence } from "../packages/plugin-sdk/examples/reference-automation/connection-sequence-model.ts";

const definition = {
  version: 1,
  beforeOpenMs: 100,
  steps: [
    { kind: "line", line: "dtr", value: false },
    { kind: "delay", milliseconds: 250 },
    { kind: "line", line: "dtr", value: true },
    { kind: "send", bytesBase64: "pQ==" },
    { kind: "ready", bytesBase64: "T0s=", timeoutMs: 500 },
  ],
};

test("a versioned connection sequence freezes its ordered, valid definition", () => {
  const draft = structuredClone(definition);
  const compiled = compileConnectionSequence(draft, "none");
  assert.deepEqual(compiled, definition);
  draft.beforeOpenMs = 0;
  draft.steps[0].line = "rts";
  assert.deepEqual(compiled, definition);
});

test("connection sequence rejects conflicts, malformed frames and excessive waiting", () => {
  assert.throws(
    () => compileConnectionSequence(definition, "dsrDtr"),
    /steps\[0\]/,
  );
  assert.throws(
    () =>
      compileConnectionSequence({ ...definition, beforeOpenMs: -1 }, "none"),
    /beforeOpenMs/,
  );
  for (const bytesBase64 of ["", "pQ", "pR==", "AA==\n", "A".repeat(348)]) {
    assert.throws(
      () =>
        compileConnectionSequence(
          {
            ...definition,
            steps: [{ kind: "send", bytesBase64 }],
          },
          "none",
        ),
      /steps\[0\]\.bytesBase64/,
    );
  }
  assert.throws(
    () =>
      compileConnectionSequence(
        {
          ...definition,
          steps: [
            { kind: "delay", milliseconds: 15_000 },
            { kind: "ready", bytesBase64: "AA==", timeoutMs: 15_000 },
          ],
        },
        "none",
      ),
    /steps/,
  );
  assert.throws(
    () =>
      compileConnectionSequence(
        { ...definition, steps: [{ kind: "open" }] },
        "none",
      ),
    /steps\[0\]/,
  );
});

const device = { hostId: "host", kind: "device", id: "port" };
const session = {
  hostId: "host",
  kind: "session",
  id: "session",
  sessionId: "session",
  sessionEpoch: "4",
};

function taskFixture({
  reused = false,
  receive = true,
  disconnect = false,
  signal,
} = {}) {
  let time = 0;
  const calls = [];
  const receipts = new Map();
  const events = [];
  let received = 0;
  const append = (text) => {
    const bytes = Buffer.from(text);
    const event = {
      ...session,
      kind: "rx",
      eventSeq: String(events.length + 1),
      payload: {
        byteStart: String(received),
        byteEnd: String(received + bytes.length),
        bytesBase64: bytes.toString("base64"),
      },
    };
    received += bytes.length;
    events.push(event);
  };
  const task = {
    signal: signal ?? new AbortController().signal,
    actions: {
      async invokeChild(call) {
        const operationId = String(calls.length + 1);
        calls.push({ ...call, at: time });
        const receipt = (kind, value, state = "succeeded") => {
          const child = {
            operationId,
            actionId: call.actionId,
            target: call.target,
            state,
            result: { kind, value },
          };
          receipts.set(operationId, child);
          return child;
        };
        switch (call.actionId) {
          case "device.open":
            return receipt("opened", {
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch,
              revision: "1",
              reused,
            });
          case "lease.acquire":
            return receipt(
              "lease",
              { leaseId: "lease", state: "active" },
              "running",
            );
          case "lease.release":
            return receipt("lease", { leaseId: "lease", state: "released" });
          case "session.control":
            return receipt("control", {
              line: call.params.line,
              requested: call.params.value,
              actual: call.params.value,
              status: "confirmed",
            });
          case "session.tx":
            if (receive && call.params.bytesBase64 === "pQ==") {
              append("xO");
              append("K!");
            }
            if (disconnect) {
              events.push({
                ...session,
                kind: "lifecycle",
                eventSeq: String(events.length + 1),
                payload: { state: "disconnected" },
              });
            }
            return receipt("tx", {
              operationId,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch,
              bytesBase64: call.params.bytesBase64,
              outcome: "accepted",
            });
          default:
            throw new Error(`Unexpected action ${call.actionId}`);
        }
      },
    },
    operations: {
      async get({ operationId }) {
        return receipts.get(operationId);
      },
    },
    streams: {
      async read({ startEventSeq, sessionId, sessionEpoch }) {
        assert.equal(sessionId, session.sessionId);
        assert.equal(sessionEpoch, session.sessionEpoch);
        return {
          events: events.filter(
            (event) => BigInt(event.eventSeq) >= BigInt(startEventSeq),
          ),
          nextEventSeq: String(events.length + 1),
          hasMore: false,
        };
      },
    },
    progress: { report() {} },
  };
  return {
    task,
    calls,
    clock: {
      now: () => time,
      async wait(milliseconds, signal) {
        signal.throwIfAborted();
        time += milliseconds;
      },
    },
  };
}

function connectionCall(sequence) {
  return {
    target: device,
    params: { configuration: { flowControl: "none" }, definition: sequence },
  };
}

test("opens after the pre-open wait and holds one lease through reset, wake and ready", async () => {
  const f = taskFixture();
  const run = createConnectionSequence(f.clock);
  const result = await run(connectionCall(definition), f.task);
  assert.equal(result.outcome, "completed");
  assert.deepEqual(result.session, session);
  assert.deepEqual(
    f.calls.map(({ actionId, at }) => [actionId, at]),
    [
      ["device.open", 100],
      ["lease.acquire", 100],
      ["session.control", 100],
      ["session.control", 350],
      ["session.tx", 350],
      ["lease.release", 350],
    ],
  );
  for (const call of f.calls.filter(({ actionId }) =>
    actionId.startsWith("session."),
  )) {
    assert.equal(call.leaseId, "lease");
    assert.deepEqual(call.target, session);
  }
  assert.deepEqual(result.steps.at(-1).source, {
    hostId: "host",
    sessionId: "session",
    sessionEpoch: "4",
    direction: "rx",
    eventStart: "1",
    eventEnd: "3",
    byteStart: "1",
    byteEnd: "3",
  });
});

test("a reused port and a timed out ready wait admit no later step", async () => {
  const reused = taskFixture({ reused: true });
  const first = await createConnectionSequence(reused.clock)(
    connectionCall(definition),
    reused.task,
  );
  assert.equal(first.outcome, "port_in_use");
  assert.deepEqual(
    reused.calls.map(({ actionId }) => actionId),
    ["device.open"],
  );

  const timeout = taskFixture({ receive: false });
  const result = await createConnectionSequence(timeout.clock)(
    connectionCall({
      ...definition,
      steps: [...definition.steps, { kind: "send", bytesBase64: "Aw==" }],
    }),
    timeout.task,
  );
  assert.equal(result.outcome, "ready_timeout");
  assert.equal(result.steps.at(-1).state, "skipped");
  assert.deepEqual(
    timeout.calls
      .filter(({ actionId }) => actionId === "session.tx")
      .map(({ params }) => params.bytesBase64),
    ["pQ=="],
  );
});

test("a disconnect stops the remaining control and TX steps", async () => {
  const f = taskFixture({ receive: false, disconnect: true });
  const report = await createConnectionSequence(f.clock)(
    connectionCall({
      ...definition,
      steps: [
        { kind: "send", bytesBase64: "pQ==" },
        { kind: "ready", bytesBase64: "T0s=", timeoutMs: 500 },
        { kind: "line", line: "rts", value: true },
        { kind: "send", bytesBase64: "Aw==" },
      ],
    }),
    f.task,
  );
  assert.equal(report.outcome, "session_changed");
  assert.deepEqual(
    report.steps.slice(-3).map((step) => step.state),
    ["skipped", "skipped", "skipped"],
  );
  assert.deepEqual(
    f.calls
      .filter(({ actionId }) => actionId.startsWith("session."))
      .map(({ actionId }) => actionId),
    ["session.tx"],
  );
});

test("cancellation before opening produces no child operation", async () => {
  const abort = new AbortController();
  const fixture = taskFixture({ signal: abort.signal });
  const run = createConnectionSequence({
    ...fixture.clock,
    async wait(_milliseconds, signal) {
      abort.abort();
      signal.throwIfAborted();
    },
  });
  await assert.rejects(run(connectionCall(definition), fixture.task), {
    name: "AbortError",
  });
  assert.deepEqual(fixture.calls, []);
});
