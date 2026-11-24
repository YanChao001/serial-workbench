import assert from "node:assert/strict";
import test from "node:test";
import {
  compareModbusExchange,
  modbusUnitRouting,
} from "../packages/plugin-sdk/examples/reference-protocol-fields/modbus-exchange.ts";
import {
  decodeModbusFrame,
  encodeModbusFrame,
} from "../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame.ts";
import { checksumBytes } from "../packages/plugin-sdk/src/wire-checksum.ts";

const readHolding = { functionCode: 3, address: 0, quantity: 10 };
const hex = (value) => Buffer.from(value).toString("hex");
const rtuframe = (value) => {
  const bytes = Buffer.from(value, "hex");
  return Uint8Array.of(...bytes, ...checksumBytes(bytes, "modbus", "little"));
};

test("three independently specified Modbus wire envelopes round trip an identical request", () => {
  const serial = { unitId: 1, pdu: readHolding };
  const tcp = { transactionId: 1, ...serial };
  const known = [
    ["rtu", serial, Buffer.from("01030000000ac5cd", "hex")],
    ["ascii", serial, Buffer.from(":01030000000AF2\r\n", "ascii")],
    ["tcp", tcp, Buffer.from("00010000000601030000000a", "hex")],
  ];
  for (const [transport, packet, expected] of known) {
    assert.equal(
      hex(encodeModbusFrame(transport, "request", packet)),
      hex(expected),
    );
    assert.deepEqual(decodeModbusFrame(transport, "request", expected), {
      packet,
      broadcast: false,
    });
  }
});

test("every required function and exception keeps semantic values through both directions", () => {
  const requests = [
    { functionCode: 1, address: 65535, quantity: 1 },
    { functionCode: 2, address: 0, quantity: 2000 },
    { functionCode: 3, address: 100, quantity: 125 },
    { functionCode: 4, address: 0, quantity: 1 },
    { functionCode: 5, address: 0, value: true },
    { functionCode: 6, address: 65535, value: 65535 },
    {
      functionCode: 15,
      address: 0,
      values: [true, false, false, true, false, false, false, true, true],
    },
    { functionCode: 16, address: 11, values: [0x0123, 0x4567] },
  ];
  const responses = [
    { functionCode: 1, bitBytes: [0x81, 1] },
    { functionCode: 2, bitBytes: [0x12] },
    { functionCode: 3, values: [0x0001, 0xcdef] },
    { functionCode: 4, values: [0x1234] },
    requests[4],
    requests[5],
    { functionCode: 15, address: 0, quantity: 9 },
    { functionCode: 16, address: 11, quantity: 2 },
    { functionCode: 3, exceptionCode: 2 },
  ];
  for (const transport of ["rtu", "ascii", "tcp"]) {
    for (const [direction, pdus] of [
      ["request", requests],
      ["response", responses],
    ]) {
      for (const pdu of pdus) {
        const packet = {
          unitId: 7,
          pdu,
          ...(transport === "tcp" ? { transactionId: 0xffe0 } : {}),
        };
        const bytes = encodeModbusFrame(transport, direction, packet);
        assert.deepEqual(decodeModbusFrame(transport, direction, bytes), {
          packet,
          broadcast: false,
        });
      }
    }
  }
  assert.equal(
    hex(
      encodeModbusFrame("rtu", "request", {
        unitId: 7,
        pdu: requests[6],
      }).subarray(1, -2),
    ),
    "0f00000009028901",
  );
  assert.equal(
    hex(
      encodeModbusFrame("tcp", "response", {
        unitId: 0xff,
        transactionId: 7,
        pdu: { functionCode: 3, exceptionCode: 2 },
      }),
    ),
    "000700000003ff8302",
  );
});

