import { setTimeout as delay } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import type {
  NodeRegister,
  NodeTaskContext,
  SourceRange,
  StreamReadResult,
} from "@serial-workbench/plugin-sdk/node";
import {
  modbusTransaction,
  modbusTransactionAction,
} from "./modbus-transaction.ts";
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

const action = "swb.reference.automation.run";
const maxSteps = 8;
const maxRounds = 8;
const roundPauseMs = 3000;
const maxBytes = 256;

if (!isMainThread) await delay(roundPauseMs);

type EventTime = StreamReadResult["events"][number]["time"];
type Outcome =
  | "matched"
  | "unexpected_response"
  | "response_timeout"
  | "source_changed"
  | "transmit_unconfirmed";
type StepResult = {
  operationId: string;
  outcome: Outcome;
  source?: SourceRange;
  lateResponse?: SourceRange;
};
type ObservedResponse = {
  outcome: "matched" | "unexpected_response";
  time: EventTime;
  source?: SourceRange;
};

function decode(value: unknown): Buffer {
  if (typeof value === "string" && value.length <= 344) {
    const bytes = Buffer.from(value, "base64");
    if (
      bytes.length >= 1 &&
      bytes.length <= maxBytes &&
      bytes.toString("base64") === value
    )
      return bytes;
  }
  throw new Error(
    "Automation frames require 1 to 256 bytes in canonical Base64",
  );
}

function parseStep(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("sendBase64" in value) ||
    !("expectBase64" in value)
  )
    throw new Error(
      "Automation step requires send and expected response frames",
    );
  return {
    sendBase64: decode(value.sendBase64).toString("base64"),
    expect: decode(value.expectBase64),
  };
}

async function response(
  task: NodeTaskContext,
  session: Session,
  operationId: string,
  expected: Buffer,
  cursor: string,
  timeoutMs: number,
  lateResponseWaitMs: number,
): Promise<{ nextEventSeq: string; result: StepResult }> {
  const responseNs = BigInt(timeoutMs) * 1_000_000n;
  const observationNs = BigInt(timeoutMs + lateResponseWaitMs) * 1_000_000n;
  const deadline = performance.now() + timeoutMs + lateResponseWaitMs;
  let intentSeen = false;
  let written: EventTime | undefined;
  let observed: ObservedResponse | undefined;
  let matched = 0;
  let firstEvent: string | undefined;
  let firstByte: string | undefined;
  let nextByte: string | undefined;
  const finish = (
    outcome: Outcome,
    ranges: Pick<StepResult, "source" | "lateResponse"> = {},
  ) => ({
    nextEventSeq: cursor,
    result: { operationId, outcome, ...ranges },
  });
  const classify = (tx: EventTime, rx: ObservedResponse) => {
    if (tx.clockId !== rx.time.clockId) return finish("source_changed");
    const elapsed = BigInt(rx.time.sourceMonoNs) - BigInt(tx.sourceMonoNs);
    if (elapsed <= responseNs)
      return finish(rx.outcome, rx.source ? { source: rx.source } : {});
    return finish(
      "response_timeout",
      elapsed <= observationNs && rx.source ? { lateResponse: rx.source } : {},
    );
  };
  let finalPages = 0;
  while (true) {
    const finalRead = performance.now() >= deadline;
    const page = await readSession(task, session, cursor);
    for (const event of page.events) {
      task.signal.throwIfAborted();
      if (
        event.sessionId !== session.sessionId ||
        event.sessionEpoch !== session.sessionEpoch ||
        event.hostId !== session.hostId
      )
        throw new Error("Automation read changed session identity");
      cursor = String(BigInt(event.eventSeq) + 1n);
      if (event.kind === "gap" || event.kind === "configuration_boundary")
        return finish("source_changed");
      if (event.kind === "tx_intent") {
        if (event.payload.operationId === operationId) intentSeen = true;
        continue;
      }
      if (!intentSeen) continue;
      if (event.kind === "tx") {
        if (event.payload.operationId === operationId) {
          written = event.time;
          if (observed) return classify(written, observed);
        } else if (
          event.payload.acceptedRanges.length ||
          event.payload.unknownRanges.length
        ) {
          return finish("source_changed");
        }
        continue;
      }
      if (event.kind !== "rx" || observed) continue;

      const { byteStart, byteEnd, bytesBase64 } = event.payload;
      const bytes = Buffer.from(bytesBase64, "base64");
      if (
        (nextByte !== undefined && nextByte !== byteStart) ||
        BigInt(byteEnd) - BigInt(byteStart) !== BigInt(bytes.length)
      )
        return finish("source_changed");
      if (!bytes.length) continue;
      firstEvent ??= event.eventSeq;
      firstByte ??= byteStart;
      nextByte = byteEnd;
      if (!expected.subarray(matched, matched + bytes.length).equals(bytes)) {
        observed = { outcome: "unexpected_response", time: event.time };
      } else {
        matched += bytes.length;
        if (matched === expected.length)
          observed = {
            outcome: "matched",
            time: event.time,
            source: {
              hostId: session.hostId,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch,
              direction: "rx",
              eventStart: firstEvent,
              eventEnd: cursor,
              byteStart: firstByte,
              byteEnd,
            },
          };
      }
      if (observed && written) return classify(written, observed);
    }
    cursor = page.nextEventSeq;
    if (finalRead) {
      if (!page.hasMore) return finish("response_timeout");
      finalPages++;
      if (finalPages >= maxPageReads) return finish("source_changed");
    } else if (!page.hasMore) {
      const wait = Math.min(pollMs, deadline - performance.now());
      if (wait > 0) await delay(wait, undefined, { signal: task.signal });
    }
  }
}

