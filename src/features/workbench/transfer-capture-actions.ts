import { useEffect, useId, useRef, useState } from "react";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { isRecord } from "@/lib/settings-model";
import { nativeErrorCode } from "@/lib/native-error";
import { operationFailureEventKey } from "./workbench-notice";

/** This aborts the UI waiter; only Host operation state settles native work. */
export function useToolAction(formatError?: (reason: unknown) => string) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [errorCode, setErrorCode] = useState<string>();
  const [eventKey, setEventKey] = useState<string>();
  const [failureIndex, setFailureIndex] = useState(0);
  useEffect(() => () => pending.current?.abort(), []);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    setErrorCode(undefined);
    setEventKey(undefined);
    try {
      await action(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setErrorCode(nativeErrorCode(reason));
        setEventKey(operationFailureEventKey(reason));
        setFailureIndex((value) => value + 1);
        setError(
          formatError
            ? formatError(reason)
            : isRecord(reason) && typeof reason.message === "string"
              ? `${typeof reason.code === "string" ? `${reason.code}: ` : ""}${reason.message}`
              : reason instanceof Error
                ? reason.message
                : String(reason),
        );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, error, errorCode, eventKey, failureIndex, run };
}

export function useToolDraft<T>(
  value: T,
  label: string,
  unavailable: string,
  discard: (value: T) => void,
  save?: (value: T, signal?: AbortSignal) => Promise<void>,
) {
  const id = useId();
  const [saved, setSaved] = useState(value);
  useUnsavedWork({
    id: `workbench-tool-${id}`,
    label,
    dirty: JSON.stringify(value) !== JSON.stringify(saved),
    async save(signal) {
      if (!save) throw new Error(unavailable);
      await save(value, signal);
      if (!signal?.aborted) setSaved(value);
    },
    discard: () => discard(saved),
  });
}
