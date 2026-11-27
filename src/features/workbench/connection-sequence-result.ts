import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { readVerifiedFile } from "@/lib/host-reader";
import { isRecord } from "@/lib/settings-model";
import type { HostContextValue } from "@/providers/host-context";
import {
  validateSourceRange,
  validateTarget,
} from "../../../packages/contracts/src/generated/validators.mjs";
import { builtinConnectionSequenceAction } from "../../../packages/plugin-sdk/examples/reference-automation/connection-sequence-model";

const outcomes = [
  "completed",
  "port_in_use",
  "open_failed",
  "step_failed",
  "session_changed",
  "ready_timeout",
] as const;
const stepKinds = [
  "before_open",
  "open",
  "line",
  "delay",
  "send",
  "ready",
] as const;
const stepStates = ["succeeded", "failed", "skipped"] as const;

function contains<const Values extends readonly string[]>(
  values: Values,
  candidate: unknown,
): candidate is Values[number] {
  return values.some((value) => value === candidate);
}

function invalid(): never {
  throw new ContractValidationError("Invalid connection sequence result");
}

function parseConnectionResult(value: unknown, target: Target) {
  if (
    !isRecord(value) ||
    !contains(outcomes, value.outcome) ||
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    value.steps.length > 18
  )
    return invalid();
  const session = value.session;
  if (
    (session !== undefined &&
      (!validateTarget(session) ||
        session.hostId !== target.hostId ||
        session.kind !== "session" ||
        session.id !== session.sessionId ||
        !session.sessionEpoch)) ||
    (value.outcome === "completed" && session === undefined)
  )
    return invalid();
  const steps = value.steps.map((step: unknown) => {
    if (
      !isRecord(step) ||
      !contains(stepKinds, step.kind) ||
      !contains(stepStates, step.state) ||
      (step.operationId !== undefined && typeof step.operationId !== "string")
    )
      return invalid();
    const source = step.source;
    if (
      source !== undefined &&
      (step.kind !== "ready" ||
        step.state !== "succeeded" ||
        !session ||
        !validateSourceRange(source) ||
        source.hostId !== session.hostId ||
        source.sessionId !== session.sessionId ||
        source.sessionEpoch !== session.sessionEpoch ||
        source.direction !== "rx" ||
        source.byteStart === undefined ||
        source.byteEnd === undefined ||
        BigInt(source.byteEnd) <= BigInt(source.byteStart))
    )
      return invalid();
    return {
      kind: step.kind,
      state: step.state,
      operationId: step.operationId,
      source,
    };
  });
  return { outcome: value.outcome, session, steps };
}

export type ConnectionSequenceResult = ReturnType<typeof parseConnectionResult>;

export async function readConnectionSequenceResult(
  operation: Operation,
  read: HostContextValue["readFile"],
  signal: AbortSignal,
) {
  const reference =
    operation.result?.kind === "reference"
      ? operation.result.value.resultRef
      : undefined;
  if (
    operation.actionId !== builtinConnectionSequenceAction ||
    operation.state !== "succeeded" ||
    operation.target.kind !== "device" ||
    operation.target.hostId !== operation.executionHostId ||
    reference?.kind !== "plugin_result" ||
    reference.id !== operation.operationId ||
    reference.hostId !== operation.executionHostId
  )
    return invalid();
  const bytes = await readVerifiedFile(reference, read, signal);
  signal.throwIfAborted();
  const decoded: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  return parseConnectionResult(decoded, operation.target);
}
