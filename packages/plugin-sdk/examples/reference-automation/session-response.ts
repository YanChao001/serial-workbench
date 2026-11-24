import { setTimeout as delay } from "node:timers/promises";
import type {
  NodeTaskContext,
  SourceRange,
  StreamReadResult,
} from "@serial-workbench/plugin-sdk/node";
import {
  maxPageReads,
  pollMs,
  readSession,
  type Session,
} from "./session-transaction.ts";

const maxBytes = 256;
export type ReceiveObserver = (
  event: Extract<StreamReadResult["events"][number], { kind: "rx" }>,
) => "condition_met" | "source_changed" | undefined;

type EventTime = StreamReadResult["events"][number]["time"];
export type ResponseOutcome =
  | "stop_condition"
  | "matched"
  | "unexpected_response"
  | "response_ambiguous"
  | "response_timeout"
  | "source_changed"
  | "transmit_unconfirmed";
export type StepResult = {
  operationId: string;
  outcome: ResponseOutcome;
  source?: SourceRange;
  lateResponse?: SourceRange;
};
type ObservedResponse = {
  outcome: "matched" | "unexpected_response";
  time: EventTime;
  source?: SourceRange;
};

export function decodeAutomationFrame(value: unknown): Buffer {
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

export async function readExpectedResponse(
  task: NodeTaskContext,
  session: Session,
  operationId: string,
  expected: Buffer,
  cursor: string,
  timeoutMs: number,
  lateResponseWaitMs: number,
  stop?: ReceiveObserver,
  confirmedWriteBase64?: string,
): Promise<{ nextEventSeq: string; result: StepResult }> {
  const responseNs = BigInt(timeoutMs) * 1_000_000n;
  const observationNs = BigInt(timeoutMs + lateResponseWaitMs) * 1_000_000n;
  const deadline = performance.now() + timeoutMs + lateResponseWaitMs;
  let intentSeen = false;
  let written: EventTime | undefined;
  let observed: ObservedResponse | undefined;
  let matched = 0;
  let firstEvent: string | undefined;
  let firstByte: string | undefined;
  let nextByte: string | undefined;
  const finish = (
    outcome: ResponseOutcome,
    ranges: Pick<StepResult, "source" | "lateResponse"> = {},
  ) => ({
    nextEventSeq: cursor,
    result: { operationId, outcome, ...ranges },
  });
  const classify = (tx: EventTime, rx: ObservedResponse) => {
    if (tx.clockId !== rx.time.clockId) return finish("source_changed");
    if (
      confirmedWriteBase64 !== undefined &&
      rx.outcome === "unexpected_response"
    )
      return finish("unexpected_response");
    const elapsed = BigInt(rx.time.sourceMonoNs) - BigInt(tx.sourceMonoNs);
    if (elapsed <= responseNs)
      return finish(rx.outcome, rx.source ? { source: rx.source } : {});
    return finish(
      "response_timeout",
      elapsed <= observationNs && rx.source ? { lateResponse: rx.source } : {},
    );
  };
  let finalPages = 0;
  while (true) {
    const finalRead = performance.now() >= deadline;
    const page = await readSession(task, session, cursor);
    for (const event of page.events) {
      task.signal.throwIfAborted();
      if (
        event.sessionId !== session.sessionId ||
        event.sessionEpoch !== session.sessionEpoch ||
        event.hostId !== session.hostId
      )
        throw new Error("Automation read changed session identity");
      if (confirmedWriteBase64 !== undefined && event.eventSeq !== cursor)
        return finish("source_changed");
      cursor = String(BigInt(event.eventSeq) + 1n);
      if (event.kind === "gap" || event.kind === "configuration_boundary")
        return finish("source_changed");
      if (event.kind === "rx" && stop) {
        const outcome = stop(event);
        if (outcome)
          return finish(
            outcome === "condition_met" ? "stop_condition" : outcome,
          );
      }
      if (event.kind === "tx_intent") {
        if (event.payload.operationId === operationId) intentSeen = true;
        else if (confirmedWriteBase64 !== undefined)
          return finish("source_changed");
        continue;
      }
      if (
        confirmedWriteBase64 !== undefined &&
        event.kind === "tx" &&
        event.payload.operationId !== operationId &&
        (event.payload.acceptedRanges.length ||
          event.payload.unknownRanges.length)
      )
        return finish("source_changed");
      if (!intentSeen) continue;
      if (event.kind === "tx") {
        if (event.payload.operationId === operationId) {
          if (
            confirmedWriteBase64 !== undefined &&
            (event.payload.outcome !== "accepted" ||
              event.payload.bytesBase64 !== confirmedWriteBase64 ||
              event.payload.unknownRanges.length !== 0)
          )
            return finish("transmit_unconfirmed");
          written = event.time;
          if (observed) return classify(written, observed);
        } else if (
          event.payload.acceptedRanges.length ||
          event.payload.unknownRanges.length
        ) {
          return finish("source_changed");
        }
        continue;
      }
      if (event.kind !== "rx" || observed) continue;

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
      if (!expected.subarray(matched, matched + bytes.length).equals(bytes)) {
        observed = { outcome: "unexpected_response", time: event.time };
      } else {
        matched += bytes.length;
        if (matched === expected.length)
          observed = {
            outcome: "matched",
            time: event.time,
            source: {
              hostId: session.hostId,
              sessionId: session.sessionId,
              sessionEpoch: session.sessionEpoch,
              direction: "rx",
              eventStart: firstEvent,
              eventEnd: cursor,
              byteStart: firstByte,
              byteEnd,
            },
          };
      }
      if (observed && written) return classify(written, observed);
    }
    if (confirmedWriteBase64 !== undefined && page.nextEventSeq !== cursor)
      return finish("source_changed");
    cursor = page.nextEventSeq;
    if (finalRead) {
      if (!page.hasMore) {
        if (confirmedWriteBase64 !== undefined) {
          if (!written) return finish("source_changed");
          if (matched > 0 && !observed) return finish("response_ambiguous");
        }
        return finish("response_timeout");
      }
      finalPages++;
      if (finalPages >= maxPageReads) return finish("source_changed");
    } else if (!page.hasMore) {
      const wait = Math.min(pollMs, deadline - performance.now());
      if (wait > 0) await delay(wait, undefined, { signal: task.signal });
    }
  }
}
