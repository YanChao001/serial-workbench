import { useEffect, useId, useRef, useState } from "react";
import { useUnsavedWork } from "@/providers/unsaved-work";
import { isRecord } from "@/lib/settings-model";

/** This aborts the UI waiter; only Host operation state settles native work. */
export function useToolAction() {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => pending.current?.abort(), []);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      await action(controller.signal);
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          isRecord(reason) && typeof reason.message === "string"
            ? `${typeof reason.code === "string" ? `${reason.code}: ` : ""}${reason.message}`
            : reason instanceof Error
              ? reason.message
              : String(reason),
        );
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, error, run };
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

export function unsigned(value: string): bigint | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return;
  const parsed = BigInt(value);
  return parsed <= 18446744073709551615n ? parsed : undefined;
}
