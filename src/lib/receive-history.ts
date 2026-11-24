import type {
  EventTime,
  RawEvent,
  StreamItem,
} from "@serial-workbench/contracts";
import type { ReceiveHistory } from "./generated/bindings";
import generatedDefaults from "./generated/client-defaults.json";
import { streamSourceKey } from "./stream-source";

export type { ReceiveHistory } from "./generated/bindings";
export const DEFAULT_RECEIVE_HISTORY: Readonly<ReceiveHistory> =
  generatedDefaults.preferences.receiveHistory;

export function parseReceiveHistory(value: unknown): ReceiveHistory {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw { code: "INVALID_DOCUMENT" };
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).some(
      (key) => key !== "maxRecords" && key !== "maxBytes",
    ) ||
    typeof fields.maxRecords !== "number" ||
    !Number.isInteger(fields.maxRecords) ||
    fields.maxRecords < 1 ||
    fields.maxRecords > 20000 ||
    typeof fields.maxBytes !== "number" ||
    !Number.isInteger(fields.maxBytes) ||
    fields.maxBytes < 1024 * 1024 ||
    fields.maxBytes > 16 * 1024 * 1024
  )
    throw { code: "INVALID_DOCUMENT" };
  return { maxRecords: fields.maxRecords, maxBytes: fields.maxBytes };
}

