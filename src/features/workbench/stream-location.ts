import type { RawEvent, StreamItem } from "@serial-workbench/contracts";
import type { HistoryStreamItem } from "@/lib/receive-history";

export const STREAM_LOCATION_KINDS = [
  "reference",
  "event",
  "packet",
  "line",
] as const;
export type StreamLocationKind = (typeof STREAM_LOCATION_KINDS)[number];

const REFERENCE_PREFIX = "SWB1 ";
const MAX_UINT64 = 18_446_744_073_709_551_615n;

type EventLocation = [
  host: string,
  hostEpoch: string,
  session: string,
  sessionEpoch: string,
  event: string,
  byteStart: string | null,
];

type NumberedEvent = { locator: EventLocation; packet?: number };
export type NumberedStreamRow = {
  itemIndex: number;
  line: number;
  events: NumberedEvent[];
};
type StreamLocations = ReadonlyMap<number, NumberedStreamRow>;

function byteStart(event: RawEvent): string | null {
  return event.kind === "rx" ||
    event.kind === "tx" ||
    event.kind === "tx_intent"
    ? event.payload.byteStart
    : null;
}

function eventLocation(event: RawEvent): EventLocation {
  return [
    event.hostId,
    event.instanceEpoch,
    event.sessionId,
    event.sessionEpoch,
    event.eventSeq,
    byteStart(event),
  ];
}

export function streamLocationReference(location: EventLocation): string {
  return REFERENCE_PREFIX + JSON.stringify(location);
}

function unsignedDecimal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d{0,19})$/.test(value) &&
    BigInt(value) <= MAX_UINT64
  );
}

function parseReference(value: string): string | undefined {
  if (!value.startsWith(REFERENCE_PREFIX) || value.length > 4096) return;
  try {
    const parsed: unknown = JSON.parse(value.slice(REFERENCE_PREFIX.length));
    if (!Array.isArray(parsed) || parsed.length !== 6) return;
    const [host, hostEpoch, session, sessionEpoch, seq, offset] = parsed;
    if (
      typeof host !== "string" ||
      !host ||
      typeof session !== "string" ||
      !session ||
      !unsignedDecimal(hostEpoch) ||
      !unsignedDecimal(sessionEpoch) ||
      !unsignedDecimal(seq) ||
      (offset !== null && !unsignedDecimal(offset))
    )
      return;
    return streamLocationReference([
      host,
      hostEpoch,
      session,
      sessionEpoch,
      seq,
      offset,
    ]);
  } catch {
    return;
  }
}

export function numberStreamRows(
  rows: readonly { itemIndex: number; itemIndexes: readonly number[] }[],
  projected: readonly { item: StreamItem; itemIndex: number }[],
  original: readonly HistoryStreamItem[],
): StreamLocations {
  const packets = new Map<string, number>();
  const sources = new Map<number, NumberedEvent[]>();
  for (const { item, itemIndex } of projected) {
    if (item.kind !== "source") continue;
    const locator = eventLocation(item.event);
    const input = original[itemIndex];
    let packet: number | undefined;
    if (locator[5] !== null) {
      const packetKey =
        input?.displayRecord ?? streamLocationReference(locator);
      packet = packets.get(packetKey);
      if (packet === undefined) {
        packet = packets.size + 1;
        packets.set(packetKey, packet);
      }
    }
    const events: NumberedEvent[] = [{ locator, packet }];
    // The visible TX receipt occupies the original intent row. Both source events remain addressable.
    if (
      input?.kind === "source" &&
      input.event.eventSeq !== item.event.eventSeq
    )
      events.unshift({ locator: eventLocation(input.event), packet });
    sources.set(itemIndex, events);
  }
  return new Map(
    rows.map((row, index) => [
      row.itemIndex,
      {
        itemIndex: row.itemIndex,
        line: index + 1,
        events: row.itemIndexes.flatMap(
          (itemIndex) => sources.get(itemIndex) ?? [],
        ),
      },
    ]),
  );
}

type StreamLocationResult =
  | { kind: "found"; row: NumberedStreamRow; event: NumberedEvent | undefined }
  | { kind: "invalid" | "unavailable" | "ambiguous" };

export function findStreamLocation(
  rows: StreamLocations,
  kind: StreamLocationKind,
  input: string,
): StreamLocationResult {
  const value = input.trim();
  const reference = kind === "reference" ? parseReference(value) : undefined;
  if (kind === "reference" ? !reference : !unsignedDecimal(value))
    return { kind: "invalid" };

  let found: Extract<StreamLocationResult, { kind: "found" }> | undefined;
  for (const row of rows.values()) {
    if (kind === "line" && String(row.line) === value)
      return { kind: "found", row, event: row.events[0] };
    if (kind === "line") continue;
    for (const event of row.events) {
      if (reference && streamLocationReference(event.locator) === reference)
        return { kind: "found", row, event };
      if (kind === "packet" && String(event.packet) === value)
        return { kind: "found", row, event };
      if (kind !== "event" || event.locator[4] !== value) continue;
      if (
        found &&
        found.event?.locator
          .slice(0, 4)
          .some((part, index) => part !== event.locator[index])
      )
        return { kind: "ambiguous" };
      found ??= { kind: "found", row, event };
    }
  }
  return found ?? { kind: "unavailable" };
}
