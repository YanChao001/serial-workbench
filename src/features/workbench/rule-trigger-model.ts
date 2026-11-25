import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { validateSourceRange } from "../../../packages/contracts/src/generated/validators.mjs";
import { readVerifiedFile } from "@/lib/host-reader";
import { isRecord } from "@/lib/settings-model";
import type { HostContextValue } from "@/providers/host-context";

export const ruleActionIds = [
  "swb.builtin.automation.rule",
  "swb.reference.automation.rule",
] as const;
export type RuleActionId = (typeof ruleActionIds)[number];
export const ruleDefinitionLimit = 32_768;

export function inspectRuleDefinition(definition: string) {
  if (!definition.trim() || definition.length > ruleDefinitionLimit) return;
  try {
    const value: unknown = JSON.parse(definition);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.condition) ||
      !isRecord(value.effect)
    )
      return;
    const { kind } = value.condition;
    if (kind !== "regex" && kind !== "field") return;
    const effect = value.effect.kind;
    if (effect !== "notify" && effect !== "send" && effect !== "action") return;
    const observationMs = value.observationMs ?? 30_000;
    if (
      typeof observationMs !== "number" ||
      !Number.isInteger(observationMs) ||
      observationMs < 50 ||
      observationMs > 120_000
    )
      return;
    if (effect !== "action") return { kind, effect, observationMs } as const;
    const { actionId, params } = value.effect;
    if (
      typeof actionId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(actionId) ||
      !isRecord(params)
    )
      return;
    return {
      kind,
      effect,
      observationMs,
      action: { actionId, params },
    } as const;
  } catch {
    return;
  }
}

export function sameRule(operation: Operation, target: Target) {
  return (
    ruleActionIds.some((action) => action === operation.actionId) &&
    operation.executionHostId === target.hostId &&
    operation.executionMode === "independent" &&
    operation.target.kind === "session" &&
    operation.target.hostId === target.hostId &&
    operation.target.id === target.id &&
    operation.target.sessionId === target.sessionId &&
    operation.target.sessionEpoch === target.sessionEpoch
  );
}

const outcomes = [
  "notification",
  "written",
  "transmit_unconfirmed",
  "action_completed",
  "action_failed",
  "action_unconfirmed",
  "timed_out",
  "source_changed",
  "already_armed",
] as const;
type Outcome = (typeof outcomes)[number];
export type RuleResult =
  | { outcome: "timed_out" | "source_changed" | "already_armed" }
  | {
      outcome: "notification";
      message: string;
      source: { byteStart: string; byteEnd: string };
    }
  | {
      outcome: Exclude<
        Outcome,
        "notification" | "timed_out" | "source_changed" | "already_armed"
      >;
      operationId: string;
      source: { byteStart: string; byteEnd: string };
    };

export async function readRuleResult(
  accepted: Operation,
  completed: Operation,
  target: Target,
  read: HostContextValue["readFile"],
  signal: AbortSignal,
): Promise<RuleResult> {
  const reference =
    completed.result?.kind === "reference"
      ? completed.result.value.resultRef
      : undefined;
  if (
    !sameRule(accepted, target) ||
    !sameRule(completed, target) ||
    completed.operationId !== accepted.operationId ||
    completed.actionId !== accepted.actionId ||
    completed.state !== "succeeded" ||
    reference?.kind !== "plugin_result" ||
    reference.id !== accepted.operationId ||
    reference.hostId !== target.hostId
  )
    throw new ContractValidationError(
      "Rule result belongs to a different operation",
    );
  const bytes = await readVerifiedFile(reference, read, signal);
  signal.throwIfAborted();
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!isRecord(value))
    throw new ContractValidationError("Invalid rule result");
  const outcome = outcomes.find((entry) => entry === value.outcome);
  if (!outcome) throw new ContractValidationError("Unknown rule outcome");
  if (
    outcome === "timed_out" ||
    outcome === "source_changed" ||
    outcome === "already_armed"
  )
    return { outcome };

  const source = value.source;
  if (
    !validateSourceRange(source) ||
    source.hostId !== target.hostId ||
    source.sessionId !== target.sessionId ||
    source.sessionEpoch !== target.sessionEpoch ||
    source.direction !== "rx" ||
    source.byteStart === undefined ||
    source.byteEnd === undefined ||
    BigInt(source.byteStart) >= BigInt(source.byteEnd) ||
    BigInt(source.eventStart) >= BigInt(source.eventEnd)
  )
    throw new ContractValidationError("Invalid rule match source");
  const range = { byteStart: source.byteStart, byteEnd: source.byteEnd };
  if (outcome === "notification") {
    if (
      typeof value.message !== "string" ||
      !value.message.trim() ||
      value.message.length > 256
    )
      throw new ContractValidationError("Invalid rule notification");
    return { outcome, message: value.message, source: range };
  }
  if (typeof value.operationId !== "string" || !value.operationId)
    throw new ContractValidationError("Rule effect has no operation receipt");
  return { outcome, operationId: value.operationId, source: range };
}
