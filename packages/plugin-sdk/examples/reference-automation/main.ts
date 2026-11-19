import { setTimeout as delay } from "node:timers/promises";
import type {
  Call,
  NodeRegister,
  NodeTaskContext,
  Operation,
  SourceRange,
} from "@serial-workbench/plugin-sdk/node";

const action = "swb.reference.automation.run";
const maxSteps = 8;
const maxBytes = 256;
const maxPageReads = 32;
const txWaitMs = 1000;
const settleMs = 4000;
const pollMs = 20;

type Session = Call["target"] & { sessionId: string; sessionEpoch: string };
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

function read(task: NodeTaskContext, session: Session, startEventSeq: string) {
  task.signal.throwIfAborted();
  return task.streams.read({
    sessionId: session.sessionId,
    sessionEpoch: session.sessionEpoch,
    startEventSeq,
    maxEvents: "32",
    maxBytes: "65536",
  });
}

async function retainedTail(
  task: NodeTaskContext,
  session: Session,
  cursor: string,
) {
  for (let pages = 0; pages < maxPageReads; pages++) {
    const page = await read(task, session, cursor);
    if (!page.hasMore) return page.nextEventSeq;
    cursor = page.nextEventSeq;
  }
  throw new Error("Automation requires a recent source event cursor");
}

async function settledTx(task: NodeTaskContext, child: Operation) {
  const deadline = performance.now() + settleMs;
  while (["queued", "running", "cancel_requested"].includes(child.state)) {
    if (performance.now() >= deadline) return undefined;
    await delay(pollMs, undefined, { signal: task.signal });
    child = await task.operations.get({ operationId: child.operationId });
  }
  return child;
}

async function response(
  task: NodeTaskContext,
  session: Session,
  operationId: string,
  expected: Buffer,
  cursor: string,
  timeoutMs: number,
): Promise<{ nextEventSeq: string; result: StepResult }> {
  const deadline = performance.now() + timeoutMs;
  let intentSeen = false;
  let matched = 0;
  let firstEvent: string | undefined;
  let firstByte: string | undefined;
  let nextByte: string | undefined;
  const finish = (outcome: Outcome, source?: SourceRange) => ({
    nextEventSeq: cursor,
    result: { operationId, outcome, ...(source ? { source } : {}) },
  });
  while (performance.now() < deadline) {
    const page = await read(task, session, cursor);
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
        if (intentSeen) return finish("source_changed");
        intentSeen = event.payload.operationId === operationId;
        continue;
      }
      if (!intentSeen || event.kind !== "rx") continue;

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
      if (!expected.subarray(matched, matched + bytes.length).equals(bytes))
        return finish("unexpected_response");
      matched += bytes.length;
      if (matched === expected.length)
        return finish("matched", {
          hostId: session.hostId,
          sessionId: session.sessionId,
          sessionEpoch: session.sessionEpoch,
          direction: "rx",
          eventStart: firstEvent,
          eventEnd: cursor,
          byteStart: firstByte,
          byteEnd,
        });
    }
    cursor = page.nextEventSeq;
    if (!page.hasMore) await delay(pollMs, undefined, { signal: task.signal });
  }
  return finish("response_timeout");
}

export const register: NodeRegister = (context) => {
  context.actions.register(action, async ({ target, params }, task) => {
    const { sessionId, sessionEpoch } = target;
    const { steps, startEventSeq = "1", responseTimeoutMs = 1000 } = params;
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
      typeof responseTimeoutMs !== "number" ||
      !Number.isInteger(responseTimeoutMs) ||
      responseTimeoutMs < 50 ||
      responseTimeoutMs > 5000
    )
      throw new Error(
        "Automation requires an exact session, a cursor and a bounded sequence",
      );

    const sequence = steps.map(parseStep);
    const session = { ...target, sessionId, sessionEpoch };
    let cursor = await retainedTail(task, session, startEventSeq);
    const attempted: StepResult[] = [];
    for (const [index, step] of sequence.entries()) {
      task.signal.throwIfAborted();
      const child = await task.actions.invokeChild({
        actionId: "session.tx",
        target: session,
        params: {
          bytesBase64: step.sendBase64,
          writeWaitMs: String(txWaitMs),
          queueWaitMs: String(txWaitMs),
        },
      });
      const finished = await settledTx(task, child);
      task.signal.throwIfAborted();
      const receipt = finished?.result;
      if (
        finished?.state !== "succeeded" ||
        receipt?.kind !== "tx" ||
        receipt.value.outcome !== "accepted" ||
        receipt.value.operationId !== child.operationId ||
        receipt.value.sessionId !== sessionId ||
        receipt.value.sessionEpoch !== sessionEpoch ||
        receipt.value.bytesBase64 !== step.sendBase64
      ) {
        const outcome = "transmit_unconfirmed";
        attempted.push({ operationId: child.operationId, outcome });
        return { outcome, completedSteps: index, attempted };
      }
      const { nextEventSeq, result } = await response(
        task,
        session,
        child.operationId,
        step.expect,
        cursor,
        responseTimeoutMs,
      );
      cursor = nextEventSeq;
      attempted.push(result);
      if (result.outcome !== "matched")
        return { outcome: result.outcome, completedSteps: index, attempted };
      task.progress.report({
        completed: String(index + 1),
        total: String(sequence.length),
        unit: "steps",
      });
    }
    return { outcome: "matched", completedSteps: sequence.length, attempted };
  });
  return () => {};
};
