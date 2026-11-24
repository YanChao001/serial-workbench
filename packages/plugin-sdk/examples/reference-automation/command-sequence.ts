import { setTimeout as delay } from "node:timers/promises";
import type { NodeActionHandler } from "@serial-workbench/plugin-sdk/node";
import {
  compileCommandSequence,
  type CommandSequenceStep,
} from "./command-sequence-model.ts";
import { readExpectedResponse, type StepResult } from "./session-response.ts";
import {
  acquireTransaction,
  maxPageReads,
  readSession,
  releaseTransaction,
  sendTransaction,
} from "./session-transaction.ts";

export { commandSequenceAction } from "./command-sequence-model.ts";

type SequenceWait = (
  milliseconds: number,
  signal: AbortSignal,
) => void | Promise<void>;
type Attempt = (StepResult | { operationId: string; outcome: "written" }) & {
  path: string;
};

function expiredCursor(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "CURSOR_EXPIRED"
  );
}

export function createCommandSequence(
  wait: SequenceWait = (milliseconds, signal) =>
    delay(milliseconds, undefined, { signal }),
): NodeActionHandler {
  return async ({ target, params }, task) => {
    const { sessionId, sessionEpoch } = target;
    if (
      target.kind !== "session" ||
      target.id !== sessionId ||
      !sessionId ||
      !sessionEpoch
    )
      throw new Error("A command sequence requires an exact session");
    const session = { ...target, sessionId, sessionEpoch };
    const startEventSeq = params.startEventSeq;
    if (
      typeof startEventSeq !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(startEventSeq) ||
      BigInt(startEventSeq) > 18_446_744_073_709_551_615n
    )
      throw new Error(
        "A command sequence requires a current source event cursor",
      );
    let cursor = startEventSeq;
    const plan = compileCommandSequence(params.definition);
    const attempts: Attempt[] = [];
    let completedSteps = 0;
    let stoppedAt: string | undefined;

    async function advanceWithinSession() {
      for (let index = 0; index < maxPageReads; index++) {
        const page = await readSession(task, session, cursor).catch(
          (error: unknown) => {
            if (!expiredCursor(error)) throw error;
          },
        );
        if (!page) return false;
        for (const event of page.events) {
          if (
            event.kind === "gap" ||
            event.kind === "configuration_boundary" ||
            event.hostId !== session.hostId ||
            event.sessionId !== session.sessionId ||
            event.sessionEpoch !== session.sessionEpoch ||
            event.eventSeq !== cursor
          )
            return false;
          cursor = String(BigInt(cursor) + 1n);
        }
        if (page.nextEventSeq !== cursor) return false;
        if (!page.hasMore) return true;
      }
      return false;
    }

    async function transmit(
      step: Extract<CommandSequenceStep, { kind: "send" }>,
    ) {
      const leaseId = await acquireTransaction(task, session);
      try {
        if (!(await advanceWithinSession())) return;
        const bytes = Buffer.from(step.bytes).toString("base64");
        const { confirmed, operationId } = await sendTransaction(
          task,
          session,
          leaseId,
          bytes,
        );
        if (!confirmed)
          return { operationId, outcome: "transmit_unconfirmed" } as const;
        if (!step.expect) return { operationId, outcome: "written" } as const;
        try {
          const response = await readExpectedResponse(
            task,
            session,
            operationId,
            Buffer.from(step.expect.bytes),
            cursor,
            step.expect.timeoutMs,
            0,
          );
          cursor = response.nextEventSeq;
          return response.result;
        } catch (error) {
          if (!expiredCursor(error)) throw error;
          return { operationId, outcome: "source_changed" } as const;
        }
      } finally {
        // 任务停止后由 Host 结算已接纳的写入并清退租约。
        if (!task.signal.aborted)
          await releaseTransaction(task, session, leaseId);
      }
    }

    async function runSteps(
      steps: readonly CommandSequenceStep[],
    ): Promise<StepResult["outcome"] | undefined> {
      for (const step of steps) {
        task.signal.throwIfAborted();
        let branch: readonly CommandSequenceStep[] | undefined;
        if (step.kind === "delay") {
          await wait(step.milliseconds, task.signal);
        } else {
          const attempt = await transmit(step);
          if (!attempt) {
            stoppedAt = step.path;
            return "source_changed";
          }
          attempts.push({ ...attempt, path: step.path });
          switch (attempt.outcome) {
            case "written":
              break;
            case "matched":
              branch = step.expect?.onMatch;
              break;
            case "response_timeout": {
              // 无协议关联键时，同值迟到应答不能归入接下来的发送。
              const fallback = step.expect?.onTimeout;
              const failed = fallback && (await runSteps(fallback));
              stoppedAt ??= step.path;
              return failed ?? attempt.outcome;
            }
            default:
              stoppedAt = step.path;
              return attempt.outcome;
          }
        }
        task.signal.throwIfAborted();
        completedSteps++;
        task.progress.report({
          completed: String(completedSteps),
          unit: "steps",
        });
        if (branch) {
          const outcome = await runSteps(branch);
          if (outcome) return outcome;
        }
      }
    }

    const outcome = (await runSteps(plan)) ?? "completed";
    return {
      outcome,
      completedSteps,
      attempts,
      ...(stoppedAt !== undefined && { stoppedAt }),
    };
  };
}
