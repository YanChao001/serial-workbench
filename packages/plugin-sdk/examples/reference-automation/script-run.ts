import type {
  ConfirmedScriptSource,
  NodeActionHandler,
  NodeWorkers,
} from "@serial-workbench/plugin-sdk/node";
import {
  readSession,
  settledOperation,
  type Session,
} from "./session-transaction.ts";

export const builtinTrustedScriptAction = "swb.builtin.automation.script";

export function createTrustedScriptRun(
  workers: NodeWorkers,
): NodeActionHandler {
  return async (call, task) => {
    const { language, source, sourceSha256, sessionRevision } = call.params;
    const { sessionId, sessionEpoch } = call.target;
    if (
      (language !== "js" && language !== "ts") ||
      typeof source !== "string" ||
      typeof sourceSha256 !== "string" ||
      typeof sessionRevision !== "string" ||
      sessionId === undefined ||
      sessionEpoch === undefined
    ) {
      throw new Error(
        "Script execution requires a confirmed session and source",
      );
    }

    const snapshot: ConfirmedScriptSource = { language, source, sourceSha256 };
    const session: Session = { ...call.target, sessionId, sessionEpoch };
    return workers.runConfirmedScript(snapshot, {
      read: (startEventSeq) => readSession(task, session, startEventSeq),
      async send(bytesBase64) {
        task.signal.throwIfAborted();
        const child = await task.actions.invokeChild({
          actionId: "session.tx",
          target: session,
          expectedRevision: sessionRevision,
          params: {
            bytesBase64,
            writeWaitMs: "1000",
            queueWaitMs: "1000",
          },
        });
        const finished = await settledOperation(task, child);
        task.signal.throwIfAborted();
        const result = finished?.result;
        if (
          result?.kind !== "tx" ||
          result.value.operationId !== child.operationId ||
          result.value.sessionId !== sessionId ||
          result.value.sessionEpoch !== sessionEpoch ||
          result.value.bytesBase64 !== bytesBase64
        ) {
          throw new Error(
            finished?.error?.message ?? "Serial write receipt is unavailable",
          );
        }
        return result.value;
      },
    });
  };
}
