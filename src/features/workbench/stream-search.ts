import { compileStreamTextPattern } from "./stream-text-pattern";
import type { StreamItem, TextEncoding } from "@serial-workbench/contracts";
import {
  createTextDecoder,
  prepareTextEncoding,
  encodedCharacterBytes,
  encodeText,
} from "@/lib/text-encoding";
import { encodeSend } from "@serial-workbench/host-client";
import {
  streamLiteralMatches,
  streamSearchChunks,
  type StreamMatch,
  type StreamDirection,
} from "./stream-model";
export type StreamSearchOptions = {
  encoding?: TextEncoding;
  transmitEncoding?: TextEncoding;
  direction?: StreamDirection | "all";
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};
export type StreamSearchResult = {
  matches: StreamMatch[];
  error?: "syntax" | "encoding" | "limit";
  partial?: true;
};
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 10000;
const word = /[\p{L}\p{N}_]/u;
export function sourceInSearchDirection(
  item: StreamItem,
  direction: StreamSearchOptions["direction"] = "rx",
): boolean {
  if (item.kind === "reader_gap") return true;
  const kind = item.event.kind;
  if (kind === "rx") return direction !== "tx";
  if (kind === "tx" || kind === "tx_intent") return direction !== "rx";
  return (
    kind === "gap" || kind === "configuration_boundary" || kind === "lifecycle"
  );
}

export async function prepareStreamSearchEncoding(
  options: StreamSearchOptions,
) {
  if (options.direction !== "tx")
    await prepareTextEncoding(options.encoding ?? "utf-8");
  if (options.direction === "tx" || options.direction === "all")
    await prepareTextEncoding(options.transmitEncoding ?? "utf-8");
}

