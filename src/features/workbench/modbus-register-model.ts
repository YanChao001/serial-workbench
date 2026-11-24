import { ContractValidationError } from "@serial-workbench/contracts";
import { bytesToBase64 } from "@/lib/base64";
import {
  compareModbusExchange,
  type ModbusUnitRouting,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-exchange";
import {
  decodeModbusFrame,
  encodeModbusFrame,
  type ModbusTransport,
} from "../../../packages/plugin-sdk/examples/reference-protocol-fields/modbus-frame";
import type { TimelineAttempt } from "./modbus-timeline-model";

export const registerFormats = ["u16", "i16", "u32", "i32", "f32"] as const;
type RegisterFormat = (typeof registerFormats)[number];
const byteOrders = {
  AB: [0, 1],
  BA: [1, 0],
  ABCD: [0, 1, 2, 3],
  BADC: [1, 0, 3, 2],
  CDAB: [2, 3, 0, 1],
  DCBA: [3, 2, 1, 0],
} as const;
type RegisterOrder = keyof typeof byteOrders;

export type RegisterDraft = {
  transport: ModbusTransport;
  routing: ModbusUnitRouting;
  table: "holding" | "input";
  unit: string;
  base: "0" | "1";
  address: string;
  count: string;
  format: RegisterFormat;
  order: RegisterOrder;
  timeout: string;
  interval: string;
};

export const initialRegisterDraft: RegisterDraft = {
  transport: "rtu",
  routing: "gateway",
  table: "holding",
  unit: "1",
  base: "0",
  address: "0",
  count: "1",
  format: "u16",
  order: "AB",
  timeout: "1000",
  interval: "1000",
};

export function registerOrders(format: RegisterFormat): RegisterOrder[] {
  return format === "u16" || format === "i16"
    ? ["AB", "BA"]
    : ["ABCD", "BADC", "CDAB", "DCBA"];
}

function decimalInteger(source: string, min: number, max: number) {
  if (!/^\d+$/.test(source)) return undefined;
  const value = Number(source);
  return value >= min && value <= max ? value : undefined;
}

export function registerRange(draft: RegisterDraft) {
  const base = Number(draft.base);
  const start = decimalInteger(draft.address, base, 65_535 + base);
  const tcp = draft.transport === "tcp";
  const unitId = decimalInteger(draft.unit, tcp ? 0 : 1, tcp ? 255 : 247);
  const width = byteOrders[draft.order].length / 2;
  const count = decimalInteger(draft.count, 1, Math.floor(125 / width));
  const timeout = decimalInteger(draft.timeout, 50, 5000);
  const interval = decimalInteger(draft.interval, 250, 60_000);
  if (
    start === undefined ||
    unitId === undefined ||
    count === undefined ||
    timeout === undefined ||
    !registerOrders(draft.format).includes(draft.order)
  )
    return undefined;
  const address = start - base;
  const quantity = count * width;
  if (address + quantity > 65_536) return undefined;
  return {
    base,
    address,
    unitId,
    count,
    width,
    quantity,
    timeout,
    interval,
    functionCode: draft.table === "holding" ? 3 : 4,
  } as const;
}

type RegisterRange = NonNullable<ReturnType<typeof registerRange>>;

export function decodeRegisterValue(
  words: readonly number[],
  draft: RegisterDraft,
) {
  const bytes = words.flatMap((word) => [word >>> 8, word & 0xff]);
  const order = byteOrders[draft.order];
  const data = new DataView(
    Uint8Array.from(order, (index) => bytes[index]!).buffer,
  );
  switch (draft.format) {
    case "u16":
      return data.getUint16(0);
    case "i16":
      return data.getInt16(0);
    case "u32":
      return data.getUint32(0);
    case "i32":
      return data.getInt32(0);
    case "f32":
      return data.getFloat32(0);
  }
}

const integerBounds = {
  u16: [0, 65_535],
  i16: [-32_768, 32_767],
  u32: [0, 4_294_967_295],
  i32: [-2_147_483_648, 2_147_483_647],
} as const;

export function encodeRegisterValue(input: string, draft: RegisterDraft) {
  const text = input.trim();
  const value = Number(text);
  const order = byteOrders[draft.order];
  const bytes = new Uint8Array(order.length);
  const data = new DataView(bytes.buffer);
  if (draft.format === "f32") {
    if (
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ||
      !Number.isFinite(Math.fround(value))
    )
      return undefined;
    data.setFloat32(0, value);
  } else {
    const [min, max] = integerBounds[draft.format];
    if (!/^[+-]?\d+$/.test(text) || value < min || value > max)
      return undefined;
    if (order.length === 2) data.setUint16(0, value);
    else data.setUint32(0, value);
  }
  const wire = Uint8Array.from(order, (index) => bytes[index]!);
  const view = new DataView(wire.buffer);
  return Array.from({ length: wire.length / 2 }, (_, index) =>
    view.getUint16(index * 2),
  );
}

export type RegisterWrite = { index: number; words: number[] };

export function selectRegisterWrite(
  draft: RegisterDraft,
  range: RegisterRange | undefined,
  source: string,
  value: string,
): RegisterWrite | undefined {
  if (!range || draft.table !== "holding") return undefined;
  const first = range.address + range.base;
  const address = decimalInteger(
    source,
    first,
    first + range.quantity - range.width,
  );
  if (address === undefined || (address - first) % range.width !== 0)
    return undefined;
  const words = encodeRegisterValue(value, draft);
  return words && { index: (address - first) / range.width, words };
}

export function registerRequest(
  draft: RegisterDraft,
  range: RegisterRange,
  transactionId: number,
  write?: RegisterWrite,
) {
  const address = range.address + (write ? write.index * range.width : 0);
  const pdu = write
    ? write.words.length === 1
      ? { functionCode: 6, address, value: write.words[0] }
      : { functionCode: 16, address, values: write.words }
    : { functionCode: range.functionCode, address, quantity: range.quantity };
  return encodeModbusFrame(draft.transport, "request", {
    unitId: range.unitId,
    ...(draft.transport === "tcp" && { transactionId }),
    pdu,
  });
}

export function registerResult(
  draft: RegisterDraft,
  request: Uint8Array,
  attempt: TimelineAttempt,
  write: boolean,
) {
  const { outcome, response } = attempt;
  if (outcome !== "matched" && outcome !== "device_exception")
    return { attempt, words: undefined };
  if (
    !response?.attributionKnown ||
    !response.bytesBase64 ||
    response.bytesBase64.length > 684
  )
    throw new ContractValidationError(
      "Modbus register result requires the matched response",
    );
  const bytes = Uint8Array.from(atob(response.bytesBase64), (byte) =>
    byte.charCodeAt(0),
  );
  if (
    bytesToBase64(bytes) !== response.bytesBase64 ||
    BigInt(bytes.length) !== response.byteEnd - response.byteStart
  )
    throw new ContractValidationError(
      "Modbus register response range does not match its bytes",
    );
  const match = compareModbusExchange(
    draft.transport,
    request,
    bytes,
    draft.routing,
  );
  if (
    match.status === "device-exception" &&
    outcome === "device_exception" &&
    match.exceptionCode === response.exceptionCode
  )
    return { attempt, words: undefined };
  if (
    match.status !== "matched" ||
    outcome !== "matched" ||
    response.exceptionCode !== undefined
  )
    throw new ContractValidationError(
      "Modbus register response does not match its request",
    );
  if (write) return { attempt, words: undefined };
  const { packet } = decodeModbusFrame(draft.transport, "response", bytes);
  if (
    (packet.pdu.functionCode !== 3 && packet.pdu.functionCode !== 4) ||
    !("values" in packet.pdu)
  )
    throw new ContractValidationError("Modbus register read is missing words");
  const words = packet.pdu.values;
  if (!words.every((word): word is number => typeof word === "number"))
    throw new ContractValidationError(
      "Modbus register read requires word values",
    );
  return { attempt, words };
}
