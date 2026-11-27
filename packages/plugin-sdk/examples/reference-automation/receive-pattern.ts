import type { SourceRange } from "@serial-workbench/plugin-sdk/node";
import type { ReceiveObserver } from "./session-response.ts";

export type ReceiveEvent = Parameters<ReceiveObserver>[0];
export type ReceiveMatch = {
  source: SourceRange;
  remainder?: ReceiveEvent;
};

export function observePattern(
  pattern: Buffer,
  onMatch?: (match: ReceiveMatch) => void,
): ReceiveObserver {
  let suffix: Buffer = Buffer.alloc(0);
  let nextByte: string | undefined;
  let ranges: { end: bigint; eventSeq: string }[] = [];
  return (event) => {
    const { payload } = event;
    const { byteStart, byteEnd, bytesBase64 } = payload;
    const start = BigInt(byteStart);
    const end = BigInt(byteEnd);
    const bytes = Buffer.from(bytesBase64, "base64");
    if (
      (nextByte !== undefined && nextByte !== byteStart) ||
      end - start !== BigInt(bytes.length)
    )
      return "source_changed";
    nextByte = byteEnd;
    if (onMatch) ranges.push({ end, eventSeq: event.eventSeq });
    const input = Buffer.concat([suffix, bytes]);
    const first = input.indexOf(pattern);
    if (first >= 0) {
      if (onMatch) {
        const matchStart = start + BigInt(first - suffix.length);
        const matchEnd = matchStart + BigInt(pattern.length);
        const firstEvent = ranges.find((range) => range.end > matchStart);
        if (!firstEvent) return "source_changed";
        const offset = Number(matchEnd - start);
        onMatch({
          source: {
            hostId: event.hostId,
            sessionId: event.sessionId,
            sessionEpoch: event.sessionEpoch,
            direction: "rx",
            eventStart: firstEvent.eventSeq,
            eventEnd: String(BigInt(event.eventSeq) + 1n),
            byteStart: String(matchStart),
            byteEnd: String(matchEnd),
          },
          ...(offset < bytes.length
            ? {
                remainder: {
                  ...event,
                  payload: {
                    ...payload,
                    byteStart: String(matchEnd),
                    bytesBase64: bytes.subarray(offset).toString("base64"),
                  },
                },
              }
            : {}),
        });
      }
      return "condition_met";
    }
    suffix = input.subarray(Math.max(0, input.length - (pattern.length - 1)));
    if (onMatch) {
      const suffixStart = end - BigInt(suffix.length);
      ranges = ranges.filter((range) => range.end > suffixStart);
    }
    return undefined;
  };
}
