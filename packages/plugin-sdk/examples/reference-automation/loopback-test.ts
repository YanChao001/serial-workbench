import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Call,
  NodeTaskContext,
  SourceRange,
  StreamReadResult,
} from "@serial-workbench/plugin-sdk/node";
import {
  acquireTransaction,
  maxPageReads,
  pollMs,
  readSession,
  releaseTransaction,
  retainedTail,
  sendTransactionWithDeadline,
  type Session,
} from "./session-transaction.ts";

export const builtinLoopbackTestAction = "swb.builtin.automation.loopback";

const headerBytes = 16;
const leaseMs = 30_000;
const taskBudgetMs = 20_000;
const maxU64 = 18_446_744_073_709_551_615n;

type Event = StreamReadResult["events"][number];
type FrameOutcome =
  | "compared"
  | "marker_mismatch"
  | "missing_bytes"
  | "response_timeout"
  | "unexpected_bytes"
  | "source_changed"
  | "transmit_unconfirmed"
  | "timing_unavailable";

function boundedInteger(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error("Loopback requires bounded integer settings");
  return value;
}

function frameBytes(
  seed: number,
  sequence: number,
  size: number,
  runTag: Buffer,
): Buffer {
  const frame = Buffer.alloc(size);
  frame.writeUInt32LE(seed, 0);
  frame.writeUInt32LE(sequence, 4);
  runTag.copy(frame, 8);
  // xorshift32. Keep the seed and sequence in the wire format and avoid
  // the zero state when generating the reproducible payload.
  let state = seed ^ Math.imul(sequence, 0x9e3779b9) || 0x6d2b79f5;
  for (let i = headerBytes; i < size; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    frame[i] = state & 0xff;
  }
  return frame;
}

function countBitErrors(expected: Buffer, observed: Buffer): number {
  let count = 0;
  for (let i = headerBytes; i < expected.length; i++) {
    let difference = expected[i]! ^ observed[i]!;
    while (difference) {
      difference &= difference - 1;
      count++;
    }
  }
  return count;
}

