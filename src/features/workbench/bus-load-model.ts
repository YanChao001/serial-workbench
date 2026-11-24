import type { RawEvent } from "@serial-workbench/contracts";
import { parseHex } from "@serial-workbench/host-client";
import { parseU64 } from "@/lib/u64";
import {
  ProtocolFieldError,
  type compileProtocolFields,
} from "../../../packages/plugin-sdk/examples/reference-framing/protocol-fields";
import { retainedSource } from "./field-chart-model";
import type { FramingInspection } from "./framing-anomalies-model";

export const busIntervals = [10, 100, 1000] as const;
export type BusInterval = (typeof busIntervals)[number];
type Codec = ReturnType<typeof compileProtocolFields>;
const maxBuckets = 60;

type BusBucket = {
  offsetMs: bigint;
  receivedBytes: bigint;
  acceptedBytes: bigint;
  unknownBytes: bigint;
  parsedFrames: number;
  failedFrames: number;
  gap: boolean;
  complete: boolean;
  framesComplete: boolean;
};

function length(start: string, end: string) {
  const from = parseU64(start);
  const after = parseU64(end);
  return from !== undefined && after !== undefined && after > from
    ? after - from
    : 0n;
}

function txBytes(ranges: { start: string; end: string }[]) {
  return ranges.reduce(
    (bytes, { start, end }) => bytes + length(start, end),
    0n,
  );
}

function invalidFrame(codec: Codec, bytes: Uint8Array) {
  if (bytes.length !== codec.byteLength) return true;
  try {
    return codec.decode(bytes).some((field) => field.checksum?.valid === false);
  } catch (error) {
    if (error instanceof ProtocolFieldError) return true;
    throw error;
  }
}

export function busLoad(
  inspection: FramingInspection,
  intervalMs: BusInterval,
  codec?: Codec,
) {
  const events = new Map<bigint, RawEvent>();
  const { target } = inspection;
  for (const item of inspection.items) {
    if (item.kind !== "source") continue;
    const event = item.event;
    const seq = parseU64(event.eventSeq);
    if (
      seq !== undefined &&
      event.hostId === target.hostId &&
      event.sessionId === target.sessionId &&
      event.sessionEpoch === target.sessionEpoch
    )
      events.set(seq, event);
  }
  const sequences = [...events.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const first = events.get(sequences[0] ?? -1n);
  const last = events.get(sequences.at(-1) ?? -1n);
  const origin = parseU64(first?.time.sourceMonoNs);
  const observedThrough = parseU64(last?.time.sourceMonoNs);
  if (
    !first ||
    origin === undefined ||
    observedThrough === undefined ||
    observedThrough < origin
  )
    return undefined;
  const width = BigInt(intervalMs) * 1_000_000n;
  const lastBucket = (observedThrough - origin) / width;
  const firstBucket =
    lastBucket >= BigInt(maxBuckets)
      ? lastBucket - BigInt(maxBuckets) + 1n
      : 0n;
  const buckets: BusBucket[] = Array.from(
    { length: Number(lastBucket - firstBucket + 1n) },
    (_, row) => ({
      offsetMs: (firstBucket + BigInt(row)) * BigInt(intervalMs),
      receivedBytes: 0n,
      acceptedBytes: 0n,
      unknownBytes: 0n,
      parsedFrames: 0,
      failedFrames: 0,
      gap: false,
      complete: false,
      framesComplete: false,
    }),
  );
  const bucketIndex = (time: bigint) => (time - origin) / width - firstBucket;
  const tick = new Map<bigint, bigint>();
  let previousSeq: bigint | undefined;
  let previousTime = origin;
  let resolution = 0n;
  for (const seq of sequences) {
    const event = events.get(seq)!;
    const time = parseU64(event.time.sourceMonoNs);
    if (
      event.time.clockId !== first.time.clockId ||
      event.instanceEpoch !== first.instanceEpoch ||
      time === undefined ||
      time < previousTime
    )
      return undefined;
    const eventResolution = parseU64(event.time.precision.resolutionNs);
    if (eventResolution === undefined) return undefined;
    if (eventResolution > resolution) resolution = eventResolution;
    tick.set(seq, time);
    const index = bucketIndex(time);
    if (
      event.kind === "gap" ||
      (previousSeq !== undefined && seq !== previousSeq + 1n)
    ) {
      const from = bucketIndex(previousTime);
      for (let row = from >= 0n ? Number(from) : 0; row <= Number(index); row++)
        buckets[row]!.gap = true;
    }
    previousSeq = seq;
    previousTime = time;
    const bucket = buckets[Number(index)];
    if (!bucket) continue;
    if (event.kind === "rx") {
      bucket.receivedBytes += length(
        event.payload.byteStart,
        event.payload.byteEnd,
      );
    } else if (event.kind === "tx") {
      bucket.acceptedBytes += txBytes(event.payload.acceptedRanges);
      bucket.unknownBytes += txBytes(event.payload.unknownRanges);
    }
  }

  let unresolved = 0;
  let parsedThrough: bigint | undefined;
  for (const frame of inspection.frames) {
    const after = parseU64(frame.eventEnd);
    const bytes = parseHex(frame.hex);
    if (after === undefined || !retainedSource(frame, bytes, events)) {
      unresolved += 1;
      continue;
    }
    const time = tick.get(after - 1n);
    if (time === undefined) {
      unresolved += 1;
      continue;
    }
    if (parsedThrough === undefined || time > parsedThrough)
      parsedThrough = time;
    const bucket = buckets[Number(bucketIndex(time))];
    if (!bucket) continue;
    bucket.parsedFrames += 1;
    if (codec && invalidFrame(codec, bytes)) bucket.failedFrames += 1;
  }
  const endSeq = parseU64(inspection.endEventSeq);
  const frameCoverage =
    endSeq === undefined
      ? parsedThrough
      : (tick.get(endSeq - 1n) ?? parsedThrough);
  const frameStartSeq = inspection.frameStart
    ? parseU64(inspection.frameStart.eventSeq)
    : sequences[0];
  const frameStartEvent =
    frameStartSeq === undefined ? undefined : events.get(frameStartSeq);
  const frameStartTime =
    frameStartSeq === undefined ? undefined : tick.get(frameStartSeq);
  const selectedByte = inspection.frameStart?.byteStart;
  // 块内游标和同时间刻度的前序事件都可能留下未扫描的前缀。
  const partialStart =
    (selectedByte !== undefined &&
      (frameStartEvent?.kind !== "rx" ||
        selectedByte !== frameStartEvent.payload.byteStart)) ||
    (frameStartSeq !== undefined &&
      frameStartTime !== undefined &&
      tick.get(frameStartSeq - 1n) === frameStartTime);
  for (const bucket of buckets) {
    const start = origin + bucket.offsetMs * 1_000_000n;
    const end = start + width;
    bucket.complete = !bucket.gap && end <= observedThrough;
    bucket.framesComplete =
      bucket.complete &&
      unresolved === 0 &&
      frameStartTime !== undefined &&
      (start > frameStartTime || (start === frameStartTime && !partialStart)) &&
      frameCoverage !== undefined &&
      end <= frameCoverage;
  }
  return {
    clock: first.time.clockId,
    resolution: String(resolution),
    origin: String(origin),
    observedThrough: String(observedThrough),
    buckets,
    unresolved,
    hasCodec: Boolean(codec),
  };
}
