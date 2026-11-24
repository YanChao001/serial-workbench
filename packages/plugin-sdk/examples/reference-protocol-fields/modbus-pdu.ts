import { ProtocolFieldError } from "../reference-framing/protocol-fields.ts";

export type ModbusDirection = "request" | "response";

export function modbusInteger(
  value: unknown,
  min: number,
  max: number,
  path: string,
) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new ProtocolFieldError(
      path,
      `Expected an integer from ${min} to ${max}`,
    );
  return value;
}

export function modbusRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProtocolFieldError(path, "Expected an object");
  return value as Record<string, unknown>;
}

export function modbusKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
) {
  for (const key of Object.keys(record))
    if (!keys.includes(key))
      throw new ProtocolFieldError(`${path}.${key}`, "Unexpected property");
}

export function modbusWord(bytes: Uint8Array, offset: number) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint16(offset);
}

const quantityLimits = {
  1: 2000,
  2: 2000,
  3: 125,
  4: 125,
  5: 1,
  6: 1,
  15: 1968,
  16: 123,
} as const;
type FunctionCode = keyof typeof quantityLimits;
type ModbusPdu =
  | { functionCode: number; exceptionCode: number }
  | ({ functionCode: FunctionCode } & (
      | { bitBytes: number[] }
      | { address: number; quantity: number }
      | { address: number; value: number | boolean }
      | { values: number[] }
      | { address: number; values: boolean[] | number[] }
    ));

function functionCode(value: unknown): FunctionCode {
  if (typeof value === "number" && Object.hasOwn(quantityLimits, value))
    return value as FunctionCode;
  throw new ProtocolFieldError(
    "pdu.functionCode",
    "Unsupported Modbus function",
  );
}

export function isModbusWrite(functionCode: number) {
  return (
    functionCode === 5 ||
    functionCode === 6 ||
    functionCode === 15 ||
    functionCode === 16
  );
}

function words(value: number) {
  return [value >>> 8, value & 0xff];
}

function bool(value: unknown, path: string) {
  if (typeof value !== "boolean")
    throw new ProtocolFieldError(path, "Expected a boolean");
  return value;
}

function array(value: unknown, max: number, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max)
    throw new ProtocolFieldError(
      path,
      `Expected an array of 1 to ${max} items`,
    );
  return value;
}

function checkAddressRange(address: number, quantity: number) {
  if (address + quantity > 65536)
    throw new ProtocolFieldError("pdu.address", "Address range exceeds 65535");
}

export function encodeModbusPdu(
  value: unknown,
  direction: ModbusDirection,
): Uint8Array {
  const input = modbusRecord(value, "pdu");
  if (Object.hasOwn(input, "exceptionCode")) {
    modbusKeys(input, ["functionCode", "exceptionCode"], "pdu");
    if (direction !== "response")
      throw new ProtocolFieldError(
        "pdu.exceptionCode",
        "Exceptions require a response",
      );
    return Uint8Array.of(
      modbusInteger(input.functionCode, 1, 0x7f, "pdu.functionCode") | 0x80,
      modbusInteger(input.exceptionCode, 1, 255, "pdu.exceptionCode"),
    );
  }
  const fc = functionCode(input.functionCode);
  if (!isModbusWrite(fc) && direction === "response") {
    const functionIsBits = fc <= 2;
    const key = functionIsBits ? "bitBytes" : "values";
    modbusKeys(input, ["functionCode", key], "pdu");
    const values = array(input[key], functionIsBits ? 250 : 125, `pdu.${key}`);
    const payload = values.flatMap((entry, index) => {
      const number = modbusInteger(
        entry,
        0,
        functionIsBits ? 255 : 65535,
        `pdu.${key}[${index}]`,
      );
      return functionIsBits ? [number] : words(number);
    });
    return Uint8Array.of(fc, payload.length, ...payload);
  }
  const address = modbusInteger(input.address, 0, 65535, "pdu.address");
  if (fc === 5 || fc === 6) {
    modbusKeys(input, ["functionCode", "address", "value"], "pdu");
    const data =
      fc === 5
        ? bool(input.value, "pdu.value")
          ? 0xff00
          : 0
        : modbusInteger(input.value, 0, 65535, "pdu.value");
    return Uint8Array.of(fc, ...words(address), ...words(data));
  }
  const maxQuantity = quantityLimits[fc];
  if (fc <= 4 || direction === "response") {
    modbusKeys(input, ["functionCode", "address", "quantity"], "pdu");
    const quantity = modbusInteger(
      input.quantity,
      1,
      maxQuantity,
      "pdu.quantity",
    );
    checkAddressRange(address, quantity);
    return Uint8Array.of(fc, ...words(address), ...words(quantity));
  }
  modbusKeys(input, ["functionCode", "address", "values"], "pdu");
  const values = array(input.values, maxQuantity, "pdu.values");
  checkAddressRange(address, values.length);
  let payload: Uint8Array | number[];
  if (fc === 15) {
    const packed = new Uint8Array(Math.ceil(values.length / 8));
    for (const [index, value] of values.entries())
      if (bool(value, `pdu.values[${index}]`)) {
        const byte = index >>> 3;
        packed[byte] = packed[byte]! | (1 << (index % 8));
      }
    payload = packed;
  } else {
    payload = values.flatMap((entry, index) =>
      words(modbusInteger(entry, 0, 65535, `pdu.values[${index}]`)),
    );
  }
  return Uint8Array.of(
    fc,
    ...words(address),
    ...words(values.length),
    payload.length,
    ...payload,
  );
}

