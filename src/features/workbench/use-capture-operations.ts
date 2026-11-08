import { useCallback, useEffect, useRef } from "react";
import type { ObjectRef, Operation } from "@serial-workbench/contracts";
export type CaptureTracker = (
  start: (signal?: AbortSignal) => Promise<Operation | undefined>,
  signal?: AbortSignal,
) => Promise<Operation | undefined>;
/** Only explicitly initiated operations from this window can add a reference. */
export function useCaptureOperations(
  scope: string,
  operations: readonly Operation[],
  onReference: (reference: ObjectRef) => void,
): CaptureTracker {
  const current = useRef({ scope, ids: new Set<string>() });
  if (current.current.scope !== scope)
    current.current = { scope, ids: new Set() };
  const latest = useRef(operations);
  latest.current = operations;
  const receive = useRef(onReference);
  receive.current = onReference;
  const publish = useCallback((operation: Operation) => {
    if (operation.actionId === "capture.start") {
      const result = operation.result;
      const ref =
        result?.kind === "reference"
          ? result.value.resultRef
          : result?.kind === "capture_status"
            ? result.value.captureRef
            : undefined;
      if (ref?.kind === "capture" && ref.hostId === operation.executionHostId) {
        current.current.ids.delete(operation.operationId);
        receive.current(ref);
      }
    }
  }, []);
  useEffect(() => {
    for (const operation of operations)
      if (current.current.ids.has(operation.operationId)) publish(operation);
  }, [operations, publish, scope]);
  useEffect(() => {
    const owner = {
      scope,
      ids:
        current.current.scope === scope
          ? current.current.ids
          : new Set<string>(),
    };
    current.current = owner;
    return () => {
      if (current.current === owner)
        current.current = { scope: "", ids: new Set() };
    };
  }, [scope]);
  return useCallback(
    async (start, signal) => {
      if (current.current.scope !== scope) return undefined;
      const owner = current.current;
      const operation = await start(signal);
      if (operation && !signal?.aborted && owner === current.current) {
        owner.ids.add(operation.operationId);
        publish(
          latest.current.find(
            (value) => value.operationId === operation.operationId,
          ) ?? operation,
        );
      }
      return operation;
    },
    [publish, scope],
  );
}
