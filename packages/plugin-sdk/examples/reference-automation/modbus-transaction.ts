import { setTimeout as delay } from "node:timers/promises";
import type {
  NodeActionHandler,
  NodeTaskContext,
  SourceRange,
} from "@serial-workbench/plugin-sdk/node";
import type { QueryValue } from "@serial-workbench/contracts";
import { modbusUnitRouting } from "../reference-protocol-fields/modbus-exchange.ts";
import {
  decodeModbusFrame,
  modbusFrameLimits,
  modbusTransport,
} from "../reference-protocol-fields/modbus-frame.ts";
import { modbusInteger } from "../reference-protocol-fields/modbus-pdu.ts";
import {
  ModbusResponseReader,
  type EventTime,
} from "./modbus-response-reader.ts";
import {
  acquireTransaction,
  maxPageReads,
  operationSettleMs,
  pollMs,
  readSession,
  releaseTransaction,
  retainedTail,
  sendTransaction,
  type Session,
} from "./session-transaction.ts";

export const modbusTransactionAction = "swb.reference.automation.modbus";
const retryLeaseMs = 30_000;
type Candidate = NonNullable<ReturnType<ModbusResponseReader["consume"]>>;
type Outcome =
  | "matched"
  | "device_exception"
  | "invalid_response"
  | "response_timeout"
  | "source_changed"
  | "transmit_unconfirmed";
type Attempt = {
  operationId: string;
  outcome: Outcome;
  ignoredFrames: number;
  response?: QueryValue;
  lateResponse?: QueryValue;
  trace?: {
    tx: ReturnType<typeof tracePoint>;
    rxFirst?: ReturnType<typeof tracePoint>;
    rxLast?: ReturnType<typeof tracePoint>;
  };
};
type Cursor = { eventSeq: string; previousTx?: EventTime };
type Observation = {
  result: Attempt;
  retryFrom?: Cursor;
  partialFrame?: boolean;
};

function tracePoint(eventSeq: string, time: EventTime) {
  return {
    eventSeq,
    clockId: time.clockId,
    monoNs: time.sourceMonoNs,
    source: time.precision.source,
    resolutionNs: time.precision.resolutionNs,
  };
}

function sourceRange(session: Session, rx: Candidate): SourceRange {
  return {
    hostId: session.hostId,
    sessionId: session.sessionId,
    sessionEpoch: session.sessionEpoch,
    direction: "rx",
    eventStart: rx.start.event,
    eventEnd: rx.end.event,
    byteStart: String(rx.start.byte),
    byteEnd: String(rx.end.byte),
  };
}