let limits = DEFAULT_RECEIVE_HISTORY;
const listeners = new Set<() => void>();
export function receiveHistoryLimits(): Readonly<ReceiveHistory> {
  return limits;
}
export function setReceiveHistoryLimits(value: ReceiveHistory) {
  const next = parseReceiveHistory(value);
  if (
    limits.maxRecords === next.maxRecords &&
    limits.maxBytes === next.maxBytes
  )
    return;
  limits = next;
  for (const listener of listeners) listener();
}
export function subscribeReceiveHistoryLimits(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅用于显示投影。Host 的原始事件、游标和录制内容保持独立。 */
export type HistoryStreamItem = StreamItem & {
  displayRecord?: string;
  receiveIdleMs?: ReceiveIdleMs;
  displayTime?: EventTime;
};
export type HistoryPosition = {
  eventSeq: string;
  rxEnd: string;
  txEnd: string;
};
type RxEvent = Extract<RawEvent, { kind: "rx" }>;
type Segment = {
  event: RxEvent;
  parts: string[];
  length: number;
  cached?: HistoryStreamItem;
};
type Entry =
  | {
      kind: "rx";
      id: string;
      segments: Segment[];
      size: number;
      receiveIdleMs?: ReceiveIdleMs;
    }
  | { kind: "record"; item: HistoryStreamItem; size: number; txKey?: string };
const SEGMENT_BYTES = 65536;
const MAX_SOURCE_EVENTS = 16_384;
export const RECEIVE_IDLE_MS = [1, 5, 10, 20, 50, 100, 200, 500, 1000] as const;
export type ReceiveIdleMs = (typeof RECEIVE_IDLE_MS)[number];
export const DEFAULT_RECEIVE_IDLE_MS: ReceiveIdleMs = 100;
const initialPosition = (): HistoryPosition => ({
  eventSeq: "0",
  rxEnd: "0",
  txEnd: "0",
});
const maximum = (left: string, right: string) =>
  BigInt(left) > BigInt(right) ? left : right;
function shiftedMessage(
  message: RxEvent["payload"]["message"],
  offset: number,
) {
  return message
    ? {
        ...message,
        fragmentOffset: String(BigInt(message.fragmentOffset) + BigInt(offset)),
      }
    : undefined;
}
function txKey(item: StreamItem): string | undefined {
  if (
    item.kind !== "source" ||
    (item.event.kind !== "tx" && item.event.kind !== "tx_intent")
  )
    return;
  return JSON.stringify([
    streamSourceKey(item.event),
    item.event.payload.operationId,
    item.event.payload.byteStart,
    item.event.payload.byteEnd,
  ]);
}
function dataSize(item: StreamItem): number {
  if (item.kind !== "source") return 0;
  const { event } = item;
  return event.kind === "rx" ||
    event.kind === "tx" ||
    event.kind === "tx_intent"
    ? Number(BigInt(event.payload.byteEnd) - BigInt(event.payload.byteStart))
    : 0;
}
export function historyPosition(
  items: readonly StreamItem[],
  removed?: HistoryPosition,
): HistoryPosition {
  const position = { ...(removed ?? initialPosition()) };
  for (const item of items) {
    if (item.kind === "reader_gap") {
      position.eventSeq = maximum(
        position.eventSeq,
        item.gap.missingEventRange.end,
      );
      continue;
    }
    const { event } = item;
    position.eventSeq = maximum(position.eventSeq, event.eventSeq);
    if (event.kind === "rx")
      position.rxEnd = maximum(position.rxEnd, event.payload.byteEnd);
    if (event.kind === "tx" || event.kind === "tx_intent")
      position.txEnd = maximum(position.txEnd, event.payload.byteEnd);
  }
  return position;
}
/** 清空以字节边界为准，后到回执及已合并的接收段均不会使旧内容重现。 */
export function historyAfter(
  items: readonly HistoryStreamItem[],
  position?: HistoryPosition,
): readonly HistoryStreamItem[] {
  if (!position) return items;
  return items.flatMap((item): HistoryStreamItem[] => {
    if (item.kind === "source") {
      const { event } = item;
      if (event.kind === "rx") {
        if (BigInt(event.payload.byteEnd) <= BigInt(position.rxEnd)) return [];
        if (BigInt(event.payload.byteStart) < BigInt(position.rxEnd)) {
          const removed = Number(
            BigInt(position.rxEnd) - BigInt(event.payload.byteStart),
          );
          return [
            {
              ...item,
              event: {
                ...event,
                payload: {
                  ...event.payload,
                  byteStart: position.rxEnd,
                  message: shiftedMessage(event.payload.message, removed),
                  bytesBase64: btoa(
                    atob(event.payload.bytesBase64).slice(removed),
                  ),
                },
              },
            },
          ];
        }
        return [item];
      }
      if (event.kind === "tx" || event.kind === "tx_intent")
        return BigInt(event.payload.byteEnd) > BigInt(position.txEnd)
          ? [item]
          : [];
      return BigInt(event.eventSeq) > BigInt(position.eventSeq) ? [item] : [];
    }
    return BigInt(item.gap.missingEventRange.end) > BigInt(position.eventSeq)
      ? [item]
      : [];
  });
}
export function historyTrimmedAfter(
  removed: HistoryPosition | undefined,
  position?: HistoryPosition,
): boolean {
  return (
    !!removed &&
    (BigInt(removed.rxEnd) > BigInt(position?.rxEnd ?? "0") ||
      BigInt(removed.txEnd) > BigInt(position?.txEnd ?? "0") ||
      BigInt(removed.eventSeq) > BigInt(position?.eventSeq ?? "0"))
  );
}

/** 连续接收按显示记录保留，物理读块压实为有界段，容量只计实际数据字节。 */
export class ReceiveHistoryBuffer {
  private entries: Entry[] = [];
  private transmissions = new Map<string, Extract<Entry, { kind: "record" }>>();
  private retainedBytes = 0;
  private sources: StreamItem[] = [];
  private sourceBytes = 0;
  private receiveIdleMs = DEFAULT_RECEIVE_IDLE_MS;
  private activeReceive?: Extract<Entry, { kind: "rx" }>;
  readonly removed = initialPosition();
  trimmed = false;
  constructor(
    private limits: Readonly<ReceiveHistory> = receiveHistoryLimits(),
    private options: { preserveSource?: boolean } = {},
  ) {}

  append(items: readonly HistoryStreamItem[]) {
    for (const item of items) {
      if (this.options.preserveSource) {
        this.sources.push(item);
        this.sourceBytes += dataSize(item);
      }
      if (item.kind === "source" && item.event.kind === "rx") {
        this.appendReceive(item.event, item.displayRecord, item.receiveIdleMs);
        continue;
      }
      const key = txKey(item);
      const previous = key ? this.transmissions.get(key) : undefined;
      if (previous) {
        if (
          item.kind === "source" &&
          item.event.kind === "tx" &&
          previous.item.kind === "source"
        )
          previous.item = {
            ...item,
            displayTime: previous.item.displayTime ?? previous.item.event.time,
          };
        continue;
      }
      this.activeReceive = undefined;
      const size = dataSize(item);
      const entry: Extract<Entry, { kind: "record" }> = {
        kind: "record",
        item,
        size,
        txKey: key,
      };
      this.entries.push(entry);
      if (key) this.transmissions.set(key, entry);
      this.retainedBytes += size;
    }
    this.trim();
    this.trimSources();
  }
  setLimits(value: Readonly<ReceiveHistory>): boolean {
    this.limits = value;
    const changed = this.trim();
    return this.trimSources() || changed;
  }
  setReceiveIdleMs(value: ReceiveIdleMs): boolean {
    if (this.receiveIdleMs === value) return false;
    this.receiveIdleMs = value;
    this.activeReceive = undefined;
    return true;
  }

  items(): readonly HistoryStreamItem[] {
    return this.entries.flatMap((entry): HistoryStreamItem[] => {
      if (entry.kind === "record") return [entry.item];
      return entry.segments.map((segment) => {
        if (!segment.cached) {
          const binary = segment.parts.join("");
          segment.parts = [binary];
          segment.cached = {
            kind: "source",
            displayRecord: entry.id,
            receiveIdleMs: entry.receiveIdleMs,
            event: {
              ...segment.event,
              payload: { ...segment.event.payload, bytesBase64: btoa(binary) },
            },
          };
        }
        return segment.cached;
      });
    });
  }
  sourceItems(): readonly StreamItem[] {
    return this.trimmed
      ? historyAfter(this.sources, this.removed)
      : this.sources.slice();
  }

  private trimSources() {
    let removed = 0;
    let clipped = false;
    while (
      this.sources.length - removed > MAX_SOURCE_EVENTS ||
      this.sourceBytes > this.limits.maxBytes
    ) {
      const item = this.sources[removed]!;
      const size = dataSize(item);
      const excess = this.sourceBytes - this.limits.maxBytes;
      if (
        this.sources.length - removed <= MAX_SOURCE_EVENTS &&
        excess > 0 &&
        excess < size &&
        item.kind === "source" &&
        item.event.kind === "rx"
      ) {
        const position = initialPosition();
        position.rxEnd = String(
          BigInt(item.event.payload.byteStart) + BigInt(excess),
        );
        this.sources[removed] = historyAfter([item], position)[0]!;
        this.sourceBytes -= excess;
        clipped = true;
        break;
      }
      this.sourceBytes -= size;
      removed++;
    }
    if (removed > 0) this.sources = this.sources.slice(removed);
    return clipped || removed > 0;
  }
  private appendReceive(
    event: RxEvent,
    recordId?: string,
    recordedIdleMs?: ReceiveIdleMs,
  ) {
    let entry = this.activeReceive;
    const last = entry?.segments.at(-1)?.event;
    const elapsed = last
      ? BigInt(event.time.sourceMonoNs) - BigInt(last.time.sourceMonoNs)
      : -1n;
    const previousMessage = last?.payload.message;
    const message = event.payload.message;
    const messageChanged =
      previousMessage?.messageId !== message?.messageId ||
      previousMessage?.messageType !== message?.messageType ||
      (previousMessage &&
        message &&
        last &&
        BigInt(previousMessage.fragmentOffset) +
          BigInt(last.payload.byteEnd) -
          BigInt(last.payload.byteStart) !==
          BigInt(message.fragmentOffset));
    if (
      !last ||
      streamSourceKey(last) !== streamSourceKey(event) ||
      last.configurationRevision !== event.configurationRevision ||
      last.time.clockId !== event.time.clockId ||
      last.time.precision.source !== event.time.precision.source ||
      last.time.precision.resolutionNs !== event.time.precision.resolutionNs ||
      last.payload.byteEnd !== event.payload.byteStart ||
      messageChanged ||
      (recordId
        ? recordId !== entry?.id
        : elapsed < 0n || elapsed > BigInt(this.receiveIdleMs) * 1_000_000n)
    ) {
      entry = {
        kind: "rx",
        id:
          recordId ??
          JSON.stringify([
            streamSourceKey(event),
            event.eventSeq,
            event.payload.byteStart,
          ]),
        segments: [],
        size: 0,
        receiveIdleMs: recordId
          ? recordedIdleMs
          : message
            ? undefined
            : this.receiveIdleMs,
      };
      this.entries.push(entry);
      this.activeReceive = entry;
    }
    const current = entry!;
    const binary = atob(event.payload.bytesBase64);
    let offset = 0;
    while (offset < binary.length) {
      let segment = current.segments.at(-1);
      if (!segment || segment.length === SEGMENT_BYTES) {
        segment = {
          event: {
            ...event,
            payload: {
              ...event.payload,
              byteStart: String(
                BigInt(event.payload.byteStart) + BigInt(offset),
              ),
              message: shiftedMessage(event.payload.message, offset),
            },
          },
          parts: [],
          length: 0,
        };
        current.segments.push(segment);
      }
      const part = binary.slice(
        offset,
        offset + SEGMENT_BYTES - segment.length,
      );
      segment.parts.push(part);
      segment.length += part.length;
      offset += part.length;
      segment.event = {
        ...event,
        payload: {
          ...event.payload,
          byteStart: segment.event.payload.byteStart,
          message: segment.event.payload.message,
          byteEnd: String(BigInt(event.payload.byteStart) + BigInt(offset)),
        },
      };
      segment.cached = undefined;
    }
    current.size += binary.length;
    this.retainedBytes += binary.length;
  }
  private markRemoved(item: StreamItem) {
    if (item.kind === "reader_gap") {
      this.removed.eventSeq = maximum(
        this.removed.eventSeq,
        item.gap.missingEventRange.end,
      );
      return;
    }
    const { event } = item;
    if (event.kind === "rx")
      this.removed.rxEnd = maximum(this.removed.rxEnd, event.payload.byteEnd);
    else if (event.kind === "tx" || event.kind === "tx_intent")
      this.removed.txEnd = maximum(this.removed.txEnd, event.payload.byteEnd);
    else this.removed.eventSeq = maximum(this.removed.eventSeq, event.eventSeq);
  }
  private trim(): boolean {
    let removed = 0;
    let changed = false;
    while (
      this.entries.length - removed > this.limits.maxRecords ||
      this.retainedBytes > this.limits.maxBytes
    ) {
      changed = true;
      const entry = this.entries[removed]!;
      if (
        this.entries.length - removed <= this.limits.maxRecords &&
        entry.kind === "rx" &&
        entry.size > this.retainedBytes - this.limits.maxBytes
      ) {
        let excess = this.retainedBytes - this.limits.maxBytes;
        entry.size -= excess;
        this.retainedBytes -= excess;
        while (excess > 0) {
          const segment = entry.segments[0]!;
          const count = Math.min(excess, segment.length);
          this.markRemoved({
            kind: "source",
            event: {
              ...segment.event,
              payload: {
                ...segment.event.payload,
                byteEnd: String(
                  BigInt(segment.event.payload.byteStart) + BigInt(count),
                ),
              },
            },
          });
          if (count === segment.length) entry.segments.shift();
          else {
            segment.parts = [segment.parts.join("").slice(count)];
            segment.length -= count;
            segment.event = {
              ...segment.event,
              payload: {
                ...segment.event.payload,
                byteStart: String(
                  BigInt(segment.event.payload.byteStart) + BigInt(count),
                ),
                message: shiftedMessage(segment.event.payload.message, count),
              },
            };
            segment.cached = undefined;
          }
          excess -= count;
        }
        this.trimmed = true;
        break;
      }
      if (entry.kind === "rx") {
        for (const segment of entry.segments)
          this.markRemoved({ kind: "source", event: segment.event });
        if (this.activeReceive === entry) this.activeReceive = undefined;
      } else {
        this.markRemoved(entry.item);
        if (entry.txKey) this.transmissions.delete(entry.txKey);
      }
      this.retainedBytes -= entry.size;
      removed++;
    }
    if (removed === 0) return changed;
    this.entries = this.entries.slice(removed);
    this.trimmed = true;
    return true;
  }
}
