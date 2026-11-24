import { setTimeout as delay } from "node:timers/promises";
import type { NodeActionHandler } from "@serial-workbench/plugin-sdk/node";
import {
  compileCommandSequence,
  responseFramesConflict,
  type CommandSequenceStep,
} from "./command-sequence-model.ts";
import { readExpectedResponse, type StepResult } from "./session-response.ts";
import {
  acquireTransaction,
  maxPageReads,
  readSession,
  releaseTransaction,
  sendTransaction,
  sendTransactionWithDeadline,
} from "./session-transaction.ts";

export { commandSequenceAction } from "./command-sequence-model.ts";

type SequenceWait = (
  milliseconds: number,
  signal: AbortSignal,
) => void | Promise<void>;
type Attempt = (StepResult | { operationId: string; outcome: "written" }) & {
  path: string;
};
type SendStep = Extract<CommandSequenceStep, { kind: "send" }>;
type SendAttempt = { path: string; bytes: Uint8Array; response?: Uint8Array };

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
    const unresolvedReplies: Uint8Array[] = [];
    const writesWithoutReply = new Set<string>();
    let completedSteps = 0;
    let stoppedAt: string | undefined;

    async function advanceWithinSession(
      afterTimeout: boolean,
      expectsReply: boolean,
    ) {
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
            (afterTimeout &&
              ((expectsReply && event.kind === "rx") ||
                (event.kind === "tx_intent" &&
                  !writesWithoutReply.has(event.payload.operationId)) ||
                (event.kind === "tx" &&
                  !writesWithoutReply.has(event.payload.operationId) &&
                  (event.payload.acceptedRanges.length !== 0 ||
                    event.payload.unknownRanges.length !== 0)))) ||
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
      step: SendStep,
      candidate: SendAttempt,
      afterTimeout: boolean,
    ) {
      const leaseId = await acquireTransaction(task, session);
      try {
        if (
          !(await advanceWithinSession(
            afterTimeout,
            candidate.response !== undefined,
          ))
        )
          return;
        const bytes = Buffer.from(candidate.bytes).toString("base64");
        const { confirmed, operationId } =
          step.writeWaitMs === undefined
            ? await sendTransaction(task, session, leaseId, bytes)
            : await sendTransactionWithDeadline(
                task,
                session,
                leaseId,
                bytes,
                step.writeWaitMs,
              );
        if (!confirmed)
          return { operationId, outcome: "transmit_unconfirmed" } as const;
        if (!step.expect || !candidate.response) {
          // These confirmed writes may still be behind the next step's Raw cursor.
          writesWithoutReply.add(operationId);
          return { operationId, outcome: "written" } as const;
        }
        try {
          const response = await readExpectedResponse(
            task,
            session,
            operationId,
            Buffer.from(candidate.response),
            cursor,
            step.expect.timeoutMs,
            0,
            undefined,
            step.expect.retry.length || afterTimeout ? bytes : undefined,
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

    async function runSend(step: SendStep) {
      const candidates: SendAttempt[] = [
        { path: step.path, bytes: step.bytes, response: step.expect?.bytes },
        ...(step.expect?.retry ?? []),
      ];
      let last:
        | Attempt
        | { path: string; outcome: "source_changed"; operationId?: never } = {
        path: step.path,
        outcome: "source_changed",
      };
      for (const candidate of candidates) {
        const response = candidate.response;
        if (
          response &&
          unresolvedReplies.some((previous) =>
            responseFramesConflict(previous, response),
          )
        )
          return {
            path: candidate.path,
            outcome: "response_ambiguous",
          } as const;
        const attempt = await transmit(
          step,
          candidate,
          unresolvedReplies.length > 0,
        );
        if (!attempt)
          return { path: candidate.path, outcome: "source_changed" } as const;
        last = { ...attempt, path: candidate.path };
        attempts.push(last);
        if (attempt.outcome !== "response_timeout") break;
        if (response) unresolvedReplies.push(response);
      }
      return last;
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
          const attempt = await runSend(step);
          switch (attempt.outcome) {
            case "written":
              break;
            case "matched":
              branch = step.expect?.onMatch;
              break;
            case "response_timeout": {
              // 用完明确配置的尝试后，仍由超时收尾分支处理。
              const fallback = step.expect?.onTimeout;
              const failed = fallback && (await runSteps(fallback));
              stoppedAt ??= attempt.path;
              return failed ?? attempt.outcome;
            }
            default:
              stoppedAt = attempt.path;
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
