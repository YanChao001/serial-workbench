export const CHECKSUM_ALGORITHMS = [
  { value: "sum", label: "Sum-8" },
  { value: "xor", label: "XOR-8" },
  { value: "modbus", label: "CRC-16/Modbus" },
  { value: "ccitt", label: "CRC-16/CCITT-FALSE" },
  { value: "crc32", label: "CRC-32/ISO-HDLC" },
] as const;

export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number]["value"];
export type ChecksumOrder = "little" | "big";

export type SendChecksum = Readonly<{
  algorithm: ChecksumAlgorithm | "none";
  order: ChecksumOrder;
  includeEnding: boolean;
  start: string;
  end: string;
}>;

export const DEFAULT_SEND_CHECKSUM: SendChecksum = {
  algorithm: "none",
  order: "little",
  includeEnding: false,
  start: "",
  end: "",
};

function reflectedCrc(
  bytes: Uint8Array,
  initial: number,
  polynomial: number,
): number {
  let value = initial;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      value = (value >>> 1) ^ (value & 1 ? polynomial : 0);
  }
  return value;
}

function ccittFalse(bytes: Uint8Array): number {
  let value = 0xffff;
  for (const byte of bytes) {
    value ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      value = ((value << 1) & 0xffff) ^ (value & 0x8000 ? 0x1021 : 0);
  }
  return value;
}

function checksumBytes(
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
      const value =
        algorithm === "modbus"
          ? reflectedCrc(bytes, 0xffff, 0xa001)
          : ccittFalse(bytes);
      const result = new Uint8Array(2);
      new DataView(result.buffer).setUint16(0, value, order === "little");
      return result;
    }
    case "crc32": {
      const value = reflectedCrc(bytes, 0xffffffff, 0xedb88320) ^ 0xffffffff;
      const result = new Uint8Array(4);
      new DataView(result.buffer).setUint32(0, value, order === "little");
      return result;
    }
  }
}

function byteOffset(input: string, fallback: number): number {
  if (input === "") return fallback;
  return /^\d+$/.test(input) ? Number(input) : Number.NaN;
}

/** 校验选段来自已编码字节，结果附加在完整草稿和行尾之后。 */
export function appendSendChecksum(
  bytes: Uint8Array,
  bodyLength: number,
  settings: SendChecksum & { algorithm: ChecksumAlgorithm },
): { bytes: Uint8Array; checksum: Uint8Array } | null {
  const sourceLength = settings.includeEnding ? bytes.length : bodyLength;
  const start = byteOffset(settings.start, 0);
  const end = byteOffset(settings.end, sourceLength);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= end ||
    end > sourceLength
  )
    return null;

  const checksum = checksumBytes(
    bytes.subarray(start, end),
    settings.algorithm,
    settings.order,
  );
  const result = new Uint8Array(bytes.length + checksum.length);
  result.set(bytes);
  result.set(checksum, bytes.length);
  return { bytes: result, checksum };
}
