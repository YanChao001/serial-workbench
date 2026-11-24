import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { locks } from "node:worker_threads";
import type {
  NodeActionHandler,
  NodeTaskContext,
  QueryValue,
  SourceRange,
} from "@serial-workbench/plugin-sdk/node";
import { endsRuleObservation, watchRuleCondition } from "./rule-observation.ts";
import { decodeAutomationFrame } from "./session-response.ts";
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

export const ruleTriggerAction = "swb.reference.automation.rule";
export const builtinRuleTriggerAction = "swb.builtin.automation.rule";

type Effect =
  | { kind: "send"; bytesBase64: string }
  | { kind: "notify"; message: string }
  | { kind: "action"; actionId: string; params: Record<string, QueryValue> };

const maxSeq = 18_446_744_073_709_551_615n;
const actionIdFormat = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(value: unknown, depth = 0): value is QueryValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 16) return false;
  if (Array.isArray(value))
    return value.every((item: unknown) => json(item, depth + 1));
  return (
    object(value) &&
    Object.values(value).every((entry) => json(entry, depth + 1))
  );
}

function parseEffect(value: unknown): Effect {
  if (!object(value)) throw new Error("Rule requires an explicit effect");
  if (value.kind === "send" && Object.keys(value).length === 2)
    return {
      kind: "send",
      bytesBase64: decodeAutomationFrame(value.bytesBase64).toString("base64"),
    };
  if (
    value.kind === "notify" &&
    Object.keys(value).length === 2 &&
    typeof value.message === "string" &&
    value.message.trim() &&
    value.message.length <= 256
  )
    return { kind: "notify", message: value.message };
  if (
    value.kind === "action" &&
    Object.keys(value).length === 3 &&
    typeof value.actionId === "string" &&
    actionIdFormat.test(value.actionId) &&
    ![
      ruleTriggerAction,
      builtinRuleTriggerAction,
      "session.tx",
      "lease.acquire",
      "lease.release",
    ].includes(value.actionId) &&
    object(value.params) &&
    json(value.params)
  )
    return { kind: "action", actionId: value.actionId, params: value.params };
  throw new Error("Invalid rule effect");
}

function parseDefinition(serialized: unknown) {
  if (typeof serialized !== "string" || serialized.length > 32_768)
    throw new Error("Rule requires a bounded JSON definition");
  const definition: unknown = JSON.parse(serialized);
  if (!object(definition))
    throw new Error("Rule requires a versioned definition");
  const {
    version,
    startAtBoundary = false,
    observationMs = 30_000,
    condition,
    effect,
  } = definition;
  if (
    Object.keys(definition).some(
      (key) =>
        ![
          "version",
          "startAtBoundary",
          "observationMs",
          "condition",
          "effect",
        ].includes(key),
    ) ||
    version !== 1 ||
    !object(condition) ||
    !json(condition) ||
    typeof startAtBoundary !== "boolean" ||
    typeof observationMs !== "number" ||
    !Number.isInteger(observationMs) ||
    observationMs < 50 ||
    observationMs > 120_000
  )
    throw new Error("Invalid rule version, boundary or observation interval");
  return {
    condition,
    startAtBoundary,
    observationMs,
    effect: parseEffect(effect),
  };
}

function canonicalJson(value: QueryValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => {
        return JSON.stringify(key) + ":" + canonicalJson(value[key] ?? null);
      })
      .join(",") +
    "}"
  );
}

function ruleScope(session: Session, condition: Record<string, QueryValue>) {
  const normalized = { ...condition };
  if (normalized.kind === "regex") normalized.ignoreCase ??= false;
  if (normalized.kind === "field") normalized.compare ??= "decoded";
  return (
    "swb:rule:" +
    createHash("sha256")
      .update(
        canonicalJson([
          session.hostId,
          session.sessionId,
          session.sessionEpoch,
          normalized,
        ]),
      )
      .digest("hex")
  );
}

function expired(error: unknown) {
  return object(error) && error.code === "CURSOR_EXPIRED";
}

async function readPage(
  task: NodeTaskContext,
  session: Session,
  cursor: string,
) {
  try {
    return await readSession(task, session, cursor);
  } catch (error) {
    if (!expired(error)) throw error;
  }
}

