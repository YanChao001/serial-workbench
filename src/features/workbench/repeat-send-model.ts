import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { parseHex } from "@serial-workbench/host-client";
import { bytesToBase64 } from "@/lib/base64";
import { readVerifiedFile } from "@/lib/host-reader";
import { isRecord } from "@/lib/settings-model";
import type { HostContextValue } from "@/providers/host-context";
import {
  builtinRepeatSendAction,
  repeatJitterLimit,
  repeatSendAction,
  repeatSendFrameBytes,
  repeatSendLimits,
} from "../../../packages/plugin-sdk/examples/reference-automation/repeat-send-settings";

export {
  builtinRepeatSendAction,
  repeatJitterLimit,
  repeatSendAction,
  repeatSendFrameBytes,
  repeatSendLimits,
};
export type RepeatSendActionId =
  typeof builtinRepeatSendAction | typeof repeatSendAction;

export type RepeatSendDraft = {
  send: string;
  periodMs: string;
  count: string;
  jitterMs: string;
  startDelayMs: string;
  startOn: string;
  startTimeoutMs: string;
  stopOn: string;
  expect: string;
  responseTimeoutMs: string;
};
export const initialRepeatSendDraft: RepeatSendDraft = {
  send: "",
  periodMs: "1000",
  count: "5",
  jitterMs: "0",
  startDelayMs: "0",
  startOn: "",
  startTimeoutMs: "5000",
  stopOn: "",
  expect: "",
  responseTimeoutMs: "1000",
};

function integer(value: string, min: number, max: number) {
  if (!/^[0-9]+$/.test(value)) return;
  const number = Number(value);
  if (Number.isSafeInteger(number) && number >= min && number <= max)
    return number;
}

function hex(value: string) {
  // Bound the input before parsing separators and hexadecimal digits.
  if (value.length > repeatSendFrameBytes * 4) return;
  try {
    const bytes = parseHex(value);
    if (bytes.length <= repeatSendFrameBytes) return bytes;
  } catch {
    return undefined;
  }
}

export function prepareRepeatSend(
  draft: RepeatSendDraft,
  startEventSeq: string,
) {
  const send = hex(draft.send);
  const startOn = hex(draft.startOn);
  const stopOn = hex(draft.stopOn);
  const expect = hex(draft.expect);
  const period = integer(draft.periodMs, ...repeatSendLimits.periodMs);
  if (!send?.length || !startOn || !stopOn || !expect)
    return { problem: "hex" as const };
  const count = integer(draft.count, ...repeatSendLimits.count);
  const jitter =
    period === undefined
      ? undefined
      : integer(draft.jitterMs, 0, repeatJitterLimit(period));
  const delay = integer(draft.startDelayMs, ...repeatSendLimits.startDelayMs);
  const startTimeout = integer(
    draft.startTimeoutMs,
    ...repeatSendLimits.startTimeoutMs,
  );
  const responseTimeout = integer(
    draft.responseTimeoutMs,
    ...repeatSendLimits.responseTimeoutMs,
  );
  if (
    period === undefined ||
    count === undefined ||
    jitter === undefined ||
    delay === undefined ||
    (startOn.length && startTimeout === undefined) ||
    (expect.length && responseTimeout === undefined)
  )
    return { problem: "timing" as const };
  return {
    send,
    params: {
      sendBase64: bytesToBase64(send),
      count,
      periodMs: period,
      jitterMs: jitter,
      startDelayMs: delay,
      startEventSeq,
      ...(startOn.length
        ? {
            startOnBase64: bytesToBase64(startOn),
            startTimeoutMs: startTimeout!,
          }
        : {}),
      ...(stopOn.length ? { stopOnBase64: bytesToBase64(stopOn) } : {}),
      ...(expect.length
        ? {
            expectBase64: bytesToBase64(expect),
            responseTimeoutMs: responseTimeout!,
          }
        : {}),
    },
  };
}

const outcomes = [
  "completed",
  "start_timeout",
  "stop_condition",
  "unexpected_response",
  "response_timeout",
  "source_changed",
  "transmit_unconfirmed",
] as const;
const attemptOutcomes = [
  "written",
  "matched",
  "stop_condition",
  "unexpected_response",
  "response_timeout",
  "source_changed",
  "transmit_unconfirmed",
] as const;

function known<const T extends readonly string[]>(
  values: T,
  item: unknown,
): item is T[number] {
  return values.some((value) => value === item);
}
function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRepeatResult(value: unknown) {
  if (
    !isRecord(value) ||
    !known(outcomes, value.outcome) ||
    !nonnegative(value.completed) ||
    !nonnegative(value.skippedSlots) ||
    !Array.isArray(value.attempted) ||
    value.attempted.length > repeatSendLimits.count[1] ||
    value.completed > value.attempted.length
  )
    throw new ContractValidationError("Invalid repeat-send result");
  const attempted = value.attempted.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.operationId !== "string" ||
      !entry.operationId ||
      !known(attemptOutcomes, entry.outcome) ||
      !nonnegative(entry.scheduledMs) ||
      !nonnegative(entry.startedMs)
    )
      throw new ContractValidationError("Invalid repeat-send attempt");
    return {
      operationId: entry.operationId,
      outcome: entry.outcome,
      scheduledMs: entry.scheduledMs,
      startedMs: entry.startedMs,
    };
  });
  if (
    attempted.filter(
      ({ outcome }) => outcome === "written" || outcome === "matched",
    ).length !== value.completed
  )
    throw new ContractValidationError(
      "Repeat-send count differs from its attempts",
    );
  return {
    outcome: value.outcome,
    completed: value.completed,
    skippedSlots: value.skippedSlots,
    attempted,
  };
}

export type RepeatSendResult = ReturnType<typeof parseRepeatResult>;

export function sameRepeatSend(operation: Operation, target: Target) {
  return (
    (operation.actionId === builtinRepeatSendAction ||
      operation.actionId === repeatSendAction) &&
    operation.executionHostId === target.hostId &&
    operation.target.hostId === target.hostId &&
    operation.target.kind === "session" &&
    operation.target.id === target.id &&
    operation.target.sessionId === target.sessionId &&
    operation.target.sessionEpoch === target.sessionEpoch
  );
}

export function repeatPending(operation: Operation) {
  return (
    operation.state === "queued" ||
    operation.state === "running" ||
    operation.state === "cancel_requested"
  );
}

export async function readRepeatResult(
  accepted: Operation,
  completed: Operation,
  target: Target,
  read: HostContextValue["readFile"],
  signal: AbortSignal,
) {
  const ref =
    completed.result?.kind === "reference"
      ? completed.result.value.resultRef
      : undefined;
  if (
    !sameRepeatSend(accepted, target) ||
    !sameRepeatSend(completed, target) ||
    completed.operationId !== accepted.operationId ||
    completed.actionId !== accepted.actionId ||
    completed.state !== "succeeded" ||
    ref?.kind !== "plugin_result" ||
    ref.hostId !== target.hostId ||
    ref.id !== accepted.operationId
  )
    throw new ContractValidationError(
      "Repeat-send result belongs to another operation",
    );
  const bytes = await readVerifiedFile(ref, read, signal);
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  signal.throwIfAborted();
  return parseRepeatResult(value);
}
