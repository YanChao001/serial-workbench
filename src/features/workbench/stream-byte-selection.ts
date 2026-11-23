import { parseHex } from "@serial-workbench/host-client";
import type { StreamHexSelection } from "./stream-hex-selection";

export type StreamByteRow = {
  hexSource?: string;
  hexLane?: string;
  offset?: string;
  byteEnd?: string;
  hex?: string;
};

type StreamByteSegment = { rowIndex: number; start: bigint; end: bigint };

function containsOffset(
  row: StreamByteRow,
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

export function readStreamByteSelection(
  rows: readonly StreamByteRow[],
  selection: StreamHexSelection,
  limit: number,
) {
  const size = selection.end.offset - selection.start.offset;
  if (size < 1n || size > BigInt(limit)) return;
  const first = rows.findIndex((row) => containsOffset(row, selection.start));
  if (first < 0) return;
  const last = rows.findIndex(
    (row, index) => index >= first && containsOffset(row, selection.end),
  );
  if (last < first) return;

  const lane = rows[first]?.hexLane;
  const bytes = new Uint8Array(Number(size));
  const segments: StreamByteSegment[] = [];
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
      segments.push({ rowIndex: index, start: position, end: stop });
    }
    position = stop;
  }
  if (position !== selection.end.offset) return;
  return { bytes, offset: selection.start.offset, segments };
}
