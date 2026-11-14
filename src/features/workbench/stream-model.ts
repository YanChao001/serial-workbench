import type { StreamItem } from "@serial-workbench/contracts";
import { encodeSend } from "@serial-workbench/host-client";
import { streamSourceKey } from "@/lib/stream-source";
export { streamSourceKey } from "@/lib/stream-source";

export type StreamMatch = { offset: string; end: string; itemIndex: number };

export function decodeBytes(bytesBase64: string): Uint8Array {
  return Uint8Array.from(atob(bytesBase64), (byte) => byte.charCodeAt(0));
}

/** 同一发送块的回执更新原行；文件任务的不同块保留各自字节和结果。 */
export function projectStreamItems(items: readonly StreamItem[]) {
  const rows: { item: StreamItem; itemIndex: number }[] = [];
  const txRows = new Map<string, number>();
  items.forEach((item, itemIndex) => {
    if (
      item.kind === "source" &&
      (item.event.kind === "tx_intent" || item.event.kind === "tx")
    ) {
      const { event } = item;
      const key = JSON.stringify([
        event.hostId,
        event.instanceEpoch,
        event.sessionId,
        event.sessionEpoch,
        event.payload.operationId,
        event.payload.byteStart,
        event.payload.byteEnd,
      ]);
      const previous = txRows.get(key);
      if (previous !== undefined) {
        if (event.kind === "tx")
          rows[previous] = { item, itemIndex: rows[previous]!.itemIndex };
        return;
      }
      txRows.set(key, rows.length);
    }
    rows.push({ item, itemIndex });
  });
  return rows;
}

export function findNextStreamMatch(
  items: readonly StreamItem[],
  input: string,
  mode: "text" | "hex",
  afterOffset?: string,
): StreamMatch | null {
  const needle = encodeSend(input, mode, { kind: "none" });
  const after = afterOffset === undefined ? undefined : BigInt(afterOffset);
  let first: StreamMatch | null = null;
  for (const match of streamLiteralMatches(items, needle)) {
    first ??= match;
    if (after === undefined || BigInt(match.offset) > after) return match;
  }
  return first;
}

/** 统一接收连续性边界，文本、HEX 与正则搜索共用。 */
export function* streamSearchChunks(items: readonly StreamItem[]) {
  let previousEnd: bigint | undefined;
  let previousSource = "";
  for (const [itemIndex, item] of items.entries()) {
    if (
      item.kind === "reader_gap" ||
      item.event.kind === "gap" ||
      item.event.kind === "configuration_boundary" ||
      item.event.kind === "lifecycle"
    ) {
      previousEnd = undefined;
      continue;
    }
    if (item.event.kind !== "rx") continue;
    const event = item.event;
    const source = JSON.stringify([
      streamSourceKey(event),
      event.configurationRevision,
    ]);
    const start = BigInt(event.payload.byteStart);
    yield {
      itemIndex,
      start,
      continuous: start === previousEnd && source === previousSource,
      bytes: decodeBytes(event.payload.bytesBase64),
    };
    previousEnd = BigInt(event.payload.byteEnd);
    previousSource = source;
  }
}

/** 惰性 KMP：下一项可提前停止，完整检索也只扫描一次。 */
export function* streamLiteralMatches(
  items: readonly StreamItem[],
  needle: Uint8Array,
): Generator<StreamMatch> {
  if (!needle.length) return;
  // KMP 保留已匹配前缀；重复字节的长查询也只线性扫描接收数据。
  const prefixes = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index++) {
    while (matched > 0 && needle[index] !== needle[matched])
      matched = prefixes[matched - 1]!;
    if (needle[index] === needle[matched]) matched++;
    prefixes[index] = matched;
  }
  // 环形记录原始块归属，跨块命中仍定位匹配首字节所在的块。
  const origins = new Uint32Array(needle.length);
  const needleBytes = BigInt(needle.length);
  let ringPosition = 0;
  let matched = 0;
  const reset = () => {
    matched = 0;
    ringPosition = 0;
  };
  for (const { itemIndex, start, bytes, continuous } of streamSearchChunks(
    items,
  )) {
    if (!continuous) reset();
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]!;
      origins[ringPosition] = itemIndex;
      ringPosition = (ringPosition + 1) % needle.length;
      while (matched > 0 && byte !== needle[matched])
        matched = prefixes[matched - 1]!;
      if (byte === needle[matched]) matched++;
      if (matched === needle.length) {
        const end = start + BigInt(index + 1);
        const offset = end - needleBytes;
        yield {
          offset: offset.toString(),
          end: end.toString(),
          itemIndex: origins[ringPosition]!,
        };
        matched = prefixes[matched - 1]!;
      }
    }
  }
}