test("length, integrity, serial broadcast and range failures report distinct fields", () => {
  assert.throws(
    () =>
      decodeModbusFrame(
        "rtu",
        "request",
        Buffer.from("01030000000ac5cc", "hex"),
      ),
    { path: "frame.crc" },
  );
  assert.throws(
    () =>
      decodeModbusFrame("ascii", "request", Buffer.from(":01030000000AF3\r\n")),
    { path: "frame.lrc" },
  );
  assert.throws(
    () =>
      decodeModbusFrame("ascii", "request", Buffer.from(":01030000000AF2\n\n")),
    { path: "frame.ascii" },
  );
  assert.throws(
    () =>
      decodeModbusFrame(
        "tcp",
        "request",
        Buffer.from("00010001000601030000000a", "hex"),
      ),
    { path: "frame.protocolId" },
  );
  assert.throws(
    () =>
      decodeModbusFrame(
        "tcp",
        "request",
        Buffer.from("00010000000701030000000a", "hex"),
      ),
    { path: "frame.length" },
  );
  assert.throws(
    () => decodeModbusFrame("rtu", "request", rtuframe("010f00000009028981")),
    { path: "pdu.bytes" },
  );
  assert.throws(
    () => decodeModbusFrame("rtu", "response", rtuframe("010302000100")),
    { path: "pdu.length" },
  );
  assert.throws(
    () => decodeModbusFrame("rtu", "response", rtuframe("018300")),
    { path: "pdu.exceptionCode" },
  );
  assert.throws(
    () => encodeModbusFrame("rtu", "request", { unitId: 0, pdu: readHolding }),
    { path: "packet.unitId" },
  );
  assert.throws(
    () =>
      encodeModbusFrame("rtu", "request", { unitId: 248, pdu: readHolding }),
    { path: "packet.unitId" },
  );
  assert.throws(
    () => encodeModbusFrame("tcp", "request", { unitId: 1, pdu: readHolding }),
    { path: "packet.transactionId" },
  );
  const write = {
    unitId: 0,
    pdu: { functionCode: 6, address: 1, value: 0x1234 },
  };
  const broadcast = encodeModbusFrame("rtu", "request", write);
  assert.deepEqual(decodeModbusFrame("rtu", "request", broadcast), {
    packet: write,
    broadcast: true,
  });
  assert.throws(() => decodeModbusFrame("rtu", "response", broadcast), {
    path: "packet.unitId",
  });
  assert.equal(
    decodeModbusFrame(
      "tcp",
      "request",
      encodeModbusFrame("tcp", "request", {
        transactionId: 1,
        unitId: 0,
        pdu: readHolding,
      }),
    ).broadcast,
    false,
  );
  assert.throws(
    () =>
      encodeModbusFrame("rtu", "request", {
        unitId: 1,
        pdu: { ...readHolding, address: 65535 },
      }),
    { path: "pdu.address" },
  );
});

test("maximum write quantities are bounded before encoding and survive round trips", () => {
  const vectors = [
    [15, Array.from({ length: 1968 }, (_, index) => index % 3 === 0), true],
    [16, Array.from({ length: 123 }, (_, index) => index * 5), 99],
  ];
  for (const [functionCode, values, extra] of vectors) {
    const packet = { unitId: 247, pdu: { functionCode, address: 0, values } };
    const bytes = encodeModbusFrame("rtu", "request", packet);
    assert.equal(bytes.length, 255);
    assert.deepEqual(decodeModbusFrame("rtu", "request", bytes).packet, packet);
    assert.throws(
      () =>
        encodeModbusFrame("rtu", "request", {
          ...packet,
          pdu: { ...packet.pdu, values: [...values, extra] },
        }),
      { path: "pdu.values" },
    );
  }
});

function exchangeFrames(transport, request, response, options = {}) {
  const header = {
    unitId: 1,
    ...(transport === "tcp" ? { transactionId: 1 } : {}),
  };
  const sent = encodeModbusFrame(transport, "request", {
    ...header,
    unitId: options.requestUnit ?? header.unitId,
    pdu: request,
  });
  const received =
    response &&
    encodeModbusFrame(transport, "response", {
      ...header,
      ...options.responseHeader,
      pdu: response,
    });
  return [transport, sent, received, options.routing];
}

test("Modbus pairs all eight function codes across all three transports", () => {
  const vectors = [
    [{ functionCode: 1, address: 1, quantity: 9 }, { bitBytes: [0x99, 1] }],
    [{ functionCode: 2, address: 2, quantity: 8 }, { bitBytes: [0xff] }],
    [{ functionCode: 3, address: 1, quantity: 2 }, { values: [17, 23] }],
    [{ functionCode: 4, address: 1, quantity: 1 }, { values: [31] }],
    [
      { functionCode: 5, address: 1, value: false },
      { address: 1, value: false },
    ],
    [
      { functionCode: 6, address: 2, value: 0 },
      { address: 2, value: 0 },
    ],
    [
      { functionCode: 15, address: 3, values: [true] },
      { address: 3, quantity: 1 },
    ],
    [
      { functionCode: 16, address: 5, values: [99, 101] },
      { address: 5, quantity: 2 },
    ],
  ];
  for (const transport of ["rtu", "ascii", "tcp"]) {
    for (const [request, response] of vectors) {
      const frames = exchangeFrames(transport, request, {
        functionCode: request.functionCode,
        ...response,
      });
      assert.deepEqual(compareModbusExchange(...frames), { status: "matched" });
    }
  }
});