export function withinSearchBudget(
  items: readonly StreamItem[],
  direction: StreamSearchOptions["direction"] = "rx",
): boolean {
  let bytes = 0;
  for (const item of items) {
    if (item.kind !== "source") continue;
    const event = item.event;
    if (
      event.kind !== "rx" &&
      event.kind !== "tx" &&
      event.kind !== "tx_intent"
    )
      continue;
    if (!sourceInSearchDirection(item, direction)) continue;
    const encoded = event.payload.bytesBase64;
    bytes +=
      (encoded.length / 4) * 3 -
      (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (bytes > MAX_BYTES) return false;
  }
  return true;
}
export function searchStream(
  items: readonly StreamItem[],
  query: string,
  mode: "text" | "hex",
  options: StreamSearchOptions,
): StreamSearchResult {
  if (!query) return { matches: [] };
  if (!withinSearchBudget(items, options.direction))
    return { matches: [], error: "limit" };
  if (options.direction !== "all")
    return searchLane(items, query, mode, options, options.direction ?? "rx");

  const receive = searchLane(items, query, mode, options, "rx");
  if (receive.error === "syntax") return receive;
  const send = searchLane(items, query, mode, options, "tx");
  const matches = [...receive.matches, ...send.matches].sort(
    (left, right) => left.itemIndex - right.itemIndex,
  );
  const incomplete =
    receive.partial ||
    send.partial ||
    receive.error ||
    send.error ||
    matches.length > MAX_MATCHES;
  if (!matches.length && (receive.error || send.error))
    return {
      matches,
      error: receive.error ?? send.error,
    };
  return {
    matches: matches.slice(0, MAX_MATCHES),
    ...(incomplete ? { partial: true } : {}),
  };
}

function searchLane(
  items: readonly StreamItem[],
  query: string,
  mode: "text" | "hex",
  options: StreamSearchOptions,
  direction: StreamDirection,
): StreamSearchResult {
  const matches: StreamMatch[] = [];
  const includeSpan = options.direction !== undefined;
  if (mode === "hex") {
    try {
      for (const match of streamLiteralMatches(
        items,
        encodeSend(query, "hex", { kind: "none" }),
        direction,
        includeSpan,
      )) {
        if (matches.length === MAX_MATCHES) return { matches, partial: true };
        matches.push(match);
      }
      return { matches };
    } catch {
      return { matches, error: "syntax" };
    }
  }
  let pattern: RegExp;
  try {
    pattern = compileStreamTextPattern(
      query,
      options.regex,
      options.caseSensitive,
    );
  } catch {
    return { matches, error: "syntax" };
  }
  type Group = {
    start: bigint;
    length: number;
    chunks: Uint8Array[];
    origins: { offset: number; itemIndex: number }[];
  };
  const groups: Group[] = [];
  let group: Group | undefined;
  let total = 0;
  for (const chunk of streamSearchChunks(items, direction)) {
    total += chunk.bytes.length;
    if (total > MAX_BYTES) return { matches: [], error: "limit" };
    if (!chunk.continuous || !group) {
      group = { start: chunk.start, length: 0, chunks: [], origins: [] };
      groups.push(group);
    }
    group.origins.push({ offset: group.length, itemIndex: chunk.itemIndex });
    group.chunks.push(chunk.bytes);
    group.length += chunk.bytes.length;
  }
  let encoding = false;
  const codec =
    (direction === "rx" ? options.encoding : options.transmitEncoding) ??
    "utf-8";
  for (const group of groups) {
    const bytes = new Uint8Array(group.length);
    let at = 0;
    for (const chunk of group.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    let text: string;
    try {
      text = createTextDecoder(codec, { fatal: true, ignoreBOM: true }).decode(
        bytes,
        {
          stream: true,
        },
      );
      // 拒绝不能原样回到相同字节的映射，避免返回错误的查找偏移。
      if (codec !== "utf-8") {
        const original = encodeText(text, codec);
        if (original.some((byte, index) => byte !== bytes[index]))
          throw new Error("Noncanonical encoding");
      }
    } catch {
      encoding = true;
      continue;
    }
    const offsets = new Uint32Array(text.length + 1);
    let byteOffset = 0;
    for (let i = 0; i < text.length;) {
      const code = text.codePointAt(i)!;
      offsets[i] = byteOffset;
      const length = code > 65535 ? 2 : 1;
      if (length === 2) offsets[i + 1] = byteOffset;
      byteOffset += encodedCharacterBytes(code, codec);
      i += length;
      offsets[i] = byteOffset;
    }
    pattern.lastIndex = 0;
    let found: RegExpExecArray | null;
    let origin = 0;
    let lastOrigin = 0;
    while ((found = pattern.exec(text)) !== null) {
      const index = found.index,
        end = index + found[0].length;
      if (!found[0].length) {
        const cp = text.codePointAt(index);
        pattern.lastIndex = index + (cp !== undefined && cp > 65535 ? 2 : 1);
        if (pattern.lastIndex > text.length) break;
        continue;
      }
      const before = Array.from(text.slice(Math.max(0, index - 2), index)).at(
        -1,
      );
      const after = Array.from(text.slice(end, end + 2))[0];
      if (
        options.wholeWord &&
        ((before && word.test(before)) || (after && word.test(after)))
      )
        continue;
      const offset = offsets[index]!;
      while (
        origin + 1 < group.origins.length &&
        group.origins[origin + 1]!.offset <= offset
      )
        origin++;
      const endOffset = offsets[end]!;
      if (matches.length === MAX_MATCHES) return { matches, partial: true };
      lastOrigin = Math.max(lastOrigin, origin);
      while (
        lastOrigin + 1 < group.origins.length &&
        group.origins[lastOrigin + 1]!.offset < endOffset
      )
        lastOrigin++;
      matches.push({
        offset: (group.start + BigInt(offset)).toString(),
        end: (group.start + BigInt(endOffset)).toString(),
        itemIndex: group.origins[origin]!.itemIndex,
        ...(includeSpan
          ? {
              span: {
                lastItemIndex: group.origins[lastOrigin]!.itemIndex,
                direction,
              },
            }
          : {}),
      });
    }
  }
  return {
    matches,
    ...(encoding
      ? matches.length
        ? { partial: true }
        : { error: "encoding" }
      : {}),
  };
}
