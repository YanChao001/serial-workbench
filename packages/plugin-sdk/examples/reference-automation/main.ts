import { setTimeout as delay } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import type { NodeRegister } from "@serial-workbench/plugin-sdk/node";
import {
  modbusTransaction,
  modbusTransactionAction,
} from "./modbus-transaction.ts";
import {
  acquireTransaction,
  releaseTransaction,
  retainedTail,
  sendTransaction,
} from "./session-transaction.ts";

import {
  decodeAutomationFrame,
  readExpectedResponse,
  type StepResult,
} from "./session-response.ts";
import { createRepeatSend, repeatSendAction } from "./repeat-send.ts";

const action = "swb.reference.automation.run";
const maxSteps = 8;
const maxRounds = 8;
const roundPauseMs = 3000;

if (!isMainThread) await delay(roundPauseMs);

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
    sendBase64: decodeAutomationFrame(value.sendBase64).toString("base64"),
    expect: decodeAutomationFrame(value.expectBase64),
  };
}

export const register: NodeRegister = (context) => {
  context.actions.register(modbusTransactionAction, modbusTransaction);
  context.actions.register(repeatSendAction, createRepeatSend());
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
        const { nextEventSeq, result } = await readExpectedResponse(
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