async function readProbe(
  task: NodeTaskContext,
  session: Session,
  operationId: string,
  expected: Buffer,
  configurationRevision: string,
  initialCursor: string,
  deadline: number,
  timeoutMs: number,
) {
  const observed = Buffer.alloc(expected.length);
  const sent = expected.toString("base64");
  let cursor = initialCursor;
  let receivedBytes = 0;
  let confirmed = false;
  let intent: Extract<Event, { kind: "tx_intent" }> | undefined;
  let first: Extract<Event, { kind: "rx" }> | undefined;
  let last: Extract<Event, { kind: "rx" }> | undefined;
  let pages = 0;
  const sourceRange = (): SourceRange | null =>
    first && last
      ? {
          hostId: session.hostId,
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          direction: "rx",
          eventStart: first.eventSeq,
          eventEnd: String(BigInt(last.eventSeq) + 1n),
          byteStart: first.payload.byteStart,
          byteEnd: last.payload.byteEnd,
        }
      : null;
  const finish = (outcome: FrameOutcome) => ({
    cursor,
    outcome,
    receivedBytes,
    comparison: null,
    source: sourceRange(),
  });

  for (;;) {
    const finalRead = performance.now() >= deadline;
    const page = await readSession(task, session, cursor);
    for (const event of page.events) {
      task.signal.throwIfAborted();
      if (
        event.hostId !== session.hostId ||
        event.sessionId !== session.sessionId ||
        event.sessionEpoch !== session.sessionEpoch ||
        event.eventSeq !== cursor ||
        event.configurationRevision !== configurationRevision ||
        event.kind === "gap" ||
        event.kind === "configuration_boundary" ||
        event.kind === "lifecycle" ||
        event.kind === "control"
      )
        return finish("source_changed");
      cursor = String(BigInt(event.eventSeq) + 1n);
      if (event.kind === "tx_intent") {
        if (
          intent ||
          event.payload.operationId !== operationId ||
          event.payload.bytesBase64 !== sent
        )
          return finish("source_changed");
        intent = event;
      } else if (event.kind === "tx") {
        if (!intent || confirmed || event.payload.operationId !== operationId)
          return finish("source_changed");
        const receipt = event.payload;
        if (
          receipt.sessionId !== session.sessionId ||
          receipt.sessionEpoch !== session.sessionEpoch ||
          receipt.bytesBase64 !== sent ||
          receipt.byteStart !== intent.payload.byteStart ||
          receipt.byteEnd !== intent.payload.byteEnd ||
          receipt.outcome !== "accepted" ||
          receipt.unknownRanges.length
        )
          return finish("transmit_unconfirmed");
        confirmed = true;
      } else if (event.kind === "rx") {
        if (!intent) return finish("unexpected_bytes");
        if (
          event.time.clockId !== intent.time.clockId ||
          BigInt(event.time.sourceMonoNs) <
            BigInt((last ?? intent).time.sourceMonoNs)
        )
          return finish("timing_unavailable");
        const { byteStart, byteEnd, bytesBase64 } = event.payload;
        const bytes = Buffer.from(bytesBase64, "base64");
        if (
          (last && last.payload.byteEnd !== byteStart) ||
          BigInt(byteEnd) - BigInt(byteStart) !== BigInt(bytes.length)
        )
          return finish("source_changed");
        if (receivedBytes + bytes.length > expected.length)
          return finish("unexpected_bytes");
        if (!bytes.length) continue;
        first ??= event;
        last = event;
        bytes.copy(observed, receivedBytes);
        receivedBytes += bytes.length;
      }
    }
    if (page.nextEventSeq !== cursor) return finish("source_changed");
    if (page.hasMore) {
      if (++pages >= maxPageReads) return finish("source_changed");
      continue;
    }
    pages = 0;
    if (
      intent &&
      confirmed &&
      first &&
      last &&
      receivedBytes === expected.length
    ) {
      const elapsed =
        BigInt(last.time.sourceMonoNs) - BigInt(intent.time.sourceMonoNs);
      if (last.time.clockId !== intent.time.clockId || elapsed < 0n)
        return finish("timing_unavailable");
      if (elapsed > BigInt(timeoutMs) * 1_000_000n)
        return finish("response_timeout");
      if (
        !expected
          .subarray(0, headerBytes)
          .equals(observed.subarray(0, headerBytes))
      )
        return finish("marker_mismatch");
      return {
        cursor,
        outcome: "compared" as const,
        receivedBytes,
        source: sourceRange(),
        comparison: {
          started: intent.time,
          ended: last.time,
          bitErrors: countBitErrors(expected, observed),
          comparedBits: (expected.length - headerBytes) * 8,
          latencyNs: Number(elapsed),
        },
      };
    }
    if (finalRead) {
      if (!confirmed) return finish("transmit_unconfirmed");
      return finish(receivedBytes ? "missing_bytes" : "response_timeout");
    }
    const wait = Math.min(pollMs, deadline - performance.now());
    if (wait > 0) await delay(wait, undefined, { signal: task.signal });
  }
}

