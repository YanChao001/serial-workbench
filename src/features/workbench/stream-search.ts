import type { StreamItem, TextEncoding } from "@serial-workbench/contracts";
import {
  createTextDecoder,
  encodedCharacterBytes,
  encodeText,
} from "@/lib/text-encoding";
import { encodeSend } from "@serial-workbench/host-client";
import {
  streamLiteralMatches,
  streamSearchChunks,
  type StreamMatch,
} from "./stream-model";
export type StreamSearchOptions = {
  encoding?: TextEncoding;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
};
export type StreamSearchResult = {
  matches: StreamMatch[];
  error?: "syntax" | "encoding" | "limit";
};
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MATCHES = 10000;
const word = /[\p{L}\p{N}_]/u;
export function withinSearchBudget(items: readonly StreamItem[]): boolean {
  let bytes = 0;
  for (const item of items) {
    if (item.kind !== "source" || item.event.kind !== "rx") continue;
    const encoded = item.event.payload.bytesBase64;
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
  const matches: StreamMatch[] = [];
  if (!query) return { matches };
  if (!withinSearchBudget(items)) return { matches, error: "limit" };
  if (mode === "hex") {
    try {
      for (const match of streamLiteralMatches(
        items,
        encodeSend(query, "hex", { kind: "none" }),
      )) {
        matches.push(match);
        if (matches.length >= MAX_MATCHES) break;
      }
      return { matches };
    } catch {
      return { matches, error: "syntax" };
    }
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(
      options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      `gu${options.caseSensitive ? "" : "i"}`,
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
  for (const chunk of streamSearchChunks(items)) {
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
  const codec = options.encoding ?? "utf-8";
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
      matches.push({
        offset: (group.start + BigInt(offset)).toString(),
        end: (group.start + BigInt(offsets[end]!)).toString(),
        itemIndex: group.origins[origin]!.itemIndex,
      });
      if (matches.length >= MAX_MATCHES) return { matches };
    }
  }
  return {
    matches,
    ...(!matches.length && encoding ? { error: "encoding" as const } : {}),
  };
}
