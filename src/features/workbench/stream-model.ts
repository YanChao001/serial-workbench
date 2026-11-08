import type { StreamItem } from "@serial-workbench/contracts";
import { encodeSend } from "@serial-workbench/host-client";

export type StreamMatch = { offset: string; end: string; itemIndex: number };
export function decodeBytes(bytesBase64: string): Uint8Array {
  return Uint8Array.from(atob(bytesBase64), (byte) => byte.charCodeAt(0));
}

export function findStreamMatches(
  items: readonly StreamItem[],
  input: string,
  mode: "text" | "hex",
): StreamMatch[] {
  const needle = encodeSend(input, mode, { kind: "none" });
  if (!needle.length) return [];
  const matches: StreamMatch[] = [];
  let pending: { byte: number; offset: bigint; itemIndex: number }[] = [];
  let previousEnd: bigint | undefined;
  let previousSession = "";
  items.forEach((item, itemIndex) => {
    if (item.kind === "reader_gap" || item.event.kind === "gap") {
      pending = [];
      previousEnd = undefined;
      return;
    }
    if (item.event.kind !== "rx") return;
    const { event } = item;
    const session = `${event.sessionId}:${event.sessionEpoch}`;
    const start = BigInt(event.payload.byteStart);
    if (start !== previousEnd || session !== previousSession) pending = [];
    const bytes = decodeBytes(event.payload.bytesBase64);
    for (let index = 0; index < bytes.length; index++) {
      pending.push({
        byte: bytes[index]!,
        offset: start + BigInt(index),
        itemIndex,
      });
      if (pending.length > needle.length) pending.shift();
      if (
        pending.length === needle.length &&
        pending.every((value, position) => value.byte === needle[position])
      ) {
        const first = pending[0]!;
        matches.push({
          offset: first.offset.toString(),
          end: (start + BigInt(index) + 1n).toString(),
          itemIndex: first.itemIndex,
        });
      }
    }
    previousEnd = BigInt(event.payload.byteEnd);
    previousSession = session;
  });
  return matches;
}
