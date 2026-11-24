import {
  ContractValidationError,
  type StreamItem,
  type Target,
} from "@serial-workbench/contracts";
import { isRecord } from "@/lib/settings-model";
import { parseU64 } from "@/lib/u64";

export const modbusTimelineAction = "swb.reference.modbus.transaction";

export function modbusStartEventSeq(
  items: readonly StreamItem[],
  target: Target,
) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item?.kind !== "source") continue;
    const event = item.event;
    if (
      event.hostId === target.hostId &&
      event.sessionId === target.sessionId &&
      event.sessionEpoch === target.sessionEpoch
    )
      return event.eventSeq;
  }
  return "1";
}

const outcomes = [
  "matched",
  "device_exception",
  "invalid_response",
  "response_timeout",
  "source_changed",
  "transmit_unconfirmed",
  "broadcast_completed",
] as const;
const clockSources = [
  "host_read",
  "device",
  "line_capture",
  "sample_clock",
] as const;
type Outcome = (typeof outcomes)[number];
type Point = {
  event: bigint;
  ns: bigint;
  clockId: string;
  source: (typeof clockSources)[number];
  resolution: bigint;
};

export type TimelineAttempt = {
  operationId: string;
  outcome: Outcome;
  transactionId?: number;
  ignoredFrames: number;
  tx?: Point;
  response?: {
    first: Point;
    last: Point;
    attributionKnown: boolean;
    byteStart: bigint;
    byteEnd: bigint;
    late: boolean;
    bytesBase64?: string;
    exceptionCode?: number;
  };
};

function invalid(): never {
  throw new ContractValidationError("Invalid Modbus transaction timeline");
}

function exactInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function outcome(value: unknown): Outcome {
  return outcomes.find((item) => item === value) ?? invalid();
}

function point(value: unknown): Point {
  if (!isRecord(value) || typeof value.clockId !== "string" || !value.clockId)
    return invalid();
  const { clockId } = value;
  const event = parseU64(value.eventSeq);
  const ns = parseU64(value.monoNs);
  const resolution = parseU64(value.resolutionNs);
  const source = clockSources.find((item) => item === value.source);
  if (
    event === undefined ||
    event === 0n ||
    ns === undefined ||
    resolution === undefined ||
    !source
  )
    return invalid();
  return { event, ns, resolution, source, clockId };
}

function response(
  value: unknown,
  late: boolean,
  trace: Record<string, unknown>,
  tx: Point,
  target: Target,
): NonNullable<TimelineAttempt["response"]> {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.timing))
    return invalid();
  const { source, timing, exceptionCode } = value;
  const first = point(trace.rxFirst);
  const last = point(trace.rxLast);
  const byteStart = parseU64(source.byteStart);
  const byteEnd = parseU64(source.byteEnd);
  const attributionKnown = timing.attemptAttribution !== "indeterminate";
  if (
    source.hostId !== target.hostId ||
    source.sessionId !== target.sessionId ||
    source.sessionEpoch !== target.sessionEpoch ||
    source.direction !== "rx" ||
    parseU64(source.eventStart) !== first.event ||
    parseU64(source.eventEnd) !== last.event + 1n ||
    byteStart === undefined ||
    byteEnd === undefined ||
    byteEnd <= byteStart ||
    first.event > last.event ||
    first.ns > last.ns ||
    tx.ns > last.ns ||
    first.clockId !== tx.clockId ||
    last.clockId !== tx.clockId ||
    timing.clockId !== tx.clockId ||
    parseU64(timing.txMonoNs) !== tx.ns ||
    parseU64(timing.rxMonoNs) !== last.ns ||
    (attributionKnown
      ? parseU64(timing.elapsedNs) !== last.ns - tx.ns
      : timing.elapsedNs !== undefined) ||
    (exceptionCode !== undefined && !exactInteger(exceptionCode, 1, 255))
  )
    return invalid();
  return {
    first,
    last,
    attributionKnown,
    byteStart,
    byteEnd,
    late,
    bytesBase64:
      typeof value.bytesBase64 === "string" ? value.bytesBase64 : undefined,
    exceptionCode,
  };
}

function attempt(value: unknown, target: Target): TimelineAttempt {
  if (!isRecord(value)) return invalid();
  const { operationId, requestTransactionId, ignoredFrames, trace } = value;
  const result = outcome(value.outcome);
  if (
    typeof operationId !== "string" ||
    !operationId ||
    result === "broadcast_completed" ||
    !exactInteger(ignoredFrames, 0, 32) ||
    (requestTransactionId !== undefined &&
      !exactInteger(requestTransactionId, 0, 65_535)) ||
    (trace !== undefined && !isRecord(trace))
  )
    return invalid();
  const parsed: TimelineAttempt = {
    operationId,
    outcome: result,
    transactionId: requestTransactionId,
    ignoredFrames,
  };
  const received = value.response ?? value.lateResponse;
  if (trace) {
    parsed.tx = point(trace.tx);
    if (received !== undefined)
      parsed.response = response(
        received,
        value.lateResponse !== undefined,
        trace,
        parsed.tx,
        target,
      );
  }
  if (
    (received !== undefined && !parsed.response) ||
    (value.response !== undefined && value.lateResponse !== undefined) ||
    (Boolean(parsed.response) &&
      result !== "matched" &&
      result !== "device_exception" &&
      result !== "response_timeout") ||
    ((result === "matched" || result === "device_exception") &&
      (!parsed.response || parsed.response.late)) ||
    (result === "response_timeout" && parsed.response && !parsed.response.late)
  )
    return invalid();
  return parsed;
}

export function parseModbusTimeline(value: unknown, target: Target) {
  if (!isRecord(value)) return invalid();
  const settled = outcome(value.outcome);
  if (settled === "broadcast_completed") {
    if (
      !exactInteger(value.turnaroundMs, 10, 2000) ||
      value.attempts !== undefined
    )
      return invalid();
    return { attempts: [], turnaroundMs: value.turnaroundMs };
  }
  if (
    !Array.isArray(value.attempts) ||
    value.attempts.length < 1 ||
    value.attempts.length > 3
  )
    return invalid();
  const attempts = value.attempts.map((item: unknown) => attempt(item, target));
  const latest = attempts.at(-1);
  if (
    latest?.operationId !== value.operationId ||
    latest?.outcome !== settled ||
    new Set(attempts.map(({ operationId }) => operationId)).size !==
      attempts.length
  )
    return invalid();
  return { attempts, turnaroundMs: undefined };
}

export function timingMilliseconds(ns: bigint) {
  const delta = ns < 0n ? -ns : ns;
  const fraction = (delta % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0{1,3}$/, "");
  return `${ns < 0n ? "−" : ""}${delta / 1_000_000n}.${fraction}`;
}

export function timelineAxis(
  attempts: readonly TimelineAttempt[],
  windowNs: bigint,
) {
  const first = attempts.find((attempt) => attempt.tx)?.tx;
  if (!first) return undefined;
  let start = first.ns;
  let end = first.ns + windowNs;
  for (const { tx, response } of attempts) {
    if (!tx || tx.clockId !== first.clockId) continue;
    if (response && response.first.ns < start) start = response.first.ns;
    if (response && response.last.ns > end) end = response.last.ns;
    if (tx.ns + windowNs > end) end = tx.ns + windowNs;
  }
  return { start, end, baseline: first.ns, clockId: first.clockId };
}
