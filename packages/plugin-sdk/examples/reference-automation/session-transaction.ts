import { setTimeout as delay } from "node:timers/promises";
import type {
  Call,
  NodeTaskContext,
  Operation,
} from "@serial-workbench/plugin-sdk/node";

const txWaitMs = 1000;
const transactionTtlMs = 15_000;
export const operationSettleMs = 4000;
export const pollMs = 20;
export const maxPageReads = 32;
export type Session = Call["target"] & {
  sessionId: string;
  sessionEpoch: string;
};

export function readSession(
  task: NodeTaskContext,
  session: Session,
  startEventSeq: string,
) {
  task.signal.throwIfAborted();
  return task.streams.read({
    sessionId: session.sessionId,
    sessionEpoch: session.sessionEpoch,
    startEventSeq,
    maxEvents: "32",
    maxBytes: "65536",
  });
}

export async function retainedTail(
  task: NodeTaskContext,
  session: Session,
  cursor: string,
) {
  for (let pages = 0; pages < maxPageReads; pages++) {
    const page = await readSession(task, session, cursor);
    if (!page.hasMore) return page.nextEventSeq;
    cursor = page.nextEventSeq;
  }
  throw new Error("Automation requires a recent source event cursor");
}

function pending(child: Operation) {
  return ["queued", "running", "cancel_requested"].includes(child.state);
}

export async function settledOperation(
  task: NodeTaskContext,
  child: Operation,
) {
  const deadline = performance.now() + operationSettleMs;
  while (pending(child)) {
    if (performance.now() >= deadline) return undefined;
    await delay(pollMs, undefined, { signal: task.signal });
    child = await task.operations.get({ operationId: child.operationId });
  }
  return child;
}

export async function acquireTransaction(
  task: NodeTaskContext,
  session: Session,
  ttlMs = transactionTtlMs,
) {
  let owner = await task.actions.invokeChild({
    actionId: "lease.acquire",
    target: session,
    params: { kind: "transaction", ttlMs: String(ttlMs) },
  });
  while (pending(owner)) {
    task.signal.throwIfAborted();
    const receipt = owner.result;
    if (
      owner.state === "running" &&
      receipt?.kind === "lease" &&
      receipt.value.state === "active"
    )
      return receipt.value.leaseId;
    await delay(pollMs, undefined, { signal: task.signal });
    owner = await task.operations.get({ operationId: owner.operationId });
  }
  throw new Error("The serial transaction lease did not become active");
}

export async function releaseTransaction(
  task: NodeTaskContext,
  session: Session,
  leaseId: string,
) {
  const released = await settledOperation(
    task,
    await task.actions.invokeChild({
      actionId: "lease.release",
      target: session,
      params: { leaseId },
    }),
  );
  if (
    released?.state !== "succeeded" ||
    released.result?.kind !== "lease" ||
    released.result.value.leaseId !== leaseId ||
    released.result.value.state !== "released"
  )
    throw new Error("The serial transaction lease release was not confirmed");
}

export async function sendTransaction(
  task: NodeTaskContext,
  session: Session,
  leaseId: string,
  bytesBase64: string,
) {
  const child = await task.actions.invokeChild({
    actionId: "session.tx",
    target: session,
    leaseId,
    params: {
      bytesBase64,
      writeWaitMs: String(txWaitMs),
      queueWaitMs: String(txWaitMs),
    },
  });
  const finished = await settledOperation(task, child);
  task.signal.throwIfAborted();
  const receipt = finished?.result;
  return {
    operationId: child.operationId,
    confirmed:
      finished?.state === "succeeded" &&
      receipt?.kind === "tx" &&
      receipt.value.outcome === "accepted" &&
      receipt.value.operationId === child.operationId &&
      receipt.value.sessionId === session.sessionId &&
      receipt.value.sessionEpoch === session.sessionEpoch &&
      receipt.value.bytesBase64 === bytesBase64,
  };
}

// Keep the existing signed consumers on their standard transaction timing.
export async function sendTransactionWithDeadline(
  task: NodeTaskContext,
  session: Session,
  leaseId: string,
  bytesBase64: string,
  writeWaitMs: number,
) {
  const child = await task.actions.invokeChild({
    actionId: "session.tx",
    target: session,
    leaseId,
    params: {
      bytesBase64,
      writeWaitMs: String(writeWaitMs),
      queueWaitMs: String(txWaitMs),
    },
  });
  const deadline =
    performance.now() +
    Math.max(operationSettleMs, writeWaitMs + txWaitMs + 1000);
  let finished = child;
  while (pending(finished) && performance.now() < deadline) {
    await delay(pollMs, undefined, { signal: task.signal });
    finished = await task.operations.get({ operationId: child.operationId });
  }
  task.signal.throwIfAborted();
  const receipt = finished.result;
  return {
    operationId: child.operationId,
    confirmed:
      finished.state === "succeeded" &&
      receipt?.kind === "tx" &&
      receipt.value.outcome === "accepted" &&
      receipt.value.operationId === child.operationId &&
      receipt.value.sessionId === session.sessionId &&
      receipt.value.sessionEpoch === session.sessionEpoch &&
      receipt.value.bytesBase64 === bytesBase64,
  };
}
