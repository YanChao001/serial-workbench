import { crcValue, type CrcParameters } from "./crc.ts";

export const CHECKSUM_WIDTHS = {
  sum: 1,
  xor: 1,
  modbus: 2,
  ccitt: 2,
  crc32: 4,
} as const;

export type ChecksumAlgorithm = keyof typeof CHECKSUM_WIDTHS;
export type ChecksumOrder = "little" | "big";

const wireCrc = {
  modbus: {
    width: 16,
    polynomial: 0x8005,
    initial: 0xffff,
    reflectInput: true,
    reflectOutput: true,
    finalXor: 0,
  },
  ccitt: {
    width: 16,
    polynomial: 0x1021,
    initial: 0xffff,
    reflectInput: false,
    reflectOutput: false,
    finalXor: 0,
  },
  crc32: {
    width: 32,
    polynomial: 0x04c11db7,
    initial: 0xffffffff,
    reflectInput: true,
    reflectOutput: true,
    finalXor: 0xffffffff,
  },
} satisfies Record<"modbus" | "ccitt" | "crc32", CrcParameters>;

export function checksumBytes(
  bytes: Uint8Array,
  algorithm: ChecksumAlgorithm,
  order: ChecksumOrder,
): Uint8Array {
  switch (algorithm) {
    case "sum":
      return Uint8Array.of(bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0));
    case "xor":
      return Uint8Array.of(bytes.reduce((xor, byte) => xor ^ byte, 0));
    case "modbus":
    case "ccitt": {
      const value = crcValue(bytes, wireCrc[algorithm]);
      const result = new Uint8Array(2);
      new DataView(result.buffer).setUint16(0, value, order === "little");
      return result;
    }
    case "crc32": {
      const value = crcValue(bytes, wireCrc[algorithm]);
      const result = new Uint8Array(4);
      new DataView(result.buffer).setUint32(0, value, order === "little");
      return result;
    }
  }
}
