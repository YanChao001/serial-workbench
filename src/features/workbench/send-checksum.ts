import {
  checksumBytes,
  type ChecksumAlgorithm,
  type ChecksumOrder,
} from "../../../packages/plugin-sdk/src/wire-checksum";

export const CHECKSUM_ALGORITHMS = [
  { value: "sum", label: "Sum-8" },
  { value: "xor", label: "XOR-8" },
  { value: "modbus", label: "CRC-16/Modbus" },
  { value: "ccitt", label: "CRC-16/CCITT-FALSE" },
  { value: "crc32", label: "CRC-32/ISO-HDLC" },
] as const;

export type { ChecksumAlgorithm, ChecksumOrder };

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