async function observe(
  task: NodeTaskContext,
  session: Session,
  operationId: string,
  reader: ModbusResponseReader,
  start: Cursor,
  options: {
    timeoutMs: number;
    lateWaitMs: number;
    ambiguous: boolean;
    includeTrace: boolean;
  },
): Promise<Observation> {
  const { timeoutMs, lateWaitMs, ambiguous, includeTrace } = options;
  const timeoutNs = BigInt(timeoutMs) * 1_000_000n;
  const observationNs = BigInt(timeoutMs + lateWaitMs) * 1_000_000n;
  const deadline = performance.now() + timeoutMs + lateWaitMs;
  let cursor = start.eventSeq;
  let intent: EventTime | undefined;
  let written: { eventSeq: string; time: EventTime } | undefined;
  let observed: Candidate | undefined;
  let nextByte: string | undefined;
  let lastRxNs: bigint | undefined;
  let finalPages = 0;
  const result = (
    outcome: Outcome,
    evidence?: Pick<Attempt, "response" | "lateResponse">,
    rx?: Candidate,
  ): Observation => ({
    result: {
      operationId,
      outcome,
      ignoredFrames: reader.ignoredFrames,
      ...evidence,
      ...(includeTrace && written
        ? {
            trace: {
              tx: tracePoint(written.eventSeq, written.time),
              ...(rx && {
                rxFirst: tracePoint(rx.start.event, rx.start.time),
                rxLast: tracePoint(String(BigInt(rx.end.event) - 1n), rx.time),
              }),
            },
          }
        : {}),
    },
  });

  function classify(tx: EventTime, rx: Candidate) {
    const elapsed = BigInt(rx.time.sourceMonoNs) - BigInt(tx.sourceMonoNs);
    if (tx.clockId !== rx.time.clockId || elapsed < 0)
      return result("source_changed");
    if (elapsed > observationNs) return result("response_timeout");
    const timing = {
      clockId: tx.clockId,
      txMonoNs: tx.sourceMonoNs,
      rxMonoNs: rx.time.sourceMonoNs,
      txPrecision: tx.precision,
      rxPrecision: rx.time.precision,
      ...(ambiguous
        ? { attemptAttribution: "indeterminate" }
        : { elapsedNs: String(elapsed) }),
    };
    const received = {
      source: sourceRange(session, rx),
      timing,
      bytesBase64: rx.responseBase64,
    };
    const response =
      rx.outcome === "device_exception"
        ? { ...received, exceptionCode: rx.exceptionCode }
        : received;
    return elapsed > timeoutNs
      ? result("response_timeout", { lateResponse: response }, rx)
      : result(rx.outcome, { response }, rx);
  }

  while (true) {
    const finalRead = performance.now() >= deadline;
    const page = await readSession(task, session, cursor).catch(
      (error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "CURSOR_EXPIRED"
        )
          return undefined;
        throw error;
      },
    );
    if (!page) return result("source_changed");
    for (const event of page.events) {
      task.signal.throwIfAborted();
      if (
        event.hostId !== session.hostId ||
        event.sessionId !== session.sessionId ||
        event.sessionEpoch !== session.sessionEpoch ||
        event.kind === "gap" ||
        event.kind === "configuration_boundary"
      )
        return result("source_changed");
      if (
        event.kind === "tx_intent" &&
        event.payload.operationId === operationId
      ) {
        const previous = start.previousTx;
        if (
          previous &&
          (event.time.clockId !== previous.clockId ||
            BigInt(event.time.sourceMonoNs) < BigInt(previous.sourceMonoNs))
        )
          return result("source_changed");
        intent = event.time;
        continue;
      }
      if (!intent) continue;
      if (event.kind === "tx") {
        if (event.payload.operationId === operationId) {
          if (
            event.time.clockId !== intent.clockId ||
            BigInt(event.time.sourceMonoNs) < BigInt(intent.sourceMonoNs)
          )
            return result("source_changed");
          written = event;
          if (observed) return classify(written.time, observed);
        } else if (
          event.payload.acceptedRanges.length ||
          event.payload.unknownRanges.length
        ) {
          return result("source_changed");
        }
        continue;
      }
      if (event.kind !== "rx" || observed) continue;
      const { bytesBase64, byteStart, byteEnd } = event.payload;
      const bytes = Buffer.from(bytesBase64, "base64");
      const rxNs = BigInt(event.time.sourceMonoNs);
      if (
        event.time.clockId !== intent.clockId ||
        rxNs < (lastRxNs ?? BigInt(intent.sourceMonoNs)) ||
        (nextByte !== undefined && nextByte !== byteStart) ||
        BigInt(byteEnd) - BigInt(byteStart) !== BigInt(bytes.length)
      )
        return result("source_changed");
      if (bytes.length === 0) continue;
      nextByte = byteEnd;
      lastRxNs = rxNs;
      observed = reader.consume({
        bytes,
        byteStart,
        eventSeq: event.eventSeq,
        time: event.time,
      });
      if (reader.stopped) return result("invalid_response");
      if (observed && written) return classify(written.time, observed);
    }
    cursor = page.nextEventSeq;
    if (finalRead) {
      if (!page.hasMore) {
        if (!written) return result("source_changed");
        const timeout = result("response_timeout");
        return reader.hasPartialFrame
          ? { ...timeout, partialFrame: true }
          : {
              ...timeout,
              retryFrom: { eventSeq: cursor, previousTx: written.time },
            };
      }
      if (++finalPages >= maxPageReads) return result("source_changed");
    } else if (!page.hasMore) {
      const wait = Math.min(pollMs, deadline - performance.now());
      if (wait > 0) await delay(wait, undefined, { signal: task.signal });
    }
  }
}

