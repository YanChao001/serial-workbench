import type { RawEvent, StreamItem } from "@serial-workbench/contracts";
import { streamSourceKey } from "@/lib/stream-source";

export const receiveComparisonModes = ["time", "event", "offset"] as const;
export type ReceiveComparisonMode = (typeof receiveComparisonModes)[number];

type RxEvent = Extract<RawEvent, { kind: "rx" }>;
type ReceiveRow = {
  kind: "rx";
  key: string;
  event: RxEvent;
  start: bigint;
  end: bigint;
  clock: string;
  time: bigint;
};
type BoundaryRow = {
  kind: "gap" | "configuration";
  key: string;
};
export type ReceiveComparisonRow = ReceiveRow | BoundaryRow;
export const receiveComparisonToleranceMs = 100;
const toleranceNs = BigInt(receiveComparisonToleranceMs) * 1_000_000n;

export function liveReceiveRows(
  items: readonly StreamItem[],
  source: Parameters<typeof streamSourceKey>[0],
): ReceiveComparisonRow[] {
  const scope = streamSourceKey(source);
  const rows: ReceiveComparisonRow[] = [];
  for (const item of items) {
    if (item.kind === "reader_gap") {
      if (streamSourceKey(item.gap) === scope) {
        const { start, end } = item.gap.missingEventRange;
        rows.push({ kind: "gap", key: "reader:" + start + ":" + end });
      }
      continue;
    }
    const { event } = item;
    if (streamSourceKey(event) !== scope) continue;
    if (event.kind === "gap" || event.kind === "configuration_boundary") {
      rows.push({
        kind: event.kind === "gap" ? "gap" : "configuration",
        key: "boundary:" + event.eventSeq,
      });
    } else if (event.kind === "rx") {
      const { byteStart, byteEnd } = event.payload;
      rows.push({
        kind: "rx",
        key: event.eventSeq + ":" + byteStart,
        event,
        start: BigInt(byteStart),
        end: BigInt(byteEnd),
        clock: JSON.stringify([
          event.hostId,
          event.instanceEpoch,
          event.time.clockId,
        ]),
        time: BigInt(event.time.sourceMonoNs),
      });
    }
  }
  return rows;
}

export function matchLiveReceiveRow(
  source: ReceiveComparisonRow,
  target: readonly ReceiveComparisonRow[],
  mode: ReceiveComparisonMode,
): { key: string; timeDeltaNs?: bigint } | undefined {
  if (source.kind !== "rx") return;
  if (mode !== "time") {
    const matched = target.find(
      (row) =>
        row.kind === "rx" &&
        (mode === "event"
          ? row.event.eventSeq === source.event.eventSeq
          : row.start <= source.start && source.start < row.end),
    );
    return matched && { key: matched.key };
  }

  let previous: ReceiveRow | undefined;
  for (const row of target) {
    if (row.kind !== "rx" || row.clock !== source.clock) {
      previous = undefined;
      continue;
    }
    if (row.time === source.time) return { key: row.key, timeDeltaNs: 0n };
    // 邻近时间需要两条同一连续段中的证据，不能跨缺口或对端留存边界。
    if (
      previous &&
      previous.event.configurationRevision ===
        row.event.configurationRevision &&
      previous.time <= source.time &&
      source.time < row.time
    ) {
      const before = source.time - previous.time;
      const after = row.time - source.time;
      const nearest = before <= after ? previous : row;
      const delta = nearest.time - source.time;
      if (delta >= -toleranceNs && delta <= toleranceNs)
        return { key: nearest.key, timeDeltaNs: delta };
    }
    previous = row;
  }
}
