import assert from "node:assert/strict";
import test from "node:test";
import { register } from "../packages/plugin-sdk/examples/reference-automation/main.ts";
import { modbusTransactionAction } from "../packages/plugin-sdk/examples/reference-automation/modbus-transaction.ts";
import { encodeModbusFrame } from "../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame.ts";

const session = {
  kind: "session",
  hostId: "host",
  id: "session",
  sessionId: "session",
  sessionEpoch: "2",
};
const precision = {
  source: "host_read",
  resolutionNs: "1000000",
  syncMethod: "fixture",
};
const time = (ms, clockId = "source-clock") => ({
  clockId,
  sourceMonoNs: String(ms * 1_000_000),
  precision,
});
const event = (kind, seq, ms, payload, clockId) => ({
  ...session,
  kind,
  eventSeq: String(seq),
  time: time(ms, clockId),
  payload,
});
const intent = event("tx_intent", 8, 1, { operationId: "tx" });
const written = event("tx", 9, 10, {
  operationId: "tx",
  acceptedRanges: [{}],
  unknownRanges: [],
});
function nextTx(attempt, seq, ms) {
  const operationId = `tx-${attempt}`;
  return [
    event("tx_intent", seq, ms, { operationId }),
    event("tx", seq + 1, ms + 9, { ...written.payload, operationId }),
  ];
}
const rx = (seq, start, ms, bytes, clockId) =>
  event(
    "rx",
    seq,
    ms,
    {
      bytesBase64: Buffer.from(bytes).toString("base64"),
      byteStart: String(start),
      byteEnd: String(start + bytes.length),
    },
    clockId,
  );

function wire(transport, direction, pdu, unitId = 1, transactionId = 7) {
  const envelope = transport === "tcp" ? { unitId, transactionId } : { unitId };
  return encodeModbusFrame(transport, direction, { ...envelope, pdu });
}
const readPdu = { functionCode: 3, address: 0, quantity: 1 };
const responsePdu = { functionCode: 3, values: [0x1234] };

async function run(t, transport, request, pages, options = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "performance");
  let now = 0;
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: { now: () => now },
  });
  t.after(() => Object.defineProperty(globalThis, "performance", previous));
  let handler;
  register({
    actions: {
      register(id, action) {
        if (id === modbusTransactionAction) handler = action;
      },
    },
  });
  assert.ok(handler);
  const requestBase64 = Buffer.from(request).toString("base64");
  const expectedTx = options.requests ?? [request];
  const controller = new AbortController();
  const calls = [];
  const cursors = [];
  let readCount = 0;
  let txCount = 0;
  t.after(() => {
    if (options.invalid) assert.deepEqual(calls, []);
    if (options.abortOnRead)
      assert.deepEqual(calls, ["lease.acquire", "session.tx"]);
  });
  const result = await handler(
    {
      target: session,
      params: {
        transport,
        requestBase64,
        startEventSeq: "8",
        responseTimeoutMs: 50,
        ...options.params,
      },
    },
    {
      signal: controller.signal,
      actions: {
        async invokeChild(call) {
          calls.push(call.actionId);
          assert.deepEqual(call.target, session);
          if (call.actionId === "lease.acquire") {
            assert.deepEqual(call.params, {
              kind: "transaction",
              ttlMs: options.params?.retryLimit ? "30000" : "15000",
            });
            return {
              state: "running",
              result: {
                kind: "lease",
                value: { state: "active", leaseId: "lease" },
              },
            };
          }
          if (call.actionId === "session.tx") {
            assert.ok(txCount < expectedTx.length, "too many writes");
            assert.equal(call.leaseId, "lease");
            const bytesBase64 = Buffer.from(expectedTx[txCount++]).toString(
              "base64",
            );
            assert.equal(call.params.bytesBase64, bytesBase64);
            const operationId = txCount === 1 ? "tx" : `tx-${txCount}`;
            return {
              operationId,
              state: "succeeded",
              result: {
                kind: "tx",
                value: {
                  outcome: "accepted",
                  operationId,
                  sessionId: session.id,
                  sessionEpoch: session.sessionEpoch,
                  bytesBase64: options.unconfirmed ? "AA==" : bytesBase64,
                },
              },
            };
          }
          assert.equal(call.actionId, "lease.release");
          assert.equal(call.params.leaseId, "lease");
          return {
            state: "succeeded",
            result: {
              kind: "lease",
              value: { state: "released", leaseId: "lease" },
            },
          };
        },
      },
      streams: {
        async read(params) {
          assert.equal(params.sessionId, session.id);
          assert.equal(params.sessionEpoch, session.sessionEpoch);
          cursors.push(params.startEventSeq);
          if (readCount + 1 === options.abortOnRead) controller.abort();
          if (++readCount === 1) {
            assert.deepEqual(calls, ["lease.acquire"]);
            return { events: [], nextEventSeq: "8", hasMore: false };
          }
          const page = pages[readCount - 2];
          if (page?.error)
            throw Object.assign(new Error(page.error), { code: page.error });
          if (!page)
            return {
              events: [],
              nextEventSeq: params.startEventSeq,
              hasMore: false,
            };
          now = page.now ?? now;
          return {
            events: page.events,
            nextEventSeq: page.next,
            hasMore: page.more ?? false,
          };
        },
      },
    },
  );
  assert.deepEqual(calls, [
    "lease.acquire",
    ...expectedTx.map(() => "session.tx"),
    "lease.release",
  ]);
  return { result, cursors };
}

