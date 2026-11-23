import {
  ContractValidationError,
  type Call,
  type StreamItem,
  type Target,
} from "@serial-workbench/contracts";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { bytesToBase64 } from "@/lib/base64";
import { isRecord } from "@/lib/settings-model";
import { parseU64, U64_MAX } from "@/lib/u64";
import { decodeBytes } from "./stream-model";

export const framingAction = "swb.reference.framing.scan";
export type FramingMode =
  "fixed" | "delimiter" | "length" | "markers" | "silence";
export type FramingRange = Pick<FramingDraft, "startEventSeq" | "endEventSeq">;
export type FramingDraft = {
  startEventSeq: string;
  endEventSeq: string;
  mode: FramingMode;
  fixedLength: string;
  delimiter: string;
  offset: string;
  width: "1" | "2" | "4";
  order: "le" | "be";
  adjustment: string;
  header: string;
  footer: string;
  escape: string;
  idle: string;
  limit: string;
};

export function initialFramingDraft(range: FramingRange): FramingDraft {
  return {
    ...range,
    mode: "fixed",
    fixedLength: "8",
    delimiter: "0D 0A",
    offset: "0",
    width: "1",
    order: "be",
    adjustment: "1",
    header: "",
    footer: "",
    escape: "",
    idle: "",
    limit: "4096",
  };
}

export function receivedFramingRange(
  items: readonly StreamItem[],
  target: Target,
): FramingRange {
  let first: bigint | undefined;
  let last: bigint | undefined;
  let lastByte: bigint | undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (
      !item ||
      item.kind !== "source" ||
      item.event.kind !== "rx" ||
      item.event.hostId !== target.hostId ||
      item.event.sessionId !== target.sessionId ||
      item.event.sessionEpoch !== target.sessionEpoch
    )
      continue;
    const sequence = parseU64(item.event.eventSeq);
    const byteStart = parseU64(item.event.payload.byteStart);
    const byteEnd = parseU64(item.event.payload.byteEnd);
    if (
      sequence === undefined ||
      sequence === 0n ||
      sequence === U64_MAX ||
      byteStart === undefined ||
      byteEnd === undefined ||
      byteEnd <= byteStart
    )
      continue;
    last ??= sequence;
    lastByte ??= byteEnd;
    if (last + 1n - sequence > 1024n || lastByte - byteStart > 65_536n) break;
    first = sequence;
  }
  if (first === undefined || last === undefined)
    return { startEventSeq: "1", endEventSeq: "" };
  const end = last + 1n;
  return {
    startEventSeq: String(first),
    endEventSeq: String(end),
  };
}

function bounded(value: string, min: number, max: number): number {
  if (!/^-?(0|[1-9][0-9]{0,4})$/.test(value))
    throw new Error("Invalid framing integer");
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new Error("Invalid framing integer");
  return parsed;
}

function hexBytes(value: string, max: number): Uint8Array | undefined {
  if (!value.trim()) return undefined;
  if (value.length > 128) throw new Error("Invalid framing marker");
  const parsed = parseHex(value);
  if (!parsed.length || parsed.length > max)
    throw new Error("Invalid framing marker");
  return parsed;
}

export function framingParams(draft: FramingDraft): Call["params"] | undefined {
  const start = parseU64(draft.startEventSeq);
  const end = parseU64(draft.endEventSeq);
  if (!start || end === undefined || end <= start || end - start > 1024n)
    return;
  try {
    const limit = bounded(draft.limit, 1, 4096);
    const header = hexBytes(draft.header, Math.min(limit, 16));
    const footer =
      draft.mode === "silence"
        ? undefined
        : hexBytes(draft.footer, Math.min(limit, 16));
    const delimiter =
      draft.mode === "delimiter"
        ? hexBytes(draft.delimiter, Math.min(limit, 16))
        : undefined;
    const escape = hexBytes(draft.escape, 1)?.[0];
    if (
      (draft.mode === "markers" && !footer) ||
      (draft.mode === "delimiter" && !delimiter) ||
      [header, footer, delimiter].some(
        (marker) => marker && escape !== undefined && marker.includes(escape),
      )
    )
      return;
    const params: Call["params"] = {
      startEventSeq: draft.startEventSeq,
      endEventSeq: draft.endEventSeq,
      maxFrameLength: limit,
    };
    if (header) params.headerBase64 = bytesToBase64(header);
    if (footer) params.footerBase64 = bytesToBase64(footer);
    if (escape !== undefined) params.escapeByte = escape;
    if (draft.idle || draft.mode === "silence")
      params.idleTimeoutMs = bounded(draft.idle, 1, 60_000);
    if (draft.mode === "fixed")
      params.fixedLength = bounded(
        draft.fixedLength,
        Math.max(1, (header?.length ?? 0) + (footer?.length ?? 0)),
        limit,
      );
    if (delimiter) params.delimiterBase64 = bytesToBase64(delimiter);
    if (draft.mode === "length") {
      const width = Number(draft.width);
      params.lengthField = {
        width,
        offset: bounded(draft.offset, 0, limit - width),
        byteOrder: draft.order,
        adjustment: bounded(draft.adjustment, -limit, limit),
      };
    }
    return params;
  } catch {
    return undefined;
  }
}

