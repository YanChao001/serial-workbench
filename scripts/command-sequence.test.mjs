import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { validateNodePackageManifest } from "../packages/contracts/src/generated/validators.mjs";
import { register } from "../packages/plugin-sdk/examples/reference-automation/main.ts";
import manifest from "../packages/plugin-sdk/examples/reference-automation/manifest.json" with { type: "json" };
import {
  commandSequenceAction,
  createCommandSequence,
} from "../packages/plugin-sdk/examples/reference-automation/command-sequence.ts";

const target = {
  kind: "session",
  hostId: "host",
  id: "session",
  sessionId: "session",
  sessionEpoch: "1",
};

function operator({
  writeOutcome = "accepted",
  beforeWait = () => {},
  replies = [],
  retryReplies = {},
  omitRawWrite = false,
  beforeRetryLease = () => {},
  pageSize = Infinity,
  cursorExpiry,
  cancelInFlight = false,
} = {}) {
  const controller = new AbortController();
  const sent = [];
  const writeWaits = [];
  const events = [];
  let byteOffset = 0;
  let lease;
  let time = 0;
  function wait(milliseconds, signal) {
    assert.equal(lease, undefined, "A delay cannot keep the port leased");
    beforeWait(controller, event);
    signal.throwIfAborted();
    time += milliseconds;
  }
  const run = createCommandSequence(wait);
  function event(kind, payload) {
    const eventSeq = events.length + 1;
    events.push({
      ...target,
      eventSeq: String(eventSeq),
      kind,
      time: { clockId: "clock", sourceMonoNs: String(eventSeq * 1000000) },
      payload,
    });
  }
  const task = {
    signal: controller.signal,
    streams: {
      async read({ startEventSeq }) {
        if (
          cursorExpiry === "before" ||
          (cursorExpiry === "after" && sent.length)
        )
          throw Object.assign(new Error("Raw retention expired"), {
            code: "CURSOR_EXPIRED",
          });
        const offset = Number(startEventSeq) - 1;
        const page = events.slice(offset, offset + pageSize);
        const next = offset + page.length;
        return {
          events: page,
          nextEventSeq: String(next + 1),
          hasMore: next < events.length,
        };
      },
    },
    actions: {
      async invokeChild(call) {
        assert.deepEqual(call.target, target);
        if (call.actionId === "lease.acquire") {
          assert.equal(lease, undefined);
          lease = "sequence-lease";
          if (sent.length === 1) beforeRetryLease(event);
          return {
            state: "running",
            result: {
              kind: "lease",
              value: { leaseId: lease, state: "active" },
            },
          };
        }
        if (call.actionId === "lease.release") {
          assert.ok(lease);
          assert.equal(call.params.leaseId, lease);
          lease = undefined;
          return {
            state: "succeeded",
            result: {
              kind: "lease",
              value: { leaseId: call.params.leaseId, state: "released" },
            },
          };
        }
        assert.equal(call.actionId, "session.tx");
        assert.ok(lease);
        assert.equal(call.leaseId, lease);
        const { bytesBase64, writeWaitMs } = call.params;
        writeWaits.push(writeWaitMs);
        const operationId = "write-" + (sent.length + 1);
        sent.push({
          hex: Buffer.from(bytesBase64, "base64").toString("hex"),
          time,
        });
        event("tx_intent", { operationId });
        if (cancelInFlight) {
          controller.abort();
          return { state: "running", operationId };
        }
        if (!omitRawWrite)
          event("tx", {
            operationId,
            bytesBase64,
            outcome: writeOutcome,
            acceptedRanges: [
              {
                start: "0",
                end: String(Buffer.from(bytesBase64, "base64").length),
              },
            ],
            unknownRanges: [],
          });
        const requestHex = sent.at(-1).hex.toUpperCase();
        const availableReplies = retryReplies[requestHex];
        if (bytesBase64 === "AQ==" || availableReplies) {
          const reply = (availableReplies ?? replies).shift();
          for (const block of Array.isArray(reply) ? reply : [reply]) {
            if (!block) continue;
            const bytes = Buffer.from(block.replaceAll(" ", ""), "hex");
            event("rx", {
              bytesBase64: bytes.toString("base64"),
              byteStart: String(byteOffset),
              byteEnd: String(byteOffset + bytes.length),
            });
            byteOffset += bytes.length;
          }
        }
        return {
          operationId,
          state: "succeeded",
          result: {
            kind: "tx",
            value: {
              ...target,
              outcome: writeOutcome,
              operationId,
              bytesBase64,
            },
          },
        };
      },
    },
    progress: { report() {} },
  };
  return {
    sent,
    writeWaits,
    run: (document) =>
      run(
        {
          target,
          params: { definition: JSON.stringify(document), startEventSeq: "1" },
        },
        task,
      ),
  };
}

