import {
  ContractValidationError,
  parseReply,
  parseSharedSettings,
  type Operation,
  type SettingsDocumentResult,
  type Target,
  type JsonValue,
} from "@serial-workbench/contracts";
import { HostRequestError } from "@serial-workbench/host-client";
import type { HostConnection } from "./host-client";

import type { SettingsBackend } from "./settings-sync";
import { hostApplyDocumentIntent } from "./tauri";

const abortError = () => new DOMException("Waiting was aborted", "AbortError");
const pendingStates = new Set<Operation["state"]>([
  "queued",
  "running",
  "cancel_requested",
]);
function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, field]) => field !== undefined)
        .map(([key, field]) => [key, jsonValue(field)]),
    );
  throw new ContractValidationError("Settings contain a non-JSON value");
}
function pause(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 50);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Shares HostProvider's authenticated connection; only this adapter's channels are owned here. */
export function createHostSettingsBackend(
  connection: HostConnection,
): SettingsBackend & { markExplicitEdit(): void; dispose(): void } {
  const lifetime = new AbortController();
  let explicitEdit = false;
  const stops = new Set<() => void>();
  const target: Target = {
    hostId: connection.attachment.hostId,
    kind: "settings",
    id: "shared",
  };
  function checked(value: SettingsDocumentResult) {
    if (
      value.scope.target.hostId !== target.hostId ||
      value.scope.target.kind !== target.kind ||
      value.scope.target.id !== target.id
    )
      throw new ContractValidationError(
        "Settings belong to another Host target",
      );
    return value;
  }
  function checkedOperation(operation: Operation) {
    if (
      operation.actionId !== "settings.save" ||
      operation.executionHostId !== target.hostId ||
      operation.target.hostId !== target.hostId ||
      operation.target.kind !== target.kind ||
      operation.target.id !== target.id
    )
      throw new ContractValidationError(
        "Operation belongs to another settings target",
      );
    return operation;
  }
  async function read() {
    const result = await connection.client.query(
      connection.buildQuery("settings.read", target),
      lifetime.signal,
    );
    if (result.kind !== "settings") throw new ContractValidationError();
    return checked(result.value);
  }
  return {
    markExplicitEdit() {
      if (!lifetime.signal.aborted) explicitEdit = true;
    },
    async read() {
      return (await read()).document;
    },
    async save(value, expectedRevision) {
      if (lifetime.signal.aborted) throw abortError();
      // 在等待前一次性取走标记，保存期间的新编辑保留给下一次提交。
      const useIntent = explicitEdit;
      explicitEdit = false;
      const params = { value: jsonValue(value) };
      let operation = useIntent
        ? await hostApplyDocumentIntent(connection.generation, {
            kind: "settingsSave",
            expectedRevision,
            params: { value: parseSharedSettings(params.value) },
          })
        : await connection.client.invoke(
            connection.buildCall("settings.save", target, params, {
              expectedRevision,
            }),
            lifetime.signal,
          );
      if (lifetime.signal.aborted) throw abortError();
      checkedOperation(operation);
      const operationId = operation.operationId;
      while (pendingStates.has(operation.state)) {
        await pause(lifetime.signal);
        const result = await connection.client.query(
          connection.buildQuery("operation.get", connection.hostTarget, {
            operationId,
          }),
          lifetime.signal,
        );
        if (lifetime.signal.aborted) throw abortError();
        if (
          result.kind !== "operation" ||
          result.value.operation.operationId !== operationId
        )
          throw new ContractValidationError();
        operation = checkedOperation(result.value.operation);
      }
      if (operation.error) throw new HostRequestError(operation.error);
      if (operation.state !== "succeeded") throw { code: "OPERATION_ABORTED" };
      if (operation.result?.kind !== "settings")
        throw new ContractValidationError();
      const document = checked(operation.result.value).document;
      if (BigInt(document.revision) <= BigInt(expectedRevision))
        throw new ContractValidationError(
          "Saved settings revision did not advance",
        );
      return document;
    },
    async subscribe(listener, failed) {
      const { scope } = await read();
      await connection.refreshScopes(lifetime.signal);
      const controller = new AbortController();
      let close: (() => void) | undefined;
      const stop = () => {
        controller.abort();
        close?.();
        stops.delete(stop);
        lifetime.signal.removeEventListener("abort", stop);
      };
      stops.add(stop);
      lifetime.signal.addEventListener("abort", stop, { once: true });
      if (lifetime.signal.aborted) {
        stop();
        throw abortError();
      }
      try {
        close = await connection.client.subscribe(
          scope.scopeId,
          (event) => {
            if (controller.signal.aborted) return;
            if (event.type === "error") {
              failed?.(event.error);
              return;
            }
            try {
              const reply = parseReply({
                ok: true,
                result: {
                  kind: "settings",
                  value:
                    event.type === "snapshot"
                      ? event.snapshot.state
                      : event.delta.payload,
                },
              });
              if (
                !reply.ok ||
                !("kind" in reply.result) ||
                reply.result.kind !== "settings"
              )
                throw new ContractValidationError();
              const value = checked(reply.result.value);
              if (value.scope.scopeId !== scope.scopeId)
                throw new ContractValidationError();
              listener(value.document);
            } catch (error) {
              failed?.(error);
            }
          },
          controller.signal,
        );
        if (controller.signal.aborted) close();
        return stop;
      } catch (error) {
        stop();
        throw error;
      }
    },
    dispose() {
      explicitEdit = false;
      lifetime.abort();
      for (const stop of [...stops]) stop();
    },
  };
}
