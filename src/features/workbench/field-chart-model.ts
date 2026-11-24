import type { RawEvent } from "@serial-workbench/contracts";
import { formatHex, parseHex } from "@serial-workbench/host-client";
import { parseU64 } from "@/lib/u64";
import { streamSourceKey } from "@/lib/stream-source";
import {
  ProtocolFieldError,
  type FieldReading,
  type compileProtocolFields,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import type { FramingInspection } from "./framing-anomalies-model";
import type { FramingFrame } from "./framing-model";
import { sliceRawBytes } from "./stream-model";
import type { ChartSourceSelection } from "./stream-chart-selection";

type Span = { event: string; start: bigint; end: bigint };
export type FieldChartFrame = {
  frame: FramingFrame;
  readings?: FieldReading[];
  source?: {
    key: string;
    instance: string;
    revision: string;
    clock: string;
    spans: Span[];
  };
  breakBefore?: boolean;
};

export function isChartField(reading: FieldReading) {
  return reading.rawValue !== undefined;
}

function retainedSource(
  frame: FramingFrame,
  bytes: Uint8Array,
  events: ReadonlyMap<bigint, RawEvent>,
): FieldChartFrame["source"] {
  const first = BigInt(frame.eventStart);
  const after = BigInt(frame.eventEnd);
  const end = BigInt(frame.byteEnd);
  let next = BigInt(frame.byteStart);
  let consumed = 0;
  const startEvent = events.get(first);
  if (startEvent?.kind !== "rx" || events.get(after - 1n)?.kind !== "rx")
    return;
  const instance = startEvent.instanceEpoch;
  const revision = startEvent.configurationRevision;
  const clock = startEvent.time.clockId;
  const spans: Span[] = [];
  for (let seq = first; seq < after; seq++) {
    const event = events.get(seq);
    if (
      !event ||
      event.kind === "gap" ||
      event.kind === "configuration_boundary" ||
      event.kind === "lifecycle" ||
      event.instanceEpoch !== instance ||
      event.configurationRevision !== revision ||
      event.time.clockId !== clock
    )
      return;
    if (event.kind !== "rx") continue;
    const start = parseU64(event.payload.byteStart);
    const afterEvent = parseU64(event.payload.byteEnd);
    if (
      start === undefined ||
      afterEvent === undefined ||
      (seq === first ? start > next : start !== next) ||
      afterEvent <= next ||
      (seq < after - 1n && afterEvent >= end)
    )
      return;
    const until = afterEvent < end ? afterEvent : end;
    const retained = sliceRawBytes(
      event.payload.bytesBase64,
      afterEvent - start,
      Number(next - start),
      Number(until - start),
    );
    if (!retained) return;
    for (const byte of retained) {
      if (bytes[consumed++] !== byte) return;
    }
    spans.push({ event: event.eventSeq, start: next, end: until });
    next = until;
  }
  if (next === end && consumed === bytes.length)
    return {
      key: streamSourceKey(startEvent),
      instance,
      revision,
      clock,
      spans,
    };
}

export function fieldChartFrames(
  inspection: FramingInspection,
  codec: ReturnType<typeof compileProtocolFields>,
) {
  const { target } = inspection;
  const events = new Map<bigint, RawEvent>();
  for (const item of inspection.items) {
    if (item.kind !== "source") continue;
    const { event } = item;
    const seq = parseU64(event.eventSeq);
    if (
      seq !== undefined &&
      event.hostId === target.hostId &&
      event.sessionId === target.sessionId &&
      event.sessionEpoch === target.sessionEpoch
    )
      events.set(seq, event);
  }
  return inspection.frames.map((frame): FieldChartFrame => {
    const bytes = parseHex(frame.hex);
    const source = retainedSource(frame, bytes, events);
    const entry = {
      frame,
      source,
      breakBefore: inspection.breaks?.has(frame.byteStart),
    };
    if (bytes.length !== codec.byteLength) return entry;
    try {
      const readings = codec.decode(bytes);
      return { ...entry, readings };
    } catch (error) {
      if (!(error instanceof ProtocolFieldError)) throw error;
      return entry;
    }
  });
}

export function chartValue(entry: FieldChartFrame, field: string) {
  if (
    !entry.source ||
    !entry.readings ||
    entry.readings.some((reading) => reading.checksum?.valid === false)
  )
    return;
  const reading = entry.readings.find(({ id }) => id === field);
  if (
    !reading ||
    !isChartField(reading) ||
    reading.calibration?.status === "unmapped"
  )
    return;
  const value = Number(reading.value);
  if (Number.isFinite(value)) return value;
}

type FieldPair = { index: number; x: number; y: number };

export function fieldChartPairs(
  entries: readonly FieldChartFrame[],
  start: number,
  xField: string,
  yField: string,
) {
  const segments: FieldPair[][] = [];
  let segment: FieldPair[] | undefined;
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    const x = chartValue(entry, xField);
    const y = chartValue(entry, yField);
    if (x === undefined || y === undefined) {
      segment = undefined;
      continue;
    }
    if (!segment || !sharesChartSegment(entries[index - 1]!, entry)) {
      segment = [];
      segments.push(segment);
    }
    segment.push({ index, x, y });
  }
  return segments;
}

