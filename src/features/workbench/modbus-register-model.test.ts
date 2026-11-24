import { expect, test } from "vitest";
import { bytesToBase64 } from "@/lib/base64";
import {
  decodeModbusFrame,
  encodeModbusFrame,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame";
import {
  decodeRegisterValue,
  encodeRegisterValue,
  initialRegisterDraft,
  registerRange,
  registerRequest,
  registerResult,
  selectRegisterWrite,
  type RegisterDraft,
} from "./modbus-register-model";
import type { TimelineAttempt } from "./modbus-timeline-model";

test("register word layouts round-trip known wire values", () => {
  const layouts = [
    ["ABCD", [0x1234, 0x5678]],
    ["BADC", [0x3412, 0x7856]],
    ["CDAB", [0x5678, 0x1234]],
    ["DCBA", [0x7856, 0x3412]],
  ] as const;
  for (const [order, words] of layouts) {
    const draft: RegisterDraft = {
      ...initialRegisterDraft,
      format: "u32",
      order,
    };
    expect(decodeRegisterValue(words, draft)).toBe(0x1234_5678);
    expect(encodeRegisterValue("305419896", draft)).toEqual(words);
  }
  const signed = {
    ...initialRegisterDraft,
    format: "i16",
    order: "BA",
  } as const;
  expect(encodeRegisterValue("-32768", signed)).toEqual([0x0080]);
  expect(decodeRegisterValue([0x0080], signed)).toBe(-32768);
  expect(encodeRegisterValue("32768", signed)).toBeUndefined();
  const float = {
    ...initialRegisterDraft,
    format: "f32",
    order: "CDAB",
  } as const;
  expect(encodeRegisterValue("1.5", float)).toEqual([0, 0x3fc0]);
  expect(decodeRegisterValue([0, 0x8000], float)).toBe(-0);
  expect(encodeRegisterValue("1e40", float)).toBeUndefined();
});

test("range selection uses one-based input, whole variables and the correct function codes", () => {
  const draft: RegisterDraft = {
    ...initialRegisterDraft,
    transport: "tcp",
    table: "input",
    base: "1",
    address: "65533",
    count: "2",
    format: "i32",
    order: "ABCD",
  };
  const range = registerRange(draft)!;
  expect(range).toMatchObject({ address: 65532, quantity: 4, functionCode: 4 });
  expect(registerRange({ ...draft, address: "65534" })).toBeUndefined();
  expect(selectRegisterWrite(draft, range, "65533", "5")).toBeUndefined();
  const holding = { ...draft, table: "holding" } as const;
  expect(selectRegisterWrite(holding, range, "65534", "5")).toBeUndefined();
  const write = selectRegisterWrite(holding, range, "65535", "-1")!;
  const packet = decodeModbusFrame(
    "tcp",
    "request",
    registerRequest(holding, range, 7, write),
  ).packet;
  expect(packet).toMatchObject({
    transactionId: 7,
    pdu: { functionCode: 16, address: 65534, values: [65535, 65535] },
  });
  const single = registerRange(initialRegisterDraft)!;
  expect(
    decodeModbusFrame(
      "rtu",
      "request",
      registerRequest(initialRegisterDraft, single, 0, {
        index: 0,
        words: [258],
      }),
    ).packet.pdu,
  ).toEqual({ functionCode: 6, address: 0, value: 258 });
});

test("register results recheck the raw Modbus reply and keep late data out of the table", () => {
  const draft = { ...initialRegisterDraft, transport: "tcp" } as const;
  const request = registerRequest(draft, registerRange(draft)!, 9);
  const packet = (transactionId: number, pdu: object) =>
    encodeModbusFrame("tcp", "response", { unitId: 1, transactionId, pdu });
  const point = {
    event: 1n,
    ns: 10n,
    clockId: "test",
    source: "host_read",
    resolution: 1n,
  } as const;
  const result = (
    wire: Uint8Array,
    override: Partial<TimelineAttempt> = {},
  ): TimelineAttempt => ({
    operationId: "test-tx",
    outcome: "matched",
    ignoredFrames: 0,
    response: {
      first: point,
      last: point,
      late: false,
      attributionKnown: true,
      byteStart: 0n,
      byteEnd: BigInt(wire.length),
      bytesBase64: bytesToBase64(wire),
    },
    ...override,
  });
  const read = packet(9, { functionCode: 3, values: [0x1234] });
  expect(registerResult(draft, request, result(read), false).words).toEqual([
    0x1234,
  ]);
  const bad = packet(8, { functionCode: 3, values: [0x1234] });
  expect(() => registerResult(draft, request, result(bad), false)).toThrow(
    /does not match its request/,
  );
  const exception = result(packet(9, { functionCode: 3, exceptionCode: 2 }));
  exception.outcome = "device_exception";
  exception.response!.exceptionCode = 2;
  expect(
    registerResult(draft, request, exception, false).attempt.response
      ?.exceptionCode,
  ).toBe(2);
  const late = result(read, { outcome: "response_timeout" });
  late.response!.late = true;
  expect(registerResult(draft, request, late, false).words).toBeUndefined();
});