export const modbusTransaction: NodeActionHandler = async (
  { target, params },
  task,
): Promise<QueryValue> => {
  const { sessionId, sessionEpoch } = target;
  const {
    transport,
    requestBase64,
    unitRouting,
    startEventSeq = "1",
    responseTimeoutMs = 1000,
    lateResponseWaitMs = 0,
    broadcastTurnaroundMs = 150,
    retryLimit = 0,
    includeTrace = false,
  } = params;
  if (
    target.kind !== "session" ||
    target.id !== sessionId ||
    !sessionId ||
    !sessionEpoch ||
    typeof includeTrace !== "boolean" ||
    typeof startEventSeq !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(startEventSeq) ||
    BigInt(startEventSeq) > 18_446_744_073_709_551_615n
  )
    throw new Error(
      "Modbus transaction requires a session generation and exact source cursor",
    );
  const selected = modbusTransport(transport);
  const routing = modbusUnitRouting(selected, unitRouting);
  const timeoutMs = modbusInteger(
    responseTimeoutMs,
    50,
    5000,
    "responseTimeoutMs",
  );
  const lateWaitMs = modbusInteger(
    lateResponseWaitMs,
    0,
    3000,
    "lateResponseWaitMs",
  );
  const turnaroundMs = modbusInteger(
    broadcastTurnaroundMs,
    10,
    2000,
    "broadcastTurnaroundMs",
  );
  const retries = modbusInteger(retryLimit, 0, 2, "retryLimit");
  if (typeof requestBase64 !== "string" || requestBase64.length > 684)
    throw new Error(
      "Modbus transaction requires one bounded request in canonical Base64",
    );
  const request = Buffer.from(requestBase64, "base64");
  if (
    request.length > modbusFrameLimits[selected] ||
    request.toString("base64") !== requestBase64
  )
    throw new Error(
      "Modbus transaction requires one bounded request in canonical Base64",
    );
  const { broadcast, packet } = decodeModbusFrame(selected, "request", request);
  const { functionCode } = packet.pdu;
  const attemptBudgetMs = timeoutMs + lateWaitMs + operationSettleMs;
  const retryDeadline = performance.now() + retryLeaseMs - operationSettleMs;
  if (retries > 0) {
    if (broadcast || functionCode < 1 || functionCode > 4)
      throw new Error("Modbus retries require a unicast read (FC01–04)");
    if (selected !== "tcp" && lateWaitMs < 50)
      throw new Error(
        "Serial Modbus retries require a late window of at least 50 ms",
      );
    if ((retries + 1) * attemptBudgetMs > retryLeaseMs - operationSettleMs)
      throw new Error("Modbus retries exceed the transaction lease budget");
  }
  const session = { ...target, sessionId, sessionEpoch };
  const leaseId = await acquireTransaction(
    task,
    session,
    retries > 0 ? retryLeaseMs : undefined,
  );
  try {
    let start: Cursor = {
      eventSeq: broadcast
        ? startEventSeq
        : await retainedTail(task, session, startEventSeq),
    };
    if (retries > 0 && performance.now() + attemptBudgetMs > retryDeadline)
      throw new Error("Modbus lease does not have enough time for an attempt");
    const attempts: (Attempt & { requestTransactionId?: number })[] = [];
    const initialTransactionId =
      selected === "tcp" ? request.readUInt16BE(0) : undefined;
    for (let index = 0; ; index++) {
      task.signal.throwIfAborted();
      const requestTransactionId =
        initialTransactionId === undefined
          ? undefined
          : (initialTransactionId + index) & 0xffff;
      const attemptRequest = Buffer.from(request);
      if (requestTransactionId !== undefined)
        attemptRequest.writeUInt16BE(requestTransactionId, 0);
      const { operationId, confirmed } = await sendTransaction(
        task,
        session,
        leaseId,
        attemptRequest.toString("base64"),
      );
      if (confirmed && broadcast) {
        await delay(turnaroundMs, undefined, { signal: task.signal });
        return {
          operationId,
          outcome: "broadcast_completed",
          ignoredFrames: 0,
          turnaroundMs,
        };
      }
      const observation: Observation = confirmed
        ? await observe(
            task,
            session,
            operationId,
            new ModbusResponseReader(selected, attemptRequest, routing),
            start,
            {
              timeoutMs,
              lateWaitMs,
              ambiguous: selected !== "tcp" && index > 0,
              includeTrace,
            },
          )
        : {
            result: {
              operationId,
              outcome: "transmit_unconfirmed",
              ignoredFrames: 0,
            },
          };
      const { result, retryFrom, partialFrame } = observation;
      if (retries === 0 && !includeTrace) return result;
      const { trace, ...summary } = result;
      attempts.push({
        ...summary,
        ...(trace && { trace }),
        ...(requestTransactionId !== undefined && { requestTransactionId }),
      });
      if (index === retries) return { ...summary, attempts };
      if (!retryFrom)
        return partialFrame
          ? { ...summary, attempts, retryStopped: "partial_frame" }
          : { ...summary, attempts };
      if (performance.now() + attemptBudgetMs > retryDeadline)
        return { ...summary, attempts, retryStopped: "lease_budget" };
      start = retryFrom;
    }
  } finally {
    if (!task.signal.aborted) await releaseTransaction(task, session, leaseId);
  }
};