for (const transport of ["rtu", "ascii", "tcp"]) {
  test(`${transport} pairs split frames, skips a coalesced foreign reply and preserves byte and clock evidence`, async (t) => {
    const request = wire(transport, "request", readPdu);
    const response = wire(transport, "response", responsePdu);
    const unrelated = wire(
      transport,
      "response",
      responsePdu,
      transport === "tcp" ? 1 : 2,
      23,
    );
    const bytes = Uint8Array.of(...unrelated, ...response.subarray(0, 3));
    const { result, cursors } = await run(t, transport, request, [
      {
        events: [intent, written, rx(10, 64, 15, bytes)],
        next: "11",
        more: true,
      },
      {
        events: [rx(11, 64 + bytes.length, 19, response.subarray(3))],
        next: "12",
      },
    ]);
    assert.deepEqual(cursors, ["8", "8", "11"]);
    assert.deepEqual(result, {
      operationId: "tx",
      outcome: "matched",
      ignoredFrames: 1,
      response: {
        bytesBase64: Buffer.from(response).toString("base64"),
        source: {
          hostId: session.hostId,
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          direction: "rx",
          eventStart: "10",
          eventEnd: "12",
          byteStart: String(64 + unrelated.length),
          byteEnd: String(64 + unrelated.length + response.length),
        },
        timing: {
          clockId: "source-clock",
          txMonoNs: "10000000",
          rxMonoNs: "19000000",
          elapsedNs: "9000000",
          txPrecision: precision,
          rxPrecision: precision,
        },
      },
    });
  });
}

test("a matching late device exception remains a timeout with separate wire evidence", async (t) => {
  const request = wire("tcp", "request", readPdu);
  const response = wire("tcp", "response", {
    functionCode: 3,
    exceptionCode: 2,
  });
  const { result, cursors } = await run(
    t,
    "tcp",
    request,
    [
      { events: [intent, written], next: "10", now: 151 },
      { events: [rx(10, 0, 115, response)], next: "11" },
    ],
    { params: { lateResponseWaitMs: 100 } },
  );
  assert.deepEqual(cursors, ["8", "8", "10"]);
  assert.equal(result.outcome, "response_timeout");
  assert.equal(result.lateResponse.exceptionCode, 2);
  assert.equal(result.lateResponse.timing.elapsedNs, "105000000");
  assert.equal(result.response, undefined);
});

test("an RX event published before the TX event waits for the confirmed source timestamps", async (t) => {
  const request = wire("tcp", "request", readPdu);
  const response = wire("tcp", "response", responsePdu);
  const { result } = await run(t, "tcp", request, [
    {
      events: [intent, rx(9, 0, 18, response), { ...written, eventSeq: "10" }],
      next: "11",
    },
  ]);
  assert.equal(result.outcome, "matched");
  assert.equal(result.response.timing.elapsedNs, "8000000");
});

test("an on-time exception settles independently from malformed headers and discontinuous source ranges", async (t) => {
  const request = wire("tcp", "request", readPdu);
  const response = wire("tcp", "response", {
    functionCode: 3,
    exceptionCode: 2,
  });
  const malformed = Uint8Array.from(response);
  malformed[2] = 1;
  for (const [chunks, expected] of [
    [[rx(10, 20, 15, response)], "device_exception"],
    [[rx(10, 20, 15, malformed)], "invalid_response"],
    [
      [
        rx(10, 20, 15, response.subarray(0, 4)),
        rx(11, 25, 17, response.subarray(4)),
      ],
      "source_changed",
    ],
    [[rx(10, 20, 15, response, "changed-clock")], "source_changed"],
    [
      [
        rx(10, 20, 16, response.subarray(0, 4)),
        rx(11, 24, 15, response.subarray(4)),
      ],
      "source_changed",
    ],
    [[rx(10, 20, 5, response)], "source_changed"],
  ]) {
    await t.test(expected, async (caseTest) => {
      const { result } = await run(caseTest, "tcp", request, [
        { events: [intent, written, ...chunks], next: "12" },
      ]);
      assert.equal(result.outcome, expected);
    });
  }
});

