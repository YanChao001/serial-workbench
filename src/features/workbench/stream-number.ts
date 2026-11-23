import { parseHex } from "@serial-workbench/host-client";
import type { StreamHexSelection } from "./stream-hex-selection";

const MAX_NUMBER_BYTES = 8;
export const NUMBER_WIDTHS = [1, 2, 4, MAX_NUMBER_BYTES] as const;
export type NumberWidth = (typeof NUMBER_WIDTHS)[number];

type StreamNumberRow = {
  hexSource?: string;
  hexLane?: string;
  offset?: string;
  byteEnd?: string;
  hex?: string;
};

export type StreamNumberSample = { bytes: Uint8Array; offset: bigint };

function containsOffset(
  row: StreamNumberRow,
  point: StreamHexSelection["start"],
) {
  return (
    row.hexSource === point.source &&
    row.offset !== undefined &&
    row.byteEnd !== undefined &&
    point.offset >= BigInt(row.offset) &&
    point.offset <= BigInt(row.byteEnd)
  );
}

export function streamNumberSample(
  rows: readonly StreamNumberRow[],
  selection: StreamHexSelection,
): StreamNumberSample | undefined {
  const size = selection.end.offset - selection.start.offset;
  if (size < 1n || size > BigInt(MAX_NUMBER_BYTES)) return;
  const first = rows.findIndex((row) => containsOffset(row, selection.start));
  if (first < 0) return;
  const last = rows.findIndex(
    (row, index) => index >= first && containsOffset(row, selection.end),
  );
  if (last < first) return;

  const lane = rows[first]?.hexLane;
  const bytes = new Uint8Array(Number(size));
  let position = selection.start.offset;
  for (let index = first; index <= last; index++) {
    const row = rows[index];
    if (
      !row?.hex ||
      !lane ||
      row.hexLane !== lane ||
      row.offset === undefined ||
      row.byteEnd === undefined
    )
      return;
    const start = BigInt(row.offset);
    const end = BigInt(row.byteEnd);
    if ((index !== first && start !== position) || position > end) return;

    const stop = end < selection.end.offset ? end : selection.end.offset;
    if (stop > position) {
      const range = row.hex.slice(
        Number(position - start) * 3,
        Number(stop - start) * 3 - 1,
      );
      const part = parseHex(range);
      if (part.length !== Number(stop - position)) return;
      bytes.set(part, Number(position - selection.start.offset));
    }
    position = stop;
  }
  if (position !== selection.end.offset) return;
  return { bytes, offset: selection.start.offset };
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
