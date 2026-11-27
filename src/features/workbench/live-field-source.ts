import type { RawEvent, StreamItem, Target } from "@serial-workbench/contracts";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { streamSourceKey } from "@/lib/stream-source";
import { parseU64, U64_MAX } from "@/lib/u64";
import { retainedSource } from "./field-chart-model";
import type { FramingFrame } from "./framing-model";
import { sliceRawBytes } from "./stream-model";
import {
  retainedChartSelection,
  type ChartSourceSelection,
} from "./stream-chart-selection";

const maxEvents = 1024;
const maxFrameBytes = 4096;

type Snapshot =
  | { kind: "frame"; frame: FramingFrame; pending: number }
  | { kind: "source_changed" };

function join(prefix: Uint8Array, suffix: Uint8Array) {
  if (!prefix.length) return suffix;
  const result = new Uint8Array(prefix.length + suffix.length);
  result.set(prefix);
  result.set(suffix, prefix.length);
  return result;
}

export function beginLiveFieldSource(
  items: readonly StreamItem[],
  target: Target,
  anchor: FramingFrame,
) {
  const first = parseU64(anchor.eventStart);
  const after = parseU64(anchor.eventEnd);
  const byteEnd = parseU64(anchor.byteEnd);
  if (
    target.kind !== "session" ||
    first === undefined ||
    after === undefined ||
    after <= first ||
    after - first > BigInt(maxEvents) ||
    byteEnd === undefined
  )
    return;

  const events = new Map<bigint, RawEvent>();
  for (const item of items) {
    if (item.kind !== "source") continue;
    const { event } = item;
    const seq = parseU64(event.eventSeq);
    if (
      seq !== undefined &&
      first <= seq &&
      seq < after &&
      event.hostId === target.hostId &&
      event.sessionId === target.sessionId &&
      event.sessionEpoch === target.sessionEpoch
    ) {
      events.set(seq, event);
    }
  }
  const bytes = parseHex(anchor.hex);
  const width = bytes.length;
  const last = events.get(after - 1n);
  if (!width || width > maxFrameBytes || last?.kind !== "rx") return;
  const anchorSource = retainedSource(anchor, bytes, events);
  if (!anchorSource) return;
  const { key, revision, clock } = anchorSource;

  let sequence = after - 1n;
  let nextByte = byteEnd;
  let tail: Uint8Array = new Uint8Array();
  let tailEvent = "";
  let frame = anchor;
  let snapshot: Snapshot = { kind: "frame", frame, pending: 0 };

  function sharesSource(event: RawEvent) {
    return (
      streamSourceKey(event) === key &&
      event.configurationRevision === revision &&
      event.time.clockId === clock
    );
  }

  function acceptRx(
    event: Extract<RawEvent, { kind: "rx" }>,
    allowOverlappingPrefix = false,
  ) {
    const { payload } = event;
    const start = parseU64(payload.byteStart);
    const end = parseU64(payload.byteEnd);
    if (
      start === undefined ||
      end === undefined ||
      end <= start ||
      end < nextByte ||
      (allowOverlappingPrefix ? start > nextByte : start !== nextByte)
    ) {
      return false;
    }
    if (nextByte === end) return allowOverlappingPrefix;
    const dataStart = nextByte;
    const offset = Number(dataStart - start);
    const length = Number(end - start);
    if (!Number.isSafeInteger(length) || sequence === U64_MAX) return false;

    function slice(from: number, to: number) {
      return sliceRawBytes(payload.bytesBase64, BigInt(length), from, to);
    }

    const available = tail.length + length - offset;
    const remainder = available % width;
    const complete = available - remainder;
    if (!complete) {
      const suffix = slice(offset, length);
      if (!suffix) return false;
      if (!tail.length) tailEvent = event.eventSeq;
      tail = join(tail, suffix);
    } else {
      const latestEnd = length - remainder;
      const startsInTail = latestEnd - width < offset;
      const suffix = slice(Math.max(offset, latestEnd - width), latestEnd);
      const pending = slice(latestEnd, length);
      if (!suffix || !pending) return false;
      const packet = startsInTail ? join(tail, suffix) : suffix;
      if (packet.length !== width) return false;
      const frameEnd = end - BigInt(remainder);
      frame = {
        hex: formatHex(packet),
        byteStart: String(frameEnd - BigInt(width)),
        byteEnd: String(frameEnd),
        eventStart: startsInTail ? tailEvent : event.eventSeq,
        eventEnd: String(sequence + 1n),
      };
      tail = pending;
      tailEvent = event.eventSeq;
    }
    nextByte = end;
    return true;
  }

  if (!acceptRx(last, true)) return;

  function changed(): Snapshot {
    snapshot = { kind: "source_changed" };
    return snapshot;
  }

  return {
    selection(
      received: readonly StreamItem[],
      displayed: FramingFrame,
    ): ChartSourceSelection | undefined {
      if (snapshot.kind === "source_changed") return;
      const range = {
        start: {
          source: JSON.stringify([key, displayed.eventStart]),
          offset: BigInt(displayed.byteStart),
          ascii: false,
        },
        end: {
          source: JSON.stringify([
            key,
            String(BigInt(displayed.eventEnd) - 1n),
          ]),
          offset: BigInt(displayed.byteEnd),
          ascii: false,
        },
        backwards: false,
      };
      const retained = retainedChartSelection(received, range);
      if (retained?.hex === displayed.hex) return { range, hex: displayed.hex };
    },
    update(received: readonly StreamItem[]): Snapshot {
      if (snapshot.kind === "source_changed") return snapshot;
      if (!received.length) return changed();
      let from = received.length;
      while (from > 0) {
        const item = received[from - 1]!;
        if (item.kind === "source" && sharesSource(item.event)) {
          const seq = parseU64(item.event.eventSeq);
          if (seq !== undefined && seq <= sequence) break;
        }
        from--;
        if (received.length - from > maxEvents) return changed();
      }
      for (let cursor = from; cursor < received.length; cursor++) {
        const item = received[cursor]!;
        if (item.kind !== "source") return changed();
        const { event } = item;
        const seq = parseU64(event.eventSeq);
        if (
          !sharesSource(event) ||
          seq !== sequence + 1n ||
          event.kind === "gap" ||
          event.kind === "configuration_boundary" ||
          event.kind === "lifecycle"
        ) {
          return changed();
        }
        sequence = seq;
        if (event.kind === "rx" && !acceptRx(event)) return changed();
      }
      if (snapshot.frame !== frame || snapshot.pending !== tail.length) {
        snapshot = { kind: "frame", frame, pending: tail.length };
      }
      return snapshot;
    },
  };
}
