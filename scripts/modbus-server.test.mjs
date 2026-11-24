import assert from "node:assert/strict";
import test from "node:test";
import { compareModbusExchange } from "../packages/plugin-sdk/examples/reference-protocol-fields/modbus-exchange.ts";
import {
  decodeModbusFrame,
  encodeModbusFrame,
} from "../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame.ts";
import {
  parseModbusServerModel,
  simulateModbusServer,
} from "../packages/plugin-sdk/examples/reference-protocol-fields/modbus-server.ts";
import { checksumBytes } from "../packages/plugin-sdk/src/wire-checksum.ts";

function header(transport, unitId) {
  return transport === "tcp" ? { unitId, transactionId: 0x1234 } : { unitId };
}
function request(transport, pdu, unitId = 1) {
  return encodeModbusFrame(transport, "request", {
    ...header(transport, unitId),
    pdu,
  });
}
function rawRequest(transport, pdu, unitId = 1) {
  if (transport === "tcp")
    return Uint8Array.of(0x12, 0x34, 0, 0, 0, pdu.length + 1, unitId, ...pdu);
  const payload = Uint8Array.of(unitId, ...pdu);
  if (transport === "rtu")
    return Uint8Array.of(
      ...payload,
      ...checksumBytes(payload, "modbus", "little"),
    );
  const check = -payload.reduce((sum, byte) => sum + byte, 0) & 0xff;
  return new TextEncoder().encode(
    ":" +
      Buffer.from([...payload, check])
        .toString("hex")
        .toUpperCase() +
      "\r\n",
  );
}

const definition = {
  unitId: 1,
  tables: {
    coils: [
      {
        start: 0,
        values: [true, false, true, false, false, false, false, false, true],
      },
    ],
    discreteInputs: [{ start: 0, values: [false, true] }],
    holdingRegisters: [
      { start: 1, values: [0x5678] },
      { start: 0, values: [0x1234] },
    ],
    inputRegisters: [{ start: 10, values: [13, 17] }],
  },
};

test("the eight functions read and change only their own address spaces across RTU, ASCII and TCP", () => {
  const original = structuredClone(definition);
  const vectors = [
    [{ functionCode: 1, address: 0, quantity: 9 }, { bitBytes: [5, 1] }],
    [{ functionCode: 2, address: 0, quantity: 2 }, { bitBytes: [2] }],
    [
      { functionCode: 3, address: 0, quantity: 2 },
      { values: [0x1234, 0x5678] },
    ],
    [{ functionCode: 4, address: 10, quantity: 2 }, { values: [13, 17] }],
    [
      { functionCode: 5, address: 1, value: true },
      { address: 1, value: true },
    ],
    [
      { functionCode: 6, address: 1, value: 258 },
      { address: 1, value: 258 },
    ],
    [
      { functionCode: 15, address: 6, values: [true, true, false] },
      { address: 6, quantity: 3 },
    ],
    [
      { functionCode: 16, address: 0, values: [7, 11] },
      { address: 0, quantity: 2 },
    ],
    [{ functionCode: 1, address: 0, quantity: 9 }, { bitBytes: [199, 0] }],
    [{ functionCode: 3, address: 0, quantity: 2 }, { values: [7, 11] }],
  ];
  for (const transport of ["rtu", "ascii", "tcp"]) {
    let state = definition;
    for (const [pdu, expected] of vectors) {
      const bytes = request(transport, pdu);
      const result = simulateModbusServer(transport, bytes, state);
      assert.equal(result.status, "replied");
      assert.deepEqual(
        compareModbusExchange(transport, bytes, result.responseBytes),
        { status: "matched" },
      );
      assert.deepEqual(
        decodeModbusFrame(transport, "response", result.responseBytes).packet,
        {
          ...header(transport, 1),
          pdu: { ...expected, functionCode: pdu.functionCode },
        },
      );
      state = result.model;
    }
    assert.deepEqual(definition, original);
    assert.deepEqual(
      state.tables.discreteInputs,
      original.tables.discreteInputs,
    );
    assert.deepEqual(
      state.tables.inputRegisters,
      original.tables.inputRegisters,
    );
  }
});