function requireLength(condition: boolean) {
  if (!condition)
    throw new ProtocolFieldError(
      "pdu.length",
      "Unexpected PDU length or byte count",
    );
}

function readRegisters(bytes: Uint8Array, start: number) {
  return Array.from({ length: (bytes.length - start) / 2 }, (_, index) =>
    modbusWord(bytes, start + index * 2),
  );
}

function readModbusPdu(
  bytes: Uint8Array,
  direction: ModbusDirection,
): ModbusPdu {
  requireLength(bytes.length >= 2 && bytes.length <= 253);
  const first = bytes[0]!;
  if ((first & 0x80) !== 0) {
    requireLength(bytes.length === 2);
    return { functionCode: first & 0x7f, exceptionCode: bytes[1]! };
  }
  const fc = functionCode(first);
  if (!isModbusWrite(fc) && direction === "response") {
    const count = bytes[1]!;
    requireLength(count >= 1 && count === bytes.length - 2);
    if (fc <= 2)
      return { functionCode: fc, bitBytes: Array.from(bytes.subarray(2)) };
    requireLength(count % 2 === 0);
    return { functionCode: fc, values: readRegisters(bytes, 2) };
  }
  const writesMany = (fc === 15 || fc === 16) && direction === "request";
  requireLength(writesMany ? bytes.length >= 7 : bytes.length === 5);
  const address = modbusWord(bytes, 1);
  const data = modbusWord(bytes, 3);
  if (fc === 5) {
    if (data !== 0 && data !== 0xff00)
      throw new ProtocolFieldError(
        "pdu.value",
        "Invalid write-single-coil value",
      );
    return { functionCode: fc, address, value: data === 0xff00 };
  }
  if (fc === 6) return { functionCode: fc, address, value: data };
  if (!writesMany) return { functionCode: fc, address, quantity: data };
  const count = bytes[5]!;
  requireLength(count === bytes.length - 6);
  if (fc === 15) {
    requireLength(
      data >= 1 && data <= quantityLimits[15] && count === Math.ceil(data / 8),
    );
    const values = Array.from({ length: data }, (_, index) =>
      Boolean(bytes[6 + (index >>> 3)]! & (1 << (index % 8))),
    );
    return { functionCode: fc, address, values };
  }
  requireLength(data >= 1 && data <= quantityLimits[16] && count === data * 2);
  return { functionCode: fc, address, values: readRegisters(bytes, 6) };
}

export function decodeModbusPdu(bytes: Uint8Array, direction: ModbusDirection) {
  const decoded = readModbusPdu(bytes, direction);
  const canonical = encodeModbusPdu(decoded, direction);
  if (
    canonical.length !== bytes.length ||
    canonical.some((byte, index) => byte !== bytes[index])
  )
    throw new ProtocolFieldError(
      "pdu.bytes",
      "Invalid reserved bits in the PDU",
    );
  return decoded;
}