export function fieldChartSpans(entry: FieldChartFrame, reading: FieldReading) {
  const start = BigInt(entry.frame.byteStart) + BigInt(reading.bytes.start);
  const end = BigInt(entry.frame.byteStart) + BigInt(reading.bytes.end);
  const bytes = parseHex(reading.rawHex);
  return (entry.source?.spans ?? []).flatMap((span) => {
    const from = span.start > start ? span.start : start;
    const to = span.end < end ? span.end : end;
    if (from >= to) return [];
    return [
      {
        event: span.event,
        start: String(from),
        end: String(to),
        hex: formatHex(
          bytes.subarray(Number(from - start), Number(to - start)),
        ),
      },
    ];
  });
}

export function fieldChartSelection(
  entry: FieldChartFrame,
  reading: FieldReading,
): ChartSourceSelection | undefined {
  if (!entry.source) return;
  const spans = fieldChartSpans(entry, reading);
  const first = spans[0];
  const last = spans.at(-1);
  if (!first || !last) return;
  return {
    range: {
      start: {
        source: JSON.stringify([entry.source.key, first.event]),
        offset: BigInt(first.start),
        ascii: false,
      },
      end: {
        source: JSON.stringify([entry.source.key, last.event]),
        offset: BigInt(last.end),
        ascii: false,
      },
      backwards: false,
    },
    hex: spans.map((span) => span.hex).join(" "),
  };
}

export function locateChartSelection(
  entries: readonly FieldChartFrame[],
  selection: ChartSourceSelection,
  preferred?: string,
) {
  const { range } = selection;
  for (const entry of entries) {
    if (!entry.source) continue;
    const options =
      entry.readings?.filter((reading) => {
        if (!isChartField(reading)) return false;
        const spans = fieldChartSpans(entry, reading);
        const key = entry.source!.key;
        const hasStart = spans.some(
          (span) =>
            JSON.stringify([key, span.event]) === range.start.source &&
            range.start.offset >= BigInt(span.start) &&
            range.start.offset < BigInt(span.end),
        );
        const hasEnd = spans.some(
          (span) =>
            JSON.stringify([key, span.event]) === range.end.source &&
            range.end.offset > BigInt(span.start) &&
            range.end.offset <= BigInt(span.end),
        );
        if (!hasStart || !hasEnd) return false;
        const origin = BigInt(spans[0]!.start);
        const expected = parseHex(reading.rawHex).subarray(
          Number(range.start.offset - origin),
          Number(range.end.offset - origin),
        );
        return formatHex(expected) === selection.hex;
      }) ?? [];
    const field =
      options.find(({ id }) => id === preferred) ??
      (options.length === 1 ? options[0] : undefined);
    if (field) return { entry, field: field.id };
  }
}

export function sharesChartSegment(
  left: FieldChartFrame,
  right: FieldChartFrame,
) {
  return Boolean(
    !right.breakBefore &&
    left.source &&
    right.source &&
    left.source.instance === right.source.instance &&
    left.source.revision === right.source.revision &&
    left.source.clock === right.source.clock &&
    left.frame.byteEnd === right.frame.byteStart &&
    BigInt(right.frame.eventStart) <= BigInt(left.frame.eventEnd),
  );
}
