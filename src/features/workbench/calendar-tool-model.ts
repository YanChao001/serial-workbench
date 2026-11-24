import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { parseHex } from "@serial-workbench/host-client";
import { bytesToBase64 } from "@/lib/base64";
import { readVerifiedFile } from "@/lib/host-reader";
import { isRecord } from "@/lib/settings-model";
import type {
  HostContextValue,
  HostInvocation,
} from "@/providers/host-context";
import {
  builtinCalendarTaskAction,
  calendarMaxRuns,
  calendarTaskAction,
} from "../../../packages/plugin-sdk/examples/reference-automation/calendar-settings";
import {
  compileCalendarSchedule,
  parseCalendarInstant,
} from "../../../packages/plugin-sdk/examples/reference-automation/calendar-schedule";
import { repeatSendFrameBytes } from "./repeat-send-model";

export const calendarActionIds = [
  builtinCalendarTaskAction,
  calendarTaskAction,
] as const;
export type CalendarActionId = (typeof calendarActionIds)[number];

export type CalendarDraft = {
  mode: "once" | "cron";
  at: string;
  expression: string;
  timeZone: string;
  endAt: string;
  count: string;
  hex: string;
};

export type CalendarInput = NonNullable<HostInvocation["params"]>;
type Preparation =
  | { problem: "hex" | "schedule"; params?: never }
  | { params: CalendarInput; size: number; previewAt: string; problem?: never };

export function prepareCalendar(draft: CalendarDraft): Preparation {
  let bytes: Uint8Array;
  try {
    bytes = parseHex(draft.hex);
  } catch {
    return { problem: "hex" as const };
  }
  if (bytes.length === 0 || bytes.length > repeatSendFrameBytes)
    return { problem: "hex" as const };

  const bytesBase64 = bytesToBase64(bytes);
  try {
    if (draft.mode === "once") {
      const atMs = parseCalendarInstant(draft.at.trim());
      return {
        size: bytes.length,
        previewAt: new Date(atMs).toISOString(),
        params: {
          bytesBase64,
          schedule: { kind: "once", at: draft.at.trim() },
        },
      };
    }
    const count = Number(draft.count);
    if (!/^[1-9][0-9]?$/.test(draft.count) || count > calendarMaxRuns)
      return { problem: "schedule" as const };
    const schedule = {
      kind: "cron",
      expression: draft.expression.trim(),
      timeZone: draft.timeZone.trim(),
    };
    const endAt = draft.endAt.trim();
    compileCalendarSchedule(schedule);
    const endMs = parseCalendarInstant(endAt);
    return {
      size: bytes.length,
      previewAt: new Date(endMs).toISOString(),
      params: { bytesBase64, schedule, count, endAt },
    };
  } catch {
    return { problem: "schedule" as const };
  }
}

export function sameCalendar(operation: Operation, target: Target) {
  return (
    calendarActionIds.some((id) => operation.actionId === id) &&
    operation.executionHostId === target.hostId &&
    operation.target.hostId === target.hostId &&
    operation.target.kind === "session" &&
    operation.target.id === target.id &&
    operation.target.sessionId === target.sessionId &&
    operation.target.sessionEpoch === target.sessionEpoch
  );
}

const outcomes = [
  "completed",
  "completed_with_misses",
  "missed",
  "window_ended",
  "transmit_unconfirmed",
  "capacity_reached",
] as const;
const runOutcomes = ["written", "missed", "transmit_unconfirmed"] as const;

function calendarTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 8_640_000_000_000_000
  );
}

function parseCalendarResult(value: unknown) {
  const outcome = isRecord(value)
    ? outcomes.find((item) => item === value.outcome)
    : undefined;
  if (
    !isRecord(value) ||
    !outcome ||
    !Array.isArray(value.runs) ||
    value.runs.length > calendarMaxRuns ||
    !Array.isArray(value.skipped) ||
    value.skipped.length > calendarMaxRuns + 1
  )
    throw new ContractValidationError("Invalid calendar result");
  const runs = value.runs.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.operationId !== "string" ||
      !entry.operationId ||
      !calendarTime(entry.scheduledMs) ||
      entry.scheduledMs < 0 ||
      !calendarTime(entry.observedMs) ||
      entry.observedMs < entry.scheduledMs
    )
      throw new ContractValidationError("Invalid calendar slot");
    const outcome = runOutcomes.find((item) => item === entry.outcome);
    if (!outcome)
      throw new ContractValidationError("Invalid calendar slot outcome");
    return {
      operationId: entry.operationId,
      scheduledMs: entry.scheduledMs,
      observedMs: entry.observedMs,
      outcome,
    };
  });
  const skipped = value.skipped.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !calendarTime(entry.firstMs) ||
      !calendarTime(entry.throughMs) ||
      entry.throughMs < entry.firstMs
    )
      throw new ContractValidationError("Invalid missed calendar range");
    return { firstMs: entry.firstMs, throughMs: entry.throughMs };
  });
  return { outcome, runs, skipped };
}

export async function readCalendarResult(
  accepted: Operation,
  finished: Operation,
  target: Target,
  read: HostContextValue["readFile"],
  signal: AbortSignal,
) {
  const ref =
    finished.result?.kind === "reference"
      ? finished.result.value.resultRef
      : undefined;
  if (
    finished.state !== "succeeded" ||
    finished.operationId !== accepted.operationId ||
    finished.actionId !== accepted.actionId ||
    !sameCalendar(accepted, target) ||
    !sameCalendar(finished, target) ||
    ref?.kind !== "plugin_result" ||
    ref.hostId !== target.hostId ||
    ref.id !== finished.operationId
  )
    throw new ContractValidationError(
      "Calendar result belongs to another operation",
    );
  const bytes = await readVerifiedFile(ref, read, signal);
  signal.throwIfAborted();
  const result: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  return parseCalendarResult(result);
}

export type CalendarReport = Awaited<ReturnType<typeof readCalendarResult>>;
