import { checksumBytes } from "../../src/wire-checksum.ts";
import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";
import {
  decodeModbusPdu,
  encodeModbusPdu,
  isModbusWrite,
  modbusInteger,
  modbusKeys,
  modbusRecord,
  modbusWord,
  type ModbusDirection,
} from "./modbus-pdu.ts";

export const modbusFrameLimits = { rtu: 256, ascii: 513, tcp: 260 } as const;
export type ModbusTransport = keyof typeof modbusFrameLimits;

export function modbusTransport(value: unknown): ModbusTransport {
  if (value === "rtu" || value === "ascii" || value === "tcp") return value;
  throw new ProtocolFieldError("transport", "Expected RTU, ASCII or TCP");
}

export function modbusDirection(value: unknown): ModbusDirection {
  if (value === "request" || value === "response") return value;
  throw new ProtocolFieldError("direction", "Expected a request or response");
}

function checkUnit(
  unit: unknown,
  transport: ModbusTransport,
  direction: ModbusDirection,
  fc: number,
) {
  const unitId = modbusInteger(
    unit,
    0,
    transport === "tcp" ? 255 : 247,
    "packet.unitId",
  );
  if (
    transport !== "tcp" &&
    unitId === 0 &&
    (direction !== "request" || !isModbusWrite(fc))
  )
    throw new ProtocolFieldError(
      "packet.unitId",
      "Serial unit zero requires a broadcast write request",
    );
  return unitId;
}

function lrc(bytes: Uint8Array) {
  const [sum] = checksumBytes(bytes, "sum", "big");
  return -sum! & 0xff;
}

function asciiFrame(bytes: Uint8Array) {
  const body = Array.from(Uint8Array.of(...bytes, lrc(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0").toUpperCase(),
  ).join("");
  return new TextEncoder().encode(":" + body + "\r\n");
}

function readAsciiFrame(bytes: Uint8Array) {
  if (bytes[0] !== 0x3a || bytes.at(-2) !== 0x0d || bytes.at(-1) !== 0x0a)
    throw new ProtocolFieldError(
      "frame.ascii",
      "Expected colon and CRLF framing",
    );
  const text = String.fromCharCode(...bytes.subarray(1, -2));
  if (text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text))
    throw new ProtocolFieldError(
      "frame.ascii",
      "Expected complete ASCII hexadecimal bytes",
    );
  const parsed = Uint8Array.from({ length: text.length / 2 }, (_, index) =>
    Number.parseInt(text.slice(index * 2, index * 2 + 2), 16),
  );
  const payload = parsed.subarray(0, -1);
  if (lrc(payload) !== parsed.at(-1))
    throw new ProtocolFieldError(
      "frame.lrc",
      "Modbus ASCII LRC does not match",
    );
  return payload;
}

export function encodeModbusFrame(
  transport: ModbusTransport,
  direction: ModbusDirection,
  value: unknown,
): Uint8Array {
  const packet = modbusRecord(value, "packet");
  modbusKeys(
    packet,
    transport === "tcp"
      ? ["unitId", "transactionId", "pdu"]
      : ["unitId", "pdu"],
    "packet",
  );
  const pdu = encodeModbusPdu(packet.pdu, direction);
  const unitId = checkUnit(packet.unitId, transport, direction, pdu[0]!);
  if (transport === "tcp") {
    const transactionId = modbusInteger(
      packet.transactionId,
      0,
      65535,
      "packet.transactionId",
    );
    const bytes = new Uint8Array(pdu.length + 7);
    const header = new DataView(bytes.buffer);
    header.setUint16(0, transactionId);
    header.setUint16(4, pdu.length + 1);
    bytes[6] = unitId;
    bytes.set(pdu, 7);
    return bytes;
  }
  const body = Uint8Array.of(unitId, ...pdu);
  if (transport === "ascii") return asciiFrame(body);
  return Uint8Array.of(...body, ...checksumBytes(body, "modbus", "little"));
}

export function decodeModbusAdu(
  transport: ModbusTransport,
  bytes: Uint8Array,
): { unitId: number; pdu: Uint8Array } & (
  { transactionId: number } | Record<never, never>
) {
  const minimum = transport === "tcp" ? 8 : transport === "ascii" ? 9 : 4;
  if (bytes.length < minimum || bytes.length > modbusFrameLimits[transport])
    throw new ProtocolFieldError(
      "frame.length",
      "Frame length is outside the Modbus limit",
    );
  if (transport === "tcp") {
    if (modbusWord(bytes, 2) !== 0)
      throw new ProtocolFieldError(
        "frame.protocolId",
        "Modbus protocol identifier must be zero",
      );
    if (modbusWord(bytes, 4) !== bytes.length - 6)
      throw new ProtocolFieldError(
        "frame.length",
        "MBAP length does not match the frame",
      );
    return {
      transactionId: modbusWord(bytes, 0),
      unitId: bytes[6]!,
      pdu: bytes.subarray(7),
    };
  }
  let payload: Uint8Array;
  if (transport === "ascii") payload = readAsciiFrame(bytes);
  else {
    payload = bytes.subarray(0, -2);
    const sum = checksumBytes(payload, "modbus", "little");
    if (sum[0] !== bytes.at(-2) || sum[1] !== bytes.at(-1))
      throw new ProtocolFieldError(
        "frame.crc",
        "Modbus RTU CRC does not match",
      );
  }
  return { unitId: payload[0]!, pdu: payload.subarray(1) };
}

export function decodeModbusFrame(
  transport: ModbusTransport,
  direction: ModbusDirection,
  bytes: Uint8Array,
): {
  packet: { unitId: number; pdu: ReturnType<typeof decodeModbusPdu> } & (
    { transactionId: number } | Record<never, never>
  );
  broadcast: boolean;
} {
  const minimum = transport === "tcp" ? 9 : transport === "ascii" ? 11 : 5;
  if (bytes.length < minimum)
    throw new ProtocolFieldError(
      "frame.length",
      "Frame length is outside the Modbus limit",
    );
  const header = decodeModbusAdu(transport, bytes);
  const pdu = decodeModbusPdu(header.pdu, direction);
  const unitId = checkUnit(
    header.unitId,
    transport,
    direction,
    pdu.functionCode,
  );
  return {
    packet: { ...header, pdu },
    broadcast: transport !== "tcp" && unitId === 0,
  };
}