const send = (hex) => ({ kind: "send", hex });

test("a command sequence expands variables, repeats the ordered steps and chooses the configured branch", async () => {
  const device = operator();
  const result = await device.run({
    version: 1,
    variables: { channel: "01" },
    steps: [
      {
        kind: "repeat",
        count: 2,
        steps: [send("AA ${channel}"), { kind: "delay", milliseconds: 30 }],
      },
      {
        kind: "if",
        variable: "channel",
        equals: "01",
        then: [send("A2")],
        else: [send("B2")],
      },
    ],
  });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(device.sent, [
    { hex: "aa01", time: 0 },
    { hex: "aa01", time: 30 },
    { hex: "a2", time: 60 },
  ]);
  assert.deepEqual(
    result.attempts.map(({ operationId }) => operationId),
    ["write-1", "write-2", "write-3"],
  );
});

test("a recorded write keeps its explicit deadline while existing definitions keep the default", async () => {
  const device = operator();
  const result = await device.run({
    version: 1,
    steps: [{ ...send("AA"), writeWaitMs: 3200 }, send("BB")],
  });
  assert.equal(result.outcome, "completed");
  assert.deepEqual(device.writeWaits, ["3200", "1000"]);
  await assert.rejects(
    operator().run({
      version: 1,
      steps: [{ ...send("AA"), writeWaitMs: 5001 }],
    }),
    /writeWaitMs/,
  );
});

test("a command sequence takes reply branches for the current write and stops after timeout fallback", async () => {
  const device = operator({ replies: ["4F 4B", undefined] });
  const probe = {
    ...send("01"),
    expect: {
      hex: "4F 4B",
      timeoutMs: 50,
      onMatch: [send("02")],
      onTimeout: [send("03")],
    },
  };
  const result = await device.run({
    version: 1,
    steps: [probe, probe, send("FF")],
  });
  assert.equal(result.outcome, "response_timeout");
  assert.equal(result.stoppedAt, "$.steps[1]");
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01", "02", "01", "03"],
  );
  assert.deepEqual(
    result.attempts.map(({ outcome }) => outcome),
    ["matched", "written", "response_timeout", "written"],
  );
  assert.equal(result.attempts[0].source.byteStart, "0");
  assert.equal(result.attempts[0].source.byteEnd, "2");
  assert.equal(result.attempts[2].path, "$.steps[1]");
});

test("invalid definitions including a bad inactive branch are rejected before any write", async () => {
  const device = operator();
  await assert.rejects(
    device.run({
      version: 1,
      variables: { mode: "write" },
      steps: [
        send("AA"),
        {
          kind: "if",
          variable: "mode",
          equals: "write",
          then: [send("BB")],
          else: [send("not hex")],
        },
      ],
    }),
    { path: "$.steps[1].else[0].hex" },
  );
  await assert.rejects(
    device.run({
      version: 1,
      steps: [
        {
          kind: "repeat",
          count: 32,
          steps: [send("AA"), send("BB"), send("CC")],
        },
      ],
    }),
    { path: "$.steps[0]" },
  );
  assert.deepEqual(device.sent, []);
});

