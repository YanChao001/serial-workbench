import type { CaptureRecord, RawEvent } from "@serial-workbench/contracts";
import { parseHex } from "@serial-workbench/host-client";
import { parseU64, U64_MAX } from "@/lib/u64";
import type { ComparisonFrame } from "../../../packages/plugin-sdk/examples/reference-protocol-fields/session-comparison";
import { retainedSource } from "./field-chart-model";
import { replayFieldPage } from "./replay-field-source";

type ReplayComparisonFrame = ComparisonFrame & {
  source: {
    eventStart: string;
    eventEnd: string;
    byteStart: string;
    byteEnd: string;
    firstRecord?: string;
    lastRecord?: string;
  };
};

export function replayComparisonFrames(
  records: readonly CaptureRecord[],
  source: Extract<RawEvent, { kind: "rx" }>,
  anchor: bigint,
  width: number,
) {
  if (
    anchor < 0n ||
    anchor > U64_MAX ||
    !Number.isInteger(width) ||
    width < 1 ||
    width > 4096
  )
    return;
  const result = replayFieldPage(records, source, anchor, width);
  if (!result) return;
  return projectReplayComparison(result, anchor, width);
}

export function projectReplayComparison(
  result: NonNullable<ReturnType<typeof replayFieldPage>>,
  anchor: bigint,
  width: number,
) {
  const { inspection } = result;
  const events = new Map<bigint, RawEvent>();
  for (const item of inspection.items)
    if (item.kind === "source")
      events.set(BigInt(item.event.eventSeq), item.event);

  const frames: ReplayComparisonFrame[] = [];
  let segment = 0;
  let unresolved = 0;
  for (const frame of inspection.frames) {
    const bytes = parseHex(frame.hex);
    const provenance = retainedSource(frame, bytes, events);
    if (!provenance) {
      unresolved++;
      segment++;
      continue;
    }
    if (inspection.breaks?.has(frame.byteStart)) segment++;
    const last = BigInt(frame.eventEnd) - 1n;
    const sourceTime = events.get(last)?.time;
    const timestamp = parseU64(sourceTime?.sourceMonoNs);
    frames.push({
      position: (BigInt(frame.byteStart) - anchor) / BigInt(width) + 1n,
      bytes,
      time:
        timestamp === undefined || !sourceTime
          ? undefined
          : { clockId: sourceTime.clockId, monoNs: timestamp, segment },
      source: {
        eventStart: frame.eventStart,
        eventEnd: frame.eventEnd,
        byteStart: frame.byteStart,
        byteEnd: frame.byteEnd,
        firstRecord: inspection.recordOrdinals?.get(frame.eventStart),
        lastRecord: inspection.recordOrdinals?.get(String(last)),
      },
    });
  }
  return {
    source: inspection.target,
    anchor: String(anchor),
    width,
    frames,
    gap: result.gap || unresolved > 0,
    limited: result.limited,
  };
}

export type ReplayComparisonSample = ReturnType<typeof projectReplayComparison>;
export type ComparisonSide = "baseline" | "candidate";
