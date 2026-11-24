import {
  ContractValidationError,
  parseReply,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { validateSourceRange } from "../../../packages/contracts/src/generated/validators.mjs";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostConnection } from "@/lib/host-client";
import { readVerifiedFile } from "@/lib/host-reader";
import { isRecord } from "@/lib/settings-model";
import type { HostContextValue } from "@/providers/host-context";
import {
  builtinCommandSequenceAction,
  commandSequenceAction,
} from "../../../packages/plugin-sdk/examples/reference-automation/command-sequence-model";

export { builtinCommandSequenceAction, commandSequenceAction };
export type SequenceActionId =
  typeof builtinCommandSequenceAction | typeof commandSequenceAction;

const outcomes = [
  "completed",
  "response_timeout",
  "unexpected_response",
  "source_changed",
  "transmit_unconfirmed",
  "stop_condition",
] as const;
const attemptOutcomes = [
  "written",
  "matched",
  "response_timeout",
  "unexpected_response",
  "source_changed",
  "transmit_unconfirmed",
  "stop_condition",
] as const;

function includes<const T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return values.some((known) => known === value);
}

function sameSession(left: Target, right: Target) {
  return (
    left.kind === "session" &&
    right.kind === "session" &&
    left.hostId === right.hostId &&
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch
  );
}

export function sameSequence(operation: Operation, target: Target) {
  return (
    (operation.actionId === builtinCommandSequenceAction ||
      operation.actionId === commandSequenceAction) &&
    operation.executionHostId === target.hostId &&
    sameSession(operation.target, target)
  );
}

export async function readSequenceCursor(
  connection: HostConnection,
  target: Target,
  signal: AbortSignal,
) {
  const reply = parseReply(
    await connection.transport.rawRequest(
      {
        method: "action.query",
        params: connection.buildQuery("stream.cursor", target),
      },
      signal,
    ),
  );
  signal.throwIfAborted();
  if (!reply.ok) throw new HostRequestError(reply.error);
  if (
    !("kind" in reply.result) ||
    reply.result.kind !== "stream_cursor" ||
    !sameSession(reply.result.value.target, target) ||
    connection.attachment.hostId !== target.hostId ||
    reply.result.value.cursor.hostId !== target.hostId ||
    reply.result.value.cursor.instanceEpoch !==
      connection.attachment.instanceEpoch ||
    reply.result.value.cursor.scopeId !==
      ["raw", target.sessionId, target.sessionEpoch].join(":")
  )
    throw new ContractValidationError(
      "Sequence cursor belongs to another session",
    );
  const next = BigInt(reply.result.value.cursor.position) + 1n;
  if (next > 18_446_744_073_709_551_615n)
    throw new ContractValidationError("Sequence cursor is exhausted");
  return String(next);
}

function path(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    /^\$(?:\.(?:steps|then|else|expect|onMatch|onTimeout)|\[[0-9]+\])+$/.test(
      value,
    )
  );
}

function parseResult(value: unknown, target: Target) {
  if (
    !isRecord(value) ||
    !includes(outcomes, value.outcome) ||
    (value.stoppedAt !== undefined && !path(value.stoppedAt)) ||
    typeof value.completedSteps !== "number" ||
    !Number.isInteger(value.completedSteps) ||
    value.completedSteps < 0 ||
    value.completedSteps > 64 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 64
  )
    throw new ContractValidationError("Invalid command sequence result");
  const attempts = value.attempts.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !path(entry.path) ||
      typeof entry.operationId !== "string" ||
      entry.operationId.length === 0 ||
      entry.operationId.length > 128 ||
      !includes(attemptOutcomes, entry.outcome)
    )
      throw new ContractValidationError("Invalid command sequence receipt");
    const raw = entry.source;
    let source: { byteStart: string; byteEnd: string } | undefined;
    if (raw !== undefined) {
      if (
        entry.outcome !== "matched" ||
        !validateSourceRange(raw) ||
        raw.hostId !== target.hostId ||
        raw.sessionId !== target.sessionId ||
        raw.sessionEpoch !== target.sessionEpoch ||
        raw.direction !== "rx" ||
        typeof raw.byteStart !== "string" ||
        typeof raw.byteEnd !== "string" ||
        BigInt(raw.eventStart) >= BigInt(raw.eventEnd) ||
        BigInt(raw.byteStart) >= BigInt(raw.byteEnd)
      )
        throw new ContractValidationError(
          "Invalid command sequence response range",
        );
      source = { byteStart: raw.byteStart, byteEnd: raw.byteEnd };
    } else if (entry.outcome === "matched") {
      throw new ContractValidationError("Matched response has no source range");
    }
    return {
      path: entry.path,
      operationId: entry.operationId,
      outcome: entry.outcome,
      source,
    };
  });
  return {
    completedSteps: value.completedSteps,
    outcome: value.outcome,
    stoppedAt: value.stoppedAt,
    attempts,
  };
}

export type SequenceResult = ReturnType<typeof parseResult>;

export async function readSequenceResult(
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
    !sameSequence(accepted, target) ||
    !sameSequence(completed, target) ||
    accepted.operationId !== completed.operationId ||
    accepted.actionId !== completed.actionId ||
    accepted.executionMode !== completed.executionMode ||
    completed.state !== "succeeded" ||
    ref?.kind !== "plugin_result" ||
    ref.id !== accepted.operationId ||
    ref.hostId !== target.hostId
  )
    throw new ContractValidationError(
      "Sequence result belongs to another operation",
    );
  const bytes = await readVerifiedFile(ref, read, signal);
  signal.throwIfAborted();
  return parseResult(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    target,
  );
}
