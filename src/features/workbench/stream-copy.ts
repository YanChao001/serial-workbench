import type {
  EventTime,
  StreamItem,
  TextEncoding,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { bytesToBase64 } from "@/lib/base64";
import { createTextDecoder } from "@/lib/text-encoding";
import type { StreamHexSelection } from "./stream-hex-selection";
import {
  readStreamByteSelection,
  type StreamByteRow,
} from "./stream-byte-selection";

export const STREAM_COPY_LIMIT = 65_536;
export const STREAM_COPY_FORMATS = [
  "text",
  "hex",
  "timed",
  "c",
  "python",
  "base64",
] as const;
export type StreamCopyFormat = (typeof STREAM_COPY_FORMATS)[number];

type TimedPart = { start: number; end: number; time: EventTime };

export type StreamCopySample = {
  bytes: Uint8Array;
  offset: bigint;
  direction: "RX" | "TX";
  parts: TimedPart[];
};

export function readStreamCopySample(
  rows: readonly (StreamByteRow & { itemIndexes: number[] })[],
  projected: readonly { item: StreamItem; itemIndex: number }[],
  selection: StreamHexSelection,
): StreamCopySample | undefined {
  const raw = readStreamByteSelection(rows, selection, STREAM_COPY_LIMIT);
  if (!raw) return;
  const items = new Map(
    projected.map(({ item, itemIndex }) => [itemIndex, item]),
  );
  const parts: TimedPart[] = [];
  let direction: StreamCopySample["direction"] | undefined;
  for (const segment of raw.segments) {
    let position = segment.start;
    for (const index of rows[segment.rowIndex]!.itemIndexes) {
      const item = items.get(index);
      if (item?.kind !== "source") return;
      const event = item.event;
      if (
        event.kind !== "rx" &&
        event.kind !== "tx" &&
        event.kind !== "tx_intent"
      )
        return;
      const current = event.kind === "rx" ? "RX" : "TX";
      if (direction && current !== direction) return;
      direction = current;
      const start = BigInt(event.payload.byteStart);
      const end = BigInt(event.payload.byteEnd);
      if (end <= position) continue;
      if (start > position) return;
      const stop = end < segment.end ? end : segment.end;
      parts.push({
        start: Number(position - raw.offset),
        end: Number(stop - raw.offset),
        time: event.time,
      });
      position = stop;
      if (position === segment.end) break;
    }
    if (position !== segment.end) return;
  }
  if (!direction) return;
  return { bytes: raw.bytes, offset: raw.offset, direction, parts };
}

export function formatStreamCopy(
  sample: StreamCopySample,
  format: StreamCopyFormat,
  encoding: TextEncoding,
  timeSource: "source" | "received",
): string {
  const { bytes, direction, offset, parts } = sample;
  switch (format) {
    case "text":
      return createTextDecoder(encoding).decode(bytes);
    case "hex":
      return formatHex(bytes);
    case "base64":
      return bytesToBase64(bytes);
    case "c": {
      const lines: string[] = [];
      for (let start = 0; start < bytes.length; start += 16) {
        const values = formatHex(bytes.subarray(start, start + 16))
          .split(" ")
          .map((pair) => "0x" + pair);
        lines.push("  " + values.join(", ") + ",");
      }
      return "const unsigned char data[] = {\n" + lines.join("\n") + "\n};";
    }
    case "python":
      return (
        'b"' +
        formatHex(bytes)
          .split(" ")
          .map((pair) => "\\x" + pair)
          .join("") +
        '"'
      );
    case "timed": {
      const decoder = createTextDecoder(encoding);
      return parts
        .map(({ start, end, time }, index) => {
          const timestamp =
            timeSource === "source"
              ? (time.sourceWallTime ?? time.receivedWallTime)
              : time.receivedWallTime;
          const text = decoder.decode(bytes.subarray(start, end), {
            stream: index + 1 < parts.length,
          });
          return [
            timestamp,
            direction,
            (offset + BigInt(start)).toString(),
            JSON.stringify(text),
          ].join("\t");
        })
        .join("\n");
    }
  }
}
