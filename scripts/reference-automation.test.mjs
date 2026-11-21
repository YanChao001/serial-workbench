import assert from "node:assert/strict";
import test from "node:test";
import { register } from "../packages/plugin-sdk/examples/reference-automation/main.ts";

for (const late of [false, true]) {
  test(`automation reads a retained ${late ? "late" : "on-time"} reply at the polling deadline`, async (t) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "performance");
    let now = 0;
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: { now: () => now },
    });
    t.after(() => Object.defineProperty(globalThis, "performance", previous));

    const session = {
      kind: "session",
      hostId: "host",
      id: "session",
      sessionId: "session",
      sessionEpoch: "1",
    };
    const bytesBase64 = "QQ==";
    const operationId = "write";
    const tx = {
      ...session,
      kind: "tx",
      eventSeq: "2",
      time: { clockId: "source", sourceMonoNs: "1000000" },
      payload: { operationId },
    };
    const source = {
      hostId: session.hostId,
      sessionId: session.sessionId,
      sessionEpoch: session.sessionEpoch,
      direction: "rx",
      eventStart: "3",
      eventEnd: "4",
      byteStart: "0",
      byteEnd: "1",
    };
    let handler;
    register({ actions: { register: (_id, run) => (handler = run) } });
    let reads = 0;
    const result = await handler(
      {
        target: session,
        params: {
          responseTimeoutMs: 50,
          lateResponseWaitMs: late ? 50 : 0,
          steps: [{ sendBase64: bytesBase64, expectBase64: bytesBase64 }],
        },
      },
      {
        signal: new AbortController().signal,
        actions: {
          async invokeChild({ actionId }) {
            if (actionId === "lease.acquire")
              return {
                state: "running",
                result: {
                  kind: "lease",
                  value: { state: "active", leaseId: "lease" },
                },
              };
            if (actionId === "session.tx")
              return {
                operationId,
                state: "succeeded",
                result: {
                  kind: "tx",
                  value: {
                    outcome: "accepted",
                    operationId,
                    sessionId: session.sessionId,
                    sessionEpoch: session.sessionEpoch,
                    bytesBase64,
                  },
                },
              };
            assert.equal(actionId, "lease.release");
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
          async read({ startEventSeq }) {
            reads++;
            if (reads === 1)
              return { events: [], nextEventSeq: "1", hasMore: false };
            if (reads === 2) {
              // The Host took a snapshot before the reply was retained. On return
              // to the SDK, its local polling deadline has already elapsed.
              now = late ? 101 : 51;
              return {
                events: [{ ...tx, kind: "tx_intent", eventSeq: "1" }, tx],
                nextEventSeq: "3",
                hasMore: false,
              };
            }
            assert.equal(startEventSeq, "3");
            return {
              events: [
                {
                  ...session,
                  kind: "rx",
                  eventSeq: "3",
                  time: {
                    clockId: "source",
                    sourceMonoNs: late ? "100000000" : "50000000",
                  },
                  payload: { bytesBase64, byteStart: "0", byteEnd: "1" },
                },
              ],
              nextEventSeq: "4",
              hasMore: false,
            };
          },
        },
        progress: { report() {} },
      },
    );
    const outcome = late ? "response_timeout" : "matched";
    assert.deepEqual(result, {
      outcome,
      completedSteps: late ? 0 : 1,
      attempted: [
        { operationId, outcome, [late ? "lateResponse" : "source"]: source },
      ],
    });
    assert.equal(reads, 3);
  });
}
