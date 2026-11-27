import { createContext } from "react";
import {
  ContractValidationError,
  type Operation,
  type Target,
} from "@serial-workbench/contracts";
import { toast } from "sonner";
import { isRecord } from "@/lib/settings-model";
import { presentBackgroundRuleAlert } from "@/lib/tauri";
import type { HostContextValue } from "@/providers/host-context";
import {
  readRuleResult,
  sameRule,
  type RuleResult,
} from "./rule-trigger-model";

export type RuleTaskAccess = Pick<
  HostContextValue,
  "waitForOperation" | "readFile"
> & {
  scope: string;
  target: Target;
};

type BackgroundAlert =
  "armed" | "requesting" | "submitted" | "skipped" | "unavailable";

type RuleObservation =
  | { id: string; report: RuleResult; terminal: true }
  | { id: string; stopped: true; terminal: true }
  | { id: string; error: unknown; terminal: boolean };

type Entry = {
  scope: string;
  operation: Operation;
  controller: AbortController;
  pending: boolean;
  alert?: BackgroundAlert;
  outcome?: Promise<RuleObservation>;
};

async function observeRule(
  access: RuleTaskAccess,
  operation: Operation,
  signal: AbortSignal,
): Promise<RuleObservation> {
  const id = operation.operationId;
  try {
    const terminal = await access.waitForOperation(operation, signal);
    signal.throwIfAborted();
    if (
      terminal.operationId !== id ||
      terminal.actionId !== operation.actionId ||
      !sameRule(terminal, access.target)
    )
      throw new ContractValidationError(
        "Rule terminal belongs to another operation",
      );
    if (terminal.state === "cancelled")
      return { id, stopped: true, terminal: true };
    if (terminal.state !== "succeeded")
      return { id, error: terminal.error, terminal: true };
    const report = await readRuleResult(
      operation,
      terminal,
      access.target,
      access.readFile,
      signal,
    );
    return { id, report, terminal: true };
  } catch (error) {
    const terminal =
      isRecord(error) &&
      error.operationId === id &&
      error.executionHostId === operation.executionHostId &&
      typeof error.operationState === "string";
    if (terminal && error.operationState === "cancelled")
      return { id, stopped: true, terminal: true };
    return { id, error, terminal };
  }
}

export function createRuleTaskObservations() {
  const entries = new Map<string, Entry>();
  const alertListeners = new Set<() => void>();
  function setAlert(entry: Entry, alert?: BackgroundAlert) {
    if (entry.controller.signal.aborted) return;
    entry.alert = alert;
    for (const listener of alertListeners) listener();
  }
  function requestAlert(entry: Entry, result: RuleObservation) {
    if (
      entry.alert !== "armed" ||
      entry.controller.signal.aborted ||
      !result.terminal
    )
      return;
    if (!("report" in result) || result.report.outcome !== "notification") {
      setAlert(entry);
      return;
    }
    setAlert(entry, "requesting");
    void presentBackgroundRuleAlert(result.report.message).then(
      (submitted) => setAlert(entry, submitted ? "submitted" : "skipped"),
      () => setAlert(entry, "unavailable"),
    );
  }
  const trim = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= 64) break;
      if (!entry.pending) entries.delete(key);
    }
  };
  return {
    observe(
      access: RuleTaskAccess,
      operation: Operation,
      backgroundAlert = false,
    ) {
      const key = JSON.stringify([access.scope, operation.operationId]);
      const entry: Entry = entries.get(key) ?? {
        scope: access.scope,
        operation,
        controller: new AbortController(),
        pending: true,
      };
      if (!entry.outcome) {
        entry.pending = true;
        entries.delete(key);
        entries.set(key, entry);
        entry.outcome = observeRule(
          access,
          operation,
          entry.controller.signal,
        ).then((result) => {
          entry.pending = false;
          if (entry.controller.signal.aborted) return result;
          if (!result.terminal) entry.outcome = undefined;
          if ("report" in result && result.report.outcome === "notification")
            toast.info(result.report.message, { id: key });
          trim();
          return result;
        });
        trim();
      }
      if (backgroundAlert && !entry.alert) setAlert(entry, "armed");
      if (entry.alert === "armed")
        void entry.outcome.then((outcome) => requestAlert(entry, outcome));
      return entry.outcome;
    },
    backgroundAlert(access: RuleTaskAccess, operation: Operation) {
      const key = JSON.stringify([access.scope, operation.operationId]);
      return entries.get(key)?.alert;
    },
    subscribeBackgroundAlerts(listener: () => void) {
      alertListeners.add(listener);
      return () => {
        alertListeners.delete(listener);
      };
    },
    recent(access: RuleTaskAccess) {
      let result: Operation | undefined;
      for (const entry of entries.values())
        if (
          entry.scope === access.scope &&
          sameRule(entry.operation, access.target)
        )
          result = entry.operation;
      return result;
    },
    dispose() {
      for (const entry of entries.values()) entry.controller.abort();
      entries.clear();
    },
  };
}

export const RuleTaskObservationsContext = createContext<ReturnType<
  typeof createRuleTaskObservations
> | null>(null);
export type { RuleObservation };