// Scan to an authoritative tail before arming or dispatching. Historical RX
// does not trigger an effect, and a discontinuity invalidates the armed scope.
async function fencedTail(
  task: NodeTaskContext,
  session: Session,
  cursor: string,
) {
  for (let index = 0; index < maxPageReads; index++) {
    const page = await readPage(task, session, cursor);
    task.signal.throwIfAborted();
    if (!page) return;
    for (const event of page.events) {
      if (
        event.hostId !== session.hostId ||
        event.sessionId !== session.sessionId ||
        event.sessionEpoch !== session.sessionEpoch ||
        event.eventSeq !== cursor ||
        endsRuleObservation(event)
      )
        return;
      cursor = String(BigInt(cursor) + 1n);
    }
    if (page.nextEventSeq !== cursor) return;
    if (!page.hasMore) return cursor;
  }
}

async function dispatchRuleEffect(
  task: NodeTaskContext,
  session: Session,
  effect: Effect,
  source: SourceRange,
): Promise<QueryValue> {
  if (
    effect.kind !== "send" &&
    !(await fencedTail(task, session, source.eventEnd))
  )
    return { outcome: "source_changed" };
  task.signal.throwIfAborted();
  if (effect.kind === "notify")
    return { outcome: "notification", source, message: effect.message };
  if (effect.kind === "action") {
    const operation = await task.actions.invokeChild({
      actionId: effect.actionId,
      target: session,
      params: effect.params,
    });
    const settled = await settledOperation(task, operation);
    return {
      outcome:
        settled?.state === "succeeded"
          ? "action_completed"
          : settled
            ? "action_failed"
            : "action_unconfirmed",
      operationId: operation.operationId,
      source,
    };
  }
  const leaseId = await acquireTransaction(task, session);
  try {
    if (!(await fencedTail(task, session, source.eventEnd)))
      return { outcome: "source_changed" };
    task.signal.throwIfAborted();
    const receipt = await sendTransaction(
      task,
      session,
      leaseId,
      effect.bytesBase64,
    );
    return {
      outcome: receipt.confirmed ? "written" : "transmit_unconfirmed",
      operationId: receipt.operationId,
      source,
    };
  } finally {
    if (!task.signal.aborted) await releaseTransaction(task, session, leaseId);
  }
}

export function createRuleTrigger(
  wait: (ms: number, signal: AbortSignal) => Promise<void> = (ms, signal) =>
    delay(ms, undefined, { signal }),
  now = () => performance.now(),
): NodeActionHandler {
  return async ({ target, params }, task): Promise<QueryValue> => {
    const { sessionId, sessionEpoch } = target;
    const { startEventSeq } = params;
    if (
      target.kind !== "session" ||
      !sessionId ||
      target.id !== sessionId ||
      !sessionEpoch ||
      typeof startEventSeq !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(startEventSeq) ||
      BigInt(startEventSeq) > maxSeq
    )
      throw new Error("Rule requires a current cursor on an exact session");

    const plan = parseDefinition(params.definition);
    const session = { ...target, sessionId, sessionEpoch };
    task.signal.throwIfAborted();
    return locks.request(
      ruleScope(session, plan.condition),
      { ifAvailable: true },
      async (lock): Promise<QueryValue> => {
        task.signal.throwIfAborted();
        if (!lock) return { outcome: "already_armed" };
        const cursor = await fencedTail(task, session, startEventSeq);
        if (!cursor || (plan.startAtBoundary && cursor !== startEventSeq))
          return { outcome: "source_changed" };
        const watch = watchRuleCondition(
          plan.condition,
          session,
          cursor,
          plan.startAtBoundary,
        );
        task.progress.report({ completed: "0", total: "1", unit: "matches" });
        const deadline = now() + plan.observationMs;
        let consecutivePages = 0;
        while (now() < deadline) {
          const page = await readPage(task, session, watch.nextEventSeq);
          task.signal.throwIfAborted();
          if (!page) return { outcome: "source_changed" };
          for (const event of page.events) {
            task.signal.throwIfAborted();
            if (now() >= deadline) return { outcome: "timed_out" };
            const observed = watch.observe(event);
            if (observed?.kind === "source_changed")
              return { outcome: observed.kind };
            if (observed?.kind === "match") {
              if (now() >= deadline) return { outcome: "timed_out" };
              task.progress.report({
                completed: "1",
                total: "1",
                unit: "matches",
              });
              return dispatchRuleEffect(
                task,
                session,
                plan.effect,
                observed.source,
              );
            }
          }
          if (page.nextEventSeq !== watch.nextEventSeq)
            return { outcome: "source_changed" };
          if (page.hasMore) {
            if (++consecutivePages >= maxPageReads)
              return { outcome: "source_changed" };
            continue;
          }
          consecutivePages = 0;
          const remaining = deadline - now();
          if (remaining > 0)
            await wait(Math.min(pollMs, remaining), task.signal);
        }
        task.signal.throwIfAborted();
        return { outcome: "timed_out" };
      },
    );
  };
}
