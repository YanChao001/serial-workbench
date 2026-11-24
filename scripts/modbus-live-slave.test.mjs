import assert from "node:assert/strict";
import test from "node:test";
import { serveModbus } from "../packages/plugin-sdk/examples/reference-modbus-slave/serve.ts";
import { encodeModbusFrame } from "../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame.ts";

const target = {
  hostId: "host",
  kind: "session",
  id: "session",
  sessionId: "session",
  sessionEpoch: "2",
};
const model = {
  unitId: 1,
  tables: { holdingRegisters: [{ start: 0, values: [12, 0] }] },
};
const hex = (bytes) => Buffer.from(bytes).toString("base64");
const wire = (transport, direction, transactionId, pdu) =>
  encodeModbusFrame(transport, direction, {
    unitId: 1,
    ...(transport === "tcp" && { transactionId }),
    pdu,
  });
const rx = (eventSeq, byteStart, bytes) => ({
  ...target,
  kind: "rx",
  eventSeq: String(eventSeq),
  time: {
    clockId: "clock",
    sourceMonoNs: String(eventSeq * 100_000),
    precision: {
      source: "host_read",
      resolutionNs: "100000",
      syncMethod: "fixture",
    },
  },
  payload: {
    bytesBase64: hex(bytes),
    byteStart: String(byteStart),
    byteEnd: String(byteStart + bytes.length),
  },
});

async function serve(transport, pages, { confirmed = true } = {}) {
  const effects = [];
  const progress = [];
  const cursors = [];
  let read = 0;
  const task = {
    signal: new AbortController().signal,
    progress: { report: (value) => progress.push(value.completed) },
    streams: {
      async read({ startEventSeq, sessionId, sessionEpoch }) {
        assert.equal(sessionId, target.sessionId);
        assert.equal(sessionEpoch, target.sessionEpoch);
        cursors.push(startEventSeq);
        if (read++ === 0)
          return { events: [], nextEventSeq: "4", hasMore: false };
        const events = pages[read - 2];
        assert.ok(events, "unexpected polling after scripted pages");
        return {
          events,
          nextEventSeq: String(Number(events.at(-1).eventSeq) + 1),
          hasMore: read - 1 < pages.length,
        };
      },
    },
    actions: {
      async invokeChild(call) {
        effects.push(call);
        assert.deepEqual(call.target, target);
        if (call.actionId === "lease.acquire")
          return {
            state: "running",
            result: {
              kind: "lease",
              value: { state: "active", leaseId: "lease" },
            },
          };
        if (call.actionId === "lease.release")
          return {
            state: "succeeded",
            result: {
              kind: "lease",
              value: { state: "released", leaseId: "lease" },
            },
          };
        assert.equal(call.actionId, "session.tx");
        assert.equal(call.leaseId, "lease");
        const operationId = `reply-${effects.length}`;
        return {
          state: "succeeded",
          operationId,
          result: {
            kind: "tx",
            value: {
              outcome: "accepted",
              operationId,
              sessionId: target.sessionId,
              sessionEpoch: target.sessionEpoch,
              bytesBase64: confirmed ? call.params.bytesBase64 : "AA==",
            },
          },
        };
      },
    },
  };
  const result = await serveModbus(
    { target, params: { transport, model, durationMs: 1000, requestLimit: 2 } },
    task,
  );
  return { result, effects, progress, cursors };
}

for (const transport of ["rtu", "ascii", "tcp"]) {
  test(`${transport} live slave processes split and joined requests with one model and settled replies`, async () => {
    const writePdu = { functionCode: 6, address: 1, value: 258 };
    const write = wire(transport, "request", 7, writePdu);
    const read = wire(transport, "request", 8, {
      functionCode: 3,
      address: 1,
      quantity: 1,
    });
    const result = await serve(transport, [
      [rx(4, 20, write.subarray(0, 3))],
      [rx(5, 23, Uint8Array.of(...write.subarray(3), ...read))],
    ]);
    assert.equal(result.result.reason, "request_limit");
    assert.deepEqual(result.cursors, ["1", "4", "5"]);
    assert.deepEqual(result.progress, ["0", "1", "2"]);
    assert.deepEqual(
      result.result.model.tables.holdingRegisters[0].values,
      [12, 258],
    );
    assert.deepEqual(
      result.effects.map(({ actionId }) => actionId),
      ["lease.acquire", "session.tx", "session.tx", "lease.release"],
    );
    const [first, second] = result.result.processed;
    assert.deepEqual(
      [first.source.eventStart, first.source.eventEnd],
      ["4", "6"],
    );
    assert.deepEqual(
      [second.source.byteStart, second.source.byteEnd],
      [String(20 + write.length), String(20 + write.length + read.length)],
    );
    assert.equal(
      first.responseBase64,
      hex(wire(transport, "response", 7, writePdu)),
    );
    assert.equal(
      second.responseBase64,
      hex(wire(transport, "response", 8, { functionCode: 3, values: [258] })),
    );
    assert.equal(second.tx.confirmed, true);
  });
}

test("an unconfirmed response records the consumed request and prevents further writes", async () => {
  const request = wire("tcp", "request", 7, {
    functionCode: 6,
    address: 1,
    value: 258,
  });
  const result = await serve(
    "tcp",
    [[rx(4, 0, Uint8Array.of(...request, ...request))]],
    { confirmed: false },
  );
  assert.equal(result.result.reason, "reply_unconfirmed");
  assert.equal(result.result.processed.length, 1);
  assert.equal(result.result.processed[0].tx.confirmed, false);
  assert.equal(result.result.model.tables.holdingRegisters[0].values[1], 258);
  assert.equal(
    result.effects.filter(({ actionId }) => actionId === "session.tx").length,
    1,
  );
});

test("a source gap stops live slave before a later request", async () => {
  const request = wire("rtu", "request", 7, {
    functionCode: 3,
    address: 0,
    quantity: 1,
  });
  const partial = rx(4, 0, request.subarray(0, 3));
  const result = await serve("rtu", [
    [partial, { ...partial, eventSeq: "5", kind: "gap" }, rx(6, 3, request)],
  ]);
  assert.equal(result.result.reason, "source_changed");
  assert.equal(result.result.pendingFrame, true);
  assert.deepEqual(
    result.effects.map(({ actionId }) => actionId),
    ["lease.acquire", "lease.release"],
  );
});

test("an RTU broadcast updates the live model and remains silent", async () => {
  const broadcast = encodeModbusFrame("rtu", "request", {
    unitId: 0,
    pdu: { functionCode: 6, address: 1, value: 258 },
  });
  const read = wire("rtu", "request", 7, {
    functionCode: 3,
    address: 1,
    quantity: 1,
  });
  const { effects, result } = await serve("rtu", [
    [rx(4, 0, Uint8Array.of(...broadcast, ...read))],
  ]);
  assert.equal(result.reason, "request_limit");
  assert.equal(result.processed[0].status, "broadcast");
  assert.equal(result.processed[0].tx, undefined);
  assert.equal(
    result.processed[1].responseBase64,
    hex(wire("rtu", "response", 7, { functionCode: 3, values: [258] })),
  );
  assert.equal(
    effects.filter(({ actionId }) => actionId === "session.tx").length,
    1,
  );
});