test("timeout, unconfirmed transfers and serial broadcast each settle the exclusive lease", async (t) => {
  const request = wire("rtu", "request", readPdu);
  await t.test("expired receive cursor", async (caseTest) => {
    const { result } = await run(caseTest, "rtu", request, [
      { error: "CURSOR_EXPIRED" },
    ]);
    assert.equal(result.outcome, "source_changed");
  });
  await t.test("no reply", async (caseTest) => {
    const { result } = await run(caseTest, "rtu", request, [
      { events: [intent, written], next: "10", now: 51 },
    ]);
    assert.equal(result.outcome, "response_timeout");
  });
  await t.test("unconfirmed", async (caseTest) => {
    const { result, cursors } = await run(caseTest, "rtu", request, [], {
      unconfirmed: true,
    });
    assert.equal(result.outcome, "transmit_unconfirmed");
    assert.deepEqual(cursors, ["8"]);
  });
  await t.test("broadcast", async (caseTest) => {
    const broadcast = wire(
      "rtu",
      "request",
      { functionCode: 6, address: 1, value: 9 },
      0,
    );
    const { result, cursors } = await run(caseTest, "rtu", broadcast, [], {
      params: { broadcastTurnaroundMs: 10 },
    });
    assert.deepEqual(result, {
      operationId: "tx",
      outcome: "broadcast_completed",
      ignoredFrames: 0,
      turnaroundMs: 10,
    });
    assert.deepEqual(cursors, []);
  });
});

test("a TCP retry keeps one lease, wraps the MBAP ID and skips the first attempt's stale reply", async (t) => {
  const request = wire("tcp", "request", readPdu, 1, 65_535);
  const retry = wire("tcp", "request", readPdu, 1, 0);
  const stale = wire("tcp", "response", responsePdu, 1, 65_535);
  const current = wire("tcp", "response", responsePdu, 1, 0);
  const { result, cursors } = await run(
    t,
    "tcp",
    request,
    [
      { events: [intent, written], next: "10", now: 51 },
      { events: [], next: "10" },
      {
        events: [
          ...nextTx(2, 10, 65),
          rx(12, 0, 80, Uint8Array.of(...stale, ...current)),
        ],
        next: "13",
      },
    ],
    { params: { retryLimit: 1 }, requests: [request, retry] },
  );
  assert.deepEqual(cursors, ["8", "8", "10", "10"]);
  assert.equal(result.outcome, "matched");
  assert.equal(result.operationId, "tx-2");
  assert.equal(result.response.source.byteStart, String(stale.length));
  assert.deepEqual(
    result.attempts.map(
      ({ operationId, requestTransactionId, outcome, ignoredFrames }) => [
        operationId,
        requestTransactionId,
        outcome,
        ignoredFrames,
      ],
    ),
    [
      ["tx", 65_535, "response_timeout", 0],
      ["tx-2", 0, "matched", 1],
    ],
  );
});

for (const transport of ["rtu", "ascii"]) {
  test(`${transport} retains the timed-out attempt and labels response attribution after a retry`, async (t) => {
    const request = wire(transport, "request", readPdu);
    const response = wire(transport, "response", responsePdu);
    const { result } = await run(
      t,
      transport,
      request,
      [
        { events: [intent, written], next: "10", now: 101 },
        { events: [], next: "10" },
        {
          events: [...nextTx(2, 10, 115), rx(12, 0, 131, response)],
          next: "13",
        },
      ],
      {
        params: { retryLimit: 1, lateResponseWaitMs: 50 },
        requests: [request, request],
      },
    );
    assert.deepEqual(
      result.attempts.map((attempt) => attempt.outcome),
      ["response_timeout", "matched"],
    );
    assert.equal(result.response.timing.attemptAttribution, "indeterminate");
    assert.equal(result.response.timing.elapsedNs, undefined);
    assert.equal(result.response.timing.rxMonoNs, "131000000");
    assert.equal(result.response.source.byteStart, "0");
  });
}

