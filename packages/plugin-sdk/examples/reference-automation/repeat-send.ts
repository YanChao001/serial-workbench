import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  NodeActionHandler,
  NodeTaskContext,
  StreamReadResult,
} from "@serial-workbench/plugin-sdk/node";
import {
  acquireTransaction,
  maxPageReads,
  pollMs,
  readSession,
  releaseTransaction,
  retainedTail,
  sendTransaction,
  type Session,
} from "./session-transaction.ts";
import {
  decodeAutomationFrame,
  readExpectedResponse,
  type ResponseOutcome,
  type ReceiveObserver,
} from "./session-response.ts";

import {
  repeatSendAction,
  repeatSendLimits,
  repeatJitterLimit,
} from "./repeat-send-settings.ts";

export { repeatSendAction };
type RepeatClock = {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  jitter(limit: number): number;
};
const monotonicClock: RepeatClock = {
  now: () => performance.now(),
  wait: (ms, signal) =>
    delay(Math.max(1, Math.ceil(ms)), undefined, { signal }),
  jitter: (limit) => (limit === 0 ? 0 : randomInt(-limit, limit + 1)),
};
type Outcome =
  | "completed"
  | "start_timeout"
  | "stop_condition"
  | Exclude<ResponseOutcome, "matched">;
type Event = StreamReadResult["events"][number];

function integer(
  name: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error("Invalid repeat send setting " + name);
  return value;
}

function parsePlan(params: Parameters<NodeActionHandler>[0]["params"]) {
  const periodMs = integer(
    "periodMs",
    params.periodMs,
    ...repeatSendLimits.periodMs,
  );
  const startEventSeq = params.startEventSeq ?? "1";
  if (
    typeof startEventSeq !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(startEventSeq) ||
    BigInt(startEventSeq) > 18_446_744_073_709_551_615n
  )
    throw new Error("Repeat send requires an exact source event cursor");
  return {
    startEventSeq,
    bytes: decodeAutomationFrame(params.sendBase64).toString("base64"),
    periodMs,
    count: integer("count", params.count, ...repeatSendLimits.count),
    jitterMs: integer(
      "jitterMs",
      params.jitterMs ?? 0,
      0,
      repeatJitterLimit(periodMs),
    ),
    startDelayMs: integer(
      "startDelayMs",
      params.startDelayMs ?? 0,
      ...repeatSendLimits.startDelayMs,
    ),
    startTimeoutMs: integer(
      "startTimeoutMs",
      params.startTimeoutMs ?? 5000,
      ...repeatSendLimits.startTimeoutMs,
    ),
    responseTimeoutMs: integer(
      "responseTimeoutMs",
      params.responseTimeoutMs ?? 1000,
      ...repeatSendLimits.responseTimeoutMs,
    ),
    startOn:
      params.startOnBase64 === undefined
        ? undefined
        : decodeAutomationFrame(params.startOnBase64),
    stopOn:
      params.stopOnBase64 === undefined
        ? undefined
        : decodeAutomationFrame(params.stopOnBase64),
    expected:
      params.expectBase64 === undefined
        ? undefined
        : decodeAutomationFrame(params.expectBase64),
  };
}

function observePattern(
  pattern: Buffer,
  afterMatch?: (event: Parameters<ReceiveObserver>[0]) => void,
): ReceiveObserver {
  let suffix: Buffer = Buffer.alloc(0);
  let nextByte: string | undefined;
  return (event) => {
    const { payload } = event;
    const { byteStart, byteEnd, bytesBase64 } = payload;
    const bytes = Buffer.from(bytesBase64, "base64");
    if (
      (nextByte !== undefined && nextByte !== byteStart) ||
      BigInt(byteEnd) - BigInt(byteStart) !== BigInt(bytes.length)
    )
      return "source_changed";
    nextByte = byteEnd;
    const input = Buffer.concat([suffix, bytes]);
    const first = input.indexOf(pattern);
    if (first >= 0) {
      const end = first + pattern.length - suffix.length;
      if (afterMatch && end < bytes.length) {
        afterMatch({
          ...event,
          payload: {
            ...payload,
            byteStart: String(BigInt(byteStart) + BigInt(end)),
            bytesBase64: bytes.subarray(end).toString("base64"),
          },
        });
      }
      return "condition_met";
    }
    suffix = input.subarray(Math.max(0, input.length - (pattern.length - 1)));
    return undefined;
  };
}

function sourceChanged(event: Event, session: Session) {
  return (
    event.hostId !== session.hostId ||
    event.sessionId !== session.sessionId ||
    event.sessionEpoch !== session.sessionEpoch ||
    event.kind === "gap" ||
    event.kind === "configuration_boundary"
  );
}

async function observeUntil(
  task: NodeTaskContext,
  session: Session,
  cursor: string,
  observer: ReceiveObserver,
  deadline: number,
  clock: RepeatClock,
) {
  let pages = 0;
  while (true) {
    const finalRead = clock.now() >= deadline;
    const page = await readSession(task, session, cursor);
    for (const event of page.events) {
      task.signal.throwIfAborted();
      if (sourceChanged(event, session))
        return { cursor, outcome: "source_changed" as const };
      cursor = String(BigInt(event.eventSeq) + 1n);
      const outcome = event.kind === "rx" ? observer(event) : undefined;
      if (outcome) return { cursor, outcome };
    }
    cursor = page.nextEventSeq;
    if (page.hasMore) {
      if (++pages >= maxPageReads)
        return { cursor, outcome: "source_changed" as const };
      continue;
    }
    if (finalRead) return { cursor };
    pages = 0;
    const remaining = deadline - clock.now();
    if (remaining > 0)
      await clock.wait(Math.min(pollMs, remaining), task.signal);
  }
}

