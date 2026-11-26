import type {
  RawEvent,
  StreamItem,
  TextEncoding,
} from "@serial-workbench/contracts";
import { createTextDecoder } from "@/lib/text-encoding";
import { receiveTextSample } from "./encoding-sample";
import { remapCharacters, type CharacterRemapRules } from "./character-remap";
import { streamEventBookmark } from "./stream-location";
import { sliceRawBytes, streamSourceKey } from "./stream-model";

const sourceByteLimit = 64 * 1024;
const sourceEventLimit = 256;
const displayTextLimit = 128 * 1024;
type Receive = Extract<RawEvent, { kind: "rx" }>;

type Segment = {
  kind: "segment";
  first: Receive;
  firstItem: number;
  last: Receive;
  byteStart: bigint;
  byteEnd: bigint;
  owner: string;
  messageEnd: boolean;
  nextFragment?: bigint;
  decoder: ReturnType<typeof createTextDecoder>;
  decoded: string[];
};
type Boundary = { kind: "gap"; key: number };

export type MappedReceiveRow =
  | Boundary
  | {
      kind: "rx";
      reference: string;
      firstItem: number;
      start: string;
      end: string;
      firstEvent: string;
      lastEvent: string;
      result: ReturnType<typeof remapCharacters>;
    };

function nextWindow(items: readonly StreamItem[]) {
  let first = Math.max(0, items.length - sourceEventLimit);
  let skip = 0n;
  let remaining = BigInt(sourceByteLimit);
  for (let index = items.length - 1; index >= first; index--) {
    const item = items[index];
    if (item?.kind !== "source" || item.event.kind !== "rx") continue;
    const { byteStart, byteEnd, message } = item.event.payload;
    if (message?.messageType === "binary") continue;
    const length = BigInt(byteEnd) - BigInt(byteStart);
    if (length > remaining) {
      first = remaining > 0n ? index : index + 1;
      skip = remaining > 0n ? length - remaining : 0n;
      break;
    }
    remaining -= length;
  }
  return { first, skip };
}

export function mappedReceiveEncodingSample(items: readonly StreamItem[]) {
  return receiveTextSample(items.slice(nextWindow(items).first)).bytes;
}

function sourceOwner(event: Receive) {
  const { message } = event.payload;
  return JSON.stringify([
    streamSourceKey(event),
    event.configurationRevision,
    event.time.clockId,
    message?.messageId,
    message?.messageType,
    message?.messageLength,
  ]);
}

function segmentStart(
  items: readonly StreamItem[],
  index: number,
  event: Receive,
  owner: string,
): bigint {
  let start = BigInt(event.payload.byteStart);
  if (event.payload.message)
    return start - BigInt(event.payload.message.fragmentOffset);
  // 只回看元数据，判断窗口裁剪前连续编码单元的起始位置。
  for (let prior = index - 1; prior >= 0; prior--) {
    const item = items[prior]!;
    if (
      item.kind === "reader_gap" ||
      item.event.kind === "gap" ||
      item.event.kind === "configuration_boundary" ||
      item.event.kind === "lifecycle"
    )
      break;
    if (item.event.kind !== "rx") continue;
    if (
      sourceOwner(item.event) !== owner ||
      BigInt(item.event.payload.byteEnd) !== start
    )
      break;
    start = BigInt(item.event.payload.byteStart);
  }
  return start;
}

/** 投影只读取当前显示窗口，并保留原始事件与半开字节区间。 */
export function projectMappedReceive(
  items: readonly StreamItem[],
  encoding: TextEncoding,
  rules: CharacterRemapRules,
) {
  const { first, skip } = nextWindow(items);
  const utf16 = encoding === "utf-16le" || encoding === "utf-16be";
  let missingPrefix = first > 0 || skip > 0n;
  const segments: (Segment | Boundary)[] = [];
  let current: Segment | undefined;

  function finish(boundary: boolean) {
    if (!current) return;
    if (boundary || current.messageEnd)
      current.decoded.push(current.decoder.decode());
    segments.push(current);
    current = undefined;
  }

  for (let index = first; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind === "reader_gap" || item.event.kind === "gap") {
      missingPrefix = false;
      finish(true);
      segments.push({ kind: "gap", key: index });
      continue;
    }
    const event = item.event;
    if (event.kind === "configuration_boundary" || event.kind === "lifecycle") {
      missingPrefix = false;
      finish(true);
      continue;
    }
    if (event.kind !== "rx") continue;
    const { byteStart, byteEnd, bytesBase64, message } = event.payload;
    if (message?.messageType === "binary") {
      missingPrefix = false;
      finish(true);
      continue;
    }
    const offset = BigInt(byteStart);
    const end = BigInt(byteEnd);
    let omitted = index === first ? skip : 0n;
    const length = end - offset;
    const owner = sourceOwner(event);
    const fragment = message ? BigInt(message.fragmentOffset) : undefined;
    const startsSegment =
      !current ||
      current.messageEnd ||
      current.owner !== owner ||
      current.byteEnd !== offset ||
      current.nextFragment !== fragment;
    if (startsSegment && utf16 && (missingPrefix || fragment !== undefined)) {
      const phase = offset + omitted - segmentStart(items, index, event, owner);
      if (phase % 2n !== 0n && length > omitted) omitted += 1n;
      if (length === omitted && length > 0n) {
        finish(true);
        continue;
      }
    }
    missingPrefix = false;
    const bytes = sliceRawBytes(
      bytesBase64,
      length,
      Number(omitted),
      Number(length),
    );
    if (!bytes) {
      finish(true);
      segments.push({ kind: "gap", key: index });
      continue;
    }
    if (!current || startsSegment) {
      finish(true);
      current = {
        kind: "segment",
        first: event,
        firstItem: index,
        last: event,
        owner,
        byteStart: offset + omitted,
        byteEnd: end,
        messageEnd: false,
        decoder: createTextDecoder(encoding),
        decoded: [],
      };
    }
    current.decoded.push(current.decoder.decode(bytes, { stream: true }));
    current.last = event;
    current.byteEnd = end;
    current.nextFragment =
      fragment === undefined ? undefined : fragment + length;
    current.messageEnd =
      message !== undefined &&
      current.nextFragment === BigInt(message.messageLength);
  }
  finish(false);

  // 优先保留最新段落的文本。超限段仍保留可定位的源范围。
  let remaining = displayTextLimit;
  const rows: MappedReceiveRow[] = [];
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index]!;
    if (segment.kind === "gap") {
      rows.push(segment);
      continue;
    }
    const result = remapCharacters(segment.decoded.join(""), rules, remaining);
    if (result.ok) remaining -= result.text.length;
    rows.push({
      kind: "rx",
      reference: streamEventBookmark(segment.first).reference,
      firstItem: segment.firstItem,
      start: String(segment.byteStart),
      end: String(segment.byteEnd),
      firstEvent: segment.first.eventSeq,
      lastEvent: segment.last.eventSeq,
      result,
    });
  }
  return { rows: rows.reverse(), limited: first > 0 || skip > 0n };
}
