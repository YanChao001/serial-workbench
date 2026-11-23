import type { StreamHexSelection } from "./stream-hex-selection";
import {
  readStreamByteSelection,
  type StreamByteRow,
} from "./stream-byte-selection";

const MAX_NUMBER_BYTES = 8;
export const NUMBER_WIDTHS = [1, 2, 4, MAX_NUMBER_BYTES] as const;
export type NumberWidth = (typeof NUMBER_WIDTHS)[number];
export type StreamNumberSample = { bytes: Uint8Array; offset: bigint };

export function streamNumberSample(
  rows: readonly StreamByteRow[],
  selection: StreamHexSelection,
): StreamNumberSample | undefined {
  const sample = readStreamByteSelection(rows, selection, MAX_NUMBER_BYTES);
  if (sample) return { bytes: sample.bytes, offset: sample.offset };
}

export function interpretStreamNumber(
  bytes: Uint8Array,
  width: NumberWidth,
  littleEndian: boolean,
) {
  const bits = width * 8;
  let unsigned = 0n;
  for (let index = 0; index < width; index++) {
    const byte = bytes[littleEndian ? width - 1 - index : index]!;
    unsigned = (unsigned << 8n) | BigInt(byte);
  }
  const signed = BigInt.asIntN(bits, unsigned);
  const view = new DataView(bytes.buffer, bytes.byteOffset, width);
  const float =
    width === 4
      ? view.getFloat32(0, littleEndian)
      : width === 8
        ? view.getFloat64(0, littleEndian)
        : undefined;
  return {
    unsigned: unsigned.toString(),
    signed: signed.toString(),
    hex: unsigned
      .toString(16)
      .toUpperCase()
      .padStart(width * 2, "0"),
    binary: unsigned.toString(2).padStart(bits, "0"),
    octal: unsigned.toString(8).padStart(Math.ceil(bits / 3), "0"),
    float:
      float === undefined
        ? undefined
        : Object.is(float, -0)
          ? "-0"
          : float.toString(),
  };
}