test("validated envelopes answer illegal function, address and value with independently expected exceptions", () => {
  const sparse = {
    ...definition,
    tables: {
      holdingRegisters: [
        { start: 0, values: [10] },
        { start: 2, values: [30] },
      ],
    },
  };
  const baseline = parseModbusServerModel(sparse);
  const vectors = [
    [[17], 1],
    [[3, 0xff, 0xff, 0, 2], 2],
    [[3, 0, 0, 0, 3], 2],
    [[3, 0, 0, 0, 0], 3],
    [[5, 0, 0, 0x12, 0x34], 3],
    [[16, 0, 0, 0, 2, 2, 0, 10], 3],
  ];
  for (const transport of ["rtu", "ascii", "tcp"]) {
    for (const [pdu, exceptionCode] of vectors) {
      const result = simulateModbusServer(
        transport,
        rawRequest(transport, pdu),
        sparse,
      );
      assert.equal(result.status, "exception");
      assert.equal(result.exceptionCode, exceptionCode);
      assert.deepEqual(result.model, baseline);
      assert.deepEqual(
        result.responseBytes,
        rawRequest(transport, [pdu[0] | 0x80, exceptionCode]),
      );
      assert.deepEqual(
        decodeModbusFrame(transport, "response", result.responseBytes).packet
          .pdu,
        { functionCode: pdu[0], exceptionCode },
      );
    }
    const crossesHole = request(transport, {
      functionCode: 16,
      address: 0,
      values: [1, 2, 3],
    });
    const rejected = simulateModbusServer(transport, crossesHole, sparse);
    assert.equal(rejected.exceptionCode, 2);
    assert.deepEqual(rejected.model, baseline);
  }
});

test("serial broadcast changes the simulated table silently while wrong or corrupt requests do not", () => {
  const baseline = parseModbusServerModel(definition);
  for (const transport of ["rtu", "ascii"]) {
    const pdu = { functionCode: 6, address: 1, value: 9 };
    const broadcast = simulateModbusServer(
      transport,
      request(transport, pdu, 0),
      definition,
    );
    assert.equal(broadcast.status, "broadcast");
    assert.equal("responseBytes" in broadcast, false);
    assert.equal(broadcast.model.tables.holdingRegisters[0].values[1], 9);
    const invalid = simulateModbusServer(
      transport,
      rawRequest(transport, [3, 0, 0, 0, 1], 0),
      definition,
    );
    assert.deepEqual(invalid, {
      status: "discarded",
      path: "pdu.functionCode",
      model: baseline,
    });
    assert.deepEqual(
      simulateModbusServer(transport, request(transport, pdu, 2), definition),
      {
        status: "ignored",
        model: baseline,
      },
    );
    const damaged = request(transport, pdu);
    const checksumByte = transport === "rtu" ? 0 : damaged.length - 3;
    if (transport === "rtu") damaged[checksumByte] ^= 1;
    else damaged[checksumByte] = damaged[checksumByte] === 0x30 ? 0x31 : 0x30;
    assert.deepEqual(simulateModbusServer(transport, damaged, definition), {
      status: "discarded",
      path: transport === "rtu" ? "frame.crc" : "frame.lrc",
      model: baseline,
    });
  }
  const unicast = request(
    "tcp",
    { functionCode: 3, address: 0, quantity: 1 },
    0,
  );
  assert.equal(
    simulateModbusServer("tcp", unicast, definition).status,
    "ignored",
  );
  for (const result of [
    simulateModbusServer("tcp", unicast, { ...definition, unitId: 0 }),
    simulateModbusServer("tcp", unicast, definition, "direct"),
  ]) {
    assert.equal(result.status, "replied");
    assert.equal(
      Buffer.from(result.responseBytes).toString("hex"),
      "1234000000050003021234",
    );
  }
});

test("configured faults and strict device model validation preserve writes and input bounds", () => {
  const faulty = {
    ...definition,
    faults: [
      { functionCode: 6, behavior: "exception", exceptionCode: 6 },
      { functionCode: 5, behavior: "silent" },
    ],
  };
  const model = parseModbusServerModel(faulty);
  const write = request("tcp", { functionCode: 6, address: 0, value: 55 });
  const busy = simulateModbusServer("tcp", write, faulty);
  assert.equal(busy.status, "exception");
  assert.equal(busy.exceptionCode, 6);
  assert.deepEqual(busy.model, model);
  const silent = request("tcp", { functionCode: 5, address: 0, value: false });
  assert.deepEqual(simulateModbusServer("tcp", silent, faulty), {
    status: "silent",
    model,
  });
  assert.throws(
    () =>
      parseModbusServerModel({
        ...definition,
        tables: {
          holdingRegisters: [
            { start: 0, values: [1, 2] },
            { start: 1, values: [3] },
          ],
        },
      }),
    { path: "model.tables.holdingRegisters" },
  );
  assert.throws(
    () =>
      parseModbusServerModel({
        ...definition,
        tables: { coils: [{ start: 0, values: [1] }] },
      }),
    { path: "model.tables.coils[0].values[0]" },
  );
  assert.throws(
    () =>
      parseModbusServerModel({
        ...definition,
        faults: [
          { functionCode: 5, behavior: "silent" },
          { functionCode: 5, behavior: "silent" },
        ],
      }),
    { path: "model.faults[1].functionCode" },
  );
  assert.throws(
    () =>
      parseModbusServerModel({
        ...definition,
        tables: { discreteInputs: [{ start: 65535, values: [true, false] }] },
      }),
    { path: "model.tables.discreteInputs[0]" },
  );
});