test("TCP transaction ID always applies and only TCP direct mode ignores the unit", () => {
  const request = { functionCode: 3, address: 0, quantity: 1 };
  const response = { functionCode: 3, values: [17] };
  for (const transport of ["rtu", "ascii", "tcp"]) {
    assert.deepEqual(
      compareModbusExchange(
        ...exchangeFrames(transport, request, response, {
          responseHeader: { unitId: 2 },
        }),
      ),
      { status: "mismatch", reason: "unit-id" },
    );
  }
  assert.deepEqual(
    compareModbusExchange(
      ...exchangeFrames("tcp", request, response, {
        routing: "direct",
        responseHeader: { unitId: 255, transactionId: 2 },
      }),
    ),
    { status: "mismatch", reason: "transaction-id" },
  );
  assert.deepEqual(
    compareModbusExchange(
      ...exchangeFrames("tcp", request, response, {
        routing: "direct",
        responseHeader: { unitId: 255 },
      }),
    ),
    { status: "matched" },
  );
  assert.equal(modbusUnitRouting("tcp", undefined), "gateway");
  assert.throws(() => modbusUnitRouting("rtu", "direct"), {
    path: "unitRouting",
  });
});

test("comparison distinguishes valid mismatches, device exceptions and missing samples", () => {
  const coils = { functionCode: 1, address: 1, quantity: 9 };
  const registers = { functionCode: 3, address: 0, quantity: 2 };
  const single = { functionCode: 6, address: 4, value: 7 };
  const multiple = { functionCode: 16, address: 5, values: [9, 11] };
  const mismatches = [
    [registers, { functionCode: 4, exceptionCode: 2 }, "function-code"],
    [coils, { functionCode: 1, bitBytes: [1] }, "read-count"],
    [coils, { functionCode: 1, bitBytes: [1, 2] }, "padding"],
    [registers, { functionCode: 3, values: [1] }, "read-count"],
    [single, { ...single, address: 5 }, "write-address"],
    [single, { ...single, value: 8 }, "write-echo"],
    [multiple, { functionCode: 16, address: 5, quantity: 1 }, "write-count"],
  ];
  for (const [request, response, reason] of mismatches)
    assert.deepEqual(
      compareModbusExchange(...exchangeFrames("rtu", request, response)),
      {
        status: "mismatch",
        reason,
      },
    );
  assert.deepEqual(
    compareModbusExchange(
      ...exchangeFrames("rtu", registers, {
        functionCode: 3,
        exceptionCode: 2,
      }),
    ),
    { status: "device-exception", exceptionCode: 2 },
  );
  assert.deepEqual(compareModbusExchange(...exchangeFrames("rtu", registers)), {
    status: "missing-response",
  });
  for (const transport of ["rtu", "ascii"]) {
    assert.deepEqual(
      compareModbusExchange(
        ...exchangeFrames(transport, single, undefined, {
          requestUnit: 0,
        }),
      ),
      { status: "broadcast" },
    );
    assert.deepEqual(
      compareModbusExchange(
        ...exchangeFrames(transport, single, single, {
          requestUnit: 0,
        }),
      ),
      { status: "mismatch", reason: "broadcast-response" },
    );
  }
  const [, sent, received] = exchangeFrames("rtu", single, single);
  const corrupt = (bytes) =>
    Uint8Array.from(bytes, (byte, index) =>
      index === bytes.length - 1 ? byte ^ 1 : byte,
    );
  assert.throws(() => compareModbusExchange("rtu", corrupt(sent), received), {
    path: "request.frame.crc",
  });
  assert.throws(() => compareModbusExchange("rtu", sent, corrupt(received)), {
    path: "response.frame.crc",
  });
});