export type FramingFrame = {
  hex: string;
  byteStart: string;
  byteEnd: string;
  eventStart: string;
  eventEnd: string;
};
export type FramingPage = {
  frames: FramingFrame[];
  incompleteBytes: number;
  nextCursor?: { eventSeq: string; byteStart: string };
};

export function parseFramingPage(
  input: unknown,
  target: Target,
  params: Call["params"],
): FramingPage {
  const invalid = () => new ContractValidationError("Invalid framing result");
  if (
    !isRecord(input) ||
    !Array.isArray(input.frames) ||
    input.frames.length > 128 ||
    typeof input.incompleteBytes !== "number" ||
    !Number.isInteger(input.incompleteBytes) ||
    input.incompleteBytes < 0 ||
    input.incompleteBytes > 65_536
  )
    throw invalid();

  const first = parseU64(params.startEventSeq);
  const end = parseU64(params.endEventSeq);
  if (!first || end === undefined) throw invalid();
  let previousByte = parseU64(params.startByte);
  let previousEvent = first;
  let coveredBytes = BigInt(input.incompleteBytes);
  const frames = input.frames.map((frame: unknown) => {
    if (
      !isRecord(frame) ||
      typeof frame.bytesBase64 !== "string" ||
      frame.bytesBase64.length > 5464 ||
      !isRecord(frame.source)
    )
      throw invalid();
    const {
      hostId,
      sessionId,
      sessionEpoch,
      direction,
      byteStart,
      byteEnd,
      eventStart,
      eventEnd,
    } = frame.source;
    if (
      hostId !== target.hostId ||
      sessionId !== target.sessionId ||
      sessionEpoch !== target.sessionEpoch ||
      direction !== "rx" ||
      typeof byteStart !== "string" ||
      typeof byteEnd !== "string" ||
      typeof eventStart !== "string" ||
      typeof eventEnd !== "string"
    )
      throw invalid();
    const startByte = parseU64(byteStart);
    const endByte = parseU64(byteEnd);
    const startEvent = parseU64(eventStart);
    const endEvent = parseU64(eventEnd);
    if (
      startByte === undefined ||
      endByte === undefined ||
      endByte <= startByte ||
      (previousByte !== undefined && startByte < previousByte) ||
      startEvent === undefined ||
      endEvent === undefined ||
      startEvent < previousEvent ||
      endEvent > end ||
      endEvent <= startEvent
    )
      throw invalid();
    const bytes = decodeBytes(frame.bytesBase64);
    if (bytes.length > 4096 || BigInt(bytes.length) !== endByte - startByte)
      throw invalid();
    coveredBytes += endByte - startByte;
    if (coveredBytes > 65_536n) throw invalid();
    previousByte = endByte;
    previousEvent = endEvent - 1n;
    return { hex: formatHex(bytes), byteStart, byteEnd, eventStart, eventEnd };
  });
  const result: FramingPage = {
    frames,
    incompleteBytes: input.incompleteBytes,
  };
  if (input.nextCursor !== undefined) {
    if (!isRecord(input.nextCursor) || frames.length !== 128) throw invalid();
    const { eventSeq, byteStart } = input.nextCursor;
    const cursor = parseU64(eventSeq);
    const offset = parseU64(byteStart);
    if (
      typeof eventSeq !== "string" ||
      typeof byteStart !== "string" ||
      cursor === undefined ||
      cursor < previousEvent ||
      cursor >= end ||
      offset === undefined ||
      (previousByte !== undefined && offset < previousByte)
    )
      throw invalid();
    result.nextCursor = { eventSeq, byteStart };
  }
  return result;
}
