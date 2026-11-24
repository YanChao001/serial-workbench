import type { RawEvent, StreamItem } from "@serial-workbench/contracts";
import { formatHex } from "@serial-workbench/host-client";
import { parseU64 } from "@/lib/u64";
import { streamSourceKey } from "@/lib/stream-source";
import type { StreamHexSelection } from "./stream-hex-selection";
import { sliceRawBytes } from "./stream-model";

export type ChartSourceSelection = { range: StreamHexSelection; hex: string };

export function streamHexEventSource(event: RawEvent) {
  return JSON.stringify([streamSourceKey(event), event.eventSeq]);
}

type RxEvent = Extract<RawEvent, { kind: "rx" }>;

function eventForSource(items: readonly StreamItem[], source: string) {
  const item = items.find((entry) => matchesRx(entry, source));
  return item && matchesRx(item, source) ? item.event : undefined;
}

function itemAtOffset(
  items: readonly StreamItem[],
  reference: RxEvent,
  offset: bigint,
  isEnd: boolean,
) {
  const identity = streamSourceKey(reference);
  return items.findIndex((item) => {
    if (item.kind !== "source" || item.event.kind !== "rx") return false;
    const { event } = item;
    if (
      streamSourceKey(event) !== identity ||
      event.configurationRevision !== reference.configurationRevision ||
      event.time.clockId !== reference.time.clockId
    )
      return false;
    const start = parseU64(event.payload.byteStart);
    const end = parseU64(event.payload.byteEnd);
    return (
      start !== undefined &&
      end !== undefined &&
      (isEnd
        ? start < offset && end >= offset
        : start <= offset && end > offset)
    );
  });
}

/** 显示行可以由多个读块合并。对外交接的事件来自原始区间。 */
export function sourceSelectionFromDisplay(
  displayed: readonly StreamItem[],
  sources: readonly StreamItem[],
  range: StreamHexSelection,
): StreamHexSelection | undefined {
  const start = eventForSource(displayed, range.start.source);
  const end = eventForSource(displayed, range.end.source);
  if (!start || !end) return;
  const first =
    sources[itemAtOffset(sources, start, range.start.offset, false)];
  const last = sources[itemAtOffset(sources, end, range.end.offset, true)];
  if (first?.kind !== "source" || last?.kind !== "source") return;
  return {
    ...range,
    start: { ...range.start, source: streamHexEventSource(first.event) },
    end: { ...range.end, source: streamHexEventSource(last.event) },
  };
}

export function chartSelectionRows(
  sources: readonly StreamItem[],
  displayed: readonly StreamItem[],
  range: StreamHexSelection,
) {
  const start = eventForSource(sources, range.start.source);
  const end = eventForSource(sources, range.end.source);
  if (!start || !end) return;
  const first = itemAtOffset(displayed, start, range.start.offset, false);
  const last = itemAtOffset(displayed, end, range.end.offset, true);
  if (first >= 0 && last >= first) return { first, last };
}

function matchesRx(
  item: StreamItem,
  source: string,
): item is { kind: "source"; event: RxEvent } {
  return (
    item.kind === "source" &&
    item.event.kind === "rx" &&
    streamHexEventSource(item.event) === source
  );
}

export function retainedChartSelection(
  items: readonly StreamItem[],
  range: StreamHexSelection,
) {
  const length = range.end.offset - range.start.offset;
  if (length < 1n || length > 4096n) return;
  const first = items.findIndex((item) => matchesRx(item, range.start.source));
  if (first < 0) return;
  const head = items[first]!;
  if (!matchesRx(head, range.start.source)) return;
  const identity = streamSourceKey(head.event);
  const revision = head.event.configurationRevision;
  const clock = head.event.time.clockId;
  const bytes = new Uint8Array(Number(length));
  let offset = range.start.offset;
  let previous: bigint | undefined;
  for (let index = first; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind !== "source") {
      if (item.kind === "reader_gap" && streamSourceKey(item.gap) === identity)
        return;
      continue;
    }
    const event = item.event;
    if (streamSourceKey(event) !== identity) continue;
    const sequence = parseU64(event.eventSeq);
    if (
      sequence === undefined ||
      (previous !== undefined && sequence !== previous + 1n) ||
      event.kind === "gap" ||
      event.kind === "configuration_boundary" ||
      event.kind === "lifecycle" ||
      event.configurationRevision !== revision ||
      event.time.clockId !== clock
    )
      return;
    previous = sequence;
    if (event.kind !== "rx") continue;
    const start = parseU64(event.payload.byteStart);
    const end = parseU64(event.payload.byteEnd);
    const final = streamHexEventSource(event) === range.end.source;
    const until = final ? range.end.offset : end;
    if (
      start === undefined ||
      end === undefined ||
      until === undefined ||
      (index === first ? offset < start : offset !== start) ||
      until > end ||
      until <= offset ||
      until > range.end.offset
    )
      return;
    const part = sliceRawBytes(
      event.payload.bytesBase64,
      end - start,
      Number(offset - start),
      Number(until - start),
    );
    if (!part) return;
    bytes.set(part, Number(offset - range.start.offset));
    offset = until;
    if (final) return { first, last: index, hex: formatHex(bytes) };
  }
}