test("a timeout without an explicit branch stops the whole sequence", async () => {
  const device = operator();
  const result = await device.run({
    version: 1,
    steps: [
      { ...send("01"), expect: { hex: "4F 4B", timeoutMs: 50 } },
      send("BB"),
    ],
  });
  assert.equal(result.outcome, "response_timeout");
  assert.equal(result.completedSteps, 0);
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01"],
  );
});

test("an unexpected reply cannot enter the timeout branch or the next step", async () => {
  const device = operator({ replies: ["4E 4F"] });
  const result = await device.run({
    version: 1,
    steps: [
      {
        ...send("01"),
        expect: { hex: "4F 4B", timeoutMs: 50, onTimeout: [send("03")] },
      },
      send("BB"),
    ],
  });
  assert.equal(result.outcome, "unexpected_response");
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01"],
  );
});

test("a partial write and a cancelled delay both prevent later writes", async () => {
  const partial = operator({ writeOutcome: "partial" });
  const result = await partial.run({
    version: 1,
    steps: [send("AA"), send("BB")],
  });
  assert.equal(result.outcome, "transmit_unconfirmed");
  assert.deepEqual(
    partial.sent.map(({ hex }) => hex),
    ["aa"],
  );

  const cancelled = operator({
    beforeWait: (controller) => controller.abort(),
  });
  await assert.rejects(
    cancelled.run({
      version: 1,
      steps: [send("AA"), { kind: "delay", milliseconds: 10 }, send("BB")],
    }),
    { name: "AbortError" },
  );
  assert.deepEqual(
    cancelled.sent.map(({ hex }) => hex),
    ["aa"],
  );
});

test("the reference plugin registers the declared sequence and produces a schema-valid report", async () => {
  assert.ok(validateNodePackageManifest(manifest));
  const spec = manifest.contributes.actions.find(
    ({ actionId }) => actionId === commandSequenceAction,
  );
  assert.ok(spec);
  const implementations = new Map();
  register({
    actions: {
      register(actionId, handler) {
        implementations.set(actionId, handler);
      },
    },
  });
  assert.equal(typeof implementations.get(commandSequenceAction), "function");
  const ajv = new Ajv();
  const definition = { version: 1, steps: [send("AA")] };
  assert.ok(
    ajv.compile(spec.inputSchema)({
      definition: JSON.stringify(definition),
      startEventSeq: "1",
    }),
  );
  const output = ajv.compile(spec.outputSchema);
  assert.ok(
    output(await operator().run(definition)),
    JSON.stringify(output.errors),
  );
});

test("a flow gap or configuration change stops the next write after a delay", async () => {
  for (const kind of ["gap", "configuration_boundary"]) {
    const device = operator({
      beforeWait: (_controller, push) => push(kind, {}),
    });
    const result = await device.run({
      version: 1,
      steps: [send("AA"), { kind: "delay", milliseconds: 20 }, send("BB")],
    });
    assert.equal(result.outcome, "source_changed");
    assert.equal(result.stoppedAt, "$.steps[2]");
    assert.deepEqual(
      device.sent.map(({ hex }) => hex),
      ["aa"],
    );
  }
});

test("a timed-out exchange cannot set up another expectation that a late reply could satisfy", async () => {
  const device = operator();
  await assert.rejects(
    device.run({
      version: 1,
      steps: [
        {
          ...send("01"),
          expect: {
            hex: "4F 4B",
            timeoutMs: 50,
            onTimeout: [{ ...send("02"), expect: { hex: "4F 4B" } }],
          },
        },
      ],
    }),
    { path: "$.steps[0].expect.onTimeout[0].expect" },
  );
  assert.deepEqual(device.sent, []);
});

test("the sequence matches a split reply across pages and preserves its full source interval", async () => {
  const device = operator({ replies: [["4F", "4B"]], pageSize: 1 });
  const result = await device.run({
    version: 1,
    steps: [{ ...send("01"), expect: { hex: "4F 4B", timeoutMs: 100 } }],
  });
  const { source } = result.attempts[0];
  assert.equal(result.outcome, "completed");
  assert.equal(source.eventStart, "3");
  assert.equal(source.eventEnd, "5");
  assert.equal(source.byteStart, "0");
  assert.equal(source.byteEnd, "2");
});