export const register: NodeRegister = (context) => {
  context.actions.register(modbusTransactionAction, modbusTransaction);
  context.actions.register(action, async ({ target, params }, task) => {
    const { sessionId, sessionEpoch } = target;
    const {
      steps,
      rounds = 1,
      startEventSeq = "1",
      responseTimeoutMs = 1000,
      lateResponseWaitMs = 0,
    } = params;
    if (
      target.kind !== "session" ||
      target.id !== sessionId ||
      !sessionId ||
      !sessionEpoch ||
      typeof startEventSeq !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(startEventSeq) ||
      BigInt(startEventSeq) > 18_446_744_073_709_551_615n ||
      !Array.isArray(steps) ||
      steps.length < 1 ||
      steps.length > maxSteps ||
      typeof rounds !== "number" ||
      !Number.isInteger(rounds) ||
      rounds < 1 ||
      rounds > maxRounds ||
      typeof responseTimeoutMs !== "number" ||
      !Number.isInteger(responseTimeoutMs) ||
      responseTimeoutMs < 50 ||
      responseTimeoutMs > 5000 ||
      typeof lateResponseWaitMs !== "number" ||
      !Number.isInteger(lateResponseWaitMs) ||
      lateResponseWaitMs < 0 ||
      lateResponseWaitMs > 3000
    )
      throw new Error(
        "Automation requires an exact session, a cursor and a bounded sequence",
      );

    const round = steps.map(parseStep);
    const sequence = Array.from({ length: rounds }, () => round).flat();
    const session = { ...target, sessionId, sessionEpoch };
    let cursor = await retainedTail(task, session, startEventSeq);
    const attempted: StepResult[] = [];
    for (const [index, step] of sequence.entries()) {
      task.signal.throwIfAborted();
      const leaseId = await acquireTransaction(task, session);
      try {
        const transmission = await sendTransaction(
          task,
          session,
          leaseId,
          step.sendBase64,
        );
        if (!transmission.confirmed) {
          const outcome = "transmit_unconfirmed";
          attempted.push({ operationId: transmission.operationId, outcome });
          return { outcome, completedSteps: index, attempted };
        }
        const { nextEventSeq, result } = await response(
          task,
          session,
          transmission.operationId,
          step.expect,
          cursor,
          responseTimeoutMs,
          lateResponseWaitMs,
        );
        cursor = nextEventSeq;
        attempted.push(result);
        if (result.outcome !== "matched")
          return { outcome: result.outcome, completedSteps: index, attempted };
      } finally {
        // The Host cancels the acquire child during parent cancellation and settles its lease.
        if (!task.signal.aborted)
          await releaseTransaction(task, session, leaseId);
      }
      task.progress.report({
        completed: String(index + 1),
        total: String(sequence.length),
        unit: "steps",
      });
      if ((index + 1) % round.length === 0 && index + 1 < sequence.length) {
        // 工作线程随任务取消。上一轮已释放事务租约，其他调用者可以继续收发。
        const worker = context.workers.start("dist/main.mjs");
        const { exitCode } = await worker.finished;
        task.signal.throwIfAborted();
        if (exitCode !== 0) throw new Error("Automation round wait failed");
      }
    }
    return { outcome: "matched", completedSteps: sequence.length, attempted };
  });
  return () => {};
};
