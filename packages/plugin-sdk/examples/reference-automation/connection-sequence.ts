import { setTimeout as delay } from "node:timers/promises";
import type {
  NodeActionHandler,
  NodeTaskContext,
  SourceRange,
} from "@serial-workbench/plugin-sdk/node";
import {
  compileConnectionSequence,
  type ConnectionSequenceStep,
} from "./connection-sequence-model.ts";
import {
  observePattern,
  type ReceiveEvent,
  type ReceiveMatch,
} from "./receive-pattern.ts";
import {
  acquireTransaction,
  maxPageReads,
  pollMs,
  readSession,
  releaseTransaction,
  sendTransaction,
  settledOperation,
  type Session,
} from "./session-transaction.ts";

type ConnectionClock = {
  now(): number;
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
};

const monotonicClock: ConnectionClock = {
  now: () => performance.now(),
  wait: (milliseconds, signal) =>
    delay(Math.max(1, Math.ceil(milliseconds)), undefined, { signal }),
};

type Cursor = { nextEventSeq: string; remainder?: ReceiveEvent };
type ReadyStep = Extract<ConnectionSequenceStep, { kind: "ready" }>;
type ScanResult =
  | { kind: "tail"; cursor: Cursor }
  | { kind: "matched"; cursor: Cursor; source: SourceRange }
  | { kind: "session_changed" | "ready_timeout" };
type StepKind = "before_open" | "open" | ConnectionSequenceStep["kind"];
type StepReceipt = {
  kind: StepKind;
  state: "succeeded" | "failed" | "skipped";
  operationId?: string;
  source?: SourceRange;
};
type Outcome =
  | "completed"
  | "port_in_use"
  | "open_failed"
  | "step_failed"
  | "session_changed"
  | "ready_timeout";
type ConnectionReport = {
  outcome: Outcome;
  session?: Session;
  steps: StepReceipt[];
};

function rawSourceEnded(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "CURSOR_EXPIRED" ||
      error.code === "EPOCH_MISMATCH" ||
      error.code === "SESSION_NOT_OPEN" ||
      error.code === "NOT_FOUND")
  );
}

async function scanSource(
  task: NodeTaskContext,
  session: Session,
  cursor: Cursor,
  writes: ReadonlySet<string>,
  clock: ConnectionClock,
  ready?: ReadyStep,
): Promise<ScanResult> {
  const deadline = ready ? clock.now() + ready.timeoutMs : undefined;
  let nextEventSeq = cursor.nextEventSeq;
  let found: ReceiveMatch | undefined;
  const observe = ready
    ? observePattern(Buffer.from(ready.bytesBase64, "base64"), (match) => {
        found = match;
      })
    : undefined;
  const foundResult = (match: ReceiveMatch): ScanResult => ({
    kind: "matched",
    source: match.source,
    cursor: {
      nextEventSeq,
      ...(match.remainder ? { remainder: match.remainder } : {}),
    },
  });
  if (cursor.remainder && observe) {
    if (observe(cursor.remainder) === "source_changed")
      return { kind: "session_changed" };
    if (found) return foundResult(found);
  }
  let pages = 0;
  while (true) {
    if (deadline !== undefined && clock.now() >= deadline)
      return { kind: "ready_timeout" };
    const page = await readSession(task, session, nextEventSeq).catch(
      (error: unknown) => {
        if (!rawSourceEnded(error)) throw error;
      },
    );
    if (!page) return { kind: "session_changed" };
    for (const event of page.events) {
      task.signal.throwIfAborted();
      if (
        event.hostId !== session.hostId ||
        event.sessionId !== session.sessionId ||
        event.sessionEpoch !== session.sessionEpoch ||
        event.eventSeq !== nextEventSeq ||
        event.kind === "gap" ||
        event.kind === "configuration_boundary" ||
        (event.kind === "lifecycle" &&
          ["closing", "closed", "disconnected"].some(
            (state) => event.payload.state === state,
          )) ||
        ((event.kind === "tx_intent" || event.kind === "tx") &&
          !writes.has(event.payload.operationId))
      )
        return { kind: "session_changed" };
      nextEventSeq = String(BigInt(event.eventSeq) + 1n);
      if (event.kind === "rx" && observe) {
        if (observe(event) === "source_changed")
          return { kind: "session_changed" };
        if (found) {
          if (deadline !== undefined && clock.now() >= deadline)
            return { kind: "ready_timeout" };
          return foundResult(found);
        }
      }
    }
    if (page.nextEventSeq !== nextEventSeq) return { kind: "session_changed" };
    if (page.hasMore) {
      if (++pages >= maxPageReads) return { kind: "session_changed" };
      continue;
    }
    if (deadline === undefined)
      return { kind: "tail", cursor: { nextEventSeq } };
    pages = 0;
    const remaining = deadline - clock.now();
    if (remaining > 0)
      await clock.wait(Math.min(pollMs, remaining), task.signal);
  }
}