test("retention expiry stops execution and preserves the ID of any admitted write", async () => {
  const definition = {
    version: 1,
    steps: [{ ...send("01"), expect: { hex: "4F 4B" } }, send("02")],
  };
  const expired = operator({ cursorExpiry: "before" });
  const before = await expired.run(definition);
  assert.equal(before.outcome, "source_changed");
  assert.equal(before.stoppedAt, "$.steps[0]");
  assert.deepEqual(before.attempts, []);
  assert.deepEqual(expired.sent, []);

  const device = operator({ cursorExpiry: "after" });
  const after = await device.run(definition);
  assert.equal(after.outcome, "source_changed");
  assert.equal(after.attempts[0].operationId, "write-1");
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01"],
  );
});

test("cancelling an in-flight write prevents admission of the next command", async () => {
  const device = operator({ cancelInFlight: true });
  await assert.rejects(
    device.run({ version: 1, steps: [send("AA"), send("BB")] }),
    { name: "AbortError" },
  );
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["aa"],
  );
});

test("a configured retry keeps the timed-out attempt and reports the distinct reply to the next write", async () => {
  const device = operator({ retryReplies: { "02": ["D2"] }, pageSize: 1 });
  const result = await device.run({
    version: 1,
    steps: [
      {
        ...send("01"),
        expect: {
          hex: "D1",
          timeoutMs: 50,
          retry: [{ hex: "02", expectHex: "D2" }],
        },
      },
    ],
  });
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01", "02"],
  );
  assert.equal(result.outcome, "completed");
  assert.equal(result.completedSteps, 1);
  assert.deepEqual(
    result.attempts.map(({ path, operationId, outcome }) => ({
      path,
      operationId,
      outcome,
    })),
    [
      {
        path: "$.steps[0]",
        operationId: "write-1",
        outcome: "response_timeout",
      },
      {
        path: "$.steps[0].expect.retry[0]",
        operationId: "write-2",
        outcome: "matched",
      },
    ],
  );
  assert.equal(result.attempts[1].source.byteStart, "0");
  assert.equal(result.attempts[1].source.byteEnd, "1");
});