test("the retry limit settles at most three accepted attempts", async (t) => {
  const transport = "tcp";
  const request = wire(transport, "request", readPdu);
  const { result } = await run(
    t,
    transport,
    request,
    [
      { events: [intent, written], next: "10", now: 51 },
      { events: [], next: "10" },
      { events: nextTx(2, 10, 60), next: "12", now: 102 },
      { events: [], next: "12" },
      { events: nextTx(3, 12, 111), next: "14", now: 153 },
      { events: [], next: "14" },
    ],
    {
      params: { retryLimit: 2 },
      requests: [
        request,
        wire(transport, "request", readPdu, 1, 8),
        wire(transport, "request", readPdu, 1, 9),
      ],
    },
  );
  assert.equal(result.outcome, "response_timeout");
  assert.deepEqual(
    result.attempts.map(({ operationId }) => operationId),
    ["tx", "tx-2", "tx-3"],
  );
});

test("a clock change across attempts settles source loss and stops further sends", async (t) => {
  const request = wire("tcp", "request", readPdu);
  const [newIntent, newTx] = nextTx(2, 10, 60);
  newIntent.time.clockId = "other-clock";
  const { result } = await run(
    t,
    "tcp",
    request,
    [
      { events: [intent, written], next: "10", now: 51 },
      { events: [], next: "10" },
      { events: [newIntent, newTx], next: "12" },
    ],
    {
      params: { retryLimit: 2 },
      requests: [request, wire("tcp", "request", readPdu, 1, 8)],
    },
  );
  assert.equal(result.outcome, "source_changed");
  assert.deepEqual(
    result.attempts.map(({ outcome }) => outcome),
    ["response_timeout", "source_changed"],
  );
});

test("cancellation at the response deadline prevents resending", async (t) => {
  const request = wire("tcp", "request", readPdu);
  await assert.rejects(
    run(
      t,
      "tcp",
      request,
      [
        { events: [intent, written], next: "10", now: 51 },
        { events: [], next: "10" },
      ],
      { params: { retryLimit: 1 }, abortOnRead: 3 },
    ),
    { name: "AbortError" },
  );
});

test("late replies, partial frames, source loss and unconfirmed sends stop retry", async (t) => {
  const request = wire("tcp", "request", readPdu);
  const response = wire("tcp", "response", responsePdu);
  const bad = Uint8Array.from(response);
  bad[2] = 1;
  const received = (bytes) => [
    { events: [intent, written, rx(10, 0, 80, bytes)], next: "11", now: 101 },
  ];
  for (const [label, pages, options, outcome, reason] of [
    ["late match", received(response), {}, "response_timeout"],
    [
      "partial frame",
      received(response.subarray(0, 3)),
      {},
      "response_timeout",
      "partial_frame",
    ],
    ["unknown binary framing", received(bad), {}, "invalid_response"],
    ["source disappeared", [{ error: "CURSOR_EXPIRED" }], {}, "source_changed"],
    [
      "unconfirmed write receipt",
      [],
      { unconfirmed: true },
      "transmit_unconfirmed",
    ],
    [
      "lease time consumed",
      [{ events: [intent, written], next: "10", now: 22_000 }],
      {},
      "response_timeout",
      "lease_budget",
    ],
  ]) {
    await t.test(label, async (caseTest) => {
      const { result } = await run(caseTest, "tcp", request, pages, {
        params: { retryLimit: 1, lateResponseWaitMs: 50 },
        ...options,
      });
      assert.equal(result.outcome, outcome);
      assert.equal(result.attempts.length, 1);
      assert.equal(result.retryStopped, reason);
      if (label === "late match") assert.ok(result.lateResponse);
    });
  }
});

test("invalid retry plans fail before acquiring a lease or writing", async (t) => {
  const write = { functionCode: 6, address: 1, value: 9 };
  for (const [label, transport, request, params, message] of [
    [
      "TCP write",
      "tcp",
      wire("tcp", "request", write),
      { retryLimit: 1 },
      /unicast read/,
    ],
    [
      "broadcast",
      "rtu",
      wire("rtu", "request", write, 0),
      { retryLimit: 1 },
      /unicast read/,
    ],
    [
      "serial guard absent",
      "ascii",
      wire("ascii", "request", readPdu),
      { retryLimit: 1 },
      /late window/,
    ],
    [
      "too many attempts",
      "tcp",
      wire("tcp", "request", readPdu),
      { retryLimit: 3 },
      /retryLimit/,
    ],
    [
      "lease cannot cover attempts",
      "tcp",
      wire("tcp", "request", readPdu),
      { retryLimit: 2, responseTimeoutMs: 5_000, lateResponseWaitMs: 3_000 },
      /lease budget/,
    ],
  ]) {
    await t.test(label, async (caseTest) => {
      await assert.rejects(
        run(caseTest, transport, request, [], { params, invalid: true }),
        message,
      );
    });
  }
});