export function createConnectionSequence(
  clock: ConnectionClock = monotonicClock,
): NodeActionHandler {
  return async ({ target, params }, task) => {
    if (target.kind !== "device" || target.sessionId || target.sessionEpoch)
      throw new Error("A connection sequence requires one device");
    const { configuration, definition } = params;
    if (
      !configuration ||
      typeof configuration !== "object" ||
      Array.isArray(configuration)
    )
      throw new Error("A connection sequence requires serial configuration");
    const flowControl = configuration.flowControl;
    if (
      flowControl !== "none" &&
      flowControl !== "xonXoff" &&
      flowControl !== "rtsCts" &&
      flowControl !== "dsrDtr"
    )
      throw new Error("A connection sequence requires known flow control");
    const plan = compileConnectionSequence(definition, flowControl);
    const kinds: StepKind[] = [
      ...(plan.beforeOpenMs ? (["before_open"] as const) : []),
      "open",
      ...plan.steps.map((step) => step.kind),
    ];
    const total = String(kinds.length);
    const receipts: StepReceipt[] = [];
    let session: Session | undefined;
    const progress = () =>
      task.progress.report({
        completed: String(receipts.length),
        total,
        unit: "steps",
      });
    const finish = (outcome: Outcome): ConnectionReport => ({
      outcome,
      ...(session ? { session } : {}),
      steps: [
        ...receipts,
        ...kinds
          .slice(receipts.length)
          .map((kind) => ({ kind, state: "skipped" as const })),
      ],
    });
    const stepFailed = (kind: StepKind, operationId?: string) => {
      receipts.push({
        kind,
        state: "failed",
        ...(operationId ? { operationId } : {}),
      });
    };

    progress();
    if (plan.beforeOpenMs) {
      await clock.wait(plan.beforeOpenMs, task.signal);
      task.signal.throwIfAborted();
      receipts.push({ kind: "before_open", state: "succeeded" });
      progress();
    }
    task.signal.throwIfAborted();
    const admittedOpen = await task.actions
      .invokeChild({
        actionId: "device.open",
        target,
        params: { configuration },
      })
      .catch(() => undefined);
    task.signal.throwIfAborted();
    if (!admittedOpen) {
      stepFailed("open");
      return finish("open_failed");
    }
    const open = await settledOperation(
      task,
      await task.operations.get({ operationId: admittedOpen.operationId }),
    );
    const returned = open?.result;
    if (
      open?.state !== "succeeded" ||
      open.actionId !== "device.open" ||
      open.operationId !== admittedOpen.operationId ||
      returned?.kind !== "opened" ||
      returned.value.reused
    ) {
      stepFailed("open", admittedOpen.operationId);
      return finish(
        returned?.kind === "opened" && returned.value.reused
          ? "port_in_use"
          : "open_failed",
      );
    }
    const { sessionId, sessionEpoch, revision } = returned.value;
    const connected: Session = {
      hostId: target.hostId,
      kind: "session",
      id: sessionId,
      sessionId,
      sessionEpoch,
    };
    session = connected;
    receipts.push({
      kind: "open",
      state: "succeeded",
      operationId: open.operationId,
    });
    progress();
    if (!plan.steps.length) return finish("completed");

    const lease = await acquireTransaction(
      task,
      connected,
      30_000,
      revision,
    ).catch(() => undefined);
    task.signal.throwIfAborted();
    if (!lease) return finish("session_changed");
    let cursor: Cursor = { nextEventSeq: "1" };
    const writes = new Set<string>();
    let operationId: string | undefined;
    let released = true;
    const runSteps = async (): Promise<ConnectionReport> => {
      for (const step of plan.steps) {
        task.signal.throwIfAborted();
        operationId = undefined;
        const current = await scanSource(
          task,
          connected,
          cursor,
          writes,
          clock,
        );
        if (current.kind !== "tail") return finish("session_changed");
        let source: SourceRange | undefined;
        switch (step.kind) {
          case "delay":
            await clock.wait(step.milliseconds, task.signal);
            if (
              (await scanSource(task, connected, cursor, writes, clock))
                .kind !== "tail"
            ) {
              stepFailed(step.kind);
              return finish("session_changed");
            }
            break;
          case "line": {
            const child = await task.actions.invokeChild({
              actionId: "session.control",
              target: connected,
              params: { line: step.line, value: step.value },
              leaseId: lease,
            });
            operationId = child.operationId;
            const line = await settledOperation(task, child);
            const control = line?.result;
            if (
              line?.state !== "succeeded" ||
              control?.kind !== "control" ||
              control.value.line !== step.line ||
              control.value.status !== "confirmed" ||
              control.value.actual !== step.value
            ) {
              stepFailed(step.kind, operationId);
              return finish("step_failed");
            }
            break;
          }
          case "send": {
            cursor = current.cursor;
            const sent = await sendTransaction(
              task,
              connected,
              lease,
              step.bytesBase64,
            );
            operationId = sent.operationId;
            if (!sent.confirmed) {
              stepFailed(step.kind, operationId);
              return finish("step_failed");
            }
            writes.add(sent.operationId);
            break;
          }
          case "ready": {
            const observed = await scanSource(
              task,
              connected,
              cursor,
              writes,
              clock,
              step,
            );
            if (observed.kind !== "matched") {
              stepFailed(step.kind);
              return finish(
                observed.kind === "ready_timeout"
                  ? "ready_timeout"
                  : "session_changed",
              );
            }
            ({ cursor, source } = observed);
            break;
          }
        }
        task.signal.throwIfAborted();
        receipts.push({
          kind: step.kind,
          state: "succeeded",
          ...(operationId ? { operationId } : {}),
          ...(source ? { source } : {}),
        });
        progress();
      }
      return finish("completed");
    };
    let report: ConnectionReport;
    try {
      report = await runSteps();
    } catch (error) {
      task.signal.throwIfAborted();
      const next = kinds[receipts.length];
      if (next !== undefined) stepFailed(next, operationId);
      report = finish(
        rawSourceEnded(error) ? "session_changed" : "step_failed",
      );
    } finally {
      if (!task.signal.aborted) {
        await releaseTransaction(task, connected, lease).catch(() => {
          released = false;
        });
      }
    }
    task.signal.throwIfAborted();
    if (!released && report.outcome === "completed")
      report.outcome = "session_changed";
    return report;
  };
}
