import { setTimeout as delay } from "node:timers/promises";
import type {
  NodeActionHandler,
  NodeTaskContext,
  QueryValue,
} from "@serial-workbench/plugin-sdk/node";
import {
  acquireTransaction,
  pollMs,
  readSession,
  releaseTransaction,
  retainedTail,
  sendTransaction,
  settledOperation,
  type Session,
} from "../reference-automation/session-transaction.ts";
import { modbusUnitRouting } from "../reference-protocol-fields/modbus-exchange.ts";
import { modbusTransport } from "../reference-protocol-fields/modbus-frame.ts";
import { modbusInteger } from "../reference-protocol-fields/modbus-pdu.ts";
import {
  parseModbusServerModel,
  simulateModbusServer,
} from "../reference-protocol-fields/modbus-server.ts";
import { ModbusRequestReader } from "./request-reader.ts";

const sourceByteLimit = 65_536;
const leaseTtl = 15_000;
const renewEvery = 8_000;
type ResultReason =
  | "request_limit"
  | "receive_deadline"
  | "source_changed"
  | "session_ended"
  | "invalid_stream"
  | "byte_limit"
  | "lease_unavailable"
  | "reply_unconfirmed";

async function renewLease(
  task: NodeTaskContext,
  session: Session,
  leaseId: string,
) {
  const result = await settledOperation(
    task,
    await task.actions.invokeChild({
      actionId: "lease.renew",
      target: session,
      params: { leaseId, ttlMs: String(leaseTtl) },
    }),
  );
  return (
    result?.state === "succeeded" &&
    result.result?.kind === "lease" &&
    result.result.value.state === "active" &&
    result.result.value.leaseId === leaseId
  );
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

export const serveModbus: NodeActionHandler = async (
  { target, params },
  task,
): Promise<QueryValue> => {
  const { sessionId, sessionEpoch } = target;
  const {
    startEventSeq = "1",
    requestLimit = 16,
    durationMs = 15_000,
    replyDelayMs = 0,
  } = params;
  if (
    target.kind !== "session" ||
    target.id !== sessionId ||
    !sessionId ||
    !sessionEpoch ||
    typeof startEventSeq !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(startEventSeq) ||
    BigInt(startEventSeq) > 18_446_744_073_709_551_615n
  )
    throw new Error(
      "Modbus slave requires a session generation and exact source cursor",
    );
  const transport = modbusTransport(params.transport);
  const routing = modbusUnitRouting(transport, params.unitRouting);
  const limit = modbusInteger(requestLimit, 1, 64, "requestLimit");
  const duration = modbusInteger(durationMs, 100, 120_000, "durationMs");
  const replyDelay = modbusInteger(replyDelayMs, 0, 2000, "replyDelayMs");
  let model = parseModbusServerModel(params.model);
  if (transport !== "tcp") modbusInteger(model.unitId, 1, 247, "model.unitId");
  const session = { ...target, sessionId, sessionEpoch };
  const leaseRequestedAt = performance.now();
  const leaseId = await acquireTransaction(task, session, leaseTtl);
  const reader = new ModbusRequestReader(transport);
  const processed: QueryValue[] = [];
  const sent = new Set<string>();
  let needsRelease = true;
  let receivedBytes = 0;
  let nextByte: string | undefined;
  let clockId: string | undefined;
  let lastNs: bigint | undefined;
  let renewAt = leaseRequestedAt + renewEvery;
  const report = (reason: ResultReason) => ({
    reason,
    model,
    processed,
    receivedBytes,
    pendingFrame: reader.partial,
  });
  async function ensureLease() {
    const now = performance.now();
    if (now < renewAt) return true;
    if (!(await renewLease(task, session, leaseId))) return false;
    renewAt = now + renewEvery;
    return true;
  }
  const progress = () =>
    task.progress.report({
      unit: "frames",
      completed: String(processed.length),
      total: String(limit),
    });

  try {
    let cursor = await retainedTail(task, session, startEventSeq);
    const deadline = performance.now() + duration;
    progress();
    while (performance.now() < deadline) {
      if (!(await ensureLease())) return report("lease_unavailable");
      const page = await readSession(task, session, cursor).catch(
        (error: unknown) => {
          if (errorCode(error) === "CURSOR_EXPIRED") return undefined;
          throw error;
        },
      );
      if (!page) return report("source_changed");
      for (const event of page.events) {
        task.signal.throwIfAborted();
        if (performance.now() >= deadline) return report("receive_deadline");
        if (
          event.hostId !== session.hostId ||
          event.sessionId !== session.sessionId ||
          event.sessionEpoch !== session.sessionEpoch ||
          event.kind === "gap" ||
          event.kind === "configuration_boundary"
        )
          return report("source_changed");
        if (event.kind === "lifecycle") {
          needsRelease = event.payload.state !== "closed";
          return report("session_ended");
        }
        if (
          event.kind === "tx" &&
          !sent.has(event.payload.operationId) &&
          (event.payload.acceptedRanges.length ||
            event.payload.unknownRanges.length)
        )
          return report("source_changed");
        if (event.kind !== "rx") continue;
        const { bytesBase64, byteStart, byteEnd } = event.payload;
        const bytes = Buffer.from(bytesBase64, "base64");
        const rawNs = BigInt(event.time.sourceMonoNs);
        if (
          (clockId !== undefined && event.time.clockId !== clockId) ||
          (lastNs !== undefined && rawNs < lastNs) ||
          (nextByte !== undefined && byteStart !== nextByte) ||
          BigInt(byteEnd) - BigInt(byteStart) !== BigInt(bytes.length)
        )
          return report("source_changed");
        if (bytes.length === 0) continue;
        clockId = event.time.clockId;
        lastNs = rawNs;
        nextByte = byteEnd;
        const bounded = bytes.subarray(0, sourceByteLimit - receivedBytes);
        receivedBytes += bounded.length;
        for (const frame of reader.consume({
          bytes: bounded,
          byteStart,
          eventSeq: event.eventSeq,
        })) {
          task.signal.throwIfAborted();
          if (performance.now() >= deadline) return report("receive_deadline");
          if (!(await ensureLease())) return report("lease_unavailable");
          const result = simulateModbusServer(
            transport,
            frame.bytes,
            model,
            routing,
          );
          model = result.model;
          const observation = {
            status: result.status,
            requestBase64: Buffer.from(frame.bytes).toString("base64"),
            source: {
              hostId: session.hostId,
              sessionId,
              sessionEpoch,
              direction: "rx",
              eventStart: frame.eventStart,
              eventEnd: frame.eventEnd,
              byteStart: frame.byteStart,
              byteEnd: frame.byteEnd,
            },
            time: {
              clockId,
              sourceMonoNs: event.time.sourceMonoNs,
              precision: event.time.precision,
            },
            ...(result.status === "exception" && {
              exceptionCode: result.exceptionCode,
            }),
            ...(result.status === "discarded" && { path: result.path }),
          };
          if ("responseBytes" in result) {
            if (replyDelay > 0)
              await delay(
                Math.min(replyDelay, Math.max(0, deadline - performance.now())),
                undefined,
                { signal: task.signal },
              );
            const ended = performance.now() >= deadline;
            if (ended || !(await ensureLease())) {
              processed.push(observation);
              progress();
              return report(ended ? "receive_deadline" : "lease_unavailable");
            }
            task.signal.throwIfAborted();
            const responseBase64 = Buffer.from(result.responseBytes).toString(
              "base64",
            );
            const tx = await sendTransaction(
              task,
              session,
              leaseId,
              responseBase64,
            );
            sent.add(tx.operationId);
            processed.push({ ...observation, responseBase64, tx });
            progress();
            if (!tx.confirmed) return report("reply_unconfirmed");
          } else {
            processed.push(observation);
            progress();
          }
          if (processed.length === limit) return report("request_limit");
        }
        if (reader.fault) return report("invalid_stream");
        if (receivedBytes === sourceByteLimit) return report("byte_limit");
      }
      cursor = page.nextEventSeq;
      if (!page.hasMore) {
        const pause = Math.min(pollMs, deadline - performance.now());
        if (pause > 0) await delay(pause, undefined, { signal: task.signal });
      }
    }
    return report("receive_deadline");
  } finally {
    if (needsRelease && !task.signal.aborted)
      await releaseTransaction(task, session, leaseId);
  }
};
