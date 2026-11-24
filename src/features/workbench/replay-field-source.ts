import type {
  CaptureRecord,
  RawEvent,
  Target,
} from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { streamSourceKey } from "@/lib/stream-source";
import { parseU64, U64_MAX } from "@/lib/u64";
import { captureRecordItems } from "./capture-record-items";
import type { FramingInspection } from "./framing-anomalies-model";
import type { FramingFrame } from "./framing-model";
import { sliceRawBytes } from "./stream-model";

export function replayFieldSources(records: readonly CaptureRecord[]) {
  const sources = new Map<string, Extract<RawEvent, { kind: "rx" }>>();
  for (const { entry } of records) {
    if (entry.kind !== "event" || entry.value.kind !== "rx") continue;
    const key = streamSourceKey(entry.value);
    if (!sources.has(key)) sources.set(key, entry.value);
  }
  return sources;
}

export function replayFieldPage(
  records: readonly CaptureRecord[],
  source: Extract<RawEvent, { kind: "rx" }>,
  anchor: bigint,
  width: number,
) {
  const key = streamSourceKey(source);
  const target: Target = {
    hostId: source.hostId,
    id: source.sessionId,
    kind: "session",
    sessionId: source.sessionId,
    sessionEpoch: source.sessionEpoch,
  };
  const items = captureRecordItems(records).filter((item) =>
    item.kind === "source"
      ? streamSourceKey(item.event) === key
      : item.kind === "reader_gap" && streamSourceKey(item.gap) === key,
  );
  const recordOrdinals = new Map<string, string>();
  for (const { entry, recordOrdinal } of records) {
    if (entry.kind === "event" && streamSourceKey(entry.value) === key)
      recordOrdinals.set(entry.value.eventSeq, recordOrdinal);
  }
  const frames: FramingFrame[] = [];
  const breaks = new Set<string>();
  const frame = new Uint8Array(width);
  const span = BigInt(width);
  let frameStart: FramingInspection["frameStart"];
  let revision: string | undefined;
  let clock: string | undefined;
  let lastEvent: bigint | undefined;
  let nextByte: bigint | undefined;
  let byteStart = anchor;
  let eventStart = "";
  let filled = 0;
  let consumed = 0;
  let gap = false;
  let breakBeforeFrame = false;
  let limited = false;

  function noteGap() {
    filled = 0;
    gap = true;
    breakBeforeFrame = true;
  }

  for (const item of items) {
    if (item.kind !== "source") {
      if (frameStart) {
        noteGap();
        if (item.kind === "reader_gap" && !item.gap.missingByteRanges?.length)
          break;
        const skipped =
          item.kind === "reader_gap" &&
          item.gap.missingByteRanges?.find((range) => range.direction === "rx");
        if (skipped) nextByte = parseU64(skipped.end);
      }
      continue;
    }
    const { event } = item;
    const seq = parseU64(event.eventSeq);
    if (seq === undefined || seq === U64_MAX) continue;
    if (frameStart) {
      if (
        event.configurationRevision !== revision ||
        event.kind === "configuration_boundary" ||
        event.kind === "lifecycle"
      ) {
        noteGap();
        break;
      }
      if (lastEvent !== undefined && seq <= lastEvent) {
        noteGap();
        break;
      }
      if (event.kind === "gap" && event.payload.direction !== "tx") {
        noteGap();
        const skipped = event.payload.missingByteRange;
        if (!event.payload.knownExtent || skipped?.direction !== "rx") break;
        nextByte = parseU64(skipped.end);
      }
      if (
        (lastEvent !== undefined && seq !== lastEvent + 1n) ||
        event.kind === "gap" ||
        event.time.clockId !== clock
      )
        noteGap();
      lastEvent = seq;
      clock = event.time.clockId;
    }
    if (event.kind !== "rx") continue;
    const start = parseU64(event.payload.byteStart);
    const end = parseU64(event.payload.byteEnd);
    if (start === undefined || end === undefined || end <= start) continue;
    if (!frameStart) {
      if (anchor < start || anchor >= end) continue;
      frameStart = { eventSeq: event.eventSeq, byteStart: String(anchor) };
      revision = event.configurationRevision;
      clock = event.time.clockId;
      lastEvent = seq;
    }
    if (nextByte !== undefined && start !== nextByte) {
      if (start < nextByte) {
        noteGap();
        break;
      }
      noteGap();
    }
    const available = start < anchor ? anchor : start;
    const phase = (available - anchor) % span;
    const aligned =
      filled || phase === 0n ? available : available + span - phase;
    nextByte = end;
    if (aligned >= end) continue;

    const remaining = BigInt(
      Math.min(65_536 - consumed, (128 - frames.length) * width - filled),
    );
    const sliceEnd = aligned + remaining < end ? aligned + remaining : end;
    const data = sliceRawBytes(
      event.payload.bytesBase64,
      end - start,
      Number(aligned - start),
      Number(sliceEnd - start),
    );
    if (!data) {
      noteGap();
      continue;
    }
    for (let offset = 0; offset < data.length; offset++) {
      if (filled === 0) {
        byteStart = aligned + BigInt(offset);
        eventStart = event.eventSeq;
      }
      frame[filled++] = data[offset]!;
      consumed++;
      if (filled === width) {
        if (breakBeforeFrame) breaks.add(String(byteStart));
        frames.push({
          hex: formatHex(frame),
          byteStart: String(byteStart),
          byteEnd: String(byteStart + span),
          eventStart,
          eventEnd: String(seq + 1n),
        });
        filled = 0;
        breakBeforeFrame = false;
      }
    }
    if (sliceEnd < end) {
      limited = true;
      break;
    }
  }
  if (!frameStart) return;
  const inspection: FramingInspection = {
    target,
    items,
    frames,
    frameStart,
    recordOrdinals,
    breaks,
    fixedFrameWidth: width,
  };
  return { inspection, gap: gap || filled !== 0, limited };
}