export async function loopbackTest(
  { target, params }: Call,
  task: NodeTaskContext,
) {
  const { sessionId, sessionEpoch } = target;
  const {
    startEventSeq,
    configurationRevision,
    sessionRevision,
    source,
    wired,
  } = params;
  const count = boundedInteger(params.count, 1, 16);
  const size = boundedInteger(params.frameBytes, 24, 256);
  const seed = boundedInteger(params.seed, 0, 0xffff_ffff);
  const timeoutMs = boundedInteger(params.timeoutMs, 50, 5000);
  if (
    target.kind !== "session" ||
    target.id !== sessionId ||
    !sessionEpoch ||
    typeof startEventSeq !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(startEventSeq) ||
    BigInt(startEventSeq) > maxU64 ||
    typeof configurationRevision !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(configurationRevision) ||
    BigInt(configurationRevision) > maxU64 ||
    typeof sessionRevision !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(sessionRevision) ||
    BigInt(sessionRevision) >= maxU64 ||
    (source !== "virtual_echo" && source !== "serial_loopback") ||
    (source === "serial_loopback" ? wired !== true : wired === true) ||
    count * timeoutMs > 15_000
  )
    throw new Error(
      "Loopback requires a confirmed source, exact session, and bounded duration",
    );

  const runTag = randomBytes(8);
  const session = { ...target, sessionId, sessionEpoch };
  const leaseId = await acquireTransaction(
    task,
    session,
    leaseMs,
    sessionRevision,
  );
  const leasedRevision = String(BigInt(sessionRevision) + 1n);
  try {
    const deadline = performance.now() + taskBudgetMs;
    let cursor = await retainedTail(task, session, startEventSeq);
    let bitErrors = 0;
    let comparedBits = 0;
    let sentBytes = 0;
    let comparedFrames = 0;
    let clockId: string | undefined;
    let comparableClocks = true;
    let started: bigint | undefined;
    let ended: bigint | undefined;
    const latencies: number[] = [];
    const frames = [];
    let outcome: FrameOutcome | "completed" | "duration_limit" = "completed";

    for (let sequence = 1; sequence <= count; sequence++) {
      task.signal.throwIfAborted();
      const remainingMs = Math.floor(deadline - performance.now());
      if (remainingMs < timeoutMs) {
        outcome = "duration_limit";
        break;
      }
      const expected = frameBytes(seed, sequence, size, runTag);
      const stopAt = performance.now() + timeoutMs;
      const transmission = await sendTransactionWithDeadline(
        task,
        session,
        leaseId,
        expected.toString("base64"),
        timeoutMs,
        leasedRevision,
      );
      if (!transmission.confirmed) {
        outcome = "transmit_unconfirmed";
        frames.push({
          sequence,
          operationId: transmission.operationId,
          outcome,
          receivedBytes: 0,
        });
        break;
      }
      sentBytes += size;
      const probe = await readProbe(
        task,
        session,
        transmission.operationId,
        expected,
        configurationRevision,
        cursor,
        stopAt,
        timeoutMs,
      );
      cursor = probe.cursor;
      const comparison = probe.comparison;
      const frame = {
        sequence,
        operationId: transmission.operationId,
        outcome: probe.outcome,
        receivedBytes: probe.receivedBytes,
        ...(probe.source ? { source: probe.source } : {}),
      };
      if (!comparison) {
        frames.push(frame);
        outcome = probe.outcome;
        break;
      }
      const { started: start, ended: end, latencyNs } = comparison;
      frames.push({
        ...frame,
        latencyNs,
        bitErrors: comparison.bitErrors,
        comparedBits: comparison.comparedBits,
      });
      comparedFrames++;
      comparedBits += comparison.comparedBits;
      bitErrors += comparison.bitErrors;
      clockId ??= start.clockId;
      started ??= BigInt(start.sourceMonoNs);
      const nextEnd = BigInt(end.sourceMonoNs);
      comparableClocks &&=
        start.clockId === clockId &&
        (ended === undefined || ended <= BigInt(start.sourceMonoNs));
      ended = nextEnd;
      latencies.push(latencyNs);
      task.progress.report({
        completed: String(comparedFrames),
        total: String(count),
        unit: "frames",
      });
    }

    const duration =
      comparableClocks && ended !== undefined && started !== undefined
        ? Number(ended - started)
        : 0;
    return {
      outcome,
      source,
      seed,
      runTag: runTag.toString("hex"),
      frameBytes: size,
      requestedFrames: count,
      sentBytes,
      comparedFrames,
      comparedBits,
      bitErrors,
      bitErrorRate: comparedBits ? bitErrors / comparedBits : null,
      throughputBytesPerSecond:
        duration > 0 ? (comparedFrames * size * 1e9) / duration : null,
      latencyNs:
        latencies.length && comparableClocks
          ? {
              min: Math.min(...latencies),
              max: Math.max(...latencies),
              mean:
                latencies.reduce((sum, value) => sum + value, 0) /
                latencies.length,
            }
          : null,
      frames,
    };
  } finally {
    // Cancelling the parent retires its transaction child and releases the lease.
    if (!task.signal.aborted) await releaseTransaction(task, session, leaseId);
  }
}