test("a late earlier reply prevents a match or another retry", async () => {
  const device = operator({ retryReplies: { "02": ["D1"] } });
  const result = await device.run({
    version: 1,
    steps: [
      {
        ...send("01"),
        expect: {
          hex: "D1",
          timeoutMs: 50,
          retry: [
            { hex: "02", expectHex: "D2" },
            { hex: "03", expectHex: "D3" },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01", "02"],
  );
  assert.equal(result.outcome, "unexpected_response");
  assert.equal(result.stoppedAt, "$.steps[0].expect.retry[0]");
});

test("a retry requires confirmed terminal and Raw write evidence", async () => {
  for (const settings of [
    { writeOutcome: "partial" },
    { omitRawWrite: true },
  ]) {
    const device = operator(settings);
    const result = await device.run({
      version: 1,
      steps: [
        {
          ...send("01"),
          expect: {
            hex: "D1",
            timeoutMs: 50,
            retry: [{ hex: "02", expectHex: "D2" }],
          },
        },
      ],
    });
    assert.deepEqual(
      device.sent.map(({ hex }) => hex),
      ["01"],
    );
    assert.equal(
      result.outcome,
      settings.omitRawWrite ? "source_changed" : "transmit_unconfirmed",
    );
    assert.equal(result.attempts.length, 1);
  }
});

test("intervening writes prevent the configured retry from starting", async () => {
  const device = operator({
    beforeRetryLease: (event) =>
      event("tx_intent", { operationId: "different-writer" }),
  });
  const result = await device.run({
    version: 1,
    steps: [
      {
        ...send("01"),
        expect: {
          hex: "D1",
          timeoutMs: 50,
          retry: [{ hex: "02", expectHex: "D2" }],
        },
      },
    ],
  });
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01"],
  );
  assert.equal(result.outcome, "source_changed");
  assert.equal(result.stoppedAt, "$.steps[0].expect.retry[0]");
});

test("all retries share the bounds and use the timeout branch only after the final attempt", async () => {
  const device = operator();
  const step = {
    ...send("01"),
    expect: {
      hex: "D1",
      timeoutMs: 50,
      retry: [{ hex: "02", expectHex: "D2" }],
      onTimeout: [send("FF"), send("FE")],
    },
  };
  const result = await device.run({ version: 1, steps: [step, send("AA")] });
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01", "02", "ff", "fe"],
  );
  assert.deepEqual(
    result.attempts.map(({ outcome }) => outcome),
    ["response_timeout", "response_timeout", "written", "written"],
  );
  assert.equal(result.outcome, "response_timeout");
  assert.equal(result.stoppedAt, "$.steps[0].expect.retry[0]");
  const tooMany = operator();
  await assert.rejects(
    tooMany.run({
      version: 1,
      steps: [{ kind: "repeat", count: 33, steps: [step] }],
    }),
    /too many steps/,
  );
  assert.deepEqual(tooMany.sent, []);
});

test("overlapping replies and duplicate request frames are rejected before submission", async () => {
  for (const retry of [
    { hex: "02", expectHex: "AA D1 FF" },
    { hex: "01", expectHex: "D2" },
  ]) {
    const device = operator();
    await assert.rejects(
      device.run({
        version: 1,
        steps: [{ ...send("01"), expect: { hex: "D1", retry: [retry] } }],
      }),
      /retry\[0\]\.(expectHex|hex)/,
    );
    assert.deepEqual(device.sent, []);
  }
});

test("a partial expected reply prevents a retry", async () => {
  const device = operator({
    replies: ["11"],
    retryReplies: { "02": ["33 44"] },
  });
  const result = await device.run({
    version: 1,
    steps: [
      {
        ...send("01"),
        expect: {
          hex: "11 22",
          timeoutMs: 50,
          retry: [{ hex: "02", expectHex: "33 44" }],
        },
      },
    ],
  });
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01"],
  );
  assert.equal(result.outcome, "response_ambiguous");
  assert.equal(result.attempts[0].outcome, "response_ambiguous");
});

test("a successful retry cannot make an earlier timed-out reply valid for another step", async () => {
  const device = operator({ retryReplies: { "02": ["D2"], "03": ["D1"] } });
  const result = await device.run({
    version: 1,
    steps: [
      {
        ...send("01"),
        expect: {
          hex: "D1",
          timeoutMs: 50,
          retry: [{ hex: "02", expectHex: "D2" }],
          onMatch: [
            { ...send("03"), expect: { hex: "D1", onMatch: [send("04")] } },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01", "02"],
  );
  assert.equal(result.outcome, "response_ambiguous");
  assert.equal(result.stoppedAt, "$.steps[0].expect.onMatch[0]");
  assert.deepEqual(
    result.attempts.map(({ outcome }) => outcome),
    ["response_timeout", "matched"],
  );
});

test("bytes arriving between a timed-out write and its retry stop correlation", async () => {
  const device = operator({
    beforeRetryLease: (event) =>
      event("rx", {
        bytesBase64: "0Q==",
        byteStart: "0",
        byteEnd: "1",
      }),
  });
  const result = await device.run({
    version: 1,
    steps: [
      {
        ...send("01"),
        expect: {
          hex: "D1",
          timeoutMs: 50,
          retry: [{ hex: "02", expectHex: "D2" }],
        },
      },
    ],
  });
  assert.deepEqual(
    device.sent.map(({ hex }) => hex),
    ["01"],
  );
  assert.equal(result.outcome, "source_changed");
  assert.equal(result.stoppedAt, "$.steps[0].expect.retry[0]");
});