function nextSlot(
  nominal: number,
  period: number,
  offset: number,
  now: number,
) {
  const target = nominal + period + offset;
  // 已错过的时隙直接越过，避免超时或休眠后连续补发。
  const skipped = target <= now ? Math.floor((now - target) / period) + 1 : 0;
  const nextNominal = nominal + (skipped + 1) * period;
  return { nominal: nextNominal, target: nextNominal + offset, skipped };
}

export function createRepeatSend(
  clock: RepeatClock = monotonicClock,
): NodeActionHandler {
  return async ({ target, params }, task) => {
    if (
      target.kind !== "session" ||
      !target.sessionId ||
      target.id !== target.sessionId ||
      !target.sessionEpoch
    )
      throw new Error("Repeat send requires an exact session");
    const session = {
      ...target,
      sessionId: target.sessionId,
      sessionEpoch: target.sessionEpoch,
    };
    const plan = parsePlan(params);
    const attempted: {
      operationId: string;
      outcome: "written" | ResponseOutcome;
      scheduledMs: number;
      startedMs: number;
    }[] = [];
    let completed = 0;
    let skippedSlots = 0;
    const finish = (outcome: Outcome) => ({
      outcome,
      completed,
      skippedSlots,
      attempted,
    });
    if (plan.startDelayMs > 0) await clock.wait(plan.startDelayMs, task.signal);
    task.signal.throwIfAborted();
    let cursor =
      plan.startOn || plan.stopOn || plan.expected
        ? await retainedTail(task, session, plan.startEventSeq)
        : plan.startEventSeq;
    const stop = plan.stopOn ? observePattern(plan.stopOn) : undefined;
    if (plan.startOn) {
      let stopped: ReturnType<ReceiveObserver>;
      const startPattern = observePattern(
        plan.startOn,
        stop
          ? (remaining) => {
              stopped = stop(remaining);
            }
          : undefined,
      );
      const deadline = clock.now() + plan.startTimeoutMs;
      const start = await observeUntil(
        task,
        session,
        cursor,
        startPattern,
        deadline,
        clock,
      );
      if (start.outcome === "source_changed") return finish("source_changed");
      if (start.outcome !== "condition_met" || clock.now() > deadline)
        return finish("start_timeout");
      if (stopped)
        return finish(stopped === "condition_met" ? "stop_condition" : stopped);
      cursor = start.cursor;
    }

    const origin = clock.now();
    let nominal = origin;
    let scheduled = origin;
    while (completed < plan.count) {
      if (stop) {
        const wait = await observeUntil(
          task,
          session,
          cursor,
          stop,
          scheduled,
          clock,
        );
        cursor = wait.cursor;
        if (wait.outcome)
          return finish(
            wait.outcome === "condition_met" ? "stop_condition" : wait.outcome,
          );
      } else {
        const remaining = scheduled - clock.now();
        if (remaining > 0) await clock.wait(remaining, task.signal);
      }
      task.signal.throwIfAborted();
      if (completed !== 0 && clock.now() >= scheduled + plan.periodMs) {
        // 休眠或执行器暂停可能跨过整轮，恢复时重新等待下一时隙。
        const next = nextSlot(
          nominal - plan.periodMs,
          plan.periodMs,
          scheduled - nominal,
          clock.now(),
        );
        nominal = next.nominal;
        scheduled = next.target;
        skippedSlots += next.skipped;
        continue;
      }
      const leaseId = await acquireTransaction(task, session);
      try {
        if (stop) {
          const check = await observeUntil(
            task,
            session,
            cursor,
            stop,
            clock.now(),
            clock,
          );
          cursor = check.cursor;
          if (check.outcome)
            return finish(
              check.outcome === "condition_met"
                ? "stop_condition"
                : check.outcome,
            );
        } else if (plan.expected) {
          // 回应只从本轮实际发出前的留存尾部开始归属。
          cursor = await retainedTail(task, session, cursor);
        }
        const startedMs = Math.floor(clock.now() - origin);
        const send = await sendTransaction(task, session, leaseId, plan.bytes);
        let outcome: "written" | ResponseOutcome = send.confirmed
          ? "written"
          : "transmit_unconfirmed";
        if (send.confirmed && plan.expected) {
          const response = await readExpectedResponse(
            task,
            session,
            send.operationId,
            plan.expected,
            cursor,
            plan.responseTimeoutMs,
            0,
            stop,
          );
          cursor = response.nextEventSeq;
          outcome = response.result.outcome;
        }
        attempted.push({
          operationId: send.operationId,
          outcome,
          scheduledMs: Math.floor(scheduled - origin),
          startedMs,
        });
        if (outcome !== "written" && outcome !== "matched")
          return finish(outcome);
        completed++;
      } finally {
        // 任务取消后由 Host 清退子操作和租约。
        if (!task.signal.aborted)
          await releaseTransaction(task, session, leaseId);
      }
      task.progress.report({
        completed: String(completed),
        total: String(plan.count),
        unit: "rounds",
      });
      if (completed < plan.count) {
        const next = nextSlot(
          nominal,
          plan.periodMs,
          clock.jitter(plan.jitterMs),
          clock.now(),
        );
        nominal = next.nominal;
        scheduled = next.target;
        skippedSlots += next.skipped;
      }
    }
    return finish("completed");
  };
}
